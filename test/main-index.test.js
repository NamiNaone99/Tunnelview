'use strict';
/*
 * node --test test/main-index.test.js — src/main/index.js wiring under plain Node: a fake
 * `electron`, and stubs for the modules that would touch the network or the OS (host-server,
 * viewer-client, tailscale, input, auth, tray, icons, child_process.execFile). No Electron runtime,
 * no PowerShell, no real input. index.js runs main() when it is required, so every load() gets a
 * fresh copy of src/ (require cache cleared) and a faked process.platform; tests run in order.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const SRC = path.join(__dirname, '..', 'src');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const realNow = Date.now;
/** Move Date.now() ahead by ms (0 = back to real time); timers are unaffected. */
const clockAhead = (ms) => { Date.now = ms ? () => realNow() + ms : realNow; };
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

// Every load shares this execFile stub (index.js / ipc.js destructure it when they load).
let currentHarness = null;
childProcess.execFile = (file, args, opts, cb) => {
  const h = currentHarness;
  if (h) h.execCalls.push({ file, args, env: opts && opts.env });
  const out = h && typeof h.fwOutput === 'function' ? h.fwOutput() : '';
  setImmediate(() => cb(out === null ? new Error('failed') : null, out || '', ''));
  return new EventEmitter();
};

function setPlatform(p) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true, enumerable: true, writable: false });
}

// Every load() makes a userData folder, and index.js writes identity.json (a private key) into
// it: all of them go when this file is done.
const userDataDirs = [];
test.after(() => {
  for (const dir of userDataDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* still in use: left to the OS */ }
  }
});

function stub(rel, exports) {
  const file = require.resolve(path.join(SRC, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}

/**
 * Load a fresh index.js for `platform`.
 * @param {{platform:string, settings?:object, loginItem?:object, screen?:string, before?:(h)=>void}} opts
 */
async function load({ platform, settings: initialSettings = null, loginItem = null, screen: screenStatus = 'granted', before = null }) {
  setPlatform(platform);
  for (const k of Object.keys(require.cache)) if (k.startsWith(SRC)) delete require.cache[k];

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnelview-index-'));
  userDataDirs.push(userData);
  if (initialSettings) {
    fs.mkdirSync(path.join(userData, 'userData'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'userData', 'settings.json'), JSON.stringify({ version: 1, ...initialSettings }));
  }

  const h = {
    platform,
    userData,
    execCalls: [],
    switches: [],
    fwOutput: () => JSON.stringify({ category: 'Private', profileEnabled: 'True', allowInbound: 'True', rules: [] }),
    windows: [],
    handlers: new Map(),
    notifications: [],
    loginCalls: [],
    loginItem: { openAtLogin: false, executableWillLaunchAtLogin: false, wasOpenedAtLogin: false, status: 'not-registered', ...(loginItem || {}) },
    psb: { next: 1, started: new Set(), log: [] },
    getSources: 0,
    screenStatus,
  };
  currentHarness = h;

  /* ---------------- fake electron ---------------- */
  let wcIds = 1000;
  class FakeWC extends EventEmitter {
    constructor() { super(); this.id = wcIds++; this.sent = []; this.destroyed = false; }
    send(ch, p) { this.sent.push([ch, p]); }
    isLoading() { return false; }
    isDestroyed() { return this.destroyed; }
    isCrashed() { return false; }
    getURL() { return ''; }
    setWebRTCUDPPortRange() {}
    setWindowOpenHandler() {}
    openDevTools() {}
    reload() {}
  }
  class FakeBW extends EventEmitter {
    constructor(opts) {
      super();
      this.opts = opts;
      this.webContents = new FakeWC();
      this.destroyed = false;
      this.visible = false;
      this.fullScreen = false;
      this.fullScreenCalls = [];
      h.windows.push(this);
    }
    loadFile(file) { this.file = file; setTimeout(() => { if (!this.destroyed) this.emit('ready-to-show'); }, 5); return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { if (this.destroyed) return; this.destroyed = true; this.webContents.destroyed = true; this.emit('closed'); }
    close() {
      if (this.destroyed) return;
      const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      this.emit('close', e);
      if (!e.defaultPrevented) this.destroy();
    }
    show() { this.visible = true; }
    showInactive() { this.visible = true; }
    hide() { this.visible = false; }
    focus() {}
    isFocused() { return false; }
    flashFrame() {}
    center() {}
    moveTop() {}
    isMinimized() { return false; }
    restore() {}
    minimize() {}
    setTitle() {}
    setAlwaysOnTop() {}
    setVisibleOnAllWorkspaces() {}
    isFullScreen() { return this.fullScreen; }
    setFullScreen(v) { this.fullScreenCalls.push(v); }
    getBounds() { return { x: 0, y: 0, width: 360, height: 140 }; }
    setBounds() {}
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    commandLine: { hasSwitch: () => false, appendSwitch(name, value) { h.switches.push(value === undefined ? name : `${name}=${value}`); } },
    setAppUserModelId() {},
    enableSandbox() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    isReady: () => true,
    getVersion: () => '0.0.0-test',
    getPath: (name) => { const d = path.join(userData, name); fs.mkdirSync(d, { recursive: true }); return d; },
    quit() { h.quitCalls = (h.quitCalls || 0) + 1; },
    exit() {},
    relaunch() {},
    dock: null,
    getLoginItemSettings: () => ({ ...h.loginItem }),
    setLoginItemSettings: (o) => {
      h.loginCalls.push(o);
      if (platform === 'darwin') h.loginItem.status = o.openAtLogin ? (h.registerResult || 'enabled') : 'not-registered';
      h.loginItem.openAtLogin = !!o.openAtLogin;
    },
  });
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => [{ id: 1, label: 'Main', bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 }],
    getPrimaryDisplay: () => screen.getAllDisplays()[0],
    getDisplayMatching: () => screen.getAllDisplays()[0],
  });
  class FakeNotification extends EventEmitter {
    constructor(o) { super(); this.o = o; h.notifications.push(this); }
    show() {}
    close() {}
  }
  FakeNotification.isSupported = () => true;
  const fakeElectron = {
    app,
    BrowserWindow: FakeBW,
    Menu: { setApplicationMenu() {}, buildFromTemplate: () => ({}) },
    Notification: FakeNotification,
    session: {
      defaultSession: {
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, on() {},
        setDisplayMediaRequestHandler: (fn) => { h.displayMediaHandler = fn; },
      },
    },
    nativeTheme: Object.assign(new EventEmitter(), { themeSource: 'system', shouldUseDarkColors: true }),
    webContents: { fromFrame: () => null },
    powerMonitor: new EventEmitter(),
    powerSaveBlocker: {
      start: (type) => { const id = h.psb.next++; h.psb.started.add(id); h.psb.log.push(['start', type, id]); return id; },
      isStarted: (id) => h.psb.started.has(id),
      stop: (id) => { h.psb.log.push(['stop', id]); return h.psb.started.delete(id); },
    },
    dialog: { showMessageBox: async () => ({ response: 1 }), showErrorBox() {}, showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    shell: { openExternal: async (u) => { (h.opened = h.opened || []).push(u); }, openPath: async () => '', showItemInFolder() {} },
    systemPreferences: { setUserDefault() {}, getMediaAccessStatus: () => h.screenStatus, isTrustedAccessibilityClient: () => true },
    ipcMain: { handle: (ch, fn) => h.handlers.set(ch, fn), on() {} },
    screen,
    desktopCapturer: { getSources: async () => { h.getSources++; return [{ id: 'screen:0:0', name: 'Screen 1', display_id: '1' }]; } },
    clipboard: { read: async () => [], writeText: async () => {}, has: async () => false },
    ClipboardItem: class {},
    nativeImage: { createEmpty: () => ({ isEmpty: () => true }) },
  };
  h.app = app;
  h.electron = fakeElectron;
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fakeElectron };

  /* ---------------- stubs ---------------- */
  class FakeHost extends EventEmitter {
    constructor(deps) { super(); this.deps = deps; this.settings = deps.settings; this.permsSent = []; this.ended = []; this.pairingCancels = []; h.host = this; }
    cancelPairing(offerId, reason) { this.pairingCancels.push([offerId, reason]); return true; }
    async start() { return this.status(); }
    async stop() {}
    status() { return { listening: true, addresses: ['100.64.0.1'], port: 47800, error: null }; }
    endSession(reason) { this.ended.push(reason); if (this.sid) this.emit('session-end', { id: this.sid, reason }); }
    setPermissions(p) { this.permsSent.push(p); }
    sendSignal() {}
  }
  stub('main/host-server.js', Object.assign(FakeHost, { HostServer: FakeHost }));
  stub('main/viewer-client.js', class FakeViewerSession extends EventEmitter {
    connect() { return true; }
    close() {}
  });
  stub('main/auth.js', {});
  stub('main/input/index.js', { available: true, reason: null, setDisplay() {}, handle() {}, releaseAll() {}, refreshPermission() {} });
  const img = { isEmpty: () => true };
  stub('main/icons.js', { appIcon: () => img, appIconLarge: () => img, trayIcon: () => img, available: () => false });
  stub('main/tray.js', { create() {}, update() {}, destroy() {}, describe() { return {}; } });
  const ts = Object.assign(new EventEmitter(), {
    cliPath: null,
    last: null,
    async init() {},
    async status() {
      this.last = {
        state: 'running', message: '', magicDnsSuffix: 'tail1.ts.net', peers: [],
        self: { stableId: 'nSELF', hostname: 'me', dnsName: 'me.tail1.ts.net', ips: ['fd7a:115c:a1e0::1', '100.64.0.1'], user: { login: 'me@example.com', displayName: 'Me' } },
      };
      return this.last;
    },
    startWatching() {},
    stopWatching() {},
    isTailscaleIp: (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip) || /^fd7a:115c:a1e0:/i.test(ip),
    normalizeIp: (ip) => ip,
    async resolveTarget() { throw Object.assign(new Error('nope'), { code: 'NOT_FOUND' }); },
  });
  stub('main/tailscale.js', ts);
  h.ts = ts;
  // The real updater would schedule a GitHub check (isPackaged is true here): a recording fake.
  // h.updaterJustUpdated (set in `before`) is what its init() reports.
  stub('main/updater.js', {
    createUpdater(deps) {
      const u = Object.assign(new EventEmitter(), {
        deps,
        calls: [],
        justUpdated: h.updaterJustUpdated || null,
        init() { u.calls.push('init'); return { justUpdated: u.justUpdated }; },
        start() { u.calls.push('start'); },
        dispose() { u.calls.push('dispose'); },
        getState() { return { status: 'idle', currentVersion: deps.appVersion }; },
        sessionsChanged() { u.calls.push('sessionsChanged'); },
        settingsChanged(keys) { u.calls.push(['settingsChanged', keys]); },
        isInstalling() { return h.updaterInstalling === true; },
        reschedule() { u.calls.push('reschedule'); },
        async check() { return u.getState(); },
        async download() { return { ok: true }; },
        async install() { return { ok: true }; },
        reveal() { return { ok: true }; },
      });
      h.updater = u;
      return u;
    },
  });

  // Real modules this harness observes.
  h.capture = require(path.join(SRC, 'main/capture.js'));
  const origSetIdleWarm = h.capture.setIdleWarm;
  h.capture.setIdleWarm = (fn, o) => { h.canWarm = fn; return origSetIdleWarm(fn, o); };
  h.files = require(path.join(SRC, 'main/files.js'));
  h.prepareDirCalls = 0;
  h.files.prepareDir = async () => { h.prepareDirCalls++; return { ok: true, path: '' }; };
  h.settings = require(path.join(SRC, 'main/settings.js'));
  h.windowsMod = require(path.join(SRC, 'main/windows.js'));
  if (before) before(h);

  h.exports = require(path.join(SRC, 'main/index.js'));
  await settle();
  await sleep(20);
  await settle();
  return h;
}

/* ------------------------------------------------------------------ harness helpers */

function ipcEvent(h, win) {
  const entry = h.windowsMod.getEntry({ sender: win.webContents });
  const kind = entry ? entry.kind : 'main';
  const frame = { processId: 1, routingId: win.webContents.id, url: pathToFileURL(h.windowsMod.htmlPath(kind)).href };
  win.webContents.mainFrame = frame;
  return { sender: win.webContents, senderFrame: frame };
}
const invoke = (h, ch, win, ...args) => h.handlers.get(ch)(ipcEvent(h, win), ...args);
const live = (h, title) => h.windows.filter((w) => !w.destroyed && w.opts && String(w.opts.title).startsWith(title));
const mainWindow = (h) => live(h, 'Tunnelview').find((w) => w.opts.title === 'Tunnelview');

const PEER = { ip: '100.100.1.2', hostname: 'studio', os: 'macos', user: { login: 'alice@example.com', displayName: 'Alice' }, stableId: 'nPEER', sameUser: false, isSelf: false, tags: [] };

/** Emit an incoming request; respond() mimics host-server (session-start on accept). */
function request(h, { peer = PEER, requestId = `r${Date.now()}${Math.random()}` } = {}) {
  const req = {
    requestId,
    peer: JSON.parse(JSON.stringify(peer)),
    viewer: { hostname: 'laptop', os: 'windows', version: '1.0' },
    answers: [],
    respond(a) {
      req.answers.push(a);
      if (a.accept) startSession(h, { via: 'prompt', permissions: a.permissions, peer });
      return true;
    },
  };
  h.host.emit('request', req);
  return req;
}

function startSession(h, { via = 'password', permissions = { control: true, clipboard: true, files: true, audio: true }, peer = PEER } = {}) {
  h.host.sid = `s${Math.random()}`;
  h.host.emit('session-start', { id: h.host.sid, peer, viewer: { hostname: 'laptop', os: 'windows', version: '1.0' }, permissions, via, startedAt: Date.now() });
  return h.host.sid;
}

let W = null; // the win32 load, shared by the tests below (they run in order)
let M = null; // the first darwin load

/* ================================================================== win32 */

test('win32 startup: idle warm-up wired, firewall query told our Tailscale IP', async () => {
  const h = await load({ platform: 'win32' });
  assert.equal(typeof h.canWarm, 'function', 'capture.setIdleWarm received the predicate');
  assert.equal(h.canWarm(), true, 'idle, hosting on → warming allowed');
  const fw = h.execCalls.find((c) => /powershell\.exe$/i.test(c.file));
  assert.ok(fw, 'firewall query ran');
  assert.equal(fw.env.TUNNELVIEW_TS_IP, '100.64.0.1', 'IPv4 preferred');
  assert.equal(fw.env.TUNNELVIEW_FW_PROGRAM, process.execPath);
  h.settings.update({ hostEnabled: false });
  assert.equal(h.canWarm(), false, 'hosting off → no warm-up');
  h.settings.update({ hostEnabled: true });
  W = h;
});

test('a prompt with a valid display cache does not enumerate; the warm-up waits while it shows', async () => {
  const h = W;
  await h.capture.listDisplays({ force: true });
  h.getSources = 0;
  clockAhead(3 * 3600e3); // warmed hours ago: still valid (no display event since)
  const req = request(h);
  assert.equal(h.canWarm(), false, 'no idle warm-up while a prompt is visible');
  await sleep(200); // ready-to-show + 100 ms
  assert.equal(h.getSources, 0, 'cached list reused at prompt time');
  // Decline (Reject button): the warm panel's pending panel:ready resolves null, no handler error.
  const warm = live(h, 'Tunnelview session')[0];
  assert.ok(warm && !warm.visible, 'hidden warm panel exists');
  const ready = invoke(h, 'panel:ready', warm);
  const prompt = live(h, 'Incoming')[0];
  assert.deepEqual(await invoke(h, 'prompt:respond', prompt, { accept: false }), { ok: true });
  assert.equal(await ready, null);
  assert.equal(warm.destroyed, true);
  assert.equal(req.answers[0].accept, false);
  assert.equal(h.canWarm(), true, 'idle again');
  clockAhead(0);
});

test('a prompt with no valid cache still warms the display list once', async () => {
  const h = W;
  h.capture.invalidate();
  h.getSources = 0;
  request(h);
  await sleep(200);
  assert.equal(h.getSources, 1);
  const prompt = live(h, 'Incoming')[0];
  await invoke(h, 'prompt:respond', prompt, { accept: false });
  await settle();
});

test('accepted prompt: the warm panel is adopted, the display is kept awake until the session ends', async () => {
  const h = W;
  h.getSources = 0;
  clockAhead(6 * 3600e3);
  const req = request(h);
  await sleep(150);
  const warm = live(h, 'Tunnelview session')[0];
  const ready = invoke(h, 'panel:ready', warm);
  const prompt = live(h, 'Incoming')[0];
  // the prompt must be gone before the panel is revealed, or Windows activates the panel next
  let promptGoneWhenRevealed = null;
  const reveal = warm.showInactive;
  warm.showInactive = function () { promptGoneWhenRevealed = prompt.isDestroyed(); return reveal.call(this); };
  await invoke(h, 'prompt:respond', prompt, { accept: true, permissions: { control: true, clipboard: true, files: true, audio: true } });
  assert.equal(promptGoneWhenRevealed, true, 'accepted prompt destroyed before the session panel is shown');
  const init = await ready;
  assert.ok(init && init.sessionId, 'PanelInit after adoption');
  assert.equal(h.getSources, 0, 'session start reused the cached list');
  assert.equal(req.answers[0].accept, true);
  assert.equal(h.canWarm(), false, 'no idle warm-up during a session');
  assert.deepEqual(h.psb.log.filter((l) => l[0] === 'start').map((l) => l[1]), ['prevent-display-sleep']);
  assert.equal(h.psb.started.size, 1, 'held during the session');
  h.host.emit('session-end', { id: h.host.sid, reason: 'viewer-ended' });
  assert.equal(h.psb.started.size, 0, 'released at the end');
  assert.equal(h.canWarm(), true);
  clockAhead(0);
});

test('audio: a host without system audio gives host-server audio:false defaults and clamps a password session', async () => {
  const h = W;
  const real = h.capture.audioSupported;
  h.capture.audioSupported = () => false;
  try {
    assert.equal(h.settings.get().defaultPermissions.audio, true, 'stored setting untouched');
    assert.equal(h.host.settings.get().defaultPermissions.audio, false, "host-server's view says no audio");
    h.host.permsSent.length = 0;
    startSession(h, { via: 'password', permissions: { control: true, clipboard: true, files: true, audio: true } });
    await settle();
    assert.deepEqual(h.host.permsSent, [{ control: true, clipboard: true, files: true, audio: false }], 'viewer told audio is off');
    const panel = live(h, 'Tunnelview session').slice(-1)[0];
    const init = await invoke(h, 'panel:ready', panel);
    assert.equal(init.permissions.audio, false);
    h.host.emit('session-end', { id: h.host.sid, reason: 'viewer-ended' });
    // The view delegates writes and listeners to the real store.
    let changed = 0;
    const fn = () => { changed++; };
    h.host.settings.on('change', fn);
    h.host.settings.update({ theme: 'dark' });
    h.host.settings.removeListener('change', fn);
    h.host.settings.update({ theme: 'system' });
    assert.equal(changed, 1);
    assert.equal(h.settings.get().theme, 'system');
  } finally {
    h.capture.audioSupported = real;
  }
  assert.equal(h.host.settings.get().defaultPermissions.audio, true, 'win32 loopback: audio stays');
});

test('tagged peers: tags reach the prompt; "Always allow" is never saved for them', async () => {
  const h = W;
  const tagged = { ...PEER, stableId: 'nTAG', tags: ['tag:server', 'x'.repeat(100), 7, 'a', 'b', 'c', 'd', 'e', 'f', 'g'], user: { login: 'tagged-devices', displayName: 'Tagged Devices' } };
  let req = request(h, { peer: tagged });
  await sleep(20);
  let prompt = live(h, 'Incoming')[0];
  const init = await invoke(h, 'prompt:ready', prompt);
  assert.equal(init.peer.tags.length, 8, 'at most 8, non-strings dropped');
  assert.equal(init.peer.tags[0], 'tag:server');
  assert.equal(init.peer.tags[1].length, 64, 'each clipped to 64 chars');
  await invoke(h, 'prompt:respond', prompt, { accept: true, trust: true, permissions: {} });
  assert.equal(req.answers[0].trust, false);
  assert.equal(h.settings.isTrusted('nTAG'), false);
  h.host.emit('session-end', { id: h.host.sid, reason: 'viewer-ended' });
  await sleep(20);

  // A tagged node whose login is not 'tagged-devices' (just tags) is not trusted either.
  req = request(h, { peer: { ...PEER, stableId: 'nTAG2', tags: ['tag:ci'] } });
  await sleep(20);
  prompt = live(h, 'Incoming')[0];
  await invoke(h, 'prompt:respond', prompt, { accept: true, trust: true, permissions: {} });
  assert.equal(req.answers[0].trust, false);
  h.host.emit('session-end', { id: h.host.sid, reason: 'viewer-ended' });
  await sleep(20);

  // Untagged: trusted as before.
  req = request(h);
  await sleep(20);
  prompt = live(h, 'Incoming')[0];
  assert.deepEqual((await invoke(h, 'prompt:ready', prompt)).peer.tags, []);
  await invoke(h, 'prompt:respond', prompt, { accept: true, trust: true, permissions: {} });
  assert.equal(req.answers[0].trust, true);
  assert.equal(h.settings.isTrusted('nPEER'), true);
  h.host.emit('session-end', { id: h.host.sid, reason: 'viewer-ended' });
  h.settings.removeTrusted('nPEER');
});

test('firewall: only Block rules that reach the Tailscale profile + port warn; "block all" warns too', async () => {
  const h = W;
  const state = async () => { await sleep(80); return invoke(h, 'app:get-state', mainWindow(h)); };
  const out = (o) => () => JSON.stringify({ category: 'Private', profileEnabled: 'True', allowInbound: 'True', rules: [], ...o });
  // "Private networks" ticked in the Windows Security Alert → a Public-only Block rule.
  h.fwOutput = out({ rules: [{ name: 'Tunnelview (Public)', profile: 4, remote: ['Any'], protocol: 'TCP', localPort: ['Any'] }] });
  h.settings.update({ port: 47811 });
  assert.equal((await state()).host.warning, null);
  h.fwOutput = out({ rules: [{ name: 'TCP Query User', profile: 0, remote: ['Any'], protocol: 'TCP', localPort: ['Any'] }] });
  h.settings.update({ port: 47812 });
  assert.match((await state()).host.warning, /Block rule/);
  // A failed query keeps the previous state.
  h.fwOutput = () => null;
  h.settings.update({ port: 47813 });
  assert.match((await state()).host.warning, /Block rule/);
  h.fwOutput = out({ allowInbound: 'False' });
  h.settings.update({ port: 47814 });
  assert.match((await state()).host.warning, /blocks all incoming connections/);
  h.fwOutput = out({});
  h.settings.update({ port: 47800 });
  assert.equal((await state()).host.warning, null);
});

test('firewall: re-checked when our Tailscale IP changes, not on every Tailscale change event', async () => {
  const h = W;
  await sleep(50);
  const before = h.execCalls.length;
  h.ts.emit('change', h.ts.last); // same IPs
  await sleep(30);
  assert.equal(h.execCalls.length, before);
  h.ts.last = { ...h.ts.last, self: { ...h.ts.last.self, ips: ['100.64.0.9'] } };
  h.ts.emit('change', h.ts.last);
  await sleep(30);
  assert.equal(h.execCalls.length, before + 1);
  assert.equal(h.execCalls[h.execCalls.length - 1].env.TUNNELVIEW_TS_IP, '100.64.0.9');
});

test('firewallVerdict: profile, remote address and port scoping', () => {
  const { firewallVerdict } = W.exports;
  const rule = (o) => ({ name: 'r', profile: 0, remote: ['Any'], protocol: 'Any', localPort: ['Any'], ...o });
  const v = (raw, port = 47800) => firewallVerdict({ category: 'Private', profileEnabled: 'True', allowInbound: 'True', ...raw }, port);
  assert.deepEqual(v({ rules: [rule()] }), { blocked: ['r'], blockAll: false });
  // profile
  assert.deepEqual(v({ rules: [rule({ profile: 4 })] }).blocked, [], 'Public only vs Private adapter');
  assert.deepEqual(v({ rules: [rule({ profile: 6 })] }).blocked, ['r'], 'Private, Public');
  assert.deepEqual(v({ category: 'Domain', rules: [rule({ profile: 1 })] }).blocked, ['r']);
  assert.deepEqual(v({ category: null, rules: [rule({ profile: 4 })] }).blocked, ['r'], 'unknown category: every profile');
  assert.deepEqual(v({ profileEnabled: 'False', allowInbound: 'False', rules: [rule()] }), { blocked: [], blockAll: false }, 'firewall off for that profile');
  // remote address
  for (const remote of [['100.64.0.0/10'], ['100.64.0.0/255.192.0.0'], ['100.100.1.2'], ['100.0.0.0-100.70.0.0'], ['10.0.0.0/8', '100.127.255.255'], ['fd7a:115c:a1e0::/48'], ['fd7a:115c:a1e0::1234:5678'], ['fd00::/8'], ['::/0']]) {
    assert.deepEqual(v({ rules: [rule({ remote })] }).blocked, ['r'], JSON.stringify(remote));
  }
  for (const remote of [['192.168.0.0/16'], ['LocalSubnet'], ['100.128.0.0/9'], ['100.63.255.255'], ['fd7a:115c:a1e1::/48'], ['2001:db8::/32'], ['DNS', 'DHCP']]) {
    assert.deepEqual(v({ rules: [rule({ remote })] }).blocked, [], JSON.stringify(remote));
  }
  // port / protocol
  assert.deepEqual(v({ rules: [rule({ protocol: 'TCP', localPort: ['47800'] })] }).blocked, ['r']);
  assert.deepEqual(v({ rules: [rule({ protocol: 'TCP', localPort: ['47000-48000'] })] }).blocked, ['r']);
  assert.deepEqual(v({ rules: [rule({ protocol: 'TCP', localPort: ['443', 'RPC'] })] }).blocked, []);
  assert.deepEqual(v({ rules: [rule({ protocol: 'UDP' })] }).blocked, [], 'UDP-only rule does not stop signaling');
  assert.deepEqual(v({ rules: [rule({ protocol: 'TCP', localPort: ['47900'] })] }, 47900).blocked, ['r'], 'custom settings.port');
  // block all + PowerShell unwrapping a one-element array
  assert.deepEqual(v({ allowInbound: 'False', rules: rule({ profile: 4 }) }), { blocked: [], blockAll: true });
  assert.equal(v({ category: null, allowInbound: 'False' }).blockAll, false, 'unknown profile: cannot tell');
  assert.equal(firewallVerdict(null, 47800), null);
  assert.equal(firewallVerdict([], 47800), null);
});

test('idle warm-up: never while the OS session is locked; unlock invalidates and re-warms (main3-2)', async () => {
  const h = W;
  const pm = h.electron.powerMonitor;
  assert.equal(h.canWarm(), true);
  pm.emit('lock-screen');
  assert.equal(h.canWarm(), false, 'lock screen: no warm-up');
  // A resume on the lock screen invalidates the list; the warm-up it schedules is refused there.
  await h.capture.listDisplays({ force: true });
  h.getSources = 0;
  pm.emit('resume');
  assert.equal(h.capture.hasCache(), false);
  h.capture.scheduleWarm(0);
  await sleep(20);
  assert.equal(h.getSources, 0, 'nothing enumerated on the lock screen');
  // Something else filled the cache while locked (e.g. a password session): unlock drops it.
  await h.capture.listDisplays({ maxAgeMs: Infinity });
  assert.equal(h.capture.hasCache(), true);
  h.getSources = 0;
  pm.emit('unlock-screen');
  assert.equal(h.capture.hasCache(), false, "'unlock-screen' invalidates the list");
  assert.equal(h.canWarm(), true, 'unlocked: warming allowed again');
  h.capture.scheduleWarm(0); // (capture schedules it 2 s after the unlock; run it now)
  await sleep(20);
  assert.equal(h.getSources, 1, 're-warmed on the desktop');
  assert.equal(h.capture.hasCache(), true);

  // The live check covers a missed event / a start while locked (and asks again a minute later,
  // since no 'unlock-screen' may follow); failures are ignored.
  const realSchedule = h.capture.scheduleWarm;
  const rechecks = [];
  h.capture.scheduleWarm = (ms) => { rechecks.push(ms); };
  pm.getSystemIdleState = (threshold) => { assert.equal(threshold, 1); return 'locked'; };
  try {
    assert.equal(h.canWarm(), false);
  } finally {
    h.capture.scheduleWarm = realSchedule;
  }
  assert.deepEqual(rechecks, [60000]);
  pm.getSystemIdleState = () => 'idle';
  assert.equal(h.canWarm(), true);
  pm.getSystemIdleState = () => { throw new Error('unavailable'); };
  assert.equal(h.canWarm(), true);
  delete pm.getSystemIdleState;
});

test('idle warm-up: never while this machine views another device; re-scheduled when the last viewer ends (main3-3)', async () => {
  const h = W;
  const peer = { ...PEER, ips: ['100.100.1.2', 'fd7a:115c:a1e0::2'], dnsName: 'studio.tail1.ts.net' };
  const realResolve = h.ts.resolveTarget;
  h.ts.resolveTarget = async () => ({ ip: '100.100.1.2', port: 47800, peer: JSON.parse(JSON.stringify(peer)), portExplicit: true });
  const warmCalls = [];
  const realSchedule = h.capture.scheduleWarm;
  h.capture.scheduleWarm = (ms) => { warmCalls.push(ms); return realSchedule(ms); };
  try {
    assert.equal(h.canWarm(), true);
    const r = await invoke(h, 'session:connect', mainWindow(h), { target: '100.100.1.2' });
    assert.deepEqual(r, { ok: true });
    const viewer = live(h, '').find((w) => h.windowsMod.getKind(w.webContents) === 'viewer');
    assert.ok(viewer, 'viewer window opened');
    assert.equal(h.canWarm(), false, 'connecting viewer: no warm-up');
    await sleep(80); // state pushed while the viewer is busy
    assert.deepEqual(warmCalls, []);
    viewer.destroy(); // the user closes the viewer window
    await sleep(80);
    assert.equal(h.canWarm(), true);
    assert.deepEqual(warmCalls, [2000], 'a skipped warm-up runs at idle once the last viewer is gone');
    await sleep(80);
    assert.deepEqual(warmCalls, [2000], 'once per transition, not on every state push');
  } finally {
    h.ts.resolveTarget = realResolve;
    h.capture.scheduleWarm = realSchedule;
  }
});

/* ================================================================== darwin */

test('macOS: closing the full-screen main window leaves full screen first, then hides', async () => {
  const h = await load({ platform: 'darwin' });
  M = h;
  const win = mainWindow(h);
  win.visible = true;
  win.close();
  assert.equal(win.destroyed, false);
  assert.equal(win.visible, false, 'not full screen: hidden right away');
  win.visible = true;
  win.fullScreen = true;
  win.close();
  assert.deepEqual(win.fullScreenCalls, [false], 'leaves full screen');
  assert.equal(win.visible, true, 'not hidden inside the full-screen Space');
  win.close(); // a second Cmd+W while the transition runs
  assert.deepEqual(win.fullScreenCalls, [false]);
  win.fullScreen = false;
  win.emit('leave-full-screen');
  assert.equal(win.visible, false, 'hidden once out of full screen');
  assert.equal(win.destroyed, false);
});

test('macOS: the receive folder is prepared at startup and when hosting / the folder changes', async () => {
  const h = M;
  assert.equal(h.prepareDirCalls, 1, 'startup (hosting enabled)');
  h.settings.update({ downloadDir: path.join(h.userData, 'Received') });
  assert.equal(h.prepareDirCalls, 2);
  h.settings.update({ hostEnabled: false });
  h.settings.update({ downloadDir: null });
  assert.equal(h.prepareDirCalls, 2, 'not while hosting is off');
  h.settings.update({ hostEnabled: true });
  assert.equal(h.prepareDirCalls, 3);
});

test('macOS: no system audio → host-server defaults and password sessions start without audio; display kept awake', async () => {
  const h = M;
  assert.equal(h.capture.audioSupported(), false);
  assert.equal(h.host.settings.get().defaultPermissions.audio, false);
  h.host.permsSent.length = 0;
  startSession(h, { via: 'trusted' });
  await settle();
  assert.equal(h.host.permsSent[0].audio, false);
  assert.equal(h.psb.started.size, 1);
  h.host.emit('session-end', { id: h.host.sid, reason: 'viewer-ended' });
  assert.equal(h.psb.started.size, 0);
});

test('macOS: quitting during the full-screen transition does not hide; shutdown releases the blocker', async () => {
  const h = M;
  const win = mainWindow(h);
  win.visible = true;
  win.fullScreen = true;
  win.close();
  startSession(h, { via: 'password' });
  await settle();
  assert.equal(h.psb.started.size, 1);
  h.app.emit('before-quit', { preventDefault() {} });
  win.fullScreen = false;
  win.emit('leave-full-screen');
  assert.equal(win.visible, true, 'quitting: the window is closed by the quit, not hidden');
  await sleep(50);
  assert.equal(h.psb.started.size, 0, 'blocker released by shutdown');
});

/* ---------------- macOS login item (one load per scenario: reconcile runs at startup) */

test('macOS login item: removed by the user in System Settings → setting turned off, not re-registered', async () => {
  const h = await load({ platform: 'darwin', settings: { startAtLogin: true, loginItemApplied: true }, loginItem: { status: 'not-registered' } });
  assert.deepEqual(h.loginCalls, []);
  assert.equal(h.settings.get().startAtLogin, false);
  assert.equal(h.settings.get().loginItemApplied, false);
});

test('macOS login item: wanted and never registered → registered once and remembered', async () => {
  const h = await load({ platform: 'darwin', settings: { startAtLogin: true }, loginItem: { status: 'not-registered' } });
  assert.deepEqual(h.loginCalls, [{ openAtLogin: true }]);
  assert.equal(h.settings.get().loginItemApplied, true);
  assert.equal(h.settings.get().startAtLogin, true);
  // The user turns it off in Tunnelview → unregistered, marker cleared.
  h.settings.update({ startAtLogin: false });
  assert.deepEqual(h.loginCalls[1], { openAtLogin: false });
  assert.equal(h.settings.get().loginItemApplied, false);
});

test('macOS login item: already enabled → nothing re-registered; requires-approval → hint, no re-register', async () => {
  let h = await load({ platform: 'darwin', settings: { startAtLogin: true }, loginItem: { status: 'enabled' } });
  assert.deepEqual(h.loginCalls, []);
  assert.equal(h.settings.get().loginItemApplied, true);
  h = await load({ platform: 'darwin', settings: { startAtLogin: true, loginItemApplied: true }, loginItem: { status: 'requires-approval' } });
  assert.deepEqual(h.loginCalls, []);
  const hint = h.notifications.find((n) => /open at login/i.test(n.o.title));
  assert.ok(hint, 'approval hint shown');
  hint.emit('click');
  await settle();
  assert.deepEqual(h.opened, ['x-apple.systempreferences:com.apple.LoginItems-Settings.extension']);
});

test('macOS login item: not wanted but still registered → unregistered', async () => {
  const h = await load({ platform: 'darwin', settings: { startAtLogin: false, loginItemApplied: true }, loginItem: { status: 'enabled' } });
  assert.deepEqual(h.loginCalls, [{ openAtLogin: false }]);
  assert.equal(h.settings.get().loginItemApplied, false);
});

test('Windows viewer decodes video in software unless gpuVideoDecode is on; macOS never gets the switch', async () => {
  const DISABLE = 'disable-accelerated-video-decode';
  let h = await load({ platform: 'win32' });
  assert.ok(h.switches.includes(DISABLE), 'no settings file → software decode');
  h = await load({ platform: 'win32', settings: { gpuVideoDecode: false } });
  assert.ok(h.switches.includes(DISABLE));
  h = await load({ platform: 'win32', settings: { gpuVideoDecode: 'yes' } });
  assert.ok(h.switches.includes(DISABLE), 'only a literal true opts in');
  h = await load({ platform: 'win32', settings: { gpuVideoDecode: true } });
  assert.ok(!h.switches.includes(DISABLE), 'opted in → GPU decode');
  assert.equal(h.settings.get().gpuVideoDecode, true);
  h = await load({ platform: 'darwin', settings: { gpuVideoDecode: false } });
  assert.ok(!h.switches.includes(DISABLE), 'macOS keeps VideoToolbox');
});

/* ================================================================== identity + pairing a phone */

test('identity: userData/identity.json loaded before the host, passed to it; pairing events reach the main window; a session cancels the offer', async () => {
  const h = await load({
    platform: 'win32',
    // The harness stubs auth.js as {}; identity.js needs its real base64 helpers.
    before: () => {
      const file = require.resolve(path.join(SRC, 'main/auth.js'));
      delete require.cache[file];
      require(file);
    },
  });
  assert.ok(fs.existsSync(path.join(h.userData, 'userData', 'identity.json')), 'created in userData');
  const id = h.host.deps.identity;
  assert.ok(id && id.unavailable === false, 'HostServer got the loaded identity');
  const main = mainWindow(h);
  assert.deepEqual(await invoke(h, 'security:identity', main), { available: true, fingerprint: id.fingerprint(), wasReset: false });

  main.webContents.sent.length = 0;
  const offerId = '6f1c2a54-8d0e-4f43-9a1b-3c5d7e9f0a12';
  h.host.emit('pairing', { offerId, phase: 'attempt-failed', token: 'never-forwarded', peer: { name: 'mallory-pc', login: 'm@example.com', os: 'android', ip: '100.64.0.9' } });
  h.host.emit('pairing', { offerId, phase: 'not-a-phase' });
  h.host.emit('pairing', { offerId, phase: 'cancelled', reason: 'replaced' });
  assert.deepEqual(main.webContents.sent.filter(([ch]) => ch === 'pairing:status'), [
    ['pairing:status', { offerId, phase: 'attempt-failed', peer: { name: 'mallory-pc', login: 'm@example.com', os: 'android' } }],
    ['pairing:status', { offerId, phase: 'cancelled', reason: 'replaced' }],
  ]);

  assert.deepEqual(h.host.pairingCancels, []);
  startSession(h);
  assert.deepEqual(h.host.pairingCancels, [[null, 'session']], 'no pairing code stays usable while someone sees this desktop');
  const reset = await invoke(h, 'security:reset-identity', main);
  assert.equal(reset.ok, false);
  assert.equal(reset.code, 'SESSION_ACTIVE', 'reset locked during the incoming session');
  h.host.endSession('test-done');
  await settle();
});

test('pairing: main withdraws the offer when the main window\'s page goes without the dialog closing (crash, reload, navigation, closed)', async () => {
  const h = await load({ platform: 'win32' });
  const main = mainWindow(h);
  const cancels = h.host.pairingCancels;
  cancels.length = 0;
  const wc = main.webContents;
  // Not the page going away: in-page navigation, a sub-frame, hiding to the tray (the dialog stays
  // open there and keeps showing what happens to the code).
  wc.emit('did-start-navigation', { url: 'file:///index.html#x', isMainFrame: true, isSameDocument: true });
  wc.emit('did-start-navigation', { url: 'about:blank', isMainFrame: false, isSameDocument: false });
  wc.emit('did-start-navigation', {}, 'file:///index.html#y', true, true); // legacy arguments, in place
  main.close(); // closeToTray (default): hidden
  assert.equal(main.destroyed, false);
  assert.deepEqual(cancels, []);

  wc.emit('did-start-navigation', { url: 'file:///index.html', isMainFrame: true, isSameDocument: false }); // reload
  assert.deepEqual(cancels, [[null, 'cancelled']]);
  wc.emit('did-start-navigation', {}, 'file:///index.html', false, true); // legacy arguments
  assert.equal(cancels.length, 2);
  wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
  assert.equal(cancels.length, 3);
  main.destroy();
  assert.deepEqual(cancels, [[null, 'cancelled'], [null, 'cancelled'], [null, 'cancelled'], [null, 'cancelled']]);
  await settle();
});

/* ================================================================== in-app updates (updater.js) */

test('updater: created with the app facts, init() before start(); install is blocked by incoming, pending and outgoing sessions', async () => {
  const h = await load({ platform: 'win32' });
  const u = h.updater;
  assert.ok(u, 'createUpdater called');
  assert.deepEqual(u.calls.filter((c) => c === 'init' || c === 'start'), ['init', 'start']);
  const d = u.deps;
  assert.equal(d.appVersion, '0.0.0-test');
  assert.equal(d.isPackaged, true);
  assert.equal(d.settings, h.settings);
  assert.equal(d.userData, path.join(h.userData, 'userData'));
  assert.equal(d.platform, 'win32');
  assert.equal(d.resourcesPath, process.resourcesPath);
  assert.equal(d.execPath, process.execPath);
  assert.equal(typeof d.quit, 'function');
  assert.equal(typeof d.showItemInFolder, 'function');
  assert.equal(d.translated(), false);
  assert.equal(d.sessionBlocker(), null);

  startSession(h);
  await settle();
  assert.equal(d.sessionBlocker(), 'INCOMING_SESSION');
  h.host.endSession('test-done');
  await settle();
  assert.equal(d.sessionBlocker(), null);

  request(h);
  await settle();
  assert.equal(d.sessionBlocker(), 'INCOMING_REQUEST');
  await invoke(h, 'prompt:respond', live(h, 'Incoming')[0], { accept: false });
  await settle();
  assert.equal(d.sessionBlocker(), null);

  const peer = { ...PEER, ips: ['100.100.1.2'], dnsName: 'studio.tail1.ts.net' };
  const realResolve = h.ts.resolveTarget;
  h.ts.resolveTarget = async () => ({ ip: '100.100.1.2', port: 47800, peer: JSON.parse(JSON.stringify(peer)), portExplicit: true });
  try {
    assert.deepEqual(await invoke(h, 'session:connect', mainWindow(h), { target: '100.100.1.2' }), { ok: true });
    assert.equal(d.sessionBlocker(), 'OUTGOING_SESSION', 'connecting to another device counts');
    live(h, '').find((w) => h.windowsMod.getKind(w.webContents) === 'viewer').destroy();
    await settle();
    assert.equal(d.sessionBlocker(), null);
  } finally {
    h.ts.resolveTarget = realResolve;
  }
});

test('updater: its state reaches the main window cleaned; session changes and autoUpdateCheck reach the updater', async () => {
  const h = await load({ platform: 'win32' });
  const u = h.updater;
  const main = mainWindow(h);
  main.webContents.sent.length = 0;
  u.emit('state', { status: 'available', latest: { version: '0.4.0', date: '2026-11-07T12:00:00.000Z', notes: 'a\u0007b\nc', size: 5 }, file: 'C:\\x' });
  const sent = main.webContents.sent.filter(([ch]) => ch === 'update:state');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0][1].latest, { version: '0.4.0', date: '2026-11-07T12:00:00.000Z', notes: 'ab\nc', size: 5 });
  assert.equal('file' in sent[0][1], false);
  // The same updater answers update:get-state (ipc ctx.updater).
  const viaIpc = await invoke(h, 'update:get-state', main);
  assert.equal(viaIpc.status, 'idle');
  assert.equal(viaIpc.currentVersion, '0.0.0-test');

  const before = u.calls.filter((c) => c === 'sessionsChanged').length;
  startSession(h);
  await sleep(80); // the coalesced state push
  assert.ok(u.calls.filter((c) => c === 'sessionsChanged').length > before, 'blocked is re-evaluated on state pushes');
  h.host.endSession('test-done');
  await settle();

  h.settings.update({ autoUpdateCheck: false });
  assert.deepEqual(u.calls.filter((c) => Array.isArray(c)).pop(), ['settingsChanged', ['autoUpdateCheck']]);
  const n = u.calls.length;
  h.settings.update({ lastUpdateCheckAt: 5 });
  assert.equal(u.calls.slice(n).filter((c) => Array.isArray(c)).length, 0, 'its own bookkeeping does not reschedule');
});

test('updater: Windows stages under %LOCALAPPDATA% (never the roaming or redirected AppData), macOS under userData', async () => {
  const saved = process.env.LOCALAPPDATA;
  const restore = () => { if (saved === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = saved; };
  const local = path.join(os.tmpdir(), 'tunnelview-localappdata');
  try {
    process.env.LOCALAPPDATA = local;
    let h = await load({ platform: 'win32' });
    assert.equal(h.updater.deps.updatesDir, path.join(local, 'Tunnelview', 'updates'));
    assert.notEqual(path.dirname(h.updater.deps.updatesDir), h.updater.deps.userData);
    // Not set (or not an absolute path): the profile's AppData/Local.
    for (const v of [undefined, 'relative/dir']) {
      if (v === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = v;
      h = await load({ platform: 'win32' });
      assert.equal(h.updater.deps.updatesDir, path.join(h.userData, 'home', 'AppData', 'Local', 'Tunnelview', 'updates'), String(v));
    }
    process.env.LOCALAPPDATA = local;
    h = await load({ platform: 'darwin' });
    assert.equal(h.updater.deps.updatesDir, path.join(h.userData, 'userData', 'updates'));
  } finally {
    restore();
  }
});

test('updater: while it installs no session starts (HostServer busy, no prompt, no outgoing connect); waking from sleep reschedules', async () => {
  const h = await load({ platform: 'win32' });
  const busy = h.host.deps.busy;
  assert.equal(typeof busy, 'function', 'HostServer got the busy gate');
  assert.equal(busy(), false);
  h.updaterInstalling = true;
  assert.equal(busy(), true);

  const prompts = live(h, 'Incoming').length;
  const req = request(h);
  await settle();
  assert.deepEqual(req.answers, [{ accept: false, reason: 'busy' }]);
  assert.equal(live(h, 'Incoming').length, prompts, 'no prompt window');
  assert.equal(h.updater.deps.sessionBlocker(), null, 'nothing pending');

  const peer = { ...PEER, ips: ['100.100.1.2'], dnsName: 'studio.tail1.ts.net' };
  const realResolve = h.ts.resolveTarget;
  h.ts.resolveTarget = async () => ({ ip: '100.100.1.2', port: 47800, peer: JSON.parse(JSON.stringify(peer)), portExplicit: true });
  try {
    const r = await invoke(h, 'session:connect', mainWindow(h), { target: '100.100.1.2' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'UPDATING');
    assert.equal(live(h, '').filter((w) => h.windowsMod.getKind(w.webContents) === 'viewer').length, 0);
    // Not installing any more (UAC cancelled, or it failed): everything works again.
    h.updaterInstalling = false;
    assert.equal(busy(), false);
    const again = request(h);
    await settle();
    assert.deepEqual(again.answers, []);
    assert.equal(live(h, 'Incoming').length, prompts + 1, 'prompt shown');
    await invoke(h, 'prompt:respond', live(h, 'Incoming')[0], { accept: false });
    await settle();
  } finally {
    h.ts.resolveTarget = realResolve;
  }

  const pm = h.electron.powerMonitor;
  const n = h.updater.calls.filter((c) => c === 'reschedule').length;
  pm.emit('resume');
  pm.emit('unlock-screen');
  assert.equal(h.updater.calls.filter((c) => c === 'reschedule').length, n + 2, 'resume and unlock-screen re-read the wall clock');
});

test('updater: the quit for an install really exits — no hiding to the tray, short shutdown cap, updater disposed', async () => {
  const h = await load({ platform: 'win32' });
  const main = mainWindow(h);
  // A host that never finishes stopping: shutdown() would wait 2 s for it.
  h.host.stop = () => new Promise(() => {});
  h.updater.deps.quit();
  assert.equal(h.quitCalls, 1);
  h.app.emit('before-quit', { preventDefault() {} });
  main.close();
  assert.equal(main.destroyed, true, 'closed, not hidden to the tray (closeToTray is on)');
  await sleep(50);
  assert.ok(h.updater.calls.includes('dispose'), 'no check or download continues');
  await sleep(1650);
  assert.equal(h.quitCalls, 2, 'the second app.quit() came after the 1.5 s cap, not the usual 4 s');
});

test('macOS login item after an in-app update: registered again instead of being turned off', async () => {
  const h = await load({
    platform: 'darwin',
    settings: { startAtLogin: true, loginItemApplied: true },
    loginItem: { status: 'not-registered' },
    before: (x) => { x.updaterJustUpdated = { from: '0.3.0', to: '0.4.0' }; },
  });
  assert.deepEqual(h.loginCalls, [{ openAtLogin: true }]);
  assert.equal(h.settings.get().startAtLogin, true);
  assert.equal(h.settings.get().loginItemApplied, true);
});
