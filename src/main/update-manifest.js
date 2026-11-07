'use strict';
/*
 * The signed update manifest, tunnelview-update.json (DECISIONS U1). Pure functions with Node
 * built-ins only: src/main/updater.js verifies with it, and scripts/sign-update.js (run in CI
 * without node_modules) builds, signs and re-verifies with it.
 *
 * The file (the "envelope"), exactly these three keys:
 *   {"payload":"<base64 of the UTF-8 payload JSON>","sig":"<base64 Ed25519 signature over the
 *    payload bytes>","kid":"<key id>"}
 * The payload, exactly these keys in this order (encodePayload writes it; verify insists on it):
 *   {"v":1,"app":"Tunnelview","version":"X.Y.Z","date":"YYYY-MM-DDTHH:MM:SS.sssZ","notes":"…",
 *    "files":{"win32-x64":{"name","size","sha256"},"win32-arm64":…,"darwin-arm64":…,"darwin-x64":…}}
 *   version  X.Y.Z, digits only, no leading zeros (compareVersions orders them)
 *   date     what Date#toISOString() writes (UTC, milliseconds)
 *   notes    plain text, at most 4000 UTF-16 code units; no control characters except \n and \t, no
 *            bidi controls, no U+2028/2029, no lone surrogates
 *   files    all four platform keys; name is exactly assetName(key, version), size an integer
 *            1 … 400 MiB, sha256 64 lowercase hex characters
 * kid = keyId(raw public key) = the first 16 lowercase hex characters of SHA-256 of the raw 32-byte
 * Ed25519 public key (src/main/update-keys.js lists the embedded keys; sign-update.js and CI derive
 * the same value).
 *
 *   verifyManifest(bytes, {keys, currentVersion?}) → {ok:true, manifest, kid}
 *                                                  | {ok:false, code, detail?, version?}
 *   signManifest(payload, privateKey, kid?)        → Buffer (the file: envelope JSON + '\n')
 *   buildPayload({version, date, notes, files})    → payload object in canonical key order
 *   compareVersions(a, b)                          → -1 | 0 | 1 (throws TypeError on a bad version)
 *   assetName(platformKey, version)                → the release asset name
 *   keyId(rawPublicKey32)                          → kid
 *
 * One code per failure, checked in this order:
 *   TOO_LARGE      the file is over 64 KiB
 *   MALFORMED      not UTF-8 JSON, not exactly {payload, sig, kid} as strings, kid not 16 hex,
 *                  payload / sig not canonical base64 (sig: 64 bytes)
 *   UNKNOWN_KEY    no embedded key has that kid
 *   BAD_SIGNATURE  the signature does not verify with that key over the payload bytes
 *   INVALID        signed, but the payload breaks a rule above (detail names the field)
 *   NOT_NEWER      only with currentVersion: the manifest's version is not greater than it
 */
const crypto = require('crypto');

const MANIFEST_NAME = 'tunnelview-update.json';
const FORMAT_VERSION = 1;
const APP_NAME = 'Tunnelview';
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_NOTES_LENGTH = 4000;
const MAX_ASSET_BYTES = 400 * 1024 * 1024;
const KEY_BYTES = 32;
const SIG_BYTES = 64;
const KID_HEX_CHARS = 16;
const PLATFORM_KEYS = Object.freeze(['win32-x64', 'win32-arm64', 'darwin-arm64', 'darwin-x64']);
const ENVELOPE_KEYS = Object.freeze(['payload', 'sig', 'kid']);
const PAYLOAD_KEYS = Object.freeze(['v', 'app', 'version', 'date', 'notes', 'files']);
const FILE_KEYS = Object.freeze(['name', 'size', 'sha256']);
const CODES = Object.freeze(['TOO_LARGE', 'MALFORMED', 'UNKNOWN_KEY', 'BAD_SIGNATURE', 'INVALID', 'NOT_NEWER']);

const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex'); // SPKI DER before the raw key
const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_RE = /^[0-9a-f]{64}$/;
const KID_RE = /^[0-9a-f]{16}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
// C0 / C1 controls except \t (09) and \n (0a), bidi marks / embeddings / overrides / isolates,
// line and paragraph separators, BOM, and (u flag) lone surrogates.
const NOTES_BAD_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]|[\ud800-\udfff]/u;
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

// Release asset names (electron-builder.yml artifactName), one per platform key.
const ASSET_NAME = Object.freeze({
  'win32-x64': (v) => `Tunnelview-Setup-${v}-x64.exe`,
  'win32-arm64': (v) => `Tunnelview-Setup-${v}-arm64.exe`,
  'darwin-arm64': (v) => `Tunnelview-${v}-mac-arm64.zip`,
  'darwin-x64': (v) => `Tunnelview-${v}-mac-x64.zip`,
});
// The same names as an allow-list: no path separators, no traversal, nothing else.
const ASSET_NAME_RE = Object.freeze({
  'win32-x64': /^Tunnelview-Setup-(\d{1,9}\.\d{1,9}\.\d{1,9})-x64\.exe$/,
  'win32-arm64': /^Tunnelview-Setup-(\d{1,9}\.\d{1,9}\.\d{1,9})-arm64\.exe$/,
  'darwin-arm64': /^Tunnelview-(\d{1,9}\.\d{1,9}\.\d{1,9})-mac-arm64\.zip$/,
  'darwin-x64': /^Tunnelview-(\d{1,9}\.\d{1,9}\.\d{1,9})-mac-x64\.zip$/,
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
/** Exactly these own keys (JSON.parse makes "__proto__" an own key, so it counts as an extra one). */
const sameKeys = (o, keys) => Object.keys(o).length === keys.length && keys.every((k) => hasOwn(o, k));

function manifestError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ------------------------------------------------------------------ encodings */

/** Strict base64 (standard alphabet, padded, canonical), byte length within [min, max]. → Buffer|null */
function decodeB64(s, min, max) {
  if (typeof s !== 'string' || s.length === 0 || s.length % 4 !== 0) return null;
  if (s.length > Math.ceil(max / 3) * 4 || !B64_RE.test(s)) return null;
  const buf = Buffer.from(s, 'base64');
  if (buf.length < min || buf.length > max || buf.toString('base64') !== s) return null;
  return buf;
}

/** Strict base64url without padding of exactly `bytes` bytes. → Buffer|null */
function decodeB64url(s, bytes) {
  if (typeof s !== 'string' || !B64URL_RE.test(s) || s.length !== Math.ceil((bytes * 4) / 3)) return null;
  const buf = Buffer.from(s, 'base64url');
  return buf.length === bytes && buf.toString('base64url') === s ? buf : null;
}

/** Raw 32-byte public key of an Ed25519 KeyObject (private or public): the tail of its SPKI DER. */
function rawPublicKey(keyObject) {
  const pub = keyObject instanceof crypto.KeyObject && keyObject.type === 'public' ? keyObject : crypto.createPublicKey(keyObject);
  const spki = pub.export({ format: 'der', type: 'spki' });
  if (spki.length !== SPKI_ED25519_PREFIX.length + KEY_BYTES || !spki.subarray(0, SPKI_ED25519_PREFIX.length).equals(SPKI_ED25519_PREFIX)) {
    throw manifestError('BAD_KEY', 'Not an Ed25519 key.');
  }
  return Buffer.from(spki.subarray(SPKI_ED25519_PREFIX.length));
}

function publicKeyObject(raw) {
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** kid: the first 16 lowercase hex characters of SHA-256(raw 32-byte Ed25519 public key). */
function keyId(raw) {
  if (!(raw instanceof Uint8Array) || raw.length !== KEY_BYTES) throw manifestError('BAD_KEY', 'An Ed25519 public key is 32 raw bytes.');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, KID_HEX_CHARS);
}

/* ------------------------------------------------------------------ field rules */

const validVersion = (v) => typeof v === 'string' && VERSION_RE.test(v);

function versionParts(v) {
  if (!validVersion(v)) throw new TypeError(`not an X.Y.Z version: ${String(v).slice(0, 40)}`);
  return v.split('.').map(Number);
}

/** -1 / 0 / 1 for two X.Y.Z versions (numeric per part). Throws TypeError on anything else. */
function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const t = Date.parse(s);
  return Number.isFinite(t) && new Date(t).toISOString() === s; // no 30 February, no hour 24
}

function validNotes(s) {
  return typeof s === 'string' && s.length <= MAX_NOTES_LENGTH && !NOTES_BAD_RE.test(s);
}

/** Release notes as sign-update.js stores them: no BOM, LF line ends, no trailing whitespace. */
function normalizeNotes(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
}

/** The release asset name for a platform key and version (throws on an unknown key / bad version). */
function assetName(platformKey, version) {
  if (!hasOwn(ASSET_NAME, platformKey)) throw manifestError('BAD_PLATFORM', `Unknown platform key: ${String(platformKey).slice(0, 40)}`);
  if (!validVersion(version)) throw manifestError('BAD_VERSION', 'Not an X.Y.Z version.');
  return ASSET_NAME[platformKey](version);
}

/** null when the payload follows every rule, else the name of the first field that does not. */
function validatePayload(p) {
  if (!isObj(p)) return 'payload';
  if (!sameKeys(p, PAYLOAD_KEYS)) return 'keys';
  if (p.v !== FORMAT_VERSION) return 'v';
  if (p.app !== APP_NAME) return 'app';
  if (!validVersion(p.version)) return 'version';
  if (!validDate(p.date)) return 'date';
  if (!validNotes(p.notes)) return 'notes';
  if (!isObj(p.files) || !sameKeys(p.files, PLATFORM_KEYS)) return 'files';
  for (const key of PLATFORM_KEYS) {
    const f = p.files[key];
    if (!isObj(f) || !sameKeys(f, FILE_KEYS)) return `files.${key}`;
    if (typeof f.name !== 'string' || !ASSET_NAME_RE[key].test(f.name) || f.name !== ASSET_NAME[key](p.version)) return `files.${key}.name`;
    if (!Number.isSafeInteger(f.size) || f.size < 1 || f.size > MAX_ASSET_BYTES) return `files.${key}.size`;
    if (typeof f.sha256 !== 'string' || !SHA256_RE.test(f.sha256)) return `files.${key}.sha256`;
  }
  return null;
}

/** The payload with its keys in the canonical order (values are taken as they are). */
function buildPayload({ version, date, notes, files }) {
  const out = { v: FORMAT_VERSION, app: APP_NAME, version, date, notes, files: {} };
  for (const key of PLATFORM_KEYS) {
    const f = isObj(files) ? files[key] : undefined;
    out.files[key] = isObj(f) ? { name: f.name, size: f.size, sha256: f.sha256 } : f;
  }
  return out;
}

/** UTF-8 bytes of the payload JSON in canonical key order (what the signature covers). */
function encodePayload(p) {
  return Buffer.from(JSON.stringify(buildPayload(p)), 'utf8');
}

/** The manifest file: envelope JSON in key order payload, sig, kid, and a trailing newline. */
function encodeEnvelope({ payload, sig, kid }) {
  return Buffer.from(`${JSON.stringify({ payload, sig, kid })}\n`, 'utf8');
}

/**
 * Parse the file without checking the signature.
 * @returns {{ok:true, kid:string, payload:Buffer, sig:Buffer} | {ok:false, code:'TOO_LARGE'|'MALFORMED', detail?}}
 */
function decodeEnvelope(bytes) {
  const fail = (code, detail) => (detail ? { ok: false, code, detail } : { ok: false, code });
  let buf = bytes;
  if (typeof buf === 'string') buf = Buffer.from(buf, 'utf8');
  if (!(buf instanceof Uint8Array)) return fail('MALFORMED', 'type');
  if (buf.length > MAX_MANIFEST_BYTES) return fail('TOO_LARGE');
  let o;
  try {
    o = JSON.parse(UTF8.decode(buf));
  } catch {
    return fail('MALFORMED', 'json');
  }
  if (!isObj(o) || !sameKeys(o, ENVELOPE_KEYS) || !ENVELOPE_KEYS.every((k) => typeof o[k] === 'string')) return fail('MALFORMED', 'keys');
  if (!KID_RE.test(o.kid)) return fail('MALFORMED', 'kid');
  const payload = decodeB64(o.payload, 1, MAX_MANIFEST_BYTES);
  if (!payload) return fail('MALFORMED', 'payload');
  const sig = decodeB64(o.sig, SIG_BYTES, SIG_BYTES);
  if (!sig) return fail('MALFORMED', 'sig');
  return { ok: true, kid: o.kid, payload, sig };
}

/** The KeyObject of the list entry whose kid matches (entries with a bad key or a wrong kid never match). */
function findKey(keys, kid) {
  if (!Array.isArray(keys)) return null;
  for (const k of keys) {
    if (!isObj(k) || k.kid !== kid) continue;
    const raw = decodeB64url(k.publicKey, KEY_BYTES);
    if (!raw || keyId(raw) !== kid) continue;
    try { return publicKeyObject(raw); } catch { /* not a usable key */ }
  }
  return null;
}

function deepFreeze(o) {
  if (isObj(o)) for (const v of Object.values(o)) deepFreeze(v);
  return Object.freeze(o);
}

/**
 * Verify a downloaded manifest file against the embedded keys.
 * @param {Buffer|Uint8Array|string} bytes the file as downloaded
 * @param {{keys: Array<{kid:string, publicKey:string}>, currentVersion?:string}} opts
 *   currentVersion (X.Y.Z): also require the manifest to be strictly newer (NOT_NEWER otherwise)
 * @returns {{ok:true, manifest:object, kid:string} | {ok:false, code:string, detail?:string, version?:string}}
 */
function verifyManifest(bytes, { keys, currentVersion } = {}) {
  const env = decodeEnvelope(bytes);
  if (!env.ok) return env;
  const key = findKey(keys, env.kid);
  if (!key) return { ok: false, code: 'UNKNOWN_KEY' };
  let good = false;
  try { good = crypto.verify(null, env.payload, key, env.sig); } catch { good = false; }
  if (!good) return { ok: false, code: 'BAD_SIGNATURE' };
  let p;
  try {
    p = JSON.parse(UTF8.decode(env.payload));
  } catch {
    return { ok: false, code: 'INVALID', detail: 'json' };
  }
  const bad = validatePayload(p);
  if (bad) return { ok: false, code: 'INVALID', detail: bad };
  // One spelling only: whatever signed it, it is exactly what encodePayload writes.
  if (!encodePayload(p).equals(env.payload)) return { ok: false, code: 'INVALID', detail: 'not-canonical' };
  if (currentVersion !== undefined && compareVersions(p.version, currentVersion) <= 0) {
    return { ok: false, code: 'NOT_NEWER', version: p.version };
  }
  return { ok: true, manifest: deepFreeze(buildPayload(p)), kid: env.kid };
}

/**
 * Sign a payload (sign-update.js). The kid is derived from the key; a `kid` argument must match it.
 * @param {object} payload checked with validatePayload first (throws INVALID)
 * @param {crypto.KeyObject|string|Buffer} privateKey Ed25519 private key (KeyObject or PEM)
 * @returns {Buffer} the manifest file bytes
 */
function signManifest(payload, privateKey, kid) {
  const bad = validatePayload(payload);
  if (bad) throw manifestError('INVALID', `The manifest payload is not valid (${bad}).`);
  const key = privateKey instanceof crypto.KeyObject ? privateKey : crypto.createPrivateKey(privateKey);
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') throw manifestError('BAD_KEY', 'The signing key is not an Ed25519 private key.');
  const ownKid = keyId(rawPublicKey(key));
  if (kid !== undefined && kid !== ownKid) throw manifestError('BAD_KEY', 'The key id does not belong to the signing key.');
  const bytes = encodePayload(payload);
  const sig = crypto.sign(null, bytes, key);
  return encodeEnvelope({ payload: bytes.toString('base64'), sig: sig.toString('base64'), kid: ownKid });
}

module.exports = {
  MANIFEST_NAME,
  FORMAT_VERSION,
  APP_NAME,
  MAX_MANIFEST_BYTES,
  MAX_NOTES_LENGTH,
  MAX_ASSET_BYTES,
  PLATFORM_KEYS,
  CODES,
  ASSET_NAME_RE,
  validVersion,
  compareVersions,
  validDate,
  validNotes,
  normalizeNotes,
  assetName,
  validatePayload,
  buildPayload,
  encodePayload,
  encodeEnvelope,
  decodeEnvelope,
  verifyManifest,
  signManifest,
  keyId,
  rawPublicKey,
  decodeB64url,
};
