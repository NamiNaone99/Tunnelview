'use strict';
/*
 * Preload for the MAIN window → window.tunnelview
 * Contract: docs/ARCHITECTURE.md §6. Main-side handlers: src/main/ipc.js.
 *
 * Shapes
 *   AppState = {
 *     version: string, platform: 'windows'|'macos',
 *     tailscale: { state:'running'|'stopped'|'needs-login'|'not-installed'|'error', message:string,
 *                  self: TsSelf|null, magicDnsSuffix:string|null },
 *     host: { enabled:bool, listening:bool, addresses:string[], port:number, error:string|null,
 *             warning: string|null,   // listening but probably unreachable (e.g. a Windows Firewall
 *                                     // inbound Block rule for this program); shown even while listening
 *             session: null | { id, peer:{ip,hostname,os,user:{login,displayName}}, startedAt:number, via:string },
 *             pending: bool },
 *     viewers: [{ id:number, hostname:string, phase:string }],
 *     permissions: { screen:'granted'|'denied'|'not-determined'|'restricted'|'unknown'|'n/a',
 *                    accessibility:'granted'|'denied'|'n/a' },
 *     input: { available:bool, reason:string|null }
 *   }
 *   TsSelf = { id, stableId, hostname, dnsName, shortName, os, ips:string[], user:{login,displayName} }
 *   PeerInfo = { id, stableId, hostname, dnsName, shortName, os, ips:string[], online:bool, lastSeen:string|null,
 *                user:{login,displayName}, tags:string[], favorite:bool,
 *                tunnelview: null | { version, os, passwordSet:bool, acceptMode:string, busy:bool,
 *                                  updating:bool,   // busy because it installs a Tunnelview update
 *                                  port:number },   // the signaling port Tunnelview answered on
 *                probe: null | 'ok' | 'not-allowed' | 'refused' | 'timeout' | 'incompatible' | 'error' }
 *                  // null = not probed; ok = Tunnelview answered (tunnelview set); not-allowed =
 *                  // Tunnelview answered 403: its Who-can-connect excludes this device (tunnelview
 *                  // stays null; the port is still remembered for connect); refused = nothing
 *                  // listening; timeout = no answer (ACL / firewall / slow relay); incompatible =
 *                  // Tunnelview with another protocol version; error = anything else
 *   PublicSettings = settings (ARCHITECTURE §8) with `password` removed and `passwordSet: bool` added,
 *                    plus `effectiveDownloadDir: string`.
 *   PairingOffer = { ok:true, offerId:string, link:string,   // tunnelview://pair/1/… (one offer's token)
 *                    qr:{ size:number, bits:string },          // modules per side (no quiet zone); base64,
 *                                                              // row-major, MSB first, 1 = dark
 *                    expiresAt:number,                         // ms since the epoch (2 minutes)
 *                    fingerprint:string,                       // TV-XXXX-XXXX-XXXX-XXXX-XXXX
 *                    host:{ name:string, ips:string[], port:number } }   // what the link names
 *                                                              // (name '' = no MagicDNS name in it)
 *                | { ok:false, code:'SESSION_ACTIVE'|'HOSTING_OFF'|'TS_DOWN'|'NO_IDENTITY' }
 *   PairingStatus = { offerId:string, phase:'paired'|'attempt-failed'|'expired'|'cancelled'|'failed',
 *                     reason?:string,   // cancelled: cancelled|replaced|session|host-stopped|
 *                                       // host-id-changed|identity-reset; failed: too-many-attempts
 *                     peer?:{ name:string, login:string, os:string } }   // paired / attempt-failed:
 *                                       // who tried, as Tailscale whois knows them
 *   IdentityInfo = { available:bool, fingerprint:string|null, wasReset:bool,
 *                    error?:string }   // while unavailable: CORRUPT|READ_FAILED|VERSION|WRITE_FAILED|MISSING|NOT_LOADED|…
 *   The identity key itself never reaches this window.
 *   UpdateState = {   // in-app updates (src/main/updater.js; DECISIONS U1-U6)
 *     status: 'idle'           // nothing checked yet in this run
 *           | 'checking' | 'up-to-date'
 *           | 'available'      // latest is set, not downloaded
 *           | 'downloading'    // progress is set
 *           | 'ready'          // latest is downloaded and verified: offer "Restart and install"
 *           | 'installing'     // see phase; on success Tunnelview quits
 *           | 'error',         // error is set; latest / downloaded keep what was known, so
 *                              // Download / Install can still be offered
 *     phase: null | 'preparing' | 'waiting-for-approval' | 'quitting',   // installing only
 *                              // (waiting-for-approval: Windows UAC prompt, may stay open long)
 *     currentVersion: string, platform: 'windows'|'macos'|'other',
 *     supported: bool,         // this build can install by itself (packaged; Windows x64/arm64
 *                              // installed by its installer, with elevate.exe, updates on a local
 *                              // disk; or macOS); otherwise point to the releases page
 *     installBlocked: null | { code:string, message:string },   // macOS: where this copy runs
 *                              // from it cannot replace itself (TRANSLOCATED, READ_ONLY_LOCATION,
 *                              // NOT_WRITABLE, NOT_OWNER, SHARED_LOCATION): offer the download
 *                              // only, then show it in Finder, with the message
 *     autoCheck: bool,         // settings.autoUpdateCheck
 *     lastCheckAt: number|null,// ms since the epoch of the last completed check
 *     latest: null | { version:'X.Y.Z', date:string (ISO), notes:string, size:number },
 *                              // notes: plain text, may contain \n and \t; render as text only
 *     downloaded: bool,
 *     progress: null | { received:number, total:number, percent:0..100 },
 *     error: null | { code:string, message:string },   // message: English, ready to show
 *     blocked: null | 'INCOMING_SESSION'|'INCOMING_REQUEST'|'OUTGOING_SESSION'|'SESSION_ACTIVE',
 *                              // install would be refused right now, and why
 *     justUpdated: null | { from:string, to:string } } // this start follows an in-app update
 *                              // (macOS: Screen Recording / Accessibility must be allowed again)
 *   UpdateResult = { ok:true } | { ok:false, code:string, message:string }
 */
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('tunnelview', {
  /** @returns {Promise<AppState>} */
  getState: () => ipcRenderer.invoke('app:get-state'),
  /** Pushed whenever any part of AppState changes. @returns unsubscribe fn */
  onState: (cb) => on('app:state', cb),

  /**
   * Tailnet devices from `tailscale status`, self excluded. When probe=true, online peers are
   * probed (GET /tunnelview/v1/info, 1.5 s timeout, max 8 concurrent) to fill `tunnelview`.
   * @param {{probe?: boolean}} [opts] @returns {Promise<PeerInfo[]>}
   */
  listPeers: (opts) => ipcRenderer.invoke('peers:list', opts || {}),

  /**
   * Open a viewer window and connect. target = peer stableId, hostname, MagicDNS name or Tailscale IP
   * (optionally with :port; without one, main picks the port Tunnelview was found on, a recent
   * connection's port, or probes this device's custom port and the default).
   * @returns {Promise<{ok:boolean, existing?:boolean, error?:string, code?:string}>}
   * existing: true → a viewer window for that device was already open and was brought to the front.
   * code: 'NOT_TAILNET' | 'NOT_FOUND' | 'TS_DOWN' | 'SELF_HOST_DISABLED'
   *       | 'AMBIGUOUS' (the name matches several devices — use the full MagicDNS name or IP)
   *       | 'UPDATING' (an update is being installed on this computer; `error` says so)
   */
  connect: (opts) => ipcRenderer.invoke('session:connect', opts),
  /** Bring a running viewer window to the front. id = AppState.viewers[].id. @returns {Promise<{ok:boolean}>} */
  focusViewer: (id) => ipcRenderer.invoke('viewer:focus', Number(id)),

  /** @returns {Promise<PublicSettings>} */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  /**
   * Partial update; returns the validated, persisted settings. @returns {Promise<PublicSettings>}
   * While an incoming session is active (AppState.host.session !== null) a change to acceptMode,
   * allowFrom, allowList, autoAcceptSameUser, defaultPermissions, downloadDir or autoUpdateCheck
   * REJECTS with 'Disconnect the remote session to change security settings.' (other keys still
   * apply). password, loginItemApplied and lastUpdateCheckAt cannot be written from here.
   */
  updateSettings: (partial) => ipcRenderer.invoke('settings:update', partial),
  /**
   * Set (string, 8–128 chars) or clear (null) the unattended-access password.
   * Refused ({ok:false, error:'Disconnect the remote session to change security settings.'})
   * while an incoming session is active. @returns {Promise<{ok:boolean, error?:string}>}
   */
  setPassword: (password) => ipcRenderer.invoke('settings:set-password', password),
  /** Folder picker for incoming files; null when cancelled or while an incoming session is active. @returns {Promise<string|null>} */
  chooseDownloadDir: () => ipcRenderer.invoke('settings:choose-download-dir'),

  /**
   * Start a pairing offer for a phone (replaces any live one). Refused with a code while an
   * incoming session is active, hosting is off / not listening, Tailscale is down, or the identity
   * is unavailable. @returns {Promise<PairingOffer>}
   */
  startPairing: () => ipcRenderer.invoke('pairing:start'),
  /** Withdraw that offer (only that one: a newer offer stays). @returns {Promise<{ok:boolean}>} */
  cancelPairing: (offerId) => ipcRenderer.invoke('pairing:cancel', String(offerId)),
  /** What happened to an offer. @param {(s: PairingStatus) => void} cb @returns unsubscribe fn */
  onPairingStatus: (cb) => on('pairing:status', cb),
  /** @returns {Promise<IdentityInfo>} */
  getIdentity: () => ipcRenderer.invoke('security:identity'),
  /**
   * New identity key: every paired phone must pair again. Cancels a live pairing offer. Refused
   * ({ok:false, code:'SESSION_ACTIVE', message:'Disconnect the remote session to change security
   * settings.'}) while an incoming session is active; code 'WRITE_FAILED' when the new key could
   * not be stored (the old one stays). `error` is always IdentityInfo's (the key's error code).
   * @returns {Promise<{ok:boolean, code?:string, message?:string} & IdentityInfo>}
   */
  resetIdentity: () => ipcRenderer.invoke('security:reset-identity'),
  /**
   * Load the identity file again (after its cause was fixed). Never a new key once a key file has
   * existed in this run: with both files gone the error is 'MISSING' (Reset identity… makes one).
   * @returns {Promise<IdentityInfo>}
   */
  retryIdentity: () => ipcRenderer.invoke('security:retry-identity'),

  /**
   * macOS: trigger the system prompt. kind: 'screen'|'accessibility'. For 'screen' this also adds
   * Tunnelview to the Screen Recording list and opens that System Settings pane while not granted
   * (offer it whenever permissions.screen !== 'granted'). @returns {Promise<string>} new status
   */
  requestPermission: (kind) => ipcRenderer.invoke('permissions:request', kind),
  /** macOS: open the matching System Settings pane. */
  openPermissionSettings: (kind) => ipcRenderer.invoke('permissions:open', kind),
  /** Quit & reopen Tunnelview (macOS applies a Screen Recording grant only after a restart). @returns {Promise<{ok:boolean}>} */
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),

  copyText: (text) => ipcRenderer.invoke('app:copy-text', String(text)),
  /** Opens https://login.tailscale.com/admin/machines in the default browser. */
  openTailscaleAdmin: () => ipcRenderer.invoke('app:open-tailscale-admin'),
  /** Opens https://tailscale.com/download in the default browser. @returns {Promise<{ok:boolean}>} */
  openTailscaleDownload: () => ipcRenderer.invoke('app:open-tailscale-download'),
  /** Starts / brings up the local Tailscale client app (to start it or sign in). @returns {Promise<{ok:boolean, error?:string}>} */
  openTailscale: () => ipcRenderer.invoke('app:open-tailscale'),
  /** Polls `tailscale status` now (≤ 5 s) instead of returning the cached state. @returns {Promise<AppState>} */
  refreshTailscale: () => ipcRenderer.invoke('tailscale:refresh'),
  openDownloads: () => ipcRenderer.invoke('files:open-folder'),
  /** End the active incoming session (host side) from the main window. */
  endHostSession: () => ipcRenderer.invoke('host:end-session'),
  quit: () => ipcRenderer.send('app:quit'),

  /* In-app updates. The only traffic outside the tailnet: main process, HTTPS GET to GitHub. */
  /** @returns {Promise<UpdateState>} */
  getUpdateState: () => ipcRenderer.invoke('update:get-state'),
  /** Check GitHub now (always allowed). Resolves when the check is over. @returns {Promise<UpdateState>} */
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  /**
   * Download and verify UpdateState.latest. Resolves when it is verified (ok) or failed; progress
   * arrives through onUpdateState meanwhile. @returns {Promise<UpdateResult>}
   */
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  /**
   * Stop a running download (its downloadUpdate() then answers {ok:false, code:'CANCELLED'} and
   * the state goes back to 'available'). @returns {Promise<UpdateResult>}
   */
  cancelUpdate: () => ipcRenderer.invoke('update:cancel'),
  /**
   * Install the downloaded update (only ever from the user's click). Refused with the reason
   * (code = UpdateState.blocked) during an incoming session, a pending incoming request or an
   * outgoing session. Windows: resolves after the UAC prompt is answered ({ok:true}: Tunnelview
   * quits now; code 'UAC_DECLINED' when declined). macOS: resolves once the helper runs, then
   * Tunnelview quits and reopens updated. @returns {Promise<UpdateResult>}
   */
  installUpdate: () => ipcRenderer.invoke('update:install'),
  /**
   * Turn the daily check on / off (settings.autoUpdateCheck). Refused ({ok:false,
   * code:'SETTINGS_LOCKED', message}) while an incoming session is active. @returns {Promise<UpdateResult>}
   */
  setAutoUpdateCheck: (enabled) => ipcRenderer.invoke('update:set-auto', enabled === true),
  /** Show the downloaded update file in Explorer / Finder. @returns {Promise<UpdateResult>} */
  revealUpdate: () => ipcRenderer.invoke('update:reveal'),
  /** Open https://github.com/NamiNaone99/Tunnelview/releases/latest in the browser. @returns {Promise<{ok:boolean}>} */
  openReleasesPage: () => ipcRenderer.invoke('update:open-releases'),
  /** Pushed on every update state change. @param {(s: UpdateState) => void} cb @returns unsubscribe fn */
  onUpdateState: (cb) => on('update:state', cb),
});
