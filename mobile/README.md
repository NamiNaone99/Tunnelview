# Tunnelview mobile (viewer)

The phone app views and controls a Windows or Mac computer running Tunnelview, **inside your
Tailscale tailnet only**. It is a viewer: it never shares the phone's screen and never listens
for connections. Android first; iOS builds from the same code later.

Status: milestone M1 (project skeleton, hardened manifest, CI build and signing). The home screen
only shows the version and build channel.

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
