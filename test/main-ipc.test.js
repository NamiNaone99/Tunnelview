'use strict';
/*
 * node --test test/main-ipc.test.js — ipc.js handlers with a fake `electron`, fake windows,
 * fake tailscale and a fake ViewerSession (no Electron runtime, no network to the tailnet).
 * Tests run in order and share ipc.js's module state (one register()).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const PROTOCOL = require('../src/shared/protocol');

/* ------------------------------------------------------------------ fake electron */

const handlers = new Map();
const listeners = new Map();
const opened = [];
const relaunched = [];
let dialogCalls = 0;
const fakeElectron = {
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on: (ch, fn) => listeners.set(ch, fn) },
  shell: { openExternal: async (u) => { opened.push(u); }, openPath: async () => '' },
  app: { relaunch: (o) => relaunched.push(o), getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: async () => { dialogCalls++; return { canceled: true, filePaths: [] }; } },
  clipboard: { writeText: async () => {} },
};
require.cache[require.resolve('electron')] = {
  id: require.resolve('electron'), filename: require.resolve('electron'), loaded: true, exports: fakeElectron,
};

const ipc = require('../src/main/ipc');
const { Settings } = require('../src/main/settings');

/* ------------------------------------------------------------------ fakes */

let nextWcId = 100;
const entries = new Map(); // wcId → registry entry

function fakeWin() {
  const win = new EventEmitter();
  const wc = new EventEmitter();
  wc.id = nextWcId++;
  wc.sent = [];
  wc.reloads = 0;
  wc.send = (ch, payload) => wc.sent.push([ch, payload]);
  wc.reload = () => { wc.reloads++; };
  win.webContents = wc;
  win.destroyed = false;
  win.focused = 0;
  win.isDestroyed = () => win.destroyed;
  win.isMinimized = () => false;
  win.restore = () => {};
  win.show = () => {};
  win.focus = () => { win.focused++; };
  win.close = () => { if (!win.destroyed) { win.destroyed = true; win.emit('closed'); } };
  return win;
}

function addEntry(kind) {
  const win = fakeWin();
  entries.set(win.webContents.id, { kind, win, wcId: win.webContents.id });
  return win;
}

const createdViewers = [];
const windows = {
  isOwnMainFrame: (event) => entries.has(event.sender.id),
  getEntry: (event) => entries.get(event.sender.id) || null,
  getKind: (event) => { const e = entries.get(event.sender.id); return e ? e.kind : null; },
  createViewer: (rec) => {
    const win = addEntry('viewer');
    createdViewers.push(rec);
    win.on('closed', () => entries.delete(win.webContents.id));
    return win;
  },
  setPanelExpanded() {},
};

const SELF = { stableId: 'nSELF', hostname: 'me', dnsName: 'me.tail1.ts.net', ips: ['100.64.0.1'], user: { login: 'me@example.com', displayName: 'Me' }, os: 'windows' };
const PEER = {
  stableId: 'nPEER', hostname: 'victims-macbook', dnsName: 'studio.tail1.ts.net', shortName: 'studio',
  ips: ['100.100.1.2', 'fd7a:115c:a1e0::2'], user: { login: 'alice@example.com', displayName: 'Alice' },
  os: 'macos', online: true, tags: [], direct: false, relay: 'fra',
};

const isTs = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(ip) || /^fd7a:115c:a1e0:/i.test(ip);
const norm = (ip) => String(ip).replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');

const ts = {
  state: 'running',
  peers: [PEER],
  last: null,
  cliPath: null,
  statusCalls: 0,
  resolveCalls: [],
  resolveError: null,
  isTailscaleIp: (ip) => isTs(norm(ip)),
  normalizeIp: norm,
  async status() {
    this.statusCalls++;
    this.last = { state: this.state, message: this.state === 'running' ? '' : 'Tailscale is turned off.', self: SELF, peers: this.state === 'running' ? this.peers : [] };
    return this.last;
  },
  async resolveTarget(str) {
    this.resolveCalls.push(str);
    if (this.resolveError) throw this.resolveError;
    const m = /^\[([^\]]+)\]:(\d+)$/.exec(str) || /^([^:]+):(\d+)$/.exec(str);
    const host = m ? m[1] : str;
    const port = m ? Number(m[2]) : PROTOCOL.DEFAULT_PORT;
    const st = await this.status();
    if (st.state !== 'running') { const e = new Error('Tailscale is turned off.'); e.code = 'TS_DOWN'; throw e; }
    const all = [{ ...SELF, isSelf: true }, ...st.peers];
    // Like tailscale.js: IP literal → its owner; else the stableId tier first, then names
    // (here also the self-reported hostname, so a name squatting a stableId can be simulated).
    const peer = isTs(norm(host)) ? all.find((p) => p.ips.includes(norm(host)))
      : all.find((p) => p.stableId === host) || all.find((p) => p.shortName === host || p.dnsName === host || p.hostname === host);
    if (!peer) { const e = new Error(`${host} is not a device in your tailnet.`); e.code = isTs(norm(host)) || /^\d/.test(host) ? 'NOT_TAILNET' : 'NOT_FOUND'; throw e; }
    const ip = isTs(norm(host)) ? norm(host) : peer.ips[0];
    return { ip, port, peer: JSON.parse(JSON.stringify(peer)), portExplicit: !!m };
  },
};

class FakeViewerSession extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.connected = false;
    this.closedWith = null;
    FakeViewerSession.instances.push(this);
  }
  connect() { this.connected = true; return true; }
  close(reason) { this.closedWith = reason; }
  async submitPassword(pw) { this.submitted = pw; return FakeViewerSession.submitResult; }
  sendSignal() { return true; }
}
FakeViewerSession.instances = [];
FakeViewerSession.submitResult = { ok: true };

const fakeAuth = {
  async hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(Buffer.from(pw, 'utf8'), salt, 32, { N: 1024, r: 8, p: 1 });
    return { salt: salt.toString('base64'), N: 1024, r: 8, p: 1, keylen: 32, key: key.toString('base64') };
  },
};
const settingsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnelview-ipc-'));
const settings = new Settings({ dir: settingsDir, auth: fakeAuth, downloadsDir: path.join(settingsDir, 'Downloads') });
settings.load();

let sessionActive = false;
let activePanelId = null; // wcId of the fake active session panel
const hostCtl = {
  isActivePanel: (wcId) => activePanelId !== null && wcId === activePanelId,
  getPermissions: () => (sessionActive ? { control: true, clipboard: true, files: true, audio: true } : null),
  sessionActive: () => sessionActive,
  panelReady: async () => ({}),
  endSession() {},
  setPermissions: (p) => p,
  promptInit: () => null,
  respond: () => ({ ok: false }),
};

const chunkCalls = [];
const files = {
  forgetOwner: async () => {},
  abort: async () => true,
  chunk: async (owner, id, data) => { chunkCalls.push([owner, id, data.length]); return { ok: true }; },
  openFolder: async () => ({ ok: true }),
};

const captureFake = {}; // filled per test
let quitCalls = 0;
const inputFacade = { available: true, reason: null, blocked: 'elevated-window', handle() {}, releaseAll() {} };
ipc.register({
  settings,
  tailscale: ts,
  auth: fakeAuth,
  ViewerSession: FakeViewerSession,
  windows,
  capture: captureFake,
  clipboard: { subscribe() {}, unsubscribe() {} },
  files,
  permissions: { KINDS: ['screen', 'accessibility'] },
  input: inputFacade,
  hostCtl,
  getHost: () => ({ status: () => ({ listening: true }) }),
  getState: () => ({ state: 'fake', tsCalls: ts.statusCalls }),
  stateChanged() {},
  notify() {},
  quit: () => { quitCalls++; },
  appVersion: '0.0.0-test',
  osName: 'windows',
});

const mainWin = addEntry('main');
const invoke = (ch, win, ...args) => handlers.get(ch)({ sender: { id: win.webContents.id } }, ...args);
const send = (ch, win, ...args) => listeners.get(ch)({ sender: { id: win.webContents.id } }, ...args);
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };
const statuses = (win) => win.webContents.sent.filter(([ch]) => ch === 'viewer:status').map(([, p]) => p);
const lastStatus = (win) => statuses(win).slice(-1)[0];

/** Open a viewer window through session:connect and let it start its session. */
async function openViewer(target = '100.100.1.2', extra = {}) {
  const before = createdViewers.length;
  const res = await invoke('session:connect', mainWin, { target, ...extra });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(createdViewers.length, before + 1);
  const rec = createdViewers[createdViewers.length - 1];
  const init = await invoke('viewer:ready', rec.win);
  await settle();
  return { rec, win: rec.win, init, vs: FakeViewerSession.instances[FakeViewerSession.instances.length - 1] };
}

const closeAll = () => { for (const r of createdViewers) r.win.close(); };

/* ------------------------------------------------------------------ ipc-1: reconnect re-resolves */

test('reconnect re-checks the device against current tailscale status (Tailscale down → refused)', async () => {
  ts.state = 'running';
  const { win, vs } = await openViewer();
  const n = FakeViewerSession.instances.length;
  assert.equal(vs.connected, true);
  assert.ok(ts.resolveCalls.includes('nPEER:47800'), 'the first start re-resolves the node (stableId, explicit port) too');

  vs.emit('closed', { reason: 'network', message: 'lost' });
  ts.state = 'stopped';
  const r = await invoke('viewer:reconnect', win);
  assert.deepEqual(r, { ok: false });
  assert.equal(FakeViewerSession.instances.length, n, 'no ViewerSession constructed');
  const st = lastStatus(win);
  assert.equal(st.phase, 'closed');
  assert.equal(st.reason, 'unreachable');
  assert.match(st.message, /turned off/);

  // Peer left the tailnet while Tailscale runs → not-tailnet.
  ts.state = 'running';
  ts.peers = [];
  assert.deepEqual(await invoke('viewer:reconnect', win), { ok: false });
  assert.equal(lastStatus(win).reason, 'not-tailnet');
  assert.equal(FakeViewerSession.instances.length, n);

  // Back on the tailnet → a fresh session, looked up by stableId with the stored port explicit.
  ts.peers = [PEER];
  assert.deepEqual(await invoke('viewer:reconnect', win), { ok: true });
  assert.equal(FakeViewerSession.instances.length, n + 1);
  assert.equal(ts.resolveCalls[ts.resolveCalls.length - 1], 'nPEER:47800');
  closeAll();
});

/* ------------------------------------------------------------------ net2-7: reconnect by stableId */

test('reconnect refuses when the stored IP now belongs to another node, and forgets the password', async () => {
  ts.peers = [PEER];
  const { win, rec, vs } = await openViewer('100.100.1.2:47800', { password: 'form-pw' });
  assert.equal(vs.opts.password, 'form-pw');
  vs.emit('status', { phase: 'accepted', sessionId: 's', permissions: {} });
  vs.emit('closed', { reason: 'network' });
  const n = FakeViewerSession.instances.length;
  // PEER left; another node got its address (and even calls itself like PEER's stableId).
  ts.peers = [{ ...PEER, stableId: 'nOTHER', hostname: 'nPEER', dnsName: 'evil.tail1.ts.net', shortName: 'evil', user: { login: 'mallory@example.com', displayName: 'M' } }];
  assert.deepEqual(await invoke('viewer:reconnect', win), { ok: false });
  assert.equal(FakeViewerSession.instances.length, n, 'nothing dialled');
  const st = lastStatus(win);
  assert.equal(st.phase, 'closed');
  assert.equal(st.reason, 'not-tailnet');
  assert.equal(rec.password, null, 'remembered password cleared');
  assert.equal(rec.pendingPassword, null);
  // Even once PEER is back, the forgotten password is not sent.
  ts.peers = [PEER];
  assert.deepEqual(await invoke('viewer:reconnect', win), { ok: true });
  assert.equal(FakeViewerSession.instances[FakeViewerSession.instances.length - 1].opts.password, null);
  closeAll();
});

test('reconnect follows the node to its new Tailscale IP (by stableId)', async () => {
  ts.peers = [PEER];
  const { win, rec, vs } = await openViewer('100.100.1.2:47800', { password: 'form-pw' });
  vs.emit('closed', { reason: 'network' });
  ts.peers = [{ ...PEER, ips: ['100.100.9.9', 'fd7a:115c:a1e0::9'] }];
  assert.deepEqual(await invoke('viewer:reconnect', win), { ok: true });
  const latest = FakeViewerSession.instances[FakeViewerSession.instances.length - 1];
  assert.equal(latest.opts.target.ip, '100.100.9.9');
  assert.equal(latest.opts.target.port, 47800, 'stored port kept');
  assert.equal(rec.target.ip, '100.100.9.9');
  assert.equal(latest.opts.password, 'form-pw', 'same node: the password still applies');
  ts.peers = [PEER];
  closeAll();
});

test('reconnect keeps the address family the user dialled while the node still has it', async () => {
  ts.peers = [PEER];
  const { win, vs } = await openViewer('[fd7a:115c:a1e0::2]:47800');
  vs.emit('closed', { reason: 'network' });
  assert.deepEqual(await invoke('viewer:reconnect', win), { ok: true });
  assert.equal(FakeViewerSession.instances[FakeViewerSession.instances.length - 1].opts.target.ip, 'fd7a:115c:a1e0::2');
  closeAll();
});

test('a reconnect superseded by another start (or by Disconnect) does not dial', async () => {
  const { win } = await openViewer();
  const n = FakeViewerSession.instances.length;
  const a = invoke('viewer:reconnect', win);
  const b = invoke('viewer:reconnect', win);
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual([ra.ok, rb.ok], [false, true]);
  assert.equal(FakeViewerSession.instances.length, n + 1, 'only the latest start constructs a session');
  FakeViewerSession.instances[n].emit('closed', { reason: 'network' });
  const c = invoke('viewer:reconnect', win);
  send('viewer:disconnect', win, 'viewer-closed'); // user gives up while the target is re-checked
  assert.deepEqual(await c, { ok: false });
  assert.equal(FakeViewerSession.instances.length, n + 1);
  closeAll();
});

/* ------------------------------------------------------------------ security-2: verified names */

test('viewer shows the Tailscale-verified name and owner, not the host self-report', async () => {
  const { win, init, vs } = await openViewer();
  assert.equal(init.target.hostname, 'studio', 'MagicDNS first label, not peer.hostname');
  vs.emit('status', { phase: 'hello', host: { hostname: 'my-own-pc', os: 'windows', user: { login: 'mallory@evil', displayName: 'Mallory' }, passwordSet: true, acceptMode: 'ask' } });
  const st = lastStatus(win);
  assert.equal(st.host.hostname, 'studio');
  assert.deepEqual(st.host.user, { login: 'alice@example.com', displayName: 'Alice' });
  assert.equal(ipc.listViewers().find((v) => v.id === win.webContents.id).hostname, 'studio');
  vs.emit('status', { phase: 'accepted', sessionId: 's1', permissions: { control: true }, host: { hostname: 'my-own-pc', os: 'windows', user: {} } });
  const recent = settings.get().recent[0];
  assert.equal(recent.hostname, 'studio');
  assert.equal(recent.port, 47800);
  closeAll();
});

test('verifiedName: dnsName first label → dnsName → ip', () => {
  assert.equal(ipc.verifiedName({ dnsName: 'box.tail1.ts.net', hostname: 'spoof' }, '100.64.0.9'), 'box');
  assert.equal(ipc.verifiedName({ dnsName: '', hostname: 'spoof' }, '100.64.0.9'), '100.64.0.9');
  assert.equal(ipc.verifiedName(null, '100.64.0.9'), '100.64.0.9');
});

test("connect passes the resolver's AMBIGUOUS code through", async () => {
  const e = new Error('Several devices are called "studio". Use the full MagicDNS name or the IP.');
  e.code = 'AMBIGUOUS';
  ts.resolveError = e;
  const r = await invoke('session:connect', mainWin, { target: 'studio' });
  ts.resolveError = null;
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AMBIGUOUS');
  assert.match(r.error, /Several devices/);
});

/* ------------------------------------------------------------------ ipc-2: hostReason */

test('closed status keeps a valid hostReason (status and closed-event paths)', async () => {
  let { win, vs } = await openViewer();
  vs.emit('status', { phase: 'closed', reason: 'host-ended', message: 'The remote side ended the session.', hostReason: 'capture-failed' });
  assert.equal(lastStatus(win).hostReason, 'capture-failed');
  closeAll();

  ({ win, vs } = await openViewer());
  vs.emit('status', { phase: 'closed', reason: 'host-ended', hostReason: 'Not Valid!' });
  assert.ok(!('hostReason' in lastStatus(win)), 'invalid hostReason dropped');
  closeAll();

  ({ win, vs } = await openViewer());
  vs.emit('closed', { reason: 'host-ended', message: 'x', hostReason: 'non-tailnet-path' });
  assert.equal(lastStatus(win).hostReason, 'non-tailnet-path');
  closeAll();

  assert.equal(ipc.sanitizeStatus({ phase: 'waiting', hostReason: 'x' }).hostReason, undefined, 'only on closed');
});

/* ------------------------------------------------------------------ ipc-5: password handling */

test("submit-password reports the session's {ok:false} and never stores an unverified password", async () => {
  const { win, vs } = await openViewer();
  vs.emit('status', { phase: 'auth-required', host: { hostname: 'x', os: 'macos', user: {}, passwordSet: true, acceptMode: 'password-only' } });
  FakeViewerSession.submitResult = { ok: false, error: 'Still checking the previous password.' };
  assert.deepEqual(await invoke('viewer:submit-password', win, 'secret-1'), { ok: false, error: 'Still checking the previous password.' });
  FakeViewerSession.submitResult = { ok: true };
  assert.deepEqual(await invoke('viewer:submit-password', win, 'wrong-pw'), { ok: true });
  vs.emit('status', { phase: 'auth-required', remaining: 2 }); // host said: wrong
  vs.emit('closed', { reason: 'network' });
  await invoke('viewer:reconnect', win);
  let latest = FakeViewerSession.instances[FakeViewerSession.instances.length - 1];
  assert.equal(latest.opts.password, null, 'wrong password is not re-sent by Reconnect');

  assert.deepEqual(await invoke('viewer:submit-password', win, 'right-pw'), { ok: true });
  latest.emit('status', { phase: 'accepted', sessionId: 's', permissions: {} });
  latest.emit('closed', { reason: 'network' });
  await invoke('viewer:reconnect', win);
  latest = FakeViewerSession.instances[FakeViewerSession.instances.length - 1];
  assert.equal(latest.opts.password, 'right-pw', 'accepted password is reused');
  closeAll();
});

test('connect-form password is dropped after denied:bad-password', async () => {
  const { win, vs } = await openViewer('100.100.1.2', { password: 'form-pw' });
  assert.equal(vs.opts.password, 'form-pw');
  vs.emit('status', { phase: 'closed', reason: 'denied:bad-password', message: 'Wrong password' });
  await invoke('viewer:reconnect', win);
  assert.equal(FakeViewerSession.instances[FakeViewerSession.instances.length - 1].opts.password, null);
  closeAll();
});

test('denied:locked forgets the password only when a proof was sent; rate-limited keeps it (net3-4)', async () => {
  const latest = () => FakeViewerSession.instances[FakeViewerSession.instances.length - 1];
  /** Open with a form password, close the session with `closed` via `path`, then Reconnect. */
  async function scenario(closed, path = 'status') {
    const { win, rec, vs } = await openViewer('100.100.1.2', { password: 'form-pw' });
    assert.equal(vs.opts.password, 'form-pw');
    if (path === 'status') vs.emit('status', { phase: 'closed', message: 'x', ...closed });
    else vs.emit('closed', { message: 'x', ...closed });
    const kept = rec.password;
    assert.deepEqual(await invoke('viewer:reconnect', win), { ok: true });
    const next = latest().opts.password;
    closeAll();
    return { kept, next };
  }
  // hello.auth.passwordLocked: no proof sent → the untried password survives the lock-out.
  for (const path of ['status', 'closed']) {
    const r = await scenario({ reason: 'denied:locked', proofSent: false }, path);
    assert.equal(r.kept, 'form-pw', `${path}: kept`);
    assert.equal(r.next, 'form-pw', `${path}: Reconnect passes it to the next session`);
  }
  // The proof was sent (it may have caused the lock), or nobody says: forget it, as before.
  for (const closed of [{ reason: 'denied:locked', proofSent: true }, { reason: 'denied:locked' }]) {
    for (const path of ['status', 'closed']) {
      const r = await scenario(closed, path);
      assert.equal(r.kept, null, `${JSON.stringify(closed)} via ${path}`);
      assert.equal(r.next, null);
    }
  }
  // HTTP 429 is not a password denial.
  const r = await scenario({ reason: 'rate-limited' });
  assert.equal(r.next, 'form-pw');
  // Garbage proofSent values are ignored (→ unknown → forget on denied:locked).
  assert.equal(ipc.sanitizeStatus({ phase: 'closed', reason: 'denied:locked', proofSent: 'no' }).proofSent, undefined);
  assert.equal(ipc.sanitizeStatus({ phase: 'waiting', proofSent: false }).proofSent, undefined, 'only on closed');
  assert.equal(ipc.sanitizeStatus({ phase: 'closed', reason: 'denied:locked', proofSent: false }).proofSent, false);
  assert.equal((await scenario({ reason: 'denied:locked', proofSent: 0 })).next, null);
});

/* ------------------------------------------------------------------ ux-8: one window per device */

test('connecting to a device with an open viewer focuses it instead of opening another', async () => {
  const { win } = await openViewer();
  const before = createdViewers.length;
  const r = await invoke('session:connect', mainWin, { target: 'studio' });
  assert.deepEqual(r, { ok: true, existing: true });
  assert.equal(createdViewers.length, before);
  assert.ok(win.focused >= 1);
  assert.deepEqual(await invoke('viewer:focus', mainWin, win.webContents.id), { ok: true });
  assert.deepEqual(await invoke('viewer:focus', mainWin, 99999), { ok: false });
  closeAll();
});

test('the same device addressed by its IPv6 address focuses the open IPv4 viewer (runtime2-6)', async () => {
  const { win } = await openViewer('100.100.1.2:47800');
  const before = createdViewers.length;
  const focused = win.focused;
  assert.deepEqual(await invoke('session:connect', mainWin, { target: '[fd7a:115c:a1e0::2]:47800' }), { ok: true, existing: true });
  assert.equal(createdViewers.length, before);
  assert.ok(win.focused > focused);
  // Another port on the same node is another listener: a new window.
  const r = await invoke('session:connect', mainWin, { target: '[fd7a:115c:a1e0::2]:47999' });
  assert.deepEqual(r, { ok: true });
  assert.equal(createdViewers.length, before + 1);
  closeAll();
});

/* ------------------------------------------------------------------ ux-3: port selection */

test('targets without a port use a recent connection port; explicit ports win', async () => {
  settings.update({ recent: [] });
  settings.addRecent({ stableId: 'nPEER', hostname: 'studio', ip: '100.100.1.2', os: 'macos', port: 48123 });
  let { rec } = await openViewer('studio');
  assert.equal(rec.target.port, 48123);
  closeAll();
  ({ rec } = await openViewer('100.100.1.2:47999'));
  assert.equal(rec.target.port, 47999);
  closeAll();
  settings.update({ recent: [] });
  ({ rec } = await openViewer('studio'));
  assert.equal(rec.target.port, PROTOCOL.DEFAULT_PORT, 'default when our own port is the default');
  closeAll();
});

/* ------------------------------------------------------------------ ux-9: probe outcomes */

test('fetchInfo distinguishes ok / not-allowed / incompatible / error / refused / timeout', async () => {
  let mode = 'ok';
  const server = http.createServer((req, res) => {
    if (mode === 'hang') return; // never answers
    if (mode === '426') { res.writeHead(426); res.end(); return; }
    if (mode === '403') { res.writeHead(403); res.end(); return; }
    if (mode === '503') { res.writeHead(503); res.end(); return; }
    if (mode === 'other') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"hello":1}'); return; }
    const body = mode === 'ok'
      ? { app: PROTOCOL.APP_ID, protocol: PROTOCOL.PROTOCOL_VERSION, version: '1.0', os: 'macos', passwordSet: true, acceptMode: 'ask', busy: false }
      : { app: PROTOCOL.APP_ID, protocol: PROTOCOL.PROTOCOL_VERSION + 1 };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const ok = await ipc.fetchInfo('127.0.0.1', port);
    assert.equal(ok.status, 'ok');
    assert.equal(ok.info.passwordSet, true);
    mode = 'newer';
    assert.equal((await ipc.fetchInfo('127.0.0.1', port)).status, 'incompatible');
    mode = '426';
    assert.equal((await ipc.fetchInfo('127.0.0.1', port)).status, 'incompatible');
    mode = '403';
    assert.equal((await ipc.fetchInfo('127.0.0.1', port)).status, 'not-allowed', 'Who can connect excludes us');
    mode = '503';
    assert.equal((await ipc.fetchInfo('127.0.0.1', port)).status, 'error', 'transient: not a policy answer');
    mode = 'other';
    assert.equal((await ipc.fetchInfo('127.0.0.1', port)).status, 'error');
    mode = 'hang';
    assert.equal((await ipc.fetchInfo('127.0.0.1', port)).status, 'timeout');
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  assert.equal((await ipc.fetchInfo('127.0.0.1', port)).status, 'refused');
});

/* ------------------------------------------------------------------ security-6: settings lock */

test('security settings are locked while an incoming session is active', async () => {
  sessionActive = true;
  try {
    await assert.rejects(invoke('settings:update', mainWin, { acceptMode: 'password-only' }), /Disconnect the remote session to change security settings\./);
    await assert.rejects(invoke('settings:update', mainWin, { theme: 'dark', allowFrom: 'list' }), /Disconnect the remote session/);
    await assert.rejects(invoke('settings:update', mainWin, { defaultPermissions: { control: false } }), /Disconnect/);
    await assert.rejects(invoke('settings:update', mainWin, { downloadDir: path.join(os.tmpdir(), 'Startup') }), /Disconnect/);
    assert.equal(settings.get().acceptMode, 'ask');
    assert.equal(settings.get().theme, 'system', 'nothing applied from a refused partial');
    // Unrelated keys (and unchanged locked values) still apply.
    const pub = await invoke('settings:update', mainWin, { theme: 'dark', acceptMode: 'ask', quality: 'speed' });
    assert.equal(pub.theme, 'dark');
    assert.equal(pub.quality, 'speed');
    assert.deepEqual(await invoke('settings:set-password', mainWin, 'a-long-password'), { ok: false, error: 'Disconnect the remote session to change security settings.' });
    const calls = dialogCalls;
    assert.equal(await invoke('settings:choose-download-dir', mainWin), null);
    assert.equal(dialogCalls, calls, 'no dialog while locked');
  } finally {
    sessionActive = false;
  }
  const pub = await invoke('settings:update', mainWin, { acceptMode: 'password-only' });
  assert.equal(pub.acceptMode, 'password-only');
  assert.deepEqual(await invoke('settings:set-password', mainWin, 'a-long-password'), { ok: true });
  settings.update({ acceptMode: 'ask', theme: 'system' });
});

/* ------------------------------------------------------------------ misc handlers */

test('kd keeps a well-formed locks field and never rejects for a bad one', () => {
  assert.deepEqual(ipc.sanitizeInput({ t: 'kd', code: 'KeyA', key: 'a', rep: false, locks: { caps: true, num: false } }),
    { t: 'kd', code: 'KeyA', key: 'a', rep: false, locks: { caps: true, num: false } });
  assert.deepEqual(ipc.sanitizeInput({ t: 'kd', code: 'KeyA', key: 'a', locks: { caps: false, num: 'x' } }).locks, { caps: false });
  assert.ok(!('locks' in ipc.sanitizeInput({ t: 'kd', code: 'KeyA', key: 'a', locks: { num: true } })));
  assert.ok(!('locks' in ipc.sanitizeInput({ t: 'kd', code: 'KeyA', key: 'a', locks: 'caps' })));
  assert.ok(!('locks' in ipc.sanitizeInput({ t: 'ku', code: 'KeyA', key: 'a', locks: { caps: true } })), 'kd only');
});

test('viewer:path-info reports direct/relay from tailscale status, cached 2 s', async () => {
  const { win } = await openViewer();
  const calls = ts.statusCalls;
  assert.deepEqual(await invoke('viewer:path-info', win), { ok: true, direct: false, relay: 'fra' });
  assert.deepEqual(await invoke('viewer:path-info', win), { ok: true, direct: false, relay: 'fra' });
  assert.equal(ts.statusCalls, calls + 1, 'second call served from the cache');
  closeAll();
  ts.peers = [{ ...PEER, direct: undefined, relay: undefined }];
  const v2 = await openViewer();
  assert.deepEqual(await invoke('viewer:path-info', v2.win), { ok: true, direct: null, relay: '' });
  ts.peers = [PEER];
  closeAll();
});

test('Tailscale actions: download page, refresh polls status now', async () => {
  assert.deepEqual(await invoke('app:open-tailscale-download', mainWin), { ok: true });
  assert.equal(opened[opened.length - 1], 'https://tailscale.com/download');
  const calls = ts.statusCalls;
  const st = await invoke('tailscale:refresh', mainWin);
  assert.equal(st.state, 'fake');
  assert.equal(ts.statusCalls, calls + 1);
});

test('app:relaunch relaunches without --hidden and quits gracefully', async () => {
  process.argv.push('--hidden');
  try {
    assert.deepEqual(await invoke('app:relaunch', mainWin), { ok: true });
  } finally {
    process.argv.pop();
  }
  await tick();
  assert.equal(relaunched.length, 1);
  assert.ok(!relaunched[0].args.includes('--hidden'));
  assert.equal(quitCalls, 1);
});

test('files:chunk is an invoke gated like the other file channels', async () => {
  const { win } = await openViewer();
  assert.deepEqual(await invoke('files:chunk', win, 't1', new Uint8Array(3)), { ok: true });
  assert.deepEqual(chunkCalls[chunkCalls.length - 1], [win.webContents.id, 't1', 3]);
  assert.deepEqual(await invoke('files:chunk', win, '', new Uint8Array(3)), { ok: false, reason: 'bad-request' });
  const panel = addEntry('panel'); // not the active session's panel
  assert.deepEqual(await invoke('files:chunk', panel, 't1', new Uint8Array(3)), { ok: false, reason: 'not-allowed' });
  closeAll();
});

test('panel:input-status forwards the input layer blocked reason', async () => {
  const panel = addEntry('panel');
  assert.deepEqual(await invoke('panel:input-status', panel), { available: true, reason: null, blocked: 'elevated-window' });
  inputFacade.blocked = null;
  assert.equal((await invoke('panel:input-status', panel)).blocked, null);
});

/* ------------------------------------------------------------------ lifecycle-7: viewer crash */

test('a crashed viewer renderer drops its session, reloads, and does not auto-reconnect', async () => {
  const { win, vs } = await openViewer();
  const n = FakeViewerSession.instances.length;
  win.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(vs.closedWith, 'viewer-crashed');
  await tick();
  assert.equal(win.webContents.reloads, 1);
  await invoke('viewer:ready', win); // the reloaded renderer
  await settle();
  assert.equal(FakeViewerSession.instances.length, n, 'no automatic reconnect');
  const st = lastStatus(win);
  assert.equal(st.phase, 'closed');
  assert.equal(st.reason, 'network');
  assert.deepEqual(await invoke('viewer:reconnect', win), { ok: true }, 'Reconnect works after a crash');
  closeAll();
});

/* ------------------------------------------------------------------ panel2-4 / runtime2-4: displays */

test('panel:commit-display: {ok:true}, or not-found with the display main actually served', async () => {
  const panel = addEntry('panel');
  activePanelId = panel.webContents.id;
  const committed = [];
  let served = '1';
  Object.assign(captureFake, {
    commitDisplay: (id) => { committed.push(id); return id === '2' ? { ok: true } : { ok: false, error: 'not-found' }; },
    servedDisplayId: () => served,
  });
  try {
    assert.deepEqual(await invoke('panel:commit-display', panel, '2'), { ok: true });
    assert.deepEqual(await invoke('panel:commit-display', panel, '3'), { ok: false, error: 'not-found', served: '1' });
    served = null;
    assert.deepEqual(await invoke('panel:commit-display', panel, '3'), { ok: false, error: 'not-found', served: null });
    assert.deepEqual(await invoke('panel:commit-display', panel, ''), { ok: false, error: 'not-found', served: null });
    assert.deepEqual(committed, ['2', '3', '3'], 'an invalid id never reaches capture');
    const other = addEntry('panel'); // not the active session's panel
    await assert.rejects(invoke('panel:commit-display', other, '2'), /No active session/);
  } finally {
    activePanelId = null;
  }
});

test('panel:list-displays accepts a cached list up to a minute old', async () => {
  const panel = addEntry('panel');
  activePanelId = panel.webContents.id;
  const asked = [];
  Object.assign(captureFake, {
    LIST_MAX_AGE_MS: 60000,
    listDisplays: async (opts) => { asked.push(opts); return [{ id: '1', name: 'A', primary: true, width: 1, height: 1, scaleFactor: 1, bounds: {} }]; },
    publicDisplay: (d) => ({ id: d.id, name: d.name }),
  });
  try {
    assert.deepEqual(await invoke('panel:list-displays', panel), [{ id: '1', name: 'A' }]);
    assert.deepEqual(asked, [{ maxAgeMs: 60000 }]);
  } finally {
    activePanelId = null;
  }
});

/* ------------------------------------------------------------------ macos2-4 */

test('settings:update never lets the renderer set the loginItemApplied bookkeeping flag', async () => {
  const pub = await invoke('settings:update', mainWin, { loginItemApplied: true, theme: 'light' });
  assert.equal(pub.theme, 'light');
  assert.equal(settings.get().loginItemApplied, false);
  settings.update({ theme: 'system' });
});
