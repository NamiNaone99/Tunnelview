import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/app_info.dart';

void main() {
  test('only an exact "release" is a release build', () {
    expect(parseChannel('release'), BuildChannel.release);
    expect(parseChannel('dev'), BuildChannel.dev);
    expect(parseChannel('Release'), BuildChannel.dev);
    expect(parseChannel(''), BuildChannel.dev);
  });

  test('app name follows the channel', () {
    const dev = AppInfo(
      version: '0.3.0',
      build: '7',
      channel: BuildChannel.dev,
    );
    const release = AppInfo(
      version: '0.3.0',
      build: '300',
      channel: BuildChannel.release,
    );
    expect(dev.appName, 'Tunnelview Dev');
    expect(release.appName, 'Tunnelview');
    expect(release.versionLabel, '0.3.0 (build 300)');
  });
}
