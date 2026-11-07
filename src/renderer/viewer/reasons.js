/*
 * Tunnelview viewer — human-friendly text for every way a session can end.
 * Reasons come from main (ARCHITECTURE §7 viewer phases: unreachable|not-tunnelview|timeout|protocol|
 * denied:<reason>|host-ended|network|not-tailnet|not-tailnet-route|rate-limited) or are raised
 * locally by the viewer (local, media-failed, media-timeout, non-tailnet-path, reconnect-failed,
 * init-failed).
 *
 * When the HOST ends the session, main reports reason 'host-ended' plus the host's own `bye`
 * reason as `hostReason`. viewer.js shows that more specific reason instead of the generic
 * "<host> ended the session" when it is one of HOST_REASONS (produced by the host panel and
 * host-server: capture failures, ICE/connection failures, a tailnet-path abort, Tailscale stopping).
 * Also controlBlockReason(): why remote control is unavailable during a session (toolbar / chip).
 * Pure; unit-tested from Node (test/viewer-validate.test.js).
 *
 * describeClose returns { title, message, tone:'danger'|'warn'|'info', icon, detail? } — icon is a
 * ui.js icon name. Without `detail` the viewer shows main's status message as the detail line;
 * `detail: ''` means the message already says everything main's text does (no detail line).
 */

const UDP_HINT = 'Make sure your Tailscale ACLs allow UDP 47801–47899 between the two devices.';

/**
 * The "Try again in …." sentence of main's status message (viewer-client: ' Try again in 29
 * seconds.', ' Try again in about 2 minutes.', ' Try again in 15 minutes.'), or ''.
 */
export function retrySentence(msg) {
  return ((/Try again in [^.]+\./).exec(typeof msg === 'string' ? msg : '') || [''])[0];
}

/** Host `bye` reasons that describeClose explains better than "<host> ended the session". */
export const HOST_REASONS = new Set([
  'capture-failed', 'capture-ended', 'capture-blocked',
  'connection-lost', 'connection-failed', 'connection-timeout', 'negotiation-failed', 'media-failed', 'setup-failed',
  'non-tailnet-path', 'host-stopped', 'host-ended',
]);

/** Reason to display for a 'closed' status: the host's own reason when it is a known one. */
export function effectiveCloseReason(reason, hostReason) {
  return reason === 'host-ended' && typeof hostReason === 'string' && HOST_REASONS.has(hostReason) ? hostReason : reason;
}

/**
 * Why remote control is unavailable right now, as the end of "View only — …" ('' = available).
 * No control while the picture is not live either: during an ICE outage (`unstable`) the input
 * channel stays open, so clicks and keys would queue up and run on the host all at once on
 * recovery, against a screen the user never saw; a stalled decoder (`videoStalled`) freezes the
 * picture the same way.
 * @param {{control:boolean, controlAllowed?:boolean, unstable?:boolean, videoStalled?:boolean, inputOpen:boolean, host?:string}} s
 */
export function controlBlockReason({ control, controlAllowed, unstable, videoStalled, inputOpen, host }) {
  if (!control) return 'the host turned remote control off';
  if (controlAllowed === false) return `input isn't available on ${host || 'the remote device'}`;
  if (unstable) return 'the connection is recovering';
  if (videoStalled) return 'the video is stalled';
  if (!inputOpen) return 'the input channel is not ready';
  return '';
}

/**
 * @param {string} reason
 * @param {{host:string, user:string, hadVideo?:boolean, passwordSet?:boolean, message?:string}} ctx  (already-sanitized
 *        display strings; passwordSet = the host's hello info, undefined when unknown; message = main's status message)
 */
export function describeClose(reason, ctx) {
  const host = ctx && ctx.host ? ctx.host : 'the remote device';
  const user = ctx && ctx.user ? ctx.user : 'The person at the remote device';
  const retry = retrySentence(ctx && ctx.message);
  const r = typeof reason === 'string' ? reason : '';

  switch (r) {
    case 'unreachable':
      return { tone: 'danger', icon: 'plug', title: `Can't reach ${host}`,
        message: `${host} didn't answer over Tailscale. Check that it is online in your tailnet and that Tunnelview is running on it.` };
    case 'not-tunnelview':
      return { tone: 'danger', icon: 'alert', title: 'Tunnelview is not available there',
        message: `${host} answered, but Tunnelview isn't listening on that address (it may not be installed, hosting may be off, or it uses a different port).` };
    case 'timeout':
      return { tone: 'warn', icon: 'clock', title: 'Connection timed out',
        message: `${host} took too long to respond.` };
    case 'protocol':
      return { tone: 'danger', icon: 'alert', title: 'Incompatible versions',
        message: 'The two devices could not understand each other. Update Tunnelview on both devices and try again.' };
    case 'host-ended':
      return { tone: 'info', icon: 'info', title: 'Session ended',
        message: `${host} ended the session.` };

    // ---- host-side reasons (HOST_REASONS, reported as hostReason with 'host-ended') ----
    case 'capture-failed':
    case 'capture-ended':
      return { tone: 'danger', icon: 'monitor', title: 'Screen sharing failed',
        message: `${host} couldn't share its screen. If it's a Mac, allow Tunnelview under System Settings › Privacy & Security › Screen Recording on that Mac, then quit and reopen Tunnelview there.` };
    case 'capture-blocked':
      return { tone: 'warn', icon: 'lock', title: 'Screen recording needs approval',
        message: `${host} is waiting for someone at that Mac to allow screen recording (macOS asks for this from time to time).` };
    case 'host-stopped':
      return { tone: 'warn', icon: 'power', title: 'Remote access stopped',
        message: `Tailscale stopped or incoming connections were turned off on ${host}.` };
    case 'connection-lost':
      return describeClose('network', { ...(ctx || {}), host, hadVideo: true });
    case 'connection-failed':
    case 'connection-timeout':
    case 'negotiation-failed':
    case 'setup-failed':
      return describeClose('media-failed', ctx);

    case 'network':
      return ctx && ctx.hadVideo
        ? { tone: 'warn', icon: 'plug', title: 'Connection lost', message: `The connection to ${host} dropped.` }
        : { tone: 'warn', icon: 'plug', title: 'Connection lost', message: `The connection to ${host} was interrupted before the session started.` };
    case 'not-tailnet':
      return { tone: 'danger', icon: 'shield', title: 'Not in your tailnet',
        message: `${host} is not a device in your Tailscale network, so Tunnelview refused to connect. Tunnelview only connects to Tailscale addresses.` };
    case 'not-tailnet-route': // the target is a tailnet device, but this computer routed the connection elsewhere
      return { tone: 'danger', icon: 'shield', title: "Connection didn't go through Tailscale",
        message: `Your computer routed the connection to ${host} outside Tailscale, so Tunnelview stopped before sending anything. Another network or VPN may be using Tailscale's address range (100.64.0.0/10), or Tailscale may still be starting. Check that Tailscale is connected and try again.` };
    case 'rate-limited': // HTTP 429: too many connection attempts from this address (not a password lock)
      return { tone: 'warn', icon: 'clock', title: 'Too many attempts',
        message: `This device tried to connect to ${host} too often. Wait a minute and try again.`, detail: '' };
    case 'non-tailnet-path':
      return { tone: 'danger', icon: 'shield', title: 'Stopped to protect your session',
        message: 'The video connection tried to use a path outside your Tailscale network, so Tunnelview ended the session.' };
    case 'media-failed':
      return { tone: 'danger', icon: 'monitor', title: "Video couldn't start",
        message: `Tunnelview couldn't open a direct encrypted connection to ${host} over Tailscale. ${UDP_HINT}` };
    case 'media-timeout':
      return { tone: 'danger', icon: 'monitor', title: "Video didn't start",
        message: `Access was granted, but no video arrived from ${host}. ${UDP_HINT}` };
    case 'reconnect-failed':
      return { tone: 'danger', icon: 'refresh', title: "Couldn't reconnect",
        message: `Starting a new connection to ${host} failed. Check that Tailscale is running and try again.` };
    case 'init-failed':
      return { tone: 'danger', icon: 'alert', title: "Couldn't start the session",
        message: 'The viewer could not be initialized. Close this window and connect again from Tunnelview.' };
    case 'local':
    case 'viewer-closed':
    case 'viewer-cancelled':
      return { tone: 'info', icon: 'check', title: 'Disconnected',
        message: `You ended the session with ${host}.` };

    // ---- denied:<reason> (host admission, ARCHITECTURE §4) ----
    case 'denied:rejected':
      return { tone: 'warn', icon: 'x', title: 'Request declined',
        message: `${user} declined your request to connect to ${host}.` };
    case 'denied:timeout':
      return { tone: 'warn', icon: 'clock', title: 'No answer',
        message: `Nobody accepted the request on ${host} in time.` };
    case 'denied:auth-timeout':
      return { tone: 'warn', icon: 'clock', title: 'Password prompt timed out',
        message: "The password wasn't entered in time. Reconnect to try again." };
    case 'denied:busy':
      return { tone: 'warn', icon: 'users', title: `${host} is busy`,
        message: 'Another session is already active (or another request is waiting) on that device. Try again in a moment.' };
    case 'denied:not-allowed':
      return { tone: 'danger', icon: 'shield', title: 'Not allowed',
        message: `${host} only accepts connections from specific people or devices, and this device or your account isn't on its list. Ask its owner to add you under Who can connect (a short device name there only matches devices of its own tailnet).` };
    case 'denied:bad-password':
      return { tone: 'danger', icon: 'lock', title: 'Wrong password',
        message: 'Too many incorrect password attempts on this connection.' };
    case 'denied:password-required':
      if (ctx && ctx.passwordSet === false) {
        return { tone: 'warn', icon: 'lock', title: 'Password required',
          message: `${host} only accepts password connections, but no password has been set there yet. Ask its owner to set one or switch to 'Ask every time'.` };
      }
      return { tone: 'warn', icon: 'lock', title: 'Password required',
        message: `${host} only accepts connections with its password. Reconnect and enter it when asked.` };
    case 'denied:locked': // per device / per Tailscale account / all tagged devices together
      return { tone: 'danger', icon: 'lock', title: 'Temporarily locked',
        message: `Too many failed password attempts from this device or your Tailscale account (tagged devices share one limit). ${retry || 'Try again in 15 minutes.'}`,
        detail: '' };
    case 'denied:suspended': // host-wide: many failures from several devices, not necessarily this one
      return { tone: 'warn', icon: 'lock', title: `Passwords paused on ${host}`,
        message: `${host} has stopped accepting passwords for up to 15 minutes after many failed attempts from several devices. Trusted devices, and requests the person there accepts, still work.` };
    case 'denied:try-later': // prompt back-off or prompt rate limit; the exact wait comes from main's message
      return { tone: 'warn', icon: 'clock', title: 'Try again later',
        message: `${host} isn't taking new requests from this device right now: a recent request was declined or not answered there, or this device asked several times in a few minutes. ${retry || 'Try again in a few minutes.'}`,
        detail: '' };
    case 'denied:protocol':
      return { tone: 'danger', icon: 'alert', title: 'Request rejected',
        message: `${host} rejected the request because of a protocol error. Update Tunnelview on both devices.` };
    case 'denied:disabled':
      return { tone: 'warn', icon: 'power', title: 'Incoming connections are off',
        message: `Remote access is turned off on ${host}.` };
    default:
      break;
  }
  if (r.startsWith('denied:')) {
    return { tone: 'warn', icon: 'x', title: 'Request denied', message: `${host} refused the connection.` };
  }
  return { tone: 'info', icon: 'info', title: 'Session ended', message: `The session with ${host} has ended.` };
}
