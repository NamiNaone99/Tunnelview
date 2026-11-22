// A scripted Tunnelview host for tests: an in-memory SignalTransport whose
// hello is signed with a real Ed25519 key, plus a fake ViewerPeer.
import 'dart:async';
import 'dart:convert';

import 'package:cryptography/cryptography.dart' as cg;
import 'package:cryptography/dart.dart' as cgdart;
import 'package:flutter/widgets.dart';
import 'package:tunnelview_mobile/proto/codec.dart';
import 'package:tunnelview_mobile/proto/pairing.dart';
import 'package:tunnelview_mobile/proto/signal.dart';
import 'package:tunnelview_mobile/rtc/peer.dart';
import 'package:tunnelview_mobile/session/transport.dart';

const String hostNodeId = 'nHOSTabc123CNTRL';
const String phoneNodeId = 'nPHONEp1x2CNTRL';
const String hostIp = '100.101.102.103';
const String phoneIp = '100.64.1.2';
const String helloNonce = 'EBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8=';

/// An Ed25519 identity from a fixed seed.
class TestIdentity {
  TestIdentity._(this._pair, this.pub);

  static Future<TestIdentity> create([int fill = 0x20]) async {
    final pair = await cgdart.DartEd25519().newKeyPairFromSeed(
      List<int>.filled(32, fill),
    );
    final pub = await pair.extractPublicKey();
    return TestIdentity._(pair, pub.bytes);
  }

  final cg.SimpleKeyPair _pair;
  final List<int> pub;

  String get pubB64Url => encodeB64Url(pub);

  Future<String> sign(List<int> message) async {
    final sig = await cgdart.DartEd25519().sign(message, keyPair: _pair);
    return base64.encode(sig.bytes);
  }
}

/// One accepted connection, seen from the host.
class FakeConnection implements SignalConnection {
  FakeConnection(this.localAddress, this.cnonce);

  @override
  final String? localAddress;
  final String cnonce;

  final StreamController<String> _toPhone = StreamController<String>();

  /// Every frame the phone sent, decoded.
  final List<Map<String, dynamic>> sent = [];
  final StreamController<Map<String, dynamic>> _sentEvents =
      StreamController.broadcast();
  bool phoneClosed = false;

  @override
  int? closeCode;

  @override
  Stream<String> get frames => _toPhone.stream;

  @override
  void send(String text) {
    final msg = jsonDecode(text) as Map<String, dynamic>;
    sent.add(msg);
    _sentEvents.add(msg);
  }

  @override
  Future<void> close([int code = 1000]) async {
    phoneClosed = true;
    if (!_toPhone.isClosed) unawaited(_toPhone.close());
  }

  /// Host to phone.
  void push(Map<String, Object?> msg) => _toPhone.add(jsonEncode(msg));

  /// The host closes the socket.
  Future<void> hangUp([int code = 1000]) async {
    closeCode = code;
    if (!_toPhone.isClosed) unawaited(_toPhone.close());
  }

  /// The next frame of type [t] the phone sends (or already sent).
  Future<Map<String, dynamic>> sentOf(String t) async {
    for (final m in sent) {
      if (m['t'] == t) return m;
    }
    return _sentEvents.stream
        .firstWhere((m) => m['t'] == t)
        .timeout(const Duration(seconds: 20));
  }

  List<Map<String, dynamic>> allSent(String t) => [
    for (final m in sent)
      if (m['t'] == t) m,
  ];
}

/// The host side of the transport.
class FakeHost implements SignalTransport {
  FakeHost(this.identity);

  final TestIdentity identity;

  /// Signs hellos instead of [identity] when set (an impostor).
  TestIdentity? signer;

  /// Fails every dial with this.
  DialFailure? dialFailure;
  String? localAddress = phoneIp;
  String viewerId = phoneNodeId;
  String hostId = hostNodeId;
  bool sendIdent = true;
  String version = '0.3.0';
  Map<String, Object?> auth = {
    'passwordSet': false,
    'acceptMode': 'ask',
    'salt': null,
    'kdf': null,
    'nonce': helloNonce,
    'autoAccept': false,
    'passwordLocked': false,
  };

  final List<String> dialed = [];
  final List<FakeConnection> connections = [];

  FakeConnection get last => connections.last;

  @override
  Future<SignalConnection> dial(String ip, int port, String cnonce) async {
    dialed.add(ip);
    final failure = dialFailure;
    if (failure != null) throw failure;
    final conn = FakeConnection(localAddress, cnonce);
    connections.add(conn);
    final hello = <String, Object?>{
      't': 'hello',
      'protocol': 2,
      'app': 'Tunnelview',
      'version': version,
      'host': {
        'hostname': 'office-pc',
        'os': 'windows',
        'user': {'login': 'alice@example.com', 'displayName': 'Alice'},
      },
      'auth': auth,
    };
    if (sendIdent) {
      hello['ident'] = {
        'v': 1,
        'alg': 'ed25519',
        'hostId': hostId,
        'viewerId': viewerId,
        'cnonce': cnonce,
        'sig': await (signer ?? identity).sign(
          identBytes(auth['nonce'], cnonce, hostId, viewerId),
        ),
      };
    }
    conn.push(hello);
    return conn;
  }
}

/// A peer that records what the session does with it.
class FakePeer implements ViewerPeer {
  FakePeer(this.events);

  final PeerEvents events;
  final List<String> offers = [];
  final List<SignalCandidate> candidates = [];
  final Map<String, List<Map<String, dynamic>>> sentByChannel = {};
  final Set<String> open = {};
  final ValueNotifier<Size> size = ValueNotifier(Size.zero);
  List<Map<dynamic, dynamic>> statsReport = const [];
  bool closed = false;

  @override
  Future<String> answer(String offerSdp) async {
    offers.add(offerSdp);
    return 'v=0\r\na=answer-${offers.length}\r\n';
  }

  @override
  Future<void> addCandidate(SignalCandidate candidate) async {
    candidates.add(candidate);
  }

  @override
  bool send(String label, String text) {
    if (!open.contains(label)) return false;
    (sentByChannel[label] ??= []).add(jsonDecode(text) as Map<String, dynamic>);
    return true;
  }

  void openChannel(String label) {
    open.add(label);
    events.onChannel(label, true);
  }

  List<Map<String, dynamic>> sentOn(String label) =>
      sentByChannel[label] ?? const [];

  @override
  Future<List<Map<dynamic, dynamic>>> stats() async => statsReport;

  @override
  Listenable get videoChanges => size;

  @override
  Size get videoSize => size.value;

  @override
  Widget buildVideo() => const SizedBox.expand(key: Key('fake-video'));

  @override
  Future<void> close() async {
    closed = true;
  }
}

/// A getStats() report whose selected pair runs between these addresses.
List<Map<dynamic, dynamic>> statsFor(String local, String remote) => [
  {'id': 'T', 'type': 'transport', 'selectedCandidatePairId': 'CP'},
  {
    'id': 'CP',
    'type': 'candidate-pair',
    'localCandidateId': 'L',
    'remoteCandidateId': 'R',
  },
  {
    'id': 'L',
    'type': 'local-candidate',
    'address': local,
    'candidateType': 'host',
    'protocol': 'udp',
  },
  {
    'id': 'R',
    'type': 'remote-candidate',
    'address': remote,
    'candidateType': 'host',
    'protocol': 'udp',
  },
];
