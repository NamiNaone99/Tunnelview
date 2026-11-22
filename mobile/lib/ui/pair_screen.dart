import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_zxing/flutter_zxing.dart';

import '../app/connectivity.dart';
import '../app/services.dart';
import '../app_info.dart';
import '../session/hosts.dart';
import '../session/pair_flow.dart';
import 'session_strings.dart';

/// Builds the camera view that reports scanned text. Tests replace it.
typedef ScannerBuilder = Widget Function(
  BuildContext context,
  void Function(String text) onText,
);

Widget _zxingScanner(BuildContext context, void Function(String) onText) =>
    ReaderWidget(
      codeFormat: Format.qrCode,
      showGallery: false,
      showToggleCamera: false,
      tryHarder: true,
      onScan: (code) {
        final text = code.text;
        if (code.isValid && text != null) onText(text);
      },
    );

/// Pair a computer: scan the QR code its "Pair a phone" dialog shows, or
/// paste the link. Pops with the new [PairedHost] on success.
///
/// The camera starts only when the user taps Scan, which is also when
/// Android asks for the camera permission. Scanning is offline (zxing).
class PairScreen extends StatefulWidget {
  const PairScreen({
    super.key,
    required this.controller,
    required this.services,
    required this.info,
    this.scannerBuilder = _zxingScanner,
  });

  final ConnectivityController controller;
  final AppServices services;
  final AppInfo info;
  final ScannerBuilder scannerBuilder;

  @override
  State<PairScreen> createState() => _PairScreenState();
}

class _PairScreenState extends State<PairScreen> {
  final TextEditingController _link = TextEditingController();
  bool _scanning = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _link.dispose();
    super.dispose();
  }

  Future<void> _pair(String text) async {
    if (_busy) return;
    final controller = widget.controller;
    if (!controller.tailnet.isOk) {
      setState(() => _error = SessionStrings.pairNeedsTailscale);
      return;
    }
    setState(() {
      _busy = true;
      _scanning = false;
      _error = null;
    });
    final services = widget.services;
    try {
      final link = readPairLink(text, services.now());
      final host = await pairWithLink(
        link,
        transport: services.transport,
        selfAddrs: controller.tailnet.selfAddrs,
        deviceName: controller.deviceName.isEmpty
            ? 'Android phone'
            : controller.deviceName,
        appVersion: widget.info.version,
        now: services.now,
      );
      await services.hosts.save(host);
      if (mounted) Navigator.of(context).pop(host);
    } on PairFailure catch (e) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = SessionStrings.pairFailure(e.reason);
        });
      }
    } catch (_) {
      if (mounted) {
        setState(() {
          _busy = false;
          _error = SessionStrings.pairFailure('network');
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Pair a computer')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            const Text(SessionStrings.pairHint),
            const SizedBox(height: 16),
            if (_busy)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 32),
                child: Column(
                  children: [
                    CircularProgressIndicator(),
                    SizedBox(height: 16),
                    Text(SessionStrings.pairing, key: Key('pairing')),
                  ],
                ),
              )
            else ...[
              if (_scanning)
                ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: AspectRatio(
                    aspectRatio: 1,
                    child: widget.scannerBuilder(
                      context,
                      (text) => unawaited(_pair(text)),
                    ),
                  ),
                )
              else
                FilledButton.icon(
                  key: const Key('scan-code'),
                  onPressed: () => setState(() {
                    _scanning = true;
                    _error = null;
                  }),
                  icon: const Icon(Icons.qr_code_scanner),
                  label: const Text(SessionStrings.scanCode),
                ),
              const SizedBox(height: 24),
              TextField(
                key: const Key('pair-link'),
                controller: _link,
                autocorrect: false,
                enableSuggestions: false,
                keyboardType: TextInputType.url,
                minLines: 1,
                maxLines: 4,
                decoration: const InputDecoration(
                  labelText: SessionStrings.pasteLink,
                  hintText: 'tunnelview://pair/1/…',
                  border: OutlineInputBorder(),
                ),
              ),
              const SizedBox(height: 8),
              Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton(
                  key: const Key('pair-with-link'),
                  onPressed: () => unawaited(_pair(_link.text)),
                  child: const Text(SessionStrings.pair),
                ),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: 16),
              Text(
                _error!,
                key: const Key('pair-error'),
                style: TextStyle(color: theme.colorScheme.error),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
