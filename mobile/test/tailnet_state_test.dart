import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/platform/tailnet.dart';

import 'support/fake_tailnet.dart';

void main() {
  group('chooseTailnet', () {
    test('exactly one VPN network with an fd7a address', () {
      final c = chooseTailnet([wifi(), tun()]);
      expect(c.reason, TailnetReason.ok);
      expect(c.network!.handle, tunHandle);
    });

    test('no VPN at all is "none"', () {
      expect(chooseTailnet([wifi()]).reason, TailnetReason.none);
      expect(chooseTailnet([]).reason, TailnetReason.none);
    });

    test('a VPN with only a 100.64/10 address is "no-fd7a" (WARP, NetBird)', () {
      expect(chooseTailnet([wifi(), otherVpn()]).reason, TailnetReason.noFd7a);
      expect(chooseTailnet([tun(v6: null)]).reason, TailnetReason.noFd7a);
    });

    test('two Tailscale networks are "several"', () {
      final c = chooseTailnet([tun(), tun(handle: tun2Handle)]);
      expect(c.reason, TailnetReason.several);
      expect(c.network, isNull);
    });

    test('an fd7a address on a non-VPN network does not count', () {
      const fake = NetworkEntry(
        handle: 5,
        isVpn: false,
        transports: ['wifi'],
        addresses: [LinkAddressInfo('fd7a:115c:a1e0::5', 128)],
      );
      expect(chooseTailnet([fake]).reason, TailnetReason.none);
    });

    test('a VPN without link properties does not count', () {
      const vpn = NetworkEntry(
        handle: 7,
        isVpn: true,
        hasLinkProperties: false,
        addresses: [LinkAddressInfo('fd7a:115c:a1e0::5', 128)],
      );
      expect(chooseTailnet([vpn]).reason, TailnetReason.none);
    });

    test('an IPv4-mapped 100.x address is not an fd7a address', () {
      const vpn = NetworkEntry(
        handle: 8,
        isVpn: true,
        addresses: [LinkAddressInfo('::ffff:100.64.0.1', 128)],
      );
      expect(chooseTailnet([vpn]).reason, TailnetReason.noFd7a);
    });
  });

  group('selfAddressesOf', () {
    test('own 100.64/10 and fd7a addresses, canonical, IPv4 first', () {
      const n = NetworkEntry(
        handle: 1,
        isVpn: true,
        addresses: [
          LinkAddressInfo('FD7A:115C:A1E0:0:0:0:0:7', 128),
          LinkAddressInfo('100.101.12.7', 32),
          LinkAddressInfo('fe80::1', 64),
          LinkAddressInfo('100.101.12.7', 32),
        ],
      );
      expect(selfAddressesOf(n), ['100.101.12.7', 'fd7a:115c:a1e0::7']);
    });
  });

  group('RouteSummary', () {
    test('one /10 route', () {
      final r = RouteSummary.of(tun());
      expect(r.mode, 'one /10 route');
      expect(r.cgnatSlash10, 1);
      expect(r.tailnetV6Route, isTrue);
      expect(r.defaultRoute, isFalse);
      expect(r.tunRoutes, 2);
    });

    test('per-peer host routes (carrier CGNAT)', () {
      final r = RouteSummary.of(tun(hostRoutes: true));
      expect(r.mode, '2 host routes');
      expect(r.cgnatSlash10, 0);
      expect(r.cgnatHostRoutes, 2);
    });

    test('exit node adds a default route', () {
      expect(RouteSummary.of(tun(exitNode: true)).defaultRoute, isTrue);
    });

    test('routes on other interfaces are ignored', () {
      final other = RouteSummary.of(
        const NetworkEntry(
          handle: 1,
          isVpn: true,
          interfaceName: 'tun0',
          routes: [
            RouteEntry(
              destination: '100.64.0.0',
              prefix: 10,
              interfaceName: 'wlan0',
            ),
          ],
        ),
      );
      expect(other.mode, 'no 100.64.0.0/10 route');
      expect(other.tunRoutes, 0);
    });
  });

  group('deriveTailnetState', () {
    test('bound tailnet network is OK with own addresses', () {
      final s = deriveTailnetState(snap([wifi(), tun()]));
      expect(s.status, TailnetStatus.ok);
      expect(s.bound, isTrue);
      expect(s.selfAddrs, [
        '100.101.12.7',
        'fd7a:115c:a1e0:ab12:4843:cd96:6265:c07',
      ]);
      expect(s.primaryAddress, '100.101.12.7');
    });

    test('no VPN is off, another VPN is anotherVpn, two are several', () {
      expect(deriveTailnetState(snap([wifi()])).status, TailnetStatus.off);
      expect(
        deriveTailnetState(snap([wifi(), otherVpn()])).status,
        TailnetStatus.anotherVpn,
      );
      expect(
        deriveTailnetState(snap([tun(), tun(handle: tun2Handle)])).status,
        TailnetStatus.several,
      );
    });

    test('a refused bind means Tunnelview is excluded (split tunnelling)', () {
      final s = deriveTailnetState(
        snap(
          [wifi(), tun()],
          binding: const BindingInfo(attempted: tunHandle, ok: false),
        ),
      );
      expect(s.status, TailnetStatus.excluded);
      expect(s.reason, 'excluded');
      expect(s.bound, isFalse);
    });

    test('bound to an older network only: still checking', () {
      final s = deriveTailnetState(
        snap(
          [wifi(), tun()],
          binding: const BindingInfo(process: tun2Handle),
        ),
      );
      expect(s.status, TailnetStatus.checking);
      expect(s.reason, 'binding');
    });

    test('platform and Dart disagree: never OK', () {
      final wrongHandle = deriveTailnetState(
        snap([wifi(), tun()], tailnet: tun2Handle),
      );
      expect(wrongHandle.status, TailnetStatus.checking);
      expect(wrongHandle.reason, 'mismatch');
      final wrongReason = deriveTailnetState(
        snap([wifi(), otherVpn()], reason: 'ok', tailnet: 300),
      );
      expect(wrongReason.status, TailnetStatus.checking);
    });
  });

  group('platform map parsing', () {
    Map<String, Object?> rawSnapshot() => {
      'at': 1234,
      'sdk': 34,
      'networks': [
        {
          'handle': tunHandle,
          'isVpn': true,
          'transports': ['vpn'],
          'validated': true,
          'isActive': true,
          'hasLinkProperties': true,
          'interface': 'tun0',
          'addresses': [
            {'address': '100.101.12.7', 'prefix': 32},
            {'address': 'fd7a:115c:a1e0::7', 'prefix': 128},
          ],
          'routes': [
            {
              'destination': '100.64.0.0',
              'prefix': 10,
              'gateway': null,
              'interface': 'tun0',
              'isDefault': false,
              'type': 1,
            },
          ],
          'dns': ['100.100.100.100'],
        },
      ],
      'tailnet': tunHandle,
      'reason': 'ok',
      'binding': {'process': tunHandle, 'attempted': tunHandle, 'ok': true},
    };

    test('a well-formed snapshot parses', () {
      final s = TailnetSnapshot.fromMap(rawSnapshot());
      expect(s.at, 1234);
      expect(s.networks.single.routes.single.prefix, 10);
      expect(s.binding.process, tunHandle);
      expect(deriveTailnetState(s).status, TailnetStatus.ok);
    });

    test('an event parses', () {
      final e = TailnetEvent.fromMap({
        'kind': 'lost',
        'handle': tunHandle,
        'snapshot': rawSnapshot(),
      });
      expect(e.kind, 'lost');
      expect(e.handle, tunHandle);
    });

    test('malformed maps are rejected', () {
      final badReason = rawSnapshot()..['reason'] = 'maybe';
      expect(
        () => TailnetSnapshot.fromMap(badReason),
        throwsA(isA<TailnetFormatException>()),
      );
      final badHandle = rawSnapshot()..['tailnet'] = '1';
      expect(
        () => TailnetSnapshot.fromMap(badHandle),
        throwsA(isA<TailnetFormatException>()),
      );
      expect(
        () => TailnetSnapshot.fromMap(null),
        throwsA(isA<TailnetFormatException>()),
      );
    });
  });

  group('TailnetMonitor', () {
    late FakeTailnetPlatform platform;
    late TailnetMonitor monitor;

    setUp(() {
      platform = FakeTailnetPlatform(snap([wifi()], at: 0));
      monitor = TailnetMonitor(platform);
    });

    tearDown(() async {
      await monitor.dispose();
      await platform.close();
    });

    test('starts with a snapshot and follows events', () async {
      final states = <TailnetState>[];
      final sub = monitor.states.listen(states.add);
      await monitor.start();
      expect(monitor.state.status, TailnetStatus.off);
      platform.emit(snap([wifi(), tun()], at: 500), kind: 'available');
      await settle();
      expect(monitor.state.status, TailnetStatus.ok);
      expect(states.map((s) => s.status), [
        TailnetStatus.off,
        TailnetStatus.ok,
      ]);
      await sub.cancel();
    });

    test('a new tailnet network within 3 s of the loss: re-established', () {
      monitor.apply(snap([wifi(), tun()], at: 1000));
      expect(monitor.state.vpnReestablished, isFalse);
      monitor.apply(snap([wifi()], at: 2000));
      expect(monitor.state.status, TailnetStatus.off);
      monitor.apply(snap([wifi(), tun(handle: tun2Handle)], at: 4500));
      expect(monitor.state.status, TailnetStatus.ok);
      expect(monitor.state.vpnReestablished, isTrue);
      expect(monitor.changes.map((c) => c.kind), contains('reestablished'));
      // The hint belongs to the transition only.
      monitor.apply(snap([wifi(), tun(handle: tun2Handle)], at: 4600));
      expect(monitor.state.vpnReestablished, isFalse);
    });

    test('after more than 3 s it is a plain reconnect', () {
      monitor.apply(snap([wifi(), tun()], at: 1000));
      monitor.apply(snap([wifi()], at: 2000));
      monitor.apply(snap([wifi(), tun(handle: tun2Handle)], at: 5001));
      expect(monitor.state.status, TailnetStatus.ok);
      expect(monitor.state.vpnReestablished, isFalse);
    });

    test('a direct replacement (no gap) is re-established', () {
      monitor.apply(snap([wifi(), tun()], at: 1000));
      monitor.apply(snap([wifi(), tun(handle: tun2Handle)], at: 1200));
      expect(monitor.state.vpnReestablished, isTrue);
      expect(monitor.changes.last.kind, 'replaced');
    });

    test('old and new briefly side by side ("several") still counts', () {
      monitor.apply(snap([wifi(), tun()], at: 1000));
      monitor.apply(snap([tun(), tun(handle: tun2Handle)], at: 1100));
      expect(monitor.state.status, TailnetStatus.several);
      monitor.apply(snap([wifi(), tun(handle: tun2Handle)], at: 1300));
      expect(monitor.state.status, TailnetStatus.ok);
      expect(monitor.state.vpnReestablished, isTrue);
    });

    test('the first network found is not "re-established"', () {
      monitor.apply(snap([wifi()], at: 0));
      monitor.apply(snap([wifi(), tun()], at: 100));
      expect(monitor.state.vpnReestablished, isFalse);
      expect(monitor.changes.map((c) => c.kind), contains('appeared'));
    });

    test('a platform error is never OK', () async {
      final failing = _FailingPlatform();
      final m = TailnetMonitor(failing);
      await m.start();
      expect(m.state.status, TailnetStatus.checking);
      expect(m.state.reason, 'platform-error');
      await m.dispose();
    });

    test('an unsupported platform says so', () async {
      final m = TailnetMonitor(const UnsupportedTailnet());
      await m.start();
      expect(m.state.status, TailnetStatus.unsupported);
      await m.dispose();
    });
  });
}

class _FailingPlatform extends FakeTailnetPlatform {
  _FailingPlatform() : super(snap(const []));

  @override
  Future<TailnetSnapshot> snapshot() =>
      Future.error(const TailnetFormatException('bad'));

  @override
  Stream<TailnetEvent> events() => const Stream.empty();
}
