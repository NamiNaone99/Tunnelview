'use strict';
/*
 * Windows input injection backend (ARCHITECTURE §7 input/index.js — Windows mapping).
 * user32.dll via koffi 3: SendInput, GetSystemMetrics, MapVirtualKeyW. Optional read-only helpers
 * (desktop / integrity probe, monitor rect, lock state) come from user32 + kernel32 + advapi32 and
 * are loaded lazily and separately (loadExtras): if they fail, injection itself keeps working.
 *
 * Backend interface (shared with darwin.js, consumed by ./index.js):
 *   check()                          → { available, reason }
 *   moveTo(px, py)                   physical virtual-desktop pixels
 *   button(b, down, px?, py?, n)     b = DOM button 0..4; px/py omitted → no move
 *   scroll(dx, dy)                   DOM wheel deltas in CSS px (dy > 0 = scroll down)
 *   key(code, down, repeat) → bool   false if `code` has no Windows mapping
 *   text(str)                        Unicode text (no control characters — index.js strips them)
 *   reset()                          forget transient state (wheel remainders, button bookkeeping)
 * Optional (index.js feature-detects each one):
 *   mask()                           win32: tap the unassigned VK 0xE8 so a following Alt/Win release
 *                                    is not a "solo tap" (no menu bar / Start menu)
 *   tapLock(kind) → bool             win32: Caps/Num Lock resync tap ('caps' | 'num') by virtual key
 *                                    (VK_CAPITAL / VK_NUMLOCK), not by the layout-dependent scancode
 *   takeShortfall() → bool           win32: SendInput inserted fewer events than requested since the
 *                                    last call (secure desktop, …); clears the flag
 *   blockedReason(pt?) → 'secure-desktop'|'elevated-window'|null   win32 (pt = physical px, or
 *                                    null → the foreground window)
 *   lockState() → {caps, num}|null   current host Caps Lock / Num Lock toggles (darwin: num null)
 *   setCaps(on)                      darwin: set the emulated Caps Lock state
 *   monitorRect(pt) → {x,y,width,height}|null   win32: exact physical rcMonitor of the monitor at pt
 *   windowAt(pt) → HWND (BigInt) of the top-level owner window under pt | null (none) | undefined (unknown)
 *
 * Platform notes:
 *   - Electron is per-monitor-DPI-aware (v2), so GetSystemMetrics(SM_*VIRTUALSCREEN) and the rect from
 *     screen.dipToScreenRect() are both physical pixels. (A DPI-unaware plain `node` process sees
 *     virtualized metrics instead — only relevant for tests.)
 *   - Absolute moves use MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK: 0..65535 spans the whole virtual
 *     desktop (all monitors), so multi-monitor layouts with negative origins work.
 *   - SendInput fails while the secure desktop (UAC prompt, lock screen, Ctrl+Alt+Del) is active: it
 *     then inserts fewer events than requested (logged rate-limited, reported via takeShortfall()).
 *     UIPI blocking of elevated targets is NOT signalled at all (Microsoft: neither the return value
 *     nor GetLastError indicates it), hence blockedReason(): input desktop name + integrity level of
 *     the target window's process vs ours. Both are platform limits (ARCHITECTURE §11).
 *   - Mouse buttons in SendInput are *physical*: if the host user swapped buttons (left-handed),
 *     MOUSEEVENTF_LEFTDOWN becomes a logical right click. DOM buttons are logical, so primary/secondary
 *     are swapped back when GetSystemMetrics(SM_SWAPBUTTON) is non-zero.
 *   - Click counts (`n`) are not needed: Windows detects double-clicks from timing/position itself.
 *   - lockState() reads GetKeyState(VK_CAPITAL / VK_NUMLOCK) & 1. That is the calling thread's key
 *     state: for a thread that does not receive the keyboard input itself, win32k only resyncs it
 *     from the global state lazily (the GetKeyState call posts an update event that the message pump
 *     applies), so the first read after a change — including a toggle we injected — can be stale.
 *     GetKeyboardState has the same per-thread semantics. index.js therefore only trusts a read that
 *     follows an earlier read in the same chain (see LOCK_SETTLE_MS there), verifies each resync tap
 *     with the next trusted read, and stops after LOCK_GIVE_UP taps that changed nothing.
 *   - Every injected event carries dwExtraInfo = EXTRA_INFO ('anyV') so hooks/tools can recognise it.
 */
const keymap = require('./keymap');

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const MOUSEEVENTF = Object.freeze({
  MOVE: 0x0001,
  LEFTDOWN: 0x0002, LEFTUP: 0x0004,
  RIGHTDOWN: 0x0008, RIGHTUP: 0x0010,
  MIDDLEDOWN: 0x0020, MIDDLEUP: 0x0040,
  XDOWN: 0x0080, XUP: 0x0100,
  WHEEL: 0x0800, HWHEEL: 0x1000,
  VIRTUALDESK: 0x4000,
  ABSOLUTE: 0x8000,
});
const KEYEVENTF = Object.freeze({ EXTENDEDKEY: 0x0001, KEYUP: 0x0002, UNICODE: 0x0004, SCANCODE: 0x0008 });
const XBUTTON1 = 0x0001; // "back"
const XBUTTON2 = 0x0002; // "forward"
const WHEEL_DELTA = 120;
const CSS_PX_PER_NOTCH = 100; // 100 CSS px of DOM wheel delta ≈ one 120-unit notch
const SM = Object.freeze({ SWAPBUTTON: 23, XVIRTUALSCREEN: 76, YVIRTUALSCREEN: 77, CXVIRTUALSCREEN: 78, CYVIRTUALSCREEN: 79 });
const MAPVK_VK_TO_VSC = 0;
const EXTRA_INFO = 0x616E7956; // 'anyV' — marks events injected by Tunnelview
const MAX_INPUTS_PER_CALL = 4096; // bounds koffi's per-call marshalling memory (40 B each)
const VK_MASK = 0xE8; // unassigned VK (AutoHotkey's default MenuMaskKey): no layout maps it to anything
const VK_CAPITAL = 0x14;
const VK_NUMLOCK = 0x90;
// probe / monitor constants (WinUser.h, winnt.h, winerror.h)
const DESKTOP_READOBJECTS = 0x0001;
const UOI_NAME = 2;
const GA_ROOT = 2;
const GA_ROOTOWNER = 3; // root window, then up the owner chain (an owned dialog → its owner)
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const TOKEN_QUERY = 0x0008;
const TOKEN_INTEGRITY_LEVEL = 25; // TOKEN_INFORMATION_CLASS TokenIntegrityLevel
const ERROR_ACCESS_DENIED = 5;
const MONITOR_DEFAULTTONEAREST = 2;
const MONITORINFOEXW_SIZE = 104; // DWORD cbSize + RECT rcMonitor + RECT rcWork + DWORD dwFlags + WCHAR[32]

// ---------------------------------------------------------------------------------------------
// Pure helpers (no native code; unit-tested on every platform)
// ---------------------------------------------------------------------------------------------

function mouseInput(dx, dy, mouseData, flags) {
  return { type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData, dwFlags: flags, time: 0, dwExtraInfo: EXTRA_INFO } } };
}

function keyInput(wVk, wScan, flags) {
  return { type: INPUT_KEYBOARD, u: { ki: { wVk, wScan, dwFlags: flags, time: 0, dwExtraInfo: EXTRA_INFO } } };
}

/**
 * Physical pixel → normalized absolute coordinate over the virtual desktop.
 *
 * win32k de-normalizes with pixel = ⌊n · size / 65536⌋ (ReactOS: `dx * SM_CXVIRTUALSCREEN >> 16`).
 * n = ⌈p · 65536 / size⌉ is the smallest n that lands on pixel p, so it is exact for every pixel —
 * and stays exact if Windows rounds to nearest instead (error < size/65536 < 0.5). The often quoted
 * round(p · 65535 / (size − 1)) is off by one pixel for ~1 in 50 positions on common widths
 * (verified exhaustively for widths 800…15360; see test/input.test.js).
 * @param {{x:number,y:number,width:number,height:number}} vs virtual screen (physical px)
 */
function normalize(px, py, vs) {
  const n = (p, origin, size) => {
    const v = Math.ceil(((p - origin) * 65536) / Math.max(1, size));
    return v < 0 ? 0 : v > 65535 ? 65535 : v;
  };
  return { nx: n(px, vs.x, vs.width), ny: n(py, vs.y, vs.height) };
}

function moveInput(px, py, vs) {
  const { nx, ny } = normalize(px, py, vs);
  return mouseInput(nx, ny, 0, MOUSEEVENTF.MOVE | MOUSEEVENTF.ABSOLUTE | MOUSEEVENTF.VIRTUALDESK);
}

/**
 * @param {number} b DOM button (0 primary, 1 middle, 2 secondary, 3 back, 4 forward)
 * @param {boolean} swapped SM_SWAPBUTTON is set (physical left = logical secondary)
 * @returns {{flags:number, data:number}|null}
 */
function buttonFlags(b, down, swapped) {
  switch (b) {
    case 0: case 2: {
      const physicalLeft = (b === 0) !== !!swapped;
      if (physicalLeft) return { flags: down ? MOUSEEVENTF.LEFTDOWN : MOUSEEVENTF.LEFTUP, data: 0 };
      return { flags: down ? MOUSEEVENTF.RIGHTDOWN : MOUSEEVENTF.RIGHTUP, data: 0 };
    }
    case 1: return { flags: down ? MOUSEEVENTF.MIDDLEDOWN : MOUSEEVENTF.MIDDLEUP, data: 0 };
    case 3: return { flags: down ? MOUSEEVENTF.XDOWN : MOUSEEVENTF.XUP, data: XBUTTON1 };
    case 4: return { flags: down ? MOUSEEVENTF.XDOWN : MOUSEEVENTF.XUP, data: XBUTTON2 };
    default: return null;
  }
}

/**
 * KEYBDINPUT for one keymap descriptor.
 * @param {{sc:number, ext?:boolean}|{vk:number, sc?:number, ext?:boolean}} desc
 * @param {(vk:number)=>number} [mapScan] VK → scancode (MapVirtualKeyW) for vk descriptors without sc
 */
function keyInputFor(desc, down, mapScan) {
  const up = down ? 0 : KEYEVENTF.KEYUP;
  const ext = desc.ext ? KEYEVENTF.EXTENDEDKEY : 0;
  if (typeof desc.vk === 'number') {
    let scan = typeof desc.sc === 'number' ? desc.sc : 0;
    if (typeof desc.sc !== 'number' && mapScan) {
      try { scan = mapScan(desc.vk) & 0xFF; } catch { scan = 0; }
    }
    return keyInput(desc.vk, scan & 0xFF, ext | up);
  }
  // With KEYEVENTF_SCANCODE, wVk is ignored and the layout translates the scancode (E0 via EXTENDEDKEY).
  return keyInput(0, desc.sc & 0xFF, KEYEVENTF.SCANCODE | ext | up);
}

/** KEYEVENTF_UNICODE down+up for every UTF-16 code unit (surrogate pairs are sent unit by unit). */
function unicodeInputs(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i);
    out.push(keyInput(0, unit, KEYEVENTF.UNICODE));
    out.push(keyInput(0, unit, KEYEVENTF.UNICODE | KEYEVENTF.KEYUP));
  }
  return out;
}

/** VK 0xE8 down + up by virtual key (no KEYEVENTF_SCANCODE), carrying the usual EXTRA_INFO marker. */
function maskInputs() {
  return [keyInput(VK_MASK, 0, 0), keyInput(VK_MASK, 0, KEYEVENTF.KEYUP)];
}

/**
 * Lock-resync tap (down + up) by virtual key, never KEYEVENTF_SCANCODE: the layout translates the
 * physical CapsLock scancode 0x3A, and kbd106 (Japanese) maps it to VK_DBE_ALPHANUMERIC (Eisu; Caps
 * Lock is Shift+Eisu there), while an injected VK_CAPITAL toggles Caps Lock on every layout. wScan
 * comes from MapVirtualKeyW (informational only). NumLock carries EXTENDEDKEY like the real key.
 * @param {'caps'|'num'} kind
 * @param {(vk:number)=>number} [mapScan] VK → scancode (MapVirtualKeyW MAPVK_VK_TO_VSC)
 * @returns {object[]|null} null for an unknown kind
 */
function lockTapInputs(kind, mapScan) {
  const vkCode = kind === 'caps' ? VK_CAPITAL : kind === 'num' ? VK_NUMLOCK : 0;
  if (!vkCode) return null;
  let scan = 0;
  if (mapScan) {
    try { scan = mapScan(vkCode) & 0xFF; } catch { scan = 0; }
  }
  const ext = kind === 'num' ? KEYEVENTF.EXTENDEDKEY : 0;
  return [keyInput(vkCode, scan, ext), keyInput(vkCode, scan, ext | KEYEVENTF.KEYUP)];
}

/**
 * RID (last sub-authority) of the integrity SID in a TOKEN_MANDATORY_LABEL that
 * GetTokenInformation(TokenIntegrityLevel) wrote into `buf`. The SID lives inside the same buffer;
 * `sidOffset` = Label.Sid − address(buf). Bounds-checked: never reads past the `len` bytes written.
 * @returns {number|null} e.g. 0x1000 low, 0x2000 medium, 0x3000 high, 0x4000 system
 */
function integrityRid(buf, len, sidOffset) {
  if (!Buffer.isBuffer(buf) || !Number.isInteger(len) || len > buf.length) return null;
  if (!Number.isInteger(sidOffset) || sidOffset < 0 || sidOffset + 8 > len) return null;
  if (buf[sidOffset] !== 1) return null; // SID_REVISION
  const count = buf[sidOffset + 1]; // SubAuthorityCount; then 6-byte IdentifierAuthority
  if (count < 1) return null;
  const at = sidOffset + 8 + 4 * (count - 1);
  if (at + 4 > len) return null;
  return buf.readUInt32LE(at);
}

/** NUL-terminated UTF-16LE string at the start of `buf` (GetUserObjectInformationW UOI_NAME). */
function utf16z(buf) {
  const s = buf.toString('utf16le');
  const z = s.indexOf('\0');
  return z >= 0 ? s.slice(0, z) : s;
}

/** rcMonitor from a MONITORINFOEXW buffer filled by GetMonitorInfoW → {x,y,width,height} | null. */
function monitorInfoRect(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 20) return null;
  const left = buf.readInt32LE(4);
  const top = buf.readInt32LE(8);
  const right = buf.readInt32LE(12);
  const bottom = buf.readInt32LE(16);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Decision logic of blockedReason() over plain values (unit-tested).
 * @param {object} s
 * @param {string|false|null} s.inputDesktop name of the input desktop; false = OpenInputDesktop failed
 *        (we may not even open it: Winlogon / UAC secure desktop); null = opened but name unknown
 * @param {string|null} s.ownDesktop our thread's desktop name (null → 'Default')
 * @param {() => (number|'denied'|null)} s.targetRid integrity RID of the target window's process
 *        ('denied' = OpenProcess/OpenProcessToken failed with ERROR_ACCESS_DENIED; null = no target/unknown)
 * @param {() => (number|null)} s.ownRid our process's integrity RID
 */
function decideBlocked(s) {
  if (s.inputDesktop === false) return 'secure-desktop';
  if (typeof s.inputDesktop === 'string' && s.inputDesktop) {
    const own = typeof s.ownDesktop === 'string' && s.ownDesktop ? s.ownDesktop : 'Default';
    if (s.inputDesktop.toLowerCase() !== own.toLowerCase()) return 'secure-desktop';
  }
  const target = s.targetRid();
  if (target === 'denied') return 'elevated-window';
  if (!Number.isInteger(target)) return null;
  const own = s.ownRid();
  if (!Number.isInteger(own)) return null;
  return target > own ? 'elevated-window' : null;
}

/**
 * Converts fractional DOM pixel deltas into integer wheel units, carrying the remainder so slow
 * trackpad scrolling is not lost. A direction change discards the old remainder.
 */
function createWheelAccumulator(unitsPerPx = WHEEL_DELTA / CSS_PX_PER_NOTCH) {
  let acc = 0;
  return {
    /** @returns {number} integer units to emit now (may be 0) */
    add(px) {
      const units = px * unitsPerPx;
      if (units === 0 || !Number.isFinite(units)) return 0;
      if (acc !== 0 && Math.sign(acc) !== Math.sign(units)) acc = 0;
      acc += units;
      // The epsilon absorbs binary floating-point drift (10 × 0.6 = 5.999…), which would otherwise
      // emit a whole unit one event late.
      const whole = Math.trunc(acc + Math.sign(acc) * 1e-9) || 0; // `|| 0` turns -0 into 0
      acc -= whole;
      return whole;
    },
    reset() { acc = 0; },
    get remainder() { return acc; },
  };
}

// ---------------------------------------------------------------------------------------------
// Native layer
// ---------------------------------------------------------------------------------------------

let nativeCache = null;

/**
 * Loads koffi + user32 and declares the functions. Throws if anything is missing or if the INPUT
 * layout does not match the platform ABI (never call SendInput with a wrong cbSize).
 * Declaring functions has no side effects; nothing is called here.
 */
function loadNative() {
  if (nativeCache) return nativeCache;
  if (process.platform !== 'win32') throw new Error('win32 input backend requires Windows');
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');

  // Anonymous types on purpose: koffi type names are process-global and duplicates throw.
  const MOUSEINPUT = koffi.struct({
    dx: 'int32_t', // LONG
    dy: 'int32_t',
    mouseData: 'int32_t', // DWORD in WinUser.h; declared signed so negative wheel deltas marshal directly
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t', // ULONG_PTR
  });
  const KEYBDINPUT = koffi.struct({
    wVk: 'uint16_t',
    wScan: 'uint16_t',
    dwFlags: 'uint32_t',
    time: 'uint32_t',
    dwExtraInfo: 'uintptr_t',
  });
  const HARDWAREINPUT = koffi.struct({ uMsg: 'uint32_t', wParamL: 'uint16_t', wParamH: 'uint16_t' });
  const INPUT = koffi.struct({
    type: 'uint32_t',
    u: koffi.union({ mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }),
  });

  const ptrSize = koffi.sizeof('void *');
  const expected = ptrSize === 8 ? 40 : 28; // x64/arm64: 4 + 4 pad + 32; ia32: 4 + 24
  const cbSize = koffi.sizeof(INPUT);
  if (cbSize !== expected) throw new Error(`unexpected sizeof(INPUT)=${cbSize}, expected ${expected}`);

  // __stdcall only matters on ia32; koffi ignores it elsewhere.
  const SendInput = user32.func('__stdcall', 'SendInput', 'uint32_t', ['uint32_t', koffi.pointer(INPUT), 'int32_t']);
  const GetSystemMetrics = user32.func('__stdcall', 'GetSystemMetrics', 'int32_t', ['int32_t']);
  const MapVirtualKeyW = user32.func('__stdcall', 'MapVirtualKeyW', 'uint32_t', ['uint32_t', 'uint32_t']);

  nativeCache = { koffi, user32, INPUT, cbSize, SendInput, GetSystemMetrics, MapVirtualKeyW };
  return nativeCache;
}

let extrasCache; // undefined = not loaded yet; null = unavailable

/**
 * Read-only helpers (no input is injected by any of them), returning plain JS values:
 *   inputDesktop() → name | false (cannot open the input desktop) | null (name unknown)
 *   ownDesktop()   → our thread's desktop name | null
 *   windowPid(pt?) → pid of the root window under pt (physical px) or of the foreground window; 0 = none
 *   rootOwnerAt(pt) → HWND (BigInt) of the root owner of the window under pt (physical px) | null
 *   processRid(pid | 'self') → integrity RID | 'denied' (ERROR_ACCESS_DENIED) | null
 *   monitorRect(pt) → exact physical rcMonitor of the monitor nearest pt | null
 *   keyToggled(vk) → bool (GetKeyState low bit)
 * Every handle opened here is closed in a finally block. GetLastError is reliable through koffi: it
 * saves/restores the thread's last-error value around each call.
 * @returns {object|null} null when the declarations fail (injection does not depend on these)
 */
function loadExtras() {
  if (extrasCache !== undefined) return extrasCache;
  extrasCache = null;
  try {
    const { koffi, user32 } = loadNative();
    const kernel32 = koffi.load('kernel32.dll');
    const advapi32 = koffi.load('advapi32.dll');
    const P = 'void *'; // HANDLE / HDESK / HWND / HMONITOR (BigInt or null)
    const BOOL = 'int32_t'; // Win32 BOOL is a 4-byte int, not C++ bool
    const POINT = koffi.struct({ x: 'int32_t', y: 'int32_t' }); // anonymous: koffi type names are process-global
    const OUT_U32 = koffi.out(koffi.pointer('uint32_t'));
    const OUT_PTR = koffi.out(koffi.pointer(P));
    const fn = (lib, name, ret, args) => lib.func('__stdcall', name, ret, args);

    const OpenInputDesktop = fn(user32, 'OpenInputDesktop', P, ['uint32_t', BOOL, 'uint32_t']);
    const GetThreadDesktop = fn(user32, 'GetThreadDesktop', P, ['uint32_t']);
    const CloseDesktop = fn(user32, 'CloseDesktop', BOOL, [P]);
    const GetUserObjectInformationW = fn(user32, 'GetUserObjectInformationW', BOOL, [P, 'int32_t', P, 'uint32_t', OUT_U32]);
    const WindowFromPoint = fn(user32, 'WindowFromPoint', P, [POINT]); // POINT by value
    const GetAncestor = fn(user32, 'GetAncestor', P, [P, 'uint32_t']);
    const GetForegroundWindow = fn(user32, 'GetForegroundWindow', P, []);
    const GetWindowThreadProcessId = fn(user32, 'GetWindowThreadProcessId', 'uint32_t', [P, OUT_U32]);
    const MonitorFromPoint = fn(user32, 'MonitorFromPoint', P, [POINT, 'uint32_t']);
    const GetMonitorInfoW = fn(user32, 'GetMonitorInfoW', BOOL, [P, P]);
    const GetKeyState = fn(user32, 'GetKeyState', 'int16_t', ['int32_t']);
    const GetCurrentThreadId = fn(kernel32, 'GetCurrentThreadId', 'uint32_t', []);
    const GetCurrentProcess = fn(kernel32, 'GetCurrentProcess', P, []);
    const OpenProcess = fn(kernel32, 'OpenProcess', P, ['uint32_t', BOOL, 'uint32_t']);
    const CloseHandle = fn(kernel32, 'CloseHandle', BOOL, [P]);
    const GetLastError = fn(kernel32, 'GetLastError', 'uint32_t', []);
    const OpenProcessToken = fn(advapi32, 'OpenProcessToken', BOOL, [P, 'uint32_t', OUT_PTR]);
    const GetTokenInformation = fn(advapi32, 'GetTokenInformation', BOOL, [P, 'int32_t', P, 'uint32_t', OUT_U32]);

    const toPoint = (pt) => ({ x: Math.round(pt.x), y: Math.round(pt.y) });

    function desktopName(h) {
      const buf = Buffer.alloc(520); // desktop names are ≤ MAX_PATH characters
      const need = [0];
      if (!GetUserObjectInformationW(h, UOI_NAME, buf, buf.length, need)) return null;
      return utf16z(buf);
    }

    function tokenRid(hProcess) {
      const tok = [null];
      if (!OpenProcessToken(hProcess, TOKEN_QUERY, tok)) return GetLastError() === ERROR_ACCESS_DENIED ? 'denied' : null;
      if (!tok[0]) return null;
      try {
        const buf = Buffer.alloc(64); // TOKEN_MANDATORY_LABEL (8/16 B) + one-sub-authority SID (12 B)
        const len = [0];
        if (!GetTokenInformation(tok[0], TOKEN_INTEGRITY_LEVEL, buf, buf.length, len)) return null;
        const sid = koffi.decode(buf, P); // Label.Sid points into buf
        if (sid === null || sid === undefined) return null;
        const offset = Number(BigInt(sid) - BigInt(koffi.address(buf)));
        return integrityRid(buf, Math.min(len[0] >>> 0, buf.length), offset);
      } finally {
        CloseHandle(tok[0]);
      }
    }

    extrasCache = {
      inputDesktop() {
        const h = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if (!h) return false;
        try { return desktopName(h); } finally { CloseDesktop(h); }
      },
      ownDesktop() {
        const h = GetThreadDesktop(GetCurrentThreadId()); // not to be closed
        return h ? desktopName(h) : null;
      },
      windowPid(pt) {
        let hwnd = pt ? WindowFromPoint(toPoint(pt)) : GetForegroundWindow();
        if (!hwnd) return 0;
        if (pt) hwnd = GetAncestor(hwnd, GA_ROOT) || hwnd;
        const pid = [0];
        if (!GetWindowThreadProcessId(hwnd, pid)) return 0;
        return pid[0] >>> 0;
      },
      rootOwnerAt(pt) {
        const hwnd = WindowFromPoint(toPoint(pt));
        if (!hwnd) return null;
        const root = GetAncestor(hwnd, GA_ROOTOWNER) || hwnd;
        return typeof root === 'bigint' ? root : undefined; // unexpected type: "unknown", never "no window"
      },
      processRid(pid) {
        if (pid === 'self') return tokenRid(GetCurrentProcess()); // pseudo-handle: never closed
        const h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid >>> 0);
        if (!h) return GetLastError() === ERROR_ACCESS_DENIED ? 'denied' : null;
        try { return tokenRid(h); } finally { CloseHandle(h); }
      },
      monitorRect(pt) {
        const hmon = MonitorFromPoint(toPoint(pt), MONITOR_DEFAULTTONEAREST);
        if (!hmon) return null;
        const buf = Buffer.alloc(MONITORINFOEXW_SIZE);
        buf.writeUInt32LE(MONITORINFOEXW_SIZE, 0); // cbSize
        if (!GetMonitorInfoW(hmon, buf)) return null;
        return monitorInfoRect(buf);
      },
      keyToggled(vkCode) {
        return (GetKeyState(vkCode) & 1) === 1;
      },
    };
  } catch (err) {
    extrasCache = null;
    try { console.warn('[input] win32 probe helpers unavailable:', err && err.message ? err.message : String(err)); } catch { /* ignore */ }
  }
  return extrasCache;
}

// ---------------------------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------------------------

/**
 * @param {object} [native] injected native layer (tests): { SendInput(n, inputs, cbSize), GetSystemMetrics(i),
 *                          MapVirtualKeyW(code, type), cbSize, extras? } — `extras` fakes loadExtras()
 */
function createBackend(native) {
  const nat = native || loadNative();
  const extras = native ? () => native.extras || null : loadExtras;
  const wheelV = createWheelAccumulator();
  const wheelH = createWheelAccumulator();
  const downFlags = new Map(); // DOM button → {flags,data} used for its *down*, so the up matches
  let lastBlockedLog = 0;
  let shortfall = false; // SendInput inserted fewer events than requested (see takeShortfall)
  let ownRid; // our integrity RID, read once (undefined = not yet)

  function send(inputs) {
    let sent = 0;
    for (let i = 0; i < inputs.length; i += MAX_INPUTS_PER_CALL) {
      const chunk = inputs.length <= MAX_INPUTS_PER_CALL ? inputs : inputs.slice(i, i + MAX_INPUTS_PER_CALL);
      const n = nat.SendInput(chunk.length, chunk, nat.cbSize) >>> 0;
      sent += n;
      if (n !== chunk.length) {
        shortfall = true;
        const now = Date.now();
        if (now - lastBlockedLog > 10000) {
          lastBlockedLog = now;
          console.warn(`[input] SendInput inserted ${n}/${chunk.length} events (blocked by UIPI or secure desktop?)`);
        }
        break;
      }
    }
    return sent;
  }

  function virtualScreen() {
    return {
      x: nat.GetSystemMetrics(SM.XVIRTUALSCREEN),
      y: nat.GetSystemMetrics(SM.YVIRTUALSCREEN),
      width: nat.GetSystemMetrics(SM.CXVIRTUALSCREEN),
      height: nat.GetSystemMetrics(SM.CYVIRTUALSCREEN),
    };
  }

  function hasPoint(px, py) {
    return typeof px === 'number' && typeof py === 'number' && Number.isFinite(px) && Number.isFinite(py);
  }

  const mapScan = (vkCode) => nat.MapVirtualKeyW(vkCode, MAPVK_VK_TO_VSC);

  return {
    platform: 'win32',

    check() {
      return { available: true, reason: null };
    },

    moveTo(px, py) {
      if (!hasPoint(px, py)) return;
      // Metrics are re-read on every move: cheap user32 reads, and always right after display changes.
      send([moveInput(px, py, virtualScreen())]);
    },

    button(b, down, px, py) {
      let bf;
      if (down) {
        bf = buttonFlags(b, true, nat.GetSystemMetrics(SM.SWAPBUTTON) !== 0);
        if (!bf) return;
        downFlags.set(b, bf);
      } else {
        const d = downFlags.get(b);
        downFlags.delete(b);
        // Release the same physical button we pressed even if SM_SWAPBUTTON changed meanwhile.
        bf = d ? buttonFlags(b, false, isSwappedFlags(b, d)) : buttonFlags(b, false, nat.GetSystemMetrics(SM.SWAPBUTTON) !== 0);
        if (!bf) return;
      }
      const inputs = [];
      if (hasPoint(px, py)) inputs.push(moveInput(px, py, virtualScreen()));
      inputs.push(mouseInput(0, 0, bf.data, bf.flags));
      send(inputs);
    },

    scroll(dx, dy) {
      const inputs = [];
      // DOM dy > 0 = scroll down = negative WHEEL delta; DOM dx > 0 = scroll right = positive HWHEEL.
      const v = wheelV.add(-dy);
      const h = wheelH.add(dx);
      if (v !== 0) inputs.push(mouseInput(0, 0, v, MOUSEEVENTF.WHEEL));
      if (h !== 0) inputs.push(mouseInput(0, 0, h, MOUSEEVENTF.HWHEEL));
      if (inputs.length) send(inputs);
    },

    key(code, down /* , repeat — Windows auto-repeat is simply another key-down */) {
      const desc = keymap.winKey(code);
      if (!desc) return false;
      send([keyInputFor(desc, down, mapScan)]);
      return true;
    },

    text(str) {
      if (typeof str !== 'string' || !str) return;
      send(unicodeInputs(str));
    },

    reset() {
      wheelV.reset();
      wheelH.reset();
      downFlags.clear();
    },

    /**
     * Taps the unassigned VK 0xE8 (down+up in one SendInput). Windows opens the menu bar
     * (SC_KEYMENU / Office KeyTips) or the Start menu when Alt / Win go down and up with nothing in
     * between; index.js sends this before releasing a held Alt/Win in releaseAll(), never for a
     * genuine `ku` (an intentional remote Alt tap must still open menus).
     */
    mask() {
      send(maskInputs());
    },

    /**
     * Caps Lock / Num Lock resync tap (index.js syncLocks): VK_CAPITAL / VK_NUMLOCK down+up in one
     * SendInput, by virtual key (see lockTapInputs). The viewer's own CapsLock key stays a scancode.
     * @param {'caps'|'num'} kind
     * @returns {boolean} false for an unknown kind (nothing sent)
     */
    tapLock(kind) {
      const inputs = lockTapInputs(kind, mapScan);
      if (!inputs) return false;
      send(inputs);
      return true;
    },

    /** @returns {boolean} whether SendInput inserted fewer events than requested since the last call */
    takeShortfall() {
      const s = shortfall;
      shortfall = false;
      return s;
    },

    /**
     * Top-level window (root owner) under a physical point, for the session-UI pointer guard.
     * @param {{x:number,y:number}} pt physical px
     * @returns {bigint|null|undefined} HWND; null = no window there; undefined = cannot tell (no probe helpers)
     */
    windowAt(pt) {
      const ex = extras();
      if (!ex || typeof ex.rootOwnerAt !== 'function') return undefined;
      if (!pt || !hasPoint(pt.x, pt.y)) return undefined;
      try { return ex.rootOwnerAt({ x: pt.x, y: pt.y }); } catch { return undefined; }
    },

    /**
     * Why injected input cannot reach its target (read-only probe; never throws).
     * @param {{x:number,y:number}|null} [pt] physical px → root window under it; null → foreground window
     * @returns {'secure-desktop'|'elevated-window'|null}
     */
    blockedReason(pt) {
      try {
        const ex = extras();
        if (!ex) return null;
        const target = pt && hasPoint(pt.x, pt.y) ? { x: pt.x, y: pt.y } : null;
        return decideBlocked({
          inputDesktop: ex.inputDesktop(),
          ownDesktop: ex.ownDesktop(),
          targetRid: () => {
            const pid = ex.windowPid(target);
            if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null;
            return ex.processRid(pid);
          },
          ownRid: () => {
            if (ownRid === undefined) {
              const r = ex.processRid('self');
              ownRid = Number.isInteger(r) ? r : null;
            }
            return ownRid;
          },
        });
      } catch {
        return null;
      }
    },

    /** @returns {{caps:boolean, num:boolean}|null} host Caps Lock / Num Lock toggle state */
    lockState() {
      try {
        const ex = extras();
        if (!ex) return null;
        const caps = ex.keyToggled(VK_CAPITAL);
        const num = ex.keyToggled(VK_NUMLOCK);
        if (typeof caps !== 'boolean' || typeof num !== 'boolean') return null;
        return { caps, num };
      } catch {
        return null;
      }
    },

    /**
     * Exact physical rcMonitor of the monitor at `pt` (MonitorFromPoint, nearest). Unlike
     * screen.dipToScreenRect it does not round outward (2560 px @150 % stays 2560, not 2561).
     * @returns {{x,y,width,height}|null}
     */
    monitorRect(pt) {
      if (!pt || !hasPoint(pt.x, pt.y)) return null;
      try {
        const ex = extras();
        const r = ex ? ex.monitorRect({ x: pt.x, y: pt.y }) : null;
        if (!r || ![r.x, r.y, r.width, r.height].every(Number.isInteger) || r.width < 1 || r.height < 1) return null;
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      } catch {
        return null;
      }
    },
  };
}

/** Recover the swap state that produced a stored *down* flag set for primary/secondary buttons. */
function isSwappedFlags(b, bf) {
  if (b !== 0 && b !== 2) return false;
  const physicalLeft = bf.flags === MOUSEEVENTF.LEFTDOWN;
  return (b === 0) !== physicalLeft;
}

module.exports = {
  createBackend,
  loadNative,
  loadExtras,
  constants: Object.freeze({ INPUT_MOUSE, INPUT_KEYBOARD, MOUSEEVENTF, KEYEVENTF, XBUTTON1, XBUTTON2, WHEEL_DELTA, CSS_PX_PER_NOTCH, SM, EXTRA_INFO, VK_MASK, VK_CAPITAL, VK_NUMLOCK }),
  _pure: {
    mouseInput, keyInput, normalize, moveInput, buttonFlags, keyInputFor, unicodeInputs, createWheelAccumulator,
    maskInputs, lockTapInputs, integrityRid, utf16z, monitorInfoRect, decideBlocked,
  },
};
