'use strict';
/*
 * Every ipcMain handler — docs/ARCHITECTURE.md §6 (the preloads in src/preload/*.js are the
 * source of truth for channel names, payloads and return values).
 *
 *   ipc.register(ctx)          ctx = { settings, tailscale, auth, ViewerSession, windows, capture,
 *                                      clipboard, files, permissions, input, hostCtl, getHost,
 *                                      getState, stateChanged, notify, quit, appVersion, osName }
 *                              hostCtl = { isActivePanel(wcId), getPermissions(), sessionActive(),
 *                                          panelReady(entry), isWarmPanel(wcId), warmPanelReady(entry),
 *                                          setPermissions(p), endSession(reason), promptInit(entry),
 *                                          respond(entry, answer) }
 *   ipc.listViewers()          → AppState.viewers
 *   ipc.closeAllViewers(reason)
 *   ipc.sanitizeSignal(msg)    → shared with index.js for host-side signals
 *
 * Trust boundary rules:
 *   - every handler checks that the sender is the MAIN FRAME of a registered window of the
 *     expected kind, still showing its own page (windows.isOwnMainFrame);
 *   - panel channels: only the panel of the ACTIVE host session; prompt channels: only the prompt
 *     of the pending request (hostCtl decides); main channels: only the main window;
 *   - files:* / clipboard:* only from viewer or panel — for the panel only while the session's
 *     permissions.files / permissions.clipboard are on; panel:input only while permissions.control;
 *   - every payload is shape/type/size checked and rebuilt field-by-field before use;
 *   - security settings (accept mode, allow policy, auto-accept, default permissions, download
 *     folder, password) are locked while an incoming session is active: a remote controller
 *     drives the host's real mouse/keyboard and must not be able to plant unattended access;
 *   - every outgoing dial (first connect AND reconnect) re-resolves the target against the
 *     current `tailscale status` (§1.4); the viewer shows Tailscale-verified names, never the
 *     host's self-reported hostname/owner.
 */
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const PROTOCOL = require('../shared/protocol');

let electron = null;
const E = () => electron || (electron = require('electron'));

const TAILSCALE_ADMIN_URL = 'https://login.tailscale.com/admin/machines';
const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';
const CONNECT_CODES = ['NOT_TAILNET', 'NOT_FOUND', 'TS_DOWN', 'SELF_HOST_DISABLED', 'AMBIGUOUS'];
const VIEWER_PHASES = ['connecting', 'hello', 'auth-required', 'waiting', 'accepted', 'closed'];
const OS_NAMES = ['windows', 'macos', 'linux', 'ios', 'android', 'other'];
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_SCREENSHOT = 128 * 1024 * 1024;
const MAX_SDP = 256 * 1024;
const PROBE_TIMEOUT_MS = 1500;
const PROBE_CONCURRENCY = 8;
const PROBE_MAX_BODY = 16 * 1024;
const NOTIFY_MIN_INTERVAL_MS = 1000;
const PROBED_PORT_MAX = 512;
const PATH_INFO_CACHE_MS = 2000;
const PATH_INFO_TIMEOUT_MS = 3000;
const TS_REFRESH_TIMEOUT_MS = 5000;
const VIEWER_RELOADS_PER_MIN = 3;
// Probe outcomes, best first (ux-9): a host that answers beats one that is merely reachable.
// 'not-allowed' = Tunnelview answered 403: it runs there, but its Who-can-connect excludes us.
const PROBE_RANK = { ok: 6, 'not-allowed': 5, incompatible: 4, timeout: 3, refused: 2, error: 1 };
const PROBE_FOUND = new Set(['ok', 'not-allowed']); // Tunnelview listens on that port
// Settings a remote controller must not change while an incoming session is active (security-6).
const LOCKED_SETTING_KEYS = ['acceptMode', 'allowFrom', 'allowList', 'autoAcceptSameUser', 'defaultPermissions', 'downloadDir'];
const SETTINGS_LOCKED_MESSAGE = 'Disconnect the remote session to change security settings.';
// Closed reasons after which a remembered password is known to be wrong / useless (ipc-5).
// 'denied:locked' counts only when this connection actually sent a password proof (proofSent:
// true, or unknown): a viewer that saw hello.auth.passwordLocked sends none, and a lock caused by
// someone else (shared 'tagged' budget, another device of the same login) says nothing about the
// remembered password. 'rate-limited' (HTTP 429) is not a password denial either.
const PASSWORD_DENIALS = ['denied:bad-password', 'denied:password-required'];
const LOCKED_DENIAL = 'denied:locked';

let ctx = null;
const viewers = new Map();        // webContents.id → viewer record
const probedPort = new Map();     // normalized Tailscale IP → signaling port that answered /info
const lastNotify = new Map();     // webContents.id → ts
const warned = new Set();

/* ================================================================== validation helpers */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v, max, min = 0) => typeof v === 'string' && v.length >= min && v.length <= max;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
/** Display-safe string: control/bidi chars removed, length capped. */
const clean = (v, max) => (typeof v === 'string' ? v.replace(CONTROL_RE, '').slice(0, max) : '');
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
const unit = (v) => (finite(v) && v >= -0.01 && v <= 1.01 ? Math.min(1, Math.max(0, v)) : null);
const CODE_RE = /^[A-Za-z0-9]{1,32}$/;
const REASON_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

function osName(v) { return OS_NAMES.includes(v) ? v : 'other'; }

function user(u) {
  return isObj(u) ? { login: clean(u.login, 255), displayName: clean(u.displayName, 255) } : { login: '', displayName: '' };
}

function perms(p, base) {
  const out = {};
  for (const k of PROTOCOL.PERMISSION_KEYS) {
    if (isObj(p) && typeof p[k] === 'boolean') out[k] = p[k];
    else if (base && typeof base[k] === 'boolean') out[k] = base[k];
    else out[k] = false;
  }
  return out;
}

function isTsIp(ip) {
  try { return typeof ip === 'string' && !!ctx.tailscale.isTailscaleIp(ip); } catch { return false; }
}

/** 5th whitespace-separated field of an ICE candidate line ("candidate:f c proto prio ADDR port typ …"). */
function candidateAddress(line) {
  const body = line.startsWith('a=') ? line.slice(2) : line;
  const parts = body.trim().split(/\s+/);
  return parts.length >= 8 && parts[0].startsWith('candidate:') ? parts[4] : null;
}

/** Drop SDP a=candidate lines whose address is not a Tailscale IP (ARCHITECTURE §1.5). */
function filterSdp(sdp) {
  const lines = sdp.split(/\r\n|\n/);
  const kept = lines.filter((l) => {
    if (!l.startsWith('a=candidate:')) return true;
    const addr = candidateAddress(l);
    return !!addr && isTsIp(addr);
  });
  return kept.join('\r\n');
}

/**
 * Rebuild a signaling message ({t:'sdp'} | {t:'ice'}) from a renderer or from the network.
 * Non-tailnet ICE candidates are dropped (returns null) as defense in depth.
 */
function sanitizeSignal(msg) {
  if (!isObj(msg)) return null;
  if (msg.t === PROTOCOL.MSG.SDP) {
    const d = msg.description;
    if (!isObj(d) || (d.type !== 'offer' && d.type !== 'answer') || !isStr(d.sdp, MAX_SDP, 1)) return null;
    return { t: PROTOCOL.MSG.SDP, description: { type: d.type, sdp: filterSdp(d.sdp) } };
  }
  if (msg.t === PROTOCOL.MSG.ICE) {
    const c = msg.candidate;
    if (c === null || c === undefined) return { t: PROTOCOL.MSG.ICE, candidate: null };
    if (!isObj(c) || !isStr(c.candidate, 2048)) return null;
    if (c.candidate !== '') {
      const addr = candidateAddress(c.candidate);
      if (!addr || !isTsIp(addr)) return null;
    }
    const out = { candidate: c.candidate };
    out.sdpMid = c.sdpMid === null || c.sdpMid === undefined ? null : (isStr(c.sdpMid, 64) ? c.sdpMid : null);
    out.sdpMLineIndex = Number.isInteger(c.sdpMLineIndex) && c.sdpMLineIndex >= 0 && c.sdpMLineIndex < 64 ? c.sdpMLineIndex : null;
    out.usernameFragment = isStr(c.usernameFragment, 256) ? c.usernameFragment : null;
    if (out.sdpMid === null && out.sdpMLineIndex === null && c.candidate !== '') return null;
    return { t: PROTOCOL.MSG.ICE, candidate: out };
  }
  return null;
}

/** Rebuild one `input` data-channel message (ARCHITECTURE §5). */
function sanitizeInput(evt) {
  if (!isObj(evt)) return null;
  const I = PROTOCOL.INPUT;
  switch (evt.t) {
    case I.MOUSE_MOVE: {
      const x = unit(evt.x); const y = unit(evt.y);
      return x === null || y === null ? null : { t: evt.t, x, y };
    }
    case I.MOUSE_DOWN:
    case I.MOUSE_UP: {
      const x = unit(evt.x); const y = unit(evt.y);
      if (x === null || y === null || !Number.isInteger(evt.b) || evt.b < 0 || evt.b > 4) return null;
      const n = Number.isInteger(evt.n) ? Math.min(10, Math.max(1, evt.n)) : 1;
      return { t: evt.t, b: evt.b, x, y, n };
    }
    case I.WHEEL: {
      if (!finite(evt.dx) || !finite(evt.dy)) return null;
      const clamp = (v) => Math.max(-20000, Math.min(20000, v));
      return { t: evt.t, dx: clamp(evt.dx), dy: clamp(evt.dy) };
    }
    case I.KEY_DOWN:
    case I.KEY_UP: {
      if (!isStr(evt.code, 32) || !CODE_RE.test(evt.code)) return null;
      const out = { t: evt.t, code: evt.code, key: isStr(evt.key, 64) ? evt.key : '' };
      if (evt.t === I.KEY_DOWN) {
        out.rep = evt.rep === true;
        // Optional lock-key state of the viewer (host resyncs CapsLock/NumLock); never a reason to reject.
        if (isObj(evt.locks) && typeof evt.locks.caps === 'boolean') {
          out.locks = { caps: evt.locks.caps };
          if (typeof evt.locks.num === 'boolean') out.locks.num = evt.locks.num;
        }
      }
      return out;
    }
    case I.TEXT:
      return isStr(evt.text, I.MAX_TEXT, 1) ? { t: evt.t, text: evt.text } : null;
    case I.COMBO: {
      if (!Array.isArray(evt.codes) || evt.codes.length < 1 || evt.codes.length > 8) return null;
      if (!evt.codes.every((c) => isStr(c, 32) && CODE_RE.test(c))) return null;
      return { t: evt.t, codes: evt.codes.slice() };
    }
    case I.RELEASE_ALL:
      return { t: evt.t };
    default:
      return null;
  }
}

function toBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return null;
}

/* ================================================================== registration helpers */

function guard(event, kinds) {
  if (!ctx.windows.isOwnMainFrame(event)) return null;
  const entry = ctx.windows.getEntry(event);
  return entry && kinds.includes(entry.kind) ? entry : null;
}

function reject(channel, event) {
  let who = 'unknown';
  try { who = `${ctx.windows.getKind(event) || 'unregistered'}#${event.sender.id}`; } catch { /* destroyed */ }
  const key = `${channel}|${who}`;
  if (!warned.has(key)) {
    warned.add(key);
    console.warn(`[ipc] rejected '${channel}' from ${who}`);
  }
}

/** ipcMain.handle with sender-kind validation. */
function handle(channel, kinds, fn) {
  E().ipcMain.handle(channel, async (event, ...args) => {
    const entry = guard(event, kinds);
    if (!entry) { reject(channel, event); throw new Error('Forbidden'); }
    return fn(entry, ...args);
  });
}

/** ipcMain.on with sender-kind validation (fire-and-forget). */
function on(channel, kinds, fn) {
  E().ipcMain.on(channel, (event, ...args) => {
    const entry = guard(event, kinds);
    if (!entry) { reject(channel, event); return; }
    try {
      const r = fn(entry, ...args);
      if (r && typeof r.catch === 'function') r.catch((err) => console.error(`[ipc] ${channel} failed:`, err));
    } catch (err) {
      console.error(`[ipc] ${channel} failed:`, err);
    }
  });
}

const getHost = () => (ctx.getHost ? ctx.getHost() : null);
const isActivePanel = (entry) => entry.kind === 'panel' && ctx.hostCtl.isActivePanel(entry.wcId);
const sessionPerms = () => ctx.hostCtl.getPermissions() || perms(null);

/** files:* / clipboard:* gate: viewer always; panel only for the active session with the permission on. */
function allowedFor(entry, permKey) {
  if (entry.kind === 'viewer') return true;
  return isActivePanel(entry) && sessionPerms()[permKey] === true;
}

/* ================================================================== main window */

function selfInfo() {
  const self = ctx.tailscale.last && ctx.tailscale.last.self;
  return { hostname: (self && self.hostname) || os.hostname(), os: ctx.osName, version: ctx.appVersion };
}

function selfIps() {
  const self = ctx.tailscale.last && ctx.tailscale.last.self;
  return self && Array.isArray(self.ips) ? self.ips : [];
}

function normIp(ip) {
  try { return ctx.tailscale.normalizeIp(ip); } catch { return ip; }
}

/** Wait (bounded) for tailscale.init() so early UI calls do not see "not installed". */
async function tailscaleReady() {
  if (!ctx.tailscaleReady) return;
  await Promise.race([ctx.tailscaleReady, new Promise((r) => setTimeout(r, 6000))]);
}

const validPort = (p) => Number.isInteger(p) && p > 0 && p <= 65535;

/** "ip:port" / "[v6]:port" — an explicit port, so tailscale.resolveTarget reports portExplicit. */
function formatTarget(ip, port) {
  const host = String(ip).includes(':') ? `[${ip}]` : String(ip);
  return `${host}:${port}`;
}

function rememberPort(ip, port) {
  if (!validPort(port)) return;
  probedPort.delete(ip);
  probedPort.set(ip, port);
  while (probedPort.size > PROBED_PORT_MAX) probedPort.delete(probedPort.keys().next().value);
}

/**
 * Signaling port for a target typed WITHOUT a port (ux-3): the port a probe found Tunnelview on →
 * the port of a recent connection to that node → our own port when it is the default → else
 * probe our custom port and the default in parallel (prefer ours) → default.
 */
async function choosePort(ip, peer) {
  const s = ctx.settings.get();
  const mine = validPort(s.port) ? s.port : PROTOCOL.DEFAULT_PORT;
  if (peer && peer.isSelf) return mine; // our own host listens on settings.port
  const known = probedPort.get(ip);
  if (known) return known;
  const sid = peer && isStr(peer.stableId, 128, 1) ? peer.stableId : null;
  const recent = (Array.isArray(s.recent) ? s.recent : []).find((e) => isObj(e) && validPort(e.port)
    && (sid ? e.stableId === sid || (!e.stableId && normIp(e.ip) === ip) : normIp(e.ip) === ip));
  if (recent) return recent.port;
  if (mine === PROTOCOL.DEFAULT_PORT) return PROTOCOL.DEFAULT_PORT;
  const [a, b] = await Promise.all([fetchInfo(ip, mine), fetchInfo(ip, PROTOCOL.DEFAULT_PORT)]);
  // A Tunnelview that lets us in wins; one that refuses us ('not-allowed') only if the other port has none.
  const port = a.status === 'ok' || (a.status === 'not-allowed' && b.status !== 'ok') ? mine : PROTOCOL.DEFAULT_PORT;
  if (PROBE_FOUND.has(a.status) || PROBE_FOUND.has(b.status)) rememberPort(ip, port);
  return port;
}

async function resolveTarget(raw) {
  await tailscaleReady();
  let target = raw;
  // The UI may pass a peer stableId; map it to a Tailscale IP first (resolveTarget takes
  // ip | ip:port | [v6]:port | hostname | short name | FQDN).
  let st = ctx.tailscale.last;
  if (!st) { try { st = await ctx.tailscale.status(); } catch { st = null; } }
  if (st) {
    const nodes = [...(Array.isArray(st.peers) ? st.peers : []), ...(st.self ? [st.self] : [])];
    const byId = nodes.find((p) => p && p.stableId && p.stableId === raw);
    if (byId && Array.isArray(byId.ips) && byId.ips.length) target = byId.ips.find((ip) => !ip.includes(':')) || byId.ips[0];
  }
  const r = await ctx.tailscale.resolveTarget(target);
  if (!r || !isTsIp(r.ip)) {
    const err = new Error('That address is not part of your tailnet.');
    err.code = 'NOT_TAILNET';
    throw err;
  }
  const ip = normIp(r.ip);
  const peer = r.peer || null;
  let port = validPort(r.port) ? r.port : PROTOCOL.DEFAULT_PORT;
  if (r.portExplicit === false) port = await choosePort(ip, peer);
  return { ip, port, peer };
}

function isSelfTarget(target) {
  if (target.peer && target.peer.isSelf) return true;
  const ip = normIp(target.ip);
  return selfIps().some((s) => normIp(s) === ip);
}

function focusWindow(win) {
  if (!win || win.isDestroyed()) return false;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  return true;
}

const stableIdOf = (target) => (target && isObj(target.peer) && isStr(target.peer.stableId, 128, 1) ? target.peer.stableId : '');

/** Does `ip` (normalized) belong to the node behind `target` (its Tailscale-reported IPs)? */
function ipOfNode(ip, target) {
  const ips = target && isObj(target.peer) && Array.isArray(target.peer.ips) ? target.peer.ips : [];
  return ips.some((a) => typeof a === 'string' && normIp(a) === ip);
}

/**
 * Same device on the same port: the node stableId decides when both targets carry one;
 * otherwise one target's IP among the other node's IPs (IPv4 vs IPv6 address of one node), both
 * this machine, or the same IP.
 */
function sameDevice(a, b) {
  if (a.port !== b.port) return false;
  const sa = stableIdOf(a);
  const sb = stableIdOf(b);
  if (sa && sb) return sa === sb;
  const ipA = normIp(a.ip);
  const ipB = normIp(b.ip);
  if (ipOfNode(ipA, b) || ipOfNode(ipB, a)) return true;
  if (isSelfTarget(a) && isSelfTarget(b)) return true;
  return ipA === ipB;
}

/** A live viewer window already connected/connecting to the same device and port (ux-8). */
function findOpenViewer(target) {
  return [...viewers.values()].find((r) => !r.closed && r.phase !== 'closed' && sameDevice(r.target, target)) || null;
}

async function connect(opts) {
  if (!isObj(opts)) return { ok: false, code: 'NOT_FOUND', error: 'Invalid request.' };
  const raw = typeof opts.target === 'string' ? opts.target.trim() : '';
  if (!raw || raw.length > 255 || /[\s\u0000-\u001f\u007f]/.test(raw)) {
    return { ok: false, code: 'NOT_FOUND', error: 'Enter a device name or Tailscale IP address.' };
  }
  let password = null;
  if (opts.password !== undefined && opts.password !== null && opts.password !== '') {
    if (!isStr(opts.password, 256, 1)) return { ok: false, error: 'Invalid password.' };
    password = opts.password;
  }
  let target;
  try {
    target = await resolveTarget(raw);
  } catch (err) {
    const code = err && CONNECT_CODES.includes(err.code) ? err.code : 'NOT_FOUND';
    return { ok: false, code, error: clean(err && err.message, 300) || 'Device not found in your tailnet.' };
  }
  if (isSelfTarget(target)) {
    const host = getHost();
    let st = null;
    try { st = host ? host.status() : null; } catch { st = null; }
    if (!st || !st.listening) {
      return { ok: false, code: 'SELF_HOST_DISABLED', error: 'This device is not accepting incoming connections.' };
    }
  }
  // The host allows one session: a second window to the same device would only end 'denied:busy'.
  const existing = findOpenViewer(target);
  if (existing) {
    focusWindow(existing.win);
    return { ok: true, existing: true };
  }
  openViewer(target, password, opts.viewOnly === true);
  return { ok: true };
}

/* ---------- peers:list ---------- */

function toPeerInfo(p, favorites) {
  const ips = Array.isArray(p.ips) ? p.ips.filter((ip) => isStr(ip, 64)) : [];
  return {
    id: clean(String(p.id == null ? '' : p.id), 128),
    stableId: clean(p.stableId, 128),
    hostname: clean(p.hostname, 255),
    dnsName: clean(p.dnsName, 255),
    shortName: clean(p.shortName, 255),
    os: osName(p.os),
    ips,
    online: p.online === true,
    lastSeen: isStr(p.lastSeen, 64) ? p.lastSeen : null,
    user: user(p.user),
    tags: Array.isArray(p.tags) ? p.tags.filter((t) => isStr(t, 128)).slice(0, 32) : [],
    favorite: !!(p.stableId && favorites.has(p.stableId)),
    tunnelview: null,
    probe: null, // null = not probed
  };
}

function parseInfo(j) {
  if (!isObj(j) || j.app !== PROTOCOL.APP_ID || j.protocol !== PROTOCOL.PROTOCOL_VERSION) return null;
  return {
    version: clean(j.version, 32),
    os: osName(j.os),
    passwordSet: j.passwordSet === true,
    acceptMode: j.acceptMode === 'password-only' ? 'password-only' : 'ask',
    busy: j.busy === true,
  };
}

/**
 * GET http://<ip>:<port>/tunnelview/v1/info (Node adds [] around IPv6 in the Host header).
 * @returns {Promise<{status:'ok', info} | {status:'not-allowed'|'refused'|'timeout'|'incompatible'|'error'}>}
 */
function fetchInfo(ip, port) {
  return new Promise((resolve) => {
    let done = false;
    let req = null;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (req) req.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }), PROBE_TIMEOUT_MS);
    try {
      req = http.request({
        host: ip,
        port,
        path: PROTOCOL.INFO_PATH,
        method: 'GET',
        family: ip.includes(':') ? 6 : 4,
        agent: false,
        headers: { [PROTOCOL.PROTOCOL_HEADER]: String(PROTOCOL.PROTOCOL_VERSION), accept: 'application/json' },
      }, (res) => {
        if (res.statusCode === 426) { res.resume(); finish({ status: 'incompatible' }); return; }
        if (res.statusCode === 403) { res.resume(); finish({ status: 'not-allowed' }); return; } // §4: 403 = policy only
        if (res.statusCode !== 200) { res.resume(); finish({ status: 'error' }); return; }
        const chunks = [];
        let len = 0;
        res.on('data', (c) => {
          len += c.length;
          if (len > PROBE_MAX_BODY) finish({ status: 'error' });
          else chunks.push(c);
        });
        res.on('end', () => {
          let j = null;
          try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { finish({ status: 'error' }); return; }
          const info = parseInfo(j);
          if (info) finish({ status: 'ok', info });
          else if (isObj(j) && j.app === PROTOCOL.APP_ID) finish({ status: 'incompatible' }); // Tunnelview, other protocol
          else finish({ status: 'error' });
        });
        res.on('error', () => finish({ status: 'error' }));
      });
      req.on('error', (err) => finish({ status: err && err.code === 'ECONNREFUSED' ? 'refused' : 'error' }));
      req.end();
    } catch {
      finish({ status: 'error' });
    }
  });
}

/**
 * Probe one peer on every candidate port in parallel (a port found earlier, the default, our own)
 * and keep the best outcome: ok > not-allowed > incompatible > timeout > refused > error.
 * @returns {Promise<{status:string, info?:object, port?:number}>}
 */
async function probePeer(peer) {
  const ips = peer.ips.filter(isTsIp);
  const first = ips.find((a) => !a.includes(':')) || ips[0];
  if (!first) return { status: 'error' };
  const ip = normIp(first);
  const mine = ctx.settings.get().port;
  const ports = [...new Set([probedPort.get(ip), PROTOCOL.DEFAULT_PORT, mine].filter(validPort))];
  const results = await Promise.all(ports.map((port) => fetchInfo(ip, port).then((r) => ({ ...r, port }))));
  let best = null;
  for (const r of results) if (!best || (PROBE_RANK[r.status] || 0) > (PROBE_RANK[best.status] || 0)) best = r;
  if (best && PROBE_FOUND.has(best.status)) rememberPort(ip, best.port);
  return best || { status: 'error' };
}

async function pool(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { await fn(items[i], i); } catch { /* per-item failure is non-fatal */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function listPeers(opts) {
  const probe = isObj(opts) && opts.probe === true;
  await tailscaleReady();
  let st = null;
  try { st = await ctx.tailscale.status(); } catch { st = ctx.tailscale.last; }
  if (!st || !Array.isArray(st.peers)) return [];
  const favorites = new Set(ctx.settings.get().favorites);
  const peers = st.peers.filter((p) => isObj(p) && !p.isSelf).map((p) => toPeerInfo(p, favorites));
  if (probe) {
    const online = peers.filter((p) => p.online && p.ips.some(isTsIp));
    await pool(online, PROBE_CONCURRENCY, async (p) => {
      const r = await probePeer(p);
      p.probe = r.status;
      p.tunnelview = r.status === 'ok' ? { ...r.info, port: r.port } : null;
    });
  }
  return peers;
}

/* ---------- Tailscale client helpers (ux-4) ---------- */

const withTimeout = (promise, ms, fallback = null) => Promise.race([
  Promise.resolve(promise).catch(() => fallback),
  new Promise((r) => { const t = setTimeout(() => r(fallback), ms); if (t.unref) t.unref(); }),
]);

function spawnDetached(file) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false });
    } catch (err) {
      reject(err);
      return;
    }
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

function execOk(file, args) {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: 5000, windowsHide: true }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

/** Start / bring up the local Tailscale client app. @returns {Promise<{ok:boolean, error?:string}>} */
async function openTailscaleClient() {
  const missing = { ok: false, error: 'Tailscale is not installed on this device.' };
  try {
    if (process.platform === 'win32') {
      const candidates = [];
      const cli = ctx.tailscale && typeof ctx.tailscale.cliPath === 'string' ? ctx.tailscale.cliPath : '';
      if (cli && path.isAbsolute(cli)) candidates.push(path.join(path.dirname(cli), 'tailscale-ipn.exe'));
      candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale-ipn.exe'));
      const exe = candidates.find(isFile);
      if (!exe) return missing;
      await spawnDetached(exe);
      return { ok: true };
    }
    if (process.platform === 'darwin') {
      const err = await E().shell.openPath('/Applications/Tailscale.app');
      if (!err) return { ok: true };
      for (const bundleId of ['io.tailscale.ipn.macsys', 'io.tailscale.ipn.macos']) {
        if (await execOk('/usr/bin/open', ['-b', bundleId])) return { ok: true };
      }
      return missing;
    }
    return { ok: false, error: 'Not supported on this platform.' };
  } catch (err) {
    return { ok: false, error: clean(err && err.message, 200) || 'Could not open Tailscale.' };
  }
}

/* ================================================================== viewer windows */

function sanitizeStatus(st) {
  const phase = VIEWER_PHASES.includes(st.phase) ? st.phase : null;
  if (!phase) return null;
  const out = { phase };
  if (isObj(st.host)) {
    out.host = {
      hostname: clean(st.host.hostname, 255),
      os: osName(st.host.os),
      user: user(st.host.user),
      passwordSet: st.host.passwordSet === true,
      acceptMode: st.host.acceptMode === 'password-only' ? 'password-only' : 'ask',
    };
  }
  if (Number.isInteger(st.remaining) && st.remaining >= 0 && st.remaining <= 100) out.remaining = st.remaining;
  if (isStr(st.sessionId, 128)) out.sessionId = st.sessionId;
  if (isObj(st.permissions)) out.permissions = perms(st.permissions);
  if (isStr(st.reason, 64)) out.reason = clean(st.reason, 64);
  if (isStr(st.message, 500)) out.message = clean(st.message, 500);
  // The host's own bye reason ('capture-failed', 'non-tailnet-path', …) behind reason 'host-ended'.
  if (phase === 'closed' && isStr(st.hostReason, 64) && REASON_RE.test(st.hostReason)) out.hostReason = st.hostReason;
  // Whether this connection sent a password proof (trackPassword; the renderer ignores it).
  if (phase === 'closed' && typeof st.proofSent === 'boolean') out.proofSent = st.proofSent;
  return out;
}

/**
 * Display name for a target from Tailscale's own data (MagicDNS name first label), never the
 * peer's self-reported OS hostname or the host's `hello` — a squatting node could claim any name.
 */
function verifiedName(peer, ip = '') {
  const dns = peer && isStr(peer.dnsName, 255) ? clean(peer.dnsName, 255) : '';
  if (dns) return dns.split('.')[0] || dns;
  return ip || '';
}

/** Tailscale-reported owner of a peer ({login:'tagged-devices',…} for tagged nodes). */
function verifiedUser(peer) {
  return user(peer && peer.user);
}

/**
 * Remember a password only once the host accepted it; forget it on every failure signal (ipc-5),
 * except a 'denied:locked' close on a connection that sent no proof (st.proofSent === false): the
 * password was never tried, so Reconnect after the lock-out may still use it.
 */
function trackPassword(rec, st) {
  if (st.phase === 'accepted') {
    if (rec.pendingPassword) rec.password = rec.pendingPassword;
    rec.pendingPassword = null;
    return;
  }
  const failedAttempt = st.phase === 'auth-required' && st.remaining !== undefined;
  const denied = st.phase === 'closed'
    && (PASSWORD_DENIALS.includes(st.reason) || (st.reason === LOCKED_DENIAL && st.proofSent !== false));
  if (failedAttempt || denied) {
    rec.password = null;
    rec.pendingPassword = null;
  }
}

function openViewer(target, password, viewOnly) {
  const rec = {
    target,
    password,               // connect-form password (also reused by Reconnect until it fails)
    pendingPassword: null,  // typed into the viewer, promoted to `password` once accepted
    viewOnly,
    hostname: verifiedName(target.peer, target.ip) || target.ip,
    session: null,
    gen: 0,                 // bumps on every (re)start so stale async starts give up
    phase: 'connecting',
    permissions: null,
    recentAdded: false,
    closed: false,
    crashed: false,
    crashTimes: [],
    pathInfo: null,
    win: null,
    wcId: null,
  };
  const win = ctx.windows.createViewer(rec);
  rec.win = win;
  rec.wcId = win.webContents.id;
  viewers.set(rec.wcId, rec);
  win.on('closed', () => {
    rec.closed = true;
    rec.gen++;
    dropSession(rec, 'viewer-closed');
    rec.password = null;
    rec.pendingPassword = null;
    viewers.delete(rec.wcId);
    lastNotify.delete(rec.wcId);
    ctx.files.forgetOwner(rec.wcId).catch(() => {});
    ctx.stateChanged();
  });
  win.webContents.on('render-process-gone', (_e, details) => onViewerCrash(rec, details));
  ctx.stateChanged();
  return rec;
}

/**
 * Viewer renderer crashed: end the signaling session (the host would otherwise keep it for its
 * ICE grace), abort incoming files and reload the page; the reloaded renderer gets a 'closed'
 * status with a Reconnect button instead of reconnecting by itself.
 */
function onViewerCrash(rec, details) {
  const reason = details && details.reason;
  if (rec.closed || reason === 'clean-exit') return;
  console.error('[ipc] viewer renderer gone:', reason);
  rec.gen++;
  dropSession(rec, 'viewer-crashed');
  ctx.files.forgetOwner(rec.wcId).catch(() => {});
  rec.crashed = true;
  rec.phase = 'closed';
  ctx.stateChanged();
  const now = Date.now();
  rec.crashTimes = rec.crashTimes.filter((t) => now - t < 60000);
  rec.crashTimes.push(now);
  setImmediate(() => {
    const w = rec.win;
    if (rec.closed || !w || w.isDestroyed()) return;
    if (rec.crashTimes.length > VIEWER_RELOADS_PER_MIN) {
      console.error('[ipc] viewer keeps crashing; closing its window');
      w.close();
      return;
    }
    w.webContents.reload();
  });
}

function viewerInit(rec) {
  const s = ctx.settings.get();
  const peer = rec.target.peer;
  return {
    target: {
      ip: rec.target.ip,
      port: rec.target.port,
      hostname: rec.hostname,
      os: osName(peer && peer.os),
      user: peer && isObj(peer.user) ? user(peer.user) : null,
    },
    localOs: ctx.osName,
    viewOnly: rec.viewOnly,
    settings: { quality: s.quality, codec: s.codec, clipboardSync: s.clipboardSync, swapCmdCtrl: s.swapCmdCtrl },
  };
}

function sendTo(rec, channel, payload) {
  const w = rec.win;
  if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

/** Detach + close the current ViewerSession (its later events are ignored). */
function dropSession(rec, reason) {
  const vs = rec.session;
  rec.session = null;
  if (vs) {
    try { vs.close(reason); } catch (err) { console.warn('[ipc] viewer session close failed:', err && err.message); }
  }
}

/**
 * Where to dial a viewer's device now. With a known node stableId (the normal case) the node is
 * looked up by that stableId with the stored port kept explicit ("<stableId>:<port>"), so a node
 * that got a new Tailscale IP is still found, and an IP that now belongs to ANOTHER node is never
 * dialled with this window's verified name and remembered password. The resolver's name tiers
 * could fall through to a node whose MagicDNS label / hostname merely equals the stableId text,
 * so the result must carry the same stableId. Without a stableId: the stored ip:port.
 * @returns {Promise<{ip, port, peer}>} throws Error with .code (TS_DOWN, NOT_TAILNET, …) and
 *   .identityLost = true when the device is gone or the address belongs to another node
 */
async function resolveViewerTarget(rec) {
  const { port } = rec.target;
  const sid = stableIdOf(rec.target);
  if (!sid) return resolveTarget(formatTarget(rec.target.ip, port));
  const gone = (message) => Object.assign(new Error(message), { code: 'NOT_TAILNET', identityLost: true });
  // Tailscale stableIds are plain tokens; anything else is looked up by the stored IP (and still
  // has to carry the same stableId).
  const query = /^[A-Za-z0-9._-]{1,128}$/.test(sid) ? `${sid}:${port}` : formatTarget(rec.target.ip, port);
  let r;
  try {
    r = await resolveTarget(query);
  } catch (err) {
    if (err && err.code === 'TS_DOWN') throw err;
    throw gone('This device is no longer part of your tailnet.');
  }
  if (!r || !isObj(r.peer) || r.peer.stableId !== sid) throw gone('This address now belongs to a different device. Connect to it again from the device list.');
  // Keep the address family the user dialled while the node still has that address.
  const cur = normIp(rec.target.ip);
  const ip = ipOfNode(cur, r) && isTsIp(cur) ? cur : r.ip;
  return { ip, port, peer: r.peer };
}

/**
 * (Re)start the signaling session of a viewer window. Every start — the first one and every
 * Reconnect — first re-resolves the device against the CURRENT `tailscale status`
 * (ARCHITECTURE §1.4): with Tailscale down the 100.64/10 route is gone and the WebSocket plus the
 * saved-password proof would leave through the default gateway (ISP CGNAT space). The device is
 * re-found by its node stableId (resolveViewerTarget).
 * @returns {Promise<boolean>} true when a ViewerSession was started
 */
async function startViewerSession(rec) {
  dropSession(rec, 'viewer-reconnect');
  const gen = ++rec.gen;
  rec.crashed = false;
  rec.phase = 'connecting';
  rec.permissions = null;
  rec.pathInfo = null;
  ctx.stateChanged();

  let resolved;
  try {
    resolved = await resolveViewerTarget(rec);
  } catch (err) {
    if (rec.closed || rec.gen !== gen) return false;
    rec.phase = 'closed';
    const code = err && err.code;
    if (err && err.identityLost) {
      // Never offer this window's remembered password to whatever answers there now.
      rec.password = null;
      rec.pendingPassword = null;
    }
    sendTo(rec, 'viewer:status', {
      phase: 'closed',
      reason: code === 'TS_DOWN' ? 'unreachable' : 'not-tailnet',
      message: clean(err && err.message, 300) || 'This device is not part of your tailnet right now.',
    });
    ctx.stateChanged();
    return false;
  }
  if (rec.closed || rec.gen !== gen) return false;
  if (resolved.peer) rec.target = { ip: resolved.ip, port: rec.target.port, peer: resolved.peer };

  const vs = new ctx.ViewerSession({
    tailscale: ctx.tailscale,
    auth: ctx.auth,
    target: rec.target,
    password: rec.password,
    self: selfInfo(),
  });
  rec.session = vs;
  const current = () => rec.session === vs && !rec.closed;

  vs.on('error', (err) => console.warn('[ipc] viewer session error:', err && err.message));
  vs.on('status', (raw) => {
    if (!current() || !isObj(raw)) return;
    const st = sanitizeStatus(raw);
    if (!st) return;
    rec.phase = st.phase;
    const peer = rec.target.peer;
    if (st.host && isObj(peer)) {
      // Tailscale-verified identity instead of the host's self-reported hello (security-2).
      st.host.hostname = rec.hostname;
      st.host.user = verifiedUser(peer);
    }
    if (st.permissions) rec.permissions = st.permissions;
    trackPassword(rec, st);
    if (st.phase === 'accepted' && !rec.recentAdded) {
      rec.recentAdded = true;
      const entry = {
        stableId: (peer && isStr(peer.stableId, 128) && peer.stableId) || '',
        hostname: rec.hostname,
        ip: rec.target.ip,
        os: osName((peer && peer.os) || (st.host && st.host.os)),
      };
      if (validPort(rec.target.port)) entry.port = rec.target.port;
      ctx.settings.addRecent(entry);
    }
    sendTo(rec, 'viewer:status', st);
    ctx.stateChanged();
  });
  vs.on('signal', (msg) => {
    if (!current()) return;
    const m = sanitizeSignal(msg);
    if (m) sendTo(rec, 'viewer:signal', m);
  });
  vs.on('permissions', (p) => {
    if (!current() || !isObj(p)) return;
    rec.permissions = perms(p);
    sendTo(rec, 'viewer:permissions', rec.permissions);
  });
  vs.on('closed', (info) => {
    if (!current() || rec.phase === 'closed') return;
    rec.phase = 'closed';
    const st = { phase: 'closed', reason: clean(isObj(info) ? info.reason : '', 64) || 'network' };
    if (isObj(info) && isStr(info.message, 500)) st.message = clean(info.message, 500);
    if (isObj(info) && isStr(info.hostReason, 64) && REASON_RE.test(info.hostReason)) st.hostReason = info.hostReason;
    if (isObj(info) && typeof info.proofSent === 'boolean') st.proofSent = info.proofSent;
    trackPassword(rec, st);
    sendTo(rec, 'viewer:status', st);
    ctx.stateChanged();
  });
  try {
    vs.connect();
  } catch (err) {
    console.error('[ipc] viewer connect failed:', err);
    rec.phase = 'closed';
    sendTo(rec, 'viewer:status', { phase: 'closed', reason: 'network', message: 'Could not start the connection.' });
  }
  ctx.stateChanged();
  return true;
}

/** viewer:path-info (ux-6): is this session's Tailscale path direct or DERP-relayed? */
async function pathInfo(rec) {
  if (isSelfTarget(rec.target)) return { ok: true, direct: true, relay: '' };
  const st = await withTimeout(ctx.tailscale.status(), PATH_INFO_TIMEOUT_MS, null);
  const peers = st && Array.isArray(st.peers) ? st.peers : [];
  const sid = rec.target.peer && isStr(rec.target.peer.stableId, 128, 1) ? rec.target.peer.stableId : null;
  const ip = normIp(rec.target.ip);
  const p = (sid && peers.find((x) => isObj(x) && x.stableId === sid))
    || peers.find((x) => isObj(x) && Array.isArray(x.ips) && x.ips.some((a) => normIp(a) === ip));
  if (!p) return { ok: false };
  return { ok: true, direct: typeof p.direct === 'boolean' ? p.direct : null, relay: clean(p.relay, 16) || '' };
}

/** True while an incoming (host) session exists and has not ended (security-6). */
function hostSessionActive() {
  const h = ctx.hostCtl;
  if (h && typeof h.sessionActive === 'function') return !!h.sessionActive();
  return !!(h && h.getPermissions && h.getPermissions());
}

/** Does a settings partial change one of the locked security settings? */
function touchesLockedSettings(partial, cur) {
  return LOCKED_SETTING_KEYS.some((k) => {
    if (!Object.prototype.hasOwnProperty.call(partial, k)) return false;
    const v = partial[k];
    if (k === 'defaultPermissions') {
      return isObj(v) && PROTOCOL.PERMISSION_KEYS.some((pk) => typeof v[pk] === 'boolean' && v[pk] !== cur.defaultPermissions[pk]);
    }
    if (k === 'downloadDir') return (v === '' ? null : v) !== cur.downloadDir;
    return JSON.stringify(v) !== JSON.stringify(cur[k]);
  });
}

function viewerRec(entry) {
  const rec = viewers.get(entry.wcId);
  return rec && !rec.closed ? rec : null;
}

async function saveScreenshot(rec, png) {
  const buf = toBuffer(png);
  if (!buf || buf.length < 64 || buf.length > MAX_SCREENSHOT || !buf.subarray(0, 8).equals(PNG_MAGIC)) {
    return { ok: false, error: 'Invalid image.' };
  }
  try {
    const dir = path.join(E().app.getPath('pictures'), 'Tunnelview');
    await fsp.mkdir(dir, { recursive: true });
    const host = (rec.hostname || 'remote').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64) || 'remote';
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const file = ctx.files.uniquePath(dir, `Tunnelview-${host}-${ts}.png`);
    await fsp.writeFile(file, buf, { flag: 'wx' });
    return { ok: true, path: file };
  } catch (err) {
    console.error('[ipc] screenshot save failed:', err && err.message);
    return { ok: false, error: 'Could not save the screenshot.' };
  }
}

/* ================================================================== registration */

function register(context) {
  ctx = context;
  const { settings, windows, capture, clipboard, files, permissions, hostCtl } = ctx;
  const input = () => ctx.input;

  /* ---------------- main window ---------------- */

  handle('app:get-state', ['main'], () => ctx.getState());

  handle('peers:list', ['main'], (_e, opts) => listPeers(opts));

  handle('session:connect', ['main'], (_e, opts) => connect(opts));

  handle('settings:get', ['main'], () => settings.getPublic());

  handle('settings:update', ['main'], (_e, partial) => {
    if (isObj(partial)) {
      const copy = {};
      // password: setPassword only; loginItemApplied: main-process bookkeeping (index.js).
      for (const k of Object.keys(partial)) if (k !== 'password' && k !== 'version' && k !== 'loginItemApplied') copy[k] = partial[k];
      // A remote controller drives this machine's real mouse/keyboard: while a session is active
      // the security settings stay as they are (theme, quality, port … still apply).
      if (hostSessionActive() && touchesLockedSettings(copy, settings.get())) throw new Error(SETTINGS_LOCKED_MESSAGE);
      if ('trustedNodes' in copy) {
        // The renderer may only REMOVE trusted nodes; trust is granted solely from the prompt.
        if (Array.isArray(copy.trustedNodes)) {
          const keep = new Set(copy.trustedNodes.map((e) => (isObj(e) ? e.stableId : e)).filter((id) => isStr(id, 128, 1)));
          copy.trustedNodes = settings.get().trustedNodes.filter((t) => keep.has(t.stableId));
        } else {
          delete copy.trustedNodes;
        }
      }
      settings.update(copy);
    }
    return settings.getPublic();
  });

  handle('settings:set-password', ['main'], async (_e, pw) => {
    if (hostSessionActive()) return { ok: false, error: SETTINGS_LOCKED_MESSAGE };
    if (pw !== null && typeof pw !== 'string') return { ok: false, error: 'Invalid password.' };
    const r = await settings.setPassword(pw);
    ctx.stateChanged();
    return r;
  });

  handle('settings:choose-download-dir', ['main'], async (entry) => {
    if (hostSessionActive()) return null;
    const { dialog } = E();
    const r = await dialog.showOpenDialog(entry.win, {
      title: 'Choose a folder for received files',
      defaultPath: settings.effectiveDownloadDir(),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
    });
    if (r.canceled || !Array.isArray(r.filePaths) || !r.filePaths[0]) return null;
    // The session may have started while the dialog was open.
    if (hostSessionActive()) return null;
    settings.update({ downloadDir: r.filePaths[0] });
    return settings.effectiveDownloadDir();
  });

  handle('permissions:request', ['main'], async (_e, kind) => {
    if (!permissions.KINDS.includes(kind)) throw new Error('Unknown permission kind');
    const s = await permissions.request(kind);
    ctx.stateChanged();
    return s;
  });

  handle('permissions:open', ['main'], (_e, kind) => {
    if (!permissions.KINDS.includes(kind)) return { ok: false, error: 'Unknown permission kind' };
    return permissions.open(kind);
  });

  // macOS applies a Screen Recording grant only after a restart. app.quit() runs the graceful
  // before-quit shutdown (bye to every peer) first; the new instance starts once this one exits.
  handle('app:relaunch', ['main'], () => {
    const { app } = E();
    app.relaunch({ args: process.argv.slice(1).filter((a) => a !== '--hidden') });
    setImmediate(() => ctx.quit());
    return { ok: true };
  });

  handle('app:copy-text', ['main'], async (_e, text) => {
    if (!isStr(text, 100000)) return { ok: false };
    await E().clipboard.writeText(text);
    return { ok: true };
  });

  handle('app:open-tailscale-admin', ['main'], async () => {
    await E().shell.openExternal(TAILSCALE_ADMIN_URL);
    return { ok: true };
  });

  handle('app:open-tailscale-download', ['main'], async () => {
    await E().shell.openExternal(TAILSCALE_DOWNLOAD_URL);
    return { ok: true };
  });

  handle('app:open-tailscale', ['main'], () => openTailscaleClient());

  // "Check again": poll `tailscale status` now instead of returning the cached state.
  handle('tailscale:refresh', ['main'], async () => {
    await withTimeout(ctx.tailscale.status(), TS_REFRESH_TIMEOUT_MS, null);
    ctx.stateChanged();
    return ctx.getState();
  });

  handle('host:end-session', ['main'], () => {
    hostCtl.endSession('host-ended');
    return { ok: true };
  });

  handle('viewer:focus', ['main'], (_e, id) => {
    const rec = Number.isInteger(id) ? viewers.get(id) : null;
    if (!rec || rec.closed) return { ok: false };
    return { ok: focusWindow(rec.win) };
  });

  on('app:quit', ['main'], () => ctx.quit());

  /* ---------------- shared: files / clipboard / notify ---------------- */

  handle('files:open-folder', ['main', 'viewer', 'panel'], () => files.openFolder());

  handle('files:begin', ['viewer', 'panel'], (entry, meta) => {
    if (!allowedFor(entry, 'files')) return { ok: false, reason: 'not-allowed' };
    if (!isObj(meta)) return { ok: false, reason: 'bad-request' };
    return files.begin(entry.wcId, {
      id: meta.id,
      name: meta.name,
      size: meta.size,
      purpose: meta.purpose === undefined ? PROTOCOL.FILE.PURPOSE_FILE : meta.purpose,
    });
  });

  // An invoke, resolved only once the chunk is on disk: the renderer's flow control waits on it.
  handle('files:chunk', ['viewer', 'panel'], async (entry, id, data) => {
    if (!isStr(id, 128, 1)) return { ok: false, reason: 'bad-request' };
    if (!allowedFor(entry, 'files')) { files.abort(entry.wcId, id).catch(() => {}); return { ok: false, reason: 'not-allowed' }; }
    return files.chunk(entry.wcId, id, data);
  });

  handle('files:end', ['viewer', 'panel'], async (entry, id) => {
    if (!isStr(id, 128, 1)) return { ok: false, reason: 'bad-request' };
    if (!allowedFor(entry, 'files')) { await files.abort(entry.wcId, id); return { ok: false, reason: 'not-allowed' }; }
    return files.end(entry.wcId, id);
  });

  on('files:abort', ['viewer', 'panel'], (entry, id) => {
    if (isStr(id, 128, 1)) return files.abort(entry.wcId, id);
    return undefined;
  });

  handle('files:reveal', ['viewer', 'panel'], (entry, id) => {
    if (!isStr(id, 128, 1)) return { ok: false, reason: 'bad-request' };
    if (!allowedFor(entry, 'files')) return { ok: false, reason: 'not-allowed' };
    return files.reveal(entry.wcId, id);
  });

  on('clipboard:sync', ['viewer', 'panel'], (entry, enabled) => {
    const wc = entry.win.webContents;
    if (enabled !== true) { clipboard.unsubscribe(wc); return; }
    if (entry.kind === 'viewer') { clipboard.subscribe(wc); return; }
    if (!isActivePanel(entry)) return;
    const wcId = entry.wcId;
    clipboard.subscribe(wc, { canReceive: () => hostCtl.isActivePanel(wcId) && sessionPerms().clipboard === true });
  });

  handle('clipboard:write', ['viewer', 'panel'], (entry, item) => {
    if (!allowedFor(entry, 'clipboard')) return { ok: false, reason: 'not-allowed' };
    if (!isObj(item)) return { ok: false, reason: 'bad-request' };
    if (item.kind === 'text') {
      if (!isStr(item.text, PROTOCOL.CONTROL.MAX_CLIPBOARD_TEXT)) return { ok: false, reason: 'bad-request' };
      return clipboard.write({ kind: 'text', text: item.text });
    }
    if (item.kind === 'image') {
      const png = toBuffer(item.png);
      if (!png || png.length > PROTOCOL.FILE.MAX_CLIPBOARD_IMAGE) return { ok: false, reason: 'bad-request' };
      return clipboard.write({ kind: 'image', png });
    }
    return { ok: false, reason: 'bad-request' };
  });

  on('app:notify', ['viewer', 'panel'], (entry, payload) => {
    if (!isObj(payload)) return;
    const now = Date.now();
    if (now - (lastNotify.get(entry.wcId) || 0) < NOTIFY_MIN_INTERVAL_MS) return; // peer-driven spam guard
    lastNotify.set(entry.wcId, now);
    const title = clean(payload.title, 100) || 'Tunnelview';
    const body = clean(payload.body, 300);
    const win = entry.win;
    ctx.notify(title, body, () => { if (!win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  });

  /* ---------------- viewer ---------------- */

  handle('viewer:ready', ['viewer'], (entry) => {
    const rec = viewerRec(entry);
    if (!rec) throw new Error('No viewer context');
    const init = viewerInit(rec);
    if (rec.crashed) {
      // Reloaded after a renderer crash: never reconnect on its own — offer Reconnect instead.
      setImmediate(() => {
        if (!rec.closed) sendTo(rec, 'viewer:status', { phase: 'closed', reason: 'network', message: 'The viewer window stopped unexpectedly. Reconnect to continue.' });
      });
      return init;
    }
    // Start after the init reply is queued; listeners are already registered (preload contract).
    setImmediate(() => {
      if (rec.closed) return;
      startViewerSession(rec).catch((err) => console.error('[ipc] viewer start failed:', err));
    });
    return init;
  });

  on('viewer:signal', ['viewer'], (entry, msg) => {
    const rec = viewerRec(entry);
    if (!rec || !rec.session) return;
    const m = sanitizeSignal(msg);
    if (m) rec.session.sendSignal(m);
  });

  handle('viewer:submit-password', ['viewer'], async (entry, pw) => {
    const rec = viewerRec(entry);
    if (!rec) return { ok: false, error: 'No viewer context.' };
    if (!isStr(pw, 256, 1)) return { ok: false, error: 'Invalid password.' };
    if (!rec.session || rec.phase === 'closed') return { ok: false, error: 'Not connected.' };
    // Reused by Reconnect only after the host accepted it (status 'accepted' promotes it).
    rec.pendingPassword = pw;
    try {
      const r = await rec.session.submitPassword(pw);
      if (isObj(r) && r.ok === true) return { ok: true };
      rec.pendingPassword = null;
      return { ok: false, error: clean(isObj(r) ? r.error : '', 300) || 'Could not send the password.' };
    } catch (err) {
      rec.pendingPassword = null;
      return { ok: false, error: clean(err && err.message, 300) || 'Could not send the password.' };
    }
  });

  handle('viewer:reconnect', ['viewer'], async (entry) => {
    const rec = viewerRec(entry);
    if (!rec) return { ok: false };
    const started = await startViewerSession(rec);
    return { ok: started === true };
  });

  handle('viewer:path-info', ['viewer'], async (entry) => {
    const rec = viewerRec(entry);
    if (!rec) return { ok: false };
    const now = Date.now();
    if (rec.pathInfo && now - rec.pathInfo.at < PATH_INFO_CACHE_MS) return { ...rec.pathInfo.value };
    let value;
    try { value = await pathInfo(rec); } catch { value = { ok: false }; }
    rec.pathInfo = { at: now, value };
    return { ...value };
  });

  on('viewer:disconnect', ['viewer'], (entry, reason) => {
    const rec = viewerRec(entry);
    if (!rec) return;
    rec.gen++; // cancels a (re)start that is still re-resolving its target
    if (!rec.session) {
      if (rec.phase !== 'closed') { rec.phase = 'closed'; ctx.stateChanged(); }
      return;
    }
    const r = typeof reason === 'string' && REASON_RE.test(reason) ? reason : 'viewer-closed';
    try { rec.session.close(r); } catch (err) { console.warn('[ipc] disconnect failed:', err && err.message); }
  });

  on('viewer:close-window', ['viewer'], (entry) => { if (!entry.win.isDestroyed()) entry.win.close(); });

  on('viewer:set-title', ['viewer'], (entry, title) => {
    const t = clean(title, 200).trim();
    if (!entry.win.isDestroyed()) entry.win.setTitle(t || 'Tunnelview');
  });

  handle('viewer:set-fullscreen', ['viewer'], (entry, onFlag) => {
    const want = onFlag === true;
    if (!entry.win.isDestroyed()) entry.win.setFullScreen(want);
    return want;
  });

  handle('viewer:save-screenshot', ['viewer'], (entry, png) => {
    const rec = viewerRec(entry);
    if (!rec) return { ok: false, error: 'No viewer context.' };
    return saveScreenshot(rec, png);
  });

  handle('viewer:update-prefs', ['viewer'], (_entry, partial) => {
    if (isObj(partial)) {
      const pick = {};
      for (const k of ['quality', 'codec', 'clipboardSync', 'swapCmdCtrl']) if (k in partial) pick[k] = partial[k];
      settings.update(pick);
    }
    const s = settings.get();
    return { quality: s.quality, codec: s.codec, clipboardSync: s.clipboardSync, swapCmdCtrl: s.swapCmdCtrl };
  });

  /* ---------------- panel (host session) ---------------- */

  const panelHandle = (channel, fn) => handle(channel, ['panel'], (entry, ...args) => {
    if (!isActivePanel(entry)) throw new Error('No active session');
    return fn(entry, ...args);
  });
  const panelOn = (channel, fn) => on(channel, ['panel'], (entry, ...args) => {
    if (!isActivePanel(entry)) return undefined;
    return fn(entry, ...args);
  });

  // The ACTIVE session's panel, or the panel pre-created (hidden) while the prompt shows: its
  // ready() resolves only once the accepted session adopts it, and resolves null when the request
  // is declined / cancelled / times out (the warm window is destroyed right after; a rejection
  // would only log a handler error). Until adoption it is not the active panel, so display
  // capture and 'media' checks stay denied (§1.7: capture only behind a visible panel).
  handle('panel:ready', ['panel'], (entry) => {
    if (isActivePanel(entry)) return hostCtl.panelReady(entry);
    if (typeof hostCtl.isWarmPanel === 'function' && hostCtl.isWarmPanel(entry.wcId)) return hostCtl.warmPanelReady(entry);
    throw new Error('No active session');
  });

  panelOn('panel:signal', (_entry, msg) => {
    const m = sanitizeSignal(msg);
    const host = getHost();
    if (m && host) host.sendSignal(m);
  });

  // A viewer display switch / a capture that ended: refresh a list older than a minute (screen
  // events invalidate it earlier), so switching displays rarely pays for desktopCapturer.
  panelHandle('panel:list-displays', async () => (await capture.listDisplays({ maxAgeMs: capture.LIST_MAX_AGE_MS || 60000 })).map(capture.publicDisplay));

  // Chooses the capture source only; input mapping moves with panel:commit-display.
  panelHandle('panel:select-display', async (_entry, id) => {
    if (!isStr(id, 64, 1)) return { ok: false, error: 'Invalid display id.' };
    return capture.selectDisplay(id);
  });

  // The panel's new stream for display `id` is live: point remote input at that display.
  // → {ok:true} | {ok:false, error:'not-found', served}: `served` = the display main last served
  // to getDisplayMedia() (a fallback when `id` vanished), for the panel to commit and adopt.
  panelHandle('panel:commit-display', (_entry, id) => {
    const r = isStr(id, 64, 1) ? capture.commitDisplay(id) : null;
    if (r && r.ok === true) return { ok: true };
    let served = null;
    try { served = typeof capture.servedDisplayId === 'function' ? capture.servedDisplayId() : null; } catch { served = null; }
    return { ok: false, error: 'not-found', served: isStr(served, 64, 1) ? served : null };
  });

  panelOn('panel:input', (_entry, evt) => {
    const inp = input();
    if (!inp || !inp.available || sessionPerms().control !== true) return;
    const m = sanitizeInput(evt);
    if (!m) return;
    if (m.t === PROTOCOL.INPUT.RELEASE_ALL) inp.releaseAll();
    else inp.handle(m);
  });

  // Releasing held keys is always safe, even from a panel whose session just ended.
  on('panel:release-all', ['panel'], () => { const inp = input(); if (inp) inp.releaseAll(); });

  handle('panel:input-status', ['panel'], () => {
    const inp = input();
    let blocked = null;
    try { blocked = inp && typeof inp.blocked === 'string' ? inp.blocked : null; } catch { blocked = null; }
    return {
      available: !!(inp && inp.available),
      reason: inp && inp.reason ? String(inp.reason) : (inp ? null : 'unavailable'),
      blocked, // null | 'secure-desktop' | 'elevated-window'
    };
  });

  panelHandle('panel:set-permissions', (_entry, p) => {
    if (!isObj(p)) return sessionPerms();
    return hostCtl.setPermissions(perms(p, sessionPerms()));
  });

  panelOn('panel:end', (_entry, reason) => {
    const r = typeof reason === 'string' && REASON_RE.test(reason) ? reason : 'host-ended';
    hostCtl.endSession(r);
  });

  on('panel:set-expanded', ['panel'], (entry, expanded) => windows.setPanelExpanded(entry.win, expanded === true));

  on('panel:minimize', ['panel'], (entry) => { if (!entry.win.isDestroyed()) entry.win.minimize(); });

  /* ---------------- prompt ---------------- */

  handle('prompt:ready', ['prompt'], (entry) => {
    const init = hostCtl.promptInit(entry);
    if (!init) throw new Error('No pending request');
    return init;
  });

  handle('prompt:respond', ['prompt'], (entry, answer) => {
    if (!isObj(answer) || typeof answer.accept !== 'boolean') return { ok: false, error: 'Invalid answer.' };
    return hostCtl.respond(entry, {
      accept: answer.accept,
      permissions: isObj(answer.permissions) ? answer.permissions : null,
      trust: answer.trust === true,
    });
  });
}

/* ================================================================== exports */

function listViewers() {
  return [...viewers.values()].filter((r) => !r.closed).map((r) => ({ id: r.wcId, hostname: r.hostname, phase: r.phase }));
}

function closeAllViewers(reason = 'viewer-closed') {
  for (const rec of viewers.values()) {
    rec.gen++; // a start still re-resolving its target must not dial afterwards
    dropSession(rec, reason);
  }
}

module.exports = {
  register,
  listViewers,
  closeAllViewers,
  sanitizeSignal,
  sanitizeInput,
  sanitizePermissions: perms,
  sanitizeStatus,
  verifiedName,
  fetchInfo,
  clean,
};
