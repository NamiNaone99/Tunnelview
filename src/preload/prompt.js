'use strict';
/*
 * Preload for the incoming-connection PROMPT → window.tunnelviewPrompt
 * Contract: docs/ARCHITECTURE.md §4 (admission) and §6.
 *
 *   PromptInit = {
 *     requestId: string,
 *     peer:   { ip, hostname, os, user:{login,displayName}, stableId, sameUser:bool, isSelf:bool,
 *               tags:string[] },  // Tailscale ACL tags (≤ 8 × ≤ 64 chars, [] = untagged). Tagged
 *                                 // nodes are never trusted: hide "Always allow" for them.
 *     viewer: { hostname, os, version },
 *     timeoutSec: number,            // countdown; main auto-denies with 'timeout' at zero
 *     defaults: { control, clipboard, files, audio },
 *     audioSupported: bool,
 *     hostOs: 'windows'|'macos'
 *   }
 */
const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const listener = (_event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('tunnelviewPrompt', {
  /** @returns {Promise<PromptInit>} */
  ready: () => ipcRenderer.invoke('prompt:ready'),
  /**
   * @param {{accept:boolean, permissions?:{control,clipboard,files,audio}, trust?:boolean}} answer
   * trust=true adds the peer's node stableId to settings.trustedNodes (future auto-accept);
   * ignored for self, tagged nodes and nodes without a stableId.
   */
  respond: (answer) => ipcRenderer.invoke('prompt:respond', answer),
  /** Request vanished (viewer left, password accepted, timeout). Window will be closed by main. */
  onCancelled: (cb) => on('prompt:cancelled', cb),
});
