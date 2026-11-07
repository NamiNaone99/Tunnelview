'use strict';
/*
 * node --test test/signaling.test.js
 * Integration: real HostServer + ViewerSession over 127.0.0.1. A fake tailscale object declares
 * 127.0.0.1 (and, for whois-path tests, 127.0.0.2/3) to be tailnet IPs; settings.port = 0.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const { EventEmitter } = require('events');
const WebSocket = require('ws');

const PROTOCOL = require('../src/shared/protocol');
const auth = require('../src/main/auth');
const { normalizeIp } = require('../src/main/tailscale');
const HostServer = require('../src/main/host-server');
const ViewerSession = require('../src/main/viewer-client');

const FAST_KDF = { N: 16384, r: 8, p: 1, keylen: 32 };
const PASSWORD = 'open sesame 42';
const V = PROTOCOL.PROTOCOL_VERSION;
const VH = { [PROTOCOL.PROTOCOL_HEADER]: String(V) };
let STORED; // hashed once

const SELF_LOGIN = 'alice@example.com';

const SELF_ID = 'nSELFTEST';

class FakeTailscale extends EventEmitter {
  constructor({ selfIps = ['127.0.0.1'], tailnet = ['127.0.0.1'], whois = {}, peers = [], selfId = SELF_ID } = {}) {
    super();
    this.tailnet = new Set(tailnet);
    this.whoisMap = whois;
    this.whoisCalls = 0;
    this.statusCalls = 0;
    this.selfId = selfId;
    this.peers = peers; // [{stableId, ips}] — the viewer only dials self/peer IPs
    // When set, a ViewerSession sharing this fake (viewerFor) sees this as its own `self` (the
    // host keeps using `last.self`): the viewer is then another node, e.g. Bob (makeRemoteBob).
    this.viewerSelf = null;
    this.last = this._status('running', selfIps);
  }

  _status(state, ips) {
    return {
      state,
      message: state === 'running' ? '' : 'Tailscale is turned off.',
      self: { id: '1', stableId: this.selfId, hostname: 'test-host', dnsName: 'test-host.example.ts.net', shortName: 'test-host', os: 'windows', ips, user: { login: SELF_LOGIN, displayName: 'Alice' }, tags: [] },
      magicDnsSuffix: 'example.ts.net',
      peers: state === 'running' ? this.peers : [],
    };
  }

  setState(state, ips) {
    this.last = this._status(state, ips);
    this.emit('status', this.last);
    this.emit('change', this.last);
  }

  async status() { this.statusCalls++; return this.last; }
  isTailscaleIp(a) { return this.tailnet.has(normalizeIp(a)); }
  normalizeIp(a) { return normalizeIp(a); }
  async whois(ip) {
    this.whoisCalls++;
    const w = this.whoisMap[normalizeIp(ip)];
    return w ? structuredClone(w) : null;
  }
}

class FakeSettings extends EventEmitter {
  constructor(overrides = {}) {
    super();
    this.s = {
      version: 1,
      hostEnabled: true,
      port: 0,
      acceptMode: 'ask',
      allowFrom: 'tailnet',
      allowList: [],
      autoAcceptSameUser: false,
      trustedNodes: [],
      password: null,
      defaultPermissions: { control: true, clipboard: true, files: true, audio: true },
      promptTimeoutSec: 30,
      ...overrides,
    };
  }

  get() { return structuredClone(this.s); }
  update(p) {
    Object.assign(this.s, structuredClone(p));
    // quiet: no 'change' → no host rebind (makeRemoteBob moves the self IPs off 127.0.0.1, and a
    // rebind would then stop listening there)
    if (!this.quiet) this.emit('change', this.get());
    return this.get();
  }
}

const BOB = {
  node: { id: '5', stableId: 'nBOB0000001CNTRL', name: 'bobs-mac.example.ts.net', hostname: 'Bobs-Mac', os: 'macos', ips: ['127.0.0.2'], tags: [] },
  user: { id: '1002', login: 'bob@example.com', displayName: 'Bob' },
  isSelf: false,
};

/**
 * After start(): treat 127.0.0.1 as a whois-identified OTHER node (Bob by default) instead of self.
 * A ViewerSession sharing this fake then sees itself as that node (own IP 127.0.0.1 = its socket's
 * local address) and the host as its peer owning 127.0.0.1 — consistent with the host's whois, so
 * the node-ID proof binding matches. (The server stays bound to 127.0.0.1 — no 'change' event.)
 */
function makeRemoteBob(ts, { node = {}, user = {} } = {}) {
  ts.last.self.ips = ['127.0.0.9'];
  const w = structuredClone(BOB);
  Object.assign(w.node, { ips: ['127.0.0.1'] }, node);
  Object.assign(w.user, user);
  ts.whoisMap['127.0.0.1'] = w;
  ts.viewerSelf = { id: '5', stableId: w.node.stableId, hostname: w.node.hostname, dnsName: w.node.name, os: w.node.os, ips: ['127.0.0.1'], user: { login: w.user.login, displayName: w.user.displayName }, tags: w.node.tags };
  ts.last.peers.splice(0, ts.last.peers.length, { stableId: ts.last.self.stableId, ips: ['127.0.0.1'] });
  return w;
}

/** Undo makeRemoteBob: 127.0.0.1 is self again (affects connections made from now on). */
function makeSelfAgain(ts) {
  ts.last.self.ips = ['127.0.0.1'];
  ts.viewerSelf = null;
  ts.last.peers.splice(0, ts.last.peers.length);
}

/** The viewer's own view of `tailscale status` (see FakeTailscale.viewerSelf). */
function viewerTs(ts) {
  return {
    normalizeIp: (a) => ts.normalizeIp(a),
    isTailscaleIp: (a) => ts.isTailscaleIp(a),
    async status() {
      const st = await ts.status(); // honours per-test overrides of ts.status
      return st && st.state === 'running' && ts.viewerSelf ? { ...st, self: structuredClone(ts.viewerSelf) } : st;
    },
  };
}

function once(emitter, event, { timeout = 5000, filter = () => true } = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { emitter.removeListener(event, on); reject(new Error(`timeout waiting for '${event}'`)); }, timeout);
    function on(v) {
      if (!filter(v)) return;
      clearTimeout(t);
      emitter.removeListener(event, on);
      resolve(v);
    }
    emitter.on(event, on);
  });
}

const phase = (vs, p, timeout) => once(vs, 'status', { filter: (s) => s.phase === p, timeout });

async function startHost(t, { settings = {}, ts = new FakeTailscale() } = {}) {
  const s = new FakeSettings(settings);
  const host = new HostServer({ tailscale: ts, settings: s, auth, appVersion: '0.1.0-test', osName: 'windows' });
  await host.start();
  t.after(() => host.stop());
  const st = host.status();
  assert.equal(st.listening, true, `host not listening: ${st.error}`);
  return { host, ts, settings: s, port: st.port };
}

function viewerFor(t, ts, port, { password = null, ip = '127.0.0.1' } = {}) {
  const vs = new ViewerSession({ tailscale: viewerTs(ts), auth, target: { ip, port, peer: null }, password, self: { hostname: 'viewer-pc', os: 'macos', version: '0.1.0' } });
  const closed = [];
  vs.on('closed', (c) => closed.push(c));
  vs.closedEvents = closed;
  t.after(() => vs.close('test-cleanup'));
  return vs;
}

/** Raw ws client for header/policy tests. Resolves {status} for HTTP rejections or {ws, msgs}. */
function raw(port, { headers = VH, origin, localAddress, path = PROTOCOL.WS_PATH } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, origin, localAddress, perMessageDeflate: false });
    const msgs = [];
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    ws.on('open', () => finish({ ws, msgs }));
    ws.on('unexpected-response', (_req, res) => { finish({ status: res.statusCode }); ws.terminate(); });
    ws.on('error', (error) => finish({ error }));
  });
}

async function waitFor(pred, timeout = 3000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail('condition not reached');
}

async function loopbackAliasWorks() {
  // 127.0.0.2 as a *source* address works on Windows/Linux; macOS only configures 127.0.0.1.
  return new Promise((resolve) => {
    const srv = net.createServer((s) => s.destroy()).listen(0, '127.0.0.1', () => {
      const c = net.connect({ port: srv.address().port, host: '127.0.0.1', localAddress: '127.0.0.2' });
      c.on('connect', () => { c.destroy(); srv.close(); resolve(true); });
      c.on('error', () => { srv.close(); resolve(false); });
    });
  });
}

test.before(async () => {
  STORED = await auth.hashPassword(PASSWORD, FAST_KDF);
});

/* ------------------------------------------------------------------------------------------ */

test('host binds only to the self Tailscale IPs and reports status', async (t) => {
  const { host, port } = await startHost(t);
  const st = host.status();
  assert.deepEqual(st.addresses, ['127.0.0.1']);
  assert.ok(port > 0);
  assert.equal(st.error, null);
});

test('prompt accept → accepted + sdp/ice relay both ways, permissions, host end', async (t) => {
  const { host, ts, port } = await startHost(t);
  const requests = [];
  host.on('request', (req) => {
    requests.push(req);
    req.respond({ accept: true, permissions: { control: false, junk: true }, trust: false });
  });
  const sessionStart = once(host, 'session-start');
  const vs = viewerFor(t, ts, port);
  const phases = [];
  vs.on('status', (s) => phases.push(s.phase));
  vs.connect();
  const acc = await phase(vs, 'accepted');
  assert.deepEqual(phases.slice(0, 3), ['connecting', 'hello', 'waiting']);
  assert.equal(acc.via, 'self'); // 127.0.0.1 is a self IP here → prompt, via 'self'
  assert.deepEqual(acc.permissions, { control: false, clipboard: true, files: true, audio: true });
  assert.equal(acc.host.hostname, 'test-host');
  assert.equal(acc.host.user.login, SELF_LOGIN);

  const session = await sessionStart;
  assert.equal(session.id, acc.sessionId);
  assert.equal(session.peer.ip, '127.0.0.1');
  assert.equal(session.peer.isSelf, true);
  assert.equal(session.peer.sameUser, true);
  assert.deepEqual(session.viewer, { hostname: 'viewer-pc', os: 'macos', version: '0.1.0' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].peer.user.login, SELF_LOGIN);
  assert.equal(host.activeSession.id, acc.sessionId);

  // host → viewer (unknown fields stripped)
  const gotSignal = once(vs, 'signal');
  assert.equal(host.sendSignal({ t: 'sdp', description: { type: 'offer', sdp: 'v=0\r\n', extra: 1 }, evil: true }), true);
  assert.deepEqual(await gotSignal, { t: 'sdp', description: { type: 'offer', sdp: 'v=0\r\n' } });

  // viewer → host
  const hostSignal = once(host, 'session-signal');
  const cand = { candidate: 'candidate:1 1 udp 2122260223 127.0.0.1 47801 typ host generation 0', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd', junk: 'x' };
  assert.equal(vs.sendSignal({ t: 'ice', candidate: cand }), true);
  assert.deepEqual(await hostSignal, { t: 'ice', candidate: { candidate: cand.candidate, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' } });
  const answer = once(host, 'session-signal');
  assert.equal(vs.sendSignal({ t: 'sdp', description: { type: 'answer', sdp: 'v=0\r\n' } }), true);
  assert.equal((await answer).description.type, 'answer');
  const eoc = once(host, 'session-signal');
  assert.equal(vs.sendSignal({ t: 'ice', candidate: null }), true);
  assert.deepEqual(await eoc, { t: 'ice', candidate: null });

  // invalid / non-tailnet signals are refused on both sides
  assert.equal(vs.sendSignal({ t: 'ice', candidate: { ...cand, candidate: 'candidate:1 1 udp 2122260223 192.168.1.20 47801 typ host' } }), false);
  assert.equal(vs.sendSignal({ t: 'sdp', description: { type: 'rollback', sdp: '' } }), false);
  assert.equal(vs.sendSignal({ t: 'bye' }), false);
  assert.equal(host.sendSignal({ t: 'sdp', description: { type: 'offer', sdp: 'x'.repeat(256 * 1024 + 1) } }), false);
  assert.equal(host.sendSignal({ t: 'ice', candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host', sdpMid: 0 } }), false);

  // permissions change
  const perms = once(vs, 'permissions');
  assert.deepEqual(host.setPermissions({ files: false }), { control: false, clipboard: true, files: false, audio: true });
  assert.deepEqual(await perms, { control: false, clipboard: true, files: false, audio: true });

  // host ends → viewer closed 'host-ended', session-end exactly once
  const ends = [];
  host.on('session-end', (e) => ends.push(e));
  const closed = once(vs, 'closed');
  assert.equal(host.endSession('host-ended'), true);
  assert.equal((await closed).reason, 'host-ended');
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(ends, [{ id: acc.sessionId, reason: 'host-ended' }]);
  assert.equal(host.activeSession, null);
  assert.equal(vs.closedEvents.length, 1);
});

test('prompt reject → denied:rejected', async (t) => {
  const { host, ts, port } = await startHost(t);
  const cancelled = [];
  host.on('request-cancelled', (id) => cancelled.push(id));
  host.on('request', (req) => setTimeout(() => assert.equal(req.respond({ accept: false }), true), 20));
  const vs = viewerFor(t, ts, port);
  vs.connect();
  const c = await once(vs, 'closed');
  assert.equal(c.reason, 'denied:rejected');
  assert.match(c.message, /declined/);
  assert.deepEqual(cancelled, []);
  assert.equal(vs.closedEvents.length, 1);
});

test('prompt timeout → denied:timeout + request-cancelled; late respond is a no-op', async (t) => {
  const { host, ts, port } = await startHost(t, { settings: { promptTimeoutSec: 1 } });
  let request;
  host.on('request', (req) => { request = req; });
  const cancelled = once(host, 'request-cancelled');
  const vs = viewerFor(t, ts, port);
  vs.connect();
  await phase(vs, 'waiting');
  const [c, id] = await Promise.all([once(vs, 'closed'), cancelled]);
  assert.equal(c.reason, 'denied:timeout');
  assert.equal(id, request.requestId);
  assert.equal(request.respond({ accept: true }), false);
});

test('no request listener → denied:rejected', async (t) => {
  const { ts, port } = await startHost(t);
  const vs = viewerFor(t, ts, port);
  vs.connect();
  assert.equal((await once(vs, 'closed')).reason, 'denied:rejected');
});

test('password accepted without a prompt', async (t) => {
  const { host, ts, port } = await startHost(t, { settings: { password: STORED } });
  let prompted = false;
  host.on('request', () => { prompted = true; });
  const vs = viewerFor(t, ts, port, { password: PASSWORD });
  vs.connect();
  const acc = await phase(vs, 'accepted');
  assert.equal(acc.via, 'password');
  assert.equal(prompted, false);
});

test('valid password while the prompt is pending → accepted via password + request-cancelled', async (t) => {
  const { host, ts, port } = await startHost(t, { settings: { password: STORED } });
  const requests = [];
  host.on('request', (r) => requests.push(r));
  const vs = viewerFor(t, ts, port);
  vs.connect();
  await phase(vs, 'waiting');
  const cancelled = once(host, 'request-cancelled');
  const res = await vs.submitPassword(PASSWORD);
  assert.deepEqual(res, { ok: true });
  const acc = await phase(vs, 'accepted');
  assert.equal(acc.via, 'password');
  assert.equal(await cancelled, requests[0].requestId);
  assert.equal(requests[0].respond({ accept: true }), false);
});

test('3 bad passwords → denied:bad-password (password-only mode)', async (t) => {
  const { host, ts, port } = await startHost(t, { settings: { password: STORED, acceptMode: 'password-only' } });
  makeRemoteBob(ts);
  let prompted = false;
  host.on('request', () => { prompted = true; });
  const vs = viewerFor(t, ts, port, { password: 'wrong-1' });
  const remaining = [];
  vs.on('status', (s) => { if (s.phase === 'auth-required' && s.remaining !== undefined) remaining.push(s.remaining); });
  vs.connect();
  await waitFor(() => remaining.length === 1);
  assert.deepEqual(await vs.submitPassword('wrong-2'), { ok: true });
  await waitFor(() => remaining.length === 2);
  const closed = once(vs, 'closed');
  assert.deepEqual(await vs.submitPassword('wrong-3'), { ok: true });
  assert.equal((await closed).reason, 'denied:bad-password');
  assert.deepEqual(remaining, [2, 1]);
  assert.equal(prompted, false, 'password-only must not prompt a non-self peer');
  // failures are counted per node and per (untagged) user — not per source IP
  assert.equal(host.limiter.remaining(`node:${BOB.node.stableId}`), 7);
  assert.equal(host.limiter.remaining('login:bob@example.com'), 7);
  assert.equal(host.limiter.remaining('127.0.0.1'), 10);
  assert.equal(host.globalLimiter.remaining('*'), 27);
});

test('self-connection in password-only mode still goes to the prompt (admission order)', async (t) => {
  const { host, ts, port } = await startHost(t, { settings: { password: STORED, acceptMode: 'password-only' } });
  host.on('request', (r) => r.respond({ accept: true }));
  const vs = viewerFor(t, ts, port, { password: 'wrong' });
  vs.connect();
  const acc = await phase(vs, 'accepted');
  assert.equal(acc.via, 'self');
});

test('password-only without a password → auth-required, then submitPassword → accepted', async (t) => {
  const { ts, port } = await startHost(t, { settings: { password: STORED, acceptMode: 'password-only' } });
  const vs = viewerFor(t, ts, port);
  vs.connect();
  const ar = await phase(vs, 'auth-required');
  assert.equal(ar.host.acceptMode, 'password-only');
  assert.equal(ar.host.passwordSet, true);
  assert.equal(ar.remaining, undefined);
  assert.deepEqual(await vs.submitPassword(PASSWORD), { ok: true });
  assert.equal((await phase(vs, 'accepted')).via, 'password');
});

test('password-only request without proof → denied:password-required', async (t) => {
  const { ts, port } = await startHost(t, { settings: { password: STORED, acceptMode: 'password-only' } });
  makeRemoteBob(ts);
  const c = await raw(port);
  await waitFor(() => c.msgs.length === 1);
  c.ws.send(JSON.stringify({ t: 'request', protocol: V, viewer: { hostname: 'x', os: 'windows', version: '1' }, proof: null }));
  const code = await new Promise((r) => c.ws.on('close', (cd) => r(cd)));
  assert.equal(code, 4000);
  assert.deepEqual(c.msgs.at(-1), { t: 'denied', reason: 'password-required' });
});

test('a locked identity still gets hello (passwordLocked) and the prompt; it sends no proof (net2-2)', async (t) => {
  const { host, ts, port } = await startHost(t, { settings: { password: STORED } });
  const hello0 = await raw(port);
  await waitFor(() => hello0.msgs.length === 1);
  assert.equal(hello0.msgs[0].auth.passwordLocked, false);
  await closeRaw(hello0);
  for (let i = 0; i < 10; i++) host.limiter.fail(`node:${SELF_ID}`);
  const h = await raw(port);
  await waitFor(() => h.msgs.length === 1);
  assert.equal(h.msgs[0].t, 'hello', 'no denial before hello any more');
  assert.equal(h.msgs[0].auth.passwordLocked, true);
  await closeRaw(h);
  // a remembered (correct) password is not used: the viewer asks for the prompt instead
  const requests = [];
  host.on('request', (r) => requests.push(r));
  const vs = viewerFor(t, ts, port, { password: PASSWORD });
  vs.connect();
  await phase(vs, 'waiting');
  assert.equal(requests.length, 1);
  assert.deepEqual(await vs.submitPassword(PASSWORD), { ok: false, error: 'Password sign-in is temporarily locked on the remote device.' });
  requests[0].respond({ accept: true });
  assert.equal((await phase(vs, 'accepted')).via, 'self');
  assert.equal(host.globalLimiter.remaining('*'), 30, 'nothing was counted');
});

test('hostEnabled=false → denied:disabled', async (t) => {
  const { ts, port } = await startHost(t, { settings: { hostEnabled: false } });
  const vs = viewerFor(t, ts, port);
  vs.connect();
  assert.equal((await once(vs, 'closed')).reason, 'denied:disabled');
});

test('Origin header → 403; missing/wrong protocol header → 426; wrong path → 404', async (t) => {
  const { port } = await startHost(t);
  assert.equal((await raw(port, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await raw(port, { headers: {} })).status, 426);
  assert.equal((await raw(port, { headers: { [PROTOCOL.PROTOCOL_HEADER]: '1' } })).status, 426); // v1 viewer (unbound proofs)
  assert.equal((await raw(port, { headers: { [PROTOCOL.PROTOCOL_HEADER]: String(V + 1) } })).status, 426);
  assert.equal((await raw(port, { path: '/tunnelview/v1?x=1' })).status, 404);
  assert.equal((await raw(port, { path: '/other' })).status, 404);
});

test('policy refusal → HTTP 403 → denied:not-allowed', async (t) => {
  const { ts, port } = await startHost(t, { settings: { allowFrom: 'list', allowList: ['someone@else.example'] } });
  makeRemoteBob(ts);
  const vs = viewerFor(t, ts, port);
  vs.connect();
  const c = await once(vs, 'closed');
  assert.equal(c.reason, 'denied:not-allowed');
});

test('whois failure → HTTP 503 → a retryable reason, not denied:not-allowed', async (t) => {
  const ts = new FakeTailscale();
  const { port } = await startHost(t, { ts });
  // Make the remote fail identification: not self, no whois (but a peer the viewer may dial).
  ts.last.self.ips = ['127.0.0.9'];
  ts.last.peers.push({ stableId: 'nUNKNOWN', ips: ['127.0.0.1'] });
  assert.equal((await raw(port)).status, 503);
  assert.equal((await getJson(port, PROTOCOL.INFO_PATH)).status, 503);
  const vs = viewerFor(t, ts, port);
  vs.connect();
  const c = await once(vs, 'closed');
  assert.equal(c.reason, 'denied:busy');
  assert.match(c.message, /Try again/);
});

test('second viewer while busy (pending prompt, then active session) → denied:busy', async (t) => {
  const { host, ts, port } = await startHost(t);
  let first;
  host.on('request', (r) => { if (!first) first = r; });
  const a = viewerFor(t, ts, port);
  a.connect();
  await phase(a, 'waiting');
  const b = viewerFor(t, ts, port);
  b.connect();
  assert.equal((await once(b, 'closed')).reason, 'denied:busy');
  first.respond({ accept: true });
  await phase(a, 'accepted');
  const c = viewerFor(t, ts, port);
  c.connect();
  assert.equal((await once(c, 'closed')).reason, 'denied:busy');
  const info = await getJson(port, PROTOCOL.INFO_PATH);
  assert.equal(info.body.busy, true);
});

test('viewer disconnect while pending → request-cancelled', async (t) => {
  const { host, ts, port } = await startHost(t);
  let req;
  host.on('request', (r) => { req = r; });
  const vs = viewerFor(t, ts, port);
  vs.connect();
  await phase(vs, 'waiting');
  const cancelled = once(host, 'request-cancelled');
  vs.close('changed-my-mind');
  assert.equal(await cancelled, req.requestId);
  assert.equal(vs.closedEvents.length, 1);
  assert.equal(vs.closedEvents[0].reason, 'local');
  // the slot is free again
  await waitFor(() => !host.hasPending);
});

test('session-end on viewer close (bye) and on abrupt disconnect', async (t) => {
  const { host, ts, port } = await startHost(t);
  host.on('request', (r) => r.respond({ accept: true }));
  const vs = viewerFor(t, ts, port);
  vs.connect();
  const acc = await phase(vs, 'accepted');
  const end1 = once(host, 'session-end');
  vs.close();
  assert.deepEqual(await end1, { id: acc.sessionId, reason: 'viewer-ended' });

  const vs2 = viewerFor(t, ts, port);
  vs2.connect();
  const acc2 = await phase(vs2, 'accepted');
  const ends = [];
  host.on('session-end', (e) => ends.push(e));
  vs2._ws.terminate(); // no close frame
  await waitFor(() => ends.length === 1);
  assert.deepEqual(ends[0], { id: acc2.sessionId, reason: 'network' });
  await waitFor(() => vs2.closedEvents.length === 1);
  assert.equal(vs2.closedEvents[0].reason, 'network');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(ends.length, 1);
});

test('host.stop() ends the session for the viewer and stops listening', async (t) => {
  const { host, ts, port } = await startHost(t);
  host.on('request', (r) => r.respond({ accept: true }));
  const vs = viewerFor(t, ts, port);
  vs.connect();
  await phase(vs, 'accepted');
  const ended = once(host, 'session-end');
  const closed = once(vs, 'closed');
  await host.stop();
  assert.equal((await ended).reason, 'host-stopped');
  assert.equal((await closed).reason, 'host-ended');
  assert.equal(host.status().listening, false);
});

test('invalid JSON from the viewer → close 1003; unknown types ignored', async (t) => {
  const { port } = await startHost(t);
  const c = await raw(port);
  await waitFor(() => c.msgs.length === 1);
  const hello = c.msgs[0];
  assert.equal(hello.t, 'hello');
  assert.equal(hello.protocol, V);
  assert.equal(hello.app, 'Tunnelview');
  assert.equal(hello.auth.passwordSet, false);
  assert.equal(hello.auth.salt, null);
  assert.equal(hello.auth.autoAccept, false); // self is never auto-accepted
  assert.equal(Buffer.from(hello.auth.nonce, 'base64').length, 32);
  c.ws.send(JSON.stringify({ t: 'something-new', x: 1 }));
  c.ws.send('{not json');
  const code = await new Promise((r) => c.ws.on('close', (cd) => r(cd)));
  assert.equal(code, 1003);
});

test('request with wrong protocol version → denied:protocol', async (t) => {
  const { port } = await startHost(t);
  const c = await raw(port);
  await waitFor(() => c.msgs.length === 1);
  c.ws.send(JSON.stringify({ t: 'request', protocol: 1, viewer: {}, proof: null }));
  await new Promise((r) => c.ws.on('close', r));
  assert.deepEqual(c.msgs.at(-1), { t: 'denied', reason: 'protocol' });
});

test('hello carries salt + kdf when a password is set; viewer refuses weak host KDF', async (t) => {
  const { port } = await startHost(t, { settings: { password: STORED } });
  const c = await raw(port);
  await waitFor(() => c.msgs.length === 1);
  assert.equal(c.msgs[0].auth.salt, STORED.salt);
  assert.deepEqual(c.msgs[0].auth.kdf, FAST_KDF);
  assert.equal(c.msgs[0].auth.key, undefined);
  assert.equal(JSON.stringify(c.msgs[0]).includes(STORED.key), false, 'the stored key never leaves the host');
  c.ws.close();

  // a malicious "host" asking for N=2 must not get a proof
  const evil = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  t.after(() => evil.close());
  await once(evil, 'listening');
  const received = [];
  evil.on('connection', (ws) => {
    ws.on('message', (d) => received.push(JSON.parse(String(d))));
    ws.send(JSON.stringify({ t: 'hello', protocol: V, app: 'Tunnelview', version: '1', host: { hostname: 'evil', os: 'windows', user: {} }, auth: { passwordSet: true, acceptMode: 'ask', salt: STORED.salt, kdf: { N: 2, r: 1, p: 1, keylen: 32 }, nonce: auth.newNonce() } }));
  });
  const ts = new FakeTailscale();
  const vs = viewerFor(t, ts, evil.address().port, { password: PASSWORD });
  vs.connect();
  const cl = await once(vs, 'closed');
  assert.equal(cl.reason, 'protocol');
  assert.match(cl.message, /unsafe/);
  assert.deepEqual(received, []);
});

test('viewer: non-tailnet target refused before dialing; closed port → not-tunnelview', async (t) => {
  const ts = new FakeTailscale();
  const vs = viewerFor(t, ts, 47800, { ip: '192.168.1.10' });
  const c = once(vs, 'closed');
  assert.equal(vs.connect(), false);
  assert.equal((await c).reason, 'not-tailnet');

  const port = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const vs2 = viewerFor(t, ts, port);
  vs2.connect();
  const c2 = await once(vs2, 'closed', { timeout: 8000 });
  assert.equal(c2.reason, 'not-tunnelview');
});

test('viewer: a plain HTTP server is detected as not-tunnelview', async (t) => {
  const srv = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const ts = new FakeTailscale();
  const vs = viewerFor(t, ts, srv.address().port);
  vs.connect();
  assert.equal((await once(vs, 'closed')).reason, 'not-tunnelview');
});

/* ------------------------------------------------------------------ /info */

function getJson(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(body); } catch { /* not json */ }
        resolve({ status: res.statusCode, body: parsed, type: res.headers['content-type'] });
      });
    });
    req.on('error', reject);
  });
}

test('GET /tunnelview/v1/info → JSON; other paths 404; non-IP Host 403', async (t) => {
  const { port } = await startHost(t, { settings: { password: STORED, acceptMode: 'password-only' } });
  const r = await getJson(port, PROTOCOL.INFO_PATH);
  assert.equal(r.status, 200);
  assert.match(r.type, /application\/json/);
  assert.deepEqual(r.body, { app: 'Tunnelview', protocol: V, version: '0.1.0-test', hostname: 'test-host', os: 'windows', passwordSet: true, acceptMode: 'password-only', busy: false, enabled: true });
  assert.equal((await getJson(port, '/')).status, 404);
  assert.equal((await getJson(port, '/tunnelview/v1')).status, 404);
  assert.equal((await getJson(port, PROTOCOL.INFO_PATH, { Host: 'attacker.example' })).status, 403);
});

/* ------------------------------------------------------------------ whois / policy (127.0.0.2 source) */

test('non-self peers: whois required, allowFrom policy, trusted + same-user auto-accept', async (t) => {
  if (!(await loopbackAliasWorks())) return t.skip('127.0.0.2 source address unavailable on this OS');
  const ALICE_PHONE = { node: { id: '6', stableId: 'nALICE00002CNTRL', name: 'alice-laptop.example.ts.net', hostname: 'alice-laptop', os: 'macos', ips: ['127.0.0.3'], tags: [] }, user: { id: '1001', login: SELF_LOGIN, displayName: 'Alice' }, isSelf: false };
  const ts = new FakeTailscale({ tailnet: ['127.0.0.1', '127.0.0.2', '127.0.0.3', '127.0.0.4'], whois: { '127.0.0.2': BOB, '127.0.0.3': ALICE_PHONE } });
  const { host, settings, port } = await startHost(t, { ts });

  // in range but whois fails → 503 (retryable); not in range → dropped at the TCP level (net3-1)
  assert.equal((await raw(port, { localAddress: '127.0.0.4' })).status, 503);
  ts.tailnet.delete('127.0.0.4');
  const outside = await raw(port, { localAddress: '127.0.0.4' });
  assert.equal(outside.status, undefined, 'no HTTP answer at all');
  assert.ok(outside.error);

  // allowFrom same-user: bob refused at upgrade, alice's other device allowed
  settings.update({ allowFrom: 'same-user' });
  assert.equal((await raw(port, { localAddress: '127.0.0.2' })).status, 403);
  const ok = await raw(port, { localAddress: '127.0.0.3' });
  assert.ok(ok.ws);
  ok.ws.close();

  // allowFrom list: by login / node name / stableId
  settings.update({ allowFrom: 'list', allowList: ['Bobs-Mac.example.ts.net.'] });
  const viaName = await raw(port, { localAddress: '127.0.0.2' });
  assert.ok(viaName.ws);
  viaName.ws.close();
  settings.update({ allowList: ['someone@else.example'] });
  assert.equal((await raw(port, { localAddress: '127.0.0.2' })).status, 403);

  // trusted node → accepted without a prompt
  settings.update({ allowFrom: 'tailnet', trustedNodes: [{ stableId: BOB.node.stableId, name: 'Bobs-Mac', login: 'bob@example.com', addedAt: 1 }] });
  host.on('request', () => assert.fail('trusted peer must not be prompted'));
  const tr = await raw(port, { localAddress: '127.0.0.2' });
  await waitFor(() => tr.msgs.length === 1);
  const started = once(host, 'session-start');
  tr.ws.send(JSON.stringify({ t: 'request', protocol: V, viewer: { hostname: 'bob', os: 'macos', version: '1' }, proof: null }));
  await waitFor(() => tr.msgs.length === 2);
  assert.equal(tr.msgs[1].t, 'accepted');
  assert.equal(tr.msgs[1].via, 'trusted');
  const s = await started;
  assert.equal(s.peer.user.login, 'bob@example.com');
  assert.equal(s.peer.sameUser, false);
  assert.equal(s.peer.isSelf, false);
  const ended = once(host, 'session-end');
  tr.ws.close();
  await ended;
  host.removeAllListeners('request');

  // same-user auto-accept
  settings.update({ trustedNodes: [], autoAcceptSameUser: true });
  const su = await raw(port, { localAddress: '127.0.0.3' });
  await waitFor(() => su.msgs.length === 1);
  su.ws.send(JSON.stringify({ t: 'request', protocol: V, viewer: { hostname: 'a', os: 'macos', version: '1' }, proof: null }));
  await waitFor(() => su.msgs.length === 2);
  assert.equal(su.msgs[1].via, 'same-user');
  su.ws.close();
  await once(host, 'session-end');

  // trust=true from the prompt persists the node (deduped)
  settings.update({ autoAcceptSameUser: false });
  host.on('request', (r) => r.respond({ accept: true, trust: true }));
  for (let i = 0; i < 2; i++) {
    const p = await raw(port, { localAddress: '127.0.0.2' });
    await waitFor(() => p.msgs.length === 1);
    p.ws.send(JSON.stringify({ t: 'request', protocol: V, viewer: { hostname: 'bob', os: 'macos', version: '1' }, proof: null }));
    await waitFor(() => p.msgs.some((m) => m.t === 'accepted'));
    const e = once(host, 'session-end');
    p.ws.close();
    await e;
  }
  assert.deepEqual(settings.get().trustedNodes.map((n) => n.stableId), [BOB.node.stableId]);
});

/* ------------------------------------------------------------------ binding lifecycle */

test('rebinds on tailscale change; stops listening when Tailscale stops', async (t) => {
  const ts = new FakeTailscale();
  const { host } = await startHost(t, { ts });
  const statuses = [];
  host.on('status', (s) => statuses.push(s));
  ts.setState('stopped', []);
  await waitFor(() => !host.status().listening);
  assert.match(host.status().error, /turned off/);
  ts.setState('running', ['127.0.0.1']);
  await waitFor(() => host.status().listening);
  assert.equal(host.status().error, null);
  assert.ok(statuses.length >= 2);
});

test('an unbindable IPv6 address does not block IPv4 or surface an error', async (t) => {
  const v6 = 'fd7a:115c:a1e0::dead:beef'; // not configured on this machine → EADDRNOTAVAIL
  const ts = new FakeTailscale({ selfIps: [v6, '127.0.0.1'], tailnet: ['127.0.0.1', v6] });
  const { host } = await startHost(t, { ts });
  assert.deepEqual(host.status().addresses, ['127.0.0.1']);
  assert.equal(host.status().error, null);
  assert.equal(host._unbound, 1, 'still retried on the next poll');
});

test('changing settings.port rebinds on the new port', async (t) => {
  const { host, settings, port } = await startHost(t);
  const free = await new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  assert.notEqual(free, port);
  settings.update({ port: free });
  await waitFor(() => host.status().port === free && host.status().listening);
  const info = await getJson(free, PROTOCOL.INFO_PATH);
  assert.equal(info.status, 200);
  await assert.rejects(getJson(port, PROTOCOL.INFO_PATH));
});

test('EADDRINUSE is reported and retried on the next poll', async (t) => {
  const blocker = net.createServer();
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
  const busyPort = blocker.address().port;
  const ts = new FakeTailscale();
  const s = new FakeSettings({ port: busyPort });
  const host = new HostServer({ tailscale: ts, settings: s, auth, appVersion: '0.1.0-test', osName: 'windows' });
  t.after(() => host.stop());
  await host.start();
  assert.equal(host.status().listening, false);
  assert.match(host.status().error, /in use/);
  await new Promise((r) => blocker.close(r));
  ts.emit('status', ts.last); // next poll
  await waitFor(() => host.status().listening);
  assert.equal(host.status().port, busyPort);
  assert.equal(host.status().error, null);
});

/* ------------------------------------------------------------------ admission hardening (net fixes) */

/** Raw client: waits for hello, sends a request; resolves {ws, msgs}. */
async function rawRequest(port, { proof = null, localAddress } = {}) {
  const c = await raw(port, { localAddress });
  assert.ok(c.ws, `upgrade refused (${c.status})`);
  await waitFor(() => c.msgs.length >= 1);
  c.ws.send(JSON.stringify({ t: 'request', protocol: V, viewer: { hostname: 'raw', os: 'windows', version: '1' }, proof }));
  return c;
}

function closeRaw(c) {
  return new Promise((r) => {
    if (!c.ws || c.ws.readyState === WebSocket.CLOSED) return r();
    c.ws.once('close', () => r());
    c.ws.close();
    return undefined;
  });
}

test('relay regression: a tailnet node relaying hello/request cannot get in with the viewer\'s proof', async (t) => {
  if (!(await loopbackAliasWorks())) return t.skip('127.0.0.2/3 source addresses unavailable on this OS');
  const MALLORY = { node: { id: '9', stableId: 'nMALLORY', name: 'office-pc-1.example.ts.net', hostname: 'office-pc', os: 'windows', ips: ['127.0.0.2'], tags: [] }, user: { id: '7', login: 'mallory@example.com', displayName: 'Mallory' }, isSelf: false };
  const tsH = new FakeTailscale({ tailnet: ['127.0.0.1', '127.0.0.2'], whois: { '127.0.0.2': MALLORY } });
  const { host, port: hPort } = await startHost(t, { ts: tsH, settings: { password: STORED, acceptMode: 'password-only' } });
  let prompted = false;
  host.on('request', () => { prompted = true; });
  const started = [];
  host.on('session-start', (s) => started.push(s));

  // M listens on 127.0.0.3 and dials H from 127.0.0.2: hello H→V and request V→H verbatim.
  const m = new WebSocket.Server({ host: '127.0.0.3', port: 0 });
  t.after(() => m.close());
  await once(m, 'listening');
  const fromH = [];
  let relayedProof = null;
  m.on('connection', (vws) => {
    const hws = new WebSocket(`ws://127.0.0.1:${hPort}${PROTOCOL.WS_PATH}`, { headers: VH, localAddress: '127.0.0.2', perMessageDeflate: false });
    t.after(() => hws.terminate());
    hws.on('message', (d) => {
      const msg = JSON.parse(String(d));
      fromH.push(msg);
      if (msg.t === 'hello') vws.send(JSON.stringify(msg));
    });
    vws.on('message', (d) => {
      const msg = JSON.parse(String(d));
      if (msg.t === 'request') { relayedProof = msg.proof; hws.send(JSON.stringify(msg)); }
    });
  });

  // the victim viewer V (its own node, own IP 127.0.0.1) knows H's password and (mistakenly) dials M
  const tsV = new FakeTailscale({ selfId: 'nVICTIM', selfIps: ['127.0.0.1'], tailnet: ['127.0.0.3'], peers: [{ stableId: 'nMALLORY', ips: ['127.0.0.3'] }] });
  const vs = viewerFor(t, tsV, m.address().port, { password: PASSWORD, ip: '127.0.0.3' });
  vs.connect();
  await waitFor(() => fromH.some((x) => x.t !== 'hello'), 5000);
  assert.ok(relayedProof, 'the viewer sent a proof (to M)');
  assert.equal(fromH.some((x) => x.t === 'accepted'), false);
  // V bound its proof to {nMALLORY, nVICTIM}; H checks {nSELFTEST, nMALLORY (whois of M's IP)}
  assert.deepEqual(fromH.find((x) => x.t !== 'hello'), { t: 'auth-failed', remaining: 2 });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(started, []);
  assert.equal(prompted, false);
});

test('proof binding uses node IDs: masqueraded addresses still verify (net2-8)', async (t) => {
  if (!(await loopbackAliasWorks())) return t.skip('127.0.0.2/3 source addresses unavailable on this OS');
  // Tailscale per-peer masquerading, simulated with a plain TCP forwarder: the viewer V (own IP
  // 127.0.0.1) reaches H at 127.0.0.3, while H sees V arriving from 127.0.0.2. An IP-bound proof
  // failed here as "Incorrect password"; both sides agree on the node IDs.
  const VIEWER_BOB = structuredClone(BOB);
  const tsH = new FakeTailscale({ tailnet: ['127.0.0.1', '127.0.0.2'], whois: { '127.0.0.2': VIEWER_BOB } });
  const { host, port } = await startHost(t, { ts: tsH, settings: { password: STORED, acceptMode: 'password-only' } });
  const fwd = net.createServer((inSock) => {
    const out = net.connect({ host: '127.0.0.1', port, localAddress: '127.0.0.2' });
    inSock.pipe(out).pipe(inSock);
    const kill = () => { inSock.destroy(); out.destroy(); };
    inSock.on('error', kill); out.on('error', kill); inSock.on('close', kill); out.on('close', kill);
  });
  await new Promise((r) => fwd.listen(0, '127.0.0.3', r));
  t.after(() => fwd.close());
  const tsV = new FakeTailscale({ selfId: BOB.node.stableId, selfIps: ['127.0.0.1'], tailnet: ['127.0.0.3'], peers: [{ stableId: SELF_ID, ips: ['127.0.0.3'] }] });
  const vs = viewerFor(t, tsV, fwd.address().port, { password: PASSWORD, ip: '127.0.0.3' });
  vs.connect();
  assert.equal((await phase(vs, 'accepted')).via, 'password');
  assert.deepEqual(vs._proofBinding(), { hostId: SELF_ID, viewerId: BOB.node.stableId });
  assert.equal(host.limiter.remaining(`node:${BOB.node.stableId}`), 10, 'no failure was counted');
  assert.equal(host.globalLimiter.remaining('*'), 30);
});

test('viewer dials only while Tailscale runs and the IP is self or a current peer', async (t) => {
  const srv = http.createServer();
  let upgrades = 0;
  srv.on('upgrade', (_req, sock) => { upgrades++; sock.destroy(); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  const port = srv.address().port;

  // Tailscale stopped: 127.0.0.1 still passes the range check, but nothing is dialed
  const stopped = new FakeTailscale();
  stopped.setState('stopped', []);
  const vs1 = viewerFor(t, stopped, port, { password: PASSWORD });
  const c1 = once(vs1, 'closed');
  assert.equal(vs1.connect(), true, 'connect() still returns synchronously');
  const r1 = await c1;
  assert.equal(r1.reason, 'unreachable');
  assert.match(r1.message, /Tailscale is not running/);
  assert.ok(stopped.statusCalls >= 1);

  // running, but the IP is neither self nor a peer
  const other = new FakeTailscale({ selfIps: ['127.0.0.9'], peers: [{ stableId: 'nOTHER', ips: ['127.0.0.5'] }] });
  const vs2 = viewerFor(t, other, port);
  vs2.connect();
  assert.equal((await once(vs2, 'closed')).reason, 'not-tailnet');

  // no usable status at all → treated as down
  const broken = new FakeTailscale();
  broken.status = async () => { throw new Error('boom'); };
  const vs3 = viewerFor(t, broken, port);
  vs3.connect();
  assert.equal((await once(vs3, 'closed')).reason, 'unreachable');

  // close() while the status check is in flight → no dial
  const slow = new FakeTailscale();
  let release;
  slow.status = () => new Promise((r) => { release = () => r(slow.last); });
  const vs4 = viewerFor(t, slow, port);
  assert.equal(vs4.connect(), true);
  assert.equal(vs4.connect(), false, 'already running');
  vs4.close();
  release();
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(vs4.closedEvents.map((c) => c.reason), ['local']);
  assert.equal(upgrades, 0, 'no upgrade request ever reached the listener');
});

test("allowFrom 'list' ignores the self-reported OS hostname; the prompt shows the MagicDNS label", async (t) => {
  const { host, ts, settings, port } = await startHost(t, { settings: { allowFrom: 'list', allowList: ['office-pc'] } });
  settings.quiet = true;
  makeRemoteBob(ts, { node: { stableId: 'nMALLORY', name: 'office-pc-1.example.ts.net', hostname: 'office-pc' }, user: { login: 'mallory@example.com', displayName: 'Mallory' } });
  assert.equal((await raw(port)).status, 403);
  for (const entry of ['office-pc-1', 'Office-PC-1.example.ts.net.', 'MALLORY@example.com', 'nMALLORY']) {
    settings.update({ allowList: [entry] });
    const c = await raw(port);
    assert.ok(c.ws, entry);
    await closeRaw(c);
  }
  settings.update({ allowList: ['office-pc-1'] });
  const req = once(host, 'request');
  const c = await rawRequest(port);
  const r = await req;
  assert.equal(r.peer.hostname, 'office-pc-1', 'verified MagicDNS label, not the claimed hostname');
  await closeRaw(c);
});

test("allowFrom 'list': a bare label only matches nodes of this tailnet; /info obeys the policy too", async (t) => {
  const { ts, settings, port } = await startHost(t, { settings: { allowFrom: 'list', allowList: ['laptop'] } });
  settings.quiet = true;
  // a node shared in from another tailnet that happens to be called "laptop"
  makeRemoteBob(ts, { node: { stableId: 'nSHARED', name: 'laptop.other-tailnet.ts.net', hostname: 'laptop' }, user: { login: 'eve@example.org', displayName: 'Eve' } });
  assert.equal((await raw(port)).status, 403, 'label of a foreign tailnet');
  assert.equal((await getJson(port, PROTOCOL.INFO_PATH)).status, 403, '/info refused as well: no busy / unattended hints');
  settings.update({ allowList: ['laptop.other-tailnet.ts.net'] });
  const full = await raw(port);
  assert.ok(full.ws, 'the full MagicDNS name still matches');
  await closeRaw(full);
  const info = await getJson(port, PROTOCOL.INFO_PATH);
  assert.equal(info.status, 200);
  assert.equal(info.body.app, 'Tunnelview');
  // a bare label of this tailnet matches; a transient status error keeps the last good suffix…
  settings.update({ allowList: ['laptop'] });
  makeRemoteBob(ts, { node: { stableId: 'nLAP', name: 'laptop.example.ts.net', hostname: 'laptop' }, user: { login: 'bob@example.com', displayName: 'Bob' } });
  const own = await raw(port);
  assert.ok(own.ws, 'own-tailnet label');
  await closeRaw(own);
  const saved = { state: ts.last.state, magicDnsSuffix: ts.last.magicDnsSuffix };
  Object.assign(ts.last, { state: 'error', magicDnsSuffix: null });
  const transient = await raw(port);
  assert.ok(transient.ws, 'transient status error: not refused as "not allowed"');
  await closeRaw(transient);
  // …but with no known MagicDNS suffix a bare label never matches
  Object.assign(ts.last, { state: 'running', magicDnsSuffix: null });
  assert.equal((await raw(port)).status, 403);
  Object.assign(ts.last, saved);
});

test('a dismissed device gets no new prompt for a while; a valid password still works', async (t) => {
  const { host, ts, port } = await startHost(t, { settings: { password: STORED } });
  const requests = [];
  host.on('request', (r) => { requests.push(r); r.respond({ accept: false }); });
  const a = viewerFor(t, ts, port);
  a.connect();
  assert.equal((await once(a, 'closed')).reason, 'denied:rejected');
  const b = viewerFor(t, ts, port);
  b.connect();
  const cb = await once(b, 'closed');
  assert.equal(cb.reason, 'denied:try-later');
  const sec = Number(/Try again in (\d+) seconds?\.$/.exec(cb.message)[1]);
  assert.ok(sec >= 1 && sec <= 30, cb.message);
  assert.ok(cb.message.startsWith(ViewerSession.DENY_TEXT['try-later']), cb.message);
  assert.equal(requests.length, 1, 'no second prompt within the back-off');
  assert.equal(host.hasPending, false, 'the refused request never held the pending slot');
  // the password path never prompts, so the back-off does not apply to it
  const c = viewerFor(t, ts, port, { password: PASSWORD });
  c.connect();
  assert.equal((await phase(c, 'accepted')).via, 'password');
  assert.equal(requests.length, 1);
});

test('prompt timeout starts the back-off; a viewer cancel does not', async (t) => {
  const { host, ts, port } = await startHost(t, { settings: { promptTimeoutSec: 1 } });
  const requests = [];
  host.on('request', (r) => requests.push(r));
  const a = viewerFor(t, ts, port);
  a.connect();
  await phase(a, 'waiting');
  const cancelled = once(host, 'request-cancelled');
  a.close('changed-my-mind');
  await cancelled;
  await waitFor(() => !host.hasPending);
  const b = viewerFor(t, ts, port);
  b.connect();
  await phase(b, 'waiting');
  assert.equal(requests.length, 2, 'a cancel is not a denial');
  assert.equal((await once(b, 'closed')).reason, 'denied:timeout');
  // an unanswered prompt: a flat 30 s, reported as "try later" (not "declined")
  const c = await rawRequest(port);
  await waitFor(() => c.msgs.length === 2);
  const d = c.msgs[1];
  assert.equal(d.reason, 'try-later');
  assert.ok(Number.isInteger(d.retryAfterSec) && d.retryAfterSec >= 28 && d.retryAfterSec <= 30, JSON.stringify(d));
  assert.equal(requests.length, 2);
  assert.equal(host._cooldown.get(`node:${SELF_ID}`).level, 0, 'timeouts do not escalate');
});

test('back-off levels: 30 s, 2 min, 10 min (cap), reset after 1 h; keyed by node; bounded', () => {
  const host = new HostServer({ tailscale: new FakeTailscale(), settings: new FakeSettings(), auth, appVersion: '0', osName: 'windows' });
  let now = 1e9;
  host._now = () => now;
  const conn = { ip: '127.0.0.2', ident: { node: { stableId: 'nX' } } };
  const sameNodeOtherIp = { ip: 'fd7a:115c:a1e0::2', ident: { node: { stableId: 'nX' } } };
  const expectWindow = (ms) => {
    assert.equal(host._coolingDown(conn), true);
    assert.equal(host._coolingDown(sameNodeOtherIp), true, 'both addresses of a node share the back-off');
    now += ms - 1;
    assert.equal(host._coolingDown(conn), true);
    now += 2;
    assert.equal(host._coolingDown(conn), false);
  };
  assert.equal(host._coolingDown(conn), false);
  host._recordDenial(conn);
  expectWindow(30e3);
  host._recordDenial(conn);
  expectWindow(120e3);
  host._recordDenial(conn);
  expectWindow(600e3);
  host._recordDenial(conn);
  expectWindow(600e3); // capped
  now += 60 * 60e3; // 1 h without a denial → back to the first step
  host._recordDenial(conn);
  expectWindow(30e3);
  host._recordDenial({ ip: '127.0.0.7', ident: { node: { stableId: '' } } });
  assert.ok(host._cooldown.has('ip:127.0.0.7'), 'falls back to the IP');
  for (let i = 0; i < 300; i++) host._recordDenial({ ip: '127.0.0.8', ident: { node: { stableId: `n${i}` } } });
  assert.equal(host._cooldown.size, 256);
  assert.ok(host._cooldown.has('node:n299') && !host._cooldown.has('node:n0'), 'oldest entries dropped');
});

test('unanswered prompts cost a flat 30 s and never escalate the back-off (net2-6)', () => {
  const host = new HostServer({ tailscale: new FakeTailscale(), settings: new FakeSettings(), auth, appVersion: '0', osName: 'windows' });
  let now = 1e9;
  host._now = () => now;
  const conn = { ip: '127.0.0.2', ident: { node: { stableId: 'nX' } } };
  for (let i = 0; i < 4; i++) {
    host._recordDenial(conn, 'timeout');
    assert.equal(host._cooldownLeftMs(conn), 30e3, `timeout #${i + 1}`);
    now += 30e3 + 1;
    assert.equal(host._coolingDown(conn), false);
  }
  assert.equal(host._cooldown.get('node:nX').level, 0);
  // dismissals escalate from the first step, timeouts in between keep (not raise) the level
  host._recordDenial(conn, 'dismissed');
  assert.equal(host._cooldownLeftMs(conn), 30e3);
  now += 30e3 + 1;
  host._recordDenial(conn, 'dismissed');
  assert.equal(host._cooldownLeftMs(conn), 120e3);
  now += 120e3 + 1;
  host._recordDenial(conn, 'timeout');
  assert.equal(host._cooldownLeftMs(conn), 30e3);
  assert.equal(host._cooldown.get('node:nX').level, 2);
  now += 30e3 + 1;
  host._recordDenial(conn, 'dismissed');
  assert.equal(host._cooldownLeftMs(conn), 600e3);
  // a timeout never shortens a running back-off
  host._recordDenial(conn, 'timeout');
  assert.equal(host._cooldownLeftMs(conn), 600e3);
});

test("try-later: retryAfterSec is validated, and the viewer explains the wait (net2-6)", async (t) => {
  const host = new HostServer({ tailscale: new FakeTailscale(), settings: new FakeSettings(), auth, appVersion: '0', osName: 'windows' });
  const sent = [];
  const fakeConn = () => ({ closed: false, state: 'hello', ws: { readyState: WebSocket.OPEN, send: (s) => sent.push(JSON.parse(s)), close() {}, terminate() {} } });
  host._tryLater(fakeConn(), 29001);
  host._tryLater(fakeConn(), 1);
  host._tryLater(fakeConn(), 10 * 3600e3);
  host._deny(fakeConn(), PROTOCOL.DENY.TRY_LATER, { retryAfterSec: 0 });
  host._deny(fakeConn(), PROTOCOL.DENY.TRY_LATER, { retryAfterSec: 1.5 });
  host._deny(fakeConn(), PROTOCOL.DENY.BUSY, { retryAfterSec: '30' });
  assert.deepEqual(sent, [
    { t: 'denied', reason: 'try-later', retryAfterSec: 30 },
    { t: 'denied', reason: 'try-later', retryAfterSec: 1 },
    { t: 'denied', reason: 'try-later', retryAfterSec: 3600 },
    { t: 'denied', reason: 'try-later' },
    { t: 'denied', reason: 'try-later' },
    { t: 'denied', reason: 'busy' },
  ]);

  const base = ViewerSession.DENY_TEXT['try-later'];
  // covers the prompt rate limit too, which also counts requests this device withdrew (runtime3-4)
  assert.equal(base, 'The remote device is not taking new requests from this device right now: a recent request was declined or not answered there, or this device asked several times in a few minutes.');
  assert.ok(ViewerSession.DENY_TEXT.locked.endsWith(' Try again in 15 minutes.'));
  // the viewer's reasons.js pulls the wait out with this regex: the base text must not match it
  const WAIT_RE = /Try again in [^.]+\./;
  assert.equal(WAIT_RE.test(base), false);
  assert.equal(WAIT_RE.exec(`${base} Try again in 45 seconds.`)[0], 'Try again in 45 seconds.');
  assert.equal(WAIT_RE.exec(`${base} Try again in about 10 minutes.`)[0], 'Try again in about 10 minutes.');
  assert.equal(WAIT_RE.exec(ViewerSession.DENY_TEXT.locked)[0], 'Try again in 15 minutes.');
  assert.equal(PROTOCOL.DENY.TRY_LATER, 'try-later');
  assert.equal(PROTOCOL.DENY.SUSPENDED, 'suspended');
  for (const [retryAfterSec, suffix] of [[45, ' Try again in 45 seconds.'], [1, ' Try again in 1 second.'], [89, ' Try again in 89 seconds.'],
    [90, ' Try again in about 2 minutes.'], [600, ' Try again in about 10 minutes.'], [3600, ' Try again in about 60 minutes.'],
    [0, ''], [3601, ''], ['30', ''], [1.5, ''], [undefined, '']]) {
    const srv = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
    t.after(() => srv.close());
    await once(srv, 'listening');
    srv.on('connection', (ws) => {
      ws.on('message', (d) => {
        if (JSON.parse(String(d)).t === 'request') ws.send(JSON.stringify({ t: 'denied', reason: 'try-later', retryAfterSec }));
      });
      ws.send(JSON.stringify({ t: 'hello', protocol: V, app: 'Tunnelview', version: '1', host: { hostname: 'h', os: 'windows', user: {} }, auth: { passwordSet: false, acceptMode: 'ask', salt: null, kdf: null, nonce: auth.newNonce() } }));
    });
    const vs = viewerFor(t, new FakeTailscale(), srv.address().port);
    vs.connect();
    const c = await once(vs, 'closed');
    assert.equal(c.reason, 'denied:try-later', String(retryAfterSec));
    assert.equal(c.message, base + suffix, String(retryAfterSec));
  }
});

test('a wrong password during the back-off gets auth-failed and can be retried; admission clears it (net2-6)', async (t) => {
  const { host, ts, port } = await startHost(t, { settings: { password: STORED } });
  const requests = [];
  host.on('request', (r) => { requests.push(r); r.respond({ accept: false }); });
  const a = viewerFor(t, ts, port);
  a.connect();
  assert.equal((await once(a, 'closed')).reason, 'denied:rejected');
  assert.equal(host._coolingDown({ ip: '127.0.0.1', ident: { node: { stableId: SELF_ID } } }), true);

  // wrong password while cooling: "incorrect password" + a retry, not "declined"
  const b = viewerFor(t, ts, port, { password: 'wrong' });
  const failed = once(b, 'status', { filter: (s) => s.phase === 'auth-required' && s.remaining === 2 });
  b.connect();
  await failed;
  assert.equal(host.hasPending, false, 'the auth wait does not hold the pending slot');
  assert.deepEqual(await b.submitPassword(PASSWORD), { ok: true });
  assert.equal((await phase(b, 'accepted')).via, 'password');
  assert.equal(requests.length, 1, 'no prompt during the back-off');
  // the admission cleared the back-off (and the prompt count)
  assert.equal(host._cooldown.size, 0);
  assert.equal(host._promptLog.size, 0);
  const ended = once(host, 'session-end');
  b.close();
  await ended;
  const c = viewerFor(t, ts, port);
  c.connect();
  assert.equal((await once(c, 'closed')).reason, 'denied:rejected');
  assert.equal(requests.length, 2, 'prompted again');
});

test('stop() and toggling hosting clear the prompt back-off; lockouts survive (net2-6)', async (t) => {
  const { host, settings } = await startHost(t);
  const conn = { ip: '127.0.0.2', ident: { node: { stableId: 'nX' } } };
  const fill = () => {
    host._recordDenial(conn, 'dismissed');
    host._logPrompt(conn);
    host.limiter.fail('node:nX');
  };
  fill();
  settings.update({ promptTimeoutSec: 20 }); // unrelated change → kept
  assert.equal(host._cooldown.size, 1);
  settings.update({ hostEnabled: false });
  assert.equal(host._cooldown.size, 0);
  assert.equal(host._promptLog.size, 0);
  fill();
  settings.update({ hostEnabled: true });
  assert.equal(host._cooldown.size, 0);
  fill();
  await host.stop();
  assert.equal(host._cooldown.size, 0);
  assert.equal(host._promptLog.size, 0);
  assert.equal(host.limiter.remaining('node:nX'), 7, 'password failures are not forgotten');
});

test('at most 3 prompts per device per 5 min, withdrawn ones included (net2-4)', async (t) => {
  const { host, ts, port } = await startHost(t);
  makeRemoteBob(ts);
  const requests = [];
  const cancels = [];
  host.on('request', (r) => requests.push(r));
  host.on('request-cancelled', (id) => cancels.push(id));
  for (let i = 0; i < 3; i++) {
    const c = await rawRequest(port);
    await waitFor(() => c.msgs.length === 2);
    assert.deepEqual(c.msgs[1], { t: 'pending' }, `cycle ${i + 1}`);
    c.ws.send(JSON.stringify({ t: 'bye', reason: 'viewer-cancelled' }));
    await new Promise((r) => c.ws.once('close', r));
    await waitFor(() => !host.hasPending);
  }
  assert.equal(requests.length, 3);
  assert.equal(cancels.length, 3);
  assert.equal(host._cooldown.size, 0, 'withdrawing records no back-off …');
  const c4 = await rawRequest(port);
  await waitFor(() => c4.msgs.length === 2);
  const d = c4.msgs[1];
  assert.equal(d.t, 'denied');
  assert.equal(d.reason, 'try-later', '… but the prompt count still stops the 4th');
  assert.ok(Number.isInteger(d.retryAfterSec) && d.retryAfterSec > 290 && d.retryAfterSec <= 300, JSON.stringify(d));
  assert.equal(requests.length, 3, "no 'request' event for the 4th");
  // the window slides: once the oldest prompt is 5 min old, one more is allowed
  const t0 = Date.now();
  host._now = () => t0 + 5 * 60e3 + 1000;
  const c5 = await rawRequest(port);
  await waitFor(() => c5.msgs.length === 2);
  assert.deepEqual(c5.msgs[1], { t: 'pending' });
  assert.equal(requests.length, 4);
  await closeRaw(c5);
  // other devices are not affected
  makeSelfAgain(ts);
  host._now = Date.now;
  const self = await rawRequest(port);
  await waitFor(() => self.msgs.length === 2);
  assert.deepEqual(self.msgs[1], { t: 'pending' });
  await closeRaw(self);
});

test('prompt log is bounded and pruned', () => {
  const host = new HostServer({ tailscale: new FakeTailscale(), settings: new FakeSettings(), auth, appVersion: '0', osName: 'windows' });
  let now = 1e9;
  host._now = () => now;
  for (let i = 0; i < 300; i++) host._logPrompt({ ip: '127.0.0.8', ident: { node: { stableId: `n${i}` } } });
  assert.equal(host._promptLog.size, 256);
  const conn = { ip: '127.0.0.2', ident: { node: { stableId: 'nP' } } };
  for (let i = 0; i < 5; i++) { host._logPrompt(conn); now += 1000; }
  assert.equal(host._promptLog.get('node:nP').length, 3, 'only the last 3 are kept');
  assert.equal(host._promptWaitMs(conn), 5 * 60e3 - 3000);
  now += 5 * 60e3;
  host._logPrompt(conn);
  assert.ok(host._promptLog.size <= 256);
  assert.equal(host._promptWaitMs(conn), 0);
});

test('password-only: a failed proof frees the pending slot; its later correct proof withdraws the prompt (net3-2)', async (t) => {
  const { host, ts, port } = await startHost(t, { settings: { password: STORED, acceptMode: 'password-only' } });
  makeRemoteBob(ts);
  const a = viewerFor(t, ts, port, { password: 'wrong' });
  const failed = once(a, 'status', { filter: (s) => s.phase === 'auth-required' && s.remaining === 2 });
  a.connect();
  await failed;
  assert.equal(host.hasPending, false, 'a failed password does not hold the single pending slot');
  // another viewer (self → prompt, even after a wrong password) can now get the slot …
  makeSelfAgain(ts);
  let req;
  host.on('request', (r) => { req = r; });
  const cancels = [];
  host.on('request-cancelled', (id) => cancels.push(id));
  const b = viewerFor(t, ts, port, { password: 'nope' });
  b.connect();
  await phase(b, 'waiting');
  assert.equal(host.hasPending, true);
  // … and the first connection's correct password takes precedence over that unanswered prompt
  const bClosed = once(b, 'closed');
  assert.deepEqual(await a.submitPassword(PASSWORD), { ok: true });
  assert.equal((await phase(a, 'accepted')).via, 'password');
  assert.equal((await bClosed).reason, 'denied:busy');
  assert.deepEqual(cancels, [req.requestId]);
  assert.equal(req.respond({ accept: true }), false, 'the withdrawn prompt can no longer be accepted');
  assert.equal(host._cooldown.size, 0, 'no back-off for the withdrawn viewer');
});

test('password-only host tells trusted / same-user viewers they will be admitted (hello.auth.autoAccept)', async (t) => {
  const trusted = [{ stableId: BOB.node.stableId, name: 'bobs-mac', login: 'bob@example.com', addedAt: 1 }];
  const { host, ts, settings, port } = await startHost(t, { settings: { password: STORED, acceptMode: 'password-only', trustedNodes: trusted } });
  settings.quiet = true;
  makeRemoteBob(ts);
  host.on('request', () => assert.fail('no prompt expected'));
  const h = await raw(port);
  await waitFor(() => h.msgs.length === 1);
  assert.equal(h.msgs[0].auth.autoAccept, true);
  await closeRaw(h);

  const vs = viewerFor(t, ts, port); // no password stored
  const phases = [];
  vs.on('status', (s) => phases.push(s.phase));
  vs.connect();
  assert.equal((await phase(vs, 'accepted')).via, 'trusted');
  assert.equal(phases.includes('auth-required'), false);
  let ended = once(host, 'session-end');
  vs.close();
  await ended;

  // same-user auto-accept
  settings.update({ trustedNodes: [], autoAcceptSameUser: true });
  makeRemoteBob(ts, { node: { stableId: 'nALICE00002CNTRL', name: 'alice-laptop.example.ts.net', hostname: 'alice-laptop' }, user: { login: SELF_LOGIN, displayName: 'Alice' } });
  const vs2 = viewerFor(t, ts, port);
  vs2.connect();
  assert.equal((await phase(vs2, 'accepted')).via, 'same-user');
  ended = once(host, 'session-end');
  vs2.close();
  await ended;

  // an untrusted peer still gets the password card (hello says autoAccept:false)
  settings.update({ autoAcceptSameUser: false });
  makeRemoteBob(ts);
  const vs3 = viewerFor(t, ts, port);
  vs3.connect();
  const ar = await phase(vs3, 'auth-required');
  assert.equal(ar.remaining, undefined);
  const h2 = await raw(port);
  await waitFor(() => h2.msgs.length === 1);
  assert.equal(h2.msgs[0].auth.autoAccept, false);
  await closeRaw(h2);
});

test('viewer: only hello.auth.autoAccept === true skips the password card', async (t) => {
  for (const [autoAccept, sendsRequest] of [[true, true], ['yes', false], [1, false], [undefined, false]]) {
    const srv = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
    t.after(() => srv.close());
    await once(srv, 'listening');
    const got = [];
    srv.on('connection', (ws) => {
      ws.on('message', (d) => got.push(JSON.parse(String(d))));
      ws.send(JSON.stringify({ t: 'hello', protocol: V, app: 'Tunnelview', version: '1', host: { hostname: 'h', os: 'windows', user: {} }, auth: { passwordSet: true, acceptMode: 'password-only', salt: STORED.salt, kdf: FAST_KDF, nonce: auth.newNonce(), autoAccept } }));
    });
    const vs = viewerFor(t, new FakeTailscale(), srv.address().port);
    const phases = [];
    vs.on('status', (s) => phases.push(s.phase));
    vs.connect();
    await waitFor(() => phases.includes('auth-required') || got.some((m) => m.t === 'request'));
    await new Promise((r) => setTimeout(r, 50));
    const req = got.find((m) => m.t === 'request');
    assert.equal(!!req, sendsRequest, String(autoAccept));
    assert.equal(phases.includes('auth-required'), !sendsRequest, String(autoAccept));
    if (req) assert.equal(req.proof, null);
    vs.close();
  }
});

test("'Always allow' only covers the owner it was granted for, and never a tagged node", async (t) => {
  const { host, ts, settings, port } = await startHost(t, { settings: { trustedNodes: [{ stableId: BOB.node.stableId, name: 'bobs-mac', login: 'bob@example.com', addedAt: 1 }] } });
  settings.quiet = true;
  const requests = [];
  const record = (r) => requests.push(r);
  host.on('request', record);
  const attempt = async ({ final = false } = {}) => {
    const c = await rawRequest(port);
    const done = (m) => (final ? m.t === 'accepted' || m.t === 'denied' : m.t !== 'hello');
    await waitFor(() => c.msgs.some(done));
    const reply = c.msgs.find(done);
    const ended = reply.t === 'accepted' ? once(host, 'session-end') : null;
    await closeRaw(c);
    if (ended) await ended;
    await waitFor(() => !host.hasPending && !host.activeSession);
    return { hello: c.msgs[0], reply };
  };

  makeRemoteBob(ts);
  let r = await attempt();
  assert.equal(r.hello.auth.autoAccept, true);
  assert.equal(r.reply.via, 'trusted');

  // same stableId, new owner → prompt
  makeRemoteBob(ts, { user: { login: 'carol@example.com', displayName: 'Carol' } });
  r = await attempt();
  assert.equal(r.hello.auth.autoAccept, false);
  assert.equal(r.reply.t, 'pending');
  assert.equal(requests.length, 1);

  // the host user re-trusts it for the new owner → the stale entry is replaced
  host.removeListener('request', record);
  host.once('request', (q) => q.respond({ accept: true, trust: true }));
  r = await attempt({ final: true });
  assert.equal(r.reply.via, 'prompt');
  assert.deepEqual(settings.get().trustedNodes.map((n) => [n.stableId, n.login]), [[BOB.node.stableId, 'carol@example.com']]);
  r = await attempt();
  assert.equal(r.reply.via, 'trusted');

  // an entry without a login trusts any owner — but a tagged node is never auto-accepted
  settings.update({ trustedNodes: [{ stableId: BOB.node.stableId, name: 'bobs-mac', addedAt: 1 }] });
  r = await attempt();
  assert.equal(r.reply.via, 'trusted');
  makeRemoteBob(ts, { node: { tags: ['tag:server'] }, user: { login: 'tagged-devices', displayName: 'Tagged Devices' } });
  host.on('request', record);
  r = await attempt();
  assert.equal(r.reply.t, 'pending');
  assert.equal(requests.length, 2);
});

test('waiting for a password ends with denied:auth-timeout (the prompt keeps denied:timeout)', async (t) => {
  const { host, ts, port } = await startHost(t, { settings: { password: STORED, acceptMode: 'password-only' } });
  makeRemoteBob(ts);
  // defaults: 120 s for the first request and for the next password after auth-failed (net2-9)
  assert.equal(host._requestWaitMs, 120e3);
  assert.equal(host._authWaitMs, 120e3);
  host._requestWaitMs = 300;
  host._authWaitMs = 300;
  // the viewer sits on its password card: no request is ever sent
  const a = viewerFor(t, ts, port);
  const ca = once(a, 'closed');
  a.connect();
  await phase(a, 'auth-required');
  const ra = await ca;
  assert.equal(ra.reason, 'denied:auth-timeout');
  assert.equal(ra.message, ViewerSession.DENY_TEXT['auth-timeout']);
  // password-only 'auth' state after a wrong password
  const b = viewerFor(t, ts, port, { password: 'wrong' });
  const cb = once(b, 'closed');
  b.connect();
  assert.equal((await cb).reason, 'denied:auth-timeout');
  assert.equal(PROTOCOL.DENY.AUTH_TIMEOUT, 'auth-timeout');
});

test("the viewer's bye reason reaches session-end (allow-listed reasons only)", async (t) => {
  const { host, ts, port } = await startHost(t);
  host.on('request', (r) => r.respond({ accept: true }));
  for (const [sent, expected] of [['non-tailnet-path', 'non-tailnet-path'], ['media-timeout', 'media-timeout'], ['media-failed', 'media-failed'], ['network', 'network'], ['anything-else', 'viewer-ended']]) {
    const vs = viewerFor(t, ts, port);
    vs.connect();
    const acc = await phase(vs, 'accepted');
    const ended = once(host, 'session-end');
    vs.close(sent);
    assert.deepEqual(await ended, { id: acc.sessionId, reason: expected }, sent);
  }
});

test('password failures count per node and per user (not per IP), with a global cap', async (t) => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  t.after(() => { console.warn = origWarn; });
  const { host, ts, port } = await startHost(t, { settings: { password: STORED } });

  // success resets the node and user counters
  makeRemoteBob(ts);
  host.limiter.fail(`node:${BOB.node.stableId}`);
  host.limiter.fail('login:bob@example.com');
  const ok = viewerFor(t, ts, port, { password: PASSWORD });
  ok.connect();
  assert.equal((await phase(ok, 'accepted')).via, 'password');
  assert.equal(host.limiter.remaining(`node:${BOB.node.stableId}`), 10);
  assert.equal(host.limiter.remaining('login:bob@example.com'), 10);
  const ended = once(host, 'session-end');
  ok.close();
  await ended;

  // Bob's other device shares his user budget: once it is locked, password sign-in is off for
  // every device of bob — but the prompt still works (locks gate only password verification)
  makeRemoteBob(ts, { node: { stableId: 'nBOB0000002CNTRL', name: 'bobs-pc.example.ts.net', hostname: 'bobs-pc' } });
  for (let i = 0; i < 10; i++) host.limiter.fail('login:bob@example.com');
  const requests = [];
  host.on('request', (r) => { requests.push(r); r.respond({ accept: true }); });
  const v1 = viewerFor(t, ts, port, { password: PASSWORD });
  v1.connect();
  assert.equal((await phase(v1, 'accepted')).via, 'prompt');
  assert.equal(requests.length, 1);
  assert.equal(host.limiter.remaining('node:nBOB0000002CNTRL'), 10, 'no proof was verified or counted');
  assert.equal(warns.length, 0);

  // keys: tagged nodes share one 'tagged' budget; no stableId → IP; self only ever its own node
  assert.deepEqual(host._limiterKeys({ ip: '127.0.0.1', ident: { node: { stableId: 'nT', tags: ['tag:ci'] }, user: { login: 'tagged-devices' } } }), ['node:nT', 'tagged']);
  assert.deepEqual(host._limiterKeys({ ip: '127.0.0.5', ident: { node: { stableId: '', tags: [] }, user: { login: '' } } }), ['ip:127.0.0.5']);
  assert.deepEqual(host._limiterKeys({ ip: '127.0.0.5', ident: { node: { stableId: 'nA', tags: [] }, user: { login: 'Bob@Example.com' } } }), ['node:nA', 'login:bob@example.com']);
  assert.deepEqual(host._limiterKeys({ ip: '127.0.0.1', ident: { isSelf: true, node: { stableId: SELF_ID, tags: [] }, user: { login: SELF_LOGIN } } }), [`node:${SELF_ID}`]);
});

/** Raw client that keeps sending a bogus (but well-formed) proof until it is closed. */
async function rawBadPasswords(port) {
  const bogus = Buffer.alloc(32, 7).toString('base64');
  const c = await rawRequest(port, { proof: bogus });
  c.ws.on('message', (d) => {
    const m = JSON.parse(String(d));
    if (m.t === 'auth-failed') c.ws.send(JSON.stringify({ t: 'auth', proof: bogus }));
  });
  await new Promise((r) => (c.ws.readyState === WebSocket.CLOSED ? r() : c.ws.once('close', r)));
  return c.msgs.slice(1); // without hello
}

const tagged = (id) => ({ node: { stableId: id, name: `${id.toLowerCase()}.example.ts.net`, hostname: id, tags: ['tag:ci'] }, user: { login: 'tagged-devices', displayName: 'Tagged Devices' } });

test('all tagged nodes share one failure budget (net2-1)', async (t) => {
  const { host, ts, settings, port } = await startHost(t, { settings: { password: STORED, acceptMode: 'password-only' } });
  settings.quiet = true;
  makeRemoteBob(ts, tagged('nT1'));
  assert.deepEqual((await rawBadPasswords(port)).map((m) => m.reason || m.remaining), [2, 1, 'bad-password']);
  assert.deepEqual((await rawBadPasswords(port)).map((m) => m.reason || m.remaining), [2, 1, 'bad-password']);
  makeRemoteBob(ts, tagged('nT2'));
  assert.deepEqual((await rawBadPasswords(port)).map((m) => m.reason || m.remaining), [2, 1, 'bad-password']);
  // 9 failures so far; a third, fresh tagged identity hits the shared 10th
  makeRemoteBob(ts, tagged('nT3'));
  assert.deepEqual(await rawBadPasswords(port), [{ t: 'denied', reason: 'locked' }]);
  assert.equal(host.limiter.isLocked('tagged'), true);
  assert.equal(host.limiter.remaining('node:nT3'), 9, 'its own node saw a single failure');
  assert.equal(host.globalLimiter.isLocked('*'), false);
  // every tagged node is now locked out of password sign-in …
  makeRemoteBob(ts, tagged('nT4'));
  const h = await raw(port);
  await waitFor(() => h.msgs.length === 1);
  assert.equal(h.msgs[0].auth.passwordLocked, true);
  await closeRaw(h);
  const vs = viewerFor(t, ts, port, { password: PASSWORD });
  vs.connect();
  const c = await once(vs, 'closed');
  assert.equal(c.reason, 'denied:locked');
  assert.equal(c.message, ViewerSession.DENY_TEXT.locked);
  assert.match(c.message, /this device or your Tailscale account/);
  // … an untagged node is not
  makeRemoteBob(ts);
  const ok = viewerFor(t, ts, port, { password: PASSWORD });
  ok.connect();
  assert.equal((await phase(ok, 'accepted')).via, 'password');
});

test('host-wide suspension: fresh identities get suspended; admitted and own devices still sign in (net2-1)', async (t) => {
  const warns = [];
  const origWarn = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  t.after(() => { console.warn = origWarn; });
  const { host, ts, settings, port } = await startHost(t, { settings: { password: STORED, acceptMode: 'password-only' } });
  settings.quiet = true;
  const endAfter = async (vs) => { const e = once(host, 'session-end'); vs.close(); await e; };

  // Bob is admitted once (by password) before the attack
  makeRemoteBob(ts);
  const bob0 = viewerFor(t, ts, port, { password: PASSWORD });
  bob0.connect();
  assert.equal((await phase(bob0, 'accepted')).via, 'password');
  await endAfter(bob0);

  // the 30th failure host-wide (here from a fresh device) trips the suspension
  for (let i = 0; i < 29; i++) host.globalLimiter.fail('*');
  makeRemoteBob(ts, { node: { stableId: 'nCAROL', name: 'carol.example.ts.net' }, user: { login: 'carol@example.com', displayName: 'Carol' } });
  const carol = viewerFor(t, ts, port, { password: 'wrong' });
  carol.connect();
  const cc = await once(carol, 'closed');
  assert.equal(cc.reason, 'denied:suspended');
  assert.equal(cc.message, ViewerSession.DENY_TEXT.suspended);
  assert.equal(host.limiter.isLocked('node:nCAROL'), false, 'not a per-device lock');
  assert.equal(warns.length, 1);
  assert.match(warns[0], /password access suspended/);

  // a fresh identity, even with the right password, is told about the suspension right away
  makeRemoteBob(ts, { node: { stableId: 'nDAVE', name: 'dave.example.ts.net' }, user: { login: 'dave@example.com', displayName: 'Dave' } });
  const h = await raw(port);
  await waitFor(() => h.msgs.length === 1);
  assert.equal(h.msgs[0].auth.passwordLocked, true);
  await closeRaw(h);
  const dave = viewerFor(t, ts, port, { password: PASSWORD });
  dave.connect();
  assert.equal((await once(dave, 'closed')).reason, 'denied:suspended');
  // a proof sent anyway is ignored (not counted), the answer is the same
  const raw1 = await rawRequest(port, { proof: Buffer.alloc(32, 9).toString('base64') });
  await waitFor(() => raw1.msgs.length === 2);
  assert.deepEqual(raw1.msgs[1], { t: 'denied', reason: 'suspended' });
  assert.equal(host.limiter.remaining('node:nDAVE'), 10);

  // a device admitted before is exempt …
  makeRemoteBob(ts);
  const bob = viewerFor(t, ts, port, { password: PASSWORD });
  bob.connect();
  assert.equal((await phase(bob, 'accepted')).via, 'password');
  await endAfter(bob);
  // … as is another (untagged) device of the host's own user
  makeRemoteBob(ts, { node: { stableId: 'nALICE00002CNTRL', name: 'alice-laptop.example.ts.net', hostname: 'alice-laptop' }, user: { login: SELF_LOGIN, displayName: 'Alice' } });
  const own = viewerFor(t, ts, port, { password: PASSWORD });
  own.connect();
  assert.equal((await phase(own, 'accepted')).via, 'password');
  await endAfter(own);
  // … but the same stableId under another owner is a fresh identity
  makeRemoteBob(ts, { user: { login: 'mallory@example.com', displayName: 'Mallory' } });
  const stolen = viewerFor(t, ts, port, { password: PASSWORD });
  stolen.connect();
  assert.equal((await once(stolen, 'closed')).reason, 'denied:suspended');
  // self is never exempt, but still gets its prompt
  makeSelfAgain(ts);
  host.on('request', (r) => r.respond({ accept: true }));
  const self = viewerFor(t, ts, port, { password: PASSWORD });
  self.connect();
  assert.equal((await phase(self, 'accepted')).via, 'self');
  assert.equal(warns.length, 1);
});

test('locks gate only password verification: trusted, prompt and auth-while-pending (net2-2)', async (t) => {
  const trusted = [{ stableId: BOB.node.stableId, name: 'bobs-mac', login: 'bob@example.com', addedAt: 1 }];
  const { host, ts, settings, port } = await startHost(t, { settings: { password: STORED, acceptMode: 'password-only', trustedNodes: trusted } });
  settings.quiet = true;
  for (let i = 0; i < 30; i++) host.globalLimiter.fail('*');
  assert.equal(host.globalLimiter.isLocked('*'), true);

  // a trusted node that sends a proof anyway (e.g. an older viewer): ignored, admitted as trusted
  makeRemoteBob(ts);
  const r1 = await rawRequest(port, { proof: Buffer.alloc(32, 3).toString('base64') });
  await waitFor(() => r1.msgs.length >= 2);
  assert.deepEqual(r1.msgs.slice(1).map((m) => m.t), ['accepted']);
  assert.equal(r1.msgs[1].via, 'trusted');
  assert.equal(r1.msgs[0].auth.passwordLocked, true);
  let ended = once(host, 'session-end');
  await closeRaw(r1);
  await ended;
  assert.equal(host.limiter.remaining(`node:${BOB.node.stableId}`), 10, 'the proof was not verified or counted');
  // a trusted node whose viewer still remembers the password: no proof, admitted as trusted
  host._goodIds.clear(); // (bob's admission just now would exempt him from the suspension)
  const phases = [];
  const vs = viewerFor(t, ts, port, { password: PASSWORD });
  vs.on('status', (s) => phases.push(s.phase));
  vs.connect();
  assert.equal((await phase(vs, 'accepted')).via, 'trusted');
  assert.equal(phases.includes('auth-required'), false);
  ended = once(host, 'session-end');
  vs.close();
  await ended;

  // ask mode: a viewer with a saved password during a per-node lock gets the prompt ('pending')
  settings.update({ acceptMode: 'ask', trustedNodes: [] });
  host.globalLimiter.reset('*');
  for (let i = 0; i < 10; i++) host.limiter.fail(`node:${BOB.node.stableId}`);
  const requests = [];
  host.on('request', (r) => requests.push(r));
  const r2 = await rawRequest(port, { proof: Buffer.alloc(32, 4).toString('base64') });
  await waitFor(() => r2.msgs.length === 2);
  assert.deepEqual(r2.msgs[1], { t: 'pending' });
  // 'auth' while the prompt shows is ignored under the lock: no denial, the prompt stays up
  r2.ws.send(JSON.stringify({ t: 'auth', proof: Buffer.alloc(32, 5).toString('base64') }));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(r2.msgs.length, 2);
  assert.equal(host.hasPending, true);
  assert.equal(requests[0].respond({ accept: true }), true);
  await waitFor(() => r2.msgs.length === 3);
  assert.equal(r2.msgs[2].via, 'prompt');
  ended = once(host, 'session-end');
  await closeRaw(r2);
  await ended;
  assert.equal(host.globalLimiter.remaining('*'), 30, 'ignored proofs are never counted');

  // password-only: a request that needs the password is refused 'locked' (per-node lock) …
  settings.update({ acceptMode: 'password-only' });
  const v2 = viewerFor(t, ts, port, { password: PASSWORD });
  v2.connect();
  const c2 = await once(v2, 'closed');
  assert.equal(c2.reason, 'denied:locked');
  assert.equal(c2.proofSent, false, 'the remembered password was never tried (net3-4)');
  // … and 'auth' after auth-failed is refused once a lock applies (a fresh identity: bob was
  // admitted above, which exempts him from the host-wide suspension)
  makeRemoteBob(ts, { node: { stableId: 'nEVE', name: 'eve.example.ts.net' }, user: { login: 'eve@example.com', displayName: 'Eve' } });
  const r3 = await rawRequest(port, { proof: Buffer.alloc(32, 6).toString('base64') });
  await waitFor(() => r3.msgs.length === 2);
  assert.deepEqual(r3.msgs[1], { t: 'auth-failed', remaining: 2 });
  for (let i = 0; i < 30; i++) host.globalLimiter.fail('*');
  r3.ws.send(JSON.stringify({ t: 'auth', proof: Buffer.alloc(32, 6).toString('base64') }));
  await waitFor(() => r3.msgs.length === 3);
  assert.deepEqual(r3.msgs[2], { t: 'denied', reason: 'suspended' });
});

test('two unanswered connections per node; a full table evicts the busiest node\'s oldest idle hello (net2-3)', async (t) => {
  if (!(await loopbackAliasWorks())) return t.skip('127.0.0.x source addresses unavailable on this OS');
  const attackers = ['127.0.0.2', '127.0.0.3', '127.0.0.4', '127.0.0.5', '127.0.0.6', '127.0.0.7', '127.0.0.8', '127.0.0.9'];
  const whois = {};
  attackers.forEach((ip, i) => {
    whois[ip] = { node: { id: String(20 + i), stableId: `nATK${i}`, name: `atk-${i}.example.ts.net`, hostname: `atk-${i}`, os: 'linux', ips: [ip], tags: ['tag:x'] }, user: { id: '9', login: 'tagged-devices', displayName: 'Tagged Devices' }, isSelf: false };
  });
  whois['127.0.0.10'] = structuredClone(whois['127.0.0.2']); // the same node's second (v6-like) address
  const ts = new FakeTailscale({ tailnet: ['127.0.0.1', ...attackers, '127.0.0.10'], whois });
  const { host, port } = await startHost(t, { ts });
  const opened = [];
  t.after(() => opened.forEach((c) => c.ws.terminate()));
  const open = async (localAddress) => {
    const c = await raw(port, { localAddress });
    if (c.ws) {
      opened.push(c);
      await waitFor(() => c.msgs.length >= 1);
    }
    return c;
  };

  // one node may hold 2 connections that never send `request`; a 3rd gets 503 on any of its IPs
  assert.ok((await open('127.0.0.2')).ws);
  assert.ok((await open('127.0.0.2')).ws);
  assert.equal((await open('127.0.0.2')).status, 503);
  assert.equal((await open('127.0.0.10')).status, 503, 'both addresses of a node share the cap');

  // 7 more nodes × 2 → all 16 slots are held by idle hellos
  for (const ip of attackers.slice(1)) for (let i = 0; i < 2; i++) assert.ok((await open(ip)).ws, ip);
  assert.equal(host._conns.size, 16);

  // a legitimate viewer still reaches hello and a prompt: the oldest idle hello made room
  const requests = [];
  host.on('request', (r) => requests.push(r));
  const vs = viewerFor(t, ts, port);
  vs.connect();
  await phase(vs, 'waiting');
  assert.equal(requests.length, 1);
  await waitFor(() => opened[0].msgs.length === 2);
  assert.deepEqual(opened[0].msgs[1], { t: 'denied', reason: 'busy' });
  assert.equal(opened.slice(1).some((c) => c.msgs.length > 1), false, 'exactly one connection was evicted');
  // the active prompt holder is never evicted: with the table full again, an idle hello goes
  await waitFor(() => host._conns.size === 16);
  assert.ok((await open('127.0.0.2')).ws, 'nATK0 is down to one unanswered connection');
  await waitFor(() => opened[1].msgs.length === 2 || opened[2].msgs.length === 2);
  assert.equal(host.hasPending, true);
  assert.equal(vs.phase, 'waiting');
});

test('eviction picks the node with the most unanswered connections (hello or auth), never active or pending', () => {
  const host = new HostServer({ tailscale: new FakeTailscale(), settings: new FakeSettings(), auth, appVersion: '0', osName: 'windows' });
  const mk = (id, state) => ({ ip: `ip-${id}`, state, closed: false, ident: { node: { stableId: id } } });
  const a1 = mk('nA', 'hello');
  const b1 = mk('nB', 'auth');
  const b2 = mk('nB', 'hello');
  const b3 = mk('nB', 'pending');
  const c1 = mk('nC', 'active');
  for (const c of [a1, b1, b2, b3, c1]) host._conns.add(c);
  host._pending = b3;
  host._session = c1;
  assert.equal(host._evictionVictim(), b1, 'nB holds 3 unanswered; its oldest one waiting for a password (net3-3)');
  b1.state = 'closing';
  assert.equal(host._evictionVictim(), b2, 'nB still holds 2; then its hello');
  b2.state = 'closing';
  assert.equal(host._evictionVictim(), a1, 'tie at 1: the node whose oldest candidate is older (nB has none)');
  a1.state = 'closing';
  assert.equal(host._evictionVictim(), null, 'only the pending prompt and the session are left → 503');
  // a closed connection never counts
  const d1 = mk('nD', 'auth');
  d1.closed = true;
  host._conns.add(d1);
  assert.equal(host._evictionVictim(), null);
});

test('a full table of bad-proof (auth) connections evicts the busiest node\'s oldest auth, not a lone hello (net3-3)', () => {
  const host = new HostServer({ tailscale: new FakeTailscale(), settings: new FakeSettings(), auth, appVersion: '0', osName: 'windows' });
  const sent = new Map();
  const mk = (id, state, ip) => {
    const c = { ip, state, closed: false, ident: { node: { stableId: id } }, ws: { readyState: WebSocket.OPEN, send: (s) => sent.set(c, JSON.parse(s)), close() {}, terminate() {} } };
    host._conns.add(c);
    return c;
  };
  const legit = mk('nLEGIT', 'hello', '127.0.0.50'); // the owner's viewer on its password card
  const attackers = [];
  for (let i = 0; i < 7; i++) for (let j = 0; j < 2; j++) attackers.push(mk(`nATK${i}`, 'auth', `127.0.1.${i}`));
  attackers.push(mk('nATK7', 'auth', '127.0.1.7')); // 15 'auth' in total
  assert.equal(host._conns.size, 16);
  const newcomer = { node: { stableId: 'nOWNER' } };
  assert.equal(host._makeRoom('127.0.0.60', newcomer), true);
  assert.deepEqual(sent.get(attackers[0]), { t: 'denied', reason: 'busy' }, "the oldest 'auth' of a node holding 2");
  assert.equal(attackers[0].state, 'closing');
  assert.equal(sent.size, 1, 'exactly one connection was evicted');
  assert.equal(sent.has(legit), false, 'the lone hello stays');
  // the evicted slot is free at once (closing connections do not count) …
  assert.equal(host._makeRoom('127.0.0.60', newcomer), true);
  assert.equal(sent.size, 1);
  // … the newcomer takes it; the next one evicts the next 2-connection node's oldest, never the
  // legitimate viewer
  mk('nOWNER', 'hello', '127.0.0.60');
  assert.equal(host._makeRoom('127.0.0.61', { node: { stableId: 'nOWNER2' } }), true);
  assert.deepEqual(sent.get(attackers[2]), { t: 'denied', reason: 'busy' });
  assert.equal(sent.has(legit), false);
});

test('a malformed upgrade on a full table is refused (400 / 405) and evicts nobody (net3-3)', async (t) => {
  const { host, port } = await startHost(t);
  // 8 other nodes × 2 idle hellos fill the table (fake connections: no loopback aliases needed)
  const sent = [];
  const fakes = [];
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 2; j++) {
      const c = { id: `f${i}${j}`, ip: `127.0.2.${i}`, state: 'hello', closed: false, ident: { node: { stableId: `nIDLE${i}` } }, timer: null, killTimer: null };
      c.ws = { readyState: WebSocket.OPEN, send: (s) => sent.push([c.id, JSON.parse(s)]), close() {}, terminate() {}, ping() {} };
      fakes.push(c);
      host._conns.add(c);
    }
  }
  t.after(() => fakes.forEach((c) => { clearTimeout(c.killTimer); host._conns.delete(c); }));
  const upgrade = (lines) => new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port }, () => s.write(`${lines.join('\r\n')}\r\n\r\n`));
    let data = '';
    s.on('data', (d) => { data += d; });
    s.on('error', () => {});
    s.on('close', () => resolve(data.split('\r\n')[0]));
  });
  const base = (over = {}) => {
    const h = { Host: `127.0.0.1:${port}`, Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', [PROTOCOL.PROTOCOL_HEADER]: String(V), ...over };
    return Object.entries(h).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`);
  };
  for (const [what, lines, status] of [
    ['bad key', [`GET ${PROTOCOL.WS_PATH} HTTP/1.1`, ...base({ 'Sec-WebSocket-Key': 'not-a-key' })], 400],
    ['no key', [`GET ${PROTOCOL.WS_PATH} HTTP/1.1`, ...base({ 'Sec-WebSocket-Key': null })], 400],
    ['bad version', [`GET ${PROTOCOL.WS_PATH} HTTP/1.1`, ...base({ 'Sec-WebSocket-Version': '12' })], 400],
    ['not websocket', [`GET ${PROTOCOL.WS_PATH} HTTP/1.1`, ...base({ Upgrade: 'h2c' })], 400],
    ['subprotocol offer', [`GET ${PROTOCOL.WS_PATH} HTTP/1.1`, ...base({ 'Sec-WebSocket-Protocol': 'chat' })], 400],
    ['POST', [`POST ${PROTOCOL.WS_PATH} HTTP/1.1`, ...base(), 'Content-Length: 0'], 405],
  ]) {
    assert.match(await upgrade(lines), new RegExp(`^HTTP/1\\.1 ${status} `), what);
    assert.deepEqual(sent, [], `${what}: nobody was evicted`);
  }
  // a well-formed upgrade still makes room: exactly one idle hello is denied 'busy'
  const ok = await raw(port);
  assert.ok(ok.ws);
  await waitFor(() => ok.msgs.length === 1);
  assert.equal(ok.msgs[0].t, 'hello');
  assert.deepEqual(sent, [['f00', { t: 'denied', reason: 'busy' }]]);
  await closeRaw(ok);
});

test("admission without a prompt withdraws a stranger's pending prompt; prompts still get busy (net3-2)", async (t) => {
  const trusted = [{ stableId: BOB.node.stableId, name: 'bobs-mac', login: 'bob@example.com', addedAt: 1 }];
  const { host, ts, settings, port } = await startHost(t, { settings: { password: STORED, trustedNodes: trusted } });
  settings.quiet = true;
  const requests = [];
  const cancels = [];
  host.on('request', (r) => requests.push(r));
  host.on('request-cancelled', (id) => cancels.push(id));
  const stranger = (n) => makeRemoteBob(ts, { node: { stableId: `nSTRANGER${n}`, name: `stranger-${n}.example.ts.net`, hostname: `stranger-${n}` }, user: { login: `stranger${n}@example.com`, displayName: `Stranger ${n}` } });
  const reply = async (c, n) => { await waitFor(() => c.msgs.length >= n); return c.msgs[n - 1]; };

  // stranger A's prompt is showing (nobody answers it)
  stranger(1);
  const a = await rawRequest(port);
  assert.deepEqual(await reply(a, 2), { t: 'pending' });
  // stranger C, who needs a prompt too, is still busy — without using up a prompt of its own
  stranger(2);
  const c = await rawRequest(port);
  assert.deepEqual(await reply(c, 2), { t: 'denied', reason: 'busy' });
  assert.equal(host._promptLog.has('node:nSTRANGER2'), false);
  assert.equal(requests.length, 1);
  assert.deepEqual(cancels, []);
  assert.equal(host.hasPending, true);

  // trusted node B: admitted right away; A's prompt is withdrawn ('busy' + request-cancelled)
  makeRemoteBob(ts);
  const b = await rawRequest(port);
  const accepted = await reply(b, 2);
  assert.equal(accepted.t, 'accepted');
  assert.equal(accepted.via, 'trusted');
  assert.deepEqual(await reply(a, 3), { t: 'denied', reason: 'busy' });
  assert.deepEqual(cancels, [requests[0].requestId]);
  assert.equal(requests[0].respond({ accept: true }), false, 'a withdrawn prompt cannot be accepted');
  assert.equal(host._cooldown.size, 0, 'withdrawing records no back-off');
  assert.equal(host.hasPending, false);
  // while a session is active everyone is busy, trusted devices included
  makeRemoteBob(ts, { node: { stableId: 'nBOB0000002CNTRL' } });
  settings.s.trustedNodes.push({ stableId: 'nBOB0000002CNTRL', name: 'bobs-pc', login: 'bob@example.com', addedAt: 1 });
  const busy = await rawRequest(port);
  assert.deepEqual(await reply(busy, 2), { t: 'denied', reason: 'busy' });
  const ended = once(host, 'session-end');
  await closeRaw(b);
  await ended;
  await waitFor(() => host._conns.size === 0);

  // the same with the correct password
  stranger(3);
  const a2 = await rawRequest(port);
  assert.deepEqual(await reply(a2, 2), { t: 'pending' });
  makeRemoteBob(ts, { node: { stableId: 'nCAROL', name: 'carol.example.ts.net', hostname: 'carol' }, user: { login: 'carol@example.com', displayName: 'Carol' } });
  const owner = viewerFor(t, ts, port, { password: PASSWORD });
  owner.connect();
  assert.equal((await phase(owner, 'accepted')).via, 'password');
  assert.deepEqual(await reply(a2, 3), { t: 'denied', reason: 'busy' });
  assert.deepEqual(cancels, [requests[0].requestId, requests[1].requestId]);
  assert.equal(requests.length, 2);
});

test('idle raw TCP sockets: 4 per source IP until the upgrade, dropped when idle; others still get in (net3-1)', async (t) => {
  const alias = await loopbackAliasWorks();
  // with loopback aliases the idle sockets come from another address than the viewer (as in the
  // attack); without (macOS) from the viewer's own 127.0.0.1
  const src = alias ? '127.0.0.2' : '127.0.0.1';
  const ts = new FakeTailscale({ tailnet: ['127.0.0.1', '127.0.0.2'], whois: { '127.0.0.2': BOB } });
  const { host, port } = await startHost(t, { ts });
  host._preUpgradeIdleMs = 2500;
  const socks = [];
  let closed = 0;
  t.after(() => socks.forEach((s) => s.destroy()));
  for (let i = 0; i < 64; i++) {
    const s = net.connect({ host: '127.0.0.1', port, localAddress: src });
    s.on('error', () => {});
    s.on('close', () => { closed++; });
    socks.push(s);
  }
  // all but 4 are dropped at once, before the HTTP layer
  await waitFor(() => closed >= 60, 2000);
  assert.equal(closed, 60);
  assert.equal(host._preUpgrade.get(src), 4);

  if (alias) {
    // the 4 idle sockets of 127.0.0.2 do not keep anyone else out
    assert.equal((await getJson(port, PROTOCOL.INFO_PATH)).status, 200);
    const vs = viewerFor(t, ts, port);
    vs.connect();
    await phase(vs, 'hello');
    assert.equal(host._preUpgrade.get(src), 4, 'still held');
  }

  // the idle ones are dropped after the idle timeout; nothing stays counted
  await waitFor(() => closed === 64, 6000);
  await waitFor(() => !host._preUpgrade.has(src));
  // … and the address gets in again; an upgraded socket no longer counts as pre-upgrade
  host._preUpgradeIdleMs = 300;
  const again = await raw(port, { localAddress: src });
  assert.ok(again.ws, `upgrade refused (${again.status})`);
  await waitFor(() => again.msgs.length === 1);
  assert.equal(again.msgs[0].t, 'hello');
  assert.equal(host._preUpgrade.has(src), false);
  await new Promise((r) => setTimeout(r, 700));
  assert.equal(again.ws.readyState, WebSocket.OPEN, 'the idle timeout ends at the hand-off to ws');
  await closeRaw(again);
  const vs2 = viewerFor(t, ts, port);
  vs2.connect();
  await phase(vs2, 'hello');
});

test('viewer: nothing is sent unless the socket runs over one of its own Tailscale IPs (net2-5)', async (t) => {
  const srv = new WebSocket.Server({ port: 0, host: '127.0.0.1' });
  t.after(() => srv.close());
  await once(srv, 'listening');
  const got = [];
  srv.on('connection', (ws) => {
    ws.on('message', (d) => got.push(JSON.parse(String(d))));
    ws.send(JSON.stringify({ t: 'hello', protocol: V, app: 'Tunnelview', version: '1', host: { hostname: 'h', os: 'windows', user: {} }, auth: { passwordSet: true, acceptMode: 'ask', salt: STORED.salt, kdf: FAST_KDF, nonce: auth.newNonce() } }));
  });
  // 127.0.0.1 is a peer in `tailscale status`, but the local address the OS picked (127.0.0.1) is
  // not one of our own Tailscale IPs — e.g. the tailnet range is routed over another interface
  const ts = new FakeTailscale({ selfIps: ['127.0.0.9'], peers: [{ stableId: 'nHOST', ips: ['127.0.0.1'] }] });
  const vs = viewerFor(t, ts, srv.address().port, { password: PASSWORD });
  vs.connect();
  const c = await once(vs, 'closed');
  assert.equal(c.reason, 'not-tailnet-route', "the target is a valid peer: not 'not-tailnet' (contracts3-2)");
  assert.equal(c.message, 'The connection did not go through Tailscale (local address 127.0.0.1), so Tunnelview stopped before sending anything.');
  assert.equal(c.proofSent, false);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(got, [], 'no request, hostname or proof was sent');
  assert.equal(vs.closedEvents.length, 1);

  // the rule itself: own Tailscale IP of the dialed IP's family
  const v = new ViewerSession({ tailscale: viewerTs(new FakeTailscale()), auth, target: { ip: '127.0.0.1', port: 1 } });
  v._selfIps = ['100.64.0.2', 'fd7a:115c:a1e0::2'];
  v._dialIp = '100.64.0.1';
  for (const [local, ok] of [['100.64.0.2', true], ['fd7a:115c:a1e0::2', false], ['100.64.0.3', false], ['192.168.1.5', false], [null, false]]) {
    v._localIp = local;
    assert.equal(v._localPathOk(), ok, String(local));
  }
  v._dialIp = 'fd7a:115c:a1e0::1';
  v._localIp = 'fd7a:115c:a1e0::2';
  assert.equal(v._localPathOk(), true);
});

test("a tagged peer is never saved as 'Always allow'; request and session peers carry tags (net2-10)", async (t) => {
  const { host, ts, settings, port } = await startHost(t);
  settings.quiet = true;
  makeRemoteBob(ts, { node: { tags: ['tag:server', 'tag:prod'] }, user: { login: 'tagged-devices', displayName: 'Tagged Devices' } });
  const requests = [];
  host.on('request', (r) => { requests.push(r); r.respond({ accept: true, trust: true }); });
  const started = once(host, 'session-start');
  const c = await rawRequest(port);
  await waitFor(() => c.msgs.some((m) => m.t === 'accepted'));
  assert.deepEqual(requests[0].peer.tags, ['tag:server', 'tag:prod']);
  assert.deepEqual((await started).peer.tags, ['tag:server', 'tag:prod']);
  assert.deepEqual(settings.get().trustedNodes, [], 'nothing saved');
  let ended = once(host, 'session-end');
  await closeRaw(c);
  await ended;
  // the next request still prompts
  const c2 = await rawRequest(port);
  await waitFor(() => c2.msgs.some((m) => m.t === 'accepted'));
  assert.equal(requests.length, 2);
  assert.equal(c2.msgs.find((m) => m.t === 'accepted').via, 'prompt');
  ended = once(host, 'session-end');
  await closeRaw(c2);
  await ended;
  // tags are cleaned and capped; an untagged peer reports [] and can be trusted
  makeRemoteBob(ts, { node: { tags: ['tag:a‮', `tag:${'x'.repeat(100)}`, ...Array.from({ length: 10 }, (_, i) => `tag:t${i}`)] } });
  const c3 = await rawRequest(port);
  await waitFor(() => c3.msgs.some((m) => m.t === 'accepted'));
  const tags = requests[2].peer.tags;
  assert.equal(tags.length, 8);
  assert.equal(tags[0], 'tag:a');
  assert.equal(tags[1].length, 64);
  ended = once(host, 'session-end');
  await closeRaw(c3);
  await ended;
  makeRemoteBob(ts);
  const c4 = await rawRequest(port);
  await waitFor(() => c4.msgs.some((m) => m.t === 'accepted'));
  assert.deepEqual(requests[3].peer.tags, []);
  assert.deepEqual(settings.get().trustedNodes.map((n) => n.stableId), [BOB.node.stableId]);
  await closeRaw(c4);
  // a 'tagged-devices' owner without tags (defensive) is refused as well
  host._trustPeer({ isSelf: false, stableId: 'nZ', hostname: 'z', tags: [], user: { login: 'tagged-devices' } });
  assert.deepEqual(settings.get().trustedNodes.map((n) => n.stableId), [BOB.node.stableId]);
});

test('viewer: closed payloads say whether a password proof was sent; HTTP 429 is rate-limited (net3-4)', async (t) => {
  assert.deepEqual(ViewerSession.mapHttpStatus(429), ['rate-limited', 'Too many connection attempts from this device. Try again in a minute.']);
  const { host, ts, settings, port } = await startHost(t, { settings: { password: STORED, acceptMode: 'password-only' } });
  settings.quiet = true;
  makeRemoteBob(ts);

  // a remembered wrong password that trips the per-node lock: that proof was sent
  for (let i = 0; i < 9; i++) host.limiter.fail(`node:${BOB.node.stableId}`);
  const a = viewerFor(t, ts, port, { password: 'wrong' });
  const aStatus = once(a, 'status', { filter: (s) => s.phase === 'closed' });
  a.connect();
  const ca = await once(a, 'closed');
  assert.equal(ca.reason, 'denied:locked');
  assert.equal(ca.proofSent, true);
  assert.equal((await aStatus).proofSent, true, "the 'status' closed event carries it too");

  // now locked (hello.auth.passwordLocked): the remembered password is not sent at all
  const b = viewerFor(t, ts, port, { password: PASSWORD });
  b.connect();
  const cb = await once(b, 'closed');
  assert.equal(cb.reason, 'denied:locked');
  assert.equal(cb.proofSent, false);

  // a proof typed while the prompt shows goes out as an `auth` message
  settings.update({ acceptMode: 'ask' });
  makeSelfAgain(ts);
  let req;
  host.on('request', (r) => { req = r; });
  const c = viewerFor(t, ts, port);
  c.connect();
  await phase(c, 'waiting');
  const failed = once(c, 'status', { filter: (s) => s.phase === 'auth-required' && s.remaining === 2 });
  assert.deepEqual(await c.submitPassword('also-wrong'), { ok: true });
  await failed;
  req.respond({ accept: false });
  const cc = await once(c, 'closed');
  assert.equal(cc.reason, 'denied:rejected');
  assert.equal(cc.proofSent, true);

  // no password involved at all
  const d = viewerFor(t, ts, port);
  d.connect();
  const cd = await once(d, 'closed');
  assert.equal(cd.reason, 'denied:try-later');
  assert.equal(cd.proofSent, false);

  // the host's upgrade rate limit (20 per minute per source IP) is not a password lock
  host._rate.set('ws|127.0.0.1', Array(20).fill(Date.now()));
  const e = viewerFor(t, ts, port, { password: PASSWORD });
  e.connect();
  const ce = await once(e, 'closed');
  assert.equal(ce.reason, 'rate-limited');
  assert.equal(ce.message, 'Too many connection attempts from this device. Try again in a minute.');
  assert.equal(ce.proofSent, false);
});
