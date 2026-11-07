import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/app_info.dart';
import 'package:tunnelview_mobile/diagnostics/report.dart';
import 'package:tunnelview_mobile/platform/tailnet.dart';
import 'package:tunnelview_mobile/rtc/self_test.dart';

import 'support/fake_tailnet.dart';

const app = AppInfo(version: '0.3.0', build: '7', channel: BuildChannel.dev);

String report(TailnetState state, {SelfTestResult? selfTest}) =>
    buildDiagnosticsReport(
      app: app,
      state: state,
      changes: const [],
      selfTest: selfTest,
      webrtc: 'ready',
      deviceName: 'Pixel 8',
      now: DateTime.utc(2026, 11, 7, 12),
    );

void main() {
  test('own tun addresses, route mode and binding are in the report', () {
    final state = deriveTailnetState(snap([wifi(), tun()]));
    final r = report(state);
    expect(r, contains('Own Tailscale addresses: 100.101.12.7, '));
    expect(r, contains('fd7a:115c:a1e0:ab12:4843:cd96:6265:c07'));
    expect(r, contains('Route mode: one /10 route'));
    expect(r, contains('bound to the Tailscale network'));
    expect(r, contains('Tunnel DNS: 100.100.100.100'));
    expect(r, contains('Phone: Pixel 8'));
  });

  test('no address of any other device appears', () {
    // Per-peer routes (other devices), a router gateway and a router DNS.
    final state = deriveTailnetState(
      snap([
        wifi(),
        tun(hostRoutes: true, exitNode: true),
      ]),
    );
    final selfTest = evaluateSelfTest(
      outcome: ownCandidates(),
      selfAddrs: state.selfAddrs,
      at: DateTime.utc(2026, 11, 7),
    );
    final r = report(state, selfTest: selfTest);
    for (final other in ['100.88.1.4', '100.77.2.9', '192.168.1.1']) {
      expect(r, isNot(contains(other)), reason: other);
    }
    expect(r, contains('Route mode: 2 host routes'));
    expect(r, contains('Default route on the tunnel (exit node): yes'));
    expect(r, contains('Self-test: pass'));
  });

  test('a failed self-test names the foreign candidate', () {
    final state = deriveTailnetState(snap([wifi(), tun()]));
    final selfTest = evaluateSelfTest(
      outcome: leakyCandidates(),
      selfAddrs: state.selfAddrs,
      at: DateTime.utc(2026, 11, 7),
    );
    final r = report(state, selfTest: selfTest);
    expect(r, contains('Self-test: foreignCandidate'));
    expect(r, contains('192.168.1.23 41236 udp host'));
    expect(r, contains('NOT an own Tailscale address'));
    expect(r, contains('Sessions: Refused: the network self-test failed'));
  });

  test('Tailscale off', () {
    final r = report(deriveTailnetState(snap([wifi()])));
    expect(r, contains('Status: Tailscale is off (off, none)'));
    expect(r, contains('Self-test: not run yet'));
  });
}
