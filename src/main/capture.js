'use strict';
/*
 * Screen capture plumbing — docs/ARCHITECTURE.md §7 (capture.js).
 *
 *   capture.init(session, hooks)  // installs setDisplayMediaRequestHandler on that session
 *     hooks = { isActivePanelFrame(frame) → bool,  // only the ACTIVE session's panel may capture
 *               audioAllowed() → bool,              // session permissions.audio
 *               input }                             // input facade (setDisplay, physicalRect?)
 *   await capture.listDisplays({maxAgeMs = 5000, force = false})
 *                                   → [{id, name, primary, width, height, scaleFactor, bounds}]
 *                                     (width/height in physical pixels, bounds in DIP)
 *                                     maxAgeMs: Infinity = any cached list until it is invalidated
 *   await capture.selectDisplay(id, {mapInput = false})
 *                                   → {ok, display, sourceId} | {ok:false, error}
 *   capture.commitDisplay(id)       → {ok:true} | {ok:false, error}   (points input mapping at it)
 *   capture.servedDisplayId()       → id (listDisplays format) of the display last served to a
 *                                     getDisplayMedia() request, or null
 *   capture.hasCache()              → bool: a valid (not invalidated) enumeration is cached
 *   capture.setIdleWarm(canWarm, {delayMs})  // warm the cache at idle, see below
 *   capture.scheduleWarm(delayMs)   // (re)arm the idle warm-up timer (debounced)
 *   capture.audioSupported()       → bool
 *   capture.reset()                 // forget the selection (session ended)
 *   capture.invalidate()            // drop the cached enumeration
 *
 * The panel renderer calls selectDisplay() before every getDisplayMedia(); the request handler
 * then grants exactly that screen. No system picker, no window sources. selectDisplay() only
 * chooses the capture SOURCE: input mapping moves when the panel commits a display after its
 * new stream is live (commitDisplay), so remote clicks never land on a display the viewer does
 * not see yet. Only the initial display of a session is mapped at selection time (index.js).
 *
 * Enumeration cost: desktopCapturer.getSources() re-initialises DXGI duplication / SCK and blocks
 * the main process (and with it input to EVERY window) for 0.45–2.3 s per call. The merged rows
 * are therefore cached (single-flight) until something invalidates them: screen 'display-added' /
 * 'display-removed' / 'display-metrics-changed' (except work-area-only changes), powerMonitor
 * 'resume' and 'unlock-screen', and the display-media handler failing to resolve a source. An
 * enumeration that found no capturable screen (macOS
 * without Screen Recording) is never cached. The prompt and session-start paths reuse the cache
 * whatever its age (maxAgeMs Infinity); only the panel's own display list (viewer display switch,
 * a capture that ended) refreshes one older than LIST_MAX_AGE_MS.
 *
 * Idle warm-up: with setIdleWarm(canWarm), the cache is re-filled delayMs (2 s) after each
 * invalidation (debounced) and whenever scheduleWarm() fires, unless it is still valid or
 * canWarm() says no (index.js: hosting off, a prompt or a session in progress, an outgoing viewer
 * session, the OS session locked, macOS without Screen Recording). So the enumeration happens
 * while nobody waits for it, not after Accept.
 *
 * System audio: Electron 45 documents `audio: 'loopback'` as Windows-only (electron.d.ts,
 * Streams.audio). On macOS it is therefore reported as unsupported unless the experimental
 * opt-in TUNNELVIEW_MAC_LOOPBACK=1 is set (index.js then enables the Chromium ScreenCaptureKit
 * loopback features; requires macOS 14.2+ and NSAudioCaptureUsageDescription).
 */

let electron = null;
const E = () => electron || (electron = require('electron'));

const MAC_LOOPBACK_OPT_IN = process.platform === 'darwin' && process.env.TUNNELVIEW_MAC_LOOPBACK === '1';
const DEFAULT_MAX_AGE_MS = 5000;
// The panel's own display list (panel:list-displays: a viewer display switch, a capture that
// ended) refreshes an enumeration older than this. Everything else trusts the cache until it is
// invalidated: hot-plug, metric changes and resume invalidate it, so an older enumeration still
// names the right source for a display id (the display-media handler serves from it as well).
const LIST_MAX_AGE_MS = 60000;
// Idle warm-up after an invalidation (debounced: a hot-plug fires several screen events).
const WARM_DELAY_MS = 2000;

const state = {
  hooks: { isActivePanelFrame: () => false, audioAllowed: () => false, input: null },
  map: new Map(),     // display id → { display, source, pub }  (last enumeration)
  mapGen: -1,         // invalidation generation the map was built in
  selectedId: null,
  servedId: null,     // display id last served to a getDisplayMedia() request
  gen: 0,             // bumped by invalidate()
  cache: null,        // { at, gen, rows } — rows as stored in map, in display order
  inflight: null,     // { gen, promise }
  screenHooked: false,
  warm: { canWarm: null, delayMs: WARM_DELAY_MS, timer: null },
};

function audioSupported() {
  if (process.platform === 'win32') return true;
  if (process.platform === 'darwin') return MAC_LOOPBACK_OPT_IN;
  return false;
}

function publicDisplay(d) {
  return { id: d.id, name: d.name, primary: d.primary, width: d.width, height: d.height, scaleFactor: d.scaleFactor };
}

const copyRow = (pub) => ({ ...pub, bounds: { ...pub.bounds } });

/** Drop the cached enumeration (display hot-plug / metrics change / unresolvable source). */
function invalidate() {
  state.gen++;
  state.cache = null;
  if (state.warm.canWarm) scheduleWarm();
}

/** A valid (not invalidated) enumeration is cached: listDisplays({maxAgeMs: Infinity}) is free. */
function hasCache() {
  return !!(state.cache && state.cache.gen === state.gen);
}

/**
 * (Re)arm the idle warm-up: after delayMs, enumerate unless the cache is valid, an enumeration
 * is already running, or canWarm() refuses. Debounced: each call restarts the timer. No-op until
 * setIdleWarm() enabled it.
 */
function scheduleWarm(delayMs = state.warm.delayMs) {
  const w = state.warm;
  if (!w.canWarm) return;
  clearTimeout(w.timer);
  const ms = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : WARM_DELAY_MS;
  w.timer = setTimeout(() => {
    w.timer = null;
    // An enumeration of the current generation is running: it fills the cache itself.
    if (hasCache() || (state.inflight && state.inflight.gen === state.gen) || !w.canWarm) return;
    let ok = false;
    try { ok = w.canWarm() === true; } catch { ok = false; }
    if (!ok) return;
    listDisplays({ maxAgeMs: Infinity }).catch((err) => console.warn('[capture] idle warm-up failed:', err && err.message));
  }, ms);
  if (w.timer && typeof w.timer.unref === 'function') w.timer.unref();
}

/**
 * Enable (canWarm = function → bool) or disable (null) the idle warm-up. canWarm() is asked when
 * the timer fires; delayMs is the debounce after an invalidation (default 2 s).
 */
function setIdleWarm(canWarm, { delayMs = WARM_DELAY_MS } = {}) {
  const w = state.warm;
  w.canWarm = typeof canWarm === 'function' ? canWarm : null;
  w.delayMs = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : WARM_DELAY_MS;
  if (!w.canWarm) { clearTimeout(w.timer); w.timer = null; }
}

/** Physical pixel size of a display: the input layer's exact rect on Windows, else bounds × scale. */
function physicalSize(d, scale) {
  if (process.platform === 'win32') {
    const input = state.hooks.input;
    let pr = null;
    try { pr = input && typeof input.physicalRect === 'function' ? input.physicalRect(d) : null; } catch { pr = null; }
    if (pr && Number.isFinite(pr.width) && Number.isFinite(pr.height) && pr.width > 0 && pr.height > 0) {
      return { width: Math.round(pr.width), height: Math.round(pr.height) };
    }
  }
  return { width: Math.round(d.bounds.width * scale), height: Math.round(d.bounds.height * scale) };
}

/** Merge screen.getAllDisplays() with desktopCapturer screen sources (by display_id, else index order). */
async function enumerate() {
  const { screen, desktopCapturer } = E();
  const displays = screen.getAllDisplays();
  let primaryId = null;
  try { primaryId = screen.getPrimaryDisplay().id; } catch { /* ignore */ }

  let sources = [];
  try {
    sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  } catch (err) {
    // macOS without Screen Recording permission may throw or return nothing.
    console.warn('[capture] getSources failed:', err && err.message);
  }
  if (!Array.isArray(sources)) sources = [];

  const used = new Set();
  const byDisplayId = new Map();
  for (const s of sources) if (s && s.display_id) byDisplayId.set(String(s.display_id), s);

  const rows = displays.map((d, i) => {
    let src = byDisplayId.get(String(d.id)) || null;
    if (!src) {
      // Fallback: same index, if that source has no display_id of its own (some Windows setups).
      const cand = sources[i];
      if (cand && !cand.display_id && !used.has(cand.id)) src = cand;
    }
    if (src) used.add(src.id);
    const scale = Number.isFinite(d.scaleFactor) && d.scaleFactor > 0 ? d.scaleFactor : 1;
    const size = physicalSize(d, scale);
    const pub = {
      id: String(d.id),
      name: (d.label && String(d.label)) || (src && src.name) || `Display ${i + 1}`,
      primary: d.id === primaryId,
      width: size.width,
      height: size.height,
      scaleFactor: scale,
      bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    };
    return { pub, display: d, source: src };
  });

  // Hide displays we cannot capture — unless nothing is capturable (permission missing), in which
  // case list them all so the panel can still show the user what is wrong.
  const capturable = rows.filter((r) => r.source);
  return { rows: capturable.length ? capturable : rows, capturable: capturable.length > 0 };
}

/**
 * Displays merged with their capture sources. Returns copies of the cached result while it is
 * younger than maxAgeMs (Infinity: any age, until invalidated); force skips the cache.
 * Concurrent callers share one enumeration.
 */
async function listDisplays({ maxAgeMs = DEFAULT_MAX_AGE_MS, force = false } = {}) {
  const maxAge = typeof maxAgeMs === 'number' && maxAgeMs >= 0 ? maxAgeMs : DEFAULT_MAX_AGE_MS; // NaN → default
  const c = state.cache;
  if (!force && c && c.gen === state.gen && Date.now() - c.at <= maxAge) return c.rows.map((r) => copyRow(r.pub));
  let job = state.inflight;
  if (!job || job.gen !== state.gen) {
    const gen = state.gen;
    const promise = enumerate().then((res) => {
      // Newest result wins the map even if invalidated meanwhile; only a clean one is cached.
      if (gen >= state.mapGen) {
        state.map = new Map(res.rows.map((r) => [r.pub.id, r]));
        state.mapGen = gen;
      }
      if (gen === state.gen && res.capturable) state.cache = { at: Date.now(), gen, rows: res.rows };
      return res.rows;
    }).finally(() => { if (state.inflight && state.inflight.promise === promise) state.inflight = null; });
    job = { gen, promise };
    state.inflight = job;
  }
  const rows = await job.promise;
  return rows.map((r) => copyRow(r.pub));
}

function primaryDisplayId() {
  try { return String(E().screen.getPrimaryDisplay().id); } catch { return null; }
}

function mapInput(display) {
  const input = state.hooks.input;
  if (!display || !input || typeof input.setDisplay !== 'function') return;
  try { input.setDisplay(display); } catch (err) { console.warn('[capture] input.setDisplay failed:', err && err.message); }
}

/** The live Electron Display for an id (bounds may have changed since the enumeration). */
function liveDisplay(id) {
  try { return E().screen.getAllDisplays().find((d) => String(d.id) === id) || null; } catch { return null; }
}

/**
 * Choose the screen for the next getDisplayMedia(). Resolves from the cached enumeration of any
 * age (never forces a refresh; enumerates only when nothing valid is cached), so the start of a
 * session never waits for desktopCapturer. Input mapping only moves when mapInput is true
 * (initial display).
 * @returns {Promise<{ok:true, display, sourceId} | {ok:false, error:string}>}
 */
async function selectDisplay(id, { mapInput: moveInput = false } = {}) {
  const auto = id === undefined || id === null || id === '';
  const want = auto ? primaryDisplayId() : String(id);
  await listDisplays({ maxAgeMs: Infinity });
  let entry = want ? state.map.get(want) : null;
  if (!entry && auto) entry = state.map.values().next().value || null;
  if (!entry) return { ok: false, error: 'not-found' };
  if (!entry.source) return { ok: false, error: 'capture-unavailable' };
  state.selectedId = entry.pub.id;
  if (moveInput) mapInput(liveDisplay(entry.pub.id) || entry.display);
  return { ok: true, display: publicDisplay(entry.pub), sourceId: entry.source.id };
}

/** Point input mapping at display `id` (the panel calls this once its new stream is live). */
function commitDisplay(id) {
  const key = String(id);
  const entry = state.map.get(key);
  const display = liveDisplay(key) || (entry ? entry.display : null);
  if (!display) return { ok: false, error: 'not-found' };
  mapInput(display);
  return { ok: true };
}

function reset() {
  state.selectedId = null;
  state.servedId = null;
}

function selectedDisplayId() { return state.selectedId; }

/**
 * The display (id in listDisplays format) last served to a getDisplayMedia() request — the
 * selection, or the primary display when the selection had vanished. null before the first
 * request of a session.
 */
function servedDisplayId() { return state.servedId; }

async function onDisplayMediaRequest(request, callback) {
  let replied = false;
  const reply = (streams) => {
    if (replied) return;
    replied = true;
    try { callback(streams); } catch (err) { console.warn('[capture] callback failed:', err && err.message); }
  };
  try {
    const frame = request && request.frame;
    if (!frame || !request.videoRequested || !state.hooks.isActivePanelFrame(frame)) {
      console.warn('[capture] display media request denied (not the active session panel)');
      return reply(null);
    }
    // The panel selected a display just before this request: serve it straight from the map
    // (no enumeration) unless the map predates an invalidation or lacks the selection.
    const usable = (e) => !!(e && e.source);
    let entry = state.selectedId && state.mapGen === state.gen ? state.map.get(state.selectedId) : null;
    if (!usable(entry)) {
      await listDisplays({ force: true });
      entry = state.selectedId ? state.map.get(state.selectedId) : null;
      if (!usable(entry)) {
        // Selected screen unplugged (or nothing selected) → primary. Input mapping is not moved
        // here; the panel commits the display it ends up streaming.
        const sel = await selectDisplay(undefined);
        entry = sel.ok ? state.map.get(sel.display.id) : null;
      }
    }
    if (!usable(entry)) {
      invalidate();
      return reply(null);
    }
    // Re-check after the async gap: the session may have ended meanwhile.
    if (!state.hooks.isActivePanelFrame(frame)) return reply(null);
    const streams = { video: entry.source };
    if (request.audioRequested && audioSupported() && state.hooks.audioAllowed()) streams.audio = 'loopback';
    // What the panel actually streams (a fallback is not the display it asked for): reported by
    // panel:commit-display so the panel can adopt it.
    state.servedId = entry.pub.id;
    return reply(streams);
  } catch (err) {
    console.error('[capture] display media handler failed:', err);
    invalidate();
    return reply(null);
  }
}

function init(ses, hooks = {}) {
  state.hooks = {
    isActivePanelFrame: typeof hooks.isActivePanelFrame === 'function' ? hooks.isActivePanelFrame : () => false,
    audioAllowed: typeof hooks.audioAllowed === 'function' ? hooks.audioAllowed : () => false,
    input: hooks.input || null,
  };
  if (!state.screenHooked) {
    state.screenHooked = true;
    const onScreenEvent = () => invalidate(); // never pass the event arguments on
    try {
      const { screen } = E();
      for (const ev of ['display-added', 'display-removed']) screen.on(ev, onScreenEvent);
      // A work-area-only change (taskbar / Dock resized or moved) changes neither the sources nor
      // the rows (bounds, physical size): not worth a re-enumeration stall.
      screen.on('display-metrics-changed', (_e, _display, changed) => {
        if (Array.isArray(changed) && changed.length && changed.every((m) => m === 'workArea')) return;
        invalidate();
      });
    } catch (err) {
      console.warn('[capture] screen events unavailable:', err && err.message);
    }
    // The cache has no age limit: after sleep the GPU outputs may have been re-created. An unlock
    // drops whatever was enumerated on the lock screen (Windows secure desktop: no DXGI, so GDI
    // sources without display_id, paired by index) and re-warms 2 s later on the user's desktop.
    try {
      const { powerMonitor } = E();
      if (powerMonitor && typeof powerMonitor.on === 'function') {
        powerMonitor.on('resume', onScreenEvent);
        powerMonitor.on('unlock-screen', onScreenEvent);
      }
    } catch { /* powerMonitor unavailable: screen events still invalidate */ }
  }
  ses.setDisplayMediaRequestHandler(onDisplayMediaRequest, { useSystemPicker: false });
}

module.exports = {
  init,
  listDisplays,
  selectDisplay,
  commitDisplay,
  audioSupported,
  reset,
  invalidate,
  hasCache,
  setIdleWarm,
  scheduleWarm,
  selectedDisplayId,
  servedDisplayId,
  primaryDisplayId,
  publicDisplay,
  LIST_MAX_AGE_MS,
  MAC_LOOPBACK_OPT_IN,
};
