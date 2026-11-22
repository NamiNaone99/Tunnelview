'use strict';
/*
 * The REAL HostServer over loopback, for the phone app's interop test.
 * mobile/test/interop_real_host_test.dart starts this file with node and talks to it with the
 * app's real transport (dart:io), pairing flow and session state machine, so the Dart client is
 * checked against the host's actual upgrade checks, hello signature, pair handling, admission and
 * signal validation, not against a fake written by the same hand.
 *
 * Nothing here touches the real Tailscale or the network beyond 127.0.0.1: FakeTailscale declares
 * which addresses count as tailnet IPs. The host listens on 127.0.0.1 and sees the phone at
 * 127.0.0.2 (the Dart test maps the link's Tailscale address and the phone's own one onto these).
 * The process exits when stdin closes, on {cmd:'stop'}, or after LIFETIME_MS.
 *
 * One JSON object per line.
 *   stdout  {event:'ready', port, hostId, phoneId, linkAddress, phoneAddress, fingerprint}
 *           {event:'offer', link} {event:'request', requestId, peer, viewer}
 *           {event:'session-start', id, via, permissions} {event:'session-signal', msg}
 *           {event:'session-end', id, reason} {event:'pairing', ...} {event:'request-cancelled'}
 *           {event:'signal-sent', ok} {event:'done', cmd}
 *   stdin   {cmd:'offer'}                         start a pairing offer
 *           {cmd:'respond', accept, permissions}  answer the pending prompt
 *           {cmd:'signal', msg}                   panel → viewer (sdp / ice)
 *           {cmd:'permissions', permissions}      change the session's permissions
 *           {cmd:'settings', patch}               settings.update(patch)
 *           {cmd:'password', value}               set (string) or clear (null) the password
 *           {cmd:'end', reason}                   end the session from the host
 *           {cmd:'stop'}
 * Not a test file itself (no *.test.js name).
 */
const crypto = require('crypto');
const readline = require('readline');
const HostServer = require('../../src/main/host-server');
const auth = require('../../src/main/auth');
const pairing = require('../../src/main/pairing');
const { FakeTailscale, FakeSettings } = require('./fake-tailscale');

const LIFETIME_MS = 120000;
const HOST_LOOPBACK = '127.0.0.1';
const PHONE_LOOPBACK = '127.0.0.2';
// What the link carries and what the phone calls its own address: real Tailscale-range literals,
// because the phone refuses to dial or bind anything else.
const LINK_ADDRESS = '100.64.0.1';
const PHONE_ADDRESS = '100.64.1.2';
const PHONE_ID = 'nPHONEp1x2CNTRL';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
function keyFromSeed(byte) {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.alloc(32, byte)]), format: 'der', type: 'pkcs8' });
  return { privateKey, pub: crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12) };
}

/** identity.js's interface over a fixed key. */
function fixedIdentity(key) {
  return {
    unavailable: false,
    error: null,
    wasReset: false,
    publicKeyRaw: () => Buffer.from(key.pub),
    publicKeyB64url: () => Buffer.from(key.pub).toString('base64url'),
    fingerprint: () => pairing.fingerprint(key.pub),
    sign: (bytes) => crypto.sign(null, bytes, key.privateKey),
  };
}

const out = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`);

async function main() {
  const key = keyFromSeed(0x21);
  const ts = new FakeTailscale({
    selfIps: [HOST_LOOPBACK],
    // The candidate filter (sendSignal / session-signal) asks isTailscaleIp about the addresses
    // inside ICE candidates: the two Tailscale-range literals count as well.
    tailnet: [HOST_LOOPBACK, PHONE_LOOPBACK, LINK_ADDRESS, PHONE_ADDRESS],
    whois: {
      [PHONE_LOOPBACK]: {
        node: { id: '9', stableId: PHONE_ID, name: 'pixel.example.ts.net', hostname: 'pixel', os: 'android', ips: [PHONE_LOOPBACK], tags: [] },
        user: { id: '1002', login: 'bob@example.com', displayName: 'Bob' },
        isSelf: false,
      },
    },
  });
  const settings = new FakeSettings();
  const host = new HostServer({ tailscale: ts, settings, auth, appVersion: '0.3.0-interop', osName: 'windows', identity: fixedIdentity(key) });
  host._linkAddress = (ip) => (ip === HOST_LOOPBACK ? LINK_ADDRESS : ip);
  await host.start();
  const st = host.status();
  if (!st.listening) throw new Error(`host not listening: ${st.error}`);

  let pending = null;
  host.on('request', (req) => {
    pending = req;
    out({ event: 'request', requestId: req.requestId, peer: { ip: req.peer.ip, stableId: req.peer.stableId, hostname: req.peer.hostname, isSelf: req.peer.isSelf }, viewer: req.viewer });
  });
  host.on('request-cancelled', (requestId) => out({ event: 'request-cancelled', requestId }));
  host.on('session-start', (s) => out({ event: 'session-start', id: s.id, via: s.via, permissions: s.permissions, viewer: s.viewer }));
  host.on('session-signal', (msg) => out({ event: 'session-signal', msg }));
  host.on('session-end', (e) => out({ event: 'session-end', id: e.id, reason: e.reason }));
  host.on('pairing', (e) => out({ event: 'pairing', ...e }));

  const stop = async () => {
    try { await host.stop(); } catch { /* exiting anyway */ }
    process.exit(0);
  };
  const lifetime = setTimeout(stop, LIFETIME_MS);
  lifetime.unref();

  const handlers = {
    offer() { out({ event: 'offer', link: host.startPairing().link }); },
    respond(c) {
      const req = pending;
      pending = null;
      out({ event: 'done', cmd: 'respond', ok: !!req && req.respond({ accept: c.accept === true, permissions: c.permissions }) });
    },
    signal(c) { out({ event: 'signal-sent', ok: host.sendSignal(c.msg) }); },
    permissions(c) { out({ event: 'done', cmd: 'permissions', result: host.setPermissions(c.permissions) }); },
    settings(c) { settings.update(c.patch); out({ event: 'done', cmd: 'settings' }); },
    async password(c) {
      settings.update({ password: typeof c.value === 'string' ? await auth.hashPassword(c.value) : null });
      out({ event: 'done', cmd: 'password' });
    },
    end(c) { out({ event: 'done', cmd: 'end', ok: host.endSession(c.reason) }); },
    stop,
  };

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let c;
    try { c = JSON.parse(line); } catch { return; }
    const h = c && typeof c.cmd === 'string' && Object.prototype.hasOwnProperty.call(handlers, c.cmd) ? handlers[c.cmd] : null;
    if (!h) return;
    Promise.resolve().then(() => h(c)).catch((e) => out({ event: 'error', cmd: c.cmd, code: (e && e.code) || '', message: String((e && e.message) || e) }));
  });
  rl.on('close', stop);

  out({
    event: 'ready', port: st.port, hostId: ts.selfId, phoneId: PHONE_ID,
    linkAddress: LINK_ADDRESS, phoneAddress: PHONE_ADDRESS, fingerprint: pairing.fingerprint(key.pub),
  });
}

main().catch((e) => {
  out({ event: 'fatal', message: String((e && e.message) || e) });
  process.exit(1);
});
