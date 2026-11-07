import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';

import 'app/connectivity.dart';
import 'app/quiet_errors.dart';
import 'app_info.dart';
import 'platform/tailnet.dart';
import 'rtc/engine.dart';
import 'ui/home_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Release builds keep error text (which can hold addresses) out of logcat.
  installQuietErrorHandlers();
  // Invariant: WebRTC is initialised exactly once, with the tunnel-only
  // network mask, before any widget exists that could touch it.
  await RtcEngine.initialize();
  final controller = ConnectivityController(
    platform: Platform.isAndroid
        ? const MethodChannelTailnet()
        : const UnsupportedTailnet(),
    gatherer: const EngineIceGatherer(),
  );
  // Finds Tailscale, then runs the WebRTC self-test once.
  unawaited(controller.start());
  runApp(TunnelviewApp(controller: controller));
}

/// The app root.
///
/// No deep links (PLAN C13, security.md T7/T10): the app always starts at
/// home, whatever initial route the platform reports, and routes the
/// platform pushes later are ignored. MainActivity already drops the data of
/// any Intent another app sends; this is the Dart-side backstop.
class TunnelviewApp extends StatefulWidget {
  const TunnelviewApp({super.key, required this.controller, this.info});

  final ConnectivityController controller;
  final AppInfo? info;

  @override
  State<TunnelviewApp> createState() => _TunnelviewAppState();
}

class _TunnelviewAppState extends State<TunnelviewApp>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    // Registered before MaterialApp's own observer, so a pushed route stops
    // here.
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Re-check Tailscale when the user comes back (for example from the
    // Tailscale app).
    if (state == AppLifecycleState.resumed) {
      unawaited(widget.controller.refresh());
    }
  }

  // A route pushed by the platform (an Intent's URI): handled by ignoring it.
  @override
  Future<bool> didPushRouteInformation(RouteInformation routeInformation) =>
      Future.value(true);

  Route<void> _homeRoute() => MaterialPageRoute<void>(
    settings: const RouteSettings(name: Navigator.defaultRouteName),
    builder: (_) =>
        HomeScreen(controller: widget.controller, info: widget.info),
  );

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Tunnelview',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF2563EB)),
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: const Color(0xFF2563EB),
          brightness: Brightness.dark,
        ),
      ),
      onGenerateInitialRoutes: (_) => [_homeRoute()],
      onGenerateRoute: (settings) =>
          settings.name == Navigator.defaultRouteName ? _homeRoute() : null,
    );
  }
}
