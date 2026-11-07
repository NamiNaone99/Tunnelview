'use strict';
/*
 * Incoming file writer — docs/ARCHITECTURE.md §7 (files.js).
 *
 * Every renderer's transfers are namespaced by an owner id (webContents.id):
 *   await files.begin(ownerId, {id, name, size, purpose:'file'}) → {ok, reason?}
 *   await files.chunk(ownerId, id, Uint8Array)                   → {ok:true} once THIS chunk is on disk
 *                                                                  | {ok:false, reason}  (never rejects)
 *   await files.end(ownerId, id)                                 → {ok, path?, reason?}
 *   await files.abort(ownerId, id) / files.abortAll(ownerId) / files.forgetOwner(ownerId)
 *   files.abortAllSync()            // OS shutdown / log-off: close fds + delete every .part, synchronously
 *   await files.reveal(ownerId, id) → {ok, reason?}       (shell.showItemInFolder)
 *   await files.openFolder()        → {ok, path?, reason?} (shell.openPath)
 *   await files.prepareDir()        → {ok, path?, reason?} create the receive folder + check it is
 *                                     writable (macOS startup: Downloads privacy consent, see below)
 *
 * begin() reasons: 'bad-request' | 'unsupported-purpose' | 'too-large' | 'duplicate-id' | 'busy' |
 * 'no-space' | 'no-access' (EPERM/EACCES on the folder or the file, or the folder / the ".part"
 * creation did not answer within PREP_TIMEOUT_MS) | 'io-error'.
 *
 * Data is written to "<name>.part" and renamed (without overwriting) on a successful end().
 * Declared sizes are enforced: extra bytes → error, missing bytes at end() → error.
 *
 * macOS: the default receive folder ~/Downloads/Tunnelview is privacy-protected (TCC). The first
 * data access shows the Downloads-folder alert and the syscall (a libuv worker thread) blocks until
 * someone at the Mac answers it; the remote controller cannot (TCC ignores synthetic clicks).
 * index.js therefore calls prepareDir() at startup, while the user is at the Mac. Folder
 * preparation (mkdir -p, then on macOS a probe file ".tunnelview-write-test-<pid>" created and
 * deleted inside the folder, then statfs) is single-flight per directory: concurrent or repeated
 * begin() calls await the SAME pending promise and never issue another syscall while one is
 * pending, and begin() gives up after PREP_TIMEOUT_MS with 'no-access' (the pending syscall stays
 * shared). The probe is what triggers the alert when the folder already exists (after an update
 * or `tccutil reset`): mkdir, statfs and access() are metadata calls TCC lets through. begin()'s
 * own ".part" creation is time-boxed the same way (a late file is closed and deleted).
 *
 * Back-pressure: chunk() resolves only after its bytes were written, so the IPC caller ('files:chunk'
 * is an invoke) learns about slow disks and disk errors immediately. Bytes queued but not yet
 * written are also capped per transfer (MAX_PENDING) so a sender that ignores the replies cannot
 * grow main's memory without bound.
 *
 * Received files are untrusted: every published file is tagged like a browser download, best
 * effort (FAT/exFAT have no streams / xattrs):
 *   Windows → "<file>:Zone.Identifier" ADS with ZoneId=3 (SmartScreen, Office Protected View, MOTW)
 *   macOS   → com.apple.quarantine xattr (Gatekeeper)
 * begin() keeps a free-space floor of max(1 GiB, min(2 % of the volume, 4 GiB)) plus the bytes
 * still owed to running transfers, so a peer cannot fill the disk while a nearly full one still
 * receives files.
 *
 * Pure helpers sanitizeName() / uniquePath() are exported for tests. The default export is an
 * instance wired to settings.effectiveDownloadDir() and Electron's shell, both required lazily
 * so this module loads under plain Node.
 */
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const PROTOCOL = require('../shared/protocol');

const MAX_NAME_CHARS = 200;
// APFS/HFS+/NTFS limit names to 255 UTF-8 bytes / UTF-16 units; leave room for " (NNN)" and ".part".
const MAX_NAME_BYTES = 230;
const MAX_EXT_CHARS = 20;
const MAX_ACTIVE_PER_OWNER = 4;
const MAX_COMPLETED = 500;
const MAX_CHUNK = 4 * 1024 * 1024;
const MAX_PENDING = 256 * 1024 * 1024; // queued-but-unwritten bytes per transfer
const GIB = 1024 * 1024 * 1024;
const FREE_FLOOR_MIN = 1 * GIB;
const FREE_FLOOR_FRACTION = 0.02;
const FREE_FLOOR_FRACTION_CAP = 4 * GIB;
const ZONE_IDENTIFIER = '[ZoneTransfer]\r\nZoneId=3\r\nHostUrl=about:internet\r\n';
const XATTR_TIMEOUT_MS = 5000;
// begin() / openFolder() wait at most this long for the receive folder (mkdir + probe + statfs),
// and begin() as long again for its ".part" file.
const PREP_TIMEOUT_MS = 10000;
const ACCESS_CODES = ['EPERM', 'EACCES'];
// macOS folder preparation creates + deletes this file (+ pid) to trigger the TCC alert.
const PROBE_PREFIX = '.tunnelview-write-test-';

// FileHandles whose descriptor abortAllSync() closed with fs.closeSync. The FileHandle still
// believes it is open: if it were ever garbage-collected, its finalizer would close the (possibly
// reused) descriptor number a second time ("EBADF: Closing file descriptor N on garbage collection
// failed" → uncaughtException). Module-level, so this holds even when the receiver itself becomes
// unreachable (tests); abortAllSync runs once, at OS shutdown, so this never grows in practice.
const CLOSED_SYNC_HANDLES = [];

const ILLEGAL_RE = /[\\/:*?"<>|]/g;
// C0 + DEL + C1 controls.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;
// Bidi overrides/isolates and LRM/RLM: used to disguise extensions ("txt.exe" shown as "exe.txt").
const BIDI_RE = /[‎‏‪-‮⁦-⁩]/g;
// Windows reserved device names (also with any extension, case-insensitive, incl. superscript digits).
const RESERVED_RE = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
const ID_RE = /^[\x21-\x7e]{1,128}$/;

const utf8Len = (s) => Buffer.byteLength(s, 'utf8');

/** Truncate a stem by code points until stem+ext fits the char and byte budgets. */
function fitName(stem, ext) {
  const chars = Array.from(stem);
  let out = chars.join('');
  while (chars.length && ((out + ext).length > MAX_NAME_CHARS || utf8Len(out + ext) > MAX_NAME_BYTES)) {
    chars.pop();
    out = chars.join('');
  }
  return out.replace(/[. ]+$/, '') + ext;
}

/**
 * Make a peer-provided file name safe to create inside the download folder:
 * basename only, strip \ / : * ? " < > | + control + bidi chars, trim trailing dots/spaces,
 * cap at 200 chars (and 230 UTF-8 bytes), prefix reserved Windows device names with "_".
 */
function sanitizeName(input) {
  let s = typeof input === 'string' ? input.slice(0, 4096) : '';
  try { s = s.normalize('NFC'); } catch { /* lone surrogates etc. */ }
  const parts = s.split(/[\\/]/); // basename (both separators, on every platform)
  s = parts[parts.length - 1];
  s = s.replace(CONTROL_RE, '').replace(BIDI_RE, '').replace(ILLEGAL_RE, '');
  s = s.replace(/[\ud800-\udfff]/g, (c, i, str) => {
    // drop unpaired surrogates (not representable in file names)
    const code = c.charCodeAt(0);
    if (code <= 0xdbff) { const n = str.charCodeAt(i + 1); return n >= 0xdc00 && n <= 0xdfff ? c : ''; }
    const p = str.charCodeAt(i - 1); return p >= 0xd800 && p <= 0xdbff ? c : '';
  });
  s = s.trim().replace(/[. ]+$/, ''); // Windows silently drops trailing dots/spaces
  if (!s) s = 'file';

  let ext = path.extname(s);
  if (ext.length > MAX_EXT_CHARS || ext === s) ext = '';
  let stem = ext ? s.slice(0, -ext.length) : s;
  if (!stem.trim()) { stem = 'file'; }

  const firstSeg = s.split('.')[0].trim();
  if (RESERVED_RE.test(firstSeg)) stem = '_' + stem;
  return fitName(stem, ext);
}

/**
 * First free path for `name` in `dir`: "name.ext", then "name (1).ext", "name (2).ext", …
 * A name counts as taken if it or its ".part" sibling exists.
 * @param {(p:string)=>boolean} [exists]
 */
function uniquePath(dir, name, exists = (p) => fs.existsSync(p)) {
  let ext = path.extname(name);
  if (ext === name) ext = '';
  const stem = ext ? name.slice(0, -ext.length) : name;
  const taken = (n) => exists(path.join(dir, n)) || exists(path.join(dir, `${n}.part`));
  if (!taken(name)) return path.join(dir, name);
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken(candidate)) return path.join(dir, candidate);
  }
  return path.join(dir, `${stem} (${Date.now()})${ext}`);
}

/**
 * Bytes that must stay free on a volume of `totalBytes`: max(1 GiB, min(2 % of the volume, 4 GiB))
 * (128 GB → 2.56 GB, 1 TB and more → 4 GiB). Unknown volume size → the 1 GiB minimum.
 * begin() adds the bytes still owed to the other running transfers.
 */
function freeSpaceFloor(totalBytes) {
  const frac = Number.isFinite(totalBytes) && totalBytes > 0 ? Math.min(totalBytes * FREE_FLOOR_FRACTION, FREE_FLOOR_FRACTION_CAP) : 0;
  return Math.max(FREE_FLOOR_MIN, frac);
}

const codeError = (code, message) => Object.assign(new Error(message), { code });

/** begin()/openFolder() failure → reason. */
function failReason(err) {
  const code = err && err.code;
  if (code === 'ENOSPC_PRECHECK') return 'no-space';
  if (code === 'PREP_TIMEOUT' || ACCESS_CODES.includes(code)) return 'no-access';
  return 'io-error';
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
}

/** Default macOS quarantine writer: /usr/bin/xattr -w com.apple.quarantine <value> <file>. */
function defaultXattr(file, value) {
  return new Promise((resolve) => {
    try {
      execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, file], { timeout: XATTR_TIMEOUT_MS }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

class FileReceiver {
  /**
   * @param {{getDir?:()=>string, shell?:object, maxSize?:number, statfs?:(dir:string)=>Promise<object>,
   *          platform?:string, writeQuarantine?:(file:string, value:string)=>Promise<boolean>,
   *          fsp?:{mkdir?:Function, open?:Function, access?:Function, unlink?:Function},
   *          prepTimeoutMs?:number}} [opts]
   *   statfs: free-space source (default fs.promises.statfs); platform: tagging flavour and the
   *   macOS folder probe (default process.platform); writeQuarantine: macOS xattr writer (default
   *   /usr/bin/xattr); fsp: mkdir / open / access / unlink overrides (tests; open is used for the
   *   probe and the ".part" file, unlink for the probe); prepTimeoutMs: time box of the folder
   *   preparation and of the ".part" creation (default 10 s).
   */
  constructor(opts = {}) {
    this._getDir = opts.getDir || (() => require('./settings').effectiveDownloadDir());
    this._shellOpt = opts.shell || null;
    this._maxSize = Number.isSafeInteger(opts.maxSize) ? opts.maxSize : PROTOCOL.FILE.MAX_SIZE;
    this._statfs = typeof opts.statfs === 'function' ? opts.statfs : (typeof fsp.statfs === 'function' ? (d) => fsp.statfs(d) : null);
    this._platform = typeof opts.platform === 'string' ? opts.platform : process.platform;
    this._writeQuarantine = typeof opts.writeQuarantine === 'function' ? opts.writeQuarantine : defaultXattr;
    const o = opts.fsp && typeof opts.fsp === 'object' ? opts.fsp : {};
    this._fs = {
      mkdir: typeof o.mkdir === 'function' ? o.mkdir : (p, op) => fsp.mkdir(p, op),
      open: typeof o.open === 'function' ? o.open : (p, f, m) => fsp.open(p, f, m),
      access: typeof o.access === 'function' ? o.access : (p, m) => fsp.access(p, m),
      unlink: typeof o.unlink === 'function' ? o.unlink : (p) => fsp.unlink(p),
    };
    this._prepTimeoutMs = Number.isFinite(opts.prepTimeoutMs) && opts.prepTimeoutMs >= 0 ? opts.prepTimeoutMs : PREP_TIMEOUT_MS;
    this._preparing = new Map(); // dir → pending mkdir+probe+statfs promise (single flight)
    this._active = new Map();    // key → record
    this._completed = new Map(); // key → final path
    this._reserved = new Set();  // final paths reserved by in-flight transfers (lower-cased)
    this._closedSync = [];       // FileHandles whose fd abortAllSync() closed (also in CLOSED_SYNC_HANDLES)
  }

  get _shell() { return this._shellOpt || require('electron').shell; }

  _key(ownerId, id) { return `${ownerId}\u0000${id}`; }

  _isReserved(p) { return this._reserved.has(p.toLowerCase()); }

  /** @returns {Promise<{ok:boolean, reason?:string}>} */
  async begin(ownerId, meta) {
    if (meta === null || typeof meta !== 'object') return { ok: false, reason: 'bad-request' };
    const { id, name, size } = meta;
    const purpose = meta.purpose === undefined ? PROTOCOL.FILE.PURPOSE_FILE : meta.purpose;
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, reason: 'bad-request' };
    if (typeof name !== 'string' || name.length > 4096) return { ok: false, reason: 'bad-request' };
    if (purpose !== PROTOCOL.FILE.PURPOSE_FILE) return { ok: false, reason: 'unsupported-purpose' };
    if (!Number.isSafeInteger(size) || size < 0) return { ok: false, reason: 'bad-request' };
    if (size > this._maxSize) return { ok: false, reason: 'too-large' };
    const key = this._key(ownerId, id);
    if (this._active.has(key) || this._completed.has(key)) return { ok: false, reason: 'duplicate-id' };
    let mine = 0;
    for (const r of this._active.values()) if (r.ownerId === ownerId) mine++;
    if (mine >= MAX_ACTIVE_PER_OWNER) return { ok: false, reason: 'busy' };

    // Reserve the key synchronously so concurrent begin() calls with the same id fail fast.
    const rec = {
      key, ownerId, id, size, written: 0, queued: 0,
      state: 'opening', reason: null, fh: null, partPath: null, finalPath: null, chain: null,
    };
    this._active.set(key, rec);
    let resolveOpen;
    rec.chain = new Promise((r) => { resolveOpen = r; });
    try {
      const dir = this._getDir();
      const st = await this._prepareTimed(dir);
      this._checkSpace(st, size, key);
      const safe = sanitizeName(name);
      for (let attempt = 0; ; attempt++) {
        const finalPath = uniquePath(dir, safe, (p) => this._isReserved(p) || fs.existsSync(p));
        const partPath = `${finalPath}.part`;
        try {
          rec.fh = await this._openPartTimed(partPath); // exclusive create: never clobber
          rec.finalPath = finalPath;
          rec.partPath = partPath;
          this._reserved.add(finalPath.toLowerCase());
          break;
        } catch (err) {
          if (err.code !== 'EEXIST' || attempt >= 5) throw err;
        }
      }
      if (rec.state === 'opening') rec.state = 'receiving';
      resolveOpen();
      if (rec.state !== 'receiving') { await this._cleanup(rec); return { ok: false, reason: rec.reason || 'aborted' }; }
      return { ok: true };
    } catch (err) {
      resolveOpen();
      this._active.delete(key);
      if (rec.fh) { try { await rec.fh.close(); } catch { /* ignore */ } }
      if (rec.finalPath) this._reserved.delete(rec.finalPath.toLowerCase());
      const reason = failReason(err);
      if (reason === 'no-access') console.warn('[files] no access to the receive folder:', err.code);
      else if (reason === 'io-error') console.error('[files] begin failed:', err && err.message);
      return { ok: false, reason };
    }
  }

  /**
   * Create "<final>.part" exclusively ('wx'), time-boxed like the folder preparation: a create
   * that does not answer within the box rejects with code PREP_TIMEOUT (→ 'no-access'). Such a
   * late open still completes in the background; its handle is then closed and the file it
   * created deleted (nobody owns it any more; 'wx' guarantees it is ours).
   * @returns {Promise<import('fs').promises.FileHandle>}
   */
  _openPartTimed(partPath) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(codeError('PREP_TIMEOUT', 'the receive folder did not answer'));
      }, this._prepTimeoutMs);
      new Promise((r) => r(this._fs.open(partPath, 'wx', 0o644))).then((fh) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve(fh); return; }
        (async () => {
          try { await fh.close(); } catch { /* ignore */ }
          try { await this._fs.unlink(partPath); } catch { /* already gone */ }
        })();
      }, (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * macOS: create and delete a probe file inside `dir`. mkdir of an EXISTING folder, statfs and
   * access() are metadata calls that TCC lets through, so without a real data operation the
   * Downloads-folder alert would wait for the first offered file (mid-session, where nobody can
   * answer it). EPERM/EACCES propagate ('no-access'); an existing probe (a crashed run with the
   * same pid, or a file of that name) counts as success and is left alone (we did not create it).
   */
  async _probeWrite(dir) {
    const probe = path.join(dir, `${PROBE_PREFIX}${process.pid}`);
    let fh;
    try {
      fh = await this._fs.open(probe, 'wx', 0o600);
    } catch (err) {
      if (err && err.code === 'EEXIST') return;
      throw err;
    }
    try { await fh.close(); } catch { /* ignore */ }
    try {
      await this._fs.unlink(probe);
    } catch (err) {
      if (err && ACCESS_CODES.includes(err.code)) throw err;
      // ENOENT (already gone) or a transient error: a stray empty probe file is harmless.
    }
  }

  /**
   * mkdir -p (+ the macOS probe) + statfs of `dir`, single flight per directory: while one is
   * pending (macOS holds the syscall until someone answers the Downloads privacy alert), every
   * caller awaits the same promise, so a blocked folder ties up one libuv thread, not one per
   * offered file.
   * Resolves the statfs result (null when unsupported); rejects with the mkdir or probe error, or
   * with a statfs EPERM/EACCES.
   * @returns {Promise<object|null>}
   */
  _prepare(dir) {
    const pending = this._preparing.get(dir);
    if (pending) return pending;
    const p = (async () => {
      await this._fs.mkdir(dir, { recursive: true });
      if (this._platform === 'darwin') await this._probeWrite(dir);
      if (!this._statfs) return null;
      try {
        return (await this._statfs(dir)) || null;
      } catch (err) {
        if (err && ACCESS_CODES.includes(err.code)) throw err;
        return null; // not supported on this filesystem → no free-space check
      }
    })();
    this._preparing.set(dir, p);
    const drop = () => { if (this._preparing.get(dir) === p) this._preparing.delete(dir); };
    p.then(drop, drop);
    return p;
  }

  /** _prepare(dir) time-boxed: rejects with code PREP_TIMEOUT; the pending syscall stays shared. */
  _prepareTimed(dir) {
    let timer = null;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(codeError('PREP_TIMEOUT', 'the receive folder did not answer')), this._prepTimeoutMs);
    });
    return Promise.race([this._prepare(dir), timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Create the receive folder and check that it is writable (no time box: callers run it in the
   * background). index.js runs it on macOS at startup / when hosting is switched on / when the
   * folder changes, so the Downloads privacy alert (triggered by the probe file, also when the
   * folder already exists) appears while the user is at the Mac.
   * @returns {Promise<{ok:true, path:string} | {ok:false, reason:string}>}
   */
  async prepareDir() {
    try {
      const dir = this._getDir();
      await this._prepare(dir);
      await this._fs.access(dir, fs.constants.W_OK);
      return { ok: true, path: dir };
    } catch (err) {
      return { ok: false, reason: failReason(err) };
    }
  }

  /**
   * Refuse when the volume would drop below the free-space floor after this file and the bytes
   * still owed to the other in-flight transfers. `st` = statfs result (null → no check).
   */
  _checkSpace(st, size, key) {
    if (!st) return;
    const bsize = Number(st.bsize);
    const free = Number(st.bavail) * bsize;
    const total = Number(st.blocks) * bsize;
    if (!Number.isFinite(free) || free <= 0) return; // nonsense numbers (some network shares)
    let owed = 0;
    for (const r of this._active.values()) if (r.key !== key) owed += Math.max(0, r.size - r.written);
    if (free - owed - size < freeSpaceFloor(total)) {
      const e = new Error('not enough disk space'); e.code = 'ENOSPC_PRECHECK'; throw e;
    }
  }

  /**
   * Queue one chunk. Resolves {ok:true} once THIS chunk is on disk, or {ok:false, reason} at once
   * when the transfer is unknown/failed or the chunk is invalid, or when its write fails. Never rejects.
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  chunk(ownerId, id, data) {
    const rec = this._active.get(this._key(ownerId, id));
    if (!rec) return Promise.resolve({ ok: false, reason: 'unknown-transfer' });
    if (rec.state !== 'receiving' && rec.state !== 'opening') return Promise.resolve({ ok: false, reason: rec.reason || 'aborted' });
    const buf = toBuffer(data);
    if (!buf || buf.length > MAX_CHUNK) { this._fail(rec, 'bad-chunk'); return Promise.resolve({ ok: false, reason: 'bad-chunk' }); }
    if (rec.queued + buf.length > rec.size) { this._fail(rec, 'size-exceeded'); return Promise.resolve({ ok: false, reason: 'size-exceeded' }); }
    if (rec.queued - rec.written + buf.length > MAX_PENDING) { this._fail(rec, 'overloaded'); return Promise.resolve({ ok: false, reason: 'overloaded' }); }
    rec.queued += buf.length;
    if (buf.length === 0) return Promise.resolve({ ok: true });
    let result = { ok: false, reason: 'aborted' };
    const done = rec.chain.then(async () => {
      if (rec.state !== 'receiving') { result = { ok: false, reason: rec.reason || 'aborted' }; return; }
      let off = 0;
      while (off < buf.length) {
        const { bytesWritten } = await rec.fh.write(buf, off, buf.length - off, null);
        if (!bytesWritten) throw new Error('short write');
        off += bytesWritten;
      }
      rec.written += buf.length;
      result = { ok: true };
    }).catch((err) => {
      const reason = err && err.code === 'ENOSPC' ? 'no-space' : 'io-error';
      this._fail(rec, reason);
      result = { ok: false, reason: rec.reason || reason };
    });
    rec.chain = done;
    return done.then(() => result, () => result);
  }

  /** Finish a transfer. @returns {Promise<{ok:boolean, path?:string, reason?:string}>} */
  async end(ownerId, id) {
    const key = this._key(ownerId, id);
    const rec = this._active.get(key);
    if (!rec) {
      const done = this._completed.get(key);
      return done ? { ok: true, path: done } : { ok: false, reason: 'unknown-transfer' };
    }
    await rec.chain;
    if (rec.state === 'receiving' && rec.written !== rec.size) this._fail(rec, 'size-mismatch');
    if (rec.state !== 'receiving') {
      await this._cleanup(rec);
      return { ok: false, reason: rec.reason || 'aborted' };
    }
    rec.state = 'finishing';
    try {
      try { await rec.fh.sync(); } catch { /* best effort */ }
      await rec.fh.close();
      rec.fh = null;
      const finalPath = await this._publish(rec);
      rec.state = 'done';
      this._active.delete(key);
      this._reserved.delete(rec.finalPath.toLowerCase());
      this._remember(key, finalPath);
      await this._tagUntrusted(finalPath);
      return { ok: true, path: finalPath };
    } catch (err) {
      console.error('[files] finishing failed:', err && err.message);
      rec.state = 'error';
      rec.reason = 'io-error';
      await this._cleanup(rec);
      return { ok: false, reason: 'io-error' };
    }
  }

  /**
   * Mark a received file as coming from the internet (Mark-of-the-Web / quarantine) so the OS
   * applies SmartScreen, Office Protected View and Gatekeeper. Best effort: filesystems without
   * alternate data streams / extended attributes (FAT, exFAT, some shares) just stay untagged.
   * The stream is written to the FINAL path (a hard link shares it with the former .part).
   */
  async _tagUntrusted(finalPath) {
    try {
      if (this._platform === 'win32') {
        await fsp.writeFile(`${finalPath}:Zone.Identifier`, ZONE_IDENTIFIER);
      } else if (this._platform === 'darwin') {
        const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};Tunnelview;`;
        await this._writeQuarantine(finalPath, value);
      }
    } catch (err) {
      console.warn('[files] could not mark the received file as untrusted:', err && err.code ? err.code : err && err.message);
    }
  }

  /**
   * Move "<final>.part" to a free final name without ever overwriting an existing file:
   * hard-link (fails with EEXIST if taken) then unlink the .part. Filesystems without hard links
   * (FAT/exFAT, some network shares) fall back to exists-check + rename.
   */
  async _publish(rec) {
    const dir = path.dirname(rec.finalPath);
    const base = path.basename(rec.finalPath);
    const own = rec.finalPath.toLowerCase();
    // Our own .part and our own reservation must not count as "taken".
    const taken = (p) => {
      if (p === rec.partPath) return false;
      if (fs.existsSync(p)) return true;
      return p.toLowerCase() !== own && this._isReserved(p);
    };
    let target = rec.finalPath;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        await fsp.link(rec.partPath, target);
        await fsp.unlink(rec.partPath).catch(() => {});
        return target;
      } catch (err) {
        if (err.code !== 'EEXIST' && !fs.existsSync(target)) {
          // No hard-link support on this filesystem → plain rename into the (still free) name.
          await fsp.rename(rec.partPath, target);
          return target;
        }
        target = uniquePath(dir, base, taken);
      }
    }
    throw new Error('could not find a free file name');
  }

  _remember(key, finalPath) {
    this._completed.set(key, finalPath);
    while (this._completed.size > MAX_COMPLETED) this._completed.delete(this._completed.keys().next().value);
  }

  _fail(rec, reason) {
    if (rec.state !== 'receiving' && rec.state !== 'opening') return;
    rec.state = 'error';
    rec.reason = reason;
    // Close + delete the .part once pending writes settle; the record stays until end()/abort().
    rec.chain = rec.chain.then(() => this._closeAndUnlink(rec));
  }

  async _closeAndUnlink(rec) {
    if (rec.fh) {
      const fh = rec.fh;
      rec.fh = null;
      try { await fh.close(); } catch { /* ignore */ }
    }
    if (rec.partPath) {
      try { await fsp.unlink(rec.partPath); } catch { /* already gone */ }
    }
  }

  async _cleanup(rec) {
    await rec.chain;
    await this._closeAndUnlink(rec);
    this._active.delete(rec.key);
    if (rec.finalPath) this._reserved.delete(rec.finalPath.toLowerCase());
  }

  /** Cancel a transfer and delete its partial file. */
  async abort(ownerId, id) {
    const rec = this._active.get(this._key(ownerId, id));
    if (!rec) return false;
    if (rec.state === 'receiving' || rec.state === 'opening') { rec.state = 'aborted'; rec.reason = 'aborted'; }
    if (rec.state === 'finishing') return false; // end() is completing it
    await this._cleanup(rec);
    return true;
  }

  /** Abort every in-flight transfer of one owner (window closed / permission revoked). */
  async abortAll(ownerId) {
    const recs = [...this._active.values()].filter((r) => r.ownerId === ownerId);
    await Promise.all(recs.map((r) => this.abort(ownerId, r.id)));
    return recs.length;
  }

  /**
   * Synchronous teardown for OS shutdown / log-off (no event-loop turns left): close every open
   * .part descriptor and delete every .part file of every owner, ignoring errors.
   * @returns {number} transfers aborted
   */
  abortAllSync() {
    const recs = [...this._active.values()];
    for (const rec of recs) {
      if (rec.state !== 'finishing' && rec.state !== 'done') { rec.state = 'aborted'; rec.reason = rec.reason || 'aborted'; }
      if (rec.fh) {
        const fh = rec.fh;
        const fd = fh.fd;
        rec.fh = null;
        try { if (Number.isInteger(fd) && fd >= 0) fs.closeSync(fd); } catch { /* ignore */ }
        // The FileHandle still believes it is open; keep it referenced for the life of the process
        // (CLOSED_SYNC_HANDLES) so garbage collection never "closes" its (possibly reused)
        // descriptor number a second time.
        CLOSED_SYNC_HANDLES.push(fh);
        this._closedSync.push(fh);
      }
      if (rec.partPath) { try { fs.unlinkSync(rec.partPath); } catch { /* already gone */ } }
      this._active.delete(rec.key);
      if (rec.finalPath) this._reserved.delete(rec.finalPath.toLowerCase());
    }
    return recs.length;
  }

  /** abortAll + drop the owner's completed-transfer records (window destroyed). */
  async forgetOwner(ownerId) {
    await this.abortAll(ownerId);
    const prefix = `${ownerId}\u0000`;
    for (const key of [...this._completed.keys()]) if (key.startsWith(prefix)) this._completed.delete(key);
  }

  activeCount(ownerId) {
    let n = 0;
    for (const r of this._active.values()) if (ownerId === undefined || r.ownerId === ownerId) n++;
    return n;
  }

  /** Show a completed file in Explorer/Finder. */
  async reveal(ownerId, id) {
    const p = this._completed.get(this._key(ownerId, id));
    if (!p) return { ok: false, reason: 'unknown-transfer' };
    if (!fs.existsSync(p)) return { ok: false, reason: 'not-found' };
    this._shell.showItemInFolder(p);
    return { ok: true };
  }

  /** Open the download folder (created if missing). */
  async openFolder() {
    try {
      const dir = this._getDir();
      await this._prepareTimed(dir);
      const err = await this._shell.openPath(dir);
      return err ? { ok: false, reason: err } : { ok: true, path: dir };
    } catch (err) {
      const reason = failReason(err);
      return { ok: false, reason: reason === 'io-error' && err && err.message ? err.message : reason };
    }
  }
}

const instance = new FileReceiver();
module.exports = instance;
module.exports.FileReceiver = FileReceiver;
module.exports.sanitizeName = sanitizeName;
module.exports.uniquePath = uniquePath;
module.exports.freeSpaceFloor = freeSpaceFloor;
module.exports.MAX_NAME_CHARS = MAX_NAME_CHARS;
