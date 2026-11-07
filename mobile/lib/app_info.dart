/// Build facts that CI passes with --dart-define (.github/workflows/android.yml):
/// TUNNELVIEW_CHANNEL (dev | release), TUNNELVIEW_VERSION (package.json
/// version) and TUNNELVIEW_BUILD (the Android versionCode).
library;

/// Which key signed this build and which application ID it uses.
enum BuildChannel {
  /// Branch builds: dev key, application ID suffix ".dev", "Tunnelview Dev".
  dev,

  /// Tag builds: release key.
  release,
}

/// Parses a channel name. Anything except exactly "release" is [BuildChannel.dev],
/// so a mistyped value can never make a build claim to be a release.
BuildChannel parseChannel(String raw) =>
    raw == 'release' ? BuildChannel.release : BuildChannel.dev;

/// Version, build number and channel of this build.
class AppInfo {
  const AppInfo({
    required this.version,
    required this.build,
    required this.channel,
  });

  /// This build, from the --dart-define values.
  static final AppInfo current = AppInfo(
    version: const String.fromEnvironment(
      'TUNNELVIEW_VERSION',
      defaultValue: '0.0.0',
    ),
    build: const String.fromEnvironment('TUNNELVIEW_BUILD', defaultValue: '0'),
    channel: parseChannel(
      const String.fromEnvironment('TUNNELVIEW_CHANNEL', defaultValue: 'dev'),
    ),
  );

  final String version;
  final String build;
  final BuildChannel channel;

  /// The name shown to the user: "Tunnelview" or "Tunnelview Dev".
  String get appName =>
      channel == BuildChannel.release ? 'Tunnelview' : 'Tunnelview Dev';

  /// For example "0.3.0 (build 300)".
  String get versionLabel => '$version (build $build)';
}
