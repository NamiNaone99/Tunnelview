/// One viewing session with a paired computer: the signaling state machine
/// (the phone's twin of the desktop `viewer-client.js`) plus the WebRTC peer.
///
/// The phone is always the viewer and the answerer. It never hosts.
library;

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';

import '../proto/auth.dart';
import '../proto/signal.dart';
import '../rtc/peer.dart';
import 'hosts.dart';
import 'link.dart';
import 'transport.dart';

/// Where a session is.
enum SessionPhase {
  /// Dialing and checking the computer's signature.
  connecting,

  /// The computer wants its password (or the last one was wrong).
  password,

  /// Waiting for someone at the computer to allow the session.
  waiting,

  /// Accepted: media is starting or running.
  live,

  /// Over; see `closeReason`.
  closed,
}

/// The state of the media path while [SessionPhase.live].
enum MediaState { starting, connected, recovering }

const Set<String> _denyReasons = {
  'rejected',
  'timeout',
  'busy',
  'not-allowed',
  'bad-password',
  'password-required',
  'locked',
  'protocol',
  'disabled',
  'auth-timeout',
  'suspended',
  'try-later',
};

const List<String> qualityPresets = ['quality', 'balanced', 'speed'];

/// A session with [host].
class RemoteSession extends ChangeNotifier {
  RemoteSession({
    required this.host,
    required this.transport,
    required this.peerFactory,
    required this.selfAddrs,
    required this.deviceName,
    required this.appVersion,
    this.gate,
    this.normalizePassword,
    this.mediaTimeout = const Duration(seconds: 30),
    this.disconnectGrace = const Duration(seconds: 35),
    this.pathRecheck = const Duration(seconds: 5),
  });

  final PairedHost host;
  final SignalTransport transport;
  final PeerFactory peerFactory;
  final List<String> selfAddrs;
  final String deviceName;
  final String appVersion;

  /// The session gate (`sessionRefusal`): null when a session may run, else
  /// its refusal code. Asked before dialing and again before WebRTC starts.
  final String? Function()? gate;

  /// Unicode NFC normalisation for a typed password (the desktop hashes the
  /// NFC form). Dart has none built in; Android supplies it.
  final Future<String> Function(String text)? normalizePassword;

  /// How long the first picture may take after the session was accepted.
  final Duration mediaTimeout;

  /// How long a lost connection may take to come back. Longer than the
  /// host's 30 s, so the host, which can restart ICE, decides first.
  final Duration disconnectGrace;

  /// How often the selected ICE path is checked again while connected (the
  /// host does the same): ICE can move to another candidate pair later.
  final Duration pathRecheck;

  SessionPhase _phase = SessionPhase.connecting;
  HostLink? _link;
  ViewerPeer? _peer;
  HelloInfo? _hello;
  int? _remaining;
  bool _requestSent = false;
  bool _computing = false;
  bool _disposed = false;
  LinkFailure? _closed;
  Permissions _permissions = const Permissions();
  MediaState _media = MediaState.starting;
  bool _inputOpen = false;
  bool? _controlAllowed;
  String? _inputBlocked;
  List<RemoteDisplay> _displays = const [];
  String? _currentDisplay;
  String _quality = 'balanced';
  PathCheck? _path;
  bool _hasPicture = false;
  Timer? _mediaTimer;
  Timer? _graceTimer;
  Timer? _pathTimer;
  Future<void> _signalQueue = Future.value();

  SessionPhase get phase => _phase;

  /// What the computer said about itself (null while connecting).
  HelloInfo? get hello => _hello;

  /// Password attempts left on this connection, after a wrong one.
  int? get remaining => _remaining;

  /// True while a typed password is being hashed.
  bool get computing => _computing;

  /// Whether the computer has a password at all.
  bool get passwordSet => _hello?.passwordSet ?? false;

  /// Why the session ended (null until [SessionPhase.closed]).
  LinkFailure? get closeReason => _closed;

  Permissions get permissions => _permissions;
  MediaState get media => _media;
  ViewerPeer? get peer => _peer;
  List<RemoteDisplay> get displays => _displays;
  String? get currentDisplay => _currentDisplay;
  String get quality => _quality;

  /// The checked media path, once connected.
  PathCheck? get path => _path;

  /// True once the first frame of the remote picture arrived.
  bool get hasPicture => _hasPicture;

  /// 'secure-desktop' | 'elevated-window' while the computer's OS refuses
  /// remote input.
  String? get inputBlocked => _inputBlocked;

  /// Why input is not sent right now, or null when the phone controls the
  /// computer: 'not-live' | 'recovering' | 'view-only' | 'host-paused' |
  /// 'starting'.
  String? get controlBlock {
    if (_phase != SessionPhase.live) return 'not-live';
    if (!_permissions.control) return 'view-only';
    if (_controlAllowed == false) return 'host-paused';
    if (_media == MediaState.recovering) return 'recovering';
    if (_media != MediaState.connected || !_inputOpen) return 'starting';
    return null;
  }

  bool get canControl => controlBlock == null;

  /// Dials the computer and runs the session until it ends.
  Future<void> start() async {
    final refusal = gate?.call();
    if (refusal != null) {
      _finish(LinkFailure('gate:$refusal'));
      return;
    }
    try {
      final link = await HostLink.open(
        transport: transport,
        addresses: host.addresses,
        port: host.port,
        key: host.keyBytes,
        hostId: host.hostId,
        viewerId: host.viewerId,
        selfAddrs: selfAddrs,
      );
      if (_closed != null) {
        unawaited(link.close());
        return;
      }
      _link = link;
      _hello = link.hello;
      if (link.hello.autoAccept || link.hello.passwordLocked) {
        // Admitted without a password, or a password could not be used
        // anyway: no proof is sent.
        _sendRequest(null);
      } else if (link.hello.needsPassword) {
        _setPhase(SessionPhase.password);
      } else {
        _sendRequest(null);
      }
      await _readLoop(link);
    } on LinkFailure catch (e) {
      _finish(e);
    } catch (_) {
      _finish(const LinkFailure('network'));
    }
  }

  void _sendRequest(String? proof) {
    _requestSent = true;
    _link?.send({
      't': 'request',
      'protocol': protocolVersion,
      'viewer': {
        'hostname': deviceName,
        'os': 'android',
        'version': appVersion,
      },
      'proof': proof,
    });
    if (_phase == SessionPhase.connecting) _setPhase(SessionPhase.waiting);
  }

  /// A password the user typed. Sends `request` with the proof if no request
  /// went out yet, else `auth`. Returns an error code, or null when sent:
  /// 'not-connected' | 'no-password' | 'locked' | 'busy' | 'invalid'.
  Future<String?> submitPassword(String password) async {
    final link = _link;
    final hello = _hello;
    if (link == null || hello == null || _closed != null) {
      return 'not-connected';
    }
    if (_phase == SessionPhase.live) return 'not-connected';
    if (!hello.passwordSet) return 'no-password';
    if (hello.passwordLocked) return 'locked';
    if (_computing) return 'busy';
    if (password.isEmpty || password.length > maxPasswordLength) {
      return 'invalid';
    }
    _computing = true;
    _notify();
    final String proof;
    try {
      // The desktop hashes the NFC form of the password. ASCII is already
      // NFC; anything else is normalised first, so the same password typed
      // with marks in another order still matches.
      var text = password;
      final normalize = normalizePassword;
      if (normalize != null && password.codeUnits.any((c) => c > 0x7f)) {
        try {
          text = await normalize(password);
        } catch (_) {
          text = password; // most keyboards produce NFC already
        }
        if (text.isEmpty || text.length > maxPasswordLength) text = password;
      }
      // Bound to the node IDs the computer signed in its hello, so a relay
      // cannot use the proof.
      proof = await computeProof(
        text,
        {'salt': hello.salt, 'kdf': hello.kdf},
        hello.nonce,
        link.binding,
      );
    } on ProtoError catch (e) {
      _computing = false;
      if (e.code == 'BAD_PASSWORD_INPUT') {
        _notify();
        return 'invalid';
      }
      _fail(const LinkFailure('protocol'));
      return 'not-connected';
    } catch (_) {
      // The hashing isolate could not run: no proof was sent.
      _computing = false;
      _notify();
      return 'invalid';
    }
    _computing = false;
    if (_closed != null || _phase == SessionPhase.live) {
      _notify();
      return 'not-connected';
    }
    if (_requestSent) {
      link.send({'t': 'auth', 'proof': proof});
    } else {
      _sendRequest(proof);
    }
    _remaining = null;
    _setPhase(SessionPhase.waiting);
    return null;
  }

  Future<void> _readLoop(HostLink link) async {
    while (true) {
      final msg = await link.next();
      if (_closed != null) return;
      if (msg == null) {
        // The socket closed without a frame that explains it.
        _finish(
          LinkFailure(
            _phase != SessionPhase.live && link.closeCode == 4000
                ? 'protocol'
                : 'network',
          ),
        );
        return;
      }
      _onMessage(msg);
      if (_closed != null) return;
    }
  }

  void _onMessage(Map<String, dynamic> msg) {
    switch (msg['t']) {
      case 'pending':
        if (_requestSent && _phase != SessionPhase.live) {
          _setPhase(SessionPhase.waiting);
        }
      case 'auth-failed':
        if (!_requestSent || _phase == SessionPhase.live) return;
        final r = msg['remaining'];
        _remaining = r is int && r >= 0 && r <= 100 ? r : 0;
        _setPhase(SessionPhase.password);
      case 'accepted':
        _onAccepted(msg);
      case 'denied':
        final raw = msg['reason'];
        final reason = _denyReasons.contains(raw) ? raw as String : 'protocol';
        if (reason == 'busy' && msg['updating'] == true) {
          _fail(const LinkFailure('host-updating'));
          return;
        }
        final wait = msg['retryAfterSec'];
        _fail(
          LinkFailure(
            'denied:$reason',
            retryAfterSec:
                reason == 'try-later' &&
                    wait is int &&
                    wait >= 1 &&
                    wait <= 3600
                ? wait
                : null,
          ),
        );
      case 'sdp':
      case 'ice':
        if (_phase != SessionPhase.live) return;
        final signal = validateSignal(msg);
        if (signal != null) _enqueueSignal(signal);
      case 'permissions':
        if (_phase != SessionPhase.live || msg['permissions'] is! Map) return;
        final before = canControl;
        _permissions = Permissions.from(msg['permissions']);
        _afterControlChange(before);
      case 'bye':
        final r = cleanLabel(msg['reason'], 64);
        _fail(LinkFailure('host-ended', hostReason: r.isEmpty ? null : r));
      default:
        return; // unknown types are ignored
    }
  }

  void _onAccepted(Map<String, dynamic> msg) {
    if (!_requestSent || _phase == SessionPhase.live) return;
    final id = msg['sessionId'];
    if (id is! String || id.isEmpty || id.length > 128) {
      _fail(const LinkFailure('protocol'));
      return;
    }
    _permissions = Permissions.from(msg['permissions']);
    _remaining = null;
    _media = MediaState.starting;
    _hasPicture = false;
    _setPhase(SessionPhase.live);
    // Runs until the first frame, as in the desktop viewer: a connection
    // that never shows a picture must not stay up, with input enabled, on a
    // black screen.
    _mediaTimer = Timer(mediaTimeout, () {
      if (!_hasPicture) _end('media-timeout');
    });
    _signalQueue = _signalQueue.then((_) => _createPeer());
  }

  void _onVideo() {
    final peer = _peer;
    if (_closed != null || peer == null || _hasPicture) return;
    final size = peer.videoSize;
    if (size.width > 0 && size.height > 0) {
      _hasPicture = true;
      _mediaTimer?.cancel();
      _mediaTimer = null;
      _notify();
    }
  }

  Future<void> _createPeer() async {
    if (_closed != null) return;
    // The gate again: Tailscale may have gone, or the self-test may have
    // failed, while the request was waiting to be accepted.
    final refusal = gate?.call();
    if (refusal != null) {
      _link?.send({'t': 'bye', 'reason': 'viewer-closed'});
      _finish(LinkFailure('gate:$refusal'));
      return;
    }
    try {
      final peer = await peerFactory(
        PeerEvents(
          onCandidate: _onLocalCandidate,
          onState: _onPeerState,
          onChannel: _onChannel,
          onControl: _onControl,
        ),
      );
      if (_closed != null) {
        unawaited(peer.close());
        return;
      }
      _peer = peer;
      peer.videoChanges.addListener(_onVideo);
      _onVideo();
      _notify();
    } catch (_) {
      _end('media-failed');
    }
  }

  // Offers and candidates are applied one at a time, in arrival order.
  void _enqueueSignal(Signal signal) {
    _signalQueue = _signalQueue.then((_) => _applySignal(signal));
  }

  Future<void> _applySignal(Signal signal) async {
    final peer = _peer;
    if (peer == null || _closed != null) return;
    try {
      if (signal.isOffer) {
        final sdp = await peer.answer(signal.sdp!);
        if (_closed != null) return;
        _link?.send({
          't': 'sdp',
          'description': {'type': 'answer', 'sdp': sdp},
        });
      } else {
        final c = signal.candidate;
        // The end of candidates needs no action. A candidate outside the
        // tailnet is dropped: media may only flow through Tailscale.
        if (c == null || c.candidate.isEmpty) return;
        if (!isAllowedCandidate(c.toJson())) return;
        await peer.addCandidate(c);
      }
    } catch (_) {
      if (signal.isOffer) _end('media-failed');
    }
  }

  void _onLocalCandidate(Map<String, Object?> candidate) {
    if (_closed != null || !isAllowedCandidate(candidate)) return;
    _link?.send({'t': 'ice', 'candidate': candidate});
  }

  void _onPeerState(PeerState state) {
    if (_closed != null || _phase != SessionPhase.live) return;
    final before = canControl;
    switch (state) {
      case PeerState.connected:
        _graceTimer?.cancel();
        _graceTimer = null;
        _media = MediaState.connected;
        unawaited(_checkPath());
        _pathTimer ??= Timer.periodic(
          pathRecheck,
          (_) => unawaited(_checkPath()),
        );
      case PeerState.disconnected:
      case PeerState.failed:
        if (_media == MediaState.connected) {
          _media = MediaState.recovering;
          _graceTimer ??= Timer(disconnectGrace, () => _end('network'));
        }
      case PeerState.closed:
        if (_media != MediaState.starting) _end('network');
        return;
      case PeerState.connecting:
        break;
    }
    _afterControlChange(before);
  }

  /// The selected candidate pair must run between Tailscale addresses.
  Future<void> _checkPath() async {
    final peer = _peer;
    if (peer == null || _closed != null) return;
    final PathCheck check;
    try {
      check = verifyTailnetPath(await peer.stats());
    } catch (_) {
      return; // as on the desktop: a failing getStats proves nothing
    }
    if (_closed != null) return;
    _path = check;
    if (!check.ok) {
      _end('non-tailnet-path');
    } else {
      _notify();
    }
  }

  void _onChannel(String label, bool open) {
    if (_closed != null) return;
    if (label == 'input') {
      final before = canControl;
      _inputOpen = open;
      _afterControlChange(before);
    } else if (label == 'control' && open) {
      // The host starts at its own default; tell it what this phone wants.
      _sendControl({'t': 'quality', 'preset': _quality});
    }
  }

  void _onControl(String text) {
    if (_closed != null) return;
    final Object? raw;
    try {
      raw = jsonDecode(text);
    } on FormatException {
      return;
    }
    switch (validateControl(raw)) {
      case DisplaysMessage(:final displays, :final current):
        _displays = displays;
        _currentDisplay = current;
        _notify();
      case HostStateMessage m:
        final before = canControl;
        if (m.controlAllowed != null) _controlAllowed = m.controlAllowed;
        if (m.hasInputBlocked) _inputBlocked = m.inputBlocked;
        _afterControlChange(before);
      case null:
        return;
    }
  }

  // Keys and buttons must not stay held on the computer once control goes.
  void _afterControlChange(bool before) {
    if (before && !canControl) {
      _peer?.send('input', jsonEncode({'t': 'release-all'}));
    }
    _notify();
  }

  /// Sends one `input` message. False while the phone may not control.
  bool sendInput(Map<String, Object?> msg) {
    if (!canControl) return false;
    return _peer?.send('input', jsonEncode(msg)) ?? false;
  }

  bool _sendControl(Map<String, Object?> msg) =>
      _peer?.send('control', jsonEncode(msg)) ?? false;

  /// Asks the computer to stream another display.
  void selectDisplay(String id) {
    if (_displays.any((d) => d.id == id)) {
      _sendControl({'t': 'select-display', 'id': id});
    }
  }

  /// Picks a quality preset.
  void setQuality(String preset) {
    if (!qualityPresets.contains(preset)) return;
    _quality = preset;
    _sendControl({'t': 'quality', 'preset': preset});
    _notify();
  }

  /// The phone ends the session for [reason] and tells the computer.
  void _end(String reason) {
    if (_closed != null) return;
    _link?.send({'t': 'bye', 'reason': reason});
    _finish(LinkFailure(reason));
  }

  void _fail(LinkFailure failure) => _finish(failure);

  /// The user leaves: says bye and closes.
  void close() {
    if (_closed != null) return;
    if (_inputOpen) _peer?.send('input', jsonEncode({'t': 'release-all'}));
    _link?.send({'t': 'bye', 'reason': 'viewer-closed'});
    _finish(const LinkFailure('local'));
  }

  void _finish(LinkFailure failure) {
    if (_closed != null) return;
    _closed = failure;
    _phase = SessionPhase.closed;
    _mediaTimer?.cancel();
    _graceTimer?.cancel();
    _pathTimer?.cancel();
    final peer = _peer;
    final link = _link;
    _inputOpen = false;
    if (link != null) unawaited(link.close());
    // The picture stays in the tree until the screen rebuilds without it.
    _notify();
    if (peer != null) {
      peer.videoChanges.removeListener(_onVideo);
      scheduleMicrotask(() async {
        _peer = null;
        _notify();
        await peer.close();
      });
    }
  }

  void _setPhase(SessionPhase phase) {
    _phase = phase;
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    close();
    _disposed = true;
    super.dispose();
  }
}
