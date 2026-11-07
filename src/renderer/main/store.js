/*
 * Main window — state store + thin wrappers around window.tunnelview (src/preload/main.js).
 *
 * Everything that comes back over IPC is normalized here (types, lengths, enums) before any
 * view touches it. Main is trusted, but much of the data (hostnames, user names, tags) is chosen
 * by other people in the tailnet, so views still render it strictly as text (see ui.js).
 */
import { toast, safeText } from '../shared/ui.js';

export const api = window.tunnelview || null;
export const PROTO = window.TunnelviewProtocol || Object.freeze({
  DEFAULT_PORT: 47800, RTC_UDP_MIN: 47801, RTC_UDP_MAX: 47899,
  QUALITY_PRESETS: ['quality', 'balanced', 'speed'], CODECS: ['auto', 'h264', 'vp9', 'vp8', 'av1'],
  PERMISSION_KEYS: ['control', 'clipboard', 'files', 'audio'],
});

/* ---------------------------------------------------------------- event bus */

const bus = new EventTarget();
/** subscribe('state'|'settings'|'peers', fn) → unsubscribe */
export function subscribe(type, fn) {
  const l = () => { try { fn(); } catch (err) { console.error(`[Tunnelview] ${type} listener failed`, err); } };
  bus.addEventListener(type, l);
  return () => bus.removeEventListener(type, l);
}
function emit(type) { bus.dispatchEvent(new Event(type)); }

/* ---------------------------------------------------------------- helpers */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max = 256) => (typeof v === 'string' ? safeText(v, max) : '');
const rawStr = (v, max = 256) => (typeof v === 'string' && v.length <= max ? v : ''); // identifiers: no trimming/ellipsis
const strArr = (v, maxItems = 16, maxLen = 256) =>
  Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x && x.length <= maxLen).slice(0, maxItems) : [];
const trimDot = (s) => (s.endsWith('.') ? s.slice(0, -1) : s);
const int = (v, dflt) => (Number.isInteger(v) ? v : dflt);

export function errMsg(err) {
  const m = err && err.message ? String(err.message) : String(err || 'Unknown error');
  // ipcRenderer.invoke wraps main-side errors: "Error invoking remote method 'x': Error: msg"
  return safeText(m.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^(Type|Range)?Error:\s*/, ''), 240);
}

export const OS_NAMES = { windows: 'Windows', macos: 'macOS', linux: 'Linux', ios: 'iOS', android: 'Android', other: 'Other' };
const OSES = new Set(Object.keys(OS_NAMES));
const normOs = (v) => (typeof v === 'string' && OSES.has(v) ? v : 'other');

function normUser(u) {
  const o = isObj(u) ? u : {};
  return { login: str(o.login, 128), displayName: str(o.displayName, 128) };
}

/* ---------------------------------------------------------------- AppState */

const TS_STATES = new Set(['running', 'stopped', 'needs-login', 'not-installed', 'error']);

function normSelf(s) {
  if (!isObj(s)) return null;
  return {
    id: rawStr(s.id, 128),
    stableId: rawStr(s.stableId, 128),
    hostname: str(s.hostname, 253),
    dnsName: trimDot(str(s.dnsName, 253)),
    shortName: str(s.shortName, 253),
    os: normOs(s.os),
    ips: strArr(s.ips, 8, 64),
    user: normUser(s.user),
  };
}

function normSession(s) {
  if (!isObj(s)) return null;
  const peer = isObj(s.peer) ? s.peer : {};
  return {
    id: rawStr(s.id, 128),
    peer: { ip: str(peer.ip, 64), hostname: str(peer.hostname, 253), os: normOs(peer.os), user: normUser(peer.user) },
    startedAt: Number.isFinite(s.startedAt) ? s.startedAt : Date.now(),
    via: str(s.via, 32),
  };
}

export function normState(raw) {
  const s = isObj(raw) ? raw : {};
  const ts = isObj(s.tailscale) ? s.tailscale : {};
  const host = isObj(s.host) ? s.host : {};
  const perms = isObj(s.permissions) ? s.permissions : {};
  const input = isObj(s.input) ? s.input : {};
  return {
    loaded: isObj(raw),
    version: str(s.version, 40),
    platform: s.platform === 'macos' || s.platform === 'windows' ? s.platform : '',
    tailscale: {
      state: TS_STATES.has(ts.state) ? ts.state : isObj(raw) ? 'error' : 'unknown',
      message: str(ts.message, 400),
      self: normSelf(ts.self),
      magicDnsSuffix: trimDot(str(ts.magicDnsSuffix, 253)),
    },
    host: {
      enabled: host.enabled !== false,
      listening: !!host.listening,
      addresses: strArr(host.addresses, 8, 64),
      port: int(host.port, PROTO.DEFAULT_PORT),
      error: host.error ? str(String(host.error), 300) : null,
      // Non-fatal problem while listening, e.g. a Windows Firewall rule that blocks Tunnelview.
      warning: (typeof host.warning === 'string' && str(host.warning, 300)) || null,
      session: normSession(host.session),
      pending: !!host.pending,
    },
    viewers: Array.isArray(s.viewers)
      ? s.viewers.filter(isObj).slice(0, 50).map((v) => ({
        id: Number.isFinite(v.id) ? v.id : 0,
        hostname: str(v.hostname, 253),
        phase: str(v.phase, 32),
      }))
      : [],
    permissions: { screen: str(perms.screen, 20) || 'n/a', accessibility: str(perms.accessibility, 20) || 'n/a' },
    input: { available: input.available !== false, reason: input.reason ? str(String(input.reason), 120) : null },
  };
}

/* ---------------------------------------------------------------- PublicSettings */

const DEFAULT_PERMS = { control: true, clipboard: true, files: true, audio: true };
const oneOf = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);

export function normSettings(raw) {
  const s = isObj(raw) ? raw : {};
  const dp = isObj(s.defaultPermissions) ? s.defaultPermissions : {};
  return {
    hostEnabled: s.hostEnabled !== false,
    port: int(s.port, PROTO.DEFAULT_PORT),
    acceptMode: oneOf(s.acceptMode, ['ask', 'password-only'], 'ask'),
    allowFrom: oneOf(s.allowFrom, ['tailnet', 'same-user', 'list'], 'tailnet'),
    allowList: strArr(s.allowList, 500, 256),
    autoAcceptSameUser: !!s.autoAcceptSameUser,
    trustedNodes: Array.isArray(s.trustedNodes)
      ? s.trustedNodes.filter((n) => isObj(n) && typeof n.stableId === 'string' && n.stableId).slice(0, 500).map((n) => ({
        stableId: rawStr(n.stableId, 256),
        name: str(n.name, 253),
        login: str(n.login, 128),
        addedAt: Number.isFinite(n.addedAt) || typeof n.addedAt === 'string' ? n.addedAt : null,
      }))
      : [],
    passwordSet: !!s.passwordSet,
    defaultPermissions: Object.fromEntries(PROTO.PERMISSION_KEYS.map((k) => [k, typeof dp[k] === 'boolean' ? dp[k] : DEFAULT_PERMS[k]])),
    promptTimeoutSec: int(s.promptTimeoutSec, 30),
    quality: oneOf(s.quality, [...PROTO.QUALITY_PRESETS], 'balanced'),
    codec: oneOf(s.codec, [...PROTO.CODECS], 'auto'),
    gpuVideoDecode: s.gpuVideoDecode === true,
    clipboardSync: s.clipboardSync !== false,
    swapCmdCtrl: oneOf(s.swapCmdCtrl, ['auto', 'on', 'off'], 'auto'),
    downloadDir: typeof s.downloadDir === 'string' ? s.downloadDir : null,
    effectiveDownloadDir: typeof s.effectiveDownloadDir === 'string' ? s.effectiveDownloadDir : '',
    startAtLogin: !!s.startAtLogin,
    closeToTray: s.closeToTray !== false,
    favorites: strArr(s.favorites, 1000, 256),
    recent: Array.isArray(s.recent)
      ? s.recent.filter(isObj).slice(0, 20).map((r) => ({
        stableId: rawStr(r.stableId, 256),
        hostname: str(r.hostname, 253),
        ip: str(r.ip, 64),
        os: normOs(r.os),
        ts: Number.isFinite(r.ts) ? r.ts : 0,
      })).filter((r) => r.stableId || r.ip || r.hostname)
      : [],
    theme: oneOf(s.theme, ['system', 'dark', 'light'], 'system'),
  };
}

// whois login of a tagged node (the 'Tagged Devices' pseudo-user, src/main/tailscale.js).
export const TAGGED_LOGIN = 'tagged-devices';

/**
 * A trustedNodes entry saved for a tagged node (login 'tagged-devices'). The host never
 * auto-accepts tagged nodes (ARCHITECTURE §4 "Trusted"), so such an entry has no effect.
 */
export function isTaggedTrust(n) {
  return isObj(n) && n.login === TAGGED_LOGIN;
}

/** trustedNodes entries that can actually admit a node without a prompt. */
export function activeTrustedCount(settings) {
  const list = isObj(settings) && Array.isArray(settings.trustedNodes) ? settings.trustedNodes : [];
  return list.filter((n) => !isTaggedTrust(n)).length;
}

/* ---------------------------------------------------------------- PeerInfo */

function normTunnelview(a) {
  if (!isObj(a)) return null;
  return {
    version: str(a.version, 32),
    os: normOs(a.os),
    passwordSet: !!a.passwordSet,
    acceptMode: str(a.acceptMode, 32),
    busy: !!a.busy,
    port: Number.isInteger(a.port) && a.port > 0 && a.port <= 65535 ? a.port : null, // where it answered
  };
}

// Outcome of the last Tunnelview probe of a peer (null = not probed).
const PROBE_RESULTS = new Set(['ok', 'not-allowed', 'refused', 'timeout', 'incompatible', 'error']);

export function normPeer(p) {
  if (!isObj(p)) return null;
  const peer = {
    id: rawStr(p.id, 128),
    stableId: rawStr(p.stableId, 256),
    hostname: str(p.hostname, 253),
    dnsName: trimDot(str(p.dnsName, 253)),
    shortName: str(p.shortName, 253),
    os: normOs(p.os),
    ips: strArr(p.ips, 8, 64),
    online: !!p.online,
    lastSeen: typeof p.lastSeen === 'string' || Number.isFinite(p.lastSeen) ? p.lastSeen : null,
    user: normUser(p.user),
    tags: strArr(p.tags, 16, 128).map((t) => safeText(t, 64)),
    favorite: !!p.favorite,
    tunnelview: normTunnelview(p.tunnelview),
    probe: PROBE_RESULTS.has(p.probe) ? p.probe : null,
  };
  if (!peer.stableId && !peer.id && !peer.ips.length) return null;
  return peer;
}

export const ipv4Of = (ips) => (ips || []).find((ip) => !ip.includes(':')) || '';
export const ipv6Of = (ips) => (ips || []).find((ip) => ip.includes(':')) || '';
export const peerKey = (p) => p.stableId || p.id || p.ips[0] || '';
export function peerName(p) {
  return p.shortName || p.hostname || (p.dnsName ? p.dnsName.split('.')[0] : '') || ipv4Of(p.ips) || 'Unknown device';
}
/** Best connect() target: a Tailscale IP is always resolvable by tailscale.resolveTarget(). */
export function peerTarget(p) {
  return ipv4Of(p.ips) || p.ips[0] || p.dnsName || p.stableId || '';
}

/* ---------------------------------------------------------------- store */

export const store = {
  state: normState(null),
  settings: normSettings(null),
  // Raw PublicSettings as returned by main. Used when writing arrays of objects back
  // (e.g. trustedNodes) so we never send display-normalized copies to the validator.
  rawSettings: null,
  settingsLoaded: false,
  peers: {
    list: null, // PeerInfo[] | null (never loaded)
    loading: false,
    probing: false,
    probed: false, // at least one probe completed → tunnelview:null means "not running"
    error: null,
    updatedAt: 0,
  },
};

// Until main's first `tailscale status` poll completes it reports state 'stopped'. Treat that as
// 'unknown' ("Checking…") for a short grace period so every launch doesn't flash a scary banner.
const BOOT_GRACE_MS = 3000;
const bootAt = Date.now();
let lastRawState = null;
let graceTimer = 0;

export function setState(raw) {
  lastRawState = raw;
  store.state = normState(raw);
  const left = BOOT_GRACE_MS - (Date.now() - bootAt);
  if (store.state.tailscale.state === 'stopped' && left > 0) {
    store.state.tailscale.state = 'unknown';
    if (!graceTimer) graceTimer = setTimeout(() => setState(lastRawState), left + 50);
  }
  emit('state');
}
export function setSettings(raw) {
  store.rawSettings = isObj(raw) ? raw : null;
  store.settings = normSettings(raw);
  store.settingsLoaded = true;
  emit('settings');
}
export const tsRunning = () => store.state.tailscale.state === 'running';
/**
 * While someone is connected to this computer, main refuses changes to security settings
 * (accept mode, who can connect, allow list, auto-accept, default permissions, password,
 * download folder) so the remote controller can't weaken them. Views disable those controls.
 */
export const securityLocked = (state = store.state) => !!(state && state.host && state.host.session);

export async function refreshState() {
  if (!api) return;
  try { setState(await api.getState()); } catch (err) { console.error('[Tunnelview] getState failed', err); }
}

/**
 * Ask main to run `tailscale status` NOW (getState() returns the cached poll result) and apply
 * the fresh AppState. Falls back to refreshState() when main doesn't offer it.
 */
export async function refreshTailscale() {
  if (!api) return;
  if (typeof api.refreshTailscale !== 'function') { await refreshState(); return; }
  try {
    const st = await api.refreshTailscale();
    if (isObj(st)) { setState(st); return; }
  } catch (err) {
    console.error('[Tunnelview] refreshTailscale failed', err);
  }
  await refreshState();
}

export async function refreshSettings() {
  if (!api) return;
  try { setSettings(await api.getSettings()); } catch (err) { console.error('[Tunnelview] getSettings failed', err); }
}

let settingsRefreshTimer = 0;
export function scheduleSettingsRefresh(delay = 400) {
  clearTimeout(settingsRefreshTimer);
  settingsRefreshTimer = setTimeout(refreshSettings, delay);
}

// Serialize writes so two quick toggles can't race and the last response always wins.
let saveChain = Promise.resolve();
/**
 * updateSettings(partial) → re-render from the returned PublicSettings; null on failure (UI resynced).
 * `partial` may be a function (settings, rawSettings) → partial|null, evaluated when this write's
 * turn comes — use it for read-modify-write of arrays/objects (favorites, allowList,
 * defaultPermissions…) so quick successive edits never overwrite each other with stale data.
 */
export function saveSettings(partial) {
  const run = async () => {
    if (!api) return null;
    try {
      const body = typeof partial === 'function' ? partial(store.settings, store.rawSettings) : partial;
      if (!body || typeof body !== 'object') return store.settings; // nothing to change
      const next = await api.updateSettings(body);
      if (!isObj(next)) throw new Error('Unexpected response from settings store');
      setSettings(next);
      return store.settings;
    } catch (err) {
      toast(`Couldn't save the setting: ${errMsg(err)}`, { kind: 'danger', timeout: 6000 });
      emit('settings'); // snap controls back to the last known-good values
      return null;
    }
  };
  const p = saveChain.then(run, run);
  saveChain = p.catch(() => {});
  return p;
}

/* ---------------------------------------------------------------- peers */

let inflight = null; // { probe, promise }
let probeQueued = false;

/** Fetch tailnet devices. Single-flight; a probe requested during a plain fetch runs right after it. */
export function loadPeers({ probe = false } = {}) {
  if (!api) return Promise.resolve();
  if (inflight) {
    if (probe && !inflight.probe) probeQueued = true;
    return inflight.promise;
  }
  const pr = store.peers;
  const promise = (async () => {
    pr.loading = true;
    pr.probing = probe;
    emit('peers');
    try {
      const raw = await api.listPeers(probe ? { probe: true } : {});
      let list = Array.isArray(raw) ? raw.slice(0, 2000).map(normPeer).filter(Boolean) : [];
      if (!probe && pr.probed && pr.list) {
        // A plain refresh carries no Tunnelview info — keep what the last probe found.
        const prev = new Map(pr.list.map((p) => [peerKey(p), p]));
        list = list.map((p) => {
          if (p.tunnelview || p.probe) return p;
          const old = p.online ? prev.get(peerKey(p)) : null;
          return { ...p, tunnelview: old ? old.tunnelview : null, probe: old ? old.probe : null };
        });
      }
      pr.list = list;
      pr.error = null;
      pr.updatedAt = Date.now();
      if (probe) pr.probed = true;
    } catch (err) {
      pr.error = errMsg(err);
    } finally {
      pr.loading = false;
      pr.probing = false;
      inflight = null;
      emit('peers');
      if (probeQueued) {
        probeQueued = false;
        loadPeers({ probe: true });
      }
    }
  })();
  inflight = { probe, promise };
  return promise;
}

/* ---------------------------------------------------------------- actions */

export async function copyText(text, label = 'Text') {
  if (!api || !text) return;
  try {
    await api.copyText(String(text));
    toast(`${label} copied`, { kind: 'ok', timeout: 1800 });
  } catch (err) {
    toast(`Couldn't copy: ${errMsg(err)}`, { kind: 'danger' });
  }
}

const CONNECT_ERRORS = {
  NOT_TAILNET: () => "That address isn't on your tailnet — Tunnelview only connects over Tailscale",
  NOT_FOUND: (name) => `No device called “${name}” on your tailnet. Check the name or use its Tailscale IP.`,
  TS_DOWN: () => "Tailscale isn't running. Start Tailscale, then try again.",
  SELF_HOST_DISABLED: () =>
    'That’s this computer, and incoming connections are turned off here. Turn them on to test a self-connection.',
};

/**
 * connect({ target, password?, viewOnly? }) with friendly error toasts.
 * @returns {Promise<{ok:boolean, code?:string, error?:string}>}
 */
export async function connectTo({ target, password = '', viewOnly = false, label = '' }) {
  const t = typeof target === 'string' ? target.trim() : '';
  if (!api || !t) return { ok: false };
  const opts = { target: t, viewOnly: !!viewOnly };
  if (typeof password === 'string' && password.length) opts.password = password;
  let res;
  try {
    res = await api.connect(opts);
  } catch (err) {
    res = { ok: false, error: errMsg(err) };
  }
  const name = safeText(label || t, 60);
  if (res && res.ok) {
    // existing: a viewer window for that device was already open — main brought it forward.
    if (res.existing) toast(`Switched to your open session with ${name}`, { kind: 'info', timeout: 2500 });
    else toast(`Opening a session with ${name}…`, { kind: 'info', timeout: 2500 });
    scheduleSettingsRefresh(600); // main records it in settings.recent
    return res;
  }
  const code = res && typeof res.code === 'string' ? res.code : '';
  const fmt = CONNECT_ERRORS[code];
  const msg = fmt ? fmt(name) : (res && res.error ? safeText(res.error, 220) : 'Couldn’t start the session.');
  toast(msg, { kind: code === 'TS_DOWN' || code === 'SELF_HOST_DISABLED' ? 'warn' : 'danger', timeout: 7000 });
  return res && typeof res === 'object' ? res : { ok: false };
}

export const canFocusViewer = () => !!api && typeof api.focusViewer === 'function';

/** Bring an outgoing session's viewer window (AppState.viewers[].id) to the front. */
export async function focusViewer(id) {
  if (!canFocusViewer() || !Number.isInteger(id) || id <= 0) return false;
  try {
    const res = await api.focusViewer(id);
    if (res && res.ok === false) {
      toast('That session window is no longer open.', { kind: 'warn' });
      refreshState();
      return false;
    }
    return true;
  } catch (err) {
    toast(`Couldn't show the session window: ${errMsg(err)}`, { kind: 'danger' });
    return false;
  }
}
