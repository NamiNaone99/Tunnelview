# Tunnelview mobile (viewer)

The phone app views and controls a Windows or Mac computer running Tunnelview, **inside your
Tailscale tailnet only**. It is a viewer: it never shares the phone's screen and never listens
for connections. Android first; iOS builds from the same code later.

Status: milestone M2 (Tailscale detection). The home screen shows the Tailscale pill and Open
Tailscale; Diagnostics shows what the phone sees and runs the WebRTC self-test. Pairing and
connecting come in later milestones.

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
