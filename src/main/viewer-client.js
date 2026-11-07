'use strict';
/*
 * Outbound signaling client for ONE viewer session (docs/ARCHITECTURE.md §4, §7).
 *
 *   const vs = new ViewerSession({ tailscale, auth, target:{ip, port, peer}, password, self:{hostname, os, version} });
 *   vs.on('status', s => …)        // {phase, host?, remaining?, sessionId?, permissions?, via?, reason?, message?, proofSent?}
 *   vs.on('signal', msg => …)      // {t:'sdp', description} | {t:'ice', candidate}  (validated)
 *   vs.on('permissions', p => …)   // host changed permissions
 *   vs.on('closed', {reason, message, proofSent, hostReason?})   // exactly once per connect()
 *   vs.connect(); vs.submitPassword(pw); vs.sendSignal(msg); vs.close(reason);
 *
 * Phases: idle → connecting → hello → (auth-required | waiting) → accepted → closed.
 * Closed reasons: unreachable | not-tunnelview | timeout | protocol | denied:<reason> | host-ended |
 *                 network | not-tailnet (target is not a tailnet device) | not-tailnet-route (the
 *                 socket did not run over our own Tailscale IP) | rate-limited (HTTP 429: too many
 *                 connection attempts from this device) | local (we closed it).
 * Both closed payloads ('closed' and the 'status' {phase:'closed'}) carry proofSent: true iff this
 * connection put a password proof on the wire (request.proof or an auth message) — a 'denied:locked'
 * without one says nothing about the remembered password.
 *
 * Tailscale-only: before dialing, the target IP must pass tailscale.isTailscaleIp() AND belong to
 * self or a peer in the CURRENT `tailscale status` (state 'running') — 100.64/10 alone is also ISP
 * CGNAT space. The URL always contains an IP literal and DNS lookups are refused outright.
 * Before anything is sent (request, hostname, password proof) the socket's local address must be
 * one of our own Tailscale IPs of the dialed IP's family — otherwise the OS routed the tailnet
 * range elsewhere (CGNAT route conflict, Tailscale still starting) and we stop with
 * 'not-tailnet-route' (the target itself is a valid peer).
 * Password proofs are bound to {hostId: StableNodeID owning the dialed IP, viewerId: our own
 * StableNodeID}, both from that same status (auth.js).
 */
const { EventEmitter } = require('events');
const WebSocket = require('ws');
const PROTOCOL = require('../shared/protocol');
const { sanitizeSignal, sanitizePermissions, isPlainObject, cleanText } = require('./host-server');

const { MSG, DENY } = PROTOCOL;

const HELLO_TIMEOUT_MS = PROTOCOL.HANDSHAKE_TIMEOUT_MS; // after the WebSocket opened
const LIVENESS_MS = PROTOCOL.PING_INTERVAL_MS * 2 + 10000; // host pings every 15 s
const LIVENESS_CHECK_MS = 5000;
const CLOSE_TIMEOUT_MS = 5000;
const MAX_PASSWORD_LENGTH = 1024;
const OS_SET = new Set(['windows', 'macos', 'linux', 'ios', 'android', 'other']);
const VIA_SET = new Set(['password', 'prompt', 'trusted', 'same-user', 'self']);
const DENY_SET = new Set(Object.values(DENY));
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

const DENY_TEXT = {
  [DENY.REJECTED]: 'The remote user declined the connection.',
  [DENY.TIMEOUT]: 'The remote user did not answer in time.',
  [DENY.BUSY]: 'The remote device is busy with another session.',
  [DENY.NOT_ALLOWED]: 'This device or account is not allowed to connect to the remote device.',
  [DENY.BAD_PASSWORD]: 'Wrong password — too many attempts.',
  [DENY.PASSWORD_REQUIRED]: 'The remote device only accepts connections with its password.',
  [DENY.LOCKED]: 'Too many failed password attempts from this device or your Tailscale account. Try again in 15 minutes.',
  [DENY.PROTOCOL]: 'The remote device rejected the request (protocol error).',
  [DENY.DISABLED]: 'Incoming connections are turned off on the remote device.',
  [DENY.AUTH_TIMEOUT]: 'The remote device stopped waiting because the password was not entered in time.',
  [DENY.SUSPENDED]: 'The remote device has paused password sign-in for up to 15 minutes after many failed attempts from several devices. Trusted devices and requests the person there accepts still work.',
  // Prompt back-off (declined / unanswered) and the prompt rate limit (which also counts requests
  // this device withdrew itself); retryText() appends the wait.
  [DENY.TRY_LATER]: 'The remote device is not taking new requests from this device right now: a recent request was declined or not answered there, or this device asked several times in a few minutes.',
};

/** " Try again in N seconds." / " Try again in about M minutes." for denied 'try-later' (else ''). */
function retryText(sec) {
  if (!Number.isInteger(sec) || sec < 1 || sec > 3600) return '';
  if (sec < 90) return ` Try again in ${sec} ${sec === 1 ? 'second' : 'seconds'}.`;
  return ` Try again in about ${Math.ceil(sec / 60)} minutes.`;
}

const TEXT = {
  unreachable: 'The device could not be reached over Tailscale. It may be offline, asleep, or blocked by your tailnet ACLs.',
  notTunnelview: 'The device is online, but Tunnelview is not running there (or is not accepting connections).',
  timeout: 'The remote device did not respond in time.',
  network: 'The connection to the remote device was lost.',
  protocol: 'The remote device sent an invalid response.',
  incompatible: 'The remote device runs an incompatible version of Tunnelview.',
  notTailnet: 'Refusing to connect: the target is not a device in your tailnet.',
  tsDown: 'Tailscale is not running on this device.',
  noBinding: 'Could not determine the Tailscale device IDs of this connection; the password was not used.',
  hostEnded: 'The remote side ended the session.',
  local: 'Disconnected.',
  unsafeKdf: 'The remote device requested unsafe password parameters; the password was not sent.',
};

// Defense in depth: the URL always holds an IP literal (no lookup happens), but if anything ever
// tried to resolve a name it must fail rather than consult system DNS.
function refuseDns(hostname, options, cb) {
  const callback = typeof options === 'function' ? options : cb;
  const err = new Error(`DNS lookups are disabled (${hostname})`);
  err.code = 'ENOTFOUND';
  process.nextTick(() => callback(err));
}

function mapSocketError(err) {
  const code = err && err.code;
  const msg = String((err && err.message) || '');
  if (code === 'ECONNREFUSED') return ['not-tunnelview', TEXT.notTunnelview];
  if (['EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EHOSTDOWN', 'EADDRNOTAVAIL', 'ENETDOWN'].includes(code)) return ['unreachable', TEXT.unreachable];
  if (/handshake has timed out/i.test(msg)) return ['unreachable', TEXT.unreachable];
  if (typeof code === 'string' && code.startsWith('WS_ERR_')) return ['protocol', TEXT.protocol];
  if (/Invalid (Upgrade|Sec-WebSocket)|Server sent/i.test(msg)) return ['not-tunnelview', TEXT.notTunnelview];
  if (code === 'ECONNRESET' || code === 'EPIPE') return ['network', 'The connection was reset by the remote device.'];
  return ['network', msg ? `Connection failed: ${cleanText(msg, 200)}` : TEXT.network];
}

function mapHttpStatus(status) {
  if (status === 403) return [`denied:${DENY.NOT_ALLOWED}`, DENY_TEXT[DENY.NOT_ALLOWED]];
  // The host's upgrade rate limit (per source IP), not a password lock: no 'denied:' prefix.
  if (status === 429) return ['rate-limited', 'Too many connection attempts from this device. Try again in a minute.'];
  if (status === 426) return ['protocol', TEXT.incompatible];
  // 503: busy / shutting down / could not verify us with `tailscale whois` right now — retryable.
  if (status === 503) return [`denied:${DENY.BUSY}`, 'The remote device is busy or could not verify this device with Tailscale right now. Try again shortly.'];
  return ['not-tunnelview', `The device answered, but not as Tunnelview (HTTP ${Number(status) || '?'}).`];
}

function validNonce(s) {
  return typeof s === 'string' && s.length >= 24 && s.length <= 88 && s.length % 4 === 0 && B64_RE.test(s);
}

class ViewerSession extends EventEmitter {
  /**
   * @param {{tailscale, auth, target:{ip:string, port:number, peer?:object}, password?:string|null,
   *          self:{hostname:string, os:string, version:string}}} opts
   */
  constructor({ tailscale, auth, target, password = null, self = {} } = {}) {
    super();
    if (!tailscale || !auth || !target) throw new TypeError('ViewerSession requires { tailscale, auth, target }');
    this.ts = tailscale;
    this.auth = auth;
    this.target = { ip: String(target.ip || ''), port: Number(target.port), peer: target.peer || null };
    this.self = {
      hostname: cleanText(self && self.hostname, 255),
      os: OS_SET.has(self && self.os) ? self.os : 'other',
      version: cleanText(self && self.version, 64),
    };
    this._initialPassword = typeof password === 'string' && password.length > 0 && password.length <= MAX_PASSWORD_LENGTH ? password : null;
    this.phase = 'idle';
    this.host = null; // public host info from hello
    this.sessionId = null;
    this.permissions = null;
    this.via = null;
    this._ws = null;
    this._attempt = 0;
    this._resetAttemptState();
  }

  _resetAttemptState() {
    this._password = this._initialPassword;
    this._authParams = null;
    this._requestSent = false;
    this._proofSent = false; // a password proof went on the wire on this connection
    this._computing = false;
    this._opened = false;
    this._dialIp = null; // normalized IP dialed
    this._localIp = null; // normalized local socket IP (must be one of _selfIps)
    this._selfIps = []; // our own Tailscale IPs from the status checked before dialing
    this._bindIds = null; // {hostId, viewerId} StableNodeIDs from that status (proof binding)
    this._httpStatus = 0;
    this._lastError = null;
    this._closedEmitted = false;
    this._closeInfo = null; // [reason, message] decided before the socket closes
    this._lastRx = 0;
    this._remaining = null;
    this._clearTimers();
    this.host = null;
    this.sessionId = null;
    this.permissions = null;
    this.via = null;
  }

  _clearTimers() {
    clearTimeout(this._helloTimer);
    clearInterval(this._liveTimer);
    this._helloTimer = null;
    this._liveTimer = null;
  }

  /* -------------------------------- connect -------------------------------- */

  /**
   * Start (or restart after 'closed') the connection. Returns synchronously; the current
   * `tailscale status` is checked asynchronously before anything is dialed.
   * @returns {boolean} started (false: already running, or refused right away → 'closed' emitted)
   */
  connect() {
    if (!this._closedEmitted && this.phase !== 'idle') return false; // already running
    this._resetAttemptState();
    const attempt = ++this._attempt;
    this._setPhase('connecting');

    const ip = this.ts.normalizeIp(this.target.ip);
    if (!ip || !this.ts.isTailscaleIp(ip)) {
      this._finish('not-tailnet', TEXT.notTailnet);
      return false;
    }
    const port = this.target.port;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      this._finish('protocol', 'Invalid port.');
      return false;
    }
    this._dialIp = ip;
    this._checkTailnetAndDial(attempt, ip, port);
    return true;
  }

  /**
   * Defense in depth for §1.4: 100.64/10 is also ISP CGNAT space, so only dial while Tailscale is
   * running AND the IP belongs to self or a peer in the current status — otherwise a stored address
   * (reconnect, recent list) would go out over the LAN/ISP route, possibly with a password proof.
   */
  async _checkTailnetAndDial(attempt, ip, port) {
    let st = null;
    try {
      st = typeof this.ts.status === 'function' ? await this.ts.status() : null;
    } catch {
      st = null;
    }
    if (attempt !== this._attempt || this._closedEmitted) return; // closed / restarted meanwhile
    if (!st || st.state !== 'running') {
      this._finish('unreachable', TEXT.tsDown);
      return;
    }
    const owns = (n) => !!n && Array.isArray(n.ips) && n.ips.some((x) => this.ts.normalizeIp(x) === ip);
    const self = st.self && typeof st.self === 'object' ? st.self : null;
    // Every tailnet IP belongs to exactly one node; peers are checked first, so self only owns the
    // address when no peer does (a self-connection).
    const owner = (Array.isArray(st.peers) ? st.peers : []).find(owns) || (owns(self) ? self : null);
    if (!owner) {
      this._finish('not-tailnet', TEXT.notTailnet);
      return;
    }
    this._selfIps = self && Array.isArray(self.ips) ? self.ips.map((x) => this.ts.normalizeIp(x)).filter(Boolean) : [];
    this._bindIds = { hostId: String(owner.stableId || ''), viewerId: String((self && self.stableId) || '') };
    this._dial(attempt, ip, port);
  }

  _dial(attempt, ip, port) {
    const url = `ws://${ip.includes(':') ? `[${ip}]` : ip}:${port}${PROTOCOL.WS_PATH}`;
    let ws;
    try {
      ws = new WebSocket(url, {
        headers: { [PROTOCOL.PROTOCOL_HEADER]: String(PROTOCOL.PROTOCOL_VERSION) },
        // no `origin` option → no Origin header (the host rejects upgrades that carry one)
        handshakeTimeout: PROTOCOL.HANDSHAKE_TIMEOUT_MS,
        maxPayload: PROTOCOL.MAX_WS_PAYLOAD,
        perMessageDeflate: false,
        followRedirects: false,
        closeTimeout: CLOSE_TIMEOUT_MS,
        lookup: refuseDns,
      });
    } catch (e) {
      this._finish('protocol', cleanText(e && e.message, 200) || TEXT.protocol);
      return;
    }
    this._ws = ws;
    const mine = () => this._ws === ws && this._attempt === attempt;

    ws.on('unexpected-response', (_req, res) => {
      if (!mine()) return;
      this._httpStatus = res.statusCode;
      try { res.resume(); } catch { /* ignore */ }
      ws.terminate(); // aborts the request → 'error' + 'close'
    });
    // Our end of the connection ('upgrade' carries the socket publicly; ws._socket is the fallback),
    // checked before hello, i.e. before we send anything beyond the upgrade request itself.
    ws.on('upgrade', (res) => {
      if (!mine()) return;
      this._captureLocalIp(res && res.socket);
      if (!this._localPathOk()) this._failLocalPath();
    });
    ws.on('open', () => {
      if (!mine()) return;
      if (!this._localIp) this._captureLocalIp(ws._socket);
      this._opened = true;
      this._lastRx = Date.now();
      this._helloTimer = setTimeout(() => {
        if (mine() && !this.host) this._fail('timeout', TEXT.timeout);
      }, HELLO_TIMEOUT_MS);
      this._liveTimer = setInterval(() => {
        if (mine() && Date.now() - this._lastRx > LIVENESS_MS) this._fail('network', TEXT.network);
      }, LIVENESS_CHECK_MS);
      if (this._liveTimer.unref) this._liveTimer.unref();
    });
    ws.on('message', (data, isBinary) => { if (mine()) this._onMessage(data, isBinary); });
    ws.on('ping', () => { if (mine()) this._lastRx = Date.now(); });
    ws.on('pong', () => { if (mine()) this._lastRx = Date.now(); });
    ws.on('error', (err) => { if (mine()) this._lastError = err; });
    ws.on('close', (code) => { if (mine()) this._onSocketClose(code); });
  }

  _captureLocalIp(sock) {
    const a = sock && typeof sock.localAddress === 'string' ? sock.localAddress : '';
    const ip = a ? this.ts.normalizeIp(a) : '';
    if (ip) this._localIp = ip;
  }

  /**
   * The socket really runs over Tailscale: its local address is one of our own Tailscale IPs and
   * of the same family as the dialed IP. If the OS routed 100.64/10 or fd7a::/48 over another
   * interface (CGNAT route conflict, Tailscale's route not installed yet), it is not.
   */
  _localPathOk() {
    const ip = this._localIp;
    if (!ip || !this._dialIp || !this._selfIps.includes(ip)) return false;
    return ip.includes(':') === this._dialIp.includes(':');
  }

  /** Our route to a valid peer bypasses Tailscale ('not-tailnet' means the target is not a peer). */
  _failLocalPath() {
    const where = this._localIp || 'unknown';
    this._fail('not-tailnet-route', `The connection did not go through Tailscale (local address ${where}), so Tunnelview stopped before sending anything.`);
  }

  /** {hostId, viewerId} StableNodeIDs for auth.computeProof, or null when either is unknown. */
  _proofBinding() {
    const b = this._bindIds;
    return b && b.hostId && b.viewerId ? { hostId: b.hostId, viewerId: b.viewerId } : null;
  }

  /* -------------------------------- inbound -------------------------------- */

  _onMessage(data, isBinary) {
    if (this._closedEmitted) return;
    this._lastRx = Date.now();
    if (isBinary) return this._fail('protocol', TEXT.protocol, 1003);
    let msg;
    try {
      msg = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    } catch {
      return this._fail('protocol', TEXT.protocol, 1003);
    }
    if (!isPlainObject(msg) || typeof msg.t !== 'string') return this._fail('protocol', TEXT.protocol, 1003);

    switch (msg.t) {
      case MSG.HELLO: return this._onHello(msg);
      case MSG.PENDING:
        if (this._requestSent && this.phase !== 'accepted') {
          this._setPhase('waiting', this._remaining !== null ? { remaining: this._remaining } : {});
        }
        return undefined;
      case MSG.AUTH_FAILED: {
        if (!this._requestSent || this.phase === 'accepted') return undefined;
        const rem = Number.isInteger(msg.remaining) && msg.remaining >= 0 && msg.remaining <= 100 ? msg.remaining : 0;
        this._remaining = rem;
        this._password = null; // it was wrong; don't reuse it
        this._setPhase('auth-required', { remaining: rem });
        return undefined;
      }
      case MSG.ACCEPTED: return this._onAccepted(msg);
      case MSG.DENIED: {
        const reason = DENY_SET.has(msg.reason) ? msg.reason : DENY.PROTOCOL;
        const wait = reason === DENY.TRY_LATER ? retryText(msg.retryAfterSec) : '';
        return this._fail(`denied:${reason}`, DENY_TEXT[reason] + wait);
      }
      case MSG.SDP:
      case MSG.ICE: {
        if (this.phase !== 'accepted') return undefined;
        const clean = sanitizeSignal(msg, (a) => this.ts.isTailscaleIp(a));
        if (clean) this._safeEmit('signal', clean);
        return undefined;
      }
      case MSG.PERMISSIONS: {
        if (this.phase !== 'accepted' || !isPlainObject(msg.permissions)) return undefined;
        this.permissions = sanitizePermissions(msg.permissions, this.permissions);
        this._safeEmit('permissions', { ...this.permissions });
        return undefined;
      }
      case MSG.BYE: {
        const r = cleanText(msg.reason, 64);
        return this._fail('host-ended', TEXT.hostEnded, 1000, r ? { hostReason: r } : undefined);
      }
      default: return undefined; // unknown types are ignored
    }
  }

  _onHello(msg) {
    if (this.phase !== 'connecting' || this.host) return undefined; // duplicate hello → ignore
    clearTimeout(this._helloTimer);
    this._helloTimer = null;
    // Last gate before anything leaves this machine (request, hostname, password proof).
    if (!this._localPathOk()) return this._failLocalPath();
    if (msg.app !== PROTOCOL.APP_ID) return this._fail('not-tunnelview', TEXT.notTunnelview);
    if (msg.protocol !== PROTOCOL.PROTOCOL_VERSION) return this._fail('protocol', TEXT.incompatible);
    const h = isPlainObject(msg.host) ? msg.host : null;
    const a = isPlainObject(msg.auth) ? msg.auth : null;
    if (!h || !a) return this._fail('protocol', TEXT.protocol);
    if (typeof a.passwordSet !== 'boolean' || (a.acceptMode !== 'ask' && a.acceptMode !== 'password-only') || !validNonce(a.nonce)) {
      return this._fail('protocol', TEXT.protocol);
    }
    if (a.passwordSet && (typeof a.salt !== 'string' || a.salt.length > 128 || !isPlainObject(a.kdf))) {
      return this._fail('protocol', TEXT.protocol);
    }
    const user = isPlainObject(h.user) ? h.user : {};
    this.host = {
      hostname: cleanText(h.hostname, 255),
      os: OS_SET.has(h.os) ? h.os : 'other',
      user: { login: cleanText(user.login, 320), displayName: cleanText(user.displayName, 256) },
      passwordSet: a.passwordSet,
      acceptMode: a.acceptMode,
      // true: the host will admit us without a password (trusted node / same-user auto-accept).
      // Absent or not a boolean → false.
      autoAccept: a.autoAccept === true,
      // true: password sign-in is locked for us right now (a proof would be ignored).
      passwordLocked: a.passwordLocked === true,
      version: cleanText(msg.version, 64),
    };
    this._authParams = a.passwordSet
      ? { salt: a.salt, kdf: { N: a.kdf.N, r: a.kdf.r, p: a.kdf.p, keylen: a.kdf.keylen }, nonce: a.nonce }
      : { salt: null, kdf: null, nonce: a.nonce };
    // Refuse unsafe KDF params up front (malicious host DoS / cheap-to-crack proofs).
    if (a.passwordSet && !this.auth.validateKdf(this._authParams.kdf)) return this._fail('protocol', TEXT.unsafeKdf);

    this._setPhase('hello');
    if (this.host.autoAccept || this.host.passwordLocked) {
      // Admitted without a password, or a password could not be used anyway: no proof is sent
      // (a lock then yields the prompt, or the host's locked / suspended answer right away).
      this._sendRequest(null);
    } else if (this.host.passwordSet && this._password) {
      this._sendRequestWithPassword(this._password);
    } else if (this._needsPassword()) {
      this._setPhase('auth-required');
    } else {
      this._sendRequest(null);
    }
    return undefined;
  }

  /** Password-only host that will not auto-accept us → ask the user before sending a request. */
  _needsPassword() {
    const h = this.host;
    return !!h && h.acceptMode === 'password-only' && h.passwordSet && !h.autoAccept && !h.passwordLocked;
  }

  _onAccepted(msg) {
    if (!this._requestSent || this.phase === 'accepted') return undefined;
    if (typeof msg.sessionId !== 'string' || !msg.sessionId || msg.sessionId.length > 128) return this._fail('protocol', TEXT.protocol);
    this.sessionId = cleanText(msg.sessionId, 128);
    this.permissions = sanitizePermissions(msg.permissions, null);
    this.via = VIA_SET.has(msg.via) ? msg.via : 'prompt';
    this._password = null;
    this._setPhase('accepted', { sessionId: this.sessionId, permissions: { ...this.permissions }, via: this.via });
    return undefined;
  }

  /* -------------------------------- outbound -------------------------------- */

  _send(obj) {
    const ws = this._ws;
    if (!ws || this._closedEmitted || ws.readyState !== WebSocket.OPEN) return false;
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch {
      return false;
    }
  }

  _sendRequest(proof) {
    this._requestSent = true;
    const sent = this._send({ t: MSG.REQUEST, protocol: PROTOCOL.PROTOCOL_VERSION, viewer: { ...this.self }, proof: proof || null });
    if (sent && proof) this._proofSent = true;
    return sent;
  }

  async _sendRequestWithPassword(pw) {
    const attempt = this._attempt;
    const binding = this._proofBinding();
    if (!binding) {
      // Never compute an unbound proof (it could be relayed to another host).
      this._fail('protocol', TEXT.noBinding);
      return;
    }
    this._computing = true;
    let proof;
    try {
      proof = await this.auth.computeProof(pw, this._authParams, this._authParams.nonce, binding);
    } catch (e) {
      this._computing = false;
      if (attempt !== this._attempt || this._closedEmitted) return;
      if (e && e.code === 'BAD_BINDING') {
        this._fail('protocol', TEXT.noBinding);
        return;
      }
      if (e && (e.code === 'BAD_KDF' || e.code === 'BAD_SALT' || e.code === 'BAD_NONCE')) {
        this._fail('protocol', TEXT.unsafeKdf);
        return;
      }
      // Unusable password input → ask the user instead.
      this._password = null;
      if (this._needsPassword()) this._setPhase('auth-required');
      else this._sendRequest(null);
      return;
    }
    this._computing = false;
    if (attempt !== this._attempt || this._closedEmitted) return;
    this._sendRequest(proof);
  }

  /**
   * Password typed by the user (phase hello / auth-required / waiting). Sends t=request with the proof
   * if the request was not sent yet, otherwise t=auth. Before hello arrives it is kept for later.
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  async submitPassword(pw) {
    if (typeof pw !== 'string' || pw.length === 0 || pw.length > MAX_PASSWORD_LENGTH) return { ok: false, error: 'Enter the password.' };
    if (this._closedEmitted || this.phase === 'idle' || this.phase === 'closed') return { ok: false, error: 'Not connected.' };
    if (this.phase === 'accepted') return { ok: false, error: 'Already connected.' };
    if (!this.host) {
      this._password = pw; // used as soon as hello arrives
      return { ok: true };
    }
    if (!this.host.passwordSet) return { ok: false, error: 'The remote device has no password set.' };
    if (this.host.passwordLocked) return { ok: false, error: 'Password sign-in is temporarily locked on the remote device.' };
    if (this._computing) return { ok: false, error: 'Still checking the previous password.' };
    const attempt = this._attempt;
    const binding = this._proofBinding();
    if (!binding) {
      this._fail('protocol', TEXT.noBinding);
      return { ok: false, error: TEXT.noBinding };
    }
    this._computing = true;
    let proof;
    try {
      proof = await this.auth.computeProof(pw, this._authParams, this._authParams.nonce, binding);
    } catch (e) {
      if (e && e.code === 'BAD_BINDING') {
        if (attempt === this._attempt) this._fail('protocol', TEXT.noBinding);
        return { ok: false, error: TEXT.noBinding };
      }
      if (e && (e.code === 'BAD_KDF' || e.code === 'BAD_SALT' || e.code === 'BAD_NONCE')) {
        if (attempt === this._attempt) this._fail('protocol', TEXT.unsafeKdf);
        return { ok: false, error: TEXT.unsafeKdf };
      }
      return { ok: false, error: 'Invalid password.' };
    } finally {
      if (attempt === this._attempt) this._computing = false;
    }
    if (attempt !== this._attempt || this._closedEmitted || this.phase === 'accepted') return { ok: false, error: 'Not connected.' };
    let sent = true;
    if (this._requestSent) {
      sent = this._send({ t: MSG.AUTH, proof });
      if (sent) this._proofSent = true;
    } else {
      this._sendRequest(proof); // sets _proofSent once it is on the wire
    }
    return sent ? { ok: true } : { ok: false, error: 'Not connected.' };
  }

  /** Viewer renderer → host. Only {t:'sdp'} / {t:'ice'} while accepted. @returns {boolean} sent */
  sendSignal(msg) {
    if (this.phase !== 'accepted') return false;
    const clean = sanitizeSignal(msg, (a) => this.ts.isTailscaleIp(a));
    if (!clean) return false;
    return this._send(clean);
  }

  /** Send bye (when open) and close. Emits 'closed' {reason:'local'} unless already closed. */
  close(reason = 'viewer-closed') {
    const ws = this._ws;
    if (this._closedEmitted) {
      if (ws && ws.readyState === WebSocket.CONNECTING) ws.terminate();
      return;
    }
    const r = cleanText(reason, 64) || 'viewer-closed';
    if (ws && ws.readyState === WebSocket.OPEN) this._send({ t: MSG.BYE, reason: r });
    this._finish('local', TEXT.local);
  }

  /* -------------------------------- teardown -------------------------------- */

  /** Decide the close reason now, emit 'closed', then close the socket. */
  _fail(reason, message, code = 1000, extra) {
    if (this._closedEmitted) return undefined;
    this._finish(reason, message, code, extra);
    return undefined;
  }

  _onSocketClose(code) {
    if (this._closedEmitted) {
      this._clearTimers();
      return;
    }
    let info;
    if (this._httpStatus) info = mapHttpStatus(this._httpStatus);
    else if (!this._opened) info = mapSocketError(this._lastError);
    else if (code === 1003) info = ['protocol', TEXT.protocol];
    else if (this.phase === 'accepted') info = ['network', TEXT.network];
    else if (code === 4000) info = ['protocol', TEXT.protocol]; // denied without a denied frame
    else if (this.host) info = ['network', TEXT.network];
    else info = ['not-tunnelview', TEXT.notTunnelview];
    this._finish(info[0], info[1]);
  }

  _finish(reason, message, code = 1000, extra) {
    if (this._closedEmitted) return;
    this._closedEmitted = true;
    this._clearTimers();
    this._password = null;
    this.phase = 'closed';
    // proofSent lets main keep a remembered password that this connection never tried (e.g.
    // 'denied:locked' after hello.auth.passwordLocked, where no proof is sent).
    const payload = { reason, message: message || '', proofSent: this._proofSent, ...(extra || {}) };
    this._safeEmit('status', { phase: 'closed', ...payload });
    this._safeEmit('closed', payload);
    const ws = this._ws;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) ws.close(code, '');
      else if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
    } catch {
      try { ws.terminate(); } catch { /* ignore */ }
    }
  }

  _setPhase(phase, extra = {}) {
    this.phase = phase;
    const status = { phase, ...extra };
    if (this.host && phase !== 'connecting') {
      status.host = {
        hostname: this.host.hostname,
        os: this.host.os,
        user: { ...this.host.user },
        passwordSet: this.host.passwordSet,
        acceptMode: this.host.acceptMode,
      };
    }
    this._safeEmit('status', status);
  }

  _safeEmit(event, payload) {
    try {
      this.emit(event, payload);
    } catch (e) {
      console.error(`[viewer] '${event}' listener failed:`, e);
    }
  }
}

module.exports = ViewerSession;
module.exports.ViewerSession = ViewerSession;
module.exports.mapSocketError = mapSocketError;
module.exports.mapHttpStatus = mapHttpStatus;
module.exports.DENY_TEXT = DENY_TEXT;
