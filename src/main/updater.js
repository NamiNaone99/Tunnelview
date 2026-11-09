'use strict';
/*
 * In-app updates (DECISIONS U1-U5). This is the only connection Tunnelview makes outside the
 * tailnet (ARCHITECTURE §1): main process only, HTTPS GET only, to github.com and GitHub's two
 * release-asset hosts only, and the automatic part can be turned off (autoUpdateCheck). Requests
 * carry no cookies, no credentials and no user data: the only headers are
 * `User-Agent: Tunnelview-Updater/<version>` and `Accept`. Nothing is ever installed without the
 * user's click.
 *
 *   const { createUpdater } = require('./updater');
 *   const updater = createUpdater(deps);
 *   updater.init()       → {justUpdated}   next-start bookkeeping; call once, after settings.load()
 *   updater.start()                        automatic checks (packaged builds, autoUpdateCheck on)
 *   updater.dispose()                      timers off; a running check / download is aborted
 *   updater.getState()   → UpdateState     (shape: src/preload/main.js)
 *   updater.check()      → Promise<UpdateState>
 *   updater.download()   → Promise<Result> resolves when the download is verified (or failed);
 *                                          {ok:false, code:'CANCELLED'} after cancelDownload()
 *   updater.cancelDownload() → Result      stop a running download (the state goes back to 'available')
 *   updater.install()    → Promise<Result> {ok:true} once the installer / helper runs; the app quits
 *   updater.reveal()     → Result          show the downloaded file in Explorer / Finder
 *   updater.settingsChanged(keys)          autoUpdateCheck toggled: reschedule
 *   updater.sessionsChanged()              re-evaluate `blocked`; emits 'state' when it changed
 *   updater.reschedule()                   back from sleep / screen unlock: re-read the wall clock
 *   updater.isInstalling() → bool          an install runs (from 'preparing' until the app quits):
 *                                          index.js / ipc.js start no new session meanwhile
 *   updater.justUpdated  → {from, to} | null   this start follows an in-app update
 *   events: 'state' (UpdateState)
 *   Result = {ok:true} | {ok:false, code, message}
 *
 * deps (everything that touches the OS is injectable; tests make no network connection and start
 * no installer): appVersion, isPackaged, settings {get, update}, userData, updatesDir (default
 * <userData>/updates; index.js gives an installed Windows copy %LOCALAPPDATA%\Tunnelview\updates),
 * resourcesPath, execPath, platform, arch, translated (bool or fn: Rosetta / ARM64 translation),
 * systemVersion (macOS version string, process.getSystemVersion()), pid, getuid,
 * sessionBlocker (→ 'INCOMING_SESSION'|'INCOMING_REQUEST'|'OUTGOING_SESSION'|null), quit,
 * showItemInFolder, transport {get(url, {headers, timeoutMs, signal}) → Promise<IncomingMessage-like>},
 * fs, path, spawn, execFile, now, timers {setTimeout, clearTimeout}, keys, homedir, exlockFlag, log.
 *
 * Check: GET MANIFEST_URL (…/releases/latest/download/tunnelview-update.json), at most 5
 * redirects, each to https on an allowed host (no other port, no user info), 64 KiB cap, 30 s for
 * the whole check. The manifest must verify against update-keys.js (update-manifest.js) and is
 * offered only when its version is strictly greater than the running one. Schedule (U3): first
 * check 60 s after start, then every 24 h; settings.lastUpdateCheckAt (written after every
 * completed check, automatic or manual) keeps restarts from checking more than once a day, and a
 * value more than 24 h in the future (clock moved back) counts as never. One exception: while a
 * finished download newer than this version waits in updatesDir (the user deferred the install,
 * then restarted), the first check after a start runs 60 s after it whatever lastUpdateCheckAt
 * says, so "Restart and install" comes back without a day's wait. A failed check is quiet
 * (status line only). One that may pass soon (network, timeout, HTTP 429 / 5xx, no manifest yet)
 * is tried again after 2 h, then 4, 8 and 16 h, at most a day; any other failure (a manifest that
 * does not verify, TLS, a bad redirect, another HTTP error) counts as that day's check.
 * Timers count awake time only on macOS, so index.js calls reschedule() on 'resume'.
 *
 * Download (U4): …/releases/download/v<version>/<name>, the version taken from the VERIFIED
 * manifest, so a release published between the two requests cannot mix files. Streams to
 * <updatesDir>/<version>/<name>.partial with a running SHA-256 and byte count (more bytes than
 * the manifest's size stop it at once), then renames to <name>. A wrong size or hash deletes the
 * file. Besides the 30 s socket idle timeout, a download that gets fewer than 64 KiB (or the
 * rest of the file) in any 60 s stops with TIMEOUT, so a trickling response cannot hold the
 * updater forever; the user can also cancel it (cancelDownload). Only the newest version folder
 * is kept. A same-version manifest that lists other bytes (a rebuilt release) drops the earlier
 * download.
 *
 * Install (U5), refused during an incoming session, a pending incoming request or an outgoing
 * session (checked first and again right before anything is started; a session that starts
 * meanwhile is a refusal too, and the state goes back to what it was):
 *   Windows  (NSIS per-machine installer, which needs administrator rights). Offered only for the
 *            NSIS-installed copy (`Uninstall Tunnelview.exe` next to the exe; win-unpacked and
 *            copied folders are not supported) and only when updatesDir is on a local disk (not a
 *            UNC path). The verified file is moved into a fresh mkdtemp folder
 *            (<updatesDir>\install-XXXXXX), re-hashed under an exclusive lock (UV_FS_O_EXLOCK;
 *            EBUSY retried for about 10 s, then LOCKED with the download kept: moved back, or, when
 *            the program holding it blocks that move too, left in its install-* folder and used
 *            from there next time), then, in the same
 *            tick, `resources\elevate.exe <installer> /S --updated --force-run` is spawned (no
 *            shell, no -wait). A direct spawn of the installer fails with EACCES and shows no UAC
 *            prompt. elevate.exe exits once the user answers UAC: 0 → the installer runs and
 *            Tunnelview quits (the installer closes what is left, keeps userData, shortcuts and the
 *            login item, and relaunches the app); 1 with "…: 1223" → declined (UAC_DECLINED),
 *            anything else → LAUNCH_FAILED. The installer's own exit code cannot be seen.
 *   macOS    (ad-hoc signed zip): the running bundle (from execPath) must not be translocated, must
 *            be io.github.naminaone99.tunnelview, owned by this user, in a folder this user can
 *            write (a probe folder made and removed there proves it) and other accounts cannot
 *            (not world-writable, such as /Users/Shared: SHARED_LOCATION). The zip is re-hashed,
 *            extracted with `ditto -x -k --noqtn` into a fresh folder (a failure there is local,
 *            such as free space, and keeps the zip), and the bundle is checked: exactly
 *            Tunnelview.app, bundle id, CFBundleShortVersionString == manifest version,
 *            CFBundleExecutable, LSMinimumSystemVersion ≤ this Mac's macOS (else OS_TOO_OLD: a
 *            bundle macOS refuses to open never replaces a working one), Mach-O architecture,
 *            `codesign --verify --deep --strict`, no quarantine. A bundle check that fails keeps the
 *            zip (it matched its signed hash, so downloading it again cannot help), and a check
 *            killed by its time limit is VERIFY_TIMEOUT (try again). Tunnelview running from the
 *            bundle in another user account refuses the install (IN_USE_BY_OTHER_USER) before
 *            anything quits. Only then is the staging folder <parent>/.Tunnelview-update-XXXXXX made
 *            and the bundle moved into it; then `/bin/sh -c MAC_SWAP_SCRIPT` (a constant; paths only
 *            as arguments) is spawned detached and Tunnelview quits. The helper waits for this PID
 *            to exit (≤ 120 s) and for nothing else to run from the bundle (≤ 5 s, else `busy`),
 *            moves the old bundle aside, moves the new one in (rolling back on failure), resets the
 *            Screen Recording / Accessibility / Downloads permission entries (ad-hoc: each build is a
 *            new code identity, like scripts/mac-install.sh) and opens the app, only while it is
 *            owned by this user. The old bundle stays, hidden, as .Tunnelview-old-*.app until the
 *            new version has started once (init() removes it then), so a new version that macOS
 *            will not start still leaves the old one on disk. The helper writes its outcome to
 *            <updatesDir>/install-result.
 *   Both write <updatesDir>/pending.json {v:1, platform, from, to, at, …} first; init() on the
 *   next start reads it: running version ≥ `to` → justUpdated {from, to: the running version},
 *   else INSTALL_INCOMPLETE (or MAC_REPLACE_FAILED, or MAC_APP_IN_USE after the helper's `busy`)
 *   and the download is kept for another try. An old copy started while the
 *   install still runs (Windows: the staged installer is still locked, ≤ 15 min; macOS: no helper
 *   outcome yet, ≤ 150 s) leaves the marker for the next start. An automatic check does not
 *   replace that next-start failure while it offers the same version again.
 * Accepted risk: the staged installer / bundle lives in a folder the user can write, so malware
 * running as the same user could swap it between the last check and its use (it could also inject
 * into Tunnelview directly). Windows builds are not Authenticode-signed, so UAC says "Unknown
 * publisher".
 */
const { EventEmitter } = require('events');
const crypto = require('crypto');
const nodeFs = require('fs');
const nodePath = require('path');
const os = require('os');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const childProcess = require('child_process');
const manifestLib = require('./update-manifest');
const { KEYS } = require('./update-keys');

const REPO = 'NamiNaone99/Tunnelview';
const MANIFEST_URL = `https://github.com/${REPO}/releases/latest/download/${manifestLib.MANIFEST_NAME}`;
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const ALLOWED_HOSTS = Object.freeze(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const REDIRECT_STATUSES = Object.freeze([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;
const MAX_LOCATION_LENGTH = 8192;

const FIRST_CHECK_DELAY_MS = 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RETRY_AFTER_FAILURE_MS = 2 * 60 * 60 * 1000;
const BUSY_RETRY_MS = 30 * 60 * 1000;
const MAX_TIMER_MS = 0x7fffffff;
const CHECK_DEADLINE_MS = 30 * 1000;    // the whole manifest check
const SOCKET_IDLE_MS = 30 * 1000;       // no byte for this long → the request fails (download too)
// A download that gets fewer than STALL_MIN_BYTES (or the rest of the file) in any STALL_WINDOW_MS
// stops with TIMEOUT: one byte every 25 s would never trip the socket idle timeout.
const STALL_WINDOW_MS = 60 * 1000;
const STALL_MIN_BYTES = 64 * 1024;
const RENAME_RETRIES = 5;
const LOCK_RETRY_MS = 200;
const LOCK_RETRIES = 50;                // about 10 s of EBUSY (antivirus scanning the new file)
const STDERR_CAP = 4096;
const PENDING_MAX_BYTES = 8192;
// An old copy started by hand while the install still runs leaves pending.json alone (init()).
const WIN_INSTALL_WINDOW_MS = 15 * 60 * 1000;  // the staged installer is still locked
const MAC_HELPER_WINDOW_MS = 150 * 1000;       // no helper outcome yet: 120 s PID wait + 1 s + 5 s busy + moves

const APP_ID = 'io.github.naminaone99.tunnelview';
// electron-builder's NSIS UNINSTALL_FILENAME ("Uninstall ${PRODUCT_FILENAME}.exe"): written only by
// the installer into $INSTDIR, so win-unpacked and copied folders do not have it.
const WIN_UNINSTALLER = 'Uninstall Tunnelview.exe';
const MAC_APP_NAME = 'Tunnelview.app';
const MAC_EXECUTABLE = 'Tunnelview';
const MAC_TOOLS = Object.freeze({ sh: '/bin/sh', ditto: '/usr/bin/ditto', codesign: '/usr/bin/codesign', plutil: '/usr/bin/plutil', xattr: '/usr/bin/xattr', ps: '/bin/ps' });
const MAC_HELPER_ENV_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const MAC_DITTO_TIMEOUT_MS = 300 * 1000;
const MAC_CODESIGN_TIMEOUT_MS = 180 * 1000;
const MAC_TOOL_TIMEOUT_MS = 10 * 1000;
const MACHO_CPU = Object.freeze({ 'darwin-arm64': 0x0100000c, 'darwin-x64': 0x01000007 });
const UV_FS_O_EXLOCK = 0x10000000;      // libuv: open with no sharing at all (Windows only)

const PENDING_FILE = 'pending.json';
const RESULT_FILE = 'install-result';
const INSTALL_DIR_RE = /^install-[A-Za-z0-9]{6}$/;
const EXTRACT_DIR_RE = /^x-[A-Za-z0-9]{6}$/;
const MAC_STAGE_RE = /^\.Tunnelview-update-[A-Za-z0-9]{6}$/;
const MAC_BACKUP_RE = /^\.Tunnelview-old-[0-9a-f]{12}\.app$/;
const UA_VERSION_RE = /^[0-9A-Za-z.+-]{1,32}$/;
const RUNNING_VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const UAC_RE = /could not be launched: (\d+)\s*$/;
const OS_VERSION_RE = /^\d{1,4}(\.\d{1,4}){0,2}$/;

const STATUSES = Object.freeze(['idle', 'checking', 'up-to-date', 'available', 'downloading', 'ready', 'installing', 'error']);
const PHASES = Object.freeze(['preparing', 'waiting-for-approval', 'quitting']);
const BLOCKERS = Object.freeze(['INCOMING_SESSION', 'INCOMING_REQUEST', 'OUTGOING_SESSION']);
// Thrown inside an install that had already started: answered like the refusals before it (the
// state goes back to what it was), never as status 'error'.
const LATE_REFUSALS = new Set([...BLOCKERS, 'SESSION_ACTIVE', 'NOT_SUPPORTED', 'NOT_READY', 'BUSY', 'IN_USE_BY_OTHER_USER']);

/*
 * The helper that replaces the macOS bundle after Tunnelview has quit. A constant: every path
 * arrives as an argument ($1 … $6), never as script text. Writes one word to $result:
 * ok | timeout | busy | precondition | move-old-failed | move-new-failed | rollback-failed | bad-args.
 * `busy`: a Tunnelview process (one started from the Dock meanwhile, a helper process that
 * outlived the old app, or a copy running in another user account) still runs from the bundle
 * after 5 s, so nothing is moved.
 * The old bundle is never deleted here: it stays as $old until the new version has started once
 * (init() → _cleanupMacStaging), so a new bundle macOS refuses to open still leaves one on disk.
 * `reopen` opens $dest only while this user owns it: whatever another account managed to put
 * there (a folder others can write) is never launched as this user.
 */
const MAC_SWAP_SCRIPT = [
  'pid=$1; dest=$2; stage=$3; old=$4; result=$5; bid=$6',
  'new="$stage/Tunnelview.app"',
  "trap '' HUP INT TERM",
  'say() { echo "$1" > "$result.tmp" && /bin/mv -f "$result.tmp" "$result"; }',
  'reopen() { [ "$(/usr/bin/stat -f %u "$dest" 2>/dev/null)" = "$(/usr/bin/id -u)" ] && /usr/bin/open "$dest"; }',
  'case $dest in /*.app) ;; *) say bad-args; exit 2 ;; esac',
  'case $stage in /*/.Tunnelview-update-*) ;; *) say bad-args; exit 2 ;; esac',
  'case $old in /*/.Tunnelview-old-*.app) ;; *) say bad-args; exit 2 ;; esac',
  'n=0',
  'while /bin/kill -0 "$pid" 2>/dev/null; do',
  '  n=$((n + 1))',
  '  if [ "$n" -ge 600 ]; then say timeout; exit 1; fi',
  '  /bin/sleep 0.2',
  'done',
  '/bin/sleep 1',
  // Full executable paths (macOS ps), matched literally ("$dest" quoted in the pattern).
  'busy() { /bin/ps -axo comm= | { while IFS= read -r c; do case $c in "$dest"/Contents/*) exit 0 ;; esac; done; exit 1; }; }',
  'n=0',
  'while busy; do',
  '  n=$((n + 1))',
  '  if [ "$n" -ge 25 ]; then say busy; reopen; exit 1; fi',
  '  /bin/sleep 0.2',
  'done',
  'if [ ! -d "$new" ] || [ -L "$new" ] || [ -e "$old" ] || [ -L "$old" ] || [ -L "$dest" ] || [ ! -d "$dest" ]; then',
  '  say precondition; reopen; exit 1',
  'fi',
  'if ! /bin/mv -- "$dest" "$old"; then say move-old-failed; reopen; exit 1; fi',
  'if [ -e "$dest" ] || ! /bin/mv -- "$new" "$dest"; then',
  '  if [ ! -e "$dest" ] && /bin/mv -- "$old" "$dest"; then say move-new-failed; else say rollback-failed; fi',
  '  reopen; exit 1',
  'fi',
  '/bin/rmdir -- "$stage" 2>/dev/null',
  'for svc in ScreenCapture Accessibility SystemPolicyDownloadsFolder; do /usr/bin/tccutil reset "$svc" "$bid" >/dev/null 2>&1; done',
  'say ok',
  'reopen',
].join('\n');

/* ------------------------------------------------------------------ error codes → English */

// A bundle that matched its signed hash but failed a check on this Mac: downloading the same
// bytes again cannot help, so the zip is kept and the user is sent to the releases page.
const CHECK_FAILED = 'The downloaded update did not pass the macOS checks, so it was not installed. Get the new version from the GitHub releases page.';
const STANDARD_ACCOUNT_APPS = 'the Applications folder (on a standard account, the Applications folder in your home folder)';
const MESSAGES = Object.freeze({
  // checking / downloading
  NETWORK: 'Could not reach GitHub. Check the internet connection and try again.',
  TIMEOUT: 'GitHub did not answer in time. Try again later.',
  TLS: 'The secure connection to GitHub could not be verified (a proxy or security software may be intercepting it).',
  HTTP_STATUS: (i) => `GitHub answered with an error (HTTP ${Number.isInteger(i.status) ? i.status : '?'}). Try again later.`,
  NO_MANIFEST: 'The latest release has no update information yet. Try again later.',
  BAD_REDIRECT: 'GitHub redirected Tunnelview to an address it does not trust, so the request was stopped.',
  BAD_RESPONSE: 'GitHub sent an answer Tunnelview cannot use. Try again later.',
  MANIFEST_TOO_LARGE: 'The update information is larger than allowed, so it was ignored.',
  MANIFEST_MALFORMED: 'The update information could not be read, so it was ignored.',
  MANIFEST_UNKNOWN_KEY: 'The update is signed with a key this version of Tunnelview does not know. Get the new version from the GitHub releases page.',
  MANIFEST_BAD_SIGNATURE: 'The update information is not signed by the Tunnelview developers, so it was ignored.',
  MANIFEST_INVALID: 'The update information is signed but not valid, so it was ignored.',
  SIZE_MISMATCH: 'The downloaded file has the wrong size, so it was deleted. Try again.',
  HASH_MISMATCH: 'The downloaded file does not match its signed checksum, so it was deleted. Try again.',
  DISK_ERROR: 'Could not save the update on this computer. Check that the disk has free space.',
  CANCELLED: 'Download cancelled.',
  NOT_DOWNLOADING: 'No download is running.',
  // refusals (the state does not change)
  INCOMING_SESSION: 'Someone is connected to this computer. Install the update after the session ends.',
  INCOMING_REQUEST: 'Someone is asking to connect to this computer. Install the update after you answer.',
  OUTGOING_SESSION: 'You are connected to another device. Install the update after you disconnect.',
  SESSION_ACTIVE: 'Install the update after the current session ends.',
  NOT_SUPPORTED: 'This copy of Tunnelview cannot update itself. Get the new version from the GitHub releases page.',
  NOT_AVAILABLE: 'There is no update to download. Check for updates first.',
  NOT_READY: 'Download the update first.',
  BUSY: 'Tunnelview is already working on an update.',
  // Windows install
  UAC_DECLINED: 'Update cancelled: administrator permission was not given.',
  LAUNCH_FAILED: (i) => `Windows could not start the installer${i.winError ? ` (error ${i.winError})` : ''}. You can run the downloaded installer yourself.`,
  TAMPERED: 'The update file changed after it was checked, so it was not used. Download it again.',
  LOCKED: 'Another program (such as antivirus software) is using the update file. Try again in a moment.',
  // macOS install
  TRANSLOCATED: `macOS is running Tunnelview from a temporary read-only copy. With Finder, move Tunnelview into ${STANDARD_ACCOUNT_APPS}, open it again, then install the update.`,
  READ_ONLY_LOCATION: `Tunnelview is running from a read-only place (such as the disk image). Move it into ${STANDARD_ACCOUNT_APPS}, open it again, then install the update.`,
  NOT_WRITABLE: 'Your account cannot replace Tunnelview in its folder. Ask an administrator, move Tunnelview into the Applications folder in your home folder, or install the downloaded update by hand.',
  NOT_OWNER: 'Tunnelview was installed by another user account, so this account cannot replace it. Ask that user or an administrator, or install the downloaded update by hand.',
  SHARED_LOCATION: `Tunnelview is in a folder that other accounts on this Mac can change, so it cannot replace itself there. Move it into ${STANDARD_ACCOUNT_APPS}, open it again, then install the update.`,
  NOT_TUNNELVIEW: 'This copy of Tunnelview cannot update itself (it is not an installed Tunnelview app). Get the new version from the GitHub releases page.',
  EXTRACT_FAILED: 'Could not unpack the update. Check that the disk has free space, then try again.',
  BAD_BUNDLE: CHECK_FAILED,
  WRONG_VERSION: CHECK_FAILED,
  WRONG_ARCH: CHECK_FAILED,
  CODESIGN_FAILED: CHECK_FAILED,
  QUARANTINED: CHECK_FAILED,
  VERIFY_TIMEOUT: 'Checking the downloaded update took too long, so it was not installed. Try again.',
  OS_TOO_OLD: (i) => `Tunnelview ${i.to || 'the new version'} needs macOS ${i.need || 'a newer version'} or newer, so it was not installed. Tunnelview ${i.current || 'the current version'} stays installed.`,
  IN_USE_BY_OTHER_USER: 'Tunnelview is open in another user account on this Mac. Quit it there, then install the update.',
  SPAWN_FAILED: 'Could not start the update helper. Tunnelview keeps running; try again.',
  // the next start
  INSTALL_INCOMPLETE: (i) => `The update to ${i.to || 'the new version'} did not complete; Tunnelview ${i.current || 'the current version'} is still installed. Check for updates to try again.`,
  MAC_REPLACE_FAILED: (i) => `macOS did not let Tunnelview replace itself, so Tunnelview ${i.current || 'the current version'} is still installed. Allow Tunnelview in System Settings › Privacy & Security › App Management, then click Check now and install it again (the download is kept), or install the downloaded update by hand.`,
  MAC_APP_IN_USE: (i) => `The update to ${i.to || 'the new version'} did not complete because Tunnelview was still open, possibly in another user account on this Mac. Quit Tunnelview there, then check for updates to try again.`,
});
const MANIFEST_CODE = Object.freeze({
  TOO_LARGE: 'MANIFEST_TOO_LARGE',
  MALFORMED: 'MANIFEST_MALFORMED',
  UNKNOWN_KEY: 'MANIFEST_UNKNOWN_KEY',
  BAD_SIGNATURE: 'MANIFEST_BAD_SIGNATURE',
  INVALID: 'MANIFEST_INVALID',
});
// The download itself is at fault: it is deleted. Only TAMPERED (the bytes no longer match the
// signed hash). Every other failure comes after the zip / installer passed its signed hash right
// before (EXTRACT_FAILED, LOCKED, the bundle checks, OS_TOO_OLD, VERIFY_TIMEOUT): the same bytes
// would fail the same way, or the cause is this computer, so downloading again cannot help.
const DAMAGED_CODES = new Set(['TAMPERED']);
const REVEAL_CODES = new Set(['TRANSLOCATED', 'READ_ONLY_LOCATION', 'NOT_WRITABLE', 'NOT_OWNER', 'SHARED_LOCATION']);

function messageFor(code, info = {}) {
  const m = MESSAGES[code];
  if (typeof m === 'function') return m(info);
  return m || 'The update failed.';
}

function updateError(code, info = {}) {
  const e = new Error(messageFor(code, info));
  e.updaterCode = code;
  e.info = info;
  return e;
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const refusal = (code, info) => ({ ok: false, code, message: messageFor(code, info) });

/** A Windows UNC path (\\server\share\…, \\?\…): not a local disk, never used for an elevated installer. */
const isUncPath = (p) => typeof p === 'string' && /^[\\/]{2}/.test(p);

/**
 * A failed check that may pass soon: nothing usable came back (network, timeout, HTTP 429 / 5xx,
 * no manifest on the latest release yet). Any other failure would fail the same way again.
 */
function transientFailure(e) {
  const c = e && e.updaterCode;
  if (c === 'NETWORK' || c === 'TIMEOUT' || c === 'NO_MANIFEST') return true;
  const s = c === 'HTTP_STATUS' && e.info ? e.info.status : 0;
  return s === 429 || s >= 500;
}

/* ------------------------------------------------------------------ pure helpers (exported) */

/** The URL as a URL object when it may be requested: https, an allowed host, no port, no user info. */
function allowedUrl(s) {
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port !== '' || !ALLOWED_HOSTS.includes(u.hostname)) return null;
  return u;
}

/** …/releases/download/v<version>/<name> for a name on the platform's allow-list. */
function assetUrl(platformKey, version, name) {
  const re = manifestLib.ASSET_NAME_RE[platformKey];
  if (!re || !manifestLib.validVersion(version) || typeof name !== 'string' || !re.test(name) || name !== manifestLib.assetName(platformKey, version)) {
    throw updateError('MANIFEST_INVALID');
  }
  return `https://github.com/${REPO}/releases/download/v${version}/${name}`;
}

/**
 * The manifest files[] key for this build. Windows keeps its own architecture (an arm64 installer
 * would install an app an x64 machine cannot start); a Mac under Rosetta gets the arm64 build.
 */
function platformKeyFor(platform, arch, translated) {
  if (platform === 'win32') return arch === 'x64' ? 'win32-x64' : arch === 'arm64' ? 'win32-arm64' : null;
  if (platform === 'darwin') {
    if (arch === 'arm64' || translated === true) return 'darwin-arm64';
    return arch === 'x64' ? 'darwin-x64' : null;
  }
  return null;
}

/** CPU types in a Mach-O header: one for a thin 64-bit binary, several for a fat one, [] otherwise. */
function machoCpuTypes(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 8) return [];
  if (buf.readUInt32LE(0) === 0xfeedfacf) return [buf.readUInt32LE(4)]; // MH_MAGIC_64 (CF FA ED FE)
  const magic = buf.readUInt32BE(0);
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return [];        // FAT_MAGIC / FAT_MAGIC_64
  const n = buf.readUInt32BE(4);
  const size = magic === 0xcafebabe ? 20 : 32;
  if (n < 1 || n > 8 || 8 + n * size > buf.length) return [];
  return Array.from({ length: n }, (_, i) => buf.readUInt32BE(8 + i * size));
}

function parseRunningVersion(v) {
  const m = RUNNING_VERSION_RE.exec(String(v));
  return m ? { base: `${m[1]}.${m[2]}.${m[3]}`, pre: !!m[4] } : null;
}

/**
 * macOS version `have` is at least `need` ("13", "13.5", "14.0.1"; missing parts count as 0).
 * Anything that is not such a dotted number is false: an unreadable version never passes.
 */
function osAtLeast(have, need) {
  const h = typeof have === 'string' ? have.trim() : '';
  const n = typeof need === 'string' ? need.trim() : '';
  if (!OS_VERSION_RE.test(h) || !OS_VERSION_RE.test(n)) return false;
  const a = h.split('.').map(Number);
  const b = n.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0;
    const y = b[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

function netError(err, signal) {
  if (err && err.updaterCode) return err;
  if (signal && signal.aborted) {
    const r = signal.reason;
    return r && r.updaterCode ? r : updateError('ABORTED');
  }
  const code = err && typeof err.code === 'string' ? err.code : '';
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') return updateError('TIMEOUT');
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)|ALTNAME|HOSTNAME_MISMATCH/.test(code)) return updateError('TLS', { detail: code });
  return updateError('NETWORK', { detail: code });
}

function destroyQuietly(res) {
  try { if (res && typeof res.destroy === 'function') res.destroy(); } catch { /* ignore */ }
}

/** Node https: no agent (no keep-alive, no shared state), TLS defaults, no automatic redirects. */
function nodeTransport() {
  const https = require('https');
  return {
    get(url, { headers, timeoutMs, signal }) {
      return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request({
          protocol: 'https:',
          hostname: u.hostname,
          port: 443,
          path: `${u.pathname}${u.search}`,
          method: 'GET',
          headers,
          agent: false,
          timeout: timeoutMs,
          signal,
        }, resolve);
        req.on('timeout', () => req.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
        req.on('error', reject);
        req.end();
      });
    },
  };
}

/* ------------------------------------------------------------------ the updater */

class Updater extends EventEmitter {
  constructor(deps = {}) {
    super();
    this._appVersion = String(deps.appVersion || '');
    this._running = parseRunningVersion(this._appVersion);
    this._isPackaged = deps.isPackaged === true;
    this._settings = deps.settings;
    this._platform = deps.platform || process.platform;
    this._arch = deps.arch || process.arch;
    let translated = deps.translated;
    try { translated = typeof translated === 'function' ? translated() : translated; } catch { translated = false; }
    this._platformKey = platformKeyFor(this._platform, this._arch, translated === true);
    let systemVersion = deps.systemVersion;
    try { systemVersion = typeof systemVersion === 'function' ? systemVersion() : systemVersion; } catch { systemVersion = ''; }
    this._systemVersion = typeof systemVersion === 'string' ? systemVersion : '';
    this._fs = deps.fs || nodeFs;
    this._path = deps.path || (this._platform === 'win32' ? nodePath.win32 : nodePath.posix);
    this._userData = deps.userData;
    this._updatesDir = typeof deps.updatesDir === 'string' && deps.updatesDir ? deps.updatesDir : this._path.join(this._userData, 'updates');
    this._resourcesPath = deps.resourcesPath || '';
    this._execPath = deps.execPath || '';
    this._pid = Number.isInteger(deps.pid) ? deps.pid : process.pid;
    this._getuid = typeof deps.getuid === 'function' ? deps.getuid : null;
    this._sessionBlocker = typeof deps.sessionBlocker === 'function' ? deps.sessionBlocker : () => null;
    this._quit = typeof deps.quit === 'function' ? deps.quit : () => {};
    this._showItemInFolder = typeof deps.showItemInFolder === 'function' ? deps.showItemInFolder : () => {};
    this._transport = deps.transport || nodeTransport();
    this._spawn = deps.spawn || childProcess.spawn;
    this._execFile = deps.execFile || childProcess.execFile;
    this._now = typeof deps.now === 'function' ? deps.now : Date.now;
    this._timers = deps.timers || { setTimeout, clearTimeout };
    this._keys = deps.keys || KEYS;
    this._homedir = deps.homedir || os.homedir();
    this._exlock = Number.isInteger(deps.exlockFlag) ? deps.exlockFlag : (process.platform === 'win32' ? UV_FS_O_EXLOCK : 0);
    this._log = deps.log || console;
    this._ua = `Tunnelview-Updater/${UA_VERSION_RE.test(this._appVersion) ? this._appVersion : '0.0.0'}`;
    this._supported = this._installSupported();

    this._status = 'idle';
    this._phase = null;
    this._latest = null;       // verified manifest (strictly newer than this version)
    this._downloaded = null;   // {version, name, file, size, sha256}: verified file of _latest
    this._progress = null;
    this._error = null;        // {code, message}
    this._op = null;           // 'check' | 'download' | 'install'
    this._abort = null;
    this._timer = null;
    this._started = false;
    this._startedAt = 0;
    this._retryAt = 0;
    this._failures = 0;        // consecutive transient check failures (retry back-off)
    this._disposed = false;
    this._justUpdated = null;
    this._revealFile = null;
    this._lastBlocked = null;
    this._nextStartFailure = null; // {to, code}: init() found an install that did not take
    this._pendingDeferred = false; // init() left pending.json for a still-running install
    this._busyInstallDir = null;   // …and this Windows staging folder with it
    this._keepInstallDir = null;   // init(): a staged installer that could not be moved back stays here
    this._resumeDownload = false;  // init() found a finished download: the first check runs 60 s after start
    this._osRefused = null;        // {to, need, current}: OS_TOO_OLD for that version in this run
  }

  get justUpdated() { return this._justUpdated ? { ...this._justUpdated } : null; }

  /** An install runs (from 'preparing' until the app quits); false again after a refusal or failure. */
  isInstalling() { return this._op === 'install'; }

  /* ---------------------------------------------------------------- state */

  _blocker() {
    let b;
    try { b = this._sessionBlocker(); } catch { return 'SESSION_ACTIVE'; }
    if (!b) return null;
    return BLOCKERS.includes(b) ? b : 'SESSION_ACTIVE';
  }

  _settingsNow() {
    try { const s = this._settings && this._settings.get(); return isObj(s) ? s : {}; } catch { return {}; }
  }

  getState() {
    const s = this._settingsNow();
    const latest = this._latest;
    const entry = latest && this._platformKey ? latest.files[this._platformKey] : null;
    const block = this._macInstallBlock();
    return {
      status: this._status,
      phase: this._status === 'installing' ? this._phase : null,
      currentVersion: this._appVersion,
      platform: this._platform === 'win32' ? 'windows' : this._platform === 'darwin' ? 'macos' : 'other',
      supported: this._supported && block !== 'NOT_TUNNELVIEW',
      // macOS: where this copy runs from, it cannot replace itself (install() would refuse with
      // this code). The download stays offered: the verified zip can be installed by hand.
      installBlocked: block && block !== 'NOT_TUNNELVIEW' ? { code: block, message: messageFor(block) } : null,
      autoCheck: s.autoUpdateCheck === true,
      lastCheckAt: Number.isSafeInteger(s.lastUpdateCheckAt) ? s.lastUpdateCheckAt : null,
      latest: latest ? { version: latest.version, date: latest.date, notes: latest.notes, size: entry ? entry.size : 0 } : null,
      downloaded: !!this._downloaded,
      progress: this._status === 'downloading' && this._progress ? { ...this._progress } : null,
      error: this._error ? { ...this._error } : null,
      blocked: this._blocker(),
      justUpdated: this.justUpdated,
    };
  }

  _emit() {
    const s = this.getState();
    this._lastBlocked = s.blocked;
    try { this.emit('state', s); } catch (err) { this._log.error('[updater] state listener failed:', err && err.message); }
  }

  _setStatus(status, extra = {}) {
    this._status = status;
    if ('phase' in extra) this._phase = extra.phase;
    if ('error' in extra) this._error = extra.error;
    this._emit();
  }

  _fail(err) {
    const code = err && err.updaterCode ? err.updaterCode : 'NETWORK';
    const message = err && err.updaterCode ? err.message : messageFor(code);
    this._status = 'error';
    this._phase = null;
    this._progress = null;
    this._error = { code, message };
    return { ok: false, code, message };
  }

  sessionsChanged() {
    if (this._disposed) return;
    if (this._blocker() !== this._lastBlocked) this._emit();
  }

  settingsChanged(keys) {
    if (this._disposed) return;
    if (!Array.isArray(keys) || keys.includes('autoUpdateCheck')) {
      this._retryAt = 0;
      this._schedule();
      this._emit();
    }
  }

  /* ---------------------------------------------------------------- lifecycle */

  _installSupported() {
    if (!this._isPackaged || !this._platformKey || !this._running) return false;
    if (this._platform === 'win32') {
      // The NSIS-installed copy only: the silent installer updates the per-machine install
      // (HKLM InstallLocation), never a win-unpacked or copied folder. And a local disk only: a
      // redirected (UNC) folder would hand the elevated installer bytes read over the network.
      const P = this._path;
      return !!this._execPath && !isUncPath(this._updatesDir)
        && this._isFile(P.join(this._resourcesPath, 'elevate.exe'))
        && this._isFile(P.join(P.dirname(this._execPath), WIN_UNINSTALLER));
    }
    return this._platform === 'darwin';
  }

  /**
   * Why the running macOS bundle cannot replace itself where it is, cheaply (no tool runs): the
   * same location checks install() makes, as a code, or null. Not darwin / not supported: null.
   */
  _macInstallBlock() {
    if (this._platform !== 'darwin' || !this._supported) return null;
    const b = this._macBundle();
    if (b.code) return b.code;
    const fs = this._fs;
    try {
      fs.accessSync(b.parent, fs.constants.W_OK);
    } catch (err) {
      return err && err.code === 'EROFS' ? 'READ_ONLY_LOCATION' : 'NOT_WRITABLE';
    }
    if (this._sharedFolder(b.parent)) return 'SHARED_LOCATION';
    if (this._getuid) {
      let owner = null;
      try { owner = fs.statSync(b.real).uid; } catch { /* unknown */ }
      if (owner !== this._getuid()) return 'NOT_OWNER';
    }
    return null;
  }

  /**
   * The app's folder is one other accounts may change (world-writable, such as /Users/Shared;
   * unreadable counts too). The sticky bit protects the bundle there only until the helper moves
   * it aside: another account could then put its own bundle at that path. Only the folder's owner
   * (root for /Users/Shared) can change its mode, so this cannot be undone by a race.
   */
  _sharedFolder(parent) {
    let st = null;
    try { st = this._fs.statSync(parent); } catch { st = null; }
    return !st || (st.mode & 0o002) !== 0;
  }

  /** Next-start bookkeeping: the pending-install marker, then leftovers. Never throws. */
  init() {
    try { this._processPending(); } catch (err) { this._log.error('[updater] pending install check failed:', err && err.message); }
    try { this._cleanupUpdatesDir(); } catch (err) { this._log.warn('[updater] cleanup failed:', err && err.message); }
    if (this._platform === 'darwin' && !this._pendingDeferred) {
      try { this._sweepMacStaging(); } catch (err) { this._log.warn('[updater] staging cleanup failed:', err && err.message); }
    }
    // A verified download the user has not installed yet (cancelled the confirmation, declined the
    // prompt, an install that did not take): the first check after this start finds it again
    // without waiting for the rest of the day (_schedule).
    try { this._resumeDownload = this._hasCompleteDownload(); } catch { this._resumeDownload = false; }
    return { justUpdated: this.justUpdated };
  }

  /** <updatesDir>/<v>/<this platform's asset for v> exists for a v newer than this version. */
  _hasCompleteDownload() {
    if (!this._platformKey || !this._running) return false;
    let names = [];
    try { names = this._fs.readdirSync(this._updatesDir); } catch { return false; }
    return names.some((v) => manifestLib.validVersion(v) && this._isNewer(v)
      && this._isFile(this._path.join(this._updatesDir, v, manifestLib.assetName(this._platformKey, v))));
  }

  start() {
    if (this._started || this._disposed) return;
    this._started = true;
    this._startedAt = this._now();
    this._schedule();
  }

  /** Also stops an install that has not handed over yet (it ends as a BUSY refusal). */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._clearTimer();
    if (this._abort) { try { this._abort.abort(updateError('ABORTED')); } catch { /* ignore */ } }
  }

  /**
   * Back from sleep or a screen lock (index.js: powerMonitor 'resume' / 'unlock-screen'). On macOS
   * a timer counts awake time only, so a 24 h timer could fire days late: the due time is worked
   * out again from the wall clock, not before 60 s from now (the network comes back first).
   */
  reschedule() {
    if (!this._started || this._disposed) return;
    this._startedAt = this._now();
    this._schedule();
  }

  /* ---------------------------------------------------------------- schedule (U3) */

  _autoEnabled() {
    return this._isPackaged && !!this._platformKey && !!this._running && this._settingsNow().autoUpdateCheck === true;
  }

  _lastCheck() {
    const v = this._settingsNow().lastUpdateCheckAt;
    if (!Number.isSafeInteger(v) || v <= 0) return null;
    return v > this._now() + CHECK_INTERVAL_MS ? null : v; // clock moved back a lot: as if never
  }

  _clearTimer() {
    if (this._timer) { try { this._timers.clearTimeout(this._timer); } catch { /* ignore */ } }
    this._timer = null;
  }

  _schedule() {
    this._clearTimer();
    if (!this._started || this._disposed || !this._autoEnabled()) return;
    const now = this._now();
    const last = this._lastCheck();
    let due = this._startedAt + FIRST_CHECK_DELAY_MS;
    // A finished download waits (init()): the first check of this start is not held back a day.
    if (last !== null && !this._resumeDownload) due = Math.max(due, last + CHECK_INTERVAL_MS);
    if (this._retryAt) due = Math.max(due, this._retryAt);
    const delay = Math.min(Math.max(0, due - now), MAX_TIMER_MS);
    this._timer = this._timers.setTimeout(() => { this._timer = null; this._autoCheck(); }, delay);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  async _autoCheck() {
    if (this._disposed || !this._autoEnabled()) return;
    if (this._op) { // a download or an install is running: look again later
      this._retryAt = this._now() + BUSY_RETRY_MS;
      this._schedule();
      return;
    }
    await this.check({ auto: true });
  }

  /* ---------------------------------------------------------------- network */

  _headers() {
    return { 'User-Agent': this._ua, Accept: 'application/octet-stream' };
  }

  /** GET with manual, allow-listed redirects; resolves with a 200 response whose body is unread. */
  async _open(url, signal, timeoutMs) {
    let target = url;
    for (let redirects = 0; ; redirects++) {
      const u = allowedUrl(target);
      if (!u) throw updateError('BAD_REDIRECT');
      let res;
      try {
        res = await this._transport.get(u.href, { headers: this._headers(), timeoutMs, signal });
      } catch (err) {
        throw netError(err, signal);
      }
      const status = res && res.statusCode;
      const headers = (res && isObj(res.headers)) ? res.headers : {};
      if (REDIRECT_STATUSES.includes(status)) {
        destroyQuietly(res);
        const loc = headers.location;
        if (redirects >= MAX_REDIRECTS || typeof loc !== 'string' || !loc || loc.length > MAX_LOCATION_LENGTH) throw updateError('BAD_REDIRECT');
        try { target = new URL(loc, u).href; } catch { throw updateError('BAD_REDIRECT'); }
        continue;
      }
      if (status !== 200) {
        destroyQuietly(res);
        throw updateError('HTTP_STATUS', { status });
      }
      const enc = headers['content-encoding'];
      if (enc && String(enc).toLowerCase() !== 'identity') {
        destroyQuietly(res);
        throw updateError('BAD_RESPONSE');
      }
      return res;
    }
  }

  async _fetchManifest(signal) {
    let res;
    try {
      res = await this._open(MANIFEST_URL, signal, SOCKET_IDLE_MS);
    } catch (err) {
      if (err.updaterCode === 'HTTP_STATUS' && err.info.status === 404) throw updateError('NO_MANIFEST');
      throw err;
    }
    const declared = Number(res.headers && res.headers['content-length']);
    if (Number.isFinite(declared) && declared > manifestLib.MAX_MANIFEST_BYTES) {
      destroyQuietly(res);
      throw updateError('MANIFEST_TOO_LARGE');
    }
    const chunks = [];
    let len = 0;
    try {
      for await (const chunk of res) {
        len += chunk.length;
        if (len > manifestLib.MAX_MANIFEST_BYTES) {
          destroyQuietly(res);
          throw updateError('MANIFEST_TOO_LARGE');
        }
        chunks.push(Buffer.from(chunk));
      }
    } catch (err) {
      throw netError(err, signal);
    }
    return Buffer.concat(chunks);
  }

  _isNewer(version) {
    if (!this._running || !manifestLib.validVersion(version)) return false;
    const c = manifestLib.compareVersions(version, this._running.base);
    return c > 0 || (c === 0 && this._running.pre);
  }

  /* ---------------------------------------------------------------- check */

  /**
   * Manual or automatic check. Never throws; failures end in status 'error'. An automatic check
   * ({auto:true}) keeps a next-start failure (INSTALL_INCOMPLETE, MAC_REPLACE_FAILED: what to do
   * about it) in view while it offers that same version again; a manual one clears it.
   */
  async check(opts = {}) {
    if (this._disposed || this._op) return this.getState();
    if (!this._platformKey || !this._running) {
      this._fail(updateError('NOT_SUPPORTED'));
      this._emit();
      return this.getState();
    }
    const f = this._nextStartFailure;
    const keep = isObj(opts) && opts.auto === true && f && this._status === 'error' && this._error && this._error.code === f.code
      ? { ...this._error } : null;
    this._op = 'check';
    const ac = new AbortController();
    this._abort = ac;
    const deadline = this._timers.setTimeout(() => ac.abort(updateError('TIMEOUT')), CHECK_DEADLINE_MS);
    if (deadline && typeof deadline.unref === 'function') deadline.unref();
    if (keep) this._emit(); else this._setStatus('checking', { error: null, phase: null });
    try {
      const bytes = await this._fetchManifest(ac.signal);
      const v = manifestLib.verifyManifest(bytes, { keys: this._keys });
      if (!v.ok) throw updateError(MANIFEST_CODE[v.code] || 'MANIFEST_INVALID', { detail: v.detail });
      this._recordCheck();
      this._retryAt = 0;
      this._failures = 0;
      if (!this._isNewer(v.manifest.version)) {
        this._latest = null;
        this._downloaded = null;
        this._status = 'up-to-date';
      } else {
        // A download is kept only for exactly these bytes: the same version re-signed with other
        // files (a rebuilt release) makes _findDownloaded hash it again and drop it.
        const e = v.manifest.files[this._platformKey];
        const d = this._downloaded;
        if (d && (d.version !== v.manifest.version || d.name !== e.name || d.size !== e.size || d.sha256 !== e.sha256)) this._downloaded = null;
        this._latest = v.manifest;
        if (!this._downloaded) this._downloaded = await this._findDownloaded(v.manifest);
        this._status = this._downloaded ? 'ready' : 'available';
      }
      this._error = null;
      if (keep && this._latest && this._latest.version === f.to) {
        this._status = 'error';
        this._error = keep;
      }
      // This Mac already refused that version (OS_TOO_OLD) in this run: "ready to install" again
      // would only repeat the refusal.
      const o = this._osRefused;
      if (o && this._downloaded && this._latest && this._latest.version === o.to) {
        this._status = 'error';
        this._error = { code: 'OS_TOO_OLD', message: messageFor('OS_TOO_OLD', o) };
      }
    } catch (err) {
      const e = netError(err, ac.signal);
      if (e.updaterCode !== 'ABORTED' || !this._disposed) {
        if (keep) {
          this._status = 'error';
          this._error = keep;
          this._phase = null;
        } else {
          this._fail(e);
        }
        if (transientFailure(e)) {
          // 2 h, 4 h, 8 h, 16 h, then once a day.
          this._failures = Math.min(this._failures + 1, 8);
          this._retryAt = this._now() + Math.min(RETRY_AFTER_FAILURE_MS * 2 ** (this._failures - 1), CHECK_INTERVAL_MS);
        } else {
          // It would fail the same way again: this was the day's check (restarts included).
          this._recordCheck();
          this._retryAt = 0;
          this._failures = 0;
        }
        this._log.warn(`[updater] check failed: ${e.updaterCode}${e.info && e.info.detail ? ` (${e.info.detail})` : ''}`);
      }
    } finally {
      this._timers.clearTimeout(deadline);
      this._op = null;
      this._abort = null;
      this._resumeDownload = false; // back to the daily rhythm (U3), whatever this check found
      if (!this._disposed) {
        this._schedule();
        this._emit();
      }
    }
    return this.getState();
  }

  _recordCheck() {
    try { this._settings.update({ lastUpdateCheckAt: this._now() }); } catch (err) { this._log.warn('[updater] could not store lastUpdateCheckAt:', err && err.message); }
  }

  /* ---------------------------------------------------------------- download (U4) */

  async download() {
    if (this._disposed) return refusal('BUSY');
    if (this._op) return refusal('BUSY');
    if (!this._platformKey || !this._running) return refusal('NOT_SUPPORTED');
    if (!this._latest) return refusal('NOT_AVAILABLE');
    if (this._downloaded) return { ok: true };
    const P = this._path;
    const fs = this._fs;
    const m = this._latest;
    const entry = m.files[this._platformKey];
    const dir = P.join(this._updatesDir, m.version);
    const final = P.join(dir, entry.name);
    const partial = `${final}.partial`;
    this._op = 'download';
    const ac = new AbortController();
    this._abort = ac;
    this._progress = { received: 0, total: entry.size, percent: 0 };
    this._setStatus('downloading', { error: null, phase: null });
    // Stall watchdog: at least STALL_MIN_BYTES (or the rest of the file) per STALL_WINDOW_MS,
    // from the first request on. Injected timers, so the tests' manual clock drives it.
    let received = 0;
    let mark = 0;
    let watchdog = null;
    const stopWatchdog = () => {
      if (watchdog) { try { this._timers.clearTimeout(watchdog); } catch { /* ignore */ } }
      watchdog = null;
    };
    const armWatchdog = () => {
      watchdog = this._timers.setTimeout(() => {
        watchdog = null;
        if (received - mark < Math.min(STALL_MIN_BYTES, entry.size - mark)) {
          this._log.warn(`[updater] download stalled: ${received - mark} bytes in ${STALL_WINDOW_MS / 1000} s`);
          ac.abort(updateError('TIMEOUT'));
          return;
        }
        mark = received;
        armWatchdog();
      }, STALL_WINDOW_MS);
      if (watchdog && typeof watchdog.unref === 'function') watchdog.unref();
    };
    try {
      const url = assetUrl(this._platformKey, m.version, entry.name);
      try {
        fs.mkdirSync(dir, { recursive: true });
        this._unlinkQuiet(partial);
      } catch (err) {
        throw updateError('DISK_ERROR', { detail: err && err.code });
      }
      armWatchdog();
      const res = await this._open(url, ac.signal, SOCKET_IDLE_MS);
      const declared = res.headers ? res.headers['content-length'] : undefined;
      if (declared !== undefined && Number(declared) !== entry.size) {
        destroyQuietly(res);
        throw updateError('SIZE_MISMATCH');
      }
      const hash = crypto.createHash('sha256');
      const meter = new Transform({
        transform: (chunk, _enc, cb) => {
          received += chunk.length;
          if (received > entry.size) { cb(updateError('SIZE_MISMATCH')); return; }
          hash.update(chunk);
          this._progressTick(received, entry.size);
          cb(null, chunk);
        },
      });
      const out = fs.createWriteStream(partial, { mode: 0o600 });
      // Only an error that starts at the file is a disk error. pipeline() also destroys `out` with
      // the network's error (a reset, the idle timeout, a premature close: the response is gone
      // before its end) or the abort's: those are not tagged. A response that ended normally (all
      // of a small file already read) does not make a later write error the network's.
      const responseFailed = () => !!res.destroyed && !res.readableEnded;
      out.on('error', (e) => { if (e && typeof e === 'object' && !responseFailed() && !ac.signal.aborted) e.updaterDisk = true; });
      try {
        await pipeline(res, meter, out, { signal: ac.signal });
      } catch (err) {
        if (err && err.updaterCode) throw err;
        if (ac.signal.aborted) throw netError(err, ac.signal); // TIMEOUT (stalled), CANCELLED, ABORTED
        if (err && err.updaterDisk) throw updateError('DISK_ERROR', { detail: err.code });
        throw netError(err, ac.signal);
      }
      stopWatchdog();
      if (ac.signal.aborted) throw netError(null, ac.signal);
      if (received !== entry.size) throw updateError('SIZE_MISMATCH');
      if (hash.digest('hex') !== entry.sha256) throw updateError('HASH_MISMATCH');
      try {
        await this._renameRetry(partial, final);
      } catch (err) {
        throw updateError('DISK_ERROR', { detail: err && err.code });
      }
      this._downloaded = { version: m.version, name: entry.name, file: final, size: entry.size, sha256: entry.sha256 };
      this._revealFile = null;
      this._pruneVersions(m.version);
      this._progress = null;
      this._status = 'ready';
      this._error = null;
      this._log.log(`[updater] downloaded and verified ${entry.name}`);
      return { ok: true };
    } catch (err) {
      this._unlinkQuiet(partial);
      const e = netError(err, ac.signal);
      if (e.updaterCode === 'ABORTED' && this._disposed) return refusal('BUSY');
      if (e.updaterCode === 'CANCELLED') {
        // The user's Cancel: back to offering the download, no error.
        this._progress = null;
        this._phase = null;
        this._status = this._latest ? 'available' : 'idle';
        this._error = null;
        this._log.log('[updater] download cancelled');
        return refusal('CANCELLED');
      }
      this._log.warn(`[updater] download failed: ${e.updaterCode}`);
      return this._fail(e);
    } finally {
      stopWatchdog();
      this._op = null;
      this._abort = null;
      if (!this._disposed) this._emit();
    }
  }

  /** The user's Cancel on a running download (ipc 'update:cancel'). */
  cancelDownload() {
    if (this._disposed || this._op !== 'download' || !this._abort) return refusal('NOT_DOWNLOADING');
    try { this._abort.abort(updateError('CANCELLED')); } catch { /* ignore */ }
    return { ok: true };
  }

  _progressTick(received, total) {
    const percent = Math.min(100, Math.floor((received * 100) / total));
    const changed = !this._progress || this._progress.percent !== percent;
    this._progress = { received, total, percent };
    if (changed) this._emit();
  }

  /** A verified earlier download of this manifest's file (after a restart), or null. */
  async _findDownloaded(m) {
    const entry = m.files[this._platformKey];
    const file = this._path.join(this._updatesDir, m.version, entry.name);
    try {
      const st = this._fs.statSync(file);
      if (!st.isFile()) return null;
      if (st.size === entry.size) {
        const h = await this._hashFile(file);
        if (h.size === entry.size && h.sha256 === entry.sha256) {
          return { version: m.version, name: entry.name, file, size: entry.size, sha256: entry.sha256 };
        }
      }
      this._unlinkQuiet(file); // stale or damaged
    } catch { /* not there */ }
    return null;
  }

  _hashFile(file) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      let size = 0;
      const s = this._fs.createReadStream(file);
      s.on('data', (c) => { size += c.length; hash.update(c); });
      s.on('error', reject);
      s.on('end', () => resolve({ size, sha256: hash.digest('hex') }));
    });
  }

  /** Keep only `keep`'s version folder (U4). */
  _pruneVersions(keep) {
    let names = [];
    try { names = this._fs.readdirSync(this._updatesDir); } catch { return; }
    for (const name of names) {
      if (name !== keep && manifestLib.validVersion(name)) this._rmQuiet(this._path.join(this._updatesDir, name));
    }
  }

  /* ---------------------------------------------------------------- install (U5) */

  /** Only from the user's click (ipc 'update:install'). */
  async install() {
    if (this._disposed || this._op) return refusal('BUSY');
    if (!this._supported) return refusal('NOT_SUPPORTED');
    if (!this._latest || !this._downloaded) return refusal('NOT_READY');
    const blocked = this._blocker();
    if (blocked) return refusal(blocked);
    this._op = 'install';
    this._progress = null;
    const before = { status: this._status, error: this._error };
    this._setStatus('installing', { phase: 'preparing', error: null });
    let quitting = false;
    try {
      const r = this._platform === 'win32' ? await this._installWindows() : await this._installMac();
      quitting = r.ok === true;
      return r;
    } catch (err) {
      // Never the Windows wording on a Mac.
      const e = err && err.updaterCode ? err : updateError(this._platform === 'win32' ? 'LAUNCH_FAILED' : 'SPAWN_FAILED');
      if (!err || !err.updaterCode) this._log.error('[updater] install failed:', err && err.message);
      if (LATE_REFUSALS.has(e.updaterCode)) {
        // A session that started meanwhile (or a quit, the file gone, Tunnelview open in another
        // account): a refusal like the ones above, so the state goes back to what it was. The
        // file is back where it was, or still in its install-* folder (_downloaded points there);
        // only a file that is gone (NOT_READY) has to be downloaded again.
        this._phase = null;
        if (this._downloaded) {
          this._status = before.status;
          this._error = before.error;
        } else {
          this._status = this._latest ? 'available' : 'idle';
          this._error = null;
        }
        this._log.warn(`[updater] install refused: ${e.updaterCode}`);
        return refusal(e.updaterCode);
      }
      if (DAMAGED_CODES.has(e.updaterCode) && this._downloaded) {
        this._unlinkQuiet(this._downloaded.file);
        this._downloaded = null;
      }
      this._log.warn(`[updater] install not started: ${e.updaterCode}`);
      const result = this._fail(e);
      if (REVEAL_CODES.has(e.updaterCode)) this.reveal();
      return result;
    } finally {
      if (!quitting) {
        this._op = null;
        this._emit();
      }
    }
  }

  /** Quit for the installer / helper: after the IPC reply has been sent. */
  _quitSoon() {
    this._phase = 'quitting';
    this._emit();
    setImmediate(() => {
      try { this._quit(); } catch (err) { this._log.error('[updater] quit failed:', err && err.message); }
    });
  }

  _writePending(obj) {
    const P = this._path;
    const file = P.join(this._updatesDir, PENDING_FILE);
    const tmp = `${file}.tmp`;
    this._fs.mkdirSync(this._updatesDir, { recursive: true });
    this._fs.writeFileSync(tmp, `${JSON.stringify({ v: 1, ...obj })}\n`, { mode: 0o600 });
    this._fs.renameSync(tmp, file);
  }

  _removePending() {
    const file = this._path.join(this._updatesDir, PENDING_FILE);
    this._unlinkQuiet(file);
    this._unlinkQuiet(`${file}.tmp`);
  }

  async _installWindows() {
    const P = this._path;
    const fs = this._fs;
    const d = this._downloaded;
    const elevate = P.join(this._resourcesPath, 'elevate.exe');
    if (isUncPath(this._updatesDir) || !this._isFile(elevate)) throw updateError('NOT_SUPPORTED');
    let stageDir;
    try {
      stageDir = fs.mkdtempSync(P.join(this._updatesDir, 'install-'));
    } catch (err) {
      throw updateError('DISK_ERROR', { detail: err && err.code });
    }
    const staged = P.join(stageDir, d.name);
    try {
      await this._renameRetry(d.file, staged);
    } catch (err) {
      this._rmQuiet(stageDir);
      if (err && err.code === 'ENOENT') { this._downloaded = null; throw updateError('NOT_READY'); }
      throw updateError('DISK_ERROR', { detail: err && err.code });
    }
    // Back where download() put it, so a declined prompt or a failed launch can be retried. When
    // the move back fails too (LOCKED: the program that holds the file without delete sharing
    // blocks renames as well), the verified file stays in its install-* folder and the next
    // install() uses it from there (moved again, and re-hashed under EXLOCK before any launch).
    const restore = () => {
      try {
        fs.renameSync(staged, d.file);
        this._rmQuiet(stageDir);
      } catch {
        this._downloaded = { ...d, file: staged };
      }
    };
    let fd;
    try {
      fd = await this._openVerified(staged, d);
    } catch (err) {
      // LOCKED: another program holds the file, nothing was read and nothing proves a change.
      if (err && err.updaterCode === 'LOCKED') { restore(); throw err; }
      this._rmQuiet(stageDir);
      this._downloaded = null;
      throw err;
    }
    // From here to spawn: no await, so nothing runs between the hash check and the launch.
    const blocked = this._disposed ? 'BUSY' : this._blocker(); // disposed: Tunnelview is quitting
    if (blocked) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      restore();
      throw updateError(blocked);
    }
    try {
      this._writePending({ platform: 'win32', from: this._appVersion, to: d.version, at: this._now(), staged });
    } catch (err) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      this._removePending();
      restore();
      throw updateError('DISK_ERROR', { detail: err && err.code });
    }
    try { fs.closeSync(fd); } catch { /* ignore */ }
    let child;
    try {
      child = this._spawn(elevate, [staged, '/S', '--updated', '--force-run'], {
        detached: true,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
      });
    } catch (err) {
      this._log.warn(`[updater] elevate.exe could not start: ${err && (err.code || err.message)}`);
      this._removePending();
      restore();
      throw updateError('LAUNCH_FAILED');
    }
    this._phase = 'waiting-for-approval';
    this._emit();
    this._log.log('[updater] installer handed to elevate.exe; waiting for the administrator prompt');
    const outcome = await new Promise((resolve) => {
      let done = false;
      let stderr = '';
      const finish = (v) => { if (!done) { done = true; resolve({ ...v, stderr }); } };
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (c) => { if (stderr.length < STDERR_CAP) stderr += String(c).slice(0, STDERR_CAP - stderr.length); });
        child.stderr.on('error', () => {});
      }
      child.once('error', (error) => finish({ error }));
      child.once('close', (code) => finish({ code }));
    });
    if (!outcome.error && outcome.code === 0) {
      this._log.log('[updater] the installer is running; quitting');
      this._quitSoon();
      return { ok: true };
    }
    this._removePending();
    restore();
    if (outcome.error) {
      this._log.warn(`[updater] elevate.exe could not start: ${outcome.error.code || outcome.error.message}`);
      throw updateError('LAUNCH_FAILED');
    }
    const m = UAC_RE.exec(outcome.stderr.trim());
    if (m && m[1] === '1223') throw updateError('UAC_DECLINED');
    throw updateError('LAUNCH_FAILED', { winError: m ? m[1] : null });
  }

  /**
   * Open the staged installer so nobody else can open it (Windows: UV_FS_O_EXLOCK; EBUSY while an
   * antivirus scanner holds it is retried for about 10 s), check its size and SHA-256 against the
   * signed manifest, and return the still-open fd. Throws LOCKED when it cannot be opened (the
   * file is left alone: nothing was read, so nothing proves a change) or TAMPERED when what was
   * read does not match (the file is deleted).
   */
  async _openVerified(file, d) {
    const fs = this._fs;
    let fd = null;
    for (let attempt = 0; fd === null; attempt++) {
      try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | this._exlock);
      } catch (err) {
        if (err && err.code === 'EBUSY' && attempt < LOCK_RETRIES) { await this._sleep(LOCK_RETRY_MS); continue; }
        if (err && err.code === 'ENOENT') throw updateError('NOT_READY');
        throw updateError('LOCKED', { detail: err && err.code });
      }
    }
    try {
      const size = fs.fstatSync(fd).size;
      if (size !== d.size) throw updateError('TAMPERED');
      const hash = crypto.createHash('sha256');
      const buf = Buffer.allocUnsafe(1024 * 1024);
      let pos = 0;
      while (pos < size) {
        const n = await new Promise((resolve, reject) => {
          fs.read(fd, buf, 0, Math.min(buf.length, size - pos), pos, (err, bytes) => (err ? reject(err) : resolve(bytes)));
        });
        if (n <= 0) break;
        hash.update(buf.subarray(0, n));
        pos += n;
      }
      if (pos !== d.size || hash.digest('hex') !== d.sha256) throw updateError('TAMPERED');
      return fd;
    } catch (err) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
      this._unlinkQuiet(file);
      throw err && err.updaterCode ? err : updateError('TAMPERED', { detail: err && err.code });
    }
  }

  /** The running bundle: {real, parent} or {code}. */
  _macBundle() {
    const P = this._path;
    const exe = this._execPath;
    if (typeof exe !== 'string' || !P.isAbsolute(exe)) return { code: 'NOT_TUNNELVIEW' };
    const macos = P.dirname(exe);
    const contents = P.dirname(macos);
    const bundle = P.dirname(contents);
    if (P.basename(macos) !== 'MacOS' || P.basename(contents) !== 'Contents' || !bundle.endsWith('.app')) return { code: 'NOT_TUNNELVIEW' };
    let real;
    try {
      if (this._fs.lstatSync(bundle).isSymbolicLink()) return { code: 'NOT_TUNNELVIEW' };
      real = this._fs.realpathSync(bundle);
    } catch {
      return { code: 'NOT_TUNNELVIEW' };
    }
    if (/[\\/]AppTranslocation[\\/]/.test(real)) return { code: 'TRANSLOCATED' };
    if (!real.endsWith('.app')) return { code: 'NOT_TUNNELVIEW' };
    return { real, parent: P.dirname(real) };
  }

  /** → {code, killed, stdout, stderr}; killed: stopped by its time limit (not the tool's own answer). */
  _run(file, args, timeoutMs) {
    return new Promise((resolve) => {
      try {
        this._execFile(file, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
          resolve({
            code: err ? (Number.isInteger(err.code) ? err.code : -1) : 0,
            killed: !!(err && err.killed),
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
          });
        });
      } catch {
        resolve({ code: -1, killed: false, stdout: '', stderr: '' });
      }
    });
  }

  /** One Info.plist value, or null when it is not there. A plutil killed by its time limit: VERIFY_TIMEOUT. */
  async _plist(plist, key) {
    const r = await this._run(MAC_TOOLS.plutil, ['-extract', key, 'raw', '-o', '-', plist], MAC_TOOL_TIMEOUT_MS);
    if (r.killed) throw updateError('VERIFY_TIMEOUT', { detail: 'plutil' });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  /**
   * Another user account runs Tunnelview from this bundle (fast user switching): the helper would
   * only end in `busy` after this copy quit. `ps` failing proves nothing either way: the helper's
   * own check stays the backstop.
   */
  async _inUseByOtherUser(real) {
    if (!this._getuid) return false;
    const me = this._getuid();
    const r = await this._run(MAC_TOOLS.ps, ['-axo', 'uid=,comm='], MAC_TOOL_TIMEOUT_MS);
    if (r.code !== 0) return false;
    const inside = `${real}${this._path.sep}Contents${this._path.sep}`;
    for (const line of r.stdout.split('\n')) {
      const m = /^\s*(\d+)\s+(.+)$/.exec(line);
      if (m && Number(m[1]) !== me && m[2].startsWith(inside)) return true;
    }
    return false;
  }

  _readHead(file, bytes) {
    const fd = this._fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = this._fs.readSync(fd, buf, 0, bytes, 0);
      return buf.subarray(0, n);
    } finally {
      this._fs.closeSync(fd);
    }
  }

  async _installMac() {
    const P = this._path;
    const fs = this._fs;
    const d = this._downloaded;
    const bundle = this._macBundle();
    if (bundle.code) throw updateError(bundle.code);
    const { real, parent } = bundle;
    if (await this._plist(P.join(real, 'Contents', 'Info.plist'), 'CFBundleIdentifier') !== APP_ID) throw updateError('NOT_TUNNELVIEW');
    let stageDir = null;
    let xdir = null;
    const stageError = (err) => updateError(err && err.code === 'EROFS' ? 'READ_ONLY_LOCATION' : 'NOT_WRITABLE', { detail: err && err.code });
    try {
      // Proves this user can write next to the app, and is removed at once: the real staging
      // folder is made only after every check, so a quit during the long checks leaves nothing
      // behind in the app's folder.
      let probe;
      try {
        probe = fs.mkdtempSync(P.join(parent, '.Tunnelview-update-'));
      } catch (err) {
        throw stageError(err);
      }
      try { fs.rmdirSync(probe); } catch { this._rmQuiet(probe); }
      // Writable by other accounts too (/Users/Shared): once the helper has moved the bundle
      // aside, another account could put its own Tunnelview.app at this path.
      if (this._sharedFolder(parent)) throw updateError('SHARED_LOCATION');
      if (this._getuid) {
        let owner = null;
        try { owner = fs.statSync(real).uid; } catch { /* unknown */ }
        if (owner !== this._getuid()) throw updateError('NOT_OWNER');
      }
      // The zip is checked against the signed manifest before anything reads it.
      let h;
      try { h = await this._hashFile(d.file); } catch { h = null; }
      if (!h || h.size !== d.size || h.sha256 !== d.sha256) throw updateError('TAMPERED');

      try {
        xdir = fs.mkdtempSync(P.join(this._updatesDir, d.version, 'x-'));
      } catch (err) {
        throw updateError('DISK_ERROR', { detail: err && err.code });
      }
      // The zip matched its signed hash just above, so a failure here is local (free space, the
      // 300 s limit on a slow disk): EXTRACT_FAILED keeps the zip.
      const x = await this._run(MAC_TOOLS.ditto, ['-x', '-k', '--noqtn', d.file, xdir], MAC_DITTO_TIMEOUT_MS);
      if (x.code !== 0) throw updateError('EXTRACT_FAILED', { detail: `ditto ${x.code}` });
      let names = [];
      try { names = fs.readdirSync(xdir); } catch { names = []; }
      if (names.length !== 1 || names[0] !== MAC_APP_NAME) throw updateError('BAD_BUNDLE');
      const newApp = P.join(xdir, MAC_APP_NAME);
      let st = null;
      try { st = fs.lstatSync(newApp); } catch { st = null; }
      if (!st || st.isSymbolicLink() || !st.isDirectory()) throw updateError('BAD_BUNDLE');

      const plist = P.join(newApp, 'Contents', 'Info.plist');
      if (await this._plist(plist, 'CFBundleIdentifier') !== APP_ID) throw updateError('BAD_BUNDLE');
      if (await this._plist(plist, 'CFBundleShortVersionString') !== d.version) throw updateError('WRONG_VERSION');
      if (await this._plist(plist, 'CFBundleExecutable') !== MAC_EXECUTABLE) throw updateError('BAD_BUNDLE');
      // A bundle macOS refuses to open ("You can't use this version of the application with this
      // version of macOS") must never replace one that works.
      const minOS = await this._plist(plist, 'LSMinimumSystemVersion');
      if (minOS !== null && !osAtLeast(this._systemVersion, minOS)) {
        this._osRefused = { to: d.version, need: minOS, current: this._appVersion };
        throw updateError('OS_TOO_OLD', this._osRefused);
      }
      let cpus = [];
      try { cpus = machoCpuTypes(this._readHead(P.join(newApp, 'Contents', 'MacOS', MAC_EXECUTABLE), 4096)); } catch { cpus = []; }
      if (!cpus.includes(MACHO_CPU[this._platformKey])) throw updateError('WRONG_ARCH');
      // Killed by its time limit (a slow disk): nothing proves the bundle wrong, so try again.
      const codesignOk = async (app, failCode) => {
        const r = await this._run(MAC_TOOLS.codesign, ['--verify', '--deep', '--strict', '--verbose=2', app], MAC_CODESIGN_TIMEOUT_MS);
        if (r.killed) throw updateError('VERIFY_TIMEOUT', { detail: 'codesign' });
        if (r.code !== 0) throw updateError(failCode.code, failCode.info);
      };
      await codesignOk(newApp, { code: 'CODESIGN_FAILED' });
      await this._run(MAC_TOOLS.xattr, ['-d', '-r', '-s', 'com.apple.quarantine', newApp], MAC_TOOL_TIMEOUT_MS);
      if ((await this._run(MAC_TOOLS.xattr, ['-p', 'com.apple.quarantine', newApp], MAC_TOOL_TIMEOUT_MS)).code === 0) throw updateError('QUARANTINED');
      // Before anything quits: a copy in another account would make the helper end in `busy`.
      if (await this._inUseByOtherUser(real)) throw updateError('IN_USE_BY_OTHER_USER');

      // Tunnelview is quitting (dispose): nothing goes next to the app, nothing is handed over.
      if (this._disposed) throw updateError('BUSY');
      // Next to the destination, so both of the helper's moves are renames on one volume.
      try {
        stageDir = fs.mkdtempSync(P.join(parent, '.Tunnelview-update-'));
      } catch (err) {
        throw stageError(err);
      }
      const staged = P.join(stageDir, MAC_APP_NAME);
      try {
        fs.renameSync(newApp, staged);
      } catch (err) {
        if (!err || err.code !== 'EXDEV') throw updateError('NOT_WRITABLE', { detail: err && err.code });
        // Our own copy to the app's volume, of a bundle that already passed codesign: a failure
        // is the copy's (the target volume), not the download's, so the zip is kept.
        if ((await this._run(MAC_TOOLS.ditto, [newApp, staged], MAC_DITTO_TIMEOUT_MS)).code !== 0) throw updateError('NOT_WRITABLE', { detail: 'copy' });
        await codesignOk(staged, { code: 'NOT_WRITABLE', info: { detail: 'copy codesign' } });
      }
      this._rmQuiet(xdir);
      xdir = null;

      const backup = P.join(parent, `.Tunnelview-old-${crypto.randomBytes(6).toString('hex')}.app`);
      const resultFile = P.join(this._updatesDir, RESULT_FILE);
      if (![real, stageDir, backup, resultFile].every((a) => P.isAbsolute(a) && !/[\0\n\r]/.test(a))) throw updateError('NOT_SUPPORTED');
      // From here to spawn: no await.
      const blocked = this._disposed ? 'BUSY' : this._blocker();
      if (blocked) throw updateError(blocked);
      this._unlinkQuiet(resultFile);
      try {
        this._writePending({ platform: 'darwin', from: this._appVersion, to: d.version, at: this._now(), dest: real, stage: stageDir, backup });
      } catch (err) {
        this._removePending();
        throw updateError('DISK_ERROR', { detail: err && err.code });
      }
      try {
        await new Promise((resolve, reject) => {
          const child = this._spawn(MAC_TOOLS.sh, ['-c', MAC_SWAP_SCRIPT, 'tunnelview-update', String(this._pid), real, stageDir, backup, resultFile, APP_ID], {
            detached: true,
            stdio: 'ignore',
            cwd: '/',
            env: { PATH: MAC_HELPER_ENV_PATH, HOME: this._homedir },
          });
          child.once('error', reject);
          child.once('spawn', () => { try { child.unref(); } catch { /* ignore */ } resolve(); });
        });
      } catch (err) {
        this._removePending();
        throw updateError('SPAWN_FAILED', { detail: err && err.code });
      }
      stageDir = null; // the helper owns it now
      this._log.log('[updater] update helper started; quitting');
      this._quitSoon();
      return { ok: true };
    } finally {
      if (xdir) this._rmQuiet(xdir);
      if (stageDir) this._rmQuiet(stageDir);
    }
  }

  /* ---------------------------------------------------------------- reveal */

  reveal() {
    const file = (this._downloaded && this._downloaded.file) || this._revealFile;
    if (!file || !this._isFile(file)) return refusal('NOT_READY');
    try {
      this._showItemInFolder(file);
      return { ok: true };
    } catch {
      return refusal('NOT_READY');
    }
  }

  /* ---------------------------------------------------------------- next start */

  _processPending() {
    const P = this._path;
    const fs = this._fs;
    const file = P.join(this._updatesDir, PENDING_FILE);
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
    const resultFile = P.join(this._updatesDir, RESULT_FILE);
    let result = '';
    try { result = fs.readFileSync(resultFile, 'utf8').trim().slice(0, 32); } catch { /* none */ }
    let p = null;
    try { p = raw.length <= PENDING_MAX_BYTES ? JSON.parse(raw) : null; } catch { p = null; }
    const valid = isObj(p) && p.v === 1 && manifestLib.validVersion(p.to);
    const done = valid && !this._isNewer(p.to);
    // Decided before anything is deleted: an old copy started by hand while the installer or the
    // helper still works must leave the marker (and the files the install uses) to the next start.
    if (valid && !done && this._installStillRunning(p, result)) {
      this._pendingDeferred = true;
      this._log.log(`[updater] the update to ${p.to} is still being installed; the next start reports how it went`);
      return;
    }
    for (const f of [file, `${file}.tmp`, resultFile, `${resultFile}.tmp`]) this._unlinkQuiet(f);
    if (!valid) {
      this._log.warn('[updater] ignored an unreadable pending-install marker');
      return;
    }
    this._log.log(`[updater] the update to ${p.to} ${done ? 'completed' : 'did not complete'}${result ? ` (helper: ${result.replace(/[^a-z-]/g, '')})` : ''}`);
    if (p.platform === 'darwin') this._cleanupMacStaging(p, done);
    if (done) {
      // The version that actually runs: the marker can outlive a failed install, and a newer
      // version installed by hand later must not be reported as the marker's target.
      const to = this._running ? this._running.base : p.to;
      this._justUpdated = { from: manifestLib.validVersion(p.from) ? p.from : '', to };
      return;
    }
    const name = this._platformKey ? manifestLib.assetName(this._platformKey, p.to) : null;
    const keep = name ? P.join(this._updatesDir, p.to, name) : null;
    const staged = p.platform === 'win32' ? this._stagedInstaller(p) : null;
    let stuck = null;
    if (staged && keep) {
      // The staged installer goes back next to the downloads, for another try.
      try {
        fs.mkdirSync(P.dirname(keep), { recursive: true });
        fs.renameSync(staged, keep);
      } catch {
        // Held by another program: it stays where it is (spared by _cleanupUpdatesDir this time)
        // and "Show in folder" shows it there.
        stuck = staged;
        this._keepInstallDir = P.dirname(staged);
      }
    }
    if (keep && this._isFile(keep)) this._revealFile = keep;
    else if (stuck && this._isFile(stuck)) this._revealFile = stuck;
    let code = 'INSTALL_INCOMPLETE';
    if (p.platform === 'darwin' && ['precondition', 'move-old-failed', 'move-new-failed'].includes(result)) code = 'MAC_REPLACE_FAILED';
    // The helper found Tunnelview still running from the bundle (another user account, or a copy
    // that outlived the old app): say so, "check for updates" alone would fail the same way.
    else if (p.platform === 'darwin' && result === 'busy') code = 'MAC_APP_IN_USE';
    const e = updateError(code, { to: p.to, current: this._appVersion });
    this._fail(e);
    this._nextStartFailure = { to: p.to, code: e.updaterCode };
  }

  /** pending.json's Windows `staged` path when it is our own staged installer for `to`, else null. */
  _stagedInstaller(p) {
    const P = this._path;
    if (!this._platformKey || typeof p.staged !== 'string') return null;
    const name = manifestLib.assetName(this._platformKey, p.to);
    const stageDir = P.dirname(p.staged);
    if (P.basename(p.staged) !== name || P.dirname(stageDir) !== this._updatesDir || !INSTALL_DIR_RE.test(P.basename(stageDir))) return null;
    return this._isFile(p.staged) ? p.staged : null;
  }

  /**
   * The install recorded in pending.json may still be running (this is an old copy someone started
   * meanwhile):
   *   Windows  the staged installer cannot be opened exclusively (NSIS keeps its own exe open for
   *            the whole run), at most WIN_INSTALL_WINDOW_MS after the hand-over;
   *   macOS    the helper has written no outcome yet, at most MAC_HELPER_WINDOW_MS after it.
   * The age caps keep a stale marker (or an antivirus holding the file) from deferring forever.
   */
  _installStillRunning(p, result) {
    const age = Number.isSafeInteger(p.at) ? this._now() - p.at : -1;
    if (age < 0) return false;
    if (p.platform === 'win32') {
      if (!this._exlock || age > WIN_INSTALL_WINDOW_MS) return false;
      const staged = this._stagedInstaller(p);
      if (!staged) return false;
      let fd;
      try {
        fd = this._fs.openSync(staged, this._fs.constants.O_RDONLY | this._exlock);
      } catch (err) {
        if (err && err.code !== 'EBUSY') return false;
        this._busyInstallDir = this._path.dirname(staged);
        return true;
      }
      try { this._fs.closeSync(fd); } catch { /* ignore */ }
      return false;
    }
    if (p.platform === 'darwin') return !result && age <= MAC_HELPER_WINDOW_MS;
    return false;
  }

  /** Our own leftover next to the app: matches `re`, not a symlink, owned by this user. */
  _rmOwnedLeftover(target, parent, re) {
    const P = this._path;
    if (typeof target !== 'string' || P.dirname(target) !== parent || !re.test(P.basename(target))) return;
    try {
      const st = this._fs.lstatSync(target);
      if (st.isSymbolicLink()) return;
      if (this._getuid && st.uid !== this._getuid()) return;
    } catch {
      return;
    }
    this._rmQuiet(target);
  }

  /** Leftovers next to the app: our staging folder always, the old bundle only after success. */
  _cleanupMacStaging(p, done) {
    const P = this._path;
    if (typeof p.dest !== 'string' || !P.isAbsolute(p.dest)) return;
    const parent = P.dirname(p.dest);
    this._rmOwnedLeftover(p.stage, parent, MAC_STAGE_RE);
    if (done) this._rmOwnedLeftover(p.backup, parent, MAC_BACKUP_RE);
  }

  /**
   * Staging folders next to the running app that no marker names (Tunnelview quit or crashed
   * before it handed over). Never while a helper may still be using one (_pendingDeferred).
   */
  _sweepMacStaging() {
    const b = this._macBundle();
    if (b.code) return;
    let names = [];
    try { names = this._fs.readdirSync(b.parent); } catch { return; }
    for (const n of names) {
      if (MAC_STAGE_RE.test(n)) this._rmOwnedLeftover(this._path.join(b.parent, n), b.parent, MAC_STAGE_RE);
    }
  }

  /**
   * install-* folders, extraction leftovers, .partial files, and downloads not newer than this
   * version. Not the files of an install that is still running (_processPending).
   */
  _cleanupUpdatesDir() {
    const P = this._path;
    let names = [];
    try { names = this._fs.readdirSync(this._updatesDir); } catch { return; }
    for (const name of names) {
      const full = P.join(this._updatesDir, name);
      if (INSTALL_DIR_RE.test(name)) {
        if (full !== this._busyInstallDir && full !== this._keepInstallDir) this._rmQuiet(full);
      } else if (name === `${RESULT_FILE}.tmp` || name === `${PENDING_FILE}.tmp`) {
        if (!this._pendingDeferred) this._rmQuiet(full);
      } else if (manifestLib.validVersion(name)) {
        if (!this._isNewer(name)) { this._rmQuiet(full); continue; }
        let inner = [];
        try { inner = this._fs.readdirSync(full); } catch { inner = []; }
        for (const n of inner) if (n.endsWith('.partial') || EXTRACT_DIR_RE.test(n)) this._rmQuiet(P.join(full, n));
      }
    }
  }

  /* ---------------------------------------------------------------- fs helpers */

  _isFile(p) {
    try { return this._fs.statSync(p).isFile(); } catch { return false; }
  }

  _unlinkQuiet(p) {
    try { this._fs.unlinkSync(p); } catch { /* ignore */ }
  }

  _rmQuiet(p) {
    try { this._fs.rmSync(p, { recursive: true, force: true, maxRetries: 2 }); } catch (err) { this._log.warn('[updater] could not remove a leftover:', err && err.code); }
  }

  _sleep(ms) {
    return new Promise((resolve) => this._timers.setTimeout(resolve, ms));
  }

  /** Windows: rename can fail for a moment while an antivirus scanner holds the file. */
  async _renameRetry(from, to) {
    for (let attempt = 0; ; attempt++) {
      try {
        this._fs.renameSync(from, to);
        return;
      } catch (err) {
        if (attempt >= RENAME_RETRIES || !err || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) throw err;
        await this._sleep(50 * (attempt + 1));
      }
    }
  }
}

function createUpdater(deps) {
  return new Updater(deps);
}

module.exports = {
  createUpdater,
  Updater,
  MANIFEST_URL,
  RELEASES_URL,
  ALLOWED_HOSTS,
  MAX_REDIRECTS,
  FIRST_CHECK_DELAY_MS,
  CHECK_INTERVAL_MS,
  RETRY_AFTER_FAILURE_MS,
  APP_ID,
  MAC_SWAP_SCRIPT,
  MESSAGES,
  STATUSES,
  PHASES,
  BLOCKERS,
  UV_FS_O_EXLOCK,
  messageFor,
  allowedUrl,
  assetUrl,
  platformKeyFor,
  machoCpuTypes,
  parseRunningVersion,
  osAtLeast,
  STALL_WINDOW_MS,
  STALL_MIN_BYTES,
};
