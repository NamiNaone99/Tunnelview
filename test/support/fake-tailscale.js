'use strict';
/*
 * A fake tailnet over 127.0.0.x for tests that run the real HostServer / ViewerSession
 * (test/signaling.test.js, and later the pairing tests and the mobile interop host).
 * Nothing here touches the real Tailscale: FakeTailscale declares which loopback addresses count
 * as tailnet IPs and answers `status` / `whois` from fixed data. FakeSettings is the settings store
 * a HostServer reads; it lives here because the two are only ever used together.
 * Not a test file itself: it has no *.test.js name, so `npm test` only loads it through require().
 */
const net = require('net');
const { EventEmitter } = require('events');
const { normalizeIp } = require('../../src/main/tailscale');

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

module.exports = {
  SELF_LOGIN,
  SELF_ID,
  FakeTailscale,
  FakeSettings,
  BOB,
  makeRemoteBob,
  makeSelfAgain,
  viewerTs,
  loopbackAliasWorks,
};
