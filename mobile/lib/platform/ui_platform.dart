/// Clipboard writes marked sensitive (security.md §8.4). Android implements
/// the channel in Kotlin (`UiPlugin.kt`).
library;

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

/// Method channel of the native UI helpers.
const String uiMethodChannel = 'io.github.naminaone99.tunnelview/ui';

const MethodChannel _channel = MethodChannel(uiMethodChannel);

/// Copies [text] to the clipboard. True on success.
///
/// On Android the clip is marked sensitive (`ClipDescription.EXTRA_IS_SENSITIVE`):
/// Android 13+ hides the copy preview, and keyboards that honour the flag
/// keep it out of their clipboard history. Flutter's `Clipboard.setData`
/// cannot set the flag, so Android never uses it: if the native call fails,
/// nothing is copied.
Future<bool> copySensitiveText(
  String text, {
  String label = 'Tunnelview',
}) async {
  if (defaultTargetPlatform == TargetPlatform.android) {
    try {
      final ok = await _channel.invokeMethod<bool>('copySensitive', {
        'label': label,
        'text': text,
      });
      return ok ?? false;
    } on PlatformException {
      return false;
    } on MissingPluginException {
      return false;
    }
  }
  // iOS has no native helper yet (the iOS app is only compile-checked).
  await Clipboard.setData(ClipboardData(text: text));
  return true;
}

/// Keeps the screen on while a remote session is shown ([on] true), or lets
/// it time out again. A window flag on Android: no permission is involved.
/// False when the platform has no helper.
Future<bool> keepScreenOn(bool on) async {
  if (defaultTargetPlatform != TargetPlatform.android) return false;
  try {
    return await _channel.invokeMethod<bool>('keepScreenOn', {'on': on}) ??
        false;
  } on PlatformException {
    return false;
  } on MissingPluginException {
    return false;
  }
}

/// The Unicode NFC form of [text] (a typed password): the desktop hashes the
/// NFC form, and Dart has no normaliser of its own. Android normalises it in
/// this process (`java.text.Normalizer`); nothing is stored or logged. Where
/// there is no helper, or it fails, [text] comes back unchanged (keyboards
/// produce NFC for almost everything).
Future<String> normalizeNfc(String text) async {
  if (defaultTargetPlatform != TargetPlatform.android) return text;
  try {
    return await _channel.invokeMethod<String>('nfc', {'text': text}) ?? text;
  } on PlatformException {
    return text;
  } on MissingPluginException {
    return text;
  }
}
