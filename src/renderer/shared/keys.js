/*
 * Tunnelview — DOM → wire helpers for keyboard and wheel input (docs/ARCHITECTURE.md §5, §10).
 *
 * Pure functions with no DOM access at import time, so they are unit-tested from plain Node
 * (test/viewer-keys.test.js). Codes are KeyboardEvent.code values; the host maps them to
 * scancodes / macOS virtual keycodes in src/main/input/keymap.js (physical-key semantics, so the
 * REMOTE keyboard layout decides which character a key produces — like AnyDesk's default mode).
 */

/* ------------------------------------------------------------------------------------------ */
/* Cmd/Ctrl swap                                                                               */
/* ------------------------------------------------------------------------------------------ */

/**
 * Whether the viewer should swap Command(Meta) ⇄ Control before sending key codes.
 *   'on'  → always swap, 'off' → never,
 *   'auto' (and any unknown value) → swap iff exactly one side is macOS, so a Mac user keeps
 *   pressing ⌘C to copy on Windows and a Windows user keeps pressing Ctrl+C on a Mac.
 */
export function shouldSwapCmdCtrl(setting, localOs, remoteOs) {
  if (setting === 'on') return true;
  if (setting === 'off') return false;
  return (localOs === 'macos') !== (remoteOs === 'macos');
}

// Older Chromium / Firefox spellings of the Windows/Command keys.
const LEGACY_CODES = Object.freeze({ OSLeft: 'MetaLeft', OSRight: 'MetaRight' });
const SWAPPED = Object.freeze({
  MetaLeft: 'ControlLeft',
  ControlLeft: 'MetaLeft',
  MetaRight: 'ControlRight',
  ControlRight: 'MetaRight',
});

/** KeyboardEvent.code → wire code (legacy names normalized; Meta⇄Control when `swap`). */
export function mapCode(code, swap) {
  if (typeof code !== 'string') return '';
  const c = Object.prototype.hasOwnProperty.call(LEGACY_CODES, code) ? LEGACY_CODES[code] : code;
  if (swap && Object.prototype.hasOwnProperty.call(SWAPPED, c)) return SWAPPED[c];
  return c;
}

const MODIFIER_CODES = new Set([
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight', 'CapsLock', 'Fn',
]);

/** True for modifier keys (incl. CapsLock / Fn). */
export function isModifierCode(code) {
  return MODIFIER_CODES.has(code);
}

/* ------------------------------------------------------------------------------------------ */
/* Wheel                                                                                       */
/* ------------------------------------------------------------------------------------------ */

export const DOM_DELTA_PIXEL = 0;
export const DOM_DELTA_LINE = 1;
export const DOM_DELTA_PAGE = 2;
export const LINE_PX = 40; // §5: LINE ×40
export const PAGE_PX = 800; // §5: PAGE ×800
const MAX_WHEEL_PX = 10000; // per event; guards against absurd synthetic deltas

function clampDelta(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-MAX_WHEEL_PX, Math.min(MAX_WHEEL_PX, n));
}

/**
 * WheelEvent → deltas in CSS pixels (positive dy = scroll down, positive dx = scroll right).
 * Mouse wheels on Windows usually report PIXEL mode already (±100 per notch); Firefox-style
 * LINE/PAGE modes are converted with the §5 factors.
 */
export function wheelPixels(evt) {
  const mode = evt ? evt.deltaMode : DOM_DELTA_PIXEL;
  const f = mode === DOM_DELTA_LINE ? LINE_PX : mode === DOM_DELTA_PAGE ? PAGE_PX : 1;
  return { dx: clampDelta((evt && evt.deltaX) * f), dy: clampDelta((evt && evt.deltaY) * f) };
}

/* ------------------------------------------------------------------------------------------ */
/* Text                                                                                        */
/* ------------------------------------------------------------------------------------------ */

/**
 * Split text into chunks whose UTF-16 `.length` is ≤ max (the host validates `text.length`),
 * never splitting a surrogate pair. Used for `txt` messages (≤ PROTOCOL.INPUT.MAX_TEXT).
 */
export function chunkText(text, max) {
  const limit = Math.max(2, Math.floor(Number(max) || 0));
  const out = [];
  let cur = '';
  for (const ch of String(text ?? '')) { // iterates code points
    if (cur.length + ch.length > limit) { out.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Special key combinations (toolbar "keyboard" menu → `combo`)                                 */
/* ------------------------------------------------------------------------------------------ */

/*
 * Codes are in the HOST's terms and are sent WITHOUT the Cmd/Ctrl swap: 'MetaLeft' is the
 * Windows key on a Windows host and ⌘ Command on a Mac host.
 *
 * Deliberately NOT included:
 *   - Ctrl+Alt+Del: it is the Windows Secure Attention Sequence. Windows only honours it from the
 *     real keyboard driver (or SendSAS() from a SYSTEM service with a policy change); injected
 *     SendInput events are ignored by Winlogon, so offering it would be a button that silently does
 *     nothing (ARCHITECTURE §11). Ctrl+Shift+Esc (Task Manager) covers the common use.
 *   - Win+L: the lock hotkey is also handled by Winlogon and is ignored for injected input on
 *     current Windows versions, so it is omitted for the same reason.
 */
export const SPECIAL_KEYS = Object.freeze([
  // ---- Windows hosts ----
  { id: 'win', label: 'Windows key', hint: 'Win', codes: ['MetaLeft'], hosts: ['windows'] },
  { id: 'win-r', label: 'Run…', hint: 'Win+R', codes: ['MetaLeft', 'KeyR'], hosts: ['windows'] },
  { id: 'win-d', label: 'Show desktop', hint: 'Win+D', codes: ['MetaLeft', 'KeyD'], hosts: ['windows'] },
  { id: 'win-e', label: 'File Explorer', hint: 'Win+E', codes: ['MetaLeft', 'KeyE'], hosts: ['windows'] },
  { id: 'alt-tab', label: 'Switch window', hint: 'Alt+Tab', codes: ['AltLeft', 'Tab'], hosts: ['windows'] },
  { id: 'alt-f4', label: 'Close window', hint: 'Alt+F4', codes: ['AltLeft', 'F4'], hosts: ['windows'] },
  { id: 'ctrl-shift-esc', label: 'Task Manager', hint: 'Ctrl+Shift+Esc', codes: ['ControlLeft', 'ShiftLeft', 'Escape'], hosts: ['windows'] },
  { id: 'win-shift-s', label: 'Snip screen', hint: 'Win+Shift+S', codes: ['MetaLeft', 'ShiftLeft', 'KeyS'], hosts: ['windows'] },
  { id: 'printscreen', label: 'Print Screen', hint: 'PrtSc', codes: ['PrintScreen'], hosts: ['windows'] },

  // ---- macOS hosts ----
  { id: 'cmd-space', label: 'Spotlight', hint: '⌘ Space', codes: ['MetaLeft', 'Space'], hosts: ['macos'] },
  { id: 'cmd-tab', label: 'Switch app', hint: '⌘ Tab', codes: ['MetaLeft', 'Tab'], hosts: ['macos'] },
  { id: 'ctrl-up', label: 'Mission Control', hint: '⌃ ↑', codes: ['ControlLeft', 'ArrowUp'], hosts: ['macos'] },
  { id: 'cmd-q', label: 'Quit app', hint: '⌘ Q', codes: ['MetaLeft', 'KeyQ'], hosts: ['macos'] },
  { id: 'cmd-opt-esc', label: 'Force Quit…', hint: '⌘ ⌥ Esc', codes: ['MetaLeft', 'AltLeft', 'Escape'], hosts: ['macos'] },
  { id: 'cmd-shift-3', label: 'Screenshot (screen)', hint: '⌘ ⇧ 3', codes: ['MetaLeft', 'ShiftLeft', 'Digit3'], hosts: ['macos'] },
  { id: 'cmd-shift-4', label: 'Screenshot (selection)', hint: '⌘ ⇧ 4', codes: ['MetaLeft', 'ShiftLeft', 'Digit4'], hosts: ['macos'] },
  { id: 'cmd-ctrl-q', label: 'Lock screen', hint: '⌃ ⌘ Q', codes: ['ControlLeft', 'MetaLeft', 'KeyQ'], hosts: ['macos'] },
].map((k) => Object.freeze({ ...k, codes: Object.freeze(k.codes), hosts: Object.freeze(k.hosts) })));

/** SPECIAL_KEYS applicable to a host OS ('windows'|'macos'); unknown OS → Windows set. */
export function specialKeysFor(hostOs) {
  const os = hostOs === 'macos' ? 'macos' : 'windows';
  return SPECIAL_KEYS.filter((k) => k.hosts.includes(os));
}
