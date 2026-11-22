import 'dart:async';

import 'package:flutter/material.dart';

import '../app/connectivity.dart';
import '../app/services.dart';
import '../app_info.dart';
import '../session/hosts.dart';
import 'pair_screen.dart';
import 'session_screen.dart';
import 'session_strings.dart';
import 'strings.dart';

/// The paired computers and the Pair button on the home screen.
class ComputersList extends StatelessWidget {
  const ComputersList({
    super.key,
    required this.controller,
    required this.services,
    required this.info,
  });

  final ConnectivityController controller;
  final AppServices? services;
  final AppInfo info;

  @override
  Widget build(BuildContext context) {
    final s = services;
    if (s == null) return _body(context, null, const []);
    return ListenableBuilder(
      listenable: s.hosts,
      builder: (context, _) => _body(context, s, s.hosts.hosts),
    );
  }

  Widget _body(BuildContext context, AppServices? s, List<PairedHost> hosts) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (s != null && s.hosts.failed)
          const Padding(
            padding: EdgeInsets.only(bottom: 8),
            child: Text(SessionStrings.hostsUnreadable),
          ),
        if (hosts.isEmpty)
          const Text(Strings.noComputers)
        else
          for (final host in hosts)
            Card(
              key: Key('host-${host.hostId}'),
              child: ListTile(
                leading: Icon(_osIcon(host.os)),
                title: Text(host.displayName),
                subtitle: Text(
                  host.dnsName.isEmpty ? host.addresses.first : host.dnsName,
                ),
                trailing: IconButton(
                  key: Key('host-menu-${host.hostId}'),
                  tooltip: 'Details',
                  icon: const Icon(Icons.more_vert),
                  onPressed: () => unawaited(_details(context, s!, host)),
                ),
                onTap: () => _connect(context, s!, host),
              ),
            ),
        const SizedBox(height: 12),
        FilledButton.icon(
          key: const Key('pair-computer'),
          onPressed: s == null ? null : () => unawaited(_pair(context, s)),
          icon: const Icon(Icons.qr_code_scanner),
          label: const Text(Strings.pairComputer),
        ),
      ],
    );
  }

  static IconData _osIcon(String os) => switch (os) {
    'macos' => Icons.laptop_mac,
    'windows' => Icons.desktop_windows,
    _ => Icons.computer,
  };

  void _say(BuildContext context, String text) {
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _pair(BuildContext context, AppServices s) async {
    if (!controller.tailnet.isOk) {
      _say(context, SessionStrings.pairNeedsTailscale);
      return;
    }
    final host = await Navigator.of(context).push<PairedHost>(
      MaterialPageRoute(
        builder: (_) =>
            PairScreen(controller: controller, services: s, info: info),
      ),
    );
    if (host != null && context.mounted) {
      _say(context, SessionStrings.paired(host.displayName));
    }
  }

  void _connect(BuildContext context, AppServices s, PairedHost host) {
    // Every session first passes the gate: Tailscale is up and WebRTC was
    // seen to use only this phone's Tailscale addresses.
    final refusal = controller.sessionRefusalCode;
    if (refusal != null) {
      _say(context, SessionStrings.cannotConnect(refusal));
      return;
    }
    unawaited(
      Navigator.of(context).push<void>(
        MaterialPageRoute(
          builder: (_) => SessionScreen(
            host: host,
            controller: controller,
            services: s,
            info: info,
          ),
        ),
      ),
    );
  }

  Future<void> _details(
    BuildContext context,
    AppServices s,
    PairedHost host,
  ) async {
    final remove = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(host.displayName),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            if (host.dnsName.isNotEmpty) Text(host.dnsName),
            Text(host.addresses.join('\n')),
            const SizedBox(height: 12),
            const Text('Identity (compare with Settings on the computer):'),
            SelectableText(
              host.fingerprintText,
              key: const Key('host-fingerprint'),
              style: const TextStyle(fontFamily: 'monospace'),
            ),
          ],
        ),
        actions: [
          TextButton(
            key: const Key('host-remove'),
            onPressed: () => Navigator.pop(context, true),
            child: const Text(SessionStrings.remove),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Close'),
          ),
        ],
      ),
    );
    if (remove == true) await s.hosts.remove(host.hostId);
  }
}
