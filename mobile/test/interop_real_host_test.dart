// Interop: the phone's REAL transport (dart:io), pairing flow and session
// state machine against the desktop's REAL HostServer, which
// ../test/support/mobile-interop-host.js runs over loopback with node.
//
// The other tests use a scripted host written together with the client, so
// they cannot see a wrong assumption about the real one. Here the upgrade
// request, the signed hello, the pair proof, admission, password proofs and
// the signal relay all go through the host's own code.
//
// Only loopback is used: IOOverrides sends the socket the app asks for (to
// the link's Tailscale address, bound to the phone's Tailscale address) to
// 127.0.0.1 from 127.0.0.2, and records what the app asked for.
//
// Skipped where node or the desktop's dependencies are missing.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/rtc/peer.dart';
import 'package:tunnelview_mobile/session/hosts.dart';
import 'package:tunnelview_mobile/session/link.dart';
import 'package:tunnelview_mobile/session/pair_flow.dart';
import 'package:tunnelview_mobile/session/remote_session.dart';
import 'package:tunnelview_mobile/session/transport.dart';

import 'support/fake_host.dart' show FakePeer, statsFor;

const String hostScript = '../test/support/mobile-interop-host.js';

/// Why the suite cannot run here, or null.
String? unavailable() {
  if (!File(hostScript).existsSync()) {
    return 'the interop host script is missing';
  }
  if (!File('../node_modules/ws/package.json').existsSync()) {
    return 'the desktop dependencies are not installed (npm ci)';
  }
  // node must run, and 127.0.0.2 must work as a source address: the host
  // tells the phone from itself by it. Windows and Linux have the whole
  // 127.0.0.0/8 on loopback; stock macOS only has 127.0.0.1.
  const probe =
      "const net=require('net');"
      "const s=net.createServer(c=>c.destroy()).listen(0,'127.0.0.1',()=>{"
      "const c=net.connect({port:s.address().port,host:'127.0.0.1',"
      "localAddress:'127.0.0.2'});"
      "c.on('connect',()=>{c.destroy();s.close();process.exit(0)});"
      "c.on('error',()=>{s.close();process.exit(3)});});";
  try {
    final r = Process.runSync('node', ['-e', probe]);
    if (r.exitCode == 3) {
      return '127.0.0.2 cannot be used as a source address on this machine';
    }
    if (r.exitCode != 0) return 'node does not run';
  } on ProcessException {
    return 'node is not installed';
  }
  return null;
}

/// The node process that runs the real HostServer.
class RealHost {
  RealHost._(this._process);

  final Process _process;
  final List<Map<String, dynamic>> _events = [];
  final List<void Function()> _waiters = [];
  late final Map<String, dynamic> ready;

  static Future<RealHost> start() async {
    final process = await Process.start('node', [hostScript]);
    final host = RealHost._(process);
    process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen(host._onLine);
    // Anything on stderr fails the waiting test through its timeout; keep it
    // readable in the test output.
    process.stderr.transform(utf8.decoder).listen(stderr.write);
    host.ready = await host.next('ready');
    return host;
  }

  void _onLine(String line) {
    final Object? v;
    try {
      v = jsonDecode(line);
    } on FormatException {
      return;
    }
    if (v is! Map<String, dynamic>) return;
    _events.add(v);
    for (final w in List.of(_waiters)) {
      w();
    }
  }

  int get port => ready['port'] as int;
  String get hostId => ready['hostId'] as String;
  String get phoneId => ready['phoneId'] as String;
  String get linkAddress => ready['linkAddress'] as String;
  String get phoneAddress => ready['phoneAddress'] as String;

  void send(Map<String, Object?> cmd) =>
      _process.stdin.writeln(jsonEncode(cmd));

  /// The next not yet consumed event of this type.
  Future<Map<String, dynamic>> next(
    String event, {
    Duration timeout = const Duration(seconds: 15),
  }) {
    Map<String, dynamic>? take() {
      final i = _events.indexWhere((e) => e['event'] == event);
      return i < 0 ? null : _events.removeAt(i);
    }

    final now = take();
    if (now != null) return Future.value(now);
    final done = Completer<Map<String, dynamic>>();
    late void Function() waiter;
    waiter = () {
      final e = take();
      if (e != null && !done.isCompleted) {
        _waiters.remove(waiter);
        done.complete(e);
      }
    };
    _waiters.add(waiter);
    return done.future.timeout(
      timeout,
      onTimeout: () {
        _waiters.remove(waiter);
        throw TimeoutException('no "$event" from the host; got $_events');
      },
    );
  }

  /// True when an event of this type is waiting.
  bool has(String event) => _events.any((e) => e['event'] == event);

  Future<String> offer() async {
    send({'cmd': 'offer'});
    return (await next('offer'))['link'] as String;
  }

  Future<void> command(Map<String, Object?> cmd) async {
    send(cmd);
    await next('done');
  }

  Future<void> stop() async {
    try {
      send({'cmd': 'stop'});
      await _process.stdin.close();
    } catch (_) {
      // Already gone.
    }
    await _process.exitCode.timeout(
      const Duration(seconds: 5),
      onTimeout: () {
        _process.kill();
        return -1;
      },
    );
  }
}

/// What the app asked the OS for.
typedef Dial = ({String host, String? source, int port});

String? _text(Object? address) => switch (address) {
  null => null,
  InternetAddress() => address.address,
  _ => address.toString(),
};

/// dart:io as it really is: the base class forwards to the real sockets.
final class RealIo extends IOOverrides {}

/// Runs [body] with every socket the app opens sent to 127.0.0.1 from
/// 127.0.0.2, recording the addresses the app asked for in [dials].
Future<T> onLoopback<T>(List<Dial> dials, Future<T> Function() body) =>
    IOOverrides.runZoned(
      body,
      socketStartConnect: (host, port, {sourceAddress, sourcePort = 0}) {
        dials.add((
          host: _text(host)!,
          source: _text(sourceAddress),
          port: port,
        ));
        // The real connect. It stays in this zone tree (an error raised in
        // the root zone would never reach the app's code), with the override
        // switched off for this one call (a nested runZoned would inherit
        // it and call itself).
        return IOOverrides.runWithIOOverrides(
          () => Socket.startConnect(
            InternetAddress.loopbackIPv4,
            port,
            sourceAddress: InternetAddress('127.0.0.2'),
          ),
          RealIo(),
        );
      },
    );

Future<void> until(
  bool Function() condition, {
  Duration timeout = const Duration(seconds: 15),
  String what = 'condition',
}) async {
  final end = DateTime.now().add(timeout);
  while (!condition()) {
    if (DateTime.now().isAfter(end)) fail('timed out waiting for $what');
    await Future<void>.delayed(const Duration(milliseconds: 10));
  }
}

void main() {
  final skip = unavailable();
  // The app's HttpClient must be the real one (no widget binding here).
  HttpOverrides.global = null;

  // CI sets TUNNELVIEW_INTEROP=required: there the suite must run, not be
  // skipped without anyone noticing.
  test('the interop host is available where it is required', () {
    if (Platform.environment['TUNNELVIEW_INTEROP'] == 'required') {
      expect(skip, isNull, reason: 'the interop tests cannot run: $skip');
    }
  });

  late RealHost host;
  late List<Dial> dials;
  const transport = IoSignalTransport();

  setUp(() async {
    if (skip != null) return;
    host = await RealHost.start();
    dials = [];
  });

  tearDown(() async {
    if (skip != null) return;
    await host.stop();
  });

  Future<PairedHost> pairNow() async {
    final text = await host.offer();
    return pairWithLink(
      readPairLink(text, DateTime.now()),
      transport: transport,
      selfAddrs: [host.phoneAddress],
      deviceName: 'Pixel 9',
      appVersion: '0.3.0',
      now: DateTime.now,
    );
  }

  ({RemoteSession session, List<FakePeer> peers}) sessionFor(
    PairedHost record,
  ) {
    final peers = <FakePeer>[];
    final session = RemoteSession(
      host: record,
      transport: transport,
      peerFactory: (events) async {
        final p = FakePeer(events);
        peers.add(p);
        return p;
      },
      selfAddrs: [host.phoneAddress],
      deviceName: 'Pixel 9',
      appVersion: '0.3.0',
    );
    return (session: session, peers: peers);
  }

  test('pairing: the real host accepts the phone\'s upgrade, signs a hello the '
      'phone verifies, and accepts its pair proof', () async {
    await onLoopback(dials, () async {
      final text = await host.offer();
      final link = readPairLink(text, DateTime.now());
      expect(link.addresses, [host.linkAddress]);
      final record = await pairWithLink(
        link,
        transport: transport,
        selfAddrs: [host.phoneAddress],
        deviceName: 'Pixel 9',
        appVersion: '0.3.0',
        now: DateTime.now,
      );
      expect(record.hostId, host.hostId);
      expect(record.viewerId, host.phoneId);
      expect(record.fingerprintText, host.ready['fingerprint']);
      expect(record.name, 'test-host');
      expect(record.os, 'windows');
      expect(record.addresses, [host.linkAddress]);
      expect(record.port, host.port);

      final paired = await host.next('pairing');
      expect(paired['phase'], 'paired');
      expect((paired['peer'] as Map)['login'], 'bob@example.com');

      // The socket the app asked for: to the link's Tailscale address, bound
      // to the phone's own Tailscale address.
      expect(dials, [
        (host: host.linkAddress, source: host.phoneAddress, port: host.port),
      ]);

      // The code is used up: the same link is refused.
      await expectLater(
        pairWithLink(
          link,
          transport: transport,
          selfAddrs: [host.phoneAddress],
          deviceName: 'Pixel 9',
          appVersion: '0.3.0',
          now: DateTime.now,
        ),
        throwsA(
          isA<PairFailure>().having((e) => e.reason, 'reason', 'refused'),
        ),
      );
    });
  }, skip: skip);

  test('a session: request, prompt accepted, offer and answer relayed, '
      'candidates, permissions, bye', () async {
    await onLoopback(dials, () async {
      final record = await pairNow();
      final s = sessionFor(record);
      final done = s.session.start();

      final request = await host.next('request');
      expect((request['peer'] as Map)['stableId'], host.phoneId);
      expect(request['viewer'], {
        'hostname': 'Pixel 9',
        'os': 'android',
        'version': '0.3.0',
      });
      await until(
        () => s.session.phase == SessionPhase.waiting,
        what: 'the waiting phase',
      );
      expect(s.session.hello!.hostname, 'test-host');
      expect(s.session.hello!.version, '0.3.0-interop');

      await host.command({
        'cmd': 'respond',
        'accept': true,
        'permissions': {
          'control': true,
          'clipboard': false,
          'files': false,
          'audio': true,
        },
      });
      final started = await host.next('session-start');
      expect(started['via'], 'prompt');
      await until(
        () => s.session.phase == SessionPhase.live && s.peers.isNotEmpty,
        what: 'the live phase',
      );
      expect(s.session.permissions.control, isTrue);
      expect(s.session.permissions.clipboard, isFalse);
      final peer = s.peers.single;

      // Panel -> viewer: an offer, a tailnet candidate, the end of candidates.
      host.send({
        'cmd': 'signal',
        'msg': {
          't': 'sdp',
          'description': {
            'type': 'offer',
            'sdp': 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\n',
          },
        },
      });
      expect((await host.next('signal-sent'))['ok'], isTrue);
      const hostCandidate =
          'candidate:1 1 udp 2122260223 100.64.0.1 47810 typ host generation 0';
      host.send({
        'cmd': 'signal',
        'msg': {
          't': 'ice',
          'candidate': {
            'candidate': hostCandidate,
            'sdpMid': '0',
            'sdpMLineIndex': 0,
            'usernameFragment': 'abcd',
          },
        },
      });
      expect((await host.next('signal-sent'))['ok'], isTrue);
      host.send({
        'cmd': 'signal',
        'msg': {'t': 'ice', 'candidate': null},
      });
      expect((await host.next('signal-sent'))['ok'], isTrue);

      await until(
        () => peer.offers.isNotEmpty && peer.candidates.isNotEmpty,
        what: 'the offer and the candidate at the peer',
      );
      expect(peer.candidates.single.candidate, hostCandidate);
      expect(peer.candidates.single.usernameFragment, 'abcd');

      // Viewer -> panel: the answer, through the host's own validation.
      final answer = await host.next('session-signal');
      expect(answer['msg'], {
        't': 'sdp',
        'description': {'type': 'answer', 'sdp': 'v=0\r\na=answer-1\r\n'},
      });

      // A local candidate from the phone, as the engine reports it.
      const phoneCandidate =
          'candidate:9 1 udp 2122260223 100.64.1.2 50000 typ host generation 0';
      peer.events.onCandidate({
        'candidate': phoneCandidate,
        'sdpMid': '0',
        'sdpMLineIndex': 0,
      });
      final ice = await host.next('session-signal');
      expect(ice['msg'], {
        't': 'ice',
        'candidate': {
          'candidate': phoneCandidate,
          'sdpMid': '0',
          'sdpMLineIndex': 0,
          'usernameFragment': null,
        },
      });

      // The host changes the permissions.
      await host.command({
        'cmd': 'permissions',
        'permissions': {'control': false},
      });
      await until(
        () => !s.session.permissions.control,
        what: 'the permission change',
      );
      expect(s.session.permissions.audio, isTrue);

      // The media path comes up over the tunnel, then the user leaves.
      peer.statsReport = statsFor(host.phoneAddress, host.linkAddress);
      peer.events.onState(PeerState.connected);
      s.session.close();
      await done;
      final ended = await host.next('session-end');
      expect(ended['reason'], 'viewer-ended');
      expect(s.session.closeReason!.reason, 'local');
    });
  }, skip: skip);

  test(
    'a password-only host: a wrong password, then the right one, checked '
    'by the real host',
    () async {
      await onLoopback(dials, () async {
        final record = await pairNow();
        await host.command({'cmd': 'password', 'value': 'correct horse 22'});
        await host.command({
          'cmd': 'settings',
          'patch': {'acceptMode': 'password-only'},
        });
        final s = sessionFor(record);
        final done = s.session.start();
        await until(
          () => s.session.phase == SessionPhase.password,
          what: 'the password phase',
        );
        expect(host.has('request'), isFalse, reason: 'no prompt in this mode');

        expect(await s.session.submitPassword('wrong horse 22'), isNull);
        await until(() => s.session.remaining != null, what: 'auth-failed');
        expect(s.session.phase, SessionPhase.password);
        expect(s.session.remaining, 2);

        expect(await s.session.submitPassword('correct horse 22'), isNull);
        final started = await host.next('session-start');
        expect(started['via'], 'password');
        await until(
          () => s.session.phase == SessionPhase.live,
          what: 'the live phase',
        );

        // The host ends the session and says why.
        await host.command({'cmd': 'end', 'reason': 'capture-blocked'});
        await done;
        expect(s.session.closeReason!.reason, 'host-ended');
        expect(s.session.closeReason!.hostReason, 'capture-blocked');
      });
    },
    skip: skip,
    timeout: const Timeout(Duration(minutes: 2)),
  );

  test('a declined prompt and a policy refusal reach the phone with their '
      'reasons', () async {
    await onLoopback(dials, () async {
      final record = await pairNow();
      var s = sessionFor(record);
      var done = s.session.start();
      await host.next('request');
      await host.command({'cmd': 'respond', 'accept': false});
      await done;
      expect(s.session.closeReason!.reason, 'denied:rejected');

      // allowFrom 'list' without this phone: HTTP 403 before any WebSocket.
      await host.command({
        'cmd': 'settings',
        'patch': {'allowFrom': 'list', 'allowList': <String>[]},
      });
      s = sessionFor(record);
      done = s.session.start();
      await done;
      expect(s.session.closeReason!.reason, 'denied:not-allowed');
    });
  }, skip: skip);

  test('a record pinned to another key or another phone ID gets a hello it '
      'refuses, and the host never sees a request', () async {
    await onLoopback(dials, () async {
      final record = await pairNow();
      final otherKey = PairedHost(
        hostId: record.hostId,
        name: record.name,
        dnsName: record.dnsName,
        addresses: record.addresses,
        port: record.port,
        // Another valid Ed25519 public key (RFC 8032 test 1).
        key: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo',
        viewerId: record.viewerId,
        os: record.os,
        pairedAt: record.pairedAt,
      );
      var s = sessionFor(otherKey);
      await s.session.start();
      expect(s.session.closeReason!.reason, 'identity-mismatch');

      final otherPhone = PairedHost(
        hostId: record.hostId,
        name: record.name,
        dnsName: record.dnsName,
        addresses: record.addresses,
        port: record.port,
        key: record.key,
        viewerId: 'nSOMEOTHERCNTRL',
        os: record.os,
        pairedAt: record.pairedAt,
      );
      s = sessionFor(otherPhone);
      await s.session.start();
      expect(s.session.closeReason!.reason, 'viewer-changed');

      await Future<void>.delayed(const Duration(milliseconds: 200));
      expect(host.has('request'), isFalse);
      expect(host.has('session-start'), isFalse);
    });
  }, skip: skip);

  test('the host\'s upgrade rate limit arrives as rate-limited', () async {
    await onLoopback(dials, () async {
      final record = await pairNow();
      String? reason;
      // 20 upgrades a minute per source address; pairing used one.
      for (var i = 0; i < 25 && reason == null; i++) {
        try {
          final link = await HostLink.open(
            transport: transport,
            addresses: record.addresses,
            port: record.port,
            key: record.keyBytes,
            hostId: record.hostId,
            viewerId: record.viewerId,
            selfAddrs: [host.phoneAddress],
          );
          await link.close();
          // The host allows two unanswered connections per node: let it see
          // the close.
          await Future<void>.delayed(const Duration(milliseconds: 20));
        } on LinkFailure catch (e) {
          reason = e.reason;
        }
      }
      expect(reason, 'rate-limited');
    });
  }, skip: skip);

  test('nothing but Tailscale addresses is ever asked of the OS', () async {
    await onLoopback(dials, () async {
      await pairNow();
      expect(dials, isNotEmpty);
      for (final d in dials) {
        expect(d.host, host.linkAddress);
        expect(d.source, host.phoneAddress);
      }
      // No phone address of the link's family: nothing is dialed at all.
      dials.clear();
      final text = await host.offer();
      await expectLater(
        pairWithLink(
          readPairLink(text, DateTime.now()),
          transport: transport,
          selfAddrs: const ['fd7a:115c:a1e0::2', '192.168.1.20'],
          deviceName: 'Pixel 9',
          appVersion: '0.3.0',
          now: DateTime.now,
        ),
        throwsA(
          isA<PairFailure>().having(
            (e) => e.reason,
            'reason',
            'not-tailnet-route',
          ),
        ),
      );
      expect(dials, isEmpty);
    });
  }, skip: skip);
}
