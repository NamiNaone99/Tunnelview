/// The text behind Diagnostics › Copy report (screenshots are blocked by
/// FLAG_SECURE, so this is how a user shares what the phone sees).
///
/// Privacy rule: the report contains no address of any other device. It
/// lists this phone's own Tailscale addresses and its own local ICE
/// candidates, and only counts for everything else: per-peer routes are other
/// devices' addresses, and other networks' DNS servers and gateways are
/// routers. Tokens, nonces and keys do not exist yet; they will never be
/// added here.
library;

import '../app/session_gate.dart';
import '../app_info.dart';
import '../platform/tailnet.dart';
import '../rtc/self_test.dart';
import '../ui/strings.dart';

/// Builds the report.
String buildDiagnosticsReport({
  required AppInfo app,
  required TailnetState state,
  required List<TailnetChange> changes,
  required SelfTestResult? selfTest,
  required String webrtc,
  required String deviceName,
  required DateTime now,
}) {
  final b = StringBuffer()
    ..writeln('Tunnelview diagnostics report')
    ..writeln('App: ${app.appName} ${app.versionLabel}, ${app.channel.name}')
    ..writeln('Time: ${now.toUtc().toIso8601String()}')
    ..writeln('Phone: ${deviceName.isEmpty ? 'unknown' : deviceName}');
  final snap = state.snapshot;
  if (snap != null) b.writeln('Android API level: ${snap.sdk}');
  b
    ..writeln()
    ..writeln('[Tailscale]')
    ..writeln(
      'Status: ${Strings.pill(state)} (${state.status.name}, '
      '${state.reason})',
    )
    ..writeln(
      'Sessions: ${Strings.sessionRefusal(sessionRefusal(state, selfTest))}',
    );
  final n = state.network;
  if (n != null) {
    final routes = RouteSummary.of(n);
    b
      ..writeln(
        'Network: handle ${n.handle}, interface '
        '${n.interfaceName ?? '?'}, transports ${_list(n.transports)}',
      )
      ..writeln('Own Tailscale addresses: ${_list(state.selfAddrs)}')
      ..writeln('Process bound to it: ${state.bound ? 'yes' : 'no'}')
      ..writeln('Route mode: ${routes.mode}')
      ..writeln('IPv6 /48 route: ${routes.tailnetV6Route ? 'yes' : 'no'}')
      ..writeln(
        'Default route on the tunnel (exit node): '
        '${routes.defaultRoute ? 'yes' : 'no'}',
      )
      ..writeln('Routes on the tunnel: ${routes.tunRoutes}')
      ..writeln(
        'Tunnel DNS: ${_list(n.dns.where(_isQuad100).toList())}'
        '${n.dns.any((d) => !_isQuad100(d)) ? ' (+ others not shown)' : ''}',
      );
  }
  if (snap != null) {
    b.writeln(
      'Process binding: '
      '${describeBinding(snap.binding, n?.handle)}',
    );
    b.writeln('Networks seen: ${snap.networks.length}');
    for (final net in snap.networks) {
      final v4 = net.addresses.where((a) => !a.address.contains(':')).length;
      final v6 = net.addresses.length - v4;
      b.writeln(
        '  - ${net.interfaceName ?? '?'}: ${_list(net.transports)}'
        '${net.isVpn ? ', VPN' : ''}${net.isActive ? ', default' : ''}'
        '${net.validated ? ', validated' : ''}, $v4 IPv4 + $v6 IPv6 '
        'addresses, ${net.routes.length} routes',
      );
    }
  }
  if (changes.isNotEmpty && snap != null) {
    b.writeln('Recent changes:');
    for (final c in changes) {
      final ago = ((snap.at - c.at) / 1000).toStringAsFixed(1);
      final gap = c.gapMs == null ? '' : ' after ${c.gapMs} ms';
      b.writeln('  - ${ago}s ago: ${c.kind}$gap -> ${c.status.name}');
    }
  }

  b
    ..writeln()
    ..writeln('[WebRTC]')
    ..writeln('Engine: $webrtc');
  if (selfTest == null) {
    b.writeln('Self-test: not run yet');
  } else {
    final o = selfTest.outcome;
    b
      ..writeln(
        'Self-test: ${selfTest.verdict.name} at '
        '${selfTest.at.toUtc().toIso8601String()}',
      )
      ..writeln(Strings.selfTestVerdict(selfTest.verdict))
      ..writeln(
        'Gathering: ${o.completed ? 'complete' : 'not complete'} in '
        '${o.elapsed.inMilliseconds} ms${o.error == null ? '' : ', error ${o.error}'}',
      )
      ..writeln('Compared with: ${_list(selfTest.selfAddrs)}')
      ..writeln('Candidates: ${o.candidates.length}');
    final foreign = selfTest.foreign.toSet();
    for (final c in o.candidates) {
      b.writeln(
        '  - ${c.address ?? '(none)'} ${c.port ?? '?'} '
        '${c.protocol ?? '?'} ${c.type ?? '?'} adapter ${c.adapterLabel}'
        '${c.networkCost == null ? '' : ' cost ${c.networkCost}'}'
        '${foreign.contains(c) ? '  <- NOT an own Tailscale address' : ''}',
      );
    }
  }
  return b.toString();
}

bool _isQuad100(String a) =>
    a == '100.100.100.100' || a == 'fd7a:115c:a1e0::53';

String _list(List<String> items) => items.isEmpty ? '(none)' : items.join(', ');

/// The process binding in words.
String describeBinding(BindingInfo binding, int? tailnetHandle) {
  final p = binding.process;
  final where = p == null
      ? 'not bound'
      : p == tailnetHandle
      ? 'bound to the Tailscale network'
      : 'bound to another network (handle $p)';
  final last = binding.attempted == null
      ? ''
      : ', last attempt ${binding.ok == true ? 'succeeded' : 'refused'} '
            '(handle ${binding.attempted})';
  return '$where$last';
}
