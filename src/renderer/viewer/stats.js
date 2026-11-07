/*
 * Tunnelview viewer — connection statistics overlay + quality indicator, and the video decoder stall
 * watchdog.
 * Fed by rtc.js startStats() (direction 'inbound'); values are local measurements. The Route row
 * comes from rtc.js verifyTailnetPath() (selected ICE pair), the Path row from main's
 * getPathInfo() (Tailscale: direct or relayed through a DERP server), the Decode time row
 * (average ms per decoded frame) from the watchdog's own inbound-rtp samples (watchInboundVideo).
 * Chromium does not expose inbound-rtp decoderImplementation to this (non-capturing) page, so the
 * Decoder row only appears if a build ever reports it.
 *
 * Decoder stall: the hardware H.264 decoder sometimes stops producing frames for seconds while
 * frames keep arriving (framesReceived grows, framesDecoded does not; the viewer's PLIs are
 * answered with keyframes that are not decoded either). The picture freezes without any sign of
 * it, so the viewer shows a notice and stops sending input against the stale image until frames
 * are decoded again (DecoderStallDetector).
 */
import { h } from '../shared/ui.js';

const ADDR_RE = /^[0-9A-Fa-f.:]{2,45}$/;

export const DECODER_POLL_MS = 500; // watchdog sampling interval
export const DECODER_STALL_MS = 1000; // framesDecoded unchanged this long…
export const DECODER_STALL_MIN_FRAMES = 3; // …while at least this many frames arrived → stalled

const count = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);

/**
 * The main inbound video RTP stream of a getStats() report (most bytes received, like
 * rtc.summarizeStats), reduced to what the stall watchdog and the overlay need. null when none.
 * totalDecodeTime is in seconds; decoder is null when the page is not told (the usual case).
 * @returns {{id:string, framesReceived:number|null, framesDecoded:number|null, keyFramesDecoded:number|null,
 *            pliCount:number|null, freezeCount:number|null, totalDecodeTime:number|null, decoder:string|null}|null}
 */
export function inboundVideoSample(report) {
  let inb = null;
  if (report && typeof report.forEach === 'function') {
    report.forEach((r) => {
      if (!r || r.type !== 'inbound-rtp' || (r.kind || r.mediaType) !== 'video') return;
      if (!inb || (r.bytesReceived || 0) > (inb.bytesReceived || 0)) inb = r;
    });
  }
  if (!inb) return null;
  return {
    id: typeof inb.id === 'string' ? inb.id : '',
    framesReceived: count(inb.framesReceived),
    framesDecoded: count(inb.framesDecoded),
    keyFramesDecoded: count(inb.keyFramesDecoded),
    pliCount: count(inb.pliCount),
    freezeCount: count(inb.freezeCount),
    totalDecodeTime: count(inb.totalDecodeTime),
    decoder: typeof inb.decoderImplementation === 'string' && inb.decoderImplementation ? inb.decoderImplementation.slice(0, 64) : null,
  };
}

const delta = (a, b) => (a !== null && b !== null && a >= b ? a - b : null);

/**
 * Average decode time per frame in ms between two samples of the same stream
 * (Δ totalDecodeTime × 1000 / Δ framesDecoded), or null when unknown: no frame decoded in between,
 * stream replaced, or totalDecodeTime not reported.
 */
export function decodeMsPerFrame(prev, cur) {
  if (!prev || !cur || prev.id !== cur.id) return null;
  const frames = delta(cur.framesDecoded, prev.framesDecoded);
  const secs = delta(cur.totalDecodeTime, prev.totalDecodeTime);
  if (!frames || secs === null) return null;
  return (secs * 1000) / frames;
}

/**
 * Details for the stall / recovery console warnings: the counters that tell a stuck decoder from
 * a starved one (key frames decoded, freezes, PLIs sent) and the latest measured decode time per
 * frame. `decoder` only when the page was told which one is in use (normally it is not).
 * @param {{framesDecoded:number, pliDelta:number|null, decoder?:string|null}} ev  DecoderStallDetector event
 * @param {ReturnType<typeof inboundVideoSample>} sample
 * @param {number|null} decodeMs  latest decodeMsPerFrame()
 */
export function decoderLogInfo(ev, sample, decodeMs) {
  const info = {
    framesDecoded: ev.framesDecoded,
    keyFramesDecoded: sample ? sample.keyFramesDecoded : null,
    freezeCount: sample ? sample.freezeCount : null,
    pliDelta: ev.pliDelta,
  };
  if (typeof decodeMs === 'number' && Number.isFinite(decodeMs)) info.decodeMsPerFrame = Math.round(decodeMs * 10) / 10;
  const decoder = ev.decoder || (sample && sample.decoder);
  if (typeof decoder === 'string' && decoder) info.decoder = decoder;
  return info;
}

/**
 * Decoder stall = framesReceived grew by ≥ minFrames while framesDecoded did not change for
 * ≥ stallMs (only once decoding has started: before the first frame the overlay's "Starting
 * video…" and the media timeout apply). The stallMs clock only runs while frames keep arriving
 * undecoded: after a sample with no new frame since the last decoded one it restarts at the first
 * sample that sees frames again, so frames resuming after a pause (static screen on Fast, ICE
 * outage, display switch) are not mistaken for a stall. Cleared as soon as
 * framesDecoded changes again, or when the stream is replaced (new inbound-rtp id, counters going
 * backwards).
 */
export class DecoderStallDetector {
  constructor({ stallMs = DECODER_STALL_MS, minFrames = DECODER_STALL_MIN_FRAMES } = {}) {
    this.stallMs = stallMs;
    this.minFrames = minFrames;
    this.reset();
  }

  reset() {
    this.id = null;
    this.decoded = null; // framesDecoded when it last changed
    this.since = 0; // stall clock start: that time, or when frames arrived again after a pause
    this.baseReceived = 0; // framesReceived when framesDecoded last changed
    this.basePli = null; // pliCount at that time
    this.stalled = false;
    this.idle = false; // the previous sample saw no frame since the last decoded one
  }

  /**
   * @param {ReturnType<typeof inboundVideoSample>} sample  @param {number} now  ms (monotonic)
   * @returns {null | {type:'stalled', sinceMs, framesDecoded, framesReceivedDelta, keyFramesDecoded, pliDelta, decoder}
   *                | {type:'recovered', durationMs, framesDecoded, pliDelta, decoder}}
   */
  update(sample, now) {
    if (!sample || sample.framesDecoded === null || sample.framesReceived === null || !Number.isFinite(now)) return null;
    const fd = sample.framesDecoded;
    const fr = sample.framesReceived;
    const replaced = this.id !== sample.id || this.decoded === null || fd < this.decoded || fr < this.baseReceived;
    if (replaced || fd !== this.decoded) {
      const ev = this.stalled
        ? { type: 'recovered', durationMs: Math.max(0, now - this.since), framesDecoded: fd, pliDelta: delta(sample.pliCount, this.basePli), decoder: sample.decoder }
        : null;
      this.id = sample.id;
      this.decoded = fd;
      this.since = now;
      this.baseReceived = fr;
      this.basePli = sample.pliCount;
      this.stalled = false;
      this.idle = false;
      return ev;
    }
    if (this.stalled || fd === 0) return null;
    // Nothing arrived since the last decoded frame (static screen without repeats, ICE outage,
    // display switch): nothing is waiting for the decoder. The stall clock starts over at the
    // first sample that sees frames again, so a stall always means ≥ stallMs of frames arriving
    // undecoded. (Counted from the last decoded frame instead, the first frames after such a
    // pause — received, not decoded yet — would turn the whole pause into a "stall".)
    if (fr === this.baseReceived) {
      this.idle = true;
      return null;
    }
    if (this.idle) {
      this.idle = false;
      this.since = now;
      return null;
    }
    const received = fr - this.baseReceived;
    if (now - this.since < this.stallMs || received < this.minFrames) return null;
    this.stalled = true;
    return {
      type: 'stalled', sinceMs: now - this.since, framesDecoded: fd, framesReceivedDelta: received,
      keyFramesDecoded: sample.keyFramesDecoded, pliDelta: delta(sample.pliCount, this.basePli), decoder: sample.decoder,
    };
  }
}

/**
 * Poll pc.getStats() every intervalMs and call cb(inboundVideoSample(report)) (null when there is
 * no inbound video yet). Polls never overlap; stops by itself when the pc is closed.
 * @returns {() => void} stop
 */
export function watchInboundVideo(pc, cb, intervalMs = DECODER_POLL_MS) {
  const ms = Math.max(100, Number(intervalMs) || DECODER_POLL_MS);
  let stopped = false;
  let timer = 0;
  const tick = async () => {
    timer = 0;
    if (stopped) return;
    if (pc.signalingState === 'closed' || pc.connectionState === 'closed') { stopped = true; return; }
    try {
      const report = await pc.getStats();
      if (stopped) return;
      try { cb(inboundVideoSample(report)); } catch (e) { console.error('[viewer] decoder watch callback failed', e); }
    } catch { /* transient (pc closing) */ }
    if (!stopped) timer = setTimeout(tick, ms);
  };
  timer = setTimeout(tick, ms);
  return () => {
    stopped = true;
    clearTimeout(timer);
    timer = 0;
  };
}

const addr = (v) => (typeof v === 'string' && ADDR_RE.test(v) ? (v.includes(':') ? `[${v}]` : v) : null);

/**
 * Selected candidate pair → 'Tailscale 100.64.0.2 ↔ 100.64.0.9 (udp)', or '—' when unknown.
 * @param {{local?:string|null, remote?:string|null, protocol?:string|null}|null} route
 */
export function formatRoute(route) {
  if (!route) return '—';
  const local = addr(route.local);
  const remote = addr(route.remote);
  if (!local && !remote) return '—';
  const proto = typeof route.protocol === 'string' && /^[a-z]{2,8}$/i.test(route.protocol) ? ` (${route.protocol.toLowerCase()})` : '';
  return `Tailscale ${local || '?'} ↔ ${remote || '?'}${proto}`;
}

/**
 * Tailscale path → 'Direct' | 'Relayed via DERP (fra) — expect higher latency' | '—' (unknown).
 * @param {{direct?:boolean|null, relay?:string}|null} path
 */
export function formatPath(path) {
  if (!path || typeof path.direct !== 'boolean') return '—';
  if (path.direct) return 'Direct';
  const relay = typeof path.relay === 'string' ? path.relay : '';
  return `Relayed via DERP${relay ? ` (${relay})` : ''} — expect higher latency`;
}

/**
 * Connection quality from round-trip time and packets lost per second.
 * @returns {'ok'|'warn'|'danger'|null} null = no data yet
 */
export function qualityLevel(rttMs, lostPerSec) {
  const rtt = Number.isFinite(rttMs) ? rttMs : null;
  const loss = Number.isFinite(lostPerSec) ? Math.max(0, lostPerSec) : 0;
  if (rtt === null && !loss) return null;
  if ((rtt !== null && rtt > 250) || loss > 20) return 'danger';
  if ((rtt !== null && rtt > 100) || loss > 2) return 'warn';
  return 'ok';
}

const fmt = {
  fps: (v) => (Number.isFinite(v) ? `${v.toFixed(v < 10 ? 1 : 0)} fps` : '—'),
  res: (w, h_) => (w > 0 && h_ > 0 ? `${w}×${h_}` : '—'),
  kbps: (v) => (!Number.isFinite(v) ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} Mbps` : `${Math.round(v)} kbps`),
  ms: (v) => (Number.isFinite(v) ? `${Math.round(v)} ms` : '—'),
  int: (v) => (Number.isFinite(v) ? String(Math.round(v)) : '—'),
  text: (v) => (typeof v === 'string' && v ? v.replace(/^video\//i, '').slice(0, 32) : '—'),
  msPerFrame: (v) => `${v.toFixed(1)} ms/frame`,
};

/** Rows shown only while their value is known (never as '—'). */
const OPTIONAL_ROWS = ['decode', 'decoder'];

export class StatsOverlay {
  constructor(host) {
    this.cells = {};
    this.terms = {};
    const rows = [
      ['fps', 'Frame rate'], ['res', 'Resolution'], ['bitrate', 'Bitrate'], ['rtt', 'Round trip'],
      ['lost', 'Packets lost'], ['jitter', 'Jitter'], ['dropped', 'Frames dropped'], ['codec', 'Codec'],
      ['decode', 'Decode time'], ['decoder', 'Decoder'], ['route', 'Route'], ['path', 'Path'],
    ];
    const grid = h('dl', { class: 'stats-grid' });
    for (const [key, label] of rows) {
      this.terms[key] = h('dt', null, label);
      this.cells[key] = h('dd', null, '—');
      grid.append(this.terms[key], this.cells[key]);
    }
    for (const key of OPTIONAL_ROWS) this.#showRow(key, false);
    this.cells.decoder.classList.add('stats-wide');
    this.cells.route.classList.add('stats-wide');
    this.cells.path.classList.add('stats-wide');
    this.el = h('div', { class: 'stats', hidden: true, 'aria-label': 'Connection statistics', role: 'status' },
      h('div', { class: 'label stats-title' }, 'Connection'), grid);
    host.append(this.el);
  }

  #showRow(key, on) {
    this.terms[key].hidden = !on;
    this.cells[key].hidden = !on;
  }

  /** Selected ICE pair (see formatRoute). */
  setRoute(route) {
    this.cells.route.textContent = formatRoute(route);
  }

  /** Tailscale direct / DERP path (see formatPath). */
  setPath(path) {
    this.cells.path.textContent = formatPath(path);
  }

  /**
   * Video decoder in use (inbound-rtp decoderImplementation, e.g. 'ExternalDecoder (D3D11VideoDecoder)').
   * Chromium normally withholds it from the viewer page: the row stays hidden while it is unknown.
   */
  setDecoder(name) {
    const known = typeof name === 'string' && name !== '';
    this.cells.decoder.textContent = known ? name.slice(0, 64) : '—';
    this.#showRow('decoder', known);
  }

  /** Average decode time per frame (decodeMsPerFrame), e.g. '4.2 ms/frame'; hidden while unknown. */
  setDecodeTime(ms) {
    const known = typeof ms === 'number' && Number.isFinite(ms) && ms >= 0;
    this.cells.decode.textContent = known ? fmt.msPerFrame(ms) : '—';
    this.#showRow('decode', known);
  }

  setVisible(on) {
    this.el.hidden = !on;
  }

  reset() {
    for (const c of Object.values(this.cells)) c.textContent = '—';
    for (const key of OPTIONAL_ROWS) this.#showRow(key, false);
  }

  /** @param {{fps,width,height,bitrateKbps,rttMs,packetsLost,jitterMs,codec,framesDropped}} s */
  update(s) {
    if (!s) return;
    const c = this.cells;
    if ('fps' in s) c.fps.textContent = fmt.fps(s.fps);
    if ('width' in s || 'height' in s) c.res.textContent = fmt.res(s.width, s.height);
    if ('bitrateKbps' in s) c.bitrate.textContent = fmt.kbps(s.bitrateKbps);
    if ('rttMs' in s) c.rtt.textContent = fmt.ms(s.rttMs);
    if ('packetsLost' in s) c.lost.textContent = fmt.int(s.packetsLost);
    if ('jitterMs' in s) c.jitter.textContent = fmt.ms(s.jitterMs);
    if ('framesDropped' in s) c.dropped.textContent = fmt.int(s.framesDropped);
    if ('codec' in s) c.codec.textContent = fmt.text(s.codec);
  }
}
