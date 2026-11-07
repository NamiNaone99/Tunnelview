/*
 * Tunnelview host panel — host side of one remote-desktop session.
 * Contract: docs/ARCHITECTURE.md §1.5 (tailnet-only WebRTC), §4 (sdp/ice), §5 (data channels),
 * §9 (presets), preload/panel.js (window.tunnelviewPanel IPC surface).
 *
 * Responsibilities: screen (+ optional system audio) capture, the RTCPeerConnection and its three
 * data channels (input / control / file), ICE filtering, tailnet-path verification, quality presets,
 * display switching, clipboard sync, file transfer, permission enforcement, ICE restarts and full
 * cleanup.
 *
 * Start-up: the offer is created and sent while the screen capture is still starting (the senders
 * start without a track anyway), so ICE/DTLS overlap capture start-up.
 *
 * Security notes
 *  - Only Tailscale candidates are signalled or added (rtc.isAllowedCandidate); SDP is scrubbed too.
 *  - The media senders start WITHOUT tracks. Screen pixels/audio are attached (replaceTrack) only
 *    after the selected ICE pair has been checked to be on the tailnet — on every
 *    'selectedcandidatepairchange' of the ICE transport, plus a getStats() check on 'connected' and
 *    every 5 s. A non-tailnet pair ends the session ('non-tailnet-path').
 *  - Input, clipboard writes and file receiving are also gated on that verification and on the
 *    host user's live permissions. Every data-channel message is validated before use.
 *
 * Events (CustomEvent.detail): 'phase' string, 'path' {status,local,remote,…}, 'stats' stats,
 * 'stream' streamInfo(), 'permissions' perms, 'chat' {from,text,ts}, 'transfer' transfer,
 * 'notice' {kind,text}, 'ended' {reason, fromMain}.
 */
import {
  RTC_CONFIG, PRESETS, presetEncoding, presetStartKbps, isAllowedCandidate, filterSdpCandidates,
  mungeAnswerForSend, applyPreset, speedScaleFor, preferCodecs, verifyTailnetPath, describePair,
  captureSizeLimit, startStats, sendJson, parseJson,
} from '../shared/rtc.js';
import { FileTransfer } from '../shared/transfer.js';
import {
  sanitizeInput, sanitizeDisplayId, publicDisplay, RateLimiter, sanitizeClipboard, splitClipboardText,
  clipboardPartId, ClipboardAssembler, CLIPBOARD_SINGLE_MAX_BYTES, CLIPBOARD_CHUNK_CHARS, CLIPBOARD_MAX_PARTS,
} from './validate.js';

const P = globalThis.TunnelviewProtocol;
const C = P.CONTROL;
const F = P.FILE;

const CONNECT_TIMEOUT_MS = 45_000; // offer sent → 'connected'
const DISCONNECT_GRACE_MS = 30_000; // not 'connected' again within this of the first disconnect → end
const ICE_RESTART_AFTER_MS = 3_000; // 'disconnected' this long → ICE restart
const ICE_RESTART_RETRY_MS = 8_000; // still not connected after a restart → try again
const MAX_ICE_RESTARTS = 3; // per outage
const PATH_RECHECK_MS = 5_000;
const PATH_RETRY_MS = 200; // getStats fallback: no selected pair reported yet
const PATH_RETRIES = 25;
const CAPTURE_BLOCK_MS = 15_000; // macOS: getDisplayMedia waiting on a system alert
const MAX_PENDING_ICE = 200;
const TERMINAL = new Set(['done', 'rejected', 'error', 'cancelled']);
const BLOCKED_INPUT = new Set(['secure-desktop', 'elevated-window']);
const CAPTURE_BLOCKED_TEXT = 'macOS is waiting for someone at this Mac to allow screen recording.';

const utf8 = new TextEncoder();

function stopTrack(track) {
  try { if (track && track.readyState !== 'ended') track.stop(); } catch { /* already gone */ }
}

function stopStream(stream) {
  if (!stream) return;
  for (const t of stream.getTracks()) stopTrack(t);
}

function plainCandidate(c) {
  // RTCIceCandidate → plain object (platform objects cannot cross contextBridge / IPC).
  const j = typeof c.toJSON === 'function' ? c.toJSON() : c;
  return {
    candidate: typeof j.candidate === 'string' ? j.candidate : '',
    sdpMid: j.sdpMid == null ? null : String(j.sdpMid),
    sdpMLineIndex: Number.isInteger(j.sdpMLineIndex) ? j.sdpMLineIndex : null,
    usernameFragment: j.usernameFragment == null ? null : String(j.usernameFragment),
  };
}

/** Two captureSizeLimit() results ({width, height} or null) are the same box. */
function sameLimit(a, b) {
  if (!a || !b) return !a && !b;
  return a.width === b.width && a.height === b.height;
}

function captureError(cause) {
  const e = new Error((cause && cause.message) || 'Screen capture is unavailable');
  e.code = 'capture';
  e.cause = cause;
  return e;
}

/** Resolve like `promise`, or reject with a 'blocked' capture error after ms; a late stream is stopped. */
function timeBoxCapture(promise, ms) {
  if (!ms) return promise;
  return new Promise((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      const e = captureError(new Error('screen recording is waiting for approval'));
      e.blocked = true;
      reject(e);
    }, ms);
    promise.then(
      (stream) => {
        if (timedOut) stopStream(stream);
        else {
          clearTimeout(timer);
          resolve(stream);
        }
      },
      (err) => {
        if (timedOut) return;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export class HostSession extends EventTarget {
  /** @param api window.tunnelviewPanel  @param init normalized PanelInit */
  constructor(api, init) {
    super();
    this.api = api;
    this.init = init;
    this.perms = { ...init.permissions };
    this.inputStatus = {
      available: !!init.input.available,
      reason: init.input.reason || null,
      blocked: BLOCKED_INPUT.has(init.input.blocked) ? init.input.blocked : null,
    };
    this.quality = PRESETS[init.settings.quality] ? init.settings.quality : 'balanced';
    this.codec = init.settings.codec || 'auto';
    this.clipboardSync = init.settings.clipboardSync !== false;
    this.audioSupported = !!init.audioSupported;
    this.displays = init.displays.slice();
    const primary = this.displays.find((d) => d.primary) || this.displays[0] || null;
    this.currentDisplayId = init.initialDisplayId || (primary ? primary.id : null);
    this.wantDisplayId = this.currentDisplayId;

    this.phase = 'starting';
    this.started = false;
    this.ended = false;
    this.endReason = null;
    this.everConnected = false;
    this.pathOk = false;
    this.path = null;
    this.mediaAttached = false;

    this.pc = null;
    this.ch = { input: null, control: null, file: null };
    this.transfer = null;
    this.videoTx = null;
    this.audioTx = null;
    this.stream = null;
    this.videoTrack = null;
    this.audioTrack = null;
    this.scaledFor = null; // 'WxH' the 'speed' scale was last derived from
    this.liveTracks = new Set();
    this.pendingIce = [];
    this.remoteDescriptionSet = false;
    this.answerPending = false;
    this.iceTransport = null;
    this._onPairChange = null;
    this.iceRestarts = 0;
    this.restarting = false;
    this.captureReady = null;
    this.captureBlocked = false;
    this.clipboardSyncActive = false;
    this.clipAsm = new ClipboardAssembler();
    this.stopStats = null;
    this.timers = { connect: null, disconnect: null, restart: null, path: null };
    this.captureChain = Promise.resolve();
    this.limits = {
      chat: new RateLimiter(5, 20),
      clipboard: new RateLimiter(4, 8),
      display: new RateLimiter(2, 4),
    };
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /* ================================ lifecycle ================================ */

  /**
   * Creates the RTCPeerConnection (+ track-less transceivers) synchronously, then sends the offer
   * while the screen capture starts in parallel. Resolves once both are done.
   */
  async start() {
    if (this.started || this.ended) return;
    this.started = true;
    try {
      this._createPeerConnection();
      this._addTransceivers();
    } catch (e) {
      console.error('[panel] RTCPeerConnection setup failed', e);
      this.end('setup-failed');
      return;
    }
    this._setPhase('capturing');
    const capP = this._capture(this.currentDisplayId, this._wantAudio());
    capP.catch(() => { /* handled below */ });
    this.captureReady = capP;
    // First link of the capture chain: display switches / audio enables queued meanwhile run after
    // the initial tracks have been adopted.
    const adopted = capP.then((cap) => this._adoptInitial(cap), (e) => this._initialCaptureFailed(e));
    this.captureChain = adopted.then(() => {}, (e) => {
      if (!this.ended) console.error('[panel] adopting the capture failed', e);
    });
    try {
      await this._negotiate();
    } catch (e) {
      if (!this.ended) {
        console.error('[panel] negotiation failed', e);
        this.end('negotiation-failed');
      }
    }
    await this.captureChain; // a capture that finishes after end() is stopped by _adoptInitial
  }

  /**
   * Tear everything down. fromMain = main already knows (onEnded) → do not echo endSession.
   * Idempotent; never leaves a capture track running.
   */
  end(reason, { fromMain = false } = {}) {
    if (this.ended) return;
    this.ended = true;
    this.endReason = reason;
    if (!fromMain) {
      try { this.api.endSession(reason); } catch { /* window going away */ }
    }
    for (const k of Object.keys(this.timers)) {
      clearTimeout(this.timers[k]);
      clearInterval(this.timers[k]);
      this.timers[k] = null;
    }
    if (this.stopStats) {
      this.stopStats();
      this.stopStats = null;
    }
    if (this.iceTransport && this._onPairChange) {
      try { this.iceTransport.removeEventListener('selectedcandidatepairchange', this._onPairChange); } catch { /* ignore */ }
    }
    if (this.clipboardSyncActive) {
      this.clipboardSyncActive = false;
      try { this.api.setClipboardSync(false); } catch { /* ignore */ }
    }
    this._releaseInput();
    if (this.transfer) {
      try { this.transfer.close(); } catch { /* ignore */ }
    }
    for (const ch of Object.values(this.ch)) {
      try { if (ch) ch.close(); } catch { /* ignore */ }
    }
    if (this.pc) {
      try { this.pc.close(); } catch { /* ignore */ }
    }
    for (const t of this.liveTracks) stopTrack(t);
    this.liveTracks.clear();
    stopStream(this.stream);
    this.videoTrack = null;
    this.audioTrack = null;
    this.pendingIce = [];
    this.clipAsm.reset();
    this._setPhase('ended');
    this.emit('ended', { reason, fromMain: !!fromMain });
  }

  _setPhase(phase) {
    if (this.phase === phase) return;
    this.phase = phase;
    this.emit('phase', phase);
  }

  /* ================================ WebRTC ================================ */

  _createPeerConnection() {
    const pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc = pc;
    pc.addEventListener('icecandidate', (e) => {
      if (this.ended) return;
      const init = e.candidate ? plainCandidate(e.candidate) : null;
      if (!isAllowedCandidate(init)) return; // LAN / public / mDNS candidates are never signalled
      this.api.sendSignal({ t: P.MSG.ICE, candidate: init });
    });
    pc.addEventListener('connectionstatechange', () => this._onConnectionState());
    // §5: all three channels are created by the host, ordered + reliable, before createOffer().
    const opts = { ordered: true };
    this.ch.input = pc.createDataChannel(P.CHANNEL.INPUT, opts);
    this.ch.control = pc.createDataChannel(P.CHANNEL.CONTROL, opts);
    this.ch.file = pc.createDataChannel(P.CHANNEL.FILE, opts);
    this._wireInput();
    this._wireControl();
    this._wireFiles();
  }

  /**
   * Senders start without a track: nothing is transmitted before the tailnet path is verified.
   * No `streams`: audio and video must not share a sync group (the viewer would hold video back to
   * line it up with audio); the viewer builds its own MediaStream per track.
   */
  _addTransceivers() {
    this.videoTx = this.pc.addTransceiver('video', {
      direction: 'sendonly',
      sendEncodings: [presetEncoding(this.quality)],
    });
    preferCodecs(this.videoTx, this.codec);
    if (this.audioSupported) {
      // Always negotiate an audio m-line when audio is supported so it can be switched on later with
      // replaceTrack() — no renegotiation needed.
      this.audioTx = this.pc.addTransceiver('audio', { direction: 'sendonly' });
    }
  }

  async _negotiate() {
    const offer = await this.pc.createOffer();
    if (this.ended) return;
    await this.pc.setLocalDescription(offer);
    if (this.ended) return;
    this._sendLocalDescription();
    this._watchSelectedPair();
    this._setPhase('connecting');
    this.timers.connect = setTimeout(() => {
      if (!this.everConnected) this.end('connection-timeout');
    }, CONNECT_TIMEOUT_MS);
  }

  _sendLocalDescription() {
    const d = this.pc.localDescription;
    this.api.sendSignal({ t: P.MSG.SDP, description: { type: d.type, sdp: filterSdpCandidates(d.sdp) } });
  }

  /** Answer SDP as applied: tailnet-only candidates, start bitrate for the first keyframe, Opus stereo. */
  _prepareAnswer(sdp) {
    return mungeAnswerForSend(filterSdpCandidates(sdp), {
      startKbps: presetStartKbps(this.quality),
      opusStereo: this.audioSupported,
    });
  }

  /** Signal from the viewer, already shape-validated by validate.sanitizeSignal(). */
  async handleSignal(m) {
    if (this.ended || !this.pc) return;
    if (m.t === P.MSG.SDP) {
      // The host is always the offerer: only an answer to our outstanding offer (initial or ICE
      // restart) is applied.
      if (m.description.type !== 'answer') return;
      if (this.pc.signalingState !== 'have-local-offer' || this.answerPending) return;
      this.answerPending = true;
      const initial = !this.remoteDescriptionSet;
      try {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: this._prepareAnswer(m.description.sdp) });
      } catch (e) {
        this.answerPending = false;
        if (this.ended) return;
        if (initial) {
          console.error('[panel] setRemoteDescription failed', e);
          this.end('negotiation-failed');
        } else {
          console.warn('[panel] applying the ICE-restart answer failed', e); // the outage grace decides
        }
        return;
      }
      this.answerPending = false;
      if (this.ended) return;
      this.remoteDescriptionSet = true;
      for (const c of this.pendingIce.splice(0)) this._addIce(c);
      this._watchSelectedPair();
      return;
    }
    if (m.t === P.MSG.ICE) {
      const c = m.candidate;
      // End-of-candidates is optional for ICE to work; skip it rather than risk a TypeError.
      if (!c || c.candidate === '') return;
      if (!isAllowedCandidate(c)) {
        console.warn('[panel] dropped non-tailnet remote ICE candidate');
        return;
      }
      if (!this.remoteDescriptionSet) {
        if (this.pendingIce.length < MAX_PENDING_ICE) this.pendingIce.push(c);
        return;
      }
      this._addIce(c);
    }
  }

  _addIce(c) {
    this.pc.addIceCandidate(c).catch((e) => {
      if (!this.ended) console.warn('[panel] addIceCandidate failed:', (e && e.message) || e);
    });
  }

  _onConnectionState() {
    if (this.ended || !this.pc) return;
    const s = this.pc.connectionState;
    if (s === 'connected') {
      this._clearOutage();
      if (!this.everConnected) {
        this.everConnected = true;
        clearTimeout(this.timers.connect);
        this.timers.connect = null;
        this.stopStats = startStats(this.pc, (st) => {
          this.emit('stats', st);
          this._followCaptureSize();
        });
        this.timers.path = setInterval(() => void this._checkPath(-1), PATH_RECHECK_MS);
      }
      this._setPhase('live');
      // (Re-)verify right away — also after an outage, where the pair may not have changed.
      this._checkSelectedPair();
      void this._checkPath(0);
    } else if (s === 'disconnected' || s === 'failed') {
      if (!this.everConnected) {
        if (s === 'failed') {
          this.end('connection-failed');
        } else if (!this.timers.disconnect) {
          this.timers.disconnect = setTimeout(() => this.end('connection-lost'), DISCONNECT_GRACE_MS);
        }
        return;
      }
      this._setPhase('reconnecting');
      if (!this.timers.disconnect) {
        // First sign of this outage: it must recover within the grace period. Nothing the viewer
        // held down (a drag, a modifier) may stay pressed on this computer meanwhile.
        this.iceRestarts = 0;
        this.timers.disconnect = setTimeout(() => this.end('connection-lost'), DISCONNECT_GRACE_MS);
        this._releaseInput();
      }
      if (s === 'failed') {
        void this._restartIce();
      } else if (!this.timers.restart) {
        this.timers.restart = setTimeout(() => {
          this.timers.restart = null;
          void this._restartIce();
        }, ICE_RESTART_AFTER_MS);
      }
    }
  }

  _clearOutage() {
    clearTimeout(this.timers.disconnect);
    clearTimeout(this.timers.restart);
    this.timers.disconnect = null;
    this.timers.restart = null;
    this.iceRestarts = 0;
  }

  /** New ICE credentials + offer (sent like the first one). Bounded per outage; needs 'stable'. */
  async _restartIce() {
    const pc = this.pc;
    if (this.ended || !pc || this.restarting || pc.connectionState === 'connected') return;
    if (pc.signalingState !== 'stable' || this.iceRestarts >= MAX_ICE_RESTARTS) return;
    this.iceRestarts += 1;
    this.restarting = true;
    clearTimeout(this.timers.restart); // e.g. 'failed' arrived before the 3 s 'disconnected' timer
    this.timers.restart = null;
    try {
      if (typeof pc.restartIce === 'function') pc.restartIce();
      const offer = await pc.createOffer({ iceRestart: true });
      if (this.ended) return;
      await pc.setLocalDescription(offer);
      if (this.ended) return;
      this._sendLocalDescription();
      this._watchSelectedPair();
    } catch (e) {
      if (!this.ended) console.warn('[panel] ICE restart failed', e);
    } finally {
      this.restarting = false;
    }
    // Still down after a while → try again (bounded by MAX_ICE_RESTARTS and the outage grace).
    if (!this.ended && this.timers.disconnect && !this.timers.restart) {
      this.timers.restart = setTimeout(() => {
        this.timers.restart = null;
        void this._restartIce();
      }, ICE_RESTART_RETRY_MS);
    }
  }

  /**
   * Follow the (bundled) ICE transport's selected pair: every pair ICE selects — the first one and
   * each switch, e.g. after a restart — is checked immediately, before DTLS completes.
   */
  _watchSelectedPair() {
    if (this.ended || !this.pc) return;
    let ice = null;
    try {
      const sctp = this.pc.sctp;
      ice = (sctp && sctp.transport && sctp.transport.iceTransport) || null;
      if (!ice) {
        const dtls = this.videoTx && this.videoTx.sender && this.videoTx.sender.transport;
        ice = (dtls && dtls.iceTransport) || null;
      }
    } catch {
      ice = null;
    }
    if (!ice || typeof ice.getSelectedCandidatePair !== 'function' || ice === this.iceTransport) return;
    if (this.iceTransport && this._onPairChange) {
      try { this.iceTransport.removeEventListener('selectedcandidatepairchange', this._onPairChange); } catch { /* ignore */ }
    }
    this.iceTransport = ice;
    this._onPairChange = () => this._checkSelectedPair();
    ice.addEventListener('selectedcandidatepairchange', this._onPairChange);
    this._checkSelectedPair();
  }

  _checkSelectedPair() {
    const ice = this.iceTransport;
    if (this.ended || !ice) return;
    let pair = null;
    try { pair = ice.getSelectedCandidatePair(); } catch { return; }
    if (!pair || !pair.local || !pair.remote) return;
    const r = describePair(pair);
    if (!r.ok) {
      console.error('[panel] selected ICE candidate pair is NOT on the tailnet — ending session', r);
      this.emit('path', { ...r, status: 'failed' });
      this.end('non-tailnet-path');
      return;
    }
    this.path = r;
    this.emit('path', { ...r, status: 'ok' });
    this._pathVerified();
  }

  /** getStats() check. attempt ≥ 0: retried while no selected pair is reported yet; -1: periodic. */
  async _checkPath(attempt) {
    if (this.ended || !this.pc) return;
    const r = await verifyTailnetPath(this.pc);
    if (this.ended) return;
    if (!r.ok) {
      console.error('[panel] selected ICE candidate pair is NOT on the tailnet — ending session', r);
      this.emit('path', { ...r, status: 'failed' });
      this.end('non-tailnet-path');
      return;
    }
    if (r.pair) {
      this.path = r;
      this.emit('path', { ...r, status: 'ok' });
      this._pathVerified();
    } else if (attempt >= 0 && attempt < PATH_RETRIES) {
      setTimeout(() => void this._checkPath(attempt + 1), PATH_RETRY_MS);
    } else if (attempt >= PATH_RETRIES && !this.pathOk) {
      // Chromium reported no selected pair. Nothing contradicts the invariant (every candidate on
      // both sides was filtered to Tailscale addresses), so proceed — the UI says "unverified".
      this.emit('path', { ...r, status: 'unverified' });
      this._pathVerified();
    }
  }

  _pathVerified() {
    if (this.pathOk || this.ended) return;
    this.pathOk = true;
    // Directly, not through _serial(): a pending display switch must not delay the first frame.
    // (_attachMedia is idempotent and waits for the capture if it is not ready yet.)
    void this._attachMedia();
    this._updateClipboardSync();
    this._sendHostState();
  }

  /** Attach the captured tracks once BOTH the path is verified and the capture is ready. */
  async _attachMedia() {
    if (this.mediaAttached || this.ended || !this.pathOk || !this.videoTrack || !this.videoTx) return;
    this.mediaAttached = true;
    try {
      await this.videoTx.sender.replaceTrack(this.videoTrack);
      await this._syncAudioSender();
    } catch (e) {
      if (this.ended) return;
      console.error('[panel] attaching media failed', e);
      this.end('media-failed');
      return;
    }
    if (this.ended) return;
    await this._applyPreset();
  }

  /**
   * Apply the current preset to the video sender. 'speed' scales by speedScaleFor(capture size) so
   * the encoded picture stays even-sized (an odd size drops Chromium to the software H.264
   * encoder); until the capture size is known the preset's default scale stays in force.
   */
  _applyPreset() {
    if (!this.videoTx) return Promise.resolve(false);
    let opts = null;
    this.scaledFor = null;
    if (this.quality === 'speed') {
      const size = this._captureSize();
      if (size) {
        this.scaledFor = `${size.width}x${size.height}`;
        opts = { scaleResolutionDownBy: speedScaleFor(size.width, size.height) };
      }
    }
    return applyPreset(this.videoTx.sender, this.quality, opts);
  }

  /**
   * Current capture size (video track settings), each side floored to even, or null. Even, like
   * speedScaleFor() sees it: Chromium first reports a transient 2561×1440 for a 2560×1440 capture,
   * and settling must not re-apply the same scale (a needless encoder reconfiguration).
   */
  _captureSize() {
    let s = null;
    try {
      const t = this.videoTrack;
      s = t && typeof t.getSettings === 'function' ? t.getSettings() : null;
    } catch {
      s = null;
    }
    const w = s ? Number(s.width) : NaN;
    const h = s ? Number(s.height) : NaN;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 2 || h < 2) return null;
    return { width: w - (w % 2), height: h - (h % 2) };
  }

  /** 'speed' (each stats tick): the capture size changed without a swap (display mode change) → re-derive the scale. */
  _followCaptureSize() {
    if (this.ended || !this.mediaAttached || this.quality !== 'speed') return;
    const size = this._captureSize();
    if (!size || `${size.width}x${size.height}` === this.scaledFor) return;
    console.info('[panel] capture size changed', { from: this.scaledFor, to: `${size.width}x${size.height}` });
    void this._applyPreset();
  }

  /** Audio sender carries the audio track only while audio is allowed (else nothing, not silence). */
  async _syncAudioSender() {
    if (!this.audioTx || !this.mediaAttached || this.ended) return;
    const t = this.audioTrack;
    const want = this.perms.audio && t && t.readyState !== 'ended' ? t : null;
    if (this.audioTx.sender.track === want) return;
    await this.audioTx.sender.replaceTrack(want);
  }

  /* ================================ capture ================================ */

  _wantAudio() {
    return this.audioSupported && !!this.perms.audio;
  }

  /** Serialize capture/track operations (display switches, audio enable, recovery). */
  _serial(fn) {
    const run = this.captureChain.then(() => (this.ended ? undefined : fn()));
    this.captureChain = run.catch((e) => {
      if (!this.ended) console.error('[panel] capture operation failed', e);
    });
    return this.captureChain;
  }

  /** Initial capture finished (first link of captureChain). */
  _adoptInitial(cap) {
    if (this.ended) {
      stopStream(cap.stream);
      return undefined;
    }
    const video = cap.stream.getVideoTracks()[0];
    const audio = cap.stream.getAudioTracks()[0] || null;
    this.stream = cap.stream;
    this._adoptVideo(video);
    if (audio) {
      if (this.audioTx) this._adoptAudio(audio);
      else stopTrack(audio);
    }
    this.emit('stream', this.streamInfo());
    this._sendHostState();
    // Path verified first (common: ICE is faster than the capture device) → attach now.
    return this.pathOk ? this._attachMedia() : undefined;
  }

  _initialCaptureFailed(e) {
    if (this.ended) return;
    if (e && e.blocked) {
      console.error('[panel] screen capture is waiting for macOS approval');
      this.emit('notice', { kind: 'danger', text: CAPTURE_BLOCKED_TEXT });
      this.end('capture-blocked');
      return;
    }
    console.error('[panel] screen capture failed', e);
    this.emit('notice', { kind: 'danger', text: this._captureHint(e) });
    this.end('capture-failed');
  }

  async _select(id) {
    const r = await this.api.selectDisplay(id);
    if (!r || !r.ok) throw captureError(new Error((r && r.error) || 'display unavailable'));
    return r;
  }

  /**
   * Capture display `id`. Order: getDisplayMedia(audio) → getDisplayMedia(no audio) → legacy
   * getUserMedia(chromeMediaSource:'desktop', audio) → legacy without audio. selectDisplay() runs
   * before every attempt (main's display-media handler serves the last selection). Displays larger
   * than 4K are capped (captureSizeLimit). On macOS every attempt is time-boxed: a system alert
   * may hold the capture until someone at the Mac answers it (error.blocked).
   * @returns {Promise<{stream, limit}>} see _captured()
   */
  async _capture(id, wantAudio) {
    if (id == null) throw captureError(new Error('no display to capture'));
    const md = navigator.mediaDevices;
    const audioModes = wantAudio ? [true, false] : [false];
    const limit = this._limitFor(id);
    const timeBox = this.init.hostOs === 'macos' ? CAPTURE_BLOCK_MS : 0;
    let lastErr = null;
    const accept = (stream) => {
      if (stream && stream.getVideoTracks().length > 0) return true;
      stopStream(stream);
      return false;
    };
    if (md && typeof md.getDisplayMedia === 'function') {
      for (const audio of audioModes) {
        await this._select(id);
        try {
          // `cursor` is a display-surface constraint some Chromium builds ignore; screen sources
          // captured through Electron include the cursor anyway.
          const video = { frameRate: { ideal: 60, max: 60 }, cursor: 'always' };
          if (limit) {
            video.width = { max: limit.width };
            video.height = { max: limit.height };
          }
          const stream = await timeBoxCapture(md.getDisplayMedia({ video, audio }), timeBox);
          if (accept(stream)) return this._captured(id, stream, limit);
        } catch (e) {
          if (e && e.blocked) throw e;
          lastErr = e;
        }
        if (this.ended) throw captureError(lastErr);
      }
    }
    if (md && typeof md.getUserMedia === 'function') {
      for (const audio of audioModes) {
        const sel = await this._select(id);
        if (!sel.sourceId) break;
        try {
          const mandatory = { chromeMediaSource: 'desktop', chromeMediaSourceId: sel.sourceId, maxFrameRate: 60 };
          if (limit) {
            mandatory.maxWidth = limit.width;
            mandatory.maxHeight = limit.height;
          }
          const stream = await timeBoxCapture(md.getUserMedia({
            audio: audio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
            video: { mandatory },
          }), timeBox);
          if (accept(stream)) return this._captured(id, stream, limit);
        } catch (e) {
          if (e && e.blocked) throw e;
          lastErr = e;
        }
        if (this.ended) throw captureError(lastErr);
      }
    }
    throw captureError(lastErr);
  }

  /**
   * A capture of display `id` succeeded: enforce the size cap and log the delivered size once.
   * @returns {Promise<{stream: MediaStream, limit: {width:number, height:number}|null}>} limit = the
   * cap it was captured with (null = native size)
   */
  async _captured(id, stream, limit) {
    await this._capped(stream, limit);
    const track = stream.getVideoTracks()[0];
    let s = null;
    try { s = track && typeof track.getSettings === 'function' ? track.getSettings() : null; } catch { s = null; }
    // What Chromium actually delivers (e.g. a capped 16" MacBook Pro or DCI 4K display).
    console.info('[panel] capture settings', {
      displayId: String(id), width: s ? s.width : null, height: s ? s.height : null, limit,
    });
    return { stream, limit };
  }

  /** Enforce the size cap when the capture ignored the max constraints. */
  async _capped(stream, limit) {
    const track = stream.getVideoTracks()[0];
    if (limit && track) {
      let s = null;
      try { s = typeof track.getSettings === 'function' ? track.getSettings() : null; } catch { s = null; }
      if (s && (s.width > limit.width || s.height > limit.height) && typeof track.applyConstraints === 'function') {
        try {
          await track.applyConstraints({
            width: { max: limit.width }, height: { max: limit.height }, frameRate: { ideal: 60, max: 60 },
          });
        } catch (e) {
          console.warn('[panel] could not cap the capture size', e);
        }
      }
    }
  }

  _captureHint(e) {
    if (this.init.hostOs === 'macos') {
      return 'Screen capture failed. Allow Tunnelview under System Settings › Privacy & Security › Screen Recording, then quit and reopen Tunnelview on this Mac.';
    }
    return `Screen capture failed${e && e.message ? `: ${e.message}` : '.'}`;
  }

  _adoptVideo(track) {
    try { track.contentHint = PRESETS[this.quality].contentHint; } catch { /* unsupported */ }
    this.liveTracks.add(track);
    track.addEventListener('ended', () => this._onVideoEnded(track));
    const old = this.videoTrack;
    this.videoTrack = track;
    return old;
  }

  _adoptAudio(track) {
    track.enabled = !!this.perms.audio;
    this.liveTracks.add(track);
    track.addEventListener('ended', () => this._onAudioEnded(track));
    const old = this.audioTrack;
    this.audioTrack = track;
    return old;
  }

  _stop(track) {
    if (!track) return;
    stopTrack(track);
    this.liveTracks.delete(track);
  }

  async _swapStream(stream) {
    const video = stream.getVideoTracks()[0];
    const audio = stream.getAudioTracks()[0] || null;
    const oldVideo = this._adoptVideo(video);
    if (this.mediaAttached) await this.videoTx.sender.replaceTrack(video);
    if (oldVideo && oldVideo !== video) this._stop(oldVideo);
    if (audio) {
      if (this.audioTx) {
        const oldAudio = this._adoptAudio(audio);
        await this._syncAudioSender();
        if (oldAudio && oldAudio !== audio) this._stop(oldAudio);
      } else {
        stopTrack(audio);
      }
    }
    // Loopback audio is system-wide: when the new capture has none, the previous audio track
    // (if any) keeps playing.
    this.stream = stream;
    if (this.mediaAttached) await this._applyPreset(); // new capture size → new 'speed' scale
    else if (this.pathOk) await this._attachMedia();
  }

  /**
   * Main moves input mapping to `id` (only once its picture is what the viewer sees).
   * @returns {Promise<{ok:true}|{ok:false, error:string, served?:string|null}|null>} null = no answer
   */
  async _commitDisplay(id) {
    if (typeof this.api.commitDisplay !== 'function') return null; // older main: selectDisplay mapped it
    try {
      const r = await this.api.commitDisplay(id);
      if (r && r.ok === false) console.warn('[panel] commitDisplay refused', r);
      return r && typeof r === 'object' ? r : null;
    } catch (e) {
      console.warn('[panel] commitDisplay failed', e);
      return null;
    }
  }

  /**
   * Commit `id` after its stream is live. @returns {Promise<string>} the display actually streamed:
   * when `id` is gone (unplugged) main's display-media handler served another one (the primary) and
   * says which ({ok:false, error:'not-found', served}); input is then mapped onto that one. A
   * result without `served` (older main) keeps `id`.
   */
  async _commitStreamed(id) {
    const r = await this._commitDisplay(id);
    if (!r || r.ok !== false || r.error !== 'not-found') return id;
    const served = sanitizeDisplayId(r.served);
    if (!served || served !== r.served || served === id || this.ended) return id;
    const r2 = await this._commitDisplay(served);
    const streamed = r2 && r2.ok === true ? served : id;
    if (!this.ended) await this._refreshDisplays(); // the cached list still had `id`
    return streamed;
  }

  /** Capture `id` and swap it in. Must run inside _serial(). @returns {Promise<boolean>} */
  async _recapture(id) {
    const prevId = this.currentDisplayId;
    let cap;
    try {
      cap = await this._capture(id, this._wantAudio());
    } catch (e) {
      if (this.ended) return false;
      console.warn('[panel] capture failed', e);
      this.captureBlocked = !!(e && e.blocked);
      // _capture() pointed main's capture selection at `id`, but we keep streaming prevId: point
      // it back so a later recovery capture gets the right screen. Input mapping never moved — it
      // follows commitDisplay() only.
      if (prevId != null && prevId !== id) {
        try { await this.api.selectDisplay(prevId); } catch { /* best effort */ }
      }
      this.emit('notice', { kind: 'warn', text: this.captureBlocked ? CAPTURE_BLOCKED_TEXT : 'Could not capture that display.' });
      this._sendDisplays();
      return false;
    }
    this.captureBlocked = false;
    if (this.ended) {
      stopStream(cap.stream);
      return false;
    }
    try {
      await this._swapStream(cap.stream);
    } catch (e) {
      if (!this.ended) {
        console.error('[panel] replacing the captured track failed', e);
        this.end('media-failed');
      }
      return false;
    }
    if (this.ended) return false;
    // The new picture is in the sender now: move input mapping (clicks follow what the viewer sees).
    let streamed = await this._commitStreamed(id);
    if (this.ended) return false;
    // A fallback display captured inside another display's size box: capture it at its own size.
    if (streamed !== id && !sameLimit(cap.limit, this._limitFor(streamed))) {
      streamed = await this._recaptureServed(streamed);
      if (this.ended) return false;
    }
    this.currentDisplayId = streamed;
    if (this.wantDisplayId === id) this.wantDisplayId = streamed;
    this._sendDisplays();
    this._sendHostState();
    this.emit('stream', this.streamInfo());
    return true;
  }

  /** Capture size cap of display `id` from the cached list (null = native size). */
  _limitFor(id) {
    return captureSizeLimit(this.displays.find((d) => d.id === String(id)));
  }

  /**
   * Main served `served` in place of a vanished display, inside the size box derived from the
   * vanished one (an ultrawide's 3840×1080 squeezes a 2560×1440 primary to 1920×1080). Capture
   * `served` once more with its own box (null = native size): a screen capture started inside a
   * smaller box does not grow through applyConstraints(). At most this one extra capture per
   * fallback: its own commit result is final. If it fails, the fallback stream (already live and
   * committed) stays. Must run inside _serial(). @returns {Promise<string>} the display streamed now
   */
  async _recaptureServed(served) {
    let cap;
    try {
      cap = await this._capture(served, this._wantAudio());
    } catch (e) {
      // _capture() selected `served`, which is what keeps streaming: nothing to point back.
      if (!this.ended) console.warn('[panel] capturing the served display at its own size failed', e);
      return served;
    }
    if (this.ended) {
      stopStream(cap.stream);
      return served;
    }
    try {
      await this._swapStream(cap.stream);
    } catch (e) {
      if (!this.ended) {
        console.error('[panel] replacing the captured track failed', e);
        this.end('media-failed');
      }
      return served;
    }
    if (this.ended) return served;
    return this._commitStreamed(served);
  }

  async _refreshDisplays() {
    try {
      const list = await this.api.listDisplays();
      if (Array.isArray(list) && list.length) {
        this.displays = list.filter((d) => d && d.id != null).map((d) => ({ ...d, id: String(d.id) }));
      }
    } catch (e) {
      console.warn('[panel] listDisplays failed', e);
    }
  }

  /** Viewer asked for another display. Requests are coalesced: only the latest one is applied. */
  requestDisplay(id) {
    this.wantDisplayId = id;
    void this._serial(async () => {
      const want = this.wantDisplayId;
      await this._refreshDisplays();
      if (this.ended) return;
      if (!this.displays.some((d) => d.id === want)) {
        this.wantDisplayId = this.currentDisplayId;
        this._sendDisplays();
        return;
      }
      if (want === this.currentDisplayId) {
        this._sendDisplays();
        return;
      }
      await this._recapture(want);
    });
  }

  _onVideoEnded(track) {
    if (this.ended || track !== this.videoTrack) return;
    this.liveTracks.delete(track);
    // The OS stopped the capture (display unplugged, permission revoked, …): recapture the same
    // display if it still exists, else the primary one; give up only if that fails.
    this.emit('notice', { kind: 'warn', text: 'Screen capture was interrupted — restarting…' });
    void this._serial(async () => {
      if (this.videoTrack !== track) return;
      await this._refreshDisplays();
      if (this.ended) return;
      const has = this.displays.some((d) => d.id === this.currentDisplayId);
      const fallback = this.displays.find((d) => d.primary) || this.displays[0] || null;
      const target = has ? this.currentDisplayId : fallback ? fallback.id : null;
      if (target == null) {
        this.end('capture-ended');
        return;
      }
      this.wantDisplayId = target;
      const ok = await this._recapture(target);
      if (!ok && !this.ended) this.end(this.captureBlocked ? 'capture-blocked' : 'capture-ended');
    });
  }

  _onAudioEnded(track) {
    if (this.ended || track !== this.audioTrack) return;
    this.liveTracks.delete(track);
    this.audioTrack = null;
    if (this.mediaAttached && this.audioTx) {
      this.audioTx.sender.replaceTrack(null).catch(() => { /* pc closing */ });
    }
    this._sendHostState();
    this.emit('stream', this.streamInfo());
  }

  async _enableAudio() {
    if (this.ended || this.audioTrack || !this.perms.audio || !this.audioTx) return;
    const ok = await this._recapture(this.currentDisplayId);
    if (ok && !this.audioTrack && !this.ended) {
      this.emit('notice', { kind: 'warn', text: 'System audio could not be captured on this computer.' });
    }
  }

  setQuality(preset) {
    if (!PRESETS[preset] || this.ended) return;
    this.quality = preset;
    if (this.videoTrack) {
      try { this.videoTrack.contentHint = PRESETS[preset].contentHint; } catch { /* unsupported */ }
    }
    // Before the media is attached the preset is applied by _attachMedia().
    if (this.videoTx && this.mediaAttached) void this._applyPreset();
    this.emit('stream', this.streamInfo());
  }

  streamInfo() {
    const display = this.displays.find((d) => d.id === this.currentDisplayId) || null;
    let audio = 'unsupported';
    if (this.audioSupported) {
      if (!this.perms.audio) audio = 'off';
      else audio = this.audioTrack && this.audioTrack.readyState === 'live' ? 'on' : 'unavailable';
    }
    return { display, displays: this.displays.slice(), quality: this.quality, codecPreference: this.codec, audio };
  }

  /* ================================ data channels ================================ */

  _wireInput() {
    const ch = this.ch.input;
    ch.addEventListener('message', (e) => {
      if (this.ended || !this.pathOk || !this.perms.control || typeof e.data !== 'string') return;
      const evt = sanitizeInput(parseJson(e.data));
      if (evt) this.api.input(evt);
    });
    // Viewer vanished mid-drag / mid-keypress: never leave keys or buttons held down.
    ch.addEventListener('close', () => this._releaseInput());
  }

  _wireControl() {
    const ch = this.ch.control;
    ch.addEventListener('open', () => {
      this._sendDisplays();
      this._sendHostState();
      this._updateClipboardSync();
    });
    ch.addEventListener('message', (e) => {
      if (typeof e.data === 'string') this._onControl(parseJson(e.data));
    });
    ch.addEventListener('close', () => this._updateClipboardSync());
  }

  _onControl(m) {
    if (!m || this.ended) return;
    switch (m.t) {
      case C.SELECT_DISPLAY: {
        const id = sanitizeDisplayId(m.id);
        if (id && this.limits.display.take()) this.requestDisplay(id);
        break;
      }
      case C.QUALITY:
        if (P.QUALITY_PRESETS.includes(m.preset)) this.setQuality(m.preset);
        break;
      case C.CLIPBOARD:
        this._onRemoteClipboard(sanitizeClipboard(m));
        break;
      case C.CHAT: {
        if (typeof m.text !== 'string' || m.text.length > C.MAX_CHAT || !m.text.trim()) break;
        if (!this.limits.chat.take()) break;
        // Display time is local; the peer's `ts` is not trusted.
        this.emit('chat', { from: 'peer', text: m.text, ts: Date.now() });
        break;
      }
      default:
        break; // unknown / host→viewer-only types are ignored
    }
  }

  /** Viewer clipboard text, whole or in parts (§5). Written only on the tailnet with permission. */
  _onRemoteClipboard(msg) {
    if (!msg) return;
    if (!this.pathOk || !this.perms.clipboard) {
      this.clipAsm.reset();
      return;
    }
    let text = null;
    if (!msg.part) {
      if (this.limits.clipboard.take()) text = msg.text;
    } else if (msg.part.seq === 0 && !this.limits.clipboard.take()) {
      this.clipAsm.reset(); // rate-limited: drop this whole chunked text
    } else {
      text = this.clipAsm.push(msg);
    }
    if (text == null) return;
    Promise.resolve(this.api.writeClipboard({ kind: 'text', text })).catch((e) => {
      console.warn('[panel] clipboard write failed', e);
    });
  }

  _wireFiles() {
    const api = this.api;
    this.transfer = new FileTransfer(
      this.ch.file,
      {
        begin: (meta) => api.fileBegin(meta),
        chunk: (id, data) => api.fileChunk(id, data),
        end: (id) => api.fileEnd(id),
        abort: (id) => api.fileAbort(id),
      },
      {
        canReceive: () => !this.ended && this.pathOk && this.perms.files,
        canReceiveClipboard: () => !this.ended && this.pathOk && this.perms.clipboard,
        onClipboardImage: (png) => {
          if (this.ended || !this.perms.clipboard) return;
          Promise.resolve(api.writeClipboard({ kind: 'image', png })).catch((e) => {
            console.warn('[panel] clipboard image write failed', e);
          });
        },
      },
    );
    this.transfer.addEventListener('update', (e) => this.emit('transfer', e.detail));
  }

  _sendDisplays() {
    if (!this.displays.length || this.currentDisplayId == null) return;
    sendJson(this.ch.control, {
      t: C.DISPLAYS,
      displays: this.displays.map(publicDisplay),
      current: this.currentDisplayId,
    });
  }

  _sendHostState() {
    const controlAllowed = !!(this.perms.control && this.inputStatus.available);
    sendJson(this.ch.control, {
      t: C.HOST_STATE,
      audio: !!(this.perms.audio && this.audioTrack && this.audioTrack.readyState === 'live'),
      // Informational: false also when the OS blocks injection (e.g. macOS Accessibility missing).
      controlAllowed,
      // An elevated window / the secure desktop is in front: injected input cannot reach it.
      inputBlocked: (controlAllowed && this.inputStatus.blocked) || null,
    });
  }

  _releaseInput() {
    try { this.api.releaseAll(); } catch { /* ignore */ }
  }

  /* ================================ host-user actions ================================ */

  /** New permissions (local toggle result or main's onPermissions). */
  setPermissions(perms) {
    if (this.ended) return;
    const prev = this.perms;
    this.perms = { ...perms };
    if (prev.control && !perms.control) this._releaseInput();
    if (this.audioTrack) {
      // Immediately silent; the sender then drops the track entirely (no encoded silence).
      this.audioTrack.enabled = !!perms.audio;
      if (!!prev.audio !== !!perms.audio) void this._serial(() => this._syncAudioSender());
    } else if (perms.audio && !prev.audio && this.audioTx) {
      void this._serial(() => this._enableAudio());
    }
    this._updateClipboardSync();
    if (!perms.clipboard) this.clipAsm.reset();
    if (this.transfer) {
      for (const t of [...this.transfer.transfers.values()]) {
        if (TERMINAL.has(t.state)) continue;
        const revoked = (t.purpose === F.PURPOSE_FILE && !perms.files) || (t.purpose === F.PURPOSE_CLIPBOARD_IMAGE && !perms.clipboard);
        if (revoked) this.transfer.cancel(t.id);
      }
    }
    this._sendHostState();
    this.emit('permissions', { ...this.perms });
    this.emit('stream', this.streamInfo());
  }

  /** status = {available, reason, blocked: null|'secure-desktop'|'elevated-window'} (panel:input-status). */
  setInputStatus(status) {
    this.inputStatus = {
      available: !!status.available,
      reason: status.reason || null,
      blocked: BLOCKED_INPUT.has(status.blocked) ? status.blocked : null,
    };
    this._sendHostState();
  }

  _updateClipboardSync() {
    const want = !this.ended && this.pathOk && !!this.perms.clipboard && this.clipboardSync
      && !!this.ch.control && this.ch.control.readyState === 'open';
    if (want === this.clipboardSyncActive) return;
    this.clipboardSyncActive = want;
    try { this.api.setClipboardSync(want); } catch { /* ignore */ }
  }

  /** Local clipboard changed (main's watcher; only delivered while sync is on). */
  onLocalClipboard(item) {
    if (!this.clipboardSyncActive || this.ended || !item || typeof item !== 'object') return;
    if (item.kind === 'text') {
      if (typeof item.text !== 'string' || item.text.length === 0) return;
      if (item.text.length > C.MAX_CLIPBOARD_TEXT) {
        this.emit('notice', { kind: 'warn', text: 'Clipboard text is too large to sync.' });
        return;
      }
      if (!this._sendClipboardText(item.text) && this.ch.control && this.ch.control.readyState === 'open') {
        this.emit('notice', { kind: 'warn', text: 'Clipboard text could not be synced.' });
      }
    } else if (item.kind === 'image') {
      let png = item.png;
      if (png instanceof ArrayBuffer) png = new Uint8Array(png);
      if (!(png instanceof Uint8Array) || png.byteLength === 0) return;
      if (png.byteLength > F.MAX_CLIPBOARD_IMAGE) {
        this.emit('notice', { kind: 'warn', text: 'Clipboard image is too large to sync.' });
        return;
      }
      if (this.transfer) this.transfer.sendClipboardImage(png);
    }
  }

  /**
   * One message when its JSON fits CLIPBOARD_SINGLE_MAX_BYTES (UTF-8), else parts of
   * ≤ CLIPBOARD_CHUNK_CHARS UTF-16 units (each < 256 KiB even if every unit is \uXXXX-escaped).
   * @returns {boolean} everything was handed to the channel
   */
  _sendClipboardText(text) {
    const whole = { t: C.CLIPBOARD, kind: 'text', text };
    const json = JSON.stringify(whole);
    if (json.length * 3 <= CLIPBOARD_SINGLE_MAX_BYTES || utf8.encode(json).length <= CLIPBOARD_SINGLE_MAX_BYTES) {
      return sendJson(this.ch.control, whole);
    }
    const parts = splitClipboardText(text, CLIPBOARD_CHUNK_CHARS);
    if (parts.length > CLIPBOARD_MAX_PARTS) return false;
    const id = clipboardPartId();
    for (let seq = 0; seq < parts.length; seq++) {
      const part = { id, seq, last: seq === parts.length - 1 };
      if (!sendJson(this.ch.control, { t: C.CLIPBOARD, kind: 'text', text: parts[seq], part })) return false;
    }
    return true;
  }

  /** @returns {{from:'me',text,ts}|null} the sent message, null if not sent */
  sendChat(text) {
    if (this.ended || !this.ch.control || this.ch.control.readyState !== 'open') return null;
    const s = typeof text === 'string' ? text : String(text == null ? '' : text);
    if (!s.trim() || s.length > C.MAX_CHAT) return null;
    const ts = Date.now();
    return sendJson(this.ch.control, { t: C.CHAT, text: s, ts }) ? { from: 'me', text: s, ts } : null;
  }

  /** @returns {string|null} transfer id */
  sendFile(file) {
    if (!this.transfer || this.ended || !this.pathOk || !this.perms.files) return null;
    try {
      return this.transfer.sendFile(file);
    } catch (e) {
      console.warn('[panel] sendFile failed', e);
      return null;
    }
  }

  cancelTransfer(id) {
    return this.transfer ? this.transfer.cancel(id) : false;
  }
}
