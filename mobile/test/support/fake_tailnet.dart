// Test-only fakes (CRITIQUE N8: nothing test-only lives under lib/).
import 'dart:async';

import 'package:tunnelview_mobile/platform/tailnet.dart';
import 'package:tunnelview_mobile/rtc/self_test.dart';

/// Lets queued microtasks and stream events run.
Future<void> settle() async {
  for (var i = 0; i < 5; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

const int wifiHandle = 100;
const int cellHandle = 101;
const int tunHandle = 432902426637;
const int tun2Handle = 437197393933;

/// A Wi-Fi network with a router DNS (another device's address).
NetworkEntry wifi({bool active = true}) => NetworkEntry(
  handle: wifiHandle,
  isVpn: false,
  transports: const ['wifi'],
  validated: true,
  isActive: active,
  interfaceName: 'wlan0',
  addresses: const [
    LinkAddressInfo('192.168.1.23', 24),
    LinkAddressInfo('fe80::1234', 64),
  ],
  routes: const [
    RouteEntry(
      destination: '0.0.0.0',
      prefix: 0,
      gateway: '192.168.1.1',
      interfaceName: 'wlan0',
      isDefault: true,
    ),
  ],
  dns: const ['192.168.1.1'],
);

/// The Tailscale VPN network. [hostRoutes] true: per-peer routes (the
/// carrier also uses 100.64.0.0/10), with other devices' addresses.
NetworkEntry tun({
  int handle = tunHandle,
  String v4 = '100.101.12.7',
  String? v6 = 'fd7a:115c:a1e0:ab12:4843:cd96:6265:c07',
  bool hostRoutes = false,
  bool exitNode = false,
  String interfaceName = 'tun0',
}) => NetworkEntry(
  handle: handle,
  isVpn: true,
  transports: const ['vpn'],
  validated: true,
  interfaceName: interfaceName,
  addresses: [
    LinkAddressInfo(v4, 32),
    if (v6 != null) LinkAddressInfo(v6, 128),
  ],
  routes: [
    if (hostRoutes) ...const [
      RouteEntry(destination: '100.88.1.4', prefix: 32, interfaceName: 'tun0'),
      RouteEntry(destination: '100.77.2.9', prefix: 32, interfaceName: 'tun0'),
    ] else
      RouteEntry(
        destination: '100.64.0.0',
        prefix: 10,
        interfaceName: interfaceName,
      ),
    RouteEntry(
      destination: 'fd7a:115c:a1e0::',
      prefix: 48,
      interfaceName: interfaceName,
    ),
    if (exitNode)
      RouteEntry(
        destination: '0.0.0.0',
        prefix: 0,
        interfaceName: interfaceName,
        isDefault: true,
      ),
  ],
  dns: const ['100.100.100.100'],
);

/// Another VPN (for example Cloudflare WARP) in the shared 100.64/10 space.
NetworkEntry otherVpn() => const NetworkEntry(
  handle: 300,
  isVpn: true,
  transports: ['vpn'],
  interfaceName: 'tun0',
  addresses: [LinkAddressInfo('100.96.0.7', 32)],
);

/// A snapshot as the platform would send it. [reason] and [tailnet] default
/// to what the platform would compute; pass them to simulate disagreement.
TailnetSnapshot snap(
  List<NetworkEntry> networks, {
  int at = 1000,
  String? reason,
  int? tailnet,
  bool noTailnet = false,
  BindingInfo? binding,
}) {
  final choice = chooseTailnet(networks);
  final chosen = noTailnet ? null : (tailnet ?? choice.network?.handle);
  return TailnetSnapshot(
    at: at,
    sdk: 36,
    networks: networks,
    reason: reason ?? choice.reason,
    tailnetHandle: chosen,
    binding:
        binding ??
        (chosen == null
            ? const BindingInfo()
            : BindingInfo(process: chosen, attempted: chosen, ok: true)),
  );
}

/// A scripted [TailnetPlatform].
class FakeTailnetPlatform implements TailnetPlatform {
  FakeTailnetPlatform(this.current);

  TailnetSnapshot current;
  final StreamController<TailnetEvent> _events =
      StreamController<TailnetEvent>.broadcast();
  OpenTailscaleResult openResult = OpenTailscaleResult.opened;
  int openCalls = 0;
  int snapshotCalls = 0;
  final List<int> bindCalls = [];

  /// Sends an event with [s] (and makes it the current snapshot).
  void emit(TailnetSnapshot s, {String kind = 'link-properties', int? handle}) {
    current = s;
    _events.add(TailnetEvent(kind: kind, handle: handle, snapshot: s));
  }

  @override
  Future<TailnetSnapshot> snapshot() async {
    snapshotCalls++;
    return current;
  }

  @override
  Stream<TailnetEvent> events() => _events.stream;

  @override
  Future<bool> bindProcess(int handle) async {
    bindCalls.add(handle);
    return current.tailnetHandle == handle;
  }

  @override
  Future<bool> routeCovers(int handle, List<int> address) async => false;

  @override
  Future<String> deviceName() async => 'Pixel 8';

  @override
  Future<OpenTailscaleResult> openTailscale() async {
    openCalls++;
    return openResult;
  }

  Future<void> close() => _events.close();
}

/// A scripted [LocalIceGatherer].
class FakeGatherer implements LocalIceGatherer {
  FakeGatherer(this.outcome);

  GatherOutcome outcome;
  int calls = 0;
  Completer<void>? gate;

  @override
  Future<GatherOutcome> gather({
    Duration timeout = const Duration(seconds: 5),
  }) async {
    calls++;
    final g = gate;
    if (g != null) await g.future;
    return outcome;
  }
}

/// Candidates on the phone's own tun addresses.
GatherOutcome ownCandidates() => GatherOutcome(
  candidates: [
    GatheredCandidate.fromLine(
      'candidate:1 1 udp 2122260223 100.101.12.7 41234 typ host generation 0 '
      'ufrag Ab12 network-id 3 network-cost 10',
    )!,
    GatheredCandidate.fromLine(
      'candidate:2 1 udp 2122194687 fd7a:115c:a1e0:ab12:4843:cd96:6265:c07 '
      '41235 typ host generation 0 ufrag Ab12 network-id 3 network-cost 10',
    )!,
  ],
  completed: true,
  elapsed: const Duration(milliseconds: 120),
);

/// Own candidates plus one on Wi-Fi (the mask did not apply).
GatherOutcome leakyCandidates() => GatherOutcome(
  candidates: [
    ...ownCandidates().candidates,
    GatheredCandidate.fromLine(
      'candidate:3 1 udp 2122129151 192.168.1.23 41236 typ host generation 0',
    )!,
  ],
  completed: true,
  elapsed: const Duration(milliseconds: 150),
);
