'use strict';
/* node --test test/main-windows.test.js — windows.js with a fake `electron` (no Electron runtime). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

/* ------------------------------------------------------------------ fake electron */

let wcIds = 5000;
class FakeWC extends EventEmitter {
  constructor() { super(); this.id = wcIds++; this.destroyed = false; }
  isDestroyed() { return this.destroyed; }
  send() {}
  getURL() { return ''; }
  setWebRTCUDPPortRange() {}
  openDevTools() {}
}
class FakeBW extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.webContents = new FakeWC();
    this.destroyed = false;
  }
  /** Like Electron: the promise settles when the page finished / failed loading. */
  loadFile(file) {
    this.file = file;
    return new Promise((resolve, reject) => { this.resolveLoad = resolve; this.rejectLoad = reject; });
  }
  isDestroyed() { return this.destroyed; }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('closed');
    this.webContents.destroyed = true;
  }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  showInactive() {}
}
const workArea = { x: 0, y: 0, width: 1920, height: 1040 };
const fakeElectron = {
  app: { isPackaged: true },
  BrowserWindow: FakeBW,
  nativeTheme: { shouldUseDarkColors: true },
  webContents: { fromFrame: () => null },
  screen: { getPrimaryDisplay: () => ({ workArea }), getDisplayMatching: () => ({ workArea }) },
  nativeImage: { createEmpty: () => ({ isEmpty: () => true }), createFromBitmap: () => ({ isEmpty: () => true, addRepresentation() {} }) },
};
require.cache[require.resolve('electron')] = {
  id: require.resolve('electron'), filename: require.resolve('electron'), loaded: true, exports: fakeElectron,
};

const windows = require('../src/main/windows');

const tick = () => new Promise((r) => setImmediate(r));

/** Run fn with console.error captured. */
async function captureErrors(fn) {
  const errors = [];
  const orig = console.error;
  console.error = (...args) => errors.push(args.map(String).join(' '));
  try { await fn(); } finally { console.error = orig; }
  return errors;
}

/* ------------------------------------------------------------------ runtime3-6 */

test('a window destroyed while its page loads logs nothing; a live window\'s load failure is still logged', async () => {
  const errors = await captureErrors(async () => {
    // The pre-created (hidden) session panel discarded before it finished loading.
    const warm = windows.createPanel({ sessionId: null }, { hidden: true });
    warm.destroy();
    warm.rejectLoad(new Error("ERR_FAILED (-2) loading 'file:///Tunnelview/src/renderer/panel/index.html'"));
    await tick();

    // 'closed' already emitted while isDestroyed() still answers false (teardown order).
    const prompt = windows.createPrompt({ requestId: 'r1' });
    prompt.emit('closed');
    prompt.rejectLoad(new Error("ERR_ABORTED (-3) loading 'file:///Tunnelview/src/renderer/prompt/index.html'"));
    await tick();

    // Only the WebContents is gone.
    const panel2 = windows.createPanel({ sessionId: 's' }, { hidden: true });
    panel2.webContents.destroyed = true;
    panel2.rejectLoad(new Error('ERR_FAILED (-2) loading'));
    await tick();
  });
  assert.deepEqual(errors, [], 'discarded windows are not reported as broken installs');

  const live = await captureErrors(async () => {
    const win = windows.createPrompt({ requestId: 'r2' });
    win.rejectLoad(new Error("ERR_FILE_NOT_FOUND (-6) loading 'file:///Tunnelview/src/renderer/prompt/index.html'"));
    await tick();
    win.destroy();
  });
  assert.equal(live.length, 1);
  assert.match(live[0], /\[windows\] failed to load prompt renderer: ERR_FILE_NOT_FOUND \(-6\)/);

  // A destroyed window's registry entry is gone either way.
  const w = windows.createMain();
  assert.equal(windows.getKind(w.webContents), 'main');
  w.destroy();
  w.resolveLoad();
  assert.equal(windows.getMain(), null);
});

test('prompt: always shown without taking the keyboard', () => {
  const calls = [];
  const proto = FakeBW.prototype;
  const saved = { show: proto.show, focus: proto.focus, moveTop: proto.moveTop, center: proto.center, showInactive: proto.showInactive, flashFrame: proto.flashFrame };
  Object.assign(proto, {
    show() { calls.push('show'); },
    focus() { calls.push('focus'); },
    moveTop() { calls.push('moveTop'); },
    center() {},
    showInactive() { calls.push('showInactive'); },
    flashFrame(on) { calls.push(`flash:${on}`); },
  });
  try {
    for (const focused of [null, 'viewer']) {
      calls.length = 0;
      const viewer = windows.createViewer({ sessionId: 'v1' });
      FakeBW.getFocusedWindow = () => (focused ? viewer : null);
      const b = windows.createPrompt({ requestId: 'r4' });
      b.emit('ready-to-show');
      assert.deepEqual(calls, ['showInactive', 'moveTop'], 'never show()+focus() from code');
      b.destroy();
      viewer.destroy();
    }
  } finally {
    Object.assign(proto, saved);
    delete FakeBW.getFocusedWindow;
  }
});

test('session-UI guard: HWND match on Windows, DIP bounds + margin otherwise; hidden / minimized / destroyed ignored; focus check', () => {
  const hwnd = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const dress = (w, { handle, bounds, visible = true, minimized = false, enabled = true }) => Object.assign(w, {
    getNativeWindowHandle: () => hwnd(handle), getBounds: () => ({ ...bounds }),
    isVisible: () => visible, isMinimized: () => minimized, isEnabled: () => enabled,
  });
  const panel = dress(windows.createPanel({ sessionId: 'g1' }), { handle: 0x111, bounds: { x: 1500, y: 870, width: 400, height: 150 } });
  const main = dress(windows.createMain(), { handle: 0x222, bounds: { x: 0, y: 0, width: 800, height: 600 } });
  try {
    // Windows: the window really under the point decides (a flyout above the panel area is not the panel)
    assert.equal(windows.sessionUiAt({ window: 0x111n, dip: { x: 0, y: 0 } }), true);
    assert.equal(windows.sessionUiAt({ window: 0x999n, dip: { x: 1600, y: 900 } }), false, 'something drawn above the panel');
    assert.equal(windows.sessionUiAt({ window: 0x222n, dip: null }), false, 'the main window is not session UI');
    assert.equal(windows.sessionUiAt({ window: null, dip: { x: 1600, y: 900 } }), false, 'no window there');
    // no HWND (macOS / unknown): bounds + 4 DIP
    assert.equal(windows.sessionUiAt({ dip: { x: 1600, y: 900 } }), true);
    assert.equal(windows.sessionUiAt({ dip: { x: 1497, y: 868 } }), true, 'inside the margin');
    assert.equal(windows.sessionUiAt({ dip: { x: 1495, y: 900 } }), false);
    assert.equal(windows.sessionUiAt({ dip: null }), false);
    assert.equal(windows.sessionUiAt(null), false);
    // a native modal of the panel (file chooser, end-session box) disables it: keys guarded with no
    // focused BrowserWindow; without an HWND every press is guarded (a macOS sheet can exceed the bounds)
    dress(panel, { handle: 0x111, bounds: { x: 1500, y: 870, width: 400, height: 150 }, enabled: false });
    FakeBW.getFocusedWindow = () => null;
    assert.equal(windows.sessionUiFocused(), true, 'modal of the panel has the keyboard');
    assert.equal(windows.sessionUiAt({ dip: { x: 10, y: 10 } }), true, 'macOS: every press while a sheet is up');
    assert.equal(windows.sessionUiAt({ window: 0x999n, dip: { x: 10, y: 10 } }), false, 'Windows: the HWND still decides');
    delete FakeBW.getFocusedWindow;
    dress(panel, { handle: 0x111, bounds: { x: 1500, y: 870, width: 400, height: 150 }, minimized: true });
    assert.equal(windows.sessionUiAt({ window: 0x111n, dip: { x: 1600, y: 900 } }), false, 'minimized');
    dress(panel, { handle: 0x111, bounds: { x: 1500, y: 870, width: 400, height: 150 }, visible: false });
    assert.equal(windows.sessionUiAt({ dip: { x: 1600, y: 900 } }), false, 'hidden (warm) panel');

    FakeBW.getFocusedWindow = () => panel;
    assert.equal(windows.sessionUiFocused(), true);
    FakeBW.getFocusedWindow = () => main;
    assert.equal(windows.sessionUiFocused(), false);
    FakeBW.getFocusedWindow = () => null;
    assert.equal(windows.sessionUiFocused(), false);
    FakeBW.getFocusedWindow = () => { throw new Error('boom'); };
    assert.equal(windows.sessionUiFocused(), false);
  } finally {
    delete FakeBW.getFocusedWindow;
    panel.destroy();
    main.destroy();
  }
  assert.equal(windows.sessionUiAt({ dip: { x: 1600, y: 900 } }), false, 'destroyed');
});
