/*
 * Tunnelview host SESSION PANEL — entry module.
 * Contract: docs/ARCHITECTURE.md §1.7 (always-visible panel), §3, §5, §6; src/preload/panel.js.
 *
 * Order matters (preload contract): register onSignal / onEnded / onPermissions / onClipboard
 * FIRST, then `await tunnelviewPanel.ready()` — main flushes queued viewer signals after ready().
 * Signals that arrive before the HostSession exists are queued here.
 */
import { toast } from '../shared/ui.js';
import { HostSession } from './host-session.js';
import { PanelView, peerDisplayName } from './view.js';
import { sanitizeSignal, sanitizePermissions } from './validate.js';

const P = window.TunnelviewProtocol;
const api = window.tunnelviewPanel;
const INPUT_POLL_MS = 4000; // input unavailable (e.g. macOS Accessibility missing): wait for the grant
const BLOCKED_POLL_MS = 1000; // live control session: watch for an admin window / the secure desktop
const BLOCKED_INPUT = ['secure-desktop', 'elevated-window'];
const NOTIFY_MIN_INTERVAL_MS = 3000;
const MAX_EARLY_SIGNALS = 256;

let session = null;
let view = null;
let peerName = 'Remote user';
let inputPoll = null;
let inputPollMs = 0;
let lastNotify = 0;
const early = { signals: [], ended: null, permissions: null };

/* ------------------------------ IPC listeners (registered before ready) ------------------------------ */

function cleanReason(r) {
  return typeof r === 'string' ? r.replace(/[^A-Za-z0-9 _.:-]/g, '').slice(0, 64) : '';
}

function onSignal(msg) {
  const m = sanitizeSignal(msg);
  if (!m) return;
  if (session) void session.handleSignal(m);
  else if (early.signals.length < MAX_EARLY_SIGNALS) early.signals.push(m);
}

function onEnded(payload) {
  const reason = cleanReason(payload && payload.reason) || 'ended';
  if (session) session.end(reason, { fromMain: true });
  else early.ended = reason;
}

function onPermissions(p) {
  const perms = sanitizePermissions(p);
  if (!perms) return;
  if (session) session.setPermissions(perms);
  else early.permissions = perms;
}

function onClipboard(item) {
  if (session) session.onLocalClipboard(item);
}

/* ------------------------------ init normalization ------------------------------ */

const str = (v, max = 256) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Defensive copy of PanelInit with every field present and typed (see preload/panel.js). */
function normalizeInit(raw) {
  const i = raw && typeof raw === 'object' ? raw : {};
  const peer = i.peer && typeof i.peer === 'object' ? i.peer : {};
  const user = peer.user && typeof peer.user === 'object' ? peer.user : {};
  const viewer = i.viewer && typeof i.viewer === 'object' ? i.viewer : {};
  const settings = i.settings && typeof i.settings === 'object' ? i.settings : {};
  const input = i.input && typeof i.input === 'object' ? i.input : {};
  const os = str(peer.os, 16);
  return {
    sessionId: str(i.sessionId, 128),
    peer: {
      ip: str(peer.ip, 64),
      hostname: str(peer.hostname, 128),
      os: ['windows', 'macos', 'linux', 'ios', 'android'].includes(os) ? os : 'other',
      user: { login: str(user.login, 128), displayName: str(user.displayName, 128) },
      stableId: str(peer.stableId, 128),
      sameUser: peer.sameUser === true,
      isSelf: peer.isSelf === true,
    },
    // Self-reported by the remote app: display-only.
    viewer: { hostname: str(viewer.hostname, 128), os: str(viewer.os, 16), version: str(viewer.version, 32) },
    via: str(i.via, 32),
    startedAt: Number.isFinite(i.startedAt) ? i.startedAt : Date.now(),
    permissions: sanitizePermissions(i.permissions) || { control: false, clipboard: false, files: false, audio: false },
    settings: {
      quality: P.QUALITY_PRESETS.includes(settings.quality) ? settings.quality : 'balanced',
      codec: P.CODECS.includes(settings.codec) ? settings.codec : 'auto',
      clipboardSync: settings.clipboardSync !== false,
    },
    displays: Array.isArray(i.displays)
      ? i.displays.filter((d) => d && typeof d === 'object' && d.id != null).map((d) => ({ ...d, id: String(d.id) }))
      : [],
    initialDisplayId: i.initialDisplayId != null ? String(i.initialDisplayId) : null,
    audioSupported: i.audioSupported === true,
    hostOs: i.hostOs === 'macos' ? 'macos' : 'windows',
    input: {
      available: input.available === true,
      reason: typeof input.reason === 'string' ? input.reason.slice(0, 64) : null,
      blocked: BLOCKED_INPUT.includes(input.blocked) ? input.blocked : null,
    },
  };
}

/* ------------------------------ actions ------------------------------ */

async function togglePermission(key) {
  if (!session || session.ended || !P.PERMISSION_KEYS.includes(key)) return;
  const next = { ...session.perms, [key]: !session.perms[key] };
  view.setPermissionBusy(key, true);
  try {
    const res = await api.setPermissions(next);
    session.setPermissions(sanitizePermissions(res) || next);
  } catch (e) {
    console.error('[panel] setPermissions failed', e);
    toast('Could not change that permission.', { kind: 'danger' });
  } finally {
    view.setPermissionBusy(key, false);
  }
}

function sendChat(text) {
  if (!session || session.ended) return false;
  const msg = session.sendChat(text);
  if (!msg) {
    toast(text.length > P.CONTROL.MAX_CHAT ? 'Message is too long.' : 'Not connected yet — message not sent.', { kind: 'warn' });
    return false;
  }
  view.addChat(msg);
  return true;
}

function sendFiles(files) {
  if (!session || session.ended) return;
  if (!session.perms.files) {
    toast('File transfer is turned off for this session.', { kind: 'warn' });
    return;
  }
  if (!session.pathOk) {
    toast('Not connected yet.', { kind: 'warn' });
    return;
  }
  for (const f of files) {
    if (!session.sendFile(f)) {
      toast('Could not queue the file.', { kind: 'danger' });
      break;
    }
  }
}

function reveal(id) {
  Promise.resolve(api.fileReveal(id)).catch(() => toast('That file is no longer available.', { kind: 'warn' }));
}

/* ------------------------------ input availability (macOS Accessibility, UIPI / secure desktop) ------------------------------ */

function stopInputPoll() {
  if (inputPoll) clearInterval(inputPoll);
  inputPoll = null;
  inputPollMs = 0;
}

/** 0 = no polling; INPUT_POLL_MS while input is unavailable; BLOCKED_POLL_MS while it is in use. */
function wantedInputPollMs() {
  if (!session || session.ended) return 0;
  const st = session.inputStatus;
  if (!st.available) return st.reason !== 'unsupported-platform' ? INPUT_POLL_MS : 0;
  return session.pathOk && session.perms.control ? BLOCKED_POLL_MS : 0;
}

function applyInputStatus(status) {
  session.setInputStatus(status);
  view.setInputStatus(status);
}

function scheduleInputPoll() {
  const ms = wantedInputPollMs();
  if (ms !== inputPollMs) {
    stopInputPoll();
    if (ms) {
      inputPoll = setInterval(() => void refreshInputStatus(false), ms);
      inputPollMs = ms;
    }
  }
  // No longer watching (control revoked, input unavailable, session over): drop a stale block.
  if (ms !== BLOCKED_POLL_MS && session && !session.ended && session.inputStatus.blocked) {
    applyInputStatus({ ...session.inputStatus, blocked: null });
  }
}

async function refreshInputStatus(manual) {
  if (!session || session.ended) return;
  let status;
  try {
    const st = await api.inputStatus();
    status = {
      available: !!(st && st.available === true),
      reason: st && typeof st.reason === 'string' ? st.reason.slice(0, 64) : null,
      blocked: st && BLOCKED_INPUT.includes(st.blocked) ? st.blocked : null,
    };
  } catch (e) {
    console.warn('[panel] inputStatus failed', e);
    return;
  }
  if (!session || session.ended) return;
  if (!status.available || !session.pathOk || !session.perms.control) status.blocked = null;
  const prev = session.inputStatus;
  const changed = status.available !== prev.available || status.reason !== prev.reason;
  if (changed || status.blocked !== (prev.blocked || null)) {
    applyInputStatus(status);
    if (changed && status.available) toast('Remote control is now available.', { kind: 'ok' });
  } else if (manual) {
    toast(status.available ? 'Remote control is available.' : 'Permission is still missing.', { kind: status.available ? 'ok' : 'warn' });
  }
  scheduleInputPoll();
}

/* ------------------------------ WebRTC warm-up ------------------------------ */

/**
 * The first RTCPeerConnection in a renderer pays for the PeerConnectionFactory and the codec query
 * (1–3 s). Main pre-creates this panel (hidden) while the approval prompt is up and resolves ready()
 * only once the session is adopted, so this cost overlaps the host user's decision.
 * No offer, data channel or setLocalDescription: nothing gathers ICE candidates or opens sockets.
 * The real session RTCPeerConnection is still created only after ready() resolves.
 */
function warmWebRtc() {
  try {
    RTCRtpSender.getCapabilities('video');
    new RTCPeerConnection({ iceServers: [] }).close();
  } catch { /* WebRTC unavailable: the session itself reports it */ }
}

/* ------------------------------ notifications ------------------------------ */

function notify(title, body) {
  if (document.hasFocus()) return;
  const t = Date.now();
  if (t - lastNotify < NOTIFY_MIN_INTERVAL_MS) return;
  lastNotify = t;
  try { api.notify(title, body); } catch { /* ignore */ }
}

function onTransferUpdate(t) {
  view.updateTransfer(t);
  if (t.purpose !== P.FILE.PURPOSE_FILE || t.direction !== 'in') return;
  if (t.state === 'done') {
    toast(`Received ${t.name}`, { kind: 'ok' });
    notify('File received', `${t.name} from ${peerName}`);
  } else if (t.state === 'rejected' && t.reason === 'not-allowed') {
    toast(`${peerName} tried to send a file, but file transfer is off.`, { kind: 'warn' });
  }
}

/* ------------------------------ boot ------------------------------ */

function showFatal(text) {
  const root = document.getElementById('app');
  if (!root) return;
  const msg = document.createElement('div');
  msg.className = 'fatal banner banner-danger';
  msg.textContent = text;
  root.replaceChildren(msg);
}

async function main() {
  if (!api || !P) {
    showFatal('Tunnelview: the session panel could not start (missing preload).');
    return;
  }
  // 1) listeners first …
  api.onSignal(onSignal);
  api.onEnded(onEnded);
  api.onPermissions(onPermissions);
  api.onClipboard(onClipboard);

  // 2) … then ready(); warm WebRTC while main is still waiting for the session to be adopted
  let init;
  try {
    const ready = api.ready();
    warmWebRtc();
    const raw = await ready;
    // null = main discarded this pre-created panel (request declined / cancelled / timed out);
    // it destroys the window in the same tick, so just stop here quietly.
    if (raw == null) return;
    init = normalizeInit(raw);
  } catch (e) {
    console.error('[panel] ready() failed', e);
    showFatal('Tunnelview: the session could not be started.');
    return;
  }
  peerName = peerDisplayName(init);
  document.title = `Tunnelview — ${peerName}`;

  session = new HostSession(api, init);
  view = new PanelView(document.getElementById('app'), init, {
    onTogglePermission: (key) => void togglePermission(key),
    onExpand: (expanded) => api.setExpanded(expanded),
    onMinimize: () => api.minimize(),
    onDisconnect: () => session.end('host-ended'),
    onSendChat: sendChat,
    onSendFiles: sendFiles,
    onCancelTransfer: (id) => session.cancelTransfer(id),
    onReveal: reveal,
    onOpenFolder: () => Promise.resolve(api.openDownloads()).catch(() => {}),
    onRecheckInput: () => void refreshInputStatus(true),
    onNotice: (text) => toast(text, { kind: 'warn' }),
    // Main allows closing once the session is over (while active, close = end after confirm).
    onClose: () => window.close(),
  });

  session.addEventListener('phase', (e) => view.setPhase(e.detail));
  session.addEventListener('path', (e) => {
    view.setPath(e.detail);
    scheduleInputPoll(); // the path verification gates input
  });
  session.addEventListener('stats', (e) => view.setStats(e.detail));
  session.addEventListener('stream', (e) => view.setStream(e.detail));
  session.addEventListener('permissions', (e) => {
    view.setPermissions(e.detail);
    scheduleInputPoll();
  });
  session.addEventListener('chat', (e) => {
    view.addChat(e.detail);
    if (e.detail.from === 'peer') notify(`${peerName} · Tunnelview`, e.detail.text.length > 200 ? `${e.detail.text.slice(0, 200)}…` : e.detail.text);
  });
  session.addEventListener('transfer', (e) => onTransferUpdate(e.detail));
  session.addEventListener('notice', (e) => toast(e.detail.text, { kind: e.detail.kind || 'info' }));
  session.addEventListener('ended', (e) => {
    stopInputPoll();
    // fromMain: reported by main — e.g. the viewer's own bye reason — rather than decided here.
    view.showEnded(e.detail.reason, { byPeer: !!e.detail.fromMain });
  });
  view.setStream(session.streamInfo());

  if (early.permissions) session.setPermissions(early.permissions);
  if (early.ended) {
    session.end(early.ended, { fromMain: true });
    return;
  }
  const started = session.start(); // creates the RTCPeerConnection synchronously
  for (const m of early.signals.splice(0)) void session.handleSignal(m);
  scheduleInputPoll();
  await started;
}

// Never leave capture tracks / a peer connection behind if the window goes away first.
window.addEventListener('pagehide', () => {
  if (session && !session.ended) session.end('panel-closed');
});
// Dropping a file outside the drop zone must not navigate the window.
for (const type of ['dragover', 'drop']) document.addEventListener(type, (e) => e.preventDefault());
window.addEventListener('unhandledrejection', (e) => console.error('[panel] unhandled rejection', e.reason));

main().catch((e) => {
  console.error('[panel] fatal', e);
  if (session && !session.ended) session.end('setup-failed');
  else showFatal('Tunnelview: the session panel hit an unexpected error.');
});
