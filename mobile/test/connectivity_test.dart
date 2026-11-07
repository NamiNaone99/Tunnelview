import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/app/connectivity.dart';
import 'package:tunnelview_mobile/app/session_gate.dart';
import 'package:tunnelview_mobile/platform/tailnet.dart';
import 'package:tunnelview_mobile/rtc/self_test.dart';

import 'support/fake_tailnet.dart';

void main() {
  late FakeTailnetPlatform platform;
  late FakeGatherer gatherer;
  late ConnectivityController controller;

  setUp(() {
    platform = FakeTailnetPlatform(snap([wifi()], at: 0));
    gatherer = FakeGatherer(ownCandidates());
    controller = ConnectivityController(
      platform: platform,
      gatherer: gatherer,
      now: () => DateTime.utc(2026, 11, 7),
    );
  });

  tearDown(() async {
    controller.dispose();
    await platform.close();
  });

  test('no self-test while Tailscale is off', () async {
    await controller.start();
    await settle();
    expect(controller.tailnet.status, TailnetStatus.off);
    expect(gatherer.calls, 0);
    expect(controller.sessionRefusalCode, SessionRefusal.tailscaleOff);
    expect(controller.deviceName, 'Pixel 8');
  });

  test('the self-test runs once after Tailscale is found', () async {
    await controller.start();
    platform.emit(snap([wifi(), tun()], at: 100));
    await settle();
    expect(gatherer.calls, 1);
    expect(controller.selfTest!.verdict, SelfTestVerdict.pass);
    expect(controller.sessionRefusalCode, isNull);

    // More events and a resume do not run it again.
    platform.emit(snap([wifi(), tun()], at: 200), kind: 'capabilities');
    await controller.refresh();
    await settle();
    expect(gatherer.calls, 1);
  });

  test('Tailscale already up at start', () async {
    platform.current = snap([wifi(), tun()], at: 0);
    await controller.start();
    await settle();
    expect(gatherer.calls, 1);
    expect(controller.sessionRefusalCode, isNull);
  });

  test('a foreign candidate refuses sessions', () async {
    gatherer.outcome = leakyCandidates();
    platform.current = snap([wifi(), tun()], at: 0);
    await controller.start();
    await settle();
    expect(controller.selfTest!.verdict, SelfTestVerdict.foreignCandidate);
    expect(controller.sessionRefusalCode, SessionRefusal.selfTestFailed);
    // Not re-run on its own; the user can run it again from Diagnostics.
    platform.emit(snap([wifi(), tun()], at: 300));
    await settle();
    expect(gatherer.calls, 1);
    gatherer.outcome = ownCandidates();
    await controller.runSelfTest();
    expect(gatherer.calls, 2);
    expect(controller.sessionRefusalCode, isNull);
  });

  test('sessions wait for the self-test', () async {
    gatherer.gate = Completer<void>();
    platform.current = snap([wifi(), tun()], at: 0);
    await controller.start();
    await settle();
    expect(controller.selfTestRunning, isTrue);
    expect(controller.sessionRefusalCode, SessionRefusal.selfTestPending);
    // A second request joins the running one.
    final again = controller.runSelfTest();
    gatherer.gate!.complete();
    await again;
    expect(gatherer.calls, 1);
    expect(controller.selfTestRunning, isFalse);
    expect(controller.sessionRefusalCode, isNull);
  });

  test('new own addresses make the result stale and re-run it', () async {
    platform.current = snap([wifi(), tun()], at: 0);
    await controller.start();
    await settle();
    expect(gatherer.calls, 1);
    platform.emit(
      snap([
        wifi(),
        tun(handle: tun2Handle, v4: '100.99.1.1', v6: 'fd7a:115c:a1e0::99'),
      ], at: 500),
    );
    await settle();
    expect(gatherer.calls, 2);
    // The fake still reports the old addresses, so the new run fails.
    expect(controller.sessionRefusalCode, SessionRefusal.selfTestFailed);
  });

  test('excluded from Tailscale: no self-test, sessions refused', () async {
    platform.current = snap([
      wifi(),
      tun(),
    ], binding: const BindingInfo(attempted: tunHandle, ok: false));
    await controller.start();
    await settle();
    expect(controller.tailnet.status, TailnetStatus.excluded);
    expect(gatherer.calls, 0);
    expect(controller.sessionRefusalCode, SessionRefusal.tailscaleExcluded);
  });

  test('a throwing gatherer is a failed self-test', () async {
    final throwing = _ThrowingGatherer();
    final c = ConnectivityController(platform: platform, gatherer: throwing);
    platform.current = snap([wifi(), tun()], at: 0);
    await c.start();
    await settle();
    expect(c.selfTest!.verdict, SelfTestVerdict.error);
    expect(c.sessionRefusalCode, SessionRefusal.selfTestFailed);
    c.dispose();
  });

  test('openTailscale passes the platform result through', () async {
    platform.openResult = OpenTailscaleResult.notInstalled;
    expect(await controller.openTailscale(), OpenTailscaleResult.notInstalled);
    expect(platform.openCalls, 1);
  });

  group('sessionRefusal', () {
    final ok = deriveTailnetState(snap([wifi(), tun()]));
    // Candidates on exactly [addrs] (the fixture's own tun addresses).
    SelfTestResult pass(List<String> addrs) => evaluateSelfTest(
      outcome: GatherOutcome(
        candidates: [
          for (final c in ownCandidates().candidates)
            if (addrs.contains(c.address)) c,
        ],
        completed: true,
        elapsed: Duration.zero,
      ),
      selfAddrs: addrs,
      at: DateTime.utc(2026),
    );

    test('every non-OK state refuses', () {
      for (final s in [
        const TailnetState.checking(),
        deriveTailnetState(snap([wifi()])),
        deriveTailnetState(snap([wifi(), otherVpn()])),
        deriveTailnetState(snap([tun(), tun(handle: tun2Handle)])),
      ]) {
        expect(
          sessionRefusal(s, pass(ok.selfAddrs)),
          SessionRefusal.tailscaleOff,
        );
      }
    });

    test('OK + passing self-test on the same addresses allows', () {
      expect(sessionRefusal(ok, pass(ok.selfAddrs)), isNull);
      expect(sessionRefusal(ok, null), SessionRefusal.selfTestPending);
      expect(
        sessionRefusal(ok, pass(['100.101.12.7'])),
        SessionRefusal.selfTestStale,
      );
    });
  });
}

class _ThrowingGatherer implements LocalIceGatherer {
  @override
  Future<GatherOutcome> gather({Duration timeout = Duration.zero}) =>
      Future.error(StateError('boom'));
}
