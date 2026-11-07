/// May a session start right now? Every future dial (M5) asks this first.
library;

import '../net/addresses.dart';
import '../platform/tailnet_state.dart';
import '../rtc/self_test.dart';

/// Why sessions are refused (null from [sessionRefusal] means allowed).
abstract final class SessionRefusal {
  /// No usable Tailscale network (off, another VPN, several, unknown).
  static const tailscaleOff = 'tailscale-off';

  /// The Tailscale network is visible but Tunnelview is excluded from it.
  static const tailscaleExcluded = 'tailscale-excluded';

  /// The start-up WebRTC self-test has not finished yet.
  static const selfTestPending = 'self-test-pending';

  /// The self-test found a candidate outside the tunnel, none at all, or
  /// could not run.
  static const selfTestFailed = 'self-test-failed';

  /// The phone's Tailscale addresses changed since the self-test ran.
  static const selfTestStale = 'self-test-stale';
}

/// Null if a session may start, else a [SessionRefusal] code.
String? sessionRefusal(TailnetState tailnet, SelfTestResult? selfTest) {
  switch (tailnet.status) {
    case TailnetStatus.ok:
      break;
    case TailnetStatus.excluded:
      return SessionRefusal.tailscaleExcluded;
    case TailnetStatus.checking:
    case TailnetStatus.off:
    case TailnetStatus.anotherVpn:
    case TailnetStatus.several:
    case TailnetStatus.unsupported:
      return SessionRefusal.tailscaleOff;
  }
  if (selfTest == null) return SessionRefusal.selfTestPending;
  if (!selfTest.allowsSessions) return SessionRefusal.selfTestFailed;
  if (!sameAddressSet(selfTest.selfAddrs, tailnet.selfAddrs)) {
    return SessionRefusal.selfTestStale;
  }
  return null;
}

/// True iff [a] and [b] hold the same addresses (canonical form, any order).
bool sameAddressSet(List<String> a, List<String> b) {
  final x = {for (final s in a) canonicalAddress(s)};
  final y = {for (final s in b) canonicalAddress(s)};
  return x.length == y.length && x.containsAll(y);
}
