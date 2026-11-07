import 'package:flutter/material.dart';

import '../app_info.dart';
import '../rtc/engine.dart';

/// Placeholder home screen: name, version, channel and WebRTC start-up state.
/// The paired-computers list and the Tailscale pill replace it in later
/// milestones.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, this.info});

  /// Build facts to show; defaults to [AppInfo.current].
  final AppInfo? info;

  @override
  Widget build(BuildContext context) {
    final app = info ?? AppInfo.current;
    final rtc = RtcEngine.result;
    final theme = Theme.of(context);
    return Scaffold(
      // The keyboard must never refit the remote screen later on.
      resizeToAvoidBottomInset: false,
      appBar: AppBar(title: const Text('Tunnelview')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(app.appName, style: theme.textTheme.headlineSmall),
            const SizedBox(height: 8),
            Text('Version ${app.versionLabel}'),
            Text('Channel: ${app.channel.name}'),
            const SizedBox(height: 8),
            Text(
              rtc == null
                  ? 'WebRTC: not started'
                  : rtc.ok
                  ? 'WebRTC: ready (Tailscale tunnel only)'
                  : 'WebRTC: unavailable (${rtc.error})',
            ),
            const SizedBox(height: 24),
            const Text(
              'Pairing with a computer and connecting arrive in later builds.',
            ),
          ],
        ),
      ),
    );
  }
}
