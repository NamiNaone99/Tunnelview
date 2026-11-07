'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const keymap = require('../src/main/input/keymap');

// Every code the contract (ARCHITECTURE §5 + input assignment) requires.
const REQUIRED = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
  ...'0123456789'.split('').map((d) => `Digit${d}`),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  'Escape', 'Backquote', 'Minus', 'Equal', 'Backspace', 'Tab', 'BracketLeft', 'BracketRight', 'Backslash',
  'CapsLock', 'Semicolon', 'Quote', 'Enter',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
  'ContextMenu', 'Space', 'Comma', 'Period', 'Slash',
  'IntlBackslash', 'IntlRo', 'IntlYen', 'Lang1', 'Lang2', 'Convert', 'NonConvert', 'KanaMode',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Insert', 'Delete', 'Home', 'End', 'PageUp', 'PageDown',
  'PrintScreen', 'ScrollLock', 'Pause', 'NumLock',
  ...'0123456789'.split('').map((d) => `Numpad${d}`),
  'NumpadDecimal', 'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadEnter', 'NumpadEqual', 'NumpadComma',
  'AudioVolumeMute', 'AudioVolumeDown', 'AudioVolumeUp',
  'MediaPlayPause', 'MediaStop', 'MediaTrackNext', 'MediaTrackPrevious',
  'Help',
];

function isWinDesc(d) {
  if (d === null) return true;
  if (typeof d !== 'object') return false;
  const hasSc = Number.isInteger(d.sc) && d.sc > 0 && d.sc <= 0xFF;
  const hasVk = Number.isInteger(d.vk) && d.vk > 0 && d.vk <= 0xFE;
  if (!hasSc && !hasVk) return false;
  if ('ext' in d && d.ext !== true) return false;
  return true;
}

test('every required code has explicit win + mac entries', () => {
  for (const code of REQUIRED) {
    assert.ok(keymap.KEYMAP.has(code), `missing ${code}`);
    const e = keymap.KEYMAP.get(code);
    assert.ok('win' in e && 'mac' in e, `${code} must define win and mac (null allowed)`);
    assert.ok(isWinDesc(e.win), `${code} has a malformed win descriptor`);
    assert.ok(e.mac === null || (Number.isInteger(e.mac) && e.mac >= 0 && e.mac <= 0x7F), `${code} has a bad mac keycode`);
  }
});

test('all table entries are well-formed and frozen', () => {
  for (const [code, e] of keymap.KEYMAP) {
    assert.match(code, /^[A-Za-z0-9]+$/);
    assert.ok(code.length <= 32);
    assert.ok(Object.isFrozen(e), `${code} entry not frozen`);
    if (e.win) assert.ok(Object.isFrozen(e.win), `${code} win descriptor not frozen`);
    assert.ok(isWinDesc(e.win), code);
    assert.ok(e.mac === null || (Number.isInteger(e.mac) && e.mac >= 0 && e.mac <= 0x7F), code);
  }
});

test('spot-check known Windows scancodes and macOS keycodes', () => {
  const cases = [
    ['KeyA', { sc: 0x1E }, 0x00],
    ['Enter', { sc: 0x1C }, 0x24],
    ['ArrowLeft', { sc: 0x4B, ext: true }, 0x7B],
    ['MetaLeft', { sc: 0x5B, ext: true }, 0x37],
    ['MetaRight', { sc: 0x5C, ext: true }, 0x36],
    ['Numpad5', { sc: 0x4C }, 0x57],
    ['F5', { sc: 0x3F }, 0x60],
    ['KeyS', { sc: 0x1F }, 0x01],
    ['Tab', { sc: 0x0F }, 0x30],
    ['Space', { sc: 0x39 }, 0x31],
    ['Backspace', { sc: 0x0E }, 0x33],
    ['Escape', { sc: 0x01 }, 0x35],
    ['ShiftLeft', { sc: 0x2A }, 0x38],
    ['ShiftRight', { sc: 0x36 }, 0x3C],
    ['CapsLock', { sc: 0x3A }, 0x39],
    ['AltLeft', { sc: 0x38 }, 0x3A],
    ['AltRight', { sc: 0x38, ext: true }, 0x3D],
    ['ControlLeft', { sc: 0x1D }, 0x3B],
    ['ControlRight', { sc: 0x1D, ext: true }, 0x3E],
    ['Delete', { sc: 0x53, ext: true }, 0x75],
    ['Insert', { sc: 0x52, ext: true }, 0x72],
    ['ContextMenu', { sc: 0x5D, ext: true }, null],
    ['NumpadEnter', { sc: 0x1C, ext: true }, 0x4C],
    ['NumpadDivide', { sc: 0x35, ext: true }, 0x4B],
    ['ScrollLock', { sc: 0x46 }, 0x6B],
    ['F1', { sc: 0x3B }, 0x7A],
    ['F12', { sc: 0x58 }, 0x6F],
    ['F13', { sc: 0x64 }, 0x69],
    ['F24', { sc: 0x76 }, null],
  ];
  for (const [code, win, mac] of cases) {
    assert.deepEqual({ ...keymap.winKey(code) }, win, `${code} win`);
    assert.equal(keymap.macKey(code), mac, `${code} mac`);
  }
});

test('macOS position mappings for PC-only keys', () => {
  assert.equal(keymap.macKey('Insert'), 0x72); // kVK_Help
  assert.equal(keymap.macKey('Help'), 0x72);
  assert.equal(keymap.macKey('PrintScreen'), keymap.macKey('F13'));
  assert.equal(keymap.macKey('ScrollLock'), keymap.macKey('F14'));
  assert.equal(keymap.macKey('Pause'), keymap.macKey('F15'));
  assert.equal(keymap.macKey('NumLock'), 0x47); // kVK_ANSI_KeypadClear
  assert.equal(keymap.macKey('ContextMenu'), null);
  for (let i = 1; i <= 20; i++) assert.notEqual(keymap.macKey(`F${i}`), null, `F${i}`);
  for (let i = 21; i <= 24; i++) assert.equal(keymap.macKey(`F${i}`), null, `F${i}`);
});

test('Windows keys that must be injected by VK code', () => {
  assert.equal(keymap.winKey('Pause').vk, 0x13);
  assert.ok(!keymap.winKey('Pause').ext);
  assert.equal(keymap.winKey('NumLock').vk, 0x90);
  assert.equal(keymap.winKey('NumLock').ext, true);
  assert.equal(keymap.winKey('PrintScreen').vk, 0x2C);
  assert.equal(keymap.winKey('Help').vk, 0x2F);
  for (const [code, vk] of [['AudioVolumeMute', 0xAD], ['AudioVolumeDown', 0xAE], ['AudioVolumeUp', 0xAF],
    ['MediaTrackNext', 0xB0], ['MediaTrackPrevious', 0xB1], ['MediaStop', 0xB2], ['MediaPlayPause', 0xB3]]) {
    assert.equal(keymap.winKey(code).vk, vk, code);
    assert.equal(keymap.winKey(code).ext, true, code);
  }
});

test('extended (E0) flags on the Windows navigation cluster', () => {
  for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Insert', 'Delete', 'Home', 'End', 'PageUp',
    'PageDown', 'NumpadEnter', 'NumpadDivide', 'ControlRight', 'AltRight', 'MetaLeft', 'MetaRight', 'ContextMenu']) {
    assert.equal(keymap.winKey(code).ext, true, code);
  }
  for (const code of ['Numpad0', 'Numpad8', 'NumpadMultiply', 'ShiftRight', 'ShiftLeft', 'ControlLeft', 'AltLeft', 'Enter']) {
    assert.ok(!keymap.winKey(code).ext, code);
  }
});

test('no duplicate mac keycodes except intentional aliases', () => {
  const seen = new Map();
  for (const [code, e] of keymap.KEYMAP) {
    if (e.mac === null) continue;
    if (code in keymap.ALIASES) continue;
    if (seen.has(e.mac)) {
      const other = seen.get(e.mac);
      const intentional = keymap.MAC_SHARED[code] === other || keymap.MAC_SHARED[other] === code;
      assert.ok(intentional, `mac keycode 0x${e.mac.toString(16)} used by ${other} and ${code}`);
    } else {
      seen.set(e.mac, code);
    }
  }
});

test('no duplicate Windows (sc,ext) / (vk) targets except aliases', () => {
  const seen = new Map();
  for (const [code, e] of keymap.KEYMAP) {
    if (!e.win || code in keymap.ALIASES) continue;
    const id = typeof e.win.vk === 'number' ? `vk:${e.win.vk}` : `sc:${e.win.sc}:${e.win.ext ? 1 : 0}`;
    assert.ok(!seen.has(id), `${id} used by ${seen.get(id)} and ${code}`);
    seen.set(id, code);
  }
});

test('aliases resolve to the canonical entry', () => {
  assert.strictEqual(keymap.KEYMAP.get('OSLeft'), keymap.KEYMAP.get('MetaLeft'));
  assert.strictEqual(keymap.KEYMAP.get('OSRight'), keymap.KEYMAP.get('MetaRight'));
});

test('macKeyFor: ISO hosts swap Backquote (0x0A) and IntlBackslash (0x32); nothing else changes', () => {
  assert.equal(keymap.macKeyFor('Backquote', false), 0x32); // kVK_ANSI_Grave
  assert.equal(keymap.macKeyFor('IntlBackslash', false), 0x0A); // kVK_ISO_Section
  assert.equal(keymap.macKeyFor('Backquote', true), 0x0A); // top-left key on an ISO Mac
  assert.equal(keymap.macKeyFor('IntlBackslash', true), 0x32); // key left of Z on an ISO Mac
  for (const [code] of keymap.KEYMAP) {
    if (code === 'Backquote' || code === 'IntlBackslash') continue;
    assert.equal(keymap.macKeyFor(code, true), keymap.macKey(code), code);
    assert.equal(keymap.macKeyFor(code, false), keymap.macKey(code), code);
  }
  // only a real `true` means ISO
  assert.equal(keymap.macKeyFor('Backquote', 1), 0x32);
  assert.equal(keymap.macKeyFor('Backquote', undefined), 0x32);
  for (const code of ['NoSuchKey', 'ContextMenu', 'constructor', 42]) assert.equal(keymap.macKeyFor(code, true), null, String(code));
  // still a bijection on ISO hosts
  const seen = new Map();
  for (const [code] of keymap.KEYMAP) {
    const kc = keymap.macKeyFor(code, true);
    if (kc === null || code in keymap.ALIASES) continue;
    if (seen.has(kc)) {
      const other = seen.get(kc);
      assert.ok(keymap.MAC_SHARED[code] === other || keymap.MAC_SHARED[other] === code, `${other} and ${code} share 0x${kc.toString(16)}`);
    } else {
      seen.set(kc, code);
    }
  }
});

test('lookup by platform', () => {
  assert.deepEqual({ ...keymap.lookup('KeyA', 'win32') }, { sc: 0x1E });
  assert.equal(keymap.lookup('KeyA', 'darwin'), 0x00);
  assert.equal(keymap.lookup('KeyA', 'linux'), null);
  assert.equal(keymap.lookup('ContextMenu', 'darwin'), null);
  assert.equal(keymap.lookup('Fn', 'win32'), null);
  assert.equal(keymap.lookup('NoSuchKey', 'win32'), null);
});

test('prototype keys never resolve', () => {
  for (const code of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(keymap.isKnownCode(code), false, code);
    assert.equal(keymap.winKey(code), null, code);
    assert.equal(keymap.macKey(code), null, code);
    assert.equal(keymap.modifierKind(code), null, code);
  }
  assert.equal(keymap.winKey(undefined), null);
  assert.equal(keymap.macKey(42), null);
});

test('modifier classification', () => {
  assert.equal(keymap.modifierKind('ShiftLeft'), 'shift');
  assert.equal(keymap.modifierKind('ShiftRight'), 'shift');
  assert.equal(keymap.modifierKind('ControlRight'), 'control');
  assert.equal(keymap.modifierKind('AltRight'), 'alt');
  assert.equal(keymap.modifierKind('MetaLeft'), 'meta');
  assert.equal(keymap.modifierKind('OSRight'), 'meta');
  assert.equal(keymap.modifierKind('CapsLock'), 'capslock');
  assert.equal(keymap.modifierKind('Fn'), 'fn');
  assert.equal(keymap.modifierKind('KeyA'), null);
  assert.equal(keymap.isModifier('ControlLeft'), true);
  assert.equal(keymap.isModifier('Enter'), false);
});
