'use strict';
/*
 * Fixtures for the in-app updater tests: throwaway Ed25519 keys, signed manifests, a fake HTTPS
 * transport (no socket is ever opened), a manual clock for the schedule, a settings stand-in.
 * Not a test file itself (no *.test.js name). Never touches the production signing key.
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const manifest = require('../../src/main/update-manifest');

/** A throwaway key pair, with its kid and a one-entry key list the updater can use. */
function makeKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const raw = manifest.rawPublicKey(publicKey);
  const pub = raw.toString('base64url');
  const kid = manifest.keyId(raw);
  return { privateKey, publicKey, raw, pub, kid, keys: [{ kid, publicKey: pub }] };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Release assets for `version` (deterministic bytes per platform unless given) and the files map.
 * @returns {{version, assets: Object<name, Buffer>, files: Object<platformKey, {name,size,sha256}>}}
 */
function makeRelease(version, contents = {}) {
  const assets = {};
  const files = {};
  for (const key of manifest.PLATFORM_KEYS) {
    const name = manifest.assetName(key, version);
    const body = contents[key] || Buffer.from(`${name} ${'x'.repeat(200)}`);
    assets[name] = body;
    files[key] = { name, size: body.length, sha256: sha256(body) };
  }
  return { version, assets, files };
}

const DATE = '2026-11-07T12:00:00.000Z';

/** The manifest file bytes for a release, signed with `key`. */
function signedManifest(key, release, { notes = 'Fixes and improvements.\n\n- one\n- two', date = DATE } = {}) {
  return manifest.signManifest(manifest.buildPayload({ version: release.version, date, notes, files: release.files }), key.privateKey, key.kid);
}

/** Sign arbitrary payload bytes (no validation), for manifests the verifier must refuse. */
function signRaw(key, payloadBytes, kid = key.kid) {
  const sig = crypto.sign(null, payloadBytes, key.privateKey);
  return manifest.encodeEnvelope({ payload: Buffer.from(payloadBytes).toString('base64'), sig: sig.toString('base64'), kid });
}

/**
 * A transport like updater.js's nodeTransport, answered by `route(url, n)`:
 *   {status?, headers?, body?: Buffer|string|Array} | {error: Error} | {hang: true}
 *   | {stream: Readable} (the test writes the body, or destroys it with an error) | null (ENOTFOUND)
 * Every request is logged with its headers. An aborted signal destroys the response stream.
 */
function fakeTransport(route) {
  const requests = [];
  return {
    requests,
    get(url, { headers, timeoutMs, signal } = {}) {
      requests.push({ url, headers: { ...headers }, timeoutMs });
      return new Promise((resolve, reject) => {
        const r = route(url, requests.length);
        if (!r) { reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })); return; }
        if (r.error) { reject(r.error); return; }
        let res;
        if (r.stream) {
          res = r.stream;
        } else if (r.hang) {
          res = new Readable({ read() {} });
        } else {
          const chunks = r.body === undefined ? [] : Array.isArray(r.body) ? r.body : [r.body];
          res = Readable.from(chunks.map((c) => Buffer.from(c)), { objectMode: false });
        }
        res.statusCode = r.status || 200;
        res.headers = r.headers || {};
        if (signal) {
          if (signal.aborted) { res.destroy(signal.reason); } else signal.addEventListener('abort', () => res.destroy(signal.reason), { once: true });
        }
        resolve(res);
      });
    },
  };
}

const settle = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

/** A manual clock: injected `now` and `timers`; advance() runs due timers in order. */
function fakeClock(start = Date.UTC(2026, 10, 7, 9, 0, 0)) {
  let now = start;
  let seq = 0;
  const live = new Map();
  return {
    now: () => now,
    timers: {
      setTimeout(fn, ms) {
        const t = { id: ++seq, at: now + Math.max(0, Number(ms) || 0), fn, unref() { t.unrefed = true; return t; } };
        live.set(t.id, t);
        return t;
      },
      clearTimeout(t) { if (t) live.delete(t.id); },
    },
    /** Delays (ms from now) of the timers still waiting, soonest first. */
    pending() { return [...live.values()].map((t) => t.at - now).sort((a, b) => a - b); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...live.values()].filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        now = due.at;
        live.delete(due.id);
        due.fn();
        await settle();
      }
      now = end;
      await settle();
    },
  };
}

/** The part of settings.js the updater uses. */
function fakeSettings(init = {}) {
  const data = { autoUpdateCheck: true, lastUpdateCheckAt: null, ...init };
  const updates = [];
  return {
    data,
    updates,
    get: () => ({ ...data }),
    update(p) { updates.push({ ...p }); Object.assign(data, p); return { ...data }; },
  };
}

const quietLog = { log() {}, warn() {}, error() {} };

const tmpDirs = [];
function tmpDir(prefix = 'tunnelview-update-') {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}
function cleanupTmp() {
  for (const d of tmpDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3 }); } catch { /* left to the OS */ } }
}

module.exports = {
  makeKey,
  makeRelease,
  signedManifest,
  signRaw,
  sha256,
  fakeTransport,
  fakeClock,
  fakeSettings,
  settle,
  quietLog,
  tmpDir,
  cleanupTmp,
  DATE,
};
