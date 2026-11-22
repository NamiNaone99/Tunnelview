import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app/connectivity.dart';
import '../app/services.dart';
import '../app_info.dart';
import '../platform/ui_platform.dart';
import '../rtc/peer.dart';
import '../session/hosts.dart';
import '../session/remote_session.dart';
import 'key_input.dart';
import 'remote_geometry.dart';
import 'session_strings.dart';
import 'touch_input.dart';

// The height of the row of extra keys above the phone's keyboard.
const double _keysBarHeight = 48;

/// Views and controls one paired computer. The phone only ever views: it
/// never shares its own screen.
class SessionScreen extends StatefulWidget {
  const SessionScreen({
    super.key,
    required this.host,
    required this.controller,
    required this.services,
    required this.info,
  });

  final PairedHost host;
  final ConnectivityController controller;
  final AppServices services;
  final AppInfo info;

  @override
  State<SessionScreen> createState() => _SessionScreenState();
}

class _SessionScreenState extends State<SessionScreen> {
  late RemoteSession _session;
  late final TouchInput _touch;
  final FocusNode _kbFocus = FocusNode();
  final TextEditingController _kb = TextEditingController();
  final TextEditingController _password = TextEditingController();
  KeyboardBuffer _kbBuffer = KeyboardBuffer();
  bool _kbSetting = false;
  final List<String> _mods = [];
  ViewTransform _view = ViewTransform.identity;
  bool _showPassword = false;
  String? _passwordError;
  bool _immersive = false;
  bool _couldControl = false;

  String get _hostName => widget.host.displayName;

  @override
  void initState() {
    super.initState();
    _touch = TouchInput(
      send: (msg) => _session.sendInput(msg),
      onView: (view) => setState(() => _view = view),
      onLongPress: () => unawaited(HapticFeedback.mediumImpact()),
    );
    _kb.addListener(_onKeyboardEdit);
    _kbFocus.addListener(_onFocus);
    _startSession();
  }

  void _startSession() {
    final controller = widget.controller;
    _session = RemoteSession(
      host: widget.host,
      transport: widget.services.transport,
      peerFactory: widget.services.peerFactory,
      selfAddrs: controller.tailnet.selfAddrs,
      deviceName: controller.deviceName.isEmpty
          ? 'Android phone'
          : controller.deviceName,
      appVersion: widget.info.version,
      // Asked again inside the session: before it dials, and before WebRTC
      // starts.
      gate: () => controller.sessionRefusalCode,
      normalizePassword: normalizeNfc,
    )..addListener(_onSession);
    _view = ViewTransform.identity;
    _showPassword = false;
    _passwordError = null;
    _mods.clear();
    _couldControl = false;
    _kbBuffer = KeyboardBuffer();
    _setKeyboardField(_kbBuffer.sentinel);
    unawaited(_session.start());
  }

  void _reconnect() {
    // The same gate as on the home screen: Tailscale is up and WebRTC was
    // seen to use only this phone's Tailscale addresses.
    final refusal = widget.controller.sessionRefusalCode;
    if (refusal != null) {
      ScaffoldMessenger.of(context)
        ..hideCurrentSnackBar()
        ..showSnackBar(
          SnackBar(content: Text(SessionStrings.cannotConnect(refusal))),
        );
      return;
    }
    final old = _session..removeListener(_onSession);
    setState(_startSession);
    old.dispose();
  }

  void _onSession() {
    if (!mounted) return;
    final live = _session.phase == SessionPhase.live;
    if (live != _immersive) {
      _immersive = live;
      unawaited(
        SystemChrome.setEnabledSystemUIMode(
          live ? SystemUiMode.immersiveSticky : SystemUiMode.edgeToEdge,
        ),
      );
      unawaited(keepScreenOn(live));
    }
    // Touches are forgotten when the session stops being live and at the
    // moment control is lost, not on every notification: zooming and moving
    // the picture must keep working in a view-only session.
    final can = live && _session.canControl;
    if (!live) {
      _touch.reset();
      if (_kbFocus.hasFocus) _kbFocus.unfocus();
    } else if (_couldControl && !can) {
      _touch.reset();
    }
    _couldControl = can;
    if (_session.phase == SessionPhase.password && _session.remaining != null) {
      _passwordError = SessionStrings.passwordError(
        'wrong',
        _session.remaining,
      );
    }
    setState(() {});
  }

  void _onFocus() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _session
      ..removeListener(_onSession)
      ..dispose();
    _touch.dispose();
    _kb.dispose();
    _kbFocus.dispose();
    _password.dispose();
    if (_immersive) {
      unawaited(SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge));
      unawaited(keepScreenOn(false));
    }
    super.dispose();
  }

  // ---- keyboard ----

  // Sets the hidden field without treating it as typing.
  void _setKeyboardField(String text) {
    _kbSetting = true;
    _kb.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    _kbSetting = false;
  }

  void _onKeyboardEdit() {
    if (_kbSetting) return;
    final value = _kb.value;
    final composing = value.composing.isValid && !value.composing.isCollapsed;
    final edit = _kbBuffer.edit(
      value.text,
      composing: composing,
      modifiers: _mods,
    );
    for (final msg in edit.messages) {
      _session.sendInput(msg);
    }
    if (edit.used && _mods.isNotEmpty) setState(_mods.clear);
    final resetTo = edit.resetTo;
    if (resetTo != null) {
      _setKeyboardField(resetTo);
      return;
    }
    // The caret always stays at the end: the keyboard can move it (cursor
    // keys or gestures), and typing in the middle of the buffer would turn
    // into deletions on the computer.
    final end = value.text.length;
    final selection = value.selection;
    if (!composing &&
        selection.isValid &&
        (selection.baseOffset != end || selection.extentOffset != end)) {
      _kbSetting = true;
      _kb.selection = TextSelection.collapsed(offset: end);
      _kbSetting = false;
    }
  }

  void _toggleKeyboard() {
    final shown = MediaQuery.viewInsetsOf(context).bottom > 0;
    if (_kbFocus.hasFocus && shown) {
      _kbFocus.unfocus();
    } else if (_kbFocus.hasFocus) {
      unawaited(SystemChannels.textInput.invokeMethod<void>('TextInput.show'));
    } else {
      _kbFocus.requestFocus();
    }
  }

  void _pressKey(SpecialKey key) {
    if (key.modifier) {
      setState(() {
        if (!_mods.remove(key.code)) _mods.add(key.code);
      });
      return;
    }
    if (_mods.isNotEmpty) {
      _session.sendInput({
        't': 'combo',
        'codes': [..._mods, key.code],
      });
      setState(_mods.clear);
      return;
    }
    for (final msg in keyTap(key)) {
      _session.sendInput(msg);
    }
  }

  // ---- menus ----

  Future<void> _openMenu() async {
    final session = _session;
    final action = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            ListTile(
              leading: const Icon(Icons.keyboard),
              title: const Text(SessionStrings.keyboard),
              enabled: session.canControl,
              onTap: () => Navigator.pop(context, 'keyboard'),
            ),
            ListTile(
              leading: const Icon(Icons.keyboard_command_key),
              title: const Text(SessionStrings.keys),
              enabled: session.canControl,
              onTap: () => Navigator.pop(context, 'keys'),
            ),
            if (session.displays.length > 1)
              ListTile(
                leading: const Icon(Icons.monitor),
                title: const Text(SessionStrings.display),
                onTap: () => Navigator.pop(context, 'display'),
              ),
            ListTile(
              leading: const Icon(Icons.tune),
              title: const Text(SessionStrings.quality),
              subtitle: Text(SessionStrings.qualityLabel(session.quality)),
              onTap: () => Navigator.pop(context, 'quality'),
            ),
            if (_view.isZoomed)
              ListTile(
                leading: const Icon(Icons.zoom_out_map),
                title: const Text(SessionStrings.resetZoom),
                onTap: () => Navigator.pop(context, 'zoom'),
              ),
            ListTile(
              key: const Key('menu-disconnect'),
              leading: const Icon(Icons.close),
              title: const Text(SessionStrings.disconnect),
              onTap: () => Navigator.pop(context, 'disconnect'),
            ),
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 8, 16, 16),
              child: Text(SessionStrings.gestureHelp),
            ),
          ],
        ),
      ),
    );
    if (!mounted) return;
    switch (action) {
      case 'keyboard':
        _toggleKeyboard();
      case 'keys':
        await _pick<KeyCombo>(
          combosFor(session.hello?.os ?? widget.host.os),
          (c) => c.label,
          (c) => session.sendInput({'t': 'combo', 'codes': c.codes}),
        );
      case 'display':
        await _pick(
          session.displays,
          (d) => d.width > 0 ? '${d.name} (${d.width} × ${d.height})' : d.name,
          (d) => session.selectDisplay(d.id),
          selected: (d) => d.id == session.currentDisplay,
        );
      case 'quality':
        await _pick<String>(
          qualityPresets,
          SessionStrings.qualityLabel,
          session.setQuality,
          selected: (p) => p == session.quality,
        );
      case 'zoom':
        setState(() => _view = ViewTransform.identity);
      case 'disconnect':
        session.close();
    }
  }

  Future<void> _pick<T>(
    List<T> items,
    String Function(T) label,
    void Function(T) onPick, {
    bool Function(T)? selected,
  }) async {
    final picked = await showModalBottomSheet<T>(
      context: context,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          children: [
            for (final item in items)
              ListTile(
                title: Text(label(item)),
                trailing: selected != null && selected(item)
                    ? const Icon(Icons.check)
                    : null,
                onTap: () => Navigator.pop(context, item),
              ),
          ],
        ),
      ),
    );
    if (picked != null) onPick(picked);
  }

  Future<void> _submitPassword() async {
    final text = _password.text;
    _password.clear();
    setState(() => _passwordError = null);
    final error = await _session.submitPassword(text);
    if (mounted && error != null) {
      setState(
        () => _passwordError = SessionStrings.passwordError(error, null),
      );
    }
  }

  Future<void> _onBack() async {
    if (_session.phase != SessionPhase.live) {
      Navigator.of(context).pop();
      return;
    }
    final leave = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Disconnect from $_hostName?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text(SessionStrings.cancel),
          ),
          FilledButton(
            key: const Key('confirm-disconnect'),
            onPressed: () => Navigator.pop(context, true),
            child: const Text(SessionStrings.disconnect),
          ),
        ],
      ),
    );
    if (leave == true && mounted) Navigator.of(context).pop();
  }

  // ---- build ----

  @override
  Widget build(BuildContext context) {
    final live = _session.phase == SessionPhase.live;
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_onBack());
      },
      child: Scaffold(
        // The keyboard must never refit the remote screen.
        resizeToAvoidBottomInset: false,
        backgroundColor: live ? Colors.black : null,
        appBar: live ? null : AppBar(title: Text(_hostName)),
        body: live ? _buildLive(context) : SafeArea(child: _buildStatus()),
      ),
    );
  }

  Widget _buildStatus() {
    final session = _session;
    final theme = Theme.of(context);
    final children = <Widget>[];
    switch (session.phase) {
      case SessionPhase.connecting:
        children.addAll(const [
          Center(child: CircularProgressIndicator()),
          SizedBox(height: 16),
          Center(child: Text(SessionStrings.connecting)),
        ]);
      case SessionPhase.waiting:
        final canUsePassword =
            session.passwordSet &&
            !(session.hello?.autoAccept ?? false) &&
            !(session.hello?.passwordLocked ?? false);
        children.addAll([
          const Center(child: CircularProgressIndicator()),
          const SizedBox(height: 16),
          Text(
            SessionStrings.waiting(_hostName),
            key: const Key('session-waiting'),
            textAlign: TextAlign.center,
          ),
          if (canUsePassword && !_showPassword) ...[
            const SizedBox(height: 16),
            Center(
              child: TextButton(
                key: const Key('use-password'),
                onPressed: () => setState(() => _showPassword = true),
                child: const Text(SessionStrings.usePassword),
              ),
            ),
          ],
          if (canUsePassword && _showPassword) ..._passwordFields(),
        ]);
      case SessionPhase.password:
        children.addAll([
          Text(
            '$_hostName asks for its password.',
            style: theme.textTheme.titleMedium,
          ),
          ..._passwordFields(),
        ]);
      case SessionPhase.closed:
        final reason = session.closeReason!;
        final text = SessionStrings.closeText(
          reason.reason,
          host: _hostName,
          retryAfterSec: reason.retryAfterSec,
          hostReason: reason.hostReason,
        );
        children.addAll([
          Text(
            text.title,
            key: const Key('closed-title'),
            style: theme.textTheme.headlineSmall,
          ),
          const SizedBox(height: 8),
          Text(text.message),
          const SizedBox(height: 24),
          Wrap(
            spacing: 12,
            children: [
              FilledButton(
                key: const Key('reconnect'),
                onPressed: _reconnect,
                child: const Text(SessionStrings.reconnect),
              ),
              OutlinedButton(
                key: const Key('closed-back'),
                onPressed: () => Navigator.of(context).pop(),
                child: const Text(SessionStrings.back),
              ),
            ],
          ),
        ]);
      case SessionPhase.live:
        break;
    }
    return ListView(padding: const EdgeInsets.all(24), children: children);
  }

  List<Widget> _passwordFields() => [
    const SizedBox(height: 16),
    TextField(
      key: const Key('session-password'),
      controller: _password,
      obscureText: true,
      autocorrect: false,
      enableSuggestions: false,
      enabled: !_session.computing,
      onSubmitted: (_) => unawaited(_submitPassword()),
      decoration: InputDecoration(
        labelText: SessionStrings.password,
        border: const OutlineInputBorder(),
        errorText: _passwordError,
        errorMaxLines: 3,
      ),
    ),
    const SizedBox(height: 12),
    Align(
      alignment: Alignment.centerLeft,
      child: FilledButton(
        key: const Key('submit-password'),
        onPressed: _session.computing
            ? null
            : () => unawaited(_submitPassword()),
        child: const Text(SessionStrings.connect),
      ),
    ),
  ];

  Widget _buildLive(BuildContext context) {
    final session = _session;
    final peer = session.peer;
    final insets = MediaQuery.viewInsetsOf(context);
    final padding = MediaQuery.paddingOf(context);
    final banner = SessionStrings.controlBlock(
      session.controlBlock,
      session.inputBlocked,
    );
    final keysShown = _kbFocus.hasFocus && session.canControl;
    // What the keyboard and the extra keys cover. The picture is not refitted
    // for it; it can be moved up by this much instead.
    final covered = insets.bottom > 0
        ? insets.bottom + (keysShown ? _keysBarHeight : 0)
        : 0.0;
    return Stack(
      fit: StackFit.expand,
      children: [
        if (peer != null)
          _RemoteView(
            peer: peer,
            touch: _touch,
            view: _view,
            bottomInset: covered,
          ),
        if (peer == null || !session.hasPicture)
          const Center(
            child: Text(
              SessionStrings.startingPicture,
              style: TextStyle(color: Colors.white70),
            ),
          ),
        // The hidden field the phone's keyboard types into.
        Positioned(
          left: 0,
          top: 0,
          width: 1,
          height: 1,
          child: Opacity(
            opacity: 0,
            child: TextField(
              key: const Key('remote-keyboard'),
              controller: _kb,
              focusNode: _kbFocus,
              autocorrect: false,
              // Suggestions stay ON: Flutter turns "no suggestions" into a
              // visible-password field on Android, and keyboards offer only
              // Latin layouts there, so Thai (or any other script) could not
              // be typed. Words being composed are followed edit by edit.
              // ignore: avoid_redundant_argument_values
              enableSuggestions: true,
              // Never offered to autofill, which replaces the whole text.
              autofillHints: null,
              enableInteractiveSelection: false,
              keyboardType: TextInputType.multiline,
              textInputAction: TextInputAction.newline,
              maxLines: null,
              showCursor: false,
            ),
          ),
        ),
        if (banner != null)
          Positioned(
            top: padding.top + 8,
            left: 64,
            right: 64,
            child: Center(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  color: Colors.black87,
                  borderRadius: BorderRadius.circular(16),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 6,
                  ),
                  child: Text(
                    banner,
                    key: const Key('control-banner'),
                    textAlign: TextAlign.center,
                    style: const TextStyle(color: Colors.white, fontSize: 13),
                  ),
                ),
              ),
            ),
          ),
        Positioned(
          top: padding.top + 4,
          right: padding.right + 4,
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (session.canControl)
                _RoundButton(
                  key: const Key('toggle-keyboard'),
                  tooltip: SessionStrings.keyboard,
                  icon: Icons.keyboard,
                  onPressed: _toggleKeyboard,
                ),
              _RoundButton(
                key: const Key('session-menu'),
                tooltip: SessionStrings.menu,
                icon: Icons.more_vert,
                onPressed: () => unawaited(_openMenu()),
              ),
            ],
          ),
        ),
        if (keysShown)
          Positioned(
            left: 0,
            right: 0,
            bottom: insets.bottom,
            child: _KeysBar(
              keys: specialKeysFor(session.hello?.os ?? widget.host.os),
              latched: _mods,
              onKey: _pressKey,
            ),
          ),
      ],
    );
  }
}

/// The remote picture with the touch layer on top.
class _RemoteView extends StatelessWidget {
  const _RemoteView({
    required this.peer,
    required this.touch,
    required this.view,
    required this.bottomInset,
  });

  final ViewerPeer peer;
  final TouchInput touch;
  final ViewTransform view;

  /// How much of the bottom the keyboard covers.
  final double bottomInset;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) => ListenableBuilder(
        listenable: peer.videoChanges,
        builder: (context, _) {
          final viewport = constraints.biggest;
          final fit = fitRect(viewport, peer.videoSize);
          final v = view.clamped(viewport, bottomInset: bottomInset, fit: fit);
          touch
            ..viewport = viewport
            ..fit = fit
            ..bottomInset = bottomInset
            ..view = v;
          final rect = fit.isEmpty
              ? Offset.zero & viewport
              : Rect.fromLTWH(
                  fit.left * v.scale + v.offset.dx,
                  fit.top * v.scale + v.offset.dy,
                  fit.width * v.scale,
                  fit.height * v.scale,
                );
          return Listener(
            key: const Key('remote-view'),
            behavior: HitTestBehavior.opaque,
            onPointerDown: (e) => touch.down(e.pointer, e.localPosition),
            onPointerMove: (e) => touch.move(e.pointer, e.localPosition),
            onPointerUp: (e) => touch.up(e.pointer, e.localPosition),
            onPointerCancel: (e) => touch.cancel(e.pointer),
            child: ClipRect(
              child: Stack(
                children: [
                  Positioned.fromRect(rect: rect, child: peer.buildVideo()),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({
    super.key,
    required this.tooltip,
    required this.icon,
    required this.onPressed,
  });

  final String tooltip;
  final IconData icon;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.all(4),
    child: IconButton(
      tooltip: tooltip,
      onPressed: onPressed,
      icon: Icon(icon),
      style: IconButton.styleFrom(
        backgroundColor: Colors.black54,
        foregroundColor: Colors.white,
      ),
    ),
  );
}

/// The row of extra keys above the phone's keyboard.
class _KeysBar extends StatelessWidget {
  const _KeysBar({
    required this.keys,
    required this.latched,
    required this.onKey,
  });

  final List<SpecialKey> keys;
  final List<String> latched;
  final void Function(SpecialKey key) onKey;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.surfaceContainerHigh,
      child: SizedBox(
        height: _keysBarHeight,
        child: ListView(
          key: const Key('keys-bar'),
          scrollDirection: Axis.horizontal,
          padding: const EdgeInsets.symmetric(horizontal: 4),
          children: [
            for (final key in keys)
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 6),
                child: TextButton(
                  key: Key('key-${key.code}'),
                  onPressed: () => onKey(key),
                  style: TextButton.styleFrom(
                    minimumSize: const Size(44, 36),
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    backgroundColor: latched.contains(key.code)
                        ? scheme.primary
                        : scheme.surface,
                    foregroundColor: latched.contains(key.code)
                        ? scheme.onPrimary
                        : scheme.onSurface,
                  ),
                  child: Text(key.label),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
