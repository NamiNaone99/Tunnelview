/*
 * Main window — warm up WebRTC while the window is hidden.
 *
 * The first RTCPeerConnection of the app blocks its renderer for ~1.3–2.7 s (WebRTC stack and
 * codec factories start up). For an unattended host that runs hidden in the tray / from a login
 * item, the first incoming session would pay that on its critical path, so pay it once here while
 * nobody can see this window — never while it is visible, so the UI the user sees never freezes.
 * Deliberately no createOffer / createDataChannel / setLocalDescription: no ICE gathering, no
 * sockets, and main's 'media' permission check stays denied for this window.
 *
 * `env` exists for tests only (defaults: the page's document and globals).
 */
export function warmRtcWhileHidden(env = {}) {
  const doc = env.document || document;
  const g = env.global || globalThis;
  let warmed = false;
  const hidden = () => doc.visibilityState === 'hidden';

  const run = () => {
    if (warmed || !hidden()) return; // shown again before we got idle time → wait for the next hide
    warmed = true;
    doc.removeEventListener('visibilitychange', schedule);
    try {
      g.RTCRtpSender.getCapabilities('video');
      new g.RTCPeerConnection({ iceServers: [] }).close();
    } catch { /* WebRTC unavailable — nothing to warm */ }
  };
  function schedule() {
    if (warmed || !hidden()) return;
    if (typeof g.requestIdleCallback === 'function') g.requestIdleCallback(run, { timeout: 3000 });
    else g.setTimeout(run, 500);
  }

  doc.addEventListener('visibilitychange', schedule);
  schedule();
  return { get warmed() { return warmed; } };
}
