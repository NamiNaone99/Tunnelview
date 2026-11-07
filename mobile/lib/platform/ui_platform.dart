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
