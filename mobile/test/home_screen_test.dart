import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/app/connectivity.dart';
import 'package:tunnelview_mobile/app_info.dart';
import 'package:tunnelview_mobile/platform/tailnet.dart';
import 'package:tunnelview_mobile/platform/ui_platform.dart';
import 'package:tunnelview_mobile/ui/diagnostics_screen.dart';
import 'package:tunnelview_mobile/ui/home_screen.dart';

import 'support/fake_tailnet.dart';

const info = AppInfo(
  version: '0.3.0',
  build: '300',
  channel: BuildChannel.release,
);

void main() {
  late FakeTailnetPlatform platform;
  late FakeGatherer gatherer;
  late ConnectivityController controller;

  setUp(() {
    platform = FakeTailnetPlatform(snap([wifi()], at: 0));
    gatherer = FakeGatherer(ownCandidates());
    controller = ConnectivityController(platform: platform, gatherer: gatherer);
  });

  tearDown(() async {
    controller.dispose();
    await platform.close();
  });

  Future<void> pumpHome(WidgetTester tester) async {
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(controller: controller, info: info),
      ),
    );
    await controller.start();
    await tester.pump();
    await tester.pump();
  }

  void tallSurface(WidgetTester tester) {
    tester.view.physicalSize = const Size(1080, 8000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
  }

  String pillText(WidgetTester tester) =>
      tester.widget<Text>(find.byKey(const Key('tailscale-pill-label'))).data!;

  testWidgets('before the first snapshot the pill says Checking', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(controller: controller, info: info),
      ),
    );
    expect(pillText(tester), 'Checking Tailscale…');
    expect(find.byKey(const Key('tailscale-card')), findsNothing);
  });

  testWidgets('version, channel and WebRTC state are shown', (tester) async {
    await pumpHome(tester);
    expect(find.text('Tunnelview'), findsWidgets);
    expect(find.text('Version 0.3.0 (build 300)'), findsOneWidget);
    expect(find.text('Channel: release'), findsOneWidget);
    expect(find.text('WebRTC: not started'), findsOneWidget);
  });

  testWidgets('Tailscale off: amber pill and the "isn\'t connected" card', (
    tester,
  ) async {
    await pumpHome(tester);
    expect(pillText(tester), 'Tailscale is off');
    expect(find.text("Tailscale isn't connected"), findsOneWidget);
    expect(
      find.textContaining('Tunnelview only connects inside your tailnet'),
      findsOneWidget,
    );
  });

  testWidgets('OK: green pill with the own address, no card', (tester) async {
    platform.current = snap([wifi(), tun()]);
    await pumpHome(tester);
    expect(pillText(tester), 'Tailscale · 100.101.12.7');
    expect(find.byKey(const Key('tailscale-card')), findsNothing);
  });

  testWidgets('another VPN, excluded and several have their own texts', (
    tester,
  ) async {
    await pumpHome(tester);
    controller.monitor.apply(snap([wifi(), otherVpn()], at: 10));
    await tester.pump();
    await tester.pump();
    expect(pillText(tester), 'Another VPN is on');
    expect(
      find.textContaining('Android allows one VPN at a time'),
      findsOneWidget,
    );

    controller.monitor.apply(
      snap(
        [wifi(), tun()],
        at: 20,
        binding: const BindingInfo(attempted: tunHandle, ok: false),
      ),
    );
    await tester.pump();
    await tester.pump();
    expect(pillText(tester), 'Not using Tailscale');
    expect(find.text('Tunnelview is excluded from Tailscale'), findsOneWidget);
    expect(find.textContaining('App-based split tunneling'), findsOneWidget);

    controller.monitor.apply(snap([tun(), tun(handle: tun2Handle)], at: 30));
    await tester.pump();
    await tester.pump();
    expect(pillText(tester), 'Tailscale network unclear');
  });

  testWidgets('Open Tailscale calls the platform; not installed explains', (
    tester,
  ) async {
    platform.openResult = OpenTailscaleResult.notInstalled;
    await pumpHome(tester);
    await tester.tap(find.byKey(const Key('open-tailscale')));
    await tester.pump();
    await tester.pump();
    expect(platform.openCalls, 1);
    expect(find.textContaining("Tailscale isn't installed"), findsOneWidget);
  });

  testWidgets('Pair a computer is disabled and marked coming soon', (
    tester,
  ) async {
    await pumpHome(tester);
    final button = tester.widget<ButtonStyleButton>(
      find.byKey(const Key('pair-computer')),
    );
    expect(button.onPressed, isNull);
    expect(find.text('Coming soon'), findsOneWidget);
  });

  testWidgets('a failed self-test shows the blocked card', (tester) async {
    gatherer.outcome = leakyCandidates();
    platform.current = snap([wifi(), tun()]);
    await pumpHome(tester);
    await tester.pump();
    await tester.pump();
    expect(find.byKey(const Key('selftest-card')), findsOneWidget);
    expect(find.text('Connections are blocked'), findsOneWidget);
  });

  testWidgets('Diagnostics shows network, binding, routes and candidates', (
    tester,
  ) async {
    tallSurface(tester);
    platform.current = snap([wifi(), tun(hostRoutes: true)]);
    await pumpHome(tester);
    await tester.pump();
    await tester.pump();
    await tester.tap(find.byKey(const Key('open-diagnostics')));
    await tester.pumpAndSettle();
    expect(find.byType(DiagnosticsScreen), findsOneWidget);

    String row(String key) =>
        tester
            .widget<SelectableText>(
              find.descendant(
                of: find.byKey(Key(key)),
                matching: find.byType(SelectableText),
              ),
            )
            .data ??
        '';

    expect(row('diag-sessions'), 'Allowed');
    expect(row('diag-self-addrs'), contains('100.101.12.7'));
    expect(row('diag-route-mode'), startsWith('2 host routes'));
    expect(
      row('diag-binding'),
      'bound to the Tailscale network, last '
      'attempt succeeded (handle $tunHandle)',
    );
    expect(row('diag-selftest'), startsWith('Passed'));
    expect(row('diag-candidates'), contains('100.101.12.7 41234 udp host'));
  });

  testWidgets('the chosen network reads "vpn (over wifi)"', (tester) async {
    tallSurface(tester);
    platform.current = snap([
      wifi(),
      tun(transports: const ['wifi', 'vpn']),
    ]);
    await pumpHome(tester);
    await tester.pump();
    await tester.pump();
    await tester.tap(find.byKey(const Key('open-diagnostics')));
    await tester.pumpAndSettle();
    final row = tester
        .widget<SelectableText>(
          find.descendant(
            of: find.byKey(const Key('diag-network')),
            matching: find.byType(SelectableText),
          ),
        )
        .data;
    expect(row, 'handle $tunHandle · tun0 · vpn (over wifi) · validated');
  });

  testWidgets('a detection fault is not a brief "Checking": card and '
      'Diagnostics', (tester) async {
    await pumpHome(tester);
    // The platform and the Dart rules disagree: repeats on every snapshot.
    controller.monitor.apply(
      snap(
        [wifi(), tun()],
        at: 10,
        reason: TailnetReason.none,
        noTailnet: true,
      ),
    );
    await tester.pump();
    await tester.pump();
    expect(pillText(tester), "Can't check Tailscale");
    expect(find.byKey(const Key('tailscale-card')), findsOneWidget);
    await tester.tap(find.byKey(const Key('tailscale-card-diagnostics')));
    await tester.pumpAndSettle();
    expect(find.byType(DiagnosticsScreen), findsOneWidget);
  });

  group('Copy report', () {
    late List<MethodCall> uiCalls;
    late bool plainClipboard;
    late bool nativeResult;

    setUp(() {
      uiCalls = [];
      plainClipboard = false;
      nativeResult = true;
    });

    Future<void> openAndCopy(WidgetTester tester) async {
      final messenger = tester.binding.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(const MethodChannel(uiMethodChannel), (
        call,
      ) async {
        uiCalls.add(call);
        return nativeResult;
      });
      messenger.setMockMethodCallHandler(SystemChannels.platform, (call) async {
        if (call.method == 'Clipboard.setData') plainClipboard = true;
        return null;
      });
      addTearDown(() {
        messenger.setMockMethodCallHandler(
          const MethodChannel(uiMethodChannel),
          null,
        );
        messenger.setMockMethodCallHandler(SystemChannels.platform, null);
      });
      tallSurface(tester);
      platform.current = snap([wifi(), tun(hostRoutes: true)]);
      await pumpHome(tester);
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const Key('open-diagnostics')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('copy-report')));
      await tester.pump();
    }

    testWidgets('a sensitive clip without other devices', (tester) async {
      await openAndCopy(tester);
      expect(uiCalls.map((c) => c.method), ['copySensitive']);
      final args = uiCalls.single.arguments as Map;
      final copied = args['text'] as String;
      expect(args['label'], 'Tunnelview report');
      expect(copied, contains('Tunnelview diagnostics report'));
      expect(copied, contains('100.101.12.7'));
      expect(copied, isNot(contains('100.88.1.4')));
      expect(copied, isNot(contains('192.168.1.1')));
      // Never Flutter's plain clipboard: it cannot mark the clip sensitive.
      expect(plainClipboard, isFalse);
      expect(find.textContaining('Report copied'), findsOneWidget);
    });

    testWidgets('a failed native copy copies nothing and says so', (
      tester,
    ) async {
      nativeResult = false;
      await openAndCopy(tester);
      expect(plainClipboard, isFalse);
      expect(find.text("Couldn't copy the report."), findsOneWidget);
    });
  });
}
