'use strict';
/*
 * JSON settings store — docs/ARCHITECTURE.md §8.
 *
 *   const settings = require('./settings');   // singleton (class Settings, EventEmitter)
 *   settings.load([dir])                      // dir defaults to app.getPath('userData')
 *   settings.get()                            // deep copy (includes the stored password hash — main only!)
 *   settings.getPublic()                      // renderer view: no password, + passwordSet, effectiveDownloadDir
 *   settings.update(partial)                  // validates every field, persists atomically, emits 'change'
 *   await settings.setPassword(pw | null)     // 8–128 chars, hashed with auth.hashPassword
 *   settings.addTrusted({stableId,name,login}) / removeTrusted(stableId)
 *   settings.addRecent({stableId,hostname,ip,os,port?}) / toggleFavorite(stableId)
 *   settings.effectiveDownloadDir()
 *   events: 'change' (settingsCopy, changedKeys[])
 *
 * Electron is required lazily (only for default paths) so tests can run under plain Node with
 * `new Settings({ dir, auth, downloadsDir })`.
 */
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PROTOCOL = require('../shared/protocol');

const FILE_NAME = 'settings.json';
const SETTINGS_VERSION = 1;

const DEFAULTS = Object.freeze({
  version: SETTINGS_VERSION,
  hostEnabled: true,
  port: PROTOCOL.DEFAULT_PORT,
  acceptMode: 'ask',
  allowFrom: 'tailnet',
  allowList: [],
  autoAcceptSameUser: false,
  trustedNodes: [],
  password: null,
  defaultPermissions: { control: true, clipboard: true, files: true, audio: true },
  promptTimeoutSec: 30,
  quality: 'balanced',
  codec: 'auto',
  // Windows viewer: decode remote video on the GPU. Off by default — see index.js (read before
  // app ready; a change applies after a restart). Ignored on macOS (VideoToolbox stays on).
  gpuVideoDecode: false,
  clipboardSync: true,
  swapCmdCtrl: 'auto',
  downloadDir: null,
  startAtLogin: false,
  // macOS: Tunnelview registered its login item successfully (SMAppService). A later status of
  // 'not-registered' then means the user removed it in System Settings › Login Items.
  loginItemApplied: false,
  closeToTray: true,
  favorites: [],
  recent: [],
  theme: 'system',
});

const LIMITS = Object.freeze({
  PORT_MIN: 1024,
  PORT_MAX: 65535,
  ALLOW_LIST_MAX: 100,
  ALLOW_ENTRY_MAX: 128,
  TRUSTED_MAX: 200,
  FAVORITES_MAX: 500,
  RECENT_MAX: 20,
  ID_MAX: 128,
  NAME_MAX: 255,
  PATH_MAX: 1024,
  PROMPT_MIN: 10,
  PROMPT_MAX: 300,
  PASSWORD_MIN: 8,
  PASSWORD_MAX: 128,
});

const OS_NAMES = ['windows', 'macos', 'linux', 'ios', 'android', 'other'];

/* ------------------------------------------------------------------ helpers */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isBool = (v) => typeof v === 'boolean';
const isInt = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max && !v.includes('\0');
const oneOf = (list) => (v) => list.includes(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
function b64Bytes(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 1024 || v.length % 4 !== 0 || !B64_RE.test(v)) return -1;
  return Buffer.from(v, 'base64').length;
}

/** StoredPassword = { salt:b64(16 bytes), N, r, p, keylen:32, key:b64 } (ARCHITECTURE §4). */
function validStoredPassword(p) {
  if (!isObj(p)) return false;
  const powerOfTwo = Number.isSafeInteger(p.N) && p.N >= 1024 && p.N <= 1048576 && (p.N & (p.N - 1)) === 0;
  return powerOfTwo
    && isInt(p.r, 1, 32) && isInt(p.p, 1, 16) && p.keylen === 32
    && b64Bytes(p.salt) >= 16 && b64Bytes(p.key) === p.keylen;
}

function normStringList(v, maxItems, maxLen) {
  if (!Array.isArray(v) || v.length > maxItems * 4) return undefined;
  const out = [];
  for (const item of v) {
    if (typeof item !== 'string') return undefined;
    const s = item.trim();
    if (!s) continue;
    if (s.length > maxLen || s.includes('\0')) return undefined;
    if (!out.includes(s)) out.push(s);
  }
  return out.length <= maxItems ? out : undefined;
}

function normTrusted(e) {
  if (!isObj(e) || !isStr(e.stableId, 1, LIMITS.ID_MAX)) return null;
  return {
    stableId: e.stableId,
    name: isStr(e.name, 0, LIMITS.NAME_MAX) ? e.name : '',
    login: isStr(e.login, 0, LIMITS.NAME_MAX) ? e.login : '',
    addedAt: Number.isFinite(e.addedAt) && e.addedAt > 0 ? Math.floor(e.addedAt) : Date.now(),
  };
}

function normRecent(e) {
  if (!isObj(e)) return null;
  if (!isStr(e.stableId, 0, LIMITS.ID_MAX) || !isStr(e.hostname, 0, LIMITS.NAME_MAX) || !isStr(e.ip, 0, 64)) return null;
  if (!e.stableId && !e.ip && !e.hostname) return null;
  const out = {
    stableId: e.stableId,
    hostname: e.hostname,
    ip: e.ip,
    os: OS_NAMES.includes(e.os) ? e.os : 'other',
    ts: Number.isFinite(e.ts) && e.ts > 0 ? Math.floor(e.ts) : Date.now(),
  };
  // Optional: the signaling port that worked (hosts may use a custom port); omitted when invalid.
  if (isInt(e.port, 1, 65535)) out.port = e.port;
  return out;
}

function normEntries(v, normFn, max) {
  if (!Array.isArray(v) || v.length > max * 4) return undefined;
  const out = [];
  for (const raw of v) {
    const e = normFn(raw);
    if (!e) return undefined; // one bad entry → reject the whole value (keep old)
    out.push(e);
  }
  return out.length <= max ? out : undefined;
}

/*
 * Field validators: (value, current) → normalized value, or undefined to reject (keep old).
 * `ctx.fromDisk` is true while loading (stored data is trusted a little more for fields the
 * renderer may not set directly, e.g. trustedNodes additions and the password hash).
 */
const VALIDATORS = {
  hostEnabled: (v) => (isBool(v) ? v : undefined),
  port: (v) => (isInt(v, LIMITS.PORT_MIN, LIMITS.PORT_MAX) ? v : undefined),
  acceptMode: (v) => (oneOf(['ask', 'password-only'])(v) ? v : undefined),
  allowFrom: (v) => (oneOf(['tailnet', 'same-user', 'list'])(v) ? v : undefined),
  allowList: (v) => normStringList(v, LIMITS.ALLOW_LIST_MAX, LIMITS.ALLOW_ENTRY_MAX),
  autoAcceptSameUser: (v) => (isBool(v) ? v : undefined),
  // Main-process API (host-server adds trust after a prompt with "trust" ticked). The renderer
  // path (ipc.js 'settings:update') may only REMOVE entries — enforced at that trust boundary.
  trustedNodes: (v) => {
    const list = normEntries(v, normTrusted, LIMITS.TRUSTED_MAX);
    if (!list) return undefined;
    const dedup = [];
    for (const e of list) if (!dedup.some((d) => d.stableId === e.stableId)) dedup.push(e);
    return dedup;
  },
  password: (v, cur, ctx) => {
    if (!ctx.fromDisk) return undefined; // only setPassword() may change it
    if (v === null) return null;
    return validStoredPassword(v) ? clone(v) : null;
  },
  defaultPermissions: (v, cur) => {
    if (!isObj(v)) return undefined;
    const out = { ...(cur || DEFAULTS.defaultPermissions) };
    for (const k of PROTOCOL.PERMISSION_KEYS) if (isBool(v[k])) out[k] = v[k];
    return out;
  },
  promptTimeoutSec: (v) => (isInt(v, LIMITS.PROMPT_MIN, LIMITS.PROMPT_MAX) ? v : undefined),
  quality: (v) => (PROTOCOL.QUALITY_PRESETS.includes(v) ? v : undefined),
  codec: (v) => (PROTOCOL.CODECS.includes(v) ? v : undefined),
  gpuVideoDecode: (v) => (isBool(v) ? v : undefined),
  clipboardSync: (v) => (isBool(v) ? v : undefined),
  swapCmdCtrl: (v) => (oneOf(['auto', 'on', 'off'])(v) ? v : undefined),
  downloadDir: (v) => {
    if (v === null || v === '') return null;
    if (!isStr(v, 1, LIMITS.PATH_MAX) || !path.isAbsolute(v)) return undefined;
    return path.resolve(v);
  },
  startAtLogin: (v) => (isBool(v) ? v : undefined),
  // Main-process bookkeeping (index.js); ipc.js drops it from renderer updates.
  loginItemApplied: (v) => (isBool(v) ? v : undefined),
  closeToTray: (v) => (isBool(v) ? v : undefined),
  favorites: (v) => normStringList(v, LIMITS.FAVORITES_MAX, LIMITS.ID_MAX),
  recent: (v) => {
    const list = normEntries(v, normRecent, LIMITS.RECENT_MAX);
    return list ? list.sort((a, b) => b.ts - a.ts) : undefined;
  },
  theme: (v) => (oneOf(['system', 'dark', 'light'])(v) ? v : undefined),
};

/** Synchronous sleep (used only for short rename retries while an AV scanner holds the file). */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ class */

class Settings extends EventEmitter {
  /**
   * @param {{dir?:string, auth?:{hashPassword:Function}, downloadsDir?:string}} [opts]
   *   dir: storage directory (default: Electron userData on load()); auth: injectable for tests;
   *   downloadsDir: base for the default download folder (default: Electron 'downloads').
   */
  constructor(opts = {}) {
    super();
    this._dir = opts.dir || null;
    this._auth = opts.auth || null;
    this._downloadsDir = opts.downloadsDir || null;
    this._data = clone(DEFAULTS);
    this._loaded = false;
  }

  get file() { return this._dir ? path.join(this._dir, FILE_NAME) : null; }
  get loaded() { return this._loaded; }

  /** Load (and migrate/validate) settings from disk. Never throws; falls back to defaults. */
  load(dir) {
    if (dir) this._dir = dir;
    if (!this._dir) this._dir = require('electron').app.getPath('userData');
    const file = this.file;
    let raw = null;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[settings] read failed:', err.message);
    }
    let parsed = null;
    if (raw != null) {
      try {
        parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
        if (!isObj(parsed)) throw new Error('not an object');
      } catch (err) {
        console.error('[settings] corrupt settings file, using defaults:', err.message);
        try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
        parsed = null;
      }
    }
    this._data = this._fromDisk(parsed || {});
    this._loaded = true;
    this._cleanupTmp();
    // Persist when the file was missing, from an older version, or needed repairs.
    if (!parsed || JSON.stringify(parsed) !== JSON.stringify(this._data)) this._persist();
    return this.get();
  }

  /** Deep copy of all settings (main process only — includes the password hash). */
  get() { return clone(this._data); }

  /** Renderer-safe view. */
  getPublic() {
    const pub = clone(this._data);
    delete pub.password;
    pub.passwordSet = !!this._data.password;
    pub.effectiveDownloadDir = this.effectiveDownloadDir();
    return pub;
  }

  effectiveDownloadDir() {
    if (this._data.downloadDir) return this._data.downloadDir;
    let base = this._downloadsDir;
    if (!base) {
      try { base = require('electron').app.getPath('downloads'); } catch { base = path.join(os.homedir(), 'Downloads'); }
    }
    return path.join(base, 'Tunnelview');
  }

  /**
   * Validate + apply a partial update. Unknown keys are dropped, invalid values keep the old value,
   * `version` and `password` cannot be set here. Returns the full settings copy.
   */
  update(partial) {
    if (!isObj(partial)) return this.get();
    const next = clone(this._data);
    for (const key of Object.keys(partial)) {
      if (key === 'version' || !Object.prototype.hasOwnProperty.call(VALIDATORS, key)) continue;
      const val = VALIDATORS[key](partial[key], next[key], { fromDisk: false });
      if (val !== undefined) next[key] = val;
    }
    this._commit(next);
    return this.get();
  }

  /** @returns {Promise<{ok:boolean, error?:string}>} */
  async setPassword(pw) {
    if (pw === null || pw === undefined || pw === '') {
      const next = clone(this._data);
      next.password = null;
      this._commit(next);
      return { ok: true };
    }
    if (typeof pw !== 'string') return { ok: false, error: 'Password must be a string.' };
    const len = [...pw].length;
    if (len < LIMITS.PASSWORD_MIN) return { ok: false, error: `Password must be at least ${LIMITS.PASSWORD_MIN} characters.` };
    if (len > LIMITS.PASSWORD_MAX) return { ok: false, error: `Password must be at most ${LIMITS.PASSWORD_MAX} characters.` };
    if (pw.includes('\0')) return { ok: false, error: 'Password contains invalid characters.' };
    try {
      const auth = this._auth || require('./auth');
      const stored = await auth.hashPassword(pw);
      if (!validStoredPassword(stored)) return { ok: false, error: 'Password hashing produced an invalid result.' };
      const next = clone(this._data);
      next.password = clone(stored);
      this._commit(next);
      return { ok: true };
    } catch (err) {
      console.error('[settings] setPassword failed:', err);
      return { ok: false, error: 'Could not set the password.' };
    }
  }

  /** Trust a node for future auto-accept (prompt "trust" checkbox). Idempotent. */
  addTrusted(peer) {
    const e = normTrusted({ ...(isObj(peer) ? peer : {}), addedAt: Date.now() });
    if (!e) return false;
    const next = clone(this._data);
    next.trustedNodes = next.trustedNodes.filter((t) => t.stableId !== e.stableId);
    next.trustedNodes.push(e);
    if (next.trustedNodes.length > LIMITS.TRUSTED_MAX) next.trustedNodes = next.trustedNodes.slice(-LIMITS.TRUSTED_MAX);
    this._commit(next);
    return true;
  }

  removeTrusted(stableId) {
    if (typeof stableId !== 'string') return false;
    const next = clone(this._data);
    const before = next.trustedNodes.length;
    next.trustedNodes = next.trustedNodes.filter((t) => t.stableId !== stableId);
    if (next.trustedNodes.length === before) return false;
    this._commit(next);
    return true;
  }

  isTrusted(stableId) {
    return typeof stableId === 'string' && this._data.trustedNodes.some((t) => t.stableId === stableId);
  }

  /**
   * Remember an outgoing connection (most recent first, max 20, one entry per node).
   * entry = {stableId, hostname, ip, os, port?}; port (1–65535) is the signaling port that answered,
   * reused when the device is dialled again without an explicit port.
   */
  addRecent(entry) {
    const e = normRecent({ ...(isObj(entry) ? entry : {}), ts: Date.now() });
    if (!e) return false;
    const next = clone(this._data);
    const same = (r) => (e.stableId ? r.stableId === e.stableId : !r.stableId && r.ip === e.ip);
    next.recent = [e, ...next.recent.filter((r) => !same(r))].slice(0, LIMITS.RECENT_MAX);
    this._commit(next);
    return true;
  }

  /** @returns {boolean} the new favorite state */
  toggleFavorite(stableId) {
    if (!isStr(stableId, 1, LIMITS.ID_MAX)) return false;
    const next = clone(this._data);
    const on = !next.favorites.includes(stableId);
    next.favorites = on ? [...next.favorites, stableId] : next.favorites.filter((f) => f !== stableId);
    if (next.favorites.length > LIMITS.FAVORITES_MAX) return false;
    this._commit(next);
    return on;
  }

  /* ---------------------------------------------------------------- internals */

  _fromDisk(parsed) {
    // Migration hook: version < 1 (or missing) → v1. Unknown/new fields are dropped by validation.
    const out = clone(DEFAULTS);
    for (const key of Object.keys(VALIDATORS)) {
      if (!Object.prototype.hasOwnProperty.call(parsed, key)) continue;
      const val = VALIDATORS[key](parsed[key], out[key], { fromDisk: true });
      if (val !== undefined) out[key] = val;
    }
    out.version = SETTINGS_VERSION;
    return out;
  }

  _commit(next) {
    const changed = [];
    for (const key of Object.keys(next)) {
      if (JSON.stringify(next[key]) !== JSON.stringify(this._data[key])) changed.push(key);
    }
    if (!changed.length) return;
    this._data = next;
    this._persist();
    this.emit('change', this.get(), changed);
  }

  /** Atomic write: tmp file (fsync) → rename over settings.json. */
  _persist() {
    if (!this._dir) return false;
    const file = this.file;
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.mkdirSync(this._dir, { recursive: true });
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(this._data, null, 2) + '\n');
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
          if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
          sleepSync(15 * (attempt + 1));
        }
      }
      return true;
    } catch (err) {
      console.error('[settings] write failed:', err.message);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      return false;
    }
  }

  _cleanupTmp() {
    try {
      for (const name of fs.readdirSync(this._dir)) {
        if (name.startsWith(`${FILE_NAME}.`) && name.endsWith('.tmp')) {
          try { fs.unlinkSync(path.join(this._dir, name)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
}

const instance = new Settings();
module.exports = instance;
module.exports.Settings = Settings;
module.exports.DEFAULTS = DEFAULTS;
module.exports.LIMITS = LIMITS;
module.exports.validStoredPassword = validStoredPassword;
