/*
 * Tunnelview viewer — validation of everything that crosses a trust boundary INTO the viewer
 * renderer: signaling relayed by main (originates from the remote host), host status/permission
 * pushes, and `control` data-channel messages sent directly by the remote peer.
 * Pure functions (no DOM); unit-tested from Node in test/viewer-validate.test.js.
 *
 * Protocol constants come from the classic script src/shared/protocol.js (window.TunnelviewProtocol);
 * they are read lazily so tests can install globalThis.TunnelviewProtocol before importing.
 */
import { chunkText } from '../shared/keys.js';

const proto = () => globalThis.TunnelviewProtocol || {};

const MAX_SDP = 1024 * 1024; // = MAX_WS_PAYLOAD; real offers are a few KB
const MAX_CANDIDATE = 2048;
const MAX_DISPLAYS = 32;
const MAX_DISPLAY_ID = 128; // same limit as the host's sanitizeDisplayId
export const MAX_CONTROL_MESSAGE = 2 * 1024 * 1024; // UTF-16 units of the raw JSON string

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// C0/C1 controls, zero-width chars, LRM/RLM/ALM, bidi embeddings/overrides/isolates, BOM.
// A peer-chosen name containing U+202E could visually impersonate another device.
// eslint-disable-next-line no-control-regex
const UNSAFE_LABEL_RE = /[\u0000-\u001f\u007f-\u009f​‌‎‏؜‪-‮⁦-⁩﻿]/g;
// Same, but keeps \n and \t for multi-line chat text.
// eslint-disable-next-line no-control-regex
const UNSAFE_MULTILINE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​‌‎‏؜‪-‮⁦-⁩﻿]/g;

/** Untrusted value → single-line display string (unsafe chars stripped, code-point capped). */
export function cleanLabel(value, max = 80) {
  if (value === null || value === undefined) return '';
  let s = String(value).replace(UNSAFE_LABEL_RE, '').trim();
  if (s.length > max) {
    const cps = Array.from(s);
    if (cps.length > max) s = `${cps.slice(0, Math.max(1, max - 1)).join('')}…`;
  }
  return s;
}

/** Untrusted value → multi-line display string (keeps \n and \t). */
export function cleanMultiline(value, max) {
  if (typeof value !== 'string') return '';
  const s = value.replace(/\r\n?/g, '\n').replace(UNSAFE_MULTILINE_RE, '');
  return s.length > max ? s.slice(0, max) : s;
}

/* ------------------------------------------------------------------------------------------ */
/* Permissions / status                                                                        */
/* ------------------------------------------------------------------------------------------ */

/** {control,clipboard,files,audio} — anything that is not literally `true` is false. */
export function normalizePermissions(p) {
  const src = isObj(p) ? p : {};
  return {
    control: src.control === true,
    clipboard: src.clipboard === true,
    files: src.files === true,
    audio: src.audio === true,
  };
}

const PHASES = new Set(['connecting', 'hello', 'auth-required', 'waiting', 'accepted', 'closed']);
const OSES = new Set(['windows', 'macos', 'linux', 'ios', 'android', 'other']);

export function normalizeOs(os) {
  return typeof os === 'string' && OSES.has(os) ? os : 'other';
}

function normalizeUser(u) {
  if (!isObj(u)) return null;
  const login = cleanLabel(u.login, 120);
  const displayName = cleanLabel(u.displayName, 80);
  return login || displayName ? { login, displayName } : null;
}

function normalizeHost(host) {
  if (!isObj(host)) return null;
  return {
    hostname: cleanLabel(host.hostname, 64),
    os: normalizeOs(host.os),
    user: normalizeUser(host.user),
    passwordSet: host.passwordSet === true,
    acceptMode: host.acceptMode === 'password-only' ? 'password-only' : 'ask',
  };
}

/** Reason codes are short machine strings such as 'denied:busy'. */
export function normalizeReason(reason) {
  if (typeof reason !== 'string') return '';
  const r = reason.trim().slice(0, 64);
  return /^[a-z0-9][a-z0-9:_.-]*$/i.test(r) ? r.toLowerCase() : '';
}

/** ViewerStatus (preload/viewer.js) → sanitized copy, or null when unusable. */
export function normalizeStatus(st) {
  if (!isObj(st) || typeof st.phase !== 'string' || !PHASES.has(st.phase)) return null;
  const out = { phase: st.phase };
  const host = normalizeHost(st.host);
  if (host) out.host = host;
  if (Number.isInteger(st.remaining) && st.remaining >= 0 && st.remaining <= 100) out.remaining = st.remaining;
  if (typeof st.sessionId === 'string' && st.sessionId.length <= 128) out.sessionId = st.sessionId;
  if (own(st, 'permissions')) out.permissions = normalizePermissions(st.permissions);
  if (st.phase === 'closed') {
    out.reason = normalizeReason(st.reason) || 'network';
    out.message = cleanLabel(st.message, 300);
    // The host's own `bye` reason when it ended the session (main-shell contract; see reasons.js).
    const hostReason = normalizeReason(st.hostReason);
    if (hostReason) out.hostReason = hostReason;
  }
  return out;
}

/* ------------------------------------------------------------------------------------------ */
/* Signaling                                                                                   */
/* ------------------------------------------------------------------------------------------ */

function optString(v, max) {
  if (v === null || v === undefined) return { ok: true, value: null };
  if (typeof v !== 'string' || v.length > max) return { ok: false };
  return { ok: true, value: v };
}

/**
 * Host → viewer signaling. The viewer is always the answerer, so only offers are accepted.
 * → {t:'sdp', description:{type:'offer', sdp}} | {t:'ice', candidate:null|{candidate, sdpMid, sdpMLineIndex, usernameFragment}} | null
 */
export function validateSignal(msg) {
  if (!isObj(msg)) return null;
  if (msg.t === 'sdp') {
    const d = msg.description;
    if (!isObj(d) || d.type !== 'offer' || typeof d.sdp !== 'string') return null;
    if (d.sdp.length === 0 || d.sdp.length > MAX_SDP || !d.sdp.startsWith('v=0')) return null;
    return { t: 'sdp', description: { type: 'offer', sdp: d.sdp } };
  }
  if (msg.t === 'ice') {
    const c = msg.candidate;
    if (c === null || c === undefined) return { t: 'ice', candidate: null };
    if (!isObj(c) || typeof c.candidate !== 'string' || c.candidate.length > MAX_CANDIDATE) return null;
    const mid = optString(c.sdpMid, 64);
    const ufrag = optString(c.usernameFragment, 256);
    if (!mid.ok || !ufrag.ok) return null;
    let mline = null;
    if (c.sdpMLineIndex !== null && c.sdpMLineIndex !== undefined) {
      if (!Number.isInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 255) return null;
      mline = c.sdpMLineIndex;
    }
    if (c.candidate !== '' && mid.value === null && mline === null) return null; // unroutable
    return { t: 'ice', candidate: { candidate: c.candidate, sdpMid: mid.value, sdpMLineIndex: mline, usernameFragment: ufrag.value } };
  }
  return null;
}

/**
 * Remove `a=candidate:` lines whose address `isAllowed` rejects (non-Tailscale), in an offer we
 * received or an answer we send. Defense in depth: trickled candidates are filtered separately,
 * but candidates can also ride inside the SDP body.
 */
export function sanitizeSdp(sdp, isAllowed) {
  if (typeof sdp !== 'string') return '';
  const lines = sdp.split(/\r\n|\n/);
  const kept = lines.filter((line) => {
    if (!line.startsWith('a=candidate:')) return true;
    try {
      return !!isAllowed({ candidate: line.slice(2), sdpMid: '0', sdpMLineIndex: 0 });
    } catch {
      return false;
    }
  });
  return kept.join('\r\n');
}

/* ------------------------------------------------------------------------------------------ */
/* `control` data channel (H→V)                                                                */
/* ------------------------------------------------------------------------------------------ */

const INPUT_BLOCKED = new Set(['secure-desktop', 'elevated-window']);

function normalizeDisplay(d, index) {
  if (!isObj(d)) return null;
  if (typeof d.id !== 'string' && !Number.isSafeInteger(d.id)) return null;
  const id = String(d.id);
  if (!id || id.length > MAX_DISPLAY_ID) return null; // never truncate: the id is echoed back in select-display
  const dim = (v) => (Number.isFinite(v) && v > 0 && v <= 65536 ? Math.round(v) : 0);
  const sf = Number.isFinite(d.scaleFactor) && d.scaleFactor >= 0.25 && d.scaleFactor <= 8 ? d.scaleFactor : 1;
  return {
    id,
    name: cleanLabel(d.name, 60) || `Display ${index + 1}`,
    primary: d.primary === true,
    width: dim(d.width),
    height: dim(d.height),
    scaleFactor: sf,
  };
}

/**
 * Parsed `control` message from the HOST → sanitized message, or null to ignore.
 * Types the viewer only sends (select-display, quality) and unknown types are ignored.
 */
export function validateControl(msg) {
  if (!isObj(msg) || typeof msg.t !== 'string') return null;
  const C = proto().CONTROL || {};
  switch (msg.t) {
    case 'displays': {
      if (!Array.isArray(msg.displays)) return null;
      const seen = new Set();
      const displays = [];
      for (const raw of msg.displays.slice(0, MAX_DISPLAYS)) {
        const d = normalizeDisplay(raw, displays.length);
        if (d && !seen.has(d.id)) { seen.add(d.id); displays.push(d); }
      }
      const current = typeof msg.current === 'string' || Number.isSafeInteger(msg.current) ? String(msg.current) : null;
      return { t: 'displays', displays, current: displays.some((d) => d.id === current) ? current : null };
    }
    case 'clipboard': {
      const max = C.MAX_CLIPBOARD_TEXT || 200000;
      if (msg.kind !== 'text' || typeof msg.text !== 'string' || msg.text.length > max) return null;
      if (msg.part === undefined) return { t: 'clipboard', kind: 'text', text: msg.text };
      const part = validateClipboardPart(msg.part);
      if (!part || msg.text.length === 0 || msg.text.length > clipboardLimits().chunkChars) return null;
      return { t: 'clipboard', kind: 'text', text: msg.text, part };
    }
    case 'chat': {
      const max = C.MAX_CHAT || 4000;
      if (typeof msg.text !== 'string' || msg.text.length > max) return null;
      const text = cleanMultiline(msg.text, max).trim();
      if (!text) return null;
      const ts = Number.isFinite(msg.ts) && msg.ts > 0 ? msg.ts : null;
      return { t: 'chat', text, ts };
    }
    case 'host-state': {
      const out = { t: 'host-state' };
      if (typeof msg.audio === 'boolean') out.audio = msg.audio;
      if (typeof msg.controlAllowed === 'boolean') out.controlAllowed = msg.controlAllowed;
      // Why remote input can't reach the host right now (Windows UIPI / secure desktop).
      if (msg.inputBlocked === null || INPUT_BLOCKED.has(msg.inputBlocked)) out.inputBlocked = msg.inputBlocked;
      return out;
    }
    default:
      return null;
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Clipboard text in parts (both directions; same wire format as the host panel)               */
/* ------------------------------------------------------------------------------------------ */

/*
 * Chromium caps one data-channel message at 256 KiB, while both ends accept clipboard text up to
 * MAX_CLIPBOARD_TEXT (200 000) UTF-16 units, so ~90k Thai or ~100k CJK characters do not fit in one
 * message. Such text travels as {t:'clipboard', kind:'text', text, part:{id, seq, last}}: a message
 * is split when its JSON exceeds CLIPBOARD_SINGLE_MAX_BYTES UTF-8 bytes; every part carries at most
 * CLIPBOARD_CHUNK_CHARS UTF-16 units (≤ 6 bytes each once JSON-escaped, so always < 256 KiB) and
 * never half a surrogate pair; the id is 1–32 chars of [A-Za-z0-9_-]; seq counts 0..MAX_PARTS-1;
 * `last` marks the final part.
 */
const PART_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'; // 64 chars

/** Limits (protocol constants when present, else the shared defaults). */
export function clipboardLimits() {
  const C = proto().CONTROL || {};
  return {
    maxChars: C.MAX_CLIPBOARD_TEXT || 200000,
    singleMaxBytes: C.CLIPBOARD_SINGLE_MAX_BYTES || 240000,
    chunkChars: C.CLIPBOARD_CHUNK_CHARS || 40000,
    maxParts: C.CLIPBOARD_MAX_PARTS || 16,
  };
}

/** `part` of a clipboard message → {id, seq, last} or null. */
export function validateClipboardPart(part) {
  if (!isObj(part)) return null;
  if (typeof part.id !== 'string' || !PART_ID_RE.test(part.id)) return null;
  if (!Number.isInteger(part.seq) || part.seq < 0 || part.seq >= clipboardLimits().maxParts) return null;
  if (typeof part.last !== 'boolean') return null;
  return { id: part.id, seq: part.seq, last: part.last };
}

/** Random part id: 16 chars of [A-Za-z0-9_-]. */
export function newClipboardPartId() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ID_ALPHABET[b & 63]).join('');
}

const utf8 = typeof TextEncoder === 'function' ? new TextEncoder() : null;
const utf8Length = (s) => (utf8 ? utf8.encode(s).length : s.length * 3);

/**
 * Local clipboard text → the control messages to send, in order: one message when its JSON fits in
 * CLIPBOARD_SINGLE_MAX_BYTES, otherwise parts. [] when the text is empty or too long.
 * @param {string} text
 * @param {{id?:string}} [opts]  part id (default: random)
 */
export function clipboardMessages(text, opts = {}) {
  const L = clipboardLimits();
  if (typeof text !== 'string' || !text || text.length > L.maxChars) return [];
  const single = { t: 'clipboard', kind: 'text', text };
  // ≤ 6 UTF-8 bytes per UTF-16 unit in JSON (\uXXXX escapes): short text never needs encoding.
  if (text.length * 6 + 64 <= L.singleMaxBytes || utf8Length(JSON.stringify(single)) <= L.singleMaxBytes) return [single];
  const chunks = chunkText(text, L.chunkChars);
  if (chunks.length > L.maxParts) return [];
  const id = typeof opts.id === 'string' && PART_ID_RE.test(opts.id) ? opts.id : newClipboardPartId();
  return chunks.map((chunk, seq) => ({
    t: 'clipboard', kind: 'text', text: chunk, part: { id, seq, last: seq === chunks.length - 1 },
  }));
}

/**
 * Reassembles parted clipboard text from the peer. Parts of one id must arrive with seq 0, 1, 2…;
 * a different id, a gap, more than idleMs since the previous part, or a total above
 * MAX_CLIPBOARD_TEXT discards the partial text. push() returns the whole text when the `last`
 * part arrives, otherwise null.
 */
export class ClipboardAssembler {
  /** @param {{idleMs?:number, now?:() => number}} [o] */
  constructor({ idleMs = 10000, now = () => Date.now() } = {}) {
    this.idleMs = idleMs;
    this.now = now;
    this.cur = null; // { id, next, chunks, len, at }
  }

  reset() {
    this.cur = null;
  }

  /** @param {{text:string, part:{id:string, seq:number, last:boolean}}} msg  validated (validateControl) */
  push(msg) {
    const part = msg && msg.part;
    if (!part || typeof msg.text !== 'string') return null;
    const t = this.now();
    if (this.cur && (this.cur.id !== part.id || t - this.cur.at > this.idleMs)) this.cur = null;
    if (!this.cur) {
      if (part.seq !== 0) return null; // the beginning of this text was lost or discarded
      this.cur = { id: part.id, next: 0, chunks: [], len: 0, at: t };
    }
    const cur = this.cur;
    if (part.seq !== cur.next || cur.len + msg.text.length > clipboardLimits().maxChars) {
      this.cur = null;
      return null;
    }
    cur.chunks.push(msg.text);
    cur.len += msg.text.length;
    cur.next++;
    cur.at = t;
    if (!part.last) return null;
    this.cur = null;
    return cur.chunks.join('');
  }
}

/* ------------------------------------------------------------------------------------------ */
/* ViewerInit                                                                                  */
/* ------------------------------------------------------------------------------------------ */

/** ViewerInit (preload/viewer.js) → sanitized copy with defaults. */
export function normalizeInit(init) {
  const P = proto();
  const src = isObj(init) ? init : {};
  const t = isObj(src.target) ? src.target : {};
  const s = isObj(src.settings) ? src.settings : {};
  const presets = P.QUALITY_PRESETS || ['quality', 'balanced', 'speed'];
  const codecs = P.CODECS || ['auto', 'h264', 'vp9', 'vp8', 'av1'];
  const port = Number.isInteger(t.port) && t.port > 0 && t.port < 65536 ? t.port : P.DEFAULT_PORT || 47800;
  return {
    target: {
      ip: cleanLabel(t.ip, 64),
      port,
      hostname: cleanLabel(t.hostname, 64),
      os: normalizeOs(t.os),
      user: normalizeUser(t.user),
    },
    localOs: src.localOs === 'macos' ? 'macos' : 'windows',
    viewOnly: src.viewOnly === true,
    settings: {
      quality: presets.includes(s.quality) ? s.quality : 'balanced',
      codec: codecs.includes(s.codec) ? s.codec : 'auto',
      clipboardSync: s.clipboardSync !== false,
      swapCmdCtrl: ['auto', 'on', 'off'].includes(s.swapCmdCtrl) ? s.swapCmdCtrl : 'auto',
    },
  };
}
