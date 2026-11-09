#!/usr/bin/env node
'use strict';
/*
 * Writes test/vectors/*.json: inputs and the outputs the REAL desktop modules give for them, so the
 * mobile (Dart) viewer can be tested against exactly what the desktop does.
 *
 *   node scripts/make-mobile-fixtures.js          (re)write every vector file
 *   node scripts/make-mobile-fixtures.js --check  regenerate in memory; exit 1 when a file differs,
 *                                                 is missing, or sits in test/vectors without a producer
 *
 * test/mobile-vectors.test.js runs the same comparison under `npm test`: a behaviour change in one
 * of these modules fails CI until the vectors, and with them the phone port, are updated.
 *
 * Vector file format 1:
 *   { about, format: 1, <data sections>, functions: { <name>: { about, cases: [case, …] } } }
 *   case = { args: [...], result: <value> } | { args: [...], error: '<error.code>' }, plus `note`
 * Inputs are plain JSON on purpose: that is all a peer can put on the wire, and all a Dart test can
 * load. The text is canonical so --check can compare bytes: keys sorted, 2-space indent, LF, a
 * trailing newline, and everything outside printable ASCII escaped as \uXXXX (no raw bidi or
 * invisible characters in the repository).
 *
 * Adding vectors: write `async function fooVectors(m)` returning the file object, add it to
 * PRODUCERS, and give test/mobile-vectors.test.js a replay for its functions. Keep the output fixed
 * between runs: no clocks, no randomness, and Ed25519 keys only from fixed 32-byte seeds wrapped in
 * PKCS8 (ed25519FromSeed, mobile DECISIONS D8).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');

const ROOT = path.resolve(__dirname, '..');
const VECTOR_DIR = path.join(ROOT, 'test', 'vectors');
const FORMAT = 1;
const SELF = 'scripts/make-mobile-fixtures.js';

/* ------------------------------------------------------------------------------------------------
 * Modules, cases, serialization
 * ---------------------------------------------------------------------------------------------- */

let modulesPromise = null;

/** The desktop modules the vectors come from, loaded once. */
function loadModules() {
  if (!modulesPromise) {
    modulesPromise = (async () => {
      const PROTOCOL = require('../src/shared/protocol');
      // Renderer modules read the protocol constants from this global, as in the page.
      globalThis.TunnelviewProtocol = PROTOCOL;
      const esm = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
      return {
        PROTOCOL,
        auth: require('../src/main/auth'),
        pairing: require('../src/main/pairing'),
        ipc: require('../src/main/ipc'),
        // Only the pure validator: nothing here may reach the native input backend.
        injector: require('../src/main/input')._internals,
        rtc: await esm('src/renderer/shared/rtc.js'),
        viewerValidate: await esm('src/renderer/viewer/validate.js'),
        reasons: await esm('src/renderer/viewer/reasons.js'),
        panelValidate: await esm('src/renderer/panel/validate.js'),
      };
    })();
  }
  return modulesPromise;
}

/**
 * Deep copy of `v`, throwing unless it is plain JSON. A value JSON cannot carry (undefined, NaN,
 * -0, a Buffer, a class instance) would silently turn into something else in the file.
 */
function plain(v, where = 'value') {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || Object.is(v, -0)) throw new TypeError(`${where}: ${v} is not representable in JSON`);
    return v;
  }
  if (Array.isArray(v)) return v.map((x, i) => plain(x, `${where}[${i}]`));
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (x === undefined) throw new TypeError(`${where}.${k} is undefined`);
      out[k] = plain(x, `${where}.${k}`);
    }
    return out;
  }
  throw new TypeError(`${where} is not plain JSON (${typeof v})`);
}

/** Normalizes a case list entry: an argument array, or {args, note}. */
function entry(item) {
  return Array.isArray(item) ? { args: item, note: null } : { args: item.args, note: item.note || null };
}

/** [{args, result, note?}] from calling `fn` (sync or async) with every argument list. */
async function cases(fn, list) {
  const out = [];
  for (const item of list) {
    const { args, note } = entry(item);
    const c = { args: plain(args, 'args') }; // copied before the call: a validator must not change it
    c.result = plain(await fn(...args), `result of ${JSON.stringify(c.args).slice(0, 80)}`);
    if (note) c.note = note;
    out.push(c);
  }
  return out;
}

/** [{args, error, note?}] for calls that must reject with an error code. */
async function errorCases(fn, list) {
  const out = [];
  for (const item of list) {
    const { args, note } = entry(item);
    const c = { args: plain(args, 'args') };
    let code = null;
    try {
      await fn(...args);
    } catch (e) {
      code = e && typeof e.code === 'string' ? e.code : null;
      if (!code) throw e;
    }
    if (!code) throw new Error(`expected a rejection for ${JSON.stringify(c.args).slice(0, 120)}`);
    c.error = code;
    if (note) c.note = note;
    out.push(c);
  }
  return out;
}

/**
 * Largest n in [lo, hi) the real code accepts, for a limit that is not exported. `accepts` must be
 * monotone; the range must bracket the limit, so a limit that moved out of it fails loudly.
 */
function largest(accepts, lo, hi) {
  if (!accepts(lo) || accepts(hi)) throw new Error(`probe range [${lo}, ${hi}] does not bracket the limit`);
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (accepts(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = canonical(v[k]);
    return out;
  }
  return v;
}

const NON_ASCII_RE = /[\u007f-\uffff]/g;

/** Canonical file text (see the header). */
function serialize(obj) {
  const text = JSON.stringify(canonical(plain(obj)), null, 2)
    .replace(NON_ASCII_RE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `${text}\n`;
}

const b64 = (buf) => buf.toString('base64');
const run = (first, n) => Buffer.from(Array.from({ length: n }, (_, i) => (first + i) & 0xff));
const hmacB64 = (key, message) => crypto.createHmac('sha256', key).update(message, 'utf8').digest('base64');
const toBase64Url = (s) => s.replace(/\+/g, '-').replace(/\//g, '_');

/** The same bytes with a non-zero padding bit: what a strict decoder must refuse. */
function nonCanonicalB64(s) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const i = s.search(/=+$/) - 1;
  if (i < 0) throw new Error('nonCanonicalB64 needs padding');
  const out = s.slice(0, i) + ALPHABET[ALPHABET.indexOf(s[i]) + 1] + s.slice(i + 1);
  if (!Buffer.from(out, 'base64').equals(Buffer.from(s, 'base64'))) throw new Error('nonCanonicalB64 changed the bytes');
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * auth-v2.json — src/main/auth.js (ARCHITECTURE §4 Auth)
 * ---------------------------------------------------------------------------------------------- */

// The published protocol vectors (mobile protocol notes §3.6.3): salt = bytes 00..0f,
// nonce = bytes 10..2f, the default KDF.
const DOC_SALT = b64(run(0x00, 16));
const DOC_NONCE = b64(run(0x10, 32));
const DOC_BINDING = { hostId: 'nHOSTabc123CNTRL', viewerId: 'nVIEWxyz789CNTRL' };
const FAST_KDF = { N: 16384, r: 8, p: 1, keylen: 32 }; // the least work validateKdf accepts

async function authVectors({ PROTOCOL, auth }) {
  const { CONTEXT, KDF_DEFAULT, KDF_LIMITS } = PROTOCOL.AUTH;
  const VECTOR_2 = { key: '8RxkFwPyAulJPnkf0MXWcuxeIqFWiOezhMMYHxoNiXk=', proof: 'A+x4LqT9YsfifsfP7iPTwaSU8oWlHeEm3cB//9527SE=' };
  const specs = [
    { name: 'protocol 3.6.3 vector 1', password: 'correct horse battery staple', salt: DOC_SALT, kdf: KDF_DEFAULT, nonce: DOC_NONCE, ...DOC_BINDING,
      pinned: { key: 'eo40JB24mNWRdcaWU4xBdGepdf/laQaEJfFhiNMVnFg=', proof: 'XIc59V892Z5TTBp3wSmxmA2Cdc3hZ2XeUeaFeCD0ujE=' } },
    { name: 'protocol 3.6.3 vector 2 (decomposed e-acute, Thai)', password: 'Cafe\u0301 \u0e44\u0e17\u0e22', salt: DOC_SALT, kdf: KDF_DEFAULT, nonce: DOC_NONCE, ...DOC_BINDING, pinned: VECTOR_2 },
    { name: 'NFC: the precomposed e-acute gives vector 2', password: 'Caf\u00e9 \u0e44\u0e17\u0e22', salt: DOC_SALT, kdf: KDF_DEFAULT, nonce: DOC_NONCE, ...DOC_BINDING, pinned: VECTOR_2 },
    { name: 'astral characters, numeric node IDs (Headscale)', password: 'p\u00e4ssw\u00f6rd \ud83d\udd11 \u5bc6\u7801', salt: b64(run(0x40, 16)), kdf: FAST_KDF, nonce: b64(run(0x80, 32)), hostId: '12', viewerId: '7' },
    { name: 'limits: 1024-unit password, 64-byte salt, 16-byte nonce, 64-character IDs, p = 2', password: `${'pass-'.repeat(204)}word`, salt: b64(run(0xc0, 64)), kdf: { N: 16384, r: 8, p: 2, keylen: 32 }, nonce: b64(run(0xa0, 16)),
      hostId: `h-_${'Ab9'.repeat(20)}x`, viewerId: `v${'Zz0_-'.repeat(12)}abc` },
  ];
  const proofs = [];
  for (const s of specs) {
    const binding = { hostId: s.hostId, viewerId: s.viewerId };
    const pw = Buffer.from(s.password.normalize('NFC'), 'utf8');
    const { N, r, p, keylen } = s.kdf;
    const key = crypto.scryptSync(pw, Buffer.from(s.salt, 'base64'), keylen, { N, r, p, maxmem: auth.SCRYPT_MAXMEM });
    const message = `${CONTEXT}${s.nonce}|${s.hostId}|${s.viewerId}`;
    const proof = await auth.computeProof(s.password, { salt: s.salt, kdf: s.kdf }, s.nonce, binding);
    const stored = { salt: s.salt, N, r, p, keylen, key: b64(key) };
    // `key` and `message` are only worth shipping if they are exactly what auth.js computes.
    if (hmacB64(key, message) !== proof || !auth.verifyProof(stored, s.nonce, proof, binding)
      || auth.verifyProof(stored, s.nonce, proof, { hostId: s.viewerId, viewerId: s.hostId })) {
      throw new Error(`${s.name}: the derived key or message does not reproduce auth.computeProof`);
    }
    if (s.pinned && (s.pinned.key !== b64(key) || s.pinned.proof !== proof)) {
      throw new Error(`${s.name}: auth.js no longer produces the published protocol vector`);
    }
    proofs.push({
      name: s.name, password: s.password, passwordNfcUtf8Hex: pw.toString('hex'), salt: s.salt, kdf: { N, r, p, keylen },
      nonce: s.nonce, hostId: s.hostId, viewerId: s.viewerId, key: b64(key), message, proof,
    });
  }

  // test/auth.test.js's fixed vector: a stored key without a password.
  const T = { hostId: 'nHoSt1234CNTRL', viewerId: 'nV1ewer567CNTRL' };
  const tKey = Buffer.alloc(32, 0x11);
  const tNonce = b64(Buffer.alloc(32, 0x22));
  const tStored = { salt: b64(Buffer.alloc(16, 0x33)), ...FAST_KDF, key: b64(tKey) };
  const tMessage = `${CONTEXT}${tNonce}|${T.hostId}|${T.viewerId}`;
  const tProof = hmacB64(tKey, tMessage);
  if (tProof !== 'xvxr3gGEkhZ1evAYiFYNgw1qM/T0yQgaGJaDelvsEc4=' || !auth.verifyProof(tStored, tNonce, tProof, T)) {
    throw new Error('the test/auth.test.js fixed vector no longer verifies');
  }
  // Proofs that are right except for one thing, so each refusal has exactly one cause.
  const proofOver = (nonce, hostId = T.hostId, viewerId = T.viewerId) => hmacB64(tKey, `${CONTEXT}${nonce}|${hostId}|${viewerId}`);
  const shortNonce = 'AAAAAAAAAAAAAAAAAAAA'; // 15 bytes
  const oddNonce = nonCanonicalB64(tNonce);

  const good = { password: 'never-hashed', params: { salt: DOC_SALT, kdf: FAST_KDF }, nonce: DOC_NONCE, binding: DOC_BINDING };
  const bad = (patch, note) => {
    const o = { ...good, ...patch };
    return { args: [o.password, o.params, o.nonce, o.binding], note };
  };
  const weakKdf = { N: 8192, r: 8, p: 1, keylen: 32 };

  const grid = [];
  for (let log2N = 13; log2N <= 18; log2N++) {
    for (const r of [1, 4, 8, 16]) for (const p of [1, 4]) grid.push([{ N: 2 ** log2N, r, p, keylen: 32 }]);
  }

  return {
    about: `Password proofs (protocol v2) from src/main/auth.js. proofs: full derivations; a viewer must reproduce key = scrypt(UTF-8(NFC(password)), base64-decoded salt, kdf) and proof = base64(HMAC-SHA256(key, message)), where message = context + nonce + "|" + hostId + "|" + viewerId and the nonce stays the base64 string. hmacVectors: proofs from a stored password record (stored = what the host keeps; proof = base64(HMAC-SHA256(base64-decoded stored.key, message))). functions: the auth.js function of that name. Regenerate with node ${SELF}.`,
    format: FORMAT,
    context: CONTEXT,
    kdfDefault: { ...KDF_DEFAULT },
    kdfLimits: { ...KDF_LIMITS },
    minKdfWork: auth.MIN_KDF_WORK,
    scryptMaxmem: auth.SCRYPT_MAXMEM,
    maxAttemptsPerConnection: PROTOCOL.AUTH.MAX_ATTEMPTS_PER_CONNECTION,
    proofs,
    hmacVectors: [{ name: 'test/auth.test.js fixed v2 vector', stored: tStored, nonce: tNonce, ...T, message: tMessage, proof: tProof }],
    functions: {
      validateKdf: {
        about: 'validateKdf(kdf) -> bool. The viewer runs it on hello.auth.kdf before any scrypt.',
        cases: await cases(auth.validateKdf, [
          { args: [KDF_DEFAULT], note: 'the default (32 MiB)' },
          { args: [FAST_KDF], note: 'the least work accepted: N*r = 2^17' },
          [{ N: 16384, r: 16, p: 1, keylen: 32 }],
          [{ N: 32768, r: 8, p: 4, keylen: 32 }],
          [{ N: 65536, r: 4, p: 1, keylen: 32 }],
          { args: [{ N: 262144, r: 1, p: 1, keylen: 32 }], note: 'N above 2^17' },
          { args: [{ N: 16384, r: 17, p: 1, keylen: 32 }], note: 'r above 16' },
          { args: [{ N: 32768, r: 8, p: 5, keylen: 32 }], note: 'p above 4' },
          { args: [{ N: 32768, r: 8, p: 1, keylen: 64 }], note: 'keylen must be 32' },
          { args: [{ N: 131072, r: 16, p: 4, keylen: 32 }], note: 'scrypt would need more than 64 MiB' },
          { args: [{ N: 65536, r: 8, p: 1, keylen: 32 }], note: 'scrypt would need more than 64 MiB' },
          [{ N: 131072, r: 8, p: 1, keylen: 32 }],
          [{ N: 131072, r: 4, p: 1, keylen: 32 }],
          [{ N: 65536, r: 16, p: 1, keylen: 32 }],
          { args: [{ N: 131072, r: 1, p: 1, keylen: 32 }], note: 'N must stay below 2^(16*r)' },
          { args: [weakKdf], note: 'too little work: a rogue host could crack the proof cheaply' },
          [{ N: 1024, r: 8, p: 1, keylen: 32 }],
          [{ N: 2, r: 1, p: 1, keylen: 32 }],
          { args: [{ N: 30000, r: 8, p: 1, keylen: 32 }], note: 'not a power of two' },
          { args: [{ N: 32768, r: 8.5, p: 1, keylen: 32 }], note: 'not an integer' },
          { args: [{ N: '32768', r: 8, p: 1, keylen: 32 }], note: 'a string is not a number' },
          [{ N: 32768, r: 0, p: 1, keylen: 32 }],
          [{ N: 32768, r: 8, p: 0, keylen: 32 }],
          [{ N: -32768, r: 8, p: 1, keylen: 32 }],
          { args: [{ N: 2 ** 53, r: 8, p: 1, keylen: 32 }], note: 'not a safe integer' },
          { args: [{ N: 32768, r: 8, p: 1 }], note: 'keylen missing' },
          { args: [{ N: 32768, r: 8, p: 1, keylen: 32, maxmem: 1 }], note: 'other keys are ignored' },
          [{}],
          [null],
          ['x'],
          [[]],
          [32768],
          ...grid,
        ]),
      },
      normalizeBinding: {
        about: 'normalizeBinding({hostId, viewerId}) -> {hostId, viewerId} or null. Both must be Tailscale StableNodeIDs, /^[A-Za-z0-9_-]{1,64}$/, compared exactly.',
        cases: await cases(auth.normalizeBinding, [
          [DOC_BINDING],
          { args: [{ hostId: '12', viewerId: '7' }], note: 'numeric IDs (Headscale)' },
          { args: [{ hostId: 'n_A-1', viewerId: 'x'.repeat(64), extra: 1 }], note: 'other keys are dropped' },
          [{ hostId: 'x'.repeat(65), viewerId: 'v' }],
          [{ hostId: '', viewerId: 'v' }],
          [{ hostId: 'h', viewerId: '' }],
          [{ hostId: 'h' }],
          [{ hostId: 42, viewerId: 'v' }],
          { args: [{ hostId: 'a|b', viewerId: 'v' }], note: '"|" separates the fields of the HMAC message' },
          [{ hostId: 'h', viewerId: 'has space' }],
          [{ hostId: ' h', viewerId: 'v' }],
          { args: [{ hostId: '100.101.102.103', viewerId: 'v' }], note: 'an IP is not a node ID' },
          [{ hostId: 'n\u00c4', viewerId: 'v' }],
          [{ hostIp: '100.101.102.103', viewerIp: '100.90.5.6' }],
          [{}],
          [null],
          ['x'],
        ]),
      },
      decodeB64: {
        about: 'decodeB64(s, minBytes, maxBytes): strict, canonical standard base64 (salt 16..64, nonce 16..64, proof 32..32). Result: the bytes as lower-case hex, or null.',
        cases: await cases((s, min, max) => {
          const buf = auth.decodeB64(s, min, max);
          return buf ? buf.toString('hex') : null;
        }, [
          [b64(Buffer.alloc(32, 7)), 32, 32],
          [DOC_SALT, 16, 64],
          { args: [b64(run(0, 64)), 16, 64], note: '64 bytes: the longest salt or nonce' },
          [b64(run(0, 65)), 16, 64],
          [b64(run(0, 15)), 16, 64],
          { args: ['AAAA', 4, 8], note: '3 bytes is below the minimum' },
          ['AAA=', 1, 8],
          ['AA==', 1, 8],
          { args: ['AAB=', 1, 8], note: 'non-zero padding bits' },
          ['AB==', 1, 8],
          { args: [nonCanonicalB64(DOC_SALT), 16, 64], note: 'non-zero padding bits' },
          { args: ['AA-_', 1, 8], note: 'base64url is not accepted' },
          ['AAAA\n', 1, 8],
          [' AAAA', 1, 8],
          ['AAA', 1, 8],
          ['', 0, 8],
          ['====', 1, 8],
          ['A===', 1, 8],
          ['AA=A', 1, 8],
          [null, 1, 8],
          [42, 1, 8],
        ]),
      },
      computeProof: {
        about: 'computeProof(password, {salt, kdf}, nonceB64, {hostId, viewerId}) rejects with error.code before running scrypt. The checks run in this order: binding, kdf, salt, nonce, password.',
        cases: await errorCases(auth.computeProof, [
          bad({ binding: null }),
          bad({ binding: { hostId: 'a|b', viewerId: 'nV' } }),
          bad({ binding: { hostId: DOC_BINDING.hostId } }),
          bad({ binding: null, params: { salt: DOC_SALT, kdf: { N: 2 ** 20, r: 8, p: 1, keylen: 32 } } }, 'the binding is checked first'),
          bad({ params: null }),
          bad({ params: { salt: DOC_SALT, kdf: null } }),
          bad({ params: { salt: DOC_SALT, kdf: weakKdf } }),
          bad({ params: { salt: 'bad!', kdf: weakKdf } }, 'kdf before salt'),
          bad({ params: { salt: 'bad!', kdf: FAST_KDF } }),
          bad({ params: { salt: b64(Buffer.alloc(15)), kdf: FAST_KDF } }, 'salt below 16 bytes'),
          bad({ params: { salt: b64(Buffer.alloc(65)), kdf: FAST_KDF } }, 'salt above 64 bytes'),
          bad({ params: { salt: toBase64Url(b64(Buffer.alloc(16, 0xfb))), kdf: FAST_KDF } }, 'base64url salt'),
          bad({ params: { salt: nonCanonicalB64(DOC_SALT), kdf: FAST_KDF } }, 'non-canonical salt'),
          bad({ params: { salt: 'bad!', kdf: FAST_KDF }, nonce: 'nope' }, 'salt before nonce'),
          bad({ nonce: 'nope' }),
          bad({ nonce: shortNonce }, 'nonce below 16 bytes'),
          bad({ nonce: `${DOC_NONCE}\n` }),
          bad({ nonce: 'nope', password: '' }, 'nonce before password'),
          bad({ password: '' }),
          bad({ password: 123 }),
          bad({ password: 'x'.repeat(1025) }, 'longer than 1024 UTF-16 units'),
        ]),
      },
      verifyProof: {
        about: 'verifyProof(stored, nonceB64, proofB64, {hostId, viewerId}) -> bool: the host side. stored = {salt, N, r, p, keylen, key}.',
        cases: await cases(auth.verifyProof, [
          { args: [tStored, tNonce, tProof, T], note: 'test/auth.test.js fixed vector' },
          { args: [tStored, tNonce, tProof, { hostId: T.viewerId, viewerId: T.hostId }], note: 'IDs swapped' },
          { args: [tStored, tNonce, tProof, { hostId: T.hostId, viewerId: 'nMALLORY' }], note: 'relayed by another node: the host sees the relay as the viewer' },
          { args: [tStored, tNonce, tProof, { hostId: T.hostId.toLowerCase(), viewerId: T.viewerId }], note: 'node IDs are case-sensitive' },
          { args: [tStored, tNonce, proofOver(tNonce, '100.101.102.103', '100.90.5.6'), T], note: 'bound to IPs instead of node IDs' },
          { args: [tStored, tNonce, hmacB64(tKey, `Tunnelview-auth-v1|${tNonce}`), T], note: 'a protocol v1 proof' },
          { args: [tStored, tNonce, toBase64Url(tProof), T], note: 'base64url proof' },
          [tStored, tNonce, '', T],
          [tStored, tNonce, 'not base64!', T],
          [tStored, tNonce, tProof.slice(0, -4), T],
          [tStored, tNonce, `${tProof}AAAA`, T],
          [tStored, tNonce, b64(Buffer.alloc(16)), T],
          [tStored, tNonce, b64(Buffer.alloc(33)), T],
          { args: [tStored, shortNonce, proofOver(shortNonce), T], note: 'nonce below 16 bytes (the proof matches it)' },
          { args: [tStored, oddNonce, proofOver(oddNonce), T], note: 'non-canonical nonce (the proof matches it)' },
          { args: [tStored, tNonce, tProof, null], note: 'no binding' },
          { args: [{ ...tStored, N: 3 }, tNonce, tProof, T], note: 'stored KDF invalid' },
          { args: [{ ...tStored, key: 'short' }, tNonce, tProof, T], note: 'stored key invalid' },
          [{}, tNonce, tProof, T],
        ]),
      },
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * addresses.json — src/renderer/shared/rtc.js address and candidate filters (ARCHITECTURE §1.5)
 * ---------------------------------------------------------------------------------------------- */

async function addressVectors({ PROTOCOL, rtc }) {
  const line = (addr, tail = 'typ host generation 0') => `candidate:1 1 udp 2122260223 ${addr} 47810 ${tail}`;
  const LONG = 'candidate:1 1 udp 2122260223 100.64.0.1 47801 typ host generation 0 ufrag ';
  const ofLength = (n) => LONG + 'u'.repeat(n - LONG.length);
  const ice = (candidate) => ({ candidate, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' });
  return {
    about: `Tailscale address and ICE candidate filters from src/renderer/shared/rtc.js. protocol: the constants they derive from (TS_IPV6_PREFIX = the first 48 bits). Regenerate with node ${SELF}.`,
    format: FORMAT,
    protocol: { TS_IPV4_CIDR: PROTOCOL.TS_IPV4_CIDR, TS_IPV6_PREFIX: PROTOCOL.TS_IPV6_PREFIX },
    functions: {
      isTailscaleAddress: {
        about: 'isTailscaleAddress(addr) -> bool: inside 100.64.0.0/10 or fd7a:115c:a1e0::/48. Brackets, a zone id, surrounding spaces and IPv4-mapped IPv6 are accepted; names never are.',
        cases: await cases(rtc.isTailscaleAddress, [
          ['100.64.0.0'], ['100.64.0.1'], ['100.100.100.100'], ['100.127.255.255'],
          ['100.63.255.255'], ['100.128.0.0'], ['10.0.0.1'], ['192.168.1.20'], ['127.0.0.1'], ['0.0.0.0'], ['8.8.8.8'],
          { args: ['100.64.0.01'], note: 'leading zero (octal ambiguity)' },
          ['100.64.0'], ['100.64.0.1.5'], ['100.64.0.256'], ['100.64.0.-1'],
          { args: ['100.64.0.1:47800'], note: 'a port is not part of an address' },
          ['fd7a:115c:a1e0::'], ['fd7a:115c:a1e0::1'], ['fd7a:115c:a1e0:ab12:4843:cd96:6258:b240'], ['fd7a:115c:a1e0:0:0:0:0:1'],
          { args: ['FD7A:115C:A1E0::1'], note: 'hex digits in either case' },
          { args: ['fd7a:115c:a1e0::0.0.0.1'], note: 'embedded dotted IPv4 tail' },
          ['[fd7a:115c:a1e0::1]'], ['fd7a:115c:a1e0::1%utun3'], ['[fd7a:115c:a1e0::1%eth0]'],
          { args: ['100.64.0.1%eth0'], note: 'a zone id is stripped from IPv4 too' },
          { args: ['[100.64.0.1]'], note: 'brackets around IPv4 are stripped' },
          { args: [' 100.64.0.1 '], note: 'surrounding spaces are trimmed' },
          { args: [`${' '.repeat(60)}100.64.0.1`], note: 'longer than 64 characters before trimming' },
          ['::ffff:100.64.0.1'], ['::ffff:6440:1'], ['::ffff:10.0.0.1'], ['::ffff:100.128.0.1'],
          { args: ['64:ff9b::100.64.0.1'], note: 'NAT64 is not IPv4-mapped' },
          ['fd7a:115c:a1e1::1'],
          { args: ['fd7a:115c:a1e::1'], note: 'a1e is 0a1e' },
          { args: ['fd7a::115c::1'], note: 'two "::"' },
          ['fd7a:115c:a1e0:0:0:0:0:0:1'], ['fd7a:115c:a1e0::12345'], ['fd7a:115c:a1e0:::1'],
          ['fe80::1'], ['::1'], ['::'],
          ['[fd7a:115c:a1e0::1'], ['[]'], [''], ['abc.local'], ['redacted-ip.invalid'],
          [null], [42],
        ]),
      },
      candidateAddress: {
        about: 'candidateAddress(line) -> the 5th field of "candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...", or null. An "a=" prefix is allowed; fields split on any whitespace run; at most 2048 characters.',
        cases: await cases(rtc.candidateAddress, [
          [`${line('100.101.102.103')} ufrag abc`],
          [`a=${line('100.101.102.103', 'typ host')}`],
          [line('fd7a:115c:a1e0::1234')],
          [line('3f2a1c4e-aaaa-bbbb-cccc-0123456789ab.local')],
          ['candidate:5 1 udp 1686052607 203.0.113.9 47814 typ srflx raddr 0.0.0.0 rport 0'],
          ['candidate:1 1 tcp 1518280447 100.64.0.1 9 typ host tcptype active generation 0'],
          ['  candidate:1 1 udp 1 100.64.0.1 47801 typ host  '],
          ['candidate:1  1 udp 1 100.64.0.1 47801 typ host'],
          ['candidate:1\t1\tudp\t1\t100.64.0.1\t47801\ttyp\thost'],
          { args: ['candidate: 1 udp 1 100.64.0.1 47801 typ host'], note: 'empty foundation: the fields still line up' },
          ['candidate:1 1 udp 1 100.64.0.1 47801 host'],
          ['candidate:1 1 udp 1 100.64.0.1 47801 typ'],
          ['candidate:1 1 udp 1 100.64.0.1 47801 TYP host'],
          ['A=candidate:1 1 udp 1 100.64.0.1 47801 typ host'],
          [ofLength(2048)],
          [ofLength(2049)],
          [''], ['foo'], ['a=candidate'], [null], [42],
        ]),
      },
      isAllowedCandidate: {
        about: 'isAllowedCandidate(init) -> bool. null, a missing or empty candidate (end of candidates) -> true; otherwise candidateAddress must be a Tailscale IP.',
        cases: await cases(rtc.isAllowedCandidate, [
          [null], [{}], [{ candidate: '' }], [{ candidate: null }],
          [ice(line('100.101.102.103'))],
          [ice(line('fd7a:115c:a1e0::1234'))],
          [ice(`a=${line('100.64.0.1')}`)],
          [ice(line('::ffff:100.64.0.1'))],
          [ice(line('192.168.1.20'))],
          [ice(line('3f2a1c4e-aaaa-bbbb-cccc-0123456789ab.local'))],
          [ice('candidate:5 1 udp 1686052607 203.0.113.9 47814 typ srflx raddr 0.0.0.0 rport 0')],
          [ice(line('100.64.0.01'))],
          [ice(line('127.0.0.1'))],
          [ice('candidate:1 1 udp 1 100.64.0.1 47801 host')],
          [{ candidate: 5 }],
          [line('100.64.0.1')],
          [42],
        ]),
      },
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * tailnet-path.json — rtc.verifyTailnetPath on getStats() reports (ARCHITECTURE §1.5 path rule)
 * ---------------------------------------------------------------------------------------------- */

/** A peer connection whose getStats() returns `spec.stats` (in order), or fails. */
function statsPc(spec) {
  return {
    async getStats() {
      if (spec.getStatsFails) throw new Error('getStats failed');
      return new Map(spec.stats.map((s) => [s.id, s]));
    },
  };
}

async function pathVectors({ rtc }) {
  const transport = (pairId = 'CP') => ({ id: 'T', type: 'transport', selectedCandidatePairId: pairId });
  const pair = (extra = {}) => ({ id: 'CP', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', ...extra });
  const local = (fields = {}) => ({ id: 'L', type: 'local-candidate', protocol: 'udp', candidateType: 'host', ...fields });
  const remote = (fields = {}) => ({ id: 'R', type: 'remote-candidate', protocol: 'udp', candidateType: 'prflx', ...fields });
  const selected = (l, r) => ({ stats: [transport(), pair(), local(l), remote(r)] });
  const at = (spec, note) => ({ args: [spec], note });
  const ok = { address: '100.64.1.2' };
  return {
    about: `rtc.verifyTailnetPath(pc) for getStats() reports, from src/renderer/shared/rtc.js. args[0].stats is the report as an ordered list of stats objects keyed by id (order matters: the first match wins); args[0].getStatsFails means getStats() rejects. The phone applies a stricter local rule on top (its own tun IPs only); these vectors are the desktop rule. Regenerate with node ${SELF}.`,
    format: FORMAT,
    functions: {
      verifyTailnetPath: {
        about: 'verifyTailnetPath(pc) -> {ok, local, remote, pair, protocol, localType, remoteType}. A present local address must be a Tailscale IP literal (a missing one is allowed); a remote IP literal must be a Tailscale IP; a remote with no address or a host name is unknown and allowed; anything else fails. No selected pair or a failing getStats -> ok with pair:false.',
        cases: await cases((spec) => rtc.verifyTailnetPath(statsPc(spec)), [
          at(selected(ok, { address: '' }), 'getStats hides a peer-reflexive remote address: unknown, allowed'),
          at(selected(ok, { address: 'redacted-ip.invalid' }), "Chromium's redacted peer-reflexive placeholder"),
          at(selected(ok, { address: '100.101.102.103', candidateType: 'host' })),
          at(selected({ address: 'fd7a:115c:a1e0::1' }, { address: '[fd7a:115c:a1e0:ab12::2]' })),
          at(selected(ok, { address: '[100.64.0.2]' })),
          at(selected(ok, { address: '192.168.1.5' })),
          at(selected({ address: '192.168.1.5' }, { address: '100.64.0.2' }), 'a LAN local end paired with a 100.x remote could reach a CGNAT impostor'),
          at(selected({ address: 'abc.local' }, { address: '100.64.0.2' }), 'a local host name fails'),
          at(selected({ address: 'redacted-ip.invalid' }, { address: '100.64.0.2' })),
          at(selected({}, { address: '100.64.0.2' }), 'getStats may omit the local address'),
          at(selected({ address: '' }, { address: '100.64.0.2' })),
          at(selected({ ip: '10.1.2.3' }, {}), 'legacy `ip` field'),
          at(selected({ ip: '100.64.0.5' }, { ip: '100.64.0.6' })),
          at(selected(ok, { address: null, ip: '192.168.0.1' }), 'a null address falls back to `ip`'),
          at(selected(ok, { address: '', ip: '192.168.0.1' }), 'an empty address does not fall back to `ip`'),
          at(selected(ok, { address: 'abcd-1234.local' }), 'mDNS name: unknown, allowed'),
          at(selected(ok, { address: 'example.com.' })),
          at(selected(ok, { address: 'bad_name.local' }), 'not a host name: fails'),
          at(selected(ok, { address: '1234' }), 'a host name needs a letter'),
          at(selected(ok, { address: '100.64.0.01' }), 'malformed numeric address'),
          at(selected(ok, { address: 'fd7a::115c::1' }), 'malformed numeric address'),
          at(selected(ok, { address: 'fe80::1%en0' })),
          at(selected({ address: 'fd7a:115c:a1e0::1%utun4' }, { address: 'fd7a:115c:a1e0::2' })),
          at(selected(ok, { address: '100.128.0.1' })),
          at(selected(ok, { address: '8.8.8.8', candidateType: 'srflx' })),
          at(selected({ address: '100.64.1.2', protocol: 'tcp', candidateType: 'relay' }, { address: '100.64.0.2', candidateType: 'host' })),
          at(selected({ address: '100.64.1.2', protocol: '' }, { address: '100.64.0.2' }), 'an empty protocol is reported as null'),
          at({ stats: [] }),
          at({ getStatsFails: true }),
          at({ stats: [pair({ selected: true }), local(ok), remote({ address: '100.64.0.2' })] }, 'no transport: a pair with selected:true'),
          at({ stats: [pair({ nominated: true, state: 'succeeded' }), local(ok), remote({ address: '100.64.0.2' })] }, 'no transport: a nominated, succeeded pair'),
          at({ stats: [pair({ nominated: true, state: 'in-progress' }), local({ address: '192.168.1.5' }), remote()] }, 'not selected: not checked'),
          at({ stats: [transport('MISSING'), pair({ selected: true }), local({ address: '192.168.1.5' }), remote({ address: '100.64.0.2' })] }, 'a dangling selectedCandidatePairId falls back to the selected pair'),
          at({ stats: [
            { id: 'CP1', type: 'candidate-pair', localCandidateId: 'L1', remoteCandidateId: 'R1', nominated: true, state: 'succeeded' },
            { id: 'CP2', type: 'candidate-pair', localCandidateId: 'L2', remoteCandidateId: 'R2', nominated: true, state: 'succeeded' },
            local({ id: 'L1', address: '192.168.1.5' }), remote({ id: 'R1', address: '100.64.0.2' }),
            local({ id: 'L2', address: '100.64.1.2' }), remote({ id: 'R2', address: '100.64.0.2' }),
          ] }, 'two nominated pairs and no transport: the first in report order is checked'),
          at({ stats: [transport(), pair()] }, 'candidate stats missing from the report'),
          at({ stats: [
            { id: 'C1', type: 'codec', mimeType: 'video/H264' },
            { id: 'I1', type: 'inbound-rtp', kind: 'video', bytesReceived: 1000 },
            transport(), pair(), local(ok), remote({ address: '100.64.0.2' }),
          ] }, 'other stats are ignored'),
        ]),
      },
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * validate.json — src/renderer/viewer/validate.js (what a viewer accepts from a host)
 * ---------------------------------------------------------------------------------------------- */

const OFFER_LINES = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'a=mid:0',
  'a=candidate:1 1 udp 2122260223 100.101.102.103 47810 typ host generation 0',
  'a=candidate:2 1 udp 2122194687 192.168.1.20 47811 typ host generation 0',
  'a=candidate:3 1 udp 2122129151 fd7a:115c:a1e0::1234 47812 typ host generation 0',
  'a=candidate:4 1 udp 2122063615 3f2a1c4e-aaaa-bbbb-cccc-0123456789ab.local 47813 typ host generation 0',
  'a=candidate:5 1 udp 1686052607 203.0.113.9 47814 typ srflx raddr 0.0.0.0 rport 0',
  'a=end-of-candidates',
  '',
];

async function validateVectors({ rtc, viewerValidate: v }) {
  const OFFER = OFFER_LINES.join('\r\n');
  const iceMsg = (c) => ({ t: 'ice', candidate: c });
  const cand = { candidate: 'candidate:1 1 udp 1 100.64.0.1 47801 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'abcd' };
  const disp = (id, extra = {}) => ({ id, name: 'Display', primary: false, width: 1920, height: 1080, scaleFactor: 1, ...extra });
  const displays = (list, current = list[0] && list[0].id) => ({ t: 'displays', displays: list, current });
  const clip = (text, part) => (part === undefined ? { t: 'clipboard', kind: 'text', text } : { t: 'clipboard', kind: 'text', text, part });
  const part = (extra = {}) => ({ id: 'abc_-9', seq: 0, last: true, ...extra });

  // Limits the module keeps private, found by probing it.
  const sig = (m) => v.validateSignal(m) !== null;
  const ctl = (m) => v.validateControl(m) !== null;
  const many = (n) => Array.from({ length: n }, (_, i) => disp(`d${i}`));
  const limits = {
    sdpMaxLength: largest((n) => sig({ t: 'sdp', description: { type: 'offer', sdp: `v=0${'a'.repeat(n - 3)}` } }), 3, 8 * 1024 * 1024),
    candidateMaxLength: largest((n) => sig(iceMsg({ ...cand, candidate: 'c'.repeat(n) })), 0, 1e6),
    sdpMidMaxLength: largest((n) => sig(iceMsg({ ...cand, sdpMid: 'm'.repeat(n) })), 0, 1e6),
    usernameFragmentMaxLength: largest((n) => sig(iceMsg({ ...cand, usernameFragment: 'u'.repeat(n) })), 0, 1e6),
    sdpMLineIndexMax: largest((n) => sig(iceMsg({ ...cand, sdpMLineIndex: n })), 0, 1e6),
    displaysMax: v.validateControl(displays(many(1000))).displays.length,
    displayIdMaxLength: largest((n) => v.validateControl(displays([disp('i'.repeat(n))])).displays.length === 1, 1, 1e6),
    displayNameMaxCodePoints: Array.from(v.validateControl(displays([disp('a', { name: 'n'.repeat(1000) })])).displays[0].name).length,
    clipboardTextMaxLength: largest((n) => ctl(clip('x'.repeat(n))), 0, 1e6),
    clipboardPartTextMaxLength: largest((n) => ctl(clip('x'.repeat(n), part())), 1, 1e6),
    clipboardMaxParts: largest((n) => ctl(clip('x', part({ seq: n }))), 0, 1e6) + 1,
    chatMaxLength: largest((n) => ctl({ t: 'chat', text: 'x'.repeat(n), ts: 1 }), 1, 1e6),
  };

  return {
    about: `What a viewer accepts from a host, from src/renderer/viewer/validate.js: signaling relayed from the host and control data-channel messages. null = ignore the message. limits: maxima the module enforces (lengths in UTF-16 units), measured by probing it; the cases stay below them. Regenerate with node ${SELF}.`,
    format: FORMAT,
    limits,
    functions: {
      validateSignal: {
        about: 'validateSignal(msg) -> the clean message or null. The viewer is always the answerer: only offers are accepted. Shapes only; addresses are filtered by isAllowedCandidate.',
        cases: await cases(v.validateSignal, [
          [{ t: 'sdp', description: { type: 'offer', sdp: OFFER } }],
          { args: [{ t: 'sdp', description: { type: 'offer', sdp: 'v=0\r\n', extra: 1 }, extra: true }], note: 'unknown fields are dropped' },
          [{ t: 'sdp', description: { type: 'answer', sdp: OFFER } }],
          [{ t: 'sdp', description: { type: 'pranswer', sdp: OFFER } }],
          [{ t: 'sdp', description: { type: 'offer', sdp: 'x' } }],
          [{ t: 'sdp', description: { type: 'offer', sdp: ' v=0' } }],
          [{ t: 'sdp', description: { type: 'offer', sdp: '' } }],
          [{ t: 'sdp', description: { type: 'offer', sdp: 42 } }],
          [{ t: 'sdp', description: 'v=0' }],
          [{ t: 'sdp' }],
          [iceMsg(null)],
          { args: [{ t: 'ice' }], note: 'a missing candidate is end of candidates' },
          { args: [iceMsg({ ...cand, extra: 'x' })], note: 'unknown fields are dropped' },
          { args: [iceMsg({ candidate: cand.candidate, sdpMid: '0' })], note: 'usernameFragment defaults to null' },
          [iceMsg({ candidate: cand.candidate, sdpMid: null, sdpMLineIndex: 0 })],
          { args: [iceMsg({ candidate: cand.candidate })], note: 'neither sdpMid nor sdpMLineIndex: unroutable' },
          { args: [iceMsg({ candidate: '' })], note: 'end of candidates of one generation' },
          { args: [iceMsg({ ...cand, candidate: 'candidate:2 1 udp 2122194687 192.168.1.20 47811 typ host generation 0' })], note: 'shape only: the address filter is separate' },
          [iceMsg({ ...cand, candidate: 5 })],
          [iceMsg({ ...cand, sdpMLineIndex: -1 })],
          [iceMsg({ ...cand, sdpMLineIndex: 1.5 })],
          [iceMsg({ ...cand, sdpMLineIndex: '0' })],
          [iceMsg({ ...cand, sdpMid: 7 })],
          [iceMsg({ ...cand, usernameFragment: 7 })],
          [iceMsg('candidate:1 1 udp 1 100.64.0.1 47801 typ host')],
          [iceMsg([])],
          [{ t: 'bye', reason: 'x' }],
          [{ t: 'SDP', description: { type: 'offer', sdp: OFFER } }],
          [null], [[]], ['sdp'],
        ]),
      },
      sanitizeSdp: {
        about: 'sanitizeSdp(sdp, isAllowedCandidate): drops every a=candidate line whose address is not a Tailscale IP; lines are joined with CRLF. A non-string gives "".',
        cases: await cases((sdp) => v.sanitizeSdp(sdp, rtc.isAllowedCandidate), [
          [OFFER],
          { args: [OFFER_LINES.join('\n')], note: 'LF in, CRLF out' },
          ['v=0\r\na=candidate:bogus\r\na=mid:0'],
          [''],
          [42],
        ]),
      },
      validateControl: {
        about: 'validateControl(msg) -> the clean control-channel message from the host, or null. Types a viewer only sends (select-display, quality) and unknown types -> null.',
        cases: await cases(v.validateControl, [
          [displays([
            disp('2528732444', { name: 'DELL U2720Q', primary: true, width: 3840, height: 2160, scaleFactor: 1.5 }),
            disp('2779098405', { name: 'Built-in Retina Display', width: 2560, height: 1600, scaleFactor: 2 }),
          ])],
          { args: [displays([disp(1), disp(2)], 2)], note: 'numeric ids become strings' },
          { args: [displays([disp('a', { name: 'first' }), disp('a', { name: 'second' })])], note: 'duplicate ids: the first wins' },
          { args: [displays([null, disp(''), disp('x'.repeat(129)), disp(2 ** 53), disp(true), { id: 'ok' }], 'ok')], note: 'unusable entries are skipped; default names count the kept ones' },
          [displays([disp('x'.repeat(128))])],
          [displays([
            disp('w0', { width: 0, height: -5 }), disp('w1', { width: 65537, height: 65536 }),
            disp('w2', { width: 1920.6, height: '1080' }), disp('s0', { scaleFactor: 0.2 }), disp('s1', { scaleFactor: 0.25 }),
            disp('s2', { scaleFactor: 8 }), disp('s3', { scaleFactor: 8.5 }), disp('s4', { scaleFactor: '2' }),
          ])],
          [displays([
            disp('n0', { name: 'Evil\u202eDisplay' }), disp('n1', { name: 'Tab\tName\u0000\u200b' }), disp('n2', { name: '  padded  ' }),
            disp('n3', { name: 'n'.repeat(200) }), disp('n4', { name: '\ud83d\ude00'.repeat(70) }), disp('n5', { name: '\u202e\u200f' }),
            disp('n6', { name: 42 }), disp('n7', { name: null }), disp('n8', { primary: 'true' }),
          ], 'n3')],
          { args: [displays(many(33))], note: 'at most 32 displays' },
          [displays([disp('a')], 'missing')],
          [displays([disp('a')], null)],
          [{ t: 'displays', displays: [disp('a')] }],
          [displays([disp('a')], { id: 'a' })],
          [{ t: 'displays', displays: 'a', current: 'a' }],
          [{ t: 'displays' }],
          [clip('hello')],
          [clip('')],
          { args: [{ ...clip('hello'), extra: 1 }], note: 'unknown fields are dropped' },
          [{ t: 'clipboard', kind: 'image', text: 'x' }],
          [{ t: 'clipboard', text: 'x' }],
          [clip(42)],
          [clip('part', { ...part({ seq: 0, last: false }), extra: 1 })],
          [clip('part', part({ seq: 15 }))],
          [clip('part', part({ seq: 16 }))],
          [clip('part', part({ seq: -1 }))],
          [clip('part', part({ seq: 1.5 }))],
          [clip('part', part({ id: '' }))],
          [clip('part', part({ id: 'x'.repeat(33) }))],
          [clip('part', part({ id: 'a b' }))],
          [clip('part', part({ last: 'true' }))],
          [clip('', part())],
          { args: [clip('part', null)], note: 'a part that is present must be valid' },
          [{ t: 'chat', text: 'hi', ts: 1700000000000 }],
          [{ t: 'chat', text: '  hi  ', ts: 0 }],
          [{ t: 'chat', text: '\r\nline1\r\nline2\t\u0007', ts: -1 }],
          [{ t: 'chat', text: 'bidi \u202eevil\u2066', ts: '1' }],
          [{ t: 'chat', text: '   ' }],
          [{ t: 'chat', text: 42 }],
          [{ t: 'host-state', audio: true, controlAllowed: false, inputBlocked: null }],
          [{ t: 'host-state', audio: false, controlAllowed: true, inputBlocked: 'secure-desktop' }],
          [{ t: 'host-state', inputBlocked: 'elevated-window' }],
          [{ t: 'host-state', audio: 'yes', controlAllowed: 1, inputBlocked: 'other' }],
          [{ t: 'host-state' }],
          [{ t: 'select-display', id: '1' }],
          [{ t: 'quality', preset: 'speed' }],
          [{ t: 'unknown' }],
          [{ t: 5 }],
          [{}], [null], [[]], ['displays'],
        ]),
      },
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * reasons.json — src/renderer/viewer/reasons.js (end-of-session texts)
 * ---------------------------------------------------------------------------------------------- */

async function reasonVectors({ PROTOCOL, reasons }) {
  const src = fs.readFileSync(path.join(ROOT, 'src/renderer/viewer/reasons.js'), 'utf8');
  const body = src.slice(src.indexOf('export function describeClose'));
  // Every reason with its own text, straight from the switch, so a new one is never missed; every
  // protocol deny reason too, in case one is added without a text of its own.
  const labels = [...body.matchAll(/case '([^']+)':/g)].map((m) => m[1]);
  if (labels.length < 20) throw new Error('found too few describeClose cases in reasons.js');
  const denied = Object.values(PROTOCOL.DENY).map((r) => `denied:${r}`);
  const ctx = { host: 'office-pc', user: 'Alice Example' };
  const reasonsList = [...new Set([...labels, ...denied, 'denied:not-a-real-reason', 'not-a-real-reason', ''])];
  const describe = [
    ...reasonsList.map((r) => [r, ctx]),
    ...reasonsList.map((r) => ({ args: [r, null], note: 'no context: the default names' })),
    [null, ctx],
    { args: ['network', { ...ctx, hadVideo: true }], note: 'the session had started' },
    ['connection-lost', { ...ctx, hadVideo: false }],
    { args: ['denied:password-required', { ...ctx, passwordSet: false }], note: 'the host has no password yet' },
    ['denied:password-required', { ...ctx, passwordSet: true }],
    { args: ['denied:locked', { ...ctx, message: 'Too many failed password attempts. Try again in 29 seconds.' }], note: "the retry sentence comes from main's status message" },
    ['denied:try-later', { ...ctx, message: 'Not taking requests right now. Try again in about 2 minutes.' }],
    ['denied:try-later', { ...ctx, message: 'Try again in 1 second.' }],
    ['denied:try-later', { ...ctx, message: 'no retry sentence here' }],
  ];
  return {
    about: `End-of-session texts from src/renderer/viewer/reasons.js. describeClose covers every reason the module has a case for, with and without a context ({host, user, hadVideo?, passwordSet?, message?}); icon is a desktop icon name. hostReasons: host bye reasons that replace "host-ended" (effectiveCloseReason). Regenerate with node ${SELF}.`,
    format: FORMAT,
    hostReasons: [...reasons.HOST_REASONS].sort(),
    functions: {
      describeClose: {
        about: 'describeClose(reason, ctx) -> {tone, icon, title, message, detail?}. detail: "" = the message says it all (no detail line); absent = show main\'s status message as detail.',
        cases: await cases(reasons.describeClose, describe),
      },
      effectiveCloseReason: {
        about: 'effectiveCloseReason(reason, hostReason) -> the reason to describe: hostReason when reason is "host-ended" and hostReason is one of hostReasons.',
        cases: await cases(reasons.effectiveCloseReason, [
          ...[...reasons.HOST_REASONS].sort().map((h) => ['host-ended', h]),
          ['host-ended', 'panel-closed'],
          ['host-ended', null],
          ['host-ended', 42],
          ['network', 'capture-failed'],
          ['denied:busy', 'host-stopped'],
        ]),
      },
      retrySentence: {
        about: 'retrySentence(message) -> the first "Try again in ...." sentence of a status message, or "".',
        cases: await cases(reasons.retrySentence, [
          ['Too many failed password attempts from this device or your Tailscale account. Try again in 15 minutes.'],
          [' Try again in 29 seconds.'],
          ['x Try again in about 2 minutes. Try again in 5 seconds.'],
          ['Try again later'],
          [''],
          [null],
        ]),
      },
      controlBlockReason: {
        about: 'controlBlockReason(state) -> why remote control is unavailable, the end of "View only - ..."; "" = available.',
        cases: await cases(reasons.controlBlockReason, [
          [{ control: true, controlAllowed: true, unstable: false, videoStalled: false, inputOpen: true, host: 'office-pc' }],
          [{ control: false, controlAllowed: true, inputOpen: true, host: 'office-pc' }],
          [{ control: true, controlAllowed: false, inputOpen: true, host: 'office-pc' }],
          [{ control: true, controlAllowed: false, inputOpen: true }],
          [{ control: true, unstable: true, videoStalled: true, inputOpen: true }],
          [{ control: true, videoStalled: true, inputOpen: true }],
          [{ control: true, inputOpen: false }],
        ]),
      },
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * input-limits.json — the host's input validators (ARCHITECTURE §5 `input`)
 * ---------------------------------------------------------------------------------------------- */

async function inputVectors({ panelValidate, ipc, injector }) {
  // Every `input` message passes these in turn on the host: the panel renderer (data channel),
  // main's IPC handler (panel:input), then the injector. A viewer must stay inside all three.
  const stages = [['panel', panelValidate.sanitizeInput], ['ipc', ipc.sanitizeInput], ['injector', injector.validate]];
  const host = (msg) => stages.reduce((m, [, f]) => (m === null ? null : f(m)), msg);

  const measure = (f) => {
    const ok = (m) => f(m) !== null;
    const wheel = f({ t: 'wh', dx: 1e9, dy: -1e9 });
    if (!wheel || wheel.dy !== -wheel.dx) throw new Error('the wheel clamp is not symmetric');
    return {
      buttonMax: largest((b) => ok({ t: 'md', b, x: 0.5, y: 0.5, n: 1 }), 0, 1000),
      clickCountMax: f({ t: 'md', b: 0, x: 0.5, y: 0.5, n: 1e6 }).n,
      codeMaxLength: largest((n) => ok({ t: 'kd', code: 'A'.repeat(n), key: '' }), 1, 1000),
      comboMaxCodes: largest((n) => ok({ t: 'combo', codes: Array(n).fill('KeyA') }), 1, 1000),
      keyMaxLength: largest((n) => f({ t: 'kd', code: 'KeyA', key: 'k'.repeat(n) }).key.length === n, 0, 1000),
      textMaxUnits: largest((n) => ok({ t: 'txt', text: 'a'.repeat(n) }), 1, 1e6),
      wheelMaxAbs: wheel.dx,
    };
  };
  const md = (extra) => ({ t: 'md', b: 0, x: 0.5, y: 0.5, ...extra });
  const kd = (extra) => ({ t: 'kd', code: 'KeyA', key: 'a', ...extra });
  const codes = (n) => ['ControlLeft', 'ShiftLeft', 'AltLeft', 'MetaLeft', 'KeyA', 'KeyB', 'KeyC', 'KeyD'].slice(0, n);

  return {
    about: `Limits of the host's input validators: stages.panel = sanitizeInput in src/renderer/panel/validate.js, stages.ipc = sanitizeInput in src/main/ipc.js, stages.injector = validate in src/main/input/index.js. host = all three in that order, which is what a viewer's messages must fit (lengths in UTF-16 units; out-of-range values are clamped, not refused, where a stage clamps). Measured by probing the real functions. Regenerate with node ${SELF}.`,
    format: FORMAT,
    host: measure(host),
    stages: Object.fromEntries(stages.map(([name, f]) => [name, measure(f)])),
    functions: {
      hostInput: {
        about: 'One input data-channel message through panel, ipc and injector in turn -> what the host injects, or null (dropped).',
        cases: await cases(host, [
          [{ t: 'mm', x: 0.25, y: 0.75 }],
          { args: [{ t: 'mm', x: -1, y: 2 }], note: 'points are clamped into [0, 1]' },
          [{ t: 'mm', x: '0.5', y: 0.5 }],
          [{ t: 'mm', x: 0.5 }],
          [md({ n: 1 })],
          [md({ n: 2 })],
          [md({ n: 3 })],
          { args: [md({ n: 4 })], note: 'the click count clamps at 3, it does not wrap' },
          [md({})],
          [md({ n: 0 })],
          [md({ n: 2.5 })],
          [{ t: 'mu', b: 2, x: 1, y: 0, n: 1 }],
          [md({ b: 4, n: 1 })],
          [md({ b: 5, n: 1 })],
          [md({ b: -1, n: 1 })],
          [md({ b: 1.5, n: 1 })],
          [{ t: 'wh', dx: 0, dy: 120 }],
          [{ t: 'wh', dx: -40.5, dy: 0 }],
          [{ t: 'wh', dx: 15000, dy: -15000 }],
          { args: [{ t: 'wh', dy: 120 }], note: 'dx and dy are both required' },
          [kd({ rep: false })],
          [kd({ key: 'A', rep: true, locks: { caps: true, num: false } })],
          [{ t: 'kd', code: 'Numpad1', key: '1', locks: { caps: false } }],
          { args: [kd({ locks: { caps: 'yes' } })], note: 'malformed locks are dropped, the key stays' },
          [kd({ rep: 'yes' })],
          [kd({ code: '' })],
          [kd({ code: 'Key-A' })],
          [kd({ code: 'X'.repeat(33) })],
          { args: [kd({ key: 'k'.repeat(33) })], note: 'an overlong key becomes ""' },
          [{ t: 'kd', code: 'KeyA' }],
          [{ t: 'ku', code: 'ShiftLeft', key: 'Shift' }],
          [{ t: 'ku', code: 'KeyA', key: 'a', locks: { caps: true } }],
          [{ t: 'txt', text: 'hello' }],
          [{ t: 'txt', text: '\u0e2a\u0e27\u0e31\u0e2a\u0e14\u0e35' }],
          [{ t: 'txt', text: 'line1\nline2\ttab' }],
          { args: [{ t: 'txt', text: `${'a'.repeat(1998)}\ud83d\ude00` }], note: '2000 UTF-16 units' },
          { args: [{ t: 'txt', text: `${'a'.repeat(1999)}\ud83d\ude00` }], note: '2001 UTF-16 units (2000 code points)' },
          [{ t: 'txt', text: '' }],
          [{ t: 'txt', text: 42 }],
          [{ t: 'combo', codes: ['ControlLeft', 'AltLeft', 'Delete'] }],
          [{ t: 'combo', codes: codes(6) }],
          [{ t: 'combo', codes: codes(7) }],
          [{ t: 'combo', codes: [] }],
          [{ t: 'combo', codes: ['KeyA', 5] }],
          [{ t: 'combo', codes: 'KeyA' }],
          [{ t: 'release-all' }],
          [{ t: 'release-all', extra: 1 }],
          [{ t: 'unknown' }],
          [{}],
          [null],
          ['mm'],
        ]),
      },
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Fixed Ed25519 keys and connection values for ident / pair / links / fingerprint (DECISIONS D8)
 * ---------------------------------------------------------------------------------------------- */

// PKCS8 DER of an Ed25519 private key is this prefix followed by the 32-byte seed (RFC 8410).
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** {seed, pkcs8, privateKey, pub}: the same Ed25519 key on every run. */
function ed25519FromSeed(seed) {
  if (!Buffer.isBuffer(seed) || seed.length !== 32) throw new Error('an Ed25519 seed is 32 bytes');
  const pkcs8 = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const privateKey = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  if (!spki.subarray(0, SPKI_ED25519_PREFIX.length).equals(SPKI_ED25519_PREFIX)) throw new Error('unexpected SPKI encoding');
  return { seed, pkcs8, privateKey, pub: Buffer.from(spki.subarray(SPKI_ED25519_PREFIX.length)) };
}

// RFC 8032 section 7.1, TEST 1 and TEST 2: the seed -> key -> signature path is standard Ed25519.
const RFC8032 = [
  {
    name: 'RFC 8032 7.1 TEST 1', seed: '9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60',
    pub: 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', message: '',
    sig: 'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
  },
  {
    name: 'RFC 8032 7.1 TEST 2', seed: '4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb',
    pub: '3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', message: '72',
    sig: '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
  },
];

const HOST_KEY = ed25519FromSeed(run(0x20, 32)); // "this computer"
const OTHER_KEY = ed25519FromSeed(run(0x60, 32)); // another computer
const CNONCE = b64(run(0x40, 32)); // the phone's client nonce on this connection
const CNONCE_2 = b64(run(0x50, 32)); // ... and on another connection
const HOST_ID = DOC_BINDING.hostId;
const PHONE_ID = 'nPHONEp1x2CNTRL';
const RELAY_ID = 'nMALLORYm1CNTRL'; // a tailnet node relaying between the phone and the host
const TOKEN = run(0x70, 16);
const b64url = (buf) => buf.toString('base64url');
const ED25519_L = (1n << 252n) + 27742317777372353535851937790883648493n; // the group order

/** The same signature with S replaced by S + L: equal modulo L, refused by RFC 8032 verification. */
function malleated(sigB64) {
  const sig = Buffer.from(sigB64, 'base64');
  let s = 0n;
  for (let i = 31; i >= 0; i--) s = (s << 8n) | BigInt(sig[32 + i]);
  s += ED25519_L;
  const out = Buffer.from(sig);
  for (let i = 0; i < 32; i++) { out[32 + i] = Number(s & 0xffn); s >>= 8n; }
  if (s !== 0n) throw new Error('S + L does not fit');
  return b64(out);
}

/** The same bytes as base64url `s` (no padding) with non-zero unused bits in the last character. */
function nonCanonicalB64url(s) {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  if (s.length % 4 === 0) throw new Error('nonCanonicalB64url needs a partial last group');
  const i = s.length - 1;
  const out = s.slice(0, i) + ALPHABET[ALPHABET.indexOf(s[i]) + 1];
  if (!Buffer.from(out, 'base64url').equals(Buffer.from(s, 'base64url'))) throw new Error('nonCanonicalB64url changed the bytes');
  return out;
}

/* ------------------------------------------------------------------------------------------------
 * ident.json — hello.ident (pairing.identBytes / verifyIdent / validCnonce, DECISIONS D2)
 * ---------------------------------------------------------------------------------------------- */

async function identVectors({ PROTOCOL, pairing }) {
  for (const r of RFC8032) {
    const k = ed25519FromSeed(Buffer.from(r.seed, 'hex'));
    if (k.pub.toString('hex') !== r.pub || crypto.sign(null, Buffer.from(r.message, 'hex'), k.privateKey).toString('hex') !== r.sig) {
      throw new Error(`${r.name}: Node no longer reproduces the RFC 8032 vector`);
    }
  }
  const keys = [['host', HOST_KEY], ['other', OTHER_KEY]];
  const sign = (key, nonce, cnonce, hostId, viewerId) => ({
    v: 1, alg: 'ed25519', hostId, viewerId, cnonce,
    sig: b64(crypto.sign(null, pairing.identBytes(nonce, cnonce, hostId, viewerId), key.privateKey)),
  });
  // A hello as host-server.js sends it (no password set), with `ident` added.
  const hello = (ident, nonce = DOC_NONCE) => {
    const h = {
      t: 'hello', protocol: PROTOCOL.PROTOCOL_VERSION, app: PROTOCOL.APP_ID, version: '0.3.0',
      host: { hostname: 'office-pc', os: 'windows', user: { login: 'alice@example.com', displayName: 'Alice' } },
      auth: { passwordSet: false, acceptMode: 'ask', salt: null, kdf: null, nonce, autoAccept: false, passwordLocked: false },
    };
    if (ident !== undefined) h.ident = ident;
    return h;
  };
  const good = sign(HOST_KEY, DOC_NONCE, CNONCE, HOST_ID, PHONE_ID);
  const expect = { cnonce: CNONCE, hostId: HOST_ID, viewerId: PHONE_ID };
  const pub = b64url(HOST_KEY.pub);
  const withIdent = (patch) => hello({ ...good, ...patch });
  const without = (key) => { const i = { ...good }; delete i[key]; return hello(i); };
  const flipped = (() => { const s = Buffer.from(good.sig, 'base64'); s[5] ^= 0x01; return b64(s); })();
  const desktop = sign(HOST_KEY, DOC_NONCE, null, HOST_ID, 'nDESKTOPv1CNTRL');

  return {
    about: `hello.ident from src/main/pairing.js (protocol 2, optional field). The host signs signedText = context + hello.auth.nonce + "|" + (cnonce or "") + "|" + hostId + "|" + viewerId (UTF-8) with its Ed25519 identity key; the signature is standard base64 of 64 bytes, keys are raw 32 bytes in base64url without padding. keys: fixed test keys from 32-byte seeds (PKCS8 = the RFC 8410 prefix + seed). rfc8032: standard Ed25519 known answers the port must reproduce. functions.verifyIdent args = [pub (base64url), hello, expect?]; reasons in check order: no-ident, malformed, bad-signature, cnonce-mismatch, host-mismatch, viewer-mismatch. Not covered on purpose: small-order public keys (Ed25519 libraries differ there; a real host key never is one). Regenerate with node ${SELF}.`,
    format: FORMAT,
    context: PROTOCOL.IDENT.CONTEXT,
    alg: PROTOCOL.IDENT.ALG,
    version: PROTOCOL.IDENT.VERSION,
    clientNonceHeader: PROTOCOL.CLIENT_NONCE_HEADER,
    clientNonceBytes: PROTOCOL.CLIENT_NONCE_BYTES,
    keys: keys.map(([name, k]) => ({ name, seedHex: k.seed.toString('hex'), pkcs8: b64(k.pkcs8), pub: b64url(k.pub), pubHex: k.pub.toString('hex') })),
    rfc8032: RFC8032.map((r) => ({ ...r })),
    signatures: [
      { name: 'phone connection', key: 'host', nonce: DOC_NONCE, cnonce: CNONCE, hostId: HOST_ID, viewerId: PHONE_ID },
      { name: 'desktop viewer (no client nonce)', key: 'host', nonce: DOC_NONCE, cnonce: null, hostId: HOST_ID, viewerId: 'nDESKTOPv1CNTRL' },
      { name: 'numeric node IDs (Headscale), 16-byte nonce', key: 'other', nonce: b64(run(0x90, 16)), cnonce: CNONCE_2, hostId: '12', viewerId: '7' },
    ].map((s) => {
      const key = s.key === 'host' ? HOST_KEY : OTHER_KEY;
      const bytes = pairing.identBytes(s.nonce, s.cnonce, s.hostId, s.viewerId);
      return { ...s, signedText: bytes.toString('utf8'), sig: b64(crypto.sign(null, bytes, key.privateKey)) };
    }),
    functions: {
      identBytes: {
        about: 'identBytes(nonce, cnonce, hostId, viewerId) -> the signed text (its UTF-8 bytes are what is signed). nonce: canonical base64 of 16..64 bytes; cnonce: null or canonical base64 of 32 bytes; IDs: /^[A-Za-z0-9_-]{1,64}$/. Errors, checked in argument order: BAD_NONCE, BAD_CNONCE, BAD_BINDING.',
        cases: [
          ...await cases((...a) => pairing.identBytes(...a).toString('utf8'), [
            [DOC_NONCE, CNONCE, HOST_ID, PHONE_ID],
            { args: [DOC_NONCE, null, HOST_ID, PHONE_ID], note: 'no client nonce (desktop viewer): an empty field' },
            { args: [b64(run(0x90, 16)), CNONCE, '12', '7'], note: '16-byte nonce, numeric node IDs' },
            [b64(run(0x00, 64)), CNONCE_2, 'h'.repeat(64), 'v-_9'.repeat(16)],
          ]),
          ...await errorCases(pairing.identBytes, [
            ['', CNONCE, HOST_ID, PHONE_ID],
            { args: [b64(run(0, 15)), CNONCE, HOST_ID, PHONE_ID], note: 'nonce below 16 bytes' },
            { args: [b64(run(0, 65)), CNONCE, HOST_ID, PHONE_ID], note: 'nonce above 64 bytes' },
            { args: [nonCanonicalB64(DOC_NONCE), CNONCE, HOST_ID, PHONE_ID], note: 'non-canonical nonce' },
            { args: [toBase64Url(b64(Buffer.alloc(32, 0xfb))), CNONCE, HOST_ID, PHONE_ID], note: 'base64url nonce' },
            [null, CNONCE, HOST_ID, PHONE_ID],
            { args: [DOC_NONCE, '', HOST_ID, PHONE_ID], note: 'an empty string is not "no client nonce"' },
            [DOC_NONCE, b64(run(0, 31)), HOST_ID, PHONE_ID],
            [DOC_NONCE, b64(run(0, 33)), HOST_ID, PHONE_ID],
            [DOC_NONCE, nonCanonicalB64(CNONCE), HOST_ID, PHONE_ID],
            [DOC_NONCE, CNONCE.slice(0, -1), HOST_ID, PHONE_ID],
            [DOC_NONCE, 42, HOST_ID, PHONE_ID],
            { args: [DOC_NONCE, CNONCE, 'a|b', PHONE_ID], note: '"|" separates the fields' },
            [DOC_NONCE, CNONCE, HOST_ID, ''],
            [DOC_NONCE, CNONCE, HOST_ID, 'x'.repeat(65)],
            [DOC_NONCE, null, null, PHONE_ID],
            { args: ['bad', 'bad', 'a|b', PHONE_ID], note: 'the nonce is checked first' },
            { args: [DOC_NONCE, 'bad', 'a|b', PHONE_ID], note: 'then the client nonce' },
          ]),
        ],
      },
      validCnonce: {
        about: `validCnonce(value) -> bool: the ${PROTOCOL.CLIENT_NONCE_HEADER} header value and ident.cnonce: canonical standard base64 of exactly 32 bytes (44 characters, one "="). The host answers HTTP 400 to a malformed header.`,
        cases: await cases(pairing.validCnonce, [
          [CNONCE], [b64(Buffer.alloc(32))], [b64(Buffer.alloc(32, 0xff))],
          { args: [nonCanonicalB64(CNONCE)], note: 'non-zero padding bits' },
          { args: [CNONCE.slice(0, -1)], note: 'padding missing' },
          { args: [toBase64Url(b64(Buffer.alloc(32, 0xfb)))], note: 'base64url' },
          [b64(run(0, 31))], [b64(run(0, 33))], [b64(run(0, 16))],
          [` ${CNONCE}`], [`${CNONCE}\n`], [''], [null], [42],
        ]),
      },
      verifyIdent: {
        about: 'verifyIdent(pub, hello, expect?) -> {ok:true, reason:null, hostId, viewerId, cnonce} or {ok:false, reason}. expect = what the viewer knows ({cnonce, hostId, viewerId}); a key that is present is compared exactly. Unknown ident fields are ignored; cnonce must be present (a string or null). A pub that is not 32 bytes is a caller bug: error BAD_KEY.',
        cases: [
          ...await cases((p, h, e) => pairing.verifyIdent(Buffer.from(p, 'base64url'), h, e), [
            { args: [pub, hello(good), expect], note: 'a phone connection' },
            { args: [pub, hello(good)], note: 'nothing to compare' },
            { args: [pub, hello(desktop), { cnonce: null, hostId: HOST_ID }], note: 'a desktop viewer: no client nonce' },
            { args: [b64url(OTHER_KEY.pub), hello(sign(OTHER_KEY, b64(run(0x90, 16)), CNONCE_2, '12', '7'), b64(run(0x90, 16))), { cnonce: CNONCE_2, hostId: '12', viewerId: '7' }], note: 'numeric node IDs, 16-byte nonce' },
            { args: [pub, withIdent({ note: 'x', ext: { a: 1 } }), expect], note: 'unknown ident fields are ignored' },
            { args: [pub, hello(undefined), expect], note: 'no ident: a host older than 0.3, or a 0.3+ host whose key is unavailable right now (hello.version tells them apart)' },
            [pub, hello(null), expect],
            [pub, null, expect], [pub, 'hello', expect], [pub, [], expect],
            [pub, hello('signed'), expect],
            [pub, hello([good]), expect],
            [pub, withIdent({ v: 2 }), expect],
            [pub, withIdent({ v: '1' }), expect],
            [pub, withIdent({ alg: 'ed448' }), expect],
            [pub, without('alg'), expect],
            [pub, without('sig'), expect],
            { args: [pub, without('cnonce'), expect], note: 'cnonce must be sent, as null when absent' },
            [pub, without('viewerId'), expect],
            [pub, withIdent({ hostId: 'a|b' }), expect],
            [pub, withIdent({ cnonce: '' }), expect],
            [pub, withIdent({ cnonce: b64(run(0, 31)) }), expect],
            { args: [pub, withIdent({ sig: good.sig.slice(0, -4) }), expect], note: 'signature too short' },
            { args: [pub, withIdent({ sig: toBase64Url(good.sig).replace(/=+$/, '') }), expect], note: 'base64url without padding' },
            { args: [pub, withIdent({ sig: b64(Buffer.from(good.sig, 'base64').subarray(0, 63)) }), expect], note: '63 bytes' },
            { args: [pub, withIdent({ sig: nonCanonicalB64(good.sig) }), expect], note: 'non-zero padding bits' },
            { args: [pub, (() => { const h = hello(good); delete h.auth; return h; })(), expect], note: 'no hello.auth: no nonce' },
            [pub, { ...hello(good), auth: { ...hello(good).auth, nonce: toBase64Url(b64(Buffer.alloc(32, 0xfb))) } }, expect],
            { args: [b64url(OTHER_KEY.pub), hello(good), expect], note: 'another computer\'s key' },
            { args: [pub, withIdent({ sig: flipped }), expect], note: 'one bit of R flipped' },
            { args: [pub, withIdent({ sig: malleated(good.sig) }), expect], note: 'S + L: the same signature modulo L; RFC 8032 requires S < L' },
            { args: [pub, hello(good, b64(run(0xa0, 32))), expect], note: 'the hello nonce differs from the signed one' },
            { args: [pub, withIdent({ viewerId: PHONE_ID.toLowerCase() }), expect], note: 'a signed field changed' },
            { args: [pub, withIdent({ cnonce: CNONCE_2 }), expect], note: 'a signed field changed' },
            { args: [pub, withIdent({ cnonce: null }), expect], note: 'the client nonce dropped' },
            { args: [pub, hello(sign(HOST_KEY, DOC_NONCE, CNONCE_2, HOST_ID, PHONE_ID)), expect], note: 'authentic, but signed for another connection (replayed)' },
            { args: [pub, hello(sign(HOST_KEY, DOC_NONCE, CNONCE, 'nOTHERhost1CNTRL', PHONE_ID)), expect], note: 'signed by the pinned key for another host ID' },
            { args: [pub, hello(sign(HOST_KEY, DOC_NONCE, CNONCE, HOST_ID, RELAY_ID)), expect], note: 'relay: a node M forwarded the phone\'s client nonce, so the host saw M as the viewer' },
            { args: [pub, hello(sign(HOST_KEY, DOC_NONCE, CNONCE_2, HOST_ID, RELAY_ID)), expect], note: 'several mismatches: the first in check order wins' },
            { args: [b64url(OTHER_KEY.pub), hello(sign(HOST_KEY, DOC_NONCE, CNONCE_2, HOST_ID, RELAY_ID)), expect], note: 'a bad signature comes before any mismatch' },
            { args: [pub, hello(good), { viewerId: PHONE_ID, extra: 'ignored' }], note: 'only cnonce, hostId and viewerId are compared' },
          ]),
          ...await errorCases((p, h, e) => pairing.verifyIdent(Buffer.from(p, 'base64url'), h, e), [
            [b64url(HOST_KEY.pub.subarray(0, 31)), hello(good), expect],
            [b64url(Buffer.concat([HOST_KEY.pub, Buffer.alloc(1)])), hello(good), expect],
          ]),
        ],
      },
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * pair.json — pair proofs (pairing.pairMessage / pairProof / verifyPairProof, DECISIONS D4)
 * ---------------------------------------------------------------------------------------------- */

async function pairVectors({ PROTOCOL, pairing }) {
  const t = b64url(TOKEN);
  const at = (args) => [t, ...args];
  const conn = [DOC_NONCE, CNONCE, HOST_ID, PHONE_ID];
  const proof = pairing.pairProof(TOKEN, ...conn);
  const proofs = [
    { name: 'a phone pairing', token: TOKEN, nonce: DOC_NONCE, cnonce: CNONCE, hostId: HOST_ID, viewerId: PHONE_ID },
    { name: 'numeric node IDs, 64-byte nonce', token: run(0xe0, 16), nonce: b64(run(0x00, 64)), cnonce: CNONCE_2, hostId: '12', viewerId: '7' },
  ].map((p) => {
    const message = `${PROTOCOL.PAIR.CONTEXT}${p.nonce}|${p.cnonce}|${p.hostId}|${p.viewerId}`;
    const out = pairing.pairProof(p.token, p.nonce, p.cnonce, p.hostId, p.viewerId);
    if (pairing.pairMessage(p.nonce, p.cnonce, p.hostId, p.viewerId) !== message || hmacB64(p.token, message) !== out) {
      throw new Error(`${p.name}: pairProof is not HMAC-SHA256(token, message)`);
    }
    return { ...p, token: b64url(p.token), tokenHex: p.token.toString('hex'), message, proof: out };
  });
  const verify = (token, proofB64, ...rest) => pairing.verifyPairProof(Buffer.from(token, 'base64url'), proofB64, ...rest);

  return {
    about: `Pair proofs from src/main/pairing.js: proof = base64(HMAC-SHA256(token, message)), message = context + nonce + "|" + cnonce + "|" + hostId + "|" + viewerId, where token is the 16 bytes from the link's "t", nonce = hello.auth.nonce, cnonce = the phone's client nonce (required), hostId = the link's / ident's host ID, viewerId = ident.viewerId (the phone as the host sees it). Token arguments are base64url without padding. Every refusal is answered {t:"pair-result", ok:false, reason:"${PROTOCOL.PAIR.FAILED}"}; ${PROTOCOL.PAIR.MAX_FAILURES} wrong proofs burn the offer. Regenerate with node ${SELF}.`,
    format: FORMAT,
    context: PROTOCOL.PAIR.CONTEXT,
    tokenBytes: PROTOCOL.PAIR.TOKEN_BYTES,
    ttlMs: PROTOCOL.PAIR.TTL_MS,
    maxFailures: PROTOCOL.PAIR.MAX_FAILURES,
    failedReason: PROTOCOL.PAIR.FAILED,
    messages: { pair: PROTOCOL.MSG.PAIR, pairResult: PROTOCOL.MSG.PAIR_RESULT },
    proofs,
    functions: {
      pairMessage: {
        about: 'pairMessage(nonce, cnonce, hostId, viewerId) -> the HMAC message. Errors in argument order: BAD_NONCE, BAD_CNONCE (also when it is null: pairing needs a client nonce), BAD_BINDING.',
        cases: [
          ...await cases(pairing.pairMessage, [conn, [b64(run(0x00, 64)), CNONCE_2, '12', '7']]),
          ...await errorCases(pairing.pairMessage, [
            { args: [DOC_NONCE, null, HOST_ID, PHONE_ID], note: 'no client nonce: pairing is refused' },
            [DOC_NONCE, '', HOST_ID, PHONE_ID],
            [DOC_NONCE, b64(run(0, 31)), HOST_ID, PHONE_ID],
            [b64(run(0, 15)), CNONCE, HOST_ID, PHONE_ID],
            [DOC_NONCE, CNONCE, HOST_ID, 'a|b'],
            [DOC_NONCE, CNONCE, '', PHONE_ID],
          ]),
        ],
      },
      pairProof: {
        about: 'pairProof(token, nonce, cnonce, hostId, viewerId) -> base64 proof (44 characters). Errors: BAD_TOKEN (not 16 bytes) first, then as pairMessage.',
        cases: [
          ...await cases((tok, ...rest) => pairing.pairProof(Buffer.from(tok, 'base64url'), ...rest), [
            at(conn),
            [b64url(run(0xe0, 16)), b64(run(0x00, 64)), CNONCE_2, '12', '7'],
            { args: at([DOC_NONCE, CNONCE, PHONE_ID, HOST_ID]), note: 'IDs swapped: another proof' },
          ]),
          ...await errorCases((tok, ...rest) => pairing.pairProof(Buffer.from(tok, 'base64url'), ...rest), [
            [b64url(run(0x70, 15)), ...conn],
            [b64url(run(0x70, 17)), ...conn],
            { args: [b64url(run(0x70, 15)), 'bad', CNONCE, HOST_ID, PHONE_ID], note: 'the token is checked first' },
            at([DOC_NONCE, null, HOST_ID, PHONE_ID]),
          ]),
        ],
      },
      verifyPairProof: {
        about: 'verifyPairProof(token, proof, nonce, cnonce, hostId, viewerId) -> bool: the host side, in constant time; any malformed input is false (never an error). The host uses its own nonce, the connection\'s client nonce, its own ID and whois of the phone\'s address.',
        cases: await cases(verify, [
          [t, proof, ...conn],
          { args: [b64url(run(0x71, 16)), proof, ...conn], note: 'another offer\'s token' },
          { args: [t, proof, DOC_NONCE, CNONCE, HOST_ID, RELAY_ID], note: 'relayed: the host sees the relay node as the viewer' },
          { args: [t, proof, DOC_NONCE, CNONCE, PHONE_ID, HOST_ID], note: 'IDs swapped' },
          { args: [t, proof, DOC_NONCE, CNONCE_2, HOST_ID, PHONE_ID], note: 'another connection\'s client nonce' },
          { args: [t, proof, b64(run(0xa0, 32)), CNONCE, HOST_ID, PHONE_ID], note: 'another connection\'s hello nonce' },
          { args: [t, proof, DOC_NONCE, null, HOST_ID, PHONE_ID], note: 'no client nonce on this connection' },
          { args: [t, nonCanonicalB64(proof), ...conn], note: 'non-canonical proof encoding' },
          { args: [t, proof.replace(/=+$/, ''), ...conn], note: 'padding missing' },
          [t, `${proof}\n`, ...conn],
          [t, b64(Buffer.from(proof, 'base64').subarray(0, 31)), ...conn],
          [t, '', ...conn],
          [t, null, ...conn],
          [t, 42, ...conn],
          { args: [b64url(run(0x70, 15)), proof, ...conn], note: 'a 15-byte token' },
        ]),
      },
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * links.json — the pairing link (pairing.parseLink / encodeLink, DECISIONS D3)
 * ---------------------------------------------------------------------------------------------- */

async function linkVectors({ PROTOCOL, pairing }) {
  const PREFIX = PROTOCOL.PAIR.LINK_PREFIX;
  const KEYS = pairing.LINK_KEYS;
  const base = {
    v: 1, id: HOST_ID, n: 'office-pc.tail1234.ts.net', a: ['100.101.102.103', 'fd7a:115c:a1e0::1234:5678'],
    p: 47800, k: b64url(HOST_KEY.pub), t: b64url(TOKEN), x: 1762520000,
  };
  const label = (n, ch) => ch.repeat(n);
  const longName = [label(63, 'a'), label(63, 'b'), label(63, 'c'), label(61, 'd')].join('.'); // 253
  const worst = {
    v: 1, id: `n${'A'.repeat(63)}`, n: longName, a: ['100.127.255.255', 'fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff'],
    p: 65535, k: b64url(OTHER_KEY.pub), t: b64url(run(0xa5, 16)), x: Number.MAX_SAFE_INTEGER,
  };
  const valid = [
    ['a typical link', base],
    ['IPv4 only, no MagicDNS name', { ...base, n: '', a: ['100.64.0.1'] }],
    ['IPv6 only', { ...base, a: ['fd7a:115c:a1e0::1'] }],
    ['the longest: 253-character name, both families, 64-character id, port 65535, x = 2^53 - 1', worst],
    ['numeric node ID (Headscale), port 1024, x = 1', { ...base, id: '12', p: 1024, x: 1 }],
    ['a punycode label', { ...base, n: 'xn--caf-dma.office-pc' }],
    ['one label', { ...base, n: 'office-pc' }],
  ];
  // A link whose JSON has `obj`'s keys in canonical order (extra keys last), bypassing encodeLink.
  const ordered = (obj) => {
    const out = {};
    for (const k of KEYS) if (k in obj) out[k] = obj[k];
    for (const k of Object.keys(obj)) if (!KEYS.includes(k)) out[k] = obj[k];
    return out;
  };
  const rawBytes = (buf) => PREFIX + buf.toString('base64url');
  const raw = (text) => rawBytes(Buffer.from(text, 'utf8'));
  const mut = (patch) => raw(JSON.stringify(ordered({ ...base, ...patch })));
  const drop = (key) => { const o = { ...base }; delete o[key]; return raw(JSON.stringify(ordered(o))); };
  const link = pairing.encodeLink(base);
  const payload = link.slice(PREFIX.length);
  const json = JSON.stringify(base);
  const e9 = String.fromCharCode(0xe9);
  // The encoding cases need a payload whose last base64url group is partial (JSON length not a
  // multiple of 3): base with a name one or two characters longer.
  const partial = ['office-pc1', 'office-pc12'].map((h) => ({ ...base, n: `${h}.tail1234.ts.net` }))
    .map((o) => pairing.encodeLink(o)).find((l) => (l.length - PREFIX.length) % 4 !== 0);
  const partialPayload = partial.slice(PREFIX.length);
  const standardB64 = Buffer.from(partialPayload, 'base64url').toString('base64');
  if (!standardB64.endsWith('=')) throw new Error('the standard base64 case needs padding');

  const invalid = [
    // LINK_FORMAT
    [42], [null], [''],
    { args: [`tunnelview://pair/2/${payload}`], note: 'another link version' },
    { args: [link.replace('tunnelview://', 'TUNNELVIEW://')], note: 'the prefix is case-sensitive' },
    [`https://example.com/${payload}`],
    { args: [` ${link}`], note: 'leading whitespace' },
    { args: [PREFIX.slice(0, -1)], note: 'no "/" after the version' },
    { args: [PREFIX + 'A'.repeat(pairing.LINK_MAX_LENGTH)], note: `longer than ${pairing.LINK_MAX_LENGTH} characters` },
    // LINK_ENCODING
    { args: [PREFIX], note: 'no payload' },
    { args: [`${link} `], note: 'trailing whitespace' },
    [`${link}\n`],
    { args: [`${link}=`], note: 'padding' },
    { args: [PREFIX + payload.slice(0, 10) + ' ' + payload.slice(10)], note: 'whitespace inside' },
    { args: [PREFIX + standardB64], note: 'standard base64 with "=" padding' },
    { args: [PREFIX + nonCanonicalB64url(partialPayload)], note: 'non-zero unused bits in the last character' },
    { args: [`${partial}${'A'.repeat((5 - (partialPayload.length % 4)) % 4)}`], note: 'a length that leaves 6 bits over' },
    // LINK_JSON
    [raw('[1,2]')], [raw('null')], [raw('"x"')], [raw('{"v":1,')],
    { args: [rawBytes(Buffer.from([0x7b, 0x22, 0x76, 0x22, 0x3a, 0xff, 0x7d]))], note: 'not UTF-8' },
    { args: [rawBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(json)]))], note: 'a byte order mark' },
    // LINK_VERSION
    [mut({ v: 2 })], [mut({ v: '1' })], [mut({ v: 0 })], [drop('v')],
    // LINK_FIELDS
    { args: [mut({ z: 1 })], note: 'an unknown key' },
    { args: [raw(JSON.stringify(ordered(base)).replace('{', '{"__proto__":{},'))], note: 'a "__proto__" key is just an unknown key' },
    [drop('x')], [drop('t')], [drop('n')],
    // LINK_ID ... LINK_EXPIRY, in key order
    [mut({ id: '' })], [mut({ id: 'a|b' })], [mut({ id: 'x'.repeat(65) })], [mut({ id: 'n HOST' })], [mut({ id: 42 })],
    { args: [mut({ id: '100.101.102.103' })], note: 'an address is not a node ID' },
    { args: [mut({ n: 'Office-PC.tail1234.ts.net' })], note: 'upper case' },
    { args: [mut({ n: 'office-pc.tail1234.ts.net.' })], note: 'trailing dot' },
    [mut({ n: '.office-pc.tail1234.ts.net' })], [mut({ n: 'office-pc..ts.net' })],
    [mut({ n: '-office.ts.net' })], [mut({ n: 'office-.ts.net' })], [mut({ n: 'office_pc.ts.net' })],
    [mut({ n: `${label(64, 'a')}.ts.net` })],
    { args: [mut({ n: `${longName}e` })], note: '254 characters' },
    { args: [mut({ n: `caf${e9}.ts.net` })], note: 'not ASCII' },
    [mut({ n: 'office pc.ts.net' })], [mut({ n: null })], [mut({ n: 42 })],
    { args: [mut({ a: ['100.101.102.103', 'fd7a:115c:a1e0::1234:5678', 'fd7a:115c:a1e0::9'] })], note: 'three addresses' },
    { args: [mut({ a: ['100.101.102.103', '100.101.102.104'] })], note: 'two IPv4' },
    { args: [mut({ a: ['fd7a:115c:a1e0::1', 'fd7a:115c:a1e0::2'] })], note: 'two IPv6' },
    { args: [mut({ a: ['fd7a:115c:a1e0::1234:5678', '100.101.102.103'] })], note: 'IPv4 must come first' },
    [mut({ a: ['100.101.102.103', '100.101.102.103'] })],
    [mut({ a: [] })], [mut({ a: '100.101.102.103' })], [mut({ a: [42] })], [mut({ a: null })],
    { args: [mut({ a: ['192.168.1.20'] })], note: 'not a Tailscale address' },
    { args: [mut({ a: ['100.128.0.1'] })], note: 'outside 100.64.0.0/10' },
    [mut({ a: ['fe80::1'] })], [mut({ a: ['127.0.0.1'] })],
    { args: [mut({ a: ['100.101.102.103', 'FD7A:115C:A1E0::1234:5678'] })], note: 'canonical text only: lower case' },
    { args: [mut({ a: ['100.101.102.103', 'fd7a:115c:a1e0:0:0:0:1234:5678'] })], note: 'canonical text only: zeros compressed' },
    { args: [mut({ a: ['100.064.0.1'] })], note: 'leading zero' },
    { args: [mut({ a: ['::ffff:100.101.102.103'] })], note: 'IPv4-mapped' },
    [mut({ a: ['[fd7a:115c:a1e0::1]'] })], [mut({ a: ['fd7a:115c:a1e0::1%utun3'] })], [mut({ a: ['100.101.102.103:47800'] })],
    [mut({ a: [' 100.101.102.103'] })], [mut({ a: ['office-pc'] })],
    [mut({ p: 1023 })], [mut({ p: 65536 })], [mut({ p: 0 })], [mut({ p: -1 })], [mut({ p: 47800.5 })], [mut({ p: '47800' })], [mut({ p: null })], [mut({ p: true })],
    { args: [mut({ k: b64url(HOST_KEY.pub.subarray(0, 31)) })], note: '31 bytes' },
    { args: [mut({ k: b64url(Buffer.concat([HOST_KEY.pub, Buffer.alloc(1)])) })], note: '33 bytes' },
    { args: [mut({ k: `${b64url(HOST_KEY.pub)}=` })], note: 'padding' },
    { args: [mut({ k: b64(HOST_KEY.pub) })], note: 'standard base64' },
    { args: [mut({ k: nonCanonicalB64url(b64url(HOST_KEY.pub)) })], note: 'non-zero unused bits' },
    { args: [mut({ k: HOST_KEY.pub.toString('hex') })], note: 'hex' },
    [mut({ k: null })],
    [mut({ t: b64url(run(0x70, 15)) })], [mut({ t: b64url(run(0x70, 17)) })], [mut({ t: `${b64url(TOKEN)}==` })],
    [mut({ t: nonCanonicalB64url(b64url(TOKEN)) })], [mut({ t: 42 })],
    [mut({ x: 0 })], [mut({ x: -1 })], [mut({ x: 1.5 })], [mut({ x: '1762520000' })], [mut({ x: null })],
    { args: [raw(json.replace('"x":1762520000', '"x":9007199254740992'))], note: 'not a safe integer' },
    { args: [mut({ id: 'a|b', p: 1 })], note: 'fields are checked in key order' },
    { args: [mut({ z: 1, p: 1 })], note: 'the key set before any field' },
    // LINK_NONCANONICAL
    { args: [raw(JSON.stringify(base, null, 1))], note: 'whitespace inside the JSON' },
    { args: [raw(` ${json}`)], note: 'whitespace before the JSON' },
    { args: [raw(`${json}\n`)], note: 'whitespace after the JSON' },
    { args: [raw(JSON.stringify(Object.fromEntries(Object.entries(base).sort(([x], [y]) => (x < y ? -1 : 1)))))], note: 'keys in another order' },
    { args: [raw(json.replace('"p":47800', '"p":1,"p":47800'))], note: 'a duplicate key' },
    { args: [raw(json.replace('office-pc', 'office\\u002dpc'))], note: 'an escaped character' },
    { args: [raw(json.replace('"p":47800', '"p":4.78e4'))], note: 'a number in exponent form' },
    { args: [raw(json.replace('"p":47800', '"p":47800.0'))], note: 'a number with a fraction part' },
    { args: [raw(json.replace('"v":1', '"v":1.0'))] },
  ];
  const parse = (s) => pairing.parseLink(s);
  const validLinks = valid.map(([note, o]) => ({ args: [pairing.encodeLink(o)], note }));
  const shuffled = Object.fromEntries(Object.entries(base).reverse());

  return {
    about: `The pairing link from src/main/pairing.js: prefix + base64url without padding of the UTF-8 JSON object with exactly the keys ${KEYS.join(', ')}, in that order, written with no whitespace and no escapes (JSON.stringify). parseLink is strict: exactly one spelling of each link is accepted, the one encodeLink writes. Error codes name the first problem in check order: LINK_FORMAT, LINK_ENCODING, LINK_JSON, LINK_VERSION, LINK_FIELDS, LINK_ID, LINK_NAME, LINK_ADDRESS, LINK_PORT, LINK_KEY, LINK_TOKEN, LINK_EXPIRY, LINK_NONCANONICAL. a: 1-2 Tailscale addresses (isTailscaleAddress in addresses.json) in canonical text (dotted quad without leading zeros; RFC 5952 IPv6), at most one per family, IPv4 first. n: "" or lower-case DNS labels ([a-z0-9], inner "-", 1-63 each) joined by ".", at most 253 characters, no trailing dot. x is not compared with the clock here. Regenerate with node ${SELF}.`,
    format: FORMAT,
    prefix: PREFIX,
    keys: [...KEYS],
    maxLength: pairing.LINK_MAX_LENGTH,
    functions: {
      parseLink: {
        about: 'parseLink(text) -> {v, id, n, a, p, k, t, x}, or the error code of the first problem.',
        cases: [...await cases(parse, validLinks), ...await errorCases(parse, invalid)],
      },
      encodeLink: {
        about: 'encodeLink(object) -> the link text. The object needs exactly the link keys (any order) and valid values; the same error codes as parseLink.',
        cases: [
          ...await cases(pairing.encodeLink, [
            ...valid.map(([note, o]) => ({ args: [o], note })),
            { args: [shuffled], note: 'input key order does not matter; the output is canonical' },
          ]),
          ...await errorCases(pairing.encodeLink, [
            [null], [[]], ['x'],
            [{ ...base, v: 2 }], [{ ...base, z: 1 }], [{ ...base, a: ['fd7a:115c:a1e0::1', '100.64.0.1'] }],
            [{ ...base, n: 'Office.ts.net' }], [{ ...base, p: 80 }], [{ ...base, x: 1.5 }],
          ]),
        ],
      },
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * fingerprint.json — the identity fingerprint shown to the user (pairing.fingerprint, DECISIONS D1)
 * ---------------------------------------------------------------------------------------------- */

async function fingerprintVectors({ pairing }) {
  const keys = [
    ['host', HOST_KEY.pub], ['other', OTHER_KEY.pub],
    ...RFC8032.map((r) => [r.name, Buffer.from(r.pub, 'hex')]),
    ['all zero bytes', Buffer.alloc(32)], ['all 0xff bytes', Buffer.alloc(32, 0xff)],
  ];
  const ascii = (s) => Buffer.from(s, 'ascii').toString('hex');
  return {
    about: `Identity fingerprints from src/main/pairing.js: "TV-" + the first 20 characters of RFC 4648 base32 (upper case, no padding) of SHA-256(raw 32-byte public key), in groups of 4 joined by "-". Keys are base64url without padding. keys: each with its SHA-256 and full base32 for debugging. base32: RFC 4648 section 10 test vectors without padding (args are hex). Regenerate with node ${SELF}.`,
    format: FORMAT,
    keys: keys.map(([name, pub]) => {
      const digest = crypto.createHash('sha256').update(pub).digest();
      return { name, pub: b64url(pub), sha256Hex: digest.toString('hex'), base32: pairing.base32(digest), fingerprint: pairing.fingerprint(pub) };
    }),
    functions: {
      fingerprint: {
        about: 'fingerprint(pub) -> "TV-XXXX-XXXX-XXXX-XXXX-XXXX". A key that is not 32 bytes: error BAD_KEY.',
        cases: [
          ...await cases((p) => pairing.fingerprint(Buffer.from(p, 'base64url')), keys.map(([name, pub]) => ({ args: [b64url(pub)], note: name }))),
          ...await errorCases((p) => pairing.fingerprint(Buffer.from(p, 'base64url')), [
            [b64url(HOST_KEY.pub.subarray(0, 31))], [b64url(Buffer.alloc(33))], [''],
          ]),
        ],
      },
      base32: {
        about: 'base32(bytes as hex) -> RFC 4648 base32, upper case, no padding.',
        cases: await cases((hex) => pairing.base32(Buffer.from(hex, 'hex')), [
          [''], [ascii('f')], [ascii('fo')], [ascii('foo')], [ascii('foob')], [ascii('fooba')], [ascii('foobar')],
          ['00'], ['ff'], ['0000000000'], ['ffffffffff'], [crypto.createHash('sha256').update(HOST_KEY.pub).digest('hex')],
        ]),
      },
    },
  };
}

/* ------------------------------------------------------------------------------------------------
 * Registry and CLI
 * ---------------------------------------------------------------------------------------------- */

/** Every vector file, in one place. Producers get the loaded modules and return the file object. */
const PRODUCERS = [
  { file: 'auth-v2.json', produce: authVectors },
  { file: 'addresses.json', produce: addressVectors },
  { file: 'tailnet-path.json', produce: pathVectors },
  { file: 'validate.json', produce: validateVectors },
  { file: 'reasons.json', produce: reasonVectors },
  { file: 'input-limits.json', produce: inputVectors },
  { file: 'ident.json', produce: identVectors },
  { file: 'pair.json', produce: pairVectors },
  { file: 'links.json', produce: linkVectors },
  { file: 'fingerprint.json', produce: fingerprintVectors },
];

/** file name → canonical text, for every producer. */
async function generate() {
  const m = await loadModules();
  const out = new Map();
  for (const { file, produce } of PRODUCERS) {
    try {
      out.set(file, serialize(await produce(m)));
    } catch (e) {
      throw new Error(`${file}: ${e && e.message}`, { cause: e });
    }
  }
  return out;
}

/** Differences between `generated` and test/vectors: [{file, problem}]. */
function compare(generated) {
  const problems = [];
  for (const [file, text] of generated) {
    let have = null;
    try { have = fs.readFileSync(path.join(VECTOR_DIR, file), 'utf8'); } catch { /* missing */ }
    if (have === null) problems.push({ file, problem: 'missing' });
    else if (have !== text) problems.push({ file, problem: 'differs from what the current code produces' });
  }
  let present = [];
  try { present = fs.readdirSync(VECTOR_DIR).filter((f) => f.endsWith('.json')); } catch { /* no directory yet */ }
  for (const file of present.sort()) {
    if (!generated.has(file)) problems.push({ file, problem: `not produced by ${SELF} (stale? delete it)` });
  }
  return problems;
}

const rel = (file) => `test/vectors/${file}`;

async function main(argv) {
  const args = argv.slice(2);
  const check = args.includes('--check');
  if (args.some((a) => a !== '--check')) {
    console.error(`usage: node ${SELF} [--check]`);
    return 2;
  }
  const generated = await generate();
  const problems = compare(generated);
  if (check) {
    for (const p of problems) console.error(`✗ ${rel(p.file)}: ${p.problem}`);
    if (problems.length) {
      console.error(`Regenerate with: node ${SELF}`);
      return 1;
    }
    console.log(`✓ ${generated.size} vector file(s) in test/vectors are current`);
    return 0;
  }
  fs.mkdirSync(VECTOR_DIR, { recursive: true });
  let stale = 0;
  for (const p of problems) {
    if (generated.has(p.file)) {
      fs.writeFileSync(path.join(VECTOR_DIR, p.file), generated.get(p.file));
      console.log(`wrote ${rel(p.file)}`);
    } else {
      stale++;
      console.error(`✗ ${rel(p.file)}: ${p.problem}`);
    }
  }
  console.log(`✓ ${generated.size} vector file(s), ${problems.length - stale} rewritten`);
  return stale ? 1 : 0;
}

if (require.main === module) {
  // The renderer files are ES modules in a package without "type": Node warns once per import,
  // which would bury the --check result. Other warnings still print.
  const emitWarning = process.emitWarning;
  process.emitWarning = function filtered(warning, ...rest) {
    const code = rest[0] && typeof rest[0] === 'object' ? rest[0].code : rest[1];
    if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return undefined;
    return emitWarning.call(process, warning, ...rest);
  };
  main(process.argv).then((code) => { process.exitCode = code; }, (e) => {
    console.error(`✗ ${(e && e.stack) || e}`);
    process.exitCode = 1;
  });
}

module.exports = { PRODUCERS, VECTOR_DIR, FORMAT, loadModules, generate, compare, serialize, ed25519FromSeed };
