/*
 * Tunnelview — shared renderer UI helpers (docs/ARCHITECTURE.md §10). Used by EVERY window
 * (main, viewer, panel, prompt), so the exported API below is a contract — keep it stable.
 *
 * Security: nothing in this module ever uses innerHTML / insertAdjacentHTML. Strings become
 * text nodes or attribute values only, so tailnet-provided names (hostnames, user names, chat
 * text, file names…) can never inject markup. `on*` attributes are only accepted as functions
 * (addEventListener) and never written as inline-handler attributes.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

/* ------------------------------------------------------------------------------------------ */
/* DOM                                                                                         */
/* ------------------------------------------------------------------------------------------ */

/**
 * Create an element.
 *   attrs: class|className (string or array), style (object|string), dataset (object),
 *          on<Event> functions (onClick → addEventListener('click')),
 *          boolean true → setAttribute(k, ''), false/null/undefined → skipped, else setAttribute(k, String(v)).
 *   children: string|number (→ text node, never parsed as HTML) | Node | array (flattened) | null/false (skipped)
 */
export function h(tag, attrs = null, ...children) {
  const el = document.createElement(tag);
  if (attrs && typeof attrs === 'object') applyAttrs(el, attrs);
  appendChildren(el, children);
  return el;
}

function applyAttrs(el, attrs) {
  for (const key of Object.keys(attrs)) {
    const v = attrs[key];
    if (v === false || v === null || v === undefined) continue;

    if (key === 'class' || key === 'className') {
      const cls = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
      if (cls) el.className = cls;
      continue;
    }
    if (key === 'style') {
      if (typeof v === 'string') el.setAttribute('style', v);
      else if (typeof v === 'object') setStyles(el, v);
      continue;
    }
    if (key === 'dataset') {
      if (typeof v === 'object') {
        for (const [dk, dv] of Object.entries(v)) {
          if (dv !== null && dv !== undefined && dv !== false) el.dataset[dk] = String(dv);
        }
      }
      continue;
    }
    if (/^on[a-zA-Z]/.test(key)) {
      // Only real functions; a string here would be an inline handler (blocked by CSP anyway).
      if (typeof v === 'function') el.addEventListener(key.slice(2).toLowerCase(), v);
      continue;
    }
    const name = key === 'htmlFor' ? 'for' : key;
    if (v === true) el.setAttribute(name, '');
    else el.setAttribute(name, String(v));
  }
}

function setStyles(el, styles) {
  for (const [k, v] of Object.entries(styles)) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('--') || k.includes('-')) el.style.setProperty(k, String(v));
    else el.style[k] = typeof v === 'number' && !UNITLESS.has(k) ? `${v}px` : String(v);
  }
}
const UNITLESS = new Set(['opacity', 'zIndex', 'flex', 'flexGrow', 'flexShrink', 'fontWeight', 'lineHeight', 'order', 'zoom']);

function appendChildren(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false || c === true) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/* ------------------------------------------------------------------------------------------ */
/* Text safety                                                                                 */
/* ------------------------------------------------------------------------------------------ */

// C0/C1 controls, zero-width spaces, LRM/RLM/ALM, bidi embeddings/overrides/isolates and BOM.
// Bidi overrides in a peer-chosen hostname could visually spoof another name ("evil‮moc.knab").
// ZWJ (U+200D) is kept so emoji sequences in display names survive.
// eslint-disable-next-line no-control-regex
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f​‌‎‏؜‪-‮⁦-⁩﻿]/g;

/**
 * Extra helper (not in §10): make an untrusted value safe & bounded for display as TEXT.
 * Strips control / bidi-override characters and caps the length (code-point aware, adds "…").
 */
export function safeText(value, maxLen = 200) {
  if (value === null || value === undefined) return '';
  let s = String(value).replace(UNSAFE_TEXT_RE, '').trim();
  if (s.length > maxLen) {
    const cps = Array.from(s);
    if (cps.length > maxLen) s = cps.slice(0, Math.max(1, maxLen - 1)).join('') + '…';
  }
  return s;
}

/* ------------------------------------------------------------------------------------------ */
/* Toasts                                                                                      */
/* ------------------------------------------------------------------------------------------ */

const TOAST_KINDS = new Set(['info', 'ok', 'warn', 'danger']);
const MAX_TOASTS = 4;
let toastHost = null;

function ensureToastHost() {
  if (toastHost && toastHost.isConnected) return toastHost;
  toastHost = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
  (document.body || document.documentElement).appendChild(toastHost);
  return toastHost;
}

/**
 * Show a toast. kind: info|ok|warn|danger. timeout ≤ 0 → stays until clicked.
 * `message` is text (or a Node built with h()). Returns a dismiss() function.
 */
export function toast(message, { kind = 'info', timeout = 3500 } = {}) {
  const host = ensureToastHost();
  const k = TOAST_KINDS.has(kind) ? kind : 'info';
  const el = h('div', { class: k === 'info' ? 'toast' : `toast ${k}`, role: k === 'danger' ? 'alert' : null }, message);

  let timer = null;
  let gone = false;
  const dismiss = () => {
    if (gone) return;
    gone = true;
    clearTimeout(timer);
    el.classList.add('leaving');
    const remove = () => el.remove();
    el.addEventListener('animationend', remove, { once: true });
    setTimeout(remove, 400); // fallback when animations are disabled
  };
  const arm = (ms) => {
    clearTimeout(timer);
    if (ms > 0) timer = setTimeout(dismiss, ms);
  };

  el.addEventListener('click', dismiss);
  el.addEventListener('mouseenter', () => clearTimeout(timer)); // pause while hovered
  el.addEventListener('mouseleave', () => { if (!gone && timeout > 0) arm(1500); });

  host.appendChild(el);
  // Cap the stack: drop the oldest toasts that are not already leaving.
  const live = [...host.children].filter((c) => !c.classList.contains('leaving'));
  for (let i = 0; i < live.length - MAX_TOASTS; i++) live[i].remove();

  arm(Number(timeout) || 0);
  return dismiss;
}

/* ------------------------------------------------------------------------------------------ */
/* Icons — hand-drawn set on a 24×24 grid, stroke = currentColor, width 1.8, round caps/joins  */
/* ------------------------------------------------------------------------------------------ */

const P = (d) => ['path', { d }];
const C = (cx, cy, r) => ['circle', { cx, cy, r }];
const R = (x, y, width, height, rx) => ['rect', { x, y, width, height, rx }];
const DOT = (cx, cy, r = 1.3) => ['circle', { cx, cy, r, fill: 'currentColor', stroke: 'none' }];
const FILLED = (d) => ['path', { d, fill: 'currentColor' }];

const fx = (n) => +n.toFixed(2);

/** 8-tooth gear outline, generated so the teeth are perfectly regular. */
function gearPath(cx = 12, cy = 12, ro = 9.6, ri = 7.2, teeth = 8) {
  const step = (Math.PI * 2) / teeth;
  const ho = step * 0.2; // half tooth width at the tip
  const hi = step * 0.31; // half tooth width at the root
  const pt = (r, a) => `${fx(cx + r * Math.cos(a))} ${fx(cy + r * Math.sin(a))}`;
  let d = '';
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2;
    d += `${i === 0 ? 'M' : 'L'}${pt(ri, a - hi)}L${pt(ro, a - ho)}L${pt(ro, a + ho)}L${pt(ri, a + hi)}`;
    d += `A${ri} ${ri} 0 0 1 ${pt(ri, a + step - hi)}`;
  }
  return `${d}Z`;
}

/** Five-pointed star, optically centred a little low. */
function starPath(cx = 12, cy = 12.7, ro = 9.3, ri = 4.1) {
  let d = '';
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? ri : ro;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    d += `${i ? 'L' : 'M'}${fx(cx + r * Math.cos(a))} ${fx(cy + r * Math.sin(a))}`;
  }
  return `${d}Z`;
}

const GEAR = gearPath();
const STAR = starPath();
const SHIELD = 'M12 3l7.5 3v5.5c0 4.6-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.9-7.5-9.5V6z';
const TRAY = 'M4.5 15v3.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V15';
const SPEAKER = 'M4 9.5h3.5L12 5.5v13l-4.5-4H4z';
const APPLE_BODY =
  'M12 8.2C10.9 7.3 9.7 7 8.6 7.1 6 7.3 4.5 9.6 4.6 12.6c.1 3.9 2.4 8 4.6 8.2 1 .1 1.7-.5 2.8-.5s1.8.6 2.8.5' +
  'c1.7-.2 3.5-2.5 4.5-5.2-1.5-.6-2.7-2-2.7-3.7 0-1.4.8-2.5 1.8-3.1-.9-1.2-2.1-1.7-3.2-1.7S12.9 7.6 12 8.2z';
const APPLE_LEAF = 'M12.2 6.6c-.1-1.6 1.1-3.2 3-3.4.1 1.7-1.1 3.2-3 3.4z';
const TUX_BODY =
  'M12 3.2c-2.1 0-3.2 1.7-3.2 3.8v1.6c0 1.2-.6 2.1-1.4 3.1-1.1 1.4-2 2.9-1.8 4.9.2 2.3 2.8 4 6.4 4s6.2-1.7 6.4-4' +
  'c.2-2-.7-3.5-1.8-4.9-.8-1-1.4-1.9-1.4-3.1V7c0-2.1-1.1-3.8-3.2-3.8z';

// Null-prototype map so names like "constructor" or "__proto__" fall back safely.
const ICONS = Object.assign(Object.create(null), {
  // ---- §10 contract names ----
  monitor: [R(3, 4, 18, 12.5, 2), P('M8.5 20.5h7'), P('M12 16.5v4')],
  windows: [R(4, 4, 7, 7, 1.2), R(13, 4, 7, 7, 1.2), R(4, 13, 7, 7, 1.2), R(13, 13, 7, 7, 1.2)],
  apple: [P(APPLE_BODY), P(APPLE_LEAF)],
  linux: [P(TUX_BODY), P('M9.7 16.4c.4 1.3 1.2 2 2.3 2s1.9-.7 2.3-2'), P('M10.9 9.4l1.1.8 1.1-.8'), DOT(10.6, 7.2, 0.9), DOT(13.4, 7.2, 0.9)],
  phone: [R(6.5, 2.5, 11, 19, 2.5), P('M11 18.5h2')],
  server: [R(3.5, 4, 17, 7, 1.8), R(3.5, 13, 17, 7, 1.8), P('M7.5 7.5h.01'), P('M7.5 16.5h.01'), P('M11.5 7.5h5'), P('M11.5 16.5h5')],
  plug: [P('M9 2.5V7'), P('M15 2.5V7'), P('M6 7h12v3.5a6 6 0 0 1-12 0z'), P('M12 16.5v5')],
  power: [P('M12 3v8.5'), P('M6.3 6.8a8 8 0 1 0 11.4 0')],
  copy: [R(8.5, 8.5, 12, 12, 2), P('M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5')],
  check: [P('M5 12.5l4.5 4.5L19 7.5')],
  x: [P('M6.5 6.5l11 11'), P('M17.5 6.5l-11 11')],
  lock: [R(5, 10.5, 14, 10.5, 2.2), P('M8 10.5v-3a4 4 0 0 1 8 0v3'), P('M12 14.5V17')],
  unlock: [R(5, 10.5, 14, 10.5, 2.2), P('M8 10.5v-3a4 4 0 0 1 7.7-1.6'), P('M12 14.5V17')],
  keyboard: [R(2.5, 6, 19, 12, 2.2), P('M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01'), P('M8.5 14h7')],
  mouse: [R(6.5, 3, 11, 18, 5.5), P('M12 7v3.5')],
  clipboard: [P('M9 4.5H7.5a2 2 0 0 0-2 2V19a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V6.5a2 2 0 0 0-2-2H15'), R(9, 3, 6, 3.5, 1.2), P('M9 12h6M9 15.5h4')],
  file: [P('M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5z'), P('M13.5 3v5.5H19')],
  folder: [P('M3.5 7a2 2 0 0 1 2-2h3.8l2.2 2.5h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z')],
  chat: [P('M5.5 4.5h13a2 2 0 0 1 2 2V15a2 2 0 0 1-2 2H11l-4.5 3.5V17h-1a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z'), P('M8 9.5h8M8 12.5h5')],
  settings: [P(GEAR), C(12, 12, 3)],
  refresh: [P('M19.5 10A8 8 0 0 0 5.4 7.5'), P('M4.5 4v4h4'), P('M4.5 14a8 8 0 0 0 14.1 2.5'), P('M19.5 20v-4h-4')],
  star: [P(STAR)],
  'star-fill': [FILLED(STAR)],
  fullscreen: [P('M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9'), P('M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9'), P('M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15'), P('M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15')],
  'fullscreen-exit': [P('M9 4v3.5A1.5 1.5 0 0 1 7.5 9H4'), P('M15 4v3.5A1.5 1.5 0 0 0 16.5 9H20'), P('M20 15h-3.5a1.5 1.5 0 0 0-1.5 1.5V20'), P('M4 15h3.5A1.5 1.5 0 0 1 9 16.5V20')],
  camera: [P('M4 8.5a2 2 0 0 1 2-2h2.2L9.8 4h4.4l1.6 2.5H18a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z'), C(12, 13, 3.5)],
  gauge: [P('M6 19a8.5 8.5 0 1 1 12 0'), P('M12 13l3.5-3.5'), C(12, 13, 1.3)],
  eye: [P('M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z'), C(12, 12, 3)],
  'eye-off': [P('M3.5 3.5l17 17'), P('M10.4 5.6A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16.7 16.7 0 0 1-2.6 3.4'), P('M6.6 6.6C4 8.4 2.5 12 2.5 12s3.5 6.5 9.5 6.5c1.9 0 3.6-.6 5-1.5'), P('M9.9 9.9a3 3 0 0 0 4.2 4.2')],
  send: [P('M20.5 3.5l-10 10'), P('M20.5 3.5L14 20.5l-3.5-7-7-3.5z')],
  'chevron-down': [P('M6 9.5l6 6 6-6')],
  more: [DOT(5.5, 12, 1.5), DOT(12, 12, 1.5), DOT(18.5, 12, 1.5)],
  user: [C(12, 8, 4), P('M4.5 20.5c.8-3.8 3.8-6 7.5-6s6.7 2.2 7.5 6')],
  shield: [P(SHIELD)],
  volume: [P(SPEAKER), P('M15.5 9a4.2 4.2 0 0 1 0 6'), P('M18.2 6.3a8 8 0 0 1 0 11.4')],
  'volume-off': [P(SPEAKER), P('M16 9.5l5 5'), P('M21 9.5l-5 5')],
  upload: [P('M12 15V4.5'), P('M7.5 9L12 4.5 16.5 9'), P(TRAY)],
  download: [P('M12 4.5V15'), P('M7.5 10.5L12 15l4.5-4.5'), P(TRAY)],
  info: [C(12, 12, 9), P('M12 11v5.5'), P('M12 7.8h.01')],
  alert: [P('M10.3 4.4L2.9 17.3a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.4a2 2 0 0 0-3.4 0z'), P('M12 9.5V14'), P('M12 17.2h.01')],
  search: [C(10.5, 10.5, 6.5), P('M15.5 15.5l5 5')],
  link: [P('M10 14a4.2 4.2 0 0 0 6 0l3-3a4.2 4.2 0 0 0-6-6l-1 1'), P('M14 10a4.2 4.2 0 0 0-6 0l-3 3a4.2 4.2 0 0 0 6 6l1-1')],
  minimize: [P('M5 12h14')],
  maximize: [R(5, 5, 14, 14, 1.8)],
  grip: [DOT(9, 6), DOT(15, 6), DOT(9, 12), DOT(15, 12), DOT(9, 18), DOT(15, 18)],

  // ---- extras (same style; not part of the §10 contract list, safe to use) ----
  logo: [R(3, 4, 18, 13, 2.5), P('M9 21h6'), P('M12 17v4'), FILLED('M9.8 7.8l6 2.6-2.5.9-1 2.5z')],
  android: [P('M4.5 18a7.5 7.5 0 0 1 15 0z'), P('M8.3 11.6L6.5 8.5'), P('M15.7 11.6l1.8-3.1'), DOT(9.3, 14.8, 1), DOT(14.7, 14.8, 1)],
  'shield-check': [P(SHIELD), P('M9 12.2l2.1 2.1 4-4.1')],
  'check-circle': [C(12, 12, 9), P('M8 12.3l2.8 2.7L16 9.6')],
  plus: [P('M12 5v14'), P('M5 12h14')],
  trash: [P('M4.5 7h15'), P('M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2'), P('M6.5 7l.8 12.1a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7'), P('M10 11v6M14 11v6')],
  edit: [P('M4 20l1-4.5L15.8 4.7a1.8 1.8 0 0 1 2.5 0l1 1a1.8 1.8 0 0 1 0 2.5L8.5 19z'), P('M14 6.5l3.5 3.5')],
  'arrow-right': [P('M5 12h14'), P('M13 6l6 6-6 6')],
  external: [P('M14 4h6v6'), P('M20 4l-8.5 8.5'), P('M18 14v4.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10')],
  'chevron-right': [P('M9.5 6l6 6-6 6')],
  'chevron-left': [P('M14.5 6l-6 6 6 6')],
  'chevron-up': [P('M6 14.5l6-6 6 6')],
  clock: [C(12, 12, 9), P('M12 7.5V12l3 2')],
  history: [P('M3.5 12a8.5 8.5 0 1 0 2.6-6.1'), P('M3.5 4v4.5H8'), P('M12 7.5V12l3 2')],
  users: [C(9, 8.5, 3.5), P('M2.5 19.5c.6-3.3 3.2-5 6.5-5s5.9 1.7 6.5 5'), P('M15.5 5.2a3.5 3.5 0 0 1 0 6.6'), P('M18 14.8c1.9.6 3.2 2.2 3.5 4.7')],
  key: [C(8, 15.5, 4), P('M10.9 12.6L19.5 4'), P('M16.5 7L19 9.5'), P('M14.2 9.3l2 2')],
  globe: [C(12, 12, 9), P('M3 12h18'), P('M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z')],
  network: [R(9, 3, 6, 5, 1.2), R(3, 16, 6, 5, 1.2), R(15, 16, 6, 5, 1.2), P('M12 8v4'), P('M6 16v-2a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v2')],
  sun: [C(12, 12, 4), P('M12 2.5v2M12 19.5v2M4.6 4.6L6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4L6 18M18 6l1.4-1.4')],
  moon: [P('M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1z')],
  zap: [P('M13 2.5L4.5 13.5h7l-1 8 8.5-11h-7z')],
});

const FALLBACK_ICON = [C(12, 12, 8.5)];

/**
 * Inline SVG icon. Unknown names render a generic circle (never throws).
 * @returns {SVGSVGElement}
 */
export function icon(name, { size = 16, className = '' } = {}) {
  const def = (typeof name === 'string' && ICONS[name]) || FALLBACK_ICON;
  const px = Number(size) > 0 ? Number(size) : 16;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(px));
  svg.setAttribute('height', String(px));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('class', `icon${className ? ` ${className}` : ''}`);
  if (typeof name === 'string') svg.setAttribute('data-icon', name.slice(0, 40));
  for (const [tag, attrs] of def) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    svg.appendChild(el);
  }
  return svg;
}

const OS_ICON = Object.assign(Object.create(null), {
  windows: 'windows', win32: 'windows', win: 'windows',
  macos: 'apple', darwin: 'apple', mac: 'apple',
  linux: 'linux',
  ios: 'phone', ipados: 'phone',
  android: 'android',
  other: 'monitor',
});

/** Icon for an OS string (windows|macos|linux|ios|android|other). Optional opts as icon(). */
export function osIcon(os, opts = {}) {
  const key = typeof os === 'string' ? os.toLowerCase() : '';
  return icon(OS_ICON[key] || 'monitor', opts);
}

/* ------------------------------------------------------------------------------------------ */
/* Formatting                                                                                  */
/* ------------------------------------------------------------------------------------------ */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** 1234567 → '1.2 MB' (binary multiples, labelled KB/MB/GB like Explorer/Finder users expect). */
export function formatBytes(n) {
  let v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++; }
  if (i === 0) return `${Math.round(v)} B`;
  let s = v < 100 ? v.toFixed(1) : String(Math.round(v));
  if (Number(s) >= 1024 && i < BYTE_UNITS.length - 1) { v /= 1024; i++; s = v.toFixed(1); }
  return `${s.replace(/\.0$/, '')} ${BYTE_UNITS[i]}`;
}

/** ms → '1:05:09' (with hours) | '05:09'. Negative/invalid → '00:00'. */
export function formatDuration(ms) {
  let total = Math.floor(Number(ms) / 1000);
  if (!Number.isFinite(total) || total < 0) total = 0;
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  const p2 = (x) => String(x).padStart(2, '0');
  return hh > 0 ? `${hh}:${p2(mm)}:${p2(ss)}` : `${p2(mm)}:${p2(ss)}`;
}

function toEpochMs(tsOrIso) {
  if (tsOrIso instanceof Date) return tsOrIso.getTime();
  let t = NaN;
  if (typeof tsOrIso === 'number') t = tsOrIso;
  else if (typeof tsOrIso === 'string' && tsOrIso.trim()) {
    const s = tsOrIso.trim();
    t = /^\d+(\.\d+)?$/.test(s) ? Number(s) : Date.parse(s);
  }
  if (!Number.isFinite(t)) return NaN;
  if (t > 0 && t < 1e11) t *= 1000; // looks like epoch seconds
  return t;
}

/**
 * 'just now' | '5 min ago' | '3 hours ago' | 'yesterday' | '4 days ago' | '2 weeks ago' | …
 * Invalid / zero time (Go's "0001-01-01T00:00:00Z" means "never") → ''.
 */
export function timeAgo(tsOrIso) {
  const t = toEpochMs(tsOrIso);
  if (!Number.isFinite(t) || t <= 0) return '';
  const diff = Date.now() - t;
  const min = 60e3, hour = 60 * min, day = 24 * hour;
  if (diff < 45e3) return 'just now'; // also covers small clock skew into the future
  if (diff < 90e3) return '1 min ago';
  if (diff < hour) return `${Math.round(diff / min)} min ago`;
  if (diff < 1.5 * hour) return '1 hour ago';
  if (diff < day) return `${Math.round(diff / hour)} hours ago`;
  if (diff < 2 * day) return 'yesterday';
  if (diff < 7 * day) return `${Math.floor(diff / day)} days ago`;
  if (diff < 30 * day) { const w = Math.floor(diff / (7 * day)); return w === 1 ? '1 week ago' : `${w} weeks ago`; }
  if (diff < 365 * day) { const m = Math.max(1, Math.floor(diff / (30 * day))); return m === 1 ? '1 month ago' : `${m} months ago`; }
  const y = Math.floor(diff / (365 * day));
  return y === 1 ? '1 year ago' : `${y} years ago`;
}

/** 'system' (or anything unknown) removes data-theme so prefers-color-scheme applies; else sets it on <html>. */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark' || theme === 'light') root.setAttribute('data-theme', theme);
  else root.removeAttribute('data-theme');
}

/** 'Nong Boonmee' → 'NB', 'alice@example.com' → 'A', '' → '?'. */
export function initials(name) {
  let s = typeof name === 'string' ? safeText(name, 120) : '';
  if (s.includes('@')) s = s.split('@')[0];
  const parts = s.split(/[\s._\-+]+/u).filter((p) => /[\p{L}\p{N}]/u.test(p));
  if (!parts.length) return '?';
  const firstChar = (p) => (p.match(/[\p{L}\p{N}]/u) || [''])[0];
  const a = firstChar(parts[0]);
  const b = parts.length > 1 ? firstChar(parts[parts.length - 1]) : '';
  return (a + b).toLocaleUpperCase() || '?';
}
