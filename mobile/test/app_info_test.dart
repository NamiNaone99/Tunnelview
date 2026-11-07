import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/app_info.dart';
import 'package:tunnelview_mobile/ui/home_screen.dart';

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

  testWidgets('home screen shows the title, version and channel', (
    tester,
  ) async {
    const info = AppInfo(
      version: '0.3.0',
      build: '300',
      channel: BuildChannel.release,
    );
    await tester.pumpWidget(const MaterialApp(home: HomeScreen(info: info)));
    expect(find.text('Tunnelview'), findsWidgets);
    expect(find.text('Version 0.3.0 (build 300)'), findsOneWidget);
    expect(find.text('Channel: release'), findsOneWidget);
    expect(find.text('WebRTC: not started'), findsOneWidget);
  });
}
