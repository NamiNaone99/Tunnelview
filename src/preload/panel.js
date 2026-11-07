'use strict';
/*
 * Preload for the host SESSION PANEL (incoming session) → window.tunnelviewPanel
 * The panel is a small visible always-on-top window that ALSO runs the host side of WebRTC:
 * screen capture (getDisplayMedia), RTCPeerConnection, data channels, input forwarding.
 * Contract: docs/ARCHITECTURE.md §3–§6. Main-side handlers: src/main/ipc.js.
 *
 *   PanelInit = {
 *     sessionId: string,
 *     peer:   { ip, hostname, os, user:{login,displayName}, stableId, sameUser:bool, isSelf:bool,
 *               tags:string[] },   // Tailscale ACL tags of the viewer's node (≤ 8 × ≤ 64 chars; [] = untagged)
 *     viewer: { hostname, os, version },
 *     via: 'password'|'prompt'|'trusted'|'same-user'|'self',
 *     startedAt: number,
 *     permissions: { control, clipboard, files, audio },
 *     settings: { quality, codec, clipboardSync },
 *     displays: Display[], initialDisplayId: string,
 *     audioSupported: bool,
 *     hostOs: 'windows'|'macos',
 *     input: { available:bool, reason:string|null }
 *   }
 *   Display = { id:string, name:string, primary:bool, width:number, height:number, scaleFactor:number }
 *             (width/height in physical pixels)
 */
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('tunnelviewPanel', {
  /**
   * Register listeners first, then call ready(). Main flushes queued viewer signals after this.
   * A panel pre-created (hidden) while the prompt shows gets its reply only once the request is
   * accepted; ready() resolves null when the request is declined, cancelled or times out (the
   * window is then destroyed): start nothing. Create the session RTCPeerConnection only after
   * ready() resolved a PanelInit. It rejects only on real failures.
   * @returns {Promise<PanelInit|null>}
   */
  ready: () => ipcRenderer.invoke('panel:ready'),
  /** Signaling from viewer: {t:'sdp', description} | {t:'ice', candidate} */
  onSignal: (cb) => on('panel:signal', cb),
  /** Only {t:'sdp'} and {t:'ice'} are forwarded to the viewer. */
  sendSignal: (msg) => ipcRenderer.send('panel:signal', msg),

  /** @returns {Promise<Display[]>} */
  listDisplays: () => ipcRenderer.invoke('panel:list-displays'),
  /**
   * Choose which display the NEXT navigator.mediaDevices.getDisplayMedia() call captures. Call
   * before every getDisplayMedia(). Does NOT move remote input (except the session's initial
   * display, which main maps itself): call commitDisplay(id) once the new stream is live.
   * sourceId = desktopCapturer source id, for the legacy fallback
   *   getUserMedia({video:{mandatory:{chromeMediaSource:'desktop', chromeMediaSourceId: sourceId}}})
   * when getDisplayMedia() is unavailable/rejected.
   * @returns {Promise<{ok:boolean, display?:Display, sourceId?:string, error?:string}>}
   */
  selectDisplay: (id) => ipcRenderer.invoke('panel:select-display', String(id)),
  /**
   * The stream of display `id` (1–64 chars) now reaches the viewer: map remote input onto it.
   * When `id` is gone (main fell back to another display because it vanished), nothing is mapped
   * and `served` names the display main last served to getDisplayMedia() (listDisplays id
   * format, null if none): commit `served` and adopt it as the current display.
   * @returns {Promise<{ok:true} | {ok:false, error:'not-found', served:string|null}>}
   */
  commitDisplay: (id) => ipcRenderer.invoke('panel:commit-display', String(id)),

  /** Forward one `input` data-channel message (parsed object). Main enforces permissions.control. */
  input: (evt) => ipcRenderer.send('panel:input', evt),
  releaseAll: () => ipcRenderer.send('panel:release-all'),
  /**
   * @returns {Promise<{available:boolean, reason:string|null, blocked:null|'secure-desktop'|'elevated-window'}>}
   * blocked: input is currently being dropped by the OS (Windows UIPI: an elevated window or the
   * secure desktop has the focus) — tell the viewer (host-state inputBlocked).
   */
  inputStatus: () => ipcRenderer.invoke('panel:input-status'),

  /** Host user toggles permissions. Main persists for this session + notifies the viewer. @returns {Promise<Permissions>} */
  setPermissions: (perms) => ipcRenderer.invoke('panel:set-permissions', perms),
  /** Permissions changed elsewhere (e.g. main window). */
  onPermissions: (cb) => on('panel:permissions', cb),

  /** Host user ends the session. */
  endSession: (reason) => ipcRenderer.send('panel:end', reason ? String(reason) : 'host-ended'),
  /** Main reports the session is over (viewer left / network). Renderer must stop capture + close pc. cb({reason}) */
  onEnded: (cb) => on('panel:ended', cb),
  /** Resize between compact (false) and expanded with chat/files (true). */
  setExpanded: (expanded) => ipcRenderer.send('panel:set-expanded', !!expanded),
  minimize: () => ipcRenderer.send('panel:minimize'),

  /* ---- clipboard (local machine) — main only delivers/accepts while permissions.clipboard ---- */
  setClipboardSync: (enabled) => ipcRenderer.send('clipboard:sync', !!enabled),
  onClipboard: (cb) => on('clipboard:changed', cb),
  writeClipboard: (item) => ipcRenderer.invoke('clipboard:write', item),

  /* ---- incoming files — main rejects while !permissions.files ---- */
  fileBegin: (meta) => ipcRenderer.invoke('files:begin', meta),
  /**
   * @param {string} id @param {Uint8Array} data
   * @returns {Promise<{ok:true} | {ok:false, reason:string}>} resolves AFTER the bytes are on disk
   * (flow control: keep few chunks outstanding; {ok:false} = the transfer failed, e.g. 'no-space').
   */
  fileChunk: (id, data) => ipcRenderer.invoke('files:chunk', String(id), data),
  fileEnd: (id) => ipcRenderer.invoke('files:end', String(id)),
  fileAbort: (id) => ipcRenderer.send('files:abort', String(id)),
  fileReveal: (id) => ipcRenderer.invoke('files:reveal', String(id)),
  openDownloads: () => ipcRenderer.invoke('files:open-folder'),

  notify: (title, body) => ipcRenderer.send('app:notify', { title: String(title), body: String(body || '') }),
});
