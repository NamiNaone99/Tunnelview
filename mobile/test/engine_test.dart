import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/rtc/engine.dart';

void main() {
  group('networkIgnoreMaskFor', () {
    test('Android masks every adapter type except VPN, each once', () {
      final mask = networkIgnoreMaskFor(RtcPlatform.android);
      expect(
        mask,
        unorderedEquals([
          'adapterTypeEthernet',
          'adapterTypeWifi',
          'adapterTypeCellular',
          'adapterTypeLoopback',
          'adapterTypeAny',
        ]),
      );
      expect(mask.toSet().length, mask.length);
      expect(mask, isNot(contains('adapterTypeVpn')));
    });

    test('iOS never masks ANY (it would also ignore VPN there)', () {
      final mask = networkIgnoreMaskFor(RtcPlatform.ios);
      expect(
        mask,
        unorderedEquals([
          'adapterTypeEthernet',
          'adapterTypeWifi',
          'adapterTypeCellular',
          'adapterTypeLoopback',
        ]),
      );
      expect(mask, isNot(contains('adapterTypeAny')));
      expect(mask, isNot(contains('adapterTypeVpn')));
    });
  });

  group('initOptionsFor', () {
    test('Android: mask plus audio without focus, normal mode, media', () {
      final options = initOptionsFor(RtcPlatform.android);
      expect(
        options['networkIgnoreMask'],
        networkIgnoreMaskFor(RtcPlatform.android),
      );
      expect(options['androidAudioConfiguration'], {
        'manageAudioFocus': false,
        'androidAudioMode': 'normal',
        'androidAudioAttributesUsageType': 'media',
        'androidAudioAttributesContentType': 'movie',
      });
    });

    test('iOS: mask only, no Android audio settings', () {
      final options = initOptionsFor(RtcPlatform.ios);
      expect(
        options['networkIgnoreMask'],
        networkIgnoreMaskFor(RtcPlatform.ios),
      );
      expect(options.containsKey('androidAudioConfiguration'), isFalse);
    });
  });

  test('ensureReady throws before initialisation', () {
    expect(RtcEngine.ready, isFalse);
    expect(RtcEngine.ensureReady, throwsStateError);
  });
}
