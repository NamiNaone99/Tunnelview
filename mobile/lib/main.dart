import 'package:flutter/material.dart';

import 'rtc/engine.dart';
import 'ui/home_screen.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Invariant: WebRTC is initialised exactly once, with the tunnel-only
  // network mask, before any widget exists that could touch it.
  await RtcEngine.initialize();
  runApp(const TunnelviewApp());
}

/// The app root.
class TunnelviewApp extends StatelessWidget {
  const TunnelviewApp({super.key});

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
      home: const HomeScreen(),
    );
  }
}
