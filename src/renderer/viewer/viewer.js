/*
 * Tunnelview — VIEWER window (outgoing session): client side of WebRTC, session UI, wiring.
 * Contracts: docs/ARCHITECTURE.md §4 (viewer phases), §5 (data channels), §9, §10;
 * privileged operations only through window.tunnelviewViewer (src/preload/viewer.js).
 *
 * Flow: register listeners → init = await ready() → main dials the host over Tailscale and pushes
 * status: connecting → hello → waiting | auth-required → accepted → (local) streaming → closed.
 * After `accepted` the host (panel) sends the SDP offer + data channels; this window answers.
 *
 * Trust boundaries handled here: everything from main (status / signals / permissions) and from the
 * peer (control channel, file channel via FileTransfer) is validated in validate.js; ICE candidates
 * and SDP candidate lines are restricted to Tailscale addresses in both directions, and the selected
 * candidate pair is re-verified (local AND remote) after every (re)connection; peer strings are
 * rendered as text only; every file the host offers needs this user's OK (beginIncomingFile).
 */
import { h, $, icon, toast } from '../shared/ui.js';
import {
  RTC_CONFIG, isAllowedCandidate, isTailscaleAddress, setLowLatency, startStats, sendJson, parseJson,
  preferCodecs, verifyTailnetPath, mungeAnswerForSend,
} from '../shared/rtc.js';
import { FileTransfer } from '../shared/transfer.js';
import { shouldSwapCmdCtrl } from '../shared/keys.js';
import { InputController } from './input.js';
import { Toolbar } from './toolbar.js';
import { Overlay, NoticeBanner, inputBlockedMessage, admissionState, waitingView } from './overlay.js';
import { ChatDrawer } from './chat.js';
import { TransfersDrawer, installDropZone, offerAttention } from './transfers.js';
import {
  StatsOverlay, qualityLevel, formatPath, DecoderStallDetector, watchInboundVideo, decodeMsPerFrame, decoderLogInfo,
} from './stats.js';
import { openTextDialog } from './dialog.js';
import { originalCssSize } from './geometry.js';
import { describeClose, effectiveCloseReason, controlBlockReason } from './reasons.js';
import {
  normalizeInit, normalizeStatus, normalizePermissions, validateSignal, validateControl, sanitizeSdp,
  cleanLabel, clipboardMessages, ClipboardAssembler, MAX_CONTROL_MESSAGE,
} from './validate.js';

const P = window.TunnelviewProtocol;
const api = window.tunnelviewViewer;

const MEDIA_TIMEOUT_MS = 30000; // accepted → first video frame
// 'disconnected' / 'failed' mid-session may recover: the host restarts ICE (new offers) and gives up
// after 30 s with 'connection-lost'; waiting a little longer lets its specific reason arrive first.
const ICE_DISCONNECT_GRACE_MS = 35000;
const PATH_INFO_POLL_MS = 5000; // Tailscale direct / DERP-relayed (stats overlay + toolbar tooltip)
const FILE_CONSENT_TIMEOUT_MS = 45000; // incoming file offer unanswered → declined (transfer.js waits 60 s)
const MAX_PENDING_ICE = 256;
const MAX_EARLY_SIGNALS = 300;
const MAX_EARLY_EVENTS = 500;
const INPUT_BACKPRESSURE_BYTES = 256 * 1024; // drop coalescable input (mm/wh) above this
const MAX_TYPE_TEXT = 20000; // "Type clipboard text…" limit (typed char by char on the host)
const PATH_CHECK_DELAYS_MS = [0, 1500, 5000];
const OFFER_TOAST_MS = 12000; // "<host> wants to send you a file" while the chat drawer is in use

/* ------------------------------------------------------------------------------------------ */
/* DOM                                                                                         */
/* ------------------------------------------------------------------------------------------ */

const stage = $('#stage');
const video = $('#video');
const audio = $('#audio');
const sink = $('#ime-sink');
const chip = $('#mode-chip');
const banner = $('#banner');
chip.append(icon('eye', { size: 14 }), h('span'));
banner.append(h('span', { class: 'spinner' }), h('span', null, 'Connection unstable — trying to recover…'));
// Host input blocked by an administrator window / the secure desktop (host-state.inputBlocked).
const blockedBanner = new NoticeBanner($('#banners'), { tone: 'warn', iconName: 'shield' });
// Frames arrive but the video decoder outputs none (stats.js DecoderStallDetector): frozen picture.
const stallBanner = h('div', { class: 'banner banner-warn conn-banner', role: 'status', hidden: true },
  h('span', { class: 'spinner' }), h('span', null, 'Video stalled — recovering…'));
$('#banners').append(stallBanner);

/* ------------------------------------------------------------------------------------------ */
/* State                                                                                       */
/* ------------------------------------------------------------------------------------------ */

const state = {
  init: null,
  phase: 'connecting', // + local 'streaming'
  host: null, // hello info (normalizeStatus)
  remaining: undefined,
  passwordMode: false, // "Use password instead" while waiting
  sessionId: null,
  permissions: normalizePermissions(null),
  hostState: { audio: true, controlAllowed: true, inputBlocked: null },
  viewOnly: false,
  preset: 'balanced',
  codec: 'auto',
  clipboardSync: true,
  swapSetting: 'auto',
  scale: 'fit',
  displays: [],
  currentDisplay: null,
  fullscreen: false,
  muted: false,
  hasAudio: false,
  statsVisible: false,
  quality: null,
  qualityTitle: '',
  chatUnread: 0,
  transfersBadge: 0,
  closeReason: null,
  closeMessage: '',
  closedLocally: false,
  hadVideo: false,
  unstable: false, // ICE disconnected / failed mid-session: the host is restarting ICE
  videoStalled: false, // frames arrive but none are decoded: the picture is frozen
};

let session = null; // per-accepted-session WebRTC state (newSession)
let reconnecting = false;
let clipboardWatching = false;
let lastLocalClipboardText = '';
let lastRemoteClipboardText = null;
let exitingFullscreen = false;
let keyboardLocked = false;
let titleShown = '';
let ready = false;
const earlyEvents = [];
const earlySignals = [];

function newSession(id) {
  return {
    id, pc: null, input: null, control: null, file: null, transfer: null,
    pendingIce: [], remoteSet: false, chain: Promise.resolve(),
    stopStats: null, mediaTimer: 0, iceTimer: 0, pathTimers: [],
    stopDecoderWatch: null, decoderWatch: new DecoderStallDetector(), decoderName: undefined,
    lastDecodeSample: null, decodeMs: null, // latest average decode time per frame (stats overlay, stall logs)
    streaming: false, connectedOnce: false, lastLost: null, lastLostAt: 0,
    route: null, // latest selected ICE pair {local, remote, protocol}
    path: null, // Tailscale path {direct: boolean|null, relay} (main's getPathInfo)
    pathPoll: 0, pathPollBusy: false,
    acceptAllFiles: false, // "Accept all files for this session"
    clipAsm: new ClipboardAssembler(), // clipboard text arriving in parts
  };
}

const channelOpen = (ch) => !!ch && ch.readyState === 'open';

/* ------------------------------------------------------------------------------------------ */
/* Derived values                                                                              */
/* ------------------------------------------------------------------------------------------ */

function hostLabel() {
  const t = state.init && state.init.target;
  return (t && t.hostname) || (state.host && state.host.hostname) || (t && t.ip) || 'the remote device';
}

function hostOs() {
  const h1 = state.host && state.host.os;
  if (h1 === 'windows' || h1 === 'macos') return h1;
  return (state.init && state.init.target.os) || 'other';
}

function userLabel() {
  const tu = state.init && state.init.target.user;
  const hu = state.host && state.host.user;
  return (tu && (tu.displayName || tu.login)) || (hu && (hu.displayName || hu.login)) || '';
}

function swapNow() {
  return shouldSwapCmdCtrl(state.swapSetting, state.init ? state.init.localOs : 'windows', hostOs());
}

/*
 * Also no control while the picture is not live (connection recovering, decoder stalled; see
 * reasons.js controlBlockReason). render() then disables input, which sends release-all first
 * (delivered first on recovery) and drops held-back modifiers; control comes back by itself when
 * the connection / the decoder recovers.
 */
function controlReason() {
  return controlBlockReason({
    control: state.permissions.control,
    controlAllowed: state.hostState.controlAllowed,
    unstable: state.unstable,
    videoStalled: state.videoStalled,
    inputOpen: channelOpen(session && session.input),
    host: hostLabel(),
  });
}

function controlAvailable() {
  return controlReason() === '';
}

function canControl() {
  return state.phase === 'streaming' && !state.viewOnly && controlAvailable();
}

function canSendFiles() {
  if (state.phase !== 'streaming' || !session) return { ok: false, reason: 'Files can be sent once the session is running.' };
  if (!state.permissions.files) return { ok: false, reason: `File transfer is turned off on ${hostLabel()}.` };
  if (!session.transfer || !channelOpen(session.file)) return { ok: false, reason: 'The file channel is not ready yet.' };
  return { ok: true };
}

/* ------------------------------------------------------------------------------------------ */
/* UI components                                                                               */
/* ------------------------------------------------------------------------------------------ */

const overlay = new Overlay($('#overlay'), {
  cancel: () => {
    input.releaseAll(true);
    api.disconnect('viewer-cancelled');
    api.closeWindow();
  },
  submitPassword: (pw) => api.submitPassword(pw),
  usePassword: () => { state.passwordMode = true; render(); },
  backToWaiting: () => { state.passwordMode = false; render(); },
  reconnect: () => reconnect(),
  close: () => api.closeWindow(),
});

const input = new InputController({
  stage,
  video,
  sink,
  send: sendInput,
  getSwap: swapNow,
  getScale: () => state.scale,
  localOs: 'windows', // replaced after init (see applyInit)
  getHostOs: () => hostOs(),
  isFullscreen: () => state.fullscreen,
  onExitFullscreen: () => exitFullscreen(),
  onToolbarShortcut: () => toolbar.toggleReveal(),
  onEscapeLocal: () => toolbar.closePopover(),
});

const drawerHost = $('#drawers');

const chat = new ChatDrawer(drawerHost, {
  send: (text) => sendControl({ t: P.CONTROL.CHAT, text, ts: Date.now() }),
  peerName: () => userLabel() || hostLabel(),
  onUnread: (n) => { state.chatUnread = n; updateToolbar(); },
  notify: (title, body) => api.notify(title, body),
  onClosed: (opts) => drawerClosed(opts, 'chat'),
});

const transfers = new TransfersDrawer(drawerHost, {
  reveal: (id) => api.fileReveal(id),
  openFolder: () => api.openDownloads(),
  pickFiles: () => toolbar.pickFiles(),
  onBadge: (n) => { state.transfersBadge = n; updateToolbar(); },
  onClosed: (opts) => drawerClosed(opts, 'transfers'),
});

/** A drawer closed: give the keyboard back to the remote, unless another drawer takes over. */
function drawerClosed(opts, which) {
  if (opts && opts.restoreFocus === false) {
    render();
    return;
  }
  input.focus();
  // A file offer that arrived while the user was busy in the chat is still waiting for an answer:
  // show it now, like an offer arriving with no drawer open (the drawer takes no focus).
  if (which === 'chat' && transfers.pendingConsents > 0 && !transfers.isOpen) transfers.open();
  render();
}

/**
 * Switch to the Transfers drawer. Leaving the chat this way must not hand the keyboard to the
 * remote (the rest of a message would be typed on the host): focus goes to the Transfers drawer
 * itself (data-local-keys), never to its Accept button. `focus` also moves it there when no
 * drawer was open (user clicked "Review").
 */
function showTransfers({ focus = false } = {}) {
  const fromChat = chat.isOpen;
  if (fromChat) chat.close({ restoreFocus: false });
  if (!transfers.isOpen) transfers.open();
  if (fromChat || focus) transfers.focus();
  render();
}

function showChat() {
  transfers.close({ restoreFocus: false }); // chat.open() focuses its message box
  chat.open();
  render();
}

const stats = new StatsOverlay($('#hud'));

const toolbar = new Toolbar($('#toolbar-host'), {
  localOs: 'windows', // replaced after init
  avoid: chip, // moved below the toolbar when they would overlap
  actions: {
    selectDisplay: (id) => selectDisplay(id),
    setPreset: (p) => setPreset(p),
    setScale: (m) => { state.scale = m === 'original' ? 'original' : 'fit'; applyScale(); render(); },
    toggleViewOnly: () => toggleViewOnly(),
    setSwap: (s) => setSwap(s),
    toggleClipboard: () => toggleClipboard(),
    sendCombo: (codes) => { if (!input.sendCombo(codes)) toast("Couldn't send the keys — remote control is not available.", { kind: 'warn' }); },
    openTypeText: () => openTypeText(),
    sendFiles: (files) => sendFiles(files),
    toggleChat: () => { if (chat.isOpen) chat.close(); else showChat(); render(); },
    toggleTransfers: () => { if (transfers.isOpen) transfers.close(); else showTransfers(); render(); },
    screenshot: () => { takeScreenshot().catch((err) => toast(`Screenshot failed: ${cleanLabel(err && err.message, 120)}`, { kind: 'danger' })); },
    toggleStats: () => { state.statsVisible = !state.statsVisible; render(); },
    toggleMute: () => { state.muted = !state.muted; render(); },
    toggleFullscreen: () => { if (state.fullscreen) exitFullscreen(); else enterFullscreen(); },
    disconnect: () => userDisconnect(),
    releaseInput: () => input.releaseAll(false),
  },
});

installDropZone($('#drop-host'), {
  canDrop: canSendFiles,
  onFiles: (files) => sendFiles(files),
  targetName: hostLabel,
});

/* ------------------------------------------------------------------------------------------ */
/* Rendering                                                                                   */
/* ------------------------------------------------------------------------------------------ */

function overlayView() {
  const t = state.init ? state.init.target : { ip: '', port: P.DEFAULT_PORT };
  const base = { host: hostLabel(), ip: t.ip, port: t.port, os: hostOs(), user: userLabel() };
  switch (state.phase) {
    case 'connecting': return { ...base, kind: 'connecting' };
    case 'hello': return { ...base, kind: 'hello' };
    case 'waiting':
      // `remaining` after a wrong password: the request now waits for approval instead.
      return waitingView(base, {
        passwordMode: state.passwordMode, passwordSet: !!(state.host && state.host.passwordSet), remaining: state.remaining,
      });
    case 'auth-required':
      return { ...base, kind: 'password', remaining: state.remaining, passwordOnly: !!(state.host && state.host.acceptMode === 'password-only') };
    case 'accepted': return { ...base, kind: 'accepted' };
    case 'closed': {
      const d = describeClose(state.closeReason, closeContext());
      // A reason whose text already includes what main's message says (e.g. the wait before trying
      // again) returns its own detail ('' = none); otherwise main's message is the detail line.
      return { ...base, kind: 'closed', ...d, detail: d.detail !== undefined ? d.detail : state.closeMessage };
    }
    default: return null; // streaming
  }
}

/** describeClose() context (display strings + what we know about the host). */
function closeContext() {
  return {
    host: hostLabel(),
    user: userLabel(),
    hadVideo: state.hadVideo,
    passwordSet: state.host ? state.host.passwordSet : undefined,
    message: state.closeMessage, // main's status message (e.g. '… Try again in 29 seconds.')
  };
}

/** "Tailscale path: Direct" etc. for the toolbar host tooltip ('' when unknown). */
function pathSummary() {
  const p = session && session.path;
  const text = formatPath(p);
  return text === '—' ? '' : `Tailscale path: ${text}`;
}

function toolbarModel() {
  const files = canSendFiles();
  return {
    hostName: hostLabel(),
    hostOs: hostOs(),
    quality: state.quality,
    qualityTitle: state.qualityTitle,
    pathTitle: pathSummary(),
    displays: state.displays,
    currentDisplay: state.currentDisplay,
    preset: state.preset,
    scale: state.scale,
    viewOnly: state.viewOnly,
    controlAvailable: controlAvailable(),
    controlReason: controlReason(),
    swapSetting: state.swapSetting,
    swapEffective: swapNow(),
    clipboardSync: state.clipboardSync,
    clipboardAllowed: state.permissions.clipboard,
    filesAllowed: state.permissions.files,
    filesReady: files.ok,
    transfersBadge: state.transfersBadge,
    chatUnread: state.chatUnread,
    chatOpen: chat.isOpen,
    transfersOpen: transfers.isOpen,
    statsVisible: state.statsVisible,
    hasAudio: state.hasAudio,
    audioAllowed: state.permissions.audio,
    muted: state.muted,
    fullscreen: state.fullscreen,
  };
}

function updateToolbar() {
  toolbar.update(toolbarModel());
}

function render() {
  const view = overlayView();
  if (view) overlay.show(view);
  else overlay.hide();

  const streaming = state.phase === 'streaming';
  input.setEnabled(canControl());
  updateClipboardWatch();
  chat.setEnabled(streaming && channelOpen(session && session.control));
  const files = canSendFiles();
  transfers.setCanSend(files.ok, files.reason || '');
  toolbar.setActive(streaming);
  updateToolbar();
  stats.setVisible(state.statsVisible && streaming);
  audio.muted = state.muted || !state.permissions.audio;

  // "View only" chip so the user knows why clicks do nothing while the toolbar is hidden (short:
  // it sits left of the toolbar; the full reason is in the toolbar's view-only button tooltip).
  const showChip = streaming && !canControl();
  chip.hidden = !showChip;
  if (showChip) {
    chip.lastElementChild.textContent = state.viewOnly ? 'View only'
      : !state.permissions.control ? 'View only · host'
        : state.unstable ? 'View only · recovering'
          : state.videoStalled ? 'View only · video stalled' : 'View only · no input';
  }
  document.body.classList.toggle('drawer-open', chat.isOpen || transfers.isOpen);

  banner.hidden = !(state.unstable && (streaming || state.phase === 'accepted'));
  stallBanner.hidden = !(state.videoStalled && streaming && !state.unstable);
  // Only relevant while the user is actually trying to control the host.
  blockedBanner.set(canControl() ? inputBlockedMessage(state.hostState.inputBlocked, hostLabel()) : '');
  document.body.dataset.phase = state.phase;
  updateTitle();
}

function updateTitle() {
  const t = state.init && state.init.target;
  const title = t && (t.hostname || t.ip) ? `${hostLabel()} — Tunnelview` : 'Tunnelview';
  if (title !== titleShown) {
    titleShown = title;
    api.setTitle(title);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Status from main                                                                            */
/* ------------------------------------------------------------------------------------------ */

function onStatus(raw) {
  const st = normalizeStatus(raw);
  if (!st) return;
  // After a local close (Disconnect / media failure) main still reports its own 'closed'; anything
  // else is stale unless the user asked to reconnect.
  if (state.phase === 'closed' && st.phase !== 'closed' && !reconnecting) return;
  if (st.host) state.host = st.host;

  switch (st.phase) {
    case 'connecting':
    case 'hello':
    case 'waiting':
    case 'auth-required':
      // phase, attempts left after a wrong password (kept while the request waits for approval),
      // "Use password instead" (see overlay.js admissionState).
      if (session) teardownSession();
      Object.assign(state, admissionState(state, st));
      break;
    case 'accepted':
      onAccepted(st);
      break;
    case 'closed': {
      reconnecting = false;
      if (state.phase === 'closed' && state.closedLocally) return; // keep the more specific local reason
      // The host ended it: show its own reason (capture failed, Tailscale stopped, …) when known.
      const reason = effectiveCloseReason(st.reason, st.hostReason);
      showClosed(reason, reason === st.reason ? st.message : '', false);
      return;
    }
    default:
      return;
  }
  reconnecting = false;
  render();
}

function onAccepted(st) {
  if (st.permissions) state.permissions = st.permissions;
  state.passwordMode = false;
  state.remaining = undefined;
  if (session && (!st.sessionId || session.id === st.sessionId)) return; // repeated status
  teardownSession();
  state.sessionId = st.sessionId || null;
  const s = newSession(state.sessionId);
  session = s;
  createPeerConnection(s);
  s.mediaTimer = setTimeout(() => { if (session === s && !s.streaming) failLocal('media-timeout'); }, MEDIA_TIMEOUT_MS);
  state.phase = 'accepted';
  for (const m of earlySignals.splice(0)) enqueueSignal(s, m);
}

function onPermissions(raw) {
  const next = normalizePermissions(raw);
  const prev = state.permissions;
  state.permissions = next;
  if (session && (state.phase === 'streaming' || state.phase === 'accepted')) {
    const host = hostLabel();
    const msgs = {
      control: ['Remote control enabled by the host', `${host} turned off remote control — view only`],
      clipboard: ['Clipboard sync enabled by the host', `${host} turned off clipboard sync`],
      files: ['File transfer enabled by the host', `${host} turned off file transfer`],
      audio: ['Audio enabled by the host', `${host} turned off audio`],
    };
    for (const k of P.PERMISSION_KEYS) {
      if (prev[k] !== next[k]) toast(next[k] ? msgs[k][0] : msgs[k][1], { kind: next[k] ? 'ok' : 'warn' });
    }
    // Stop pushing data the host will refuse anyway.
    if (prev.files && !next.files && session.transfer) {
      for (const t of [...session.transfer.transfers.values()]) {
        if (t.direction === 'out' && t.purpose === P.FILE.PURPOSE_FILE && ['queued', 'offered', 'sending'].includes(t.state)) {
          session.transfer.cancel(t.id);
        }
      }
    }
  }
  render();
}

/* ------------------------------------------------------------------------------------------ */
/* WebRTC                                                                                      */
/* ------------------------------------------------------------------------------------------ */

function createPeerConnection(s) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  s.pc = pc;

  pc.addEventListener('icecandidate', (e) => {
    if (session !== s) return;
    const c = e.candidate;
    if (!c) {
      api.sendSignal({ t: P.MSG.ICE, candidate: null });
      return;
    }
    const init = typeof c.toJSON === 'function' ? c.toJSON() : c;
    // Only Tailscale host candidates leave this machine (§1.5): no LAN / public / mDNS addresses.
    if (!isAllowedCandidate(init)) return;
    api.sendSignal({
      t: P.MSG.ICE,
      candidate: {
        candidate: init.candidate,
        sdpMid: init.sdpMid ?? null,
        sdpMLineIndex: init.sdpMLineIndex ?? null,
        usernameFragment: init.usernameFragment ?? null,
      },
    });
  });
  pc.addEventListener('track', (e) => onTrack(s, e));
  pc.addEventListener('datachannel', (e) => onDataChannel(s, e.channel));
  pc.addEventListener('connectionstatechange', () => onConnectionState(s));
  s.stopStats = startStats(pc, (st) => onStats(s, st), 1000);
  s.stopDecoderWatch = watchInboundVideo(pc, (sample) => onDecoderSample(s, sample));
}

function enqueueSignal(s, msg) {
  s.chain = s.chain
    .then(() => handleSignal(s, msg))
    .catch((err) => {
      console.warn('[viewer] signaling failed:', err && err.message);
      // A failed ICE-restart renegotiation mid-session is a lost connection, not "video couldn't start".
      if (session === s && msg.t === P.MSG.SDP) failLocal(s.connectedOnce ? 'network' : 'media-failed');
    });
}

function onSignal(raw) {
  const msg = validateSignal(raw);
  if (!msg || state.phase === 'closed') return;
  if (!session) {
    // Offer racing ahead of the 'accepted' status: keep it for the session about to start.
    if (earlySignals.length < MAX_EARLY_SIGNALS) earlySignals.push(msg);
    return;
  }
  enqueueSignal(session, msg);
}

async function handleSignal(s, msg) {
  if (session !== s) return;
  const pc = s.pc;
  if (msg.t === P.MSG.SDP) {
    // The viewer is always the answerer (offers only — validated). This handles the first offer and
    // every later one on the same PC: the host recovers from network stalls with ICE restarts
    // (new offers mid-session, arriving in signalingState 'stable'). Signals are applied strictly
    // in order through s.chain, so a re-offer always finds the previous exchange completed.
    const sdp = sanitizeSdp(msg.description.sdp, isAllowedCandidate);
    await pc.setRemoteDescription({ type: 'offer', sdp });
    if (session !== s) return;
    s.remoteSet = true;
    for (const c of s.pendingIce.splice(0)) await addIce(pc, c);
    applyCodecPreference(pc);
    const answer = await pc.createAnswer();
    if (session !== s) return;
    // Opus stereo=1 in OUR answer: libwebrtc builds the receiving Opus decoder from the local
    // description and defaults to mono without it (the host's own munging only configures its
    // encoder). Every answer, ICE-restart re-offers included. Never duplicates keys.
    let applied = answer.sdp;
    const stereo = mungeAnswerForSend(answer.sdp, { opusStereo: true });
    if (typeof stereo === 'string' && stereo && stereo !== answer.sdp) {
      try {
        await pc.setLocalDescription({ type: 'answer', sdp: stereo });
        applied = stereo;
      } catch (err) {
        if (session !== s) return;
        console.warn('[viewer] stereo answer refused, using the unmodified one:', err && err.message);
        await pc.setLocalDescription(answer);
      }
    } else {
      await pc.setLocalDescription(answer);
    }
    if (session !== s) return;
    // The SDP that was actually applied, Tailscale candidates only.
    api.sendSignal({ t: P.MSG.SDP, description: { type: 'answer', sdp: sanitizeSdp(applied, isAllowedCandidate) } });
    return;
  }
  if (msg.t === P.MSG.ICE) {
    const c = msg.candidate;
    if (c && !isAllowedCandidate(c)) return; // remote candidate outside the tailnet: never try it
    if (!s.remoteSet) {
      if (s.pendingIce.length < MAX_PENDING_ICE) s.pendingIce.push(c);
      return;
    }
    await addIce(pc, c);
  }
}

async function addIce(pc, c) {
  try {
    if (c === null) await pc.addIceCandidate(); // end-of-candidates
    else await pc.addIceCandidate(c);
  } catch (err) {
    console.debug('[viewer] addIceCandidate:', err && err.message);
  }
}

/** Viewer codec preference: the answerer's codec order decides what the host's sender uses. */
function applyCodecPreference(pc) {
  if (state.codec === 'auto') return; // host already prefers H264 → VP9 → VP8
  for (const t of pc.getTransceivers()) {
    const kind = t.receiver && t.receiver.track && t.receiver.track.kind;
    if (kind === 'video') {
      try { preferCodecs(t, state.codec); } catch { /* unsupported codec: keep defaults */ }
    }
  }
}

function onTrack(s, e) {
  if (session !== s) return;
  for (const r of s.pc.getReceivers()) setLowLatency(r);
  const track = e.track;
  if (track.kind === 'video') {
    video.srcObject = new MediaStream([track]);
    video.play().catch(() => { /* muted autoplay is always allowed; retried on 'loadeddata' */ });
    // First decoded frame → 'streaming' (also covered by loadeddata/playing/resize below).
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(() => onVideoFrameReady());
  } else if (track.kind === 'audio') {
    // Separate element: the <video> stays muted so mute/unmute never interrupts the picture.
    audio.srcObject = new MediaStream([track]);
    state.hasAudio = true;
    audio.muted = state.muted || !state.permissions.audio;
    audio.play().catch(() => {});
    track.addEventListener('ended', () => { if (session === s) { state.hasAudio = false; render(); } });
    render();
  }
}

function onDataChannel(s, ch) {
  if (session !== s) { try { ch.close(); } catch { /* ignore */ } return; }
  const C = P.CHANNEL;
  const reject = () => { try { ch.close(); } catch { /* ignore */ } };
  switch (ch.label) {
    case C.INPUT:
      if (s.input) return reject();
      s.input = ch; // viewer → host only; anything the host sends here is ignored
      ch.addEventListener('open', () => { if (session === s) render(); });
      ch.addEventListener('close', () => { if (session === s) render(); });
      break;
    case C.CONTROL:
      if (s.control) return reject();
      s.control = ch;
      ch.addEventListener('open', () => onControlOpen(s));
      ch.addEventListener('close', () => { if (session === s) render(); });
      ch.addEventListener('message', (ev) => onControlMessage(s, ev.data));
      if (ch.readyState === 'open') onControlOpen(s);
      break;
    case C.FILE:
      if (s.file) return reject();
      s.file = ch;
      // FileTransfer owns ch.onmessage; only listen to open/close here.
      s.transfer = new FileTransfer(ch, {
        begin: (meta) => beginIncomingFile(s, meta),
        chunk: (id, data) => api.fileChunk(id, data),
        end: (id) => api.fileEnd(id),
        abort: (id) => api.fileAbort(id),
      }, {
        canReceive: () => session === s && state.permissions.files,
        canReceiveClipboard: () => session === s && clipboardWatching,
        onClipboardImage: (png) => {
          if (session !== s || !clipboardWatching) return;
          api.writeClipboard({ kind: 'image', png }).catch((err) => console.warn('[viewer] clipboard image write failed', err));
        },
      });
      transfers.attach(s.transfer);
      ch.addEventListener('open', () => { if (session === s) render(); });
      ch.addEventListener('close', () => { if (session === s) render(); });
      break;
    default:
      return reject(); // unknown channel from the peer
  }
  render();
}

/**
 * FileTransfer sink.begin for an incoming file offer: the host's permission alone is not enough —
 * the user at THIS computer must accept each file (or "all files for this session") before anything
 * is written to disk. Declined / unanswered (45 s) → {ok:false, reason:'declined'} → file-reject.
 * The host can trigger this at any time, so it never takes the user out of the chat drawer (focus
 * would fall back to the remote and the rest of their message would be typed on the host): then
 * only a toast points at the request (offerAttention). The Transfers badge counts the offer.
 * (Clipboard images never get here: transfer.js assembles them in memory.)
 */
async function beginIncomingFile(s, meta) {
  if (session !== s || !state.permissions.files) return { ok: false, reason: 'not-allowed' };
  if (!s.acceptAllFiles) {
    const how = offerAttention({ chatOpen: chat.isOpen, transfersOpen: transfers.isOpen });
    if (how === 'open-transfers') transfers.open(); // takes no focus: typing on the remote can't accept it
    else if (how === 'notify') fileOfferToast();
    render();
    if (!document.hasFocus()) api.notify(`Tunnelview — ${hostLabel()}`, `${hostLabel()} wants to send you a file`);
    const answer = await transfers.requestConsent({
      id: meta.id, name: meta.name, size: meta.size, from: hostLabel(), timeoutMs: FILE_CONSENT_TIMEOUT_MS,
    });
    if (session !== s || !answer.accept) return { ok: false, reason: 'declined' };
    if (answer.all) s.acceptAllFiles = true;
    if (!state.permissions.files) return { ok: false, reason: 'not-allowed' }; // revoked meanwhile
  }
  return api.fileBegin(meta);
}

let offerToastUntil = 0;

/** "<host> wants to send you a file — Review" while the chat drawer is open (one at a time). */
function fileOfferToast() {
  const now = performance.now();
  if (now < offerToastUntil) return; // the visible one already says so
  offerToastUntil = now + OFFER_TOAST_MS;
  const review = h('button', {
    type: 'button', class: 'btn btn-sm',
    onClick: () => { offerToastUntil = 0; if (session && state.phase === 'streaming') showTransfers({ focus: true }); },
  }, 'Review');
  // mousedown default prevented: clicking the toast must not pull focus out of the chat box.
  toast(h('div', { class: 'row', onMousedown: (e) => e.preventDefault() },
    h('span', { class: 'grow' }, `${hostLabel()} wants to send you a file`), review), { kind: 'info', timeout: OFFER_TOAST_MS });
}

function onControlOpen(s) {
  if (session !== s) return;
  // The viewer's remembered preset wins over the host default.
  sendJson(s.control, { t: P.CONTROL.QUALITY, preset: state.preset });
  render();
}

function onControlMessage(s, data) {
  if (session !== s || typeof data !== 'string' || data.length > MAX_CONTROL_MESSAGE) return;
  const msg = validateControl(parseJson(data));
  if (!msg) return;
  const C = P.CONTROL;
  switch (msg.t) {
    case C.DISPLAYS:
      state.displays = msg.displays;
      state.currentDisplay = msg.current;
      render();
      break;
    case C.CLIPBOARD: {
      if (!clipboardWatching) {
        s.clipAsm.reset();
        return;
      }
      let text = msg.text;
      if (msg.part) {
        text = s.clipAsm.push(msg); // large text arrives in parts; null until the last one
        if (text === null) return;
      } else {
        s.clipAsm.reset(); // a newer whole clipboard supersedes any partial one
      }
      lastRemoteClipboardText = text;
      api.writeClipboard({ kind: 'text', text }).catch((err) => console.warn('[viewer] clipboard write failed', err));
      break;
    }
    case C.CHAT:
      chat.receive(msg.text);
      if (!chat.isOpen && document.hasFocus()) {
        const preview = msg.text.length > 120 ? `${msg.text.slice(0, 119)}…` : msg.text;
        toast(`${userLabel() || hostLabel()}: ${preview}`, { kind: 'info', timeout: 5000 });
      }
      break;
    case C.HOST_STATE: {
      if (typeof msg.controlAllowed === 'boolean' && msg.controlAllowed !== state.hostState.controlAllowed) {
        state.hostState.controlAllowed = msg.controlAllowed;
        // Only announce when it is not simply the permission toggle (that has its own toast).
        if (state.permissions.control) {
          toast(msg.controlAllowed ? 'Remote control is available again'
            : `Remote input isn't available on ${hostLabel()} right now (the host may need to grant input permissions).`,
          { kind: msg.controlAllowed ? 'ok' : 'warn', timeout: 6000 });
        }
      }
      if (typeof msg.audio === 'boolean') state.hostState.audio = msg.audio;
      if (msg.inputBlocked !== undefined) state.hostState.inputBlocked = msg.inputBlocked; // null | 'secure-desktop' | 'elevated-window'
      render();
      break;
    }
    default:
      break;
  }
}

function onConnectionState(s) {
  if (session !== s) return;
  const st = s.pc.connectionState;
  if (st === 'connected') {
    s.connectedOnce = true;
    clearTimeout(s.iceTimer);
    s.iceTimer = 0;
    if (state.unstable) { state.unstable = false; render(); }
    schedulePathChecks(s); // also after every recovery: the new pair is verified again
  } else if (st === 'disconnected' || (st === 'failed' && s.connectedOnce)) {
    // Mid-session the host restarts ICE (new offers, answered in handleSignal) and gives up after
    // 30 s itself; 'failed' is not final while it does. One deadline from the first stall: the
    // states in between ('connecting', 'failed'…) do not extend it, only 'connected' clears it.
    // Meanwhile no control (controlAvailable): render() disables input → release-all.
    state.unstable = true;
    render();
    if (!s.iceTimer) {
      s.iceTimer = setTimeout(() => {
        s.iceTimer = 0;
        if (session === s && s.pc.connectionState !== 'connected') failLocal(s.streaming || s.connectedOnce ? 'network' : 'media-failed');
      }, ICE_DISCONNECT_GRACE_MS);
    }
  } else if (st === 'failed') {
    failLocal('media-failed'); // never connected: no ICE restart is coming
  }
}

/**
 * Defense in depth for §1.5: the host verifies the selected pair, the viewer does too.
 * verifyTailnetPath() reports ok:false when the local OR remote address of the selected pair is
 * present and outside the tailnet (e.g. a LAN local candidate paired with a 100.x remote — which
 * could reach a CGNAT impostor instead of the peer); absent / redacted addresses are ok because
 * every signalled candidate was already filtered. The latest pair is kept for the stats overlay.
 */
function schedulePathChecks(s) {
  for (const t of s.pathTimers) clearTimeout(t);
  s.pathTimers = PATH_CHECK_DELAYS_MS.map((ms) => setTimeout(async () => {
    if (session !== s) return;
    try {
      const r = await verifyTailnetPath(s.pc);
      if (session !== s || !r) return;
      if (r.ok === false) {
        console.warn('[viewer] selected ICE pair leaves the tailnet: local', r.local, 'remote', r.remote);
        failLocal('non-tailnet-path');
        return;
      }
      if (r.pair) {
        const addr = (a) => (typeof a === 'string' && isTailscaleAddress(a) ? cleanLabel(a, 64) : null);
        s.route = { local: addr(r.local), remote: addr(r.remote), protocol: typeof r.protocol === 'string' ? cleanLabel(r.protocol, 8) : null };
        stats.setRoute(s.route);
      }
    } catch { /* stats unavailable */ }
  }, ms));
}

/** Poll main for the Tailscale path (direct vs DERP-relayed) while streaming. Feature-detected. */
function startPathInfoPoll(s) {
  if (s.pathPoll || typeof api.getPathInfo !== 'function') return;
  const poll = async () => {
    if (session !== s || s.pathPollBusy) return;
    s.pathPollBusy = true;
    let res = null;
    try { res = await api.getPathInfo(); } catch { res = null; }
    s.pathPollBusy = false;
    if (session !== s) return;
    const path = res && res.ok === true
      ? { direct: typeof res.direct === 'boolean' ? res.direct : null, relay: cleanLabel(res.relay, 32) }
      : null;
    if (JSON.stringify(path) === JSON.stringify(s.path)) return;
    s.path = path;
    stats.setPath(path);
    updateToolbar();
  };
  s.pathPoll = setInterval(poll, PATH_INFO_POLL_MS);
  poll();
}

/**
 * Decoder stall watchdog (stats.js): frames keep arriving but none are decoded → frozen picture.
 * While it lasts: notice + no control (render → input disabled, release-all). Logged with the
 * decoder in use and the PLI count so a two-machine run can confirm the cause. Never reconnects
 * on its own (that would ask the person at the host again).
 */
function onDecoderSample(s, sample) {
  if (session !== s || !sample) return;
  if (sample.decoder !== s.decoderName) {
    s.decoderName = sample.decoder; // normally never known here (Chromium withholds it from this page)
    stats.setDecoder(sample.decoder);
  }
  // Average decode time per frame since the previous sample; kept while no frame is decoded
  // (static screen, stall), so the stall log shows the last measured value.
  const ms = decodeMsPerFrame(s.lastDecodeSample, sample);
  s.lastDecodeSample = sample;
  if (ms !== null) {
    s.decodeMs = ms;
    stats.setDecodeTime(ms);
  }
  const ev = s.decoderWatch.update(sample, performance.now());
  if (!ev) return;
  const info = decoderLogInfo(ev, sample, s.decodeMs);
  if (ev.type === 'stalled') {
    console.warn(`[viewer] video decoder stalled: ${ev.framesReceivedDelta} frames received, none decoded for ${Math.round(ev.sinceMs)} ms`, info);
    state.videoStalled = true;
  } else {
    console.warn(`[viewer] video decoder recovered after a ${Math.round(ev.durationMs)} ms stall`, info);
    state.videoStalled = false;
  }
  render();
}

function onStats(s, st) {
  if (session !== s || !st || st.direction !== 'inbound') return;
  stats.update(st);
  const now = performance.now();
  let lostPerSec = 0;
  if (Number.isFinite(st.packetsLost)) {
    if (s.lastLost !== null && now > s.lastLostAt) {
      lostPerSec = Math.max(0, st.packetsLost - s.lastLost) / ((now - s.lastLostAt) / 1000);
    }
    s.lastLost = st.packetsLost;
    s.lastLostAt = now;
  }
  const q = qualityLevel(st.rttMs, lostPerSec);
  const parts = [];
  if (Number.isFinite(st.rttMs)) parts.push(`${Math.round(st.rttMs)} ms round trip`);
  if (lostPerSec > 0) parts.push(`${lostPerSec.toFixed(1)} packets lost/s`);
  if (Number.isFinite(st.fps)) parts.push(`${Math.round(st.fps)} fps`);
  const title = parts.join(' · ');
  if (q !== state.quality || title !== state.qualityTitle) {
    state.quality = q;
    state.qualityTitle = title;
    updateToolbar();
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Video element                                                                               */
/* ------------------------------------------------------------------------------------------ */

function onVideoFrameReady() {
  applyScale();
  const s = session;
  if (!s || !video.videoWidth || s.streaming) return;
  s.streaming = true;
  state.hadVideo = true;
  clearTimeout(s.mediaTimer);
  if (state.phase === 'accepted') state.phase = 'streaming';
  startPathInfoPoll(s);
  render();
  input.focus();
}

function applyScale() {
  const original = state.scale === 'original' && video.videoWidth > 0;
  stage.classList.toggle('mode-original', original);
  if (original) {
    const { width, height } = originalCssSize(video.videoWidth, video.videoHeight, window.devicePixelRatio);
    video.style.width = `${width}px`;
    video.style.height = `${height}px`;
  } else {
    video.style.width = '';
    video.style.height = '';
    stage.scrollLeft = 0;
    stage.scrollTop = 0;
  }
}

/** Re-apply 1:1 sizing when the window moves to a monitor with another devicePixelRatio. */
function watchDevicePixelRatio() {
  const mq = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  mq.addEventListener('change', () => { applyScale(); watchDevicePixelRatio(); }, { once: true });
}

video.addEventListener('loadeddata', () => { video.play().catch(() => {}); onVideoFrameReady(); });
video.addEventListener('playing', onVideoFrameReady);
video.addEventListener('resize', onVideoFrameReady); // host switched display / resolution
window.addEventListener('resize', () => { if (state.scale === 'original') applyScale(); });
watchDevicePixelRatio();

/* ------------------------------------------------------------------------------------------ */
/* Input / control senders                                                                     */
/* ------------------------------------------------------------------------------------------ */

function sendInput(msg, opts) {
  const ch = session && session.input;
  if (!channelOpen(ch)) return false;
  // Moves and wheel deltas are superseded by the next ones; drop them while the channel is backed up
  // (presses/releases/keys are never dropped).
  if (opts && opts.droppable && ch.bufferedAmount > INPUT_BACKPRESSURE_BYTES) return false;
  return sendJson(ch, msg);
}

function sendControl(msg) {
  const ch = session && session.control;
  return channelOpen(ch) ? sendJson(ch, msg) : false;
}

function selectDisplay(id) {
  if (!state.displays.some((d) => d.id === id)) return;
  if (sendControl({ t: P.CONTROL.SELECT_DISPLAY, id })) {
    input.releaseAll(false);
    state.currentDisplay = id; // optimistic; the host confirms with a new `displays`
    render();
  } else {
    toast("Couldn't switch display — the control channel is not ready.", { kind: 'warn' });
  }
}

function setPreset(p) {
  if (!P.QUALITY_PRESETS.includes(p) || p === state.preset) return;
  state.preset = p;
  sendControl({ t: P.CONTROL.QUALITY, preset: p });
  savePrefs({ quality: p });
  render();
}

function toggleViewOnly() {
  state.viewOnly = !state.viewOnly;
  render();
  toast(state.viewOnly ? 'View only — your mouse and keyboard stay on this computer' : `You are controlling ${hostLabel()}`, { timeout: 2500 });
}

function setSwap(s) {
  if (!['auto', 'on', 'off'].includes(s) || s === state.swapSetting) return;
  input.releaseAll(true); // never leave a modifier held under its old mapping
  state.swapSetting = s;
  savePrefs({ swapCmdCtrl: s });
  render();
}

function toggleClipboard() {
  state.clipboardSync = !state.clipboardSync;
  savePrefs({ clipboardSync: state.clipboardSync });
  render();
  toast(state.clipboardSync ? 'Clipboard sync on' : 'Clipboard sync off', { timeout: 2000 });
}

function savePrefs(partial) {
  Promise.resolve(api.updatePrefs(partial)).catch((err) => console.warn('[viewer] updatePrefs failed', err));
}

/* ------------------------------------------------------------------------------------------ */
/* Clipboard sync                                                                              */
/* ------------------------------------------------------------------------------------------ */

function updateClipboardWatch() {
  const want = state.phase === 'streaming' && state.clipboardSync && state.permissions.clipboard;
  if (want === clipboardWatching) return;
  clipboardWatching = want;
  api.setClipboardSync(want);
}

/** Local clipboard changed (main's watcher; only delivered while sync is enabled). */
function onLocalClipboard(item) {
  if (!item || typeof item !== 'object') return;
  if (item.kind === 'text' && typeof item.text === 'string') lastLocalClipboardText = item.text;
  if (!clipboardWatching || !session) return;
  const C = P.CONTROL;
  if (item.kind === 'text' && typeof item.text === 'string' && item.text.length > 0) {
    if (item.text === lastRemoteClipboardText) return; // our own write of the host's clipboard
    lastRemoteClipboardText = null;
    // One message, or parts when its JSON would exceed the data-channel message limit (CJK/Thai…).
    const msgs = clipboardMessages(item.text);
    let ok = msgs.length > 0;
    for (const m of msgs) {
      if (!sendControl(m)) { ok = false; break; }
    }
    if (!ok && channelOpen(session.control)) {
      toast(item.text.length > C.MAX_CLIPBOARD_TEXT ? 'Copied text is too large to sync.' : "Couldn't sync the copied text.", { kind: 'warn' });
    }
  } else if (item.kind === 'image' && ArrayBuffer.isView(item.png)) {
    const png = item.png instanceof Uint8Array ? item.png : new Uint8Array(item.png.buffer, item.png.byteOffset, item.png.byteLength);
    if (png.byteLength === 0) return;
    if (png.byteLength > P.FILE.MAX_CLIPBOARD_IMAGE) {
      toast('Copied image is too large to sync.', { kind: 'warn' });
      return;
    }
    if (!session.transfer || !channelOpen(session.file)) return;
    try { session.transfer.sendClipboardImage(png); } catch (err) { console.warn('[viewer] clipboard image send failed', err); }
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Toolbar actions                                                                             */
/* ------------------------------------------------------------------------------------------ */

function sendFiles(files) {
  const st = canSendFiles();
  if (!st.ok) {
    toast(st.reason, { kind: 'warn' });
    return;
  }
  let queued = 0;
  for (const f of files) {
    if (!(f instanceof Blob)) continue;
    const name = cleanLabel(f.name, 80) || 'file';
    if (f.size > P.FILE.MAX_SIZE) {
      toast(`${name} is larger than 50 GB and can't be sent.`, { kind: 'warn' });
      continue;
    }
    try {
      session.transfer.sendFile(f);
      queued++;
    } catch (err) {
      toast(`Couldn't send ${name}: ${cleanLabel(err && err.message, 80)}`, { kind: 'danger' });
    }
  }
  if (queued) {
    if (!transfers.isOpen) showTransfers();
    render();
  }
}

async function readClipboardTextBestEffort() {
  if (lastLocalClipboardText) return lastLocalClipboardText;
  // Usually denied (main does not grant clipboard-read); then the user simply pastes in the dialog.
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') return '';
    return await Promise.race([navigator.clipboard.readText(), new Promise((resolve) => setTimeout(() => resolve(''), 800))]);
  } catch {
    return '';
  }
}

async function openTypeText() {
  if (!canControl()) {
    toast('Remote control is not available right now.', { kind: 'warn' });
    return;
  }
  const initial = await readClipboardTextBestEffort();
  input.releaseAll(false);
  openTextDialog({
    title: `Type text on ${hostLabel()}`,
    hint: 'The text is typed key by key as Unicode, so it also works where pasting is blocked (password prompts, consoles, VMs). Line breaks are typed as Enter.',
    initial: typeof initial === 'string' ? initial : '',
    max: MAX_TYPE_TEXT,
    onSubmit: (text) => {
      const normalized = text.replace(/\r\n?/g, '\n');
      if (!canControl() || !input.sendText(normalized)) {
        toast('Remote control is not available right now.', { kind: 'warn' });
        return false;
      }
      toast(`Typing ${normalized.length.toLocaleString()} characters on ${hostLabel()}…`, { kind: 'ok', timeout: 2500 });
      return true;
    },
    onClose: () => input.focus(),
  });
}

async function takeScreenshot() {
  if (!video.videoWidth || !video.videoHeight) {
    toast('There is no picture to capture yet.', { kind: 'warn' });
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  flash();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('could not encode PNG');
  const png = new Uint8Array(await blob.arrayBuffer());
  const res = await api.saveScreenshot(png);
  if (res && res.ok) {
    toast(`Screenshot saved to ${cleanLabel(res.path, 260) || 'Pictures/Tunnelview'}`, { kind: 'ok', timeout: 6000 });
  } else {
    toast(`Couldn't save the screenshot${res && res.error ? `: ${cleanLabel(res.error, 120)}` : ''}`, { kind: 'danger' });
  }
}

function flash() {
  const el = h('div', { class: 'shot-flash', 'aria-hidden': 'true' });
  document.body.append(el);
  el.addEventListener('animationend', () => el.remove(), { once: true });
  setTimeout(() => el.remove(), 800);
}

/* ------------------------------------------------------------------------------------------ */
/* Fullscreen + keyboard lock                                                                  */
/* ------------------------------------------------------------------------------------------ */

/*
 * Chromium only activates navigator.keyboard.lock() (system keys such as Alt+Tab, Win, ⌘Tab
 * delivered to the page) while the PAGE is in HTML fullscreen. So besides asking main for window
 * fullscreen we also requestFullscreen() on <html>: Electron keeps the native window fullscreen and
 * just marks the page fullscreen when the window is already fullscreen. Main grants the viewer the
 * 'fullscreen' and 'keyboardLock' permissions. Every step is best effort.
 */
async function enterFullscreen() {
  try { await api.setFullscreen(true); } catch { /* ignore */ }
  state.fullscreen = true; // optimistic; corrected by onFullscreen
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch { /* no user activation / denied: window fullscreen still works, just without key capture */ }
  lockKeyboard();
  render();
  toolbar.reveal(2500);
}

async function exitFullscreen() {
  if (exitingFullscreen) return;
  exitingFullscreen = true;
  unlockKeyboard();
  try { if (document.fullscreenElement) await document.exitFullscreen(); } catch { /* ignore */ }
  try { await api.setFullscreen(false); } catch { /* ignore */ }
  state.fullscreen = false;
  exitingFullscreen = false;
  render();
}

function lockKeyboard() {
  if (keyboardLocked || !navigator.keyboard || typeof navigator.keyboard.lock !== 'function') return;
  navigator.keyboard.lock().then(() => { keyboardLocked = true; }, () => { keyboardLocked = false; });
}

function unlockKeyboard() {
  try { if (navigator.keyboard && typeof navigator.keyboard.unlock === 'function') navigator.keyboard.unlock(); } catch { /* ignore */ }
  keyboardLocked = false;
}

function onFullscreenChanged(on) {
  const fs = on === true;
  state.fullscreen = fs;
  if (fs) lockKeyboard();
  else {
    unlockKeyboard();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  }
  render();
}

// Chromium's own "press and hold Esc" (keyboard lock) leaves HTML fullscreen → leave window fullscreen too.
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && state.fullscreen && !exitingFullscreen) exitFullscreen();
});

/* ------------------------------------------------------------------------------------------ */
/* Ending / reconnecting                                                                       */
/* ------------------------------------------------------------------------------------------ */

function teardownSession() {
  const s = session;
  if (!s) return;
  input.setEnabled(false); // sends release-all while the input channel is still open
  session = null;
  clearTimeout(s.mediaTimer);
  clearTimeout(s.iceTimer);
  for (const t of s.pathTimers) clearTimeout(t);
  clearInterval(s.pathPoll);
  s.clipAsm.reset();
  try { if (s.stopStats) s.stopStats(); } catch { /* ignore */ }
  try { if (s.stopDecoderWatch) s.stopDecoderWatch(); } catch { /* ignore */ }
  transfers.detach(); // also declines file offers still waiting for the user's OK
  try { if (s.transfer) s.transfer.close(); } catch { /* ignore */ }
  for (const ch of [s.input, s.control, s.file]) {
    try { if (ch) ch.close(); } catch { /* ignore */ }
  }
  try { if (s.pc) s.pc.close(); } catch { /* ignore */ }
  video.srcObject = null;
  audio.srcObject = null;
  state.hasAudio = false;
  state.displays = [];
  state.currentDisplay = null;
  state.quality = null;
  state.qualityTitle = '';
  state.unstable = false;
  state.videoStalled = false;
  state.hostState = { audio: true, controlAllowed: true, inputBlocked: null };
  stats.reset();
  applyScale();
  updateClipboardWatch();
}

function showClosed(reason, message, local) {
  teardownSession();
  earlySignals.length = 0;
  state.phase = 'closed';
  state.closeReason = reason || 'network';
  state.closeMessage = message || '';
  state.closedLocally = !!local;
  state.passwordMode = false;
  state.remaining = undefined;
  if (state.fullscreen) exitFullscreen();
  toolbar.closePopover();
  render();
  if (!local && !document.hasFocus()) {
    const d = describeClose(state.closeReason, closeContext());
    api.notify(`Tunnelview — ${hostLabel()}`, d.title);
  }
}

/** Raised by the viewer itself (media failure, unsafe path, timeout). */
function failLocal(reason) {
  if (state.phase === 'closed') return;
  input.releaseAll(true);
  api.disconnect(reason);
  showClosed(reason, '', true);
}

function userDisconnect() {
  if (state.phase === 'closed') return;
  input.releaseAll(true);
  api.disconnect('viewer-closed');
  showClosed('local', '', true);
}

async function reconnect() {
  if (reconnecting) return;
  reconnecting = true;
  teardownSession();
  earlySignals.length = 0;
  Object.assign(state, {
    phase: 'connecting', host: null, remaining: undefined, passwordMode: false, sessionId: null,
    permissions: normalizePermissions(null), closeReason: null, closeMessage: '', closedLocally: false, hadVideo: false,
  });
  render();
  let res = null;
  try { res = await api.reconnect(); } catch { res = null; }
  if (!res || !res.ok) {
    reconnecting = false;
    // Main pushes a specific 'closed' status (e.g. 'unreachable' when Tailscale is down, 'not-tailnet'
    // when the device left the tailnet) before refusing; keep that more useful reason.
    if (state.phase !== 'closed') showClosed('reconnect-failed', '', true);
  }
}

window.addEventListener('beforeunload', () => {
  // Window closing (title-bar X, Cmd+W…): main sends `bye`; make sure nothing stays pressed remotely.
  input.releaseAll(true);
  if (session && session.pc) { try { session.pc.close(); } catch { /* ignore */ } }
});

/* ------------------------------------------------------------------------------------------ */
/* Bootstrap                                                                                   */
/* ------------------------------------------------------------------------------------------ */

function applyInit(raw) {
  const init = normalizeInit(raw);
  state.init = init;
  state.viewOnly = init.viewOnly;
  state.preset = init.settings.quality;
  state.codec = init.settings.codec;
  state.clipboardSync = init.settings.clipboardSync;
  state.swapSetting = init.settings.swapCmdCtrl;
  input.o.localOs = init.localOs;
  toolbar.o.localOs = init.localOs;
  document.documentElement.dataset.os = init.localOs;
}

/** Queue main → renderer events until init is known (they may arrive before ready() resolves). */
function dispatch(fn) {
  if (ready) {
    try { fn(); } catch (err) { console.error('[viewer] event handler failed', err); }
  } else if (earlyEvents.length < MAX_EARLY_EVENTS) {
    earlyEvents.push(fn);
  }
}

async function main() {
  // Listeners FIRST (preload contract), then ready().
  api.onStatus((st) => dispatch(() => onStatus(st)));
  api.onSignal((m) => dispatch(() => onSignal(m)));
  api.onPermissions((p) => dispatch(() => onPermissions(p)));
  api.onClipboard((c) => dispatch(() => onLocalClipboard(c)));
  api.onFullscreen((on) => dispatch(() => onFullscreenChanged(on)));

  let init = null;
  try {
    init = await api.ready();
  } catch (err) {
    console.error('[viewer] ready() failed', err);
  }
  applyInit(init);
  ready = true;
  render();
  if (!init) {
    showClosed('init-failed', '', true);
    return;
  }
  for (const fn of earlyEvents.splice(0)) dispatch(fn);
  warmUpWebRtc();
}

/**
 * The first RTCPeerConnection in a renderer process blocks it for 1.3–2.7 s (WebRTC stack start-up).
 * Pay that once while the overlay still shows "connecting" / "waiting for approval" instead of
 * right after 'accepted'. Nothing is negotiated on this throw-away PC: no offer, no data channel,
 * no local description → no ICE gathering, no network traffic. The session PC is still created in
 * onAccepted.
 */
function warmUpWebRtc() {
  const run = () => {
    if (session || state.phase === 'closed') return; // the session PC already paid the cost / nothing to start
    try {
      RTCRtpSender.getCapabilities('video');
      new RTCPeerConnection({ iceServers: [] }).close();
    } catch { /* best effort */ }
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1000 });
  else setTimeout(run, 0);
}

window.addEventListener('unhandledrejection', (e) => console.warn('[viewer] unhandled rejection', e.reason));

if (!api || !P) {
  document.body.textContent = 'Tunnelview: the viewer bridge is unavailable.';
} else {
  main();
}
