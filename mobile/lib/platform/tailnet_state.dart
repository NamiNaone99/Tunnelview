/// Turns a platform snapshot into the app's Tailscale state (PLAN §6.1–6.2,
/// DECISIONS M-S1). Pure Dart, so the rules are unit-tested with fakes.
///
/// The Dart side re-derives the tailnet choice from the raw network list with
/// the bit-exact address port and only trusts a snapshot when both sides
/// agree. The platform's choice is what it binds the process to; this check
/// keeps that binding and the app's view of it in step.
library;

import '../net/addresses.dart';
import 'tailnet_platform.dart';

/// The Tailscale pill states (ux §4.2), plus two refusals the pill must show.
enum TailnetStatus {
  /// Not known yet, or the platform's view is in transition.
  checking,

  /// Exactly one Tailscale network, and the process is bound to it.
  ok,

  /// No VPN network at all.
  off,

  /// A VPN network without a Tailscale (fd7a:115c:a1e0::/48) address.
  anotherVpn,

  /// The Tailscale network is visible but the OS refused to bind the process
  /// to it: Tunnelview is excluded from Tailscale (split tunnelling).
  excluded,

  /// More than one network carries a Tailscale address. Refused.
  several,

  /// This platform has no Tailscale detection yet (iOS for now).
  unsupported,
}

/// Why the state is what it is (stable codes, shown in Diagnostics).
abstract final class TailnetStateReason {
  static const checking = 'checking';
  static const ok = 'ok';
  static const none = TailnetReason.none;
  static const noFd7a = TailnetReason.noFd7a;
  static const several = TailnetReason.several;
  static const excluded = 'excluded';
  static const binding = 'binding';
  static const mismatch = 'mismatch';
  static const platformError = 'platform-error';
  static const unsupported = 'unsupported';
}

/// The tailnet network chosen from a network list, or why there is none.
class TailnetChoice {
  const TailnetChoice(this.reason, [this.network]);
  final String reason;
  final NetworkEntry? network;
}

/// Exactly one VPN network with link properties that carries an
/// fd7a:115c:a1e0::/48 address. A 100.64.0.0/10 address alone proves
/// nothing: carriers (CGNAT), Cloudflare WARP and NetBird use it too.
TailnetChoice chooseTailnet(List<NetworkEntry> networks) {
  var vpns = 0;
  final candidates = <NetworkEntry>[];
  for (final n in networks) {
    if (!n.isVpn || !n.hasLinkProperties) continue;
    vpns++;
    if (n.addresses.any((a) => isTailscaleV6Address(a.address))) {
      candidates.add(n);
    }
  }
  if (candidates.length == 1) {
    return TailnetChoice(TailnetReason.ok, candidates.single);
  }
  if (candidates.length > 1) return const TailnetChoice(TailnetReason.several);
  return TailnetChoice(vpns > 0 ? TailnetReason.noFd7a : TailnetReason.none);
}

/// The network's own Tailscale addresses (100.64/10 and fd7a::/48), in
/// canonical form, IPv4 first, without duplicates.
List<String> selfAddressesOf(NetworkEntry network) {
  final v4 = <String>[];
  final v6 = <String>[];
  for (final a in network.addresses) {
    if (!isTailscaleAddress(a.address)) continue;
    final c = canonicalAddress(a.address)!;
    final list = c.contains(':') ? v6 : v4;
    if (!list.contains(c)) list.add(c);
  }
  return [...v4, ...v6];
}

/// How the Tailscale routes on the tunnel interface look (CRITIQUE S4).
/// Counts only: per-peer routes are other devices' addresses and never leave
/// this object.
class RouteSummary {
  const RouteSummary({
    required this.cgnatSlash10,
    required this.cgnatHostRoutes,
    required this.cgnatOtherRoutes,
    required this.tailnetV6Route,
    required this.defaultRoute,
    required this.tunRoutes,
  });

  factory RouteSummary.of(NetworkEntry network) {
    var slash10 = 0;
    var host = 0;
    var other = 0;
    var v6 = false;
    var def = false;
    var tun = 0;
    for (final r in network.routes) {
      if (r.interfaceName == null || r.interfaceName != network.interfaceName) {
        continue;
      }
      tun++;
      if (r.isDefault || r.prefix == 0) {
        def = true;
        continue;
      }
      if (isInsideTailscaleV4Range(r.destination, r.prefix)) {
        if (r.prefix == 10) {
          slash10++;
        } else if (r.prefix == 32) {
          host++;
        } else {
          other++;
        }
      } else if (isTailscaleV6Address(r.destination) && r.prefix == 48) {
        v6 = true;
      }
    }
    return RouteSummary(
      cgnatSlash10: slash10,
      cgnatHostRoutes: host,
      cgnatOtherRoutes: other,
      tailnetV6Route: v6,
      defaultRoute: def,
      tunRoutes: tun,
    );
  }

  /// Routes for exactly 100.64.0.0/10 on the tunnel.
  final int cgnatSlash10;

  /// /32 routes inside 100.64.0.0/10 on the tunnel (one per peer).
  final int cgnatHostRoutes;

  /// Other prefixes inside 100.64.0.0/10 on the tunnel.
  final int cgnatOtherRoutes;

  /// A route for fd7a:115c:a1e0::/48 on the tunnel.
  final bool tailnetV6Route;

  /// A default route on the tunnel (an exit node is in use).
  final bool defaultRoute;

  /// Every route on the tunnel interface.
  final int tunRoutes;

  /// "one /10 route", "N host routes" or "no 100.64.0.0/10 route".
  String get mode {
    if (cgnatSlash10 > 0) return 'one /10 route';
    if (cgnatHostRoutes > 0) {
      return cgnatHostRoutes == 1
          ? '1 host route'
          : '$cgnatHostRoutes host routes';
    }
    return 'no 100.64.0.0/10 route';
  }
}

/// The app's view of Tailscale at one moment.
class TailnetState {
  const TailnetState({
    required this.status,
    required this.reason,
    this.network,
    this.selfAddrs = const [],
    this.bound = false,
    this.vpnReestablished = false,
    this.snapshot,
  });

  /// Before the first snapshot.
  const TailnetState.checking()
    : status = TailnetStatus.checking,
      reason = TailnetStateReason.checking,
      network = null,
      selfAddrs = const [],
      bound = false,
      vpnReestablished = false,
      snapshot = null;

  final TailnetStatus status;
  final String reason;

  /// The chosen tailnet network (when one exists, whatever the status).
  final NetworkEntry? network;

  /// The phone's own Tailscale addresses on [network].
  final List<String> selfAddrs;

  /// True iff the OS reports the process bound to [network].
  final bool bound;

  /// True while the current tailnet network is OK and replaced the previous
  /// one directly or within 3 s of its loss (Tailscale rebuilt its tunnel,
  /// DECISIONS M-S4). Set by `TailnetMonitor`; it stays on every state of
  /// that network until it is lost or replaced.
  final bool vpnReestablished;

  final TailnetSnapshot? snapshot;

  bool get isOk => status == TailnetStatus.ok;

  /// The first own IPv4 (else IPv6) address, for the pill.
  String? get primaryAddress => selfAddrs.isEmpty ? null : selfAddrs.first;

  TailnetState withReestablished(bool value) => TailnetState(
    status: status,
    reason: reason,
    network: network,
    selfAddrs: selfAddrs,
    bound: bound,
    vpnReestablished: value,
    snapshot: snapshot,
  );
}

/// Derives the state from one snapshot.
TailnetState deriveTailnetState(TailnetSnapshot s) {
  final choice = chooseTailnet(s.networks);
  if (choice.reason != s.reason || choice.network?.handle != s.tailnetHandle) {
    // The platform and the Dart rules disagree: never report OK.
    return TailnetState(
      status: TailnetStatus.checking,
      reason: TailnetStateReason.mismatch,
      snapshot: s,
    );
  }
  switch (choice.reason) {
    case TailnetReason.none:
      return TailnetState(
        status: TailnetStatus.off,
        reason: TailnetStateReason.none,
        snapshot: s,
      );
    case TailnetReason.noFd7a:
      return TailnetState(
        status: TailnetStatus.anotherVpn,
        reason: TailnetStateReason.noFd7a,
        snapshot: s,
      );
    case TailnetReason.several:
      return TailnetState(
        status: TailnetStatus.several,
        reason: TailnetStateReason.several,
        snapshot: s,
      );
  }
  final network = choice.network!;
  final selfAddrs = selfAddressesOf(network);
  final bound = s.binding.process == network.handle;
  if (bound) {
    return TailnetState(
      status: TailnetStatus.ok,
      reason: TailnetStateReason.ok,
      network: network,
      selfAddrs: selfAddrs,
      bound: true,
      snapshot: s,
    );
  }
  final refused =
      s.binding.attempted == network.handle && s.binding.ok == false;
  return TailnetState(
    status: refused ? TailnetStatus.excluded : TailnetStatus.checking,
    reason: refused ? TailnetStateReason.excluded : TailnetStateReason.binding,
    network: network,
    selfAddrs: selfAddrs,
    snapshot: s,
  );
}
