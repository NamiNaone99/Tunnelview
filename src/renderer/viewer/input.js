/*
 * Tunnelview viewer — input capture → `input` data channel (docs/ARCHITECTURE.md §5).
 *
 * Mouse:    pointer position → normalized [0,1] coords on the streamed display (geometry.js),
 *           `mm` coalesced to one per animation frame; the latest position is always sent right
 *           before `md`/`mu`. Buttons come from mousedown/mouseup (MouseEvent.detail = the OS click
 *           count; PointerEvent.detail is always 0). Touch / pen taps use pointer events.
 * Wheel:    non-passive listener, deltas normalized to CSS px (keys.wheelPixels), summed per frame.
 * Keyboard: physical KeyboardEvent.code (optionally Cmd⇄Ctrl swapped) as `kd`/`ku`; every `kd`
 *           carries the viewer's lock state `locks:{caps, num}` so the host can resync CapsLock /
 *           NumLock (macOS has no NumLock: a Mac viewer always reports num:true).
 *           IME / dead-key composition, emoji pickers and dictation arrive as `txt` via a hidden,
 *           always-focused <textarea> ("IME sink"): Chromium only enables the OS input method while an
 *           editable element has focus, so a plain <video> could never receive composed text.
 *           Cross-OS fixes:
 *           - Windows viewer → Mac host: AltGr arrives as a synthetic ControlLeft + AltRight
 *             ('AltGraph'). Forwarded as-is it would become ⌘⌥<key> on the Mac, so the synthetic
 *             ControlLeft is held back briefly and dropped when AltGr follows, AltGr itself is not
 *             forwarded, and printable AltGr characters (@ € { } [ ] \ | ~ ą ę ł …) are typed as `txt`.
 *             AltGr dead keys (~ ^ ` ˇ ˘ ° ˛ ˙ ´ ˝ on CE layouts) are left to Windows together with
 *             the NEXT key: Chromium on Windows fires no composition events for layout dead keys, the
 *             composed character only arrives as that key's text input (IME sink → `txt`).
 *           - Mac viewer → Windows host: an Option keydown is deferred until another key or a mouse
 *             button needs it. If Option only prefixed a dead key (⌥E, ⌥U, ⌥N, ⌥`) nothing is sent,
 *             so Windows never sees a lone Alt tap (menu-bar activation that eats the accented
 *             character); a deliberate Option tap is still sent as Alt down + up on release.
 *           Modifiers held through a focus loss (blur releases everything on the host, and the OS
 *           sends no new keydown for a key that is still down when the window comes back, e.g. ⌘
 *           after a ⌘Tab round trip) are pressed again from the event's flags before the next key,
 *           click or wheel that uses them (#syncModifiers) — only while the window has focus, so
 *           their keyup can be seen (a wheel over the inactive window must not press them).
 * Safety:   everything is released (`release-all`) on blur, tab hide, lost pointer capture with
 *           buttons held, and whenever input gets disabled (held-back modifiers are dropped, never
 *           sent late).
 */
import { mapCode, wheelPixels, isModifierCode, chunkText } from '../shared/keys.js';
import { contentRect, normalizePoint, edgePanDelta, buttonBit } from './geometry.js';

const P = window.TunnelviewProtocol;
const I = P.INPUT;

const ESC_HOLD_MS = 1500; // hold Esc this long in fullscreen to leave fullscreen
const CAPTURE_LOSS_GRACE_MS = 80; // mouseup normally follows lostpointercapture within a frame
const MAX_KEY_LEN = 32;
const TEXT_INPUT_TYPES = new Set(['text', 'password', 'search', 'email', 'url', 'tel', 'number', '']);
const CTRL_HOLD_MS = 30; // Windows → Mac: a ControlLeft not followed by AltGr is forwarded after this
const ALTGR_PAIR_MS = 20; // AltGr's synthetic ControlLeft and its AltRight carry (nearly) the same timeStamp
// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f-\u009f]/;
// Modifier families for #syncModifiers: event flag → physical codes (the first one is pressed).
const MODIFIER_FAMILIES = Object.freeze([
  { flag: 'ctrlKey', key: 'Control', codes: ['ControlLeft', 'ControlRight'] },
  { flag: 'shiftKey', key: 'Shift', codes: ['ShiftLeft', 'ShiftRight'] },
  { flag: 'altKey', key: 'Alt', codes: ['AltLeft', 'AltRight'] },
  { flag: 'metaKey', key: 'Meta', codes: ['MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'] },
]);
const isMetaCode = (code) => code === 'MetaLeft' || code === 'MetaRight' || code === 'OSLeft' || code === 'OSRight';

/** KeyboardEvent.key that types exactly one visible character (not 'Dead', 'Enter', '\t'…). */
export function isPrintableKey(key) {
  return typeof key === 'string' && key.length > 0 && key.length <= 2 && Array.from(key).length === 1 && !CONTROL_CHAR_RE.test(key);
}

function modifierState(e, name) {
  try { return !!(e && typeof e.getModifierState === 'function' && e.getModifierState(name)); } catch { return false; }
}

/** True for elements where typing should stay LOCAL (chat box, password field, dialogs…). */
export function isEditable(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return TEXT_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
  return false;
}

function safeKey(key) {
  return typeof key === 'string' ? key.slice(0, MAX_KEY_LEN) : '';
}

export class InputController {
  /**
   * @param {object} o
   * @param {HTMLElement} o.stage            scroll container holding the video (receives pointer events)
   * @param {HTMLVideoElement} o.video
   * @param {HTMLTextAreaElement} o.sink     hidden IME sink
   * @param {(msg:object, opts?:{droppable?:boolean}) => boolean} o.send
   * @param {() => boolean} o.getSwap        effective Cmd/Ctrl swap
   * @param {() => 'fit'|'original'} o.getScale
   * @param {'windows'|'macos'} o.localOs
   * @param {() => string} [o.getHostOs]     remote OS ('windows'|'macos'|…) for the cross-OS key fixes
   * @param {() => boolean} o.isFullscreen
   * @param {() => void} o.onExitFullscreen  Esc long-press in fullscreen
   * @param {() => void} o.onToolbarShortcut Ctrl+Alt+Shift
   * @param {() => boolean} [o.onEscapeLocal] returns true when Esc was consumed locally (e.g. closed a menu)
   */
  constructor(o) {
    this.o = o;
    this.stage = o.stage;
    this.video = o.video;
    this.sink = o.sink;
    this.enabled = false;

    this.buttons = new Set(); // DOM buttons we sent `md` for
    this.keys = new Map(); // physical e.code → wire code sent with `kd` (so `ku` matches even if swap changed)
    this.pendingClient = null; // latest client coords not yet sent as `mm`
    this.lastSent = null; // last {x,y} sent
    this.lastClient = null; // last pointer position over the stage (edge panning, IME placement)
    this.wheel = { dx: 0, dy: 0 };
    this.raf = 0;
    this.escDownAt = 0;
    this.suppressEsc = false; // Esc held through a long-press fullscreen exit
    this.composing = false;
    this.captureLossTimer = 0;
    // Windows viewer → Mac host (AltGr)
    this.ctrlHold = null; // ControlLeft kd held back: { code, wire, msg, ts, timer }
    this.fakeCtrl = false; // the held ControlLeft was AltGr's synthetic one: drop its repeats + keyup
    this.altGr = false; // AltGr (AltRight 'AltGraph') is down
    this.altGrDead = false; // an AltGr dead key is pending: Windows composes it with the next key
    this.deadKeyUp = null; // physical code of that next key (left to Windows): its keyup is not sent either
    // Mac viewer → Windows host (Option dead keys)
    this.altHold = new Map(); // physical AltLeft/AltRight → { wire, msg, composed } not sent yet

    this.ac = new AbortController();
    this.#bind(this.ac.signal);
  }

  /* -------------------------------------------------------------------------------------- */
  /* public                                                                                  */
  /* -------------------------------------------------------------------------------------- */

  /** Enable/disable sending. Disabling releases everything held on the host first. */
  setEnabled(on) {
    on = !!on;
    if (on === this.enabled) return;
    if (!on) {
      this.releaseAll(true);
      this.enabled = false;
    } else {
      this.enabled = true;
      this.lastSent = null;
      if (document.hasFocus() && !this.#isLocalTarget(document.activeElement)) this.focus();
    }
    this.stage.classList.toggle('input-on', this.enabled);
  }

  /** Give keyboard focus to the remote (IME sink). */
  focus() {
    const c = this.lastClient;
    if (c) {
      // Park the sink under the pointer so IME candidate windows open next to where the user works.
      this.sink.style.left = `${Math.max(0, Math.min(window.innerWidth - 2, c.x))}px`;
      this.sink.style.top = `${Math.max(0, Math.min(window.innerHeight - 2, c.y))}px`;
    }
    try { this.sink.focus({ preventScroll: true }); } catch { /* detached */ }
  }

  /** Release every key/button we hold on the host. force → send even if nothing is tracked. */
  releaseAll(force = false) {
    const held = this.buttons.size > 0 || this.keys.size > 0;
    this.buttons.clear();
    this.keys.clear();
    // Held-back modifiers were never sent: just forget them.
    this.#dropCtrlHold();
    this.fakeCtrl = false;
    this.altGr = false;
    this.altGrDead = false;
    this.deadKeyUp = null;
    this.altHold.clear();
    this.pendingClient = null;
    this.wheel.dx = 0;
    this.wheel.dy = 0;
    this.escDownAt = 0;
    clearTimeout(this.captureLossTimer);
    if (this.enabled && (held || force)) this.o.send({ t: I.RELEASE_ALL });
  }

  /** Type Unicode text on the host (`txt`, chunked to MAX_TEXT). @returns {boolean} */
  sendText(text) {
    if (!this.enabled || typeof text !== 'string' || !text) return false;
    let ok = true;
    for (const chunk of chunkText(text, I.MAX_TEXT)) ok = this.o.send({ t: I.TEXT, text: chunk }) && ok;
    return ok;
  }

  /** Special key combination (codes in host terms, never swapped). @returns {boolean} */
  sendCombo(codes) {
    if (!this.enabled || !Array.isArray(codes) || !codes.length) return false;
    const clean = codes.filter((c) => typeof c === 'string' && c.length <= 32).slice(0, 8);
    if (clean.length !== codes.length) return false;
    return this.o.send({ t: I.COMBO, codes: clean });
  }

  destroy() {
    this.setEnabled(false);
    this.ac.abort();
    cancelAnimationFrame(this.raf);
    clearTimeout(this.captureLossTimer);
    this.#dropCtrlHold();
  }

  /* -------------------------------------------------------------------------------------- */
  /* wiring                                                                                  */
  /* -------------------------------------------------------------------------------------- */

  #bind(signal) {
    const st = this.stage;
    const opt = { signal };
    st.addEventListener('pointerdown', (e) => this.#onPointerDown(e), opt);
    st.addEventListener('pointermove', (e) => this.#onPointerMove(e), opt);
    st.addEventListener('pointerup', (e) => this.#onPointerUp(e), opt);
    st.addEventListener('pointercancel', (e) => this.#onPointerUp(e, true), opt);
    st.addEventListener('pointerleave', () => { if (!this.buttons.size) this.lastClient = null; }, opt);
    st.addEventListener('lostpointercapture', () => this.#onCaptureLost(), opt);
    st.addEventListener('mousedown', (e) => this.#onMouseDown(e), opt);
    st.addEventListener('mouseup', (e) => this.#onMouseUp(e), opt);
    st.addEventListener('wheel', (e) => this.#onWheel(e), { signal, passive: false });
    // The remote cursor is part of the video; a local context menu / drag image would only get in the way.
    st.addEventListener('contextmenu', (e) => e.preventDefault(), opt);
    st.addEventListener('dragstart', (e) => e.preventDefault(), opt);
    st.addEventListener('auxclick', (e) => e.preventDefault(), opt);

    // Capture phase on window: we see keys before any focused UI element does.
    window.addEventListener('keydown', (e) => this.#onKeyDown(e), { signal, capture: true });
    window.addEventListener('keyup', (e) => this.#onKeyUp(e), { signal, capture: true });
    window.addEventListener('blur', () => this.releaseAll(true), opt);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(true); }, opt);
    // Pointer left the window and the button was released outside without us seeing mouseup.
    document.addEventListener('mouseleave', (e) => { if (this.buttons.size && e.buttons === 0) this.releaseAll(true); }, opt);

    const sink = this.sink;
    sink.addEventListener('compositionstart', () => {
      this.composing = true;
      this.altGrDead = false; // the input method composes the dead key itself (→ compositionend)
      this.#markComposed();
    }, opt);
    sink.addEventListener('compositionend', (e) => this.#onCompositionEnd(e), opt);
    sink.addEventListener('input', (e) => this.#onSinkInput(e), opt);
    sink.addEventListener('blur', () => {
      this.altGrDead = false; // a pending dead key now composes wherever the focus went
      if (!this.composing) sink.value = '';
    }, opt);
  }

  /* -------------------------------------------------------------------------------------- */
  /* pointer                                                                                 */
  /* -------------------------------------------------------------------------------------- */

  #point(clientX, clientY) {
    const v = this.video;
    const rect = contentRect(v.getBoundingClientRect(), v.videoWidth, v.videoHeight);
    return rect ? normalizePoint(clientX, clientY, rect) : null;
  }

  #onPointerDown(e) {
    this.lastClient = { x: e.clientX, y: e.clientY };
    if (!this.enabled) return;
    if (e.pointerType === 'mouse') {
      // Keep receiving moves/ups while dragging outside the video or the window.
      try { this.stage.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
      return; // buttons are handled in mousedown (has the click count)
    }
    // Touch / pen: primary contact acts as the left button. preventDefault suppresses the
    // compatibility mouse events (no double md) and the focus change.
    if (!e.isPrimary) return;
    e.preventDefault();
    this.focus();
    try { this.stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    const pos = this.#point(e.clientX, e.clientY);
    if (!pos || !pos.inside) return;
    this.#buttonDown(0, 1, pos, e);
  }

  #onPointerUp(e, cancelled = false) {
    if (e.pointerType === 'mouse' || !e.isPrimary || !this.buttons.has(0)) return;
    const pos = this.#point(e.clientX, e.clientY) || this.lastSent;
    if (cancelled || !pos) { this.releaseAll(true); return; }
    this.#buttonUp(0, 1, pos);
  }

  #onPointerMove(e) {
    this.lastClient = { x: e.clientX, y: e.clientY };
    if (this.enabled) {
      // A mouseup we never saw (e.g. released over a native menu): resync from the live bitmask.
      if (e.pointerType === 'mouse' && this.buttons.size) {
        for (const b of [...this.buttons]) {
          if (!(e.buttons & buttonBit(b))) {
            const pos = this.#point(e.clientX, e.clientY) || this.lastSent;
            if (pos) this.#buttonUp(b, 1, pos);
            else this.buttons.delete(b);
          }
        }
      }
      this.pendingClient = { x: e.clientX, y: e.clientY };
    }
    if (this.enabled || this.o.getScale() === 'original') this.#schedule();
  }

  #onMouseDown(e) {
    // Never let the stage take focus / start a selection / middle-click autoscroll; the IME sink
    // keeps keyboard focus so typing continues to reach the remote.
    e.preventDefault();
    this.lastClient = { x: e.clientX, y: e.clientY };
    this.focus();
    if (!this.enabled) return;
    const b = e.button;
    if (!Number.isInteger(b) || b < 0 || b > 4) return;
    const pos = this.#point(e.clientX, e.clientY);
    if (!pos) return;
    if (!pos.inside && this.buttons.size === 0) return; // click on the letterbox bars: ignore
    this.#buttonDown(b, Math.max(1, e.detail || 1), pos, e);
  }

  #onMouseUp(e) {
    const b = e.button;
    if (!this.buttons.has(b)) return;
    e.preventDefault();
    const pos = this.#point(e.clientX, e.clientY) || this.lastSent;
    if (!pos) { this.releaseAll(true); return; }
    this.#buttonUp(b, Math.max(1, e.detail || 1), pos);
  }

  #onCaptureLost() {
    if (!this.buttons.size) return;
    clearTimeout(this.captureLossTimer);
    // lostpointercapture also fires on a normal release; only act if no mouseup followed.
    this.captureLossTimer = setTimeout(() => { if (this.buttons.size) this.releaseAll(true); }, CAPTURE_LOSS_GRACE_MS);
  }

  #sendMove(pos) {
    this.pendingClient = null;
    this.lastSent = { x: pos.x, y: pos.y };
    this.o.send({ t: I.MOUSE_MOVE, x: pos.x, y: pos.y });
  }

  #buttonDown(b, n, pos, e) {
    this.#flushHolds(); // e.g. ⌥-click / Ctrl-click: the modifier must be down on the host first
    this.#syncModifiers(e); // …also one held through a focus loss (⌘-click after ⌘Tab)
    this.#sendMove(pos); // host must be at the exact spot before the press
    this.buttons.add(b);
    this.o.send({ t: I.MOUSE_DOWN, b, x: pos.x, y: pos.y, n });
  }

  #buttonUp(b, n, pos) {
    this.#flushHolds();
    this.#sendMove(pos);
    this.buttons.delete(b);
    this.o.send({ t: I.MOUSE_UP, b, x: pos.x, y: pos.y, n });
  }

  #onWheel(e) {
    if (!this.enabled) return; // view-only: let 1:1 mode scroll the stage locally
    e.preventDefault(); // also blocks Chromium pinch-zoom (ctrl+wheel)
    // Shift/⌥/⌘ held through a focus loss (horizontal scroll, zoom…). Never Control: a touchpad
    // pinch is reported as a wheel event with ctrlKey set while no Control key is down, so a
    // Control pressed from it would never see a keyup.
    this.#syncModifiers(e, { control: false });
    const { dx, dy } = wheelPixels(e);
    this.wheel.dx += dx;
    this.wheel.dy += dy;
    this.pendingClient = { x: e.clientX, y: e.clientY };
    this.lastClient = { x: e.clientX, y: e.clientY };
    this.#schedule();
  }

  #schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(() => this.#frame());
  }

  /** Once per animation frame: coalesced move, summed wheel, edge auto-pan. */
  #frame() {
    this.raf = 0;
    let again = false;

    // Edge auto-pan in 1:1 mode (also useful when view-only).
    if (this.o.getScale() === 'original' && this.lastClient && !document.hidden) {
      const st = this.stage;
      const canScroll = st.scrollWidth > st.clientWidth + 1 || st.scrollHeight > st.clientHeight + 1;
      if (canScroll) {
        const { dx, dy } = edgePanDelta(this.lastClient.x, this.lastClient.y, st.getBoundingClientRect());
        if (dx || dy) {
          const beforeX = st.scrollLeft;
          const beforeY = st.scrollTop;
          st.scrollBy(dx, dy);
          if (st.scrollLeft !== beforeX || st.scrollTop !== beforeY) {
            again = true;
            // The picture moved under a stationary pointer → the remote position changed too.
            if (this.enabled) this.pendingClient = { ...this.lastClient };
          }
        }
      }
    }

    if (this.enabled && this.pendingClient) {
      const pos = this.#point(this.pendingClient.x, this.pendingClient.y);
      this.pendingClient = null;
      if (pos && (!this.lastSent || pos.x !== this.lastSent.x || pos.y !== this.lastSent.y)) {
        // droppable: under heavy backpressure a stale move is worthless; the next one supersedes it.
        if (this.o.send({ t: I.MOUSE_MOVE, x: pos.x, y: pos.y }, { droppable: true })) this.lastSent = { x: pos.x, y: pos.y };
      }
    }

    if (this.enabled && (this.wheel.dx || this.wheel.dy)) {
      const dx = Math.round(this.wheel.dx * 100) / 100;
      const dy = Math.round(this.wheel.dy * 100) / 100;
      this.wheel.dx = 0;
      this.wheel.dy = 0;
      if (dx || dy) {
        this.#flushHolds(); // modifier+wheel (zoom, horizontal scroll) keeps its modifier
        this.o.send({ t: I.WHEEL, dx, dy }, { droppable: true });
      }
    }

    if (again) this.#schedule();
  }

  /* -------------------------------------------------------------------------------------- */
  /* keyboard                                                                                */
  /* -------------------------------------------------------------------------------------- */

  #isLocalTarget(el) {
    if (!el || el === this.sink || el === document.body || el === document.documentElement) return false;
    if (isEditable(el)) return true;
    return !!(el.closest && el.closest('[data-local-keys]'));
  }

  /** kd/ku message. `e` (keydown only) adds the viewer's lock state for the host to resync. */
  #keyMsg(type, wire, key, rep, e) {
    const msg = { t: type, code: wire, key: safeKey(key) };
    if (type === I.KEY_DOWN) {
      msg.rep = !!rep;
      const locks = this.#locks(e);
      if (locks) msg.locks = locks;
    }
    return msg;
  }

  #sendKey(type, wire, key, rep, e) {
    this.o.send(this.#keyMsg(type, wire, key, rep, e));
  }

  /**
   * {caps, num} lock state seen with this keydown, or null when unknown. Omitted for the lock keys
   * themselves: Chromium reports their state AFTER the toggle, so a host resyncing on it would
   * toggle twice; the next key carries the settled state. macOS has no NumLock (its keypad always
   * types digits), so a Mac viewer always says num:true.
   */
  #locks(e) {
    if (!e || typeof e.getModifierState !== 'function' || e.code === 'CapsLock' || e.code === 'NumLock') return null;
    return {
      caps: modifierState(e, 'CapsLock'),
      num: this.o.localOs === 'macos' ? true : modifierState(e, 'NumLock'),
    };
  }

  #hostOs() {
    try { return this.o.getHostOs ? this.o.getHostOs() : ''; } catch { return ''; }
  }

  /** Windows viewer controlling a Mac: AltGr must not turn into ⌘⌥ (Windows hosts handle Ctrl+RAlt as AltGr). */
  #altGrFix() {
    return this.o.localOs === 'windows' && this.#hostOs() === 'macos';
  }

  /** Mac viewer controlling a Windows PC: a lone Option tap must not reach Windows as an Alt tap. */
  #optionFix() {
    return this.o.localOs === 'macos' && this.#hostOs() === 'windows';
  }

  /* ---- held-back modifiers ---- */

  #dropCtrlHold() {
    if (!this.ctrlHold) return;
    clearTimeout(this.ctrlHold.timer);
    this.ctrlHold = null;
  }

  /** Send a held-back ControlLeft as a normal kd (it was a real Ctrl press, not AltGr). */
  #flushCtrlHold() {
    const h = this.ctrlHold;
    if (!h) return;
    this.#dropCtrlHold();
    if (!this.enabled) return;
    this.keys.set(h.code, h.wire);
    this.o.send(h.msg);
  }

  /** Send deferred Option keydowns (another key / a button needs the modifier on the host). */
  #flushAltHolds() {
    if (!this.altHold.size) return;
    const held = [...this.altHold];
    this.altHold.clear();
    if (!this.enabled) return;
    for (const [code, h] of held) {
      this.keys.set(code, h.wire);
      this.o.send(h.msg);
    }
  }

  #flushHolds() {
    this.#flushCtrlHold();
    this.#flushAltHolds();
  }

  /** The OS input method used the held Option (dead key / composition): its release sends nothing. */
  #markComposed() {
    for (const h of this.altHold.values()) h.composed = true;
  }

  /* ---- modifiers held through a focus loss ---- */

  /**
   * Press on the host every modifier the event reports down that the host does not have yet:
   * blur released everything there, and the OS sends no new keydown for a key that was still held
   * when the window became active again (⌘C or ⌥-click right after a ⌘Tab round trip would
   * otherwise arrive without ⌘ / ⌥). Called before a forwarded non-modifier key, a button press
   * and a wheel, AFTER #flushHolds. The modifier is registered under its left code; its own keyup
   * (left or right key, see #releaseFamily) or the next blur releases it.
   * Never re-creates what the cross-OS fixes deliberately keep off the host: AltGr's synthetic Ctrl
   * and AltGr itself (Windows → Mac), or an Option still deferred in altHold (Mac → Windows).
   * Only while this window has focus: macOS and Windows deliver wheel events to the window under
   * the pointer even when it is inactive, and a modifier held for another app would then be
   * pressed on the host with its keyup going to that app — stuck until pressed again here.
   */
  #syncModifiers(e, { control = true } = {}) {
    if (!e || !this.enabled) return;
    if (typeof document !== 'undefined' && typeof document.hasFocus === 'function' && !document.hasFocus()) return;
    const altGraph = modifierState(e, 'AltGraph');
    const altGrSide = this.#altGrFix() && (altGraph || this.altGr || this.fakeCtrl || !!this.ctrlHold);
    for (const f of MODIFIER_FAMILIES) {
      if (e[f.flag] !== true) continue;
      if (f.codes.some((c) => this.keys.has(c))) continue; // the host already has it
      if (f.key === 'Control' && (!control || this.ctrlHold)) continue;
      if (f.key === 'Alt' && this.altHold.size) continue; // deferred Option: #flushHolds sends it when needed
      if (altGrSide && (f.key === 'Control' || f.key === 'Alt')) continue;
      // AltGr on a Windows viewer is LCtrl + RAlt: keep it AltGr for a Windows host.
      const code = f.key === 'Alt' && altGraph && this.o.localOs === 'windows' ? 'AltRight' : f.codes[0];
      const wire = mapCode(code, this.o.getSwap());
      this.keys.set(code, wire);
      this.o.send(this.#keyMsg(I.KEY_DOWN, wire, f.key, false, e));
    }
  }

  /**
   * keyup of a modifier the host does not track under this code: when the event says no key of
   * that family is down any more, release whatever the host holds for it (e.g. ⌘ re-pressed by
   * #syncModifiers as MetaLeft, physically released with the right ⌘). @returns {boolean} handled
   */
  #releaseFamily(code, e) {
    const f = MODIFIER_FAMILIES.find((m) => m.codes.includes(code));
    if (!f || e[f.flag] === true) return false;
    const held = f.codes.filter((c) => this.keys.has(c));
    if (!held.length) return false;
    for (const c of held) {
      const wire = this.keys.get(c);
      this.keys.delete(c);
      this.#sendKey(I.KEY_UP, wire, e.key);
    }
    if (f.key === 'Meta') this.#releaseAfterMeta();
    return true;
  }

  /**
   * macOS does not deliver keyup for keys released while ⌘ is held (⌘C → no keyup for C).
   * Release those together with ⌘ so they do not auto-repeat on the host.
   */
  #releaseAfterMeta() {
    if (this.o.localOs !== 'macos') return;
    for (const [phys, w] of [...this.keys]) {
      if (isModifierCode(phys)) continue;
      this.keys.delete(phys);
      if (this.enabled) this.#sendKey(I.KEY_UP, w, '');
    }
  }

  /**
   * Windows viewer → Mac host. @returns {boolean} true when the keydown was fully handled here
   * (held back, dropped, or typed as `txt`); false → forward it normally.
   */
  #altGrKeyDown(e) {
    const code = e.code;
    const held = this.ctrlHold;
    if (held) {
      const dt = Number.isFinite(e.timeStamp) && Number.isFinite(held.ts) ? Math.abs(e.timeStamp - held.ts) : 0;
      if (code === 'AltRight' && e.key === 'AltGraph' && dt <= ALTGR_PAIR_MS) {
        this.#dropCtrlHold(); // AltGr's synthetic ControlLeft: never reaches the Mac
        this.fakeCtrl = true;
      } else {
        this.#flushCtrlHold();
      }
    }
    if (code === 'ControlLeft') {
      if (e.repeat) {
        if (this.fakeCtrl) return true; // AltGr held: Windows repeats the synthetic Ctrl too
      } else if (!this.keys.has(code)) {
        this.fakeCtrl = false; // a fresh press (an earlier keyup may have been lost)
        const wire = mapCode(code, this.o.getSwap());
        this.ctrlHold = {
          code, wire, ts: e.timeStamp, msg: this.#keyMsg(I.KEY_DOWN, wire, e.key, false, e),
          timer: setTimeout(() => this.#flushCtrlHold(), CTRL_HOLD_MS),
        };
        return true;
      }
    }
    if (code === 'AltRight' && (e.key === 'AltGraph' || (this.altGr && modifierState(e, 'AltGraph')))) {
      this.altGr = true; // Mac layouts put these characters on other ⌥ combinations: not forwarded
      return true;
    }
    // (Dead keys under AltGr, and the key after one, never get here: see #onKeyDown.)
    if (this.altGr && modifierState(e, 'AltGraph') && isPrintableKey(e.key)) {
      this.#flushHolds();
      this.sendText(e.key);
      return true;
    }
    return false;
  }

  /**
   * Windows viewer → Mac host: the first non-modifier key after an AltGr dead key. A character key
   * is left entirely to Windows (no preventDefault, nothing forwarded, its keyup swallowed): Windows
   * types the composed character, or the accent plus this key, into the IME sink, whose `input`
   * event sends it as `txt`. A named key (Enter, arrows, Backspace, Esc…) or a Ctrl/Alt/⌘ shortcut
   * drops the accent and is forwarded as usual. @returns {boolean} true when left to Windows
   */
  #keyAfterAltGrDead(e) {
    this.altGrDead = false;
    const shortcut = (e.ctrlKey || e.altKey || e.metaKey) && !modifierState(e, 'AltGraph');
    if (shortcut || !isPrintableKey(e.key)) return false;
    this.deadKeyUp = e.code && !this.keys.has(e.code) ? e.code : null;
    return true;
  }

  /** Mac viewer → Windows host: defer Option. @returns {boolean} true when handled here. */
  #optionKeyDown(e) {
    const code = e.code;
    if (code !== 'AltLeft' && code !== 'AltRight') return false;
    if (this.altHold.has(code)) return true; // (macOS does not auto-repeat modifiers)
    if (this.keys.has(code)) return false; // already sent
    const wire = mapCode(code, this.o.getSwap());
    this.altHold.set(code, { wire, msg: this.#keyMsg(I.KEY_DOWN, wire, e.key, false, e), composed: false });
    return true;
  }

  #onKeyDown(e) {
    if (this.#isLocalTarget(e.target)) {
      this.altGrDead = false; // a pending dead key composes into the local field now
      return;
    }
    if (e.code === 'Escape') this.altGrDead = false; // Esc cancels a pending dead key (even when used locally)

    // Ctrl+Alt+Shift (any order) toggles the toolbar, even in fullscreen. AltGr (= Ctrl+Alt on
    // Windows) + Shift is a real typing chord on several European layouts, so it is excluded.
    if (isModifierCode(e.code) && e.ctrlKey && e.altKey && e.shiftKey && !e.metaKey && !e.repeat &&
        !(e.getModifierState && e.getModifierState('AltGraph'))) {
      e.preventDefault();
      this.releaseAll(true); // the three modifiers already went down on the host
      this.o.onToolbarShortcut();
      return;
    }

    if (e.code === 'Escape' && this.o.onEscapeLocal && this.o.onEscapeLocal()) {
      e.preventDefault();
      return;
    }

    // Long-press Esc leaves fullscreen (works in view-only too). Auto-repeat of Esc is never
    // forwarded while fullscreen because it is our exit gesture.
    if (e.code === 'Escape' && this.suppressEsc) {
      if (e.repeat) {
        e.preventDefault(); // still held after the long-press exit: not meant for the remote
        return;
      }
      this.suppressEsc = false; // a fresh press: the earlier keyup was lost (focus change)
    }
    if (e.code === 'Escape' && this.o.isFullscreen()) {
      if (!e.repeat) {
        this.escDownAt = performance.now();
      } else {
        e.preventDefault();
        if (this.escDownAt && performance.now() - this.escDownAt >= ESC_HOLD_MS) {
          this.releaseAll(true);
          this.suppressEsc = true; // until this Esc is released
          this.o.onExitFullscreen();
        }
        return;
      }
    }

    if (!this.enabled) return;
    // Windows → Mac: a dead key under AltGr (or right after one) never goes to the Mac, whose
    // layout has other dead keys: Windows composes it with the next key instead (below).
    const altGrDeadKey = e.key === 'Dead' && (this.altGrDead || (this.altGr && modifierState(e, 'AltGraph')));
    // The OS input method owns this key; its result arrives as compositionend → `txt`.
    // (So does a dead key under a still-deferred ⌥ or an AltGr dead key towards a Mac, whatever
    // keyCode the build reports: not forwarded, and no preventDefault so the composition can start.)
    if (e.isComposing || e.keyCode === 229 || (e.key === 'Dead' && this.altHold.size > 0) || altGrDeadKey) {
      // Chromium on Windows fires no composition events for layout dead keys: remember it, so the
      // next key is left to Windows as well (a composition, if one starts, clears this).
      if (altGrDeadKey && !e.isComposing && e.keyCode !== 229) this.altGrDead = true;
      this.#markComposed(); // ⌥ was a dead-key prefix (⌥E, ⌥U…): its release must not tap Alt
      return;
    }
    if (this.altGrDead && !isModifierCode(e.code) && this.#keyAfterAltGrDead(e)) return;

    e.preventDefault();
    const code = e.code;
    if (!code) {
      // No physical key (some on-screen keyboards / IMEs): type the character instead.
      if (typeof e.key === 'string' && Array.from(e.key).length === 1) this.sendText(e.key);
      return;
    }
    if (this.#altGrFix() && this.#altGrKeyDown(e)) return;
    if (this.#optionFix() && this.#optionKeyDown(e)) return;
    this.#flushHolds(); // a key that is forwarded needs its held modifiers down first
    if (!isModifierCode(code)) this.#syncModifiers(e); // …and modifiers held through a focus loss
    // macOS reports CapsLock as keydown when it turns ON and keyup when it turns OFF; the host
    // needs a full tap for every toggle or its caps state drifts.
    if (code === 'CapsLock' && this.o.localOs === 'macos') {
      const wire = mapCode(code, false);
      this.#sendKey(I.KEY_DOWN, wire, e.key, false, e);
      this.#sendKey(I.KEY_UP, wire, e.key);
      return;
    }
    let wire = this.keys.get(code);
    if (!wire) {
      wire = mapCode(code, this.o.getSwap());
      this.keys.set(code, wire);
    }
    this.#sendKey(I.KEY_DOWN, wire, e.key, e.repeat, e);
  }

  #onKeyUp(e) {
    const code = e.code;
    if (code === 'Escape') {
      this.escDownAt = 0;
      if (this.suppressEsc) {
        this.suppressEsc = false;
        e.preventDefault();
        return;
      }
    }

    // Windows → Mac: a held-back ControlLeft goes out before any release (a quick Ctrl tap included).
    this.#flushCtrlHold();
    if (this.deadKeyUp && code === this.deadKeyUp) {
      this.deadKeyUp = null; // the key Windows composed with an AltGr dead key: never pressed on the host
      if (!this.keys.has(code)) return;
    }
    if (code === 'ControlLeft' && this.fakeCtrl) {
      this.fakeCtrl = false; // AltGr's synthetic Ctrl was never sent: neither is its release
      e.preventDefault();
      return;
    }
    if (code === 'AltRight' && this.altGr) {
      this.altGr = false;
      if (!this.keys.has(code)) { e.preventDefault(); return; }
    }
    // Mac → Windows: Option released before anything needed it.
    const opt = this.altHold.get(code);
    if (opt) {
      this.altHold.delete(code);
      e.preventDefault();
      // Composed (dead key) → nothing at all; untouched → a deliberate Alt tap.
      if (this.enabled && !opt.composed && !this.#isLocalTarget(e.target)) {
        this.o.send(opt.msg);
        this.#sendKey(I.KEY_UP, opt.wire, e.key);
      }
      return;
    }

    if (!this.keys.has(code)) {
      if (!this.enabled) return;
      // A modifier re-pressed by #syncModifiers under its left code, released with the right key.
      if (this.#releaseFamily(code, e)) { e.preventDefault(); return; }
      if (this.#isLocalTarget(e.target) || e.isComposing) return;
      if (code === 'CapsLock' && this.o.localOs === 'macos') {
        e.preventDefault();
        const wire = mapCode(code, false);
        this.#sendKey(I.KEY_DOWN, wire, e.key, false);
        this.#sendKey(I.KEY_UP, wire, e.key);
      } else if (code === 'PrintScreen') {
        // Windows consumes the PrintScreen keydown (screenshot hotkey) and only delivers keyup.
        e.preventDefault();
        const wire = mapCode(code, false);
        this.#sendKey(I.KEY_DOWN, wire, e.key, false, e);
        this.#sendKey(I.KEY_UP, wire, e.key);
      }
      return;
    }

    // Always forward the release of a key we pressed on the host, even if focus moved to local UI
    // in between — otherwise the key would stay stuck down remotely.
    e.preventDefault();
    const wire = this.keys.get(code);
    this.keys.delete(code);
    if (this.enabled) this.#sendKey(I.KEY_UP, wire, e.key);
    if (isMetaCode(code)) this.#releaseAfterMeta();
  }

  /* -------------------------------------------------------------------------------------- */
  /* IME sink                                                                                */
  /* -------------------------------------------------------------------------------------- */

  #onCompositionEnd(e) {
    this.composing = false;
    if (this.enabled && typeof e.data === 'string' && e.data) this.sendText(e.data);
    // Chromium may still insert the committed text right after compositionend; clear afterwards.
    setTimeout(() => { if (!this.composing) this.sink.value = ''; }, 0);
  }

  #onSinkInput(e) {
    if (e.isComposing || this.composing) return; // never touch the sink mid-composition
    // Text inserted without a composition: emoji picker, dictation, macOS accent popup, the
    // character Windows composed from an AltGr dead key, …
    if (this.enabled && (e.inputType === 'insertText' || e.inputType === 'insertReplacementText') && e.data) {
      this.altGrDead = false; // Windows resolved the dead key (e.g. pressed twice: '~~')
      this.sendText(e.data);
    }
    this.sink.value = '';
  }
}
