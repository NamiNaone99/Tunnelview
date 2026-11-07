'use strict';
/*
 * Unit tests for src/renderer/viewer/input.js keyboard handling (cross-OS AltGr / Option fixes,
 * lock-state resync). The real InputController is driven through a minimal fake DOM: window /
 * document / stage / sink are plain EventTargets and keyboard events are Event objects carrying
 * the KeyboardEvent fields input.js reads. No real input is ever injected anywhere.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const P = require('../src/shared/protocol');

class FakeEl extends EventTarget {
  constructor() {
    super();
    this.style = {};
    this.value = '';
    this.classList = { toggle() {}, add() {}, remove() {}, contains: () => false };
  }

  focus() {}

  setPointerCapture() {}

  getBoundingClientRect() { return { left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500 }; }
}

const win = new EventTarget();
win.TunnelviewProtocol = P;
win.innerWidth = 1000;
win.innerHeight = 500;
globalThis.window = win;
globalThis.TunnelviewProtocol = P;
globalThis.document = Object.assign(new EventTarget(), {
  hasFocus: () => true, activeElement: null, hidden: false, body: {}, documentElement: {},
});
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const load = () => import('../src/renderer/viewer/input.js');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** KeyboardEvent-like Event. mods = getModifierState() answers; noMods → no getModifierState. */
function kev(type, code, key, o = {}) {
  const e = new Event(type, { cancelable: true });
  const mods = o.mods || {};
  const props = {
    code: { value: code },
    key: { value: key },
    repeat: { value: !!o.repeat },
    keyCode: { value: o.keyCode ?? 0 },
    isComposing: { value: !!o.isComposing },
    ctrlKey: { value: !!o.ctrlKey },
    altKey: { value: !!o.altKey },
    shiftKey: { value: !!o.shiftKey },
    metaKey: { value: !!o.metaKey },
    timeStamp: { value: o.ts ?? 1000 },
  };
  if (!o.noMods) props.getModifierState = { value: (m) => !!mods[m] };
  Object.defineProperties(e, props);
  return e;
}

const down = (code, key, o) => win.dispatchEvent(kev('keydown', code, key, o));
const up = (code, key, o) => win.dispatchEvent(kev('keyup', code, key, o));

function mouse(stage, type, button = 0, mods = {}) {
  const e = new Event(type, { cancelable: true });
  Object.defineProperties(e, {
    button: { value: button }, detail: { value: 1 }, clientX: { value: 100 }, clientY: { value: 100 },
    pointerType: { value: 'mouse' }, buttons: { value: type === 'mousedown' ? 1 : 0 },
    ctrlKey: { value: !!mods.ctrlKey }, shiftKey: { value: !!mods.shiftKey }, altKey: { value: !!mods.altKey }, metaKey: { value: !!mods.metaKey },
    getModifierState: { value: (m) => !!(mods.state && mods.state[m]) },
  });
  stage.dispatchEvent(e);
}

function wheel(stage, dy, mods = {}) {
  const e = new Event('wheel', { cancelable: true });
  Object.defineProperties(e, {
    deltaX: { value: 0 }, deltaY: { value: dy }, deltaMode: { value: 0 }, clientX: { value: 100 }, clientY: { value: 100 },
    ctrlKey: { value: !!mods.ctrlKey }, shiftKey: { value: !!mods.shiftKey }, altKey: { value: !!mods.altKey }, metaKey: { value: !!mods.metaKey },
  });
  stage.dispatchEvent(e);
  return e;
}

/** Text the OS input method inserted into the IME sink without a composition. */
function sinkInput(sink, data, inputType = 'insertText') {
  const e = new Event('input');
  Object.defineProperties(e, { data: { value: data }, inputType: { value: inputType }, isComposing: { value: false } });
  sink.dispatchEvent(e);
}

async function setup({ localOs, hostOs, swap }) {
  const { InputController } = await load();
  const sent = [];
  const stage = new FakeEl();
  const sink = new FakeEl();
  const video = { videoWidth: 1000, videoHeight: 500, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 500 }) };
  const ic = new InputController({
    stage, video, sink,
    send: (m) => { sent.push(m); return true; },
    getSwap: () => swap,
    getScale: () => 'fit',
    localOs,
    getHostOs: () => hostOs,
    isFullscreen: () => false,
    onExitFullscreen() {},
    onToolbarShortcut() {},
    onEscapeLocal: () => false,
  });
  ic.setEnabled(true);
  const take = () => sent.splice(0).map((m) => (m.t === 'txt' ? `txt:${m.text}` : m.t === 'kd' || m.t === 'ku' ? `${m.t}:${m.code}` : m.t));
  return { ic, sent, stage, sink, take };
}

// AltGr on Windows = synthetic ControlLeft keydown + AltRight keydown with key 'AltGraph'.
const ALTGR_MODS = { AltGraph: true, Control: true, Alt: true };
function altGrDown(ts = 1000) {
  down('ControlLeft', 'Control', { ts, ctrlKey: true, mods: { Control: true } });
  down('AltRight', 'AltGraph', { ts, ctrlKey: true, altKey: true, mods: ALTGR_MODS });
}
function altGrUp() {
  up('ControlLeft', 'Control', { mods: { AltGraph: true } });
  up('AltRight', 'AltGraph');
}

test('isPrintableKey', async () => {
  const { isPrintableKey } = await load();
  for (const k of ['@', '€', 'ł', '{', ' ', '😀', 'é']) assert.equal(isPrintableKey(k), true, k);
  for (const k of ['Dead', 'Enter', 'AltGraph', '', '\t', '\u0000', undefined, 'ab']) assert.equal(isPrintableKey(k), false, String(k));
});

test('Windows viewer → Mac host: AltGr characters are typed as txt, never ⌘⌥<key>', async () => {
  const { ic, take } = await setup({ localOs: 'windows', hostOs: 'macos', swap: true });
  try {
    altGrDown();
    assert.deepEqual(take(), [], 'neither the synthetic Ctrl nor AltGr reaches the Mac');
    const at = kev('keydown', 'KeyQ', '@', { ctrlKey: true, altKey: true, mods: ALTGR_MODS });
    win.dispatchEvent(at);
    assert.equal(at.defaultPrevented, true, 'not also typed into the IME sink (no duplicate txt)');
    down('KeyW', 'ł', { ctrlKey: true, altKey: true, mods: ALTGR_MODS }); // Polish AltGr+W (⌘⌥W would close all windows)
    up('KeyQ', 'q', { mods: ALTGR_MODS });
    up('KeyW', 'w', { mods: ALTGR_MODS });
    assert.deepEqual(take(), ['txt:@', 'txt:ł']);
    // Auto-repeat while AltGr is held: Windows repeats the synthetic Ctrl and AltRight too.
    down('ControlLeft', 'Control', { repeat: true, mods: ALTGR_MODS });
    down('AltRight', 'AltGraph', { repeat: true, mods: ALTGR_MODS });
    // Dead keys come back through the IME sink (default action kept); named keys still go as plain kd.
    const dead = kev('keydown', 'BracketRight', 'Dead', { mods: ALTGR_MODS });
    win.dispatchEvent(dead);
    assert.equal(dead.defaultPrevented, false, 'the dead key must still reach the input method');
    down('ArrowLeft', 'ArrowLeft', { mods: ALTGR_MODS });
    up('ArrowLeft', 'ArrowLeft', { mods: ALTGR_MODS });
    assert.deepEqual(take(), ['kd:ArrowLeft', 'ku:ArrowLeft']);
    altGrUp();
    assert.deepEqual(take(), [], 'their releases are dropped too');

    // A real Ctrl afterwards still works (and is swapped to ⌘): Ctrl+C within the hold window.
    down('ControlLeft', 'Control', { ts: 5000, ctrlKey: true });
    assert.deepEqual(take(), [], 'held back briefly');
    down('KeyC', 'c', { ts: 5005, ctrlKey: true });
    up('KeyC', 'c', { ctrlKey: true });
    up('ControlLeft', 'Control');
    assert.deepEqual(take(), ['kd:MetaLeft', 'kd:KeyC', 'ku:KeyC', 'ku:MetaLeft']);
  } finally {
    ic.destroy();
  }
});

test('Windows viewer → Mac host: a lone Ctrl is flushed by timer, by a quick release and before a click', async () => {
  const { ic, take, stage } = await setup({ localOs: 'windows', hostOs: 'macos', swap: true });
  try {
    down('ControlLeft', 'Control', { ctrlKey: true });
    assert.deepEqual(take(), []);
    await wait(60);
    assert.deepEqual(take(), ['kd:MetaLeft'], 'timer flush');
    up('ControlLeft', 'Control');
    assert.deepEqual(take(), ['ku:MetaLeft']);

    down('ControlLeft', 'Control', { ctrlKey: true });
    up('ControlLeft', 'Control');
    assert.deepEqual(take(), ['kd:MetaLeft', 'ku:MetaLeft'], 'quick tap');

    down('ControlLeft', 'Control', { ctrlKey: true });
    mouse(stage, 'mousedown');
    mouse(stage, 'mouseup');
    up('ControlLeft', 'Control');
    assert.deepEqual(take(), ['kd:MetaLeft', 'mm', 'md', 'mm', 'mu', 'ku:MetaLeft'], 'Ctrl-click keeps its modifier');

    // Ctrl then AltGr from a much later timestamp is a real Ctrl+Alt, not AltGr.
    down('ControlLeft', 'Control', { ts: 100, ctrlKey: true });
    down('AltRight', 'AltGraph', { ts: 200, ctrlKey: true, altKey: true, mods: ALTGR_MODS });
    assert.deepEqual(take(), ['kd:MetaLeft']);
    up('AltRight', 'AltGraph');
    up('ControlLeft', 'Control');
    assert.deepEqual(take(), ['ku:MetaLeft']);

    // Blur forgets held / synthetic state (release-all goes out).
    altGrDown();
    win.dispatchEvent(new Event('blur'));
    assert.deepEqual(take(), ['release-all']);
    down('ControlLeft', 'Control', { ts: 9000, ctrlKey: true });
    down('KeyV', 'v', { ts: 9001, ctrlKey: true });
    assert.deepEqual(take(), ['kd:MetaLeft', 'kd:KeyV'], 'Ctrl is not mistaken for the old synthetic one');
  } finally {
    ic.destroy();
  }
});

test('Windows viewer → Windows host: Ctrl and AltGr are forwarded unchanged', async () => {
  const { ic, take } = await setup({ localOs: 'windows', hostOs: 'windows', swap: false });
  try {
    altGrDown();
    down('KeyQ', '@', { mods: ALTGR_MODS });
    altGrUp();
    up('KeyQ', 'q');
    assert.deepEqual(take(), ['kd:ControlLeft', 'kd:AltRight', 'kd:KeyQ', 'ku:ControlLeft', 'ku:AltRight', 'ku:KeyQ']);
  } finally {
    ic.destroy();
  }
});

test('Mac viewer → Windows host: Option dead keys never reach Windows as a lone Alt tap', async () => {
  const { ic, take, sink, stage } = await setup({ localOs: 'macos', hostOs: 'windows', swap: true });
  try {
    // ⌥E (dead acute) then E → é
    down('AltLeft', 'Alt', { altKey: true });
    down('KeyE', 'Dead', { altKey: true, keyCode: 229 });
    up('KeyE', 'e', { altKey: true });
    up('AltLeft', 'Alt');
    sink.dispatchEvent(new Event('compositionstart'));
    const end = new Event('compositionend');
    Object.defineProperty(end, 'data', { value: 'é' });
    sink.dispatchEvent(end);
    assert.deepEqual(take(), ['txt:é']);

    // Composition starting while ⌥ is held also counts.
    down('AltRight', 'Alt', { altKey: true });
    sink.dispatchEvent(new Event('compositionstart'));
    up('AltRight', 'Alt');
    assert.deepEqual(take(), []);

    // A dead key reported without keyCode 229 under a deferred ⌥ (⌥U = umlaut) is not forwarded either.
    down('AltLeft', 'Alt', { altKey: true });
    down('KeyU', 'Dead', { altKey: true, keyCode: 85 });
    up('KeyU', 'u', { altKey: true });
    up('AltLeft', 'Alt');
    assert.deepEqual(take(), []);

    // A deliberate Alt tap still works.
    down('AltLeft', 'Alt', { altKey: true });
    up('AltLeft', 'Alt');
    assert.deepEqual(take(), ['kd:AltLeft', 'ku:AltLeft']);

    // Alt + a forwarded key: Alt goes first.
    down('AltLeft', 'Alt', { altKey: true });
    down('F4', 'F4', { altKey: true, keyCode: 115 });
    up('F4', 'F4', { altKey: true });
    up('AltLeft', 'Alt');
    assert.deepEqual(take(), ['kd:AltLeft', 'kd:F4', 'ku:F4', 'ku:AltLeft']);

    // Alt-click.
    down('AltLeft', 'Alt', { altKey: true });
    mouse(stage, 'mousedown');
    mouse(stage, 'mouseup');
    up('AltLeft', 'Alt');
    assert.deepEqual(take(), ['kd:AltLeft', 'mm', 'md', 'mm', 'mu', 'ku:AltLeft']);

    // Blur drops a held Option without sending anything for it later.
    down('AltLeft', 'Alt', { altKey: true });
    win.dispatchEvent(new Event('blur'));
    up('AltLeft', 'Alt');
    assert.deepEqual(take(), ['release-all']);
  } finally {
    ic.destroy();
  }
});

test('Mac viewer → Mac host: Option is forwarded immediately', async () => {
  const { ic, take } = await setup({ localOs: 'macos', hostOs: 'macos', swap: false });
  try {
    down('AltLeft', 'Alt', { altKey: true });
    assert.deepEqual(take(), ['kd:AltLeft']);
    up('AltLeft', 'Alt');
    assert.deepEqual(take(), ['ku:AltLeft']);
  } finally {
    ic.destroy();
  }
});

test('kd carries the viewer lock state (caps + num; Mac viewers always num:true)', async () => {
  {
    const { ic, sent } = await setup({ localOs: 'windows', hostOs: 'windows', swap: false });
    try {
      down('KeyA', 'A', { mods: { CapsLock: true, NumLock: false } });
      down('Numpad1', 'End', { mods: { NumLock: false }, repeat: true });
      down('CapsLock', 'CapsLock', { mods: { CapsLock: true } });
      down('KeyB', 'b', { noMods: true });
      up('KeyA', 'a', { mods: { CapsLock: true } });
      const kd = sent.filter((m) => m.t === 'kd');
      assert.deepEqual(kd[0], { t: 'kd', code: 'KeyA', key: 'A', rep: false, locks: { caps: true, num: false } });
      assert.deepEqual(kd[1].locks, { caps: false, num: false });
      assert.equal(kd[1].rep, true);
      assert.equal('locks' in kd[2], false, 'lock keys report their post-toggle state: omitted');
      assert.equal('locks' in kd[3], false, 'no getModifierState → no locks');
      assert.equal('locks' in sent.find((m) => m.t === 'ku'), false, 'ku never carries locks');
    } finally {
      ic.destroy();
    }
  }
  {
    const { ic, sent } = await setup({ localOs: 'macos', hostOs: 'windows', swap: true });
    try {
      down('KeyA', 'a', { mods: { CapsLock: false, NumLock: false } });
      assert.deepEqual(sent.find((m) => m.t === 'kd').locks, { caps: false, num: true });
    } finally {
      ic.destroy();
    }
  }
  {
    // A held-back modifier keeps the lock state of its own keydown.
    const { ic, sent } = await setup({ localOs: 'windows', hostOs: 'macos', swap: true });
    try {
      down('ControlLeft', 'Control', { ctrlKey: true, mods: { CapsLock: true, NumLock: true } });
      down('KeyC', 'c', { ctrlKey: true, mods: { CapsLock: true, NumLock: true } });
      assert.deepEqual(sent.filter((m) => m.t === 'kd').map((m) => [m.code, m.locks]),
        [['MetaLeft', { caps: true, num: true }], ['KeyC', { caps: true, num: true }]]);
    } finally {
      ic.destroy();
    }
  }
});

test('Windows viewer → Mac host: an AltGr dead key composes with the next key (Windows sends no composition events)', async () => {
  const { ic, take, sink } = await setup({ localOs: 'windows', hostOs: 'macos', swap: true });
  try {
    // Hungarian AltGr+1 = dead '~', then Space → '~' (only as the next key's text input).
    altGrDown();
    const dead = kev('keydown', 'Digit1', 'Dead', { keyCode: 49, ctrlKey: true, altKey: true, mods: ALTGR_MODS });
    win.dispatchEvent(dead);
    assert.equal(dead.defaultPrevented, false, 'the dead key reaches Windows');
    up('Digit1', '1', { mods: ALTGR_MODS });
    altGrUp();
    const sp = kev('keydown', 'Space', ' ', { keyCode: 32 });
    win.dispatchEvent(sp);
    assert.equal(sp.defaultPrevented, false, 'the next key is left to Windows: it types the composed character');
    sinkInput(sink, '~');
    up('Space', ' ');
    assert.deepEqual(take(), ['txt:~'], 'no kd/ku for the dead key or Space');

    // Dead ~ then a: one composed character; the following keys are forwarded normally again.
    altGrDown(2000);
    down('Digit1', 'Dead', { keyCode: 49, ctrlKey: true, altKey: true, mods: ALTGR_MODS });
    up('Digit1', '1', { mods: ALTGR_MODS });
    altGrUp();
    down('KeyA', 'a', { keyCode: 65 });
    sinkInput(sink, 'ã');
    up('KeyA', 'a');
    down('KeyB', 'b', { keyCode: 66 });
    up('KeyB', 'b');
    assert.deepEqual(take(), ['txt:ã', 'kd:KeyB', 'ku:KeyB']);

    // Shift between the dead key and the letter is still forwarded; the letter is composed.
    altGrDown(3000);
    down('Digit1', 'Dead', { keyCode: 49, ctrlKey: true, altKey: true, mods: ALTGR_MODS });
    altGrUp();
    down('ShiftLeft', 'Shift', { shiftKey: true });
    down('KeyA', 'A', { keyCode: 65, shiftKey: true });
    sinkInput(sink, 'Ã');
    up('KeyA', 'A', { shiftKey: true });
    up('ShiftLeft', 'Shift');
    assert.deepEqual(take(), ['kd:ShiftLeft', 'txt:Ã', 'ku:ShiftLeft']);

    // A named key after the dead key drops the accent and is forwarded; nothing stays pending.
    altGrDown(4000);
    down('Digit1', 'Dead', { keyCode: 49, ctrlKey: true, altKey: true, mods: ALTGR_MODS });
    altGrUp();
    const enter = kev('keydown', 'Enter', 'Enter', { keyCode: 13 });
    win.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, true);
    up('Enter', 'Enter');
    down('KeyC', 'c', { keyCode: 67 });
    up('KeyC', 'c');
    assert.deepEqual(take(), ['kd:Enter', 'ku:Enter', 'kd:KeyC', 'ku:KeyC']);

    // A Ctrl shortcut after the dead key is a shortcut (⌘C on the Mac), not text.
    altGrDown(5000);
    down('Digit1', 'Dead', { keyCode: 49, ctrlKey: true, altKey: true, mods: ALTGR_MODS });
    altGrUp();
    down('ControlLeft', 'Control', { ts: 6000, ctrlKey: true });
    down('KeyC', 'c', { ts: 6001, ctrlKey: true, keyCode: 67 });
    up('KeyC', 'c', { ctrlKey: true });
    up('ControlLeft', 'Control');
    assert.deepEqual(take(), ['kd:MetaLeft', 'kd:KeyC', 'ku:KeyC', 'ku:MetaLeft']);

    // Dead key pressed twice: Windows types it at once ('~~'); the next key is a normal key again.
    altGrDown(7000);
    down('Digit1', 'Dead', { keyCode: 49, ctrlKey: true, altKey: true, mods: ALTGR_MODS });
    down('Digit1', 'Dead', { keyCode: 49, ctrlKey: true, altKey: true, mods: ALTGR_MODS });
    sinkInput(sink, '~~');
    altGrUp();
    down('KeyD', 'd', { keyCode: 68 });
    up('KeyD', 'd');
    assert.deepEqual(take(), ['txt:~~', 'kd:KeyD', 'ku:KeyD']);

    // Esc, a composition, and blur all cancel a pending dead key.
    const cancels = [
      () => { down('Escape', 'Escape', { keyCode: 27 }); up('Escape', 'Escape'); },
      () => {
        sink.dispatchEvent(new Event('compositionstart'));
        const end = new Event('compositionend');
        Object.defineProperty(end, 'data', { value: '' });
        sink.dispatchEvent(end);
      },
      () => win.dispatchEvent(new Event('blur')),
    ];
    for (const cancel of cancels) {
      altGrDown(8000);
      down('Digit1', 'Dead', { keyCode: 49, ctrlKey: true, altKey: true, mods: ALTGR_MODS });
      altGrUp();
      cancel();
      take();
      down('KeyE', 'e', { keyCode: 69 });
      up('KeyE', 'e');
      assert.deepEqual(take(), ['kd:KeyE', 'ku:KeyE']);
    }
  } finally {
    ic.destroy();
  }
});

test('Windows viewer → Windows host: dead keys are physical keys (the host layout composes)', async () => {
  const { ic, take } = await setup({ localOs: 'windows', hostOs: 'windows', swap: false });
  try {
    altGrDown();
    down('Digit1', 'Dead', { keyCode: 49, ctrlKey: true, altKey: true, mods: ALTGR_MODS });
    up('Digit1', '1', { mods: ALTGR_MODS });
    altGrUp();
    down('Space', ' ', { keyCode: 32 });
    up('Space', ' ');
    assert.deepEqual(take(), ['kd:ControlLeft', 'kd:AltRight', 'kd:Digit1', 'ku:Digit1', 'ku:ControlLeft', 'ku:AltRight', 'kd:Space', 'ku:Space']);
  } finally {
    ic.destroy();
  }
});

test('modifiers held through a focus loss are pressed again before the key / click / wheel that uses them', async () => {
  {
    // Mac viewer → Windows host (⌘ = Ctrl): ⌘Tab away and back while holding ⌘, then C → Ctrl+C.
    const { ic, take, stage } = await setup({ localOs: 'macos', hostOs: 'windows', swap: true });
    try {
      down('MetaLeft', 'Meta', { metaKey: true });
      win.dispatchEvent(new Event('blur'));
      assert.deepEqual(take(), ['kd:ControlLeft', 'release-all']);
      down('KeyC', 'c', { metaKey: true });
      down('KeyV', 'v', { metaKey: true });
      assert.deepEqual(take(), ['kd:ControlLeft', 'kd:KeyC', 'kd:KeyV'], 'pressed once, before the first key');
      // Released with the right ⌘ key (not tracked): the host's Ctrl goes up anyway, and the keys
      // macOS never sends keyup for (held under ⌘) with it.
      up('MetaRight', 'Meta');
      assert.deepEqual(take(), ['ku:ControlLeft', 'ku:KeyC', 'ku:KeyV']);
      down('KeyX', 'x');
      up('KeyX', 'x');
      assert.deepEqual(take(), ['kd:KeyX', 'ku:KeyX'], 'nothing re-pressed once released');

      // ⌥-click after a focus loss: Option goes down first.
      win.dispatchEvent(new Event('blur'));
      take();
      mouse(stage, 'mousedown', 0, { altKey: true });
      mouse(stage, 'mouseup', 0, { altKey: true });
      up('AltLeft', 'Alt');
      assert.deepEqual(take(), ['kd:AltLeft', 'mm', 'md', 'mm', 'mu', 'ku:AltLeft']);

      // Wheel: Shift is re-pressed (horizontal scroll); Control never is (touchpad pinch sets ctrlKey).
      const w = wheel(stage, 100, { shiftKey: true, ctrlKey: true });
      assert.equal(w.defaultPrevented, true);
      await wait(10);
      up('ShiftLeft', 'Shift');
      assert.deepEqual(take(), ['kd:ShiftLeft', 'wh', 'ku:ShiftLeft'], '(pointer already at that spot: no mm)');
    } finally {
      ic.destroy();
    }
  }
  {
    // Windows viewer → Mac host: a real Ctrl held through a focus loss becomes ⌘ again …
    const { ic, take, stage } = await setup({ localOs: 'windows', hostOs: 'macos', swap: true });
    try {
      win.dispatchEvent(new Event('blur'));
      take();
      down('KeyC', 'c', { ctrlKey: true, ts: 100 });
      up('KeyC', 'c', { ctrlKey: true });
      up('ControlLeft', 'Control');
      assert.deepEqual(take(), ['kd:MetaLeft', 'kd:KeyC', 'ku:KeyC', 'ku:MetaLeft']);
      // … but AltGr's synthetic Ctrl and AltGr itself are never re-created.
      win.dispatchEvent(new Event('blur'));
      take();
      down('AltRight', 'AltGraph', { repeat: true, ctrlKey: true, altKey: true, mods: ALTGR_MODS });
      down('ArrowLeft', 'ArrowLeft', { ctrlKey: true, altKey: true, mods: ALTGR_MODS });
      up('ArrowLeft', 'ArrowLeft', { ctrlKey: true, altKey: true, mods: ALTGR_MODS });
      down('KeyQ', '@', { ctrlKey: true, altKey: true, mods: ALTGR_MODS });
      mouse(stage, 'mousedown', 0, { ctrlKey: true, altKey: true, state: { AltGraph: true } });
      mouse(stage, 'mouseup', 0, { ctrlKey: true, altKey: true, state: { AltGraph: true } });
      assert.deepEqual(take(), ['kd:ArrowLeft', 'ku:ArrowLeft', 'txt:@', 'mm', 'md', 'mm', 'mu']);
      altGrUp();
    } finally {
      ic.destroy();
    }
  }
  {
    // Mac viewer → Windows host: an Option still deferred is not duplicated by the sync.
    const { ic, take, stage } = await setup({ localOs: 'macos', hostOs: 'windows', swap: true });
    try {
      down('AltLeft', 'Alt', { altKey: true });
      mouse(stage, 'mousedown', 0, { altKey: true });
      mouse(stage, 'mouseup', 0, { altKey: true });
      up('AltLeft', 'Alt');
      assert.deepEqual(take(), ['kd:AltLeft', 'mm', 'md', 'mm', 'mu', 'ku:AltLeft']);
    } finally {
      ic.destroy();
    }
  }
});

test('a wheel (or click) over the inactive viewer window never presses modifiers held for another app', async () => {
  const focused = globalThis.document.hasFocus;
  for (const [localOs, hostOs, swap] of [['macos', 'windows', true], ['windows', 'windows', false], ['macos', 'macos', false]]) {
    const { ic, take, stage } = await setup({ localOs, hostOs, swap });
    try {
      win.dispatchEvent(new Event('blur'));
      assert.deepEqual(take(), ['release-all']);
      // Another app is active; Shift / ⌘ / Alt are held there while the pointer scrolls over the viewer.
      globalThis.document.hasFocus = () => false;
      wheel(stage, 100, { shiftKey: true });
      wheel(stage, 100, { shiftKey: true, metaKey: true, altKey: true });
      await wait(10);
      assert.deepEqual(take(), ['mm', 'wh'], `${localOs}→${hostOs}: no kd — its keyup would go to the other app`);
      mouse(stage, 'mousedown', 0, { shiftKey: true, metaKey: true });
      mouse(stage, 'mouseup', 0, { shiftKey: true, metaKey: true });
      assert.deepEqual(take(), ['mm', 'md', 'mm', 'mu'], 'a click without focus presses nothing either');

      // Back in the viewer (the keys were released in the other app): W is just W, not Ctrl+W.
      globalThis.document.hasFocus = focused;
      down('KeyW', 'w');
      up('KeyW', 'w');
      assert.deepEqual(take(), ['kd:KeyW', 'ku:KeyW']);

      // With focus the re-press after a focus loss is unchanged.
      win.dispatchEvent(new Event('blur'));
      take();
      wheel(stage, 50, { shiftKey: true });
      await wait(10);
      up('ShiftLeft', 'Shift');
      assert.deepEqual(take(), ['kd:ShiftLeft', 'wh', 'ku:ShiftLeft']);
    } finally {
      globalThis.document.hasFocus = focused;
      ic.destroy();
    }
  }
});

test('disabling input (e.g. connection recovering) drops held-back modifiers instead of sending them late', async () => {
  {
    const { ic, take } = await setup({ localOs: 'windows', hostOs: 'macos', swap: true });
    try {
      down('KeyA', 'a');
      down('ControlLeft', 'Control', { ctrlKey: true }); // held back (AltGr check)
      ic.setEnabled(false);
      assert.deepEqual(take(), ['kd:KeyA', 'release-all']);
      await wait(60);
      up('ControlLeft', 'Control');
      up('KeyA', 'a');
      down('KeyB', 'b', { ctrlKey: true });
      assert.deepEqual(take(), [], 'nothing is sent while disabled; the held Ctrl never goes out');
      ic.setEnabled(true);
      down('KeyD', 'd');
      assert.deepEqual(take(), ['kd:KeyD']);
    } finally {
      ic.destroy();
    }
  }
  {
    const { ic, take } = await setup({ localOs: 'macos', hostOs: 'windows', swap: true });
    try {
      down('AltLeft', 'Alt', { altKey: true }); // deferred Option
      ic.setEnabled(false);
      up('AltLeft', 'Alt');
      assert.deepEqual(take(), ['release-all'], 'no late Alt tap');
      ic.setEnabled(true);
      down('KeyA', 'a');
      assert.deepEqual(take(), ['kd:KeyA']);
    } finally {
      ic.destroy();
    }
  }
});
