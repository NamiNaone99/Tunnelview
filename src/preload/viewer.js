'use strict';
/*
 * Preload for VIEWER windows (outgoing session) → window.tunnelviewViewer
 * Contract: docs/ARCHITECTURE.md §4–§6. Main-side handlers: src/main/ipc.js.
 *
 * Lifecycle: the renderer calls ready() once its listeners are registered; main then starts the
 * ViewerSession (WebSocket to the host) and pushes status/signal events. Nothing is sent before ready().
 *
 *   ViewerInit = {
 *     target: { ip, port, hostname, os, user:{login,displayName}|null },
 *     localOs: 'windows'|'macos',
 *     viewOnly: bool,
 *     settings: { quality, codec, clipboardSync, swapCmdCtrl }
 *   }
 *   ViewerStatus = { phase: 'connecting'|'hello'|'auth-required'|'waiting'|'accepted'|'closed',
 *                    host?: {hostname, os, user:{login,displayName}, passwordSet, acceptMode},
 *                    remaining?: number,                 // auth-required after a failed attempt
 *                    sessionId?: string, permissions?: {control,clipboard,files,audio},  // accepted
 *                    reason?: string, message?: string,  // closed
 *                    hostReason?: string,                // closed + reason 'host-ended': the host's own
 *                        // bye reason (≤ 64 chars, /^[a-z0-9][a-z0-9:_-]*$/), e.g. 'host-ended',
 *                        // 'capture-failed', 'non-tailnet-path', 'media-timeout', 'media-failed'
 *                    proofSent?: boolean }               // closed: this connection sent a password
 *                        // proof (main forgets a remembered password on 'denied:locked' only then;
 *                        // the renderer ignores it)
 *                    host.hostname / host.user are Tailscale-verified (MagicDNS name, tailnet owner),
 *                    not what the remote device says about itself.
 *   ClipboardItem = { kind:'text', text:string } | { kind:'image', png: Uint8Array }
 */
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('tunnelviewViewer', {
  /** Register listeners first, then call ready(). @returns {Promise<ViewerInit>} */
  ready: () => ipcRenderer.invoke('viewer:ready'),
  onStatus: (cb) => on('viewer:status', cb),
  /** Signaling from host: {t:'sdp', description} | {t:'ice', candidate} */
  onSignal: (cb) => on('viewer:signal', cb),
  /** Host changed permissions mid-session: {control,clipboard,files,audio} */
  onPermissions: (cb) => on('viewer:permissions', cb),
  /** Signaling to host — only {t:'sdp'} and {t:'ice'} are forwarded. */
  sendSignal: (msg) => ipcRenderer.send('viewer:signal', msg),
  /**
   * Password for unattended access (also valid while waiting for the host user).
   * {ok:true} = sent (the verdict arrives as status 'accepted' / 'auth-required' with remaining);
   * {ok:false, error} = not sent. Main reuses it for Reconnect only after the host accepted it.
   * @returns {Promise<{ok:boolean, error?:string}>}
   */
  submitPassword: (password) => ipcRenderer.invoke('viewer:submit-password', String(password)),
  /**
   * Re-run the connection (after phase 'closed'). The target is re-checked against the current
   * `tailscale status` first; when refused, a 'closed' status ('unreachable' | 'not-tailnet') is
   * pushed before this resolves {ok:false}. @returns {Promise<{ok:boolean}>}
   */
  reconnect: () => ipcRenderer.invoke('viewer:reconnect'),
  /**
   * Tailscale path to the host: direct (peer-to-peer) or relayed through DERP (`relay` = region
   * code, e.g. 'fra'). direct is null when unknown. Cached 2 s in main.
   * @returns {Promise<{ok:true, direct:boolean|null, relay:string} | {ok:false}>}
   */
  getPathInfo: () => ipcRenderer.invoke('viewer:path-info'),
  /** Sends {t:'bye'} and closes the WebSocket. The window stays open (renderer may close itself via closeWindow). */
  disconnect: (reason) => ipcRenderer.send('viewer:disconnect', reason ? String(reason) : 'viewer-closed'),
  closeWindow: () => ipcRenderer.send('viewer:close-window'),

  setTitle: (title) => ipcRenderer.send('viewer:set-title', String(title)),
  /** @returns {Promise<boolean>} new fullscreen state */
  setFullscreen: (on_) => ipcRenderer.invoke('viewer:set-fullscreen', !!on_),
  onFullscreen: (cb) => on('viewer:fullscreen', cb),
  /** Save a PNG (Uint8Array) to <Pictures>/Tunnelview. @returns {Promise<{ok:boolean, path?:string, error?:string}>} */
  saveScreenshot: (png) => ipcRenderer.invoke('viewer:save-screenshot', png),
  /** Persist viewer-side prefs. Allowed keys: quality, codec, clipboardSync, swapCmdCtrl. */
  updatePrefs: (partial) => ipcRenderer.invoke('viewer:update-prefs', partial),

  /* ---- clipboard (local machine) ---- */
  /** Enable/disable local clipboard watching for this window. */
  setClipboardSync: (enabled) => ipcRenderer.send('clipboard:sync', !!enabled),
  /** Local clipboard changed (only while sync is enabled). cb(ClipboardItem) */
  onClipboard: (cb) => on('clipboard:changed', cb),
  /** Write remote clipboard content locally (echo-suppressed). @returns {Promise<{ok:boolean}>} */
  writeClipboard: (item) => ipcRenderer.invoke('clipboard:write', item),

  /* ---- incoming files (local disk) ---- */
  /** Only purpose 'file' (clipboard images are assembled in the renderer → writeClipboard).
   *  @param {{id:string,name:string,size:number,purpose:'file',mime?:string}} meta @returns {Promise<{ok:boolean, reason?:string}>} */
  fileBegin: (meta) => ipcRenderer.invoke('files:begin', meta),
  /** @param {string} id @param {Uint8Array} data */
  /** @param {string} id @param {Uint8Array} data
   *  @returns {Promise<{ok:true} | {ok:false, reason:string}>} resolves AFTER the bytes are on disk
   *  (flow control: keep few chunks outstanding; {ok:false} = the transfer failed, e.g. 'no-space'). */
  fileChunk: (id, data) => ipcRenderer.invoke('files:chunk', String(id), data),
  /** @returns {Promise<{ok:boolean, path?:string, reason?:string}>} */
  fileEnd: (id) => ipcRenderer.invoke('files:end', String(id)),
  fileAbort: (id) => ipcRenderer.send('files:abort', String(id)),
  /** Show a received file in Explorer/Finder. */
  fileReveal: (id) => ipcRenderer.invoke('files:reveal', String(id)),
  openDownloads: () => ipcRenderer.invoke('files:open-folder'),

  notify: (title, body) => ipcRenderer.send('app:notify', { title: String(title), body: String(body || '') }),
});
