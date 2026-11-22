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
}
