/// The platform-neutral contract between the Dart app and the native network
/// code that finds the Tailscale tunnel. Android implements it in Kotlin
/// (`TailnetPlugin.kt`); an iOS Swift twin can implement the same channel and
/// map format later. Unit tests implement it with a fake of their own.
///
/// Map format of a snapshot (all keys always present unless noted):
///
///     at:       int, monotonic milliseconds (Android: elapsedRealtime)
///     sdk:      int, OS API level (0 if unknown)
///     networks: list of {
///       handle: int, isVpn: bool, transports: list of String,
///       validated: bool, isActive: bool, hasLinkProperties: bool,
///       interface: String or null,
///       addresses: list of {address: String, prefix: int},
///       routes: list of {destination: String, prefix: int,
///                        gateway: String or null, interface: String or null,
///                        isDefault: bool, type: int or null},
///       dns: list of String }
///     tailnet:  int or null, the handle of the network the platform chose
///     reason:   'ok' | 'none' | 'no-fd7a' | 'several'
///     binding:  {process: int or null, attempted: int or null,
///                ok: bool or null}
///
/// An event is a map with `kind` (String: 'listen', 'available', 'lost',
/// 'capabilities' or 'link-properties'), `handle` (int or null, the network
/// that changed) and `snapshot` (a snapshot taken right after the change).
library;

/// Method channel shared by every platform implementation.
const String tailnetMethodChannel = 'io.github.naminaone99.tunnelview/tailnet';

/// Event channel shared by every platform implementation.
const String tailnetEventChannel =
    'io.github.naminaone99.tunnelview/tailnet/events';

/// Result of [TailnetPlatform.openTailscale].
enum OpenTailscaleResult { opened, notInstalled, failed }

/// What the native side must provide.
abstract interface class TailnetPlatform {
  /// The current view of every network, the chosen tailnet network and the
  /// process binding. Taking a snapshot also binds the process to a newly
  /// chosen tailnet network.
  Future<TailnetSnapshot> snapshot();

  /// A new snapshot after every network change.
  Stream<TailnetEvent> events();

  /// Binds the whole process to the network [handle]. False means the OS
  /// refused (Tunnelview is excluded from the VPN) or the network is gone.
  Future<bool> bindProcess(int handle);

  /// True iff the tailnet network [handle] has a route that covers
  /// [address] (4 or 16 bytes), is not a default route (prefix > 0) and uses
  /// the tunnel interface.
  Future<bool> routeCovers(int handle, List<int> address);

  /// The phone's name (Settings DEVICE_NAME, else the model).
  Future<String> deviceName();

  /// Opens the Tailscale app.
  Future<OpenTailscaleResult> openTailscale();
}

/// Thrown when the platform sends a map that does not match the contract.
class TailnetFormatException implements Exception {
  const TailnetFormatException(this.message);
  final String message;
  @override
  String toString() => 'TailnetFormatException: $message';
}

Map<Object?, Object?> _map(Object? v, String what) {
  if (v is Map) return v;
  throw TailnetFormatException('$what is not a map');
}

List<Object?> _list(Object? v, String what) {
  if (v is List) return v;
  throw TailnetFormatException('$what is not a list');
}

int _int(Object? v, String what) {
  if (v is int) return v;
  throw TailnetFormatException('$what is not an int');
}

int? _intOrNull(Object? v, String what) => v == null ? null : _int(v, what);

bool _bool(Object? v, String what) {
  if (v is bool) return v;
  throw TailnetFormatException('$what is not a bool');
}

String _string(Object? v, String what) {
  if (v is String) return v;
  throw TailnetFormatException('$what is not a string');
}

String? _stringOrNull(Object? v, String what) =>
    v == null ? null : _string(v, what);

/// An address with its prefix length, as on an interface.
class LinkAddressInfo {
  const LinkAddressInfo(this.address, this.prefix);

  factory LinkAddressInfo.fromMap(Object? raw) {
    final m = _map(raw, 'address');
    return LinkAddressInfo(
      _string(m['address'], 'address.address'),
      _int(m['prefix'], 'address.prefix'),
    );
  }

  final String address;
  final int prefix;
}

/// One route of a network.
class RouteEntry {
  const RouteEntry({
    required this.destination,
    required this.prefix,
    this.gateway,
    this.interfaceName,
    this.isDefault = false,
    this.type,
  });

  factory RouteEntry.fromMap(Object? raw) {
    final m = _map(raw, 'route');
    return RouteEntry(
      destination: _string(m['destination'], 'route.destination'),
      prefix: _int(m['prefix'], 'route.prefix'),
      gateway: _stringOrNull(m['gateway'], 'route.gateway'),
      interfaceName: _stringOrNull(m['interface'], 'route.interface'),
      isDefault: _bool(m['isDefault'], 'route.isDefault'),
      type: _intOrNull(m['type'], 'route.type'),
    );
  }

  final String destination;
  final int prefix;
  final String? gateway;
  final String? interfaceName;
  final bool isDefault;

  /// RTN_* route type (API 33+), else null.
  final int? type;

  /// Linux RTN_UNICAST.
  static const int rtnUnicast = 1;
}

/// One network as the OS reports it.
class NetworkEntry {
  const NetworkEntry({
    required this.handle,
    required this.isVpn,
    this.transports = const [],
    this.validated = false,
    this.isActive = false,
    this.hasLinkProperties = true,
    this.interfaceName,
    this.addresses = const [],
    this.routes = const [],
    this.dns = const [],
  });

  factory NetworkEntry.fromMap(Object? raw) {
    final m = _map(raw, 'network');
    return NetworkEntry(
      handle: _int(m['handle'], 'network.handle'),
      isVpn: _bool(m['isVpn'], 'network.isVpn'),
      transports: [
        for (final t in _list(m['transports'], 'network.transports'))
          _string(t, 'network.transports[]'),
      ],
      validated: _bool(m['validated'], 'network.validated'),
      isActive: _bool(m['isActive'], 'network.isActive'),
      hasLinkProperties: _bool(
        m['hasLinkProperties'],
        'network.hasLinkProperties',
      ),
      interfaceName: _stringOrNull(m['interface'], 'network.interface'),
      addresses: [
        for (final a in _list(m['addresses'], 'network.addresses'))
          LinkAddressInfo.fromMap(a),
      ],
      routes: [
        for (final r in _list(m['routes'], 'network.routes'))
          RouteEntry.fromMap(r),
      ],
      dns: [
        for (final d in _list(m['dns'], 'network.dns'))
          _string(d, 'network.dns[]'),
      ],
    );
  }

  final int handle;
  final bool isVpn;
  final List<String> transports;
  final bool validated;
  final bool isActive;
  final bool hasLinkProperties;
  final String? interfaceName;
  final List<LinkAddressInfo> addresses;
  final List<RouteEntry> routes;
  final List<String> dns;
}

/// The process binding as the platform reports it.
class BindingInfo {
  const BindingInfo({this.process, this.attempted, this.ok});

  factory BindingInfo.fromMap(Object? raw) {
    final m = _map(raw, 'binding');
    return BindingInfo(
      process: _intOrNull(m['process'], 'binding.process'),
      attempted: _intOrNull(m['attempted'], 'binding.attempted'),
      ok: m['ok'] == null ? null : _bool(m['ok'], 'binding.ok'),
    );
  }

  /// The network the process is bound to right now (from the OS).
  final int? process;

  /// The network of the last bind attempt.
  final int? attempted;

  /// The result of the last bind attempt.
  final bool? ok;
}

/// Reasons the platform gives for its tailnet choice.
abstract final class TailnetReason {
  static const ok = 'ok';
  static const none = 'none';
  static const noFd7a = 'no-fd7a';
  static const several = 'several';
  static const all = {ok, none, noFd7a, several};
}

/// Everything the platform knows at one moment.
class TailnetSnapshot {
  const TailnetSnapshot({
    required this.at,
    required this.networks,
    required this.reason,
    this.sdk = 0,
    this.tailnetHandle,
    this.binding = const BindingInfo(),
  });

  factory TailnetSnapshot.fromMap(Object? raw) {
    final m = _map(raw, 'snapshot');
    final reason = _string(m['reason'], 'reason');
    if (!TailnetReason.all.contains(reason)) {
      throw TailnetFormatException('unknown reason "$reason"');
    }
    return TailnetSnapshot(
      at: _int(m['at'], 'at'),
      sdk: _int(m['sdk'], 'sdk'),
      networks: [
        for (final n in _list(m['networks'], 'networks'))
          NetworkEntry.fromMap(n),
      ],
      tailnetHandle: _intOrNull(m['tailnet'], 'tailnet'),
      reason: reason,
      binding: BindingInfo.fromMap(m['binding']),
    );
  }

  /// Monotonic milliseconds.
  final int at;
  final int sdk;
  final List<NetworkEntry> networks;

  /// The network the platform chose (null unless [reason] is 'ok').
  final int? tailnetHandle;
  final String reason;
  final BindingInfo binding;
}

/// A network change with the snapshot taken right after it.
class TailnetEvent {
  const TailnetEvent({required this.kind, required this.snapshot, this.handle});

  factory TailnetEvent.fromMap(Object? raw) {
    final m = _map(raw, 'event');
    return TailnetEvent(
      kind: _string(m['kind'], 'kind'),
      handle: _intOrNull(m['handle'], 'handle'),
      snapshot: TailnetSnapshot.fromMap(m['snapshot']),
    );
  }

  final String kind;
  final int? handle;
  final TailnetSnapshot snapshot;
}
