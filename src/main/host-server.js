'use strict';
/*
 * Host signaling server (docs/ARCHITECTURE.md §1, §4, §7).
 *
 * - One http.Server per own Tailscale IP (never 0.0.0.0 / ::), sharing one noServer WebSocketServer.
 *   Rebinds when Tailscale reports different IPs or the configured port changes; bind errors are
 *   reported in status().error and retried on the next Tailscale poll.
 * - Every TCP connection, before any HTTP parsing: Tailscale source while hosting, at most 4 sockets
 *   per source IP not yet handed to ws (/info probes included), each dropped after 5 s idle.
 * - Every upgrade: per-IP rate limit → Tailscale range → path → no Origin → X-Tunnelview-Protocol: <PROTOCOL_VERSION>
 *   → Host header is an IP literal (DNS-rebinding guard) → a handshake ws would accept → identity
 *   (self IP, or `tailscale whois` must succeed) → allowFrom policy → connection slots.
 *   Failures get an HTTP status line and the socket is destroyed.
 * - Admission (on `request`): disabled → busy (active session) → allowFrom → [password lock: the
 *   proof is ignored, neither verified nor counted] → cooldown without a usable proof ⇒ try-later →
 *   proof → cooldown + failed proof ⇒ wait for the next auth → self ⇒ prompt → trusted → same-user →
 *   password-only ⇒ password-required (locked / suspended while password sign-in is locked) → prompt.
 *   Every prompt (self included) is limited to 3 per node per 5 min, else try-later; another
 *   viewer's prompt showing ⇒ busy. Admission without a prompt (password, trusted, same-user)
 *   withdraws another viewer's pending prompt (it is denied busy, main gets 'request-cancelled').
 * - Locks gate only password verification; trusted / same-user / prompt admission keep working.
 * - Password proofs are bound to {hostId: our StableNodeID, viewerId: the remote node's StableNodeID}
 *   (auth.js), so a tailnet node cannot relay another viewer's proof. Failures are counted per node,
 *   per untagged user, all tagged nodes together, plus a host-wide cap that suspends password
 *   sign-in for devices never admitted before (the owner's own devices are exempt too).
 * - A device whose prompt was dismissed is refused without a new prompt for a while (30 s → 2 min →
 *   10 min; level resets after 1 h without a dismissal); an unanswered prompt costs a flat 30 s.
 *   Cleared when the node is admitted, when hosting stops or is toggled.
 * - At most 2 unanswered (hello / auth / pending) connections per node; when all 16 slots are taken,
 *   the oldest `hello` / `auth` of the node holding the most is denied 'busy' to make room.
 * - One active session + one pending prompt at a time. Signals relayed only while active, after
 *   strict validation (unknown fields stripped; ICE candidates must carry a Tailscale address).
 *
 * Dependencies are injected ({ tailscale, settings, auth, appVersion, osName }) — there is no
 * "test mode": tests pass a fake tailscale object that declares 127.0.0.1 a tailnet IP.
 */
const http = require('http');
const net = require('net');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer, WebSocket } = require('ws');
const PROTOCOL = require('../shared/protocol');

const { MSG, DENY, AUTH, PERMISSION_KEYS } = PROTOCOL;

const MAX_SDP = 256 * 1024;
const MAX_CANDIDATE = 2048;
const MAX_ICE_FIELD = 256;
const MAX_PROOF_CHARS = 128;
const REQUEST_WAIT_MS = 120e3; // hello → request (viewer may be typing a password first)
// auth-failed → next auth (the slot is NOT held meanwhile; MAX_PREACTIVE_PER_NODE bounds the cost)
const AUTH_WAIT_MS = REQUEST_WAIT_MS;
const FAIL_LIMIT = { max: 10, windowMs: 15 * 60e3, lockMs: 15 * 60e3 }; // per node / user / 'tagged'
const GLOBAL_FAIL_LIMIT = { max: 30, windowMs: 15 * 60e3, lockMs: 15 * 60e3 }; // all peers together
const GLOBAL_KEY = '*';
const TAGGED_KEY = 'tagged'; // one shared budget for every tagged node (anyone may mint them)
const GOOD_IDS_MAX = 256; // identities admitted before → exempt from the host-wide suspension
const GOOD_ID_TTL_MS = 30 * 24 * 60 * 60e3;
const COOLDOWN_STEPS_MS = [30e3, 2 * 60e3, 10 * 60e3]; // after dismissed prompts
const COOLDOWN_TIMEOUT_MS = 30e3; // after an unanswered prompt (never escalates)
const COOLDOWN_RESET_MS = 60 * 60e3; // back to the first step after 1 h without a new dismissal
const COOLDOWN_MAX = 256;
const PROMPT_RATE = { max: 3, windowMs: 5 * 60e3 }; // prompts shown per node, whatever the outcome
const PROMPT_LOG_MAX = 256;
const RETRY_AFTER_MAX_SEC = 3600;
// bye reasons a viewer may report that the host user should see (anything else → 'viewer-ended')
const VIEWER_BYE_REASONS = new Set(['non-tailnet-path', 'media-timeout', 'media-failed', 'network']);
const CLOSE_GRACE_MS = 5000;
const MAX_CONNECTIONS = 16;
const MAX_CONNECTIONS_PER_IP = 4;
const MAX_PREACTIVE_PER_NODE = 2; // connections still in hello / auth / pending, per node
const PREACTIVE_STATES = new Set(['hello', 'auth', 'pending']);
const EVICTABLE_STATES = new Set(['hello', 'auth']); // never the pending prompt or the session
// Raw TCP sockets, before the HTTP layer: an idle socket that never sends a request reaches none of
// the upgrade-level limits, so it is capped per source IP and dropped when idle.
const MAX_PREUPGRADE_PER_IP = 4; // sockets not yet handed to ws (incl. /info probes), per source IP
const PREUPGRADE_IDLE_MS = 5000;
const MAX_TCP_CONNECTIONS = 512; // per listening address
const kPreUpgrade = Symbol('tunnelview.preUpgrade'); // socket → {ip, onIdle} until released
const WS_KEY_RE = /^[+/0-9A-Za-z]{22}==$/; // what ws.handleUpgrade accepts
const MAX_TAGS = 8;
const UPGRADE_RATE = { max: 20, windowMs: 60e3 };
const INFO_RATE = { max: 60, windowMs: 60e3 };
const RATE_MAP_MAX = 5000;
const DEFAULT_PERMISSIONS = Object.freeze({ control: true, clipboard: true, files: true, audio: true });
const VIEWER_OS = new Set(['windows', 'macos', 'linux', 'ios', 'android', 'other']);
const DENY_REASONS = new Set(Object.values(DENY));
// Control chars, line/paragraph separators, bidi marks/overrides/isolates and BOM — peer-supplied
// strings end up in prompts/panels. Built from code point ranges so the source stays plain ASCII.
const UNSAFE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200e, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]];
const hex4 = (n) => n.toString(16).padStart(4, '0');
const UNSAFE_CHARS_RE = new RegExp(`[${UNSAFE_RANGES.map(([a, b]) => `\\u${hex4(a)}-\\u${hex4(b)}`).join('')}]`, 'g');

/* ------------------------------------------------------------------------------------------ */
/* Shared validators (also used by viewer-client.js)                                           */
/* ------------------------------------------------------------------------------------------ */

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function cleanText(v, max) {
  if (typeof v !== 'string') return '';
  return v.replace(UNSAFE_CHARS_RE, '').trim().slice(0, max);
}

/** Booleans for every PERMISSION_KEYS entry; non-boolean / missing values fall back. */
function sanitizePermissions(p, fallback) {
  const out = {};
  for (const k of PERMISSION_KEYS) {
    out[k] = fallback && typeof fallback[k] === 'boolean' ? fallback[k] : false;
    if (isPlainObject(p) && typeof p[k] === 'boolean') out[k] = p[k];
  }
  return out;
}

/** 5th field of an ICE candidate line ("candidate:<foundation> <component> <transport> <priority> <address> …"). */
function candidateAddress(line) {
  if (typeof line !== 'string') return null;
  let s = line.trim();
  if (s.startsWith('a=')) s = s.slice(2);
  if (!s.startsWith('candidate:')) return null;
  const parts = s.split(/\s+/);
  return parts.length >= 8 ? parts[4] : null;
}

function optString(v, max) {
  if (v === undefined || v === null) return { ok: true, value: null };
  if (typeof v === 'string' && v.length <= max) return { ok: true, value: v };
  return { ok: false };
}

/**
 * Validate a signaling message and rebuild it with only the known fields.
 *   {t:'sdp', description:{type:'offer'|'answer', sdp:string ≤ 256 KiB}}
 *   {t:'ice', candidate: null | {candidate:string ≤ 2 KiB, sdpMid, sdpMLineIndex, usernameFragment}}
 * When `isTailnetAddress` is given, ICE candidates whose address is not a Tailscale IP are dropped
 * (defense in depth on top of the renderers' own filtering — §1.5).
 * @returns {object|null} sanitized message, or null when invalid / dropped
 */
function sanitizeSignal(msg, isTailnetAddress) {
  if (!isPlainObject(msg)) return null;
  if (msg.t === MSG.SDP) {
    const d = msg.description;
    if (!isPlainObject(d)) return null;
    if (d.type !== 'offer' && d.type !== 'answer') return null;
    if (typeof d.sdp !== 'string' || d.sdp.length === 0 || d.sdp.length > MAX_SDP) return null;
    return { t: MSG.SDP, description: { type: d.type, sdp: d.sdp } };
  }
  if (msg.t === MSG.ICE) {
    const c = msg.candidate;
    if (c === null) return { t: MSG.ICE, candidate: null };
    if (!isPlainObject(c)) return null;
    if (typeof c.candidate !== 'string' || c.candidate.length > MAX_CANDIDATE) return null;
    const mid = optString(c.sdpMid, MAX_ICE_FIELD);
    const ufrag = optString(c.usernameFragment, MAX_ICE_FIELD);
    if (!mid.ok || !ufrag.ok) return null;
    let mline = null;
    if (c.sdpMLineIndex !== undefined && c.sdpMLineIndex !== null) {
      if (!Number.isInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 65535) return null;
      mline = c.sdpMLineIndex;
    }
    if (c.candidate !== '' && typeof isTailnetAddress === 'function') {
      const addr = candidateAddress(c.candidate);
      if (!addr || !isTailnetAddress(addr)) return null;
    }
    return { t: MSG.ICE, candidate: { candidate: c.candidate, sdpMid: mid.value, sdpMLineIndex: mline, usernameFragment: ufrag.value } };
  }
  return null;
}

/** Host header must be an IP literal (optionally with port): blocks DNS-rebinding from browsers. */
function hostHeaderIsIp(h) {
  if (typeof h !== 'string' || h.length === 0 || h.length > 64) return false;
  let m = /^\[([0-9a-fA-F:.]+)\](?::\d{1,5})?$/.exec(h);
  if (m) return net.isIP(m[1]) === 6;
  m = /^([0-9.]+)(?::\d{1,5})?$/.exec(h);
  return !!m && net.isIP(m[1]) === 4;
}

/**
 * HTTP status ws.handleUpgrade would refuse this upgrade with (405 / 400), or 0 when it would go
 * through. Checked before any connection slot is touched, so that a malformed upgrade can never
 * evict another viewer and then fail anyway. Tunnelview uses no subprotocols: any offer is refused
 * (ws would 400 an unparsable one only after the slot checks).
 */
function wsHandshakeError(req) {
  if (req.method !== 'GET') return 405;
  const h = req.headers;
  if (typeof h.upgrade !== 'string' || h.upgrade.toLowerCase() !== 'websocket') return 400;
  if (h['sec-websocket-version'] !== '13' && h['sec-websocket-version'] !== '8') return 400;
  if (typeof h['sec-websocket-key'] !== 'string' || !WS_KEY_RE.test(h['sec-websocket-key'])) return 400;
  if (h['sec-websocket-protocol'] !== undefined) return 400;
  return 0;
}

/** Write a minimal HTTP error response on a raw (upgrade) socket and destroy it. */
function abortHandshake(socket, code) {
  if (socket.destroyed) return;
  const text = http.STATUS_CODES[code] || 'Error';
  socket.once('finish', () => socket.destroy());
  try {
    socket.end(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    socket.destroy();
  }
  const t = setTimeout(() => socket.destroy(), 2000);
  if (t.unref) t.unref();
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function cleanReason(r, dflt) {
  const s = cleanText(r, 64);
  return /^[a-z0-9][a-z0-9:_-]*$/i.test(s) ? s : dflt;
}

/** One key per tailnet node (both of its addresses): node:<stableId>, fallback ip:<ip>. */
function nodeKey(ident, ip) {
  return ident && ident.node && ident.node.stableId ? `node:${ident.node.stableId}` : `ip:${ip}`;
}

function describeListenError(err, ip, port) {
  const code = err && err.code;
  if (code === 'EADDRINUSE') return `Port ${port} on ${ip} is already in use.`;
  if (code === 'EADDRNOTAVAIL') return `Address ${ip} is not available yet.`;
  if (code === 'EACCES') return `Not permitted to listen on ${ip}:${port}.`;
  return `Cannot listen on ${ip}:${port}: ${(err && err.message) || 'unknown error'}`;
}

/* ------------------------------------------------------------------------------------------ */
/* HostServer                                                                                  */
/* ------------------------------------------------------------------------------------------ */

class HostServer extends EventEmitter {
  /**
   * @param {{tailscale, settings, auth, appVersion:string, osName:'windows'|'macos'}} deps
   */
  constructor({ tailscale, settings, auth, appVersion, osName } = {}) {
    super();
    if (!tailscale || !settings || !auth) throw new TypeError('HostServer requires { tailscale, settings, auth }');
    this.ts = tailscale;
    this.settings = settings;
    this.auth = auth;
    this.appVersion = cleanText(String(appVersion || '0.0.0'), 64) || '0.0.0';
    this.osName = VIEWER_OS.has(osName) ? osName : 'other';
    this._now = Date.now; // clock for limiters + cooldowns (tests may replace it)
    this._requestWaitMs = REQUEST_WAIT_MS; // instance copies so tests can shorten them
    this._authWaitMs = AUTH_WAIT_MS;
    this._preUpgradeIdleMs = PREUPGRADE_IDLE_MS;
    this._preUpgrade = new Map(); // source ip → TCP sockets not yet handed to ws
    const now = () => this._now();
    this.limiter = new auth.FailureLimiter({ ...FAIL_LIMIT, now }); // keys: node:<stableId>|ip:<ip>, login:<login>, 'tagged'
    this.globalLimiter = new auth.FailureLimiter({ ...GLOBAL_FAIL_LIMIT, now });
    this._cooldown = new Map(); // node:<stableId>|ip:<ip> → {level, at, until} (Map order = oldest denial first)
    this._promptLog = new Map(); // node:<stableId>|ip:<ip> → times of the last ≤ 3 prompts shown
    this._goodIds = new Map(); // stableId → {at, login} of its last admission (not self)
    this._selfId = ''; // our StableNodeID from the last running status (proof binding hostId)
    this._lastHostEnabled = null;

    this._wss = new WebSocketServer({
      noServer: true,
      maxPayload: PROTOCOL.MAX_WS_PAYLOAD,
      perMessageDeflate: false,
      clientTracking: false,
      closeTimeout: CLOSE_GRACE_MS,
    });
    this._servers = new Map(); // ip → { server, port, configuredPort }
    this._conns = new Set();
    this._session = null; // conn with the active session
    this._pending = null; // conn holding the single pending-request slot
    this._rate = new Map();
    this._error = null;
    this._unbound = 0; // wanted addresses that failed to bind (retried on every poll)
    this._started = false;
    this._syncChain = Promise.resolve();
    this._syncQueued = false;
    this._pingTimer = null;
    this._lastStatusJson = '';

    this._onTsChange = () => { this._requestSync(); };
    this._onTsStatus = (st) => {
      // Retry a failed / incomplete bind on every poll; a 'change' event covers IP changes.
      if (st && st.state === 'running' && (this._error || this._unbound || !this._servers.size)) this._requestSync();
    };
    this._onSettingsChange = () => {
      // Hosting switched off/on: start from a clean prompt back-off.
      const enabled = this._settings().hostEnabled;
      if (this._lastHostEnabled !== null && enabled !== this._lastHostEnabled) this._clearBackoff();
      this._lastHostEnabled = enabled;
      this._requestSync();
    };
  }

  /* -------------------------------- lifecycle -------------------------------- */

  async start() {
    if (this._started) return this.status();
    this._started = true;
    this._lastHostEnabled = this._settings().hostEnabled;
    this.ts.on('change', this._onTsChange);
    this.ts.on('status', this._onTsStatus);
    if (typeof this.settings.on === 'function') this.settings.on('change', this._onSettingsChange);
    this._pingTimer = setInterval(() => this._pingAll(), PROTOCOL.PING_INTERVAL_MS);
    if (this._pingTimer.unref) this._pingTimer.unref();
    await this._requestSync({ refresh: true });
    return this.status();
  }

  async stop() {
    if (!this._started) return;
    this._started = false;
    this.ts.removeListener('change', this._onTsChange);
    this.ts.removeListener('status', this._onTsStatus);
    if (typeof this.settings.removeListener === 'function') this.settings.removeListener('change', this._onSettingsChange);
    clearInterval(this._pingTimer);
    this._pingTimer = null;

    if (this._session) this.endSession('host-stopped');
    for (const conn of [...this._conns]) {
      if (conn.state === 'pending' || conn.state === 'auth' || conn.state === 'hello') this._deny(conn, DENY.DISABLED);
      else this._closeConn(conn, 1001, 'host-stopped');
    }
    await this._requestSync();
    for (const conn of [...this._conns]) {
      try { conn.ws.terminate(); } catch { /* ignore */ }
    }
    this._clearBackoff();
    this._error = null;
    this._emitStatus();
  }

  /** Forget every prompt back-off and prompt count (hosting stopped or toggled). Lockouts stay. */
  _clearBackoff() {
    this._cooldown.clear();
    this._promptLog.clear();
  }

  /** @returns {{listening:boolean, addresses:string[], port:number, error:string|null}} */
  status() {
    const entries = [...this._servers.values()];
    return {
      listening: entries.length > 0,
      addresses: [...this._servers.keys()],
      port: entries.length ? entries[0].port : this._configuredPort(),
      error: this._error,
    };
  }

  /** Public snapshot of the active session ({id, peer, viewer, permissions, via, startedAt}) or null. */
  get activeSession() {
    return this._session && this._session.session ? structuredClone(this._session.session) : null;
  }

  /** Whether a prompt holds the pending slot (a viewer waiting for the host user's answer). */
  get hasPending() {
    return !!this._pending;
  }

  /* -------------------------------- binding -------------------------------- */

  _configuredPort() {
    let s;
    try { s = this.settings.get(); } catch { s = null; }
    const p = s && Number.isInteger(s.port) && s.port >= 0 && s.port <= 65535 ? s.port : PROTOCOL.DEFAULT_PORT;
    return p;
  }

  _requestSync(opts) {
    if (this._syncQueued && !(opts && opts.refresh)) return this._syncChain;
    this._syncQueued = true;
    const run = () => {
      this._syncQueued = false;
      return this._sync(opts).catch((e) => {
        this._error = `Host server error: ${e && e.message}`;
        this._emitStatus();
      });
    };
    this._syncChain = this._syncChain.then(run, run);
    return this._syncChain;
  }

  async _sync({ refresh = false } = {}) {
    if (!this._started) {
      await Promise.all([...this._servers.keys()].map((ip) => this._closeServer(ip)));
      return;
    }
    let st = this.ts.last;
    if (refresh || !st) {
      try { st = await this.ts.status(); } catch { st = null; }
    }
    if (!this._started) return this._sync();
    if (st && st.state === 'error' && this._servers.size) {
      // Transient CLI failure (e.g. timeout under load): keep the current bindings.
      return;
    }
    const port = this._configuredPort();
    const wanted = [];
    if (st && st.state === 'running' && st.self && typeof st.self.stableId === 'string' && st.self.stableId) {
      this._selfId = st.self.stableId;
    }
    if (st && st.state === 'running' && st.self && Array.isArray(st.self.ips)) {
      for (const raw of st.self.ips) {
        const ip = this.ts.normalizeIp(raw);
        // Never the unspecified address — only concrete Tailscale IPs.
        if (ip && ip !== '0.0.0.0' && ip !== '::' && this.ts.isTailscaleIp(ip) && !wanted.includes(ip)) wanted.push(ip);
      }
      wanted.sort((a, b) => Number(a.includes(':')) - Number(b.includes(':'))); // IPv4 first
    }
    for (const [ip, entry] of [...this._servers]) {
      if (!wanted.includes(ip) || entry.configuredPort !== port) await this._closeServer(ip);
    }
    const errors = [];
    let unbound = 0;
    for (const ip of wanted) {
      if (this._servers.has(ip)) continue;
      // Port 0 (tests): reuse the first ephemeral port for the other addresses when possible.
      const first = [...this._servers.values()][0];
      const listenPort = port === 0 && first ? first.port : port;
      try {
        await this._listen(ip, listenPort, port);
      } catch (e) {
        unbound++;
        // IPv6 is often disabled on the Tailscale adapter while Self still lists the fd7a address.
        // Viewers dial IPv4 by default, so an IPv6-only failure is not surfaced as an error as long
        // as something is bound (it is still retried on every poll).
        if (!ip.includes(':')) errors.push(describeListenError(e, ip, listenPort));
        else if (!this._servers.size) errors.push(describeListenError(e, ip, listenPort));
      }
      if (!this._started) return this._sync();
    }
    this._unbound = unbound;
    if (errors.length) this._error = errors.join(' ');
    else if (!wanted.length) this._error = st && st.message ? st.message : 'Tailscale is not running.';
    else if (!this._servers.size) this._error = 'Could not listen on any Tailscale address.';
    else this._error = null;
    this._emitStatus();
  }

  _listen(ip, port, configuredPort) {
    return new Promise((resolve, reject) => {
      const server = http.createServer({
        maxHeaderSize: 8192,
        requestTimeout: 5000,
        headersTimeout: 5000,
        keepAliveTimeout: 2000,
        connectionsCheckingInterval: 1000, // enforce the two timeouts above within ~1 s
      });
      server.maxConnections = MAX_TCP_CONNECTIONS;
      server.maxHeadersCount = 64;
      server.on('connection', (socket) => this._onTcpConnection(socket));
      server.on('request', (req, res) => { this._handleHttp(req, res).catch(() => { try { res.destroy(); } catch { /* ignore */ } }); });
      server.on('upgrade', (req, socket, head) => { this._handleUpgrade(req, socket, head, ip).catch(() => socket.destroy()); });
      server.on('clientError', (_err, socket) => { try { socket.destroy(); } catch { /* ignore */ } });
      const onError = (err) => {
        server.removeListener('listening', onListening);
        try { server.close(); } catch { /* ignore */ }
        reject(err);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        server.on('error', (err) => {
          // Runtime listener failure (rare): drop it and retry on the next poll.
          this._error = describeListenError(err, ip, port);
          if (this._servers.get(ip) && this._servers.get(ip).server === server) this._servers.delete(ip);
          try { server.close(); } catch { /* ignore */ }
          this._emitStatus();
        });
        const addr = server.address();
        this._servers.set(ip, { server, port: addr && typeof addr === 'object' ? addr.port : port, configuredPort });
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host: ip, port, exclusive: true, ipv6Only: ip.includes(':') });
    });
  }

  /**
   * Every accepted TCP socket, before the HTTP layer sees a byte: only Tailscale sources while
   * hosting; at most MAX_PREUPGRADE_PER_IP sockets per source IP until one is handed to ws (the
   * whois wait of an upgrade counts too, which bounds concurrent whois per IP); a socket idle for
   * _preUpgradeIdleMs before its hand-off is dropped. Without this, idle sockets from one node
   * would fill maxConnections and lock every viewer and /info probe out.
   */
  _onTcpConnection(socket) {
    const ip = this.ts.normalizeIp(socket.remoteAddress);
    if (!this._started || !ip || !this.ts.isTailscaleIp(ip)) {
      socket.destroy();
      return;
    }
    const n = this._preUpgrade.get(ip) || 0;
    if (n >= MAX_PREUPGRADE_PER_IP) {
      socket.destroy();
      return;
    }
    this._preUpgrade.set(ip, n + 1);
    const onIdle = () => { if (socket[kPreUpgrade]) socket.destroy(); };
    socket[kPreUpgrade] = { ip, onIdle };
    socket.once('close', () => this._releasePreUpgrade(socket));
    socket.on('timeout', onIdle);
    socket.setTimeout(this._preUpgradeIdleMs);
  }

  /** Stop counting a socket as pre-upgrade: exactly once, on close or when it is handed to ws. */
  _releasePreUpgrade(socket) {
    const pre = socket[kPreUpgrade];
    if (!pre) return;
    socket[kPreUpgrade] = null;
    socket.removeListener('timeout', pre.onIdle);
    const left = (this._preUpgrade.get(pre.ip) || 0) - 1;
    if (left > 0) this._preUpgrade.set(pre.ip, left);
    else this._preUpgrade.delete(pre.ip);
  }

  _closeServer(ip) {
    const entry = this._servers.get(ip);
    if (!entry) return Promise.resolve();
    this._servers.delete(ip);
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try {
        entry.server.close(finish);
        if (typeof entry.server.closeAllConnections === 'function') entry.server.closeAllConnections();
      } catch {
        finish();
      }
      // Upgraded WebSocket sockets keep net.Server's close callback pending; don't wait for them.
      const t = setTimeout(finish, 1000);
      if (t.unref) t.unref();
    });
  }

  _emitStatus() {
    const st = this.status();
    const json = JSON.stringify(st);
    if (json === this._lastStatusJson) return;
    this._lastStatusJson = json;
    this._safeEmit('status', st);
  }

  /* -------------------------------- admission helpers -------------------------------- */

  _rateOk(key, { max, windowMs }) {
    const now = Date.now();
    let arr = this._rate.get(key);
    if (!arr) {
      if (this._rate.size >= RATE_MAP_MAX) {
        for (const [k, v] of this._rate) if (!v.length || v[v.length - 1] <= now - windowMs) this._rate.delete(k);
        while (this._rate.size >= RATE_MAP_MAX) this._rate.delete(this._rate.keys().next().value);
      }
      arr = [];
      this._rate.set(key, arr);
    }
    while (arr.length && arr[0] <= now - windowMs) arr.shift();
    if (arr.length >= max) return false;
    arr.push(now);
    return true;
  }

  _settings() {
    let s;
    try { s = this.settings.get(); } catch { s = null; }
    if (!s || typeof s !== 'object') s = {};
    const isStored = typeof this.auth.isStoredPassword === 'function'
      ? this.auth.isStoredPassword(s.password)
      : !!(s.password && typeof s.password === 'object' && typeof s.password.key === 'string');
    return {
      hostEnabled: typeof s.hostEnabled === 'boolean' ? s.hostEnabled : true,
      acceptMode: s.acceptMode === 'password-only' ? 'password-only' : 'ask',
      allowFrom: s.allowFrom === 'same-user' || s.allowFrom === 'list' ? s.allowFrom : 'tailnet',
      allowList: Array.isArray(s.allowList) ? s.allowList.filter((x) => typeof x === 'string') : [],
      autoAcceptSameUser: s.autoAcceptSameUser === true,
      trustedNodes: Array.isArray(s.trustedNodes) ? s.trustedNodes.filter(isPlainObject) : [],
      password: isStored ? s.password : null,
      defaultPermissions: sanitizePermissions(s.defaultPermissions, DEFAULT_PERMISSIONS),
      promptTimeoutSec: clampInt(s.promptTimeoutSec, 1, 600, 30),
    };
  }

  _self() {
    const st = this.ts.last;
    return st && st.self ? st.self : null;
  }

  /**
   * This tailnet's MagicDNS suffix, lower-case without the trailing dot ('' when unknown). While a
   * status read fails (state 'error', transient) the last good suffix is used, so bare-label
   * allow-list entries do not refuse their own devices as "not allowed" (403 means policy only).
   */
  _magicDnsSuffix() {
    const st = this.ts.last;
    const v = (st && typeof st.magicDnsSuffix === 'string' ? st.magicDnsSuffix : '').toLowerCase().replace(/^\.+|\.+$/g, '');
    if (v) {
      this._lastMagicDnsSuffix = v;
      return v;
    }
    return st && st.state === 'error' && this._lastMagicDnsSuffix ? this._lastMagicDnsSuffix : '';
  }

  /** Identity of a remote IP: self (own Tailscale IP) or `tailscale whois`. null → reject. */
  async _identify(ip) {
    const self = this._self();
    const selfIps = self && Array.isArray(self.ips) ? self.ips.map((x) => this.ts.normalizeIp(x)) : [];
    if (self && selfIps.includes(ip)) {
      return {
        isSelf: true,
        node: { stableId: self.stableId || '', name: self.dnsName || '', hostname: self.hostname || os.hostname(), os: self.os || this.osName, ips: selfIps, tags: Array.isArray(self.tags) ? self.tags : [] },
        user: { login: (self.user && self.user.login) || '', displayName: (self.user && self.user.displayName) || '' },
      };
    }
    let w = null;
    try { w = await this.ts.whois(ip); } catch { w = null; }
    if (!w || !isPlainObject(w.node) || !isPlainObject(w.user)) return null;
    return {
      isSelf: w.isSelf === true,
      node: {
        stableId: cleanText(w.node.stableId, 64),
        name: cleanText(w.node.name, 255),
        hostname: cleanText(w.node.hostname, 255),
        os: VIEWER_OS.has(w.node.os) ? w.node.os : 'other',
        ips: Array.isArray(w.node.ips) ? w.node.ips.slice(0, 8) : [],
        tags: Array.isArray(w.node.tags) ? w.node.tags.filter((t) => typeof t === 'string') : [],
      },
      user: { login: cleanText(w.user.login, 320), displayName: cleanText(w.user.displayName, 256) },
    };
  }

  _isSameUser(ident) {
    if (ident.isSelf) return true;
    const self = this._self();
    const selfLogin = self && self.user ? self.user.login : '';
    if (!selfLogin || selfLogin === 'tagged-devices') return false;
    if (ident.node.tags.length) return false;
    return ident.user.login === selfLogin;
  }

  /**
   * allowFrom policy. The local machine itself is always allowed (it still always gets a prompt).
   * 'list' entries match only control-plane identities: login (case-insensitive), node stableId,
   * full MagicDNS name, or its first label for a node in THIS tailnet (a label is not unique across
   * tailnets: "laptop" must not admit laptop.<other-tailnet>.ts.net shared in from elsewhere) —
   * never the OS hostname, which the peer reports itself.
   */
  _policyAllows(ident, s) {
    if (ident.isSelf) return true;
    if (s.allowFrom === 'tailnet') return true;
    if (s.allowFrom === 'same-user') return this._isSameUser(ident);
    if (s.allowFrom === 'list') {
      const login = ident.user.login.toLowerCase();
      const name = ident.node.name.toLowerCase().replace(/\.$/, '');
      const suffix = this._magicDnsSuffix();
      const short = suffix && name.endsWith(`.${suffix}`) ? name.split('.')[0] : '';
      for (const raw of s.allowList) {
        const e = raw.trim();
        if (!e) continue;
        if (ident.node.stableId && e === ident.node.stableId) return true;
        const el = e.toLowerCase().replace(/\.$/, '');
        if ((login && el === login) || (name && el === name) || (short && el === short)) return true;
      }
      return false;
    }
    return false;
  }

  /**
   * 'Always allow' entry still valid for this identity: same stableId, same owner it was trusted
   * with (entries without a login match any owner) and not (now) tagged. A node keeps its stableId
   * when it is re-tagged or changes hands, so the stableId alone is not enough.
   */
  _isTrusted(ident, s) {
    const node = ident && ident.node;
    if (!node || !node.stableId || node.tags.length) return false;
    return s.trustedNodes.some((n) => n.stableId === node.stableId && (!n.login || n.login === ident.user.login));
  }

  _trustPeer(peer) {
    if (peer.isSelf || !peer.stableId) return;
    // _isTrusted never admits a tagged node, so an entry for one would only mislead the user.
    if ((Array.isArray(peer.tags) && peer.tags.length > 0) || peer.user.login === 'tagged-devices') return;
    try {
      const cur = this.settings.get();
      const list = cur && Array.isArray(cur.trustedNodes) ? cur.trustedNodes : [];
      const login = peer.user.login;
      if (list.some((n) => n && n.stableId === peer.stableId && n.login === login)) return;
      // Re-trusting a node that changed owner replaces its stale entry.
      const keep = list.filter((n) => !(n && n.stableId === peer.stableId));
      const entry = { stableId: peer.stableId, name: peer.hostname, login, addedAt: Date.now() };
      const r = this.settings.update({ trustedNodes: [...keep, entry] });
      if (r && typeof r.catch === 'function') r.catch((e) => console.error('[host] could not save trusted node:', e));
    } catch (e) {
      console.error('[host] could not save trusted node:', e);
    }
  }

  /**
   * Proof binding (auth.js): our own StableNodeID (captured when the connection arrived) + the
   * remote node's StableNodeID from whois. IDs survive Tailscale's per-peer address masquerading.
   */
  _binding(conn) {
    return { hostId: conn.hostId, viewerId: conn.ident.node.stableId };
  }

  /**
   * Password-failure keys: the node (fallback: its IP); for an untagged node also its user, for a
   * tagged node the budget all tagged nodes share (anyone who can tag nodes can mint new ones).
   * A self-connection (a local program) only ever counts against self, never the owner's login.
   */
  _limiterKeys(conn) {
    const { node, user } = conn.ident;
    const keys = [node.stableId ? `node:${node.stableId}` : `ip:${conn.ip}`];
    if (conn.ident.isSelf) return keys;
    if (node.tags.length) keys.push(TAGGED_KEY);
    else if (user.login) keys.push(`login:${user.login.toLowerCase()}`);
    return keys;
  }

  _isLocked(conn) {
    return this._limiterKeys(conn).some((k) => this.limiter.isLocked(k));
  }

  _resetLimiter(conn) {
    for (const k of this._limiterKeys(conn)) this.limiter.reset(k);
  }

  /**
   * Exempt from the host-wide password suspension: an identity admitted before (same stableId and
   * owner, within 30 days) or one of the owner's own untagged devices. Never self. Exempt peers
   * still count failures on their own keys and on the global counter.
   */
  _globalExempt(conn) {
    const ident = conn.ident;
    if (ident.isSelf) return false;
    if (this._isSameUser(ident)) return true;
    const e = ident.node.stableId ? this._goodIds.get(ident.node.stableId) : null;
    return !!e && this._now() - e.at < GOOD_ID_TTL_MS && e.login === ident.user.login;
  }

  /**
   * Whether password sign-in is blocked for this connection, and how the refusal is reported:
   * DENY.LOCKED (its node / user / the tagged budget), DENY.SUSPENDED (the host-wide cap) or null.
   * Locks gate only password verification — trusted, same-user and prompt admission still work.
   */
  _pwBlocked(conn) {
    if (this._isLocked(conn)) return DENY.LOCKED;
    if (this.globalLimiter.isLocked(GLOBAL_KEY) && !this._globalExempt(conn)) return DENY.SUSPENDED;
    return null;
  }

  /** Remember an admitted identity (exempts it from a later host-wide suspension). */
  _rememberGood(conn) {
    const { node, user } = conn.ident;
    if (conn.ident.isSelf || !node.stableId) return;
    const now = this._now();
    this._goodIds.delete(node.stableId); // re-insert → Map order = least recently admitted first
    this._goodIds.set(node.stableId, { at: now, login: user.login });
    for (const [id, e] of this._goodIds) {
      if (now - e.at < GOOD_ID_TTL_MS) break; // the rest is newer
      this._goodIds.delete(id);
    }
    while (this._goodIds.size > GOOD_IDS_MAX) this._goodIds.delete(this._goodIds.keys().next().value);
  }

  /** Node key for back-off, prompt counting and the pre-active cap: stableId (fallback: the IP). */
  _cooldownKey(conn) {
    return nodeKey(conn.ident, conn.ip);
  }

  /**
   * Back off before this device's next prompt.
   *   'dismissed' (the host user said no): 30 s → 2 min → 10 min (level resets after 1 h);
   *   'timeout'   (nobody answered — e.g. walking over to the PC): a flat 30 s, the level is kept.
   */
  _recordDenial(conn, kind = 'dismissed') {
    const key = this._cooldownKey(conn);
    const now = this._now();
    const prev = this._cooldown.get(key);
    const live = !!prev && now - prev.at < COOLDOWN_RESET_MS;
    let next;
    if (kind === 'timeout') {
      next = live
        ? { level: prev.level, at: prev.at, until: Math.max(prev.until, now + COOLDOWN_TIMEOUT_MS) }
        : { level: 0, at: now, until: now + COOLDOWN_TIMEOUT_MS };
    } else {
      const level = live ? Math.min(prev.level + 1, COOLDOWN_STEPS_MS.length) : 1;
      next = { level, at: now, until: now + COOLDOWN_STEPS_MS[level - 1] };
    }
    this._cooldown.delete(key); // re-insert → Map order = least recent denial first
    this._cooldown.set(key, next);
    while (this._cooldown.size > COOLDOWN_MAX) this._cooldown.delete(this._cooldown.keys().next().value);
  }

  /** @returns {number} ms left on this node's prompt back-off (0 = none). */
  _cooldownLeftMs(conn) {
    const e = this._cooldown.get(this._cooldownKey(conn));
    return e ? Math.max(0, e.until - this._now()) : 0;
  }

  _coolingDown(conn) {
    return this._cooldownLeftMs(conn) > 0;
  }

  /** @returns {number} ms until this node may be shown another prompt (0 = now). */
  _promptWaitMs(conn) {
    const arr = this._promptLog.get(this._cooldownKey(conn));
    if (!arr) return 0;
    const now = this._now();
    const recent = arr.filter((t) => t > now - PROMPT_RATE.windowMs);
    if (recent.length < PROMPT_RATE.max) return 0;
    return Math.max(1, recent[recent.length - PROMPT_RATE.max] + PROMPT_RATE.windowMs - now);
  }

  /** Count a prompt actually shown (withdrawn, dismissed, timed out or accepted alike). */
  _logPrompt(conn) {
    const key = this._cooldownKey(conn);
    const now = this._now();
    const cutoff = now - PROMPT_RATE.windowMs;
    const arr = (this._promptLog.get(key) || []).filter((t) => t > cutoff);
    arr.push(now);
    if (arr.length > PROMPT_RATE.max) arr.splice(0, arr.length - PROMPT_RATE.max);
    this._promptLog.delete(key); // re-insert → Map order = least recent prompt first
    this._promptLog.set(key, arr);
    if (this._promptLog.size > PROMPT_LOG_MAX) {
      for (const [k, v] of this._promptLog) if (!v.length || v[v.length - 1] <= cutoff) this._promptLog.delete(k);
      while (this._promptLog.size > PROMPT_LOG_MAX) this._promptLog.delete(this._promptLog.keys().next().value);
    }
  }

  /** Deny 'try-later' with the wait in whole seconds (1..3600). */
  _tryLater(conn, waitMs) {
    const retryAfterSec = Math.min(RETRY_AFTER_MAX_SEC, Math.max(1, Math.ceil(waitMs / 1000)));
    return this._deny(conn, DENY.TRY_LATER, { retryAfterSec });
  }

  /* -------------------------------- HTTP -------------------------------- */

  async _handleHttp(req, res) {
    const send = (code, body) => {
      if (res.headersSent || res.destroyed) return;
      const payload = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(code, {
        'Content-Type': body === undefined ? 'text/plain' : 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        Connection: 'close',
      });
      res.end(payload);
    };
    const ip = this.ts.normalizeIp(req.socket.remoteAddress);
    if (!this._started) return send(503);
    if (!this._rateOk(`info|${ip}`, INFO_RATE)) return send(429);
    if (!this.ts.isTailscaleIp(ip)) return send(403);
    if (!hostHeaderIsIp(req.headers.host)) return send(403);
    const ident = await this._identify(ip);
    if (!ident) return send(503); // whois failed (maybe transient) — not a policy refusal
    const pathOnly = String(req.url || '').split('?')[0];
    if (req.method !== 'GET' || pathOnly !== PROTOCOL.INFO_PATH) return send(404);
    const s = this._settings();
    // 'Who can connect' covers /info too: a node it refuses learns nothing about this host
    // (whether it is unattended, busy, password-protected).
    if (!this._policyAllows(ident, s)) return send(403);
    const self = this._self();
    return send(200, {
      app: PROTOCOL.APP_ID,
      protocol: PROTOCOL.PROTOCOL_VERSION,
      version: this.appVersion,
      hostname: (self && self.hostname) || os.hostname(),
      os: this.osName,
      passwordSet: !!s.password,
      acceptMode: s.acceptMode,
      busy: !!(this._session || this._pending),
      enabled: s.hostEnabled, // extra (not in the contract): lets the UI say "incoming disabled"
    });
  }

  /* -------------------------------- WebSocket upgrade -------------------------------- */

  async _handleUpgrade(req, socket, head, localIp) {
    socket.on('error', () => { /* handled via close */ });
    const ip = this.ts.normalizeIp(socket.remoteAddress);
    if (!this._started) return abortHandshake(socket, 503);
    if (!this._rateOk(`ws|${ip}`, UPGRADE_RATE)) return abortHandshake(socket, 429);
    if (!this.ts.isTailscaleIp(ip)) return abortHandshake(socket, 403);
    if (req.url !== PROTOCOL.WS_PATH) return abortHandshake(socket, 404);
    // Browsers always send Origin on WebSocket upgrades and cannot set custom headers.
    if (req.headers.origin !== undefined || req.headers['sec-websocket-origin'] !== undefined) return abortHandshake(socket, 403);
    if (req.headers[PROTOCOL.PROTOCOL_HEADER] !== String(PROTOCOL.PROTOCOL_VERSION)) return abortHandshake(socket, 426);
    if (!hostHeaderIsIp(req.headers.host)) return abortHandshake(socket, 403);
    // Whatever ws would refuse is refused here, before whois and before any slot is touched.
    const bad = wsHandshakeError(req);
    if (bad) return abortHandshake(socket, bad);
    if (this._countIp(ip) >= MAX_CONNECTIONS_PER_IP) return abortHandshake(socket, 503); // before whois

    const ident = await this._identify(ip);
    if (socket.destroyed) return undefined;
    if (!this._started) return abortHandshake(socket, 503);
    // whois failed: possibly transient (tailscaled busy / restarting), so answer "try again" (503)
    // rather than 403, which the viewer reports as "not on the allow list".
    if (!ident) return abortHandshake(socket, 503);
    if (!this._policyAllows(ident, this._settings())) return abortHandshake(socket, 403);
    // ws destroys a half-closed socket instead of upgrading it: never evict anyone for one.
    if (!socket.readable || !socket.writable) {
      socket.destroy();
      return undefined;
    }
    // Slot checks run here, synchronously with handleUpgrade (which adds the connection before
    // returning), so concurrent upgrades that all awaited whois cannot overshoot them.
    if (!this._makeRoom(ip, ident)) return abortHandshake(socket, 503);

    // Handed to ws: no longer pre-upgrade (ws clears the socket timeout itself as well).
    this._releasePreUpgrade(socket);
    socket.setTimeout(0);
    this._wss.handleUpgrade(req, socket, head, (ws) => this._onConnection(ws, ip, localIp, ident));
    return undefined;
  }

  _countIp(ip) {
    let n = 0;
    for (const c of this._conns) if (c.ip === ip) n++;
    return n;
  }

  /**
   * Connection-table admission for an identified peer. A node may hold at most
   * MAX_PREACTIVE_PER_NODE unanswered (hello / auth / pending) connections — a dual-stack node has
   * two IPs, so the per-IP cap alone lets 2 nodes fill the table. When MAX_CONNECTIONS live
   * connections exist, the oldest connection still in 'hello' or 'auth' of the node holding the
   * most unanswered ones is denied 'busy' to make room (never the active session or the pending
   * prompt; see _evictionVictim). Runs only for an upgrade ws will accept (wsHandshakeError).
   * @returns {boolean} false → refuse with 503
   */
  _makeRoom(ip, ident) {
    if (this._countIp(ip) >= MAX_CONNECTIONS_PER_IP) return false;
    const key = nodeKey(ident, ip);
    let live = 0;
    let mine = 0;
    for (const c of this._conns) {
      if (c.closed || c.state === 'closing') continue;
      live++;
      if (PREACTIVE_STATES.has(c.state) && this._cooldownKey(c) === key) mine++;
    }
    if (mine >= MAX_PREACTIVE_PER_NODE) return false;
    if (live < MAX_CONNECTIONS) return true;
    const victim = this._evictionVictim();
    if (!victim) return false;
    this._deny(victim, DENY.BUSY);
    return true;
  }

  /**
   * Who makes room in a full table. Candidates: connections still in 'hello' or 'auth' (waiting for
   * a request or for the next password; 'auth' holds a slot for up to 120 s per failed proof) —
   * never the pending prompt, the active session or a closing connection. The node holding the
   * most unanswered (hello / auth / pending) connections is chosen — on a tie, the one whose oldest
   * candidate is older — and loses its oldest candidate. null when that node has none (→ 503);
   * a less busy node's connection is never taken instead.
   */
  _evictionVictim() {
    const byNode = new Map(); // key → {count, victim, order}
    let order = 0;
    for (const c of this._conns) {
      order++;
      if (c.closed || !PREACTIVE_STATES.has(c.state)) continue;
      const k = this._cooldownKey(c);
      let e = byNode.get(k);
      if (!e) byNode.set(k, (e = { count: 0, victim: null, order: Infinity }));
      e.count++;
      if (!e.victim && EVICTABLE_STATES.has(c.state) && c !== this._pending && c !== this._session) {
        e.victim = c;
        e.order = order; // _conns keeps insertion order → first candidate = oldest
      }
    }
    let best = null;
    for (const e of byNode.values()) {
      if (!best || e.count > best.count || (e.count === best.count && e.order < best.order)) best = e;
    }
    return best ? best.victim : null;
  }

  _onConnection(ws, ip, localIp, ident) {
    const self = this._self();
    const conn = {
      id: crypto.randomUUID(),
      ws,
      ip,
      localIp,
      ident,
      // Our StableNodeID right now (proof binding hostId); the last running status as fallback.
      hostId: (self && typeof self.stableId === 'string' && self.stableId) || this._selfId,
      peer: {
        ip,
        // MagicDNS label (control plane, verified) before the self-reported OS hostname.
        hostname: ident.node.name.split('.')[0] || ident.node.hostname || ip,
        os: ident.node.os,
        user: { login: ident.user.login, displayName: ident.user.displayName || ident.user.login },
        stableId: ident.node.stableId,
        // ACL tags (control plane). A tagged node is never trusted (_isTrusted / _trustPeer).
        tags: (Array.isArray(ident.node.tags) ? ident.node.tags : []).slice(0, MAX_TAGS).map((t) => cleanText(t, 64)),
        sameUser: this._isSameUser(ident),
        isSelf: ident.isSelf,
      },
      viewer: null,
      state: 'hello', // hello → (pending | auth) → active → closing ; or closing directly
      nonce: this.auth.newNonce(),
      attempts: 0,
      missed: 0,
      requestId: null,
      promptAnswered: false,
      session: null,
      sessionEnded: false,
      timer: null,
      closed: false,
      killTimer: null,
    };
    this._conns.add(conn);
    ws.on('message', (data, isBinary) => this._onMessage(conn, data, isBinary));
    ws.on('pong', () => { conn.missed = 0; });
    ws.on('error', () => { /* 'close' follows */ });
    ws.on('close', (code) => this._onClose(conn, code));

    // No lockout check here: a password lock only blocks password sign-in (hello.auth.passwordLocked);
    // the prompt, trusted and same-user paths stay open.
    this._sendHello(conn);
    // No request in time (e.g. the viewer sits on its password card) → 'auth-timeout', not the
    // prompt's 'timeout' ("nobody accepted").
    conn.timer = setTimeout(() => { if (conn.state === 'hello') this._deny(conn, DENY.AUTH_TIMEOUT); }, this._requestWaitMs);
    return undefined;
  }

  _sendHello(conn) {
    const s = this._settings();
    const self = this._self();
    const pw = s.password;
    // Tells a viewer in password-only mode that it will be admitted without a password (trusted
    // node / same-user auto-accept — the same predicates _onRequest applies; self always prompts).
    const autoAccept = !conn.peer.isSelf && (this._isTrusted(conn.ident, s) || (s.autoAcceptSameUser && conn.peer.sameUser));
    this._send(conn, {
      t: MSG.HELLO,
      protocol: PROTOCOL.PROTOCOL_VERSION,
      app: PROTOCOL.APP_ID,
      version: this.appVersion,
      host: {
        hostname: (self && self.hostname) || os.hostname(),
        os: this.osName,
        user: {
          login: (self && self.user && self.user.login) || '',
          displayName: (self && self.user && (self.user.displayName || self.user.login)) || '',
        },
      },
      auth: {
        passwordSet: !!pw,
        acceptMode: s.acceptMode,
        salt: pw ? pw.salt : null,
        kdf: pw ? { N: pw.N, r: pw.r, p: pw.p, keylen: pw.keylen } : null,
        nonce: conn.nonce,
        autoAccept,
        // Password sign-in is locked for this peer right now: a proof would be ignored, so the
        // viewer sends its request without one (prompt / trusted / same-user still work).
        passwordLocked: !!this._pwBlocked(conn),
      },
    });
  }

  _send(conn, obj) {
    if (conn.closed || conn.ws.readyState !== WebSocket.OPEN) return false;
    try {
      conn.ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  /* -------------------------------- inbound frames -------------------------------- */

  _onMessage(conn, data, isBinary) {
    if (conn.closed || conn.state === 'closing') return undefined;
    if (isBinary) return this._protocolClose(conn, 'binary');
    let msg;
    try {
      msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    } catch {
      return this._protocolClose(conn, 'invalid-json');
    }
    if (!isPlainObject(msg) || typeof msg.t !== 'string') return this._protocolClose(conn, 'invalid-message');
    switch (msg.t) {
      case MSG.REQUEST: return this._onRequest(conn, msg);
      case MSG.AUTH: return this._onAuth(conn, msg);
      case MSG.SDP:
      case MSG.ICE: {
        if (conn.state !== 'active' || this._session !== conn) return undefined;
        const clean = sanitizeSignal(msg, (a) => this.ts.isTailscaleIp(a));
        if (clean) this._safeEmit('session-signal', clean);
        return undefined;
      }
      case MSG.BYE: return this._onBye(conn, msg);
      default: return undefined; // unknown types are ignored
    }
  }

  _onRequest(conn, msg) {
    if (conn.state !== 'hello') return undefined; // duplicate request → ignored
    clearTimeout(conn.timer);
    conn.timer = null;
    if (msg.protocol !== PROTOCOL.PROTOCOL_VERSION) return this._deny(conn, DENY.PROTOCOL);
    if (!isPlainObject(msg.viewer)) return this._deny(conn, DENY.PROTOCOL);
    let proof = null;
    if (msg.proof !== undefined && msg.proof !== null) {
      if (typeof msg.proof !== 'string' || msg.proof.length > MAX_PROOF_CHARS) return this._deny(conn, DENY.PROTOCOL);
      proof = msg.proof;
    }
    conn.viewer = {
      hostname: cleanText(msg.viewer.hostname, 255),
      os: VIEWER_OS.has(msg.viewer.os) ? msg.viewer.os : 'other',
      version: cleanText(msg.viewer.version, 64),
    };

    const s = this._settings();
    if (!s.hostEnabled) return this._deny(conn, DENY.DISABLED);
    // Only an active session makes the host busy for everyone. Another viewer's pending prompt
    // blocks only requests that need a prompt themselves (_startPrompt); password, trusted and
    // same-user admissions withdraw it (_accept), so unanswered prompts from strangers cannot keep
    // trusted devices and correct passwords out.
    if (this._session) return this._deny(conn, DENY.BUSY);
    if (!this._policyAllows(conn.ident, s)) return this._deny(conn, DENY.NOT_ALLOWED);
    // Locks gate only password verification: while password sign-in is blocked for this peer its
    // proof is ignored (not verified, not counted) and admission continues without it.
    const pwBlocked = this._pwBlocked(conn);
    const usesPassword = proof !== null && !!s.password && !pwBlocked;
    // A device the host user just turned away gets no new prompt (and no pending slot) for a while.
    // A password proof still gets checked: it never prompts, and failures are rate-limited.
    const coolMs = this._cooldownLeftMs(conn);
    if (coolMs > 0 && !usesPassword) return this._tryLater(conn, coolMs);

    let authFailed = false;
    if (usesPassword) {
      if (this.auth.verifyProof(s.password, conn.nonce, proof, this._binding(conn))) {
        this._resetLimiter(conn);
        return this._accept(conn, 'password');
      }
      if (!this._registerAuthFailure(conn)) return undefined; // denied
      authFailed = true;
    }
    // Back-off + wrong password: auth-failed was sent, so let the viewer retry its password (no
    // prompt meanwhile) instead of reporting the mistyped password as a declined request.
    if (coolMs > 0) return this._waitForAuth(conn);
    if (conn.peer.isSelf) return this._startPrompt(conn, s); // never silently auto-accept self
    if (this._isTrusted(conn.ident, s)) return this._accept(conn, 'trusted');
    if (s.autoAcceptSameUser && conn.peer.sameUser) return this._accept(conn, 'same-user');
    if (s.acceptMode === 'password-only') {
      if (authFailed) return this._waitForAuth(conn);
      return this._deny(conn, pwBlocked || DENY.PASSWORD_REQUIRED);
    }
    return this._startPrompt(conn, s);
  }

  /**
   * After auth-failed: wait for the next `auth` without holding the pending slot (waiting for a
   * password must not block everyone else). _onAuth / _accept re-check for an active session.
   */
  _waitForAuth(conn) {
    if (this._pending === conn) this._pending = null;
    conn.state = 'auth';
    this._armAuthWait(conn);
    return undefined;
  }

  _armAuthWait(conn) {
    clearTimeout(conn.timer);
    conn.timer = setTimeout(() => { if (conn.state === 'auth') this._deny(conn, DENY.AUTH_TIMEOUT); }, this._authWaitMs);
  }

  /** Count a bad proof. @returns {boolean} false when the connection was denied as a result. */
  _registerAuthFailure(conn) {
    conn.attempts++;
    let keyLocked = false;
    for (const k of this._limiterKeys(conn)) if (this.limiter.fail(k)) keyLocked = true;
    const wasGlobal = this.globalLimiter.isLocked(GLOBAL_KEY);
    const globalLocked = this.globalLimiter.fail(GLOBAL_KEY);
    if (globalLocked && !wasGlobal) {
      console.warn(`[host] ${GLOBAL_FAIL_LIMIT.max} failed passwords within ${GLOBAL_FAIL_LIMIT.windowMs / 60e3} min from all peers — password access suspended for ${GLOBAL_FAIL_LIMIT.lockMs / 60e3} min (devices admitted before and the owner's own devices are exempt).`);
    }
    if (keyLocked) {
      this._deny(conn, DENY.LOCKED);
      return false;
    }
    if (globalLocked && !this._globalExempt(conn)) {
      this._deny(conn, DENY.SUSPENDED);
      return false;
    }
    const remaining = AUTH.MAX_ATTEMPTS_PER_CONNECTION - conn.attempts;
    if (remaining <= 0) {
      this._deny(conn, DENY.BAD_PASSWORD);
      return false;
    }
    this._send(conn, { t: MSG.AUTH_FAILED, remaining });
    return true;
  }

  _onAuth(conn, msg) {
    if (conn.state !== 'pending' && conn.state !== 'auth') return undefined;
    if (typeof msg.proof !== 'string' || msg.proof.length > MAX_PROOF_CHARS) return this._deny(conn, DENY.PROTOCOL);
    const pwBlocked = this._pwBlocked(conn);
    if (pwBlocked) {
      // While a prompt is showing, a password the viewer types meanwhile is simply ignored: the
      // host user may be about to accept, and a lock only stops password sign-in.
      if (conn.state === 'pending') return undefined;
      return this._deny(conn, pwBlocked);
    }
    // Only an active session is 'busy': a correct proof withdraws another viewer's pending prompt
    // (_accept), as on the request path.
    if (this._session) return this._deny(conn, DENY.BUSY);
    const s = this._settings();
    if (s.password && this.auth.verifyProof(s.password, conn.nonce, msg.proof, this._binding(conn))) {
      this._resetLimiter(conn);
      return this._accept(conn, 'password');
    }
    if (this._registerAuthFailure(conn) && conn.state === 'auth') this._armAuthWait(conn);
    return undefined;
  }

  /** Viewer said bye: a reported failure reason reaches the host user, anything else is 'viewer-ended'. */
  _onBye(conn, msg) {
    const r = cleanReason(msg && msg.reason, '');
    if (conn.state === 'active') this._finishSession(conn, VIEWER_BYE_REASONS.has(r) ? r : 'viewer-ended');
    this._releaseSlot(conn);
    conn.state = 'closing';
    this._closeConn(conn, 1000, 'bye');
  }

  /** Invalid frame (binary / bad JSON / not an object with t) → close 1003. */
  _protocolClose(conn, why) {
    if (conn.state === 'active') this._finishSession(conn, 'protocol');
    this._releaseSlot(conn);
    conn.state = 'closing';
    this._closeConn(conn, 1003, why);
    return undefined;
  }

  /* -------------------------------- prompt / decisions -------------------------------- */

  _startPrompt(conn, s) {
    if (this.listenerCount('request') === 0) return this._deny(conn, DENY.REJECTED);
    // At most PROMPT_RATE.max prompts per node per window, whatever happened to them: withdrawing
    // a prompt (bye / socket close) records no back-off, so this is what stops prompt spam.
    const waitMs = this._promptWaitMs(conn);
    if (waitMs > 0) return this._tryLater(conn, waitMs);
    // The single pending slot: checked right before claiming it (another viewer's prompt → busy).
    if (this._pending && this._pending !== conn) return this._deny(conn, DENY.BUSY);
    this._pending = conn;
    this._logPrompt(conn);
    conn.state = 'pending';
    conn.requestId = crypto.randomBytes(16).toString('hex');
    this._send(conn, { t: MSG.PENDING });
    conn.timer = setTimeout(() => {
      if (conn.state !== 'pending') return;
      this._recordDenial(conn, 'timeout');
      this._deny(conn, DENY.TIMEOUT);
    }, s.promptTimeoutSec * 1000);

    const respond = (answer) => {
      if (conn.promptAnswered || conn.state !== 'pending' || conn.closed) return false;
      conn.promptAnswered = true;
      if (!isPlainObject(answer) || answer.accept !== true) {
        // Dismissed → escalating back-off for this device; main's own prompt timeout → flat 30 s.
        // 'busy' is main refusing a second prompt on its side: not the peer's fault, no back-off.
        const why = isPlainObject(answer) && (answer.reason === DENY.BUSY || answer.reason === DENY.TIMEOUT) ? answer.reason : DENY.REJECTED;
        if (why === DENY.TIMEOUT) this._recordDenial(conn, 'timeout');
        else if (why !== DENY.BUSY) this._recordDenial(conn, 'dismissed');
        this._deny(conn, why);
        return true;
      }
      const cur = this._settings();
      const perms = sanitizePermissions(answer.permissions, cur.defaultPermissions);
      if (answer.trust === true) this._trustPeer(conn.peer);
      this._accept(conn, conn.peer.isSelf ? 'self' : 'prompt', perms);
      return true;
    };
    const req = {
      requestId: conn.requestId,
      peer: structuredClone(conn.peer),
      viewer: structuredClone(conn.viewer),
      respond,
    };
    try {
      this.emit('request', req);
    } catch (e) {
      console.error("[host] 'request' listener failed:", e);
      if (conn.state === 'pending' && !conn.promptAnswered) {
        conn.promptAnswered = true;
        this._deny(conn, DENY.REJECTED);
      }
    }
    return undefined;
  }

  _accept(conn, via, perms) {
    clearTimeout(conn.timer);
    conn.timer = null;
    if (this._session && this._session !== conn) return this._deny(conn, DENY.BUSY);
    this._withdrawPending(conn);
    const wasPrompt = conn.state === 'pending';
    if (this._pending === conn) this._pending = null;
    if (wasPrompt && !conn.promptAnswered) {
      // Authenticated by password while the prompt was showing → close the prompt.
      conn.promptAnswered = true;
      this._safeEmit('request-cancelled', conn.requestId);
    }
    // Admitted by any path → forget its prompt back-off and prompt count; remember the identity.
    const key = this._cooldownKey(conn);
    this._cooldown.delete(key);
    this._promptLog.delete(key);
    if (via !== 'self') this._rememberGood(conn);
    const s = this._settings();
    const permissions = sanitizePermissions(perms, s.defaultPermissions);
    conn.state = 'active';
    conn.session = {
      id: crypto.randomUUID(),
      peer: structuredClone(conn.peer),
      viewer: structuredClone(conn.viewer),
      permissions,
      via,
      startedAt: Date.now(),
    };
    this._session = conn;
    this._send(conn, { t: MSG.ACCEPTED, sessionId: conn.session.id, permissions: { ...permissions }, via });
    this._safeEmit('session-start', structuredClone(conn.session));
    return undefined;
  }

  /**
   * An admission without a prompt (password, trusted, same-user) takes precedence over another
   * viewer's unanswered prompt: that viewer is denied 'busy' and main gets 'request-cancelled'
   * (_releaseSlot). No back-off is recorded for it — it did nothing wrong.
   */
  _withdrawPending(conn) {
    const other = this._pending;
    if (!other || other === conn) return;
    this._deny(other, DENY.BUSY);
    if (this._pending === other) this._pending = null; // (defensive: it was already closing)
  }

  /** Free the pending slot; emits 'request-cancelled' when an unanswered prompt was showing. */
  _releaseSlot(conn) {
    clearTimeout(conn.timer);
    conn.timer = null;
    if (this._pending === conn) this._pending = null;
    if (conn.state === 'pending' && !conn.promptAnswered) {
      conn.promptAnswered = true;
      this._safeEmit('request-cancelled', conn.requestId);
    }
  }

  /** Send `denied` (+ an optional validated retryAfterSec), then close 4000. */
  _deny(conn, reason, extra) {
    if (conn.closed || conn.state === 'closing') return undefined;
    const r = DENY_REASONS.has(reason) ? reason : DENY.PROTOCOL;
    this._releaseSlot(conn);
    const msg = { t: MSG.DENIED, reason: r };
    const wait = extra && extra.retryAfterSec;
    if (Number.isInteger(wait) && wait >= 1 && wait <= RETRY_AFTER_MAX_SEC) msg.retryAfterSec = wait;
    this._send(conn, msg);
    conn.state = 'closing';
    this._closeConn(conn, 4000, r);
    return undefined;
  }

  _closeConn(conn, code, reason) {
    if (conn.closed) return;
    if (conn.state !== 'active') conn.state = 'closing';
    try {
      conn.ws.close(code, String(reason || '').slice(0, 100));
    } catch {
      try { conn.ws.terminate(); } catch { /* ignore */ }
    }
    if (!conn.killTimer) {
      conn.killTimer = setTimeout(() => { try { conn.ws.terminate(); } catch { /* ignore */ } }, CLOSE_GRACE_MS);
      if (conn.killTimer.unref) conn.killTimer.unref();
    }
  }

  _onClose(conn, code) {
    if (conn.closed) return;
    const wasActive = conn.state === 'active';
    this._releaseSlot(conn);
    conn.closed = true;
    clearTimeout(conn.killTimer);
    this._conns.delete(conn);
    if (conn.session && !conn.sessionEnded) {
      const reason = conn.endReason || (wasActive && (code === 1000 || code === 1001) ? 'viewer-ended' : 'network');
      this._finishSession(conn, reason);
    }
  }

  _finishSession(conn, reason) {
    if (!conn.session || conn.sessionEnded) return;
    conn.sessionEnded = true;
    if (this._session === conn) this._session = null;
    this._safeEmit('session-end', { id: conn.session.id, reason });
  }

  _pingAll() {
    for (const conn of [...this._conns]) {
      if (conn.closed) continue;
      if (conn.missed >= 2) {
        conn.endReason = 'network';
        try { conn.ws.terminate(); } catch { /* ignore */ }
        continue;
      }
      conn.missed++;
      try { conn.ws.ping(); } catch { /* ignore */ }
    }
  }

  _safeEmit(event, payload) {
    try {
      this.emit(event, payload);
    } catch (e) {
      console.error(`[host] '${event}' listener failed:`, e);
    }
  }

  /* -------------------------------- public session API -------------------------------- */

  /** Panel renderer → viewer. Only {t:'sdp'} / {t:'ice'}; validated + stripped. @returns {boolean} sent */
  sendSignal(msg) {
    const conn = this._session;
    if (!conn || conn.state !== 'active') return false;
    const clean = sanitizeSignal(msg, (a) => this.ts.isTailscaleIp(a));
    if (!clean) return false;
    return this._send(conn, clean);
  }

  /** Update permissions of the active session (missing keys keep their value) and notify the viewer. */
  setPermissions(perms) {
    const conn = this._session;
    if (!conn || !conn.session) return null;
    const next = sanitizePermissions(perms, conn.session.permissions);
    conn.session.permissions = next;
    this._send(conn, { t: MSG.PERMISSIONS, permissions: { ...next } });
    return { ...next };
  }

  /** End the active session: bye → close 1000 → 'session-end' (exactly once). @returns {boolean} */
  endSession(reason = 'host-ended') {
    const conn = this._session;
    if (!conn) return false;
    const r = cleanReason(reason, 'host-ended');
    conn.endReason = r;
    this._send(conn, { t: MSG.BYE, reason: r });
    this._finishSession(conn, r);
    conn.state = 'closing';
    this._closeConn(conn, 1000, r);
    return true;
  }
}

module.exports = HostServer;
module.exports.HostServer = HostServer;
module.exports.sanitizeSignal = sanitizeSignal;
module.exports.sanitizePermissions = sanitizePermissions;
module.exports.candidateAddress = candidateAddress;
module.exports.isPlainObject = isPlainObject;
module.exports.cleanText = cleanText;
module.exports.hostHeaderIsIp = hostHeaderIsIp;
