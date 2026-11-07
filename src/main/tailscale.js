'use strict';
/*
 * Tailscale integration — the foundation of Tunnelview's "Tailscale-only" guarantee
 * (docs/ARCHITECTURE.md §1, §7):
 *   - CLI discovery + `tailscale status --json` → TsStatus (self, peers, MagicDNS suffix)
 *   - `tailscale whois --json <ip>` → identity of an inbound peer (cached 60 s)
 *   - macOS: the CLI is the Tailscale app executable. It is run with TAILSCALE_BE_CLI=1 (cliEnv) and
 *     only while this Mac has a Tailscale address (Tailscale#_cliAllowed)
 *   - isTailscaleIp / normalizeIp: strict address validation (real bit math, full IPv6 parsing)
 *   - resolveTarget: names/IPs → peer, resolved ONLY through the tailnet peer list (never system DNS)
 *   - startWatching: periodic status polling with 'status' / 'change' events
 *
 * Usage: `const ts = require('./tailscale')` → singleton instance. The class and the pure helpers
 * are attached to the export for tests (module.exports.Tailscale, .parseStatus, .parseWhois, ...).
 * Constructing an instance has no side effects (no CLI calls, no timers).
 */
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PROTOCOL = require('../shared/protocol');

const CLI_TIMEOUT_MS = 5000;
const CLI_MAX_BUFFER = 32 * 1024 * 1024; // large tailnets produce big status JSON
const WHOIS_TTL_MS = 60 * 1000;
const WHOIS_NEGATIVE_TTL_MS = 5 * 1000; // short negative cache: blunts floods from non-peer IPs
const WHOIS_CACHE_MAX = 512;
const MIN_WATCH_MS = 100;
const TAGGED_LOGIN = 'tagged-devices';
const TAGGED_DISPLAY = 'Tagged Devices';
const OS_VALUES = ['windows', 'macos', 'linux', 'ios', 'android', 'other'];
const RELAY_RE = /^[a-z0-9-]{0,16}$/; // DERP region code ("ams", "nyc", …)
// AMBIGUOUS message: the UI shows at most 220 chars, so the instruction comes first, then at most
// 3 candidates of ≤ 60 chars each (fewer when they would not fit).
const AMBIGUOUS_LIST_MAX = 3;
const AMBIGUOUS_ITEM_MAX = 60;
const AMBIGUOUS_MSG_MAX = 220;

/* ------------------------------------------------------------------------------------------ */
/* IP address helpers (pure)                                                                   */
/* ------------------------------------------------------------------------------------------ */

const V4_OCTET_RE = /^(0|[1-9]\d{0,2})$/; // no leading zeros (avoid octal ambiguity)
const HEXTET_RE = /^[0-9a-fA-F]{1,4}$/;

/** Strict dotted-quad → uint32 (as a JS number) or null. */
function parseIPv4(s) {
  if (typeof s !== 'string' || s.length < 7 || s.length > 15) return null;
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!V4_OCTET_RE.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function formatIPv4(n) {
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

/**
 * Full IPv6 parser (RFC 4291 text forms incl. '::' compression and an embedded dotted IPv4 tail).
 * @returns {number[]|null} 8 hextets
 */
function parseIPv6(s) {
  if (typeof s !== 'string' || s.length < 2 || s.length > 45) return null;
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  let body = s;
  let groupsNeeded = 8;
  let v4tail = null;
  const lastColon = s.lastIndexOf(':');
  if (lastColon === -1) return null;
  if (s.indexOf('.', lastColon) !== -1) {
    v4tail = parseIPv4(s.slice(lastColon + 1));
    if (v4tail === null) return null;
    body = s.slice(0, lastColon + 1); // keep the colon(s) before the IPv4 part
    if (!body.endsWith('::')) body = body.slice(0, -1);
    groupsNeeded = 6;
  } else if (s.includes('.')) {
    return null;
  }
  const dbl = body.indexOf('::');
  if (dbl !== body.lastIndexOf('::')) return null; // more than one '::' (or ':::')
  let left;
  let right;
  if (dbl === -1) {
    left = body.split(':');
    right = [];
    if (left.length !== groupsNeeded) return null;
  } else {
    const l = body.slice(0, dbl);
    const r = body.slice(dbl + 2);
    left = l === '' ? [] : l.split(':');
    right = r === '' ? [] : r.split(':');
    if (left.length + right.length > groupsNeeded - 1) return null; // '::' stands for ≥ 1 group
  }
  for (const g of left) if (!HEXTET_RE.test(g)) return null;
  for (const g of right) if (!HEXTET_RE.test(g)) return null;
  const out = left.map((h) => parseInt(h, 16));
  for (let i = left.length + right.length; i < groupsNeeded; i++) out.push(0);
  for (const h of right) out.push(parseInt(h, 16));
  if (v4tail !== null) out.push((v4tail >>> 16) & 0xffff, v4tail & 0xffff);
  return out.length === 8 ? out : null;
}

/** RFC 5952 canonical text form (lower-case, longest zero run ≥ 2 compressed, first on tie). */
function formatIPv6(g) {
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > bestLen) { bestStart = i; bestLen = j - i; }
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (bestLen < 2) return hex.join(':');
  return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLen).join(':')}`;
}

/** Strip whitespace, brackets ("[v6]" or "[v6]:port") and zone ids ("%eth0"). */
function stripAddress(addr) {
  if (typeof addr !== 'string') return '';
  let s = addr.trim();
  if (s.length === 0 || s.length > 128) return '';
  if (s.startsWith('[')) {
    const end = s.indexOf(']');
    if (end === -1) return '';
    s = s.slice(1, end);
  }
  const pct = s.indexOf('%');
  if (pct !== -1) s = s.slice(0, pct);
  return s;
}

/** → {v:4, n} | {v:6, g} | null. IPv4-mapped IPv6 (::ffff:a.b.c.d, any notation) becomes v4. */
function parseIp(addr) {
  const s = stripAddress(addr);
  if (!s) return null;
  const n4 = parseIPv4(s);
  if (n4 !== null) return { v: 4, n: n4 };
  const g = parseIPv6(s);
  if (!g) return null;
  if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff) {
    return { v: 4, n: g[6] * 65536 + g[7] };
  }
  return { v: 6, g };
}

/**
 * Canonical form of an IP address: '::ffff:' mapping removed, zone id and brackets stripped,
 * IPv6 in RFC 5952 form (so it compares equal to Node's socket.remoteAddress and Tailscale's output).
 * Non-IP input is returned stripped + lower-cased (never throws); non-strings → ''.
 */
function normalizeIp(addr) {
  const p = parseIp(addr);
  if (p) return p.v === 4 ? formatIPv4(p.n) : formatIPv6(p.g);
  return stripAddress(addr).toLowerCase();
}

// Tailscale ranges derived from the shared protocol constants.
const TS_V4 = (() => {
  const [base, bits] = PROTOCOL.TS_IPV4_CIDR.split('/');
  const b = Number(bits);
  const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
  return { base: (parseIPv4(base) & mask) >>> 0, mask };
})();
const TS_V6_PREFIX = PROTOCOL.TS_IPV6_PREFIX.split(':').filter(Boolean).map((h) => parseInt(h, 16)); // [fd7a,115c,a1e0]

/** true iff addr is in 100.64.0.0/10 or fd7a:115c:a1e0::/48 (accepts ::ffff:-mapped v4, brackets, zone ids). */
function isTailscaleIp(addr) {
  const p = parseIp(addr);
  if (!p) return false;
  if (p.v === 4) return ((p.n & TS_V4.mask) >>> 0) === TS_V4.base;
  for (let i = 0; i < TS_V6_PREFIX.length; i++) if (p.g[i] !== TS_V6_PREFIX[i]) return false;
  return true;
}

function isIpLiteral(addr) {
  return parseIp(addr) !== null;
}

/* ------------------------------------------------------------------------------------------ */
/* JSON mapping helpers (pure)                                                                 */
/* ------------------------------------------------------------------------------------------ */

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Control chars, line/paragraph separators, bidi marks/overrides/isolates and BOM: hostnames and
// display names are chosen by other tailnet users and end up in prompts — strip anything that
// could spoof. Built from code point ranges so the source stays plain ASCII.
const UNSAFE_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0x200e, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]];
const hex4 = (n) => n.toString(16).padStart(4, '0');
const UNSAFE_CHARS_RE = new RegExp(`[${UNSAFE_RANGES.map(([a, b]) => `\\u${hex4(a)}-\\u${hex4(b)}`).join('')}]`, 'g');

function cleanStr(v, max = 255) {
  if (typeof v !== 'string') return '';
  return v.replace(UNSAFE_CHARS_RE, '').trim().slice(0, max);
}

/** MagicDNS name without trailing dot, lower-case. */
function cleanDns(v) {
  const s = cleanStr(v, 255).toLowerCase();
  return s.endsWith('.') ? s.slice(0, -1) : s;
}

function idStr(v) {
  if (typeof v === 'string') return cleanStr(v, 64);
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  return '';
}

function normalizeOs(os) {
  const s = typeof os === 'string' ? os.trim().toLowerCase() : '';
  if (s === 'windows') return 'windows';
  if (s === 'macos' || s === 'darwin') return 'macos';
  if (s === 'linux') return 'linux';
  if (s === 'ios' || s === 'ipados') return 'ios';
  if (s === 'android') return 'android';
  return 'other';
}

function cleanTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags.filter((t) => typeof t === 'string').map((t) => cleanStr(t, 128)).filter(Boolean).slice(0, 64);
}

function cleanIps(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    // whois Addresses carry a prefix length; only host routes (/32, /128) are the node's own address.
    let s = raw;
    const slash = s.indexOf('/');
    if (slash !== -1) {
      const bits = s.slice(slash + 1);
      s = s.slice(0, slash);
      const v6 = s.includes(':');
      if (bits !== (v6 ? '128' : '32')) continue;
    }
    const ip = normalizeIp(s);
    if (isTailscaleIp(ip) && !out.includes(ip)) out.push(ip);
  }
  return out;
}

/** Tailscale's zero time ("0001-01-01T00:00:00Z") means "never/now" → null. */
function cleanTime(v) {
  if (typeof v !== 'string' || v.startsWith('0001-')) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function lookupUser(users, userId) {
  if (!isObj(users) || userId === undefined || userId === null) return null;
  const direct = users[String(userId)];
  if (isObj(direct)) return direct;
  // Fallback for IDs beyond 2^53 (lossy JSON numbers): compare the parsed values.
  for (const u of Object.values(users)) if (isObj(u) && u.ID === userId) return u;
  return null;
}

function userFromProfile(profile, tags) {
  if (tags.length) return { login: TAGGED_LOGIN, displayName: TAGGED_DISPLAY };
  if (!isObj(profile)) return { login: '', displayName: '' };
  const login = cleanStr(profile.LoginName, 320);
  return { login, displayName: cleanStr(profile.DisplayName, 256) || login };
}

function shortNameOf(dnsName, hostname) {
  if (dnsName) return dnsName.split('.')[0];
  return hostname.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63);
}

/** Map one ipnstate.PeerStatus (Self or Peer entry) to the contract's Peer shape. */
function mapNode(n, users, isSelf) {
  if (!isObj(n)) return null;
  const stableId = idStr(n.ID); // status JSON: "ID" is the StableNodeID string, "NodeID" the numeric id
  const tags = cleanTags(n.Tags);
  const dnsName = cleanDns(n.DNSName);
  const hostname = cleanStr(n.HostName, 255) || (dnsName ? dnsName.split('.')[0] : '');
  const online = isSelf ? true : n.Online === true;
  return {
    id: idStr(n.NodeID) || stableId,
    stableId,
    hostname,
    dnsName,
    shortName: shortNameOf(dnsName, hostname),
    os: normalizeOs(n.OS),
    ips: cleanIps(n.TailscaleIPs),
    online,
    lastSeen: online ? null : cleanTime(n.LastSeen),
    user: userFromProfile(lookupUser(users, n.UserID), tags),
    tags,
    isSelf: !!isSelf,
    // Path to the peer: `direct` = WireGuard currently talks to it over a direct UDP endpoint
    // (CurAddr set); otherwise traffic goes through the DERP region in `relay` (if any).
    direct: isSelf ? true : typeof n.CurAddr === 'string' && n.CurAddr.trim() !== '',
    relay: !isSelf && typeof n.Relay === 'string' && RELAY_RE.test(n.Relay) ? n.Relay : '',
    // extras (not in the contract, harmless): devices of users we shared a node with, expired keys
    sharee: n.ShareeNode === true,
    expired: n.Expired === true,
  };
}

const STATE_MAP = {
  Running: ['running', ''],
  Stopped: ['stopped', 'Tailscale is turned off.'],
  NeedsLogin: ['needs-login', 'Tailscale needs you to log in.'],
  NeedsMachineAuth: ['needs-login', 'This device is waiting for approval by a tailnet admin.'],
  Starting: ['stopped', 'Tailscale is starting…'],
  NoState: ['stopped', 'Tailscale is starting…'],
};

function makeStatus(state, message, extra) {
  return { state, message: message || '', self: null, magicDnsSuffix: null, peers: [], version: null, health: [], ...extra };
}

/**
 * Pure mapping of `tailscale status --json` output to TsStatus. Never throws.
 * Peers are sorted online first, then by hostname (stable, case-insensitive).
 */
function parseStatus(json) {
  if (!isObj(json)) return makeStatus('error', 'Unexpected output from "tailscale status".');
  const backend = typeof json.BackendState === 'string' ? json.BackendState : '';
  const [state, message] = STATE_MAP[backend] || ['error', backend ? `Unknown Tailscale state "${cleanStr(backend, 40)}".` : 'Tailscale reported no state.'];
  const users = isObj(json.User) ? json.User : {};
  let suffix = cleanDns(json.MagicDNSSuffix);
  if (!suffix && isObj(json.CurrentTailnet)) suffix = cleanDns(json.CurrentTailnet.MagicDNSSuffix);
  const self = isObj(json.Self) ? mapNode(json.Self, users, true) : null;
  let peers = [];
  if (state === 'running' && isObj(json.Peer)) {
    for (const raw of Object.values(json.Peer)) {
      const p = mapNode(raw, users, false);
      if (p && p.stableId && p.ips.length) peers.push(p);
    }
    peers = peers
      .map((p, i) => ({ p, i }))
      .sort((a, b) => (Number(b.p.online) - Number(a.p.online))
        || a.p.hostname.localeCompare(b.p.hostname, 'en', { sensitivity: 'base' })
        || a.i - b.i)
      .map((x) => x.p);
  }
  let selfOut = null;
  if (self) {
    const { online, lastSeen, isSelf, sharee, expired, ...rest } = self; // eslint-disable-line no-unused-vars
    selfOut = rest; // {id, stableId, hostname, dnsName, shortName, os, ips, user, tags, direct:true, relay:''}
  }
  const health = Array.isArray(json.Health) ? json.Health.map((h) => cleanStr(h, 300)).filter(Boolean).slice(0, 10) : [];
  return {
    state,
    message,
    self: selfOut,
    magicDnsSuffix: suffix || null,
    peers,
    version: cleanStr(json.Version, 64) || null,
    health,
  };
}

/**
 * Pure mapping of `tailscale whois --json <ip>` output → { node:{id,stableId,name,hostname,os,ips,tags},
 * user:{id,login,displayName}, isSelf:false } | null. isSelf is decided by the instance (needs status).
 */
function parseWhois(json) {
  if (!isObj(json) || !isObj(json.Node)) return null;
  const n = json.Node;
  const stableId = idStr(n.StableID);
  if (!stableId) return null;
  const tags = cleanTags(n.Tags);
  const hi = isObj(n.Hostinfo) ? n.Hostinfo : {};
  // `name` is ONLY the control-plane MagicDNS name (unique, verified). ComputedName is not used
  // for it: without a MagicDNS name it falls back to Hostinfo.Hostname, which the peer chooses.
  const name = cleanDns(n.Name);
  const hostname = cleanStr(hi.Hostname, 255) || cleanStr(n.ComputedName, 255) || name.split('.')[0] || '';
  const ips = cleanIps(n.Addresses);
  const up = isObj(json.UserProfile) ? json.UserProfile : null;
  const user = { id: up ? idStr(up.ID) : '', ...userFromProfile(up, tags) };
  return {
    node: { id: idStr(n.ID) || stableId, stableId, name, hostname, os: normalizeOs(hi.OS), ips, tags },
    user,
    isSelf: false,
  };
}

function stripBom(s) {
  return typeof s === 'string' && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function firstLine(s, max = 300) {
  return cleanStr(String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '', max);
}

function tsError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ------------------------------------------------------------------------------------------ */
/* CLI discovery + execution                                                                   */
/* ------------------------------------------------------------------------------------------ */

async function isExecutableFile(p) {
  try {
    const st = await fs.promises.stat(p);
    if (!st.isFile()) return false;
    if (process.platform !== 'win32') await fs.promises.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Candidate CLI paths in priority order (exported for tests). */
function cliCandidates(platform = process.platform, env = process.env) {
  const out = [];
  const P = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    // ProgramW6432 points at the 64-bit Program Files even from a 32-bit process.
    for (const base of [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)'], 'C:\\Program Files']) {
      if (base) out.push(P.join(base, 'Tailscale', 'tailscale.exe'));
    }
  } else if (platform === 'darwin') {
    // The GUI app's binary doubles as the CLI (standalone + App Store builds); it comes first
    // because /usr/local/bin/tailscale is often only the Standalone app's "Install CLI" shell
    // wrapper around it. GUI apps launched from Finder/Dock get a minimal PATH
    // (/usr/bin:/bin:/usr/sbin:/sbin), so Homebrew locations must be probed explicitly.
    out.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
    if (env.HOME) out.push(P.join(env.HOME, 'Applications', 'Tailscale.app', 'Contents', 'MacOS', 'Tailscale'));
    out.push('/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale');
  } else {
    out.push('/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale');
  }
  const exe = platform === 'win32' ? 'tailscale.exe' : 'tailscale';
  const sep = platform === 'win32' ? ';' : ':';
  for (let dir of String(env.PATH || env.Path || '').split(sep)) {
    dir = dir.trim().replace(/^"(.*)"$/, '$1');
    // Only absolute PATH entries: a relative entry (".") would let the CWD hijack the CLI.
    if (dir && P.isAbsolute(dir)) out.push(P.join(dir, exe));
  }
  return [...new Set(out)];
}

// The macOS app executable, reached through a symlink, aborts ("The current bundleIdentifier is
// unknown to the registry"), so a symlinked candidate is replaced by the file it points to.
const MAC_APP_BINARY_RE = /\/Tailscale\.app\/Contents\/MacOS\/Tailscale$/;

async function defaultLocate() {
  for (const c of cliCandidates()) {
    if (!(await isExecutableFile(c))) continue;
    if (process.platform === 'darwin') {
      try {
        const real = await fs.promises.realpath(c);
        if (MAC_APP_BINARY_RE.test(real)) return real;
      } catch { /* use c */ }
    }
    return c;
  }
  return null;
}

/**
 * Environment for the CLI child process, or undefined to inherit Tunnelview's own.
 * macOS: the Tailscale app executable is also the CLI and picks its role from the environment:
 * TAILSCALE_BE_CLI=1 forces the CLI (Tailscale KB 1080 "CLI on macOS"); otherwise it looks for
 * shell variables such as SHLVL and TERM. Tunnelview started from Finder/Dock/login has none of them,
 * so without this the binary starts as the menu-bar app, prints "The Tailscale GUI failed to
 * start…" (or nothing) and exits 0, or hangs. SHLVL/TERM are a backup should a future build stop
 * honouring TAILSCALE_BE_CLI. The open-source CLI ignores all three.
 */
function cliEnv(platform = process.platform, env = process.env) {
  if (platform !== 'darwin') return undefined;
  return { ...env, TAILSCALE_BE_CLI: '1', SHLVL: env.SHLVL || '1', TERM: env.TERM || 'dumb' };
}

/**
 * POSIX runner (macOS): like execFile, but the child gets its own process group and a timeout
 * SIGKILLs the whole group, so a binary started by a wrapper script (/usr/local/bin/tailscale) cannot
 * outlive it and turn into a running menu-bar app. Resolves {error, stdout, stderr} with
 * execFile-compatible errors: .code = exit code / spawn errno / 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
 * .killed = true on timeout, .signal. Never rejects.
 */
function spawnRunner(cliPath, args, { env, timeoutMs = CLI_TIMEOUT_MS, maxBuffer = CLI_MAX_BUFFER, group = true } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cliPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: group, windowsHide: true });
    } catch (error) {
      resolve({ error, stdout: '', stderr: '' });
      return;
    }
    const out = [];
    const errOut = [];
    let outSize = 0;
    let errSize = 0;
    let settled = false;
    let timedOut = false;
    let tooBig = false;
    let hardTimer = null;
    const finish = (spawnError, code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(errOut).toString('utf8');
      let error = null;
      if (spawnError) error = spawnError;
      else if (tooBig) error = Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, signal: null });
      else if (timedOut) error = Object.assign(new Error(`Command timed out after ${timeoutMs} ms`), { code: null, killed: true, signal: 'SIGKILL' });
      else if (code !== 0 || signal) error = Object.assign(new Error(`Command failed: ${cliPath} ${args.join(' ')}`), { code, killed: false, signal: signal || null });
      resolve({ error, stdout, stderr });
    };
    const killAll = () => {
      if (!child.pid) return;
      try {
        if (group && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
      // 'close' waits for the pipes; a grandchild holding them open must not stall the caller.
      if (!hardTimer) hardTimer = setTimeout(() => finish(null, null, 'SIGKILL'), 1000);
    };
    const timer = setTimeout(() => { timedOut = true; killAll(); }, timeoutMs);
    child.stdout.on('data', (d) => {
      outSize += d.length;
      if (outSize > maxBuffer) { tooBig = true; killAll(); return; }
      out.push(d);
    });
    child.stderr.on('data', (d) => {
      errSize += d.length;
      if (errSize <= 64 * 1024) errOut.push(d);
    });
    child.on('error', (e) => finish(e));
    child.on('close', (code, signal) => finish(null, code, signal));
  });
}

/**
 * The CLI runner the app uses. macOS: spawnRunner with cliEnv (CLI mode forced, process-group kill).
 * Elsewhere: execFile, inheriting Tunnelview's environment. `platform` / `timeoutMs` are for tests.
 */
function defaultRunner(cliPath, args, { platform = process.platform, timeoutMs = CLI_TIMEOUT_MS } = {}) {
  if (platform === 'darwin') return spawnRunner(cliPath, args, { env: cliEnv('darwin'), timeoutMs });
  return new Promise((resolve) => {
    try {
      execFile(cliPath, args, {
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: CLI_MAX_BUFFER,
        encoding: 'utf8',
        env: cliEnv(platform),
      }, (error, stdout, stderr) => resolve({ error: error || null, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    } catch (error) {
      resolve({ error, stdout: '', stderr: '' });
    }
  });
}

const DAEMON_DOWN_RE = /failed to connect|is tailscale running|not running|connection refused|no such file|cannot find|pipe|dial|socket|unavailable/i;
// What the macOS app executable prints when it starts as the menu-bar app instead of the CLI.
const APP_MODE_RE = /Tailscale GUI failed to start|CLIError/i;
const TIMEOUT_MSG = 'Tailscale did not respond in time.';
const NOT_CONNECTED_MSG = 'Tailscale isn’t connected on this Mac.';

function quoted(s, max = 140) {
  return `“${clip(firstLine(s, 300), max)}”`;
}

/** Interpret a failed / successful `status --json` run. */
function statusFromRun(r) {
  const out = stripBom(r.stdout || '').trim();
  if (out.startsWith('{')) {
    try {
      return parseStatus(JSON.parse(out));
    } catch {
      /* fall through */
    }
  }
  const err = r.error;
  if (err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return makeStatus('error', 'Tailscale’s status is too large to read.');
  if (err && (err.killed || /timed? ?out/i.test(String(err.message)))) return makeStatus('error', TIMEOUT_MSG);
  if (err && err.signal) {
    // Killed by a signal we did not send: a crash (e.g. SIGTRAP from a Swift fatal error), not a timeout.
    const why = firstLine(r.stderr) || firstLine(out);
    return makeStatus('error', `Tailscale’s command-line tool stopped unexpectedly (${cleanStr(String(err.signal), 16)})${why ? `: ${quoted(why)}` : '.'}`);
  }
  const msg = firstLine(r.stderr) || firstLine(out) || (err ? firstLine(err.message) : '');
  if (err) {
    if (DAEMON_DOWN_RE.test(msg)) return makeStatus('stopped', 'The Tailscale service is not running.', { detail: msg });
    return makeStatus('error', msg || 'The Tailscale CLI failed.');
  }
  // Exit 0 without a status.
  if (APP_MODE_RE.test(out)) {
    return makeStatus('error', `Tailscale’s command-line tool started as the Tailscale app instead of answering: ${quoted(out)}. Update Tailscale, then click Check again.`);
  }
  if (!out) return makeStatus('error', 'Tailscale’s command-line tool exited without printing a status. Update Tailscale, then click Check again.');
  return makeStatus('error', `Tailscale answered with something Tunnelview doesn’t understand: ${quoted(out)}`);
}

/* ------------------------------------------------------------------------------------------ */
/* Tailscale class                                                                             */
/* ------------------------------------------------------------------------------------------ */

class Tailscale extends EventEmitter {
  /**
   * @param {object} [opts] dependency injection (tests / embedding):
   *   locate: async () => string|null       CLI discovery (default: platform candidates)
   *   run: async (cliPath, args) => {error, stdout, stderr}   (default: execFile, 5 s timeout)
   *   tunnelGate: boolean                   run the CLI only while this machine has a Tailscale address
   *                                       (default false; the exported singleton turns it on for macOS)
   *   interfaces: () => os.networkInterfaces()-shaped object   (default: os.networkInterfaces)
   *   log: (msg) => void                    diagnostics (default: none)
   */
  constructor(opts = {}) {
    super();
    this.cliPath = null;
    this.last = null;
    this._locate = typeof opts.locate === 'function' ? opts.locate : defaultLocate;
    this._run = typeof opts.run === 'function' ? opts.run : defaultRunner;
    this._tunnelGate = opts.tunnelGate === true;
    this._interfaces = typeof opts.interfaces === 'function' ? opts.interfaces : () => os.networkInterfaces();
    this._log = typeof opts.log === 'function' ? opts.log : null;
    this._gateClosed = false; // last decision of the tunnel gate (logged on change)
    this._knownSelfIps = []; // this node's addresses from the last status that had them
    this._initPromise = null;
    this._statusInflight = null;
    this._whoisCache = new Map(); // ip → {at, value}
    this._whoisInflight = new Map(); // ip → Promise
    this._timer = null;
    this._polling = false;
    this._lastKey = null;
  }

  // Pure helpers exposed on the instance per contract.
  isTailscaleIp(addr) { return isTailscaleIp(addr); }
  normalizeIp(addr) { return normalizeIp(addr); }

  /** Locate the CLI. Never throws. @returns {Promise<string|null>} */
  init() {
    if (!this._initPromise) {
      this._initPromise = (async () => {
        try {
          const p = await this._locate();
          this.cliPath = typeof p === 'string' && p ? p : null;
        } catch {
          this.cliPath = null;
        }
        return this.cliPath;
      })().finally(() => { this._initPromise = null; });
    }
    return this._initPromise;
  }

  async _exec(args) {
    if (!this.cliPath) await this.init();
    if (!this.cliPath) return null;
    let r;
    try {
      r = await this._run(this.cliPath, args);
    } catch (error) {
      r = { error, stdout: '', stderr: '' };
    }
    if (!r || typeof r !== 'object') r = { error: new Error('no result'), stdout: '', stderr: '' };
    if (r.error && r.error.code === 'ENOENT') {
      // CLI was uninstalled/moved since discovery → rediscover next time.
      this.cliPath = null;
      return null;
    }
    return r;
  }

  /** `tailscale status --json` → TsStatus. Concurrent calls share one CLI run. Never throws. */
  status() {
    if (!this._statusInflight) {
      this._statusInflight = this._fetchStatus().finally(() => { this._statusInflight = null; });
    }
    return this._statusInflight;
  }

  async _fetchStatus() {
    let st;
    try {
      st = await this._readStatus();
    } catch (e) {
      st = makeStatus('error', firstLine(e && e.message) || 'Tailscale status failed.');
    }
    if (st.self && Array.isArray(st.self.ips) && st.self.ips.length) this._knownSelfIps = st.self.ips.slice();
    this.last = st;
    return st;
  }

  async _readStatus() {
    if (!this._cliAllowed()) {
      if (!this.cliPath) await this.init();
      return this.cliPath
        ? makeStatus('stopped', NOT_CONNECTED_MSG)
        : makeStatus('not-installed', 'Tailscale is not installed on this device.');
    }
    const r = await this._exec(['status', '--json']);
    if (!r) return makeStatus('not-installed', 'Tailscale is not installed on this device.');
    return statusFromRun(r);
  }

  /**
   * macOS tunnel gate. Running the Tailscale app executable as the CLI while Tailscale is quit or
   * still connecting can bring its network extension up and switch Tailscale off again
   * (tailscale/tailscale#21825: "Using cli commands during startup prevents automatic connection").
   * So with the gate on, the CLI only runs while this machine already carries a Tailscale address.
   * Without one, nothing on the tailnet can reach Tunnelview and Tunnelview cannot reach the tailnet
   * either, so "not connected" is the honest answer. Never throws.
   */
  _cliAllowed() {
    if (!this._tunnelGate) return true;
    let up = false;
    try { up = this._hasTailscaleAddress(); } catch { up = false; }
    if (this._log && this._gateClosed === up) {
      this._log(up ? '[tailscale] Tailscale address present: reading status from the Tailscale CLI'
        : '[tailscale] no Tailscale address on this Mac: not starting the Tailscale CLI');
    }
    this._gateClosed = !up;
    return up;
  }

  /**
   * Does a local interface carry an address that is Tailscale's? fd7a:115c:a1e0::/48 is
   * Tailscale's own prefix (every node gets one). 100.64.0.0/10 is shared CGNAT space that other
   * VPNs (Cloudflare WARP, NetBird, …) also use, so an IPv4 address only counts when it is one of
   * this node's addresses from the last Tailscale status.
   */
  _hasTailscaleAddress() {
    const known = this._knownSelfIps;
    for (const list of Object.values(this._interfaces() || {})) {
      for (const a of Array.isArray(list) ? list : []) {
        const ip = normalizeIp(a && a.address);
        if (!isTailscaleIp(ip)) continue;
        if (ip.includes(':') || known.includes(ip)) return true;
      }
    }
    return false;
  }

  /**
   * Identity of a tailnet IP via `tailscale whois --json`. Cached 60 s (failures 5 s).
   * Returns null when the IP is not a Tailscale IP, unknown, or not one of the node's OWN addresses
   * (e.g. an address merely routed through a subnet router).
   */
  async whois(ip) {
    const n = normalizeIp(ip);
    if (!isTailscaleIp(n)) return null;
    const now = Date.now();
    const hit = this._whoisCache.get(n);
    if (hit && now - hit.at < (hit.value ? WHOIS_TTL_MS : WHOIS_NEGATIVE_TTL_MS)) return clone(hit.value);
    let p = this._whoisInflight.get(n);
    if (!p) {
      p = this._fetchWhois(n).catch(() => null).then((value) => {
        this._whoisInflight.delete(n);
        this._whoisCache.delete(n);
        this._whoisCache.set(n, { at: Date.now(), value });
        while (this._whoisCache.size > WHOIS_CACHE_MAX) this._whoisCache.delete(this._whoisCache.keys().next().value);
        return value;
      });
      this._whoisInflight.set(n, p);
    }
    return clone(await p);
  }

  /** Raw `tailscale whois --json` output or null. */
  async _whoisJson(ip) {
    if (!this._cliAllowed()) return null;
    const r = await this._exec(['whois', '--json', ip]);
    if (!r || r.error) return null; // e.g. "peer not found" (exit 1)
    try {
      return JSON.parse(stripBom(r.stdout));
    } catch {
      return null;
    }
  }

  async _fetchWhois(ip) {
    if (!this.last) await this.status();
    const json = await this._whoisJson(ip);
    const w = parseWhois(json);
    if (!w || !w.node.ips.includes(ip)) return null;
    const st = this.last;
    const self = st && st.self;
    w.isSelf = !!(self && ((self.stableId && self.stableId === w.node.stableId) || (self.ips || []).includes(ip)));
    if (w.isSelf && self) {
      // whois of self carries no Hostinfo.OS → fill from status.
      if (w.node.os === 'other') w.node.os = self.os;
      if (!w.node.hostname) w.node.hostname = self.hostname;
    } else if (w.node.os === 'other' && st && Array.isArray(st.peers)) {
      const peer = st.peers.find((p) => p.stableId === w.node.stableId);
      if (peer) w.node.os = peer.os;
    }
    return w;
  }

  /**
   * Resolve user input to a tailnet peer. Accepts: IPv4, "ip:port", "[v6]:port", bare IPv6, hostname,
   * MagicDNS short name, FQDN (with/without trailing dot) or a node stableId. Resolution uses ONLY the
   * peer list from `tailscale status` (+ self) — never system DNS.
   * Names resolve through strict tiers (first tier with a match wins; see below) and are never
   * auto-picked among several candidates.
   * @returns {Promise<{ip:string, port:number, portExplicit:boolean, peer:object}>} `port` is
   *   PROTOCOL.DEFAULT_PORT unless the input carried one (`portExplicit` true).
   * @throws Error with .code 'NOT_TAILNET' | 'NOT_FOUND' | 'TS_DOWN' | 'AMBIGUOUS' (user-facing .message)
   */
  async resolveTarget(str) {
    if (typeof str !== 'string' || !str.trim() || str.length > 300) throw tsError('NOT_FOUND', 'Enter a device name or Tailscale IP.');
    const { host, port, portExplicit } = parseTargetString(str.trim());
    const st = await this.status();
    if (!st || st.state !== 'running') {
      const why = st && st.message ? st.message : 'Tailscale is not running.';
      throw tsError('TS_DOWN', st && st.state === 'not-installed' ? 'Tailscale is not installed on this device.' : why);
    }
    const all = [...(st.self ? [selfAsPeer(st.self)] : []), ...st.peers];

    if (isIpLiteral(host)) {
      const ip = normalizeIp(host);
      if (!isTailscaleIp(ip)) throw tsError('NOT_TAILNET', `${ip} is not a Tailscale address.`);
      const peer = all.find((p) => p.ips.includes(ip));
      if (!peer) throw tsError('NOT_TAILNET', `${ip} is not a device in your tailnet.`);
      return { ip, port, portExplicit, peer: clone(peer) };
    }

    // Names are only ever compared against the peer list, so any printable text is safe here
    // (device hostnames from iOS/Android may contain spaces or apostrophes).
    const name = host.toLowerCase().replace(/\.$/, '');
    if (!name || name !== cleanStr(name, 255).toLowerCase()) throw tsError('NOT_FOUND', 'That is not a valid device name.');
    // Strict tiers, most trustworthy first; the first tier that matches anything decides:
    //   1. exact stableId; 2. exact MagicDNS FQDN; 3. exact MagicDNS short label (first label of
    //   dnsName) — 1–3 are assigned by the control plane and unique; 4. the OS hostname, which every
    //   node reports about ITSELF, so any tailnet member can claim "office-pc". A self-reported
    //   hostname is only used when no MagicDNS label matches and exactly one node claims it.
    // Several matches in a tier → AMBIGUOUS: never auto-pick by online state, OS or list order (the
    // order follows node keys, which an attacker can grind).
    const tiers = [
      (p) => p.stableId === host,
      (p) => !!p.dnsName && p.dnsName === name,
      (p) => !!p.dnsName && p.dnsName.split('.')[0] === name,
      (p) => !!p.hostname && p.hostname.toLowerCase() === name,
    ];
    for (const match of tiers) {
      const found = all.filter(match);
      if (found.length === 1) {
        const peer = found[0];
        return { ip: preferIPv4(peer.ips), port, portExplicit, peer: clone(peer) };
      }
      if (found.length > 1) throw ambiguousError(host, found);
    }
    throw tsError('NOT_FOUND', `No device named "${cleanStr(host, 80)}" in your tailnet.`);
  }

  /** Poll status every `ms`; emits 'status' on each poll and 'change' when state/self identity/IPs change. */
  startWatching(ms = 10000) {
    this.stopWatching();
    const interval = Math.max(MIN_WATCH_MS, Number.isFinite(Number(ms)) ? Number(ms) : 10000);
    const tick = async () => {
      if (this._polling) return;
      this._polling = true;
      let st;
      try {
        st = await this.status();
      } finally {
        this._polling = false;
      }
      if (!this._timer) return; // stopped meanwhile
      this._safeEmit('status', st);
      const key = changeKey(st);
      if (key !== this._lastKey) {
        this._lastKey = key;
        this._whoisCache.clear(); // identity/tailnet may have changed (account switch)
        this._safeEmit('change', st);
      }
    };
    this._timer = setInterval(tick, interval);
    if (typeof this._timer.unref === 'function') this._timer.unref();
    tick();
  }

  stopWatching() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  _safeEmit(event, payload) {
    try {
      this.emit(event, payload);
    } catch (e) {
      console.error(`[tailscale] '${event}' listener failed:`, e);
    }
  }
}

function clone(v) {
  return v == null ? v : structuredClone(v);
}


function changeKey(st) {
  if (!st) return '';
  const self = st.self;
  return [st.state, self ? self.stableId : '', self ? [...self.ips].sort().join(',') : '', self && self.user ? self.user.login : ''].join('|');
}

function selfAsPeer(self) {
  return { ...self, online: true, lastSeen: null, tags: self.tags || [], isSelf: true, sharee: false, expired: false };
}

function preferIPv4(ips) {
  return ips.find((ip) => !ip.includes(':')) || ips[0];
}

function clip(s, max) {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Error for a name several nodes match. The guidance comes first and the whole message stays
 * ≤ 220 chars (what the UI shows): 'Several devices are called "x". Type the full MagicDNS name or
 * Tailscale IP instead: a.ts.net (login), b.ts.net (login), c.ts.net (login) and N more.'
 */
function ambiguousError(host, list) {
  const label = (p) => {
    const id = p.dnsName || preferIPv4(p.ips) || p.hostname || '?';
    const full = `${id} (${(p.user && p.user.login) || 'unknown owner'})`;
    return full.length <= AMBIGUOUS_ITEM_MAX ? full : clip(id, AMBIGUOUS_ITEM_MAX); // the name is what to type
  };
  const head = `Several devices are called "${clip(cleanStr(host, 255), 48)}". Type the full MagicDNS name or Tailscale IP instead`;
  for (let n = Math.min(AMBIGUOUS_LIST_MAX, list.length); n > 0; n--) {
    const more = list.length - n;
    const msg = `${head}: ${list.slice(0, n).map(label).join(', ')}${more ? ` and ${more} more` : ''}.`;
    if (msg.length <= AMBIGUOUS_MSG_MAX) return tsError('AMBIGUOUS', msg);
  }
  return tsError('AMBIGUOUS', `${head}.`);
}

/**
 * "host", "host:port", "1.2.3.4:port", "[v6]", "[v6]:port", bare "v6" → {host, port, portExplicit}.
 * `port` is PROTOCOL.DEFAULT_PORT when the string carries none (`portExplicit` false).
 */
function parseTargetString(s) {
  let host = s;
  let portStr = null;
  if (s.startsWith('[')) {
    const m = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(s);
    if (!m) throw tsError('NOT_FOUND', 'Invalid address.');
    host = m[1];
    portStr = m[2] || null;
  } else {
    const colons = (s.match(/:/g) || []).length;
    if (colons === 1) {
      const i = s.indexOf(':');
      host = s.slice(0, i);
      portStr = s.slice(i + 1);
      if (!/^\d{1,5}$/.test(portStr)) throw tsError('NOT_FOUND', 'Invalid port.');
    }
    // ≥ 2 colons without brackets → bare IPv6 literal (no port)
  }
  let port = PROTOCOL.DEFAULT_PORT;
  if (portStr !== null) {
    port = Number(portStr);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw tsError('NOT_FOUND', 'Invalid port.');
  }
  host = host.trim();
  if (!host) throw tsError('NOT_FOUND', 'Enter a device name or Tailscale IP.');
  return { host, port, portExplicit: portStr !== null };
}

// The app's instance. On macOS the CLI is the Tailscale app executable: tunnel gate on (_cliAllowed).
const instance = new Tailscale(process.platform === 'darwin'
  ? { tunnelGate: true, log: (msg) => console.log(msg) }
  : {});

module.exports = instance;
module.exports.Tailscale = Tailscale;
module.exports.parseStatus = parseStatus;
module.exports.parseWhois = parseWhois;
module.exports.isTailscaleIp = isTailscaleIp;
module.exports.normalizeIp = normalizeIp;
module.exports.isIpLiteral = isIpLiteral;
module.exports.normalizeOs = normalizeOs;
module.exports.cliCandidates = cliCandidates;
module.exports.cliEnv = cliEnv;
module.exports.spawnRunner = spawnRunner;
module.exports.defaultRunner = defaultRunner;
module.exports.statusFromRun = statusFromRun;
module.exports.parseTargetString = parseTargetString;
module.exports.OS_VALUES = OS_VALUES;
