'use strict';
/*
 * node --test test/main-ipc-pairing.test.js — the pairing:* and security:* channels of ipc.js
 * (mobile DECISIONS D4, D7) with a fake `electron`, fake windows, a fake host-server and a real
 * identity.js key in a temp folder. No Electron runtime, no network, no Tailscale.
 * Its own file because ipc.js keeps module state (one register() per process); tests run in order.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PROTOCOL = require('../src/shared/protocol');

/* ------------------------------------------------------------------ fake electron */

const handlers = new Map();
const fakeElectron = {
  ipcMain: { handle: (ch, fn) => handlers.set(ch, fn), on() {} },
  shell: { openExternal: async () => {}, openPath: async () => '' },
  app: { relaunch() {}, getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  clipboard: { writeText: async () => {} },
};
require.cache[require.resolve('electron')] = {
  id: require.resolve('electron'), filename: require.resolve('electron'), loaded: true, exports: fakeElectron,
};

const ipc = require('../src/main/ipc');
const pairing = require('../src/main/pairing');
const qr = require('../src/main/qr');
const { createIdentity } = require('../src/main/identity');

/* ------------------------------------------------------------------ fakes */

let nextWcId = 500;
const entries = new Map();
function addEntry(kind) {
  const wc = new EventEmitter();
  wc.id = nextWcId++;
  wc.sent = [];
  wc.send = (ch, p) => wc.sent.push([ch, p]);
  const win = { webContents: wc, isDestroyed: () => false };
  entries.set(wc.id, { kind, win, wcId: wc.id });
  return win;
}
const windows = {
  isOwnMainFrame: (event) => entries.has(event.sender.id),
  getEntry: (event) => entries.get(event.sender.id) || null,
  getKind: (event) => { const e = entries.get(event.sender.id); return e ? e.kind : null; },
};

const SELF_ID = 'nSELF0001CNTRL';
const ts = {
  last: { state: 'running', self: { stableId: SELF_ID, hostname: 'studio-pc', dnsName: 'studio-pc.tail1.ts.net.', ips: ['100.64.0.1'] }, peers: [] },
  isTailscaleIp: () => true,
  normalizeIp: (ip) => ip,
  async status() { return this.last; },
};

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnelview-ipc-pairing-'));
// It holds private keys (test keys, but still): gone when this file is done.
test.after(() => fs.rmSync(userData, { recursive: true, force: true }));
const identityFile = path.join(userData, 'identity.json');
const identity = createIdentity({ file: identityFile });
assert.equal(identity.load().ok, true);

/**
 * Stands in for host-server: startPairing() writes a real link with the identity's key (like
 * HostServer.startPairing), or throws the configured refusal. Every call is recorded.
 */
class FakeHost {
  constructor() {
    this.calls = [];
    this.refusal = null;     // Error.code to throw from startPairing
    this.badLink = false;    // return a link the dialog cannot show
    this.activeSession = null;
    this.live = null;
    this.linkName = 'studio-pc.tail1.ts.net'; // the link's `n` ('' = no MagicDNS name in it)
  }
  startPairing() {
    this.calls.push(['start']);
    if (this.refusal) throw Object.assign(new Error('refused'), { code: this.refusal });
    const offerId = crypto.randomUUID();
    const expiresAt = Date.now() + PROTOCOL.PAIR.TTL_MS;
    const link = this.badLink ? 'tunnelview://pair/1/AAAA' : pairing.encodeLink({
      v: PROTOCOL.PAIR.LINK_VERSION, id: SELF_ID, n: this.linkName, a: ['100.64.0.1', 'fd7a:115c:a1e0::1'],
      p: PROTOCOL.DEFAULT_PORT, k: identity.publicKeyB64url(), t: crypto.randomBytes(PROTOCOL.PAIR.TOKEN_BYTES).toString('base64url'),
      x: Math.floor(expiresAt / 1000),
    });
    this.live = offerId;
    return { offerId, link, expiresAt, host: { id: SELF_ID, name: 'studio-pc.tail1.ts.net', ips: ['100.64.0.1'], port: PROTOCOL.DEFAULT_PORT } };
  }
  cancelPairing(offerId, reason) {
    this.calls.push(['cancel', offerId, reason]);
    if (!this.live || (offerId !== null && offerId !== this.live)) return false;
    this.live = null;
    return true;
  }
  status() { return { listening: true }; }
}
const host = new FakeHost();

let sessionActive = false;
let stateChanges = 0;
const hostEnabled = { value: true };
const ctx = {
  settings: { get: () => ({ hostEnabled: hostEnabled.value, port: PROTOCOL.DEFAULT_PORT, favorites: [] }) },
  tailscale: ts,
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
    getPermissions: () => (sessionActive ? { control: false, clipboard: false, files: false, audio: false } : null),
    sessionActive: () => sessionActive,
  },
  getHost: () => host,
  identity,
  getState: () => ({}),
  stateChanged: () => { stateChanges++; },
  notify() {},
  quit() {},
  appVersion: '0.0.0-test',
  osName: 'windows',
};
ipc.register(ctx);

const mainWin = addEntry('main');
const invoke = (ch, win, ...args) => handlers.get(ch)({ sender: { id: win.webContents.id } }, ...args);
const CHANNELS = ['pairing:start', 'pairing:cancel', 'security:identity', 'security:reset-identity', 'security:retry-identity'];

/** No private key material in a value the renderer receives (the link carries only the public key). */
function assertNoSecrets(value) {
  const text = JSON.stringify(value);
  const doc = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
  assert.ok(!text.includes(doc.priv), 'private key bytes never reach the renderer');
  assert.ok(!/priv|pkcs8|secret/i.test(Object.keys(value).join(' ')));
}

/* ------------------------------------------------------------------ tests */

test('every pairing / security channel is registered and answers only the main window', async () => {
  for (const ch of CHANNELS) assert.equal(typeof handlers.get(ch), 'function', ch);
  const others = [addEntry('viewer'), addEntry('panel'), addEntry('prompt')];
  const unregistered = { webContents: { id: 9999 } };
  for (const ch of CHANNELS) {
    for (const win of [...others, unregistered]) {
      await assert.rejects(invoke(ch, win, 'x'), /Forbidden/, `${ch} from a non-main window`);
    }
  }
  assert.deepEqual(host.calls, [], 'a rejected sender never reaches the host');
});

test('pairing:start returns the offer, its QR code and what the link names', async () => {
  const r = await invoke('pairing:start', mainWin);
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r).sort(), ['expiresAt', 'fingerprint', 'host', 'link', 'offerId', 'ok', 'qr']);
  assert.equal(r.offerId, host.live);
  assert.ok(r.link.startsWith(PROTOCOL.PAIR.LINK_PREFIX));
  assert.deepEqual(r.qr, qr.encode(r.link), 'the QR code encodes exactly the link');
  assert.equal(r.fingerprint, identity.fingerprint());
  assert.match(r.fingerprint, /^TV(-[A-Z2-7]{4}){5}$/);
  assert.deepEqual(r.host, { name: 'studio-pc.tail1.ts.net', ips: ['100.64.0.1', 'fd7a:115c:a1e0::1'], port: PROTOCOL.DEFAULT_PORT },
    'details come from the link a phone reads, not from what the host said beside it');
  assert.ok(r.expiresAt > Date.now() && r.expiresAt <= Date.now() + PROTOCOL.PAIR.TTL_MS);
  assertNoSecrets(r);
});

test('pairing:start refusals: session, hosting off, Tailscale down, no identity', async () => {
  host.calls = [];
  sessionActive = true;
  assert.deepEqual(await invoke('pairing:start', mainWin), { ok: false, code: 'SESSION_ACTIVE' });
  assert.deepEqual(host.calls, [], 'refused before asking the host');
  sessionActive = false;

  hostEnabled.value = false;
  assert.deepEqual(await invoke('pairing:start', mainWin), { ok: false, code: 'HOSTING_OFF' });
  assert.deepEqual(host.calls, []);
  hostEnabled.value = true;

  for (const code of ['SESSION_ACTIVE', 'HOSTING_OFF', 'TS_DOWN', 'NO_IDENTITY']) {
    host.refusal = code;
    assert.deepEqual(await invoke('pairing:start', mainWin), { ok: false, code }, code);
  }
  host.refusal = 'EWHATEVER';
  assert.deepEqual(await invoke('pairing:start', mainWin), { ok: false, code: 'HOSTING_OFF' }, 'unknown errors are not passed on');
  host.refusal = null;

  const getHost = ctx.getHost;
  ctx.getHost = () => null;
  assert.deepEqual(await invoke('pairing:start', mainWin), { ok: false, code: 'HOSTING_OFF' });
  ctx.getHost = getHost;
});

test('an offer whose link cannot be shown is cancelled at once', async () => {
  host.calls = [];
  host.badLink = true;
  assert.deepEqual(await invoke('pairing:start', mainWin), { ok: false, code: 'HOSTING_OFF' });
  host.badLink = false;
  const [, cancel] = host.calls;
  assert.equal(cancel[0], 'cancel');
  assert.equal(typeof cancel[1], 'string', 'only that offer');
  assert.equal(host.live, null);
});

test('pairing:cancel cancels only the named offer', async () => {
  const r = await invoke('pairing:start', mainWin);
  host.calls = [];
  for (const bad of [undefined, null, 42, '', 'x'.repeat(65), { offerId: r.offerId }]) {
    assert.deepEqual(await invoke('pairing:cancel', mainWin, bad), { ok: false });
  }
  assert.deepEqual(host.calls, [], 'invalid ids never reach the host (null would mean "any offer")');
  assert.deepEqual(await invoke('pairing:cancel', mainWin, crypto.randomUUID()), { ok: false }, 'a stale dialog');
  assert.equal(host.live, r.offerId, 'the newer offer stays');
  assert.deepEqual(await invoke('pairing:cancel', mainWin, r.offerId), { ok: true });
  assert.deepEqual(host.calls.at(-1), ['cancel', r.offerId, 'cancelled']);
  assert.equal(host.live, null);
});

test('security:identity reports the fingerprint and state, never the key', async () => {
  const info = await invoke('security:identity', mainWin);
  assert.deepEqual(info, { available: true, fingerprint: identity.fingerprint(), wasReset: false });
  assertNoSecrets(info);
});

test('security:reset-identity is refused during an incoming session, like the locked settings', async () => {
  const before = fs.readFileSync(identityFile);
  const fp = identity.fingerprint();
  await invoke('pairing:start', mainWin);
  host.calls = [];

  sessionActive = true;
  const r = await invoke('security:reset-identity', mainWin);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SESSION_ACTIVE');
  assert.equal(r.message, 'Disconnect the remote session to change security settings.');
  assert.equal('error' in r, false, 'error is IdentityInfo\'s, and the key is available');
  assert.equal(r.fingerprint, fp);
  sessionActive = false;

  // The host's own view counts too (a session the panel bookkeeping has not caught up with).
  host.activeSession = { id: 's1' };
  assert.equal((await invoke('security:reset-identity', mainWin)).code, 'SESSION_ACTIVE');
  host.activeSession = null;

  assert.ok(fs.readFileSync(identityFile).equals(before), 'identity.json untouched');
  assert.equal(identity.fingerprint(), fp);
  assert.equal(identity.wasReset, false);
  assert.deepEqual(host.calls, [], 'the live offer stays');
});

test('security:reset-identity makes a new key, cancels the live offer and reports wasReset', async () => {
  const fp = identity.fingerprint();
  const offer = host.live;
  assert.ok(offer, 'an offer is live from the previous test');
  host.calls = [];
  const changes = stateChanges;
  const r = await invoke('security:reset-identity', mainWin);
  assert.equal(r.ok, true);
  assert.equal(r.available, true);
  assert.equal(r.wasReset, true);
  assert.notEqual(r.fingerprint, fp);
  assert.equal(r.fingerprint, identity.fingerprint());
  assert.deepEqual(host.calls, [['cancel', null, 'identity-reset']], 'its link shows the old key');
  assert.equal(host.live, null);
  assert.ok(stateChanges > changes);
  assert.ok(fs.existsSync(`${identityFile}.old`), 'the previous key is kept');
  assertNoSecrets(r);
  assert.deepEqual(await invoke('security:identity', mainWin), { available: true, fingerprint: r.fingerprint, wasReset: true });
});

test('security:retry-identity reloads the file: unavailable while damaged, the same key once fixed', async () => {
  const fp = identity.fingerprint();
  const good = fs.readFileSync(identityFile);
  const goodBak = fs.readFileSync(`${identityFile}.bak`);
  fs.writeFileSync(identityFile, 'not json');
  fs.writeFileSync(`${identityFile}.bak`, 'not json either');
  await invoke('pairing:start', mainWin);
  host.calls = [];

  const bad = await invoke('security:retry-identity', mainWin);
  assert.deepEqual(bad, { available: false, fingerprint: null, wasReset: true, error: 'CORRUPT' });
  assert.deepEqual(host.calls, [['cancel', null, 'identity-reset']], 'no offer outlives the key it names');
  assert.deepEqual(await invoke('security:identity', mainWin), bad);

  fs.writeFileSync(identityFile, good);
  fs.writeFileSync(`${identityFile}.bak`, goodBak);
  host.calls = [];
  const ok = await invoke('security:retry-identity', mainWin);
  assert.deepEqual(ok, { available: true, fingerprint: fp, wasReset: true });

  await invoke('pairing:start', mainWin);
  host.calls = [];
  assert.equal((await invoke('security:retry-identity', mainWin)).fingerprint, fp);
  assert.deepEqual(host.calls, [], 'same key: the live offer stays valid');
});

test('without an identity object: unavailable, reset refused', async () => {
  ctx.identity = null;
  assert.deepEqual(await invoke('security:identity', mainWin), { available: false, fingerprint: null, wasReset: false, error: 'NOT_LOADED' });
  const r = await invoke('security:reset-identity', mainWin);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'NO_IDENTITY');
  assert.deepEqual(await invoke('security:retry-identity', mainWin), { available: false, fingerprint: null, wasReset: false, error: 'NOT_LOADED' });
  ctx.identity = identity;
});

test('sanitizePairingEvent keeps only what the dialog shows', () => {
  const id = crypto.randomUUID();
  assert.deepEqual(
    ipc.sanitizePairingEvent({ offerId: id, phase: 'attempt-failed', token: 'secret', proof: 'p', peer: { name: 'mallory\u202e-pc', login: 'm@example.com', os: 'android', ip: '100.64.0.9' } }),
    { offerId: id, phase: 'attempt-failed', peer: { name: 'mallory-pc', login: 'm@example.com', os: 'android' } });
  assert.deepEqual(ipc.sanitizePairingEvent({ offerId: id, phase: 'paired', peer: { name: 'pixel-8', login: 'a@example.com', os: 'haiku' } }),
    { offerId: id, phase: 'paired', peer: { name: 'pixel-8', login: 'a@example.com', os: 'other' } });
  assert.deepEqual(ipc.sanitizePairingEvent({ offerId: id, phase: 'cancelled', reason: 'session', peer: { name: 'x' } }),
    { offerId: id, phase: 'cancelled', reason: 'session' }, 'no peer on an offer that just ended');
  assert.deepEqual(ipc.sanitizePairingEvent({ offerId: id, phase: 'failed', reason: 'Too Many!' }), { offerId: id, phase: 'failed' });
  for (const bad of [null, 'x', { offerId: id }, { offerId: id, phase: 'started' }, { offerId: '', phase: 'paired' }, { offerId: 'x'.repeat(65), phase: 'expired' }]) {
    assert.equal(ipc.sanitizePairingEvent(bad), null, JSON.stringify(bad));
  }
});

test('pairing:start: a link without a MagicDNS name gives host.name \'\', never a name the phone cannot see', async () => {
  host.linkName = '';
  try {
    const r = await invoke('pairing:start', mainWin);
    assert.equal(r.ok, true);
    assert.equal(pairing.parseLink(r.link).n, '');
    // Neither this machine's hostname (ts.self.hostname 'studio-pc') nor the host's own host.name.
    assert.deepEqual(r.host, { name: '', ips: ['100.64.0.1', 'fd7a:115c:a1e0::1'], port: PROTOCOL.DEFAULT_PORT });
  } finally {
    host.linkName = 'studio-pc.tail1.ts.net';
  }
});

test('security:reset-identity in a session with the key unavailable: error stays the key\'s code, the sentence is in message', async (t) => {
  t.mock.method(console, 'error', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnelview-ipc-pairing-broken-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'identity.json'), 'damaged');
  const broken = createIdentity({ file: path.join(dir, 'identity.json') });
  assert.equal(broken.load().error, 'CORRUPT');
  ctx.identity = broken;
  sessionActive = true;
  try {
    assert.deepEqual(await invoke('security:reset-identity', mainWin), {
      ok: false, code: 'SESSION_ACTIVE', message: 'Disconnect the remote session to change security settings.',
      available: false, fingerprint: null, wasReset: false, error: 'CORRUPT',
    });
    assert.equal(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8'), 'damaged', 'nothing was reset');
  } finally {
    sessionActive = false;
    ctx.identity = identity;
  }
});
