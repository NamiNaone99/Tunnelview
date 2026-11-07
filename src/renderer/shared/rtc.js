/*
 * Tunnelview — shared WebRTC helpers for the host panel and the viewer.
 * Contract: docs/ARCHITECTURE.md §1.5 (tailnet-only WebRTC), §9 (quality presets), §10 (rtc.js API).
 *
 * Requires the classic script ../../shared/protocol.js to be loaded first (window.TunnelviewProtocol).
 *
 * Security model (§1.5): no STUN/TURN servers, and every ICE candidate — local before it is signalled,
 * remote before it is added — must carry a Tailscale address (100.64.0.0/10 or fd7a:115c:a1e0::/48).
 * mDNS ".local" host candidates are rejected (main disables WebRtcHideLocalIpsWithMdns so Chromium
 * emits real IPs). The host checks every selected candidate pair as soon as ICE picks it
 * (RTCIceTransport 'selectedcandidatepairchange' + pairIsTailnet) and re-checks via getStats().
 */

const P = globalThis.TunnelviewProtocol;
if (!P) throw new Error('Tunnelview: ../../shared/protocol.js must be loaded before rtc.js');

/** No ICE servers: candidates are host candidates on the Tailscale interface only. Deep-frozen. */
export const RTC_CONFIG = Object.freeze({
  iceServers: Object.freeze([]),
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
});

/** Chromium advertises a=max-message-size:262144 for SCTP; larger sends fail. */
export const MAX_MESSAGE_BYTES = 256 * 1024;
const MAX_CANDIDATE_LEN = 2048;
const MAX_JSON_CHARS = P.MAX_WS_PAYLOAD;

/* ------------------------------------------------------------------------------------------------
 * Address parsing (no regex shortcuts: compressed IPv6 forms are fully expanded before comparing)
 * ---------------------------------------------------------------------------------------------- */

const V4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const HEX_GROUP_RE = /^[0-9a-fA-F]{1,4}$/;

/** "a.b.c.d" → [a,b,c,d] | null. Leading zeros are rejected (octal ambiguity). */
export function parseIPv4(s) {
  if (typeof s !== 'string') return null;
  const m = V4_RE.exec(s);
  if (!m) return null;
  const out = [];
  for (let i = 1; i <= 4; i++) {
    const part = m[i];
    if (part.length > 1 && part[0] === '0') return null;
    const n = Number(part);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

/** Any textual IPv6 (incl. "::" compression and a trailing embedded IPv4) → 8 × uint16 | null. */
export function parseIPv6(s) {
  if (typeof s !== 'string' || !s.includes(':') || s.length > 45) return null;
  let str = s;
  // Embedded dotted IPv4 in the last 32 bits, e.g. ::ffff:100.64.0.1 → ::ffff:6440:1
  const lastColon = str.lastIndexOf(':');
  const tail4 = str.slice(lastColon + 1);
  if (tail4.includes('.')) {
    const v4 = parseIPv4(tail4);
    if (!v4) return null;
    str = str.slice(0, lastColon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const dbl = str.indexOf('::');
  if (dbl !== -1 && dbl !== str.lastIndexOf('::')) return null; // at most one "::"
  let head;
  let tail;
  if (dbl === -1) {
    head = str.split(':');
    tail = [];
  } else {
    const h = str.slice(0, dbl);
    const t = str.slice(dbl + 2);
    head = h ? h.split(':') : [];
    tail = t ? t.split(':') : [];
  }
  for (const g of head) if (!HEX_GROUP_RE.test(g)) return null;
  for (const g of tail) if (!HEX_GROUP_RE.test(g)) return null;
  if (dbl === -1) {
    if (head.length !== 8) return null;
  } else if (head.length + tail.length > 7) {
    return null; // "::" must stand for at least one zero group
  }
  const groups = [...head.map((g) => parseInt(g, 16))];
  const zeros = 8 - head.length - tail.length;
  for (let i = 0; i < zeros; i++) groups.push(0);
  for (const g of tail) groups.push(parseInt(g, 16));
  return groups.length === 8 ? groups : null;
}

// Tailscale ranges, derived from the shared protocol constants (not literals).
const TS_V4 = (() => {
  const [base, bitsStr] = P.TS_IPV4_CIDR.split('/');
  const octets = parseIPv4(base);
  const bits = Number(bitsStr);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (v4ToInt(octets) & mask) >>> 0, mask };
})();
const TS_V6_PREFIX = P.TS_IPV6_PREFIX.split(':').filter(Boolean).map((g) => parseInt(g, 16)); // [0xfd7a,0x115c,0xa1e0]

function v4ToInt(o) {
  return ((o[0] * 16777216) + (o[1] << 16) + (o[2] << 8) + o[3]) >>> 0;
}

function isTailscaleV4(octets) {
  return ((v4ToInt(octets) & TS_V4.mask) >>> 0) === TS_V4.net;
}

/** Strip [brackets] and %zone. Returns null for malformed bracket syntax. */
function stripAddress(addr) {
  let s = addr.trim();
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end === -1) return null;
    s = s.slice(1, end);
  }
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);
  return s;
}

/**
 * True iff addr is inside 100.64.0.0/10 or fd7a:115c:a1e0::/48.
 * Accepts brackets, zone ids and IPv4-mapped IPv6 (::ffff:100.x.y.z / ::ffff:6440:…).
 * Hostnames (incl. mDNS "*.local") are never Tailscale addresses here.
 */
export function isTailscaleAddress(addr) {
  if (typeof addr !== 'string' || addr.length === 0 || addr.length > 64) return false;
  const s = stripAddress(addr);
  if (!s) return false;
  const v4 = parseIPv4(s);
  if (v4) return isTailscaleV4(v4);
  const g = parseIPv6(s);
  if (!g) return false;
  // IPv4-mapped: ::ffff:a.b.c.d
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return isTailscaleV4([g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff]);
  }
  for (let i = 0; i < TS_V6_PREFIX.length; i++) if (g[i] !== TS_V6_PREFIX[i]) return false;
  return true;
}

/* ------------------------------------------------------------------------------------------------
 * ICE candidate filtering
 * ---------------------------------------------------------------------------------------------- */

/**
 * Connection address (5th field) of an ICE candidate line:
 *   "candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> …"
 * Accepts an optional "a=" prefix (SDP attribute form). Returns null when malformed.
 */
export function candidateAddress(candidateLine) {
  if (typeof candidateLine !== 'string' || candidateLine.length > MAX_CANDIDATE_LEN) return null;
  let s = candidateLine.trim();
  if (s.startsWith('a=')) s = s.slice(2);
  if (!s.startsWith('candidate:')) return null;
  const f = s.split(/\s+/);
  if (f.length < 8 || f[6] !== 'typ') return null;
  return f[4] || null;
}

/**
 * init = RTCIceCandidateInit | RTCIceCandidate | null.
 * null / missing / '' candidate (end-of-candidates) → true; otherwise the address must be a
 * Tailscale IP (mDNS names, LAN, public, loopback, malformed → false).
 */
export function isAllowedCandidate(init) {
  if (init === null || init === undefined) return true;
  if (typeof init !== 'object') return false;
  const c = init.candidate;
  if (c === undefined || c === null || c === '') return true;
  if (typeof c !== 'string') return false;
  return isTailscaleAddress(candidateAddress(c));
}

/**
 * Remove every "a=candidate:" line whose address is not a Tailscale IP from an SDP blob.
 * (Trickle ICE normally keeps candidates out of the SDP, but pc.localDescription read late — or a
 * peer's answer — may embed them.) Preserves the original line endings.
 */
export function filterSdpCandidates(sdp) {
  if (typeof sdp !== 'string') return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  return sdp
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('a=candidate:') || isTailscaleAddress(candidateAddress(line)))
    .join(eol);
}

/* ------------------------------------------------------------------------------------------------
 * Quality presets (§9)
 * ---------------------------------------------------------------------------------------------- */

export const PRESETS = Object.freeze({
  quality: Object.freeze({
    contentHint: 'detail', maxBitrate: 25_000_000, maxFramerate: 60, scaleResolutionDownBy: 1,
    degradationPreference: 'maintain-resolution',
  }),
  balanced: Object.freeze({
    contentHint: 'detail', maxBitrate: 10_000_000, maxFramerate: 60, scaleResolutionDownBy: 1,
    degradationPreference: 'balanced',
  }),
  // scaleResolutionDownBy here is only the default until the capture size is known: the host then
  // applies speedScaleFor(width, height), so the encoded size stays even (hardware encoders).
  speed: Object.freeze({
    contentHint: 'motion', maxBitrate: 4_000_000, maxFramerate: 60, scaleResolutionDownBy: 2,
    degradationPreference: 'maintain-framerate',
  }),
});

/** RTCRtpEncodingParameters for addTransceiver({sendEncodings:[…]}) from a preset name. */
export function presetEncoding(presetName) {
  const p = PRESETS[presetName] || PRESETS.balanced;
  return { maxBitrate: p.maxBitrate, maxFramerate: p.maxFramerate, scaleResolutionDownBy: p.scaleResolutionDownBy };
}

const SPEED_TARGETS = [1440, 1080, 900, 720, 540]; // short side of the encoded picture, largest first
const SPEED_MIN_SCALE = 1.3;
const SPEED_ASPECT_TOLERANCE = 0.002; // relative aspect-ratio error allowed when no target fits exactly

/**
 * scaleResolutionDownBy (≥ 1) for the 'speed' preset and a capture of width × height, chosen so the
 * encoded size of an even capture is a pair of EVEN integers, never larger than the capture,
 * whether WebRTC rounds or truncates width / s. An odd size (2560×1440 / 1.5 = 1707×960) makes
 * Chromium fall back from the hardware H.264 encoder to OpenH264.
 *  1. An odd side is floored to even first: Chromium reports a transient 2561×1440 before the
 *     capture settles at 2560×1440, and both must give the same scale.
 *  2. Exact: the short side becomes the largest of 1440/1080/900/720/540 that is ≤ short / 1.3 and
 *     keeps the long side an exact even integer (2560×1440 → 1920×1080, 1920×1080 → 1280×720,
 *     3840×2160 → 2560×1440).
 *  3. Otherwise (capped captures of other aspect ratios, e.g. a 16" MacBook Pro 3340×2158 or DCI
 *     3838×2024): the same targets, largest first, with the long side rounded to the nearest even
 *     integer, accepted when the short side still lands on the even target and the aspect ratio
 *     moves by < 0.2 % (3340×2158 → 1672×1080, 3838×2024 → 2048×1080).
 *  4. Failing that 2 when both halves are even, else 1.
 * An unknown size gives the preset default (2).
 */
export function speedScaleFor(width, height) {
  let w = Number(width);
  let h = Number(height);
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) return PRESETS.speed.scaleResolutionDownBy;
  w -= w % 2;
  h -= h % 2;
  if (w === 0 || h === 0) return 1; // a 1-pixel side: nothing to scale
  const short = Math.min(w, h);
  const long = Math.max(w, h);
  for (const t of SPEED_TARGETS) {
    if (t > short / SPEED_MIN_SCALE) continue;
    const n = long * t; // the scaled long side is n / short: it must be an even integer
    if (n % short !== 0 || (n / short) % 2 !== 0) continue;
    const scaledLong = n / short;
    let s = short / t;
    // Never let a quotient land just below its integer (1919.9999… would truncate to an odd size).
    while (long / s < scaledLong || short / s < t) s -= s * Number.EPSILON;
    return s;
  }
  const aspect = long / short;
  for (const t of SPEED_TARGETS) {
    if (t > short / SPEED_MIN_SCALE) continue;
    const scaledLong = 2 * Math.round((long * t) / short / 2); // nearest even long side
    let s = long / scaledLong;
    while (long / s < scaledLong) s -= s * Number.EPSILON;
    const q = short / s;
    const scaledShort = Math.floor(q);
    // Rounding and truncation must agree on an even short side, and the long side must be exact.
    if (scaledShort !== Math.floor(q + 0.5) || scaledShort % 2 !== 0 || Math.floor(long / s) !== scaledLong) continue;
    if (Math.abs(scaledLong / scaledShort - aspect) / aspect >= SPEED_ASPECT_TOLERANCE) continue;
    return s;
  }
  return w % 4 === 0 && h % 4 === 0 ? 2 : 1;
}

/** GoogCC start estimate for a preset (kbps): the preset's max bitrate, capped at 4 Mbps. */
export function presetStartKbps(presetName) {
  const p = PRESETS[presetName] || PRESETS.balanced;
  return Math.min(Math.round(p.maxBitrate / 1000), 4000);
}

/* ------------------------------------------------------------------------------------------------
 * Capture size cap
 * ---------------------------------------------------------------------------------------------- */

const CAPTURE_LONG = 3840;
const CAPTURE_SHORT = 2160;
const EXACT_HALF_MAX_SCALE = 0.55; // fit scale at or below which an exact 2× downsample is used

/**
 * Capture size cap that stays within hardware-encoder limits (some H.264 encoders top out around
 * 4096×2160) for a display given in PHYSICAL pixels ({width, height}). null = no cap needed (fits
 * in 3840×2160, or 2160×3840 for a portrait display). Otherwise the display is scaled down to FIT
 * that box, aspect ratio kept (s = min(boxW / w, boxH / h)), each side floored to an even number.
 * Only when s ≤ 0.55 is an exact 2× downsample used instead (barely smaller than the fit, and an
 * integer ratio keeps text crisp). @returns {{width:number, height:number}|null}
 */
export function captureSizeLimit(display) {
  if (!display || typeof display !== 'object') return null;
  const w = Number(display.width);
  const h = Number(display.height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const portrait = h > w;
  const boxW = portrait ? CAPTURE_SHORT : CAPTURE_LONG;
  const boxH = portrait ? CAPTURE_LONG : CAPTURE_SHORT;
  if (w <= boxW && h <= boxH) return null;
  const s = Math.min(boxW / w, boxH / h);
  let W;
  let H;
  if (s <= EXACT_HALF_MAX_SCALE && w / 2 <= boxW && h / 2 <= boxH) {
    W = w / 2;
    H = h / 2;
  } else if (w * boxH >= h * boxW) {
    // The limiting side is set exactly: h × (boxH / h) can come out as 2159.999… and floor to 2158.
    W = boxW;
    H = (h * boxW) / w;
  } else {
    H = boxH;
    W = (w * boxH) / h;
  }
  const even = (v) => Math.max(2, Math.floor(v / 2) * 2);
  return { width: even(W), height: even(H) };
}

/* ------------------------------------------------------------------------------------------------
 * Answer munging (host side, remote description — always permitted, unlike local SDP munging)
 * ---------------------------------------------------------------------------------------------- */

const START_BITRATE_CODEC_RE = /^(h264|vp8|vp9|av1)$/i; // media codecs only (not rtx/red/ulpfec/flexfec)
const RTPMAP_RE = /^a=rtpmap:(\d+) ([^/\s]+)\/(\d+)(?:\/(\d+))?/;
const FMTP_RE = /^a=fmtp:(\d+)(?: (.*))?$/;

function fmtpKeys(params) {
  const keys = new Set();
  for (const kv of params.split(';')) {
    const k = kv.split('=')[0].trim().toLowerCase();
    if (k) keys.add(k);
  }
  return keys;
}

/**
 * Munge the viewer's ANSWER before the host applies it (setRemoteDescription):
 *  - startKbps > 0: `x-google-start-bitrate=<kbps>` on every H264/VP8/VP9/AV1 payload of every video
 *    m-section, so GoogCC does not start at 300 kbps and pace the first big keyframe out slowly.
 *    A payload without an a=fmtp line (VP8) gets one, right after its a=rtpmap.
 *  - opusStereo: `stereo=1;maxaveragebitrate=128000` on Opus, so stereo loopback audio is not
 *    downmixed to ~32 kbps mono.
 * Keys already present are never duplicated or changed. Line endings are preserved.
 * @param {string} sdp  @param {{startKbps?:number, opusStereo?:boolean}} opts  @returns {string}
 */
export function mungeAnswerForSend(sdp, { startKbps = 0, opusStereo = false } = {}) {
  if (typeof sdp !== 'string' || !sdp) return sdp;
  const kbps = Number.isFinite(startKbps) && startKbps > 0 ? Math.round(startKbps) : 0;
  if (!kbps && !opusStereo) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);

  // Pass 1: per m-section, payload type → codec name, and which payload types have an fmtp line.
  const sections = [];
  const sectionOf = new Array(lines.length);
  let cur = null;
  lines.forEach((line, i) => {
    if (line.startsWith('m=')) {
      cur = { kind: line.slice(2).split(' ')[0], codecs: new Map(), fmtp: new Set() };
      sections.push(cur);
    }
    sectionOf[i] = cur;
    if (!cur) return;
    const r = RTPMAP_RE.exec(line);
    if (r) cur.codecs.set(r[1], r[2]);
    const f = FMTP_RE.exec(line);
    if (f) cur.fmtp.add(f[1]);
  });

  const wanted = (sec, pt) => {
    const name = sec.codecs.get(pt) || '';
    if (sec.kind === 'video' && kbps && START_BITRATE_CODEC_RE.test(name)) {
      return [['x-google-start-bitrate', String(kbps)]];
    }
    if (sec.kind === 'audio' && opusStereo && /^opus$/i.test(name)) {
      return [['stereo', '1'], ['maxaveragebitrate', '128000']];
    }
    return null;
  };

  // Pass 2: extend existing fmtp lines; add missing ones after their rtpmap.
  const out = [];
  lines.forEach((line, i) => {
    const sec = sectionOf[i];
    if (!sec) {
      out.push(line);
      return;
    }
    const f = FMTP_RE.exec(line);
    if (f) {
      const want = wanted(sec, f[1]);
      const params = (f[2] || '').trim();
      const have = fmtpKeys(params);
      const add = want ? want.filter(([k]) => !have.has(k)).map(([k, v]) => `${k}=${v}`) : [];
      out.push(add.length ? `a=fmtp:${f[1]} ${params ? `${params};` : ''}${add.join(';')}` : line);
      return;
    }
    out.push(line);
    const r = RTPMAP_RE.exec(line);
    if (r && !sec.fmtp.has(r[1])) {
      const want = wanted(sec, r[1]);
      if (want) out.push(`a=fmtp:${r[1]} ${want.map(([k, v]) => `${k}=${v}`).join(';')}`);
    }
  });
  return out.join(eol);
}

// getParameters()/setParameters() must not interleave on one sender (stale transactionId →
// InvalidModificationError), so calls are chained per sender.
const paramChains = new WeakMap();

/**
 * Apply a §9 preset to a video RTCRtpSender: track.contentHint + encodings (maxBitrate, maxFramerate,
 * scaleResolutionDownBy) + degradationPreference. opts.scaleResolutionDownBy (finite, ≥ 1) replaces
 * the preset's value (the host passes speedScaleFor(capture size) for 'speed'). Tolerates senders
 * without a track and an empty encodings list (before negotiation). Never throws.
 * @returns {Promise<boolean>} parameters applied
 */
export function applyPreset(sender, presetName, opts = null) {
  const base = PRESETS[presetName] || PRESETS.balanced;
  const scale = opts && Number(opts.scaleResolutionDownBy);
  const preset = Number.isFinite(scale) && scale >= 1 ? { ...base, scaleResolutionDownBy: scale } : base;
  if (!sender) return Promise.resolve(false);
  const track = sender.track;
  if (track && track.kind && track.kind !== 'video') return Promise.resolve(false);
  if (track && 'contentHint' in track) {
    try { if (track.contentHint !== preset.contentHint) track.contentHint = preset.contentHint; } catch { /* read-only on some builds */ }
  }
  if (typeof sender.getParameters !== 'function' || typeof sender.setParameters !== 'function') {
    return Promise.resolve(false);
  }
  const prev = paramChains.get(sender) || Promise.resolve();
  const run = prev.then(() => setSenderParams(sender, preset), () => setSenderParams(sender, preset));
  paramChains.set(sender, run.then(() => undefined, () => undefined));
  return run;
}

async function setSenderParams(sender, preset) {
  const build = (withDegradation) => {
    const params = sender.getParameters();
    // Before negotiation (older Chromium) encodings may be [] — the count cannot be changed, so
    // only the existing entries are updated.
    const encodings = Array.isArray(params.encodings) ? params.encodings : [];
    for (const enc of encodings) {
      enc.maxBitrate = preset.maxBitrate;
      enc.maxFramerate = preset.maxFramerate;
      enc.scaleResolutionDownBy = preset.scaleResolutionDownBy;
    }
    if (withDegradation) params.degradationPreference = preset.degradationPreference;
    else delete params.degradationPreference;
    return params;
  };
  try {
    await sender.setParameters(build(true));
    return true;
  } catch (e1) {
    // degradationPreference in setParameters is newer than the rest; retry without it.
    try {
      await sender.setParameters(build(false));
      return true;
    } catch (e2) {
      console.warn('[rtc] setParameters failed:', (e2 && e2.message) || e2);
      return false;
    }
  }
}

/* ------------------------------------------------------------------------------------------------
 * Codec preferences
 * ---------------------------------------------------------------------------------------------- */

const AUTO_ORDER = ['h264', 'vp9', 'vp8']; // §9: H264 first (usually hardware), then VP9, VP8
const AUX_CODEC_RE = /^video\/(rtx|red|ulpfec|flexfec(-03)?)$/i;

function codecRanking(codec) {
  const c = typeof codec === 'string' ? codec.toLowerCase() : 'auto';
  const names = c !== 'auto' && P.CODECS.includes(c) ? [c, ...AUTO_ORDER.filter((x) => x !== c)] : AUTO_ORDER;
  return names.map((n) => `video/${n}`);
}

function capabilityCodecs(ctor, kind) {
  try {
    const caps = ctor && typeof ctor.getCapabilities === 'function' ? ctor.getCapabilities(kind) : null;
    return caps && Array.isArray(caps.codecs) ? caps.codecs.filter((c) => c && typeof c.mimeType === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Pure ordering helper (exported for tests): preferred codecs first in ranking order, then other
 * media codecs, then codecs this side cannot encode (when `encodable` is given), and the auxiliary
 * rtx/red/ulpfec/flexfec entries last. Stable within a rank; H264 packetization-mode=1 before 0.
 */
export function orderCodecs(codecs, codec = 'auto', encodable = null) {
  const ranking = codecRanking(codec);
  const rank = (c) => {
    const mime = c.mimeType.toLowerCase();
    if (AUX_CODEC_RE.test(mime)) return 10_000;
    const idx = ranking.indexOf(mime);
    let r = idx === -1 ? 1_000 : idx * 10;
    if (encodable && encodable.size && !encodable.has(mime)) r += 5_000;
    if (mime === 'video/h264' && !/packetization-mode=1/.test(c.sdpFmtpLine || '')) r += 1;
    return r;
  };
  return codecs
    .map((c, i) => ({ c, i, r: rank(c) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.c);
}

/**
 * Reorder the transceiver's video codecs: codec = 'auto'|'h264'|'vp9'|'vp8'|'av1'.
 * Nothing is removed (the peer can always fall back). No-op if unsupported. @returns {boolean}
 */
export function preferCodecs(transceiver, codec = 'auto') {
  if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return false;
  const recv = capabilityCodecs(globalThis.RTCRtpReceiver, 'video');
  const send = capabilityCodecs(globalThis.RTCRtpSender, 'video');
  // Current spec/Chromium validate against the *receiver* capabilities; older builds accepted the
  // sender list. For a send-only transceiver a codec we cannot encode is useless, so rank it last.
  const encodable = transceiver.direction === 'sendonly' && send.length
    ? new Set(send.map((c) => c.mimeType.toLowerCase()))
    : null;
  for (const list of [recv, send]) {
    if (!list.length) continue;
    try {
      transceiver.setCodecPreferences(orderCodecs(list, codec, encodable));
      return true;
    } catch (e) {
      console.warn('[rtc] setCodecPreferences failed:', (e && e.message) || e);
    }
  }
  return false;
}

/* ------------------------------------------------------------------------------------------------
 * Stats
 * ---------------------------------------------------------------------------------------------- */

function selectedCandidatePair(report) {
  let pair = null;
  report.forEach((r) => {
    if (!pair && r.type === 'transport' && r.selectedCandidatePairId) {
      const p = report.get(r.selectedCandidatePairId);
      if (p) pair = p;
    }
  });
  if (!pair) {
    report.forEach((r) => {
      if (!pair && r.type === 'candidate-pair' && (r.selected === true || (r.nominated && r.state === 'succeeded'))) pair = r;
    });
  }
  return pair;
}

/** The address string of an RTCIceCandidate / candidate stats entry ('' and non-strings → null). */
function rawAddress(cand) {
  if (!cand) return null;
  const a = cand.address != null ? cand.address : cand.ip; // `ip` = legacy name
  return typeof a === 'string' && a ? a : null;
}

/**
 * The candidate's IP literal (brackets / zone id stripped), or null when it carries none: no
 * address, '' (getStats hides a remote peer-reflexive address), Chromium's 'redacted-ip.invalid'
 * placeholder (getSelectedCandidatePair, same candidate), an mDNS name.
 */
function statsAddress(cand) {
  const a = rawAddress(cand);
  const s = a ? stripAddress(a) : null;
  return s && (parseIPv4(s) || parseIPv6(s)) ? s : null;
}

const HOST_NAME_RE = /^(?=.*[A-Za-z])[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.?$/;

/**
 * Remote end of a selected pair. An IP literal must be a Tailscale IP. No address or a host name
 * (redacted peer-reflexive candidate, mDNS name) is unknown and allowed: every candidate ever
 * signalled was filtered, and Chromium hides only addresses it learned from the peer's checks.
 * Anything else (e.g. a malformed numeric address) fails closed.
 */
function remoteOk(cand) {
  const ip = statsAddress(cand);
  if (ip) return isTailscaleAddress(ip);
  const a = rawAddress(cand);
  return !a || HOST_NAME_RE.test(a.trim());
}

/**
 * Local end: our own candidate, with real IPs (main disables mDNS host-name obfuscation). An
 * address that is present must be a Tailscale IP literal; a missing one is accepted only when
 * `allowMissing` (getStats may omit it).
 */
function localOk(cand, allowMissing) {
  const ip = statsAddress(cand);
  if (ip) return isTailscaleAddress(ip);
  return allowMissing && !rawAddress(cand);
}

/**
 * Selected pair from RTCIceTransport.getSelectedCandidatePair() ({local, remote} RTCIceCandidates).
 * Local: must be a Tailscale IP (missing or non-IP → false). Remote: a non-Tailscale IP → false; no
 * address or a host name — Chromium reports a peer-reflexive remote, the normal case on a fast
 * tailnet, as 'redacted-ip.invalid' — is unknown and allowed. A pair without both candidates is
 * not verifiable → false.
 */
export function pairIsTailnet(pair) {
  if (!pair || typeof pair !== 'object' || !pair.local || !pair.remote) return false;
  return localOk(pair.local, false) && remoteOk(pair.remote);
}

/** {ok, local, remote, pair, protocol, localType, remoteType} (verifyTailnetPath shape) for an RTCIceCandidatePair. */
export function describePair(pair) {
  const lc = pair && pair.local;
  const rc = pair && pair.remote;
  return {
    ok: pairIsTailnet(pair),
    local: statsAddress(lc),
    remote: statsAddress(rc),
    pair: !!(lc && rc),
    protocol: (lc && typeof lc.protocol === 'string' && lc.protocol) || null,
    localType: (lc && typeof lc.type === 'string' && lc.type) || null,
    remoteType: (rc && typeof rc.type === 'string' && rc.type) || null,
  };
}

/**
 * Check the selected ICE candidate pair (getStats). ok unless an address is present and is not a
 * Tailscale IP. Chromium omits a remote peer-reflexive address ('' → unknown, which cannot
 * contradict the invariant because every signalled candidate was already filtered); a remote host
 * name is unknown too (as in pairIsTailnet), while a local one fails. local/remote are IP literals
 * or null.
 * @returns {Promise<{ok:boolean, local:string|null, remote:string|null, pair:boolean,
 *                    protocol:string|null, localType:string|null, remoteType:string|null}>}
 */
export async function verifyTailnetPath(pc) {
  const none = { ok: true, local: null, remote: null, pair: false, protocol: null, localType: null, remoteType: null };
  let report;
  try {
    report = await pc.getStats();
  } catch {
    return none;
  }
  const pair = selectedCandidatePair(report);
  if (!pair) return none;
  const lc = report.get(pair.localCandidateId);
  const rc = report.get(pair.remoteCandidateId);
  return {
    ok: localOk(lc, true) && remoteOk(rc),
    local: statsAddress(lc),
    remote: statsAddress(rc),
    pair: true,
    protocol: (lc && lc.protocol) || null,
    localType: (lc && lc.candidateType) || null,
    remoteType: (rc && rc.candidateType) || null,
  };
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Pure stats reducer (exported for tests). `prev` is the opaque sample returned by the previous call.
 * @returns {{stats: object, sample: object|null}}
 */
export function summarizeStats(report, prev = null) {
  let out = null;
  let inb = null;
  const remoteInbound = [];
  report.forEach((r) => {
    const kind = r.kind || r.mediaType;
    if (kind !== 'video') return;
    if (r.type === 'outbound-rtp') {
      if (!out || (r.bytesSent || 0) > (out.bytesSent || 0)) out = r;
    } else if (r.type === 'inbound-rtp') {
      if (!inb || (r.bytesReceived || 0) > (inb.bytesReceived || 0)) inb = r;
    } else if (r.type === 'remote-inbound-rtp') {
      remoteInbound.push(r);
    }
  });
  const rtp = out || inb;
  const direction = out ? 'outbound' : inb ? 'inbound' : (prev && prev.direction) || null;
  const remoteIn = out ? remoteInbound.find((r) => r.localId === out.id) || remoteInbound[0] || null : null;

  const pair = selectedCandidatePair(report);
  let rtt = pair ? num(pair.currentRoundTripTime) : null;
  if (rtt == null && remoteIn) rtt = num(remoteIn.roundTripTime);

  const stats = {
    direction,
    fps: null, width: null, height: null, bitrateKbps: null,
    rttMs: rtt == null ? null : Math.round(rtt * 1000),
    packetsLost: null, jitterMs: null, codec: null, framesDropped: null,
    qualityLimitation: null, implementation: null,
  };
  if (!rtp) return { stats, sample: prev ? { ...prev, direction } : null };

  const bytes = num(out ? out.bytesSent : inb.bytesReceived);
  const frames = num(out ? out.framesEncoded : inb.framesDecoded);
  const ts = num(rtp.timestamp);
  let fpsCalc = null;
  if (prev && prev.id === rtp.id && ts != null && prev.ts != null && ts > prev.ts) {
    const dt = ts - prev.ts; // ms
    if (bytes != null && prev.bytes != null && bytes >= prev.bytes) {
      stats.bitrateKbps = Math.round(((bytes - prev.bytes) * 8) / dt); // bits per ms == kbit/s
    }
    if (frames != null && prev.frames != null && frames >= prev.frames) fpsCalc = ((frames - prev.frames) * 1000) / dt;
  }
  const fps = num(rtp.framesPerSecond);
  stats.fps = fps != null ? Math.round(fps) : fpsCalc != null ? Math.round(fpsCalc) : null;
  stats.width = num(rtp.frameWidth);
  stats.height = num(rtp.frameHeight);
  const codecReport = rtp.codecId ? report.get(rtp.codecId) : null;
  if (codecReport && typeof codecReport.mimeType === 'string') stats.codec = codecReport.mimeType.replace(/^video\//i, '');
  if (out) {
    stats.packetsLost = remoteIn ? num(remoteIn.packetsLost) : null;
    const j = remoteIn ? num(remoteIn.jitter) : null;
    stats.jitterMs = j == null ? null : Math.round(j * 10000) / 10;
    stats.qualityLimitation = typeof out.qualityLimitationReason === 'string' ? out.qualityLimitationReason : null;
    stats.implementation = typeof out.encoderImplementation === 'string' ? out.encoderImplementation : null;
  } else {
    stats.packetsLost = num(inb.packetsLost);
    const j = num(inb.jitter);
    stats.jitterMs = j == null ? null : Math.round(j * 10000) / 10;
    stats.framesDropped = num(inb.framesDropped);
    stats.implementation = typeof inb.decoderImplementation === 'string' ? inb.decoderImplementation : null;
  }
  return { stats, sample: { id: rtp.id, ts, bytes, frames, direction } };
}

/**
 * Poll pc.getStats() every intervalMs and call cb(stats) with
 *   { direction:'inbound'|'outbound', fps, width, height, bitrateKbps, rttMs, packetsLost, jitterMs,
 *     codec, framesDropped, qualityLimitation, implementation }   (unknown values are null)
 * Direction is 'outbound' when a video outbound-rtp exists (host), else 'inbound' (viewer).
 * Polls never overlap. Stops by itself when the pc is closed. @returns stop function
 */
export function startStats(pc, cb, intervalMs = 1000) {
  const ms = Math.max(250, Number(intervalMs) || 1000);
  let stopped = false;
  let timer = null;
  let sample = null;
  const tick = async () => {
    timer = null;
    if (stopped) return;
    if (pc.signalingState === 'closed' || pc.connectionState === 'closed') { stopped = true; return; }
    try {
      const report = await pc.getStats();
      if (stopped) return;
      const res = summarizeStats(report, sample);
      sample = res.sample;
      try { cb(res.stats); } catch (e) { console.error('[rtc] stats callback failed', e); }
    } catch { /* transient (pc closing) */ }
    if (!stopped) timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/** Viewer: minimise receive-side buffering. Never throws. */
export function setLowLatency(receiver) {
  if (!receiver) return;
  try { if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0; } catch { /* unsupported */ }
  try { receiver.playoutDelayHint = 0; } catch { /* legacy, may be absent */ }
}

/* ------------------------------------------------------------------------------------------------
 * Data channel JSON helpers
 * ---------------------------------------------------------------------------------------------- */

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

function utf8Length(s) {
  if (s.length * 3 <= MAX_MESSAGE_BYTES) return s.length; // cannot exceed the limit; skip encoding
  return encoder ? encoder.encode(s).length : s.length * 3;
}

/**
 * JSON-encode and send. false if the channel is not 'open', the value is not serialisable, the
 * message exceeds MAX_MESSAGE_BYTES (UTF-8), or send() throws. @returns {boolean}
 */
export function sendJson(channel, obj) {
  if (!channel || channel.readyState !== 'open') return false;
  let s;
  try { s = JSON.stringify(obj); } catch { return false; }
  if (typeof s !== 'string' || utf8Length(s) > MAX_MESSAGE_BYTES) return false;
  try {
    channel.send(s);
    return true;
  } catch {
    return false;
  }
}

/** Parse one text message. Returns a plain (non-array) object or null. Never throws. */
export function parseJson(data) {
  if (typeof data !== 'string' || data.length === 0 || data.length > MAX_JSON_CHARS) return null;
  let v;
  try { v = JSON.parse(data); } catch { return null; }
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
}
