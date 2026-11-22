/// Strict base64 helpers, ported from the desktop `auth.decodeB64` and
/// `pairing.decodeB64url` (test/vectors/auth-v2.json).
library;

import 'dart:convert';
import 'dart:typed_data';

final RegExp _b64Re = RegExp(r'^[A-Za-z0-9+/]+={0,2}$');
final RegExp _b64UrlRe = RegExp(r'^[A-Za-z0-9_-]*$');

/// Canonical base64 with padding, [min]..[max] bytes. Null for anything else.
Uint8List? decodeB64(Object? s, int min, int max) {
  if (s is! String || s.isEmpty || s.length % 4 != 0) return null;
  if (s.length > ((max + 2) ~/ 3) * 4) return null;
  if (!_b64Re.hasMatch(s)) return null;
  final Uint8List bytes;
  try {
    bytes = base64.decode(s);
  } on FormatException {
    return null;
  }
  if (bytes.length < min || bytes.length > max) return null;
  // Rejects non-canonical padding bits.
  if (base64.encode(bytes) != s) return null;
  return bytes;
}

/// Canonical base64url without padding; exactly [bytes] bytes when given.
Uint8List? decodeB64Url(Object? s, [int? bytes]) {
  if (s is! String || !_b64UrlRe.hasMatch(s) || s.length % 4 == 1) return null;
  if (bytes != null && s.length != (bytes * 4 + 2) ~/ 3) return null;
  final Uint8List out;
  try {
    out = base64Url.decode(base64Url.normalize(s));
  } on FormatException {
    return null;
  }
  if (encodeB64Url(out) != s) return null;
  if (bytes != null && out.length != bytes) return null;
  return out;
}

/// base64url without padding.
String encodeB64Url(List<int> bytes) =>
    base64Url.encode(bytes).replaceAll('=', '');

/// True iff [a] and [b] hold the same bytes. The time depends only on the
/// lengths.
bool constantTimeEquals(List<int> a, List<int> b) {
  if (a.length != b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff == 0;
}

/// JavaScript's `Number.isSafeInteger` for a decoded JSON value.
bool isSafeInteger(Object? v) {
  if (v is int) return v.abs() <= 9007199254740991;
  if (v is double) {
    return v.isFinite &&
        v == v.truncateToDouble() &&
        v.abs() <= 9007199254740991;
  }
  return false;
}
