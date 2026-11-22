# Tunnelview mobile (viewer)

The phone app views and controls a Windows or Mac computer running Tunnelview, **inside your
Tailscale tailnet only**. It is a viewer: it never shares the phone's screen and never listens
for connections. Android first; iOS builds from the same code later.

Status: pairing, viewing and control are implemented. The signaling side (upgrade, signed hello,
pairing, password, signal relay) is tested against the desktop's real `HostServer` over loopback.
**The app has not been run on a real phone yet**, so the camera, the keyboard, the picture and
touch control are untried on a device. Not there yet: clipboard sync, file transfer, chat, a
biometric prompt before auto-accepted sessions.

## Using it

1. On the computer (Tunnelview 0.3 or later): open Tunnelview and choose *Pair a phone*. It shows a
   QR code for 2 minutes.
2. On the phone, with Tailscale connected: *Pair a computer*, then scan the code (or paste the
   link). The computer appears in the list; *Details* shows its identity fingerprint, the same
   one as in the computer's Settings.
3. Tap the computer. Someone there allows the session, or you type its password. Pairing admits
   nothing by itself: every session goes through the computer's own rules.
4. In the session: tap = click, two quick taps = double click, touch and hold = right click, drag =
   drag with the left button, two fingers = scroll (or move the picture while it is zoomed, or
   while the keyboard covers part of it), pinch = zoom. Touches on the black bars around the
   picture do nothing. The keyboard button opens the phone's keyboard with a row of extra keys
   (Esc, Tab, Ctrl, Alt, arrows, F1-F12); the menu has key combinations, the display and the
   quality.

## How a session is protected (`lib/proto`, `lib/session`)

- The phone only dials the Tailscale addresses stored when it paired, as IP literals (no DNS), and
  only after the Tailscale check and the WebRTC self-test passed (`session_gate.dart`; the
  session asks again before it dials and before WebRTC starts).
- The signaling socket is bound to the phone's own Tailscale address of the dialed family before
  it connects (`transport.dart`). dart:io cannot report an outgoing socket's local address
  (`Socket.address` is the destination), so the address is bound instead of read back; the OS
  refuses the bind unless the address is on this device. The process is also bound to the
  Tailscale network (below).
- Every connection carries a fresh client nonce. Before the phone sends anything, the computer's
  hello must be signed by the identity key pinned at pairing, for this connection, this host ID
  and this phone's node ID (`link.dart`, `pairing.dart` `verifyIdent`).
- Password proofs are bound to the two node IDs the computer signed; the password never leaves the
  phone. KDF parameters from the hello are validated before scrypt runs (`auth.dart`). The
  password is normalised to Unicode NFC first, as on the desktop (Android's `Normalizer`).
- ICE candidates outside the tailnet are dropped in both directions and stripped from SDP. A
  candidate line must be plain single-space fields with a bare IP literal, because libwebrtc
  splits on single spaces and resolves anything else as a host name (stricter than the desktop).
  The selected candidate pair is checked when connected and every 5 s after; a path outside
  Tailscale ends the session (`signal.dart`, `remote_session.dart`).
- A WebSocket frame, and a message split over frames, is limited to 1 MiB (`transport.dart`).

## Tests

- `test/proto_vectors_test.dart`, `test/signal_vectors_test.dart`: the Dart ports against the
  desktop's shared vectors in `../test/vectors`.
- `test/interop_real_host_test.dart`: the app's real transport, pairing flow and session state
  machine against the desktop's real `HostServer`, which `../test/support/mobile-interop-host.js`
  runs with node on 127.0.0.1 (a fake tailnet; nothing touches the real one). It needs node and
  `npm ci` in the repository root, and is skipped without them; CI requires it
  (`TUNNELVIEW_INTEROP=required`).
- `test/transport_test.dart`: the real transport against a hand-made WebSocket server (the upgrade
  request, refusals, the size limits).
- `test/session_test.dart`, `test/screens_test.dart`, `test/input_test.dart`: the session logic,
  the screens and the touch / keyboard input against a scripted host.
- Not covered by any test: the WebRTC media path, the camera, real keyboards. Those need a device.

## Building

Everything is built by GitHub Actions (`.github/workflows/android.yml`); no local Flutter or
Android SDK is needed. Toolchain: Flutter 3.47.9 (Dart 3.13.7), JDK 17, NDK 27.3.13750724,
targetSdk 36.

- `test`: `flutter pub get --enforce-lockfile`, `dart format` check, `flutter analyze`,
  `flutter test`, plus repo gates.
- `build`: an **unsigned** universal release APK (R8 on, not debuggable), checked by
  `scripts/check-apk.js` (permissions, exported components including resource-reference
  values, intent filters, `<queries>`, no component in a separate process, no VPN service, Flutter
  deep links off on the launcher, no `android.net.VpnService` in any dex, runtime classpath
  allow-list, `pubspec.lock` allow-list, banned packages in R8's mapping, 16 KB zip alignment).
  No secrets and no caches in this job. The Flutter SDK is a hash-pinned archive (SHA-256,
  framework commit and engine hash in the workflow), and Gradle runs with strict dependency
  verification forced from `~/.gradle/gradle.properties`. Unit tests for the gates:
  `test/check-apk.test.js`.
- `sign-dev` (branch pushes): signs with the dev key, application ID
  `io.github.naminaone99.tunnelview.dev`, label "Tunnelview Dev".
- `sign-release` (tags `v*`, environment `release`): signs with the release key.
- The sign jobs sign only what `build` produced: they download the internal artifact by the ID
  `build` reported and check the APK against the SHA-256 in `build`'s job outputs. Internal
  files are named `internal-*`; `build.yml`'s release job refuses to publish them.
- Every action is pinned to a full commit SHA.

Channels: Gradle `-PtunnelviewChannel=dev|release` and `--dart-define=TUNNELVIEW_CHANNEL=...`
must agree (the Gradle build checks it).

## Supply chain

- `pubspec.lock` is committed and enforced; `pubspec-allow.txt` lists every allowed package.
- `android/gradle/verification-metadata.xml` pins the SHA-256 of every Gradle artifact. It is
  regenerated with the `mobile-bootstrap` workflow when dependencies change.
- `android/runtime-classpath-allow.txt` lists the resolved `releaseRuntimeClasspath`.
- Nothing is resolved from JitPack; `android/vendor-maven/` holds the one JitPack-only artifact.
- No analytics, crash reporting, ML Kit, Firebase or Play-services code.

## Rules for Dart code

- Only `lib/rtc/engine.dart` may import `package:flutter_webrtc` (CI gate). `main()` awaits
  `RtcEngine.initialize()` before `runApp`, so WebRTC always starts with the tunnel-only network
  mask.
- Test-only code (fakes, test policies) lives under `test/` only (CI gate). Nothing may use
  Android's VpnService API (CI gate): that would replace Tailscale as the phone's VPN.
- No printing or logging: no `print`/`debugPrint` in `lib/`, no `android.util.Log` in the
  app's Kotlin (CI gate). Release builds handle Flutter errors silently
  (`lib/app/quiet_errors.dart`), because error text such as a `SocketException` names
  addresses and logcat ends up in shared bug reports.
- No deep links: the launcher activity is exported, so any app can start it with an explicit
  Intent. `MainActivity` replaces every Intent with a plain MAIN Intent before Flutter sees it,
  `flutter_deeplinking_enabled` is false in the manifest (APK gate), and the Dart app always
  starts at home and ignores routes the platform pushes.
- Clipboard writes are marked sensitive (`UiPlugin.kt`, `ClipDescription.EXTRA_IS_SENSITIVE`):
  no preview on Android 13+, kept out of keyboard clipboard histories that honour the flag.

## Tailscale detection (M2)

- `android/app/src/main/kotlin/.../TailnetPlugin.kt` (channel
  `io.github.naminaone99.tunnelview/tailnet`) reports every network and picks the tailnet: exactly
  one VPN network with an fd7a:115c:a1e0::/48 address. A 100.64.0.0/10 address alone proves
  nothing (carrier CGNAT, Cloudflare WARP, NetBird).
- The process is bound to that network (`bindProcessToNetwork`) for its whole lifetime and rebound
  on every new network object. It is never unbound, so sockets fail instead of using Wi-Fi or
  mobile data when Tailscale goes away. A refused bind means Tunnelview is excluded from Tailscale
  (split tunnelling). Binding needs no permission, so `CHANGE_NETWORK_STATE` is not requested.
- Dart re-derives the choice with a bit-exact port of the desktop `isTailscaleAddress`
  (`lib/net/addresses.dart`) and never reports OK when the two sides disagree.
- A new tailnet network within 3 s of losing the old one (or replacing it directly) is reported
  as "VPN re-established" while it is usable, until it is lost or replaced.
- At every start, once Tailscale is found, a local ICE gathering self-test runs (no ICE servers,
  nothing sent). Sessions are refused unless every candidate is one of the phone's own Tailscale
  addresses. It runs again on its own when the phone's Tailscale addresses change (also after a
  failure, and when they changed during a run), and a failed test once more on a new tailnet
  network; never a failure again on the same network and addresses ("Run self-test again" in
  Diagnostics does that). Diagnostics shows the result; Copy report leaves out other devices'
  addresses.
- A detection fault (the Kotlin and Dart choices disagree, or the platform call fails) shows
  "Can't check Tailscale" with a card that opens Diagnostics, instead of a "Checking" that never
  ends. Sessions stay refused.
- `lib/platform/tailnet_platform.dart` is the platform-neutral contract, so an iOS Swift twin can
  serve the same channel later.
