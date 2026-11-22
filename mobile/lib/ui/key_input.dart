/// Turns what the phone's keyboard types into `input` messages: text as
/// `txt`, Enter and Backspace as key presses, and a letter typed while Ctrl,
/// Alt, Shift or the Windows / Command key is latched as a key combination.
library;

/// Longest text in one `txt` message.
const int maxTextUnits = 2000;

/// Most key codes in one `combo` message.
const int maxComboCodes = 6;

/// A key on the extra row above the keyboard.
class SpecialKey {
  const SpecialKey(this.label, this.code, this.key, {this.modifier = false});

  final String label;

  /// KeyboardEvent.code.
  final String code;

  /// KeyboardEvent.key.
  final String key;

  /// Latches until the next key instead of being pressed at once.
  final bool modifier;
}

const SpecialKey keyCtrl = SpecialKey(
  'Ctrl',
  'ControlLeft',
  'Control',
  modifier: true,
);
const SpecialKey keyAlt = SpecialKey('Alt', 'AltLeft', 'Alt', modifier: true);
const SpecialKey keyShift = SpecialKey(
  'Shift',
  'ShiftLeft',
  'Shift',
  modifier: true,
);

/// The Windows key, or Command on a Mac.
SpecialKey metaKey(String hostOs) => SpecialKey(
  hostOs == 'macos' ? 'Cmd' : 'Win',
  'MetaLeft',
  'Meta',
  modifier: true,
);

const SpecialKey keyEnter = SpecialKey('Enter', 'Enter', 'Enter');
const SpecialKey keyBackspace = SpecialKey('Bksp', 'Backspace', 'Backspace');

/// The extra row, left to right.
List<SpecialKey> specialKeysFor(String hostOs) => [
  const SpecialKey('Esc', 'Escape', 'Escape'),
  const SpecialKey('Tab', 'Tab', 'Tab'),
  keyCtrl,
  keyAlt,
  keyShift,
  metaKey(hostOs),
  const SpecialKey('←', 'ArrowLeft', 'ArrowLeft'),
  const SpecialKey('↑', 'ArrowUp', 'ArrowUp'),
  const SpecialKey('↓', 'ArrowDown', 'ArrowDown'),
  const SpecialKey('→', 'ArrowRight', 'ArrowRight'),
  const SpecialKey('Del', 'Delete', 'Delete'),
  const SpecialKey('Home', 'Home', 'Home'),
  const SpecialKey('End', 'End', 'End'),
  const SpecialKey('PgUp', 'PageUp', 'PageUp'),
  const SpecialKey('PgDn', 'PageDown', 'PageDown'),
  for (var i = 1; i <= 12; i++) SpecialKey('F$i', 'F$i', 'F$i'),
];

/// A ready-made key combination.
class KeyCombo {
  const KeyCombo(this.label, this.codes);

  final String label;
  final List<String> codes;
}

/// The combinations menu for a host.
List<KeyCombo> combosFor(String hostOs) => hostOs == 'macos'
    ? const [
        KeyCombo('Cmd + Space (Spotlight)', ['MetaLeft', 'Space']),
        KeyCombo('Cmd + Tab', ['MetaLeft', 'Tab']),
        KeyCombo('Cmd + C', ['MetaLeft', 'KeyC']),
        KeyCombo('Cmd + V', ['MetaLeft', 'KeyV']),
        KeyCombo('Cmd + Z', ['MetaLeft', 'KeyZ']),
        KeyCombo('Cmd + A', ['MetaLeft', 'KeyA']),
        KeyCombo('Cmd + W', ['MetaLeft', 'KeyW']),
        KeyCombo('Cmd + Q', ['MetaLeft', 'KeyQ']),
        KeyCombo('Cmd + Option + Esc', ['MetaLeft', 'AltLeft', 'Escape']),
      ]
    // No Ctrl + Alt + Del: Windows ignores an injected one, so it would be a
    // menu entry that does nothing (the desktop viewer leaves it out too).
    : const [
        KeyCombo('Alt + Tab', ['AltLeft', 'Tab']),
        KeyCombo('Windows key', ['MetaLeft']),
        KeyCombo('Win + D (desktop)', ['MetaLeft', 'KeyD']),
        KeyCombo('Ctrl + C', ['ControlLeft', 'KeyC']),
        KeyCombo('Ctrl + V', ['ControlLeft', 'KeyV']),
        KeyCombo('Ctrl + Z', ['ControlLeft', 'KeyZ']),
        KeyCombo('Ctrl + A', ['ControlLeft', 'KeyA']),
        KeyCombo('Alt + F4', ['AltLeft', 'F4']),
        KeyCombo('Ctrl + Shift + Esc', ['ControlLeft', 'ShiftLeft', 'Escape']),
      ];

/// The `input` messages for one press and release of [key].
List<Map<String, Object?>> keyTap(SpecialKey key) => [
  {'t': 'kd', 'code': key.code, 'key': key.key, 'rep': false},
  {'t': 'ku', 'code': key.code, 'key': key.key},
];

/// The key code of a single typed character that sits on its own key (a
/// letter, a digit, space), or null.
String? codeForChar(String ch) {
  if (ch.length != 1) return null;
  final c = ch.codeUnitAt(0);
  if (c >= 0x61 && c <= 0x7a) return 'Key${ch.toUpperCase()}';
  if (c >= 0x41 && c <= 0x5a) return 'Key$ch';
  if (c >= 0x30 && c <= 0x39) return 'Digit$ch';
  if (c == 0x20) return 'Space';
  return null;
}

/// [text] in pieces of at most [maxTextUnits] UTF-16 units, never splitting
/// a surrogate pair.
List<String> chunkText(String text, [int max = maxTextUnits]) {
  final out = <String>[];
  var i = 0;
  while (i < text.length) {
    var end = i + max < text.length ? i + max : text.length;
    if (end < text.length) {
      final last = text.codeUnitAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
    }
    out.add(text.substring(i, end));
    i = end;
  }
  return out;
}

/// The messages for an edit of the keyboard's text buffer from [before] to
/// [after]: Backspace for what disappeared after the common start, then the
/// new text. [modifiers] are the latched modifier codes: one plain key typed
/// while any is latched is sent as a combination (`used` is then true and
/// the caller unlatches them).
({List<Map<String, Object?>> messages, bool used}) messagesForEdit(
  String before,
  String after,
  List<String> modifiers,
) {
  var prefix = 0;
  final limit = before.length < after.length ? before.length : after.length;
  while (prefix < limit &&
      before.codeUnitAt(prefix) == after.codeUnitAt(prefix)) {
    prefix++;
  }
  // Never cut a surrogate pair in half.
  if (prefix > 0) {
    final c = before.codeUnitAt(prefix - 1);
    if (c >= 0xd800 && c <= 0xdbff) prefix--;
  }
  final removed = before.substring(prefix).runes.length;
  final added = after.substring(prefix);
  final out = <Map<String, Object?>>[];
  for (var i = 0; i < removed; i++) {
    out.addAll(keyTap(keyBackspace));
  }
  if (modifiers.isNotEmpty && removed == 0) {
    final code = added == '\n' ? 'Enter' : codeForChar(added);
    if (code != null && modifiers.length < maxComboCodes) {
      out.add({
        't': 'combo',
        'codes': [...modifiers, code],
      });
      return (messages: out, used: true);
    }
  }
  final lines = added.split('\n');
  for (var i = 0; i < lines.length; i++) {
    if (i > 0) out.addAll(keyTap(keyEnter));
    for (final piece in chunkText(lines[i])) {
      out.add({'t': 'txt', 'text': piece});
    }
  }
  return (messages: out, used: false);
}

/// What [KeyboardBuffer.edit] found.
class KeyboardEdit {
  const KeyboardEdit(this.messages, {this.used = false, this.resetTo});

  /// The `input` messages to send, in order.
  final List<Map<String, Object?>> messages;

  /// The latched modifiers were used: unlatch them.
  final bool used;

  /// When not null: set the text field to this value (caret at its end).
  final String? resetTo;
}

/// Follows the hidden text field the phone's keyboard types into and turns
/// each change into `input` messages.
///
/// The field always starts with a short filler, so Backspace has something to
/// delete; when the text gets short or long the field is set back to a fresh
/// filler. That reset travels to Android asynchronously, so an edit the
/// keyboard made just before it arrives is still based on the OLD text.
/// Comparing such an edit with the new filler would re-type or delete text
/// on the computer. Therefore every filler starts with a marker letter that
/// changes with each reset, and the buffer remembers the last text of every
/// filler that can still be in play: an edit is always compared with the
/// last text that carried the same marker.
///
/// A filler stops being in play on evidence, not by count: Android applies
/// the resets in the order they were sent and reports edits in order, so
/// once a text of one filler arrives, no later edit can be based on an older
/// filler.
class KeyboardBuffer {
  KeyboardBuffer() {
    _open();
  }

  /// The marker letters, a to z, used in turn.
  static const int markers = 26;
  static const String _filler = '       ';

  /// Texts shorter than this, or longer than [high], cause a reset.
  static const int low = 4;
  static const int high = 200;

  int _epoch = 0;

  // The last text of each filler in play and the epoch it was issued in, by
  // marker letter.
  final Map<String, String> _last = {};
  final Map<String, int> _epochOf = {};

  static String _marker(int epoch) =>
      String.fromCharCode(0x61 + epoch % markers);

  /// What the field holds after a reset (and at the start).
  String get sentinel => '${_marker(_epoch)}$_filler';

  void _open() {
    final m = _marker(_epoch);
    _last[m] = sentinel;
    _epochOf[m] = _epoch;
  }

  String _refill() {
    _epoch++;
    _open();
    return sentinel;
  }

  /// The field's text is now [text]. [composing]: the keyboard is in the
  /// middle of composing a word (no reset then). [modifiers]: the latched
  /// modifier key codes.
  KeyboardEdit edit(
    String text, {
    required bool composing,
    required List<String> modifiers,
  }) {
    final marker = text.isEmpty ? null : text[0];
    if (marker != null && _last.containsKey(marker)) {
      // Older fillers are out of play from here on.
      final seen = _epochOf[marker]!;
      _epochOf.removeWhere((m, epoch) {
        if (epoch >= seen) return false;
        _last.remove(m);
        return true;
      });
      final base = _last[marker]!;
      if (text == base) return const KeyboardEdit([]);
      final r = messagesForEdit(base, text, modifiers);
      _last[marker] = text;
      if (composing || (text.length >= low && text.length <= high)) {
        return KeyboardEdit(r.messages, used: r.used);
      }
      return KeyboardEdit(r.messages, used: r.used, resetTo: _refill());
    }
    if (text.isEmpty) {
      // Everything was deleted in one go, the marker included. Count against
      // the shortest text in play: too few rather than too many Backspaces.
      final base = _last.values.reduce((a, b) => a.length <= b.length ? a : b);
      final r = messagesForEdit(base, text, modifiers);
      return KeyboardEdit(r.messages, used: r.used, resetTo: _refill());
    }
    // The text does not start with a marker in play (something was typed at
    // the very start of the field, or its filler is long gone). There is
    // nothing sound to compare it with: send nothing and start over, rather
    // than delete or type the wrong thing on the computer.
    return KeyboardEdit(const [], resetTo: _refill());
  }
}
