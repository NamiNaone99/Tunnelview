import 'package:flutter/material.dart';

import '../platform/tailnet_state.dart';
import 'strings.dart';

/// Colours of the pill dot (ux §4.2: green OK, grey checking, amber off or
/// another VPN, red excluded).
Color pillColor(TailnetStatus s) {
  switch (s) {
    case TailnetStatus.ok:
      return const Color(0xFF16A34A);
    case TailnetStatus.checking:
    case TailnetStatus.unsupported:
      return const Color(0xFF9CA3AF);
    case TailnetStatus.off:
    case TailnetStatus.anotherVpn:
    case TailnetStatus.several:
      return const Color(0xFFD97706);
    case TailnetStatus.excluded:
      return const Color(0xFFDC2626);
  }
}

/// The Tailscale status pill.
class TailscalePill extends StatelessWidget {
  const TailscalePill({super.key, required this.state});

  final TailnetState state;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final color = pillColor(state.status);
    final label = Strings.pill(state);
    return Semantics(
      label: 'Tailscale status: $label',
      excludeSemantics: true,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
        decoration: BoxDecoration(
          borderRadius: BorderRadius.circular(999),
          border: Border.all(color: color.withValues(alpha: 0.6)),
          color: color.withValues(alpha: 0.10),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              state.status == TailnetStatus.checking
                  ? Icons.radio_button_unchecked
                  : Icons.circle,
              size: 12,
              color: color,
            ),
            const SizedBox(width: 8),
            Flexible(
              child: Text(
                label,
                key: const Key('tailscale-pill-label'),
                style: theme.textTheme.labelLarge,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// The inline card under the pill; empty when the state needs none.
class TailscaleStatusCard extends StatelessWidget {
  const TailscaleStatusCard({
    super.key,
    required this.state,
    this.onOpenDiagnostics,
  });

  final TailnetState state;

  /// Shown as a button on cards that point to Diagnostics.
  final VoidCallback? onOpenDiagnostics;

  @override
  Widget build(BuildContext context) {
    final text = Strings.card(state);
    if (text == null) return const SizedBox.shrink();
    final theme = Theme.of(context);
    final open = onOpenDiagnostics;
    return Card(
      key: const Key('tailscale-card'),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(text.title, style: theme.textTheme.titleMedium),
            const SizedBox(height: 8),
            Text(text.message),
            if (text.pointsToDiagnostics && open != null) ...[
              const SizedBox(height: 8),
              TextButton(
                key: const Key('tailscale-card-diagnostics'),
                onPressed: open,
                child: const Text(Strings.diagnostics),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
