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
 *                                  port:number },   // the signaling port Tunnelview answered on
 *                probe: null | 'ok' | 'not-allowed' | 'refused' | 'timeout' | 'incompatible' | 'error' }
 *                  // null = not probed; ok = Tunnelview answered (tunnelview set); not-allowed =
 *                  // Tunnelview answered 403: its Who-can-connect excludes this device (tunnelview
 *                  // stays null; the port is still remembered for connect); refused = nothing
 *                  // listening; timeout = no answer (ACL / firewall / slow relay); incompatible =
 *                  // Tunnelview with another protocol version; error = anything else
 *   PublicSettings = settings (ARCHITECTURE §8) with `password` removed and `passwordSet: bool` added,
 *                    plus `effectiveDownloadDir: string`.
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
   */
  connect: (opts) => ipcRenderer.invoke('session:connect', opts),
  /** Bring a running viewer window to the front. id = AppState.viewers[].id. @returns {Promise<{ok:boolean}>} */
  focusViewer: (id) => ipcRenderer.invoke('viewer:focus', Number(id)),

  /** @returns {Promise<PublicSettings>} */
  getSettings: () => ipcRenderer.invoke('settings:get'),
  /**
   * Partial update; returns the validated, persisted settings. @returns {Promise<PublicSettings>}
   * While an incoming session is active (AppState.host.session !== null) a change to acceptMode,
   * allowFrom, allowList, autoAcceptSameUser, defaultPermissions or downloadDir REJECTS with
   * 'Disconnect the remote session to change security settings.' (other keys still apply).
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
});
