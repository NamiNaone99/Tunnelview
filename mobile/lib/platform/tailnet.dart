/// The bridge to the native `TailnetPlugin` and the [TailnetMonitor] that
/// turns its snapshots into a stream of [TailnetState]s.
library;

import 'dart:async';

import 'package:flutter/services.dart';

import 'tailnet_platform.dart';
import 'tailnet_state.dart';

export 'tailnet_platform.dart';
export 'tailnet_state.dart';

/// [TailnetPlatform] over the shared method and event channels. Android today;
/// an iOS Swift twin can serve the same channels later.
class MethodChannelTailnet implements TailnetPlatform {
  const MethodChannelTailnet();

  static const MethodChannel _methods = MethodChannel(tailnetMethodChannel);
  static const EventChannel _events = EventChannel(tailnetEventChannel);

  @override
  Future<TailnetSnapshot> snapshot() async =>
      TailnetSnapshot.fromMap(await _methods.invokeMethod<Object?>('snapshot'));

  @override
  Stream<TailnetEvent> events() =>
      _events.receiveBroadcastStream().map(TailnetEvent.fromMap);

  @override
  Future<bool> bindProcess(int handle) async =>
      await _methods.invokeMethod<bool>('bindProcess', {'handle': handle}) ??
      false;

  @override
  Future<bool> routeCovers(int handle, List<int> address) async {
    if (address.length != 4 && address.length != 16) return false;
    return await _methods.invokeMethod<bool>('routeCovers', {
          'handle': handle,
          'address': List<int>.of(address),
        }) ??
        false;
  }

  @override
  Future<String> deviceName() async =>
      await _methods.invokeMethod<String>('deviceName') ?? '';

  @override
  Future<OpenTailscaleResult> openTailscale() async {
    final r = await _methods.invokeMethod<String>('openTailscale');
    return switch (r) {
      'opened' => OpenTailscaleResult.opened,
      'not-installed' => OpenTailscaleResult.notInstalled,
      _ => OpenTailscaleResult.failed,
    };
  }
}

/// For platforms without a native plugin yet (iOS until its Swift twin
/// exists): never reports a tailnet, so the app never dials.
class UnsupportedTailnet implements TailnetPlatform {
  const UnsupportedTailnet();

  @override
  Future<TailnetSnapshot> snapshot() =>
      Future.error(UnsupportedError('no Tailscale detection on this platform'));

  @override
  Stream<TailnetEvent> events() => const Stream.empty();

  @override
  Future<bool> bindProcess(int handle) async => false;

  @override
  Future<bool> routeCovers(int handle, List<int> address) async => false;

  @override
  Future<String> deviceName() async => '';

  @override
  Future<OpenTailscaleResult> openTailscale() async =>
      OpenTailscaleResult.failed;
}

/// One entry of the change log shown in Diagnostics (no addresses).
class TailnetChange {
  const TailnetChange({
    required this.at,
    required this.kind,
    required this.status,
    this.gapMs,
  });

  /// Monotonic milliseconds (platform clock).
  final int at;

  /// 'lost', 'appeared', 'reestablished', 'replaced' or 'status'.
  final String kind;
  final TailnetStatus status;

  /// For 'reestablished' / 'appeared': milliseconds since the loss.
  final int? gapMs;
}

/// Watches the platform and publishes [TailnetState]s.
///
/// "VPN re-established" (DECISIONS M-S4, CRITIQUE S4): Tailscale on Android
/// rebuilds its VPN interface on configuration changes, which ends every
/// socket. When a new tailnet network appears within [reestablishWindowMs]
/// of the previous one's loss (or replaces it directly), the states of that
/// network carry [TailnetState.vpnReestablished] while it is usable (OK), so
/// a session can end with a specific reason and offer Reconnect instead of
/// "Tailscale is off". The flag stays on every later state of that network
/// (Android follows onAvailable at once with capability and link-property
/// callbacks) until the network is lost or replaced. A replacement the app
/// cannot use (for example Tunnelview newly excluded from Tailscale) never
/// carries it.
class TailnetMonitor {
  TailnetMonitor(this.platform);

  /// The window for the "VPN re-established" hint.
  static const int reestablishWindowMs = 3000;

  /// How many changes [changes] keeps.
  static const int maxChanges = 20;

  final TailnetPlatform platform;
  final StreamController<TailnetState> _states =
      StreamController<TailnetState>.broadcast();
  final List<TailnetChange> _changes = [];
  StreamSubscription<TailnetEvent>? _sub;
  TailnetState _state = const TailnetState.checking();

  int? _lastHandle;
  int? _lostAt;

  /// The tailnet network that re-established the tunnel, until it is lost or
  /// replaced.
  int? _reestablishedHandle;
  bool _started = false;
  bool _closed = false;

  /// The latest state.
  TailnetState get state => _state;

  /// Every new state.
  Stream<TailnetState> get states => _states.stream;

  /// Recent changes, newest last.
  List<TailnetChange> get changes => List.unmodifiable(_changes);

  /// Subscribes to platform events and takes a first snapshot.
  Future<void> start() async {
    if (_started) return;
    _started = true;
    _sub = platform.events().listen(
      (e) => apply(e.snapshot),
      onError: (Object _) => _platformError(),
    );
    await refresh();
  }

  /// Takes a fresh snapshot (for example when the app resumes).
  Future<void> refresh() async {
    try {
      apply(await platform.snapshot());
    } on UnsupportedError {
      _publish(
        const TailnetState(
          status: TailnetStatus.unsupported,
          reason: TailnetStateReason.unsupported,
        ),
      );
    } catch (_) {
      _platformError();
    }
  }

  void _platformError() => _publish(
    const TailnetState(
      status: TailnetStatus.checking,
      reason: TailnetStateReason.platformError,
    ),
  );

  /// Applies one snapshot (public for tests and the event stream).
  void apply(TailnetSnapshot s) {
    if (_closed) return;
    var next = deriveTailnetState(s);
    final handle = next.network?.handle;
    final previous = _state;
    if (handle == null) {
      _reestablishedHandle = null;
      if (_lastHandle != null && _lostAt == null) {
        _lostAt = s.at;
        _log(TailnetChange(at: s.at, kind: 'lost', status: next.status));
      }
    } else if (handle != _lastHandle) {
      _reestablishedHandle = null;
      if (_lastHandle == null) {
        _log(TailnetChange(at: s.at, kind: 'appeared', status: next.status));
      } else if (_lostAt == null) {
        _reestablishedHandle = handle;
        _log(
          TailnetChange(
            at: s.at,
            kind: 'replaced',
            status: next.status,
            gapMs: 0,
          ),
        );
      } else {
        final gap = s.at - _lostAt!;
        final within = gap >= 0 && gap <= reestablishWindowMs;
        if (within) _reestablishedHandle = handle;
        _log(
          TailnetChange(
            at: s.at,
            kind: within ? 'reestablished' : 'appeared',
            status: next.status,
            gapMs: gap,
          ),
        );
      }
      _lastHandle = handle;
      _lostAt = null;
    } else if (_lostAt != null) {
      // The same network is back (it was only briefly unusable).
      _lostAt = null;
    }
    // Only a usable network re-establishes the tunnel.
    if (handle != null && handle == _reestablishedHandle && next.isOk) {
      next = next.withReestablished(true);
    }
    if (next.status != previous.status &&
        (_changes.isEmpty || _changes.last.at != s.at)) {
      _log(TailnetChange(at: s.at, kind: 'status', status: next.status));
    }
    _publish(next);
  }

  void _log(TailnetChange c) {
    _changes.add(c);
    if (_changes.length > maxChanges) _changes.removeAt(0);
  }

  void _publish(TailnetState s) {
    if (_closed) return;
    _state = s;
    _states.add(s);
  }

  /// Stops listening.
  Future<void> dispose() async {
    _closed = true;
    await _sub?.cancel();
    await _states.close();
  }
}
