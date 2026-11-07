'use strict';
/*
 * Pairing a phone with this computer, and the signed hello (mobile DECISIONS D1-D4).
 * Pure functions with no I/O. host-server.js and identity.js use them, and they are the oracle the
 * phone's Dart port must match (test/vectors/ident.json, pair.json, links.json, fingerprint.json,
 * written by scripts/make-mobile-fixtures.js).
 *
 *   identBytes(nonce, cnonce, hostId, viewerId) → Buffer       the bytes hello.ident.sig signs
 *   verifyIdent(pubRaw, hello, expect?) → {ok, reason, …}       a viewer's check of hello.ident
 *   pairMessage(nonce, cnonce, hostId, viewerId) → string       the text the pair proof covers
 *   pairProof(token, nonce, cnonce, hostId, viewerId) → base64  HMAC-SHA256(token, pairMessage)
 *   verifyPairProof(token, proof, nonce, cnonce, hostId, viewerId) → bool   host side, constant time
 *   encodeLink(obj) / parseLink(str)                            tunnelview://pair/1/<base64url(JSON)>
 *   fingerprint(pubRaw) → 'TV-XXXX-XXXX-XXXX-XXXX-XXXX'
 *   validCnonce(str) → bool                                     the X-Tunnelview-Client-Nonce value
 *
 * nonce = hello.auth.nonce (canonical base64, 16-64 bytes, as auth.js accepts it); cnonce = the
 * client nonce (canonical base64 of exactly 32 bytes) or null; hostId / viewerId = Tailscale
 * StableNodeIDs, checked like password-proof bindings (auth.normalizeBinding). None of them can
 * contain '|', so the '|'-joined text is unambiguous. A bad argument to a builder throws an Error
 * whose `code` names it (BAD_NONCE, BAD_CNONCE, BAD_BINDING, BAD_TOKEN, BAD_KEY, LINK_*), checked
 * in argument order.
 */
const crypto = require('crypto');
const PROTOCOL = require('../shared/protocol');
const auth = require('./auth');
const { isTailscaleIp, normalizeIp } = require('./tailscale');

const { IDENT, PAIR, CLIENT_NONCE_BYTES } = PROTOCOL;
const KEY_BYTES = 32; // raw Ed25519 public key
const SIG_BYTES = 64;
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // SPKI DER before the raw key
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // RFC 4648 §6
const FINGERPRINT_CHARS = 20; // 100 bits of SHA-256(pub), shown in groups of 4

// Pairing link: the JSON keys in this exact order (the only accepted spelling, see parseLink).
const LINK_KEYS = Object.freeze(['v', 'id', 'n', 'a', 'p', 'k', 't', 'x']);
// Far above the longest valid link (about 730 characters: a 253-character name, both address
// families, a 16-digit expiry), so only junk is cut off before decoding.
const LINK_MAX_LENGTH = 1024;
const NAME_MAX = 253;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const B64URL_RE = /^[A-Za-z0-9_-]*$/;
const PORT_MIN = 1024;
const PORT_MAX = 65535;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

function pairingError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;
// The StableNodeID rule of password-proof bindings, applied to one ID.
const isNodeId = (s) => auth.normalizeBinding({ hostId: s, viewerId: s }) !== null;
const validNonce = (s) => auth.decodeB64(s, 16, 64) !== null;

/** Canonical base64 (with padding) of exactly 32 bytes: 44 characters ending in one '='. */
function validCnonce(s) {
  return auth.decodeB64(s, CLIENT_NONCE_BYTES, CLIENT_NONCE_BYTES) !== null;
}

/**
 * Strict base64url without padding: the alphabet only, and the text must be exactly what encoding
 * the decoded bytes gives (Buffer's own decoder skips bad characters and ignores padding bits).
 * @returns {Buffer|null}
 */
function decodeB64url(s, bytes) {
  if (typeof s !== 'string' || !B64URL_RE.test(s) || s.length % 4 === 1) return null;
  if (bytes !== undefined && s.length !== Math.ceil((bytes * 4) / 3)) return null;
  const buf = Buffer.from(s, 'base64url');
  if (buf.toString('base64url') !== s) return null;
  return bytes === undefined || buf.length === bytes ? buf : null;
}

/** RFC 4648 base32, upper case, no padding. */
function base32(bytes) {
  let out = '';
  let value = 0;
  let bits = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function rawKey(pubRaw) {
  if (!(pubRaw instanceof Uint8Array) || pubRaw.length !== KEY_BYTES) {
    throw pairingError('BAD_KEY', 'An Ed25519 public key is 32 raw bytes.');
  }
  return Buffer.from(pubRaw);
}

/** Node KeyObject for a raw Ed25519 public key. */
function publicKeyObject(pubRaw) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, rawKey(pubRaw)]), format: 'der', type: 'spki' });
}

/** 'TV-' + the first 20 characters of base32(SHA-256(raw public key)), in groups of 4. */
function fingerprint(pubRaw) {
  const digest = crypto.createHash('sha256').update(rawKey(pubRaw)).digest();
  return `TV-${base32(digest).slice(0, FINGERPRINT_CHARS).match(/.{4}/g).join('-')}`;
}

/** nonce|cnonce|hostId|viewerId after checking each field; cnonce null/undefined → ''. */
function boundFields(nonce, cnonce, hostId, viewerId, cnonceRequired) {
  if (!validNonce(nonce)) throw pairingError('BAD_NONCE', 'The hello nonce is not canonical base64 of 16-64 bytes.');
  if (cnonce === null || cnonce === undefined) {
    if (cnonceRequired) throw pairingError('BAD_CNONCE', 'Pairing needs the client nonce.');
  } else if (!validCnonce(cnonce)) {
    throw pairingError('BAD_CNONCE', 'The client nonce is not canonical base64 of 32 bytes.');
  }
  if (!auth.normalizeBinding({ hostId, viewerId })) throw pairingError('BAD_BINDING', 'hostId and viewerId must be Tailscale node IDs.');
  return `${nonce}|${cnonce || ''}|${hostId}|${viewerId}`;
}

/** UTF-8 of IDENT.CONTEXT + nonce|cnonce|hostId|viewerId: what the host signs into hello.ident. */
function identBytes(nonce, cnonce, hostId, viewerId) {
  return Buffer.from(IDENT.CONTEXT + boundFields(nonce, cnonce, hostId, viewerId, false), 'utf8');
}

/**
 * A viewer's check of a signed hello. `expect` holds what the viewer knows independently ({cnonce,
 * hostId, viewerId}; each compared only when present). The order of the checks decides the
 * reason, and a phone acts on it (mobile PLAN §6.6):
 *   'no-ident'         hello.ident absent or null: the host predates identities
 *   'malformed'        ident or hello.auth.nonce is not as specified (unknown ident fields are ignored)
 *   'bad-signature'    the signature does not verify with pubRaw over identBytes(...)
 *   'cnonce-mismatch'  signed for another connection (replayed)
 *   'host-mismatch'    signed by this key, but for another host ID
 *   'viewer-mismatch'  authentic, but the host sees this viewer as another node (a relay, or the
 *                      phone's Tailscale identity changed): only reached once everything else holds
 * Ed25519 verification is RFC 8032 as OpenSSL does it (S must be below the group order).
 * @param {Uint8Array} pubRaw the pinned 32-byte key; anything else throws BAD_KEY (a caller bug)
 * @returns {{ok:true, reason:null, hostId, viewerId, cnonce} | {ok:false, reason:string}}
 */
function verifyIdent(pubRaw, hello, expect) {
  const key = publicKeyObject(pubRaw);
  const fail = (reason) => ({ ok: false, reason });
  if (!isObj(hello)) return fail('malformed');
  const i = hello.ident;
  if (i === undefined || i === null) return fail('no-ident');
  if (!isObj(i) || i.v !== IDENT.VERSION || i.alg !== IDENT.ALG) return fail('malformed');
  const nonce = isObj(hello.auth) ? hello.auth.nonce : undefined;
  let signed;
  try {
    if (!has(i, 'cnonce')) return fail('malformed'); // must be sent, as a string or null
    signed = identBytes(nonce, i.cnonce, i.hostId, i.viewerId);
  } catch {
    return fail('malformed');
  }
  const sig = auth.decodeB64(i.sig, SIG_BYTES, SIG_BYTES);
  if (!sig) return fail('malformed');
  let good = false;
  try { good = crypto.verify(null, signed, key, sig); } catch { good = false; }
  if (!good) return fail('bad-signature');
  const want = isObj(expect) ? expect : {};
  if (has(want, 'cnonce') && i.cnonce !== want.cnonce) return fail('cnonce-mismatch');
  if (has(want, 'hostId') && i.hostId !== want.hostId) return fail('host-mismatch');
  if (has(want, 'viewerId') && i.viewerId !== want.viewerId) return fail('viewer-mismatch');
  return { ok: true, reason: null, hostId: i.hostId, viewerId: i.viewerId, cnonce: i.cnonce };
}

/** PAIR.CONTEXT + nonce|cnonce|hostId|viewerId. Pairing always has a client nonce. */
function pairMessage(nonce, cnonce, hostId, viewerId) {
  return PAIR.CONTEXT + boundFields(nonce, cnonce, hostId, viewerId, true);
}

function tokenBytes(token) {
  if (!(token instanceof Uint8Array) || token.length !== PAIR.TOKEN_BYTES) {
    throw pairingError('BAD_TOKEN', `A pairing token is ${PAIR.TOKEN_BYTES} bytes.`);
  }
  return Buffer.from(token);
}

/** base64(HMAC-SHA256(token, pairMessage(...))). @param {Uint8Array} token the offer's 16 bytes */
function pairProof(token, nonce, cnonce, hostId, viewerId) {
  const key = tokenBytes(token);
  return crypto.createHmac('sha256', key).update(pairMessage(nonce, cnonce, hostId, viewerId), 'utf8').digest('base64');
}

/**
 * Host side: constant-time check of a phone's pair proof (canonical base64 of 32 bytes) against
 * this connection's values. Never throws; any malformed input is simply false.
 */
function verifyPairProof(token, proofB64, nonce, cnonce, hostId, viewerId) {
  try {
    const proof = auth.decodeB64(proofB64, 32, 32);
    if (!proof) return false;
    const expected = Buffer.from(pairProof(token, nonce, cnonce, hostId, viewerId), 'base64');
    return proof.length === expected.length && crypto.timingSafeEqual(proof, expected);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------------------------------------
 * Pairing link: tunnelview://pair/1/<base64url(JSON)> (mobile DECISIONS D3)
 *   v  1
 *   id the host's StableNodeID
 *   n  its MagicDNS FQDN, lower case, no trailing dot, ≤ 253 characters, or ''
 *   a  1-2 Tailscale addresses in canonical text, at most one IPv4 and one IPv6, IPv4 first
 *   p  the signaling port, an integer 1024-65535
 *   k  base64url (no padding) of the raw 32-byte Ed25519 identity key
 *   t  base64url (no padding) of the 16-byte offer token
 *   x  the offer's expiry, integer unix seconds (checked by the caller, not here)
 * ---------------------------------------------------------------------------------------------- */

function validName(n) {
  if (typeof n !== 'string') return false;
  if (n === '') return true;
  return n.length <= NAME_MAX && n.split('.').every((label) => LABEL_RE.test(label));
}

/** Canonical text only: what normalizeIp gives (no brackets, zone, spaces, ::ffff: or upper case). */
function validAddresses(a) {
  if (!Array.isArray(a) || a.length < 1 || a.length > 2) return false;
  if (!a.every((ip) => typeof ip === 'string' && isTailscaleIp(ip) && normalizeIp(ip) === ip)) return false;
  const families = a.map((ip) => (ip.includes(':') ? 6 : 4));
  return a.length === 1 || (families[0] === 4 && families[1] === 6);
}

const LINK_FIELD_CHECKS = [
  ['id', 'LINK_ID', isNodeId],
  ['n', 'LINK_NAME', validName],
  ['a', 'LINK_ADDRESS', validAddresses],
  ['p', 'LINK_PORT', (p) => Number.isSafeInteger(p) && p >= PORT_MIN && p <= PORT_MAX],
  ['k', 'LINK_KEY', (k) => decodeB64url(k, KEY_BYTES) !== null],
  ['t', 'LINK_TOKEN', (t) => decodeB64url(t, PAIR.TOKEN_BYTES) !== null],
  ['x', 'LINK_EXPIRY', (x) => Number.isSafeInteger(x) && x > 0],
];

/** The link object with its keys in LINK_KEYS order, or throws LINK_JSON / VERSION / FIELDS / <field>. */
function checkLinkObject(o) {
  if (!isObj(o)) throw pairingError('LINK_JSON', 'A pairing link holds a JSON object.');
  if (o.v !== PAIR.LINK_VERSION) throw pairingError('LINK_VERSION', 'This pairing link is from another Tunnelview version.');
  const keys = Object.keys(o);
  if (keys.length !== LINK_KEYS.length || !LINK_KEYS.every((k) => keys.includes(k))) {
    throw pairingError('LINK_FIELDS', 'The pairing link has missing or unknown fields.');
  }
  for (const [key, code, ok] of LINK_FIELD_CHECKS) {
    if (!ok(o[key])) throw pairingError(code, `The pairing link's "${key}" is not valid.`);
  }
  const out = {};
  for (const k of LINK_KEYS) out[k] = k === 'a' ? [...o.a] : o[k];
  return out;
}

/** The link text for a pairing offer. Throws (same codes as parseLink) unless obj is a valid link. */
function encodeLink(obj) {
  const json = JSON.stringify(checkLinkObject(obj));
  return PAIR.LINK_PREFIX + Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Strict parse of a pairing link. Exactly one spelling of each link is accepted: the one
 * encodeLink writes (no whitespace anywhere, keys in order, no escapes, integers as plain digits).
 * Throws, in the order checked:
 *   LINK_FORMAT    not a string, longer than LINK_MAX_LENGTH, or not starting with LINK_PREFIX
 *   LINK_ENCODING  the rest is not canonical base64url without padding
 *   LINK_JSON      not UTF-8 JSON of an object
 *   LINK_VERSION   v is not 1
 *   LINK_FIELDS    keys missing or unknown
 *   LINK_ID, LINK_NAME, LINK_ADDRESS, LINK_PORT, LINK_KEY, LINK_TOKEN, LINK_EXPIRY   (in key order)
 *   LINK_NONCANONICAL  valid fields, but not the canonical JSON text
 * @returns {{v, id, n, a, p, k, t, x}} a fresh object
 */
function parseLink(str) {
  if (typeof str !== 'string' || str.length > LINK_MAX_LENGTH || !str.startsWith(PAIR.LINK_PREFIX)) {
    throw pairingError('LINK_FORMAT', 'This is not a Tunnelview pairing link.');
  }
  const payload = str.slice(PAIR.LINK_PREFIX.length);
  const bytes = payload ? decodeB64url(payload) : null;
  if (!bytes) throw pairingError('LINK_ENCODING', 'The pairing link is damaged.');
  let text;
  let obj;
  try {
    text = UTF8.decode(bytes);
    obj = JSON.parse(text);
  } catch {
    throw pairingError('LINK_JSON', 'The pairing link is damaged.');
  }
  const link = checkLinkObject(obj);
  if (JSON.stringify(link) !== text) throw pairingError('LINK_NONCANONICAL', 'The pairing link is not in its canonical form.');
  return link;
}

module.exports = {
  identBytes,
  verifyIdent,
  pairMessage,
  pairProof,
  verifyPairProof,
  encodeLink,
  parseLink,
  fingerprint,
  validCnonce,
  base32,
  decodeB64url,
  LINK_KEYS,
  LINK_MAX_LENGTH,
  KEY_BYTES,
  SIG_BYTES,
};
