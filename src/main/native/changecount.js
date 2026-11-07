'use strict';
/*
 * Clipboard change counter (ARCHITECTURE §2 native/changecount.js), used by clipboard.js to detect
 * clipboard changes cheaply without reading the contents on every poll.
 *
 *   const changecount = require('./native/changecount');
 *   changecount.get()  → number | null   (null = unsupported/unavailable → caller falls back to content polling)
 *
 * Windows: user32!GetClipboardSequenceNumber() — DWORD incremented on every clipboard change in the
 *          window station. Returns 0 when the caller lacks WINSTA_ACCESSCLIPBOARD; we map 0 → null.
 * macOS:   [[NSPasteboard generalPasteboard] changeCount] through the Objective-C runtime
 *          (/usr/lib/libobjc.A.dylib). objc_msgSend is a trampoline that must be called through a
 *          prototype matching the target method exactly (critical on arm64, where it is NOT variadic),
 *          so it is declared twice:
 *            id        objc_msgSend(id self, SEL op)   // +[NSPasteboard generalPasteboard]
 *            NSInteger objc_msgSend(id self, SEL op)   // -[NSPasteboard changeCount]  (NSInteger = int64 on LP64)
 *          AppKit is loaded first so the NSPasteboard class is registered (Electron already links it;
 *          the load is then just a reference-count bump). Must be called on the main thread — the
 *          Electron main process JS thread is the Cocoa main thread.
 *
 * Lazy init on first get(); never throws. A failed init is not retried (the platform will not change).
 */

let impl; // undefined = not initialised; null = unsupported; otherwise () => number|null

function initWin32() {
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const GetClipboardSequenceNumber = user32.func('__stdcall', 'GetClipboardSequenceNumber', 'uint32_t', []);
  return () => {
    const n = GetClipboardSequenceNumber() >>> 0;
    return n === 0 ? null : n;
  };
}

function initDarwin() {
  const koffi = require('koffi');
  const libobjc = koffi.load('/usr/lib/libobjc.A.dylib');
  let appkit = null;
  try {
    appkit = koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  } catch { /* already linked by Electron; objc_getClass below decides */ }

  const objc_getClass = libobjc.func('objc_getClass', 'void *', ['str']);
  const sel_registerName = libobjc.func('sel_registerName', 'void *', ['str']);
  const msgSendId = libobjc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const msgSendInteger = libobjc.func('objc_msgSend', 'int64_t', ['void *', 'void *']);

  const NSPasteboard = objc_getClass('NSPasteboard');
  if (!NSPasteboard) throw new Error('NSPasteboard class not found');
  const selGeneral = sel_registerName('generalPasteboard');
  const selChangeCount = sel_registerName('changeCount');
  if (!selGeneral || !selChangeCount) throw new Error('selector registration failed');

  const keepAlive = [libobjc, appkit]; // library handles stay referenced for the process lifetime
  return () => {
    void keepAlive;
    // generalPasteboard returns the shared instance (+0, not owned) — nothing to release.
    const pb = msgSendId(NSPasteboard, selGeneral);
    if (!pb) return null;
    const n = Number(msgSendInteger(pb, selChangeCount));
    return Number.isFinite(n) ? n : null;
  };
}

function init() {
  try {
    if (process.platform === 'win32') return initWin32();
    if (process.platform === 'darwin') return initDarwin();
  } catch (err) {
    try { console.warn('[changecount] unavailable:', err && err.message ? err.message : String(err)); } catch { /* ignore */ }
  }
  return null;
}

/** @returns {number|null} current clipboard change counter, or null when unsupported. */
function get() {
  if (impl === undefined) impl = init();
  if (!impl) return null;
  try {
    return impl();
  } catch {
    return null;
  }
}

module.exports = { get };
