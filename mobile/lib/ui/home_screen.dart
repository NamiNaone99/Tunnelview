import 'package:flutter/material.dart';

import '../app/connectivity.dart';
import '../app_info.dart';
import '../platform/tailnet.dart';
import '../rtc/engine.dart';
import 'diagnostics_screen.dart';
import 'strings.dart';
import 'tailscale_pill.dart';

/// Home: the Tailscale pill, Open Tailscale, and the (empty) computers list.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key, required this.controller, this.info});

  final ConnectivityController controller;

  /// Build facts to show; defaults to [AppInfo.current].
  final AppInfo? info;

  @override
  Widget build(BuildContext context) {
    final app = info ?? AppInfo.current;
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) => _build(context, app),
    );
  }

  Widget _build(BuildContext context, AppInfo app) {
    final theme = Theme.of(context);
    final state = controller.tailnet;
    final selfTest = controller.selfTest;
    final rtc = RtcEngine.result;
    return Scaffold(
      // The keyboard must never refit the remote screen later on.
      resizeToAvoidBottomInset: false,
      appBar: AppBar(
        title: const Text(Strings.appTitle),
        actions: [
          IconButton(
            key: const Key('open-diagnostics'),
            tooltip: Strings.diagnostics,
            icon: const Icon(Icons.monitor_heart_outlined),
            onPressed: () => openDiagnostics(context, controller, app),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: TailscalePill(state: state),
            ),
            const SizedBox(height: 12),
            TailscaleStatusCard(
              state: state,
              onOpenDiagnostics: () =>
                  openDiagnostics(context, controller, app),
            ),
            if (selfTest != null && !selfTest.allowsSessions)
              Card(
                key: const Key('selftest-card'),
                child: ListTile(
                  title: const Text(Strings.selfTestBlockedTitle),
                  subtitle: Text(Strings.selfTestVerdict(selfTest.verdict)),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => openDiagnostics(context, controller, app),
                ),
              ),
            const SizedBox(height: 8),
            Align(
              alignment: Alignment.centerLeft,
              child: state.isOk
                  ? OutlinedButton.icon(
                      key: const Key('open-tailscale'),
                      onPressed: () => openTailscale(context, controller),
                      icon: const Icon(Icons.open_in_new),
                      label: const Text(Strings.openTailscale),
                    )
                  : FilledButton.icon(
                      key: const Key('open-tailscale'),
                      onPressed: () => openTailscale(context, controller),
                      icon: const Icon(Icons.open_in_new),
                      label: const Text(Strings.openTailscale),
                    ),
            ),
            const SizedBox(height: 24),
            Text(Strings.computers, style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            const Text(Strings.noComputers),
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerLeft,
              child: FilledButton.icon(
                key: const Key('pair-computer'),
                onPressed: null,
                icon: const Icon(Icons.qr_code_scanner),
                label: const Text(Strings.pairComputer),
              ),
            ),
            const SizedBox(height: 4),
            Text(Strings.comingSoon, style: theme.textTheme.bodySmall),
            const SizedBox(height: 32),
            const Divider(),
            Text('Version ${app.versionLabel}'),
            Text('Channel: ${app.channel.name}'),
            Text(
              rtc == null
                  ? 'WebRTC: not started'
                  : rtc.ok
                  ? 'WebRTC: ready (Tailscale tunnel only)'
                  : 'WebRTC: unavailable (${rtc.error})',
            ),
          ],
        ),
      ),
    );
  }
}

/// Opens Diagnostics.
void openDiagnostics(
  BuildContext context,
  ConnectivityController controller,
  AppInfo app,
) {
  Navigator.of(context).push(
    MaterialPageRoute<void>(
      builder: (_) => DiagnosticsScreen(controller: controller, info: app),
    ),
  );
}

/// Opens the Tailscale app, or explains why it could not.
Future<void> openTailscale(
  BuildContext context,
  ConnectivityController controller,
) async {
  final messenger = ScaffoldMessenger.of(context);
  final result = await controller.openTailscale();
  switch (result) {
    case OpenTailscaleResult.opened:
      return;
    case OpenTailscaleResult.notInstalled:
      messenger.showSnackBar(
        const SnackBar(content: Text(Strings.tailscaleNotInstalled)),
      );
    case OpenTailscaleResult.failed:
      messenger.showSnackBar(
        const SnackBar(content: Text(Strings.tailscaleOpenFailed)),
      );
  }
}
