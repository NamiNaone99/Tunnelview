/// The computers this phone is paired with, and where they are stored.
library;

import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../net/addresses.dart';
import '../proto/auth.dart';
import '../proto/codec.dart';
import '../proto/pairing.dart';
import '../proto/signal.dart';

/// One paired computer. The identity key is pinned: every later connection
/// must be signed by it.
@immutable
class PairedHost {
  const PairedHost({
    required this.hostId,
    required this.name,
    required this.dnsName,
    required this.addresses,
    required this.port,
    required this.key,
    required this.viewerId,
    required this.os,
    required this.pairedAt,
  });

  /// The host's Tailscale StableNodeID.
  final String hostId;

  /// The name shown in the list (the host's own name when it paired).
  final String name;

  /// Its MagicDNS name, or ''. Display only; never resolved.
  final String dnsName;

  /// 1-2 Tailscale addresses, IPv4 first.
  final List<String> addresses;
  final int port;

  /// base64url of the host's raw Ed25519 identity key.
  final String key;

  /// This phone's node ID as the host saw it when pairing.
  final String viewerId;

  /// windows | macos | linux | other.
  final String os;

  /// Unix milliseconds.
  final int pairedAt;

  Uint8List get keyBytes => decodeB64Url(key, identityKeyBytes)!;

  /// "TV-XXXX-…": compare with Settings on the computer.
  String get fingerprintText => fingerprint(keyBytes);

  Map<String, Object?> toJson() => {
    'hostId': hostId,
    'name': name,
    'dnsName': dnsName,
    'addresses': addresses,
    'port': port,
    'key': key,
    'viewerId': viewerId,
    'os': os,
    'pairedAt': pairedAt,
  };

  /// A stored record, or null when any field is not as written by [toJson].
  static PairedHost? fromJson(Object? j) {
    if (j is! Map) return null;
    final hostId = j['hostId'];
    final viewerId = j['viewerId'];
    final addresses = j['addresses'];
    final port = j['port'];
    final key = j['key'];
    final pairedAt = j['pairedAt'];
    if (!isNodeId(hostId) || !isNodeId(viewerId)) return null;
    if (addresses is! List || addresses.isEmpty || addresses.length > 2) {
      return null;
    }
    for (final a in addresses) {
      if (a is! String || !isTailscaleAddress(a) || canonicalAddress(a) != a) {
        return null;
      }
    }
    if (port is! int || port < 1024 || port > 65535) return null;
    if (decodeB64Url(key, identityKeyBytes) == null) return null;
    if (pairedAt is! int) return null;
    final os = j['os'];
    return PairedHost(
      hostId: hostId as String,
      name: cleanLabel(j['name'], 64),
      dnsName: cleanLabel(j['dnsName'], 253),
      addresses: List.unmodifiable(addresses.cast<String>()),
      port: port,
      key: key as String,
      viewerId: viewerId as String,
      os: os is String ? cleanLabel(os, 16) : 'other',
      pairedAt: pairedAt,
    );
  }

  /// The name to show: the stored name, else the first DNS label, else the
  /// first address.
  String get displayName {
    if (name.isNotEmpty) return name;
    if (dnsName.isNotEmpty) return dnsName.split('.').first;
    return addresses.first;
  }
}

/// Where the list is kept.
abstract interface class HostStorage {
  Future<String?> read();
  Future<void> write(String value);
}

/// Android Keystore-backed storage (flutter_secure_storage).
class SecureHostStorage implements HostStorage {
  const SecureHostStorage();

  static const String _key = 'paired-hosts.v1';
  static const FlutterSecureStorage _storage = FlutterSecureStorage();

  @override
  Future<String?> read() => _storage.read(key: _key);

  @override
  Future<void> write(String value) => _storage.write(key: _key, value: value);
}

/// The list of paired computers.
class HostStore extends ChangeNotifier {
  HostStore(this._storage);

  final HostStorage _storage;
  List<PairedHost> _hosts = const [];
  bool _loaded = false;
  bool _failed = false;

  List<PairedHost> get hosts => _hosts;

  /// True once [load] finished.
  bool get loaded => _loaded;

  /// True when the stored list could not be read.
  bool get failed => _failed;

  Future<void> load() async {
    try {
      final text = await _storage.read();
      final list = text == null ? null : jsonDecode(text);
      _hosts = List.unmodifiable([
        if (list is List)
          for (final j in list) ?PairedHost.fromJson(j),
      ]);
      _failed = false;
    } catch (_) {
      _hosts = const [];
      _failed = true;
    }
    _loaded = true;
    notifyListeners();
  }

  /// Adds [host], replacing a record of the same computer.
  Future<void> save(PairedHost host) => _replace([
    host,
    for (final h in _hosts)
      if (h.hostId != host.hostId) h,
  ]);

  Future<void> remove(String hostId) => _replace([
    for (final h in _hosts)
      if (h.hostId != hostId) h,
  ]);

  Future<void> _replace(List<PairedHost> next) async {
    await _storage.write(jsonEncode([for (final h in next) h.toJson()]));
    _hosts = List.unmodifiable(next);
    _failed = false;
    notifyListeners();
  }
}
