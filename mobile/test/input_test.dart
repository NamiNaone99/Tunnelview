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
      // First the remote pointer goes under the fingers (the wheel acts at
      // the pointer), then only wheel messages.
      expect(r.sent.first, {'t': 'mm', 'x': 0.5, 'y': 0.6});
      final wheel = r.sent.skip(1).toList();
      expect(wheel, isNotEmpty);
      expect(wheel.every((m) => m['t'] == 'wh'), isTrue);
      final dy = wheel.fold<double>(0, (a, m) => a + (m['dy']! as double));
      expect(dy, greaterThan(0));
      expect(wheel.every((m) => m['dx'] == 0), isTrue);
      expect(r.view.scale, 1);
    });

    test('while the keyboard covers the bottom, two fingers move the picture '
        'up to the keyboard and send nothing', () {
      final r = Rig()..touch.bottomInset = 300;
      r.touch.down(1, const Offset(400, 150));
      r.touch.down(2, const Offset(600, 150));
      for (var y = 130.0; y >= -400; y -= 20) {
        r.touch.move(1, Offset(400, y));
        r.touch.move(2, Offset(600, y));
      }
      r.touch.up(1, const Offset(400, -400));
      r.touch.up(2, const Offset(600, -400));
      expect(r.sent, isEmpty);
      expect(r.view.scale, 1);
      // Lifted until the picture's bottom edge sits on the keyboard, no more.
      expect(r.view.offset, const Offset(0, -300));
      // Without the keyboard the same view snaps back.
      expect(r.view.clamped(const Size(1000, 500)).offset, Offset.zero);
    });

    test('a keyboard that does not reach the picture leaves two fingers '
        'scrolling', () {
      final r = Rig()..touch.bottomInset = 100;
      // A wide picture in the middle (y 125..375); the keyboard starts at
      // y 400, so there is nothing to lift.
      r.touch.fit = fitRect(const Size(1000, 500), const Size(4000, 1000));
      r.touch.down(1, const Offset(400, 300));
      r.touch.down(2, const Offset(600, 300));
      for (var y = 280.0; y >= 200; y -= 20) {
        r.touch.move(1, Offset(400, y));
        r.touch.move(2, Offset(600, y));
      }
      r.touch.up(1, const Offset(400, 200));
      r.touch.up(2, const Offset(600, 200));
      expect(r.types.first, 'mm');
      expect(r.types.skip(1).toSet(), {'wh'});
      expect(r.view.offset, Offset.zero);
    });

    test('a double tap clicks twice on the SAME remote point', () {
      final r = Rig();
      r.touch.down(1, const Offset(250, 125));
      r.touch.up(1, const Offset(250, 125));
      r.clock = r.clock.add(const Duration(milliseconds: 150));
      r.touch.down(2, const Offset(262, 131)); // a finger never hits twice
      r.touch.up(2, const Offset(262, 131));
      r.clock = r.clock.add(const Duration(milliseconds: 150));
      r.touch.down(3, const Offset(240, 120));
      r.touch.up(3, const Offset(240, 120));
      expect(r.sent.map((m) => m['n']), [1, 1, 2, 2, 3, 3]);
      for (final m in r.sent) {
        expect(m['x'], 0.25);
        expect(m['y'], 0.25);
      }
      // A fourth quick tap starts over, at its own point.
      r.clock = r.clock.add(const Duration(milliseconds: 150));
      r.touch.down(4, const Offset(260, 130));
      r.touch.up(4, const Offset(260, 130));
      expect(r.sent.last['n'], 1);
      expect(r.sent.last['x'], 0.26);
    });

    testWidgets('touches on the bars around the picture do nothing', (
      tester,
    ) async {
      final r = Rig();
      // A square picture in the middle: bars left and right of x 250..750.
      r.touch.fit = fitRect(const Size(1000, 500), const Size(500, 500));
      r.touch.down(1, const Offset(100, 250));
      r.touch.up(1, const Offset(100, 250));
      r.touch.down(2, const Offset(900, 250));
      await tester.pump(const Duration(milliseconds: 700)); // no hold either
      r.touch.up(2, const Offset(900, 250));
      r.touch.down(3, const Offset(100, 250));
      r.touch.move(3, const Offset(500, 250)); // no drag from a bar
      r.touch.up(3, const Offset(500, 250));
      expect(r.sent, isEmpty);
      expect(r.holds, 0);
      // A drag that starts on the picture and leaves it is clamped.
      r.touch.down(4, const Offset(500, 250));
      r.touch.move(4, const Offset(900, 250));
      r.touch.up(4, const Offset(900, 250));
      expect(r.types, ['md', 'mm', 'mu']);
      expect(r.sent.last['x'], 1);
      // Two fingers that start on a bar can still pinch.
      r.sent.clear();
      r.touch.down(5, const Offset(100, 250));
      r.touch.down(6, const Offset(300, 250));
      r.touch.move(5, const Offset(50, 250));
      r.touch.move(6, const Offset(500, 250));
      r.touch.up(5, const Offset(50, 250));
      r.touch.up(6, const Offset(500, 250));
      expect(r.sent, isEmpty);
      expect(r.view.scale, greaterThan(1));
      r.touch.dispose();
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

    test('a second finger ends a drag where the drag is, not under itself', () {
      final r = Rig();
      r.touch.down(1, const Offset(100, 100));
      r.touch.move(1, const Offset(300, 100));
      r.touch.down(2, const Offset(600, 300));
      expect(r.types, ['md', 'mm', 'mu']);
      expect(r.sent.last['x'], 0.3);
      expect(r.sent.last['y'], 0.2);
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

  group('keyboard buffer', () {
    const bs = [
      {'t': 'kd', 'code': 'Backspace', 'key': 'Backspace', 'rep': false},
      {'t': 'ku', 'code': 'Backspace', 'key': 'Backspace'},
    ];
    KeyboardEdit edit(
      KeyboardBuffer b,
      String text, {
      bool composing = false,
    }) => b.edit(text, composing: composing, modifiers: const []);

    test('typing appends, nothing is reset', () {
      final b = KeyboardBuffer();
      final s = b.sentinel;
      expect(s, 'a       ');
      var e = edit(b, '${s}h');
      expect(e.messages, [
        {'t': 'txt', 'text': 'h'},
      ]);
      expect(e.resetTo, isNull);
      e = edit(b, '${s}hi สวัสดี');
      expect(e.messages, [
        {'t': 'txt', 'text': 'i สวัสดี'},
      ]);
      // A caret move changes nothing.
      expect(edit(b, '${s}hi สวัสดี').messages, isEmpty);
      expect(b.sentinel, s);
    });

    test('Backspace eats the filler, which is refilled when it gets short', () {
      final b = KeyboardBuffer();
      var text = b.sentinel;
      var presses = 0;
      String? reset;
      while (reset == null) {
        text = text.substring(0, text.length - 1);
        final e = edit(b, text);
        expect(e.messages, bs);
        presses++;
        reset = e.resetTo;
      }
      expect(presses, 5); // 8 characters down to 3
      expect(reset, 'b       ');
      expect(b.sentinel, 'b       ');
      // And on from the fresh filler.
      expect(edit(b, 'b      ').messages, bs);
    });

    test('an edit made before the keyboard saw the refill is compared with '
        'the OLD text: no extra Backspaces, nothing typed twice', () {
      final b = KeyboardBuffer();
      // Held Backspace: a..3 characters left, the field is refilled to b.
      for (final t in ['a      ', 'a     ', 'a    ', 'a   ']) {
        edit(b, t);
      }
      final refill = edit(b, 'a  ');
      expect(refill.resetTo, 'b       ');
      // The next repeat was already on its way, based on the old text.
      final stale = edit(b, 'a ');
      expect(stale.messages, bs, reason: 'one Backspace, not six');
      // That text is short too: another refill follows.
      expect(stale.resetTo, 'c       ');
      // Android applies the refills in order; an edit in between is based on
      // the first one.
      expect(edit(b, 'b      ').messages, bs);
      // And then on the second.
      expect(edit(b, 'c       ok').messages, [
        {'t': 'txt', 'text': 'ok'},
      ]);
    });

    test('a long buffer is refilled; text typed before the keyboard saw it is '
        'not sent again', () {
      final b = KeyboardBuffer();
      final long = '${b.sentinel}${'x' * 190}';
      expect(edit(b, long).resetTo, isNull);
      final over = '$long\nmore';
      final e = edit(b, over);
      expect(e.messages.map((m) => m['t']), ['kd', 'ku', 'txt']);
      expect(e.resetTo, 'b       ');
      // Based on the old text: only the new character goes out.
      expect(edit(b, '$over!').messages, [
        {'t': 'txt', 'text': '!'},
      ]);
      // Based on the refill.
      expect(edit(b, 'b       ?').messages, [
        {'t': 'txt', 'text': '?'},
      ]);
    });

    test('no refill in the middle of a composition', () {
      final b = KeyboardBuffer();
      final long = '${b.sentinel}${'x' * 250}';
      expect(edit(b, long, composing: true).resetTo, isNull);
      expect(edit(b, '${long}y').resetTo, 'b       ');
    });

    test('everything deleted at once: few Backspaces rather than many', () {
      final b = KeyboardBuffer();
      var e = edit(b, '');
      expect(e.messages, hasLength(16)); // the 8 characters of the filler
      expect(e.resetTo, 'b       ');
      // With a shorter old text still remembered, that one counts.
      final c = KeyboardBuffer();
      for (final t in ['a      ', 'a     ', 'a    ', 'a   ', 'a  ']) {
        edit(c, t);
      }
      e = edit(c, '');
      expect(e.messages, hasLength(6)); // 3 characters, not 8
      expect(e.resetTo, 'c       ');
    });

    test('a latched modifier makes a combination and is reported as used', () {
      final b = KeyboardBuffer();
      final e = b.edit(
        '${b.sentinel}c',
        composing: false,
        modifiers: const ['ControlLeft'],
      );
      expect(e.used, isTrue);
      expect(e.messages, [
        {
          't': 'combo',
          'codes': ['ControlLeft', 'KeyC'],
        },
      ]);
    });

    test('many edits made before the first refill lands are all compared with '
        'the old text, however many there are', () {
      final b = KeyboardBuffer();
      for (final t in ['a      ', 'a     ', 'a    ', 'a   ']) {
        edit(b, t);
      }
      expect(edit(b, 'a  ').resetTo, 'b       ');
      // The main thread stalled: more repeats of the held Backspace were
      // already on their way, each based on the old text. Each is exactly one
      // Backspace (each also asks for a refill, with a new marker).
      var e = edit(b, 'a ');
      expect(e.messages, bs);
      expect(e.resetTo, 'c       ');
      e = edit(b, 'a');
      expect(e.messages, bs);
      expect(e.resetTo, 'd       ');
      // The marker itself is deleted: counted against the shortest text.
      e = edit(b, '');
      expect(e.messages, bs);
      expect(e.resetTo, 'e       ');
      // Android applies the refills in order; an edit may land on any of
      // them before the next one arrives. Every one is a single Backspace.
      for (final marker in ['b', 'c', 'd', 'e']) {
        expect(edit(b, '$marker      ').messages, bs, reason: marker);
      }
      // An older filler is out of play once a newer one was seen.
      e = edit(b, 'c     ');
      expect(e.messages, isEmpty);
      expect(e.resetTo, 'f       ');
    });

    test('a text that does not start with a marker in play sends nothing and '
        'starts over', () {
      final b = KeyboardBuffer();
      // Typed at the very start of the field.
      var e = edit(b, 'ก${b.sentinel}');
      expect(e.messages, isEmpty);
      expect(e.resetTo, 'b       ');
      // A marker that was never issued.
      e = edit(b, 'q       hello');
      expect(e.messages, isEmpty);
      expect(e.resetTo, 'c       ');
      // And typing goes on normally from the new filler.
      expect(edit(b, 'c       ok').messages, [
        {'t': 'txt', 'text': 'ok'},
      ]);
    });

    test('the markers go round the alphabet', () {
      final b = KeyboardBuffer();
      final seen = <String>{b.sentinel};
      for (var i = 0; i < 60; i++) {
        final s = b.sentinel;
        final e = edit(b, s.substring(0, 3));
        expect(e.messages, hasLength(10), reason: 'round $i');
        expect(e.resetTo, isNot(s));
        seen.add(e.resetTo!);
      }
      expect(seen, hasLength(KeyboardBuffer.markers));
      expect(KeyboardBuffer.markers, 26);
    });
  });

  group('geometry with the keyboard open', () {
    const viewport = Size(1000, 500);

    test('isInsidePicture', () {
      final fit = fitRect(viewport, const Size(500, 500)); // x 250..750
      const id = ViewTransform.identity;
      expect(isInsidePicture(const Offset(500, 250), fit, id), isTrue);
      expect(isInsidePicture(const Offset(100, 250), fit, id), isFalse);
      expect(isInsidePicture(const Offset(800, 250), fit, id), isFalse);
      expect(isInsidePicture(const Offset(1, 1), Rect.zero, id), isFalse);
      // Zoomed 2x from the top-left corner the picture covers x 500..1500.
      const zoomed = ViewTransform(scale: 2);
      expect(isInsidePicture(const Offset(400, 250), fit, zoomed), isFalse);
      expect(isInsidePicture(const Offset(600, 250), fit, zoomed), isTrue);
    });

    test('the picture can be lifted until its bottom meets the keyboard', () {
      const far = ViewTransform(offset: Offset(0, -9999));
      // A picture that fills the height: lifted by the whole keyboard.
      final full = fitRect(viewport, const Size(2000, 1000));
      expect(
        far.clamped(viewport, bottomInset: 300, fit: full).offset,
        const Offset(0, -300),
      );
      // A wide picture in the middle (y 125..375) with a 100 px keyboard: its
      // bottom is already above the keyboard, so it stays.
      final wide = fitRect(viewport, const Size(4000, 1000));
      expect(
        far.clamped(viewport, bottomInset: 100, fit: wide).offset,
        Offset.zero,
      );
      // With a 300 px keyboard it is lifted by the covered 175 px only.
      expect(
        far.clamped(viewport, bottomInset: 300, fit: wide).offset,
        const Offset(0, -175),
      );
      // No keyboard: as before.
      expect(far.clamped(viewport).offset, Offset.zero);
    });
  });
}
