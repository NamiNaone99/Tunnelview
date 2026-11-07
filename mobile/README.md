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
  `scripts/check-apk.js` (permissions, exported components, intent filters, `<queries>`,
  runtime classpath allow-list, `pubspec.lock` allow-list, banned packages in R8's mapping,
  16 KB zip alignment). No secrets in this job.
- `sign-dev` (branch pushes): signs with the dev key, application ID
  `io.github.naminaone99.tunnelview.dev`, label "Tunnelview Dev".
- `sign-release` (tags `v*`, environment `release`): signs with the release key.

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
- A new tailnet network within 3 s of losing the old one is reported as "VPN re-established".
- At every start, once Tailscale is found, a local ICE gathering self-test runs (no ICE servers,
  nothing sent). Sessions are refused unless every candidate is one of the phone's own Tailscale
  addresses. Diagnostics shows the result; Copy report leaves out other devices' addresses.
- `lib/platform/tailnet_platform.dart` is the platform-neutral contract, so an iOS Swift twin can
  serve the same channel later.
