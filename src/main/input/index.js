'use strict';
/*
 * Input injection facade (ARCHITECTURE §5 `input` data channel, §7 input/index.js).
 *
 *   const input = require('./input');
 *   input.available / input.reason      lazy: first access loads the native backend
 *   input.setDisplay(display)           Electron Display (or {id, bounds, scaleFactor}) being streamed; null → primary
 *   input.handle(evt)                   one parsed `input` message; invalid messages are silently dropped
 *   input.releaseAll()                  release every key/button we hold (session end, viewer blur)
 *   input.reset()                       session boundary: releaseAll() + forget the lock-key resync state
 *   input.refreshPermission()           macOS: re-check AXIsProcessTrusted → {available, reason, blocked}
 *   input.blocked                       null | 'secure-desktop' | 'elevated-window' (Windows; macOS: null)
 *   input.status()                      {available, reason, blocked}
 *   input.physicalRect(display)         Windows: exact physical-pixel rect of an Electron Display; else null
 *   input.setPointerGuard(fn)           fn({dip, window}) → true where the host's own session UI is
 *   input.setKeyGuard(fn)               fn() → true while the host's own session UI has keyboard focus
 *
 * Session-UI guards (ARCHITECTURE §1 invariant 7): the viewer sees the host's session panel and
 * approval prompt in the stream; its clicks and keystrokes must not operate them.
 *   pointer: a press (`md`) on guarded UI is dropped, a held-button move onto it is dropped (no drag
 *            or drop onto it) and a release there happens at the last injected point instead. The
 *            guard gets the point in DIP of the streamed display (`dip`, null if unknown) and, on
 *            Windows, the top-level owner HWND really under the injected physical point (`window`:
 *            BigInt | null = no window | undefined = unknown), so whatever is drawn above the panel
 *            (flyouts, menus) stays clickable and the panel's own dialogs count as the panel.
 *            Hover and wheel are not guarded.
 *   keys:    while it returns true, `kd` / `combo` / `txt` are dropped (`ku` of a held key still goes
 *            through, so nothing sticks).
 * A guard that throws counts as "guarded" (fail closed). This is a guard against the viewer driving the
 * panel or prompt directly, not a sandbox: a viewer with Control can still run programs or OS
 * accessibility features (e.g. MouseKeys) on the host.
 *
 * Trust boundary: `evt` comes from the remote viewer (data channel → panel renderer → IPC). Every field
 * is type-checked, ranges are clamped, unknown types/extra fields are ignored, and nothing from the
 * event is ever used as an object key without going through a Map (see keymap.js).
 *
 * Coordinates: `x,y` ∈ [0,1] relative to the streamed display.
 *   Windows → physical rect = the monitor's exact rcMonitor (backend.monitorRect at the display centre,
 *             dipToScreenPoint); fallback screen.dipToScreenRect(null, display.bounds), which rounds
 *             outward (2560 px @150 % → 2561). pixel = rect.x + ⌊x·w⌋ (the backend normalizes against
 *             the virtual desktop).
 *   macOS   → global display points: bounds.x + x·bounds.width, kept inside the display so the last
 *             physical pixel is reachable but the pointer never lands on a neighbouring display.
 *
 * Unavailable reasons: 'unsupported-platform' | 'native-unavailable' (koffi/library failed to load) |
 * 'accessibility-permission' (macOS) | 'native-error'.
 *
 * Blocked (Windows; input is "available" but cannot reach its target): UIPI silently drops input to
 * elevated windows and SendInput fails on the secure desktop. backend.blockedReason() is probed before
 * `md`/`kd` (≤ 1 per PROBE_INTERVAL_MS, md at its point, kd → foreground window), right after a
 * SendInput shortfall, and again when `blocked` is read while set (so the state clears).
 *
 * Lock keys: `kd` may carry `locks: {caps, num?}` (the viewer's Caps/Num Lock state). Before a
 * non-lock, non-modifier key the host is resynced: Windows taps CapsLock (any such key) / NumLock
 * (Numpad* keys) when the host toggle differs; macOS sets the backend's emulated Caps Lock.
 * The Windows tap goes through backend.tapLock() (VK_CAPITAL / VK_NUMLOCK by virtual key: the
 * physical CapsLock scancode is Eisu on Japanese layouts). The next trusted read verifies it; after
 * LOCK_GIVE_UP consecutive taps that did not change the host state (remapped CapsLock, "press Shift
 * to turn off Caps Lock", stale reads) that lock is no longer resynced until the viewer's requested
 * value changes or reset() runs (session end) — never a tap on every other keystroke.
 */
const PROTOCOL = require('../../shared/protocol');
const keymap = require('./keymap');

const I = PROTOCOL.INPUT;
const CODE_RE = /^[A-Za-z0-9]+$/;
const MAX_CODE_LEN = 32;
const MAX_KEY_LEN = 32;
const MAX_COMBO = 6;
const MAX_WHEEL_PX = 20000; // per message; PAGE-mode deltas (×800) stay well inside
const PERMISSION_RECHECK_MS = 2000;
const RECT_TTL_MS = 2000; // backstop in case screen change events are missed
const LOG_INTERVAL_MS = 5000;
const PROBE_INTERVAL_MS = 500; // blockedReason() before md/kd (and on `blocked` reads) at most this often
const PROBE_SHORTFALL_MS = 100; // …and right after a SendInput shortfall, at most this often
const BLOCKED_REASONS = new Set(['secure-desktop', 'elevated-window']);
const LOCK_CODES = new Set(['CapsLock', 'NumLock', 'ScrollLock']);
const LOCK_TAP_MS = 300; // at most one resync tap per lock per 300 ms (no oscillation)
// Windows lock-state reads are per-thread and resynced lazily (win32.js notes): the first read after a
// change may be stale, the system applies the update within one message-pump turn. A read is trusted
// only when an earlier read of the same chain is ≥ LOCK_SETTLE_MS old; a chain breaks after
// LOCK_TRUST_MS without reads or when we inject a lock key. Other events keep it warm.
const LOCK_SETTLE_MS = 50;
const LOCK_TRUST_MS = 2000;
const LOCK_PRIME_MS = 250;
// Consecutive resync taps that left the host state unchanged before that lock's resync pauses.
const LOCK_GIVE_UP = 2;

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function isValidCode(code) {
  return typeof code === 'string' && code.length > 0 && code.length <= MAX_CODE_LEN && CODE_RE.test(code);
}

/** `kd.locks` → {caps, num?} with only those booleans, or null (missing/malformed: field dropped). */
function validLocks(v) {
  if (!isObject(v) || typeof v.caps !== 'boolean') return null;
  if (v.num !== undefined && typeof v.num !== 'boolean') return null;
  return typeof v.num === 'boolean' ? { caps: v.caps, num: v.num } : { caps: v.caps };
}

/**
 * Validates and normalizes one `input` message.
 * @returns {object|null} a fresh object containing only the known, checked fields — or null (drop).
 */
function validate(evt) {
  if (!isObject(evt) || typeof evt.t !== 'string') return null;
  const t = evt.t;
  switch (t) {
    case I.MOUSE_MOVE: {
      if (!isFiniteNumber(evt.x) || !isFiniteNumber(evt.y)) return null;
      return { t, x: clamp(evt.x, 0, 1), y: clamp(evt.y, 0, 1) };
    }
    case I.MOUSE_DOWN:
    case I.MOUSE_UP: {
      if (!Number.isInteger(evt.b) || evt.b < 0 || evt.b > 4) return null;
      if (!isFiniteNumber(evt.x) || !isFiniteNumber(evt.y)) return null;
      let n = 1;
      if (evt.n !== undefined) {
        if (!isFiniteNumber(evt.n)) return null;
        n = clamp(Math.trunc(evt.n), 1, 3);
      }
      return { t, b: evt.b, x: clamp(evt.x, 0, 1), y: clamp(evt.y, 0, 1), n };
    }
    case I.WHEEL: {
      const dx = evt.dx === undefined ? 0 : evt.dx;
      const dy = evt.dy === undefined ? 0 : evt.dy;
      if (!isFiniteNumber(dx) || !isFiniteNumber(dy)) return null;
      return { t, dx: clamp(dx, -MAX_WHEEL_PX, MAX_WHEEL_PX), dy: clamp(dy, -MAX_WHEEL_PX, MAX_WHEEL_PX) };
    }
    case I.KEY_DOWN:
    case I.KEY_UP: {
      const code = evt.code;
      // '' is what Chromium reports for keys it cannot identify (DomCode::NONE): treated as unknown.
      if (typeof code !== 'string' || code.length > MAX_CODE_LEN || (code !== '' && !CODE_RE.test(code))) return null;
      // `key` only feeds the unknown-code text fallback, so a malformed one is ignored rather than
      // costing the (validated) key press itself.
      const key = typeof evt.key === 'string' && evt.key.length <= MAX_KEY_LEN ? evt.key : '';
      if (evt.rep !== undefined && typeof evt.rep !== 'boolean') return null;
      const out = { t, code, key, rep: t === I.KEY_DOWN && evt.rep === true };
      if (t === I.KEY_DOWN) {
        // Optional and advisory: a malformed `locks` costs the field, never the key press.
        const locks = validLocks(evt.locks);
        if (locks) out.locks = locks;
      }
      return out;
    }
    case I.TEXT: {
      if (typeof evt.text !== 'string' || evt.text.length === 0 || evt.text.length > I.MAX_TEXT) return null;
      return { t, text: evt.text };
    }
    case I.COMBO: {
      const codes = evt.codes;
      if (!Array.isArray(codes) || codes.length === 0 || codes.length > MAX_COMBO) return null;
      for (const c of codes) if (!isValidCode(c)) return null;
      return { t, codes: codes.slice() };
    }
    case I.RELEASE_ALL:
      return { t };
    default:
      return null;
  }
}

function isControlCodePoint(cp) {
  return cp < 0x20 || (cp >= 0x7F && cp < 0xA0);
}

/** `key` if it is exactly one printable code point (e.g. 'é', '€', '😀'), else null. */
function printableChar(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 2) return null;
  const cp = key.codePointAt(0);
  if (String.fromCodePoint(cp).length !== key.length) return null; // more than one code point
  if (isControlCodePoint(cp)) return null;
  if (cp >= 0xD800 && cp <= 0xDFFF) return null; // lone surrogate
  return key;
}

/**
 * Splits text for injection: runs of printable text, plus Enter/Tab key presses for '\n' / '\t'
 * (Unicode-injected newlines are not understood by most apps). CR/CRLF → LF, other control
 * characters are dropped, lone surrogates become U+FFFD.
 * @returns {Array<{text:string}|{code:'Enter'|'Tab'}>}
 */
function segmentText(text) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ text: buf });
    buf = '';
  };
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    const cp = ch.codePointAt(0);
    if (ch === '\n' || ch === '\t') {
      flush();
      out.push({ code: ch === '\n' ? 'Enter' : 'Tab' });
    } else if (isControlCodePoint(cp)) {
      continue;
    } else if (cp >= 0xD800 && cp <= 0xDFFF) {
      buf += '�';
    } else {
      buf += ch;
    }
  }
  flush();
  return out;
}

function validRect(r) {
  return isObject(r) && isFiniteNumber(r.x) && isFiniteNumber(r.y) &&
    isFiniteNumber(r.width) && isFiniteNumber(r.height) && r.width >= 1 && r.height >= 1;
}

function validScale(sf) {
  return isFiniteNumber(sf) && sf > 0 && sf <= 16 ? sf : 1;
}

/**
 * Exact physical rect of the monitor showing DIP bounds `b` (Windows): the backend's rcMonitor at the
 * display centre. Only trusted if the monitor contains that point (MONITOR_DEFAULTTONEAREST could
 * otherwise return a neighbour). @returns {{x,y,width,height}|null}
 */
function monitorRectFor(scr, b, backend) {
  if (!backend || typeof backend.monitorRect !== 'function' || !scr || typeof scr.dipToScreenPoint !== 'function') return null;
  try {
    const c = scr.dipToScreenPoint({ x: Math.floor(b.x + b.width / 2), y: Math.floor(b.y + b.height / 2) });
    if (!isObject(c) || !isFiniteNumber(c.x) || !isFiniteNumber(c.y)) return null;
    const p = { x: Math.round(c.x), y: Math.round(c.y) };
    const r = backend.monitorRect(p);
    if (!validRect(r)) return null;
    if (p.x < r.x || p.y < r.y || p.x >= r.x + r.width || p.y >= r.y + r.height) return null;
    return r;
  } catch {
    return null;
  }
}

/**
 * Platform rect for a display: Windows → physical pixels, macOS → points.
 * @param {object} [backend] Windows: provides monitorRect(pt) for the exact rect
 * @returns {{x,y,width,height,scaleFactor}|null}
 */
function displayRect(platform, scr, display, backend) {
  if (!isObject(display) || !validRect(display.bounds)) return null;
  const b = display.bounds;
  const scaleFactor = validScale(display.scaleFactor);
  if (platform === 'win32') {
    let r = monitorRectFor(scr, b, backend);
    if (!validRect(r) && scr && typeof scr.dipToScreenRect === 'function') {
      try {
        r = scr.dipToScreenRect(null, { x: b.x, y: b.y, width: b.width, height: b.height });
      } catch {
        r = null;
      }
    }
    // Fallback (no screen module): exact for the primary display, approximate for mixed-DPI setups.
    if (!validRect(r)) r = { x: b.x * scaleFactor, y: b.y * scaleFactor, width: b.width * scaleFactor, height: b.height * scaleFactor };
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)), scaleFactor };
  }
  return { x: b.x, y: b.y, width: b.width, height: b.height, scaleFactor };
}

/**
 * Normalized [0,1] → platform coordinates inside `rect`.
 * Windows: integer physical pixel, max = last pixel of the display.
 * macOS: fractional points, max = width − 1/scaleFactor (= the last physical pixel; an integer in
 * pixel space, so CG rounding can never push the pointer onto a neighbouring display).
 */
function mapPoint(platform, rect, x, y) {
  if (platform === 'win32') {
    return {
      x: rect.x + Math.min(Math.floor(x * rect.width), rect.width - 1),
      y: rect.y + Math.min(Math.floor(y * rect.height), rect.height - 1),
    };
  }
  const e = 1 / validScale(rect.scaleFactor);
  return {
    x: rect.x + Math.max(0, Math.min(x * rect.width, rect.width - e)),
    y: rect.y + Math.max(0, Math.min(y * rect.height, rect.height - e)),
  };
}

function isAltOrWin(code) {
  const kind = keymap.modifierKind(code);
  return kind === 'alt' || kind === 'meta';
}

function defaultLoadBackend(platform) {
  if (platform === 'win32') return require('./win32').createBackend();
  if (platform === 'darwin') return require('./darwin').createBackend();
  return null;
}

// ---------------------------------------------------------------------------------------------
// Injector
// ---------------------------------------------------------------------------------------------

/**
 * @param {object} [opts]
 * @param {string} [opts.platform]      defaults to process.platform
 * @param {object} [opts.backend]       pre-built backend (tests); skips native loading
 * @param {Function} [opts.loadBackend] (platform) → backend; may throw
 * @param {object|null} [opts.screen]   Electron-like screen module (tests); default require('electron').screen lazily
 * @param {Function} [opts.now]         clock (tests)
 * @param {Function} [opts.log]         logger (default console.warn)
 */
function _createInjector(opts = {}) {
  const platform = opts.platform || process.platform;
  const loadBackend = opts.loadBackend || defaultLoadBackend;
  const now = opts.now || Date.now;
  const log = opts.log || ((...args) => console.warn('[input]', ...args));
  const hasScreenOpt = Object.prototype.hasOwnProperty.call(opts, 'screen');

  let backend = opts.backend || null;
  let initialized = false;
  const status = { available: false, reason: null, error: null };
  let lastPermissionCheck = 0;
  let lastLog = -Infinity;

  let selected = null; // { id: string|null, display: object|null }
  let rectCache = null;
  let rectAt = -Infinity;
  let screenHooked = false;

  const heldKeys = new Set(); // codes, insertion order = press order
  const heldButtons = new Set(); // DOM buttons
  let lastPoint = null; // last platform coordinate we moved to
  let pointerGuard = null; // ({dip, window}) → true on the host's own session UI (see the header)
  let keyGuard = null; // () → true while the host's own session UI has keyboard focus

  let blocked = null; // null | 'secure-desktop' | 'elevated-window'
  let lastProbeAt = -Infinity;
  let lastProbePoint = null; // the point the last probe used (null = foreground window)

  // Windows lock-state read chain + per-lock resync bookkeeping (see LOCK_* constants and resetLocks)
  const locksState = { lastRead: -Infinity, chainStart: -Infinity, caps: null, num: null };
  resetLocks();

  function logError(where, err) {
    const t = now();
    if (t - lastLog < LOG_INTERVAL_MS) return;
    lastLog = t;
    try { log(`${where} failed:`, err && err.message ? err.message : String(err)); } catch { /* ignore */ }
  }

  function safe(where, fn) {
    try { fn(); } catch (err) { logError(where, err); }
  }

  // --- backend / permission ---

  function ensureInit() {
    if (initialized) return;
    initialized = true;
    if (!backend) {
      if (platform !== 'win32' && platform !== 'darwin') {
        status.reason = 'unsupported-platform';
        return;
      }
      try {
        backend = loadBackend(platform);
      } catch (err) {
        backend = null;
        status.reason = 'native-unavailable';
        status.error = err && err.message ? err.message : String(err);
        logError('native load', err);
        return;
      }
      if (!backend) {
        status.reason = 'unsupported-platform';
        return;
      }
    }
    refreshPermission();
  }

  function snapshot() {
    return { available: status.available, reason: status.reason, blocked };
  }

  /**
   * ensureInit + throttled re-check while unavailable for a recoverable reason (macOS: the user may
   * grant Accessibility mid-session). Callers such as ipc.js gate on `available` before handle(),
   * so the getter itself must notice the grant. AXIsProcessTrusted is cheap; ≤ 1 call / 2 s.
   */
  function current() {
    ensureInit();
    if (!status.available && backend && now() - lastPermissionCheck >= PERMISSION_RECHECK_MS) refreshPermission();
    return status;
  }

  function refreshPermission() {
    ensureInit();
    if (!backend) return snapshot();
    lastPermissionCheck = now();
    let r;
    try {
      r = backend.check();
    } catch (err) {
      logError('permission check', err);
      r = { available: false, reason: 'native-error' };
    }
    status.available = !!(r && r.available);
    status.reason = status.available ? null : String((r && r.reason) || 'native-error');
    return snapshot();
  }

  // --- display mapping ---

  function getScreen() {
    if (hasScreenOpt) return opts.screen || null;
    try {
      // Only valid after app 'ready'; before that (or outside Electron) this yields null / throws.
      const s = require('electron').screen;
      return s && typeof s.getPrimaryDisplay === 'function' ? s : null;
    } catch {
      return null;
    }
  }

  function invalidateRect() {
    rectCache = null;
    rectAt = -Infinity;
  }

  function hookScreen(scr) {
    if (screenHooked || typeof scr.on !== 'function') return;
    screenHooked = true;
    try {
      scr.on('display-metrics-changed', invalidateRect);
      scr.on('display-added', invalidateRect);
      scr.on('display-removed', invalidateRect);
    } catch { /* TTL still refreshes */ }
  }

  function resolveDisplay(scr) {
    if (!scr) return selected ? selected.display : null;
    try {
      if (selected) {
        if (selected.id !== null && typeof scr.getAllDisplays === 'function') {
          const all = scr.getAllDisplays();
          const fresh = Array.isArray(all) ? all.find((d) => d && String(d.id) === selected.id) : null;
          if (fresh) return fresh; // current bounds (resolution / arrangement may have changed)
        }
        if (selected.display) return selected.display;
      }
      return scr.getPrimaryDisplay();
    } catch {
      return selected ? selected.display : null;
    }
  }

  function currentRect() {
    const t = now();
    if (t - rectAt < RECT_TTL_MS) return rectCache;
    const scr = getScreen();
    if (scr) hookScreen(scr);
    const display = resolveDisplay(scr);
    rectCache = display ? displayRect(platform, scr, display, backend) : null;
    rectAt = t;
    return rectCache;
  }

  /**
   * Physical-pixel rect of an Electron Display (Windows; the same mapping input uses), for reporting
   * true display sizes. @returns {{x,y,width,height}|null} always null on macOS
   */
  function physicalRect(display) {
    if (platform !== 'win32' || !isObject(display) || !validRect(display.bounds)) return null;
    ensureInit();
    const r = displayRect(platform, getScreen(), display, backend);
    return r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  }

  // --- blocked probe (Windows UIPI / secure desktop) ---

  function probe(pt) {
    if (!backend || typeof backend.blockedReason !== 'function') return;
    lastProbeAt = now();
    lastProbePoint = pt || null;
    let r = null;
    try {
      r = backend.blockedReason(lastProbePoint);
    } catch (err) {
      logError('blocked probe', err);
    }
    blocked = BLOCKED_REASONS.has(r) ? r : null;
  }

  /** Re-probes a set state (≤ 1 per PROBE_INTERVAL_MS) so it clears once the obstacle is gone. */
  function currentBlocked() {
    if (blocked !== null && now() - lastProbeAt >= PROBE_INTERVAL_MS) probe(lastProbePoint);
    return blocked;
  }

  function probeAfterShortfall(e) {
    if (!backend || typeof backend.takeShortfall !== 'function') return;
    let short = false;
    try { short = backend.takeShortfall() === true; } catch { short = false; }
    if (!short || now() - lastProbeAt < PROBE_SHORTFALL_MS) return;
    const keyboard = e.t === I.KEY_DOWN || e.t === I.KEY_UP || e.t === I.TEXT || e.t === I.COMBO;
    probe(keyboard ? null : lastPoint);
  }

  // --- lock keys (Caps Lock / Num Lock resync) ---

  /** Windows-style backend: real lock state we can read and fix by tapping the key. */
  function readsLocks() {
    return !!backend && typeof backend.lockState === 'function' && typeof backend.setCaps !== 'function';
  }

  /** @returns {{state: object|null, trusted: boolean}} */
  function readLocks() {
    const t = now();
    if (t - locksState.lastRead > LOCK_TRUST_MS) locksState.chainStart = t;
    locksState.lastRead = t;
    let state = null;
    try {
      state = backend.lockState();
    } catch (err) {
      logError('lock state', err);
    }
    return { state: isObject(state) ? state : null, trusted: t - locksState.chainStart >= LOCK_SETTLE_MS };
  }

  function primeLocks() {
    if (readsLocks() && now() - locksState.lastRead >= LOCK_PRIME_MS) readLocks();
  }

  /** We are about to inject a lock key: the next read starts a fresh chain. */
  function noteLockKey(code) {
    if (code === 'CapsLock' || code === 'NumLock') locksState.lastRead = -Infinity;
  }

  /**
   * Forgets the read chain and, per lock: wanted = the viewer's last requested value (null = none
   * yet), lastTap = time of our last resync tap, expect = the value that tap should have produced
   * (null = nothing to verify), failures = consecutive taps that left the host unchanged, off = gave up.
   */
  function resetLocks() {
    locksState.lastRead = -Infinity;
    locksState.chainStart = -Infinity;
    for (const kind of ['caps', 'num']) locksState[kind] = { wanted: null, lastTap: -Infinity, expect: null, failures: 0, off: false };
  }

  /** The viewer's requested value for `kind`; a change re-arms a lock whose resync gave up. */
  function noteWanted(kind, wanted) {
    const s = locksState[kind];
    if (s.wanted !== null && s.wanted !== wanted) Object.assign(s, { expect: null, failures: 0, off: false });
    s.wanted = wanted;
  }

  /** First trusted read after a resync tap: did the tap change the host's state? */
  function verifyTap(kind, actual) {
    const s = locksState[kind];
    if (s.expect === null || typeof actual !== 'boolean') return;
    if (actual === s.expect) {
      s.failures = 0;
    } else if (++s.failures >= LOCK_GIVE_UP && !s.off) {
      // Remapped CapsLock (e.g. to Esc), "press Shift to turn off Caps Lock", or reads that never
      // settle: further taps would only inject that key again and again.
      s.off = true;
      logError(`${kind} lock resync`, `host state unchanged after ${s.failures} taps; paused until the viewer's state changes`);
    }
    s.expect = null;
  }

  function resyncTap(kind, code, expect) {
    const s = locksState[kind];
    const t = now();
    const byVk = typeof backend.tapLock === 'function'; // win32: VK_CAPITAL / VK_NUMLOCK
    if (s.off || t - s.lastTap < LOCK_TAP_MS || heldKeys.has(code) || (!byVk && !isMapped(code))) return;
    s.lastTap = t;
    s.expect = expect; // set first: if the backend throws midway, the state may still have toggled
    noteLockKey(code);
    if (byVk) backend.tapLock(kind);
    else tap(code);
  }

  /** Bring the host's Caps/Num Lock in line with the viewer's before `e` (a mapped kd) is injected. */
  function syncLocks(e) {
    const { code, locks } = e;
    if (LOCK_CODES.has(code) || keymap.isModifier(code)) return;
    if (typeof backend.setCaps === 'function') { // macOS: Caps Lock is emulated by the backend
      backend.setCaps(locks.caps);
      return;
    }
    if (!readsLocks()) return;
    noteWanted('caps', locks.caps);
    if (typeof locks.num === 'boolean') noteWanted('num', locks.num);
    const { state, trusted } = readLocks();
    if (!trusted || !state) return;
    verifyTap('caps', state.caps);
    verifyTap('num', state.num);
    if (typeof state.caps === 'boolean' && state.caps !== locks.caps) resyncTap('caps', 'CapsLock', locks.caps);
    if (typeof locks.num === 'boolean' && code.startsWith('Numpad') && typeof state.num === 'boolean' && state.num !== locks.num) {
      resyncTap('num', 'NumLock', locks.num);
    }
  }

  function point(x, y) {
    const r = currentRect();
    return r ? mapPoint(platform, r, x, y) : null;
  }

  /**
   * True when normalized (x,y) — injected at platform point `p` — lands on guarded host UI.
   * `dip`: the point in DIP of the streamed display (window bounds are DIP on every platform).
   * `window`: Windows only, the top-level owner window really under `p` (see the header).
   */
  function isGuarded(x, y, p) {
    if (!pointerGuard) return false;
    try {
      const d = resolveDisplay(getScreen());
      const dip = d && validRect(d.bounds) ? { x: d.bounds.x + x * d.bounds.width, y: d.bounds.y + y * d.bounds.height } : null;
      const window = p && backend && typeof backend.windowAt === 'function' ? backend.windowAt(p) : undefined;
      return pointerGuard({ dip, window }) === true;
    } catch (err) {
      logError('pointer guard', err);
      return true;
    }
  }

  function isKeyGuarded() {
    if (!keyGuard) return false;
    try {
      return keyGuard() === true;
    } catch (err) {
      logError('key guard', err);
      return true;
    }
  }

  /** @param {Function|null} fn ({dip, window}) → true when a press there must not be injected */
  function setPointerGuard(fn) {
    pointerGuard = typeof fn === 'function' ? fn : null;
  }

  /** @param {Function|null} fn () → true while keystrokes must not be injected */
  function setKeyGuard(fn) {
    keyGuard = typeof fn === 'function' ? fn : null;
  }

  /**
   * @param {object|string|number|null} display Electron Display / capture display ({id, bounds, scaleFactor}),
   *        a display id, or null for the primary display.
   * @returns {boolean} accepted
   */
  function setDisplay(display) {
    if (display === null || display === undefined) {
      selected = null;
    } else if (typeof display === 'string' || typeof display === 'number') {
      selected = { id: String(display), display: null };
    } else if (isObject(display) && validRect(display.bounds)) {
      const b = display.bounds;
      const id = display.id;
      selected = {
        id: typeof id === 'number' || typeof id === 'string' ? String(id) : null,
        display: { id, bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, scaleFactor: validScale(display.scaleFactor) },
      };
    } else {
      return false;
    }
    invalidateRect();
    return true;
  }

  // --- dispatch ---

  function isMapped(code) {
    return code !== '' && keymap.lookup(code, platform) != null;
  }

  function tap(code) {
    backend.key(code, true, false);
    backend.key(code, false, false);
  }

  function typeText(text) {
    for (const seg of segmentText(text)) {
      if (seg.text) backend.text(seg.text);
      else if (isMapped(seg.code)) tap(seg.code);
    }
  }

  function keyDown(e) {
    if (isMapped(e.code)) {
      if (e.locks) safe('lock sync', () => syncLocks(e));
      noteLockKey(e.code);
      heldKeys.add(e.code); // before the call: if it throws, releaseAll still sends the up
      backend.key(e.code, true, e.rep);
      return true;
    }
    // Unknown on this platform: type the produced character instead (layout-independent).
    const ch = printableChar(e.key);
    if (ch) {
      backend.text(ch);
      return true;
    }
    return false;
  }

  function keyUp(e) {
    if (!heldKeys.has(e.code)) return false; // never send stray key-ups (e.g. a lone Alt-up opens menus)
    heldKeys.delete(e.code);
    backend.key(e.code, false, false);
    return true;
  }

  function combo(codes) {
    // All-or-nothing: a partial shortcut could do something the viewer did not ask for.
    if (!codes.every(isMapped)) return false;
    const pressed = [];
    try {
      for (const c of codes) {
        if (heldKeys.has(c) || pressed.includes(c)) continue; // already down: leave its state alone
        pressed.push(c);
        noteLockKey(c);
        backend.key(c, true, false);
      }
    } finally {
      for (let i = pressed.length - 1; i >= 0; i--) safe('combo release', () => backend.key(pressed[i], false, false));
    }
    return true;
  }

  function dispatch(e) {
    switch (e.t) {
      case I.MOUSE_MOVE: {
        const p = point(e.x, e.y);
        if (!p) return false;
        if (heldButtons.size > 0 && isGuarded(e.x, e.y, p)) return false; // no drag onto the session UI
        lastPoint = p;
        backend.moveTo(p.x, p.y);
        return true;
      }
      case I.MOUSE_DOWN: {
        const p = point(e.x, e.y);
        if (!p) return false;
        if (isGuarded(e.x, e.y, p)) return false;
        lastPoint = p;
        heldButtons.add(e.b);
        backend.button(e.b, true, p.x, p.y, e.n);
        return true;
      }
      case I.MOUSE_UP: {
        if (!heldButtons.has(e.b)) return false;
        heldButtons.delete(e.b);
        const q = point(e.x, e.y);
        const p = (q && !isGuarded(e.x, e.y, q) ? q : null) || lastPoint;
        if (p) lastPoint = p;
        backend.button(e.b, false, p ? p.x : undefined, p ? p.y : undefined, e.n);
        return true;
      }
      case I.WHEEL:
        if (e.dx === 0 && e.dy === 0) return false;
        backend.scroll(e.dx, e.dy);
        return true;
      case I.KEY_DOWN:
        if (isKeyGuarded()) return false;
        return keyDown(e);
      case I.KEY_UP:
        return keyUp(e);
      case I.TEXT:
        if (isKeyGuarded()) return false;
        typeText(e.text);
        return true;
      case I.COMBO:
        if (isKeyGuarded()) return false;
        return combo(e.codes);
      default:
        return false;
    }
  }

  /**
   * Handles one `input` message. Never throws.
   * @returns {boolean} true if something was injected
   */
  function handle(evt) {
    const e = validate(evt);
    if (!e) return false;
    if (e.t === I.RELEASE_ALL) {
      releaseAll();
      return true;
    }
    if (!current().available) return false;
    // Diagnostics around the injection never cost the event itself.
    if ((e.t === I.MOUSE_DOWN || e.t === I.KEY_DOWN) && now() - lastProbeAt >= PROBE_INTERVAL_MS) {
      safe('blocked probe', () => probe(e.t === I.MOUSE_DOWN ? point(e.x, e.y) : null));
    }
    if (e.t !== I.KEY_DOWN) safe('lock state', primeLocks); // kd reads (or not) in syncLocks
    try {
      return dispatch(e);
    } catch (err) {
      logError(`inject ${e.t}`, err);
      return false;
    } finally {
      safe('shortfall probe', () => probeAfterShortfall(e));
    }
  }

  /** Releases every key (reverse press order) and mouse button we injected. Never throws. */
  function releaseAll() {
    const keys = [...heldKeys].reverse();
    const buttons = [...heldButtons];
    heldKeys.clear();
    heldButtons.clear();
    if (!backend) return;
    // An Alt/Win release with nothing pressed since its press is a "solo tap" on Windows (menu bar /
    // Start menu) — e.g. the viewer forwarded Alt, then its own OS swallowed Alt+Tab and it blurred.
    // Not done for genuine `ku` messages: an intentional remote Alt tap must still open menus.
    if (typeof backend.mask === 'function' && keys.some(isAltOrWin)) safe('mask', () => backend.mask());
    for (const c of keys) safe('release key', () => backend.key(c, false, false));
    for (const b of buttons) {
      safe('release button', () => backend.button(b, false, lastPoint ? lastPoint.x : undefined, lastPoint ? lastPoint.y : undefined, 1));
    }
    if (typeof backend.reset === 'function') safe('reset', () => backend.reset());
  }

  /**
   * Session boundary (main calls it when a host session ends): releaseAll() plus forgetting the
   * lock-key resync state, so a lock that gave up (see LOCK_GIVE_UP) is tried again next session.
   * Plain releaseAll() keeps it: it also runs on every viewer blur. Never throws.
   */
  function reset() {
    releaseAll();
    resetLocks();
  }

  return {
    get available() {
      return current().available;
    },
    get reason() {
      return current().reason;
    },
    /** null | 'secure-desktop' | 'elevated-window' (Windows only; macOS always null). */
    get blocked() {
      return currentBlocked();
    },
    /** Convenience for IPC: { available, reason, blocked }. */
    status() {
      current();
      currentBlocked();
      return snapshot();
    },
    setDisplay,
    setPointerGuard,
    setKeyGuard,
    physicalRect,
    handle,
    releaseAll,
    reset,
    refreshPermission,
    // test / diagnostics hooks
    _held: () => ({ keys: [...heldKeys], buttons: [...heldButtons] }),
    _rect: () => currentRect(),
    _error: () => status.error,
  };
}

module.exports = _createInjector();
module.exports._createInjector = _createInjector;
module.exports._internals = { validate, validLocks, printableChar, segmentText, displayRect, mapPoint, isValidCode };
