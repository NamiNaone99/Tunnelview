'use strict';
/*
 * KeyboardEvent.code → native key identifiers (ARCHITECTURE §5 `kd`/`ku`/`combo`, §7 input/keymap.js).
 *
 * Every entry is { win, mac }:
 *   win: { sc, ext? }        → inject by PS/2 set-1 scancode (SendInput + KEYEVENTF_SCANCODE).
 *                              ext:true = the key is E0-prefixed (KEYEVENTF_EXTENDEDKEY).
 *        { vk, sc?, ext? }   → inject by virtual-key code. Used where scancode injection is
 *                              unreliable (see below). `sc` (if given) only fills wScan so the
 *                              target's lParam looks like real hardware; otherwise the backend asks
 *                              MapVirtualKeyW.
 *        null                → no Windows equivalent.
 *   mac: kVK_* virtual keycode from <HIToolbox/Events.h>, or null (no macOS equivalent). These are
 *        ANSI-keyboard positions; macKeyFor(code, isIso) swaps Backquote/IntlBackslash for ISO hosts.
 *
 * Windows scancodes follow Chromium's ui/events/keycodes/dom/dom_code_data.inc (the inverse of what
 * Chromium reports as `code` on a Windows viewer), so viewer→host round-trips are lossless.
 *
 * Why some Windows keys use VK codes instead of scancodes:
 *   - Pause: hardware sends the 6-byte sequence E1 1D 45 E1 9D C5. A single injected scancode 0x45
 *     is translated by the keyboard layout to VK_NUMLOCK (verified with MapVirtualKeyW
 *     MAPVK_VSC_TO_VK_EX), so Pause must be injected as VK_PAUSE.
 *   - NumLock: shares scancode 0x45 with Pause; E0 45 maps to no VK at all. Inject VK_NUMLOCK with
 *     KEYEVENTF_EXTENDEDKEY (as in the keybd_event documentation sample).
 *   - PrintScreen: hardware sends E0 2A E0 37 and win32k special-cases the key (the screenshot / Snipping
 *     Tool hotkey is driven by VK_SNAPSHOT), so inject VK_SNAPSHOT.
 *   - Media / volume / browser / launch keys: these are E0-prefixed "consumer" keys that only some
 *     keyboard layouts list in their E0 scancode table; the shell's WM_APPCOMMAND handling is driven
 *     by the VK, so VK injection works with every layout.
 *   - Help: no standard set-1 scancode exists; VK_HELP is used.
 *
 * macOS has no Insert/PrintScreen/ScrollLock/Pause/NumLock keys; they map to the keys that occupy the
 * same physical position on an Apple extended keyboard (Help, F13, F14, F15, Keypad Clear) — the same
 * convention Chromium uses. Those are the intentional duplicate mac keycodes (see ALIASES).
 */

// --- descriptor helpers ------------------------------------------------------------------------
const sc = (n) => Object.freeze({ sc: n }); // plain scancode
const sce = (n) => Object.freeze({ sc: n, ext: true }); // E0-prefixed scancode
const vk = (n, scan, ext) => Object.freeze(Object.assign({ vk: n }, scan != null ? { sc: scan } : null, ext ? { ext: true } : null));

// Windows virtual-key codes used below (WinUser.h)
const VK = Object.freeze({
  PAUSE: 0x13, SNAPSHOT: 0x2C, HELP: 0x2F, NUMLOCK: 0x90,
  BROWSER_BACK: 0xA6, BROWSER_FORWARD: 0xA7, BROWSER_REFRESH: 0xA8, BROWSER_STOP: 0xA9,
  BROWSER_SEARCH: 0xAA, BROWSER_FAVORITES: 0xAB, BROWSER_HOME: 0xAC,
  VOLUME_MUTE: 0xAD, VOLUME_DOWN: 0xAE, VOLUME_UP: 0xAF,
  MEDIA_NEXT_TRACK: 0xB0, MEDIA_PREV_TRACK: 0xB1, MEDIA_STOP: 0xB2, MEDIA_PLAY_PAUSE: 0xB3,
  LAUNCH_MAIL: 0xB4, LAUNCH_MEDIA_SELECT: 0xB5, LAUNCH_APP1: 0xB6, LAUNCH_APP2: 0xB7,
});

// [code, win, mac]
const TABLE = [
  // Letters (mac: kVK_ANSI_*)
  ['KeyA', sc(0x1E), 0x00], ['KeyB', sc(0x30), 0x0B], ['KeyC', sc(0x2E), 0x08], ['KeyD', sc(0x20), 0x02],
  ['KeyE', sc(0x12), 0x0E], ['KeyF', sc(0x21), 0x03], ['KeyG', sc(0x22), 0x05], ['KeyH', sc(0x23), 0x04],
  ['KeyI', sc(0x17), 0x22], ['KeyJ', sc(0x24), 0x26], ['KeyK', sc(0x25), 0x28], ['KeyL', sc(0x26), 0x25],
  ['KeyM', sc(0x32), 0x2E], ['KeyN', sc(0x31), 0x2D], ['KeyO', sc(0x18), 0x1F], ['KeyP', sc(0x19), 0x23],
  ['KeyQ', sc(0x10), 0x0C], ['KeyR', sc(0x13), 0x0F], ['KeyS', sc(0x1F), 0x01], ['KeyT', sc(0x14), 0x11],
  ['KeyU', sc(0x16), 0x20], ['KeyV', sc(0x2F), 0x09], ['KeyW', sc(0x11), 0x0D], ['KeyX', sc(0x2D), 0x07],
  ['KeyY', sc(0x15), 0x10], ['KeyZ', sc(0x2C), 0x06],

  // Digit row
  ['Digit1', sc(0x02), 0x12], ['Digit2', sc(0x03), 0x13], ['Digit3', sc(0x04), 0x14], ['Digit4', sc(0x05), 0x15],
  ['Digit5', sc(0x06), 0x17], ['Digit6', sc(0x07), 0x16], ['Digit7', sc(0x08), 0x1A], ['Digit8', sc(0x09), 0x1C],
  ['Digit9', sc(0x0A), 0x19], ['Digit0', sc(0x0B), 0x1D],

  // Main block punctuation / editing
  ['Escape', sc(0x01), 0x35],
  ['Backquote', sc(0x29), 0x32], // kVK_ANSI_Grave
  ['Minus', sc(0x0C), 0x1B],
  ['Equal', sc(0x0D), 0x18],
  ['Backspace', sc(0x0E), 0x33], // kVK_Delete
  ['Tab', sc(0x0F), 0x30],
  ['BracketLeft', sc(0x1A), 0x21],
  ['BracketRight', sc(0x1B), 0x1E],
  ['Backslash', sc(0x2B), 0x2A],
  ['CapsLock', sc(0x3A), 0x39], // the physical key (Eisu on JIS layouts); lock resync uses VK_CAPITAL (win32.js tapLock)
  ['Semicolon', sc(0x27), 0x29],
  ['Quote', sc(0x28), 0x27],
  ['Enter', sc(0x1C), 0x24], // kVK_Return
  ['Space', sc(0x39), 0x31],
  ['Comma', sc(0x33), 0x2B],
  ['Period', sc(0x34), 0x2F],
  ['Slash', sc(0x35), 0x2C],
  ['IntlBackslash', sc(0x56), 0x0A], // ISO key left of Z; mac kVK_ISO_Section
  ['IntlRo', sc(0x73), 0x5E], // kVK_JIS_Underscore
  ['IntlYen', sc(0x7D), 0x5D], // kVK_JIS_Yen

  // Modifiers
  ['ShiftLeft', sc(0x2A), 0x38], // kVK_Shift
  ['ShiftRight', sc(0x36), 0x3C], // not E0-prefixed on PC keyboards
  ['ControlLeft', sc(0x1D), 0x3B],
  ['ControlRight', sce(0x1D), 0x3E],
  ['AltLeft', sc(0x38), 0x3A], // kVK_Option
  ['AltRight', sce(0x38), 0x3D], // AltGr layouts: Windows synthesizes the fake LCtrl itself
  ['MetaLeft', sce(0x5B), 0x37], // Win / kVK_Command
  ['MetaRight', sce(0x5C), 0x36], // kVK_RightCommand
  ['ContextMenu', sce(0x5D), null],
  ['Fn', null, 0x3F], // kVK_Function (only reported by some macOS viewers)

  // Function keys (mac has F1–F20 only)
  ['F1', sc(0x3B), 0x7A], ['F2', sc(0x3C), 0x78], ['F3', sc(0x3D), 0x63], ['F4', sc(0x3E), 0x76],
  ['F5', sc(0x3F), 0x60], ['F6', sc(0x40), 0x61], ['F7', sc(0x41), 0x62], ['F8', sc(0x42), 0x64],
  ['F9', sc(0x43), 0x65], ['F10', sc(0x44), 0x6D], ['F11', sc(0x57), 0x67], ['F12', sc(0x58), 0x6F],
  ['F13', sc(0x64), 0x69], ['F14', sc(0x65), 0x6B], ['F15', sc(0x66), 0x71], ['F16', sc(0x67), 0x6A],
  ['F17', sc(0x68), 0x40], ['F18', sc(0x69), 0x4F], ['F19', sc(0x6A), 0x50], ['F20', sc(0x6B), 0x5A],
  ['F21', sc(0x6C), null], ['F22', sc(0x6D), null], ['F23', sc(0x6E), null], ['F24', sc(0x76), null],

  // System keys (see header for the VK rationale and the mac position mapping)
  ['PrintScreen', vk(VK.SNAPSHOT, 0x37, true), 0x69], // mac: F13
  ['ScrollLock', sc(0x46), 0x6B], // mac: F14
  ['Pause', vk(VK.PAUSE, 0x45, false), 0x71], // mac: F15

  // Navigation cluster (E0-prefixed on Windows)
  ['Insert', sce(0x52), 0x72], // mac: kVK_Help (same physical key)
  ['Delete', sce(0x53), 0x75], // kVK_ForwardDelete
  ['Home', sce(0x47), 0x73],
  ['End', sce(0x4F), 0x77],
  ['PageUp', sce(0x49), 0x74],
  ['PageDown', sce(0x51), 0x79],
  ['ArrowLeft', sce(0x4B), 0x7B],
  ['ArrowRight', sce(0x4D), 0x7C],
  ['ArrowDown', sce(0x50), 0x7D],
  ['ArrowUp', sce(0x48), 0x7E],
  ['Help', vk(VK.HELP), 0x72],

  // Numeric keypad
  ['NumLock', vk(VK.NUMLOCK, 0x45, true), 0x47], // mac: kVK_ANSI_KeypadClear
  ['NumpadDivide', sce(0x35), 0x4B],
  ['NumpadMultiply', sc(0x37), 0x43],
  ['NumpadSubtract', sc(0x4A), 0x4E],
  ['NumpadAdd', sc(0x4E), 0x45],
  ['NumpadEnter', sce(0x1C), 0x4C],
  ['NumpadDecimal', sc(0x53), 0x41],
  ['NumpadEqual', sc(0x59), 0x51],
  ['NumpadComma', sc(0x7E), 0x5F], // kVK_JIS_KeypadComma
  ['Numpad0', sc(0x52), 0x52], ['Numpad1', sc(0x4F), 0x53], ['Numpad2', sc(0x50), 0x54],
  ['Numpad3', sc(0x51), 0x55], ['Numpad4', sc(0x4B), 0x56], ['Numpad5', sc(0x4C), 0x57],
  ['Numpad6', sc(0x4D), 0x58], ['Numpad7', sc(0x47), 0x59], ['Numpad8', sc(0x48), 0x5B],
  ['Numpad9', sc(0x49), 0x5C],

  // IME / East-Asian keys
  ['Lang1', sc(0x72), 0x68], // Hangul / Kana; mac kVK_JIS_Kana
  ['Lang2', sc(0x71), 0x66], // Hanja / Eisu; mac kVK_JIS_Eisu
  ['KanaMode', sc(0x70), null],
  ['Convert', sc(0x79), null],
  ['NonConvert', sc(0x7B), null],

  // Media / volume. mac: kVK_Mute/VolumeDown/VolumeUp exist, but see darwin.js notes; transport keys
  // have no kVK_* code on macOS (they are NX_SYSDEFINED events).
  ['AudioVolumeMute', vk(VK.VOLUME_MUTE, 0x20, true), 0x4A],
  ['AudioVolumeDown', vk(VK.VOLUME_DOWN, 0x2E, true), 0x49],
  ['AudioVolumeUp', vk(VK.VOLUME_UP, 0x30, true), 0x48],
  ['MediaTrackNext', vk(VK.MEDIA_NEXT_TRACK, 0x19, true), null],
  ['MediaTrackPrevious', vk(VK.MEDIA_PREV_TRACK, 0x10, true), null],
  ['MediaStop', vk(VK.MEDIA_STOP, 0x24, true), null],
  ['MediaPlayPause', vk(VK.MEDIA_PLAY_PAUSE, 0x22, true), null],

  // Browser / launch keys (Windows only)
  ['BrowserSearch', vk(VK.BROWSER_SEARCH, 0x65, true), null],
  ['BrowserFavorites', vk(VK.BROWSER_FAVORITES, 0x66, true), null],
  ['BrowserRefresh', vk(VK.BROWSER_REFRESH, 0x67, true), null],
  ['BrowserStop', vk(VK.BROWSER_STOP, 0x68, true), null],
  ['BrowserForward', vk(VK.BROWSER_FORWARD, 0x69, true), null],
  ['BrowserBack', vk(VK.BROWSER_BACK, 0x6A, true), null],
  ['BrowserHome', vk(VK.BROWSER_HOME, 0x32, true), null],
  ['LaunchApp1', vk(VK.LAUNCH_APP1, 0x6B, true), null],
  ['LaunchMail', vk(VK.LAUNCH_MAIL, 0x6C, true), null],
  ['MediaSelect', vk(VK.LAUNCH_MEDIA_SELECT, 0x6D, true), null],
  ['LaunchApp2', vk(VK.LAUNCH_APP2, 0x21, true), null],
];

/**
 * Legacy / alternative `code` spellings that intentionally share a target with another code.
 * alias → canonical code. (Older Chromium/Firefox reported the Windows/Command keys as OSLeft/OSRight.)
 */
const ALIASES = Object.freeze({ OSLeft: 'MetaLeft', OSRight: 'MetaRight' });

/** mac keycodes that are intentionally shared by two codes (code → the code it shares with). */
const MAC_SHARED = Object.freeze({ Insert: 'Help', PrintScreen: 'F13', ScrollLock: 'F14', Pause: 'F15' });

// Map (not a plain object) so codes like "constructor"/"toString" can never hit Object.prototype.
const KEYMAP = new Map();
for (const [code, win, mac] of TABLE) KEYMAP.set(code, Object.freeze({ win, mac }));
for (const [alias, target] of Object.entries(ALIASES)) KEYMAP.set(alias, KEYMAP.get(target));

const MODIFIERS = new Map([
  ['ShiftLeft', 'shift'], ['ShiftRight', 'shift'],
  ['ControlLeft', 'control'], ['ControlRight', 'control'],
  ['AltLeft', 'alt'], ['AltRight', 'alt'],
  ['MetaLeft', 'meta'], ['MetaRight', 'meta'], ['OSLeft', 'meta'], ['OSRight', 'meta'],
  ['CapsLock', 'capslock'],
  ['Fn', 'fn'],
]);

function entry(code) {
  return typeof code === 'string' ? KEYMAP.get(code) || null : null;
}

/** @returns {boolean} code appears in the table (even if unmapped on one platform). */
function isKnownCode(code) {
  return entry(code) !== null;
}

/** @returns {{sc:number, ext?:true}|{vk:number, sc?:number, ext?:true}|null} */
function winKey(code) {
  const e = entry(code);
  return e ? e.win : null;
}

/** @returns {number|null} macOS virtual keycode */
function macKey(code) {
  const e = entry(code);
  return e ? e.mac : null;
}

// On Apple ISO keyboards the HID layer reports the key left of 1 (Backquote position) as
// kVK_ISO_Section 0x0A and the key left of Z (IntlBackslash position) as kVK_ANSI_Grave 0x32 —
// the reverse of the ANSI-based table above (Chromium swaps them the same way for ISO viewers).
const MAC_ISO_SWAP = new Map([[0x0A, 0x32], [0x32, 0x0A]]);

/**
 * macOS virtual keycode for `code` on a host whose keyboard has the given physical layout.
 * @param {string} code KeyboardEvent.code
 * @param {boolean} isIso host keyboard is ISO (KBGetLayoutType(...) === kKeyboardISO)
 * @returns {number|null}
 */
function macKeyFor(code, isIso) {
  const kc = macKey(code);
  if (kc === null || kc === undefined || isIso !== true) return kc;
  return MAC_ISO_SWAP.has(kc) ? MAC_ISO_SWAP.get(kc) : kc;
}

/**
 * Platform-specific descriptor for `code`, or null when the key cannot be injected on that platform.
 * @param {string} code KeyboardEvent.code
 * @param {'win32'|'darwin'|string} platform process.platform value
 */
function lookup(code, platform) {
  if (platform === 'win32') return winKey(code);
  if (platform === 'darwin') return macKey(code);
  return null;
}

/** @returns {'shift'|'control'|'alt'|'meta'|'capslock'|'fn'|null} */
function modifierKind(code) {
  return typeof code === 'string' ? MODIFIERS.get(code) || null : null;
}

/** True for keys whose state changes the meaning of other keys (incl. CapsLock and Fn). */
function isModifier(code) {
  return modifierKind(code) !== null;
}

module.exports = {
  KEYMAP, // Map<code, {win, mac}> (frozen entries)
  CODES: Object.freeze([...KEYMAP.keys()]),
  ALIASES,
  MAC_SHARED,
  VK,
  lookup,
  winKey,
  macKey,
  macKeyFor,
  isKnownCode,
  isModifier,
  modifierKind,
};
