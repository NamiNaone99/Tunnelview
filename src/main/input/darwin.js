'use strict';
/*
 * macOS input injection backend (ARCHITECTURE §7 input/index.js — macOS mapping).
 * CoreGraphics / CoreFoundation / ApplicationServices via koffi 3, loaded by full framework path
 * (on macOS 11+ the binaries live in the dyld shared cache; dlopen() of these paths still works).
 *
 * Backend interface: see win32.js header. Coordinates are global display points: origin at the
 * top-left of the main display, y down — the same space as Electron's screen bounds on macOS.
 *
 * C prototypes used (CGEvent.h, CGEventSource.h, CGRemoteOperation.h, CFBase.h, AXUIElement.h).
 * Underlying C types: CGEventSourceStateID = int32_t; CGEventType, CGMouseButton, CGScrollEventUnit,
 * CGEventField, CGEventTapLocation = uint32_t enums; CGEventFlags = uint64_t; CGKeyCode = uint16_t;
 * CFTimeInterval = double; UniCharCount = unsigned long (8 bytes, LP64); UniChar = uint16_t;
 * Boolean = unsigned char; CGPoint = { double x, y } passed BY VALUE.
 *   CGEventSourceRef CGEventSourceCreate(CGEventSourceStateID stateID);
 *   void CGEventSourceSetLocalEventsSuppressionInterval(CGEventSourceRef, CFTimeInterval);
 *   CGEventFlags CGEventSourceFlagsState(CGEventSourceStateID);
 *   CGEventRef CGEventCreateMouseEvent(CGEventSourceRef, CGEventType, CGPoint, CGMouseButton);
 *   CGEventRef CGEventCreateKeyboardEvent(CGEventSourceRef, CGKeyCode, bool keyDown);
 *   CGEventRef CGEventCreateScrollWheelEvent2(CGEventSourceRef, CGScrollEventUnit, uint32_t wheelCount,
 *                                             int32_t wheel1, int32_t wheel2, int32_t wheel3);
 *   void CGEventSetFlags(CGEventRef, CGEventFlags);
 *   void CGEventSetType(CGEventRef, CGEventType);
 *   void CGEventSetIntegerValueField(CGEventRef, CGEventField, int64_t);
 *   void CGEventKeyboardSetUnicodeString(CGEventRef, UniCharCount, const UniChar *);
 *   void CGEventPost(CGEventTapLocation, CGEventRef);
 *   void CFRelease(CFTypeRef);
 *   Boolean AXIsProcessTrusted(void);
 * CGEventCreateScrollWheelEvent (non-"2") is variadic and must NOT be used: on arm64 variadic args
 * go on the stack, so the "2" variant (macOS 10.13+) is the only safe one to call through an FFI.
 *
 * Behaviour notes:
 *   - Events come from a kCGEventSourceStateHIDSystemState source (they look like hardware input) with
 *     the local-events suppression interval set to 0, so the host user's own mouse keeps working.
 *   - Posting to kCGHIDEventTap requires the Accessibility permission (AXIsProcessTrusted); without it
 *     CGEventPost silently drops events, hence check().
 *   - Modifier keys are posted as kCGEventFlagsChanged carrying the updated flags (what the HID driver
 *     does). Held modifiers (incl. left/right device bits from IOLLEvent.h) are applied to every key,
 *     mouse and scroll event, so Cmd-click / Shift-scroll work.
 *   - Caps Lock cannot be toggled through CGEvents (the lock state lives in IOHIDSystem). We emulate it:
 *     the viewer's Caps Lock press toggles a virtual alphaShift flag that is applied to later key
 *     events, and setCaps() (driven by the viewer's `kd.locks.caps`) sets it directly. The host's caps
 *     LED / global state is unchanged. reset() (every releaseAll, incl. session end) re-reads the real
 *     HID AlphaShift state so an emulated Caps Lock never carries over into a later session.
 *   - ISO keyboards: the HID layer swaps the keycodes of the key left of 1 (0x0A kVK_ISO_Section) and
 *     the key left of Z (0x32 kVK_ANSI_Grave) relative to ANSI. When the host keyboard is ISO
 *     (KBGetLayoutType(LMGetKbdType()) == kKeyboardISO, HIToolbox; detected at creation and on every
 *     reset()), keymap.macKeyFor() swaps Backquote/IntlBackslash accordingly. Any failure → ANSI.
 *     C prototypes: UInt8 LMGetKbdType(void); PhysicalKeyboardLayoutType (OSType = UInt32)
 *     KBGetLayoutType(SInt16 iKeyboardType); CGEventSourceKeyboardType (uint32_t)
 *     CGEventSourceGetKeyboardType(CGEventSourceRef).
 *   - Volume keys are posted as kVK_VolumeUp/Down/Mute key events; modern macOS drives volume from
 *     NX_SYSDEFINED media events, so these may not change the system volume. Media transport keys
 *     have no keycode and are not injectable (keymap → null).
 *   - Every created event is CFRelease()d (try/finally) — CGEventCreate* follow the Create rule.
 */
const keymap = require('./keymap');

const CG_PATH = '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics';
const CF_PATH = '/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation';
const AS_PATH = '/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices';
const HIS_PATH = '/System/Library/Frameworks/ApplicationServices.framework/Frameworks/HIServices.framework/HIServices';
const HIT_PATH = '/System/Library/Frameworks/Carbon.framework/Frameworks/HIToolbox.framework/HIToolbox';
const CARBON_PATH = '/System/Library/Frameworks/Carbon.framework/Carbon';

const kKeyboardISO = 0x49534F20; // 'ISO ' (HIToolbox Keyboards.h PhysicalKeyboardLayoutType)

const kCGEventSourceStateHIDSystemState = 1;
const kCGHIDEventTap = 0;
const kCGScrollEventUnitPixel = 0;

const EVT = Object.freeze({
  LeftMouseDown: 1, LeftMouseUp: 2, RightMouseDown: 3, RightMouseUp: 4, MouseMoved: 5,
  LeftMouseDragged: 6, RightMouseDragged: 7, KeyDown: 10, KeyUp: 11, FlagsChanged: 12,
  ScrollWheel: 22, OtherMouseDown: 25, OtherMouseUp: 26, OtherMouseDragged: 27,
});

const FIELD = Object.freeze({
  MouseEventClickState: 1,
  MouseEventButtonNumber: 3,
  MouseEventDeltaX: 4,
  MouseEventDeltaY: 5,
  KeyboardEventAutorepeat: 8,
  EventSourceUserData: 42,
});

const FLAG = Object.freeze({
  AlphaShift: 0x00010000,
  Shift: 0x00020000,
  Control: 0x00040000,
  Alternate: 0x00080000,
  Command: 0x00100000,
  NumericPad: 0x00200000,
  SecondaryFn: 0x00800000,
});

// Device-dependent modifier bits (IOKit/hidsystem/IOLLEvent.h NX_DEVICE*KEYMASK)
const NX = Object.freeze({ LCTL: 0x01, LSHIFT: 0x02, RSHIFT: 0x04, LCMD: 0x08, RCMD: 0x10, LALT: 0x20, RALT: 0x40, RCTL: 0x2000 });

// mac keycode → { mask, dev } for keys posted as FlagsChanged (CapsLock handled separately)
const MODIFIER_BITS = new Map([
  [0x38, { mask: FLAG.Shift, dev: NX.LSHIFT }], // kVK_Shift
  [0x3C, { mask: FLAG.Shift, dev: NX.RSHIFT }], // kVK_RightShift
  [0x3B, { mask: FLAG.Control, dev: NX.LCTL }], // kVK_Control
  [0x3E, { mask: FLAG.Control, dev: NX.RCTL }], // kVK_RightControl
  [0x3A, { mask: FLAG.Alternate, dev: NX.LALT }], // kVK_Option
  [0x3D, { mask: FLAG.Alternate, dev: NX.RALT }], // kVK_RightOption
  [0x37, { mask: FLAG.Command, dev: NX.LCMD }], // kVK_Command
  [0x36, { mask: FLAG.Command, dev: NX.RCMD }], // kVK_RightCommand
  [0x3F, { mask: FLAG.SecondaryFn, dev: 0 }], // kVK_Function
]);
const KVK_CAPSLOCK = 0x39;

// Flags real Apple keyboards attach to these keys (NSEventModifierFlagNumericPad / ...Function docs):
// arrows carry both; keypad keys carry NumericPad; F-keys and the navigation block carry SecondaryFn.
const ARROWS = new Set([0x7B, 0x7C, 0x7D, 0x7E]);
const KEYPAD = new Set([0x41, 0x43, 0x45, 0x47, 0x4B, 0x4C, 0x4E, 0x51, 0x52, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5B, 0x5C, 0x5F]);
const FN_KEYS = new Set([
  0x7A, 0x78, 0x63, 0x76, 0x60, 0x61, 0x62, 0x64, 0x65, 0x6D, 0x67, 0x6F, 0x69, 0x6B, 0x71, 0x6A, 0x40, 0x4F, 0x50, 0x5A, // F1–F20
  0x72, 0x73, 0x74, 0x75, 0x77, 0x79, // Help, Home, PageUp, ForwardDelete, End, PageDown
]);

const TAG = 0x616E7956; // 'anyV' in kCGEventSourceUserData — marks events injected by Tunnelview
const MAX_UNICODE_CHUNK = 20; // CGEventKeyboardSetUnicodeString truncates longer strings

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested on every platform)
// ---------------------------------------------------------------------------------------------

function implicitKeyFlags(keycode) {
  if (ARROWS.has(keycode)) return FLAG.NumericPad | FLAG.SecondaryFn;
  if (KEYPAD.has(keycode)) return FLAG.NumericPad;
  if (FN_KEYS.has(keycode)) return FLAG.SecondaryFn;
  return 0;
}

/** DOM button → CGMouseButton number (left 0, right 1, center 2, back 3, forward 4). */
function cgButton(b) {
  return [0, 2, 1, 3, 4][b];
}

/** Event type for a press/release of DOM button `b`. */
function buttonEventType(b, down) {
  if (b === 0) return down ? EVT.LeftMouseDown : EVT.LeftMouseUp;
  if (b === 2) return down ? EVT.RightMouseDown : EVT.RightMouseUp;
  return down ? EVT.OtherMouseDown : EVT.OtherMouseUp;
}

/**
 * Move event type while `pressed` (Set of DOM buttons) are held. Left wins over right, right over others.
 * @returns {{type:number, button:number}}
 */
function moveEventType(pressed) {
  if (pressed.has(0)) return { type: EVT.LeftMouseDragged, button: 0 };
  if (pressed.has(2)) return { type: EVT.RightMouseDragged, button: 1 };
  for (const b of [1, 3, 4]) if (pressed.has(b)) return { type: EVT.OtherMouseDragged, button: cgButton(b) };
  return { type: EVT.MouseMoved, button: 0 };
}

/** Split into ≤ max UTF-16 unit chunks without separating a surrogate pair. */
function utf16Chunks(str, max = MAX_UNICODE_CHUNK) {
  const chunks = [];
  let i = 0;
  while (i < str.length) {
    let end = Math.min(i + max, str.length);
    if (end < str.length && end - i > 1) {
      const last = str.charCodeAt(end - 1);
      if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
    }
    chunks.push(str.slice(i, end));
    i = end;
  }
  return chunks;
}

function createPixelAccumulator() {
  let acc = 0;
  return {
    add(px) {
      if (px === 0 || !Number.isFinite(px)) return 0;
      if (acc !== 0 && Math.sign(acc) !== Math.sign(px)) acc = 0;
      acc += px;
      const whole = Math.trunc(acc + Math.sign(acc) * 1e-9) || 0; // absorb FP drift (see win32.js); -0 → 0
      acc -= whole;
      return whole;
    },
    reset() { acc = 0; },
  };
}

function clampInt32(v) {
  return v > 0x7FFFFFFF ? 0x7FFFFFFF : v < -0x80000000 ? -0x80000000 : v;
}

/**
 * Whether the host keyboard is ISO. `nat` may lack any of the optional functions (→ ANSI).
 * Prefers LMGetKbdType() (what Chromium uses for the same swap), else the event source's type.
 * @returns {boolean}
 */
function detectIsoKeyboard(nat, source) {
  try {
    if (typeof nat.KBGetLayoutType !== 'function') return false;
    let type = 0;
    if (typeof nat.LMGetKbdType === 'function') type = Number(nat.LMGetKbdType());
    if (!type && source && typeof nat.CGEventSourceGetKeyboardType === 'function') type = Number(nat.CGEventSourceGetKeyboardType(source));
    if (!Number.isInteger(type) || type <= 0 || type > 0x7FFF) return false; // SInt16 parameter
    return (Number(nat.KBGetLayoutType(type)) >>> 0) === kKeyboardISO;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Native layer
// ---------------------------------------------------------------------------------------------

let nativeCache = null;

function loadNative() {
  if (nativeCache) return nativeCache;
  if (process.platform !== 'darwin') throw new Error('darwin input backend requires macOS');
  const koffi = require('koffi');
  const cg = koffi.load(CG_PATH);
  const cf = koffi.load(CF_PATH);

  // Anonymous struct: koffi type names are process-global and duplicates throw.
  const CGPoint = koffi.struct({ x: 'double', y: 'double' });
  const P = 'void *'; // CGEventRef / CGEventSourceRef / CFTypeRef (koffi 3: BigInt or null)

  const nat = {
    koffi, cg, cf,
    CGEventSourceCreate: cg.func('CGEventSourceCreate', P, ['int32_t']),
    CGEventSourceSetLocalEventsSuppressionInterval: cg.func('CGEventSourceSetLocalEventsSuppressionInterval', 'void', [P, 'double']),
    CGEventSourceFlagsState: cg.func('CGEventSourceFlagsState', 'uint64_t', ['int32_t']),
    CGEventCreateMouseEvent: cg.func('CGEventCreateMouseEvent', P, [P, 'uint32_t', CGPoint, 'uint32_t']),
    CGEventCreateKeyboardEvent: cg.func('CGEventCreateKeyboardEvent', P, [P, 'uint16_t', 'bool']),
    CGEventCreateScrollWheelEvent2: cg.func('CGEventCreateScrollWheelEvent2', P, [P, 'uint32_t', 'uint32_t', 'int32_t', 'int32_t', 'int32_t']),
    CGEventSetFlags: cg.func('CGEventSetFlags', 'void', [P, 'uint64_t']),
    CGEventSetType: cg.func('CGEventSetType', 'void', [P, 'uint32_t']),
    CGEventSetIntegerValueField: cg.func('CGEventSetIntegerValueField', 'void', [P, 'uint32_t', 'int64_t']),
    // UniCharCount is `unsigned long` = 8 bytes on LP64 macOS = size_t.
    CGEventKeyboardSetUnicodeString: cg.func('CGEventKeyboardSetUnicodeString', 'void', [P, 'size_t', 'uint16_t *']),
    CGEventPost: cg.func('CGEventPost', 'void', ['uint32_t', P]),
    CFRelease: cf.func('CFRelease', 'void', [P]),
    AXIsProcessTrusted: null,
  };

  // AXIsProcessTrusted lives in HIServices (re-exported by the ApplicationServices umbrella).
  for (const p of [AS_PATH, HIS_PATH]) {
    try {
      const lib = koffi.load(p);
      nat.AXIsProcessTrusted = lib.func('AXIsProcessTrusted', 'uint8_t', []);
      nat.hiservices = lib; // keep the handle referenced
      break;
    } catch { /* try next */ }
  }

  // Optional (ISO keyboard detection); a failure only means "assume ANSI".
  try {
    nat.CGEventSourceGetKeyboardType = cg.func('CGEventSourceGetKeyboardType', 'uint32_t', [P]);
  } catch { /* optional */ }
  for (const p of [HIT_PATH, CARBON_PATH]) {
    try {
      const lib = koffi.load(p);
      nat.KBGetLayoutType = lib.func('KBGetLayoutType', 'uint32_t', ['int16_t']);
      nat.hitoolbox = lib; // keep the handle referenced
      try {
        nat.LMGetKbdType = lib.func('LMGetKbdType', 'uint8_t', []);
      } catch { /* detectIsoKeyboard falls back to CGEventSourceGetKeyboardType */ }
      break;
    } catch { /* try next */ }
  }

  nativeCache = nat;
  return nat;
}

function electronTrustCheck() {
  try {
    const { systemPreferences } = require('electron');
    if (systemPreferences && typeof systemPreferences.isTrustedAccessibilityClient === 'function') {
      return !!systemPreferences.isTrustedAccessibilityClient(false);
    }
  } catch { /* not in Electron */ }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

/**
 * @param {object} [native] injected native layer (tests) with the same function names as loadNative().
 */
function createBackend(native) {
  const nat = native || loadNative();

  let source = null;
  try {
    source = nat.CGEventSourceCreate(kCGEventSourceStateHIDSystemState) || null;
    if (source) nat.CGEventSourceSetLocalEventsSuppressionInterval(source, 0);
  } catch {
    source = null; // a NULL source is valid for every CGEventCreate* call
  }

  const heldMods = new Map(); // mac keycode → {mask, dev}
  const pressed = new Set(); // DOM buttons currently down (drives *Dragged event types)
  let last = null; // last cursor position we posted {x, y}

  /** Real (hardware) Caps Lock state from the HID system; false if it cannot be read. */
  function hidCaps() {
    try {
      return (Number(nat.CGEventSourceFlagsState(kCGEventSourceStateHIDSystemState)) & FLAG.AlphaShift) !== 0;
    } catch {
      return false;
    }
  }

  let caps = hidCaps(); // emulated Caps Lock (see header)
  let iso = detectIsoKeyboard(nat, source);
  const wheel1 = createPixelAccumulator();
  const wheel2 = createPixelAccumulator();

  function modifierFlags() {
    let f = caps ? FLAG.AlphaShift : 0;
    for (const { mask, dev } of heldMods.values()) f |= mask | dev;
    return f;
  }

  /** Set flags + tag, post to the HID tap, always release. */
  function postAndRelease(ev, flags, configure) {
    try {
      if (configure) configure(ev);
      nat.CGEventSetFlags(ev, flags);
      nat.CGEventSetIntegerValueField(ev, FIELD.EventSourceUserData, TAG);
      nat.CGEventPost(kCGHIDEventTap, ev);
    } finally {
      nat.CFRelease(ev);
    }
  }

  function mouseEvent(type, x, y, button, configure) {
    const ev = nat.CGEventCreateMouseEvent(source, type, { x, y }, button);
    if (!ev) return;
    postAndRelease(ev, modifierFlags(), configure);
  }

  function flagsChanged(keycode) {
    const ev = nat.CGEventCreateKeyboardEvent(source, keycode, true);
    if (!ev) return;
    postAndRelease(ev, modifierFlags(), (e) => nat.CGEventSetType(e, EVT.FlagsChanged));
  }

  function hasPoint(px, py) {
    return typeof px === 'number' && typeof py === 'number' && Number.isFinite(px) && Number.isFinite(py);
  }

  return {
    platform: 'darwin',

    check() {
      let trusted = null;
      if (nat.AXIsProcessTrusted) {
        try { trusted = nat.AXIsProcessTrusted() !== 0; } catch { trusted = null; }
      }
      if (trusted === null) trusted = electronTrustCheck();
      if (trusted === null) return { available: true, reason: null }; // cannot tell; CGEventPost decides
      return trusted ? { available: true, reason: null } : { available: false, reason: 'accessibility-permission' };
    },

    moveTo(px, py) {
      if (!hasPoint(px, py)) return;
      const { type, button } = moveEventType(pressed);
      const dx = last ? Math.round(px - last.x) : 0;
      const dy = last ? Math.round(py - last.y) : 0;
      last = { x: px, y: py };
      mouseEvent(type, px, py, button, (ev) => {
        // CGEventCreateMouseEvent leaves the relative deltas at 0; games/3D apps read them.
        nat.CGEventSetIntegerValueField(ev, FIELD.MouseEventDeltaX, dx);
        nat.CGEventSetIntegerValueField(ev, FIELD.MouseEventDeltaY, dy);
      });
    },

    button(b, down, px, py, clicks) {
      const btn = cgButton(b);
      if (btn === undefined) return;
      if (hasPoint(px, py)) last = { x: px, y: py };
      if (!last) return; // never warp the cursor to (0,0) just to release a button we never pressed
      if (down) pressed.add(b); else pressed.delete(b);
      const n = Number.isInteger(clicks) && clicks >= 1 ? Math.min(clicks, 3) : 1;
      mouseEvent(buttonEventType(b, down), last.x, last.y, btn, (ev) => {
        nat.CGEventSetIntegerValueField(ev, FIELD.MouseEventClickState, n);
        if (btn > 1) nat.CGEventSetIntegerValueField(ev, FIELD.MouseEventButtonNumber, btn);
      });
    },

    scroll(dx, dy) {
      // Pixel units; wheel1 = vertical (+ = up), wheel2 = horizontal (+ = left) → negate DOM deltas.
      const w1 = clampInt32(wheel1.add(-dy));
      const w2 = clampInt32(wheel2.add(-dx));
      if (w1 === 0 && w2 === 0) return;
      const ev = nat.CGEventCreateScrollWheelEvent2(source, kCGScrollEventUnitPixel, 2, w1, w2, 0);
      if (!ev) return;
      postAndRelease(ev, modifierFlags());
    },

    key(code, down, repeat) {
      const kc = keymap.macKeyFor(code, iso);
      if (kc === null || kc === undefined) return false;

      if (kc === KVK_CAPSLOCK) {
        // Toggle on press only (like the hardware lock); releases and repeats are ignored.
        if (down && !repeat) {
          caps = !caps;
          flagsChanged(kc);
        }
        return true;
      }

      const mod = MODIFIER_BITS.get(kc);
      if (mod) {
        if (repeat) return true;
        if (down) {
          if (heldMods.has(kc)) return true;
          heldMods.set(kc, mod);
        } else {
          if (!heldMods.delete(kc)) return true;
        }
        flagsChanged(kc);
        return true;
      }

      const ev = nat.CGEventCreateKeyboardEvent(source, kc, !!down);
      if (!ev) return true;
      postAndRelease(ev, modifierFlags() | implicitKeyFlags(kc), (e) => {
        if (down && repeat) nat.CGEventSetIntegerValueField(e, FIELD.KeyboardEventAutorepeat, 1);
      });
      return true;
    },

    text(str) {
      if (typeof str !== 'string' || !str) return;
      for (const chunk of utf16Chunks(str)) {
        const units = new Uint16Array(chunk.length);
        for (let i = 0; i < chunk.length; i++) units[i] = chunk.charCodeAt(i);
        for (const down of [true, false]) {
          // Keycode 0 is a placeholder; the attached Unicode string is what apps receive.
          const ev = nat.CGEventCreateKeyboardEvent(source, 0, down);
          if (!ev) continue;
          // Flags 0: held modifiers must not turn typed text into shortcuts.
          postAndRelease(ev, 0, (e) => nat.CGEventKeyboardSetUnicodeString(e, units.length, units));
        }
      }
    },

    reset() {
      wheel1.reset();
      wheel2.reset();
      pressed.clear();
      // Session end / viewer blur: drop the emulated Caps Lock (a viewer that left it on must not make
      // later sessions type in capitals) and pick up a keyboard swapped meanwhile.
      caps = hidCaps();
      iso = detectIsoKeyboard(nat, source);
      if (heldMods.size) {
        // Normally index.js already released every modifier through key(); this is the safety net.
        const codes = [...heldMods.keys()];
        heldMods.clear();
        try { flagsChanged(codes[codes.length - 1]); } catch { /* ignore */ }
      }
    },

    /** Sets the emulated Caps Lock (viewer's state from `kd.locks.caps`); applied to later key events. */
    setCaps(on) {
      if (typeof on === 'boolean') caps = on;
    },

    /** @returns {{caps:boolean, num:null}} emulated Caps Lock; macOS has no Num Lock */
    lockState() {
      return { caps, num: null };
    },

    // test/introspection helpers
    _state: () => ({ flags: modifierFlags(), caps, iso, pressed: [...pressed], last }),
  };
}

module.exports = {
  createBackend,
  loadNative,
  constants: Object.freeze({ EVT, FIELD, FLAG, NX, TAG, kCGHIDEventTap, kCGScrollEventUnitPixel, kCGEventSourceStateHIDSystemState, MAX_UNICODE_CHUNK, kKeyboardISO }),
  _pure: { implicitKeyFlags, cgButton, buttonEventType, moveEventType, utf16Chunks, createPixelAccumulator, detectIsoKeyboard },
};
