/// A verified connection to a paired (or pairing) computer: dial, hello, and
/// the check of the host's signature, before the phone sends anything.
library;

import 'dart:async';
import 'dart:convert';

import '../net/addresses.dart';
import '../proto/auth.dart';
import '../proto/pairing.dart';
import '../proto/signal.dart';
import 'transport.dart';

/// Why a connection ended or could not start. [reason] is a code the UI
/// turns into text (`Strings.closeText`).
class LinkFailure implements Exception {
  const LinkFailure(this.reason, {this.retryAfterSec, this.hostReason});

  /// unreachable | timeout | not-tunnelview | protocol | rate-limited |
  /// not-tailnet-route | host-too-old | identity-unavailable |
  /// identity-mismatch | viewer-changed | network | host-ended |
  /// host-updating | denied:reason | local …
  final String reason;
  final int? retryAfterSec;

  /// The host's own `bye` reason when [reason] is host-ended.
  final String? hostReason;

  @override
  String toString() => 'LinkFailure($reason)';
}

/// What a host says about itself in hello. Display strings are cleaned.
class HelloInfo {
  const HelloInfo({
    required this.hostname,
    required this.os,
    required this.userLogin,
    required this.userDisplayName,
    required this.version,
    required this.passwordSet,
    required this.passwordOnly,
    required this.autoAccept,
    required this.passwordLocked,
    required this.nonce,
    required this.salt,
    required this.kdf,
  });

  final String hostname;

  /// windows | macos | linux | other.
  final String os;
  final String userLogin;
  final String userDisplayName;
  final String version;
  final bool passwordSet;

  /// acceptMode is 'password-only' (else 'ask').
  final bool passwordOnly;

  /// The host will admit this phone without a password.
  final bool autoAccept;

  /// Password sign-in is locked for this phone right now.
  final bool passwordLocked;
  final String nonce;
  final String? salt;
  final Map<String, Object?>? kdf;

  /// A password-only host that will not let this phone in without one.
  bool get needsPassword =>
      passwordOnly && passwordSet && !autoAccept && !passwordLocked;
}

const Set<String> _oses = {'windows', 'macos', 'linux', 'ios', 'android'};

/// Parses a hello frame. Throws [LinkFailure] 'not-tunnelview' or 'protocol'.
HelloInfo parseHello(Map<String, dynamic> msg) {
  if (msg['app'] != 'Tunnelview') throw const LinkFailure('not-tunnelview');
  if (msg['protocol'] != protocolVersion) throw const LinkFailure('protocol');
  final h = msg['host'];
  final a = msg['auth'];
  if (h is! Map || a is! Map) throw const LinkFailure('protocol');
  final passwordSet = a['passwordSet'];
  final mode = a['acceptMode'];
  if (passwordSet is! bool ||
      (mode != 'ask' && mode != 'password-only') ||
      !validNonce(a['nonce'])) {
    throw const LinkFailure('protocol');
  }
  final salt = a['salt'];
  final kdf = a['kdf'];
  if (passwordSet) {
    if (salt is! String || salt.length > 128 || kdf is! Map) {
      throw const LinkFailure('protocol');
    }
    // Unsafe parameters are refused up front: a rogue host must not get a
    // cheap-to-crack proof, nor make the phone burn memory.
    if (!validateKdf(kdf)) throw const LinkFailure('protocol');
  }
  final user = h['user'] is Map ? h['user'] as Map : const {};
  final os = h['os'];
  return HelloInfo(
    hostname: cleanLabel(h['hostname'], 64),
    os: os is String && _oses.contains(os) ? os : 'other',
    userLogin: cleanLabel(user['login'], 120),
    userDisplayName: cleanLabel(user['displayName'], 80),
    version: cleanLabel(msg['version'], 32),
    passwordSet: passwordSet,
    passwordOnly: mode == 'password-only',
    autoAccept: a['autoAccept'] == true,
    passwordLocked: a['passwordLocked'] == true,
    nonce: a['nonce'] as String,
    salt: passwordSet ? salt as String : null,
    kdf: passwordSet
        ? {'N': kdf['N'], 'r': kdf['r'], 'p': kdf['p'], 'keylen': kdf['keylen']}
        : null,
  );
}

/// The reason for an HTTP refusal of the upgrade.
String reasonForStatus(int? status) => switch (status) {
  403 => 'denied:not-allowed',
  429 => 'rate-limited',
  503 => 'denied:busy',
  400 || 426 => 'protocol',
  _ => 'not-tunnelview',
};

final RegExp _versionRe = RegExp(r'^(\d{1,4})\.(\d{1,4})\.');

/// True iff [version] is 0.3.0 or later: a host with identities.
bool hasIdentities(String version) {
  final m = _versionRe.firstMatch(version);
  if (m == null) return false;
  final major = int.parse(m.group(1)!);
  return major > 0 || int.parse(m.group(2)!) >= 3;
}

/// A connection whose hello carried a valid signature by the pinned key.
class HostLink {
  HostLink._(
    this._conn,
    this._frames,
    this.hello,
    this.hostId,
    this.viewerId,
    this.address,
    this.cnonce,
  );

  final SignalConnection _conn;
  final StreamIterator<String> _frames;

  final HelloInfo hello;

  /// The host's node ID, signed by its identity key.
  final String hostId;

  /// How the host sees this phone (its Tailscale node ID), signed too.
  final String viewerId;

  /// The address that answered.
  final String address;

  /// This connection's client nonce, which the host signed.
  final String cnonce;

  bool _closed = false;

  /// Dials [addresses] in order and returns after hello passed every check:
  /// the socket runs over this phone's Tailscale address, the hello is a
  /// Tunnelview v2 hello, and its `ident` is signed by [key] for this very
  /// connection, for [hostId] (and for [viewerId] when given).
  ///
  /// Nothing but the upgrade request is sent before that. Throws
  /// [LinkFailure].
  static Future<HostLink> open({
    required SignalTransport transport,
    required List<String> addresses,
    required int port,
    required List<int> key,
    required String hostId,
    required List<String> selfAddrs,
    String? viewerId,
  }) async {
    LinkFailure last = const LinkFailure('unreachable');
    for (final ip in addresses) {
      final cnonce = newClientNonce();
      final SignalConnection conn;
      try {
        conn = await transport.dial(ip, port, cnonce);
      } on DialFailure catch (e) {
        if (e.reason == 'http') throw LinkFailure(reasonForStatus(e.status));
        if (e.reason == 'not-tunnelview') {
          throw const LinkFailure('not-tunnelview');
        }
        last = LinkFailure(e.reason);
        continue; // unreachable or timeout: try the other address family
      }
      try {
        return await _verify(
          conn,
          ip,
          cnonce,
          key,
          hostId,
          viewerId,
          selfAddrs,
        );
      } catch (_) {
        unawaited(conn.close());
        rethrow;
      }
    }
    throw last;
  }

  static Future<HostLink> _verify(
    SignalConnection conn,
    String ip,
    String cnonce,
    List<int> key,
    String hostId,
    String? viewerId,
    List<String> selfAddrs,
  ) async {
    if (!localPathOk(conn.localAddress, ip, selfAddrs)) {
      throw const LinkFailure('not-tailnet-route');
    }
    final frames = StreamIterator(conn.frames);
    final bool got;
    try {
      got = await frames.moveNext().timeout(handshakeTimeout);
    } on TimeoutException {
      throw const LinkFailure('timeout');
    } on FormatException {
      throw const LinkFailure('protocol');
    }
    if (!got) {
      throw LinkFailure(conn.closeCode == 4000 ? 'protocol' : 'not-tunnelview');
    }
    final msg = decodeFrame(frames.current);
    if (msg['t'] != 'hello') throw const LinkFailure('not-tunnelview');
    final hello = parseHello(msg);
    final ident = await verifyIdent(
      key,
      msg,
      IdentExpect(
        cnonce: cnonce,
        checkCnonce: true,
        hostId: hostId,
        viewerId: viewerId,
      ),
    );
    if (!ident.ok) {
      throw LinkFailure(switch (ident.reason) {
        'no-ident' =>
          hasIdentities(hello.version)
              ? 'identity-unavailable'
              : 'host-too-old',
        'viewer-mismatch' => 'viewer-changed',
        _ => 'identity-mismatch',
      });
    }
    return HostLink._(
      conn,
      frames,
      hello,
      ident.hostId!,
      ident.viewerId!,
      ip,
      cnonce,
    );
  }

  /// The proof binding for this connection, from the signed hello.
  Map<String, String> get binding => {'hostId': hostId, 'viewerId': viewerId};

  /// Sends one JSON frame.
  void send(Map<String, Object?> msg) {
    if (!_closed) _conn.send(jsonEncode(msg));
  }

  /// The next frame as a JSON object, or null when the socket closed.
  /// Throws [LinkFailure] 'protocol' for anything that is not one.
  Future<Map<String, dynamic>?> next() async {
    final bool got;
    try {
      got = await _frames.moveNext();
    } on FormatException {
      throw const LinkFailure('protocol');
    }
    if (!got) return null;
    return decodeFrame(_frames.current);
  }

  /// The WebSocket close code once [next] returned null.
  int? get closeCode => _conn.closeCode;

  Future<void> close([int code = 1000]) async {
    if (_closed) return;
    _closed = true;
    // Stop reading first: an unread frame must not keep the close waiting.
    unawaited(_frames.cancel());
    await _conn.close(code);
  }
}

/// A text frame as a JSON object with a string `t`. Throws 'protocol'.
Map<String, dynamic> decodeFrame(String text) {
  final Object? v;
  try {
    v = jsonDecode(text);
  } on FormatException {
    throw const LinkFailure('protocol');
  }
  if (v is! Map<String, dynamic> || v['t'] is! String) {
    throw const LinkFailure('protocol');
  }
  return v;
}

/// The socket really runs over Tailscale: its local address is one of this
/// phone's own Tailscale addresses, of the same family as the dialed one.
bool localPathOk(String? local, String dialed, List<String> selfAddrs) {
  final l = canonicalAddress(local);
  final d = canonicalAddress(dialed);
  if (l == null || d == null) return false;
  if (!selfAddrs.any((a) => canonicalAddress(a) == l)) return false;
  return l.contains(':') == d.contains(':');
}
