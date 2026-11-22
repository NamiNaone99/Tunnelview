/// Password proofs (protocol v2), ported from the desktop `src/main/auth.js`
/// and checked against test/vectors/auth-v2.json.
///
///   key   = scrypt(utf8(NFC password), salt, 32, {N, r, p})
///   proof = base64(HMAC-SHA256(key, context + nonce + '|' + hostId + '|' + viewerId))
///
/// The password never leaves the phone. The KDF parameters come from the
/// host's hello, so they are validated before scrypt runs.
library;

import 'dart:convert';
import 'dart:isolate';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:hashlib/hashlib.dart' as hashlib;

import 'codec.dart';

/// Text every password proof starts with.
const String authContext = 'Tunnelview-auth-v2|';

const int _maxN = 131072;
const int _maxR = 16;
const int _maxP = 4;
const int _keylen = 32;
const int _scryptMaxMem = 64 * 1024 * 1024;
const int _minKdfWork = 1 << 17;
const int _saltBytes = 16;

/// Longest password accepted (characters). The UI enforces less.
const int maxPasswordLength = 1024;

final RegExp _nodeIdRe = RegExp(r'^[A-Za-z0-9_-]{1,64}$');

/// A protocol error with the desktop's error code (BAD_BINDING, BAD_KDF, …).
class ProtoError implements Exception {
  const ProtoError(this.code);

  final String code;

  @override
  String toString() => 'ProtoError($code)';
}

/// True iff [s] is a Tailscale StableNodeID as proofs bind it.
bool isNodeId(Object? s) => s is String && _nodeIdRe.hasMatch(s);

/// True iff [s] is a hello nonce: canonical base64 of 16 to 64 bytes.
bool validNonce(Object? s) => decodeB64(s, 16, 64) != null;

/// The two node IDs a proof is bound to.
class Binding {
  const Binding(this.hostId, this.viewerId);

  final String hostId;
  final String viewerId;
}

/// `{hostId, viewerId}` as a [Binding], or null unless both are node IDs.
Binding? normalizeBinding(Object? binding) {
  if (binding is! Map) return null;
  final h = binding['hostId'];
  final v = binding['viewerId'];
  if (h is! String || !isNodeId(h) || v is! String || !isNodeId(v)) return null;
  return Binding(h, v);
}

/// scrypt parameters from a hello.
class Kdf {
  const Kdf(this.n, this.r, this.p);

  final int n;
  final int r;
  final int p;
}

/// The parameters in [kdf] if they are safe and computable, else null:
/// N a power of two up to 2^17, r up to 16, p up to 4, keylen 32, a minimum
/// work of N*r >= 2^17 and at most 64 MiB of memory.
Kdf? parseKdf(Object? kdf) {
  if (kdf is! Map) return null;
  final n = kdf['N'];
  final r = kdf['r'];
  final p = kdf['p'];
  final keylen = kdf['keylen'];
  if (![n, r, p, keylen].every(isSafeInteger)) return null;
  final ni = (n as num).toInt();
  final ri = (r as num).toInt();
  final pi = (p as num).toInt();
  if ((keylen as num).toInt() != _keylen) return null;
  if (ni < 2 || ni > _maxN || (ni & (ni - 1)) != 0) return null;
  if (ri < 1 || ri > _maxR) return null;
  if (pi < 1 || pi > _maxP) return null;
  if (ni * ri < _minKdfWork) return null;
  // RFC 7914: N < 2^(16 r). N <= 2^17, so only r = 1 can fail.
  if (ni.bitLength - 1 >= 16 * ri) return null;
  if (128 * ri * (ni + 2) + 128 * ri * pi > _scryptMaxMem) return null;
  return Kdf(ni, ri, pi);
}

/// Whether [kdf] passes [parseKdf].
bool validateKdf(Object? kdf) => parseKdf(kdf) != null;

/// The text a password proof covers.
String authMessage(String nonceB64, Binding b) =>
    '$authContext$nonceB64|${b.hostId}|${b.viewerId}';

/// base64(HMAC-SHA256(key, message)).
String hmacB64(List<int> key, String message) => base64.encode(
  crypto.Hmac(crypto.sha256, key).convert(utf8.encode(message)).bytes,
);

Uint8List _scrypt(List<int> password, List<int> salt, int n, int r, int p) =>
    hashlib.Scrypt(
      cost: n,
      blockSize: r,
      parallelism: p,
      derivedKeyLength: _keylen,
      salt: salt,
    ).convert(password).bytes;

/// The proof for [password] against a hello's `{salt, kdf}` and nonce.
///
/// Throws [ProtoError] before scrypt runs, checked in this order:
/// BAD_BINDING, BAD_KDF, BAD_SALT, BAD_NONCE, BAD_PASSWORD_INPUT. scrypt runs
/// in another isolate, so the UI stays responsive.
///
/// [password] must already be in Unicode NFC. Android keyboards produce NFC.
Future<String> computeProof(
  Object? password,
  Object? params,
  Object? nonceB64,
  Object? binding,
) async {
  final b = normalizeBinding(binding);
  if (b == null) throw const ProtoError('BAD_BINDING');
  if (params is! Map) throw const ProtoError('BAD_KDF');
  final kdf = parseKdf(params['kdf']);
  if (kdf == null) throw const ProtoError('BAD_KDF');
  final salt = decodeB64(params['salt'], _saltBytes, 64);
  if (salt == null) throw const ProtoError('BAD_SALT');
  if (nonceB64 is! String || !validNonce(nonceB64)) {
    throw const ProtoError('BAD_NONCE');
  }
  if (password is! String ||
      password.isEmpty ||
      password.length > maxPasswordLength) {
    throw const ProtoError('BAD_PASSWORD_INPUT');
  }
  final pw = utf8.encode(password);
  final n = kdf.n;
  final r = kdf.r;
  final p = kdf.p;
  final key = await Isolate.run(() => _scrypt(pw, salt, n, r, p));
  return hmacB64(key, authMessage(nonceB64, b));
}
