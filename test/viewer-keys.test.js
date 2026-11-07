'use strict';
/* Unit tests for src/renderer/shared/keys.js (ES module, pure). */
const test = require('node:test');
const assert = require('node:assert/strict');
const keymap = require('../src/main/input/keymap');

const load = () => import('../src/renderer/shared/keys.js');

test('shouldSwapCmdCtrl: on/off/auto matrix', async () => {
  const { shouldSwapCmdCtrl } = await load();
  assert.equal(shouldSwapCmdCtrl('on', 'windows', 'windows'), true);
  assert.equal(shouldSwapCmdCtrl('off', 'macos', 'windows'), false);
  assert.equal(shouldSwapCmdCtrl('auto', 'macos', 'windows'), true);
  assert.equal(shouldSwapCmdCtrl('auto', 'windows', 'macos'), true);
  assert.equal(shouldSwapCmdCtrl('auto', 'macos', 'macos'), false);
  assert.equal(shouldSwapCmdCtrl('auto', 'windows', 'windows'), false);
  // unknown setting behaves like auto
  assert.equal(shouldSwapCmdCtrl('bogus', 'macos', 'windows'), true);
  assert.equal(shouldSwapCmdCtrl(undefined, 'windows', 'windows'), false);
});

test('mapCode: swaps only Meta/Control, normalizes legacy names', async () => {
  const { mapCode } = await load();
  assert.equal(mapCode('MetaLeft', true), 'ControlLeft');
  assert.equal(mapCode('ControlLeft', true), 'MetaLeft');
  assert.equal(mapCode('MetaRight', true), 'ControlRight');
  assert.equal(mapCode('ControlRight', true), 'MetaRight');
  assert.equal(mapCode('MetaLeft', false), 'MetaLeft');
  assert.equal(mapCode('KeyC', true), 'KeyC');
  assert.equal(mapCode('AltLeft', true), 'AltLeft');
  assert.equal(mapCode('OSLeft', false), 'MetaLeft');
  assert.equal(mapCode('OSRight', true), 'ControlRight');
  assert.equal(mapCode(undefined, true), '');
  assert.equal(mapCode('constructor', true), 'constructor'); // no prototype lookups
  assert.equal(mapCode('__proto__', true), '__proto__');
});

test('isModifierCode', async () => {
  const { isModifierCode } = await load();
  for (const c of ['ShiftLeft', 'ControlRight', 'AltLeft', 'MetaRight', 'CapsLock', 'OSLeft']) assert.equal(isModifierCode(c), true, c);
  for (const c of ['KeyA', 'Escape', 'Tab', '']) assert.equal(isModifierCode(c), false, c);
});

test('wheelPixels: deltaMode conversion, clamping, non-finite', async () => {
  const { wheelPixels, LINE_PX, PAGE_PX } = await load();
  assert.equal(LINE_PX, 40);
  assert.equal(PAGE_PX, 800);
  assert.deepEqual(wheelPixels({ deltaMode: 0, deltaX: 3.5, deltaY: -100 }), { dx: 3.5, dy: -100 });
  assert.deepEqual(wheelPixels({ deltaMode: 1, deltaX: 0, deltaY: 3 }), { dx: 0, dy: 120 });
  assert.deepEqual(wheelPixels({ deltaMode: 2, deltaX: -1, deltaY: 1 }), { dx: -800, dy: 800 });
  assert.deepEqual(wheelPixels({ deltaMode: 0, deltaX: NaN, deltaY: Infinity }), { dx: 0, dy: 0 });
  assert.deepEqual(wheelPixels({ deltaMode: 2, deltaX: 0, deltaY: 1e6 }), { dx: 0, dy: 10000 });
  assert.deepEqual(wheelPixels({ deltaY: 5 }), { dx: 0, dy: 5 });
});

test('chunkText: respects UTF-16 length limit and never splits surrogate pairs', async () => {
  const { chunkText } = await load();
  assert.deepEqual(chunkText('', 10), []);
  assert.deepEqual(chunkText('abc', 10), ['abc']);
  assert.deepEqual(chunkText('abcdef', 2), ['ab', 'cd', 'ef']);
  const emoji = '😀'.repeat(5); // each is 2 UTF-16 units
  const parts = chunkText(emoji, 3);
  for (const p of parts) {
    assert.ok(p.length <= 3);
    assert.ok(!/[\ud800-\udbff]$/.test(p), 'chunk must not end with a lone high surrogate');
  }
  assert.equal(parts.join(''), emoji);
  const thai = 'สวัสดีครับ'.repeat(500);
  const big = chunkText(thai, 2000);
  assert.ok(big.every((p) => p.length > 0 && p.length <= 2000));
  assert.equal(big.join(''), thai);
});

test('SPECIAL_KEYS: well-formed, host-injectable, accepted by the host validator', async () => {
  const { SPECIAL_KEYS, specialKeysFor } = await load();
  const CODE_RE = /^[A-Za-z0-9]{1,32}$/; // src/renderer/panel/validate.js sanitizeInput (combo)
  const ids = new Set();
  for (const k of SPECIAL_KEYS) {
    assert.ok(typeof k.id === 'string' && k.id && !ids.has(k.id), `unique id ${k.id}`);
    ids.add(k.id);
    assert.ok(typeof k.label === 'string' && k.label.length > 0);
    assert.ok(Array.isArray(k.codes) && k.codes.length >= 1 && k.codes.length <= 8, `${k.id} codes`);
    assert.ok(k.hosts.length > 0 && k.hosts.every((h) => h === 'windows' || h === 'macos'), `${k.id} hosts`);
    for (const code of k.codes) {
      assert.ok(CODE_RE.test(code), `${k.id}: ${code} passes the host validator`);
      for (const os of k.hosts) {
        const native = keymap.lookup(code, os === 'windows' ? 'win32' : 'darwin');
        assert.ok(native !== null && native !== undefined, `${k.id}: ${code} injectable on ${os}`);
      }
    }
    assert.ok(Object.isFrozen(k) && Object.isFrozen(k.codes));
  }
  // Ctrl+Alt+Del is deliberately absent (cannot be injected; see keys.js).
  assert.ok(!SPECIAL_KEYS.some((k) => k.codes.includes('Delete') && k.codes.includes('AltLeft') && k.codes.includes('ControlLeft')));
  for (const id of ['win', 'win-r', 'win-d', 'alt-tab', 'alt-f4', 'ctrl-shift-esc', 'printscreen']) assert.ok(ids.has(id), id);
  for (const id of ['cmd-space', 'cmd-tab', 'cmd-q', 'cmd-opt-esc', 'cmd-shift-3', 'cmd-shift-4', 'ctrl-up']) assert.ok(ids.has(id), id);

  assert.ok(specialKeysFor('macos').every((k) => k.hosts.includes('macos')));
  assert.ok(specialKeysFor('windows').every((k) => k.hosts.includes('windows')));
  assert.deepEqual(specialKeysFor('linux'), specialKeysFor('windows'));
});
