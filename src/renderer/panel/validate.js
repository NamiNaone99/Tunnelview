/*
 * Tunnelview host panel — validation of everything that reaches the panel from the remote viewer
 * (signaling via main, data-channel messages) and from main. Pure functions, no DOM.
 * Contract: docs/ARCHITECTURE.md §4 (sdp/ice), §5 (input/control channels).
 *
 * Every sanitizer returns a NEW object containing only known fields with checked types
 * (never the peer's object itself), or null when the message must be dropped.
 */
const P = globalThis.TunnelviewProtocol;
if (!P) throw new Error('Tunnelview: ../../shared/protocol.js must be loaded before panel/validate.js');
const I = P.INPUT;

const CODE_RE = /^[A-Za-z0-9]{1,32}$/; // KeyboardEvent.code values ("KeyA", "NumpadEnter", "F13")
const MAX_KEY_LEN = 32; // KeyboardEvent.key ("a", "Enter", "AudioVolumeMute", …)
const MAX_COMBO = 8;
const MAX_WHEEL = 10_000; // CSS px per message
const MAX_CLICKS = 3;
const MAX_SDP = 256 * 1024;
const MAX_CANDIDATE = 2048;
const MAX_MID = 64;
const MAX_UFRAG = 256;
const MAX_DISPLAY_ID = 128;

const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const unit = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** One `input` data-channel message → clean copy or null (§5 input table). */
export function sanitizeInput(m) {
  if (!m || typeof m !== 'object') return null;
  const t = m.t;
  switch (t) {
    case I.MOUSE_MOVE:
      return finite(m.x) && finite(m.y) ? { t, x: unit(m.x), y: unit(m.y) } : null;
    case I.MOUSE_DOWN:
    case I.MOUSE_UP: {
      if (!Number.isInteger(m.b) || m.b < 0 || m.b > 4 || !finite(m.x) || !finite(m.y)) return null;
      const n = Number.isInteger(m.n) && m.n >= 1 ? Math.min(m.n, MAX_CLICKS) : 1;
      return { t, b: m.b, x: unit(m.x), y: unit(m.y), n };
    }
    case I.WHEEL:
      if (!finite(m.dx) || !finite(m.dy)) return null;
      return { t, dx: clamp(m.dx, -MAX_WHEEL, MAX_WHEEL), dy: clamp(m.dy, -MAX_WHEEL, MAX_WHEEL) };
    case I.KEY_DOWN:
    case I.KEY_UP: {
      if (typeof m.code !== 'string' || !CODE_RE.test(m.code)) return null;
      const key = typeof m.key === 'string' && m.key.length <= MAX_KEY_LEN ? m.key : '';
      if (t !== I.KEY_DOWN) return { t, code: m.code, key };
      const out = { t, code: m.code, key, rep: m.rep === true };
      // Viewer's CapsLock/NumLock state, so the host can resync its lock keys (optional).
      const l = m.locks;
      if (l && typeof l === 'object' && !Array.isArray(l) && typeof l.caps === 'boolean') {
        out.locks = { caps: l.caps };
        if (typeof l.num === 'boolean') out.locks.num = l.num;
      }
      return out;
    }
    case I.TEXT:
      return typeof m.text === 'string' && m.text.length > 0 && m.text.length <= I.MAX_TEXT ? { t, text: m.text } : null;
    case I.COMBO: {
      const codes = m.codes;
      if (!Array.isArray(codes) || codes.length === 0 || codes.length > MAX_COMBO) return null;
      if (!codes.every((c) => typeof c === 'string' && CODE_RE.test(c))) return null;
      return { t, codes: codes.slice() };
    }
    case I.RELEASE_ALL:
      return { t };
    default:
      return null;
  }
}

function optString(v, max) {
  if (v === null || v === undefined) return null;
  return typeof v === 'string' && v.length <= max ? v : undefined;
}

/** Signaling from the viewer (forwarded by main) → {t:'sdp', description} | {t:'ice', candidate} | null. */
export function sanitizeSignal(m) {
  if (!m || typeof m !== 'object') return null;
  if (m.t === P.MSG.SDP) {
    const d = m.description;
    if (!d || typeof d !== 'object') return null;
    if (d.type !== 'offer' && d.type !== 'answer' && d.type !== 'pranswer') return null;
    if (typeof d.sdp !== 'string' || d.sdp.length === 0 || d.sdp.length > MAX_SDP || !d.sdp.startsWith('v=0')) return null;
    return { t: P.MSG.SDP, description: { type: d.type, sdp: d.sdp } };
  }
  if (m.t === P.MSG.ICE) {
    const c = m.candidate;
    if (c === null || c === undefined) return { t: P.MSG.ICE, candidate: null };
    if (typeof c !== 'object') return null;
    if (typeof c.candidate !== 'string' || c.candidate.length > MAX_CANDIDATE) return null;
    const sdpMid = optString(c.sdpMid, MAX_MID);
    if (sdpMid === undefined) return null;
    let sdpMLineIndex = null;
    if (c.sdpMLineIndex !== null && c.sdpMLineIndex !== undefined) {
      if (!Number.isInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 1023) return null;
      sdpMLineIndex = c.sdpMLineIndex;
    }
    const usernameFragment = optString(c.usernameFragment, MAX_UFRAG);
    if (usernameFragment === undefined) return null;
    if (c.candidate !== '' && sdpMid === null && sdpMLineIndex === null) return null;
    return { t: P.MSG.ICE, candidate: { candidate: c.candidate, sdpMid, sdpMLineIndex, usernameFragment } };
  }
  return null;
}

/** {control,clipboard,files,audio} with strict booleans, or null when the shape is wrong. */
export function sanitizePermissions(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {};
  for (const k of P.PERMISSION_KEYS) out[k] = p[k] === true;
  return out;
}

/** Display id from a `select-display` message → string or null. */
export function sanitizeDisplayId(id) {
  if (typeof id === 'number' && Number.isSafeInteger(id)) return String(id);
  if (typeof id === 'string' && id.length > 0 && id.length <= MAX_DISPLAY_ID) return id;
  return null;
}

/** Display as sent on the control channel (§5 `displays`): only the documented fields. */
export function publicDisplay(d) {
  const n = (v) => (finite(v) ? v : 0);
  return {
    id: String(d.id),
    name: typeof d.name === 'string' ? d.name.slice(0, 128) : '',
    primary: d.primary === true,
    width: Math.round(n(d.width)),
    height: Math.round(n(d.height)),
    scaleFactor: n(d.scaleFactor) || 1,
  };
}

/* ------------------------------------------------------------------------------------------------
 * Clipboard text on the control channel (§5): {t:'clipboard', kind:'text', text, part?:{id, seq, last}}
 * A message whose JSON exceeds CLIPBOARD_SINGLE_MAX_BYTES (UTF-8) is sent as ≤ CLIPBOARD_MAX_PARTS
 * parts of ≤ CLIPBOARD_CHUNK_CHARS UTF-16 units each (a data-channel message is ≤ 256 KiB).
 * ---------------------------------------------------------------------------------------------- */

const C = P.CONTROL;
export const CLIPBOARD_SINGLE_MAX_BYTES = C.CLIPBOARD_SINGLE_MAX_BYTES || 240_000;
export const CLIPBOARD_CHUNK_CHARS = C.CLIPBOARD_CHUNK_CHARS || 40_000;
export const CLIPBOARD_MAX_PARTS = C.CLIPBOARD_MAX_PARTS || 16;
const CLIPBOARD_IDLE_MS = 10_000;
const PART_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** Control-channel clipboard message → clean copy ({t, kind, text, part?}) or null. */
export function sanitizeClipboard(m) {
  if (!m || typeof m !== 'object' || m.kind !== 'text') return null;
  if (typeof m.text !== 'string' || m.text.length === 0) return null;
  if (m.part === undefined || m.part === null) {
    return m.text.length <= C.MAX_CLIPBOARD_TEXT ? { t: C.CLIPBOARD, kind: 'text', text: m.text } : null;
  }
  const p = m.part;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  if (typeof p.id !== 'string' || !PART_ID_RE.test(p.id)) return null;
  if (!Number.isInteger(p.seq) || p.seq < 0 || p.seq >= CLIPBOARD_MAX_PARTS) return null;
  if (typeof p.last !== 'boolean' || m.text.length > CLIPBOARD_CHUNK_CHARS) return null;
  return { t: C.CLIPBOARD, kind: 'text', text: m.text, part: { id: p.id, seq: p.seq, last: p.last } };
}

/** Split text into pieces of ≤ maxUnits UTF-16 units without separating a surrogate pair. */
export function splitClipboardText(text, maxUnits = CLIPBOARD_CHUNK_CHARS) {
  const out = [];
  const max = Math.max(2, Math.floor(maxUnits));
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + max, text.length);
    if (end < text.length) {
      const c = text.charCodeAt(end - 1);
      if (c >= 0xd800 && c <= 0xdbff) end -= 1; // high surrogate: keep it with its low half
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

/** Random part id: 16 chars of [A-Za-z0-9]. */
export function clipboardPartId() {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => abc[x % abc.length]).join('');
}

/**
 * Reassembles chunked clipboard text. One partial at a time: seq 0 starts a new one (discarding any
 * other), every later part must carry the same id and the next seq; anything else, a 10 s idle gap
 * or a total above maxChars discards the partial.
 */
export class ClipboardAssembler {
  constructor({ maxChars = C.MAX_CLIPBOARD_TEXT, idleMs = CLIPBOARD_IDLE_MS, now = Date.now } = {}) {
    this.maxChars = maxChars;
    this.idleMs = idleMs;
    this.now = now;
    this.reset();
  }

  reset() {
    this.id = null;
    this.parts = [];
    this.length = 0;
    this.next = 0;
    this.ts = 0;
  }

  /** @param msg sanitized message with `part` @returns {string|null} the whole text once the last part arrived */
  push(msg) {
    const t = this.now();
    const { id, seq, last } = msg.part;
    if (this.id !== null && t - this.ts > this.idleMs) this.reset();
    if (seq === 0) {
      this.reset();
      this.id = id;
    } else if (id !== this.id || seq !== this.next) {
      this.reset();
      return null;
    }
    if (this.length + msg.text.length > this.maxChars) {
      this.reset();
      return null;
    }
    this.parts.push(msg.text);
    this.length += msg.text.length;
    this.next = seq + 1;
    this.ts = t;
    if (!last) return null;
    const text = this.parts.join('');
    this.reset();
    return text;
  }
}

/** Token bucket: take() → false once more than `burst` events arrive faster than `perSec`. */
export class RateLimiter {
  constructor(perSec, burst = perSec) {
    this.rate = perSec / 1000;
    this.burst = burst;
    this.tokens = burst;
    this.ts = Date.now();
  }

  take() {
    const t = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + (t - this.ts) * this.rate);
    this.ts = t;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
