'use strict';
/* node --test test/main-capture.test.js — capture.js with a fake `electron` (no Electron runtime). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

/* ------------------------------------------------------------------ fake electron */

const screen = new EventEmitter();
let displays = [
  { id: 1, label: 'Built-in', bounds: { x: 0, y: 0, width: 1707, height: 960 }, scaleFactor: 1.5 },
  { id: 2, label: 'External', bounds: { x: 1707, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 },
];
screen.getAllDisplays = () => displays.map((d) => ({ ...d, bounds: { ...d.bounds } }));
screen.getPrimaryDisplay = () => screen.getAllDisplays()[0];

let getSourcesCalls = 0;
const desktopCapturer = {
  async getSources() {
    getSourcesCalls++;
    return displays.map((d, i) => ({ id: `screen:${i}:0`, name: `Screen ${i + 1}`, display_id: String(d.id) }));
  },
};

const powerMonitor = new EventEmitter();
const fakeElectron = { screen, desktopCapturer, powerMonitor };
require.cache[require.resolve('electron')] = {
  id: require.resolve('electron'), filename: require.resolve('electron'), loaded: true, exports: fakeElectron,
};

const capture = require('../src/main/capture');

const setDisplayCalls = [];
const input = {
  setDisplay: (d) => setDisplayCalls.push(d && d.id),
  physicalRect: (d) => (d.id === 1 ? { x: 0, y: 0, width: 2560, height: 1440 } : null),
};
let handler = null;
let activeFrame = true;
capture.init({ setDisplayMediaRequestHandler: (fn) => { handler = fn; } }, {
  isActivePanelFrame: () => activeFrame,
  audioAllowed: () => true,
  input,
});

function request() {
  return new Promise((resolve) => handler({ frame: {}, videoRequested: true, audioRequested: false }, resolve));
}

/* ------------------------------------------------------------------ tests (run in order) */

test('list → select → select → display-media handler enumerates exactly once', async () => {
  capture.invalidate();
  getSourcesCalls = 0;
  const list = await capture.listDisplays();
  assert.equal(list.length, 2);
  const a = await capture.selectDisplay(list[1].id);
  const b = await capture.selectDisplay(list[1].id);
  assert.equal(a.ok, true);
  assert.equal(b.sourceId, 'screen:1:0');
  const streams = await request();
  assert.equal(streams.video.id, 'screen:1:0');
  assert.equal(getSourcesCalls, 1);
});

test('concurrent listDisplays calls share one enumeration (single flight)', async () => {
  capture.invalidate();
  getSourcesCalls = 0;
  const [x, y, z] = await Promise.all([capture.listDisplays(), capture.listDisplays(), capture.selectDisplay('2')]);
  assert.equal(x.length, 2);
  assert.deepEqual(x, y);
  assert.equal(z.ok, true);
  assert.equal(getSourcesCalls, 1);
  x[0].bounds.width = 1; // callers get copies
  assert.equal((await capture.listDisplays())[0].bounds.width, 1707);
});

test("a 'display-added' event forces a new enumeration", async () => {
  await capture.listDisplays();
  getSourcesCalls = 0;
  await capture.listDisplays();
  assert.equal(getSourcesCalls, 0, 'cached');
  displays = [...displays, { id: 3, label: 'TV', bounds: { x: 3627, y: 0, width: 1280, height: 720 }, scaleFactor: 1 }];
  screen.emit('display-added', {}, displays[2]);
  const list = await capture.listDisplays();
  assert.equal(getSourcesCalls, 1);
  assert.equal(list.length, 3);
  // The handler does not trust a map built before an invalidation.
  await capture.selectDisplay('3');
  getSourcesCalls = 0;
  screen.emit('display-metrics-changed', {}, displays[2], ['bounds']);
  const streams = await request();
  assert.equal(streams.video.id, 'screen:2:0');
  assert.equal(getSourcesCalls, 1);
});

test('selectDisplay only maps input when asked; commitDisplay maps it', async () => {
  setDisplayCalls.length = 0;
  await capture.selectDisplay('2');
  await request();
  assert.deepEqual(setDisplayCalls, [], 'select + display-media handler never move input');
  await capture.selectDisplay('1', { mapInput: true });
  assert.deepEqual(setDisplayCalls, [1]);
  assert.deepEqual(capture.commitDisplay('2'), { ok: true });
  assert.deepEqual(setDisplayCalls, [1, 2]);
  assert.deepEqual(capture.commitDisplay('99'), { ok: false, error: 'not-found' });
});

test('selected display unplugged → handler refreshes and falls back to the primary', async () => {
  await capture.selectDisplay('3');
  displays = displays.slice(0, 2);
  getSourcesCalls = 0;
  // No event (missed hot-plug): the map still names display 3 but its source is gone.
  capture.invalidate();
  const streams = await request();
  assert.equal(streams.video.id, 'screen:0:0');
  assert.equal(getSourcesCalls, 1);
});

test('the handler refuses frames that are not the active panel', async () => {
  activeFrame = false;
  assert.equal(await request(), null);
  activeFrame = true;
});

test('windows: physical size comes from input.physicalRect (no 2561×1440 rounding)', async () => {
  const list = await capture.listDisplays({ force: true });
  const d1 = list.find((d) => d.id === '1');
  if (process.platform === 'win32') {
    assert.equal(d1.width, 2560);
    assert.equal(d1.height, 1440);
  } else {
    assert.equal(d1.width, Math.round(1707 * 1.5));
  }
  assert.equal(list.find((d) => d.id === '2').width, 1920);
});

test('an enumeration without capturable screens is not cached', async () => {
  const orig = desktopCapturer.getSources;
  desktopCapturer.getSources = async () => { getSourcesCalls++; return []; };
  capture.invalidate();
  getSourcesCalls = 0;
  await capture.listDisplays();
  await capture.listDisplays();
  assert.equal(getSourcesCalls, 2);
  assert.deepEqual(await capture.selectDisplay('1'), { ok: false, error: 'capture-unavailable' });
  desktopCapturer.getSources = orig;
});

/* ------------------------------------------------------------------ runtime2-4: no enumeration at prompt time */

test('a valid cache of any age is reused by the prompt / session-start paths (0 getSources)', async () => {
  capture.invalidate();
  await capture.listDisplays(); // warmed at idle
  assert.equal(capture.hasCache(), true);
  const realNow = Date.now;
  Date.now = () => realNow() + 3 * 3600 * 1000; // hours later
  try {
    getSourcesCalls = 0;
    const list = await capture.listDisplays({ maxAgeMs: Infinity }); // index.js warmDisplays at prompt time
    assert.equal(list.length, 2);
    assert.equal((await capture.selectDisplay('2', { mapInput: true })).ok, true); // panelReady + the panel's select
    const streams = await request();
    assert.equal(streams.video.id, 'screen:1:0');
    assert.equal(getSourcesCalls, 0, 'no desktopCapturer call while a prompt shows or a session starts');
    // The panel's own list (display switch) still refreshes one older than a minute.
    await capture.listDisplays({ maxAgeMs: capture.LIST_MAX_AGE_MS });
    assert.equal(getSourcesCalls, 1);
  } finally {
    Date.now = realNow;
  }
  // NaN / garbage max ages fall back to the default instead of "never fresh".
  getSourcesCalls = 0;
  await capture.listDisplays({ maxAgeMs: NaN });
  assert.equal(getSourcesCalls, 0);
});

test('an invalidation followed by idle warms exactly once (debounced), never while canWarm() refuses', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  let allowed = true;
  let asked = 0;
  capture.setIdleWarm(() => { asked++; return allowed; }, { delayMs: 2000 });
  try {
    await capture.listDisplays({ force: true });
    getSourcesCalls = 0;
    // A hot-plug fires several screen events in a row.
    screen.emit('display-added', {}, displays[0]);
    t.mock.timers.tick(500);
    screen.emit('display-metrics-changed', {}, displays[0], ['bounds']);
    t.mock.timers.tick(500);
    screen.emit('display-metrics-changed', {}, displays[1], ['scaleFactor', 'workArea']);
    assert.equal(capture.hasCache(), false);
    t.mock.timers.tick(1999);
    await flush();
    assert.equal(getSourcesCalls, 0, 'debounced: not yet');
    t.mock.timers.tick(1);
    await flush();
    assert.equal(getSourcesCalls, 1, 'warmed once, 2 s after the last event');
    assert.equal(capture.hasCache(), true);
    // A taskbar / Dock resize (work area only) keeps the cache: no new stall.
    screen.emit('display-metrics-changed', {}, displays[0], ['workArea']);
    assert.equal(capture.hasCache(), true);
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(getSourcesCalls, 1);
    // A valid cache: scheduled warm-ups are free.
    capture.scheduleWarm(10);
    t.mock.timers.tick(10);
    await flush();
    assert.equal(getSourcesCalls, 1);

    // While a prompt shows (canWarm → false): nothing, until a later scheduleWarm() finds it idle.
    allowed = false;
    asked = 0;
    screen.emit('display-removed', {}, displays[1]);
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(asked, 1);
    assert.equal(getSourcesCalls, 1, 'skipped while a prompt is visible');
    allowed = true;
    capture.scheduleWarm(2000); // index.js: the prompt closed
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(getSourcesCalls, 2);
  } finally {
    capture.setIdleWarm(null);
  }
  // Disabled: invalidations schedule nothing.
  capture.invalidate();
  t.mock.timers.tick(5000);
  await flush();
  assert.equal(getSourcesCalls, 2);
});

test("powerMonitor 'resume' / 'unlock-screen' invalidate the list and schedule an idle warm-up (main3-2)", async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
  let allowed = true;
  capture.setIdleWarm(() => allowed, { delayMs: 2000 });
  try {
    for (const ev of ['unlock-screen', 'resume']) {
      await capture.listDisplays({ force: true });
      assert.equal(capture.hasCache(), true);
      getSourcesCalls = 0;
      powerMonitor.emit(ev);
      assert.equal(capture.hasCache(), false, `${ev} drops the cached enumeration`);
      t.mock.timers.tick(1999);
      await flush();
      assert.equal(getSourcesCalls, 0);
      t.mock.timers.tick(1);
      await flush();
      assert.equal(getSourcesCalls, 1, `${ev}: re-warmed 2 s later`);
      assert.equal(capture.hasCache(), true);
    }
    // 'lock-screen' alone changes nothing here (index.js's canWarm() refuses while locked).
    getSourcesCalls = 0;
    powerMonitor.emit('lock-screen');
    assert.equal(capture.hasCache(), true);
    // A refused warm-up (still locked after a resume) leaves the list empty until unlock.
    allowed = false;
    powerMonitor.emit('resume');
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(getSourcesCalls, 0);
    allowed = true;
    powerMonitor.emit('unlock-screen');
    t.mock.timers.tick(2000);
    await flush();
    assert.equal(getSourcesCalls, 1);
  } finally {
    capture.setIdleWarm(null);
  }
});

/* ------------------------------------------------------------------ panel2-4: served display */

test('after a fallback the served display is reported; committing the vanished one is refused', async () => {
  capture.reset();
  assert.equal(capture.servedDisplayId(), null, 'nothing served yet this session');
  displays = [...displays, { id: 4, label: 'Projector', bounds: { x: 3627, y: 0, width: 1280, height: 720 }, scaleFactor: 1 }];
  capture.invalidate();
  assert.equal((await capture.selectDisplay('4')).ok, true);
  assert.equal((await request()).video.id, 'screen:2:0');
  assert.equal(capture.servedDisplayId(), '4');
  // Display A (4) is unplugged before the next getDisplayMedia(): the handler falls back to primary P (1).
  displays = displays.slice(0, 2);
  capture.invalidate();
  const streams = await request();
  assert.equal(streams.video.id, 'screen:0:0');
  assert.equal(capture.servedDisplayId(), '1', 'P, in the panel:list-displays id format');
  assert.deepEqual(capture.commitDisplay('4'), { ok: false, error: 'not-found' });
  assert.deepEqual(capture.commitDisplay(capture.servedDisplayId()), { ok: true });
  capture.reset();
  assert.equal(capture.servedDisplayId(), null);
});
