'use strict';
/*
 * Password hashing + challenge/response for unattended access (docs/ARCHITECTURE.md §4 "Auth").
 *
 *   stored = { salt:b64(16 bytes), N, r, p, keylen:32, key:b64 }
 *   key    = scrypt(utf8(password.normalize('NFC')), salt, keylen, {N, r, p, maxmem: 64 MiB})
 *   proof  = base64(HMAC-SHA256(key, PROTOCOL.AUTH.CONTEXT + nonceB64 + '|' + hostId + '|' + viewerId))
 *
 * The password never crosses the wire; the host only stores `key`. The nonce is fresh per
 * connection, so a proof cannot be replayed on another connection.
 *
 * Binding (protocol v2): hostId / viewerId are the two nodes' Tailscale StableNodeIDs.
 *   viewer: hostId = the node that owns the IP it dialed, viewerId = its own node (both from its
 *           own `tailscale status`);
 *   host:   hostId = its own node (self status), viewerId = `tailscale whois` of the remote IP.
 * WireGuard authenticates which node an address belongs to, so a tailnet node M that relays a
 * host's hello to a viewer and the viewer's proof back to the host cannot use it: the viewer bound
 * its proof to M's ID, the host expects its own ID and M's ID as the viewer. Node IDs (unlike IPs)
 * stay the same when Tailscale masquerades a peer's address (shared nodes with per-peer IPs).
 *
 * KDF parameters arrive from the (possibly malicious) host in `hello`, so the viewer validates them
 * (validateKdf) before running scrypt:
 *   - upper bounds from PROTOCOL.AUTH.KDF_LIMITS (N ≤ 2^17, r ≤ 16, p ≤ 4, keylen 32) → no DoS;
 *   - scrypt's own memory requirement must fit in maxmem (64 MiB), mirroring OpenSSL's check
 *     (128·r·(N+2) + 128·r·p bytes) and N < 2^(16·r), so validation and computation agree;
 *   - a minimum work factor N·r ≥ 2^17 (≥ 16 MiB): a rogue host must not be able to make us emit a
 *     cheaply brute-forceable proof of the user's password.
 */
const crypto = require('crypto');
const PROTOCOL = require('../shared/protocol');

const { CONTEXT, KDF_DEFAULT, KDF_LIMITS } = PROTOCOL.AUTH;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const MIN_KDF_WORK = 1 << 17; // N·r lower bound (16384·8)
const SALT_BYTES = 16;
const NONCE_BYTES = 32;
const MAX_PASSWORD_LENGTH = 1024; // chars; the UI enforces 8–128, this only bounds work
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
// Tailscale StableNodeID ("nXXXXXXXXCNTRL"; numeric on some control servers). Never contains '|'.
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Strict base64 decode: canonical encoding only, byte length within [min, max]. → Buffer|null
 */
function decodeB64(s, min, max) {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0) return null;
  if (s.length > Math.ceil(max / 3) * 4) return null;
  if (!B64_RE.test(s)) return null;
  const buf = Buffer.from(s, 'base64');
  if (buf.length < min || buf.length > max) return null;
  if (buf.toString('base64') !== s) return null; // reject non-canonical padding bits
  return buf;
}

function authError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Bytes OpenSSL's EVP_PBE_scrypt needs (Blen + Vlen), as Node checks it against maxmem. */
function scryptMemory(N, r, p) {
  return 128 * r * (N + 2) + 128 * r * p;
}

/** @returns {boolean} whether {N,r,p,keylen} are safe AND computable with maxmem 64 MiB. */
function validateKdf(kdf) {
  if (!kdf || typeof kdf !== 'object') return false;
  const { N, r, p, keylen } = kdf;
  if (![N, r, p, keylen].every(Number.isSafeInteger)) return false;
  if (keylen !== KDF_LIMITS.keylen) return false;
  if (N < 2 || N > KDF_LIMITS.maxN || (N & (N - 1)) !== 0) return false; // power of two
  if (r < 1 || r > KDF_LIMITS.maxR) return false;
  if (p < 1 || p > KDF_LIMITS.maxP) return false;
  if (N * r < MIN_KDF_WORK) return false;
  if (Math.log2(N) >= 16 * r) return false; // RFC 7914: N < 2^(128·r/8)
  if (scryptMemory(N, r, p) > SCRYPT_MAXMEM) return false;
  return true;
}

/** @returns {boolean} whether `stored` is a well-formed StoredPassword. */
function isStoredPassword(stored) {
  if (!stored || typeof stored !== 'object') return false;
  const { N, r, p, keylen } = stored;
  if (!validateKdf({ N, r, p, keylen })) return false;
  if (!decodeB64(stored.salt, SALT_BYTES, 64)) return false;
  const key = decodeB64(stored.key, keylen, keylen);
  return !!key;
}

function passwordBytes(password) {
  if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    throw authError('BAD_PASSWORD_INPUT', 'Password must be a non-empty string.');
  }
  return Buffer.from(password.normalize('NFC'), 'utf8');
}

function scrypt(pwBuf, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(pwBuf, salt, keylen, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

/**
 * Validate a proof binding {hostId, viewerId}: both must be Tailscale StableNodeIDs
 * (/^[A-Za-z0-9_-]{1,64}$/, compared exactly — IDs are case-sensitive).
 * @returns {{hostId:string, viewerId:string}|null}
 */
function normalizeBinding(binding) {
  if (!binding || typeof binding !== 'object') return null;
  const { hostId, viewerId } = binding;
  if (typeof hostId !== 'string' || !NODE_ID_RE.test(hostId)) return null;
  if (typeof viewerId !== 'string' || !NODE_ID_RE.test(viewerId)) return null;
  return { hostId, viewerId };
}

function hmac(key, nonceB64, binding) {
  return crypto.createHmac('sha256', key)
    .update(`${CONTEXT}${nonceB64}|${binding.hostId}|${binding.viewerId}`, 'utf8')
    .digest();
}

/**
 * Hash a password for storage. `kdf` defaults to PROTOCOL.AUTH.KDF_DEFAULT (must pass validateKdf).
 * @returns {Promise<{salt, N, r, p, keylen, key}>}
 */
async function hashPassword(password, kdf = KDF_DEFAULT) {
  const pw = passwordBytes(password);
  if (!validateKdf(kdf)) throw authError('BAD_KDF', 'Invalid KDF parameters.');
  const { N, r, p, keylen } = kdf;
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await scrypt(pw, salt, { N, r, p, keylen });
  return { salt: salt.toString('base64'), N, r, p, keylen, key: key.toString('base64') };
}

/**
 * Host side: constant-time check of a viewer's proof. Never throws.
 * @param {{hostId:string, viewerId:string}} binding host: {hostId: its own StableNodeID,
 *        viewerId: StableNodeID of the remote address (whois)}
 * @returns {boolean} false also for a missing / invalid binding
 */
function verifyProof(stored, nonceB64, proofB64, binding) {
  try {
    const b = normalizeBinding(binding);
    if (!b) return false;
    if (!isStoredPassword(stored)) return false;
    if (!decodeB64(nonceB64, 16, 64)) return false;
    const proof = decodeB64(proofB64, 32, 32);
    if (!proof) return false;
    const expected = hmac(Buffer.from(stored.key, 'base64'), nonceB64, b);
    if (proof.length !== expected.length) return false;
    return crypto.timingSafeEqual(proof, expected);
  } catch {
    return false;
  }
}

/**
 * Viewer side: derive the key with the host's salt/KDF params and answer the nonce.
 * Rejects (error.code 'BAD_BINDING' | 'BAD_KDF' | 'BAD_SALT' | 'BAD_NONCE' | 'BAD_PASSWORD_INPUT')
 * on unsafe input — before running scrypt.
 * @param {string} password
 * @param {{salt:string, kdf:{N,r,p,keylen}}} params from the host's hello
 * @param {string} nonceB64
 * @param {{hostId:string, viewerId:string}} binding viewer: {hostId: StableNodeID owning the IP
 *        dialed, viewerId: its own StableNodeID} — both from its own `tailscale status`
 * @returns {Promise<string>} proof (base64)
 */
async function computeProof(password, params, nonceB64, binding) {
  const b = normalizeBinding(binding);
  if (!b) throw authError('BAD_BINDING', "The devices' Tailscale IDs are unknown; the password was not used.");
  if (!params || typeof params !== 'object') throw authError('BAD_KDF', 'Missing password parameters.');
  if (!validateKdf(params.kdf)) throw authError('BAD_KDF', 'The host requested unsafe password-hashing parameters.');
  const salt = decodeB64(params.salt, SALT_BYTES, 64);
  if (!salt) throw authError('BAD_SALT', 'The host sent an invalid password salt.');
  if (!decodeB64(nonceB64, 16, 64)) throw authError('BAD_NONCE', 'The host sent an invalid challenge.');
  const pw = passwordBytes(password);
  const { N, r, p, keylen } = params.kdf;
  const key = await scrypt(pw, salt, { N, r, p, keylen });
  return hmac(key, nonceB64, b).toString('base64');
}

/** @returns {string} base64 of 32 random bytes */
function newNonce() {
  return crypto.randomBytes(NONCE_BYTES).toString('base64');
}

/**
 * Sliding-window failure counter with lockout, keyed by an opaque string (host-server uses
 * 'node:<stableId>' / 'login:<login>' / 'tagged' per peer identity, and one global key).
 *   fail(key) → true when the key is (now) locked
 */
class FailureLimiter {
  constructor({ max = 10, windowMs = 15 * 60e3, lockMs = 15 * 60e3, now = Date.now, maxEntries = 10000 } = {}) {
    this.max = Math.max(1, Math.floor(max));
    this.windowMs = Math.max(1, windowMs);
    this.lockMs = Math.max(1, lockMs);
    this.maxEntries = Math.max(16, maxEntries);
    this._now = now;
    this._map = new Map(); // key → { fails:number[], lockedUntil:number }
  }

  isLocked(key) {
    const e = this._map.get(String(key));
    if (!e || !e.lockedUntil) return false;
    if (e.lockedUntil > this._now()) return true;
    this._map.delete(String(key)); // lock expired → clean slate
    return false;
  }

  /** Remaining failures before lockout (informational). */
  remaining(key) {
    if (this.isLocked(key)) return 0;
    const e = this._map.get(String(key));
    if (!e) return this.max;
    const t = this._now();
    return Math.max(0, this.max - e.fails.filter((x) => x > t - this.windowMs).length);
  }

  fail(key) {
    const k = String(key);
    const t = this._now();
    let e = this._map.get(k);
    if (e && e.lockedUntil) {
      if (e.lockedUntil > t) return true;
      e = null;
    }
    if (!e) e = { fails: [], lockedUntil: 0 };
    e.fails = e.fails.filter((x) => x > t - this.windowMs);
    e.fails.push(t);
    if (e.fails.length >= this.max) {
      e.lockedUntil = t + this.lockMs;
      e.fails = [];
    }
    this._map.delete(k); // re-insert → Map order = least recently touched first
    this._map.set(k, e);
    this._prune(t);
    return e.lockedUntil > t;
  }

  reset(key) {
    this._map.delete(String(key));
  }

  _prune(t) {
    if (this._map.size <= this.maxEntries) return;
    for (const [k, e] of this._map) {
      const stale = e.lockedUntil ? e.lockedUntil <= t : !e.fails.some((x) => x > t - this.windowMs);
      if (stale) this._map.delete(k);
    }
    while (this._map.size > this.maxEntries) this._map.delete(this._map.keys().next().value);
  }
}

module.exports = {
  hashPassword,
  verifyProof,
  computeProof,
  newNonce,
  validateKdf,
  isStoredPassword,
  normalizeBinding,
  decodeB64,
  FailureLimiter,
  SCRYPT_MAXMEM,
  MIN_KDF_WORK,
};
