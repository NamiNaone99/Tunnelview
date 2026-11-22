// The pairing and session screens against the scripted host
// (test/support/fake_host.dart): what the user sees and what goes on the wire.
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/app/connectivity.dart';
import 'package:tunnelview_mobile/app/services.dart';
import 'package:tunnelview_mobile/app_info.dart';
import 'package:tunnelview_mobile/proto/codec.dart';
import 'package:tunnelview_mobile/proto/pairing.dart';
import 'package:tunnelview_mobile/rtc/peer.dart';
import 'package:tunnelview_mobile/session/hosts.dart';
import 'package:tunnelview_mobile/session/transport.dart';
import 'package:tunnelview_mobile/ui/home_screen.dart';
import 'package:tunnelview_mobile/ui/key_input.dart';

import 'support/fake_host.dart';
import 'support/fake_tailnet.dart';

const info = AppInfo(
  version: '0.3.0',
  build: '300',
  channel: BuildChannel.release,
);

// The phone's Tailscale address in the fake tailnet (support/fake_tailnet).
const String tunIp = '100.101.12.7';

class MemoryStorage implements HostStorage {
  String? value;

  @override
  Future<String?> read() async => value;

  @override
  Future<void> write(String v) async => value = v;
}

/// Replaced by the fake host in `boot`; dials nothing.
class NoTransport implements SignalTransport {
  const NoTransport();

  @override
  Future<SignalConnection> dial(
    String ip,
    int port,
    String cnonce, {
    required String bindAddress,
  }) => throw const DialFailure('unreachable');
}

void main() {
  late FakeTailnetPlatform platform;
  late ConnectivityController controller;
  late TestIdentity id;
  late FakeHost host;
  late MemoryStorage storage;
  late AppServices services;
  FakePeer? peer;
  final now = DateTime.utc(2026, 11, 22, 12);

  Future<void> boot(WidgetTester tester, {bool tailscale = true}) async {
    tester.view.physicalSize = const Size(1000, 2000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    // Real async for the Ed25519 key and the stored list.
    await tester.runAsync(() async {
      id = await TestIdentity.create();
      await services.hosts.load();
    });
    host = FakeHost(id);
    services = AppServices(
      hosts: services.hosts,
      transport: host,
      peerFactory: (events) async => peer = FakePeer(events),
      now: () => now,
    );
    platform.current = snap(tailscale ? [wifi(), tun()] : [wifi()]);
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(
          controller: controller,
          services: services,
          info: info,
        ),
      ),
    );
    await tester.runAsync(() async {
      await controller.start();
      await settle();
    });
    await tester.pump();
    await tester.pump();
  }

  /// Runs pending real async work (signatures, stream events), then a frame.
  Future<void> step(WidgetTester tester) async {
    await tester.runAsync(() async {
      for (var i = 0; i < 6; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 5));
      }
    });
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  String linkText() =>
      linkPrefix +
      encodeB64Url(
        utf8.encode(
          PairLink(
            hostId: hostNodeId,
            name: 'office-pc.tail1234.ts.net',
            addresses: const [hostIp],
            port: 47800,
            key: id.pubB64Url,
            token: encodeB64Url(List<int>.generate(16, (i) => 0x70 + i)),
            expiresAt: now.millisecondsSinceEpoch ~/ 1000 + 60,
          ).canonicalJson(),
        ),
      );

  PairedHost record() => PairedHost(
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

  setUp(() {
    peer = null;
    storage = MemoryStorage();
    platform = FakeTailnetPlatform(snap([wifi()], at: 0));
    controller = ConnectivityController(
      platform: platform,
      gatherer: FakeGatherer(ownCandidates()),
    );
    services = AppServices(
      hosts: HostStore(storage),
      transport: const NoTransport(),
      peerFactory: (events) async => FakePeer(events),
    );
  });

  tearDown(() async {
    controller.dispose();
    await platform.close();
  });

  testWidgets('pairing with a pasted link adds the computer to the list', (
    tester,
  ) async {
    await boot(tester);
    expect(find.textContaining('No computers yet'), findsOneWidget);
    await tester.tap(find.byKey(const Key('pair-computer')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('scan-code')), findsOneWidget);

    await tester.enterText(find.byKey(const Key('pair-link')), linkText());
    await tester.tap(find.byKey(const Key('pair-with-link')));
    await tester.pump();
    await step(tester);
    final conn = host.last;
    expect(conn.allSent('pair'), hasLength(1));
    expect(find.byKey(const Key('pairing')), findsOneWidget);
    conn.push({
      't': 'pair-result',
      'ok': true,
      'hostId': hostNodeId,
      'viewerId': phoneNodeId,
    });
    await step(tester);
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('host-$hostNodeId')), findsOneWidget);
    expect(find.text('office-pc'), findsOneWidget);
    expect(find.text('Paired with office-pc'), findsOneWidget);
    expect(storage.value, contains(hostNodeId));

    // Details show the identity fingerprint; Remove forgets the computer.
    await tester.tap(find.byKey(const Key('host-menu-$hostNodeId')));
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<SelectableText>(find.byKey(const Key('host-fingerprint')))
          .data,
      fingerprint(id.pub),
    );
    await tester.tap(find.byKey(const Key('host-remove')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('host-$hostNodeId')), findsNothing);
    expect(storage.value, '[]');
  });

  testWidgets('a bad link and a refused code say why', (tester) async {
    await boot(tester);
    await tester.tap(find.byKey(const Key('pair-computer')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const Key('pair-link')), 'hello');
    await tester.tap(find.byKey(const Key('pair-with-link')));
    await tester.pump();
    expect(
      find.textContaining("isn't a Tunnelview pairing code"),
      findsOneWidget,
    );
    expect(host.dialed, isEmpty);

    await tester.enterText(find.byKey(const Key('pair-link')), linkText());
    await tester.tap(find.byKey(const Key('pair-with-link')));
    await tester.pump();
    await step(tester);
    host.last.push({'t': 'pair-result', 'ok': false, 'reason': 'failed'});
    await step(tester);
    expect(find.textContaining("didn't accept the code"), findsOneWidget);
    expect(storage.value, isNull);
  });

  testWidgets('without Tailscale nothing is dialed', (tester) async {
    await tester.runAsync(() async => id = await TestIdentity.create());
    storage.value = jsonEncode([record()]);
    await boot(tester, tailscale: false);
    await tester.tap(find.byKey(const Key('pair-computer')));
    await tester.pump();
    expect(find.text('Connect Tailscale on this phone first.'), findsOneWidget);
    await tester.tap(find.byKey(const Key('host-$hostNodeId')));
    await tester.pump();
    expect(host.dialed, isEmpty);
    expect(find.byKey(const Key('session-waiting')), findsNothing);
  });

  testWidgets('a session: wait, view, type, tap, disconnect', (tester) async {
    await tester.runAsync(() async => id = await TestIdentity.create());
    storage.value = jsonEncode([record()]);
    await boot(tester);
    await tester.tap(find.byKey(const Key('host-$hostNodeId')));
    await tester.pump();
    await step(tester);
    final conn = host.last;
    expect(conn.allSent('request'), hasLength(1));
    expect(find.byKey(const Key('session-waiting')), findsOneWidget);
    // No password is set on this computer: nothing to type.
    expect(find.byKey(const Key('use-password')), findsNothing);

    conn.push({
      't': 'accepted',
      'sessionId': 's1',
      'permissions': {'control': true},
      'via': 'prompt',
    });
    await step(tester);
    final p = peer!;
    expect(find.byKey(const Key('fake-video')), findsOneWidget);
    expect(find.text('Starting the picture…'), findsOneWidget);

    p.statsReport = statsFor(tunIp, hostIp);
    p.events.onState(PeerState.connected);
    p.openChannel('control');
    p.openChannel('input');
    p.size.value = const Size(2000, 1000);
    await step(tester);
    expect(find.text('Starting the picture…'), findsNothing);
    expect(find.byKey(const Key('control-banner')), findsNothing);

    // A tap in the middle of the picture is a left click in its middle.
    await tester.tapAt(tester.getCenter(find.byKey(const Key('remote-view'))));
    await tester.pump();
    expect(p.sentOn('input'), [
      {'t': 'md', 'b': 0, 'x': 0.5, 'y': 0.5, 'n': 1},
      {'t': 'mu', 'b': 0, 'x': 0.5, 'y': 0.5, 'n': 1},
    ]);

    // The keyboard types text, and the extra row sends keys.
    await tester.tap(find.byKey(const Key('toggle-keyboard')));
    await tester.pump();
    expect(find.byKey(const Key('keys-bar')), findsOneWidget);
    tester.testTextInput.enterText('${KeyboardBuffer().sentinel}สวัสดี');
    await tester.pump();
    expect(p.sentOn('input').last, {'t': 'txt', 'text': 'สวัสดี'});
    await tester.tap(find.byKey(const Key('key-Escape')));
    expect(p.sentOn('input').last, {
      't': 'ku',
      'code': 'Escape',
      'key': 'Escape',
    });
    await tester.tap(find.byKey(const Key('key-ControlLeft')));
    await tester.tap(find.byKey(const Key('key-AltLeft')));
    await tester.pump();
    await tester.drag(find.byKey(const Key('keys-bar')), const Offset(-400, 0));
    await tester.pump();
    await tester.tap(find.byKey(const Key('key-Delete')));
    expect(p.sentOn('input').last, {
      't': 'combo',
      'codes': ['ControlLeft', 'AltLeft', 'Delete'],
    });

    // The host pauses control: a banner, and taps send nothing.
    p.events.onControl(
      jsonEncode({'t': 'host-state', 'controlAllowed': false}),
    );
    await tester.pump();
    expect(find.byKey(const Key('control-banner')), findsOneWidget);
    final before = p.sentOn('input').length;
    await tester.tapAt(tester.getCenter(find.byKey(const Key('remote-view'))));
    expect(p.sentOn('input'), hasLength(before));

    // Disconnect from the menu.
    await tester.tap(find.byKey(const Key('session-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu-disconnect')));
    await tester.pumpAndSettle();
    await step(tester);
    expect(conn.sent.last, {'t': 'bye', 'reason': 'viewer-closed'});
    expect(
      tester.widget<Text>(find.byKey(const Key('closed-title'))).data,
      'Disconnected',
    );
    expect(p.closed, isTrue);
    await tester.tap(find.byKey(const Key('closed-back')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('host-$hostNodeId')), findsOneWidget);
  });

  testWidgets('a refusal shows its reason and Connect again dials again', (
    tester,
  ) async {
    await tester.runAsync(() async => id = await TestIdentity.create());
    storage.value = jsonEncode([record()]);
    await boot(tester);
    await tester.tap(find.byKey(const Key('host-$hostNodeId')));
    await tester.pump();
    await step(tester);
    host.last.push({'t': 'denied', 'reason': 'rejected'});
    await step(tester);
    expect(
      tester.widget<Text>(find.byKey(const Key('closed-title'))).data,
      'Declined',
    );
    await tester.tap(find.byKey(const Key('reconnect')));
    await tester.pump();
    await step(tester);
    expect(host.connections, hasLength(2));
    expect(find.byKey(const Key('session-waiting')), findsOneWidget);
    host.last.push({'t': 'denied', 'reason': 'busy'});
    await step(tester);
    expect(find.text('office-pc is busy'), findsOneWidget);
  });

  testWidgets('a view-only session can still zoom, also while the session '
      'reports changes', (tester) async {
    await tester.runAsync(() async => id = await TestIdentity.create());
    storage.value = jsonEncode([record()]);
    await boot(tester);
    await tester.tap(find.byKey(const Key('host-$hostNodeId')));
    await tester.pump();
    await step(tester);
    host.last.push({
      't': 'accepted',
      'sessionId': 's1',
      'permissions': {'control': false},
      'via': 'prompt',
    });
    await step(tester);
    final p = peer!;
    p.statsReport = statsFor(tunIp, hostIp);
    p.events.onState(PeerState.connected);
    p.openChannel('input');
    p.size.value = const Size(1000, 2000);
    await step(tester);
    expect(
      tester.widget<Text>(find.byKey(const Key('control-banner'))).data,
      startsWith('View only'),
    );

    final video = find.byKey(const Key('fake-video'));
    final start = tester.getSize(video);
    final centre = tester.getCenter(find.byKey(const Key('remote-view')));
    final a = await tester.startGesture(
      centre - const Offset(60, 0),
      pointer: 7,
    );
    final b = await tester.startGesture(
      centre + const Offset(60, 0),
      pointer: 8,
    );
    await a.moveBy(const Offset(-60, 0));
    await b.moveBy(const Offset(60, 0));
    await tester.pump();
    final midway = tester.getSize(video);
    expect(midway.width, greaterThan(start.width));

    // The session reports something while the fingers are still down.
    p.events.onControl(jsonEncode({'t': 'host-state', 'audio': true}));
    await tester.pump();
    await a.moveBy(const Offset(-80, 0));
    await b.moveBy(const Offset(80, 0));
    await tester.pump();
    expect(
      tester.getSize(video).width,
      greaterThan(midway.width),
      reason: 'the pinch goes on after the update',
    );
    await a.up();
    await b.up();
    expect(p.sentOn('input'), isEmpty, reason: 'view only: nothing is sent');

    await tester.tap(find.byKey(const Key('session-menu')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const Key('menu-disconnect')));
    await tester.pumpAndSettle();
    await step(tester);
  });

  testWidgets('a password-only computer asks for its password', (tester) async {
    await tester.runAsync(() async => id = await TestIdentity.create());
    storage.value = jsonEncode([record()]);
    await boot(tester);
    host.auth = {
      ...host.auth,
      'passwordSet': true,
      'acceptMode': 'password-only',
      'salt': 'AAECAwQFBgcICQoLDA0ODw==',
      'kdf': {'N': 16384, 'r': 8, 'p': 1, 'keylen': 32},
    };
    await tester.tap(find.byKey(const Key('host-$hostNodeId')));
    await tester.pump();
    await step(tester);
    expect(find.byKey(const Key('session-password')), findsOneWidget);
    expect(host.last.sent, isEmpty);

    await tester.enterText(
      find.byKey(const Key('session-password')),
      'hunter22',
    );
    await tester.tap(find.byKey(const Key('submit-password')));
    await tester.pump();
    // scrypt runs in another isolate: give it real time, and pump so its
    // result is handled.
    for (var i = 0; i < 200 && host.last.allSent('request').isEmpty; i++) {
      await step(tester);
    }
    expect(host.last.allSent('request').single['proof'], isA<String>());
    // The field no longer holds the password.
    expect(find.text('hunter22'), findsNothing);

    host.last.push({'t': 'auth-failed', 'remaining': 2});
    await step(tester);
    expect(find.text('Wrong password. 2 tries left.'), findsOneWidget);
  });
}
