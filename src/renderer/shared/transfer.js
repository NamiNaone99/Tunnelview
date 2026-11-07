/*
 * Tunnelview — file-transfer engine over the `file` RTCDataChannel (host panel + viewer).
 * Contract: docs/ARCHITECTURE.md §5 ('file' channel) and §10 (transfer.js API).
 *
 * Wire protocol (JSON text frames + binary ArrayBuffer chunks, ordered + reliable channel):
 *   sender                                   receiver
 *   file-offer {id,name,size,mime,purpose} →
 *                                          ← file-accept {id} | file-reject {id,reason}
 *   <binary frames: [lane byte][≤ 64 KiB]> →   (bytes beyond `size` → file-error, transfer aborted)
 *                                          ← file-pause {id} / file-resume {id}   (file lane only)
 *   file-end {id}                          →
 *                                          ← file-done {id} | file-error {id,reason}
 *   either side, any time: file-cancel {id}
 *
 * Lanes: every binary frame starts with one byte naming its lane — LANE_FILE (0) carries
 * purpose 'file', LANE_CLIPBOARD (1) carries purpose 'clipboard-image' — so a clipboard image never
 * waits behind a multi-GB file. Each direction has at most one transfer per lane in flight (the rest
 * are queued per lane); the two lanes share the channel's backpressure and alternate chunks.
 * A frame is at most CHUNK_SIZE + 1 bytes.
 *
 * Backpressure: the sender pauses while bufferedAmount > HIGH_WATER and resumes on
 * 'bufferedamountlow' (LOW_WATER). Receiver flow control (file lane): when the sink's chunk() returns
 * a promise (write completes on disk), the receiver sends file-pause once RX_PAUSE_BYTES are in
 * flight and file-resume when they drain to RX_RESUME_BYTES; a failed write is reported to the
 * sender immediately (file-error), not at file-end.
 *
 * Everything received is untrusted: every JSON message is validated, sizes are enforced, names are
 * stripped of control / bidi-override characters before being shown or handed to the sink.
 */
import { sendJson, parseJson } from './rtc.js';

const P = globalThis.TunnelviewProtocol;
if (!P) throw new Error('Tunnelview: ../../shared/protocol.js must be loaded before transfer.js');
const F = P.FILE;

const CHUNK = F.CHUNK_SIZE;
const READ_BLOCK = CHUNK * 16; // read 1 MiB per Blob.slice().arrayBuffer(), send 64 KiB frames
const PURPOSE_FILE = F.PURPOSE_FILE;
const PURPOSE_CLIP = F.PURPOSE_CLIPBOARD_IMAGE;
const LANE_FILE = Number.isInteger(F.LANE_FILE) ? F.LANE_FILE : 0;
const LANE_CLIP = Number.isInteger(F.LANE_CLIPBOARD) ? F.LANE_CLIPBOARD : 1;
const LANES = [LANE_FILE, LANE_CLIP];
const MSG_PAUSE = F.PAUSE || 'file-pause';
const MSG_RESUME = F.RESUME || 'file-resume';
const RX_PAUSE_BYTES = 16 * 1024 * 1024; // sink writes in flight → ask the sender to pause
const RX_RESUME_BYTES = 4 * 1024 * 1024; // … and to resume once they drained to this
const MAX_NAME = 255;
const MAX_MIME = 255;
const MAX_CONTROL_CHARS = 8 * 1024; // offers are tiny; anything bigger is garbage
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PROGRESS_MS = 100; // ≤ 10 progress events per second per transfer
const ACCEPT_TIMEOUT_MS = 60_000; // offer → accept/reject (and sink.begin)
const FINISH_TIMEOUT_MS = 120_000; // file-end → file-done/file-error
const STALL_TIMEOUT_MS = 120_000; // no bytes moved while sending/receiving (incl. a receiver pause)
const WATCHDOG_MS = 5_000;
const DRAIN_POLL_MS = 250; // safety net in case a 'bufferedamountlow' event is missed
const MAX_HISTORY = 200; // finished transfers kept in `transfers`
const TERMINAL = new Set(['done', 'rejected', 'error', 'cancelled']);
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// C0/C1 controls + bidi embeddings/overrides/isolates + LRM/RLM: they can disguise file
// extensions ("photo‮gpj.exe") or break layouts.
const UNSAFE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const laneOf = (purpose) => (purpose === PURPOSE_CLIP ? LANE_CLIP : LANE_FILE);

function cleanName(name) {
  let s = typeof name === 'string' ? name.replace(UNSAFE_NAME_CHARS, '').trim() : '';
  if (s.length > MAX_NAME) {
    const dot = s.lastIndexOf('.');
    const ext = dot > 0 && s.length - dot <= 16 ? s.slice(dot) : '';
    s = s.slice(0, MAX_NAME - ext.length).replace(/[\ud800-\udbff]$/, '') + ext;
  }
  return s;
}

function cleanReason(reason) {
  if (typeof reason !== 'string') return '';
  return reason.replace(/[^A-Za-z0-9 _.:-]/g, '').slice(0, 64);
}

function cleanMime(mime) {
  return typeof mime === 'string' && mime.length <= MAX_MIME && /^[\x20-\x7e]*$/.test(mime) ? mime : '';
}

function newId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function isPng(bytes) {
  if (bytes.byteLength < PNG_MAGIC.length) return false;
  for (let i = 0; i < PNG_MAGIC.length; i++) if (bytes[i] !== PNG_MAGIC[i]) return false;
  return true;
}

function concatChunks(chunks, size) {
  const out = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function codedError(code, message) {
  const e = new Error(message || code);
  e.code = code;
  return e;
}

export class FileTransfer extends EventTarget {
  /**
   * @param {RTCDataChannel} channel the 'file' channel
   * @param {{begin(meta):Promise<{ok,reason?}>, chunk(id,Uint8Array):(void|Promise<{ok,reason?}>), end(id):Promise<{ok,path?,reason?}>, abort(id)}|null} sink
   *        destination for incoming purpose:'file' transfers (the preload's fileBegin/fileChunk/fileEnd/fileAbort).
   *        chunk() may return a promise that settles once the bytes are written: it enables receiver
   *        flow control and immediate write-error reporting. A plain (undefined) return still works.
   * @param {{canReceive?:(meta)=>boolean, canReceiveClipboard?:(meta)=>boolean,
   *          onClipboardImage?:(png:Uint8Array)=>void}} [opts]
   *        canReceive gates purpose:'file' offers (false → file-reject 'not-allowed').
   *        Clipboard images are accepted only when onClipboardImage is set and the optional
   *        canReceiveClipboard (default: allow) returns true; they are assembled in memory.
   */
  constructor(channel, sink, opts = {}) {
    super();
    if (!channel) throw new TypeError('FileTransfer: channel is required');
    this.channel = channel;
    this.sink = sink || null;
    this.opts = opts || {};
    /** @type {Map<string, {id,name,size,mime,direction,purpose,state,bytes,startedAt,finishedAt,path?,reason?}>} */
    this.transfers = new Map();

    this._queues = new Map(LANES.map((l) => [l, []])); // lane → outgoing ids waiting for their turn
    this._blobs = new Map(); // outgoing id → Blob
    // lane → current outgoing { id, t, blob, lane, phase:'offered'|'sending'|'ending', aborted, paused, last }
    this._outs = new Map(LANES.map((l) => [l, null]));
    // lane → current incoming { id, t, lane, phase:'begin'|'receiving', begun, chunks, last, inflight, paused, writes }
    this._ins = new Map(LANES.map((l) => [l, null]));
    this._finishing = new Set(); // incoming ids between file-end and sink.end() resolution
    this._drainWaiters = new Set();
    this._lastEmit = new Map();
    this._emitTimers = new Map();
    this._watchdog = null;
    this._closed = false; // close() called
    this._dead = false; // channel closed

    channel.binaryType = 'arraybuffer';
    try { channel.bufferedAmountLowThreshold = F.LOW_WATER; } catch { /* read-only in exotic shims */ }
    this._onMessage = (e) => this._handleMessage(e.data);
    this._onOpen = () => this._kick();
    this._onClose = () => this._handleChannelClose();
    this._onLow = () => this._wakeDrain();
    channel.onmessage = this._onMessage;
    channel.addEventListener('open', this._onOpen);
    channel.addEventListener('close', this._onClose);
    channel.addEventListener('bufferedamountlow', this._onLow);
    if (channel.readyState === 'closed') queueMicrotask(() => this._handleChannelClose());
  }

  /* -------------------------------- public API -------------------------------- */

  /** Queue a File (or Blob with .name). @returns {string} transfer id */
  sendFile(file) {
    if (this._closed) throw new Error('FileTransfer is closed');
    if (!file || typeof file.size !== 'number' || typeof file.slice !== 'function') {
      throw new TypeError('sendFile expects a File or Blob');
    }
    return this._enqueue(file, cleanName(file.name) || 'file', cleanMime(file.type), PURPOSE_FILE);
  }

  /** Queue a PNG for the peer's clipboard (own lane; supersedes older queued images). @returns {string} id */
  sendClipboardImage(png) {
    if (this._closed) throw new Error('FileTransfer is closed');
    let bytes = png;
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    if (!(bytes instanceof Uint8Array)) throw new TypeError('sendClipboardImage expects a Uint8Array');
    for (const id of [...this._queues.get(LANE_CLIP)]) this.cancel(id);
    return this._enqueue(new Blob([bytes], { type: 'image/png' }), 'clipboard.png', 'image/png', PURPOSE_CLIP);
  }

  /** Cancel a queued or running transfer (either direction). @returns {boolean} */
  cancel(id) {
    const t = this.transfers.get(id);
    if (!t || TERMINAL.has(t.state)) return false;
    if (t.direction === 'out') {
      const o = this._outById(id);
      if (o) {
        // After file-end every byte is on the wire and the receiver may already be finalizing:
        // cancelling now could leave the two sides disagreeing, so it is too late.
        if (o.phase === 'ending') return false;
        this._sendCtl({ t: F.CANCEL, id });
        this._finishOut(o, 'cancelled', 'cancelled');
        return true;
      }
      const q = this._queues.get(laneOf(t.purpose));
      const qi = q.indexOf(id);
      if (qi !== -1) {
        q.splice(qi, 1);
        this._blobs.delete(id);
        this._finish(t, 'cancelled', 'cancelled');
        return true;
      }
      return false;
    }
    const rec = this._inById(id);
    if (rec) {
      this._ins.set(rec.lane, null);
      this._sendCtl({ t: F.CANCEL, id });
      if (rec.begun && t.purpose === PURPOSE_FILE) this._sinkAbort(id);
      this._finish(t, 'cancelled', 'cancelled');
      return true;
    }
    return false; // already finishing (sink.end in flight) — too late to cancel
  }

  /** Cancel everything and detach from the channel. Idempotent. */
  close() {
    if (this._closed) return;
    for (const q of this._queues.values()) for (const id of [...q]) this.cancel(id);
    for (const o of [...this._outs.values()]) if (o) this.cancel(o.id);
    // Still set → it was past file-end (cancel refused). We stop listening, so its outcome is unknown.
    for (const o of [...this._outs.values()]) if (o) this._finishOut(o, 'error', 'closed');
    for (const rec of [...this._ins.values()]) if (rec) this.cancel(rec.id);
    this._closed = true;
    this._detach();
  }

  /* -------------------------------- outgoing -------------------------------- */

  _outById(id) {
    for (const o of this._outs.values()) if (o && o.id === id) return o;
    return null;
  }

  _enqueue(blob, name, mime, purpose) {
    const id = newId();
    const t = this._record({ id, name, size: blob.size, mime, direction: 'out', purpose, state: 'queued' });
    const limit = purpose === PURPOSE_CLIP ? F.MAX_CLIPBOARD_IMAGE : F.MAX_SIZE;
    if (blob.size > limit) {
      this._finish(t, 'error', 'too-large');
      return id;
    }
    if (this._dead || this.channel.readyState === 'closing' || this.channel.readyState === 'closed') {
      this._finish(t, 'error', 'channel-closed');
      return id;
    }
    this._blobs.set(id, blob);
    this._queues.get(laneOf(purpose)).push(id);
    this._emit(t, true);
    this._kick();
    return id;
  }

  /** Start the next queued transfer on every lane that is free. */
  _kick() {
    if (this._closed || this._dead || this.channel.readyState !== 'open') return;
    for (const lane of LANES) {
      if (this._outs.get(lane)) continue;
      const q = this._queues.get(lane);
      while (q.length) {
        const id = q.shift();
        const t = this.transfers.get(id);
        const blob = this._blobs.get(id);
        if (!t || !blob || t.state !== 'queued') continue;
        const o = { id, t, blob, lane, phase: 'offered', aborted: false, paused: false, last: now() };
        this._outs.set(lane, o);
        t.state = 'offered';
        if (!this._sendCtl({ t: F.OFFER, id, name: t.name, size: t.size, mime: t.mime, purpose: t.purpose })) {
          this._finishOut(o, 'error', 'channel-closed');
          return;
        }
        this._emit(t, true);
        this._armWatchdog();
        break;
      }
    }
  }

  _otherLaneSending(o) {
    for (const x of this._outs.values()) if (x && x !== o && x.phase === 'sending' && !x.aborted) return true;
    return false;
  }

  async _pump(o) {
    const ch = this.channel;
    const { t } = o;
    try {
      let offset = 0;
      while (offset < t.size) {
        const blockEnd = Math.min(offset + READ_BLOCK, t.size);
        const block = new Uint8Array(await o.blob.slice(offset, blockEnd).arrayBuffer());
        if (o.aborted) return;
        if (block.byteLength !== blockEnd - offset) throw codedError('read-failed', 'short read');
        for (let p = 0; p < block.byteLength; p += CHUNK) {
          while (o.paused || ch.bufferedAmount > F.HIGH_WATER) {
            await this._waitDrain(o);
            if (o.aborted) return;
            if (ch.readyState !== 'open') throw codedError('channel-closed');
          }
          if (ch.readyState !== 'open') throw codedError('channel-closed');
          const piece = block.subarray(p, Math.min(p + CHUNK, block.byteLength));
          const frame = new Uint8Array(piece.byteLength + 1);
          frame[0] = o.lane;
          frame.set(piece, 1);
          ch.send(frame);
          offset += piece.byteLength;
          t.bytes = offset;
          o.last = now();
          this._emit(t);
          if (this._otherLaneSending(o)) {
            // Both lanes are streaming: let the other lane's pump send its next chunk.
            await Promise.resolve();
            if (o.aborted) return;
          }
        }
      }
      if (o.aborted) return;
      o.phase = 'ending';
      o.last = now();
      if (!this._sendCtl({ t: F.END, id: o.id })) throw codedError('channel-closed');
      this._emit(t, true);
    } catch (e) {
      if (o.aborted) return;
      const code = e && typeof e.code === 'string' ? e.code : e && e.name === 'NotReadableError' ? 'read-failed' : 'send-failed';
      if (code !== 'channel-closed') this._sendCtl({ t: F.CANCEL, id: o.id });
      this._finishOut(o, 'error', code);
    }
  }

  /** Resolves when the channel drained (and `o` is not paused by the receiver), or o / the channel ended. */
  _waitDrain(o) {
    return new Promise((resolve) => {
      let iv = null;
      const done = () => {
        if (iv !== null) clearInterval(iv);
        this._drainWaiters.delete(done);
        resolve();
      };
      iv = setInterval(() => {
        if (o.aborted || this.channel.readyState !== 'open') done();
        else if (!o.paused && this.channel.bufferedAmount <= F.LOW_WATER) done();
      }, DRAIN_POLL_MS);
      this._drainWaiters.add(done);
    });
  }

  _wakeDrain() {
    for (const w of [...this._drainWaiters]) w();
  }

  _finishOut(o, state, reason) {
    if (!o || this._outs.get(o.lane) !== o) return;
    o.aborted = true;
    this._outs.set(o.lane, null);
    this._blobs.delete(o.id);
    this._wakeDrain();
    this._finish(o.t, state, reason);
    queueMicrotask(() => this._kick());
  }

  /* -------------------------------- incoming -------------------------------- */

  _inById(id) {
    for (const rec of this._ins.values()) if (rec && rec.id === id) return rec;
    return null;
  }

  _handleMessage(data) {
    if (this._closed) return;
    if (typeof data === 'string') {
      if (data.length > MAX_CONTROL_CHARS) return;
      const m = parseJson(data);
      if (m && typeof m.t === 'string') this._handleControl(m);
    } else if (data instanceof ArrayBuffer) {
      this._handleFrame(new Uint8Array(data));
    } else if (ArrayBuffer.isView(data)) {
      this._handleFrame(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    }
    // Blob frames cannot occur (binaryType is 'arraybuffer'); converting them asynchronously would
    // break ordering, so anything else is dropped.
  }

  _handleControl(m) {
    const id = typeof m.id === 'string' && ID_RE.test(m.id) ? m.id : null;
    if (!id) return;
    switch (m.t) {
      case F.OFFER: void this._onOffer(id, m); break;
      case F.ACCEPT: this._onAccept(id); break;
      case F.REJECT: this._onReject(id, m.reason); break;
      case F.END: void this._onEnd(id); break;
      case F.DONE: this._onDone(id); break;
      case F.ERROR: this._onPeerError(id, m.reason); break;
      case F.CANCEL: this._onPeerCancel(id); break;
      case MSG_PAUSE: this._onPeerPause(id, true); break;
      case MSG_RESUME: this._onPeerPause(id, false); break;
      default: break; // unknown types are ignored
    }
  }

  _allowed(name, meta) {
    const fn = this.opts[name];
    if (typeof fn !== 'function') return true;
    try { return !!fn(meta); } catch { return false; }
  }

  async _onOffer(id, m) {
    const purpose = m.purpose === PURPOSE_CLIP ? PURPOSE_CLIP : m.purpose === PURPOSE_FILE ? PURPOSE_FILE : null;
    const nameOk = typeof m.name === 'string' && m.name.length > 0 && m.name.length <= MAX_NAME;
    const sizeOk = Number.isSafeInteger(m.size) && m.size >= 0 && m.size <= F.MAX_SIZE;
    if (!purpose || !nameOk || !sizeOk) {
      this._sendCtl({ t: F.REJECT, id, reason: 'invalid' });
      return;
    }
    if (this.transfers.has(id)) {
      this._sendCtl({ t: F.REJECT, id, reason: 'duplicate' });
      return;
    }
    const lane = laneOf(purpose);
    if (this._ins.get(lane)) {
      // The peer must not offer a second transfer on a lane while one is still streaming to us.
      this._sendCtl({ t: F.REJECT, id, reason: 'busy' });
      return;
    }
    const size = m.size;
    const mime = cleanMime(m.mime);
    const t = this._record({ id, name: cleanName(m.name) || 'file', size, mime, direction: 'in', purpose, state: 'offered' });
    const meta = { id, name: t.name, size, mime, purpose };
    const reject = (reason) => {
      this._sendCtl({ t: F.REJECT, id, reason });
      this._finish(t, 'rejected', reason);
    };

    if (purpose === PURPOSE_CLIP) {
      if (size > F.MAX_CLIPBOARD_IMAGE) return reject('too-large');
      if (typeof this.opts.onClipboardImage !== 'function' || !this._allowed('canReceiveClipboard', meta)) {
        return reject('not-allowed');
      }
      const crec = this._newIn(id, t, lane, 'receiving', true);
      crec.chunks = [];
      this._ins.set(lane, crec);
      t.state = 'receiving';
      t.startedAt = Date.now();
      if (!this._sendCtl({ t: F.ACCEPT, id })) {
        this._ins.set(lane, null);
        this._finish(t, 'error', 'channel-closed');
        return undefined;
      }
      this._emit(t, true);
      this._armWatchdog();
      return undefined;
    }

    if (!this._allowed('canReceive', meta)) return reject('not-allowed');
    if (!this.sink || typeof this.sink.begin !== 'function') return reject('not-supported');

    const rec = this._newIn(id, t, lane, 'begin', false);
    this._ins.set(lane, rec);
    this._emit(t, true);
    this._armWatchdog();
    let res;
    try {
      res = await this.sink.begin({ id, name: t.name, size, purpose: PURPOSE_FILE, mime });
    } catch {
      res = { ok: false, reason: 'write-failed' };
    }
    if (this._ins.get(lane) !== rec) {
      // Cancelled (locally, by the peer, by timeout or channel close) while begin() was pending.
      if (res && res.ok) this._sinkAbort(id);
      return undefined;
    }
    if (!res || !res.ok) {
      this._ins.set(lane, null);
      return reject(cleanReason(res && res.reason) || 'rejected');
    }
    rec.begun = true;
    rec.phase = 'receiving';
    rec.last = now();
    t.state = 'receiving';
    t.startedAt = Date.now();
    if (!this._sendCtl({ t: F.ACCEPT, id })) {
      this._ins.set(lane, null);
      this._sinkAbort(id);
      this._finish(t, 'error', 'channel-closed');
      return undefined;
    }
    this._emit(t, true);
    return undefined;
  }

  _newIn(id, t, lane, phase, begun) {
    return {
      id, t, lane, phase, begun, chunks: null, last: now(),
      inflight: 0, paused: false, writes: new Set(), writeError: null,
    };
  }

  /** One binary frame: [lane byte][payload]. */
  _handleFrame(bytes) {
    if (bytes.byteLength < 2) return; // empty frame / lane byte without payload
    const rec = this._ins.get(bytes[0]);
    // No accepted transfer on that lane: a frame that was in flight when we cancelled — or a
    // misbehaving peer.
    if (!rec || rec.phase !== 'receiving') return;
    const t = rec.t;
    const payload = bytes.subarray(1);
    const n = payload.byteLength;
    if (t.bytes + n > t.size) {
      this._ins.set(rec.lane, null);
      this._sendCtl({ t: F.ERROR, id: t.id, reason: 'size-mismatch' });
      if (t.purpose === PURPOSE_FILE) this._sinkAbort(t.id);
      this._finish(t, 'error', 'size-mismatch');
      return;
    }
    t.bytes += n;
    rec.last = now();
    if (t.purpose === PURPOSE_CLIP) {
      rec.chunks.push(payload);
    } else {
      // Own buffer: the sink may transfer it across IPC.
      this._writeChunk(rec, payload.slice());
      if (this._ins.get(rec.lane) !== rec) return; // failed synchronously
    }
    this._emit(t);
  }

  _writeChunk(rec, data) {
    const t = rec.t;
    let r;
    try {
      r = this.sink.chunk(t.id, data);
    } catch {
      this._writeFailed(rec, 'write-failed');
      return;
    }
    if (!r || typeof r.then !== 'function') return; // fire-and-forget sink: no flow control
    const n = data.byteLength;
    rec.inflight += n;
    const p = Promise.resolve(r)
      .then(
        (res) => (res && typeof res === 'object' && res.ok === false ? cleanReason(res.reason) || 'write-failed' : null),
        () => 'write-failed',
      )
      .then((err) => {
        rec.inflight -= n;
        rec.last = now();
        rec.writes.delete(p);
        if (err) {
          this._writeFailed(rec, err);
          return;
        }
        if (rec.paused && rec.inflight <= RX_RESUME_BYTES && this._ins.get(rec.lane) === rec) {
          rec.paused = false;
          this._sendCtl({ t: MSG_RESUME, id: t.id });
        }
      });
    rec.writes.add(p);
    if (!rec.paused && rec.inflight >= RX_PAUSE_BYTES) {
      rec.paused = true;
      this._sendCtl({ t: MSG_PAUSE, id: t.id });
    }
  }

  /** A sink write failed: tell the sender now (file-error), or after file-end if that already arrived. */
  _writeFailed(rec, reason) {
    const t = rec.t;
    if (TERMINAL.has(t.state)) return;
    if (this._ins.get(rec.lane) === rec) {
      this._ins.set(rec.lane, null);
      this._sendCtl({ t: F.ERROR, id: t.id, reason });
      this._sinkAbort(t.id);
      this._finish(t, 'error', reason);
    } else if (!rec.writeError) {
      rec.writeError = reason; // _onEnd is waiting for the writes and reports it
    }
  }

  async _onEnd(id) {
    const rec = this._inById(id);
    if (!rec || rec.phase !== 'receiving') return;
    this._ins.set(rec.lane, null); // binary frames after file-end belong to the next accepted transfer
    const t = rec.t;
    if (t.bytes !== t.size) {
      this._sendCtl({ t: F.ERROR, id, reason: 'size-mismatch' });
      if (t.purpose === PURPOSE_FILE) this._sinkAbort(id);
      this._finish(t, 'error', 'size-mismatch');
      return;
    }
    if (t.purpose === PURPOSE_CLIP) {
      const png = concatChunks(rec.chunks, t.size);
      rec.chunks = null;
      if (!isPng(png)) {
        this._sendCtl({ t: F.ERROR, id, reason: 'invalid-image' });
        this._finish(t, 'error', 'invalid-image');
        return;
      }
      try { this.opts.onClipboardImage(png); } catch (e) { console.warn('[transfer] onClipboardImage failed', e); }
      this._sendCtl({ t: F.DONE, id });
      this._finish(t, 'done');
      return;
    }
    this._finishing.add(id);
    // Main finishes its own write chain before end(), but a failed write must be reported as such.
    if (rec.writes.size) await Promise.all([...rec.writes]);
    if (TERMINAL.has(t.state)) {
      this._finishing.delete(id);
      return;
    }
    if (rec.writeError) {
      this._finishing.delete(id);
      this._sendCtl({ t: F.ERROR, id, reason: rec.writeError });
      this._sinkAbort(id);
      this._finish(t, 'error', rec.writeError);
      return;
    }
    let res;
    try {
      res = await this.sink.end(id);
    } catch {
      res = { ok: false, reason: 'write-failed' };
    }
    this._finishing.delete(id);
    if (TERMINAL.has(t.state)) return;
    if (res && res.ok) {
      if (typeof res.path === 'string') t.path = res.path;
      this._sendCtl({ t: F.DONE, id });
      this._finish(t, 'done');
    } else {
      const reason = cleanReason(res && res.reason) || 'write-failed';
      this._sendCtl({ t: F.ERROR, id, reason });
      this._finish(t, 'error', reason);
    }
  }

  _onAccept(id) {
    const o = this._outById(id);
    if (!o || o.phase !== 'offered') return;
    o.phase = 'sending';
    o.last = now();
    o.t.state = 'sending';
    o.t.startedAt = Date.now();
    this._emit(o.t, true);
    void this._pump(o);
  }

  _onReject(id, reason) {
    const o = this._outById(id);
    if (!o || o.phase !== 'offered') return;
    this._finishOut(o, 'rejected', cleanReason(reason) || 'rejected');
  }

  _onDone(id) {
    const o = this._outById(id);
    if (!o || o.phase !== 'ending') return;
    this._finishOut(o, 'done');
  }

  _onPeerError(id, reason) {
    const o = this._outById(id);
    if (!o) return; // receiver-side errors are only ever about our outgoing transfers
    this._finishOut(o, 'error', cleanReason(reason) || 'peer-error');
  }

  /** Receiver flow control (file lane only). Refreshes the stall clock: a pause may last ≤ STALL_TIMEOUT_MS. */
  _onPeerPause(id, paused) {
    const o = this._outById(id);
    if (!o || o.lane !== LANE_FILE || o.phase !== 'sending') return;
    o.paused = paused;
    o.last = now();
    if (!paused) this._wakeDrain();
  }

  _onPeerCancel(id) {
    const o = this._outById(id);
    if (o) {
      this._finishOut(o, 'cancelled', 'peer-cancelled');
      return;
    }
    const rec = this._inById(id);
    if (rec) {
      this._ins.set(rec.lane, null);
      if (rec.begun && rec.t.purpose === PURPOSE_FILE) this._sinkAbort(id);
      this._finish(rec.t, 'cancelled', 'peer-cancelled');
    }
  }

  _sinkAbort(id) {
    try { if (this.sink && typeof this.sink.abort === 'function') this.sink.abort(id); } catch { /* best effort */ }
  }

  /* -------------------------------- lifecycle -------------------------------- */

  _handleChannelClose() {
    if (this._dead) return;
    this._dead = true;
    if (!this._closed) {
      for (const q of this._queues.values()) {
        for (const id of q) {
          const t = this.transfers.get(id);
          if (t && !TERMINAL.has(t.state)) this._finish(t, 'error', 'channel-closed');
        }
        q.length = 0;
      }
      this._blobs.clear();
      for (const o of [...this._outs.values()]) if (o) this._finishOut(o, 'error', 'channel-closed');
      for (const rec of [...this._ins.values()]) {
        if (!rec) continue;
        this._ins.set(rec.lane, null);
        if (rec.begun && rec.t.purpose === PURPOSE_FILE) this._sinkAbort(rec.id);
        this._finish(rec.t, 'error', 'channel-closed');
      }
      // Transfers in this._finishing complete on their own: the data is fully on disk already.
    }
    this._wakeDrain();
    this._stopWatchdog();
  }

  _detach() {
    const ch = this.channel;
    if (ch.onmessage === this._onMessage) ch.onmessage = null;
    ch.removeEventListener('open', this._onOpen);
    ch.removeEventListener('close', this._onClose);
    ch.removeEventListener('bufferedamountlow', this._onLow);
    this._wakeDrain();
    this._stopWatchdog();
    for (const tm of this._emitTimers.values()) clearTimeout(tm);
    this._emitTimers.clear();
  }

  _armWatchdog() {
    if (this._watchdog !== null || this._closed || this._dead) return;
    this._watchdog = setInterval(() => this._checkStalls(), WATCHDOG_MS);
    if (this._watchdog && typeof this._watchdog.unref === 'function') this._watchdog.unref(); // Node tests
  }

  _stopWatchdog() {
    if (this._watchdog !== null) clearInterval(this._watchdog);
    this._watchdog = null;
  }

  _checkStalls() {
    const n = now();
    for (const o of [...this._outs.values()]) {
      if (!o) continue;
      const limit = o.phase === 'offered' ? ACCEPT_TIMEOUT_MS : o.phase === 'ending' ? FINISH_TIMEOUT_MS : STALL_TIMEOUT_MS;
      if (n - o.last > limit) {
        this._sendCtl({ t: F.CANCEL, id: o.id });
        this._finishOut(o, 'error', 'timeout');
      }
    }
    for (const rec of [...this._ins.values()]) {
      if (!rec) continue;
      const limit = rec.phase === 'begin' ? ACCEPT_TIMEOUT_MS : STALL_TIMEOUT_MS;
      if (n - rec.last > limit) {
        this._ins.set(rec.lane, null);
        this._sendCtl({ t: rec.phase === 'begin' ? F.REJECT : F.CANCEL, id: rec.id, reason: 'timeout' });
        if (rec.begun && rec.t.purpose === PURPOSE_FILE) this._sinkAbort(rec.id);
        this._finish(rec.t, 'error', 'timeout');
      }
    }
    const busy = [...this._outs.values(), ...this._ins.values()].some(Boolean);
    if (!busy) this._stopWatchdog();
  }

  /* -------------------------------- bookkeeping -------------------------------- */

  _sendCtl(msg) {
    return sendJson(this.channel, msg);
  }

  _record(fields) {
    const t = {
      id: fields.id,
      name: fields.name,
      size: fields.size,
      mime: fields.mime || '',
      direction: fields.direction,
      purpose: fields.purpose,
      state: fields.state,
      bytes: 0,
      startedAt: null,
      finishedAt: null,
    };
    this.transfers.set(t.id, t);
    this._prune();
    return t;
  }

  _finish(t, state, reason) {
    t.state = state;
    if (reason) t.reason = reason;
    t.finishedAt = Date.now();
    this._emit(t, true);
    this._lastEmit.delete(t.id);
  }

  _prune() {
    if (this.transfers.size <= MAX_HISTORY) return;
    for (const [id, t] of this.transfers) {
      if (this.transfers.size <= MAX_HISTORY) break;
      if (TERMINAL.has(t.state)) this.transfers.delete(id);
    }
  }

  /** 'update' events: immediately on state changes, progress throttled to ≤ 10/s per transfer. */
  _emit(t, force = false) {
    const id = t.id;
    const n = now();
    const pending = this._emitTimers.get(id);
    const last = this._lastEmit.get(id) || 0;
    if (force || n - last >= PROGRESS_MS) {
      if (pending) {
        clearTimeout(pending);
        this._emitTimers.delete(id);
      }
      this._lastEmit.set(id, n);
      this._dispatch(t);
    } else if (!pending) {
      this._emitTimers.set(id, setTimeout(() => {
        this._emitTimers.delete(id);
        if (TERMINAL.has(t.state)) return; // the final state was already dispatched
        this._lastEmit.set(id, now());
        this._dispatch(t);
      }, Math.max(0, PROGRESS_MS - (n - last))));
    }
  }

  _dispatch(t) {
    this.dispatchEvent(new CustomEvent('update', { detail: t }));
  }
}
