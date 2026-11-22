// Pairing and the session state machine against a scripted host whose hello
// is really signed (test/support/fake_host.dart). No network, no WebRTC.
import 'dart:convert';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/proto/auth.dart';
import 'package:tunnelview_mobile/proto/codec.dart';
import 'package:tunnelview_mobile/proto/pairing.dart';
import 'package:tunnelview_mobile/rtc/peer.dart';
import 'package:tunnelview_mobile/session/hosts.dart';
import 'package:tunnelview_mobile/session/link.dart';
import 'package:tunnelview_mobile/session/pair_flow.dart';
import 'package:tunnelview_mobile/session/remote_session.dart';
import 'package:tunnelview_mobile/session/transport.dart';

import 'support/fake_host.dart';

final DateTime now = DateTime.utc(2026, 11, 22, 12);
final List<int> token = List<int>.generate(16, (i) => 0x70 + i);

PairLink linkFor(TestIdentity id, {int? expiresAt, List<String>? addresses}) =>
    PairLink(
      hostId: hostNodeId,
      name: 'office-pc.tail1234.ts.net',
      addresses: addresses ?? const [hostIp],
      port: 47800,
      key: id.pubB64Url,
      token: encodeB64Url(token),
      expiresAt: expiresAt ?? now.millisecondsSinceEpoch ~/ 1000 + 60,
    );

PairedHost recordFor(TestIdentity id) => PairedHost(
  hostId: hostNodeId,
  name: 'office-pc',
  dnsName: 'office-pc.tail1234.ts.net',
  addresses: const [hostIp],
  port: 47800,
  key: id.pubB64Url,
  viewerId: phoneNodeId,
  os: 'windows',
  pairedAt: 1,
);

const String phoneIp6 = 'fd7a:115c:a1e0::2';

Future<PairedHost> pair(
  FakeHost host,
  PairLink link, {
  List<String> selfAddrs = const [phoneIp],
}) => pairWithLink(
  link,
  transport: host,
  selfAddrs: selfAddrs,
  deviceName: 'Pixel',
  appVersion: '0.3.0',
  now: () => now,
);

class Harness {
  Harness(this.host, this.session);

  final FakeHost host;
  final RemoteSession session;
  FakePeer? peer;
  late Future<void> done;
}

Harness sessionWith(
  FakeHost host,
  TestIdentity id, {
  String? Function()? gate,
  Future<String> Function(String)? normalizePassword,
  Duration mediaTimeout = const Duration(seconds: 30),
  Duration disconnectGrace = const Duration(seconds: 35),
  Duration pathRecheck = const Duration(seconds: 5),
}) {
  late Harness h;
  final session = RemoteSession(
    host: recordFor(id),
    transport: host,
    peerFactory: (events) async => h.peer = FakePeer(events),
    selfAddrs: const [phoneIp],
    deviceName: 'Pixel',
    appVersion: '0.3.0',
    gate: gate,
    normalizePassword: normalizePassword,
    mediaTimeout: mediaTimeout,
    disconnectGrace: disconnectGrace,
    pathRecheck: pathRecheck,
  );
  h = Harness(host, session);
  h.done = session.start();
  return h;
}

/// Sends `accepted` once the request is out.
Future<void> accept(
  FakeHost host, {
  Map<String, Object?> permissions = const {'control': true},
}) async {
  await settle();
  await host.last.sentOf('request');
  host.last.push({
    't': 'accepted',
    'sessionId': 's1',
    'permissions': permissions,
    'via': 'prompt',
  });
  await settle();
}

/// Lets queued microtasks and stream events run.
Future<void> settle() async {
  for (var i = 0; i < 20; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

Future<Harness> accepted(
  FakeHost host,
  TestIdentity id, {
  Map<String, Object?> permissions = const {'control': true},
}) async {
  final h = sessionWith(host, id);
  await host.connections.isEmpty.then((_) => settle());
  await host.last.sentOf('request');
  host.last.push({
    't': 'accepted',
    'sessionId': 's1',
    'permissions': permissions,
    'via': 'prompt',
  });
  await settle();
  return h;
}

extension on bool {
  Future<void> then(Future<void> Function(bool) f) => f(this);
}

void main() {
  late TestIdentity id;
  late FakeHost host;

  setUp(() async {
    id = await TestIdentity.create();
    host = FakeHost(id);
  });

  group('pairing', () {
    test('sends a valid proof and stores what the host signed', () async {
      final future = pair(host, linkFor(id));
      await settle();
      final conn = host.last;
      final msg = await conn.sentOf('pair');
      expect(
        msg['proof'],
        pairProof(token, helloNonce, conn.cnonce, hostNodeId, phoneNodeId),
      );
      expect(msg['device'], {
        'name': 'Pixel',
        'os': 'android',
        'version': '0.3.0',
      });
      conn.push({
        't': 'pair-result',
        'ok': true,
        'hostId': hostNodeId,
        'viewerId': phoneNodeId,
        'peer': {'name': 'pixel', 'login': 'alice@example.com'},
      });
      final record = await future;
      expect(record.hostId, hostNodeId);
      expect(record.viewerId, phoneNodeId);
      expect(record.name, 'office-pc');
      expect(record.addresses, [hostIp]);
      expect(record.key, id.pubB64Url);
      expect(record.fingerprintText, fingerprint(id.pub));
      expect(conn.phoneClosed, isTrue);
      // The record survives storage.
      final again = PairedHost.fromJson(jsonDecode(jsonEncode(record)));
      expect(again!.toJson(), record.toJson());
    });

    test('a link far past its expiry dials nothing', () async {
      final link = linkFor(
        id,
        expiresAt: now.millisecondsSinceEpoch ~/ 1000 - 301,
      );
      await expectLater(
        pair(host, link),
        throwsA(
          isA<PairFailure>().having((e) => e.reason, 'reason', 'expired'),
        ),
      );
      expect(host.dialed, isEmpty);
    });

    test('the computer decides about a link that is only a little past its '
        'expiry by the phone\'s clock', () async {
      // The phone's clock is 3 minutes ahead: the code looks expired here but
      // is still good on the computer.
      final link = linkFor(
        id,
        expiresAt: now.millisecondsSinceEpoch ~/ 1000 - 180,
      );
      final accepted = pair(host, link);
      await settle();
      await host.last.sentOf('pair');
      host.last.push({
        't': 'pair-result',
        'ok': true,
        'hostId': hostNodeId,
        'viewerId': phoneNodeId,
      });
      expect((await accepted).hostId, hostNodeId);

      // The same link refused by the computer: it really did run out.
      final refused = pair(host, link);
      await settle();
      await host.last.sentOf('pair');
      host.last.push({'t': 'pair-result', 'ok': false, 'reason': 'failed'});
      await expectLater(
        refused,
        throwsA(
          isA<PairFailure>().having((e) => e.reason, 'reason', 'expired'),
        ),
      );
    });

    test('a hello signed by another key: nothing is sent', () async {
      host.signer = await TestIdentity.create(0x55);
      await expectLater(
        pair(host, linkFor(id)),
        throwsA(
          isA<PairFailure>().having(
            (e) => e.reason,
            'reason',
            'identity-mismatch',
          ),
        ),
      );
      expect(host.last.sent, isEmpty);
      expect(host.last.phoneClosed, isTrue);
    });

    test('a hello signed for another host ID: nothing is sent', () async {
      host.hostId = 'nOTHERhost1CNTRL';
      await expectLater(
        pair(host, linkFor(id)),
        throwsA(
          isA<PairFailure>().having(
            (e) => e.reason,
            'reason',
            'identity-mismatch',
          ),
        ),
      );
      expect(host.last.sent, isEmpty);
    });

    test('an unsigned hello from an old host', () async {
      host
        ..sendIdent = false
        ..version = '0.2.0';
      await expectLater(
        pair(host, linkFor(id)),
        throwsA(
          isA<PairFailure>().having((e) => e.reason, 'reason', 'host-too-old'),
        ),
      );
      expect(host.last.sent, isEmpty);
    });

    test(
      'a socket that does not run over Tailscale: nothing is sent',
      () async {
        host.localAddress = '192.168.1.20';
        await expectLater(
          pair(host, linkFor(id)),
          throwsA(
            isA<PairFailure>().having(
              (e) => e.reason,
              'reason',
              'not-tailnet-route',
            ),
          ),
        );
        expect(host.last.sent, isEmpty);
      },
    );

    test('the computer refuses', () async {
      final future = pair(host, linkFor(id));
      await settle();
      await host.last.sentOf('pair');
      host.last.push({'t': 'pair-result', 'ok': false, 'reason': 'failed'});
      await expectLater(
        future,
        throwsA(
          isA<PairFailure>().having((e) => e.reason, 'reason', 'refused'),
        ),
      );
    });

    test('an unreachable IPv4 address falls back to IPv6, each dial bound to '
        'the phone address of that family', () async {
      host.dialFailure = const DialFailure('unreachable');
      await expectLater(
        pair(
          host,
          linkFor(id, addresses: const [hostIp, 'fd7a:115c:a1e0::1234']),
          selfAddrs: const ['FD7A:115C:A1E0:0::2', phoneIp],
        ),
        throwsA(
          isA<PairFailure>().having((e) => e.reason, 'reason', 'unreachable'),
        ),
      );
      expect(host.dialed, [hostIp, 'fd7a:115c:a1e0::1234']);
      expect(host.bound, [phoneIp, phoneIp6]);
    });

    test('every dial is bound to the phone\'s own Tailscale address', () async {
      final future = pair(host, linkFor(id));
      await settle();
      expect(host.bound, [phoneIp]);
      host.last.push({
        't': 'pair-result',
        'ok': true,
        'hostId': hostNodeId,
        'viewerId': phoneNodeId,
      });
      await future;
    });

    test('an address family the phone has no Tailscale address for is not '
        'dialed', () async {
      // IPv4-only phone, IPv4 unreachable: IPv6 is skipped, not dialed
      // unbound.
      host.dialFailure = const DialFailure('unreachable');
      await expectLater(
        pair(
          host,
          linkFor(id, addresses: const [hostIp, 'fd7a:115c:a1e0::1234']),
        ),
        throwsA(
          isA<PairFailure>().having((e) => e.reason, 'reason', 'unreachable'),
        ),
      );
      expect(host.dialed, [hostIp]);

      // No Tailscale address of the host's only family: nothing is dialed.
      final other = FakeHost(id);
      await expectLater(
        pair(other, linkFor(id), selfAddrs: const [phoneIp6, '192.168.1.20']),
        throwsA(
          isA<PairFailure>().having(
            (e) => e.reason,
            'reason',
            'not-tailnet-route',
          ),
        ),
      );
      expect(other.dialed, isEmpty);
    });

    test('bindAddressFor', () {
      expect(bindAddressFor(hostIp, const [phoneIp6, phoneIp]), phoneIp);
      expect(
        bindAddressFor('fd7a:115c:a1e0::9', const [phoneIp, phoneIp6]),
        phoneIp6,
      );
      expect(
        bindAddressFor(hostIp, const ['192.168.1.20', '10.0.0.1']),
        isNull,
      );
      expect(bindAddressFor(hostIp, const []), isNull);
      expect(bindAddressFor('office-pc', const [phoneIp]), isNull);
    });

    test('HTTP refusals', () async {
      for (final (status, reason) in [
        (403, 'denied:not-allowed'),
        (429, 'rate-limited'),
        (503, 'denied:busy'),
        (426, 'protocol'),
        (404, 'not-tunnelview'),
      ]) {
        host.dialFailure = DialFailure('http', status: status);
        await expectLater(
          pair(host, linkFor(id)),
          throwsA(isA<PairFailure>().having((e) => e.reason, 'reason', reason)),
        );
      }
    });

    test('readPairLink', () {
      final link = linkFor(id);
      final text = linkPrefix + encodeB64Url(utf8.encode(link.canonicalJson()));
      expect(readPairLink('  $text\n', now).hostId, hostNodeId);
      expect(
        () => readPairLink('https://example.com', now),
        throwsA(isA<PairFailure>().having((e) => e.reason, 'reason', 'link')),
      );
      // One minute of validity plus the five minutes of clock slack.
      expect(
        readPairLink(text, now.add(const Duration(minutes: 5))).hostId,
        hostNodeId,
      );
      expect(
        () => readPairLink(text, now.add(const Duration(minutes: 7))),
        throwsA(
          isA<PairFailure>().having((e) => e.reason, 'reason', 'expired'),
        ),
      );
    });
  });

  group('session', () {
    test('asks, is accepted, answers the offer, filters candidates', () async {
      final h = sessionWith(host, id);
      await settle();
      final conn = host.last;
      final request = await conn.sentOf('request');
      expect(request, {
        't': 'request',
        'protocol': 2,
        'viewer': {'hostname': 'Pixel', 'os': 'android', 'version': '0.3.0'},
        'proof': null,
      });
      expect(h.session.phase, SessionPhase.waiting);
      expect(h.session.hello!.hostname, 'office-pc');

      conn.push({'t': 'pending'});
      conn.push({
        't': 'accepted',
        'sessionId': 's1',
        'permissions': {'control': true, 'clipboard': true},
        'via': 'prompt',
      });
      await settle();
      expect(h.session.phase, SessionPhase.live);
      expect(h.session.permissions.control, isTrue);
      expect(h.session.controlBlock, 'starting');

      conn.push({
        't': 'sdp',
        'description': {
          'type': 'offer',
          'sdp': 'v=0\r\no=- 1 2 IN IP4 0.0.0.0',
        },
      });
      conn.push({
        't': 'ice',
        'candidate': {
          'candidate':
              'candidate:1 1 udp 2122260223 $hostIp 47810 typ host generation 0',
          'sdpMid': '0',
          'sdpMLineIndex': 0,
        },
      });
      // Outside the tailnet: must never reach the peer.
      conn.push({
        't': 'ice',
        'candidate': {
          'candidate': 'candidate:2 1 udp 2122260223 192.168.1.20 47810 typ host generation 0',
          'sdpMid': '0',
          'sdpMLineIndex': 0,
        },
      });
      conn.push({'t': 'ice', 'candidate': null});
      await settle();
      final peer = h.peer!;
      expect(peer.offers, hasLength(1));
      expect(peer.candidates.map((c) => c.candidate), [
        'candidate:1 1 udp 2122260223 $hostIp 47810 typ host generation 0',
      ]);
      final answer = await conn.sentOf('sdp');
      expect(answer['description'], {
        'type': 'answer',
        'sdp': 'v=0\r\na=answer-1\r\n',
      });

      // Local candidates: only Tailscale ones are sent.
      peer.events.onCandidate({
        'candidate':
            'candidate:9 1 udp 2122260223 $phoneIp 50000 typ host generation 0',
        'sdpMid': '0',
        'sdpMLineIndex': 0,
      });
      peer.events.onCandidate({
        'candidate':
            'candidate:8 1 udp 2122260223 10.0.0.5 50000 typ host generation 0',
        'sdpMid': '0',
        'sdpMLineIndex': 0,
      });
      expect(conn.allSent('ice'), hasLength(1));

      // Connected over the tunnel, channels open: the phone controls.
      peer.statsReport = statsFor(phoneIp, hostIp);
      peer.events.onState(PeerState.connected);
      peer.openChannel('control');
      peer.openChannel('input');
      await settle();
      expect(h.session.media, MediaState.connected);
      expect(h.session.path!.ok, isTrue);
      expect(h.session.canControl, isTrue);
      expect(peer.sentOn('control'), [
        {'t': 'quality', 'preset': 'balanced'},
      ]);
      expect(h.session.sendInput({'t': 'mm', 'x': 0.5, 'y': 0.5}), isTrue);

      // Displays and host state arrive on the control channel.
      peer.events.onControl(
        jsonEncode({
          't': 'displays',
          'displays': [
            {
              'id': 'a',
              'name': 'DELL',
              'primary': true,
              'width': 3840,
              'height': 2160,
              'scaleFactor': 1.5,
            },
            {'id': 'b', 'name': 'Second', 'width': 1920, 'height': 1080},
          ],
          'current': 'a',
        }),
      );
      expect(h.session.displays.map((d) => d.id), ['a', 'b']);
      expect(h.session.currentDisplay, 'a');
      h.session.selectDisplay('b');
      h.session.selectDisplay('nope');
      expect(peer.sentOn('control').last, {'t': 'select-display', 'id': 'b'});

      // The host pauses control: keys are released, input stops.
      peer.events.onControl(
        jsonEncode({'t': 'host-state', 'controlAllowed': false}),
      );
      expect(h.session.controlBlock, 'host-paused');
      expect(peer.sentOn('input').last, {'t': 'release-all'});
      expect(h.session.sendInput({'t': 'mm', 'x': 0.1, 'y': 0.1}), isFalse);

      // The user leaves.
      h.session.close();
      await settle();
      expect(conn.sent.last, {'t': 'bye', 'reason': 'viewer-closed'});
      expect(h.session.phase, SessionPhase.closed);
      expect(h.session.closeReason!.reason, 'local');
      expect(peer.closed, isTrue);
      expect(conn.phoneClosed, isTrue);
      await h.done;
    });

    test(
      'a password-only computer gets a proof bound to the signed IDs',
      () async {
        const salt = 'AAECAwQFBgcICQoLDA0ODw==';
        const kdf = {'N': 16384, 'r': 8, 'p': 1, 'keylen': 32};
        host.auth = {
          ...host.auth,
          'passwordSet': true,
          'acceptMode': 'password-only',
          'salt': salt,
          'kdf': kdf,
        };
        final h = sessionWith(host, id);
        await settle();
        expect(h.session.phase, SessionPhase.password);
        expect(host.last.sent, isEmpty);

        expect(await h.session.submitPassword(''), 'invalid');
        expect(await h.session.submitPassword('hunter22-wrong'), isNull);
        final request = await host.last.sentOf('request');
        expect(
          request['proof'],
          await computeProof(
            'hunter22-wrong',
            {'salt': salt, 'kdf': kdf},
            helloNonce,
            {'hostId': hostNodeId, 'viewerId': phoneNodeId},
          ),
        );
        expect(h.session.phase, SessionPhase.waiting);

        host.last.push({'t': 'auth-failed', 'remaining': 2});
        await settle();
        expect(h.session.phase, SessionPhase.password);
        expect(h.session.remaining, 2);

        expect(await h.session.submitPassword('hunter22'), isNull);
        final auth = await host.last.sentOf('auth');
        expect(auth['proof'], isNot(request['proof']));
        host.last.push({
          't': 'accepted',
          'sessionId': 's2',
          'permissions': {'control': false},
          'via': 'password',
        });
        await settle();
        expect(h.session.phase, SessionPhase.live);
        expect(h.session.controlBlock, 'view-only');
        h.session.close();
        await h.done;
      },
      timeout: const Timeout(Duration(minutes: 3)),
    );

    test('auto-accept and locked hosts never get a proof', () async {
      host.auth = {
        ...host.auth,
        'passwordSet': true,
        'acceptMode': 'password-only',
        'salt': 'AAECAwQFBgcICQoLDA0ODw==',
        'kdf': {'N': 16384, 'r': 8, 'p': 1, 'keylen': 32},
        'passwordLocked': true,
      };
      final h = sessionWith(host, id);
      await settle();
      final request = await host.last.sentOf('request');
      expect(request['proof'], isNull);
      expect(await h.session.submitPassword('whatever1'), 'locked');
      host.last.push({'t': 'denied', 'reason': 'locked'});
      await h.done;
      expect(h.session.closeReason!.reason, 'denied:locked');
    });

    test(
      'unsafe KDF parameters end the session before anything is sent',
      () async {
        host.auth = {
          ...host.auth,
          'passwordSet': true,
          'salt': 'AAECAwQFBgcICQoLDA0ODw==',
          'kdf': {'N': 1024, 'r': 1, 'p': 1, 'keylen': 32},
        };
        final h = sessionWith(host, id);
        await h.done;
        expect(h.session.closeReason!.reason, 'protocol');
        expect(host.last.sent, isEmpty);
      },
    );

    test('the host sees this phone as another node: pair again', () async {
      host.viewerId = 'nOTHERphoneCNTRL';
      final h = sessionWith(host, id);
      await h.done;
      expect(h.session.closeReason!.reason, 'viewer-changed');
      expect(host.last.sent, isEmpty);
    });

    test('an impostor at the paired address gets nothing', () async {
      host.signer = await TestIdentity.create(0x66);
      final h = sessionWith(host, id);
      await h.done;
      expect(h.session.closeReason!.reason, 'identity-mismatch');
      expect(host.last.sent, isEmpty);
    });

    test('denied reasons', () async {
      var h = sessionWith(host, id);
      await settle();
      await host.last.sentOf('request');
      host.last.push({
        't': 'denied',
        'reason': 'try-later',
        'retryAfterSec': 40,
      });
      await h.done;
      expect(h.session.closeReason!.reason, 'denied:try-later');
      expect(h.session.closeReason!.retryAfterSec, 40);

      h = sessionWith(host, id);
      await settle();
      host.last.push({'t': 'denied', 'reason': 'busy', 'updating': true});
      await h.done;
      expect(h.session.closeReason!.reason, 'host-updating');

      h = sessionWith(host, id);
      await settle();
      host.last.push({'t': 'denied', 'reason': 'made-up'});
      await h.done;
      expect(h.session.closeReason!.reason, 'denied:protocol');
    });

    test('a media path outside the tailnet ends the session', () async {
      final h = await accepted(host, id);
      final peer = h.peer!;
      peer.statsReport = statsFor('192.168.1.5', hostIp);
      peer.events.onState(PeerState.connected);
      await h.done.timeout(const Duration(seconds: 5), onTimeout: () {});
      await settle();
      expect(h.session.closeReason!.reason, 'non-tailnet-path');
      expect(host.last.sent.last, {'t': 'bye', 'reason': 'non-tailnet-path'});
      expect(peer.closed, isTrue);
    });

    test('the host ends the session and says why', () async {
      final h = await accepted(host, id);
      host.last.push({'t': 'bye', 'reason': 'capture-blocked'});
      await h.done;
      expect(h.session.closeReason!.reason, 'host-ended');
      expect(h.session.closeReason!.hostReason, 'capture-blocked');
    });

    test('a dropped socket is a network end', () async {
      final h = await accepted(host, id);
      await host.last.hangUp(1006);
      await h.done;
      expect(h.session.closeReason!.reason, 'network');
    });

    test(
      'losing the media path stops input, and gives up after the grace',
      () async {
        final h = sessionWith(
          host,
          id,
          disconnectGrace: const Duration(milliseconds: 50),
        );
        await accept(host);
        final peer = h.peer!;
        peer.statsReport = statsFor(phoneIp, hostIp);
        peer.events.onState(PeerState.connected);
        peer.openChannel('input');
        await settle();
        expect(h.session.canControl, isTrue);
        peer.events.onState(PeerState.disconnected);
        expect(h.session.controlBlock, 'recovering');
        expect(peer.sentOn('input').last, {'t': 'release-all'});
        await Future<void>.delayed(const Duration(milliseconds: 120));
        await settle();
        expect(h.session.closeReason!.reason, 'network');
        expect(host.last.sent.last, {'t': 'bye', 'reason': 'network'});
      },
    );

    test('permissions pushed by the host', () async {
      final h = await accepted(host, id, permissions: const {'control': false});
      expect(h.session.permissions.control, isFalse);
      host.last.push({
        't': 'permissions',
        'permissions': {'control': true, 'audio': 1},
      });
      await settle();
      expect(h.session.permissions.control, isTrue);
      expect(h.session.permissions.audio, isFalse);
      h.session.close();
      await h.done;
    });

    test('the gate is asked before dialing', () async {
      final h = sessionWith(host, id, gate: () => 'self-test-failed');
      await h.done;
      expect(h.session.closeReason!.reason, 'gate:self-test-failed');
      expect(host.dialed, isEmpty);
    });

    test('the gate is asked again before WebRTC starts', () async {
      String? refusal;
      final h = sessionWith(host, id, gate: () => refusal);
      await settle();
      await host.last.sentOf('request');
      // Tailscale goes away while the request waits to be accepted.
      refusal = 'tailscale-off';
      host.last.push({
        't': 'accepted',
        'sessionId': 's1',
        'permissions': {'control': true},
      });
      await h.done.timeout(const Duration(seconds: 5), onTimeout: () {});
      await settle();
      expect(h.session.closeReason!.reason, 'gate:tailscale-off');
      expect(h.peer, isNull, reason: 'no peer connection was created');
      expect(host.last.sent.last, {'t': 'bye', 'reason': 'viewer-closed'});
    });

    test(
      'no picture in time ends the session, even with ICE connected',
      () async {
        final h = sessionWith(
          host,
          id,
          mediaTimeout: const Duration(milliseconds: 80),
        );
        await accept(host);
        final peer = h.peer!;
        peer.statsReport = statsFor(phoneIp, hostIp);
        peer.events.onState(PeerState.connected);
        peer.openChannel('input');
        await settle();
        expect(h.session.media, MediaState.connected);
        expect(h.session.hasPicture, isFalse);
        await Future<void>.delayed(const Duration(milliseconds: 160));
        await settle();
        expect(h.session.closeReason!.reason, 'media-timeout');
        expect(host.last.sent.last, {'t': 'bye', 'reason': 'media-timeout'});
      },
    );

    test('the first frame stops the picture deadline', () async {
      final h = sessionWith(
        host,
        id,
        mediaTimeout: const Duration(milliseconds: 80),
      );
      await accept(host);
      final peer = h.peer!;
      peer.statsReport = statsFor(phoneIp, hostIp);
      peer.events.onState(PeerState.connected);
      peer.size.value = const Size(1920, 1080);
      await settle();
      expect(h.session.hasPicture, isTrue);
      await Future<void>.delayed(const Duration(milliseconds: 160));
      await settle();
      expect(h.session.phase, SessionPhase.live);
      h.session.close();
      await h.done;
    });

    test('the path is checked again later: a switch off the tailnet ends the '
        'session', () async {
      final h = sessionWith(
        host,
        id,
        pathRecheck: const Duration(milliseconds: 30),
      );
      await accept(host);
      final peer = h.peer!;
      peer.statsReport = statsFor(phoneIp, hostIp);
      peer.events.onState(PeerState.connected);
      peer.size.value = const Size(1920, 1080);
      await settle();
      expect(h.session.path!.ok, isTrue);
      expect(h.session.phase, SessionPhase.live);
      // ICE moves to another candidate pair while still "connected".
      peer.statsReport = statsFor(phoneIp, '203.0.113.5');
      await Future<void>.delayed(const Duration(milliseconds: 120));
      await settle();
      expect(h.session.closeReason!.reason, 'non-tailnet-path');
      expect(host.last.sent.last, {'t': 'bye', 'reason': 'non-tailnet-path'});
    });

    test('a non-ASCII password is normalised before hashing; ASCII is not '
        'touched', () async {
      const salt = 'AAECAwQFBgcICQoLDA0ODw==';
      const kdf = {'N': 16384, 'r': 8, 'p': 1, 'keylen': 32};
      host.auth = {
        ...host.auth,
        'passwordSet': true,
        'acceptMode': 'password-only',
        'salt': salt,
        'kdf': kdf,
      };
      final asked = <String>[];
      final h = sessionWith(
        host,
        id,
        // Stands in for Android's NFC: maps the typed text to another one.
        normalizePassword: (text) async {
          asked.add(text);
          return 'normalised-form';
        },
      );
      await settle();
      expect(await h.session.submitPassword('รหัส-typed'), isNull);
      final request = await host.last.sentOf('request');
      expect(asked, ['รหัส-typed']);
      expect(
        request['proof'],
        await computeProof(
          'normalised-form',
          {'salt': salt, 'kdf': kdf},
          helloNonce,
          {'hostId': hostNodeId, 'viewerId': phoneNodeId},
        ),
      );
      host.last.push({'t': 'auth-failed', 'remaining': 2});
      await settle();
      expect(await h.session.submitPassword('plain-ascii-1'), isNull);
      final auth = await host.last.sentOf('auth');
      expect(asked, hasLength(1), reason: 'ASCII is already NFC');
      expect(
        auth['proof'],
        await computeProof(
          'plain-ascii-1',
          {'salt': salt, 'kdf': kdf},
          helloNonce,
          {'hostId': hostNodeId, 'viewerId': phoneNodeId},
        ),
      );
      h.session.close();
      await h.done;
    }, timeout: const Timeout(Duration(minutes: 3)));
  });

  test('localPathOk', () {
    expect(localPathOk(phoneIp, hostIp, const [phoneIp]), isTrue);
    expect(localPathOk(null, hostIp, const [phoneIp]), isFalse);
    expect(localPathOk('10.0.0.2', hostIp, const [phoneIp]), isFalse);
    expect(
      localPathOk('fd7a:115c:a1e0::2', hostIp, const [
        phoneIp,
        'fd7a:115c:a1e0::2',
      ]),
      isFalse,
      reason: 'other family than the dialed address',
    );
    expect(
      localPathOk('FD7A:115C:A1E0:0::2', 'fd7a:115c:a1e0::9', const [
        'fd7a:115c:a1e0::2',
      ]),
      isTrue,
    );
  });

  test('hasIdentities', () {
    expect(hasIdentities('0.2.9'), isFalse);
    expect(hasIdentities('0.3.0'), isTrue);
    expect(hasIdentities('1.0.0'), isTrue);
    expect(hasIdentities('junk'), isFalse);
  });
}
