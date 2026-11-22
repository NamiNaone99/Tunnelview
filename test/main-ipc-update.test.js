'use strict';
/*
 * node --test test/main-ipc-update.test.js — the update:* channels of ipc.js (DECISIONS U5, U6,
 * U8): main-window-only senders, plain cleaned payloads, the incoming-session lock on
 * autoUpdateCheck, and lastUpdateCheckAt never written by a renderer. Fake `electron`, fake
 * windows and a fake updater; real settings.js in a temp folder. No network.
 * Its own file because ipc.js keeps module state (one register() per process); tests run in order.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

/* ------------------------------------------------------------------ fake electron */

const handlers = new Map();
const opened = [];
const fakeElectron = {
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on() {} },
  shell: { openExternal: async (u) => { opened.push(u); }, openPath: async () => '' },
  app: { relaunch() {}, getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  clipboard: { writeText: async () => {} },
};
require.cache[require.resolve('electron')] = {
  id: require.resolve('electron'), filename: require.resolve('electron'), loaded: true, exports: fakeElectron,
};

const ipc = require('../src/main/ipc');
const { Settings } = require('../src/main/settings');

/* ------------------------------------------------------------------ fakes */

let nextWcId = 700;
const entries = new Map();
function addEntry(kind) {
  const wc = new EventEmitter();
  wc.id = nextWcId++;
  const win = { webContents: wc, isDestroyed: () => false };
  entries.set(wc.id, { kind, win, wcId: wc.id });
  return win;
}
const windows = {
  isOwnMainFrame: (event) => entries.has(event.sender.id),
  getEntry: (event) => entries.get(event.sender.id) || null,
  getKind: (event) => { const e = entries.get(event.sender.id); return e ? e.kind : null; },
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnelview-ipc-update-'));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const settings = new Settings({ dir, downloadsDir: path.join(dir, 'Downloads') });
settings.load();

/** Records every call; answers with whatever the test put in `next`. */
class FakeUpdater extends EventEmitter {
  constructor() {
    super();
    this.calls = [];
    this.state = { status: 'idle' };
    this.next = { ok: true };
  }
  getState() { this.calls.push('getState'); return this.state; }
  async check() { this.calls.push('check'); this.state = { ...this.state, status: 'up-to-date' }; return this.state; }
  async download() { this.calls.push('download'); return this.next; }
  async install() { this.calls.push('install'); return this.next; }
  reveal() { this.calls.push('reveal'); return this.next; }
  cancelDownload() { this.calls.push('cancel'); return this.next; }
}
const updater = new FakeUpdater();

let sessionActive = false;
const ctx = {
  settings,
  tailscale: { last: null, isTailscaleIp: () => true, normalizeIp: (ip) => ip, async status() { return null; } },
  auth: {},
  ViewerSession: class {},
  windows,
  capture: {},
  clipboard: { subscribe() {}, unsubscribe() {} },
  files: { forgetOwner: async () => {} },
  permissions: { KINDS: ['screen', 'accessibility'] },
  input: { available: true, reason: null, handle() {}, releaseAll() {} },
  hostCtl: {
    isActivePanel: () => false,
    getPermissions: () => (sessionActive ? { control: true, clipboard: true, files: true, audio: true } : null),
    sessionActive: () => sessionActive,
  },
  getHost: () => null,
  identity: null,
  updater,
  getState: () => ({}),
  stateChanged() {},
  notify() {},
  quit() {},
  appVersion: '0.3.0',
  osName: 'windows',
};
ipc.register(ctx);

const mainWin = addEntry('main');
const invoke = (ch, win, ...args) => handlers.get(ch)({ sender: { id: win.webContents.id } }, ...args);
const CHANNELS = ['update:get-state', 'update:check', 'update:download', 'update:install', 'update:cancel', 'update:set-auto', 'update:reveal', 'update:open-releases'];

/* ------------------------------------------------------------------ tests */

test('every update channel is registered and answers only the main window', async () => {
  for (const ch of CHANNELS) assert.equal(typeof handlers.get(ch), 'function', ch);
  const others = [addEntry('viewer'), addEntry('panel'), addEntry('prompt')];
  const unregistered = { webContents: { id: 9999 } };
  for (const ch of CHANNELS) {
    for (const win of [...others, unregistered]) {
      await assert.rejects(invoke(ch, win, true), /Forbidden/, `${ch} from a non-main window`);
    }
  }
  assert.deepEqual(updater.calls, [], 'a rejected sender never reaches the updater');
  assert.deepEqual(opened, []);
  assert.equal(settings.get().autoUpdateCheck, true);
});

test('update:get-state: a rebuilt plain object; notes stay multi-line plain text', async () => {
  updater.state = {
    status: 'available',
    phase: 'quitting',                       // only while installing
    currentVersion: '0.3.0',
    platform: 'windows',
    supported: true,
    autoCheck: true,
    lastCheckAt: 1762516800000,
    latest: { version: '0.4.0', date: '2026-11-07T12:00:00.000Z', notes: 'Line one\n\tindented\u0007\u202e\nend', size: 123, url: 'file:///x', extra: 1 },
    downloaded: false,
    progress: { received: 1, total: 2, percent: 50 }, // only while downloading
    error: { code: 'NETWORK', message: 'Could not reach GitHub.\u0000', stack: 'secret' },
    blocked: 'OUTGOING_SESSION',
    justUpdated: null,
    installBlocked: { code: 'TRANSLOCATED', message: 'Move it.‮', path: '/private/var/folders/x' },
    file: 'C:\\Users\\me\\AppData\\Roaming\\Tunnelview\\updates\\0.4.0\\x.exe',
  };
  const s = await invoke('update:get-state', mainWin);
  assert.deepEqual(s, {
    status: 'available',
    phase: null,
    currentVersion: '0.3.0',
    platform: 'windows',
    supported: true,
    autoCheck: true,
    lastCheckAt: 1762516800000,
    latest: { version: '0.4.0', date: '2026-11-07T12:00:00.000Z', notes: 'Line one\n\tindented\nend', size: 123 },
    downloaded: false,
    progress: null,
    error: { code: 'NETWORK', message: 'Could not reach GitHub.' },
    blocked: 'OUTGOING_SESSION',
    justUpdated: null,
    installBlocked: { code: 'TRANSLOCATED', message: 'Move it.' },
  });
  // Garbage in → safe defaults out.
  updater.state = { status: 'pwned', latest: { version: '../../x' }, error: { code: 'lower case' }, blocked: 'NOPE', platform: 'linux', justUpdated: { to: 'x' } };
  const g = await invoke('update:get-state', mainWin);
  assert.equal(g.status, 'idle');
  assert.equal(g.latest, null);
  assert.equal(g.error, null);
  assert.equal(g.blocked, null);
  assert.equal(g.platform, 'other');
  assert.equal(g.justUpdated, null);
  assert.equal(g.installBlocked, null);
  updater.state = { status: 'ready', installBlocked: { code: 'lower', message: 'x' } };
  assert.equal((await invoke('update:get-state', mainWin)).installBlocked, null);
  // Downloading / installing keep their extra fields.
  updater.state = { status: 'downloading', progress: { received: 10, total: 20, percent: 50.7 } };
  assert.deepEqual((await invoke('update:get-state', mainWin)).progress, { received: 10, total: 20, percent: 50 });
  updater.state = { status: 'installing', phase: 'waiting-for-approval', justUpdated: { from: '0.2.0', to: '0.3.0' } };
  const i = await invoke('update:get-state', mainWin);
  assert.equal(i.phase, 'waiting-for-approval');
  assert.deepEqual(i.justUpdated, { from: '0.2.0', to: '0.3.0' });
  assert.deepEqual(ipc.sanitizeUpdateState(undefined).status, 'idle');
});

test('update:check runs a check (also during a session) and returns the new state', async () => {
  updater.calls.length = 0;
  updater.state = { status: 'idle' };
  sessionActive = true;
  try {
    const s = await invoke('update:check', mainWin, { anything: 'ignored' });
    assert.equal(s.status, 'up-to-date');
    assert.deepEqual(updater.calls, ['check', 'getState']);
  } finally {
    sessionActive = false;
  }
});

test('update:download / install / cancel / reveal: results are {ok} or {ok, code, message} only', async () => {
  updater.calls.length = 0;
  for (const ch of ['update:download', 'update:install', 'update:cancel', 'update:reveal']) {
    updater.next = { ok: true, path: 'C:\\secret' };
    assert.deepEqual(await invoke(ch, mainWin), { ok: true }, ch);
    updater.next = { ok: false, code: 'UAC_DECLINED', message: 'Update cancelled: administrator permission was not given.', stack: 'x' };
    assert.deepEqual(await invoke(ch, mainWin), { ok: false, code: 'UAC_DECLINED', message: 'Update cancelled: administrator permission was not given.' }, ch);
    updater.next = { ok: false, code: '<script>', message: 42 };
    assert.deepEqual(await invoke(ch, mainWin), { ok: false, code: 'UNKNOWN', message: 'The update failed.' }, ch);
  }
  assert.deepEqual(updater.calls.filter((c) => c !== 'getState'), ['download', 'download', 'download', 'install', 'install', 'install', 'cancel', 'cancel', 'cancel', 'reveal', 'reveal', 'reveal']);
});

test('update:set-auto: booleans only; locked while an incoming session is active', async () => {
  assert.deepEqual(await invoke('update:set-auto', mainWin, 'false'), { ok: false, code: 'BAD_REQUEST', message: 'Invalid value.' });
  assert.equal(settings.get().autoUpdateCheck, true);
  assert.deepEqual(await invoke('update:set-auto', mainWin, false), { ok: true });
  assert.equal(settings.get().autoUpdateCheck, false);
  sessionActive = true;
  try {
    assert.deepEqual(await invoke('update:set-auto', mainWin, true), { ok: false, code: 'SETTINGS_LOCKED', message: 'Disconnect the remote session to change security settings.' });
    assert.equal(settings.get().autoUpdateCheck, false);
    assert.deepEqual(await invoke('update:set-auto', mainWin, false), { ok: true }, 'no change is not refused');
    // settings:update has the same lock (LOCKED_SETTING_KEYS).
    await assert.rejects(invoke('settings:update', mainWin, { autoUpdateCheck: true }), /Disconnect the remote session to change security settings\./);
    assert.equal(settings.get().autoUpdateCheck, false);
    const pub = await invoke('settings:update', mainWin, { autoUpdateCheck: false, theme: 'dark' });
    assert.equal(pub.theme, 'dark', 'unrelated keys still apply');
  } finally {
    sessionActive = false;
  }
  assert.deepEqual(await invoke('update:set-auto', mainWin, true), { ok: true });
  assert.equal(settings.get().autoUpdateCheck, true);
  settings.update({ theme: 'system' });
});

test('settings:update never writes lastUpdateCheckAt (main-process bookkeeping)', async () => {
  settings.update({ lastUpdateCheckAt: 1000 });
  const pub = await invoke('settings:update', mainWin, { lastUpdateCheckAt: 0, autoUpdateCheck: true });
  assert.equal(settings.get().lastUpdateCheckAt, 1000);
  assert.equal(pub.lastUpdateCheckAt, 1000);
});

test('update:open-releases opens the GitHub releases page and nothing else', async () => {
  assert.deepEqual(await invoke('update:open-releases', mainWin, 'https://evil.example'), { ok: true });
  assert.deepEqual(opened, ['https://github.com/NamiNaone99/Tunnelview/releases/latest']);
});

test('without an updater every action answers NOT_SUPPORTED', async () => {
  ctx.updater = null;
  try {
    assert.equal((await invoke('update:get-state', mainWin)).status, 'idle');
    assert.equal((await invoke('update:check', mainWin)).status, 'idle');
    for (const ch of ['update:download', 'update:install', 'update:cancel', 'update:reveal']) {
      const r = await invoke(ch, mainWin);
      assert.equal(r.ok, false);
      assert.equal(r.code, 'NOT_SUPPORTED');
    }
  } finally {
    ctx.updater = updater;
  }
});
