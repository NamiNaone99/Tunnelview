import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/app/connectivity.dart';
import 'package:tunnelview_mobile/app/quiet_errors.dart';
import 'package:tunnelview_mobile/main.dart';
import 'package:tunnelview_mobile/ui/home_screen.dart';

import 'support/fake_tailnet.dart';

void main() {
  group('no deep links', () {
    late FakeTailnetPlatform platform;
    late ConnectivityController controller;

    setUp(() {
      platform = FakeTailnetPlatform(snap([wifi()], at: 0));
      controller = ConnectivityController(
        platform: platform,
        gatherer: FakeGatherer(ownCandidates()),
      );
    });

    tearDown(() async {
      controller.dispose();
      await platform.close();
    });

    Future<void> navigation(WidgetTester tester, MethodCall call) async {
      await tester.binding.defaultBinaryMessenger.handlePlatformMessage(
        SystemChannels.navigation.name,
        SystemChannels.navigation.codec.encodeMethodCall(call),
        (_) {},
      );
      await tester.pumpAndSettle();
    }

    final homes = find.byType(HomeScreen, skipOffstage: false);

    testWidgets('the initial route from the platform is ignored', (
      tester,
    ) async {
      tester.platformDispatcher.defaultRouteNameTestValue = '/pair/1/AAAA';
      addTearDown(tester.platformDispatcher.clearDefaultRouteNameTestValue);
      await tester.pumpWidget(TunnelviewApp(controller: controller));
      await tester.pumpAndSettle();
      expect(homes, findsOneWidget);
    });

    testWidgets('routes pushed by the platform are ignored', (tester) async {
      await tester.pumpWidget(TunnelviewApp(controller: controller));
      await tester.pumpAndSettle();
      await navigation(
        tester,
        const MethodCall('pushRouteInformation', <String, Object?>{
          'location': '/',
          'state': null,
        }),
      );
      await navigation(
        tester,
        const MethodCall('pushRouteInformation', <String, Object?>{
          'location': 'tunnelview://pair/1/AAAA',
          'state': null,
        }),
      );
      await navigation(tester, const MethodCall('pushRoute', '/pair'));
      expect(homes, findsOneWidget);
    });
  });

  group('quiet error handlers', () {
    late FlutterExceptionHandler? savedOnError;
    late FlutterExceptionHandler savedPresent;
    late bool Function(Object, StackTrace)? savedPlatform;
    late DebugPrintCallback savedPrint;
    late List<String?> printed;
    late List<FlutterErrorDetails> presented;

    setUp(() {
      savedOnError = FlutterError.onError;
      savedPresent = FlutterError.presentError;
      savedPlatform = PlatformDispatcher.instance.onError;
      savedPrint = debugPrint;
      printed = [];
      presented = [];
      debugPrint = (String? message, {int? wrapWidth}) => printed.add(message);
      // Flutter's default presenter prints the error text to the log.
      FlutterError.presentError = presented.add;
    });

    tearDown(() {
      debugPrint = savedPrint;
      FlutterError.presentError = savedPresent;
      FlutterError.onError = savedOnError;
      PlatformDispatcher.instance.onError = savedPlatform;
    });

    // The text of a socket error names the peer.
    final error = StateError('connect failed, address = 100.101.12.7');

    test('release: nothing is presented or printed; async errors handled', () {
      installQuietErrorHandlers(release: true);
      FlutterError.onError!(FlutterErrorDetails(exception: error));
      expect(presented, isEmpty);
      expect(printed, isEmpty);
      expect(
        PlatformDispatcher.instance.onError!(error, StackTrace.empty),
        isTrue,
      );
    });

    test('development: Flutter reports errors as usual', () {
      installQuietErrorHandlers(release: false);
      FlutterError.onError!(FlutterErrorDetails(exception: error));
      expect(presented, hasLength(1));
      expect(
        PlatformDispatcher.instance.onError!(error, StackTrace.empty),
        isFalse,
      );
    });
  });
}
