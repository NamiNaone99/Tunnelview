/// Owns the Tailscale monitor and the WebRTC self-test result for the whole
/// app, and tells the UI when either changes.
library;

import 'dart:async';

import 'package:flutter/foundation.dart';

import '../platform/tailnet.dart';
import '../rtc/self_test.dart';
import 'session_gate.dart';

class ConnectivityController extends ChangeNotifier {
  ConnectivityController({
    required this.platform,
    required this.gatherer,
    this.selfTestTimeout = const Duration(seconds: 5),
    DateTime Function()? now,
  }) : monitor = TailnetMonitor(platform),
       _now = now ?? DateTime.now;

  final TailnetPlatform platform;
  final LocalIceGatherer gatherer;
  final TailnetMonitor monitor;
  final Duration selfTestTimeout;
  final DateTime Function() _now;

  StreamSubscription<TailnetState>? _sub;
  SelfTestResult? _selfTest;
  Future<SelfTestResult?>? _running;
  String _deviceName = '';
  bool _disposed = false;

  /// The latest Tailscale state.
  TailnetState get tailnet => monitor.state;

  /// The stored self-test result (null until the first run finished).
  SelfTestResult? get selfTest => _selfTest;

  /// True while the self-test runs.
  bool get selfTestRunning => _running != null;

  /// This phone's name, once known.
  String get deviceName => _deviceName;

  /// Null if a session may start, else a `SessionRefusal` code.
  String? get sessionRefusalCode => sessionRefusal(tailnet, _selfTest);

  /// Starts watching Tailscale. The self-test runs once Tailscale is found.
  Future<void> start() async {
    _sub ??= monitor.states.listen(_onState);
    await monitor.start();
    try {
      _deviceName = await platform.deviceName();
      _notify();
    } catch (_) {
      // The name is only shown in Diagnostics.
    }
  }

  /// Takes a fresh snapshot (on resume).
  Future<void> refresh() => monitor.refresh();

  void _onState(TailnetState s) {
    _notify();
    _maybeRunSelfTest(s);
  }

  void _maybeRunSelfTest(TailnetState s) {
    if (_disposed || !s.isOk || _running != null) return;
    if (needsSelfTest(s, _selfTest)) unawaited(runSelfTest());
  }

  /// Runs the local ICE gathering self-test against the current own
  /// Tailscale addresses and stores the result. Null if Tailscale is not OK.
  Future<SelfTestResult?> runSelfTest() {
    final running = _running;
    if (running != null) return running;
    final state = tailnet;
    if (!state.isOk) return Future.value(_selfTest);
    final future = _run(state.selfAddrs, state.network?.handle);
    _running = future;
    _notify();
    return future;
  }

  Future<SelfTestResult?> _run(List<String> selfAddrs, int? handle) async {
    GatherOutcome outcome;
    try {
      outcome = await gatherer.gather(timeout: selfTestTimeout);
    } catch (e) {
      outcome = GatherOutcome.failed(e.runtimeType.toString(), Duration.zero);
    }
    final result = evaluateSelfTest(
      outcome: outcome,
      selfAddrs: selfAddrs,
      networkHandle: handle,
      at: _now(),
    );
    _selfTest = result;
    _running = null;
    _notify();
    // A change that arrived while the test ran was not acted on.
    _maybeRunSelfTest(tailnet);
    return result;
  }

  /// Opens the Tailscale app.
  Future<OpenTailscaleResult> openTailscale() async {
    try {
      return await platform.openTailscale();
    } catch (_) {
      return OpenTailscaleResult.failed;
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_sub?.cancel());
    unawaited(monitor.dispose());
    super.dispose();
  }
}

/// Whether the self-test should run (again) on its own for the OK state [s],
/// given the stored result [last]:
/// - once per app start, after Tailscale is found;
/// - whenever the phone's own Tailscale addresses differ from the ones
///   [last] was compared with, whatever its verdict;
/// - after a failure, once more on a new tailnet network (Tailscale
///   reconnected or rebuilt its tunnel).
///
/// A failure is never re-run on the same network and addresses; the user can
/// run it again from Diagnostics.
bool needsSelfTest(TailnetState s, SelfTestResult? last) {
  if (last == null) return true;
  if (!sameAddressSet(last.selfAddrs, s.selfAddrs)) return true;
  return !last.allowsSessions && last.networkHandle != s.network?.handle;
}
