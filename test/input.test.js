'use strict';
/*
 * Tests for src/main/input (facade, Windows + macOS backends) and src/main/native/changecount.js.
 * SAFETY: nothing here may inject real input. Injectors always get a fake backend; the win32/darwin
 * backends are always built on a fake native layer. The only real native calls are side-effect-free
 * (declaring functions, sizeof, GetClipboardSequenceNumber) and run on Windows only.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const PROTOCOL = require('../src/shared/protocol');
const input = require('../src/main/input');
const win32 = require('../src/main/input/win32');
const darwin = require('../src/main/input/darwin');

const { validate, printableChar, segmentText, displayRect, mapPoint } = input._internals;
const I = PROTOCOL.INPUT;

// ---------------------------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------------------------

function fakeBackend({ available = true, reason = null, throwOn = null } = {}) {
  const calls = [];
  const b = {
    calls,
    checkResult: { available, reason },
    check() { calls.push(['check']); return b.checkResult; },
    moveTo(x, y) { if (throwOn === 'moveTo') throw new Error('boom'); calls.push(['moveTo', x, y]); },
    button(btn, down, x, y, n) { calls.push(['button', btn, down, x, y, n]); },
    scroll(dx, dy) { calls.push(['scroll', dx, dy]); },
    key(code, down, rep) {
      if (typeof throwOn === 'function' && throwOn(code, down)) throw new Error('key boom');
      calls.push(['key', code, down, rep]);
      return true;
    },
    text(s) { calls.push(['text', s]); },
    reset() { calls.push(['reset']); },
  };
  b.inj = () => calls.filter((c) => c[0] !== 'check');
  return b;
}

/** Electron-like screen: primary 1920×1080 @1.0, secondary 2560×1440 physical @1.5 to the right. */
function fakeScreen() {
  const listeners = {};
  const displays = [
    { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
    { id: 2, bounds: { x: 1920, y: 0, width: 1707, height: 960 }, scaleFactor: 1.5 },
  ];
  const physical = { 1: { x: 0, y: 0, width: 1920, height: 1080 }, 2: { x: 1920, y: -100, width: 2560, height: 1440 } };
  return {
    displays,
    physical,
    listeners,
    getPrimaryDisplay: () => displays[0],
    getAllDisplays: () => displays,
    dipToScreenRect(win, rect) {
      assert.equal(win, null);
      const d = displays.find((x) => x.bounds.x === rect.x && x.bounds.y === rect.y);
      return d ? { ...physical[d.id] } : { ...rect };
    },
    dipToScreenPoint(p) {
      const d = displays.find((x) => p.x >= x.bounds.x && p.x < x.bounds.x + x.bounds.width && p.y >= x.bounds.y && p.y < x.bounds.y + x.bounds.height) || displays[0];
      const ph = physical[d.id];
      return { x: Math.round(ph.x + (p.x - d.bounds.x) * d.scaleFactor), y: Math.round(ph.y + (p.y - d.bounds.y) * d.scaleFactor) };
    },
    on(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    emit(ev) { for (const fn of listeners[ev] || []) fn(); },
  };
}

function makeInjector(platform, opts = {}) {
  const backend = opts.backend || fakeBackend();
  let t = 1000;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const inj = input._createInjector({ platform, backend, screen: opts.screen === undefined ? fakeScreen() : opts.screen, now: clock.now, log: () => {} });
  return { inj, backend, clock };
}

// ---------------------------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------------------------

test('validate: rejects non-objects and unknown types', () => {
  for (const v of [null, undefined, 1, 'mm', [], [{ t: 'mm' }], { t: 5 }, { t: 'nope' }, { x: 0.5 }]) {
    assert.equal(validate(v), null, JSON.stringify(v));
  }
});

test('validate: mouse move clamps and requires finite numbers', () => {
  assert.deepEqual(validate({ t: 'mm', x: 0.25, y: 0.75 }), { t: 'mm', x: 0.25, y: 0.75 });
  assert.deepEqual(validate({ t: 'mm', x: -3, y: 9 }), { t: 'mm', x: 0, y: 1 });
  for (const bad of [{ x: NaN, y: 0 }, { x: Infinity, y: 0 }, { x: '0.5', y: 0.5 }, { y: 0.5 }, { x: 0.5, y: null }]) {
    assert.equal(validate({ t: 'mm', ...bad }), null, JSON.stringify(bad));
  }
});

test('validate: mouse buttons', () => {
  assert.deepEqual(validate({ t: 'md', b: 0, x: 0.5, y: 0.5, n: 2 }), { t: 'md', b: 0, x: 0.5, y: 0.5, n: 2 });
  assert.equal(validate({ t: 'md', b: 0, x: 0.5, y: 0.5 }).n, 1);
  assert.equal(validate({ t: 'md', b: 4, x: 0.5, y: 0.5, n: 0 }).n, 1);
  assert.equal(validate({ t: 'mu', b: 2, x: 0.5, y: 0.5, n: 9 }).n, 3);
  assert.equal(validate({ t: 'md', b: 1, x: 0.5, y: 0.5, n: 2.9 }).n, 2);
  for (const b of [-1, 5, 1.5, '0', null, undefined]) assert.equal(validate({ t: 'md', b, x: 0, y: 0 }), null, String(b));
  assert.equal(validate({ t: 'md', b: 0, x: 0, y: 0, n: '2' }), null);
  assert.equal(validate({ t: 'md', b: 0, x: 0, y: 0, n: NaN }), null);
});

test('validate: wheel', () => {
  assert.deepEqual(validate({ t: 'wh', dx: 0, dy: 40 }), { t: 'wh', dx: 0, dy: 40 });
  assert.deepEqual(validate({ t: 'wh', dy: -3 }), { t: 'wh', dx: 0, dy: -3 });
  assert.deepEqual(validate({ t: 'wh', dx: 1e9, dy: -1e9 }), { t: 'wh', dx: 20000, dy: -20000 });
  assert.equal(validate({ t: 'wh', dx: 'x', dy: 0 }), null);
  assert.equal(validate({ t: 'wh', dx: 0, dy: Infinity }), null);
});

test('validate: keys', () => {
  assert.deepEqual(validate({ t: 'kd', code: 'KeyA', key: 'a', rep: true }), { t: 'kd', code: 'KeyA', key: 'a', rep: true });
  assert.deepEqual(validate({ t: 'ku', code: 'KeyA', key: 'a', rep: true }), { t: 'ku', code: 'KeyA', key: 'a', rep: false });
  assert.deepEqual(validate({ t: 'kd', code: 'KeyA' }), { t: 'kd', code: 'KeyA', key: '', rep: false });
  assert.deepEqual(validate({ t: 'kd', code: '', key: 'é' }), { t: 'kd', code: '', key: 'é', rep: false });
  for (const code of ['Key-A', 'Key A', '../x', 'A'.repeat(33), 5, null, undefined, '__proto__']) {
    assert.equal(validate({ t: 'kd', code, key: 'a' }), null, String(code));
  }
  // malformed `key` is ignored (only used for the text fallback); the key press itself survives
  assert.deepEqual(validate({ t: 'kd', code: 'KeyA', key: 'x'.repeat(33) }), { t: 'kd', code: 'KeyA', key: '', rep: false });
  assert.deepEqual(validate({ t: 'kd', code: 'KeyA', key: 7 }), { t: 'kd', code: 'KeyA', key: '', rep: false });
  assert.equal(validate({ t: 'kd', code: 'KeyA', rep: 'yes' }), null);
});

test('validate: optional kd.locks (only the booleans; malformed → field dropped, event kept)', () => {
  assert.deepEqual(validate({ t: 'kd', code: 'KeyA', key: 'a', locks: { caps: true } }),
    { t: 'kd', code: 'KeyA', key: 'a', rep: false, locks: { caps: true } });
  assert.deepEqual(validate({ t: 'kd', code: 'Numpad1', key: '1', locks: { caps: false, num: true, extra: 1 } }).locks,
    { caps: false, num: true });
  for (const locks of [null, 'caps', [], [true], { caps: 'yes' }, { num: true }, { caps: true, num: 1 }, { caps: 1 }]) {
    assert.deepEqual(validate({ t: 'kd', code: 'KeyA', key: 'a', locks }), { t: 'kd', code: 'KeyA', key: 'a', rep: false }, JSON.stringify(locks));
  }
  // ku never carries it
  assert.deepEqual(validate({ t: 'ku', code: 'KeyA', key: 'a', locks: { caps: true } }), { t: 'ku', code: 'KeyA', key: 'a', rep: false });
  const v = validate(JSON.parse('{"t":"kd","code":"KeyA","locks":{"caps":true,"__proto__":{"evil":1}}}'));
  assert.deepEqual(Object.keys(v.locks), ['caps']);
  assert.equal(v.locks.evil, undefined);
});

test('validate: text and combo limits', () => {
  assert.deepEqual(validate({ t: 'txt', text: 'hi' }), { t: 'txt', text: 'hi' });
  assert.ok(validate({ t: 'txt', text: 'x'.repeat(I.MAX_TEXT) }));
  assert.equal(validate({ t: 'txt', text: 'x'.repeat(I.MAX_TEXT + 1) }), null);
  assert.equal(validate({ t: 'txt', text: '' }), null);
  assert.equal(validate({ t: 'txt', text: 5 }), null);
  assert.deepEqual(validate({ t: 'combo', codes: ['ControlLeft', 'KeyC'] }), { t: 'combo', codes: ['ControlLeft', 'KeyC'] });
  assert.ok(validate({ t: 'combo', codes: Array(6).fill('KeyA') }));
  assert.equal(validate({ t: 'combo', codes: Array(7).fill('KeyA') }), null);
  assert.equal(validate({ t: 'combo', codes: [] }), null);
  assert.equal(validate({ t: 'combo', codes: ['KeyA', ''] }), null);
  assert.equal(validate({ t: 'combo', codes: ['KeyA', 'bad code'] }), null);
  assert.equal(validate({ t: 'combo', codes: 'KeyA' }), null);
  assert.deepEqual(validate({ t: 'release-all', junk: 1 }), { t: 'release-all' });
});

test('validate: output contains only known fields (no prototype pollution carry-over)', () => {
  const evt = JSON.parse('{"t":"mm","x":0.5,"y":0.5,"__proto__":{"evil":1},"extra":2}');
  const v = validate(evt);
  assert.deepEqual(Object.keys(v).sort(), ['t', 'x', 'y']);
  assert.equal(v.evil, undefined);
  assert.equal({}.evil, undefined);
});

test('printableChar', () => {
  assert.equal(printableChar('a'), 'a');
  assert.equal(printableChar('é'), 'é');
  assert.equal(printableChar('😀'), '😀');
  for (const k of ['', 'Enter', 'Dead', 'ab', '\n', '\u007f', '\u0085', '\uD83D', 7, null]) assert.equal(printableChar(k), null, JSON.stringify(k));
});

test('segmentText: newlines/tabs become key presses, controls dropped', () => {
  assert.deepEqual(segmentText('a\r\nb\tc\rd\ne'), [
    { text: 'a' }, { code: 'Enter' }, { text: 'b' }, { code: 'Tab' }, { text: 'c' }, { code: 'Enter' },
    { text: 'd' }, { code: 'Enter' }, { text: 'e' },
  ]);
  assert.deepEqual(segmentText('x\u0000\u0007y\u009bz'), [{ text: 'xyz' }]);
  assert.deepEqual(segmentText('😀\uD800!'), [{ text: '😀�!' }]);
  assert.deepEqual(segmentText('\n'), [{ code: 'Enter' }]);
});

// ---------------------------------------------------------------------------------------------
// coordinate mapping math
// ---------------------------------------------------------------------------------------------

test('mapPoint (win32): integer physical pixels inside the rect', () => {
  const r = { x: 1920, y: -100, width: 2560, height: 1440, scaleFactor: 1.5 };
  assert.deepEqual(mapPoint('win32', r, 0, 0), { x: 1920, y: -100 });
  assert.deepEqual(mapPoint('win32', r, 1, 1), { x: 1920 + 2559, y: -100 + 1439 });
  assert.deepEqual(mapPoint('win32', r, 0.5, 0.5), { x: 1920 + 1280, y: -100 + 720 });
  // viewer pixel centre of the last column of a same-size video maps to the last pixel
  assert.equal(mapPoint('win32', r, 2559.5 / 2560, 0).x, 1920 + 2559);
});

test('mapPoint (darwin): points, last physical pixel reachable, never the next display', () => {
  const r = { x: -1440, y: 0, width: 1440, height: 900, scaleFactor: 2 };
  assert.deepEqual(mapPoint('darwin', r, 0, 0), { x: -1440, y: 0 });
  assert.deepEqual(mapPoint('darwin', r, 1, 1), { x: -1440 + 1439.5, y: 899.5 });
  assert.deepEqual(mapPoint('darwin', r, 0.5, 0.25), { x: -720, y: 225 });
  const r1 = { x: 0, y: 0, width: 1280, height: 800, scaleFactor: 1 };
  assert.deepEqual(mapPoint('darwin', r1, 1, 1), { x: 1279, y: 799 });
});

test('displayRect: Windows uses dipToScreenRect, macOS uses DIP bounds', () => {
  const scr = fakeScreen();
  assert.deepEqual(displayRect('win32', scr, scr.displays[1]), { x: 1920, y: -100, width: 2560, height: 1440, scaleFactor: 1.5 });
  assert.deepEqual(displayRect('darwin', scr, scr.displays[1]), { x: 1920, y: 0, width: 1707, height: 960, scaleFactor: 1.5 });
  // no screen module → scaled bounds fallback
  assert.deepEqual(displayRect('win32', null, { bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 1.5 }),
    { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1.5 });
  assert.equal(displayRect('win32', scr, { bounds: { x: 0, y: 0, width: 0, height: 10 } }), null);
  assert.equal(displayRect('darwin', scr, null), null);
});

/** Screen whose dipToScreenRect rounds outward like Chromium (2560 px @150 % → DIP 1707 → 2561). */
function outwardScreen() {
  const scr = fakeScreen();
  scr.dipToScreenRect = (win, r) => {
    const d = scr.displays.find((x) => x.bounds.x === r.x && x.bounds.y === r.y);
    const p = scr.physical[d.id];
    return { x: p.x, y: p.y, width: Math.ceil(d.bounds.width * d.scaleFactor), height: Math.ceil(d.bounds.height * d.scaleFactor) };
  };
  return scr;
}

/** backend.monitorRect over fakeScreen's physical rects (MONITOR_DEFAULTTONEAREST-like). */
function withMonitorRect(backend, scr, override) {
  backend.monitorRect = (pt) => {
    backend.calls.push(['monitorRect', pt]);
    if (override) return override(pt);
    const hit = Object.values(scr.physical).find((r) => pt.x >= r.x && pt.y >= r.y && pt.x < r.x + r.width && pt.y < r.y + r.height);
    return hit ? { ...hit } : { ...scr.physical[1] };
  };
  return backend;
}

test('displayRect (win32): exact monitor rect from backend.monitorRect instead of outward-rounded DIP conversion', () => {
  const scr = outwardScreen();
  const d2 = scr.displays[1];
  assert.deepEqual(displayRect('win32', scr, d2), { x: 1920, y: -100, width: 2561, height: 1440, scaleFactor: 1.5 }); // the bug
  const backend = withMonitorRect(fakeBackend(), scr);
  assert.deepEqual(displayRect('win32', scr, d2, backend), { x: 1920, y: -100, width: 2560, height: 1440, scaleFactor: 1.5 });
  // queried at the physical centre of the display
  assert.deepEqual(backend.calls.at(-1), ['monitorRect', { x: Math.round(1920 + 853 * 1.5), y: -100 + 480 * 1.5 }]);
  // monitorRect null / throwing / not containing the point / no dipToScreenPoint → previous behaviour
  for (const bad of [() => null, () => { throw new Error('x'); }, () => ({ x: 0, y: 0, width: 1920, height: 1080 })]) {
    assert.equal(displayRect('win32', scr, d2, withMonitorRect(fakeBackend(), scr, bad)).width, 2561);
  }
  const noPoint = outwardScreen();
  delete noPoint.dipToScreenPoint;
  assert.equal(displayRect('win32', noPoint, d2, withMonitorRect(fakeBackend(), noPoint)).width, 2561);
  // macOS never asks the backend
  const mac = withMonitorRect(fakeBackend(), scr);
  assert.deepEqual(displayRect('darwin', scr, d2, mac), { x: 1920, y: 0, width: 1707, height: 960, scaleFactor: 1.5 });
  assert.equal(mac.calls.length, 0);
});

test('injector (win32): x = 1 maps to the last pixel of the exact monitor rect; physicalRect reports it', () => {
  const scr = outwardScreen();
  const backend = withMonitorRect(fakeBackend(), scr);
  const { inj } = makeInjector('win32', { backend, screen: scr });
  inj.setDisplay(scr.displays[1]);
  inj.handle({ t: 'mm', x: 1, y: 1 });
  assert.deepEqual(backend.inj().filter((c) => c[0] === 'moveTo').at(-1), ['moveTo', 1920 + 2559, -100 + 1439]);
  assert.deepEqual(inj.physicalRect(scr.displays[1]), { x: 1920, y: -100, width: 2560, height: 1440 });
  assert.deepEqual(inj.physicalRect(scr.displays[0]), { x: 0, y: 0, width: 1920, height: 1080 });
  for (const bad of [null, undefined, 3, {}, { bounds: { x: 0, y: 0, width: 0, height: 1 } }]) assert.equal(inj.physicalRect(bad), null);
  // backend without monitorRect → current dipToScreenRect result
  const { inj: plain } = makeInjector('win32', { screen: scr });
  assert.deepEqual(plain.physicalRect(scr.displays[1]), { x: 1920, y: -100, width: 2561, height: 1440 });
  // macOS: always null
  const { inj: mac } = makeInjector('darwin', { backend: withMonitorRect(fakeBackend(), scr), screen: scr });
  assert.equal(mac.physicalRect(scr.displays[1]), null);
});

// ---------------------------------------------------------------------------------------------
// injector (fake backend)
// ---------------------------------------------------------------------------------------------

test('injector: default display is primary; setDisplay switches and maps into it', () => {
  const { inj, backend } = makeInjector('win32');
  assert.equal(inj.available, true);
  assert.equal(inj.reason, null);
  inj.handle({ t: 'mm', x: 0.5, y: 0.5 });
  assert.deepEqual(backend.inj().at(-1), ['moveTo', 960, 540]);

  const scr = fakeScreen();
  assert.equal(inj.setDisplay(scr.displays[1]), true);
  inj.handle({ t: 'mm', x: 0, y: 0 });
  assert.deepEqual(backend.inj().at(-1), ['moveTo', 1920, -100]);
  inj.handle({ t: 'mm', x: 1, y: 1 });
  assert.deepEqual(backend.inj().at(-1), ['moveTo', 1920 + 2559, -100 + 1439]);

  assert.equal(inj.setDisplay(null), true);
  inj.handle({ t: 'mm', x: 1, y: 1 });
  assert.deepEqual(backend.inj().at(-1), ['moveTo', 1919, 1079]);

  assert.equal(inj.setDisplay('2'), true); // by id
  inj.handle({ t: 'mm', x: 0, y: 0 });
  assert.deepEqual(backend.inj().at(-1), ['moveTo', 1920, -100]);

  assert.equal(inj.setDisplay({ id: 3, bounds: { x: 0, y: 0 } }), false);
  assert.equal(inj.setDisplay(42.5), true); // unknown id → falls back to primary
  inj.handle({ t: 'mm', x: 0, y: 0 });
  assert.deepEqual(backend.inj().at(-1), ['moveTo', 0, 0]);
});

test('injector (darwin): maps to global points of the selected display', () => {
  const scr = fakeScreen();
  const { inj, backend } = makeInjector('darwin', { screen: scr });
  inj.setDisplay(scr.displays[1]);
  inj.handle({ t: 'mm', x: 0.5, y: 0.5 });
  assert.deepEqual(backend.inj().at(-1), ['moveTo', 1920 + 853.5, 480]);
});

test('injector: display changes invalidate the cached rect', () => {
  const scr = fakeScreen();
  const { inj, backend } = makeInjector('darwin', { screen: scr });
  inj.handle({ t: 'mm', x: 1, y: 0 });
  assert.equal(backend.inj().at(-1)[1], 1919);
  scr.displays[0].bounds = { x: 0, y: 0, width: 1280, height: 720 };
  scr.emit('display-metrics-changed');
  inj.handle({ t: 'mm', x: 1, y: 0 });
  assert.equal(backend.inj().at(-1)[1], 1279);
});

test('injector: setDisplay with a capture-style object (string id, own bounds)', () => {
  const { inj, backend } = makeInjector('darwin', { screen: null });
  assert.equal(inj.setDisplay({ id: 'abc', bounds: { x: 100, y: 50, width: 800, height: 600 }, scaleFactor: 1 }), true);
  inj.handle({ t: 'mm', x: 0.5, y: 0.5 });
  assert.deepEqual(backend.inj().at(-1), ['moveTo', 500, 350]);
});

test('injector: no screen and no display → pointer events dropped, keys still work', () => {
  const { inj, backend } = makeInjector('win32', { screen: null });
  assert.equal(inj.handle({ t: 'mm', x: 0.5, y: 0.5 }), false);
  assert.equal(inj.handle({ t: 'md', b: 0, x: 0.5, y: 0.5 }), false);
  assert.equal(inj.handle({ t: 'kd', code: 'KeyA', key: 'a' }), true);
  assert.deepEqual(backend.inj(), [['key', 'KeyA', true, false]]);
});

test('injector: invalid events never reach the backend', () => {
  const { inj, backend } = makeInjector('win32');
  const junk = [null, 'x', 42, [], { t: 'mm' }, { t: 'md', b: 9, x: 0, y: 0 }, { t: 'kd', code: '<script>' },
    { t: 'txt', text: 'x'.repeat(5000) }, { t: 'combo', codes: Array(10).fill('KeyA') }, { t: 'wh', dy: 'down' },
    { t: 'constructor' }, { t: 'toString' }, { t: '__proto__' }];
  for (const j of junk) assert.equal(inj.handle(j), false);
  assert.deepEqual(backend.inj(), []);
});

test('injector: mouse buttons, click counts and wheel', () => {
  const { inj, backend } = makeInjector('win32');
  inj.handle({ t: 'md', b: 0, x: 0.5, y: 0.5, n: 2 });
  inj.handle({ t: 'mu', b: 0, x: 0.5, y: 0.5, n: 2 });
  inj.handle({ t: 'mu', b: 2, x: 0.5, y: 0.5 }); // never pressed → dropped
  inj.handle({ t: 'wh', dx: 0, dy: 0 }); // no-op
  inj.handle({ t: 'wh', dx: 3, dy: -40 });
  assert.deepEqual(backend.inj(), [
    ['button', 0, true, 960, 540, 2],
    ['button', 0, false, 960, 540, 2],
    ['scroll', 3, -40],
  ]);
});

test('injector: pointer guard — no press on, and no drag onto, the host session UI (DIP of the streamed display)', () => {
  for (const platform of ['win32', 'darwin']) {
    const scr = fakeScreen();
    const { inj, backend } = makeInjector(platform, { screen: scr });
    // the session panel on the secondary display (DIP), bottom-right: x 3227–3607, y 760–960
    const seen = [];
    const panel = { x: 3227, y: 760, width: 380, height: 200 };
    inj.setPointerGuard(({ dip: p, window }) => {
      seen.push(p);
      assert.equal(window, undefined, 'fake backend has no windowAt');
      return p.x >= panel.x && p.x < panel.x + panel.width && p.y >= panel.y && p.y < panel.y + panel.height;
    });
    inj.setDisplay(scr.displays[1]);
    const onPanel = { x: (3400 - 1920) / 1707, y: 900 / 960 };
    const off = { x: 0.25, y: 0.25 };

    assert.equal(inj.handle({ t: 'md', b: 0, ...onPanel }), false, `${platform}: press on the panel dropped`);
    assert.equal(inj.handle({ t: 'mu', b: 0, ...onPanel }), false, 'its release is a stray up');
    assert.ok(Math.abs(seen[0].x - 3400) < 1e-6 && Math.abs(seen[0].y - 900) < 1e-6, 'guard gets DIP of the streamed display');
    assert.equal(inj.handle({ t: 'mm', ...onPanel }), true, 'hovering is allowed');
    assert.equal(inj.handle({ t: 'wh', dx: 0, dy: 40 }), true, 'wheel is allowed');

    backend.calls.length = 0;
    assert.equal(inj.handle({ t: 'md', b: 0, ...off }), true);
    const pressAt = backend.inj()[0].slice(3, 5);
    assert.equal(inj.handle({ t: 'mm', ...onPanel }), false, 'drag into the panel dropped');
    assert.equal(inj.handle({ t: 'mu', b: 0, ...onPanel }), true, 'the button is still released…');
    const up = backend.inj().at(-1);
    assert.deepEqual([up[0], up[1], up[2]], ['button', 0, false]);
    assert.deepEqual(up.slice(3, 5), pressAt, '…at the last allowed point, not on the panel');
    assert.deepEqual(inj._held().buttons, []);

    inj.setPointerGuard(() => { throw new Error('boom'); });
    assert.equal(inj.handle({ t: 'md', b: 0, ...off }), false, 'a guard that throws drops the press (fail closed)');
    inj.setPointerGuard(null);
    assert.equal(inj.handle({ t: 'md', b: 0, ...onPanel }), true, 'no guard → injected');
    inj.releaseAll();
  }
});

test('injector: pointer guard gets the window really under the injected physical point (win32 backend.windowAt)', () => {
  const scr = fakeScreen();
  const backend = fakeBackend();
  const asked = [];
  backend.windowAt = (p) => { asked.push(p); return p.x >= 1800 ? 0x10n : 0x20n; }; // 0x10 = the panel
  const { inj } = makeInjector('win32', { screen: scr, backend });
  inj.setPointerGuard(({ window }) => window === 0x10n);
  assert.equal(inj.handle({ t: 'md', b: 0, x: 0.99, y: 0.5 }), false, 'the panel window is under the point');
  assert.deepEqual(asked[0], { x: 1900, y: 540 }, 'asked at the physical pixel that would be injected');
  assert.equal(inj.handle({ t: 'md', b: 0, x: 0.5, y: 0.5 }), true, 'another window (e.g. a flyout above the panel area)');
  inj.releaseAll();
});

test('injector: key guard drops kd / combo / tx while the session UI has focus; ku of a held key still goes through', () => {
  const { inj, backend } = makeInjector('win32');
  let focused = false;
  inj.setKeyGuard(() => focused);
  assert.equal(inj.handle({ t: 'kd', code: 'ShiftLeft', key: 'Shift' }), true);
  focused = true;
  assert.equal(inj.handle({ t: 'kd', code: 'Space', key: ' ' }), false);
  assert.equal(inj.handle({ t: 'combo', codes: ['MetaLeft', 'ArrowDown'] }), false);
  assert.equal(inj.handle({ t: 'txt', text: 'hi' }), false);
  focused = false;
  assert.equal(inj.handle({ t: 'txt', text: 'hi' }), true, 'txt is injected when unguarded');
  focused = true;
  assert.equal(inj.handle({ t: 'ku', code: 'Space', key: ' ' }), false, 'never pressed → no stray up');
  assert.equal(inj.handle({ t: 'ku', code: 'ShiftLeft', key: 'Shift' }), true, 'held before → released');
  assert.deepEqual(backend.inj(), [['key', 'ShiftLeft', true, false], ['text', 'hi'], ['key', 'ShiftLeft', false, false]]);
  inj.setKeyGuard(() => { throw new Error('boom'); });
  assert.equal(inj.handle({ t: 'kd', code: 'KeyA', key: 'a' }), false, 'fail closed');
  inj.setKeyGuard(null);
  assert.equal(inj.handle({ t: 'kd', code: 'KeyA', key: 'a' }), true);
  inj.releaseAll();
});

test('injector: held keys/buttons tracking and releaseAll (reverse order)', () => {
  const { inj, backend } = makeInjector('win32');
  inj.handle({ t: 'kd', code: 'ControlLeft', key: 'Control' });
  inj.handle({ t: 'kd', code: 'ShiftLeft', key: 'Shift' });
  inj.handle({ t: 'kd', code: 'KeyA', key: 'A' });
  inj.handle({ t: 'kd', code: 'KeyA', key: 'A', rep: true });
  inj.handle({ t: 'md', b: 2, x: 0.25, y: 0.25 });
  inj.handle({ t: 'ku', code: 'ShiftLeft', key: 'Shift' });
  inj.handle({ t: 'ku', code: 'KeyZ', key: 'z' }); // never pressed → no stray key-up
  assert.deepEqual(inj._held(), { keys: ['ControlLeft', 'KeyA'], buttons: [2] });
  backend.calls.length = 0;
  inj.releaseAll();
  assert.deepEqual(backend.inj(), [
    ['key', 'KeyA', false, false],
    ['key', 'ControlLeft', false, false],
    ['button', 2, false, 480, 270, 1],
    ['reset'],
  ]);
  assert.deepEqual(inj._held(), { keys: [], buttons: [] });
  backend.calls.length = 0;
  inj.releaseAll(); // idempotent
  assert.deepEqual(backend.inj(), [['reset']]);
});

test('injector: release-all message and repeats', () => {
  const { inj, backend } = makeInjector('darwin');
  inj.handle({ t: 'kd', code: 'KeyQ', key: 'q', rep: false });
  inj.handle({ t: 'kd', code: 'KeyQ', key: 'q', rep: true });
  assert.equal(inj.handle({ t: 'release-all' }), true);
  assert.deepEqual(backend.inj(), [['key', 'KeyQ', true, false], ['key', 'KeyQ', true, true], ['key', 'KeyQ', false, false], ['reset']]);
});

test('injector: unknown code with printable key types the character', () => {
  const { inj, backend } = makeInjector('win32');
  inj.handle({ t: 'kd', code: 'Unidentified', key: 'ß' });
  inj.handle({ t: 'ku', code: 'Unidentified', key: 'ß' }); // nothing held → nothing sent
  inj.handle({ t: 'kd', code: '', key: '😀' });
  inj.handle({ t: 'kd', code: 'Unidentified', key: 'Dead' }); // not printable → dropped
  inj.handle({ t: 'kd', code: 'Fn', key: 'Fn' }); // known, but unmapped on Windows, not printable
  assert.deepEqual(backend.inj(), [['text', 'ß'], ['text', '😀']]);
  assert.deepEqual(inj._held().keys, []);
});

test('injector: code unmapped on the host platform falls back to text (darwin ContextMenu)', () => {
  const { inj, backend } = makeInjector('darwin');
  assert.equal(inj.handle({ t: 'kd', code: 'ContextMenu', key: 'ContextMenu' }), false);
  assert.equal(inj.handle({ t: 'kd', code: 'F21', key: 'F21' }), false);
  assert.deepEqual(backend.inj(), []);
});

test('injector: combo presses in order and releases in reverse', () => {
  const { inj, backend } = makeInjector('win32');
  assert.equal(inj.handle({ t: 'combo', codes: ['ControlLeft', 'AltLeft', 'Delete'] }), true);
  assert.deepEqual(backend.inj(), [
    ['key', 'ControlLeft', true, false], ['key', 'AltLeft', true, false], ['key', 'Delete', true, false],
    ['key', 'Delete', false, false], ['key', 'AltLeft', false, false], ['key', 'ControlLeft', false, false],
  ]);
  assert.deepEqual(inj._held().keys, []);
});

test('injector: combo leaves keys the viewer already holds untouched; duplicates pressed once', () => {
  const { inj, backend } = makeInjector('win32');
  inj.handle({ t: 'kd', code: 'ControlLeft', key: 'Control' });
  backend.calls.length = 0;
  inj.handle({ t: 'combo', codes: ['ControlLeft', 'KeyC', 'KeyC'] });
  assert.deepEqual(backend.inj(), [['key', 'KeyC', true, false], ['key', 'KeyC', false, false]]);
  assert.deepEqual(inj._held().keys, ['ControlLeft']);
});

test('injector: combo with a code unmapped on this platform is dropped entirely', () => {
  const { inj, backend } = makeInjector('darwin');
  assert.equal(inj.handle({ t: 'combo', codes: ['ShiftLeft', 'ContextMenu'] }), false);
  assert.equal(inj.handle({ t: 'combo', codes: ['MetaLeft', 'Unidentified'] }), false);
  assert.deepEqual(backend.inj(), []);
});

test('injector: combo releases already-pressed keys if a press throws', () => {
  const backend = fakeBackend({ throwOn: (code, down) => code === 'KeyT' && down });
  const { inj } = makeInjector('win32', { backend });
  assert.equal(inj.handle({ t: 'combo', codes: ['ControlLeft', 'ShiftLeft', 'KeyT'] }), false);
  assert.deepEqual(backend.inj(), [
    ['key', 'ControlLeft', true, false], ['key', 'ShiftLeft', true, false],
    ['key', 'KeyT', false, false], ['key', 'ShiftLeft', false, false], ['key', 'ControlLeft', false, false],
  ]);
});

test('injector: txt segments into text runs and Enter/Tab taps', () => {
  const { inj, backend } = makeInjector('darwin');
  inj.handle({ t: 'txt', text: 'héllo\r\nwörld\t😀' });
  assert.deepEqual(backend.inj(), [
    ['text', 'héllo'], ['key', 'Enter', true, false], ['key', 'Enter', false, false],
    ['text', 'wörld'], ['key', 'Tab', true, false], ['key', 'Tab', false, false], ['text', '😀'],
  ]);
  assert.deepEqual(inj._held().keys, []);
});

test('injector: backend exceptions are contained', () => {
  const backend = fakeBackend({ throwOn: 'moveTo' });
  const { inj } = makeInjector('win32', { backend });
  assert.equal(inj.handle({ t: 'mm', x: 0.1, y: 0.1 }), false);
  assert.equal(inj.handle({ t: 'kd', code: 'KeyA' }), true);
});

test('injector: unavailable (macOS permission) drops events and re-checks periodically', () => {
  const backend = fakeBackend({ available: false, reason: 'accessibility-permission' });
  const { inj, clock } = makeInjector('darwin', { backend });
  assert.equal(inj.available, false);
  assert.equal(inj.reason, 'accessibility-permission');
  assert.equal(inj.handle({ t: 'kd', code: 'KeyA' }), false);
  backend.checkResult = { available: true, reason: null };
  clock.advance(500);
  assert.equal(inj.handle({ t: 'kd', code: 'KeyA' }), false); // too soon to re-check
  clock.advance(2000);
  assert.equal(inj.handle({ t: 'kd', code: 'KeyA' }), true);
  assert.equal(inj.available, true);
  backend.checkResult = { available: false, reason: 'accessibility-permission' };
  assert.deepEqual(inj.refreshPermission(), { available: false, reason: 'accessibility-permission', blocked: null });
  assert.deepEqual(inj.status(), { available: false, reason: 'accessibility-permission', blocked: null });
});

test('injector: `available` getter itself notices a permission grant (ipc.js gates on it)', () => {
  const backend = fakeBackend({ available: false, reason: 'accessibility-permission' });
  const { inj, clock } = makeInjector('darwin', { backend });
  assert.equal(inj.available, false);
  backend.checkResult = { available: true, reason: null };
  assert.equal(inj.available, false); // throttled
  clock.advance(2000);
  assert.equal(inj.available, true);
  assert.equal(inj.reason, null);
  const checks = backend.calls.filter((c) => c[0] === 'check').length;
  clock.advance(10000);
  void inj.available; // available → no further checks
  assert.equal(backend.calls.filter((c) => c[0] === 'check').length, checks);
});

// --- Alt/Win solo-tap mask (releaseAll) ---

function maskingBackend() {
  const backend = fakeBackend();
  backend.mask = () => { backend.calls.push(['mask']); };
  return backend;
}

test('injector: releaseAll masks a lone held Alt before releasing it (no menu bar / Start menu)', () => {
  const backend = maskingBackend();
  const { inj } = makeInjector('win32', { backend });
  inj.handle({ t: 'kd', code: 'AltLeft', key: 'Alt' });
  backend.calls.length = 0;
  inj.releaseAll();
  assert.deepEqual(backend.inj(), [['mask'], ['key', 'AltLeft', false, false], ['reset']]);

  // Win key (and its legacy alias), mixed with other keys: one mask, before any release
  backend.calls.length = 0;
  inj.handle({ t: 'kd', code: 'ControlLeft', key: 'Control' });
  inj.handle({ t: 'kd', code: 'OSLeft', key: 'Meta' });
  inj.handle({ t: 'kd', code: 'AltRight', key: 'AltGraph' });
  backend.calls.length = 0;
  inj.releaseAll();
  assert.deepEqual(backend.inj(), [
    ['mask'], ['key', 'AltRight', false, false], ['key', 'OSLeft', false, false], ['key', 'ControlLeft', false, false], ['reset'],
  ]);
});

test('injector: genuine ku of Alt is never masked; Ctrl-only releaseAll is not masked', () => {
  const backend = maskingBackend();
  const { inj } = makeInjector('win32', { backend });
  inj.handle({ t: 'kd', code: 'AltLeft', key: 'Alt' });
  inj.handle({ t: 'ku', code: 'AltLeft', key: 'Alt' }); // intentional remote Alt tap: must open menus
  inj.releaseAll();
  assert.deepEqual(backend.inj(), [['key', 'AltLeft', true, false], ['key', 'AltLeft', false, false], ['reset']]);

  backend.calls.length = 0;
  inj.handle({ t: 'kd', code: 'ControlLeft', key: 'Control' });
  inj.handle({ t: 'kd', code: 'ShiftLeft', key: 'Shift' });
  inj.releaseAll();
  assert.equal(backend.inj().filter((c) => c[0] === 'mask').length, 0);

  // backends without mask() (macOS) are unaffected
  const mac = fakeBackend();
  const { inj: m } = makeInjector('darwin', { backend: mac });
  m.handle({ t: 'kd', code: 'MetaLeft', key: 'Meta' });
  m.releaseAll();
  assert.deepEqual(mac.inj(), [['key', 'MetaLeft', true, false], ['key', 'MetaLeft', false, false], ['reset']]);
});

test('injector: a throwing mask() does not prevent the releases', () => {
  const backend = fakeBackend();
  backend.mask = () => { throw new Error('mask boom'); };
  const { inj } = makeInjector('win32', { backend });
  inj.handle({ t: 'kd', code: 'MetaLeft', key: 'Meta' });
  backend.calls.length = 0;
  inj.releaseAll();
  assert.deepEqual(backend.inj(), [['key', 'MetaLeft', false, false], ['reset']]);
});

// --- blocked (UIPI / secure desktop) ---

function probingBackend() {
  const backend = fakeBackend();
  backend.reasonResult = null;
  backend.short = false;
  backend.blockedReason = (pt) => { backend.calls.push(['probe', pt]); return backend.reasonResult; };
  backend.takeShortfall = () => { const s = backend.short; backend.short = false; return s; };
  backend.probes = () => backend.calls.filter((c) => c[0] === 'probe');
  return backend;
}

test('injector: blocked reports backend.blockedReason, probed before md/kd at most every 500 ms', () => {
  const backend = probingBackend();
  const { inj, clock } = makeInjector('win32', { backend });
  assert.equal(inj.blocked, null); // nothing probed yet, reading does not probe while clear
  assert.equal(backend.probes().length, 0);

  backend.reasonResult = 'elevated-window';
  inj.handle({ t: 'md', b: 0, x: 0.5, y: 0.5 });
  const firstProbe = backend.calls.findIndex((c) => c[0] === 'probe');
  const firstButton = backend.calls.findIndex((c) => c[0] === 'button');
  assert.ok(firstProbe >= 0 && firstProbe < firstButton, 'probe runs before the injection');
  assert.deepEqual(backend.probes(), [['probe', { x: 960, y: 540 }]]); // md: the event's point
  assert.equal(inj.blocked, 'elevated-window');
  assert.deepEqual(inj.status(), { available: true, reason: null, blocked: 'elevated-window' });

  inj.handle({ t: 'mu', b: 0, x: 0.5, y: 0.5 });
  inj.handle({ t: 'kd', code: 'KeyA', key: 'a' });
  inj.handle({ t: 'mm', x: 0.1, y: 0.1 });
  assert.equal(backend.probes().length, 1, 'rate-limited');

  clock.advance(500);
  backend.reasonResult = null;
  inj.handle({ t: 'kd', code: 'KeyB', key: 'b' });
  assert.deepEqual(backend.probes().at(-1), ['probe', null]); // kd: the foreground window
  assert.equal(inj.blocked, null, 'cleared by a later probe');

  // the backend returning anything else is not reported
  clock.advance(500);
  backend.reasonResult = 'pwned';
  inj.handle({ t: 'kd', code: 'KeyC', key: 'c' });
  assert.equal(inj.blocked, null);
  backend.blockedReason = () => { throw new Error('probe boom'); };
  clock.advance(500);
  assert.equal(inj.handle({ t: 'kd', code: 'KeyD', key: 'd' }), true, 'a failing probe never costs the event');
  assert.equal(inj.blocked, null);
});

test('injector: a SendInput shortfall probes right away; a set state is re-probed on read so it clears', () => {
  const backend = probingBackend();
  const { inj, clock } = makeInjector('win32', { backend });
  inj.handle({ t: 'kd', code: 'KeyA', key: 'a' }); // probe #1 (clear)
  clock.advance(100);
  backend.reasonResult = 'secure-desktop';
  backend.short = true; // this mm "inserted 0 of 1 events"
  inj.handle({ t: 'mm', x: 0.25, y: 0.25 });
  assert.equal(backend.probes().length, 2);
  assert.deepEqual(backend.probes().at(-1), ['probe', { x: 480, y: 270 }]);
  assert.equal(inj.blocked, 'secure-desktop');

  backend.short = true;
  clock.advance(50);
  inj.handle({ t: 'mm', x: 0.3, y: 0.3 }); // shortfall probes are limited to one per 100 ms
  assert.equal(backend.probes().length, 2);

  backend.reasonResult = null; // user dismissed the UAC prompt
  assert.equal(inj.blocked, 'secure-desktop'); // < 500 ms since the last probe
  clock.advance(500);
  assert.equal(inj.blocked, null);
  assert.deepEqual(backend.probes().at(-1), ['probe', { x: 480, y: 270 }]); // same target as before
  clock.advance(5000);
  void inj.blocked;
  inj.status();
  assert.equal(backend.probes().length, 3, 'no probing while clear and idle');
});

test('injector: macOS (no blockedReason) always reports blocked null', () => {
  const { inj } = makeInjector('darwin');
  inj.handle({ t: 'md', b: 0, x: 0.5, y: 0.5 });
  inj.handle({ t: 'kd', code: 'KeyA', key: 'a' });
  assert.equal(inj.blocked, null);
  assert.deepEqual(inj.status(), { available: true, reason: null, blocked: null });
});

// --- Caps Lock / Num Lock resync ---

/**
 * Windows-like backend: `host` = the real toggles; lockState() returns this thread's copy and only
 * then syncs it (win32k resyncs a non-focus thread lazily), so the first read after a change is stale.
 */
function lockBackend(host, { stale = true, thread = null } = {}) {
  const backend = fakeBackend();
  backend.host = { caps: false, num: true, ...host };
  let copy = { ...backend.host, ...thread }; // this thread's (possibly outdated) view
  backend.reads = 0;
  backend.lockState = () => {
    backend.reads++;
    const r = stale ? { ...copy } : { ...backend.host };
    copy = { ...backend.host };
    return r;
  };
  const key = backend.key;
  backend.key = (code, down, rep) => {
    if (down && !rep && code === 'CapsLock') backend.host.caps = !backend.host.caps;
    if (down && !rep && code === 'NumLock') backend.host.num = !backend.host.num;
    return key(code, down, rep);
  };
  backend.taps = (code) => backend.inj().filter((c) => c[0] === 'key' && c[1] === code && c[2] === true).length;
  return backend;
}

test('injector: mismatched host Caps Lock → a CapsLock tap before the letter; matching → none', () => {
  const backend = lockBackend({ caps: false }, { stale: false });
  const { inj, clock } = makeInjector('win32', { backend });
  inj.handle({ t: 'mm', x: 0.5, y: 0.5 }); // any event primes the lock-state read chain
  clock.advance(100);
  backend.calls.length = 0;
  assert.equal(inj.handle({ t: 'kd', code: 'KeyA', key: 'A', locks: { caps: true } }), true);
  assert.deepEqual(backend.inj(), [['key', 'CapsLock', true, false], ['key', 'CapsLock', false, false], ['key', 'KeyA', true, false]]);
  assert.equal(backend.host.caps, true);
  inj.handle({ t: 'ku', code: 'KeyA', key: 'A' });

  for (let i = 0; i < 10; i++) {
    clock.advance(120);
    inj.handle({ t: 'kd', code: 'KeyB', key: 'B', locks: { caps: true } });
    inj.handle({ t: 'ku', code: 'KeyB', key: 'B' });
  }
  assert.equal(backend.taps('CapsLock'), 1, 'matching state → no further taps');
  assert.deepEqual(inj._held().keys, []);
});

test('injector: stale first reads never make Caps Lock oscillate', () => {
  for (const [gap, withKeyUp] of [[100, true], [300, false], [1000, false]]) {
    const backend = lockBackend({ caps: true }, { thread: { caps: false } }); // host on, this thread still believes off
    const { inj, clock } = makeInjector('win32', { backend });
    for (let i = 0; i < 30; i++) {
      inj.handle({ t: 'kd', code: 'KeyQ', key: 'q', rep: !withKeyUp && i > 0, locks: { caps: false } });
      if (withKeyUp) inj.handle({ t: 'ku', code: 'KeyQ', key: 'q' });
      clock.advance(gap);
    }
    assert.equal(backend.taps('CapsLock'), 1, `gap ${gap}`);
    assert.equal(backend.host.caps, false, `gap ${gap}`);
    // the very first key (no earlier read) only primes: no tap acted on an untrusted read
    const firstTap = backend.calls.findIndex((c) => c[0] === 'key' && c[1] === 'CapsLock');
    const firstKey = backend.calls.findIndex((c) => c[0] === 'key' && c[1] === 'KeyQ');
    assert.ok(firstKey < firstTap, `gap ${gap}`);
  }
});

test('injector: resync taps are rate-limited to one per 300 ms per lock', () => {
  const backend = lockBackend({ caps: false }, { stale: false });
  const { inj, clock } = makeInjector('win32', { backend });
  inj.handle({ t: 'mm', x: 0.5, y: 0.5 });
  clock.advance(100);
  inj.handle({ t: 'kd', code: 'KeyA', key: 'A', locks: { caps: true } }); // tap #1
  backend.host.caps = false; // host user flips it back at once
  for (const dt of [60, 60, 60]) {
    clock.advance(dt);
    inj.handle({ t: 'kd', code: 'KeyA', key: 'A', rep: true, locks: { caps: true } });
  }
  assert.equal(backend.taps('CapsLock'), 1, 'within 300 ms of the last tap');
  clock.advance(150);
  inj.handle({ t: 'kd', code: 'KeyA', key: 'A', rep: true, locks: { caps: true } });
  assert.equal(backend.taps('CapsLock'), 2);
});

test('injector: Num Lock resync only for Numpad keys; lock and modifier keys never resync', () => {
  const backend = lockBackend({ caps: false, num: false }, { stale: false });
  const { inj, clock } = makeInjector('win32', { backend });
  inj.handle({ t: 'mm', x: 0.5, y: 0.5 });
  clock.advance(100);
  inj.handle({ t: 'kd', code: 'KeyA', key: 'a', locks: { caps: false, num: true } });
  assert.equal(backend.taps('NumLock'), 0, 'not a numpad key');
  clock.advance(100);
  inj.handle({ t: 'kd', code: 'Numpad1', key: '1', locks: { caps: false, num: true } });
  assert.deepEqual(backend.inj().slice(-3), [['key', 'NumLock', true, false], ['key', 'NumLock', false, false], ['key', 'Numpad1', true, false]]);
  assert.equal(backend.host.num, true);
  inj.releaseAll();

  const reads = backend.reads;
  backend.calls.length = 0;
  clock.advance(1000);
  for (const code of ['CapsLock', 'NumLock', 'ScrollLock', 'ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft']) {
    inj.handle({ t: 'kd', code, key: code, locks: { caps: true, num: false } });
  }
  assert.equal(backend.reads, reads, 'no lock-state read for lock/modifier keys');
  assert.equal(backend.taps('CapsLock'), 1, 'only the viewer\'s own CapsLock press');
  assert.equal(backend.taps('NumLock'), 1, 'only the viewer\'s own NumLock press');
});

test('injector: no resync tap while the viewer holds the lock key; malformed locks still inject', () => {
  const backend = lockBackend({ caps: false }, { stale: false });
  const { inj, clock } = makeInjector('win32', { backend });
  inj.handle({ t: 'kd', code: 'CapsLock', key: 'CapsLock' }); // held down (host toggles to on)
  clock.advance(100);
  inj.handle({ t: 'mm', x: 0.5, y: 0.5 });
  clock.advance(100);
  inj.handle({ t: 'kd', code: 'KeyA', key: 'A', locks: { caps: false } });
  assert.equal(backend.taps('CapsLock'), 1);
  inj.releaseAll();

  backend.calls.length = 0;
  for (const locks of [{ caps: 'on' }, 'caps', null, { caps: true, num: 'x' }]) {
    assert.equal(inj.handle({ t: 'kd', code: 'KeyZ', key: 'z', locks }), true, JSON.stringify(locks));
  }
  assert.equal(backend.taps('KeyZ'), 4);
  assert.equal(backend.taps('CapsLock'), 0);
});

/**
 * Windows-like backend with backend.tapLock (VK_CAPITAL / VK_NUMLOCK). `works[kind]` false = a tap
 * never changes the host (JIS Eisu, CapsLock remapped to Esc, "press Shift to turn off Caps Lock",
 * per-thread reads that never settle).
 */
function vkLockBackend(host, works = { caps: true, num: true }) {
  const backend = fakeBackend();
  backend.host = { caps: false, num: true, ...host };
  backend.lockState = () => ({ ...backend.host });
  backend.tapLock = (kind) => {
    backend.calls.push(['tapLock', kind]);
    if (works[kind]) backend.host[kind] = !backend.host[kind];
    return true;
  };
  backend.lockTaps = (kind) => backend.calls.filter((c) => c[0] === 'tapLock' && c[1] === kind).length;
  return backend;
}

/** `n` key presses (kd 80 ms ku 87 ms: 6 keys/s) carrying the viewer's lock state `locks`. */
function typeKeys(inj, clock, n, locks, code = 'KeyA') {
  for (let i = 0; i < n; i++) {
    inj.handle({ t: 'kd', code, key: 'a', locks });
    clock.advance(80);
    inj.handle({ t: 'ku', code, key: 'a' });
    clock.advance(87);
  }
}

test('injector (win32): the resync tap uses backend.tapLock; the viewer\'s own CapsLock stays a key', () => {
  const backend = vkLockBackend({ caps: false, num: false });
  const { inj, clock } = makeInjector('win32', { backend });
  inj.handle({ t: 'mm', x: 0.5, y: 0.5 });
  clock.advance(100);
  backend.calls.length = 0;
  inj.handle({ t: 'kd', code: 'KeyA', key: 'A', locks: { caps: true } });
  assert.deepEqual(backend.inj(), [['tapLock', 'caps'], ['key', 'KeyA', true, false]]);
  inj.handle({ t: 'ku', code: 'KeyA', key: 'A' });
  clock.advance(400);
  inj.handle({ t: 'kd', code: 'Numpad1', key: '1', locks: { caps: true, num: true } });
  assert.deepEqual(backend.inj().slice(-3), [['key', 'KeyA', false, false], ['tapLock', 'num'], ['key', 'Numpad1', true, false]]);
  inj.handle({ t: 'ku', code: 'Numpad1', key: '1' });
  inj.handle({ t: 'kd', code: 'CapsLock', key: 'CapsLock' });
  assert.deepEqual(backend.inj().slice(-1), [['key', 'CapsLock', true, false]]);
  assert.deepEqual([backend.lockTaps('caps'), backend.lockTaps('num')], [1, 1]);
});

test('injector: Caps Lock resync gives up after 2 taps that change nothing, until the viewer toggles or reset()', () => {
  const backend = vkLockBackend({ caps: false, num: true }, { caps: false, num: true });
  const { inj, clock } = makeInjector('win32', { backend });
  typeKeys(inj, clock, 60, { caps: true, num: true }); // 10 s of typing with the viewer's Caps Lock on
  assert.equal(backend.lockTaps('caps'), 2, 'not one tap per other keystroke');
  assert.equal(backend.inj().filter((c) => c[0] === 'key' && c[1] === 'CapsLock').length, 0, 'never the scancode key');

  inj.releaseAll(); // viewer blur: not a reason to try again
  typeKeys(inj, clock, 20, { caps: true, num: true });
  assert.equal(backend.lockTaps('caps'), 2);

  // The viewer turns Caps Lock off (matches the host: nothing to do) and on again: re-armed.
  typeKeys(inj, clock, 1, { caps: true, num: true }, 'CapsLock');
  typeKeys(inj, clock, 10, { caps: false, num: true });
  assert.equal(backend.lockTaps('caps'), 2);
  typeKeys(inj, clock, 1, { caps: false, num: true }, 'CapsLock');
  typeKeys(inj, clock, 60, { caps: true, num: true });
  assert.equal(backend.lockTaps('caps'), 4, 'two more taps after the toggle, then quiet again');

  // Session end: reset() releases like releaseAll and re-arms the resync.
  inj.handle({ t: 'kd', code: 'ShiftLeft', key: 'Shift' });
  inj.reset();
  assert.deepEqual(inj._held().keys, []);
  assert.deepEqual(backend.inj().slice(-2), [['key', 'ShiftLeft', false, false], ['reset']]);
  typeKeys(inj, clock, 60, { caps: true, num: true });
  assert.equal(backend.lockTaps('caps'), 6);
  assert.equal(backend.lockTaps('num'), 0);
});

test('injector: Num Lock resync gives up on its own; a working Caps Lock resync is unaffected', () => {
  const backend = vkLockBackend({ caps: false, num: false }, { caps: true, num: false });
  const { inj, clock } = makeInjector('win32', { backend });
  typeKeys(inj, clock, 40, { caps: true, num: true }, 'Numpad5');
  assert.equal(backend.lockTaps('num'), 2);
  assert.equal(backend.lockTaps('caps'), 1);
  assert.equal(backend.host.caps, true);

  backend.host.caps = false; // the host user turns Caps Lock off: resynced again, Num Lock stays paused
  typeKeys(inj, clock, 40, { caps: true, num: true }, 'Numpad5');
  assert.deepEqual([backend.lockTaps('caps'), backend.lockTaps('num')], [2, 2]);

  typeKeys(inj, clock, 5, { caps: true, num: false }, 'Numpad5'); // viewer's Num Lock off = host: re-armed, no tap
  typeKeys(inj, clock, 40, { caps: true, num: true }, 'Numpad5');
  assert.equal(backend.lockTaps('num'), 4);
});

test('injector: taps that work are never given up (a verified tap clears the failure count)', () => {
  const backend = vkLockBackend({ caps: false });
  const { inj, clock } = makeInjector('win32', { backend });
  inj.handle({ t: 'mm', x: 0.5, y: 0.5 });
  clock.advance(100);
  for (let round = 0; round < 4; round++) {
    inj.handle({ t: 'kd', code: 'KeyA', key: 'A', locks: { caps: true } }); // tap → host on
    // even rounds: the host user turns it off again before the tap is verified (1 failure, then a re-tap)
    if (round % 2 === 0) backend.host.caps = false;
    typeKeys(inj, clock, 4, { caps: true });
    assert.equal(backend.host.caps, true, `round ${round}`);
    backend.host.caps = false;
    clock.advance(400);
  }
  assert.equal(backend.lockTaps('caps'), 6);
});

test('injector (macOS): locks.caps sets the emulated Caps Lock instead of tapping', () => {
  const backend = fakeBackend();
  backend.setCaps = (on) => { backend.calls.push(['setCaps', on]); };
  backend.lockState = () => { backend.calls.push(['lockState']); return { caps: false, num: null }; };
  const { inj } = makeInjector('darwin', { backend });
  inj.handle({ t: 'mm', x: 0.5, y: 0.5 });
  inj.handle({ t: 'kd', code: 'KeyA', key: 'A', locks: { caps: true, num: true } });
  inj.handle({ t: 'kd', code: 'Numpad1', key: '1', locks: { caps: false, num: false } });
  inj.handle({ t: 'kd', code: 'ShiftLeft', key: 'Shift', locks: { caps: true } }); // modifier: untouched
  inj.handle({ t: 'kd', code: 'KeyB', key: 'b' }); // no locks: untouched
  assert.deepEqual(backend.inj().filter((c) => c[0] !== 'moveTo'), [
    ['setCaps', true], ['key', 'KeyA', true, false],
    ['setCaps', false], ['key', 'Numpad1', true, false],
    ['key', 'ShiftLeft', true, false], ['key', 'KeyB', true, false],
  ]);
});

test('injector: native load failure and unsupported platforms', () => {
  const failing = input._createInjector({ platform: 'win32', loadBackend: () => { throw new Error('no koffi'); }, screen: null, log: () => {} });
  assert.equal(failing.available, false);
  assert.equal(failing.reason, 'native-unavailable');
  assert.equal(failing._error(), 'no koffi');
  assert.equal(failing.handle({ t: 'kd', code: 'KeyA' }), false);
  failing.releaseAll();

  let loaded = false;
  const linux = input._createInjector({ platform: 'linux', loadBackend: () => { loaded = true; return fakeBackend(); }, screen: null });
  assert.equal(linux.available, false);
  assert.equal(linux.reason, 'unsupported-platform');
  assert.equal(loaded, false);

  const checkThrows = fakeBackend();
  checkThrows.check = () => { throw new Error('ax'); };
  const inj = input._createInjector({ platform: 'darwin', backend: checkThrows, screen: null, log: () => {} });
  assert.equal(inj.available, false);
  assert.equal(inj.reason, 'native-error');
});

test('module singleton exposes the contract surface', () => {
  for (const fn of ['setDisplay', 'handle', 'releaseAll', 'reset', 'refreshPermission', 'status', 'physicalRect']) assert.equal(typeof input[fn], 'function', fn);
  assert.ok(Object.getOwnPropertyDescriptor(input, 'blocked').get, 'blocked is a getter');
  assert.equal(typeof input._createInjector, 'function');
  // NOTE: input.available is deliberately not read here: on Windows it would load the real backend.
});

// ---------------------------------------------------------------------------------------------
// win32 backend (pure helpers + fake native layer)
// ---------------------------------------------------------------------------------------------

const W = win32.constants;
const wp = win32._pure;

test('win32 normalize: exact pixel round-trip (⌊n·size/65536⌋ and round-to-nearest models)', () => {
  for (const size of [800, 1024, 1366, 1707, 1920, 2560, 3440, 3840, 5120, 7680, 11520]) {
    const vs = { x: -size, y: 0, width: size, height: 1000 };
    for (let p = 0; p < size; p++) {
      const { nx } = wp.normalize(p - size, 0, vs);
      assert.ok(nx >= 0 && nx <= 65535);
      assert.equal(Math.floor((nx * size) / 65536), p, `floor model, size ${size}, pixel ${p}`);
      assert.equal(Math.floor((nx * size + 32768) / 65536), p, `round model, size ${size}, pixel ${p}`);
    }
  }
  const vs = { x: -1920, y: -200, width: 4480, height: 1640 };
  assert.deepEqual(wp.normalize(-1920, -200, vs), { nx: 0, ny: 0 });
  assert.deepEqual(wp.normalize(-99999, 99999, vs), { nx: 0, ny: 65535 });
});

test('win32 button flags incl. XBUTTONs and swapped buttons', () => {
  assert.deepEqual(wp.buttonFlags(0, true, false), { flags: W.MOUSEEVENTF.LEFTDOWN, data: 0 });
  assert.deepEqual(wp.buttonFlags(0, false, false), { flags: W.MOUSEEVENTF.LEFTUP, data: 0 });
  assert.deepEqual(wp.buttonFlags(2, true, false), { flags: W.MOUSEEVENTF.RIGHTDOWN, data: 0 });
  assert.deepEqual(wp.buttonFlags(0, true, true), { flags: W.MOUSEEVENTF.RIGHTDOWN, data: 0 });
  assert.deepEqual(wp.buttonFlags(2, false, true), { flags: W.MOUSEEVENTF.LEFTUP, data: 0 });
  assert.deepEqual(wp.buttonFlags(1, true, true), { flags: W.MOUSEEVENTF.MIDDLEDOWN, data: 0 });
  assert.deepEqual(wp.buttonFlags(3, true, false), { flags: W.MOUSEEVENTF.XDOWN, data: W.XBUTTON1 });
  assert.deepEqual(wp.buttonFlags(4, false, false), { flags: W.MOUSEEVENTF.XUP, data: W.XBUTTON2 });
  assert.equal(wp.buttonFlags(7, true, false), null);
});

test('win32 keyboard inputs: scancode, extended, VK, key-up', () => {
  const ki = (inp) => inp.u.ki;
  assert.deepEqual(ki(wp.keyInputFor({ sc: 0x1E }, true)), { wVk: 0, wScan: 0x1E, dwFlags: W.KEYEVENTF.SCANCODE, time: 0, dwExtraInfo: W.EXTRA_INFO });
  assert.equal(ki(wp.keyInputFor({ sc: 0x4B, ext: true }, false)).dwFlags, W.KEYEVENTF.SCANCODE | W.KEYEVENTF.EXTENDEDKEY | W.KEYEVENTF.KEYUP);
  assert.deepEqual(ki(wp.keyInputFor({ vk: 0x90, sc: 0x45, ext: true }, true)), { wVk: 0x90, wScan: 0x45, dwFlags: W.KEYEVENTF.EXTENDEDKEY, time: 0, dwExtraInfo: W.EXTRA_INFO });
  assert.equal(ki(wp.keyInputFor({ vk: 0x2F }, true, () => 0x163)).wScan, 0x63); // MapVirtualKeyW fallback
  assert.equal(wp.keyInputFor({ sc: 0x1E }, true).type, W.INPUT_KEYBOARD);
});

test('win32 unicode inputs: down+up per UTF-16 unit', () => {
  const inputs = wp.unicodeInputs('a😀');
  assert.equal(inputs.length, 6);
  assert.deepEqual(inputs.map((i) => [i.u.ki.wScan, i.u.ki.dwFlags]), [
    [0x61, W.KEYEVENTF.UNICODE], [0x61, W.KEYEVENTF.UNICODE | W.KEYEVENTF.KEYUP],
    [0xD83D, W.KEYEVENTF.UNICODE], [0xD83D, W.KEYEVENTF.UNICODE | W.KEYEVENTF.KEYUP],
    [0xDE00, W.KEYEVENTF.UNICODE], [0xDE00, W.KEYEVENTF.UNICODE | W.KEYEVENTF.KEYUP],
  ]);
  for (const i of inputs) assert.equal(i.u.ki.wVk, 0);
});

test('win32 wheel accumulator: 100 CSS px ≈ 120 units, fractional carry, direction reset', () => {
  const acc = wp.createWheelAccumulator();
  assert.equal(acc.add(100), 120);
  assert.equal(acc.add(-50), -60);
  let total = 0;
  for (let i = 0; i < 10; i++) total += acc.add(0.5); // 0.6 units each
  assert.equal(total, 6);
  acc.add(0.5); // +0.6 remainder
  assert.equal(acc.add(-0.5), 0); // direction change drops the old +0.6 → -0.6
  assert.ok(Math.abs(acc.remainder + 0.6) < 1e-9);
});

function fakeWinNative({ swap = 0, insertLimit = Infinity } = {}) {
  const sent = [];
  const metrics = { [W.SM.XVIRTUALSCREEN]: -1920, [W.SM.YVIRTUALSCREEN]: 0, [W.SM.CXVIRTUALSCREEN]: 3840, [W.SM.CYVIRTUALSCREEN]: 1080, [W.SM.SWAPBUTTON]: swap };
  return {
    sent,
    metrics,
    cbSize: 40,
    SendInput(n, inputs, cbSize) {
      assert.equal(n, inputs.length);
      assert.equal(cbSize, 40);
      sent.push(inputs);
      return Math.min(n, insertLimit);
    },
    GetSystemMetrics: (i) => metrics[i] ?? 0,
    MapVirtualKeyW: (vkCode) => (vkCode === 0x2F ? 0x63 : 0),
  };
}

test('win32 backend: moves, buttons, wheel, keys and text against a fake user32', () => {
  const nat = fakeWinNative();
  const be = win32.createBackend(nat);
  assert.deepEqual(be.check(), { available: true, reason: null });

  be.moveTo(-1920, 0);
  be.moveTo(1919, 1079);
  const [m0] = nat.sent[0];
  const [m1] = nat.sent[1];
  assert.equal(m0.type, W.INPUT_MOUSE);
  assert.deepEqual(m0.u.mi, { dx: 0, dy: 0, mouseData: 0, dwFlags: W.MOUSEEVENTF.MOVE | W.MOUSEEVENTF.ABSOLUTE | W.MOUSEEVENTF.VIRTUALDESK, time: 0, dwExtraInfo: W.EXTRA_INFO });
  assert.equal(Math.floor((m1.u.mi.dx * 3840) / 65536) - 1920, 1919);
  assert.equal(Math.floor((m1.u.mi.dy * 1080) / 65536), 1079);

  nat.sent.length = 0;
  be.button(3, true, 10, 10, 1);
  assert.equal(nat.sent[0].length, 2); // move + button in one atomic SendInput
  assert.deepEqual([nat.sent[0][1].u.mi.dwFlags, nat.sent[0][1].u.mi.mouseData], [W.MOUSEEVENTF.XDOWN, W.XBUTTON1]);
  be.button(3, false);
  assert.equal(nat.sent[1].length, 1); // no position → no move
  assert.equal(nat.sent[1][0].u.mi.dwFlags, W.MOUSEEVENTF.XUP);

  nat.sent.length = 0;
  be.scroll(0, 100); // DOM down → negative wheel
  be.scroll(100, 0); // DOM right → positive hwheel
  be.scroll(0, 0.4); // 0.48 units → nothing yet
  assert.deepEqual(nat.sent.map((s) => s.map((i) => [i.u.mi.dwFlags, i.u.mi.mouseData])), [
    [[W.MOUSEEVENTF.WHEEL, -120]], [[W.MOUSEEVENTF.HWHEEL, 120]],
  ]);

  nat.sent.length = 0;
  assert.equal(be.key('KeyA', true, false), true);
  assert.equal(be.key('ArrowLeft', false, false), true);
  assert.equal(be.key('Pause', true, false), true);
  assert.equal(be.key('Help', true, false), true);
  assert.equal(be.key('Fn', true, false), false);
  assert.equal(be.key('constructor', true, false), false);
  const k = nat.sent.map((s) => s[0].u.ki);
  assert.deepEqual([k[0].wScan, k[0].dwFlags], [0x1E, W.KEYEVENTF.SCANCODE]);
  assert.deepEqual([k[1].wScan, k[1].dwFlags], [0x4B, W.KEYEVENTF.SCANCODE | W.KEYEVENTF.EXTENDEDKEY | W.KEYEVENTF.KEYUP]);
  assert.deepEqual([k[2].wVk, k[2].wScan, k[2].dwFlags], [0x13, 0x45, 0]);
  assert.deepEqual([k[3].wVk, k[3].wScan], [0x2F, 0x63]);
  assert.equal(nat.sent.length, 4);

  nat.sent.length = 0;
  be.text('x'.repeat(3000)); // 6000 inputs → split into bounded SendInput calls, order preserved
  assert.deepEqual(nat.sent.map((s) => s.length), [4096, 1904]);
  for (const batch of nat.sent) for (const i of batch) assert.equal(i.u.ki.dwExtraInfo, W.EXTRA_INFO);
});

test('win32 backend: swapped mouse buttons press and release the same physical button', () => {
  const nat = fakeWinNative({ swap: 1 });
  const be = win32.createBackend(nat);
  be.button(0, true, 0, 0, 1); // logical primary on a left-handed setup → physical right
  nat.metrics[W.SM.SWAPBUTTON] = 0; // user flips the setting mid-press
  be.button(0, false, 0, 0, 1);
  assert.equal(nat.sent[0][1].u.mi.dwFlags, W.MOUSEEVENTF.RIGHTDOWN);
  assert.equal(nat.sent[1][1].u.mi.dwFlags, W.MOUSEEVENTF.RIGHTUP);
});

test('win32 backend: blocked SendInput (UIPI / secure desktop) does not throw', () => {
  const nat = fakeWinNative({ insertLimit: 0 });
  const be = win32.createBackend(nat);
  const warn = console.warn;
  console.warn = () => {};
  try {
    be.key('KeyA', true, false);
    be.text('hello');
  } finally {
    console.warn = warn;
  }
});

test('win32 backend: mask() is one SendInput of VK 0xE8 down+up (no scancode flag, Tunnelview marker)', () => {
  const nat = fakeWinNative();
  const be = win32.createBackend(nat);
  be.mask();
  assert.equal(nat.sent.length, 1);
  assert.deepEqual(nat.sent[0].map((i) => [i.type, i.u.ki.wVk, i.u.ki.wScan, i.u.ki.dwFlags, i.u.ki.dwExtraInfo]), [
    [W.INPUT_KEYBOARD, 0xE8, 0, 0, W.EXTRA_INFO],
    [W.INPUT_KEYBOARD, 0xE8, 0, W.KEYEVENTF.KEYUP, W.EXTRA_INFO],
  ]);
  assert.equal(W.VK_MASK, 0xE8);
});

test('win32 backend: tapLock() taps VK_CAPITAL / VK_NUMLOCK by virtual key (no scancode flag), one SendInput each', () => {
  const nat = fakeWinNative();
  const mapped = [];
  nat.MapVirtualKeyW = (code, type) => { mapped.push([code, type]); return code === W.VK_CAPITAL ? 0x3A : code === W.VK_NUMLOCK ? 0x45 : 0; };
  const be = win32.createBackend(nat);
  assert.equal(be.tapLock('caps'), true);
  assert.equal(be.tapLock('num'), true);
  for (const bad of ['scroll', 'CapsLock', 'constructor', undefined]) assert.equal(be.tapLock(bad), false, String(bad));
  assert.equal(nat.sent.length, 2);
  const rows = (batch) => batch.map((i) => [i.type, i.u.ki.wVk, i.u.ki.wScan, i.u.ki.dwFlags, i.u.ki.dwExtraInfo]);
  assert.deepEqual(rows(nat.sent[0]), [
    [W.INPUT_KEYBOARD, 0x14, 0x3A, 0, W.EXTRA_INFO],
    [W.INPUT_KEYBOARD, 0x14, 0x3A, W.KEYEVENTF.KEYUP, W.EXTRA_INFO],
  ]);
  assert.deepEqual(rows(nat.sent[1]), [
    [W.INPUT_KEYBOARD, 0x90, 0x45, W.KEYEVENTF.EXTENDEDKEY, W.EXTRA_INFO],
    [W.INPUT_KEYBOARD, 0x90, 0x45, W.KEYEVENTF.EXTENDEDKEY | W.KEYEVENTF.KEYUP, W.EXTRA_INFO],
  ]);
  assert.deepEqual(mapped, [[0x14, 0], [0x90, 0]]); // MAPVK_VK_TO_VSC

  // The viewer's own CapsLock key is still the physical scancode (Eisu on a JIS host, as there).
  be.key('CapsLock', true, false);
  assert.deepEqual([nat.sent[2][0].u.ki.wVk, nat.sent[2][0].u.ki.wScan, nat.sent[2][0].u.ki.dwFlags], [0, 0x3A, W.KEYEVENTF.SCANCODE]);

  nat.MapVirtualKeyW = () => { throw new Error('no layout'); }; // wScan is informational: still taps
  assert.equal(be.tapLock('caps'), true);
  assert.deepEqual(rows(nat.sent[3])[1], [W.INPUT_KEYBOARD, 0x14, 0, W.KEYEVENTF.KEYUP, W.EXTRA_INFO]);
  assert.deepEqual(rows(wp.lockTapInputs('caps')), [ // pure helper without MapVirtualKeyW
    [W.INPUT_KEYBOARD, 0x14, 0, 0, W.EXTRA_INFO],
    [W.INPUT_KEYBOARD, 0x14, 0, W.KEYEVENTF.KEYUP, W.EXTRA_INFO],
  ]);
  assert.equal(wp.lockTapInputs('toString'), null);
});

test('win32 backend: takeShortfall reports (once) that SendInput inserted fewer events', () => {
  const nat = fakeWinNative({ insertLimit: 0 });
  const be = win32.createBackend(nat);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(be.takeShortfall(), false);
    be.key('KeyA', true, false);
    assert.equal(be.takeShortfall(), true);
    assert.equal(be.takeShortfall(), false);
  } finally {
    console.warn = warn;
  }
  const ok = win32.createBackend(fakeWinNative());
  ok.text('hello');
  assert.equal(ok.takeShortfall(), false);
});

test('win32 integrity RID parsing is bounds-checked', () => {
  // TOKEN_MANDATORY_LABEL (x64: Sid ptr + Attributes + pad = 16 B) followed by S-1-16-8192 (medium)
  const buf = Buffer.alloc(64);
  Buffer.from([1, 1, 0, 0, 0, 0, 0, 16, 0x00, 0x20, 0, 0]).copy(buf, 16);
  assert.equal(wp.integrityRid(buf, 28, 16), 0x2000);
  buf.writeUInt32LE(0x3000, 24);
  assert.equal(wp.integrityRid(buf, 28, 16), 0x3000);
  assert.equal(wp.integrityRid(buf, 27, 16), null); // RID not fully inside what was written
  assert.equal(wp.integrityRid(buf, 28, 24), null);
  assert.equal(wp.integrityRid(buf, 28, -1), null);
  assert.equal(wp.integrityRid(buf, 28, 1.5), null);
  assert.equal(wp.integrityRid(buf, 100, 16), null); // len > buffer
  buf[17] = 0; // SubAuthorityCount 0
  assert.equal(wp.integrityRid(buf, 28, 16), null);
  buf[17] = 1;
  buf[16] = 2; // bad revision
  assert.equal(wp.integrityRid(buf, 28, 16), null);
  assert.equal(wp.integrityRid('x', 28, 16), null);

  assert.equal(wp.utf16z(Buffer.from('Default\0garbage', 'utf16le')), 'Default');
  assert.equal(wp.utf16z(Buffer.alloc(8)), '');
  const mi = Buffer.alloc(104);
  mi.writeUInt32LE(104, 0);
  [-2560, -200, 0, 1240].forEach((v, i) => mi.writeInt32LE(v, 4 + i * 4));
  assert.deepEqual(wp.monitorInfoRect(mi), { x: -2560, y: -200, width: 2560, height: 1440 });
  assert.equal(wp.monitorInfoRect(Buffer.alloc(104)), null); // empty rect
});

test('win32 decideBlocked: secure desktop, elevated targets, everything else null', () => {
  const s = (o) => wp.decideBlocked({ inputDesktop: 'Default', ownDesktop: 'Default', targetRid: () => 0x2000, ownRid: () => 0x2000, ...o });
  assert.equal(s({}), null);
  assert.equal(s({ inputDesktop: false }), 'secure-desktop'); // OpenInputDesktop failed (Winlogon / UAC)
  assert.equal(s({ inputDesktop: 'Winlogon' }), 'secure-desktop');
  assert.equal(s({ inputDesktop: 'Screen-saver' }), 'secure-desktop');
  assert.equal(s({ inputDesktop: 'default' }), null); // object names are case-insensitive
  assert.equal(s({ inputDesktop: 'Desktop2', ownDesktop: 'Desktop2' }), null); // we live on another desktop
  assert.equal(s({ inputDesktop: 'Default', ownDesktop: null }), null);
  assert.equal(s({ inputDesktop: null }), null); // name unknown → integrity check only
  assert.equal(s({ targetRid: () => 0x3000 }), 'elevated-window');
  assert.equal(s({ targetRid: () => 0x4000 }), 'elevated-window');
  assert.equal(s({ targetRid: () => 'denied' }), 'elevated-window');
  assert.equal(s({ targetRid: () => 0x1000 }), null); // low integrity (AppContainer) receives our input
  assert.equal(s({ targetRid: () => 0x3000, ownRid: () => 0x3000 }), null); // we are elevated too
  assert.equal(s({ targetRid: () => null }), null);
  assert.equal(s({ targetRid: () => 0x3000, ownRid: () => null }), null);
});

const OTHER_PID = process.pid + 1; // a window of another process

function fakeProbe(over = {}) {
  const ex = {
    desk: 'Default', own: 'Default', pid: OTHER_PID, rids: { self: 0x2000, [OTHER_PID]: 0x2000 }, pts: [], ridCalls: [],
    toggled: { [W.VK_CAPITAL]: false, [W.VK_NUMLOCK]: true }, monitor: { x: 0, y: 0, width: 2560, height: 1440 },
    ...over,
  };
  ex.layer = {
    inputDesktop: () => ex.desk,
    ownDesktop: () => ex.own,
    windowPid: (pt) => { ex.pts.push(pt); return ex.pid; },
    processRid: (pid) => { ex.ridCalls.push(pid); return Object.prototype.hasOwnProperty.call(ex.rids, pid) ? ex.rids[pid] : null; },
    monitorRect: (pt) => { ex.pts.push(pt); return ex.monitor; },
    keyToggled: (vk) => ex.toggled[vk],
  };
  return ex;
}

test('win32 backend: blockedReason over a fake probe layer', () => {
  const ex = fakeProbe();
  const nat = fakeWinNative();
  nat.extras = ex.layer;
  const be = win32.createBackend(nat);
  assert.equal(be.blockedReason(null), null);
  assert.deepEqual(ex.pts, [null]); // no point → foreground window
  assert.equal(be.blockedReason({ x: 100.4, y: -20 }), null);
  assert.deepEqual(ex.pts.at(-1), { x: 100.4, y: -20 });
  assert.equal(be.blockedReason({ x: NaN, y: 0 }), null);
  assert.equal(ex.pts.at(-1), null); // invalid point → foreground window

  ex.rids[OTHER_PID] = 0x3000;
  assert.equal(be.blockedReason(null), 'elevated-window');
  ex.rids[OTHER_PID] = 'denied';
  assert.equal(be.blockedReason({ x: 1, y: 1 }), 'elevated-window');
  ex.desk = false;
  assert.equal(be.blockedReason(null), 'secure-desktop');
  ex.desk = 'Winlogon';
  assert.equal(be.blockedReason(null), 'secure-desktop');
  ex.desk = 'Default';
  ex.pid = 0; // no window there
  assert.equal(be.blockedReason(null), null);
  ex.pid = process.pid; // our own window: never queried
  const n = ex.ridCalls.length;
  assert.equal(be.blockedReason(null), null);
  assert.equal(ex.ridCalls.length, n);
  assert.equal(ex.ridCalls.filter((p) => p === 'self').length, 1, 'own RID is read once');

  ex.layer.inputDesktop = () => { throw new Error('boom'); };
  assert.equal(be.blockedReason(null), null);
  assert.equal(win32.createBackend(fakeWinNative()).blockedReason(null), null); // no probe layer
});

test('win32 backend: lockState and monitorRect over a fake probe layer', () => {
  const ex = fakeProbe();
  const nat = fakeWinNative();
  nat.extras = ex.layer;
  const be = win32.createBackend(nat);
  assert.deepEqual(be.lockState(), { caps: false, num: true });
  ex.toggled[W.VK_CAPITAL] = true;
  assert.deepEqual(be.lockState(), { caps: true, num: true });
  ex.toggled[W.VK_NUMLOCK] = undefined;
  assert.equal(be.lockState(), null);

  assert.deepEqual(be.monitorRect({ x: 1280, y: 720 }), { x: 0, y: 0, width: 2560, height: 1440 });
  assert.deepEqual(ex.pts.at(-1), { x: 1280, y: 720 });
  assert.equal(be.monitorRect(null), null);
  assert.equal(be.monitorRect({ x: Infinity, y: 0 }), null);
  for (const bad of [null, { x: 0, y: 0, width: 0, height: 10 }, { x: 0.5, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: '10', height: 10 }]) {
    ex.monitor = bad;
    assert.equal(be.monitorRect({ x: 1, y: 1 }), null, JSON.stringify(bad));
  }
  const bare = win32.createBackend(fakeWinNative());
  assert.equal(bare.lockState(), null);
  assert.equal(bare.monitorRect({ x: 1, y: 1 }), null);
});

test('win32 probe helpers: real read-only calls (no input injected)', { skip: process.platform !== 'win32' }, () => {
  const ex = win32.loadExtras();
  assert.ok(ex, 'helpers load');
  const desk = ex.inputDesktop();
  assert.ok(desk === false || desk === null || typeof desk === 'string');
  const own = ex.ownDesktop();
  assert.ok(own === null || typeof own === 'string');
  const rid = ex.processRid('self');
  assert.ok(Number.isInteger(rid) && rid >= 0x1000 && rid <= 0x4000, String(rid));
  assert.equal(ex.processRid(0), null); // System Idle Process: ERROR_INVALID_PARAMETER, not "denied"
  assert.ok(Number.isInteger(ex.windowPid(null)));
  assert.equal(typeof ex.keyToggled(W.VK_CAPITAL), 'boolean');
  const m = ex.monitorRect({ x: 0, y: 0 });
  assert.ok(m === null || (Number.isInteger(m.width) && m.width > 0 && Number.isInteger(m.height) && m.height > 0));
  // the backend methods built on them (still read-only)
  const be = win32.createBackend();
  assert.ok([null, 'secure-desktop', 'elevated-window'].includes(be.blockedReason(null)));
  const ls = be.lockState();
  assert.ok(ls === null || (typeof ls.caps === 'boolean' && typeof ls.num === 'boolean'));
});

test('win32 native bindings: INPUT layout matches the ABI (no SendInput call)', { skip: process.platform !== 'win32' }, () => {
  const nat = win32.loadNative();
  const ptr = nat.koffi.sizeof('void *');
  assert.equal(nat.cbSize, ptr === 8 ? 40 : 28);
  assert.equal(nat.koffi.sizeof(nat.INPUT), nat.cbSize);
  assert.equal(nat.koffi.offsetof(nat.INPUT, 'u'), ptr === 8 ? 8 : 4);
  assert.equal(typeof nat.SendInput, 'function');
  // GetSystemMetrics has no side effects (values may be 0 in a non-interactive CI session)
  assert.ok(Number.isInteger(nat.GetSystemMetrics(W.SM.CXVIRTUALSCREEN)));
  assert.ok(Number.isInteger(nat.GetSystemMetrics(W.SM.YVIRTUALSCREEN)));
});

test('changecount.get() returns a positive integer or null and never throws', () => {
  const changecount = require('../src/main/native/changecount');
  for (let i = 0; i < 2; i++) {
    const v = changecount.get();
    // null when unsupported or (Windows) without clipboard access, e.g. a service session
    assert.ok(v === null || (Number.isInteger(v) && v > 0), String(v));
  }
});

// ---------------------------------------------------------------------------------------------
// darwin backend (pure helpers + fake CoreGraphics)
// ---------------------------------------------------------------------------------------------

const D = darwin.constants;
const dp = darwin._pure;

test('darwin helpers: drag types, buttons, implicit flags, UTF-16 chunking', () => {
  assert.deepEqual(dp.moveEventType(new Set()), { type: D.EVT.MouseMoved, button: 0 });
  assert.deepEqual(dp.moveEventType(new Set([2, 0])), { type: D.EVT.LeftMouseDragged, button: 0 });
  assert.deepEqual(dp.moveEventType(new Set([2])), { type: D.EVT.RightMouseDragged, button: 1 });
  assert.deepEqual(dp.moveEventType(new Set([1])), { type: D.EVT.OtherMouseDragged, button: 2 });
  assert.deepEqual(dp.moveEventType(new Set([4])), { type: D.EVT.OtherMouseDragged, button: 4 });
  assert.deepEqual([0, 1, 2, 3, 4].map(dp.cgButton), [0, 2, 1, 3, 4]);
  assert.equal(dp.buttonEventType(0, true), D.EVT.LeftMouseDown);
  assert.equal(dp.buttonEventType(2, false), D.EVT.RightMouseUp);
  assert.equal(dp.buttonEventType(3, true), D.EVT.OtherMouseDown);
  assert.equal(dp.implicitKeyFlags(0x7B), D.FLAG.NumericPad | D.FLAG.SecondaryFn);
  assert.equal(dp.implicitKeyFlags(0x57), D.FLAG.NumericPad);
  assert.equal(dp.implicitKeyFlags(0x60), D.FLAG.SecondaryFn);
  assert.equal(dp.implicitKeyFlags(0x00), 0);
  assert.deepEqual(dp.utf16Chunks('a'.repeat(45)).map((c) => c.length), [20, 20, 5]);
  const s = 'a'.repeat(19) + '😀' + 'b';
  const chunks = dp.utf16Chunks(s);
  assert.deepEqual(chunks, ['a'.repeat(19), '😀b']);
  assert.equal(chunks.join(''), s);
  assert.deepEqual(dp.utf16Chunks(''), []);
});

function fakeMacNative({ trusted = 1, hidFlags = 0, kbdType, layoutOf, sourceKbdType } = {}) {
  let next = 100n;
  const live = new Set();
  const log = [];
  const events = new Map(); // handle → record
  const create = (rec) => {
    const h = next++;
    live.add(h);
    events.set(h, { ...rec, fields: {}, flags: null, posted: false });
    log.push(['create', h]);
    return h;
  };
  const ev = (h) => {
    assert.ok(live.has(h), 'use of a released/unknown event');
    return events.get(h);
  };
  const nat = {
    log, live, events,
    posted: () => [...events.values()].filter((e) => e.posted),
    CGEventSourceCreate: (state) => { assert.equal(state, D.kCGEventSourceStateHIDSystemState); return 1n; },
    CGEventSourceSetLocalEventsSuppressionInterval: (src, s) => { assert.equal(src, 1n); assert.equal(s, 0); log.push(['suppress', s]); },
    hidFlags,
    CGEventSourceFlagsState: () => nat.hidFlags,
    CGEventCreateMouseEvent: (src, type, pt, button) => {
      assert.equal(src, 1n);
      assert.ok(Number.isFinite(pt.x) && Number.isFinite(pt.y));
      return create({ kind: 'mouse', type, x: pt.x, y: pt.y, button });
    },
    CGEventCreateKeyboardEvent: (src, keycode, down) => {
      assert.equal(typeof down, 'boolean');
      return create({ kind: 'key', type: down ? D.EVT.KeyDown : D.EVT.KeyUp, keycode });
    },
    CGEventCreateScrollWheelEvent2: (src, unit, count, w1, w2, w3) => {
      assert.equal(unit, D.kCGScrollEventUnitPixel);
      assert.equal(count, 2);
      assert.ok(Number.isInteger(w1) && Number.isInteger(w2));
      return create({ kind: 'scroll', type: D.EVT.ScrollWheel, w1, w2, w3 });
    },
    CGEventSetFlags: (h, f) => { ev(h).flags = f; },
    CGEventSetType: (h, t) => { ev(h).type = t; },
    CGEventSetIntegerValueField: (h, field, v) => { ev(h).fields[field] = v; },
    CGEventKeyboardSetUnicodeString: (h, len, units) => {
      assert.ok(units instanceof Uint16Array);
      assert.equal(len, units.length);
      assert.ok(len <= 20);
      ev(h).text = String.fromCharCode(...units);
    },
    CGEventPost: (tap, h) => { assert.equal(tap, D.kCGHIDEventTap); ev(h).posted = true; },
    CFRelease: (h) => { assert.ok(live.delete(h), 'double/invalid CFRelease'); log.push(['release', h]); },
    AXIsProcessTrusted: () => trusted,
  };
  // optional HIToolbox / CG keyboard-type functions (absent → the backend assumes ANSI)
  if (kbdType !== undefined) nat.LMGetKbdType = () => nat.kbdType;
  nat.kbdType = kbdType;
  if (layoutOf) nat.KBGetLayoutType = (t) => { assert.ok(Number.isInteger(t) && t > 0 && t <= 0x7FFF); return layoutOf(t); };
  if (sourceKbdType !== undefined) nat.CGEventSourceGetKeyboardType = (src) => { assert.equal(src, 1n); return sourceKbdType; };
  return nat;
}

const ISO_TYPE = 0x2B; // e.g. an ISO Apple keyboard type
const layoutOf = (t) => (t === ISO_TYPE ? D.kKeyboardISO : 0x414E5349 /* 'ANSI' */);

test('darwin backend: permission check', () => {
  assert.deepEqual(darwin.createBackend(fakeMacNative({ trusted: 1 })).check(), { available: true, reason: null });
  assert.deepEqual(darwin.createBackend(fakeMacNative({ trusted: 0 })).check(), { available: false, reason: 'accessibility-permission' });
});

test('darwin backend: source setup, moves, drags, clicks; every event released', () => {
  const nat = fakeMacNative();
  const be = darwin.createBackend(nat);
  assert.deepEqual(nat.log[0], ['suppress', 0]);

  be.moveTo(100, 200);
  be.button(0, true, 110, 205, 2);
  be.moveTo(150, 250);
  be.button(0, false, 150, 250, 2);
  be.button(1, true, 150, 250, 1);
  be.moveTo(160, 240);
  be.button(1, false, 160, 240, 1);
  be.button(2, true, 160, 240, 1);
  be.moveTo(170, 240);
  be.button(2, false, undefined, undefined, 1); // release at last position
  be.moveTo(171, 240);

  const p = nat.posted();
  assert.deepEqual(p.map((e) => [e.type, e.button]), [
    [D.EVT.MouseMoved, 0], [D.EVT.LeftMouseDown, 0], [D.EVT.LeftMouseDragged, 0], [D.EVT.LeftMouseUp, 0],
    [D.EVT.OtherMouseDown, 2], [D.EVT.OtherMouseDragged, 2], [D.EVT.OtherMouseUp, 2],
    [D.EVT.RightMouseDown, 1], [D.EVT.RightMouseDragged, 1], [D.EVT.RightMouseUp, 1], [D.EVT.MouseMoved, 0],
  ]);
  assert.equal(p[1].fields[D.FIELD.MouseEventClickState], 2);
  assert.equal(p[3].fields[D.FIELD.MouseEventClickState], 2);
  assert.equal(p[4].fields[D.FIELD.MouseEventButtonNumber], 2);
  assert.equal(p[1].fields[D.FIELD.MouseEventButtonNumber], undefined);
  assert.deepEqual([p[9].x, p[9].y], [170, 240]);
  assert.deepEqual([p[2].fields[D.FIELD.MouseEventDeltaX], p[2].fields[D.FIELD.MouseEventDeltaY]], [40, 45]);
  for (const e of p) assert.equal(e.fields[D.FIELD.EventSourceUserData], D.TAG);
  for (const e of p) assert.equal(e.flags, 0);
  assert.equal(nat.live.size, 0, 'every created event must be CFReleased');
});

test('darwin backend: no cursor warp when releasing a button without any known position', () => {
  const nat = fakeMacNative();
  const be = darwin.createBackend(nat);
  be.button(0, false, undefined, undefined, 1);
  assert.equal(nat.posted().length, 0);
});

test('darwin backend: modifiers as FlagsChanged, flags applied to keys, mouse and scroll', () => {
  const nat = fakeMacNative();
  const be = darwin.createBackend(nat);
  const F = D.FLAG;
  be.key('ShiftLeft', true, false);
  be.key('ShiftLeft', true, true); // repeat of a modifier → nothing
  be.key('MetaRight', true, false);
  be.key('KeyA', true, false);
  be.key('KeyA', true, true);
  be.moveTo(5, 5);
  be.scroll(0, 30);
  be.key('KeyA', false, false);
  be.key('MetaRight', false, false);
  be.key('ShiftLeft', false, false);
  be.key('ShiftLeft', false, false); // not held → nothing

  const p = nat.posted();
  const shift = F.Shift | D.NX.LSHIFT;
  const both = shift | F.Command | D.NX.RCMD;
  assert.deepEqual(p.map((e) => [e.type, e.keycode, e.flags]), [
    [D.EVT.FlagsChanged, 0x38, shift],
    [D.EVT.FlagsChanged, 0x36, both],
    [D.EVT.KeyDown, 0x00, both],
    [D.EVT.KeyDown, 0x00, both],
    [D.EVT.MouseMoved, undefined, both],
    [D.EVT.ScrollWheel, undefined, both],
    [D.EVT.KeyUp, 0x00, both],
    [D.EVT.FlagsChanged, 0x36, shift],
    [D.EVT.FlagsChanged, 0x38, 0],
  ]);
  assert.equal(p[2].fields[D.FIELD.KeyboardEventAutorepeat], undefined);
  assert.equal(p[3].fields[D.FIELD.KeyboardEventAutorepeat], 1);
  assert.deepEqual([p[5].w1, p[5].w2], [-30, 0]);
  assert.equal(nat.live.size, 0);
});

test('darwin backend: caps lock toggles a virtual alphaShift; arrows get NumericPad|Fn', () => {
  const nat = fakeMacNative();
  const be = darwin.createBackend(nat);
  be.key('CapsLock', true, false);
  be.key('CapsLock', false, false);
  be.key('KeyB', true, false);
  be.key('ArrowUp', true, false);
  be.key('CapsLock', true, false);
  be.key('KeyB', true, false);
  const p = nat.posted();
  assert.deepEqual(p.map((e) => [e.type, e.flags]), [
    [D.EVT.FlagsChanged, D.FLAG.AlphaShift],
    [D.EVT.KeyDown, D.FLAG.AlphaShift],
    [D.EVT.KeyDown, D.FLAG.AlphaShift | D.FLAG.NumericPad | D.FLAG.SecondaryFn],
    [D.EVT.FlagsChanged, 0],
    [D.EVT.KeyDown, 0],
  ]);
  // initial caps state is taken from the HID system state
  const nat2 = fakeMacNative({ hidFlags: D.FLAG.AlphaShift });
  const be2 = darwin.createBackend(nat2);
  be2.key('KeyB', true, false);
  assert.equal(nat2.posted()[0].flags, D.FLAG.AlphaShift);
});

test('darwin backend: unicode text in ≤20-unit chunks, flags 0, down+up', () => {
  const nat = fakeMacNative();
  const be = darwin.createBackend(nat);
  be.key('ControlLeft', true, false); // must not leak into text events
  const text = 'x'.repeat(19) + '😀' + 'y'.repeat(25);
  be.text(text);
  const p = nat.posted().filter((e) => e.type !== D.EVT.FlagsChanged);
  assert.deepEqual(p.map((e) => [e.type, e.text.length, e.flags]), [
    [D.EVT.KeyDown, 19, 0], [D.EVT.KeyUp, 19, 0],
    [D.EVT.KeyDown, 20, 0], [D.EVT.KeyUp, 20, 0],
    [D.EVT.KeyDown, 7, 0], [D.EVT.KeyUp, 7, 0],
  ]);
  assert.equal(p.filter((e) => e.type === D.EVT.KeyDown).map((e) => e.text).join(''), text);
  assert.equal(nat.live.size, 0);
});

test('darwin backend: scroll accumulation and directions', () => {
  const nat = fakeMacNative();
  const be = darwin.createBackend(nat);
  be.scroll(0, 0.4);
  be.scroll(0, 0.4);
  be.scroll(0, 0.4); // 1.2 px accumulated → wheel1 = -1
  be.scroll(12, 0); // right → wheel2 negative
  const p = nat.posted();
  assert.deepEqual(p.map((e) => [e.w1, e.w2, e.w3]), [[-1, 0, 0], [0, -12, 0]]);
});

test('darwin backend: setCaps / lockState drive the emulated Caps Lock', () => {
  const nat = fakeMacNative();
  const be = darwin.createBackend(nat);
  assert.deepEqual(be.lockState(), { caps: false, num: null });
  be.setCaps(true);
  assert.deepEqual(be.lockState(), { caps: true, num: null });
  be.key('KeyB', true, false);
  assert.equal(nat.posted().at(-1).flags, D.FLAG.AlphaShift);
  be.setCaps('yes'); // ignored
  be.setCaps(undefined);
  assert.equal(be._state().caps, true);
  be.setCaps(false);
  be.key('KeyB', true, false);
  assert.equal(nat.posted().at(-1).flags, 0);
  assert.equal(nat.live.size, 0);
});

test('darwin backend: reset() re-reads the real Caps Lock so an emulated one never carries over', () => {
  const nat = fakeMacNative({ hidFlags: 0 });
  const be = darwin.createBackend(nat);
  be.key('CapsLock', true, false); // viewer turns caps on (emulated)
  assert.equal(be._state().caps, true);
  be.reset(); // session end
  assert.equal(be._state().caps, false);
  be.key('KeyB', true, false);
  assert.equal(nat.posted().at(-1).flags, 0);
  nat.hidFlags = D.FLAG.AlphaShift | D.FLAG.Shift; // host user turned the real Caps Lock on meanwhile
  be.reset();
  assert.equal(be._state().caps, true);
  nat.CGEventSourceFlagsState = () => { throw new Error('flags boom'); };
  be.setCaps(true);
  be.reset();
  assert.equal(be._state().caps, false);
});

test('darwin detectIsoKeyboard: LMGetKbdType first, else the source type; any failure → ANSI', () => {
  const detect = dp.detectIsoKeyboard;
  assert.equal(detect(fakeMacNative({ kbdType: ISO_TYPE, layoutOf }), 1n), true);
  assert.equal(detect(fakeMacNative({ kbdType: 40, layoutOf }), 1n), false);
  assert.equal(detect(fakeMacNative({ sourceKbdType: ISO_TYPE, layoutOf }), 1n), true); // no LMGetKbdType
  assert.equal(detect(fakeMacNative({ kbdType: 0, sourceKbdType: ISO_TYPE, layoutOf }), 1n), true);
  assert.equal(detect(fakeMacNative({ sourceKbdType: ISO_TYPE, layoutOf }), null), false); // no source
  assert.equal(detect(fakeMacNative({ kbdType: ISO_TYPE }), 1n), false); // no KBGetLayoutType
  assert.equal(detect(fakeMacNative(), 1n), false);
  assert.equal(detect(fakeMacNative({ sourceKbdType: 0x10000, layoutOf }), 1n), false); // not an SInt16
  const throwing = fakeMacNative({ kbdType: ISO_TYPE, layoutOf });
  throwing.KBGetLayoutType = () => { throw new Error('hitoolbox'); };
  assert.equal(detect(throwing, 1n), false);
  assert.equal(detect(fakeMacNative({ kbdType: ISO_TYPE, layoutOf: () => 0x49534F20n }), 1n), true); // BigInt-safe
});

test('darwin backend: ISO host swaps Backquote / IntlBackslash keycodes; ANSI host unchanged', () => {
  const keycodes = (nat, be) => {
    for (const code of ['Backquote', 'IntlBackslash', 'KeyA', 'Digit1']) be.key(code, true, false);
    return nat.posted().map((e) => e.keycode);
  };
  const iso = fakeMacNative({ kbdType: ISO_TYPE, layoutOf });
  assert.deepEqual(keycodes(iso, darwin.createBackend(iso)), [0x0A, 0x32, 0x00, 0x12]);
  const ansi = fakeMacNative({ kbdType: 40, layoutOf });
  assert.deepEqual(keycodes(ansi, darwin.createBackend(ansi)), [0x32, 0x0A, 0x00, 0x12]);
  const none = fakeMacNative();
  assert.deepEqual(keycodes(none, darwin.createBackend(none)), [0x32, 0x0A, 0x00, 0x12]);

  // keyboard swapped while running: picked up on reset()
  const nat = fakeMacNative({ kbdType: 40, layoutOf });
  const be = darwin.createBackend(nat);
  assert.equal(be._state().iso, false);
  nat.kbdType = ISO_TYPE;
  be.reset();
  assert.equal(be._state().iso, true);
  be.key('IntlBackslash', true, false);
  assert.equal(nat.posted().at(-1).keycode, 0x32);
});

test('darwin backend: unmapped keys and reset', () => {
  const nat = fakeMacNative();
  const be = darwin.createBackend(nat);
  assert.equal(be.key('ContextMenu', true, false), false);
  assert.equal(be.key('F24', true, false), false);
  assert.equal(be.key('toString', true, false), false);
  be.key('AltLeft', true, false);
  be.button(0, true, 1, 1, 1);
  be.reset();
  assert.equal(be._state().flags, 0);
  assert.deepEqual(be._state().pressed, []);
  be.moveTo(2, 2);
  assert.equal(nat.posted().at(-1).type, D.EVT.MouseMoved);
  assert.equal(nat.live.size, 0);
});
