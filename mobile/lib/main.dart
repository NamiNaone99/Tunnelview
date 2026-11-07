import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter/material.dart';

import 'app/connectivity.dart';
import 'app_info.dart';
import 'platform/tailnet.dart';
import 'rtc/engine.dart';
import 'ui/home_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
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
      home: HomeScreen(controller: widget.controller, info: widget.info),
    );
  }
}
