// Touch gestures, keyboard edits and the picture geometry: what the phone
// sends on the `input` channel. The expected shapes are the ones the host's
// validators accept (../test/vectors/input-limits.json).
import 'dart:convert';
import 'dart:io';
import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/ui/key_input.dart';
import 'package:tunnelview_mobile/ui/remote_geometry.dart';
import 'package:tunnelview_mobile/ui/touch_input.dart';

class Rig {
  Rig() {
    touch = TouchInput(
      send: (msg) {
        sent.add(msg);
        return true;
      },
      onView: (v) => view = v,
      onLongPress: () => holds++,
      now: () => clock,
    );
    // A 1000x500 viewport showing a 2000x1000 display: it fills the screen.
    touch
      ..viewport = const Size(1000, 500)
      ..fit = fitRect(const Size(1000, 500), const Size(2000, 1000));
  }

  late final TouchInput touch;
  final List<Map<String, Object?>> sent = [];
  ViewTransform view = ViewTransform.identity;
  int holds = 0;
  DateTime clock = DateTime.utc(2026);

  List<Object?> get types => [for (final m in sent) m['t']];
}

void main() {
  group('geometry', () {
    test('fitRect letterboxes and centres', () {
      final wide = fitRect(const Size(1000, 1000), const Size(1920, 1080));
      expect(wide.left, 0);
      expect(wide.width, closeTo(1000, 1e-9));
      expect(wide.top, closeTo(218.75, 1e-9));
      expect(wide.height, closeTo(562.5, 1e-9));
      expect(
        fitRect(const Size(1000, 500), const Size(500, 500)),
        const Rect.fromLTWH(250, 0, 500, 500),
      );
      expect(fitRect(const Size(1000, 500), Size.zero), Rect.zero);
    });

    test('toRemote maps and clamps', () {
      final fit = fitRect(const Size(1000, 500), const Size(500, 500));
      const id = ViewTransform.identity;
      expect(toRemote(const Offset(500, 250), fit, id), const Offset(0.5, 0.5));
      expect(toRemote(const Offset(0, 0), fit, id), const Offset(0, 0));
      expect(toRemote(const Offset(999, 600), fit, id), const Offset(1, 1));
      expect(toRemote(const Offset(1, 1), Rect.zero, id), isNull);
      // Zoomed 2x about the top-left corner: the screen centre is the
      // picture's first quarter.
      const zoomed = ViewTransform(scale: 2);
      expect(
        toRemote(const Offset(750, 250), fit, zoomed),
        const Offset(0.25, 0.25),
      );
    });

    test('the view stays inside its limits', () {
      const viewport = Size(1000, 500);
      final v = const ViewTransform(
        scale: 20,
        offset: Offset(500, -9000),
      ).clamped(viewport);
      expect(v.scale, maxZoom);
      expect(v.offset, const Offset(0, -2500));
      final z = ViewTransform.identity.zoomedAt(
        const Offset(500, 250),
        2,
        Offset.zero,
        viewport,
      );
      expect(z.scale, 2);
      expect(z.offset, const Offset(-500, -250));
      // The focal point still shows the same picture point.
      final fit = fitRect(viewport, const Size(2000, 1000));
      expect(toRemote(const Offset(500, 250), fit, z), const Offset(0.5, 0.5));
    });
  });

  group('touch', () {
    test('a tap is a left click; a second quick tap is a double click', () {
      final r = Rig();
      r.touch.down(1, const Offset(250, 125));
      r.touch.up(1, const Offset(252, 126));
      expect(r.sent, [
        {'t': 'md', 'b': 0, 'x': 0.25, 'y': 0.25, 'n': 1},
        {'t': 'mu', 'b': 0, 'x': 0.25, 'y': 0.25, 'n': 1},
      ]);
      r.clock = r.clock.add(const Duration(milliseconds: 200));
      r.touch.down(2, const Offset(255, 125));
      r.touch.up(2, const Offset(255, 125));
      expect(r.sent[2]['n'], 2);
      expect(r.sent[3]['n'], 2);
      // Much later: a single click again.
      r.clock = r.clock.add(const Duration(seconds: 2));
      r.touch.down(3, const Offset(255, 125));
      r.touch.up(3, const Offset(255, 125));
      expect(r.sent.last['n'], 1);
    });

    testWidgets('touch and hold is a right click', (tester) async {
      final r = Rig();
      r.touch.down(1, const Offset(500, 250));
      await tester.pump(const Duration(milliseconds: 600));
      expect(r.sent, [
        {'t': 'md', 'b': 2, 'x': 0.5, 'y': 0.5, 'n': 1},
        {'t': 'mu', 'b': 2, 'x': 0.5, 'y': 0.5, 'n': 1},
      ]);
      expect(r.holds, 1);
      r.touch.move(1, const Offset(700, 250));
      r.touch.up(1, const Offset(700, 250));
      expect(r.sent, hasLength(2), reason: 'nothing after the right click');
      r.touch.dispose();
    });

    test('a drag holds the left button from where it started', () {
      final r = Rig();
      r.touch.down(1, const Offset(100, 100));
      r.touch.move(1, const Offset(105, 100)); // inside the slop
      expect(r.sent, isEmpty);
      r.touch.move(1, const Offset(200, 100));
      r.touch.move(1, const Offset(300, 250));
      r.touch.up(1, const Offset(300, 250));
      expect(r.sent, [
        {'t': 'md', 'b': 0, 'x': 0.1, 'y': 0.2, 'n': 1},
        {'t': 'mm', 'x': 0.2, 'y': 0.2},
        {'t': 'mm', 'x': 0.3, 'y': 0.5},
        {'t': 'mu', 'b': 0, 'x': 0.3, 'y': 0.5, 'n': 1},
      ]);
      r.touch.dispose();
    });

    test('two fingers scroll: fingers up scrolls down', () {
      final r = Rig();
      r.touch.down(1, const Offset(400, 300));
      r.touch.down(2, const Offset(600, 300));
      r.touch.move(1, const Offset(400, 280));
      r.touch.move(2, const Offset(600, 280));
      r.touch.move(1, const Offset(400, 260));
      r.touch.move(2, const Offset(600, 260));
      r.touch.up(1, const Offset(400, 260));
      r.touch.up(2, const Offset(600, 260));
      expect(r.types.toSet(), {'wh'});
      final dy = r.sent.fold<double>(0, (a, m) => a + (m['dy']! as double));
      expect(dy, greaterThan(0));
      expect(r.sent.every((m) => m['dx'] == 0), isTrue);
      expect(r.view.scale, 1);
    });

    test('a pinch zooms the picture and sends nothing', () {
      final r = Rig();
      r.touch.down(1, const Offset(400, 250));
      r.touch.down(2, const Offset(600, 250));
      r.touch.move(1, const Offset(300, 250));
      r.touch.move(2, const Offset(700, 250));
      r.touch.move(1, const Offset(200, 250));
      r.touch.move(2, const Offset(800, 250));
      r.touch.up(1, const Offset(200, 250));
      r.touch.up(2, const Offset(800, 250));
      expect(r.sent, isEmpty);
      expect(r.view.scale, greaterThan(1.5));
      // The next tap lands on the zoomed picture: near its middle (the
      // fingers did not move at the same instant, so not exactly).
      r.touch.down(3, const Offset(500, 250));
      r.touch.up(3, const Offset(500, 250));
      expect(r.sent.first['x'], closeTo(0.5, 0.06));
      expect(r.sent.first['y'], closeTo(0.5, 0.01));
      expect(
        r.sent.first['x'],
        toRemote(const Offset(500, 250), r.touch.fit, r.view)!.dx,
      );
    });

    test('a second finger ends a drag by releasing the button', () {
      final r = Rig();
      r.touch.down(1, const Offset(100, 100));
      r.touch.move(1, const Offset(300, 100));
      r.touch.down(2, const Offset(600, 300));
      expect(r.types, ['md', 'mm', 'mu']);
      r.touch.dispose();
    });

    test('reset releases a held button', () {
      final r = Rig();
      r.touch.down(1, const Offset(100, 100));
      r.touch.move(1, const Offset(300, 100));
      r.touch.reset();
      expect(r.sent.last, {'t': 'release-all'});
    });

    test('no picture: nothing is sent', () {
      final r = Rig()..touch.fit = Rect.zero;
      r.touch.down(1, const Offset(100, 100));
      r.touch.up(1, const Offset(100, 100));
      r.touch.down(2, const Offset(100, 100));
      r.touch.move(2, const Offset(300, 100));
      r.touch.up(2, const Offset(300, 100));
      expect(r.sent, isEmpty);
      r.touch.dispose();
    });
  });

  group('keyboard', () {
    const s = '        ';

    test('typed text, Thai included, goes as txt', () {
      expect(messagesForEdit(s, '${s}a', const []).messages, [
        {'t': 'txt', 'text': 'a'},
      ]);
      expect(messagesForEdit('$sส', '$sสวัสดี', const []).messages, [
        {'t': 'txt', 'text': 'วัสดี'},
      ]);
    });

    test('deleting sends Backspace, once per character', () {
      expect(messagesForEdit('${s}ab', s, const []).messages, [
        {'t': 'kd', 'code': 'Backspace', 'key': 'Backspace', 'rep': false},
        {'t': 'ku', 'code': 'Backspace', 'key': 'Backspace'},
        {'t': 'kd', 'code': 'Backspace', 'key': 'Backspace', 'rep': false},
        {'t': 'ku', 'code': 'Backspace', 'key': 'Backspace'},
      ]);
      // An emoji is two UTF-16 units but one Backspace.
      expect(messagesForEdit('$s😀', s, const []).messages, hasLength(2));
      // Backspace on the sentinel itself.
      expect(
        messagesForEdit(s, s.substring(1), const []).messages,
        hasLength(2),
      );
    });

    test('a correction is Backspace then the new text', () {
      final m = messagesForEdit('${s}teh', '${s}the', const []).messages;
      expect(m.map((x) => x['t']), ['kd', 'ku', 'kd', 'ku', 'txt']);
      expect(m.last['text'], 'he');
    });

    test('Enter is a key press, also inside pasted text', () {
      expect(
        messagesForEdit(s, '$s\n', const []).messages.map((m) => m['code']),
        ['Enter', 'Enter'],
      );
      final m = messagesForEdit(s, '${s}one\ntwo', const []).messages;
      expect(m.map((x) => x['t']), ['txt', 'kd', 'ku', 'txt']);
    });

    test('a key typed with a latched modifier is a combination', () {
      final r = messagesForEdit(s, '${s}c', const ['ControlLeft']);
      expect(r.used, isTrue);
      expect(r.messages, [
        {
          't': 'combo',
          'codes': ['ControlLeft', 'KeyC'],
        },
      ]);
      // Thai has no key code: it is typed as text and the modifier stays.
      final thai = messagesForEdit(s, '$sก', const ['ControlLeft']);
      expect(thai.used, isFalse);
      expect(thai.messages.single['t'], 'txt');
    });

    test('long text is split below the host limit', () {
      final text = 'a' * 4500;
      final m = messagesForEdit(s, s + text, const []).messages;
      expect(m.map((x) => (x['text']! as String).length), [2000, 2000, 500]);
      final pieces = chunkText('${'a' * 1999}😀b');
      expect(pieces.first.length, 1999);
      expect(pieces.join(), '${'a' * 1999}😀b');
    });

    test('codes and combinations fit the host limits', () {
      final limits =
          (jsonDecode(
                File('../test/vectors/input-limits.json').readAsStringSync(),
              ) as Map)['host']
              as Map;
      final codeRe = RegExp(r'^[A-Za-z0-9]+$');
      for (final os in ['windows', 'macos']) {
        for (final k in specialKeysFor(os)) {
          expect(codeRe.hasMatch(k.code), isTrue, reason: k.code);
          expect(k.code.length, lessThanOrEqualTo(limits['codeMaxLength']));
          expect(k.key.length, lessThanOrEqualTo(limits['keyMaxLength']));
        }
        for (final c in combosFor(os)) {
          expect(c.codes, isNotEmpty);
          expect(c.codes.length, lessThanOrEqualTo(limits['comboMaxCodes']));
        }
      }
      expect(maxComboCodes, limits['comboMaxCodes']);
      expect(maxTextUnits, limits['textMaxUnits']);
      expect(wheelMax, limits['wheelMaxAbs']);
      expect(codeForChar('a'), 'KeyA');
      expect(codeForChar('Z'), 'KeyZ');
      expect(codeForChar('7'), 'Digit7');
      expect(codeForChar(' '), 'Space');
      expect(codeForChar('é'), isNull);
    });
  });
}
