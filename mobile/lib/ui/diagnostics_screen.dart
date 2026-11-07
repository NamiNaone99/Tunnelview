import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app/connectivity.dart';
import '../app_info.dart';
import '../diagnostics/report.dart';
import '../platform/tailnet.dart';
import '../rtc/engine.dart';
import '../rtc/self_test.dart';
import 'strings.dart';
import 'tailscale_pill.dart';

/// The WebRTC engine state in one line.
String webrtcStatusText() {
  final rtc = RtcEngine.result;
  if (rtc == null) return 'not started';
  return rtc.ok ? 'ready, tunnel-only network mask applied' : '${rtc.error}';
}

/// Diagnostics: the Tailscale network the phone found, its own tunnel
/// addresses, the process binding, the route mode and the local ICE
/// gathering self-test. Everything stays on the phone unless the user copies
/// the report.
class DiagnosticsScreen extends StatelessWidget {
  const DiagnosticsScreen({
    super.key,
    required this.controller,
    this.info,
    this.now,
  });

  final ConnectivityController controller;
  final AppInfo? info;

  /// The clock for the report (tests).
  final DateTime Function()? now;

  @override
  Widget build(BuildContext context) {
    return ListenableBuilder(
      listenable: controller,
      builder: (context, _) => _build(context),
    );
  }

  String _report() => buildDiagnosticsReport(
    app: info ?? AppInfo.current,
    state: controller.tailnet,
    changes: controller.monitor.changes,
    selfTest: controller.selfTest,
    webrtc: webrtcStatusText(),
    deviceName: controller.deviceName,
    now: (now ?? DateTime.now)(),
  );

  Future<void> _copy(BuildContext context) async {
    final messenger = ScaffoldMessenger.of(context);
    await Clipboard.setData(ClipboardData(text: _report()));
    messenger.showSnackBar(const SnackBar(content: Text(Strings.reportCopied)));
  }

  Widget _build(BuildContext context) {
    final theme = Theme.of(context);
    final state = controller.tailnet;
    final snap = state.snapshot;
    final network = state.network;
    final selfTest = controller.selfTest;
    final running = controller.selfTestRunning;
    return Scaffold(
      resizeToAvoidBottomInset: false,
      appBar: AppBar(
        title: const Text(Strings.diagnostics),
        actions: [
          IconButton(
            key: const Key('copy-report'),
            tooltip: Strings.copyReport,
            icon: const Icon(Icons.copy_all_outlined),
            onPressed: () => _copy(context),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const _Section('Tailscale'),
            Align(
              alignment: Alignment.centerLeft,
              child: TailscalePill(state: state),
            ),
            const SizedBox(height: 8),
            _Row('State', '${state.status.name} (${state.reason})'),
            _Row(
              'Sessions',
              Strings.sessionRefusal(controller.sessionRefusalCode),
              key: const Key('diag-sessions'),
            ),
            if (network != null) ...[
              _Row(
                'Chosen network',
                'handle ${network.handle} · '
                    '${network.interfaceName ?? '?'} · '
                    '${network.transports.join(', ')}'
                    '${network.validated ? ' · validated' : ''}',
              ),
              _Row(
                'Own Tailscale addresses',
                state.selfAddrs.isEmpty ? '(none)' : state.selfAddrs.join('\n'),
                key: const Key('diag-self-addrs'),
              ),
              _Row(
                'Route mode',
                _routeText(RouteSummary.of(network)),
                key: const Key('diag-route-mode'),
              ),
              _Row(
                'Tunnel DNS',
                network.dns.isEmpty ? '(none)' : network.dns.join(', '),
              ),
            ],
            if (snap != null)
              _Row(
                'Process binding',
                describeBinding(snap.binding, network?.handle),
                key: const Key('diag-binding'),
              ),
            if (state.vpnReestablished)
              const _Row(
                'Last change',
                'VPN re-established (Tailscale rebuilt its tunnel)',
              ),
            _Row(
              'This phone',
              controller.deviceName.isEmpty ? '?' : controller.deviceName,
            ),
            if (snap != null) ...[
              _Section('Networks (${snap.networks.length})'),
              for (final n in snap.networks) _NetworkTile(network: n),
            ],
            if (controller.monitor.changes.isNotEmpty && snap != null) ...[
              const _Section('Recent changes'),
              for (final c in controller.monitor.changes.reversed)
                Text(
                  '${((snap.at - c.at) / 1000).toStringAsFixed(1)} s ago: '
                  '${c.kind}${c.gapMs == null ? '' : ' after ${c.gapMs} ms'}'
                  ' → ${c.status.name}',
                ),
            ],
            const _Section('WebRTC'),
            _Row('Engine', webrtcStatusText()),
            if (running)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 8),
                child: LinearProgressIndicator(),
              ),
            if (selfTest == null && !running)
              const _Row(
                'Self-test',
                'Not run yet. It runs once Tailscale is found.',
                key: Key('diag-selftest'),
              ),
            if (selfTest != null) ..._selfTestRows(selfTest),
            const SizedBox(height: 16),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                FilledButton.icon(
                  key: const Key('run-selftest'),
                  onPressed: running || !state.isOk
                      ? null
                      : () => controller.runSelfTest(),
                  icon: const Icon(Icons.network_check),
                  label: const Text(Strings.runSelfTest),
                ),
                OutlinedButton.icon(
                  onPressed: () => _copy(context),
                  icon: const Icon(Icons.copy_all_outlined),
                  label: const Text(Strings.copyReport),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Text(
              'The self-test creates a WebRTC connection on this phone with '
              'no servers, lists the addresses WebRTC would use, and closes '
              'it. Nothing is sent anywhere. Copy report leaves out the '
              'addresses of other devices.',
              style: theme.textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _selfTestRows(SelfTestResult r) {
    final o = r.outcome;
    final foreign = r.foreign.toSet();
    return [
      _Row(
        'Self-test',
        Strings.selfTestVerdict(r.verdict),
        key: const Key('diag-selftest'),
      ),
      _Row(
        'Ran at',
        '${_hms(r.at)} · ${o.completed ? 'complete' : 'not complete'} in '
            '${o.elapsed.inMilliseconds} ms'
            '${o.error == null ? '' : ' · ${o.error}'}',
      ),
      _Row('Compared with', r.selfAddrs.join('\n')),
      _Row(
        'Candidates (${o.candidates.length})',
        o.candidates.isEmpty
            ? '(none)'
            : [
                for (final c in o.candidates)
                  '${c.address ?? '(none)'} ${c.port ?? '?'} '
                      '${c.protocol ?? '?'} ${c.type ?? '?'} · '
                      '${c.adapterLabel}'
                      '${foreign.contains(c) ? ' · NOT own' : ''}',
              ].join('\n'),
        key: const Key('diag-candidates'),
      ),
    ];
  }
}

String _two(int n) => n.toString().padLeft(2, '0');

String _hms(DateTime t) =>
    '${_two(t.hour)}:${_two(t.minute)}:${_two(t.second)}';

String _routeText(RouteSummary r) {
  final extra = <String>[
    if (r.tailnetV6Route) 'fd7a::/48 route',
    if (r.defaultRoute) 'default route (exit node)',
    if (r.cgnatOtherRoutes > 0) '${r.cgnatOtherRoutes} other 100.64/10 routes',
  ];
  return extra.isEmpty ? r.mode : '${r.mode} · ${extra.join(' · ')}';
}

class _Section extends StatelessWidget {
  const _Section(this.title);
  final String title;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 20, bottom: 8),
    child: Text(title, style: Theme.of(context).textTheme.titleMedium),
  );
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.value, {super.key});
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: theme.textTheme.labelMedium),
          SelectableText(value),
        ],
      ),
    );
  }
}

class _NetworkTile extends StatelessWidget {
  const _NetworkTile({required this.network});
  final NetworkEntry network;

  @override
  Widget build(BuildContext context) {
    final n = network;
    final flags = [
      n.transports.isEmpty ? 'no transport' : n.transports.join(', '),
      if (n.isVpn) 'VPN',
      if (n.isActive) 'default',
      if (n.validated) 'validated',
    ].join(' · ');
    final addrs = n.addresses.map((a) => '${a.address}/${a.prefix}');
    return _Row(
      '${n.interfaceName ?? '?'} (handle ${n.handle})',
      '$flags\n'
          '${addrs.isEmpty ? 'no addresses' : addrs.join('\n')}\n'
          '${n.routes.length} routes · ${n.dns.length} DNS servers',
    );
  }
}
