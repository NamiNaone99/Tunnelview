/*
 * Main window — in-app updates (DECISIONS U6): what Settings › Updates says and offers, the
 * confirmation before installing, and the small banner above Remote Desk.
 *
 * Main decides everything (src/main/updater.js; contract: UpdateState in src/preload/main.js).
 * This module only shows UpdateState and forwards the user's clicks. Nothing is installed without
 * a click and a confirmation, and release notes are rendered strictly as text.
 */
import { h, icon, toast, formatBytes } from '../shared/ui.js';
import {
  api, store, subscribe, errMsg, hasUpdateApi, setUpdateState, refreshUpdateState, setUpdateOp, updateAction,
} from './store.js';
import { openModal } from './dialogs.js';
import { preserveFocus } from './desk.js';

/** Why Install is refused right now (UpdateState.blocked). Same words as main's refusals. */
export const BLOCKED_TEXT = Object.freeze({
  INCOMING_SESSION: 'Someone is connected to this computer. Install the update after the session ends.',
  INCOMING_REQUEST: 'Someone is asking to connect to this computer. Install the update after you answer.',
  OUTGOING_SESSION: 'You are connected to another device. Install the update after you disconnect.',
  SESSION_ACTIVE: 'Install the update after the current session ends.',
});
export const NOT_SUPPORTED_TEXT = 'This copy of Tunnelview cannot update itself. Get the new version from the GitHub releases page.';

// Answers that leave UpdateState as it was, so the status line will not show them: toasted instead.
const REFUSALS = new Set([
  'BUSY', 'NOT_READY', 'NOT_AVAILABLE', 'NOT_SUPPORTED', 'BAD_REQUEST', 'SETTINGS_LOCKED', 'UNKNOWN',
  'INCOMING_SESSION', 'INCOMING_REQUEST', 'OUTGOING_SESSION', 'SESSION_ACTIVE', 'IN_USE_BY_OTHER_USER',
  'NOT_DOWNLOADING',
]);
// Failures after which the downloaded file is worth showing (install it by hand, or try later).
const REVEAL_AFTER = new Set([
  'UAC_DECLINED', 'LAUNCH_FAILED', 'TRANSLOCATED', 'READ_ONLY_LOCATION', 'NOT_WRITABLE', 'NOT_OWNER',
  'SHARED_LOCATION', 'INSTALL_INCOMPLETE', 'MAC_REPLACE_FAILED', 'MAC_APP_IN_USE',
]);
// Reported by main at the start after an install that did not take.
const NEXT_START_FAILURES = new Set(['INSTALL_INCOMPLETE', 'MAC_REPLACE_FAILED', 'MAC_APP_IN_USE']);
const WORKING = new Set(['checking', 'downloading', 'installing']);
/** This Mac refused the downloaded version (it needs a newer macOS): installing it again cannot work. */
const osTooOld = (u) => u.status === 'error' && !!u.error && u.error.code === 'OS_TOO_OLD';

/* ------------------------------------------------------------------ wording + buttons (pure) */

/**
 * The status line for an UpdateState: {tone, text, detail, progress, announce}.
 *   tone: '' | 'ok' | 'accent' | 'danger' | 'busy' (spinner)
 *   progress: 0..100 while downloading, else null
 *   announce: what the polite live region says when the status changes ('' = nothing). It never
 *             carries the percentage, so a download is not read out once per percent.
 */
export function describeUpdate(u) {
  const out = { tone: '', text: '', detail: '', progress: null, announce: '' };
  if (!u) return out;
  const v = u.latest ? u.latest.version : '';
  const mac = u.platform === 'macos';
  const blocked = u.supported && u.installBlocked ? u.installBlocked.message : '';
  const set = (tone, text, detail = '', announce = text) => Object.assign(out, { tone, text, detail, announce });
  switch (u.status) {
    case 'checking':
      return set('busy', 'Checking for updates…');
    case 'up-to-date':
      return set('ok', 'Up to date', u.currentVersion ? `Tunnelview ${u.currentVersion} is the newest version.` : '');
    case 'available': {
      const size = u.latest.size ? `Download size: ${formatBytes(u.latest.size)}.` : '';
      return set('accent', `Update ${v} available`,
        !u.supported ? NOT_SUPPORTED_TEXT : blocked ? `${size ? `${size} ` : ''}${blocked}` : size,
        `Update ${v} available.`);
    }
    case 'downloading': {
      const p = u.progress || { received: 0, total: 0, percent: 0 };
      set('busy', `Downloading ${p.percent}%`,
        p.total ? `${formatBytes(p.received)} of ${formatBytes(p.total)}` : '',
        `Downloading update ${v}…`);
      out.progress = p.percent;
      return out;
    }
    case 'ready':
      if (blocked) {
        // Verified, but this copy cannot replace itself where it runs: install it by hand, or move
        // the app (the message says how) and install from there.
        return set('ok', 'Downloaded', `Tunnelview ${v} is downloaded and verified. ${blocked}`, `Update ${v} is downloaded.`);
      }
      return set('ok', 'Ready to install', u.supported ? `Tunnelview ${v} is downloaded and verified.` : NOT_SUPPORTED_TEXT,
        `Update ${v} is ready to install.`);
    case 'installing':
      if (u.phase === 'waiting-for-approval') {
        return set('busy', 'Waiting for administrator permission…',
          'Answer the Windows permission prompt. If you can’t see it, look for its flashing button on the taskbar.');
      }
      if (u.phase === 'quitting') {
        return mac
          ? set('busy', 'Restarting Tunnelview…', 'Tunnelview opens again with the new version in a moment.')
          : set('busy', 'Closing Tunnelview to install the update…', 'Tunnelview opens again when the installer is done.');
      }
      return set('busy', 'Preparing the update…', mac ? 'Checking the downloaded app.' : 'Checking the downloaded installer.');
    case 'error':
      return set('danger', u.error ? u.error.message : 'The update failed.');
    default: // idle: nothing checked yet in this run
      return out;
  }
}

/**
 * Which buttons Settings › Updates shows and whether they work right now.
 *   check / primary: {enabled, busy}; busy buttons stay focusable (aria-disabled) so the keyboard
 *   focus survives a running check, download or install.
 *   primary.action: 'download' | 'install' | 'reveal' (downloaded, but this copy cannot replace
 *   itself where it runs: UpdateState.installBlocked) | 'releases' (this copy cannot update itself)
 *   hint: why Install has to wait ('' when it doesn't); reveal: offer "Show in folder";
 *   cancel: offer Cancel (a download runs); releases: offer the GitHub releases page as a
 *   secondary button.
 */
export function updatePlan(u, ops = {}) {
  const plan = { check: { enabled: false, busy: false }, primary: null, hint: '', reveal: false, cancel: false, releases: true };
  if (!u) return plan;
  const working = WORKING.has(u.status);
  const pending = !!(ops.check || ops.download || ops.install);
  const checkBusy = u.status === 'checking' || !!ops.check;
  const blockedHere = u.supported && !!u.installBlocked;
  plan.check = { enabled: !working && !pending, busy: checkBusy };
  if (u.latest && !osTooOld(u)) {
    const v = u.latest.version;
    if (!u.supported) {
      plan.primary = { action: 'releases', label: `Get ${v} from GitHub`, enabled: true, busy: false };
    } else if (u.status === 'installing' || ops.install) {
      plan.primary = { action: 'install', label: u.status === 'installing' ? 'Installing…' : 'Restart and install', enabled: false, busy: true };
    } else if (u.downloaded && blockedHere) {
      plan.primary = { action: 'reveal', label: revealLabel(u.platform), enabled: !working && !pending, busy: false };
    } else if (u.downloaded) {
      plan.primary = { action: 'install', label: 'Restart and install', enabled: !working && !pending && !u.blocked, busy: false };
    } else {
      const busy = u.status === 'downloading' || !!ops.download;
      plan.primary = { action: 'download', label: busy ? 'Downloading…' : 'Download and install', enabled: !working && !pending, busy };
      // Where it runs, this copy cannot replace itself: the download is all it can do.
      if (blockedHere && !busy) plan.primary.label = 'Download';
    }
    if (u.blocked && u.supported && !blockedHere && u.status !== 'installing') plan.hint = BLOCKED_TEXT[u.blocked] || BLOCKED_TEXT.SESSION_ACTIVE;
  }
  plan.reveal = !working && u.status === 'error' && !!u.error && !osTooOld(u) && (u.downloaded || REVEAL_AFTER.has(u.error.code));
  if (plan.primary && plan.primary.action === 'reveal') plan.reveal = false; // already the primary button
  plan.cancel = u.status === 'downloading';
  plan.releases = !(plan.primary && plan.primary.action === 'releases');
  return plan;
}

export const revealLabel = (platform) => (platform === 'macos' ? 'Show in Finder' : 'Show in folder');

/* ------------------------------------------------------------------ actions */

/** A failed answer that the status line will not show (a refusal leaves the state unchanged). */
function shouldToast(res) {
  const err = store.update && store.update.status === 'error' ? store.update.error : null;
  return REFUSALS.has(res.code) || !err || err.code !== res.code;
}

/** "Check now": always allowed (also with the daily check off). */
export async function checkNow() {
  if (!hasUpdateApi() || typeof api.checkForUpdates !== 'function' || store.updateOps.check) return;
  setUpdateOp('check', true);
  try {
    setUpdateState(await api.checkForUpdates());
  } catch (err) {
    toast(`Couldn't check for updates: ${errMsg(err)}`, { kind: 'danger', timeout: 6000 });
  } finally {
    setUpdateOp('check', false);
  }
}

/** The daily check on / off (settings.autoUpdateCheck; locked during an incoming session). */
export async function setAutoCheck(on) {
  const res = await updateAction('setAutoUpdateCheck', on === true);
  if (!res.ok) toast(res.message, { kind: res.code === 'SETTINGS_LOCKED' ? 'warn' : 'danger', timeout: 6000 });
  await refreshUpdateState(); // the toggle shows what main stored
  return res.ok;
}

/**
 * "Download and install": download and verify, then ask to install (the install itself still needs
 * the click in the confirmation). When a session started meanwhile, the update just waits, ready.
 * @returns {Promise<boolean>} whether the install started (Tunnelview is quitting)
 */
export async function downloadAndInstall() {
  if (store.updateOps.download || store.updateOps.install) return false;
  setUpdateOp('download', true);
  let res;
  try {
    res = await updateAction('downloadUpdate');
  } finally {
    setUpdateOp('download', false);
  }
  await refreshUpdateState();
  if (!res.ok) {
    // CANCELLED: the user's own Cancel, nothing to explain.
    if (res.code !== 'CANCELLED' && shouldToast(res)) toast(res.message, { kind: 'warn', timeout: 6000 });
    return false;
  }
  const u = store.update;
  if (!u || !u.latest || !u.downloaded) return false;
  if (u.installBlocked) {
    toast(`Tunnelview ${u.latest.version} is downloaded. ${u.installBlocked.message}`, { timeout: 9000 });
    return false;
  }
  if (u.blocked) {
    toast(`Tunnelview ${u.latest.version} is downloaded. ${BLOCKED_TEXT[u.blocked] || BLOCKED_TEXT.SESSION_ACTIVE}`, { timeout: 7000 });
    return false;
  }
  return installWithConfirm();
}

/** Cancel on a running download (update:cancel); downloadAndInstall() then ends quietly. */
export async function cancelDownload() {
  const res = await updateAction('cancelUpdate');
  if (!res.ok && res.code !== 'NOT_DOWNLOADING') toast(res.message, { kind: 'warn', timeout: 6000 });
  await refreshUpdateState();
  return res.ok;
}

/**
 * "Restart and install": confirmation first, then update:install. Windows answers after the UAC
 * prompt; macOS once the helper runs. On success Tunnelview quits (and reopens updated).
 * @returns {Promise<boolean>} whether the install started
 */
export async function installWithConfirm() {
  const u = store.update;
  if (!u || !u.latest || !u.downloaded || store.updateOps.install) return false;
  if (u.installBlocked) {
    toast(u.installBlocked.message, { kind: 'warn', timeout: 9000 });
    return false;
  }
  if (u.blocked) {
    toast(BLOCKED_TEXT[u.blocked] || BLOCKED_TEXT.SESSION_ACTIVE, { kind: 'warn', timeout: 6000 });
    return false;
  }
  setUpdateOp('install', true);
  try {
    if (!(await confirmInstall(u))) return false;
    const res = await updateAction('installUpdate');
    if (res.ok) return true;
    await refreshUpdateState();
    if (shouldToast(res)) toast(res.message, { kind: 'warn', timeout: 7000 });
    return false;
  } finally {
    setUpdateOp('install', false);
  }
}

/** Show the downloaded update in Explorer / Finder (to run it by hand). */
export async function revealDownloaded() {
  const res = await updateAction('revealUpdate');
  if (!res.ok) toast(res.message, { kind: 'warn', timeout: 6000 });
}

/** https://github.com/NamiNaone99/Tunnelview/releases/latest in the browser (main opens it). */
export async function openReleases() {
  if (!api || typeof api.openReleasesPage !== 'function') return;
  try {
    await api.openReleasesPage();
  } catch (err) {
    toast(`Couldn't open the releases page: ${errMsg(err)}`, { kind: 'danger' });
  }
}

/* ------------------------------------------------------------------ confirmation */

/**
 * What happens when the update installs, per platform. Cancel has the focus: a stray Enter must not
 * restart the app. @returns {Promise<boolean>} true = install
 */
export function confirmInstall(u) {
  const v = u.latest.version;
  let body;
  if (u.platform === 'macos') {
    body = h('div', { class: 'col gap-12 update-confirm' },
      h('p', null, `Tunnelview quits, replaces itself with version ${v} and opens again.`),
      h('div', { class: 'banner banner-warn small' },
        icon('alert'),
        h('div', { class: 'grow' },
          h('div', { class: 'strong' }, 'Allow Screen Recording and Accessibility again afterwards'),
          h('div', { class: 'dim' },
            'Tunnelview is ad-hoc signed (not notarized by Apple), so macOS treats every update as a new app and asks for both permissions again. Until you allow them in System Settings › Privacy & Security, viewers can’t see or control this Mac. Access to the Downloads folder may be asked for again too.'))),
      h('p', { class: 'small dim' }, 'A copy of Tunnelview you built yourself is replaced by the release build.'));
  } else if (u.platform === 'windows') {
    body = h('div', { class: 'col gap-12 update-confirm' },
      h('p', null, 'Windows will ask for permission (UAC). Tunnelview closes and reopens after the update.'),
      h('p', { class: 'small dim' },
        'The prompt says “Unknown publisher” because Tunnelview’s Windows builds are not code-signed. Your settings are kept. If other people are signed in to this PC, their Tunnelview closes too.'));
  } else {
    body = h('div', { class: 'col gap-12 update-confirm' }, h('p', null, 'Tunnelview closes and reopens after the update.'));
  }
  return new Promise((resolve) => {
    let answered = false;
    const modal = openModal({
      title: `Install Tunnelview ${v}?`,
      iconName: 'download',
      body,
      actions: [
        { label: 'Cancel', id: 'cancel', onClick: () => true },
        { label: 'Restart and install', id: 'ok', kind: 'primary', onClick: () => { answered = true; return true; } },
      ],
      onClose: () => resolve(answered),
      initialFocus: (m) => m.buttons.cancel,
    });
    modal.el.classList.add('modal-update');
  });
}

/* ------------------------------------------------------------------ banner */

// Dismissed banners, in this window's memory only: a newer version (or another failure) shows again.
const dismissed = { version: '', justUpdated: '', failure: '' };
const DISMISS_FIELD = { available: 'version', updated: 'justUpdated', failed: 'failure' };
const BANNER_STATUSES = new Set(['available', 'checking', 'downloading', 'ready', 'error']);

/**
 * The one banner to show for (UpdateState, AppState), or null:
 *   updated   this start follows an in-app update (macOS: while Screen Recording / Accessibility
 *             still have to be allowed again)
 *   failed    the last install did not take
 *   available a newer version is known (also while it downloads or waits, ready, to be installed)
 */
export function pickUpdateBanner(u, state, gone = dismissed) {
  if (!u) return null;
  if (u.justUpdated && gone.justUpdated !== u.justUpdated.to) {
    const to = u.justUpdated.to;
    if (u.platform !== 'macos') return { kind: 'updated', key: to, tone: 'ok', icon: 'check-circle', title: `Tunnelview was updated to ${to}`, sub: '', action: '' };
    const perms = state && state.permissions;
    if (state && state.loaded && perms && !(perms.screen === 'granted' && perms.accessibility === 'granted')) {
      return {
        kind: 'updated', key: to, tone: 'warn', icon: 'shield', title: `Tunnelview was updated to ${to}`, action: '',
        sub: 'macOS asks again for Screen Recording and Accessibility after every update. Allow both with Grant under “macOS permissions” on the left, then use Quit & Reopen.',
      };
    }
  }
  if (u.status === 'error' && u.error && NEXT_START_FAILURES.has(u.error.code) && gone.failure !== u.error.code) {
    return { kind: 'failed', key: u.error.code, tone: 'warn', icon: 'alert', title: 'The update did not complete', sub: u.error.message, action: 'Details' };
  }
  if (u.latest && BANNER_STATUSES.has(u.status) && !osTooOld(u) && gone.version !== u.latest.version) {
    const v = u.latest.version;
    const have = u.currentVersion ? `You have ${u.currentVersion}.` : '';
    const base = { kind: 'available', key: v, tone: 'accent', icon: 'download', action: 'View update' };
    const blockedHere = u.supported && u.installBlocked;
    if (u.status === 'downloading') return { ...base, title: `Downloading Tunnelview ${v}…`, sub: blockedHere ? u.installBlocked.message : 'It installs only after you confirm.' };
    if (u.downloaded && blockedHere) return { ...base, title: `Tunnelview ${v} is downloaded`, sub: u.installBlocked.message };
    if (u.downloaded) return { ...base, title: `Tunnelview ${v} is ready to install`, sub: have };
    return { ...base, title: `Tunnelview ${v} is available`, sub: have };
  }
  return null;
}

/**
 * The banner above Remote Desk. "View update" / "Details" open Settings › Updates; ✕ hides it for
 * that version (or that failure) until this window is reloaded. afterDismiss() gets the keyboard
 * focus when the banner had it.
 */
export function mountUpdateBanner(root, { openSettings = null, afterDismiss = null } = {}) {
  if (!root) return { render() {} };
  let lastSig = null;

  function dismiss(b) {
    const hadFocus = root.contains(document.activeElement);
    dismissed[DISMISS_FIELD[b.kind]] = b.key;
    render();
    if (hadFocus && typeof afterDismiss === 'function') afterDismiss();
  }

  function build(b) {
    const titleId = 'update-banner-title';
    return h('div', { class: `banner banner-${b.tone} update-banner`, role: 'status', 'aria-labelledby': titleId },
      icon(b.icon, { size: 18 }),
      h('div', { class: 'grow update-banner-text' },
        h('div', { class: 'strong', id: titleId }, b.title),
        b.sub ? h('div', { class: 'small dim update-banner-sub' }, b.sub) : null),
      h('div', { class: 'row gap-4 update-banner-actions' },
        b.action && typeof openSettings === 'function' ? h('button', {
          class: 'btn btn-sm', type: 'button', dataset: { fid: 'update-banner-open' },
          onClick: () => openSettings('updates', { focusSection: true }),
        }, b.action) : null,
        h('button', {
          class: 'btn btn-ghost btn-icon btn-sm', type: 'button', dataset: { fid: 'update-banner-dismiss' },
          title: 'Dismiss', 'aria-label': `Dismiss: ${b.title}`, onClick: () => dismiss(b),
        }, icon('x'))));
  }

  function render() {
    const b = pickUpdateBanner(store.update, store.state);
    const sig = JSON.stringify(b);
    if (sig === lastSig) return;
    lastSig = sig;
    if (!b) { root.replaceChildren(); root.hidden = true; return; }
    root.hidden = false;
    preserveFocus(root, () => root.replaceChildren(build(b)));
  }

  subscribe('update', render);
  subscribe('state', render);
  render();
  return { render };
}
