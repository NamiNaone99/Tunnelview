/// The local ICE gathering self-test (DECISIONS M-B2, CRITIQUE B2): proof at
/// run time that WebRTC gathers candidates on the Tailscale tunnel only.
///
/// The gathering itself lives in `engine.dart` (the only file that may import
/// flutter_webrtc). Everything here is pure Dart: parsing, merging with
/// stats, and the verdict. Nothing is sent anywhere: there are no ICE servers
/// and no remote peer.
library;

import '../net/addresses.dart';

/// Gathers this phone's local ICE candidates and returns them.
abstract interface class LocalIceGatherer {
  Future<GatherOutcome> gather({Duration timeout = const Duration(seconds: 5)});
}

/// One local candidate.
class GatheredCandidate {
  const GatheredCandidate({
    this.address,
    this.port,
    this.protocol,
    this.type,
    this.networkId,
    this.networkCost,
    this.networkType,
    this.adapterType,
    this.vpn,
  });

  /// Parses an ICE candidate line (with or without "a="). Null if malformed.
  static GatheredCandidate? fromLine(String line) {
    final address = candidateAddress(line);
    if (address == null) return null;
    var s = jsTrim(line);
    if (s.startsWith('a=')) s = s.substring(2);
    final f = s.split(RegExp(r'\s+'));
    String? attr(String name) {
      for (var i = 8; i + 1 < f.length; i += 2) {
        if (f[i] == name) return f[i + 1];
      }
      return null;
    }

    return GatheredCandidate(
      address: address,
      port: int.tryParse(f[5]),
      protocol: f[2].toLowerCase(),
      type: f[7],
      networkId: int.tryParse(attr('network-id') ?? ''),
      networkCost: int.tryParse(attr('network-cost') ?? ''),
    );
  }

  /// A `local-candidate` stats entry (the map of `StatsReport.values`).
  static GatheredCandidate fromStats(Map<Object?, Object?> v) {
    final address = v['address'] ?? v['ip'];
    final port = v['port'];
    final protocol = v['protocol'];
    final type = v['candidateType'];
    final networkType = v['networkType'];
    final adapterType = v['networkAdapterType'];
    final vpn = v['vpn'];
    return GatheredCandidate(
      address: address is String && address.isNotEmpty ? address : null,
      port: port is num ? port.toInt() : null,
      protocol: protocol is String ? protocol.toLowerCase() : null,
      type: type is String ? type : null,
      networkType: networkType is String ? networkType : null,
      adapterType: adapterType is String ? adapterType : null,
      vpn: vpn is bool ? vpn : null,
    );
  }

  /// The address as libwebrtc reported it (an IP literal, or a host name).
  final String? address;
  final int? port;
  final String? protocol;

  /// host, srflx, prflx or relay.
  final String? type;
  final int? networkId;
  final int? networkCost;

  /// From stats: libwebrtc's network type ("vpn", "wifi", "cellular", ...).
  final String? networkType;

  /// From stats: libwebrtc's adapter type.
  final String? adapterType;

  /// From stats: whether libwebrtc considers the network a VPN.
  final bool? vpn;

  /// The identity used to merge a line with its stats entry.
  String get key =>
      '${canonicalAddress(address) ?? address}|$port|${protocol ?? ''}';

  /// This candidate with the stats-only fields of [s] filled in.
  GatheredCandidate withStats(GatheredCandidate s) => GatheredCandidate(
    address: address ?? s.address,
    port: port ?? s.port,
    protocol: protocol ?? s.protocol,
    type: type ?? s.type,
    networkId: networkId,
    networkCost: networkCost,
    networkType: s.networkType ?? networkType,
    adapterType: s.adapterType ?? adapterType,
    vpn: s.vpn ?? vpn,
  );

  /// "vpn", "wifi", ... or "unknown".
  String get adapterLabel {
    final parts = <String>[
      if (networkType != null) networkType!,
      if (adapterType != null && adapterType != networkType) adapterType!,
      if (vpn == true && networkType != 'vpn' && adapterType != 'vpn') 'vpn',
    ];
    return parts.isEmpty ? 'unknown' : parts.join('/');
  }
}

/// Merges trickled candidate lines, candidate lines from the local SDP and
/// `local-candidate` stats entries. Every candidate libwebrtc reported in any
/// of them appears once.
List<GatheredCandidate> mergeCandidates(
  Iterable<String> lines,
  Iterable<Map<Object?, Object?>> localCandidateStats,
) {
  final byKey = <String, GatheredCandidate>{};
  for (final line in lines) {
    final c = GatheredCandidate.fromLine(line);
    if (c == null) {
      // Unparsable: keep it, so the verdict refuses it.
      byKey['?${byKey.length}|$line'] ??= const GatheredCandidate();
      continue;
    }
    byKey.putIfAbsent(c.key, () => c);
  }
  for (final v in localCandidateStats) {
    final s = GatheredCandidate.fromStats(v);
    final existing = byKey[s.key];
    byKey[s.key] = existing == null ? s : existing.withStats(s);
  }
  return byKey.values.toList();
}

/// What the gathering produced.
class GatherOutcome {
  const GatherOutcome({
    required this.candidates,
    required this.completed,
    required this.elapsed,
    this.error,
  });

  const GatherOutcome.failed(String this.error, this.elapsed)
    : candidates = const [],
      completed = false;

  final List<GatheredCandidate> candidates;

  /// True iff ICE gathering reached "complete" before the timeout.
  final bool completed;
  final Duration elapsed;

  /// The error type, if gathering could not run.
  final String? error;
}

/// The self-test verdict.
enum SelfTestVerdict {
  /// Every candidate is one of the phone's own Tailscale addresses.
  pass,

  /// A candidate is not an own Tailscale address: WebRTC would use a network
  /// outside the tunnel. Sessions are refused.
  foreignCandidate,

  /// No candidate at all: WebRTC sees no usable tunnel. Sessions are refused.
  noCandidates,

  /// Gathering did not complete in time. Sessions are refused.
  incomplete,

  /// Gathering could not run (WebRTC unavailable, platform error).
  error,
}

/// A stored self-test result.
class SelfTestResult {
  const SelfTestResult({
    required this.verdict,
    required this.outcome,
    required this.selfAddrs,
    required this.at,
  });

  final SelfTestVerdict verdict;
  final GatherOutcome outcome;

  /// The own Tailscale addresses the candidates were compared with.
  final List<String> selfAddrs;
  final DateTime at;

  /// Sessions may start only after a passing self-test.
  bool get allowsSessions => verdict == SelfTestVerdict.pass;

  /// Candidates whose address is not an own Tailscale address.
  List<GatheredCandidate> get foreign => foreignCandidates(outcome, selfAddrs);
}

/// Candidates whose address is not exactly one of [selfAddrs].
List<GatheredCandidate> foreignCandidates(
  GatherOutcome outcome,
  List<String> selfAddrs,
) {
  final own = <String>{for (final a in selfAddrs) canonicalAddress(a) ?? a};
  bool isOwn(GatheredCandidate c) {
    final a = canonicalAddress(c.address);
    return a != null && own.contains(a);
  }

  return [
    for (final c in outcome.candidates)
      if (!isOwn(c)) c,
  ];
}

/// The verdict for one gathering run.
SelfTestResult evaluateSelfTest({
  required GatherOutcome outcome,
  required List<String> selfAddrs,
  required DateTime at,
}) {
  SelfTestVerdict verdict;
  if (outcome.error != null) {
    verdict = SelfTestVerdict.error;
  } else if (foreignCandidates(outcome, selfAddrs).isNotEmpty) {
    verdict = SelfTestVerdict.foreignCandidate;
  } else if (outcome.candidates.isEmpty) {
    verdict = SelfTestVerdict.noCandidates;
  } else if (!outcome.completed) {
    verdict = SelfTestVerdict.incomplete;
  } else {
    verdict = SelfTestVerdict.pass;
  }
  return SelfTestResult(
    verdict: verdict,
    outcome: outcome,
    selfAddrs: List.unmodifiable(selfAddrs),
    at: at,
  );
}
