'use strict';
/*
 * This computer's Ed25519 identity key (mobile DECISIONS D1).
 * A paired phone pins the public key and checks every hello.ident signature with it. So the key
 * must survive updates, crashes and damaged files, and it must never change behind the user's back
 * (CRITIQUE B3). A silent new key would make every phone report "not the computer you paired with".
 *
 *   userData/identity.json      {v:1, createdAt, pub: base64url(raw 32 bytes), priv: base64(PKCS8 DER)}
 *   userData/identity.json.bak  the same bytes, written after every successful write
 *   userData/identity.json.old  the previous identity.json, kept by reset()
 *
 * Stored like settings.json (atomic temp file + rename, mode 0600), with no safeStorage: on macOS
 * its keychain item is tied to the ad-hoc code signature, which changes with every update.
 * Load order:
 *   1. identity.json is valid → use it (identity.json.bak is brought up to date);
 *   2. else identity.json.bak is valid → use it and rewrite identity.json;
 *   3. else NEITHER file exists → generate a key and write both, unless a key file existed earlier
 *      in this run: then 'MISSING' (files deleted after a damaged-file banner must not turn Retry
 *      into a silent reset; Reset identity… makes the new key, with its warning and session lock);
 *   4. else → unavailable, with an error code. The files stay as they are, so a phone hears "this
 *      computer can't prove its identity right now", not "pair again", until Retry or Reset.
 * A file that has to be replaced is never destroyed: unless it already is a copy of the key being
 * kept, it is first renamed to <name>.corrupt-<ms> (unusable) or <name>.prev-<ms> (another valid
 * key); identity.json.old too, so a second reset still keeps the first key. reset() is the only
 * way to get a new key once a key file has existed.
 * The private key never leaves this module: not to a renderer, not into settings.json.
 *
 *   const identity = createIdentity({ file: path.join(app.getPath('userData'), 'identity.json') });
 *   identity.load()               → {ok, error}; never throws (retry() is the same, for the UI)
 *   identity.unavailable          → true while no key can be used; identity.error says why:
 *                                   'CORRUPT' | 'READ_FAILED' | 'VERSION' (written by a newer
 *                                   Tunnelview) | 'WRITE_FAILED' (a new key could not be stored)
 *                                   | 'MISSING' (both files gone after a key file existed in this
 *                                   run) | 'NOT_LOADED' (before the first load); null while available
 *   identity.publicKeyRaw()       → Buffer(32) (a copy) | null
 *   identity.publicKeyB64url()    → string | null
 *   identity.fingerprint()        → 'TV-XXXX-XXXX-XXXX-XXXX-XXXX' | null
 *   identity.sign(bytes)          → Buffer(64); throws {code:'IDENTITY_UNAVAILABLE'} while unavailable
 *   identity.reset({sessionActive}) → {ok, error}: a new key, the old file kept as .old; refused
 *                                   with 'SESSION_ACTIVE' during an incoming session
 *   identity.wasReset             → true only after a reset() in this run
 *
 * fs and now are injectable, so tests run under plain Node without Electron.
 */
const crypto = require('crypto');
const nodeFs = require('fs');
const path = require('path');
const auth = require('./auth');
const pairing = require('./pairing');

const FORMAT_VERSION = 1;
const MAX_FILE_BYTES = 64 * 1024; // the real file is about 150 bytes
const PKCS8_MAX_BYTES = 256;
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SELF_TEST = Buffer.from('Tunnelview identity self-test', 'utf8');
const UTF8 = new TextDecoder('utf-8', { fatal: true });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function identityError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** Synchronous sleep (only for short rename retries while an AV scanner holds the file). */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

/** Raw 32-byte public key of an Ed25519 KeyObject (private or public): the tail of its SPKI DER. */
function rawPublicKey(keyObject) {
  const spki = crypto.createPublicKey(keyObject).export({ format: 'der', type: 'spki' });
  if (spki.length !== SPKI_ED25519_PREFIX.length + pairing.KEY_BYTES || !spki.subarray(0, SPKI_ED25519_PREFIX.length).equals(SPKI_ED25519_PREFIX)) {
    throw new Error('not an Ed25519 key');
  }
  return Buffer.from(spki.subarray(SPKI_ED25519_PREFIX.length));
}

/** The file text for a key: {v, createdAt, pub, priv}, 2-space JSON and a trailing newline. */
function serialize(priv, pub, createdAt) {
  const der = priv.export({ format: 'der', type: 'pkcs8' });
  const doc = { v: FORMAT_VERSION, createdAt, pub: pub.toString('base64url'), priv: der.toString('base64') };
  return Buffer.from(`${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

/**
 * A loaded key, or why the bytes are not one: 'VERSION' for a newer format (left for that
 * Tunnelview), 'CORRUPT' for anything else, including a private key that does not match `pub`
 * or cannot sign.
 * @returns {{ok:true, priv, pub, createdAt} | {ok:false, code}}
 */
function parseIdentity(bytes) {
  const bad = (code) => ({ ok: false, code });
  if (bytes.length > MAX_FILE_BYTES) return bad('CORRUPT');
  let o;
  try {
    const text = UTF8.decode(bytes);
    o = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return bad('CORRUPT');
  }
  if (!isObj(o)) return bad('CORRUPT');
  if (o.v !== FORMAT_VERSION) return bad(Number.isSafeInteger(o.v) && o.v > FORMAT_VERSION ? 'VERSION' : 'CORRUPT');
  if (!Number.isSafeInteger(o.createdAt) || o.createdAt <= 0) return bad('CORRUPT');
  const pub = pairing.decodeB64url(o.pub, pairing.KEY_BYTES);
  const der = auth.decodeB64(o.priv, 1, PKCS8_MAX_BYTES);
  if (!pub || !der) return bad('CORRUPT');
  try {
    const priv = crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    if (priv.asymmetricKeyType !== 'ed25519' || !rawPublicKey(priv).equals(pub)) return bad('CORRUPT');
    // A key that cannot sign would otherwise only show up as hellos every phone rejects.
    const pubKey = crypto.createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, pub]), format: 'der', type: 'spki' });
    if (!crypto.verify(null, SELF_TEST, pubKey, crypto.sign(null, SELF_TEST, priv))) return bad('CORRUPT');
    return { ok: true, priv, pub, createdAt: o.createdAt };
  } catch {
    return bad('CORRUPT');
  }
}

class Identity {
  constructor({ file, fs = nodeFs, now = Date.now } = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new TypeError('createIdentity: file must be an absolute path');
    this._file = file;
    this._bak = `${file}.bak`;
    this._old = `${file}.old`;
    this._fs = fs;
    this._now = now;
    this._tmpSeq = 0;
    this._priv = null;
    this._pub = null;
    this._error = 'NOT_LOADED';
    this._wasReset = false;
    this._keyFileSeen = false; // a key file existed (or was written) during this run
  }

  get unavailable() { return this._priv === null; }
  get error() { return this._error; }
  get wasReset() { return this._wasReset; }

  publicKeyRaw() { return this._pub ? Buffer.from(this._pub) : null; }
  publicKeyB64url() { return this._pub ? this._pub.toString('base64url') : null; }
  fingerprint() { return this._pub ? pairing.fingerprint(this._pub) : null; }

  /** Ed25519 signature of `bytes`. */
  sign(bytes) {
    if (!this._priv) throw identityError('IDENTITY_UNAVAILABLE', "This computer's identity key is not available.");
    if (!(bytes instanceof Uint8Array)) throw new TypeError('sign: bytes must be a Buffer or Uint8Array');
    return crypto.sign(null, bytes, this._priv);
  }

  /** Load (or create) the key following the load order in the header. Never throws. */
  load() {
    this._cleanupTmp();
    const main = this._read(this._file);
    if (main.state === 'ok') {
      this._keyFileSeen = true;
      this._use(main);
      // Keep the backup current, e.g. after a crash between writing identity.json and the .bak.
      this._replace(this._bak, main.bytes);
      return this._status();
    }
    const bak = this._read(this._bak);
    if (main.state !== 'missing' || bak.state !== 'missing') this._keyFileSeen = true;
    if (bak.state === 'ok') {
      this._use(bak);
      // An unreadable identity.json (I/O error) is left alone: its content is unknown.
      if (main.state !== 'error' && !this._replace(this._file, bak.bytes)) {
        console.error('[identity] could not restore identity.json from identity.json.bak');
      }
      return this._status();
    }
    if (main.state === 'missing' && bak.state === 'missing') {
      // Gone since this run saw them (deleted after the damaged-file banner, a cleanup tool): a
      // new key here would be a reset without the reset's warning, session lock and wasReset.
      if (this._keyFileSeen) return this._unavailable('MISSING');
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      const bytes = serialize(privateKey, rawPublicKey(privateKey), this._now());
      // A key that is not on disk would be a new key at the next start: never hand one out.
      if (!this._write(this._file, bytes)) return this._unavailable('WRITE_FAILED');
      this._keyFileSeen = true;
      if (!this._write(this._bak, bytes)) console.error('[identity] could not write identity.json.bak');
      this._use(parseIdentity(bytes));
      return this._status();
    }
    return this._unavailable(main.state === 'missing' ? bak.code : main.code);
  }

  /**
   * load() again: Settings › Security › Retry after the cause was fixed. It only ever loads a key
   * file; it makes a key only when this run never had one (a first write that failed).
   */
  retry() {
    return this.load();
  }

  /**
   * Replace the key (Settings › Security › Reset identity…). The previous identity.json (or the
   * .bak it was loaded from) is kept as identity.json.old; an earlier .old (the key a previous reset
   * retired) is renamed aside first, never written over. On any write failure the old key stays.
   * @param {{sessionActive?: boolean}} [opts] true while an incoming session runs → refused
   * @returns {{ok:boolean, error:string|null}}
   */
  reset({ sessionActive = false } = {}) {
    if (sessionActive) return { ok: false, error: 'SESSION_ACTIVE' };
    const fs = this._fs;
    let prev = null;
    for (const file of [this._file, this._bak]) {
      try {
        prev = fs.readFileSync(file);
        break;
      } catch (err) {
        if (err && err.code === 'ENOENT') continue;
        // Unreadable: move it to .old as it is, since it cannot be copied.
        if (!this._clear(this._old)) return { ok: false, error: 'WRITE_FAILED' };
        try {
          fs.renameSync(file, this._old);
          break;
        } catch {
          return { ok: false, error: 'WRITE_FAILED' };
        }
      }
    }
    if (prev && !this._replace(this._old, prev)) return { ok: false, error: 'WRITE_FAILED' };
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    const bytes = serialize(privateKey, rawPublicKey(privateKey), this._now());
    if (!this._write(this._file, bytes)) return { ok: false, error: 'WRITE_FAILED' };
    this._keyFileSeen = true;
    // The .bak usually holds the same bytes as prev (now in .old); anything else is set aside.
    if (!this._replace(this._bak, bytes, prev)) console.error('[identity] could not write identity.json.bak');
    this._use(parseIdentity(bytes));
    this._wasReset = true;
    return { ok: true, error: null };
  }

  /* ---------------------------------------------------------------- internals */

  _status() {
    return { ok: !this.unavailable, error: this._error };
  }

  _use(slot) {
    this._priv = slot.priv;
    this._pub = slot.pub;
    this._error = null;
  }

  _unavailable(code) {
    this._priv = null;
    this._pub = null;
    this._error = code;
    console.error(`[identity] unavailable: ${code}`);
    return this._status();
  }

  /** @returns {{state:'missing'} | {state:'error', code} | {state:'invalid', code, bytes} | {state:'ok', bytes, priv, pub}} */
  _read(file) {
    let bytes;
    try {
      bytes = this._fs.readFileSync(file);
    } catch (err) {
      return err && err.code === 'ENOENT' ? { state: 'missing' } : { state: 'error', code: 'READ_FAILED' };
    }
    const parsed = parseIdentity(bytes);
    return parsed.ok ? { state: 'ok', bytes, ...parsed } : { state: 'invalid', code: parsed.code, bytes };
  }

  /**
   * Put `bytes` at `file`. Content that differs (and is not `alsoKept`, a copy saved elsewhere)
   * is renamed aside first; an unreadable file, or one that cannot be moved, is left in place.
   * @returns {boolean} whether `file` now holds `bytes`
   */
  _replace(file, bytes, alsoKept = null) {
    let have;
    try {
      have = this._fs.readFileSync(file);
    } catch (err) {
      if (err && err.code === 'ENOENT') return this._write(file, bytes);
      return false;
    }
    if (have.equals(bytes)) return true;
    if (!(alsoKept && have.equals(alsoKept)) && !this._setAside(file, have)) return false;
    return this._write(file, bytes);
  }

  /**
   * Make room at `file` for a rename onto it: an existing file is set aside like in _replace.
   * @returns {boolean} false when it is still there (unreadable, or it could not be moved)
   */
  _clear(file) {
    let have;
    try {
      have = this._fs.readFileSync(file);
    } catch (err) {
      return !!(err && err.code === 'ENOENT');
    }
    return this._setAside(file, have);
  }

  /** Rename `file` (whose bytes are `have`) to <file>.prev-<ms> or .corrupt-<ms>. @returns {boolean} */
  _setAside(file, have) {
    const base = `${file}.${parseIdentity(have).ok ? 'prev' : 'corrupt'}-${this._now()}`;
    // Never onto another aside file (rename replaces its target): the same millisecond gets -1, -2…
    let aside = null;
    for (let n = 0; n < 100 && !aside; n++) {
      const name = n ? `${base}-${n}` : base;
      try {
        this._fs.lstatSync(name);
      } catch (err) {
        if (err && err.code === 'ENOENT') aside = name;
      }
    }
    try {
      if (!aside) throw new Error('no free name');
      this._fs.renameSync(file, aside);
      return true;
    } catch (err) {
      console.error(`[identity] could not move ${path.basename(file)} aside:`, err && err.message);
      return false;
    }
  }

  /** Atomic write like settings.js: temp file (0600, fsync) → rename. @returns {boolean} */
  _write(file, bytes) {
    const fs = this._fs;
    const tmp = `${file}.${process.pid}.${this._now()}.${++this._tmpSeq}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // Windows: rename can fail transiently with EPERM/EBUSY while antivirus/indexer holds the target.
      for (let attempt = 0; ; attempt++) {
        try {
          fs.renameSync(tmp, file);
          break;
        } catch (err) {
          if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(err && err.code)) throw err;
          sleepSync(15 * (attempt + 1));
        }
      }
      return true;
    } catch (err) {
      console.error(`[identity] write of ${path.basename(file)} failed:`, err && err.message);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return false;
    }
  }

  /** Temp files a crash left behind. They never hold the only copy of a key in use. */
  _cleanupTmp() {
    const dir = path.dirname(this._file);
    const base = path.basename(this._file);
    try {
      for (const name of this._fs.readdirSync(dir)) {
        if (name.startsWith(`${base}.`) && name.endsWith('.tmp')) {
          try { this._fs.unlinkSync(path.join(dir, name)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
}

/** @param {{file:string, fs?:object, now?:() => number}} opts file: absolute path of identity.json */
function createIdentity(opts) {
  return new Identity(opts);
}

module.exports = { createIdentity, parseIdentity, FORMAT_VERSION };
