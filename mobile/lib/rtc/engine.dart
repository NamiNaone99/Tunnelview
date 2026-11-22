// The ONLY file in the app that may import package:flutter_webrtc. CI fails
// the build if any other Dart file does (.github/workflows/android.yml).
//
// Why: flutter_webrtc initialises itself with default options (no network
// mask) the first time any of its APIs is used, and the native
// PeerConnectionFactory keeps the options it was created with. If anything
// touched WebRTC before the masked initialisation, libwebrtc would gather
// candidates on Wi-Fi and mobile data, outside the Tailscale tunnel. So
// main() awaits [RtcEngine.initialize] before runApp, and everything else
// goes through this file and checks [RtcEngine.ready] first.
import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/widgets.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';

import '../proto/signal.dart';
import 'peer.dart';
import 'self_test.dart';

/// Platforms with their own network mask rules.
enum RtcPlatform { android, ios, unsupported }

/// The platform this process runs on.
RtcPlatform get currentRtcPlatform {
  if (Platform.isAndroid) return RtcPlatform.android;
  if (Platform.isIOS) return RtcPlatform.ios;
  return RtcPlatform.unsupported;
}

/// Adapter types libwebrtc must never gather candidates on. Only VPN stays.
///
/// Each entry appears once: the Android plugin adds the bits up, so a repeated
/// entry would set a wrong bit. Android also masks ANY, because libwebrtc falls
/// back to ANY-address networks when enumeration is empty. iOS must never get
/// ANY: there it sets every ignore flag, VPN included, and nothing is gathered.
List<String> networkIgnoreMaskFor(RtcPlatform platform) {
  const common = <AdapterType>[
    AdapterType.adapterTypeEthernet,
    AdapterType.adapterTypeWifi,
    AdapterType.adapterTypeCellular,
    AdapterType.adapterTypeLoopback,
  ];
  switch (platform) {
    case RtcPlatform.android:
      return [for (final t in common) t.name, AdapterType.adapterTypeAny.name];
    case RtcPlatform.ios:
      return [for (final t in common) t.name];
    case RtcPlatform.unsupported:
      return const [];
  }
}

/// Remote audio must not pause the user's music or switch the phone to call
/// mode: no audio focus, normal mode, media usage.
AndroidAudioConfiguration androidAudioConfiguration() =>
    AndroidAudioConfiguration(
      manageAudioFocus: false,
      androidAudioMode: AndroidAudioMode.normal,
      androidAudioAttributesUsageType: AndroidAudioAttributesUsageType.media,
      androidAudioAttributesContentType:
          AndroidAudioAttributesContentType.movie,
    );

/// The options for the one and only `WebRTC.initialize` call.
Map<String, dynamic> initOptionsFor(RtcPlatform platform) => {
  'networkIgnoreMask': networkIgnoreMaskFor(platform),
  'zeroPlayoutDelay': true,
  if (platform == RtcPlatform.android)
    'androidAudioConfiguration': androidAudioConfiguration().toMap(),
};

/// Outcome of the start-up initialisation.
class RtcInitResult {
  const RtcInitResult.ok() : ok = true, error = null;
  const RtcInitResult.failed(String this.error) : ok = false;

  final bool ok;
  final String? error;
}

/// Owner of the process-wide WebRTC factory.
class RtcEngine {
  RtcEngine._();

  static Future<RtcInitResult>? _init;
  static RtcInitResult? _result;

  /// Initialises WebRTC with the tunnel-only mask. Safe to call more than
  /// once: every call returns the first call's future.
  static Future<RtcInitResult> initialize() =>
      _init ??= _initialize(currentRtcPlatform);

  /// True once [initialize] completed with the mask applied.
  static bool get ready => _result?.ok ?? false;

  /// The start-up result, or null before [initialize] completed.
  static RtcInitResult? get result => _result;

  /// Throws unless [initialize] completed successfully. Every future
  /// peer-connection or renderer factory in this file calls it first.
  static void ensureReady() {
    if (!ready) {
      throw StateError('WebRTC is not initialised with the tunnel-only mask');
    }
  }

  static Future<RtcInitResult> _initialize(RtcPlatform platform) async {
    if (platform == RtcPlatform.unsupported) {
      return _result = const RtcInitResult.failed('unsupported platform');
    }
    if (WebRTC.initialized) {
      // Something used flutter_webrtc first, so the factory already exists
      // without the mask. Refuse instead of running unmasked.
      return _result = const RtcInitResult.failed(
        'WebRTC was initialised before the network mask was applied',
      );
    }
    try {
      await WebRTC.initialize(options: initOptionsFor(platform));
      if (platform == RtcPlatform.android) {
        await Helper.setAndroidAudioConfiguration(androidAudioConfiguration());
      }
      return _result = const RtcInitResult.ok();
    } catch (e) {
      return _result = RtcInitResult.failed('WebRTC initialisation failed: $e');
    }
  }
}

/// Settings for every peer connection. No ICE servers: no STUN or TURN, so
/// nothing is ever sent to a third party and only host candidates exist.
Map<String, dynamic> peerConnectionConfig() => {
  'iceServers': <Map<String, dynamic>>[],
  'bundlePolicy': 'max-bundle',
  'rtcpMuxPolicy': 'require',
  'sdpSemantics': 'unified-plan',
  'tcpCandidatePolicy': 'disabled',
};

/// Throws unless [config] has an empty `iceServers` list.
void assertNoIceServers(Map<String, dynamic> config) {
  final servers = config['iceServers'];
  if (servers is! List || servers.isNotEmpty) {
    throw StateError('peer connections must have no ICE servers');
  }
}

/// The real [LocalIceGatherer]: a local peer connection with one data
/// channel and an offer, gathered until complete or the timeout, then closed.
/// The offer and the candidates never leave this function's result.
class EngineIceGatherer implements LocalIceGatherer {
  const EngineIceGatherer();

  @override
  Future<GatherOutcome> gather({
    Duration timeout = const Duration(seconds: 5),
  }) async {
    final watch = Stopwatch()..start();
    if (!RtcEngine.ready) {
      return GatherOutcome.failed('webrtc-unavailable', watch.elapsed);
    }
    RTCPeerConnection? pc;
    final lines = <String>[];
    final complete = Completer<void>();
    try {
      final config = peerConnectionConfig();
      assertNoIceServers(config);
      pc = await createPeerConnection(config);
      pc.onIceCandidate = (c) {
        final line = c.candidate;
        if (line != null && line.isNotEmpty) lines.add(line);
      };
      pc.onIceGatheringState = (state) {
        if (state == RTCIceGatheringState.RTCIceGatheringStateComplete &&
            !complete.isCompleted) {
          complete.complete();
        }
      };
      await pc.createDataChannel('self-test', RTCDataChannelInit());
      final offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      var completed = true;
      try {
        await complete.future.timeout(timeout);
      } on TimeoutException {
        completed = false;
      }
      final local = await pc.getLocalDescription();
      final sdpLines = (local?.sdp ?? '')
          .split(RegExp(r'\r?\n'))
          .where((l) => l.startsWith('a=candidate:'));
      final stats = await pc.getStats();
      return GatherOutcome(
        candidates: mergeCandidates(
          [...lines, ...sdpLines],
          [
            for (final r in stats)
              if (r.type == 'local-candidate') r.values,
          ],
        ),
        completed: completed,
        elapsed: watch.elapsed,
      );
    } catch (e) {
      return GatherOutcome.failed(_describeError(e), watch.elapsed);
    } finally {
      final p = pc;
      if (p != null) {
        try {
          await p.close();
        } catch (_) {
          // Closing a connection that already failed must not hide the result.
        }
        try {
          await p.dispose();
        } catch (_) {
          // As above.
        }
      }
    }
  }
}

/// flutter_webrtc throws plain strings; keep them short.
String _describeError(Object e) {
  final s = e is String ? e : e.runtimeType.toString();
  return s.length > 160 ? '${s.substring(0, 160)}…' : s;
}

/// Creates the real [ViewerPeer]. Throws unless WebRTC was initialised with
/// the tunnel-only mask.
Future<ViewerPeer> createEnginePeer(PeerEvents events) async {
  RtcEngine.ensureReady();
  final config = peerConnectionConfig();
  assertNoIceServers(config);
  final renderer = RTCVideoRenderer();
  await renderer.initialize();
  final RTCPeerConnection pc;
  try {
    pc = await createPeerConnection(config);
  } catch (_) {
    await renderer.dispose();
    rethrow;
  }
  return _EnginePeer(pc, renderer, events);
}

/// Longest `control` message accepted (UTF-16 units), as on the desktop.
const int maxControlMessageLength = 2 * 1024 * 1024;

class _EnginePeer implements ViewerPeer {
  _EnginePeer(this._pc, this._renderer, this._events) {
    _renderer.onResize = _onResize;
    _renderer.onFirstFrameRendered = _onResize;
    _pc.onIceCandidate = _onIceCandidate;
    _pc.onIceConnectionState = _onIceState;
    _pc.onDataChannel = _onDataChannel;
    _pc.onTrack = _onTrack;
  }

  final RTCPeerConnection _pc;
  final RTCVideoRenderer _renderer;
  final PeerEvents _events;
  final Map<String, RTCDataChannel> _channels = {};
  final ValueNotifier<Size> _size = ValueNotifier(Size.zero);
  MediaStream? _ownStream;
  bool _closed = false;

  void _onResize() {
    if (_closed) return;
    _size.value = Size(
      _renderer.videoWidth.toDouble(),
      _renderer.videoHeight.toDouble(),
    );
  }

  void _onIceCandidate(RTCIceCandidate c) {
    if (_closed) return;
    final line = c.candidate;
    if (line == null || line.isEmpty) return;
    final init = <String, Object?>{
      'candidate': line,
      'sdpMid': c.sdpMid,
      'sdpMLineIndex': c.sdpMLineIndex,
    };
    // Never offer the host an address outside the tunnel.
    if (!isAllowedCandidate(init)) return;
    _events.onCandidate(init);
  }

  void _onIceState(RTCIceConnectionState state) {
    if (_closed) return;
    switch (state) {
      case RTCIceConnectionState.RTCIceConnectionStateConnected:
      case RTCIceConnectionState.RTCIceConnectionStateCompleted:
        _events.onState(PeerState.connected);
      case RTCIceConnectionState.RTCIceConnectionStateDisconnected:
        _events.onState(PeerState.disconnected);
      case RTCIceConnectionState.RTCIceConnectionStateFailed:
        _events.onState(PeerState.failed);
      case RTCIceConnectionState.RTCIceConnectionStateClosed:
        _events.onState(PeerState.closed);
      case RTCIceConnectionState.RTCIceConnectionStateNew:
      case RTCIceConnectionState.RTCIceConnectionStateChecking:
      case RTCIceConnectionState.RTCIceConnectionStateCount:
        _events.onState(PeerState.connecting);
    }
  }

  void _onDataChannel(RTCDataChannel channel) {
    final label = channel.label;
    if (_closed || label == null) return;
    _channels[label] = channel;
    channel.onDataChannelState = (state) {
      if (_closed) return;
      if (state == RTCDataChannelState.RTCDataChannelOpen) {
        _events.onChannel(label, true);
      } else if (state == RTCDataChannelState.RTCDataChannelClosed) {
        _events.onChannel(label, false);
      }
    };
    if (label == 'control') {
      channel.onMessage = (m) {
        if (_closed || m.isBinary) return;
        final text = m.text;
        if (text.length <= maxControlMessageLength) _events.onControl(text);
      };
    }
    if (channel.state == RTCDataChannelState.RTCDataChannelOpen) {
      _events.onChannel(label, true);
    }
  }

  Future<void> _onTrack(RTCTrackEvent event) async {
    if (_closed || event.track.kind != 'video') return;
    try {
      if (event.streams.isNotEmpty) {
        _renderer.srcObject = event.streams.first;
        return;
      }
      // The host adds its tracks without a stream: wrap the track in one.
      final stream = _ownStream ??= await createLocalMediaStream(
        'tunnelview-remote',
      );
      await stream.addTrack(event.track, addToNative: true);
      if (_closed) return;
      _renderer.srcObject = stream;
    } catch (_) {
      // No picture; the session notices that no frame arrives.
    }
  }

  @override
  Future<String> answer(String offerSdp) async {
    await _pc.setRemoteDescription(
      RTCSessionDescription(sanitizeSdp(offerSdp), 'offer'),
    );
    final answer = await _pc.createAnswer();
    final sdp = sanitizeSdp(answer.sdp ?? '');
    await _pc.setLocalDescription(RTCSessionDescription(sdp, 'answer'));
    return sdp;
  }

  // Never a null mid: on Android a null string reaches libwebrtc's native
  // code and aborts the app. With an empty mid libwebrtc goes by the m-line
  // index (the plugin reads a missing index as 0; everything is bundled on
  // one transport anyway).
  @override
  Future<void> addCandidate(SignalCandidate c) => _pc.addCandidate(
    RTCIceCandidate(c.candidate, c.sdpMid ?? '', c.sdpMLineIndex),
  );

  @override
  bool send(String label, String text) {
    final channel = _channels[label];
    if (_closed ||
        channel == null ||
        channel.state != RTCDataChannelState.RTCDataChannelOpen) {
      return false;
    }
    unawaited(
      channel.send(RTCDataChannelMessage(text)).catchError((Object _) {}),
    );
    return true;
  }

  @override
  Future<List<Map<dynamic, dynamic>>> stats() async {
    final report = await _pc.getStats();
    return [
      for (final r in report) {...r.values, 'id': r.id, 'type': r.type},
    ];
  }

  @override
  Listenable get videoChanges => _size;

  @override
  Size get videoSize => _size.value;

  @override
  Widget buildVideo() => RTCVideoView(
    _renderer,
    objectFit: RTCVideoViewObjectFit.RTCVideoViewObjectFitContain,
  );

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _renderer.onResize = null;
    _renderer.onFirstFrameRendered = null;
    try {
      _renderer.srcObject = null;
    } catch (_) {
      // Already detached.
    }
    for (final step in <Future<void> Function()>[
      _pc.close,
      _pc.dispose,
      () async => _ownStream?.dispose(),
      _renderer.dispose,
    ]) {
      try {
        await step();
      } catch (_) {
        // Tearing down a connection that already failed.
      }
    }
    _size.dispose();
  }
}
