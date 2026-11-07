/*
 * Tunnelview viewer — floating session toolbar (top-centre pill).
 *
 * Auto-hides HIDE_DELAY_MS after the pointer leaves the top TOP_ZONE_PX of the window (unless
 * pinned or a menu is open). Ctrl+Alt+Shift (wired in input.js) toggles it — also in fullscreen,
 * where it is the only way to reach the toolbar without the mouse.
 *
 * Buttons never take keyboard focus on click (mousedown preventDefault) so typing keeps going to
 * the remote through input.js's IME sink. All host-provided strings are inserted as text.
 *
 * Layout: [host · tools… | ⋯ | fullscreen · pin · Disconnect]. The trailing group never moves or
 * scrolls away; when the window (or the space left by an open drawer) is too narrow for every
 * tool, the least important ones move into the "⋯" menu (measured on every resize with a
 * ResizeObserver). The "View only" chip (o.avoid) is moved below the toolbar whenever the toolbar
 * would cover it.
 */
import { h, icon, osIcon } from '../shared/ui.js';
import { specialKeysFor } from '../shared/keys.js';

const HIDE_DELAY_MS = 2500;
const TOP_ZONE_PX = 48;
const SHORTCUT_REVEAL_MS = 4000;
const PIN_KEY = 'tunnelview.viewer.toolbarPinned';
const CHIP_GAP_PX = 8;

// Tools that can move into the "⋯" menu, least important first. Short labels for that menu.
const OVERFLOW_ORDER = ['stats', 'screenshot', 'audio', 'send', 'view', 'clipboard', 'transfers', 'keys', 'display', 'chat', 'viewOnly'];
const MENU_LABELS = {
  display: 'Remote display', view: 'Quality and scaling', viewOnly: 'View only', keys: 'Special keys',
  clipboard: 'Clipboard sync', send: 'Send files…', transfers: 'File transfers', chat: 'Chat',
  screenshot: 'Save a screenshot', stats: 'Connection statistics', audio: 'Remote audio',
};

const keepFocus = (e) => e.preventDefault();

const PRESETS = [
  { id: 'quality', label: 'Best', title: 'Sharpest picture (up to 25 Mbps)' },
  { id: 'balanced', label: 'Balanced', title: 'Good picture, smooth motion (up to 10 Mbps)' },
  { id: 'speed', label: 'Fast', title: 'Lowest latency on slow links (up to 4 Mbps)' },
];
const SCALES = [
  { id: 'fit', label: 'Fit window', title: 'Scale the remote screen to fit this window' },
  { id: 'original', label: '1:1', title: 'Show the remote screen pixel for pixel (scroll / move to the edges to pan)' },
];
const SWAPS = [
  { id: 'auto', label: 'Auto', title: 'Swap only between macOS and Windows' },
  { id: 'on', label: 'On', title: 'Always swap Cmd and Ctrl' },
  { id: 'off', label: 'Off', title: 'Never swap' },
];

function readPinned() {
  try { return localStorage.getItem(PIN_KEY) === '1'; } catch { return false; }
}
function writePinned(v) {
  try { localStorage.setItem(PIN_KEY, v ? '1' : '0'); } catch { /* storage unavailable */ }
}

export class Toolbar {
  /**
   * @param {HTMLElement} host
   * @param {object} o
   * @param {'windows'|'macos'} o.localOs
   * @param {HTMLElement} [o.avoid]  element at the top-left (the "View only" chip) to keep clear of
   * @param {object} o.actions  see viewer.js (selectDisplay, setPreset, setScale, toggleViewOnly, setSwap,
   *   toggleClipboard, sendCombo, openTypeText, sendFiles, toggleChat, toggleTransfers, screenshot,
   *   toggleStats, toggleMute, toggleFullscreen, disconnect, releaseInput)
   */
  constructor(host, o) {
    this.o = o;
    this.a = o.actions;
    this.s = {};
    this.btns = {};
    this.badges = {};
    this.seps = [];
    this.runs = {}; // key → what the button does (also used by the "⋯" menu)
    this.overflowed = []; // keys currently in the "⋯" menu, in toolbar order
    this.layoutRaf = 0;
    this.layoutSig = '';
    this.active = false;
    this.shown = false;
    this.pinned = readPinned();
    this.hover = false;
    this.inZone = false;
    this.forced = false;
    this.hideTimer = 0;
    this.forceTimer = 0;
    this.pop = null; // { el, anchor, build }
    this.ac = new AbortController();

    this.#build(host);
    this.#bind();
    this.#applyShown(false);
    this.#scheduleLayout();
  }

  /* -------------------------------------------------------------------------------------- */
  /* public                                                                                  */
  /* -------------------------------------------------------------------------------------- */

  /** Toolbar usable (streaming)? When false it is hidden entirely. */
  setActive(on) {
    on = !!on;
    if (on === this.active) return;
    this.active = on;
    if (!on) this.closePopover();
    else this.reveal(3000); // let the user discover it when the stream starts
    this.#sync();
    this.#scheduleLayout();
  }

  /** Keep the toolbar visible for `ms`. */
  reveal(ms = SHORTCUT_REVEAL_MS) {
    this.forced = true;
    clearTimeout(this.forceTimer);
    this.forceTimer = setTimeout(() => { this.forced = false; this.#sync(); }, ms);
    this.#sync();
  }

  /** Ctrl+Alt+Shift: show if hidden, hide if it was only shown by the shortcut. */
  toggleReveal() {
    if (this.shown && this.forced && !this.pinned) {
      this.forced = false;
      clearTimeout(this.forceTimer);
      this.closePopover();
      this.#sync(true);
    } else {
      this.reveal();
    }
  }

  get popoverOpen() {
    return !!this.pop;
  }

  /** @returns {boolean} true if a popover was open (Esc consumed). */
  closePopover() {
    if (!this.pop) return false;
    const { el, anchor } = this.pop;
    this.pop = null;
    anchor.classList.remove('open');
    anchor.setAttribute('aria-expanded', 'false');
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 150);
    this.#sync();
    return true;
  }

  /** Open the native file picker (also used by the Transfers drawer). */
  pickFiles() {
    this.fileInput.value = '';
    this.fileInput.click();
  }

  /** Push the current view model (see viewer.js toolbarModel()). */
  update(s) {
    this.s = s;
    const b = this.btns;

    // host + quality
    this.hostName.textContent = s.hostName || '';
    if (this.osShown !== s.hostOs) {
      this.osShown = s.hostOs;
      this.hostOs.replaceChildren(osIcon(s.hostOs, { size: 14 }));
    }
    this.qualityDot.className = `dot${s.quality ? ` dot-${s.quality}` : ''}`;
    this.host.title = `${s.hostName}${s.qualityTitle ? ` — ${s.qualityTitle}` : ''}`
      + `${s.pathTitle ? `\n${s.pathTitle}` : ''}\nShow this toolbar any time: ${this.#shortcutLabel()}`;

    // displays
    b.display.hidden = !(s.displays && s.displays.length > 1);

    // view-only / control
    const controlOff = !s.controlAvailable;
    this.#toggle(b.viewOnly, s.viewOnly || controlOff, s.viewOnly || controlOff ? 'eye' : 'mouse');
    b.viewOnly.disabled = controlOff;
    this.#label(b.viewOnly, controlOff
      ? `View only — ${s.controlReason || 'remote control is not available'}`
      : s.viewOnly ? 'View only (click to control the remote computer)' : 'Controlling the remote computer (click for view only)');
    b.keys.disabled = controlOff || s.viewOnly;
    this.#label(b.keys, b.keys.disabled ? 'Special keys (needs remote control)' : 'Special keys, Cmd/Ctrl swap and type text');

    // clipboard
    this.#toggle(b.clipboard, s.clipboardSync && s.clipboardAllowed);
    b.clipboard.disabled = !s.clipboardAllowed;
    this.#label(b.clipboard, !s.clipboardAllowed ? 'Clipboard sync (disabled by the host)'
      : s.clipboardSync ? 'Clipboard sync is on — copy on one side, paste on the other' : 'Clipboard sync is off');

    // files / transfers / chat
    b.send.disabled = !(s.filesAllowed && s.filesReady);
    this.#label(b.send, !s.filesAllowed ? 'Send files (disabled by the host)' : 'Send files (or drop them anywhere)');
    this.#toggle(b.transfers, s.transfersOpen);
    this.#badge('transfers', s.transfersBadge);
    this.#toggle(b.chat, s.chatOpen);
    this.#badge('chat', s.chatUnread);

    // tools
    this.#toggle(b.stats, s.statsVisible);
    b.audio.disabled = !(s.hasAudio && s.audioAllowed);
    this.#toggle(b.audio, false, s.muted || !s.audioAllowed ? 'volume-off' : 'volume');
    this.#label(b.audio, !s.audioAllowed ? 'Audio (disabled by the host)' : !s.hasAudio ? 'No audio from the remote computer'
      : s.muted ? 'Unmute remote audio' : 'Mute remote audio');
    this.#toggle(b.fullscreen, false, s.fullscreen ? 'fullscreen-exit' : 'fullscreen');
    this.#label(b.fullscreen, s.fullscreen
      ? `Exit fullscreen (or hold Esc)`
      : `Fullscreen — system shortcuts like ${this.o.localOs === 'macos' ? '⌘Tab' : 'Alt+Tab and the Windows key'} go to the remote. Hold Esc to exit.`);
    this.#toggle(b.pin, this.pinned, this.pinned ? 'lock' : 'unlock');
    this.#label(b.pin, this.pinned ? 'Toolbar pinned (click to auto-hide)' : `Pin the toolbar (auto-hides otherwise; ${this.#shortcutLabel()} shows it)`);

    this.#badge('more', this.#overflowBadge());

    // Width-affecting changes (display button, host name, a drawer opening) → re-measure.
    const layoutSig = JSON.stringify([b.display.hidden, s.hostName, !!(s.chatOpen || s.transfersOpen)]);
    if (layoutSig !== this.layoutSig) {
      this.layoutSig = layoutSig;
      this.#scheduleLayout();
    }

    // update() runs every second (stats); rebuilding an open menu that often would eat clicks
    // (mousedown on one node, mouseup on its replacement), so only rebuild when its data changed.
    this.#refreshPopover();
  }

  #refreshPopover() {
    if (this.pop && this.pop.sigFn() !== this.pop.sig) this.#renderPopover();
  }

  #popoverSig() {
    const s = this.s;
    return JSON.stringify([s.displays, s.currentDisplay, s.preset, s.scale, s.swapSetting, s.swapEffective,
      s.controlAvailable, s.viewOnly, s.hostOs]);
  }

  destroy() {
    this.ac.abort();
    clearTimeout(this.hideTimer);
    clearTimeout(this.forceTimer);
    cancelAnimationFrame(this.layoutRaf);
    if (this.ro) this.ro.disconnect();
    this.closePopover();
    this.wrap.remove();
    this.handle.remove();
  }

  /* -------------------------------------------------------------------------------------- */
  /* DOM                                                                                     */
  /* -------------------------------------------------------------------------------------- */

  #shortcutLabel() {
    return this.o.localOs === 'macos' ? '⌃⌥⇧ (Ctrl+Option+Shift)' : 'Ctrl+Alt+Shift';
  }

  #btn(key, iconName, label, onClick, { badge = false, popover = false } = {}) {
    const b = h('button', {
      type: 'button', class: 'btn btn-ghost btn-icon tb-btn', title: label, 'aria-label': label,
      onMousedown: keepFocus, onClick,
    }, icon(iconName, { size: 16 }));
    if (popover) { b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); }
    if (badge) {
      const bd = h('span', { class: 'tb-badge', hidden: true, 'aria-hidden': 'true' });
      b.append(bd);
      this.badges[key] = bd;
    }
    this.btns[key] = b;
    return b;
  }

  #sep() {
    const s = h('span', { class: 'tb-sep', 'aria-hidden': 'true' });
    this.seps.push(s);
    return s;
  }

  #build(host) {
    const a = this.a;
    this.qualityDot = h('span', { class: 'dot' });
    this.hostOs = h('span', { class: 'tb-os' });
    this.hostName = h('span', { class: 'tb-host-name ellipsis' });
    this.host = h('div', { class: 'tb-host' }, this.qualityDot, this.hostOs, this.hostName);

    this.fileInput = h('input', { type: 'file', multiple: true, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
    this.fileInput.addEventListener('change', () => {
      const files = [...(this.fileInput.files || [])];
      this.fileInput.value = '';
      if (files.length) a.sendFiles(files);
    });

    const pop = (key, build) => {
      this.runs[key] = { popover: build };
      return (e) => this.#openPopover(e.currentTarget, build);
    };
    const act = (key, fn) => {
      this.runs[key] = { run: fn };
      return fn;
    };

    // Tools: may move into the "⋯" menu when space is short (OVERFLOW_ORDER).
    this.main = h('div', { class: 'tb-main' },
      this.host,
      this.#sep(),
      this.#btn('display', 'monitor', 'Choose remote display', pop('display', (el) => this.#buildDisplays(el)), { popover: true }),
      this.#btn('view', 'gauge', 'Picture quality and scaling', pop('view', (el) => this.#buildView(el)), { popover: true }),
      this.#sep(),
      this.#btn('viewOnly', 'mouse', 'View only', act('viewOnly', () => a.toggleViewOnly())),
      this.#btn('keys', 'keyboard', 'Special keys', pop('keys', (el) => this.#buildKeys(el)), { popover: true }),
      this.#btn('clipboard', 'clipboard', 'Clipboard sync', act('clipboard', () => a.toggleClipboard())),
      this.#sep(),
      this.#btn('send', 'upload', 'Send files', act('send', () => this.pickFiles())),
      this.#btn('transfers', 'download', 'File transfers', act('transfers', () => a.toggleTransfers()), { badge: true }),
      this.#btn('chat', 'chat', 'Chat', act('chat', () => a.toggleChat()), { badge: true }),
      this.#sep(),
      this.#btn('screenshot', 'camera', 'Save a screenshot of the remote screen', act('screenshot', () => a.screenshot())),
      this.#btn('stats', 'info', 'Connection statistics', act('stats', () => a.toggleStats())),
      this.#btn('audio', 'volume', 'Mute remote audio', act('audio', () => a.toggleMute())));

    this.moreBtn = this.#btn('more', 'more', 'More tools',
      (e) => this.#openPopover(e.currentTarget, (el) => this.#buildMore(el), () => this.#moreSig()), { badge: true, popover: true });
    this.moreBtn.hidden = true;

    // Always visible, never scrolled away.
    this.trail = h('div', { class: 'tb-trail' },
      this.#btn('fullscreen', 'fullscreen', 'Fullscreen', () => a.toggleFullscreen()),
      this.#btn('pin', 'unlock', 'Pin the toolbar', () => this.#togglePin()),
      h('button', {
        type: 'button', class: 'btn btn-danger btn-sm tb-disconnect', title: 'End the session', 'aria-label': 'Disconnect',
        onMousedown: keepFocus, onClick: () => a.disconnect(),
      }, icon('power', { size: 14 }), h('span', { class: 'tb-disc-label' }, 'Disconnect')));

    this.bar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Session toolbar' },
      this.main, this.moreBtn, this.trail, this.fileInput);

    this.wrap = h('div', { class: 'tb-wrap' }, this.bar);
    this.handle = h('button', {
      type: 'button', class: 'tb-handle', title: `Show toolbar (${this.#shortcutLabel()})`, 'aria-label': 'Show toolbar',
      onMousedown: keepFocus, onClick: () => this.reveal(),
    });
    host.append(this.handle, this.wrap);
  }

  #bind() {
    const opt = { signal: this.ac.signal };
    const enter = () => { this.hover = true; this.#sync(); };
    const leave = () => { this.hover = false; this.#sync(); };
    this.wrap.addEventListener('pointerenter', enter, opt);
    this.wrap.addEventListener('pointerleave', leave, opt);
    // Any toolbar interaction releases whatever is held on the remote (e.g. a modifier).
    this.wrap.addEventListener('pointerdown', () => this.a.releaseInput(), opt);

    window.addEventListener('pointermove', (e) => {
      // No reveal while dragging on the remote (e.g. a window title bar near the top edge).
      const inZone = e.clientY <= TOP_ZONE_PX && e.buttons === 0;
      if (inZone !== this.inZone) { this.inZone = inZone; this.#sync(); }
    }, { signal: this.ac.signal, passive: true, capture: true });
    document.addEventListener('mouseleave', () => { if (this.inZone) { this.inZone = false; this.#sync(); } }, opt);

    // Popover dismissal: outside press, window blur, resize.
    document.addEventListener('pointerdown', (e) => {
      if (!this.pop) return;
      if (this.pop.el.contains(e.target) || this.pop.anchor.contains(e.target)) return;
      this.closePopover();
    }, { signal: this.ac.signal, capture: true });
    window.addEventListener('blur', () => this.closePopover(), opt);
    window.addEventListener('resize', () => this.closePopover(), opt);

    // Re-measure when the window or the chip changes size, and once a drawer's slide has moved
    // the toolbar (its `left` transition) so the chip check sees the final position.
    if (typeof ResizeObserver === 'function') {
      this.ro = new ResizeObserver(() => this.#scheduleLayout());
      this.ro.observe(document.documentElement);
      if (this.o.avoid) this.ro.observe(this.o.avoid);
    } else {
      window.addEventListener('resize', () => this.#scheduleLayout(), opt);
    }
    this.wrap.addEventListener('transitionend', (e) => { if (e.target === this.wrap && e.propertyName === 'left') this.#scheduleLayout(); }, opt);
  }

  /* -------------------------------------------------------------------------------------- */
  /* overflow ("⋯") + chip placement                                                         */
  /* -------------------------------------------------------------------------------------- */

  #scheduleLayout() {
    if (!this.layoutRaf) this.layoutRaf = requestAnimationFrame(() => this.#layout());
  }

  /**
   * Show as many tools as fit in the toolbar's max-width (CSS: window minus an open drawer), move
   * the rest into "⋯", then keep the top-left chip clear of the toolbar.
   */
  #layout() {
    this.layoutRaf = 0;
    const wrap = this.wrap;
    const cap = parseFloat(getComputedStyle(wrap).maxWidth); // resolved px; NaN for 'none'
    for (const s of this.seps) s.classList.remove('tb-overflowed');
    for (const k of OVERFLOW_ORDER) this.btns[k].classList.remove('tb-overflowed');
    this.moreBtn.hidden = true;
    wrap.classList.add('tb-measuring'); // natural width, no cap
    const fits = () => !Number.isFinite(cap) || wrap.getBoundingClientRect().width <= cap + 0.5;
    const out = new Set();
    if (!fits()) {
      for (const s of this.seps) s.classList.add('tb-overflowed'); // cheapest space first
      if (!fits()) {
        this.moreBtn.hidden = false;
        for (const k of OVERFLOW_ORDER) {
          if (fits()) break;
          const b = this.btns[k];
          if (b.hidden) continue; // not applicable right now (e.g. a single display)
          b.classList.add('tb-overflowed');
          out.add(k);
        }
      }
    }
    wrap.classList.remove('tb-measuring');
    const before = this.overflowed.join();
    this.overflowed = Object.keys(MENU_LABELS).filter((k) => out.has(k)); // toolbar order
    if (!this.overflowed.length) this.moreBtn.hidden = true;
    this.#badge('more', this.#overflowBadge());
    if (this.pop) {
      // The anchor of an open menu just disappeared → close it; else refresh "⋯" if its content changed.
      if (this.pop.anchor.hidden || this.pop.anchor.classList.contains('tb-overflowed')) this.closePopover();
      else if (before !== this.overflowed.join()) this.#refreshPopover();
    }
    this.#placeChip();
  }

  /** Move the chip (o.avoid) below the toolbar when the toolbar's left edge would cover it. */
  #placeChip() {
    const chip = this.o.avoid;
    if (!chip) return;
    let crowded = false;
    if (!chip.hidden) {
      const chipRight = chip.getBoundingClientRect().right;
      const left = this.wrap.getBoundingClientRect().left; // translateX(-50%) included; hiding only moves it up
      crowded = left < chipRight + CHIP_GAP_PX || document.body.classList.contains('drawer-open');
    }
    document.body.classList.toggle('chip-below', crowded);
  }

  #overflowBadge() {
    let n = 0;
    for (const k of this.overflowed) {
      const bd = this.badges[k];
      if (bd && !bd.hidden) n += Number(this.s[k === 'chat' ? 'chatUnread' : 'transfersBadge']) || 0;
    }
    return n;
  }

  #moreSig() {
    return JSON.stringify(this.overflowed.map((k) => {
      const b = this.btns[k];
      return [k, b.title, b.disabled, b.classList.contains('active'), b.firstElementChild?.getAttribute('data-icon'),
        this.badges[k] ? this.badges[k].textContent : ''];
    }));
  }

  #buildMore(el) {
    for (const k of this.overflowed) {
      const b = this.btns[k];
      const run = this.runs[k] || {};
      const toggle = b.getAttribute('aria-pressed') !== null;
      const bd = this.badges[k];
      el.append(this.#item({
        iconName: b.firstElementChild?.getAttribute('data-icon') || 'more',
        label: MENU_LABELS[k],
        title: b.title,
        disabled: b.disabled,
        current: toggle && b.getAttribute('aria-pressed') === 'true',
        role: toggle ? 'menuitemcheckbox' : 'menuitem',
        extra: bd && !bd.hidden ? h('span', { class: 'badge badge-danger' }, bd.textContent) : null,
        onClick: () => {
          if (run.popover) {
            // Same menu, now anchored on "⋯" (the tool's own button is hidden).
            this.closePopover();
            this.#openPopover(this.moreBtn, run.popover);
          } else {
            this.closePopover();
            if (run.run) run.run();
          }
        },
      }));
    }
  }

  #toggle(btn, active, iconName) {
    btn.classList.toggle('active', !!active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    if (iconName && btn.firstElementChild?.getAttribute('data-icon') !== iconName) {
      btn.firstElementChild.replaceWith(icon(iconName, { size: 16 }));
    }
  }

  #label(btn, text) {
    btn.title = text;
    btn.setAttribute('aria-label', text);
  }

  #badge(key, n) {
    const bd = this.badges[key];
    if (!bd) return;
    const v = Number(n) || 0;
    bd.hidden = v <= 0;
    bd.textContent = v > 99 ? '99+' : String(v);
  }

  #togglePin() {
    this.pinned = !this.pinned;
    writePinned(this.pinned);
    this.update(this.s);
    this.#sync();
  }

  /* -------------------------------------------------------------------------------------- */
  /* visibility                                                                              */
  /* -------------------------------------------------------------------------------------- */

  #wanted() {
    return this.active && (this.pinned || this.hover || this.inZone || !!this.pop || this.forced);
  }

  #sync(immediate = false) {
    if (this.#wanted()) {
      clearTimeout(this.hideTimer);
      this.hideTimer = 0;
      this.#applyShown(true);
      return;
    }
    if (!this.active || immediate) {
      clearTimeout(this.hideTimer);
      this.hideTimer = 0;
      this.#applyShown(false);
      return;
    }
    if (this.shown && !this.hideTimer) {
      this.hideTimer = setTimeout(() => {
        this.hideTimer = 0;
        if (!this.#wanted()) this.#applyShown(false);
      }, HIDE_DELAY_MS);
    }
  }

  #applyShown(on) {
    this.shown = on;
    this.wrap.classList.toggle('hidden', !on);
    this.wrap.inert = !on; // hidden toolbar must not be clickable / focusable
    this.handle.hidden = on || !this.active;
  }

  /* -------------------------------------------------------------------------------------- */
  /* popovers                                                                                */
  /* -------------------------------------------------------------------------------------- */

  /** @param {() => string} [sigFn] data signature; the menu is rebuilt when it changes */
  #openPopover(anchor, build, sigFn = () => this.#popoverSig()) {
    if (this.pop && this.pop.anchor === anchor) { this.closePopover(); return; }
    this.closePopover();
    const el = h('div', { class: 'popover tb-pop', role: 'menu' });
    el.addEventListener('pointerenter', () => { this.hover = true; this.#sync(); });
    el.addEventListener('pointerleave', () => { this.hover = false; this.#sync(); });
    el.addEventListener('pointerdown', () => this.a.releaseInput());
    this.pop = { el, anchor, build, sigFn };
    anchor.classList.add('open');
    anchor.setAttribute('aria-expanded', 'true');
    document.body.append(el);
    this.#renderPopover();
    this.#sync();
  }

  #renderPopover() {
    const p = this.pop;
    if (!p) return;
    p.sig = p.sigFn();
    p.el.replaceChildren();
    p.build(p.el);
    // Position under the anchor, clamped to the window.
    const r = p.anchor.getBoundingClientRect();
    const w = p.el.offsetWidth;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2));
    p.el.style.left = `${Math.round(left)}px`;
    p.el.style.top = `${Math.round(r.bottom + 8)}px`;
    p.el.style.maxHeight = `${Math.max(120, window.innerHeight - r.bottom - 24)}px`;
  }

  #segmented(options, current, onPick, disabled = false) {
    return h('div', { class: 'segmented', role: 'radiogroup' }, options.map((opt) => h('button', {
      type: 'button', role: 'radio', title: opt.title, class: opt.id === current ? 'active' : null,
      'aria-checked': opt.id === current ? 'true' : 'false', disabled,
      onMousedown: keepFocus, onClick: () => onPick(opt.id),
    }, opt.label)));
  }

  #item({ iconName, label, hint, title = null, onClick, disabled = false, current = false, extra = null, role = 'menuitem' }) {
    return h('button', {
      type: 'button', class: `menu-item${current ? ' current' : ''}`, role, disabled, title,
      'aria-checked': role === 'menuitemradio' || role === 'menuitemcheckbox' ? (current ? 'true' : 'false') : null,
      onMousedown: keepFocus, onClick,
    },
    iconName ? icon(iconName, { size: 16 }) : null,
    h('span', { class: 'grow ellipsis' }, label),
    extra,
    hint ? h('span', { class: 'kbd' }, hint) : null);
  }

  #buildDisplays(el) {
    const s = this.s;
    el.append(h('div', { class: 'label pop-title' }, 'Remote displays'));
    for (const d of s.displays || []) {
      const current = d.id === s.currentDisplay;
      el.append(this.#item({
        iconName: current ? 'check' : 'monitor',
        label: d.name,
        current,
        role: 'menuitemradio',
        extra: h('span', { class: 'row gap-4' },
          d.primary ? h('span', { class: 'badge badge-accent' }, 'Main') : null,
          d.width && d.height ? h('span', { class: 'tiny faint' }, `${d.width}×${d.height}`) : null),
        onClick: () => { this.closePopover(); if (!current) this.a.selectDisplay(d.id); },
      }));
    }
  }

  #buildView(el) {
    const s = this.s;
    el.append(
      h('div', { class: 'label pop-title' }, 'Picture quality'),
      h('div', { class: 'pop-section' }, this.#segmented(PRESETS, s.preset, (id) => this.a.setPreset(id))),
      h('div', { class: 'label pop-title' }, 'Scaling'),
      h('div', { class: 'pop-section' }, this.#segmented(SCALES, s.scale, (id) => this.a.setScale(id))),
      h('p', { class: 'tiny faint pop-note' }, 'Quality applies to the stream the host sends; your choice is remembered.'));
  }

  #buildKeys(el) {
    const s = this.s;
    const disabled = !s.controlAvailable || s.viewOnly;
    const isMacHost = s.hostOs === 'macos';
    el.append(
      h('div', { class: 'label pop-title' }, 'Swap ⌘ Cmd / Ctrl'),
      h('div', { class: 'pop-section' }, this.#segmented(SWAPS, s.swapSetting, (id) => this.a.setSwap(id))),
      h('p', { class: 'tiny faint pop-note' }, s.swapEffective
        ? (this.o.localOs === 'macos' ? 'Swapped: your ⌘ key acts as Ctrl on the remote.' : 'Swapped: your Ctrl key acts as ⌘ on the remote.')
        : 'Not swapped: keys are sent as they are.'),
      h('div', { class: 'menu-sep' }),
      h('div', { class: 'label pop-title' }, `Send to the remote ${isMacHost ? 'Mac' : 'PC'}`));
    for (const k of specialKeysFor(s.hostOs)) {
      el.append(this.#item({
        label: k.label, hint: k.hint, disabled,
        onClick: () => { this.closePopover(); this.a.sendCombo(k.codes); },
      }));
    }
    if (!isMacHost) {
      el.append(h('p', { class: 'tiny faint pop-note' },
        'Ctrl+Alt+Del and Win+L can’t be sent: Windows only accepts them from a physical keyboard. Use Task Manager instead.'));
    }
    el.append(
      h('div', { class: 'menu-sep' }),
      this.#item({
        iconName: 'clipboard', label: 'Type clipboard text…', disabled,
        onClick: () => { this.closePopover(); this.a.openTypeText(); },
      }));
  }
}
