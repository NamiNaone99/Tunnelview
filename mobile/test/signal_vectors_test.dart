// The desktop's shared vectors for what a viewer accepts from a host
// (../test/vectors), run against lib/proto/signal.dart.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/proto/signal.dart';

Map<String, dynamic> vectors(String name) =>
    jsonDecode(File('../test/vectors/$name.json').readAsStringSync())
        as Map<String, dynamic>;

List<Map<String, dynamic>> cases(Map<String, dynamic> file, String fn) =>
    ((file['functions'] as Map)[fn] as Map)['cases']
            .cast<Map<String, dynamic>>()
        as List<Map<String, dynamic>>;

Object? controlJson(ControlMessage? m) => switch (m) {
  null => null,
  DisplaysMessage() => {
    't': 'displays',
    'displays': [for (final d in m.displays) d.toJson()],
    'current': m.current,
  },
  HostStateMessage() => {
    't': 'host-state',
    if (m.audio != null) 'audio': m.audio,
    if (m.controlAllowed != null) 'controlAllowed': m.controlAllowed,
    if (m.hasInputBlocked) 'inputBlocked': m.inputBlocked,
  },
};

void main() {
  test('addresses.json isAllowedCandidate', () {
    for (final c in cases(vectors('addresses'), 'isAllowedCandidate')) {
      expect(
        isAllowedCandidate((c['args'] as List)[0]),
        c['result'],
        reason: '${c['args']}',
      );
    }
  });

  group('validate.json', () {
    final file = vectors('validate');

    test('validateSignal', () {
      for (final c in cases(file, 'validateSignal')) {
        expect(
          validateSignal((c['args'] as List)[0])?.toJson(),
          c['result'],
          reason: '${c['args']}',
        );
      }
    });

    test('sanitizeSdp', () {
      for (final c in cases(file, 'sanitizeSdp')) {
        expect(sanitizeSdp((c['args'] as List)[0]), c['result']);
      }
    });

    // The phone handles displays and host-state; clipboard and chat are
    // ignored for now.
    test('validateControl (displays, host-state, junk)', () {
      var checked = 0;
      for (final c in cases(file, 'validateControl')) {
        final arg = (c['args'] as List)[0];
        final t = arg is Map ? arg['t'] : null;
        if (t == 'clipboard' || t == 'chat') {
          expect(validateControl(arg), isNull);
          continue;
        }
        checked++;
        expect(
          controlJson(validateControl(arg)),
          c['result'],
          reason: jsonEncode(arg),
        );
      }
      expect(checked, greaterThan(10));
    });
  });

  test('tailnet-path.json verifyTailnetPath', () {
    for (final c in cases(vectors('tailnet-path'), 'verifyTailnetPath')) {
      final arg = (c['args'] as List)[0] as Map;
      final stats = arg['stats'];
      if (stats is! List) continue; // a failing getStats: the engine's job
      expect(
        verifyTailnetPath(stats.cast<Map>()).toJson(),
        c['result'],
        reason: '${c['note']} ${jsonEncode(arg)}',
      );
    }
  });

  // Stricter than the desktop on purpose: the phone hands the line to
  // libwebrtc, which splits on single spaces and resolves anything that is
  // not an IP literal as a host name.
  group('candidate lines only libwebrtc would read differently', () {
    bool ok(String line) => isAllowedCandidate({'candidate': line});
    const good =
        'candidate:1 1 udp 2122260223 100.64.0.1 47810 typ host generation 0';

    test('a normal Tailscale candidate passes', () {
      expect(ok(good), isTrue);
      expect(ok('a=$good'), isTrue);
      expect(ok('candidate:1 1 udp 1 fd7a:115c:a1e0::1234 9 typ host'), isTrue);
    });

    test('a TAB-separated decoy in front of the real fields is refused', () {
      // Split on any white space, field 5 is 100.64.0.1; split on single
      // spaces (libwebrtc), it is 203.0.113.5.
      const decoy =
          'candidate:F\t1\tudp\t1\t100.64.0.1\t9\ttyp\thost 1 udp 2130706431 '
          '203.0.113.5 3478 typ host';
      expect(ok(decoy), isFalse);
      expect(
        ok(
          'candidate:F\t1\tudp\t1\t100.64.0.1\t9\ttyp\thost 1 udp 1 '
          'evil.example 3478 typ host',
        ),
        isFalse,
      );
      // The same line inside an offer is dropped from the SDP.
      expect(
        sanitizeSdp('v=0\r\na=$decoy\r\na=$good\r\n'),
        'v=0\r\na=$good\r\n',
      );
    });

    test('other white space, double spaces and control characters', () {
      expect(ok(good.replaceFirst(' udp ', '  udp ')), isFalse);
      expect(ok(' $good'), isFalse);
      expect(ok('$good '), isFalse);
      expect(ok(good.replaceFirst(' udp ', '\u00a0udp ')), isFalse);
      expect(ok('$good\r'), isFalse);
      expect(ok('$good\u0000'), isFalse);
    });

    test('an address that is not a bare IP literal', () {
      String withAddress(String a) =>
          'candidate:1 1 udp 2122260223 $a 47810 typ host';
      expect(ok(withAddress('100.64.0.1')), isTrue);
      expect(ok(withAddress('[fd7a:115c:a1e0::1]')), isFalse);
      expect(ok(withAddress('fd7a:115c:a1e0::1%wlan0')), isFalse);
      expect(ok(withAddress('100.64.0.1%1')), isFalse);
      expect(ok(withAddress('office-pc.tail1234.ts.net')), isFalse);
      expect(ok(withAddress('abcd.local')), isFalse);
    });
  });
}
