/// Pairing links, the signed hello and pair proofs: the Dart port of the
/// desktop `src/main/pairing.js`, checked against test/vectors/links.json,
/// ident.json, pair.json and fingerprint.json.
library;

import 'dart:convert';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart' as cg;
import 'package:cryptography/dart.dart' as cgdart;

import '../net/addresses.dart';
import 'auth.dart';
import 'codec.dart';

/// Text the host signs into hello.ident.
const String identContext = 'Tunnelview-hello-v1|';

/// Text a pair proof covers.
const String pairContext = 'Tunnelview-pair-v1|';

/// Start of every pairing link.
const String linkPrefix = 'tunnelview://pair/1/';

/// Upgrade header carrying the client nonce.
const String clientNonceHeader = 'x-tunnelview-client-nonce';

const int clientNonceBytes = 32;
const int pairTokenBytes = 16;
const int identityKeyBytes = 32;
const int _sigBytes = 64;
const int linkMaxLength = 1024;
const int _nameMax = 253;
const int _portMin = 1024;
const int _portMax = 65535;
const List<String> _linkKeys = ['v', 'id', 'n', 'a', 'p', 'k', 't', 'x'];
const String _base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

final RegExp _labelRe = RegExp(r'^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$');

/// True iff [s] is a client nonce: canonical base64 of exactly 32 bytes.
bool validCnonce(Object? s) =>
    decodeB64(s, clientNonceBytes, clientNonceBytes) != null;

/// RFC 4648 base32, upper case, no padding.
String base32(List<int> bytes) {
  final out = StringBuffer();
  var value = 0;
  var bits = 0;
  for (final b in bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out.write(_base32Alphabet[(value >> (bits - 5)) & 31]);
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out.write(_base32Alphabet[(value << (5 - bits)) & 31]);
  return out.toString();
}

/// "TV-XXXX-XXXX-XXXX-XXXX-XXXX": 100 bits of SHA-256 of the raw public key.
/// Throws BAD_KEY unless [pub] is 32 bytes.
String fingerprint(List<int> pub) {
  if (pub.length != identityKeyBytes) throw const ProtoError('BAD_KEY');
  final text = base32(crypto.sha256.convert(pub).bytes).substring(0, 20);
  return 'TV-${[for (var i = 0; i < 20; i += 4) text.substring(i, i + 4)].join('-')}';
}

String _boundFields(
  Object? nonce,
  Object? cnonce,
  Object? hostId,
  Object? viewerId,
  bool cnonceRequired,
) {
  if (!validNonce(nonce)) throw const ProtoError('BAD_NONCE');
  if (cnonce == null) {
    if (cnonceRequired) throw const ProtoError('BAD_CNONCE');
  } else if (!validCnonce(cnonce)) {
    throw const ProtoError('BAD_CNONCE');
  }
  if (!isNodeId(hostId) || !isNodeId(viewerId)) {
    throw const ProtoError('BAD_BINDING');
  }
  return '$nonce|${cnonce ?? ''}|$hostId|$viewerId';
}

/// The bytes hello.ident.sig signs.
Uint8List identBytes(
  Object? nonce,
  Object? cnonce,
  Object? hostId,
  Object? viewerId,
) => utf8.encode(
  identContext + _boundFields(nonce, cnonce, hostId, viewerId, false),
);

/// The text a pair proof covers. Pairing always has a client nonce.
String pairMessage(
  Object? nonce,
  Object? cnonce,
  Object? hostId,
  Object? viewerId,
) => pairContext + _boundFields(nonce, cnonce, hostId, viewerId, true);

/// base64(HMAC-SHA256(token, pairMessage(...))). Throws BAD_TOKEN unless
/// [token] is 16 bytes, then as [pairMessage].
String pairProof(
  List<int> token,
  Object? nonce,
  Object? cnonce,
  Object? hostId,
  Object? viewerId,
) {
  if (token.length != pairTokenBytes) throw const ProtoError('BAD_TOKEN');
  return hmacB64(token, pairMessage(nonce, cnonce, hostId, viewerId));
}

/// Result of [verifyIdent].
class IdentResult {
  const IdentResult.ok(String this.hostId, String this.viewerId, this.cnonce)
    : ok = true,
      reason = null;
  const IdentResult.fail(String this.reason)
    : ok = false,
      hostId = null,
      viewerId = null,
      cnonce = null;

  final bool ok;

  /// 'no-ident' | 'malformed' | 'bad-signature' | 'cnonce-mismatch' |
  /// 'host-mismatch' | 'viewer-mismatch', or null when [ok].
  final String? reason;
  final String? hostId;
  final String? viewerId;
  final String? cnonce;
}

/// What the viewer knows independently; a field that is set is compared.
class IdentExpect {
  const IdentExpect({
    this.cnonce,
    this.checkCnonce = false,
    this.hostId,
    this.viewerId,
  });

  /// Compared (null included) only when [checkCnonce].
  final String? cnonce;
  final bool checkCnonce;
  final String? hostId;
  final String? viewerId;
}

final cg.Ed25519 _ed25519 = cgdart.DartEd25519();

/// A viewer's check of a signed hello against the pinned 32-byte key [pub].
/// The order of the checks decides the reason, as on the desktop. Throws
/// BAD_KEY unless [pub] is 32 bytes (a caller bug).
Future<IdentResult> verifyIdent(
  List<int> pub,
  Object? hello, [
  IdentExpect expect = const IdentExpect(),
]) async {
  if (pub.length != identityKeyBytes) throw const ProtoError('BAD_KEY');
  if (hello is! Map) return const IdentResult.fail('malformed');
  final i = hello['ident'];
  if (i == null) return const IdentResult.fail('no-ident');
  if (i is! Map || i['v'] != 1 || i['alg'] != 'ed25519') {
    return const IdentResult.fail('malformed');
  }
  final auth = hello['auth'];
  final nonce = auth is Map ? auth['nonce'] : null;
  if (!i.containsKey('cnonce')) return const IdentResult.fail('malformed');
  final cnonce = i['cnonce'];
  final hostId = i['hostId'];
  final viewerId = i['viewerId'];
  final Uint8List signed;
  try {
    signed = identBytes(nonce, cnonce, hostId, viewerId);
  } on ProtoError {
    return const IdentResult.fail('malformed');
  }
  final sig = decodeB64(i['sig'], _sigBytes, _sigBytes);
  if (sig == null) return const IdentResult.fail('malformed');
  var good = false;
  try {
    good =
        _scalarBelowOrder(sig) &&
        await _ed25519.verify(
          signed,
          signature: cg.Signature(
            sig,
            publicKey: cg.SimplePublicKey(
              List<int>.of(pub),
              type: cg.KeyPairType.ed25519,
            ),
          ),
        );
  } catch (_) {
    good = false;
  }
  if (!good) return const IdentResult.fail('bad-signature');
  if (expect.checkCnonce && cnonce != expect.cnonce) {
    return const IdentResult.fail('cnonce-mismatch');
  }
  if (expect.hostId != null && hostId != expect.hostId) {
    return const IdentResult.fail('host-mismatch');
  }
  if (expect.viewerId != null && viewerId != expect.viewerId) {
    return const IdentResult.fail('viewer-mismatch');
  }
  return IdentResult.ok(
    hostId as String,
    viewerId as String,
    cnonce as String?,
  );
}

// The Ed25519 group order L, little-endian.
const List<int> _orderLe = [
  0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, //
  0xde, 0xf9, 0xde, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
];

/// RFC 8032: the signature's S (bytes 32..63, little-endian) must be below L.
bool _scalarBelowOrder(List<int> sig) {
  for (var i = 31; i >= 0; i--) {
    final s = sig[32 + i];
    final l = _orderLe[i];
    if (s < l) return true;
    if (s > l) return false;
  }
  return false;
}

/// A parsed pairing link.
class PairLink {
  const PairLink({
    required this.hostId,
    required this.name,
    required this.addresses,
    required this.port,
    required this.key,
    required this.token,
    required this.expiresAt,
  });

  /// The host's StableNodeID.
  final String hostId;

  /// Its MagicDNS name, or ''.
  final String name;

  /// 1-2 Tailscale addresses, IPv4 first.
  final List<String> addresses;
  final int port;

  /// base64url of the host's raw Ed25519 public key.
  final String key;

  /// base64url of the 16-byte offer token.
  final String token;

  /// Expiry in unix seconds.
  final int expiresAt;

  Uint8List get keyBytes => decodeB64Url(key, identityKeyBytes)!;
  Uint8List get tokenBytes => decodeB64Url(token, pairTokenBytes)!;

  /// The link's JSON object, as the desktop's parseLink returns it.
  Map<String, Object> toJson() => {
    'v': 1,
    'id': hostId,
    'n': name,
    'a': addresses,
    'p': port,
    'k': key,
    't': token,
    'x': expiresAt,
  };

  /// The one canonical JSON text of this link.
  String canonicalJson() =>
      '{"v":1,"id":"$hostId","n":"$name",'
      '"a":[${addresses.map((a) => '"$a"').join(',')}],'
      '"p":$port,"k":"$key","t":"$token","x":$expiresAt}';
}

bool _validName(Object? n) {
  if (n is! String) return false;
  if (n.isEmpty) return true;
  return n.length <= _nameMax && n.split('.').every(_labelRe.hasMatch);
}

bool _validAddresses(Object? a) {
  if (a is! List || a.isEmpty || a.length > 2) return false;
  for (final ip in a) {
    if (ip is! String ||
        !isTailscaleAddress(ip) ||
        canonicalAddress(ip) != ip) {
      return false;
    }
  }
  if (a.length == 1) return true;
  return !(a[0] as String).contains(':') && (a[1] as String).contains(':');
}

/// Strict parse of a pairing link: only the one spelling the desktop writes
/// is accepted. Throws [ProtoError] with, in the order checked: LINK_FORMAT,
/// LINK_ENCODING, LINK_JSON, LINK_VERSION, LINK_FIELDS, LINK_ID, LINK_NAME,
/// LINK_ADDRESS, LINK_PORT, LINK_KEY, LINK_TOKEN, LINK_EXPIRY,
/// LINK_NONCANONICAL. The expiry is checked by the caller.
PairLink parseLink(Object? str) {
  if (str is! String ||
      str.length > linkMaxLength ||
      !str.startsWith(linkPrefix)) {
    throw const ProtoError('LINK_FORMAT');
  }
  final payload = str.substring(linkPrefix.length);
  final bytes = payload.isEmpty ? null : decodeB64Url(payload);
  if (bytes == null) throw const ProtoError('LINK_ENCODING');
  final String text;
  final Object? obj;
  try {
    // Dart's decoder would silently drop a leading byte order mark.
    if (bytes.length >= 3 &&
        bytes[0] == 0xef &&
        bytes[1] == 0xbb &&
        bytes[2] == 0xbf) {
      throw const FormatException('BOM');
    }
    text = const Utf8Decoder().convert(bytes);
    obj = jsonDecode(text);
  } on FormatException {
    throw const ProtoError('LINK_JSON');
  }
  if (obj is! Map) throw const ProtoError('LINK_JSON');
  if (obj['v'] is! num || obj['v'] != 1) throw const ProtoError('LINK_VERSION');
  if (obj.length != _linkKeys.length || !_linkKeys.every(obj.containsKey)) {
    throw const ProtoError('LINK_FIELDS');
  }
  if (!isNodeId(obj['id'])) throw const ProtoError('LINK_ID');
  if (!_validName(obj['n'])) throw const ProtoError('LINK_NAME');
  if (!_validAddresses(obj['a'])) throw const ProtoError('LINK_ADDRESS');
  final p = obj['p'];
  if (!isSafeInteger(p) || (p as num) < _portMin || p > _portMax) {
    throw const ProtoError('LINK_PORT');
  }
  if (decodeB64Url(obj['k'], identityKeyBytes) == null) {
    throw const ProtoError('LINK_KEY');
  }
  if (decodeB64Url(obj['t'], pairTokenBytes) == null) {
    throw const ProtoError('LINK_TOKEN');
  }
  final x = obj['x'];
  if (!isSafeInteger(x) || (x as num) <= 0) {
    throw const ProtoError('LINK_EXPIRY');
  }
  final link = PairLink(
    hostId: obj['id'] as String,
    name: obj['n'] as String,
    addresses: List<String>.unmodifiable((obj['a'] as List).cast<String>()),
    port: p.toInt(),
    key: obj['k'] as String,
    token: obj['t'] as String,
    expiresAt: x.toInt(),
  );
  if (link.canonicalJson() != text) {
    throw const ProtoError('LINK_NONCANONICAL');
  }
  return link;
}
