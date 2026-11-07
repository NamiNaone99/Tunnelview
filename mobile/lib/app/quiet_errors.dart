/// Release builds never write error text to the system log (PLAN §6.10: no
/// logging of IPs, tokens, nonces or proofs). By default Flutter prints every
/// framework error and every uncaught async error to logcat, even in release
/// mode, and the text of network errors carries addresses
/// (`SocketException`: "address = 100.x.y.z, port = ..."). Logcat ends up in
/// bug reports users share.
library;

import 'package:flutter/foundation.dart';

/// Installs the error handlers. With [release] (the default in a release
/// build) errors are handled silently; otherwise Flutter's usual reporting
/// stays on for development.
void installQuietErrorHandlers({bool release = kReleaseMode}) {
  FlutterError.onError = (details) {
    if (!release) FlutterError.presentError(details);
  };
  // True: handled, so the engine does not log "Unhandled Exception: ...".
  PlatformDispatcher.instance.onError = (error, stack) => release;
}
