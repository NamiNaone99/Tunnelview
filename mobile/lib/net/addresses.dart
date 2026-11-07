/// Tailscale address tests: a bit-exact port of `parseIPv4`, `parseIPv6`,
/// `isTailscaleAddress` and `candidateAddress` from the desktop
/// `src/renderer/shared/rtc.js`, plus `canonicalAddress` (the RFC 5952 form of
/// `normalizeIp` in `src/main/tailscale.js`) for exact address comparisons.
///
/// Every quirk of the JavaScript is kept on purpose, so that the phone accepts
/// exactly the addresses the desktop accepts. `test/addresses_test.dart` holds
/// vectors computed by running the real desktop functions.
library;

/// Tailscale's IPv4 range (`TS_IPV4_CIDR` in `src/shared/protocol.js`).
const String tsIpv4Cidr = '100.64.0.0/10';

/// The first 48 bits of Tailscale's IPv6 range fd7a:115c:a1e0::/48
/// (`TS_IPV6_PREFIX` in `src/shared/protocol.js`).
const String tsIpv6Prefix = 'fd7a:115c:a1e0:';

/// Longest candidate line `candidateAddress` reads (rtc.js `MAX_CANDIDATE_LEN`).
const int maxCandidateLength = 2048;

final RegExp _v4Re = RegExp(r'^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$');
final RegExp _hexGroupRe = RegExp(r'^[0-9a-fA-F]{1,4}$');
final RegExp _whitespaceRe = RegExp(r'\s+');

/// The characters JavaScript's `String.prototype.trim` removes: WhiteSpace
/// (including every Unicode Zs space and U+FEFF) and LineTerminator. Dart's
/// own `trim` also removes U+0085, which JavaScript keeps.
bool _isJsWhitespace(int c) =>
    c == 0x09 ||
    c == 0x0a ||
    c == 0x0b ||
    c == 0x0c ||
    c == 0x0d ||
    c == 0x20 ||
    c == 0xa0 ||
    c == 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c == 0x2028 ||
    c == 0x2029 ||
    c == 0x202f ||
    c == 0x205f ||
    c == 0x3000 ||
    c == 0xfeff;

/// `s.trim()` with JavaScript semantics.
String jsTrim(String s) {
  var start = 0;
  var end = s.length;
  while (start < end && _isJsWhitespace(s.codeUnitAt(start))) {
    start++;
  }
  while (end > start && _isJsWhitespace(s.codeUnitAt(end - 1))) {
    end--;
  }
  return s.substring(start, end);
}

/// "a.b.c.d" → `[a, b, c, d]`, or null. Leading zeros are rejected (octal
/// ambiguity).
List<int>? parseIPv4(Object? s) {
  if (s is! String) return null;
  final m = _v4Re.firstMatch(s);
  if (m == null) return null;
  final out = <int>[];
  for (var i = 1; i <= 4; i++) {
    final part = m.group(i)!;
    if (part.length > 1 && part[0] == '0') return null;
    final n = int.parse(part);
    if (n > 255) return null;
    out.add(n);
  }
  return out;
}

/// Any textual IPv6 (including "::" compression and a trailing embedded
/// IPv4) → 8 groups of 16 bits, or null.
List<int>? parseIPv6(Object? s) {
  if (s is! String || !s.contains(':') || s.length > 45) return null;
  var str = s;
  // Embedded dotted IPv4 in the last 32 bits, e.g. ::ffff:100.64.0.1.
  final lastColon = str.lastIndexOf(':');
  final tail4 = str.substring(lastColon + 1);
  if (tail4.contains('.')) {
    final v4 = parseIPv4(tail4);
    if (v4 == null) return null;
    final hi = ((v4[0] << 8) | v4[1]).toRadixString(16);
    final lo = ((v4[2] << 8) | v4[3]).toRadixString(16);
    str = '${str.substring(0, lastColon + 1)}$hi:$lo';
  }
  final dbl = str.indexOf('::');
  // At most one "::".
  if (dbl != -1 && dbl != str.lastIndexOf('::')) return null;
  List<String> head;
  List<String> tail;
  if (dbl == -1) {
    head = str.split(':');
    tail = <String>[];
  } else {
    final h = str.substring(0, dbl);
    final t = str.substring(dbl + 2);
    head = h.isNotEmpty ? h.split(':') : <String>[];
    tail = t.isNotEmpty ? t.split(':') : <String>[];
  }
  for (final g in head) {
    if (!_hexGroupRe.hasMatch(g)) return null;
  }
  for (final g in tail) {
    if (!_hexGroupRe.hasMatch(g)) return null;
  }
  if (dbl == -1) {
    if (head.length != 8) return null;
  } else if (head.length + tail.length > 7) {
    // "::" must stand for at least one zero group.
    return null;
  }
  final groups = [for (final g in head) int.parse(g, radix: 16)];
  final zeros = 8 - head.length - tail.length;
  for (var i = 0; i < zeros; i++) {
    groups.add(0);
  }
  for (final g in tail) {
    groups.add(int.parse(g, radix: 16));
  }
  return groups.length == 8 ? groups : null;
}

int _v4ToInt(List<int> o) =>
    (o[0] * 16777216) + (o[1] << 16) + (o[2] << 8) + o[3];

// Tailscale ranges, derived from the protocol constants (as rtc.js does).
final ({int net, int mask}) _tsV4 = () {
  final parts = tsIpv4Cidr.split('/');
  final octets = parseIPv4(parts[0])!;
  final bits = int.parse(parts[1]);
  final mask = bits == 0 ? 0 : (0xffffffff << (32 - bits)) & 0xffffffff;
  return (net: _v4ToInt(octets) & mask, mask: mask);
}();

final List<int> _tsV6Prefix = [
  for (final g in tsIpv6Prefix.split(':'))
    if (g.isNotEmpty) int.parse(g, radix: 16),
];

bool _isTailscaleV4(List<int> octets) =>
    (_v4ToInt(octets) & _tsV4.mask) == _tsV4.net;

/// True iff the 8 groups start with fd7a:115c:a1e0 (the /48 prefix).
bool isTailscaleV6Groups(List<int> groups) {
  if (groups.length != 8) return false;
  for (var i = 0; i < _tsV6Prefix.length; i++) {
    if (groups[i] != _tsV6Prefix[i]) return false;
  }
  return true;
}

bool _isMappedV4(List<int> g) =>
    g[0] == 0 &&
    g[1] == 0 &&
    g[2] == 0 &&
    g[3] == 0 &&
    g[4] == 0 &&
    g[5] == 0xffff;

/// Strips [brackets] and %zone. Null for malformed bracket syntax.
String? _stripAddress(String addr) {
  var s = jsTrim(addr);
  if (s.startsWith('[')) {
    final end = s.indexOf(']');
    if (end == -1) return null;
    s = s.substring(1, end);
  }
  final pct = s.indexOf('%');
  if (pct != -1) s = s.substring(0, pct);
  return s;
}

/// True iff [addr] is inside 100.64.0.0/10 or fd7a:115c:a1e0::/48.
///
/// Accepts brackets, zone ids and IPv4-mapped IPv6 (::ffff:100.x.y.z).
/// Host names (including mDNS "*.local") are never Tailscale addresses.
bool isTailscaleAddress(Object? addr) {
  if (addr is! String || addr.isEmpty || addr.length > 64) return false;
  final s = _stripAddress(addr);
  if (s == null || s.isEmpty) return false;
  final v4 = parseIPv4(s);
  if (v4 != null) return _isTailscaleV4(v4);
  final g = parseIPv6(s);
  if (g == null) return false;
  if (_isMappedV4(g)) {
    return _isTailscaleV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  return isTailscaleV6Groups(g);
}

/// The connection address (5th field) of an ICE candidate line
/// "candidate:foundation component transport priority address port typ type".
/// Accepts an optional "a=" prefix. Null when malformed.
String? candidateAddress(Object? candidateLine) {
  if (candidateLine is! String || candidateLine.length > maxCandidateLength) {
    return null;
  }
  var s = jsTrim(candidateLine);
  if (s.startsWith('a=')) s = s.substring(2);
  if (!s.startsWith('candidate:')) return null;
  final f = s.split(_whitespaceRe);
  if (f.length < 8 || f[6] != 'typ') return null;
  return f[4].isEmpty ? null : f[4];
}

String _formatIPv6(List<int> g) {
  var bestStart = -1;
  var bestLen = 0;
  for (var i = 0; i < 8;) {
    if (g[i] != 0) {
      i++;
      continue;
    }
    var j = i;
    while (j < 8 && g[j] == 0) {
      j++;
    }
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  final hex = [for (final x in g) x.toRadixString(16)];
  if (bestLen < 2) return hex.join(':');
  final left = hex.sublist(0, bestStart).join(':');
  final right = hex.sublist(bestStart + bestLen).join(':');
  return '$left::$right';
}

/// The canonical text form of an IP address literal, or null if [addr] is not
/// one: dotted IPv4; IPv4-mapped IPv6 as IPv4; other IPv6 lower-case with the
/// longest run of two or more zero groups compressed (RFC 5952). Brackets and
/// zone ids are stripped. Two addresses are the same iff their canonical forms
/// are equal.
String? canonicalAddress(Object? addr) {
  if (addr is! String || addr.isEmpty || addr.length > 64) return null;
  final s = _stripAddress(addr);
  if (s == null || s.isEmpty) return null;
  final v4 = parseIPv4(s);
  if (v4 != null) return v4.join('.');
  final g = parseIPv6(s);
  if (g == null) return null;
  if (_isMappedV4(g)) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
  }
  return _formatIPv6(g);
}

/// The 4 or 16 bytes of an IP address literal, or null. Used to hand an
/// address to the platform without any string parsing (and so without any
/// chance of a DNS lookup) on the other side.
List<int>? addressBytes(Object? addr) {
  final c = canonicalAddress(addr);
  if (c == null) return null;
  final v4 = parseIPv4(c);
  if (v4 != null) return v4;
  final g = parseIPv6(c)!;
  return [
    for (final x in g) ...[x >> 8, x & 0xff],
  ];
}

/// True iff [addr] is an IPv6 literal inside fd7a:115c:a1e0::/48
/// (IPv4-mapped addresses are not).
bool isTailscaleV6Address(Object? addr) {
  final c = canonicalAddress(addr);
  if (c == null || !c.contains(':')) return false;
  return isTailscaleV6Groups(parseIPv6(c)!);
}

/// True iff [addr] is an IPv4 literal inside 100.64.0.0/10.
bool isTailscaleV4Address(Object? addr) {
  final c = canonicalAddress(addr);
  if (c == null || c.contains(':')) return false;
  return _isTailscaleV4(parseIPv4(c)!);
}

/// True iff the network [prefix]/[bits] lies inside 100.64.0.0/10 (bits ≥ 10).
bool isInsideTailscaleV4Range(String prefix, int bits) =>
    bits >= 10 && bits <= 32 && isTailscaleV4Address(prefix);
