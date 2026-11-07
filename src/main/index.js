'use strict';
/*
 * Tunnelview main process entry — app lifecycle, single instance, command-line switches, security
 * hardening, AppState, and the wiring between the host server (incoming sessions), the prompt /
 * panel windows, the viewer windows (ipc.js) and the tray. Contract: docs/ARCHITECTURE.md.
 *
 * Flags: --dev (unpackaged runs only: DevTools detached for every window), --hidden (start in the
 * tray; used by the Windows login item). Env: TUNNELVIEW_MAC_LOOPBACK=1 (experimental macOS
 * system-audio loopback).
 *
 * Packaged builds refuse to start with remote-debugging / inspector switches: Tunnelview holds the
 * Screen Recording + Accessibility grants and unattended-access settings, and a debugger attached
 * by a local process could drive all of it.
 *
 * Exports (pure helpers, for tests): firewallVerdict(raw, port), FIREWALL_SCRIPT.
 */
const { app, Menu, Notification, session, nativeTheme, webContents, powerMonitor, powerSaveBlocker, dialog, shell, systemPreferences } = require('electron');
const path = require('path');
const { execFile } = require('child_process');
const PROTOCOL = require('../shared/protocol');
const capture = require('./capture');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
const DEV = !app.isPackaged && process.argv.includes('--dev');
const OS_NAME = IS_MAC ? 'macos' : IS_WIN ? 'windows' : 'linux';

/* ================================================================== Windows Firewall verdict */

/*
 * Windows Firewall query (main → checkFirewall). Locale-independent: enum values are compared /
 * cast, never display text. The program path and our own Tailscale IP travel in environment
 * variables, never in the script. Output (one JSON object):
 *   { category: 'Domain'|'Private'|'Public'|null,   // network profile of the Tailscale adapter
 *     profileEnabled: 'True'|'False'|…|null, allowInbound: 'True'|'False'|'NotConfigured'|null,
 *     rules: [{ name, profile:int (0 = Any, 1 Domain | 2 Private | 4 Public), remote:[…],
 *               protocol:'Any'|'TCP'|…, localPort:[…] }] }   // enabled inbound Block rules for us
 * firewallVerdict() decides which of them actually stop a tailnet peer.
 */
const FIREWALL_SCRIPT = [
  '$ErrorActionPreference = "SilentlyContinue"',
  '$cat = $null; $fpEnabled = $null; $allowIn = $null',
  'if ($env:TUNNELVIEW_TS_IP) { $addr = Get-NetIPAddress -IPAddress $env:TUNNELVIEW_TS_IP | Select-Object -First 1; if ($addr) { $cp = Get-NetConnectionProfile -InterfaceIndex $addr.InterfaceIndex | Select-Object -First 1; if ($cp) { $cat = [string]$cp.NetworkCategory; if ($cat -eq "DomainAuthenticated") { $cat = "Domain" }; $fp = Get-NetFirewallProfile -PolicyStore ActiveStore -Name $cat; if ($fp) { $fpEnabled = [string]$fp.Enabled; $allowIn = [string]$fp.AllowInboundRules } } } }',
  '$rules = @(Get-NetFirewallApplicationFilter -PolicyStore ActiveStore -Program $env:TUNNELVIEW_FW_PROGRAM | Get-NetFirewallRule | Where-Object { $_.Enabled -eq "True" -and $_.Direction -eq "Inbound" -and $_.Action -eq "Block" } | ForEach-Object { $r = $_; $af = $r | Get-NetFirewallAddressFilter; $pf = $r | Get-NetFirewallPortFilter; [pscustomobject]@{ name = [string]$r.DisplayName; profile = [int]$r.Profile; remote = @($af.RemoteAddress | ForEach-Object { [string]$_ }); protocol = [string]$pf.Protocol; localPort = @($pf.LocalPort | ForEach-Object { [string]$_ }) } })',
  'ConvertTo-Json -Compress -Depth 4 -InputObject ([pscustomobject]@{ category = $cat; profileEnabled = $fpEnabled; allowInbound = $allowIn; rules = $rules })',
].join('; ');

const FW_PROFILE_BITS = { Domain: 1, Private: 2, Public: 4 };
const TS_V4 = [0x64400000, 0x647fffff];                             // 100.64.0.0/10
const TS_V6 = [0xfd7a115ca1e0n << 80n, ((0xfd7a115ca1e0n + 1n) << 80n) - 1n]; // fd7a:115c:a1e0::/48

function v4ToInt(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some((x) => x > 255) ? null : ((p[0] * 256 + p[1]) * 256 + p[2]) * 256 + p[3];
}

function v6ToBig(s) {
  let str = String(s).toLowerCase().replace(/%.*$/, '');
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(str); // ::ffff:1.2.3.4
  if (v4) {
    const n = v4ToInt(v4[1]);
    if (n === null) return null;
    str = `${str.slice(0, -v4[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const halves = str.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return null;
  const groups = [...head, ...Array(fill).fill('0'), ...tail];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g, 16)), 0n);
}

/** [lo, hi] of one RemoteAddress entry (address, a.b.c.d/len, a.b.c.d/mask, lo-hi), or null. */
function addressRange(entry) {
  const s = String(entry).trim();
  const isV6 = s.includes(':');
  const toNum = isV6 ? v6ToBig : v4ToInt;
  const bits = isV6 ? 128 : 32;
  const dash = s.indexOf('-');
  if (dash > 0) {
    const lo = toNum(s.slice(0, dash));
    const hi = toNum(s.slice(dash + 1));
    return lo === null || hi === null ? null : { v6: isV6, lo, hi };
  }
  const [addr, mask] = s.split('/');
  const base = toNum(addr);
  if (base === null) return null;
  if (mask === undefined) return { v6: isV6, lo: base, hi: base };
  let len = /^\d{1,3}$/.test(mask) ? Number(mask) : null;
  if (len === null && !isV6) {
    const m = v4ToInt(mask); // dotted mask, as the firewall prints 100.64.0.0/255.192.0.0
    if (m === null) return null;
    len = 32 - Math.log2(2 ** 32 - m);
    if (!Number.isInteger(len)) return null;
  }
  if (len === null || len > bits) return null;
  if (isV6) {
    const host = (1n << BigInt(128 - len)) - 1n;
    return { v6: true, lo: base & ~host, hi: (base & ~host) | host };
  }
  const size = 2 ** (32 - len);
  const lo = Math.floor(base / size) * size;
  return { v6: false, lo, hi: lo + size - 1 };
}

/** Can a rule with these RemoteAddress entries match a tailnet peer? */
function remoteCoversTailnet(remote) {
  const list = Array.isArray(remote) && remote.length ? remote : ['Any'];
  return list.some((e) => {
    if (/^\s*any\s*$/i.test(String(e))) return true;
    const r = addressRange(e);
    if (!r) return false; // keywords (LocalSubnet, DNS, …): never the Tailscale /32 + /128 adapter's peers
    const [lo, hi] = r.v6 ? TS_V6 : TS_V4;
    return r.lo <= hi && r.hi >= lo;
  });
}

/** Does a rule's port filter cover inbound TCP `port`? */
function portCovers(protocol, localPort, port) {
  const proto = String(protocol || 'Any').trim().toLowerCase();
  if (proto !== 'any' && proto !== 'tcp' && proto !== '6') return false;
  const list = Array.isArray(localPort) && localPort.length ? localPort : ['Any'];
  return list.some((p) => {
    const s = String(p).trim();
    if (/^any$/i.test(s)) return true;
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(s);
    return !!m && port >= Number(m[1]) && port <= Number(m[2] || m[1]);
  });
}

/**
 * Which enabled inbound Block rules for Tunnelview stop a tailnet peer from reaching the signaling
 * port, and whether the Tailscale adapter's profile blocks every inbound connection.
 * A rule counts when its profile is Any or includes the Tailscale adapter's category (unknown
 * category: every profile), its RemoteAddress is Any or overlaps 100.64.0.0/10 /
 * fd7a:115c:a1e0::/48, and its port filter is Any or covers `port` over TCP.
 * @returns {{blocked:string[], blockAll:boolean} | null} null = unusable query output
 */
function firewallVerdict(raw, port) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const bit = FW_PROFILE_BITS[raw.category] || 0;
  // That profile's firewall is off: nothing on it blocks.
  if (bit && raw.profileEnabled === 'False') return { blocked: [], blockAll: false };
  let rules = raw.rules;
  if (rules && !Array.isArray(rules)) rules = [rules]; // PowerShell unwraps one-element arrays
  const blocked = [];
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string') continue;
    const profile = Number.isInteger(r.profile) ? r.profile : 0;
    if (bit && profile !== 0 && (profile & bit) === 0) continue;
    if (!remoteCoversTailnet(r.remote)) continue;
    if (!portCovers(r.protocol, r.localPort, port)) continue;
    if (!blocked.includes(r.name)) blocked.push(r.name);
  }
  return { blocked: blocked.slice(0, 20), blockAll: !!bit && raw.allowInbound === 'False' };
}

module.exports = { firewallVerdict, FIREWALL_SCRIPT };

/* ================================================================== before ready */

const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port'];

/** Debugging switches on the command line of a PACKAGED build (unpackaged dev / e2e runs may use them). */
function debuggingRequested() {
  if (!app.isPackaged) return [];
  const found = DEBUG_SWITCHES.filter((s) => { try { return app.commandLine.hasSwitch(s); } catch { return false; } });
  const args = [...process.argv.slice(1), ...(Array.isArray(process.execArgv) ? process.execArgv : [])];
  for (const a of args) {
    if (typeof a === 'string' && /^(--?|\/)(inspect|remote-debugging)/i.test(a)) found.push(a.split('=')[0]);
  }
  return found;
}

const refusedSwitches = debuggingRequested();
if (refusedSwitches.length) {
  console.error('[main] refusing to start: debugging switches are not allowed in packaged builds:', [...new Set(refusedSwitches)].join(', '));
  app.exit(1);
} else {
  // Real host candidates (no mDNS .local obfuscation) so ICE can be pinned to Tailscale IPs (§1.5).
  // Windows: Chromium's native occlusion tracking would treat the session panel as hidden when
  // covered/minimised and throttle it; the panel must keep capturing + encoding.
  const disabledFeatures = ['WebRtcHideLocalIpsWithMdns'];
  if (IS_WIN) disabledFeatures.push('CalculateNativeWinOcclusion');
  app.commandLine.appendSwitch('disable-features', disabledFeatures.join(','));
  // Windows: the viewer decodes remote video in software unless the user turned 'GPU video
  // decoding' on. Measured on an Intel Quick Sync machine: the GPU H.264 decoder kept failing
  // mid-stream (frames dropped until the next keyframe → 1–3 s freezes every few seconds, no packet
  // loss), while software decoding had none at the same CPU cost. The switch is process-wide and
  // must be set before 'ready', so the one flag is read straight from settings.json here.
  if (IS_WIN && !gpuVideoDecodeWanted()) app.commandLine.appendSwitch('disable-accelerated-video-decode');
  if (capture.MAC_LOOPBACK_OPT_IN) {
    // Experimental: Electron 45 documents 'loopback' audio as Windows-only. These Chromium features
    // route macOS 14.2+ system audio through ScreenCaptureKit; capture.audioSupported() is only true
    // on macOS when this opt-in is set.
    app.commandLine.appendSwitch('enable-features', 'MacLoopbackAudioForScreenShare,MacSckSystemAudioLoopbackOverride');
  }
  app.setAppUserModelId('io.github.naminaone99.tunnelview');
  app.enableSandbox();

  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    main();
  }
}

/** settings.json's gpuVideoDecode === true, read before app ready (any failure → false). */
function gpuVideoDecodeWanted() {
  try {
    const raw = require('fs').readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8');
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return !!parsed && parsed.gpuVideoDecode === true;
  } catch {
    return false;
  }
}

function safeRequire(name, fallback) {
  try {
    return require(name);
  } catch (err) {
    console.error(`[main] failed to load ${name}:`, err && err.message);
    return fallback;
  }
}

function main() {
  const settings = require('./settings');
  const windows = require('./windows');
  const ipc = require('./ipc');
  const tray = require('./tray');
  const icons = require('./icons');
  const clipboard = require('./clipboard');
  const files = require('./files');
  const permissions = require('./permissions');
  const tailscale = require('./tailscale');
  const auth = require('./auth');
  const hostServerMod = require('./host-server');
  const viewerClientMod = require('./viewer-client');
  const HostServer = typeof hostServerMod === 'function' ? hostServerMod : hostServerMod.HostServer;
  const ViewerSession = typeof viewerClientMod === 'function' ? viewerClientMod : viewerClientMod.ViewerSession;
  // Native input injection is optional at runtime (koffi / OS permission problems must not kill the app).
  const input = safeRequire('./input', {
    available: false,
    reason: 'load-failed',
    setDisplay() {},
    handle() {},
    releaseAll() {},
    reset() {},
    refreshPermission() {},
  });

  // §1 invariant 7: the viewer sees the session panel and the approval prompt in the stream; its
  // clicks and keystrokes must not drive them (input/index.js header: what this does and does not stop).
  if (typeof input.setPointerGuard === 'function') input.setPointerGuard(windows.sessionUiAt);
  if (typeof input.setKeyGuard === 'function') input.setKeyGuard(windows.sessionUiFocused);

  // Prompt and session start reuse the cached display list whatever its age: screen hot-plug /
  // metric events and resume invalidate it, and it is re-warmed at idle (capture.js), so the
  // desktopCapturer stall (0.45–2.3 s, input to every window frozen) never lands on a prompt or
  // between Accept and the first frame.
  const SESSION_DISPLAYS_MAX_AGE_MS = Infinity;
  const DISPLAY_WARM_STARTUP_MS = 3000;   // idle warm-up after startup / hosting switched on
  const DISPLAY_WARM_IDLE_MS = 2000;      // … after a prompt or a session is over
  const DISPLAY_WARM_LOCKED_RECHECK_MS = 60000; // … refused while locked: look again this much later
  const FIREWALL_WARNING = 'Windows Firewall is blocking Tunnelview (a Block rule exists for this program), so other devices cannot connect. See README › Troubleshooting.';
  const FIREWALL_BLOCK_ALL_WARNING = 'Windows Firewall blocks all incoming connections on the network profile of the Tailscale adapter ("Block all incoming connections"), so other devices cannot connect. See README › Troubleshooting.';
  const FIREWALL_RECHECK_MS = 60000;
  const MAIN_RELOADS_PER_MIN = 3;
  const LOGIN_ITEMS_SETTINGS_URL = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension';

  let host = null;
  let hostRunning = false;   // we called start() successfully and not stop()
  let hostStartError = null;
  let hostFirewallWarning = null;
  let hostOp = Promise.resolve();
  let isQuitting = false;
  let shutdownStarted = false;
  let shutdownDone = false;
  let osTeardownDone = false;
  let tailscaleReady = null;
  let suppressLoginItemApply = false;

  /**
   * Host-side state: at most one pending prompt and one active session (§3). warmPanel = the
   * session panel pre-created (hidden) while the prompt shows; adopted by the accepted session.
   */
  const hostState = { prompt: null, session: null, warmPanel: null };

  /* ---------------------------------------------------------------- helpers */

  const clean = ipc.clean;
  const permsOf = ipc.sanitizePermissions;

  /** Request / session peer from host-server (§7): `tags` = the node's ACL tags, [] = untagged. */
  function peerInfo(p) {
    const o = p && typeof p === 'object' ? p : {};
    const u = o.user && typeof o.user === 'object' ? o.user : {};
    return {
      ip: clean(o.ip, 64),
      hostname: clean(o.hostname, 255),
      os: ['windows', 'macos', 'linux', 'ios', 'android', 'other'].includes(o.os) ? o.os : 'other',
      user: { login: clean(u.login, 255), displayName: clean(u.displayName, 255) },
      stableId: clean(o.stableId, 128),
      sameUser: o.sameUser === true,
      isSelf: o.isSelf === true,
      tags: Array.isArray(o.tags) ? o.tags.filter((t) => typeof t === 'string').slice(0, 8).map((t) => clean(t, 64)) : [],
    };
  }

  /** "Always allow" is honoured only for an untagged node with a stableId (host-server _isTrusted). */
  const trustable = (peer) => !peer.isSelf && !!peer.stableId && peer.tags.length === 0 && peer.user.login !== 'tagged-devices';

  function viewerInfo(v) {
    const o = v && typeof v === 'object' ? v : {};
    return {
      hostname: clean(o.hostname, 255),
      os: ['windows', 'macos', 'linux', 'ios', 'android', 'other'].includes(o.os) ? o.os : 'other',
      version: clean(o.version, 32),
    };
  }

  const displayName = (peer) => peer.hostname || peer.ip || 'A device';
  const describePeer = (peer) => (peer.user.login ? `${displayName(peer)} (${peer.user.login})` : displayName(peer));

  const liveNotifications = new Set();
  function notify(title, body, onClick) {
    try {
      if (!Notification.isSupported()) return null;
      const n = new Notification({ title: String(title), body: String(body || ''), icon: IS_WIN ? icons.appIconLarge() : undefined });
      liveNotifications.add(n); // keep a reference so 'click' still fires after GC
      const drop = () => liveNotifications.delete(n);
      n.on('click', () => { drop(); if (onClick) { try { onClick(); } catch { /* ignore */ } } });
      n.on('close', drop);
      n.on('failed', drop);
      setTimeout(drop, 5 * 60 * 1000).unref();
      n.show();
      return n;
    } catch (err) {
      console.warn('[main] notification failed:', err && err.message);
      return null;
    }
  }

  /* ---------------------------------------------------------------- AppState */

  function hostStatus() {
    const s = settings.get();
    let st = null;
    if (host) { try { st = host.status(); } catch (err) { st = null; } }
    st = st && typeof st === 'object' ? st : {};
    return {
      enabled: s.hostEnabled,
      listening: st.listening === true,
      addresses: Array.isArray(st.addresses) ? st.addresses.filter((a) => typeof a === 'string') : [],
      port: Number.isInteger(st.port) ? st.port : s.port,
      error: (typeof st.error === 'string' && st.error) || hostStartError || null,
      warning: (s.hostEnabled && hostFirewallWarning) || null,
    };
  }

  function sessionSummary() {
    const sess = hostState.session;
    if (!sess || sess.ended) return null;
    const p = sess.peer;
    return { id: sess.id, peer: { ip: p.ip, hostname: p.hostname, os: p.os, user: { ...p.user } }, startedAt: sess.startedAt, via: sess.via };
  }

  function buildState() {
    const ts = tailscale.last;
    return {
      version: app.getVersion(),
      platform: OS_NAME,
      tailscale: ts
        ? { state: ts.state, message: ts.message || '', self: ts.self || null, magicDnsSuffix: ts.magicDnsSuffix || null }
        : { state: 'stopped', message: 'Checking Tailscale…', self: null, magicDnsSuffix: null },
      host: { ...hostStatus(), session: sessionSummary(), pending: !!hostState.prompt },
      viewers: ipc.listViewers(),
      permissions: permissions.status(),
      input: { available: !!input.available, reason: input.reason ? String(input.reason) : null },
    };
  }

  /* ---------- idle display warm-up gates (capture.setIdleWarm) ---------- */

  let screenLocked = false; // powerMonitor 'lock-screen' … 'unlock-screen'
  let viewersBusy = false;  // an outgoing viewer session was connecting / connected at the last state push

  /** The OS session is locked (lock screen; on Windows the secure desktop, where DXGI is denied). */
  function osSessionLocked() {
    if (screenLocked) return true;
    try { return powerMonitor.getSystemIdleState(1) === 'locked'; } catch { return false; }
  }

  /** An outgoing viewer window is connecting or connected (its input runs through main). */
  function viewerSessionActive() {
    try { return ipc.listViewers().some((v) => !!(v && v.phase && v.phase !== 'closed')); } catch { return false; }
  }

  /** The last outgoing viewer session ended: run a warm-up skipped meanwhile, at idle. */
  function noteViewerActivity() {
    const busy = viewerSessionActive();
    if (viewersBusy && !busy) capture.scheduleWarm(DISPLAY_WARM_IDLE_MS);
    viewersBusy = busy;
  }

  let stateTimer = null;
  /** Coalesce bursts of changes into one push to the main window + tray. */
  function stateChanged() {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      try { noteViewerActivity(); } catch (err) { console.error('[main] viewer activity check failed:', err); }
      let state;
      try { state = buildState(); } catch (err) { console.error('[main] buildState failed:', err); return; }
      const win = windows.getMain();
      if (win && !win.webContents.isLoading()) win.webContents.send('app:state', state);
      tray.update(state);
    }, 50);
  }

  /* ---------------------------------------------------------------- host server */

  /** Serialize host start()/stop() so they follow settings.hostEnabled (and quitting). */
  function syncHost() {
    hostOp = hostOp.then(async () => {
      if (!host) return;
      const want = settings.get().hostEnabled && !isQuitting;
      if (hostRunning && !want) {
        if (hostState.session && !hostState.session.ended) endHostSession('host-ended');
        try { await host.stop(); } catch (err) { console.error('[main] host.stop failed:', err); }
        hostRunning = false;
      }
      if (want && !hostRunning) {
        try {
          await host.start();
          hostRunning = true;
          hostStartError = null;
        } catch (err) {
          hostRunning = false;
          hostStartError = clean(err && err.message, 200) || 'Could not start listening.';
          console.error('[main] host.start failed:', err && err.message);
        }
      }
    }).catch((err) => console.error('[main] syncHost failed:', err)).finally(stateChanged);
    return hostOp;
  }

  /* ---------- Windows Firewall: inbound Block rules for this program ---------- */

  // When the Windows Firewall prompt is dismissed, Windows adds inbound *Block* rules
  // ("TCP/UDP Query User{…}") for the program. They win over allow rules: real tailnet peers are
  // dropped while self-tests (loopback) still pass. Only rules that can match a tailnet peer on
  // the signaling port count (firewallVerdict: profile of the Tailscale adapter, remote address,
  // port), and "Block all incoming connections" on that profile is reported too.
  let firewallCheck = null;
  let firewallCheckedAt = 0;
  let firewallAgain = false;
  let firewallTsIp; // our Tailscale IP the last check used (undefined = never checked)

  /** One of our own Tailscale IPs (IPv4 preferred) to find the adapter's network profile. */
  function selfTailscaleIp() {
    try {
      const self = tailscale.last && tailscale.last.self;
      const ips = self && Array.isArray(self.ips) ? self.ips.filter((ip) => typeof ip === 'string' && tailscale.isTailscaleIp(ip)) : [];
      return ips.find((ip) => !ip.includes(':')) || ips[0] || null;
    } catch {
      return null;
    }
  }

  function checkFirewall() {
    if (!IS_WIN || isQuitting) return;
    if (firewallCheck) { firewallAgain = true; return; } // single flight; re-run once it is done
    const s = settings.get();
    if (!s.hostEnabled) return;
    firewallCheckedAt = Date.now();
    const port = s.port;
    const env = { ...process.env, TUNNELVIEW_FW_PROGRAM: process.execPath };
    const tsIp = selfTailscaleIp();
    firewallTsIp = tsIp;
    if (tsIp) env.TUNNELVIEW_TS_IP = tsIp; else delete env.TUNNELVIEW_TS_IP;
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    firewallCheck = new Promise((resolve) => {
      try {
        execFile(ps, ['-NoProfile', '-NonInteractive', '-Command', FIREWALL_SCRIPT], {
          windowsHide: true,
          timeout: 15000,
          maxBuffer: 256 * 1024,
          env,
        }, (err, stdout) => {
          if (err) { resolve(null); return; }
          try {
            resolve(firewallVerdict(JSON.parse(String(stdout || '').trim()), port));
          } catch {
            resolve(null);
          }
        });
      } catch {
        resolve(null);
      }
    }).then((verdict) => {
      firewallCheck = null;
      if (verdict) { // query failed → keep what we knew (initially: no warning)
        const next = verdict.blockAll ? FIREWALL_BLOCK_ALL_WARNING : verdict.blocked.length ? FIREWALL_WARNING : null;
        if (next && next !== hostFirewallWarning) {
          console.warn('[main] Windows Firewall blocks Tunnelview:', verdict.blockAll ? 'all inbound connections on the Tailscale profile' : verdict.blocked.slice(0, 5).join(', '));
        }
        if (next !== hostFirewallWarning) {
          hostFirewallWarning = next;
          stateChanged();
        }
      }
      if (firewallAgain) { firewallAgain = false; checkFirewall(); }
    });
  }

  /* ---------- incoming request → prompt ---------- */

  function stopAttention(p) {
    if (p.win && !p.win.isDestroyed() && IS_WIN) { try { p.win.flashFrame(false); } catch { /* ignore */ } }
    if (IS_MAC && app.dock && typeof p.bounceId === 'number' && p.bounceId >= 0) {
      try { app.dock.cancelBounce(p.bounceId); } catch { /* ignore */ }
    }
    if (p.notification) { try { p.notification.close(); } catch { /* ignore */ } p.notification = null; }
  }

  function closePrompt(p, delayMs) {
    stopAttention(p);
    clearTimeout(p.timer);
    if (hostState.prompt === p) hostState.prompt = null;
    const win = p.win;
    setTimeout(() => { if (win && !win.isDestroyed()) win.close(); }, delayMs);
    // A display change while the prompt showed was not warmed (prompts never enumerate a valid cache).
    capture.scheduleWarm(DISPLAY_WARM_IDLE_MS);
    stateChanged();
  }

  function finishPrompt(p, answer) {
    if (p.done) return;
    p.done = true;
    const s = settings.get();
    const accept = answer.accept === true;
    const permissionsGranted = permsOf(answer.permissions, s.defaultPermissions);
    if (!capture.audioSupported()) permissionsGranted.audio = false;
    const peer = peerInfo(p.req.peer);
    // Tagged nodes are never trusted by host-server, so their "Always allow" is not saved either.
    const trust = accept && answer.trust === true && trustable(peer);
    const warm = hostState.warmPanel && hostState.warmPanel.requestId === p.requestId ? hostState.warmPanel : null;
    if (warm && accept) warm.accepted = true;
    // Destroy an accepted prompt BEFORE respond() reveals the session panel: if the active prompt
    // closed after the panel was shown, Windows would activate the panel (next window in z-order),
    // and the session-UI key guard would then drop every keystroke of the new viewer.
    if (accept && p.win && !p.win.isDestroyed()) {
      stopAttention(p);
      try { p.win.destroy(); } catch { /* already gone */ }
    }
    try {
      const reply = { accept, permissions: permissionsGranted, trust };
      if (!accept && answer.reason) reply.reason = answer.reason;
      p.req.respond(reply);
    } catch (err) {
      console.error('[main] request.respond failed:', err);
    }
    // respond() emits 'session-start' synchronously, so an accepted warm panel is adopted by now;
    // anything else (declined, timed out, viewer already gone) discards it.
    if (warm && hostState.warmPanel === warm) destroyWarmPanel(accept ? 'not-adopted' : 'declined');
    // host-server records trust itself on respond({trust:true}); this covers it if it ever does not.
    if (trust && !settings.isTrusted(peer.stableId)) {
      settings.addTrusted({ stableId: peer.stableId, name: peer.hostname, login: peer.user.login });
    }
    closePrompt(p, 0);
  }

  function onRequest(req) {
    if (!req || typeof req.respond !== 'function') return;
    if (hostState.prompt) {
      // host-server allows one pending prompt; refuse defensively if it ever sends two.
      try { req.respond({ accept: false, reason: PROTOCOL.DENY.BUSY }); } catch { /* ignore */ }
      return;
    }
    const s = settings.get();
    const peer = peerInfo(req.peer);
    const p = { req, requestId: String(req.requestId), createdAt: Date.now(), done: false, win: null, wcId: null, timer: null, bounceId: null, notification: null };
    hostState.prompt = p;
    p.win = windows.createPrompt({ requestId: p.requestId });
    p.wcId = p.win.webContents.id;
    // Closing the prompt by any means (Alt+F4, Cmd+W) = reject.
    p.win.on('closed', () => { if (!p.done) finishPrompt(p, { accept: false }); });
    if (IS_WIN) {
      p.win.once('ready-to-show', () => { if (!p.win.isDestroyed() && !p.win.isFocused()) p.win.flashFrame(true); });
      p.win.on('focus', () => { try { p.win.flashFrame(false); } catch { /* ignore */ } });
    }
    if (IS_MAC && app.dock) {
      try { p.bounceId = app.dock.bounce('critical'); } catch { /* ignore */ }
    }
    p.notification = notify('Incoming connection', `${describePeer(peer)} wants to connect to this computer.`, () => {
      if (p.win && !p.win.isDestroyed()) { p.win.show(); p.win.focus(); }
    });
    // Overlap the expensive session-start work with the human decision: the panel renderer, and
    // — only when nothing valid is cached — the display enumeration. desktopCapturer blocks main
    // (and input to every window, the prompt's Accept button included) for 0.45–2.3 s, so a
    // cached list of ANY age is reused: display events invalidate it and it is re-warmed at idle.
    // Started once the prompt is on screen so it does not delay it. macOS: only once Screen
    // Recording is granted, so no TCC prompt appears here.
    createWarmPanel(p);
    const warmDisplays = () => {
      if (p.done || !settings.get().hostEnabled || capture.hasCache()) return;
      if (IS_MAC && permissions.status().screen !== 'granted') return;
      capture.listDisplays({ maxAgeMs: Infinity }).catch(() => {});
    };
    p.win.once('ready-to-show', () => setTimeout(warmDisplays, 100));
    // Safety net: host-server times the prompt out after promptTimeoutSec; if it ever does not,
    // deny here a little later so a prompt can never wait forever.
    p.timer = setTimeout(() => {
      if (hostState.prompt === p && !p.done) finishPrompt(p, { accept: false, reason: PROTOCOL.DENY.TIMEOUT });
    }, (s.promptTimeoutSec + 2) * 1000);
    stateChanged();
  }

  function onRequestCancelled(requestId) {
    const p = hostState.prompt;
    if (!p || p.requestId !== String(requestId)) return;
    p.done = true;
    if (hostState.warmPanel && hostState.warmPanel.requestId === p.requestId) destroyWarmPanel('cancelled');
    if (p.win && !p.win.isDestroyed()) p.win.webContents.send('prompt:cancelled', { requestId: p.requestId });
    closePrompt(p, 800);
  }

  function promptInit(entry) {
    const p = hostState.prompt;
    if (!p || p.done || entry.wcId !== p.wcId) return null;
    const s = settings.get();
    const elapsed = (Date.now() - p.createdAt) / 1000;
    const audio = capture.audioSupported();
    return {
      requestId: p.requestId,
      peer: peerInfo(p.req.peer),
      viewer: viewerInfo(p.req.viewer),
      timeoutSec: Math.max(1, Math.round(s.promptTimeoutSec - elapsed)),
      defaults: { ...permsOf(s.defaultPermissions), audio: s.defaultPermissions.audio && audio },
      audioSupported: audio,
      hostOs: OS_NAME,
    };
  }

  function respondFromPrompt(entry, answer) {
    const p = hostState.prompt;
    if (!p || p.done || entry.wcId !== p.wcId) return { ok: false, error: 'No pending request.' };
    finishPrompt(p, answer);
    return { ok: true };
  }

  /* ---------- pre-created ("warm") session panel ---------- */

  /**
   * Prompt path only: create the session panel hidden while the user decides, so the accepted
   * session does not pay for a cold sandboxed renderer + first RTCPeerConnection. Until the
   * session adopts it, it is NOT the active panel: its panel:ready waits, display capture and
   * 'media' checks stay denied, and it is never shown (§1.7: capture only behind a visible panel).
   */
  function createWarmPanel(p) {
    if (hostState.warmPanel) destroyWarmPanel('replaced');
    const warm = { win: null, wcId: null, requestId: p.requestId, accepted: false, sess: null, onClose: null, waiters: [], dead: false };
    try {
      warm.win = windows.createPanel({ sessionId: null }, { hidden: true, onClose: (e) => { if (warm.onClose) warm.onClose(e); } });
    } catch (err) {
      console.warn('[main] could not pre-create the session panel:', err && err.message);
      return null;
    }
    warm.wcId = warm.win.webContents.id;
    warm.win.webContents.on('render-process-gone', () => {
      if (!warm.sess && hostState.warmPanel === warm) destroyWarmPanel('crashed');
    });
    warm.win.on('closed', () => {
      if (warm.sess) return; // adopted: the session's own handlers run
      warm.dead = true;
      dismissWarmWaiters(warm);
      if (hostState.warmPanel === warm) hostState.warmPanel = null;
    });
    hostState.warmPanel = warm;
    return warm;
  }

  /**
   * The warm panel is discarded (declined, cancelled, timed out, closed): its pending
   * panel:ready resolves null instead of rejecting. That is an expected outcome, and a rejected
   * handler makes Electron log "Error occurred in handler for 'panel:ready'" on every timeout.
   */
  function dismissWarmWaiters(warm) {
    for (const w of warm.waiters.splice(0)) w.resolve(false);
  }

  function destroyWarmPanel(_why) {
    const warm = hostState.warmPanel;
    if (!warm) return;
    hostState.warmPanel = null;
    if (warm.sess) return; // adopted: belongs to the session now
    warm.dead = true;
    dismissWarmWaiters(warm);
    if (warm.win && !warm.win.isDestroyed()) warm.win.destroy();
  }

  function isWarmPanel(wcId) {
    const warm = hostState.warmPanel;
    return !!(warm && !warm.dead && !warm.sess && warm.wcId === wcId);
  }

  /**
   * panel:ready from the warm panel: resolves with the PanelInit once the session adopted it, or
   * null when the panel is discarded instead. Real failures (panelReady for the adopted session)
   * still reject.
   */
  function warmPanelReady(entry) {
    const warm = hostState.warmPanel;
    if (!warm || warm.dead || warm.sess || warm.wcId !== entry.wcId) return Promise.reject(new Error('No active session'));
    return new Promise((resolve) => warm.waiters.push({ resolve }))
      .then((adopted) => (adopted ? panelReady(entry) : null));
  }

  /* ---------- session lifecycle → panel ---------- */

  function sendPanel(sess, channel, payload) {
    const w = sess.panelWin;
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }

  /**
   * The user closes the panel (Alt+F4, Cmd+W, taskbar): confirm before ending the session
   * (ARCHITECTURE §3). The panel's Disconnect button and the tray / main-window "End session"
   * end it without a dialog; quitting and an already-ended session close it right away.
   */
  function panelOnClose(sess, e) {
    if (isQuitting || sess.ended) return;
    e.preventDefault();
    if (sess.confirming) return;
    sess.confirming = true;
    const win = sess.panelWin;
    const opts = {
      type: 'question',
      buttons: ['End session', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: 'End the remote session?',
      detail: `${displayName(sess.peer)} will be disconnected.`,
    };
    const shown = win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
    shown.then(({ response }) => {
      sess.confirming = false;
      if (response === 0 && !sess.ended) endHostSession('host-ended');
    }).catch(() => { sess.confirming = false; });
  }

  /** Attach the session's lifecycle handlers to its panel window (cold or adopted warm panel). */
  function wirePanel(sess, win) {
    sess.panelWin = win;
    const panelWcId = win.webContents.id;
    sess.panelWcId = panelWcId;
    win.webContents.on('render-process-gone', () => {
      // No visible panel → no session (security invariant §1.7).
      if (!sess.ended) { endHostSession('host-ended'); finalizeSession(sess, 'host-ended'); }
    });
    win.on('closed', () => {
      if (!sess.ended) { endHostSession('host-ended'); finalizeSession(sess, 'host-ended'); }
      files.forgetOwner(panelWcId).catch(() => {});
    });
    if (IS_WIN) win.on('session-end', onOsSessionEnd);
  }

  async function onSessionStart(info) {
    if (!info || typeof info !== 'object' || info.id == null) return;
    const prev = hostState.session;
    if (prev && !prev.ended) finalizeSession(prev, 'replaced');

    const s = settings.get();
    const sess = {
      id: String(info.id),
      peer: peerInfo(info.peer),
      viewer: viewerInfo(info.viewer),
      via: ['password', 'prompt', 'trusted', 'same-user', 'self'].includes(info.via) ? info.via : 'prompt',
      startedAt: Number.isFinite(info.startedAt) ? info.startedAt : Date.now(),
      acceptedAt: Date.now(),
      permissions: permsOf(info.permissions, s.defaultPermissions),
      ready: false,
      queue: [],
      ended: false,
      confirming: false,
      warm: false,
      panelWin: null,
      panelWcId: null,
      endFallback: null,
      psb: null,
    };
    hostState.session = sess;
    capture.reset();

    // Safety net (host-server already gets audio:false defaults from hostSettings): never start a
    // session with audio on when this host cannot capture system audio.
    if (!capture.audioSupported() && sess.permissions.audio) {
      sess.permissions.audio = false;
      if (host) { try { host.setPermissions({ ...sess.permissions }); } catch { /* ignore */ } }
    }

    // Keep the display awake while someone is connected: Chromium's WebRTC wake lock only
    // prevents app suspension, so the screen would sleep (video freezes) and a Mac set to
    // "require password after the display turns off" would lock — which Tunnelview cannot unlock.
    // Incoming sessions only, never for the viewer role.
    try { sess.psb = powerSaveBlocker.start('prevent-display-sleep'); } catch (err) {
      console.warn('[main] could not keep the display awake:', err && err.message);
    }

    // macOS: capture needs Screen Recording, injection needs Accessibility. (Tunnelview is put on the
    // Screen Recording list at startup / from the main window; a prompt here would interrupt the
    // session, so only explain.)
    const pst = permissions.refresh();
    if (IS_MAC) {
      if (pst.screen !== 'granted') {
        notify('Screen Recording permission needed', 'Tunnelview cannot share this screen until it is allowed in System Settings → Privacy & Security → Screen Recording.');
      }
      if (pst.accessibility !== 'granted' && sess.permissions.control) {
        notify('Accessibility permission needed', 'Remote control needs Tunnelview to be allowed in System Settings → Privacy & Security → Accessibility.');
      }
    }

    // The prompt path pre-created the panel while the user decided: adopt it. Every other path
    // (password, trusted, same-user, or a lost warm panel) creates it now.
    const warm = hostState.warmPanel;
    if (warm && warm.accepted && !warm.dead && warm.win && !warm.win.isDestroyed() && (sess.via === 'prompt' || sess.via === 'self')) {
      hostState.warmPanel = null;
      warm.sess = sess;
      sess.warm = true;
      wirePanel(sess, warm.win);
      warm.onClose = (e) => panelOnClose(sess, e);
      windows.revealPanel(warm.win);
      for (const w of warm.waiters.splice(0)) w.resolve(true);
    } else {
      const win = windows.createPanel({ sessionId: sess.id }, { onClose: (e) => panelOnClose(sess, e) });
      wirePanel(sess, win);
    }

    if (sess.via !== 'prompt') {
      notify(`${displayName(sess.peer)} connected`, `${describePeer(sess.peer)} is now viewing this computer. Use the session panel to disconnect.`);
    }
    stateChanged();
  }

  function onSessionSignal(msg) {
    const sess = hostState.session;
    if (!sess || sess.ended) return;
    const m = ipc.sanitizeSignal(msg);
    if (!m) return;
    if (sess.ready) sendPanel(sess, 'panel:signal', m);
    else if (sess.queue.length < 1000) sess.queue.push(m);
  }

  async function panelReady(entry) {
    const sess = hostState.session;
    if (!sess || sess.ended || entry.wcId !== sess.panelWcId) throw new Error('No active session');
    // One enumeration at most (usually none: warmed while the prompt showed); the selection below
    // and the panel's own selectDisplay() reuse it.
    const displays = await capture.listDisplays({ maxAgeMs: SESSION_DISPLAYS_MAX_AGE_MS });
    const initial = displays.find((d) => d.id === capture.selectedDisplayId())
      || displays.find((d) => d.primary) || displays[0] || null;
    // The initial display is the only one mapped at selection time; later switches are committed
    // by the panel once their stream is live (panel:commit-display).
    if (initial) await capture.selectDisplay(initial.id, { mapInput: true });
    if (sess.ended || hostState.session !== sess) throw new Error('Session ended');
    const s = settings.get();
    const init = {
      sessionId: sess.id,
      peer: { ...sess.peer, user: { ...sess.peer.user } },
      viewer: { ...sess.viewer },
      via: sess.via,
      startedAt: sess.startedAt,
      permissions: { ...sess.permissions },
      settings: { quality: s.quality, codec: s.codec, clipboardSync: s.clipboardSync },
      displays: displays.map(capture.publicDisplay),
      initialDisplayId: initial ? initial.id : '',
      audioSupported: capture.audioSupported(),
      hostOs: OS_NAME,
      input: { available: !!input.available, reason: input.reason ? String(input.reason) : null },
    };
    if (!sess.ready) {
      console.log(`[main] session ${sess.id.slice(0, 8)}: accept → panel ready in ${Date.now() - sess.acceptedAt} ms (${sess.warm ? 'pre-created' : 'cold'} panel)`);
    }
    sess.ready = true;
    // Flush viewer signals that arrived before the panel was listening (after the reply).
    setImmediate(() => {
      if (sess.ended) return;
      const queued = sess.queue.splice(0);
      for (const m of queued) sendPanel(sess, 'panel:signal', m);
    });
    return init;
  }

  function setSessionPermissions(p) {
    const sess = hostState.session;
    if (!sess || sess.ended) return permsOf(null);
    const prev = sess.permissions;
    const next = permsOf(p, prev);
    if (!capture.audioSupported()) next.audio = false;
    sess.permissions = next;
    if (host) { try { host.setPermissions({ ...next }); } catch (err) { console.error('[main] host.setPermissions failed:', err); } }
    if (prev.control && !next.control) { try { input.releaseAll(); } catch { /* ignore */ } }
    if (prev.files && !next.files) files.abortAll(sess.panelWcId).catch(() => {});
    sendPanel(sess, 'panel:permissions', { ...next });
    stateChanged();
    return { ...next };
  }

  function endHostSession(reason = 'host-ended') {
    const sess = hostState.session;
    if (!sess || sess.ended) return;
    if (host) { try { host.endSession(reason); } catch (err) { console.error('[main] host.endSession failed:', err); } }
    if (sess.ended) return; // host-server emitted 'session-end' synchronously
    // If host-server never confirms with 'session-end', tear down locally anyway.
    clearTimeout(sess.endFallback);
    sess.endFallback = setTimeout(() => finalizeSession(sess, reason), 3000);
    if (sess.endFallback.unref) sess.endFallback.unref();
  }

  function onSessionEnd(evt) {
    const sess = hostState.session;
    if (!sess) return;
    const id = evt && evt.id != null ? String(evt.id) : null;
    if (id && id !== sess.id) return;
    // The reason reaches the panel unchanged (≤ 64 chars, control chars stripped): 'viewer-ended',
    // 'network', 'host-ended', or what the panel/viewer gave ('capture-failed', 'non-tailnet-path',
    // 'media-timeout', 'media-failed', …).
    finalizeSession(sess, evt && typeof evt.reason === 'string' ? evt.reason : 'ended');
  }

  /** Let the display sleep again (idempotent). */
  function releaseDisplayAwake(sess) {
    if (!sess || sess.psb == null) return;
    const id = sess.psb;
    sess.psb = null;
    try { if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id); } catch { /* ignore */ }
  }

  function finalizeSession(sess, reason) {
    releaseDisplayAwake(sess);
    if (sess.ended) return;
    sess.ended = true;
    clearTimeout(sess.endFallback);
    if (hostState.session === sess) hostState.session = null;
    // Session boundary: release held keys AND forget the lock-key resync give-up state, so a lock
    // whose resync gave up (e.g. a remapped CapsLock) is tried again next session.
    try { if (typeof input.reset === 'function') input.reset(); else input.releaseAll(); } catch { /* ignore */ }
    capture.reset();
    capture.scheduleWarm(DISPLAY_WARM_IDLE_MS);
    const win = sess.panelWin;
    if (win && !win.isDestroyed()) {
      clipboard.unsubscribe(win.webContents);
      win.webContents.send('panel:ended', { reason: clean(reason, 64) || 'ended' });
      setTimeout(() => { if (!win.isDestroyed()) win.close(); }, 1500);
    }
    if (sess.panelWcId != null) files.abortAll(sess.panelWcId).catch(() => {});
    stateChanged();
  }

  const hostCtl = {
    isActivePanel: (wcId) => !!(hostState.session && !hostState.session.ended && hostState.session.panelWcId === wcId),
    getPermissions: () => (hostState.session && !hostState.session.ended ? { ...hostState.session.permissions } : null),
    sessionActive: () => !!(hostState.session && !hostState.session.ended),
    panelReady,
    isWarmPanel,
    warmPanelReady,
    setPermissions: setSessionPermissions,
    endSession: endHostSession,
    promptInit,
    respond: respondFromPrompt,
  };

  /** Display capture is only served to the main frame of the ACTIVE session's panel. */
  function isActivePanelFrame(frame) {
    try {
      const wc = webContents.fromFrame(frame);
      if (!wc || !hostCtl.isActivePanel(wc.id)) return false;
      return frame.parent === null && windows.isAllowedUrl(wc, frame.url);
    } catch {
      return false;
    }
  }

  /* ---------------------------------------------------------------- security hardening */

  function installSecurity() {
    app.on('web-contents-created', (_e, wc) => {
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      wc.on('will-navigate', (event, legacyUrl) => {
        const url = (event && event.url) || legacyUrl || '';
        if (url.startsWith('devtools://')) return;
        if (!windows.isAllowedUrl(wc, url)) {
          event.preventDefault();
          console.warn('[main] blocked navigation to', url.slice(0, 200));
        }
      });
      wc.on('will-frame-navigate', (event) => {
        if (event && event.isMainFrame === false) event.preventDefault(); // no sub-frames, ever
      });
      wc.on('will-redirect', (event, legacyUrl) => {
        const url = (event && event.url) || legacyUrl || '';
        if (!url.startsWith('devtools://') && !windows.isAllowedUrl(wc, url)) event.preventDefault();
      });
      wc.on('will-attach-webview', (event) => event.preventDefault());
    });

    const ses = session.defaultSession;
    const allowed = (wc, permission, details) => {
      if (!wc) return false;
      const entry = windows.getEntry(wc);
      if (!entry) return false;
      if (details && details.isMainFrame === false) return false;
      const url = details && details.requestingUrl;
      if (url && !windows.isAllowedUrl(wc, url)) return false;
      switch (entry.kind) {
        // Electron 45 names screen capture 'display-capture' ('media' = camera/microphone → denied).
        case 'panel': return permission === 'display-capture' && hostCtl.isActivePanel(entry.wcId);
        case 'viewer': return permission === 'fullscreen' || permission === 'keyboardLock' || permission === 'pointerLock';
        default: return false;
      }
    };
    ses.setPermissionRequestHandler((wc, permission, callback, details) => {
      const ok = allowed(wc, permission, details);
      if (!ok) console.warn(`[main] denied permission '${permission}'`);
      callback(ok);
    });
    // Chromium's WebRTC network manager enumerates every adapter (including Tailscale's) only when the
    // page *has* mic/camera permission; otherwise it gathers on the default route only (LAN/Wi-Fi), the
    // tailnet-only candidate filter drops everything and ICE never starts. So the *check* for 'media' is
    // answered yes for viewer windows and the active panel. Actual getUserMedia *requests* still go
    // through the request handler above and stay denied (no camera/microphone access is granted).
    const rtcEnumerationAllowed = (wc, details) => {
      if (!wc) return false;
      const entry = windows.getEntry(wc);
      if (!entry) return false;
      if (details && details.isMainFrame === false) return false;
      const url = details && details.requestingUrl;
      if (url && !windows.isAllowedUrl(wc, url)) return false;
      return entry.kind === 'viewer' || (entry.kind === 'panel' && hostCtl.isActivePanel(entry.wcId));
    };
    ses.setPermissionCheckHandler((wc, permission, _origin, details) =>
      (permission === 'media' && rtcEnumerationAllowed(wc, details)) || allowed(wc, permission, details));
    ses.setDevicePermissionHandler(() => false);
    ses.on('will-download', (event) => event.preventDefault());
  }

  function installMenu() {
    if (IS_MAC) {
      // fileMenu carries Close (⌘W) on macOS; windowMenu has none. While a viewer controls the
      // remote, its key handler preventDefault()s ⌘W, so it goes to the remote Mac instead.
      const template = [{ role: 'appMenu' }, { role: 'fileMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }];
      if (DEV) template.push({ role: 'viewMenu' });
      Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    } else {
      Menu.setApplicationMenu(null);
    }
  }

  /* ---------------------------------------------------------------- windows / lifecycle */

  const wiredMainWindows = new WeakSet();
  const mainReloads = [];
  function ensureMainWindow(show) {
    const win = windows.createMain();
    if (!wiredMainWindows.has(win)) {
      wiredMainWindows.add(win);
      let leavingFullScreen = null; // macOS: timer while waiting for 'leave-full-screen'
      win.on('close', (e) => {
        // Both OSes: hide (keep running in the tray / menu bar) when closeToTray, otherwise really
        // close — window-all-closed then quits, so the host stops listening on the tailnet.
        if (isQuitting || !settings.get().closeToTray) return;
        e.preventDefault();
        if (IS_MAC && (leavingFullScreen || win.isFullScreen())) {
          // Hiding a window in native full screen leaves its Space behind as an empty black
          // screen: leave full screen first, then hide (unless the app started quitting meanwhile,
          // which closes the window itself).
          if (leavingFullScreen) return; // already on its way out
          const onLeft = () => {
            clearTimeout(leavingFullScreen);
            leavingFullScreen = null;
            if (!win.isDestroyed() && !isQuitting) win.hide();
          };
          win.once('leave-full-screen', onLeft);
          // Never wait forever (the transition may be refused): give up quietly; closing again retries.
          leavingFullScreen = setTimeout(() => {
            leavingFullScreen = null;
            win.removeListener('leave-full-screen', onLeft);
          }, 5000);
          win.setFullScreen(false);
          return;
        }
        win.hide();
      });
      win.webContents.on('did-finish-load', stateChanged);
      // A crashed main renderer would otherwise be reused as a blank window by ensureMainWindow.
      win.webContents.on('render-process-gone', (_e, details) => {
        if (isQuitting || (details && details.reason === 'clean-exit')) return;
        const now = Date.now();
        while (mainReloads.length && now - mainReloads[0] > 60000) mainReloads.shift();
        if (mainReloads.length >= MAIN_RELOADS_PER_MIN) {
          console.error('[main] main window renderer keeps crashing; reloading only when reopened');
          return;
        }
        mainReloads.push(now);
        console.error('[main] main window renderer gone:', details && details.reason, '— reloading');
        setImmediate(() => { if (!win.isDestroyed()) win.webContents.reload(); });
      });
      if (IS_WIN) {
        win.on('session-end', onOsSessionEnd);
        win.on('focus', () => { if (Date.now() - firewallCheckedAt > FIREWALL_RECHECK_MS) checkFirewall(); });
      }
    } else if (show && !win.isDestroyed() && win.webContents.isCrashed()) {
      win.webContents.reload(); // user asked for the window again after the reload budget ran out
    }
    if (show) windows.showMain();
    return win;
  }

  /** macOS SMAppService status of the main-app login item, or null when unknown. */
  function macLoginItemStatus() {
    try {
      const st = app.getLoginItemSettings().status;
      return ['not-registered', 'enabled', 'requires-approval', 'not-found'].includes(st) ? st : null;
    } catch (err) {
      console.warn('[main] getLoginItemSettings failed:', err && err.message);
      return null;
    }
  }

  /** Follow the user's choice made outside Tunnelview: turn the setting off without re-applying it. */
  function adoptLoginItemOff(extra = {}) {
    suppressLoginItemApply = true;
    try { settings.update({ startAtLogin: false, ...extra }); } finally { suppressLoginItemApply = false; }
  }

  let loginApprovalHinted = false;
  /** macOS: the login item is registered but the user must allow it in System Settings. */
  function hintLoginItemApproval() {
    console.warn('[main] the login item needs approval in System Settings › General › Login Items');
    if (loginApprovalHinted) return;
    loginApprovalHinted = true;
    notify('Allow Tunnelview to open at login', 'macOS needs your approval in System Settings › General › Login Items. Click to open it.', () => {
      shell.openExternal(LOGIN_ITEMS_SETTINGS_URL).catch(() => {});
    });
  }

  function applyLoginItem(enabled) {
    if (!app.isPackaged) return; // never register the bare electron binary during development
    try {
      if (IS_WIN) app.setLoginItemSettings({ openAtLogin: !!enabled, path: process.execPath, args: ['--hidden'] });
      else if (IS_MAC) app.setLoginItemSettings({ openAtLogin: !!enabled });
    } catch (err) {
      console.error('[main] setLoginItemSettings failed:', err && err.message);
    }
    if (!IS_MAC) return;
    // Remember whether WE registered it, so a later 'not-registered' reads as "the user removed it".
    let applied = false;
    if (enabled) {
      const st = macLoginItemStatus();
      applied = st === 'enabled' || st === 'requires-approval';
      if (st === 'requires-approval') hintLoginItemApproval();
    }
    if (settings.get().loginItemApplied !== applied) settings.update({ loginItemApplied: applied });
  }

  /**
   * macOS startup reconcile (SMAppService status, never re-registering over the user):
   *   wanted + 'not-registered' after Tunnelview had registered it → the user removed it in System
   *     Settings › Login Items: turn the setting off;
   *   wanted + 'enabled' → nothing (just remember that it is registered);
   *   wanted + 'requires-approval' → registered, waiting for the user: log + hint, no re-register;
   *   wanted + never registered / 'not-found' / unknown → register;
   *   not wanted + registered ('enabled' / 'requires-approval') → stale entry: unregister.
   */
  function reconcileMacLoginItem(want) {
    const st = macLoginItemStatus();
    const s = settings.get();
    if (want) {
      if (st === 'not-registered' && s.loginItemApplied) { adoptLoginItemOff({ loginItemApplied: false }); return; }
      if (st === 'enabled' || st === 'requires-approval') {
        if (!s.loginItemApplied) settings.update({ loginItemApplied: true });
        if (st === 'requires-approval') hintLoginItemApproval();
        return;
      }
      applyLoginItem(true);
      return;
    }
    if (st === 'enabled' || st === 'requires-approval') applyLoginItem(false);
    else if (s.loginItemApplied) settings.update({ loginItemApplied: false });
  }

  /**
   * Startup: bring the OS login item in line with settings without overriding the user.
   * Windows: register once when wanted but missing; when the user disabled Tunnelview in Task
   * Manager → Startup apps (Run entry present, StartupApproved off) follow that choice by turning
   * the setting off — without calling setLoginItemSettings (which would re-enable it).
   * macOS: the same idea with the SMAppService status (reconcileMacLoginItem).
   */
  function reconcileLoginItem() {
    if (!app.isPackaged) return;
    const want = settings.get().startAtLogin;
    if (IS_MAC) { reconcileMacLoginItem(want); return; }
    if (!IS_WIN) return;
    let li;
    try {
      li = app.getLoginItemSettings({ path: process.execPath, args: ['--hidden'] });
    } catch (err) {
      console.warn('[main] getLoginItemSettings failed:', err && err.message);
      return;
    }
    if (li.openAtLogin && li.executableWillLaunchAtLogin === false) {
      if (want) adoptLoginItemOff();
      return;
    }
    if (want && !li.openAtLogin) applyLoginItem(true);
    else if (!want && li.openAtLogin) applyLoginItem(false); // stale entry while the setting is off
  }

  function launchedHidden() {
    if (process.argv.includes('--hidden')) return true;
    if (IS_MAC) {
      try { return !!app.getLoginItemSettings().wasOpenedAtLogin; } catch { return false; }
    }
    return false;
  }

  function withTimeout(promise, ms) {
    return Promise.race([Promise.resolve(promise).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
  }

  async function shutdown() {
    try {
      const p = hostState.prompt;
      if (p && !p.done) finishPrompt(p, { accept: false });
      destroyWarmPanel('shutdown');
      const sess = hostState.session;
      const panelWcId = sess ? sess.panelWcId : null;
      if (sess && !sess.ended) {
        endHostSession('host-ended'); // sends bye to the viewer
        finalizeSession(sess, 'host-ended');
      }
      releaseDisplayAwake(sess);
      capture.setIdleWarm(null);
      const viewerIds = ipc.listViewers().map((v) => v.id);
      ipc.closeAllViewers('viewer-closed'); // sends bye to every host we are viewing
      try { input.releaseAll(); } catch { /* ignore */ }
      clipboard.dispose();
      try { tailscale.stopWatching(); } catch { /* ignore */ }
      // Delete incoming .part files now: the windows' 'closed' handlers run too late at exit.
      await withTimeout(Promise.all([
        ...viewerIds.map((id) => files.forgetOwner(id)),
        panelWcId != null ? files.abortAll(panelWcId) : null,
      ].filter(Boolean)), 1500);
      await hostOp.catch(() => {});
      if (host && hostRunning) await withTimeout(host.stop(), 2000);
      hostRunning = false;
    } catch (err) {
      console.error('[main] shutdown error:', err);
    }
  }

  /**
   * Windows shutdown / restart / log-off: Electron emits no before-quit and powerMonitor
   * 'shutdown' is macOS/Linux-only, and nothing async is guaranteed to run afterwards. So tear
   * down synchronously: bye to the viewer (ws.send writes immediately) and to every host we view,
   * release held input, close + delete incoming .part files.
   */
  function onOsSessionEnd() {
    if (osTeardownDone) return;
    osTeardownDone = true;
    isQuitting = true;
    try {
      const p = hostState.prompt;
      if (p && !p.done) finishPrompt(p, { accept: false });
      destroyWarmPanel('shutdown');
      const sess = hostState.session;
      if (sess && !sess.ended) {
        endHostSession('host-ended');
        finalizeSession(sess, 'host-ended');
      }
      releaseDisplayAwake(sess);
      capture.setIdleWarm(null);
      ipc.closeAllViewers('viewer-closed');
      try { input.releaseAll(); } catch { /* ignore */ }
      files.abortAllSync();
    } catch (err) {
      console.error('[main] session-end teardown failed:', err);
    }
    // The graceful async shutdown has nothing left to do; let any later app.quit() through.
    shutdownStarted = true;
    shutdownDone = true;
  }

  app.on('before-quit', (e) => {
    isQuitting = true;
    if (shutdownDone) return;
    e.preventDefault();
    if (shutdownStarted) return;
    shutdownStarted = true;
    withTimeout(shutdown(), 4000).finally(() => {
      shutdownDone = true;
      app.quit();
    });
  });

  app.on('will-quit', () => tray.destroy());

  app.on('second-instance', () => {
    if (app.isReady()) ensureMainWindow(true);
  });

  let readyAt = 0;
  let startedHidden = false;
  app.on('activate', () => {
    // macOS Dock click: re-show the main window, or create a new one when it was really closed
    // (closeToTray off). macOS also fires 'activate' right after launch; don't defeat a hidden
    // login-item start.
    if (!app.isReady() || !readyAt) return;
    if (startedHidden && Date.now() - readyAt < 3000) return;
    ensureMainWindow(true);
  });

  app.on('window-all-closed', () => {
    // Both OSes: keep running (tray / menu bar, host keeps listening) only when closeToTray.
    if (!settings.get().closeToTray) app.quit();
  });

  app.on('child-process-gone', (_e, details) => {
    if (details && details.reason !== 'clean-exit') console.warn('[main] child process gone:', details.type, details.reason);
  });

  process.on('unhandledRejection', (err) => console.error('[main] unhandled rejection:', err));

  /* ---------------------------------------------------------------- ready */

  app.whenReady().then(() => {
    settings.load();
    nativeTheme.themeSource = settings.get().theme;

    if (IS_MAC) {
      // Viewer typing goes through an always-focused hidden textarea: with AppKit's default
      // press-and-hold, held letter keys do not auto-repeat and the accent picker can inject an
      // accented character on the host. This writes Tunnelview's own defaults domain (which wins
      // over NSGlobalDomain). Side effect: the press-and-hold accent picker is also off in
      // Tunnelview's own text fields; Option dead keys still work.
      try { systemPreferences.setUserDefault('ApplePressAndHoldEnabled', 'boolean', false); } catch (err) {
        console.warn('[main] could not disable ApplePressAndHoldEnabled:', err && err.message);
      }
    }

    installSecurity();
    installMenu();
    if (IS_MAC && !app.isPackaged && app.dock) {
      try { const img = icons.appIconLarge(); if (!img.isEmpty()) app.dock.setIcon(img); } catch { /* ignore */ }
    }

    capture.init(session.defaultSession, {
      isActivePanelFrame,
      audioAllowed: () => !!(hostState.session && !hostState.session.ended && hostState.session.permissions.audio),
      input,
    });
    // Warm the display list at idle (after each invalidation, debounced, and when scheduled
    // below): never while a prompt or a session is in progress — those reuse the cache — nor
    // while the OS session is locked (Windows lock screen: no DXGI, so GDI sources without
    // display_id get paired with displays by index and that pairing would be cached; capture.js
    // invalidates on 'unlock-screen' and re-warms on the user's desktop), nor while this machine
    // views another device (the 0.45–2.3 s main-process stall would freeze the viewer's remote
    // input; noteViewerActivity re-schedules it once the last viewer session ends), and on macOS
    // only once Screen Recording is granted (no TCC prompt from here).
    if (powerMonitor && typeof powerMonitor.on === 'function') {
      powerMonitor.on('lock-screen', () => { screenLocked = true; });
      powerMonitor.on('unlock-screen', () => { screenLocked = false; });
    }
    capture.setIdleWarm(() => {
      if (isQuitting || !settings.get().hostEnabled) return false;
      if (hostState.prompt || (hostState.session && !hostState.session.ended)) return false;
      if (osSessionLocked()) {
        // 'unlock-screen' re-warms by itself; this recheck covers a lock seen only by the live
        // check (screen saver, missed event). Asked only while nothing valid is cached.
        capture.scheduleWarm(DISPLAY_WARM_LOCKED_RECHECK_MS);
        return false;
      }
      if (viewerSessionActive()) return false;
      if (IS_MAC && permissions.status().screen !== 'granted') return false;
      return true;
    }, { delayMs: DISPLAY_WARM_IDLE_MS });
    capture.scheduleWarm(DISPLAY_WARM_STARTUP_MS);
    permissions.init({ input });
    permissions.on('change', stateChanged);

    // Tailscale discovery runs in the background; the UI shows "Checking…" meanwhile.
    tailscaleReady = (async () => {
      try { await tailscale.init(); } catch (err) { console.error('[main] tailscale.init failed:', err); }
      try { await tailscale.status(); } catch (err) { console.error('[main] tailscale.status failed:', err && err.message); }
      try { tailscale.startWatching(); } catch (err) { console.error('[main] tailscale.startWatching failed:', err); }
    })();
    tailscale.on('status', stateChanged);
    tailscale.on('change', (st) => {
      // host-server rebinds on its own; this only retries a start() that failed while Tailscale was down.
      if (st && st.state === 'running' && settings.get().hostEnabled && !hostRunning) syncHost();
      // Our Tailscale IP decides which adapter's network profile the Block rules are judged on.
      if (firewallTsIp !== undefined && selfTailscaleIp() !== firewallTsIp) checkFirewall();
      stateChanged();
    });

    // host-server's view of the settings: defaultPermissions.audio is false on a host that cannot
    // capture system audio (macOS without the loopback opt-in), so sessions admitted by password,
    // trusted node or same-user start (and are ACCEPTED) without audio, like the prompt path.
    // host-server uses get(), update() (trusted nodes) and on/removeListener('change'); the
    // writes go to the real store unchanged.
    const hostSettings = {
      get() {
        const s = settings.get();
        if (!capture.audioSupported() && s.defaultPermissions && typeof s.defaultPermissions === 'object') s.defaultPermissions.audio = false;
        return s;
      },
      update: (partial) => settings.update(partial),
      on(event, fn) { settings.on(event, fn); return hostSettings; },
      removeListener(event, fn) { settings.removeListener(event, fn); return hostSettings; },
      off(event, fn) { settings.removeListener(event, fn); return hostSettings; },
    };

    try {
      host = new HostServer({ tailscale, settings: hostSettings, auth, appVersion: app.getVersion(), osName: OS_NAME });
      host.on('request', (req) => { try { onRequest(req); } catch (err) { console.error('[main] request handling failed:', err); } });
      host.on('request-cancelled', onRequestCancelled);
      host.on('session-start', (s) => { onSessionStart(s).catch((err) => console.error('[main] session-start failed:', err)); });
      host.on('session-signal', onSessionSignal);
      host.on('session-end', onSessionEnd);
      host.on('status', stateChanged);
      host.on('error', (err) => console.error('[main] host server error:', err && err.message));
    } catch (err) {
      host = null;
      hostStartError = 'Host server unavailable.';
      console.error('[main] HostServer construction failed:', err);
    }

    ipc.register({
      settings,
      tailscale,
      auth,
      ViewerSession,
      windows,
      capture,
      clipboard,
      files,
      permissions,
      input,
      hostCtl,
      getHost: () => host,
      getState: buildState,
      stateChanged,
      notify,
      quit: () => app.quit(),
      appVersion: app.getVersion(),
      osName: OS_NAME,
      tailscaleReady,
    });

    /** macOS: put Tunnelview on the Screen Recording list (no System Settings) so it can be set up before any session. */
    const registerScreenCapture = () => {
      if (!IS_MAC || !settings.get().hostEnabled) return;
      if (permissions.status().screen === 'granted') return;
      permissions.register('screen').catch(() => {});
    };

    /**
     * macOS: touch the receive folder (default ~/Downloads/Tunnelview, privacy-protected) now, in
     * the background, so the Downloads-folder alert appears while the user is at the Mac — not
     * when a peer offers a file mid-session, where nobody can answer it (TCC ignores synthetic
     * clicks). files.prepareDir() writes and deletes a probe file in it, so this also works when
     * the folder already exists. Repeated when hosting is switched on or the folder changes.
     */
    const prepareReceiveDir = () => {
      if (!IS_MAC || isQuitting || !settings.get().hostEnabled) return;
      files.prepareDir().then((r) => {
        if (r && !r.ok) console.warn('[main] the folder for received files is not usable:', r.reason);
      }).catch(() => {});
    };

    settings.on('change', (s, keys) => {
      // Port changes: host-server re-binds by itself on settings 'change' (keeping an active
      // session alive), so only hostEnabled toggles start()/stop() here.
      if (keys.includes('hostEnabled')) {
        syncHost();
        if (s.hostEnabled) {
          checkFirewall();
          registerScreenCapture();
          prepareReceiveDir();
          capture.scheduleWarm(DISPLAY_WARM_STARTUP_MS);
        }
      } else if (keys.includes('port')) {
        checkFirewall(); // Block rules are judged against the signaling port
      }
      if (keys.includes('downloadDir')) prepareReceiveDir();
      if (keys.includes('startAtLogin') && !suppressLoginItemApply) applyLoginItem(s.startAtLogin);
      if (keys.includes('theme')) nativeTheme.themeSource = s.theme;
      stateChanged();
    });

    tray.create({
      onOpen: () => ensureMainWindow(true),
      onToggleHost: (enabled) => settings.update({ hostEnabled: enabled }),
      onEndSession: () => endHostSession('host-ended'),
      onQuit: () => app.quit(),
    });

    startedHidden = launchedHidden();
    readyAt = Date.now();
    ensureMainWindow(!startedHidden);
    // Not unconditional any more: re-applying it on every launch overrode a user who disabled
    // Tunnelview in Task Manager → Startup apps. Later changes go through the settings 'change' handler.
    reconcileLoginItem();
    tailscaleReady.then(() => {
      syncHost();
      checkFirewall(); // background; never blocks startup
      registerScreenCapture();
      prepareReceiveDir();
    });

    if (powerMonitor && typeof powerMonitor.on === 'function') {
      powerMonitor.on('shutdown', () => app.quit()); // macOS/Linux: allow a graceful bye
    }
    stateChanged();
  }).catch((err) => {
    console.error('[main] startup failed:', err);
    try { dialog.showErrorBox('Tunnelview failed to start', String((err && err.stack) || err)); } catch { /* ignore */ }
    app.exit(1);
  });
}
