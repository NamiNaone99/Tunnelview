'use strict';
/*
 * A Node "phone" for tests: the client side of pairing (mobile PLAN §6.5) and of every later
 * connection to a paired computer (§6.6), written step by step so the Dart client can follow it.
 * It is the reference behaviour, not a product: no Tailscale, no bound sockets, no route check.
 * Those steps happen on the phone before the first byte and cannot be shown over loopback; the
 * `dial` hook stands in for them (a link's Tailscale address → where the test host listens).
 *
 *   const phone = new PhoneSim({ dial: (ip, port) => ({ host: '127.0.0.1', port, localAddress: '127.0.0.2' }) });
 *   const p = await phone.pair(link)        → {ok:true, record, seenAs} | {ok:false, reason}
 *   const c = await phone.connect(record)   → {ok:true, conn, hello, cnonce} | {ok:false, reason}
 *   phone.sent                              every frame this phone put on the wire, in order
 *
 * Refusal reasons:
 *   pair:    link-<CODE> (pairing.parseLink), expired, declined (the user said no after seeing the
 *            fingerprint), unreachable, http-<status>, protocol (hello not as specified),
 *            host-update-needed (no hello.ident), not-paired-host (ident not signed by the link's key
 *            for the link's host on this connection), failed (pair-result ok:false, or a result that
 *            does not match what was signed)
 *   connect: unreachable, http-<status>, protocol, host-update-needed, identity-mismatch (the host
 *            sees this phone as another node: a relay, or the phone's Tailscale identity changed),
 *            host-key-mismatch (a hello came, but none was signed by the pinned key for the pinned
 *            host on this connection)
 * A refusal sends nothing: no `request`, no `pair`, no hostname, no proof.
 */
const crypto = require('crypto');
const WebSocket = require('ws');
const PROTOCOL = require('../../src/shared/protocol');
const auth = require('../../src/main/auth');
const pairing = require('../../src/main/pairing');

const HELLO_TIMEOUT_MS = PROTOCOL.HANDSHAKE_TIMEOUT_MS;
const RESULT_TIMEOUT_MS = PROTOCOL.HANDSHAKE_TIMEOUT_MS;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** 32 random bytes in canonical base64: the X-Tunnelview-Client-Nonce value, new for every connection. */
function newClientNonce() {
  return crypto.randomBytes(PROTOCOL.CLIENT_NONCE_BYTES).toString('base64');
}

/**
 * The checks viewer-client.js applies to a hello before anything is sent (app, protocol, shapes,
 * nonce, KDF limits). hello.ident is checked separately (pairing.verifyIdent).
 */
function validHello(h) {
  if (!isObj(h) || h.t !== PROTOCOL.MSG.HELLO) return false;
  if (h.app !== PROTOCOL.APP_ID || h.protocol !== PROTOCOL.PROTOCOL_VERSION) return false;
  if (!isObj(h.host) || !isObj(h.auth)) return false;
  const a = h.auth;
  if (typeof a.passwordSet !== 'boolean' || (a.acceptMode !== 'ask' && a.acceptMode !== 'password-only')) return false;
  if (!auth.decodeB64(a.nonce, 16, 64)) return false;
  if (a.passwordSet && (typeof a.salt !== 'string' || a.salt.length > 128 || !isObj(a.kdf) || !auth.validateKdf(a.kdf))) return false;
  return true;
}

/** One WebSocket with a frame queue. Every frame the phone sends goes through send(). */
class PhoneConnection {
  constructor(ws, sentLog) {
    this.ws = ws;
    this.frames = [];
    this._sentLog = sentLog;
    this._waiters = [];
    this.closed = new Promise((resolve) => {
      ws.on('close', (code, reason) => {
        resolve({ code, reason: String(reason || '') });
        for (const w of this._waiters.splice(0)) w.resolve(null);
      });
    });
    ws.on('message', (data, isBinary) => {
      let msg = null;
      if (!isBinary) {
        try { msg = JSON.parse(String(data)); } catch { msg = null; }
      }
      this.frames.push(msg);
      for (const w of [...this._waiters]) {
        if (w.match(msg)) {
          this._waiters.splice(this._waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    });
    ws.on('error', () => { /* 'close' follows */ });
  }

  /** The first frame (already received or still to come) with t === type, or null on close / timeout. */
  next(type, timeoutMs = RESULT_TIMEOUT_MS) {
    const match = (m) => isObj(m) && m.t === type;
    const have = this.frames.find(match);
    if (have) return Promise.resolve(have);
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.resolve(null);
    return new Promise((resolve) => {
      const w = { match, resolve: (v) => { clearTimeout(timer); resolve(v); } };
      const timer = setTimeout(() => {
        const i = this._waiters.indexOf(w);
        if (i >= 0) this._waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      this._waiters.push(w);
    });
  }

  send(obj) {
    if (this.ws.readyState !== WebSocket.OPEN) return false;
    this._sentLog.push(structuredClone(obj));
    this.ws.send(JSON.stringify(obj));
    return true;
  }

  close() {
    try { this.ws.close(1000, 'phone-closed'); } catch { /* ignore */ }
    const t = setTimeout(() => { try { this.ws.terminate(); } catch { /* ignore */ } }, 500);
    if (t.unref) t.unref();
  }
}

class PhoneSim {
  /**
   * @param {object} [opts]
   *   dial(ip, port) → {host, port, localAddress?}: where a link / record address is reached
   *   device: what `pair` reports about the phone (display only; the host uses whois)
   *   confirm({name, address, port, fingerprint}) → bool: the user's confirm sheet (default yes)
   *   now: clock for the link expiry
   */
  constructor({ dial = (ip, port) => ({ host: ip, port }), device = null, confirm = () => true, now = Date.now } = {}) {
    this._dial = dial;
    this.device = device || { name: 'pixel-8', os: 'android', version: '0.3.0' };
    this._confirm = confirm;
    this._now = now;
    this.sent = [];
    this.connections = [];
  }

  /** Upgrade with the protocol header and a fresh client nonce, no Origin. → {conn} | {status} | {error} */
  _open(ip, port, cnonce) {
    const target = this._dial(ip, port);
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const host = target.host.includes(':') ? `[${target.host}]` : target.host;
      const ws = new WebSocket(`ws://${host}:${target.port}${PROTOCOL.WS_PATH}`, {
        headers: { [PROTOCOL.PROTOCOL_HEADER]: String(PROTOCOL.PROTOCOL_VERSION), [PROTOCOL.CLIENT_NONCE_HEADER]: cnonce },
        localAddress: target.localAddress,
        perMessageDeflate: false,
        handshakeTimeout: HELLO_TIMEOUT_MS,
        maxPayload: PROTOCOL.MAX_WS_PAYLOAD,
        followRedirects: false,
      });
      const conn = new PhoneConnection(ws, this.sent);
      ws.on('open', () => { this.connections.push(conn); finish({ conn }); });
      ws.on('unexpected-response', (_req, res) => { finish({ status: res.statusCode }); ws.terminate(); });
      ws.on('error', (error) => finish({ error }));
    });
  }

  /**
   * Pair with the computer behind `link` (PLAN §6.5): strict parse, expiry, the user's confirm with
   * the fingerprint, then per address (IPv4 first): hello → ident signed by the link's key for the
   * link's host and THIS connection's client nonce → pair proof → pair-result naming the same IDs.
   * The phone learns its own node ID (viewerId) from the signed hello and pins it.
   */
  async pair(link) {
    let d;
    try {
      d = pairing.parseLink(link);
    } catch (e) {
      return { ok: false, reason: `link-${e && e.code ? e.code : 'INVALID'}` };
    }
    if (d.x * 1000 <= this._now()) return { ok: false, reason: 'expired' };
    const keyPub = pairing.decodeB64url(d.k, pairing.KEY_BYTES);
    const token = pairing.decodeB64url(d.t, PROTOCOL.PAIR.TOKEN_BYTES);
    if (!this._confirm({ name: d.n, address: d.a[0], port: d.p, fingerprint: pairing.fingerprint(keyPub) })) {
      return { ok: false, reason: 'declined' };
    }
    let last = 'unreachable';
    for (const ip of d.a) {
      const cnonce = newClientNonce();
      const opened = await this._open(ip, d.p, cnonce);
      if (!opened.conn) {
        last = opened.status ? `http-${opened.status}` : 'unreachable';
        continue;
      }
      const { conn } = opened;
      const hello = await conn.next(PROTOCOL.MSG.HELLO, HELLO_TIMEOUT_MS);
      if (!validHello(hello)) {
        conn.close();
        return { ok: false, reason: 'protocol' };
      }
      // viewerId is not known yet: the host tells us how it sees us, under its signature.
      const v = pairing.verifyIdent(keyPub, hello, { cnonce, hostId: d.id });
      if (!v.ok) {
        conn.close();
        return { ok: false, reason: v.reason === 'no-ident' ? 'host-update-needed' : 'not-paired-host' };
      }
      const proof = pairing.pairProof(token, hello.auth.nonce, cnonce, d.id, v.viewerId);
      conn.send({ t: PROTOCOL.MSG.PAIR, proof, device: { ...this.device } });
      const r = await conn.next(PROTOCOL.MSG.PAIR_RESULT, RESULT_TIMEOUT_MS);
      conn.close();
      if (!isObj(r) || r.ok !== true || r.hostId !== d.id || r.viewerId !== v.viewerId) return { ok: false, reason: 'failed' };
      const peer = isObj(r.peer) ? r.peer : {};
      return {
        ok: true,
        record: { hostId: d.id, keyPub: d.k, name: d.n, ips: [...d.a], port: d.p, selfId: v.viewerId },
        seenAs: { name: typeof peer.name === 'string' ? peer.name : '', login: typeof peer.login === 'string' ? peer.login : '' },
      };
    }
    return { ok: false, reason: last };
  }

  /**
   * Connect to a paired computer (PLAN §6.6). Nothing is sent until hello.ident proves, for this
   * connection, that the pinned key signed it for the pinned host AND that the host sees this phone
   * as the node it paired as. A forged or replayed hello moves on to the next address; a relay
   * (viewer-mismatch) stops at once. On success the caller continues like viewer-client from
   * _onHello on, with the proof binding {hostId: record.hostId, viewerId: record.selfId}.
   */
  async connect(record) {
    const keyPub = pairing.decodeB64url(record.keyPub, pairing.KEY_BYTES);
    let helloSeen = false;
    let last = 'unreachable';
    for (const ip of record.ips) {
      const cnonce = newClientNonce();
      const opened = await this._open(ip, record.port, cnonce);
      if (!opened.conn) {
        if (opened.status) last = `http-${opened.status}`;
        continue;
      }
      const { conn } = opened;
      const hello = await conn.next(PROTOCOL.MSG.HELLO, HELLO_TIMEOUT_MS);
      if (!validHello(hello)) {
        conn.close();
        return { ok: false, reason: 'protocol' };
      }
      helloSeen = true;
      const v = pairing.verifyIdent(keyPub, hello, { cnonce, hostId: record.hostId, viewerId: record.selfId });
      if (v.ok) return { ok: true, conn, hello, cnonce, binding: { hostId: record.hostId, viewerId: record.selfId } };
      conn.close();
      if (v.reason === 'no-ident') return { ok: false, reason: 'host-update-needed' };
      if (v.reason === 'viewer-mismatch') return { ok: false, reason: 'identity-mismatch' };
      // malformed, bad-signature, cnonce-mismatch, host-mismatch: not the pinned computer here.
    }
    return { ok: false, reason: helloSeen ? 'host-key-mismatch' : last };
  }

  closeAll() {
    for (const c of this.connections) c.close();
  }
}

module.exports = { PhoneSim, PhoneConnection, newClientNonce, validHello };
