'use strict';
/*
 * node --test test/updater-install.test.js — src/main/updater.js install flows (DECISIONS U5, U8)
 * and what the next start makes of them. spawn / execFile are fakes: no installer, elevate.exe,
 * ditto, codesign, plutil, xattr or open ever runs. The "bundles" and downloads are small files
 * in temp folders; the HTTPS layer is the fake from test/support/update-fixtures.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { spawnSync } = require('child_process');
const U = require('../src/main/updater');
const F = require('./support/update-fixtures');

test.after(F.cleanupTmp);

const KEY = F.makeKey();
const REL = F.makeRelease('0.4.0');
const MANIFEST = F.signedManifest(KEY, REL);
const GH = 'https://github.com/NamiNaone99/Tunnelview';
const WIN_NAME = 'Tunnelview-Setup-0.4.0-x64.exe';
const MAC_NAME = 'Tunnelview-0.4.0-mac-arm64.zip';
const APP_ID = 'io.github.naminaone99.tunnelview';
// MACFLOW-2: a bundle that fails a check on this Mac keeps the zip and never says "download again".
const CHECK_FAILED = 'The downloaded update did not pass the macOS checks, so it was not installed. Get the new version from the GitHub releases page.';

/** Every manifest and asset straight from github.com (redirects are covered by updater.test.js). */
function directGithub(release = REL, manifest = MANIFEST) {
  return F.fakeTransport((url) => {
    if (url === U.MANIFEST_URL) return { status: 200, body: manifest };
    for (const [name, body] of Object.entries(release.assets)) {
      if (url === `${GH}/releases/download/v${release.version}/${name}`) return { status: 200, body };
    }
    return { status: 404 };
  });
}

const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
async function waitFor(pred, what = 'condition') {
  for (let i = 0; i < 400; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}
/** Small delays run at once, the 30 s check deadline stays a real timer. */
const fastTimers = {
  setTimeout: (fn, ms) => (ms < 1000 ? { imm: setImmediate(fn) } : { t: setTimeout(fn, ms) }),
  clearTimeout: (h) => { if (h && h.imm) clearImmediate(h.imm); else if (h && h.t) clearTimeout(h.t); },
};

/* ================================================================== Windows */

/**
 * A Windows updater with the 0.4.0 installer downloaded, installed the way the NSIS installer
 * leaves it (elevate.exe in resources, `Uninstall Tunnelview.exe` next to the exe). The fake
 * elevate.exe records its call (and what was on disk at that moment), then exits with `exitCode`
 * after writing `stderr` — or waits for ctl.release() when `hold` is set.
 */
async function readyWin(o = {}) {
  const userData = F.tmpDir();
  const resources = path.join(userData, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'elevate.exe'), 'MZ');
  fs.writeFileSync(path.join(userData, 'Uninstall Tunnelview.exe'), 'MZ');
  const updates = o.updatesDir || path.join(userData, 'updates');
  const ctl = { exitCode: o.exitCode === undefined ? 0 : o.exitCode, stderr: o.stderr || '', spawnError: o.spawnError || null, release: null };
  const spawned = [];
  const spawn = (file, args, opts) => {
    const child = new EventEmitter();
    child.stderr = new PassThrough();
    const staged = args[0];
    spawned.push({
      file, args: [...args], opts,
      staged: fs.existsSync(staged) ? fs.readFileSync(staged) : null,
      pending: readJson(path.join(updates, 'pending.json')),
    });
    const finish = () => {
      if (ctl.spawnError) { child.emit('error', ctl.spawnError); return; }
      if (ctl.stderr) child.stderr.write(ctl.stderr);
      child.stderr.end();
      setImmediate(() => child.emit('close', ctl.exitCode));
    };
    if (o.hold) ctl.release = finish; else setImmediate(finish);
    return child;
  };
  const quits = { n: 0 };
  const shown = [];
  const opens = [];
  const baseFs = o.fs || fs;
  const recordingFs = Object.assign(Object.create(baseFs), {
    openSync(p, flags, mode) { if (typeof flags === 'number') opens.push(flags); return baseFs.openSync(p, flags, mode); },
  });
  const u = U.createUpdater({
    appVersion: '0.3.0',
    isPackaged: true,
    settings: F.fakeSettings(),
    userData,
    updatesDir: o.updatesDir,
    resourcesPath: resources,
    execPath: path.join(userData, 'Tunnelview.exe'),
    platform: 'win32',
    arch: 'x64',
    path,
    fs: recordingFs,
    transport: directGithub(),
    keys: KEY.keys,
    spawn,
    timers: fastTimers,
    quit: () => { quits.n++; },
    showItemInFolder: (f) => shown.push(f),
    log: F.quietLog,
    ...o.deps,
  });
  const states = [];
  u.on('state', (s) => states.push(s));
  await u.check();
  assert.deepEqual(await u.download(), { ok: true });
  return { u, userData, updates, resources, spawned, quits, states, shown, opens, ctl, file: path.join(updates, '0.4.0', WIN_NAME) };
}

test('Windows: elevate.exe starts the re-verified installer with /S --updated --force-run, no shell; quit after exit 0', async () => {
  const t = await readyWin();
  const r = await t.u.install();
  assert.deepEqual(r, { ok: true });
  assert.equal(t.spawned.length, 1);
  const call = t.spawned[0];
  assert.equal(call.file, path.join(t.resources, 'elevate.exe'), 'through elevate.exe: a direct spawn gets EACCES and no UAC prompt');
  const staged = call.args[0];
  assert.deepEqual(call.args.slice(1), ['/S', '--updated', '--force-run'], 'no -wait, no /D=, no --delete-app-data');
  assert.equal(path.basename(staged), WIN_NAME);
  assert.match(path.basename(path.dirname(staged)), /^install-[A-Za-z0-9]{6}$/, 'a fresh folder that holds only the installer');
  assert.equal(path.dirname(path.dirname(staged)), t.updates);
  assert.ok(call.staged && call.staged.equals(REL.assets[WIN_NAME]), 'the verified bytes are what gets launched');
  assert.deepEqual(call.opts, { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  assert.deepEqual(call.pending, { v: 1, platform: 'win32', from: '0.3.0', to: '0.4.0', at: call.pending.at, staged });
  assert.equal(typeof call.pending.at, 'number');
  // The re-hash opened the staged file exclusively (UV_FS_O_EXLOCK on a Windows host).
  const expected = fs.constants.O_RDONLY | (process.platform === 'win32' ? U.UV_FS_O_EXLOCK : 0);
  assert.deepEqual(t.opens, [expected]);
  await F.settle();
  assert.equal(t.quits.n, 1, 'quits only once elevate.exe reported the installer running');
  const phases = t.states.filter((s) => s.status === 'installing').map((s) => s.phase);
  assert.deepEqual(phases, ['preparing', 'waiting-for-approval', 'quitting']);
  assert.equal((await t.u.install()).code, 'BUSY', 'nothing else starts while quitting');
});

test('Windows: UAC declined → UAC_DECLINED, the installer goes back, nothing quits; a retry works', async () => {
  const t = await readyWin({ exitCode: 1, stderr: 'C:\\Users\\me\\AppData\\Roaming\\Tunnelview\\updates\\install-Ab3dE6\\Tunnelview-Setup-0.4.0-x64.exe could not be launched: 1223\r\n' });
  const r = await t.u.install();
  assert.deepEqual(r, { ok: false, code: 'UAC_DECLINED', message: 'Update cancelled: administrator permission was not given.' });
  await F.settle();
  assert.equal(t.quits.n, 0);
  assert.ok(fs.readFileSync(t.file).equals(REL.assets[WIN_NAME]), 'kept for another try');
  assert.deepEqual(fs.readdirSync(t.updates), ['0.4.0'], 'no pending marker, no install-* folder');
  const s = t.u.getState();
  assert.equal(s.status, 'error');
  assert.equal(s.error.code, 'UAC_DECLINED');
  assert.equal(s.downloaded, true);
  t.ctl.exitCode = 0;
  t.ctl.stderr = '';
  assert.deepEqual(await t.u.install(), { ok: true });
  await F.settle();
  assert.equal(t.quits.n, 1);
});

test('Windows: other launch failures → LAUNCH_FAILED (with the Windows error), the installer kept', async () => {
  let t = await readyWin({ exitCode: 1, stderr: 'C:\\x\\Tunnelview-Setup-0.4.0-x64.exe could not be launched: 1260\n' });
  let r = await t.u.install();
  assert.equal(r.code, 'LAUNCH_FAILED');
  assert.equal(r.message, 'Windows could not start the installer (error 1260). You can run the downloaded installer yourself.');
  assert.ok(fs.existsSync(t.file));
  assert.deepEqual(t.u.reveal(), { ok: true });
  assert.deepEqual(t.shown, [t.file]);

  t = await readyWin({ exitCode: 1, stderr: 'Unrecognized Flag: -x\n' });
  r = await t.u.install();
  assert.equal(r.code, 'LAUNCH_FAILED');
  assert.equal(r.message, 'Windows could not start the installer. You can run the downloaded installer yourself.');

  t = await readyWin({ spawnError: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });
  r = await t.u.install();
  assert.equal(r.code, 'LAUNCH_FAILED');
  assert.ok(fs.existsSync(t.file));
  assert.equal(fs.existsSync(path.join(t.updates, 'pending.json')), false);
  await F.settle();
  assert.equal(t.quits.n, 0);
});

test('Windows: a file changed after the download is never launched (TAMPERED) and is deleted', async () => {
  const t = await readyWin();
  const bytes = Buffer.from(REL.assets[WIN_NAME]);
  bytes[bytes.length - 1] ^= 0x55; // same size, other content
  fs.writeFileSync(t.file, bytes);
  const r = await t.u.install();
  assert.deepEqual(r, { ok: false, code: 'TAMPERED', message: U.MESSAGES.TAMPERED });
  assert.equal(t.spawned.length, 0);
  assert.equal(t.u.getState().downloaded, false, 'download again');
  assert.deepEqual(fs.readdirSync(t.updates).sort(), ['0.4.0']);
  assert.deepEqual(fs.readdirSync(path.join(t.updates, '0.4.0')), []);
});

test('Windows: EBUSY on the exclusive open is retried (antivirus); a lock that stays is LOCKED and keeps the download', async () => {
  let busy = 2;
  const busyFs = Object.assign(Object.create(fs), {
    openSync(p, flags, mode) {
      if (typeof flags === 'number' && busy-- > 0) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return fs.openSync(p, flags, mode);
    },
  });
  let t = await readyWin({ fs: busyFs });
  assert.deepEqual(await t.u.install(), { ok: true });
  assert.equal(t.spawned.length, 1);

  // Held for longer than the retries (about 10 s): another program has it, nothing proves a change.
  busy = 1000;
  t = await readyWin({ fs: busyFs });
  const r = await t.u.install();
  assert.deepEqual(r, { ok: false, code: 'LOCKED', message: U.MESSAGES.LOCKED });
  assert.match(r.message, /Another program .* is using the update file\. Try again in a moment\./);
  assert.equal(t.spawned.length, 0);
  assert.ok(fs.readFileSync(t.file).equals(REL.assets[WIN_NAME]), 'the verified download is back where it was, not deleted');
  assert.deepEqual(fs.readdirSync(t.updates), ['0.4.0'], 'no install-* folder, no pending.json');
  let s = t.u.getState();
  assert.equal(s.downloaded, true);
  assert.equal(s.status, 'error');
  assert.equal(s.error.code, 'LOCKED');
  assert.equal(t.u.isInstalling(), false);
  // Once the other program lets go, the same download installs.
  busy = 0;
  assert.deepEqual(await t.u.install(), { ok: true });
  assert.equal(t.spawned.length, 1);
  assert.ok(t.spawned[0].staged.equals(REL.assets[WIN_NAME]));
  s = t.u.getState();
  assert.equal(s.error, null);
});

test('Windows: when the installer cannot be moved back (still locked), the staged copy stays the download; the next install uses it', async () => {
  // WINFLOW-1: LOCKED after the move into install-*, and the move back fails too.
  let busy = 1000;
  let holdBack = true;
  const heldFs = Object.assign(Object.create(fs), {
    openSync(p, flags, mode) {
      if (typeof flags === 'number' && busy-- > 0) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return fs.openSync(p, flags, mode);
    },
    renameSync(from, to) {
      if (holdBack && /[\\/]install-[A-Za-z0-9]{6}[\\/]/.test(from)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return fs.renameSync(from, to);
    },
  });
  const t = await readyWin({ fs: heldFs });
  const r = await t.u.install();
  assert.equal(r.code, 'LOCKED');
  assert.equal(t.spawned.length, 0);
  const installDirs = fs.readdirSync(t.updates).filter((n) => n.startsWith('install-'));
  assert.equal(installDirs.length, 1, 'the install-* folder that holds it stays');
  const staged = path.join(t.updates, installDirs[0], WIN_NAME);
  assert.ok(fs.readFileSync(staged).equals(REL.assets[WIN_NAME]), 'the verified installer is not lost');
  let s = t.u.getState();
  assert.equal(s.downloaded, true, 'still offered: Restart and install, no new download');
  assert.deepEqual(t.u.reveal(), { ok: true });
  assert.deepEqual(t.shown, [staged], 'Show in folder points at the file that exists');
  // The other program lets go: the next install moves it from there, re-hashes it, launches it.
  busy = 0;
  holdBack = false;
  assert.deepEqual(await t.u.install(), { ok: true });
  assert.equal(t.spawned.length, 1);
  assert.ok(t.spawned[0].staged.equals(REL.assets[WIN_NAME]));
  s = t.u.getState();
  assert.equal(s.error, null);
});

test('Windows: a session that starts during the verification stops the launch, as a refusal (the state goes back)', async () => {
  // The blocker turns on at the exclusive open (the re-hash), i.e. after install()'s first gate.
  let blocker = null;
  const gateFs = Object.assign(Object.create(fs), {
    openSync(p, flags, mode) { if (typeof flags === 'number') blocker = 'INCOMING_SESSION'; return fs.openSync(p, flags, mode); },
  });
  const t = await readyWin({ fs: gateFs, deps: { sessionBlocker: () => blocker } });
  t.states.length = 0;
  const r = await t.u.install();
  assert.deepEqual(r, { ok: false, code: 'INCOMING_SESSION', message: U.MESSAGES.INCOMING_SESSION });
  assert.ok(t.states.some((s) => s.status === 'installing' && s.phase === 'preparing'), 'got past the first gate');
  assert.equal(t.spawned.length, 0);
  assert.ok(fs.existsSync(t.file), 'the installer is back');
  assert.deepEqual(fs.readdirSync(t.updates), ['0.4.0'], 'no install-* folder, no pending.json');
  let s = t.u.getState();
  assert.equal(s.status, 'ready', 'a refusal, not status error');
  assert.equal(s.error, null);
  assert.equal(s.downloaded, true);
  assert.equal(s.blocked, 'INCOMING_SESSION');
  assert.deepEqual(t.states.map((x) => x.status), ['installing', 'ready']);
  assert.equal(t.u.isInstalling(), false);
  blocker = null;
  t.u.sessionsChanged();
  s = t.u.getState();
  assert.equal(s.status, 'ready');
  assert.equal(s.blocked, null);
  assert.equal(s.error, null);
});

test('Windows: an installer gone before the launch is NOT_READY (a refusal; download again)', async () => {
  const t = await readyWin();
  fs.unlinkSync(t.file);
  t.states.length = 0;
  const r = await t.u.install();
  assert.deepEqual(r, { ok: false, code: 'NOT_READY', message: U.MESSAGES.NOT_READY });
  const s = t.u.getState();
  assert.equal(s.status, 'available');
  assert.equal(s.downloaded, false);
  assert.equal(s.error, null);
  assert.equal(t.spawned.length, 0);
  assert.ok(!t.states.some((x) => x.status === 'error'));
});

test('Windows: while the UAC prompt is open no session may start (isInstalling), and a declined prompt ends that', async () => {
  const t = await readyWin({ hold: true, exitCode: 1, stderr: 'C:\\x\\Tunnelview-Setup-0.4.0-x64.exe could not be launched: 1223\r\n' });
  assert.equal(t.u.isInstalling(), false);
  const p = t.u.install();
  assert.equal(t.u.isInstalling(), true, 'from the first check on (phase preparing)');
  await waitFor(() => t.u.getState().phase === 'waiting-for-approval', 'the UAC wait');
  assert.equal(t.u.isInstalling(), true, 'index.js / host-server / ipc refuse new sessions now');
  t.ctl.release();
  assert.equal((await p).code, 'UAC_DECLINED');
  assert.equal(t.u.isInstalling(), false, 'the gate is released again');

  const ok = await readyWin({ hold: true });
  const q = ok.u.install();
  await waitFor(() => ok.ctl.release !== null, 'the spawn');
  assert.equal(ok.u.isInstalling(), true);
  ok.ctl.release();
  assert.deepEqual(await q, { ok: true });
  assert.equal(ok.u.isInstalling(), true, 'still installing until the app has quit');
});

test('Windows: a quit (dispose) during the verification launches nothing (BUSY refusal)', async () => {
  let t;
  const gateFs = Object.assign(Object.create(fs), {
    openSync(p, flags, mode) { if (typeof flags === 'number') t.u.dispose(); return fs.openSync(p, flags, mode); },
  });
  t = await readyWin({ fs: gateFs });
  const r = await t.u.install();
  assert.equal(r.code, 'BUSY');
  assert.equal(t.spawned.length, 0);
  assert.ok(fs.existsSync(t.file));
  assert.deepEqual(fs.readdirSync(t.updates), ['0.4.0']);
});

test('Windows: updates live in the given updatesDir (index.js: %LOCALAPPDATA%), never a UNC path', async () => {
  const local = path.join(F.tmpDir(), 'LocalAppData', 'Tunnelview', 'updates');
  const t = await readyWin({ updatesDir: local });
  assert.ok(fs.existsSync(path.join(local, '0.4.0', WIN_NAME)), 'downloaded there');
  assert.equal(fs.existsSync(path.join(t.userData, 'updates')), false, 'nothing under the roaming userData');
  assert.deepEqual(await t.u.install(), { ok: true });
  const staged = t.spawned[0].args[0];
  assert.equal(path.dirname(path.dirname(staged)), local, 'staged under updatesDir');
  assert.ok(!staged.startsWith(path.join(t.userData, 'updates')));
  assert.equal(t.spawned[0].pending.staged, staged);

  // A redirected folder (UNC): this copy cannot install, and nothing is ever spawned.
  const unc = U.createUpdater({
    appVersion: '0.3.0', isPackaged: true, settings: F.fakeSettings(), userData: t.userData,
    updatesDir: '\\\\fs\\home$\\alice\\AppData\\Roaming\\Tunnelview\\updates',
    resourcesPath: t.resources, execPath: path.join(t.userData, 'Tunnelview.exe'),
    platform: 'win32', arch: 'x64', path: path.win32, transport: directGithub(), keys: KEY.keys,
    spawn: () => assert.fail('spawned'), log: F.quietLog,
  });
  assert.equal(unc.getState().supported, false);
  assert.equal((await unc.install()).code, 'NOT_SUPPORTED');
  // Defense in depth inside the Windows install itself.
  unc._supported = true;
  unc._latest = { version: '0.4.0', files: REL.files };
  unc._downloaded = { version: '0.4.0', name: WIN_NAME, file: 'x', size: 1, sha256: 'x' };
  assert.equal((await unc.install()).code, 'NOT_SUPPORTED');
});

/* ================================================================== macOS */

const machO = (cpu) => { const b = Buffer.alloc(64); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(cpu, 4); return b; };
const CPU_ARM64 = 0x0100000c;
const CPU_X64 = 0x01000007;

/**
 * A Mac updater whose running bundle is <root>/Applications/Tunnelview.app (or a translocated
 * one), with the 0.4.0 arm64 zip downloaded. The fake tools answer like plutil / ditto / codesign
 * / xattr would; "ditto -x" writes a small bundle with the given Info.plist values and CPU type.
 */
async function readyMac(o = {}) {
  const root = F.tmpDir();
  const userData = path.join(root, 'userData');
  fs.mkdirSync(userData, { recursive: true });
  const apps = o.translocated ? path.join(root, 'AppTranslocation', '1B2C3D', 'd') : path.join(root, 'Applications');
  const bundle = path.join(apps, 'Tunnelview.app');
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents', 'MacOS', 'Tunnelview'), machO(CPU_ARM64));
  fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), '<plist/>');
  const real = fs.realpathSync(bundle);
  const updates = path.join(userData, 'updates');
  const running = { CFBundleIdentifier: o.runningId || APP_ID };
  const fresh = { CFBundleIdentifier: o.id || APP_ID, CFBundleShortVersionString: o.version || '0.4.0', CFBundleExecutable: o.exe || 'Tunnelview' };
  if (o.minOS) fresh.LSMinimumSystemVersion = o.minOS;
  const uid = fs.statSync(real).uid;
  const me = o.uid === undefined ? uid : o.uid;
  const calls = [];
  const execFile = (file, args, opts, cb) => {
    calls.push([file, ...args]);
    if (o.onExec) o.onExec(file, args);
    const reply = (code, out = '') => setImmediate(() => cb(code ? Object.assign(new Error(`exit ${code}`), { code }) : null, out, ''));
    // What execFile reports when its `timeout` stopped the tool.
    const killed = () => setImmediate(() => cb(Object.assign(new Error('Command failed'), { killed: true, code: null, signal: 'SIGTERM' }), '', ''));
    if (file === '/usr/bin/plutil') {
      if (o.plutilKilled === args[1]) return killed();
      const plist = args[args.length - 1];
      const v = (plist.startsWith(real) ? running : fresh)[args[1]];
      return v === undefined ? reply(1) : reply(0, `${v}\n`);
    }
    if (file === '/usr/bin/ditto' && args[0] === '-x') {
      if (o.dittoFails) return reply(o.dittoFails === true ? 1 : o.dittoFails);
      const dest = args[4];
      const app = path.join(dest, 'Tunnelview.app');
      fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
      fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), '<plist/>');
      fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Tunnelview'), machO(o.cpu || CPU_ARM64));
      if (o.extraEntry) fs.writeFileSync(path.join(dest, '__MACOSX'), '');
      return reply(0);
    }
    if (file === '/usr/bin/ditto') { // the copy to the app's volume (EXDEV)
      if (o.copyFails) return reply(1);
      fs.cpSync(args[0], args[1], { recursive: true });
      return reply(0);
    }
    if (file === '/usr/bin/codesign') {
      if (o.codesignKilled) return killed();
      return reply(o.codesignFor ? o.codesignFor(args[args.length - 1]) : (o.codesign || 0));
    }
    if (file === '/usr/bin/xattr') return reply(args[0] === '-p' ? (o.quarantined ? 0 : 1) : 0);
    if (file === '/bin/ps') { // uid=,comm=: launchd, and this copy run by this account
      if (o.psFails) return reply(1);
      const self = `${me} ${path.join(real, 'Contents', 'MacOS', 'Tunnelview')}\n`;
      return reply(0, o.ps ? o.ps(me, real) : `    0 /sbin/launchd\n  ${self}`);
    }
    return reply(127);
  };
  // The app's folder as a Mac reports it: 0755 unless the test says otherwise (on a Windows host
  // every folder reads as 0666, which would look world-writable: SHARED_LOCATION).
  const baseFs = o.fs || fs;
  const parentDir = path.dirname(real);
  const macFs = Object.assign(Object.create(baseFs), {
    statSync(p, opts) {
      const st = baseFs.statSync(p, opts);
      if (!st || path.resolve(String(p)) !== parentDir) return st;
      const mode = (st.mode & ~0o7777) | (o.parentMode === undefined ? 0o755 : o.parentMode);
      return Object.create(st, { mode: { value: mode, enumerable: true } });
    },
  });
  const spawned = [];
  const spawn = (file, args, opts) => {
    const child = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    spawned.push({ file, args: [...args], opts, child, pending: readJson(path.join(updates, 'pending.json')) });
    setImmediate(() => (o.spawnError ? child.emit('error', o.spawnError) : child.emit('spawn')));
    return child;
  };
  const quits = { n: 0 };
  const shown = [];
  const u = U.createUpdater({
    appVersion: '0.3.0',
    isPackaged: true,
    settings: F.fakeSettings(),
    userData,
    execPath: path.join(bundle, 'Contents', 'MacOS', 'Tunnelview'),
    platform: 'darwin',
    arch: o.arch || 'arm64',
    translated: o.translated || false,
    pid: 4242,
    getuid: () => me,
    homedir: '/Users/test',
    systemVersion: o.systemVersion === undefined ? '15.1' : o.systemVersion,
    path,
    fs: macFs,
    transport: directGithub(),
    keys: KEY.keys,
    spawn,
    execFile,
    timers: fastTimers,
    quit: () => { quits.n++; },
    showItemInFolder: (f) => shown.push(f),
    sessionBlocker: o.sessionBlocker,
    log: F.quietLog,
    ...o.deps,
  });
  await u.check();
  assert.deepEqual(await u.download(), { ok: true });
  const zip = path.join(updates, '0.4.0', o.arch === 'x64' && !o.translated ? 'Tunnelview-0.4.0-mac-x64.zip' : MAC_NAME);
  return { u, root, apps, bundle, real, parent: path.dirname(real), userData, updates, calls, spawned, quits, shown, zip, uid };
}

const stagingLeft = (t) => fs.readdirSync(t.parent).filter((n) => n.startsWith('.Tunnelview-'));

test('macOS: the bundle is verified, staged next to the app, and the helper gets every path as an argument', async () => {
  const t = await readyMac();
  const r = await t.u.install();
  assert.deepEqual(r, { ok: true });
  // What ran, in order (all fakes).
  const xdir = t.calls[1][5];
  const fresh = path.join(xdir, 'Tunnelview.app');
  assert.deepEqual(t.calls, [
    ['/usr/bin/plutil', '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(t.real, 'Contents', 'Info.plist')],
    ['/usr/bin/ditto', '-x', '-k', '--noqtn', t.zip, xdir],
    ['/usr/bin/plutil', '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(fresh, 'Contents', 'Info.plist')],
    ['/usr/bin/plutil', '-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(fresh, 'Contents', 'Info.plist')],
    ['/usr/bin/plutil', '-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(fresh, 'Contents', 'Info.plist')],
    ['/usr/bin/plutil', '-extract', 'LSMinimumSystemVersion', 'raw', '-o', '-', path.join(fresh, 'Contents', 'Info.plist')],
    ['/usr/bin/codesign', '--verify', '--deep', '--strict', '--verbose=2', fresh],
    ['/usr/bin/xattr', '-d', '-r', '-s', 'com.apple.quarantine', fresh],
    ['/usr/bin/xattr', '-p', 'com.apple.quarantine', fresh],
    ['/bin/ps', '-axo', 'uid=,comm='],
  ]);
  assert.equal(path.dirname(xdir), path.join(t.updates, '0.4.0'), 'extracted into a fresh folder under updates/<version>');
  assert.equal(t.spawned.length, 1);
  const { file, args, opts, child, pending } = t.spawned[0];
  assert.equal(file, '/bin/sh');
  assert.equal(args[0], '-c');
  assert.equal(args[1], U.MAC_SWAP_SCRIPT, 'a constant script');
  assert.equal(args[2], 'tunnelview-update');
  const [pid, dest, stage, backup, result, bid] = args.slice(3);
  assert.equal(args.length, 9);
  assert.equal(pid, '4242');
  assert.equal(dest, t.real, 'the running bundle, wherever the user put it');
  assert.equal(path.dirname(stage), t.parent);
  assert.match(path.basename(stage), /^\.Tunnelview-update-[A-Za-z0-9]{6}$/);
  assert.equal(path.dirname(backup), t.parent);
  assert.match(path.basename(backup), /^\.Tunnelview-old-[0-9a-f]{12}\.app$/);
  assert.equal(result, path.join(t.updates, 'install-result'));
  assert.equal(bid, APP_ID);
  assert.deepEqual(opts, { detached: true, stdio: 'ignore', cwd: '/', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: '/Users/test' } });
  assert.equal(child.unrefed, true);
  assert.ok(fs.existsSync(path.join(stage, 'Tunnelview.app', 'Contents', 'MacOS', 'Tunnelview')), 'the new bundle waits in the staging folder');
  assert.deepEqual(fs.readdirSync(path.join(t.updates, '0.4.0')), [MAC_NAME], 'the extraction folder is gone');
  assert.deepEqual(pending, { v: 1, platform: 'darwin', from: '0.3.0', to: '0.4.0', at: pending.at, dest: t.real, stage, backup });
  await F.settle();
  assert.equal(t.quits.n, 1);
  assert.equal(t.u.getState().phase, 'quitting');
});

test('macOS: a bundle that fails the checks is never installed; the verified zip is kept (no "download again")', async () => {
  const cases = [
    [{ id: 'com.example.other' }, 'BAD_BUNDLE'],
    [{ version: '0.3.9' }, 'WRONG_VERSION'],
    [{ exe: 'Electron' }, 'BAD_BUNDLE'],
    [{ codesign: 1 }, 'CODESIGN_FAILED'],
    [{ codesign: 3 }, 'CODESIGN_FAILED'],
    [{ cpu: CPU_X64 }, 'WRONG_ARCH'],
    [{ quarantined: true }, 'QUARANTINED'],
    [{ extraEntry: true }, 'BAD_BUNDLE'],
  ];
  for (const [o, code] of cases) {
    const t = await readyMac(o);
    const r = await t.u.install();
    assert.deepEqual(r, { ok: false, code, message: CHECK_FAILED }, JSON.stringify(o));
    assert.equal(U.MESSAGES[code], CHECK_FAILED);
    assert.doesNotMatch(r.message, /download it again/i);
    assert.equal(t.spawned.length, 0);
    assert.deepEqual(stagingLeft(t), [], 'no staging folder left next to the app');
    assert.deepEqual(fs.readdirSync(path.join(t.updates, '0.4.0')), [MAC_NAME], 'the zip stays; the extraction folder goes');
    assert.equal(fs.existsSync(path.join(t.updates, 'pending.json')), false);
    assert.equal(t.u.getState().downloaded, true, 'nothing to download again');
    assert.equal(t.u.getState().error.code, code);
    await F.settle();
    assert.equal(t.quits.n, 0);
  }
  // Only a zip that no longer matches its signed hash is deleted (TAMPERED), before it is unpacked.
  const t = await readyMac();
  const bytes = Buffer.from(fs.readFileSync(t.zip));
  bytes[bytes.length - 1] ^= 0x55;
  fs.writeFileSync(t.zip, bytes);
  assert.deepEqual(await t.u.install(), { ok: false, code: 'TAMPERED', message: U.MESSAGES.TAMPERED });
  assert.ok(!t.calls.some((c) => c[0] === '/usr/bin/ditto'), 'never unpacked');
  assert.deepEqual(fs.readdirSync(path.join(t.updates, '0.4.0')), []);
  assert.equal(t.u.getState().downloaded, false);
});

test('macOS: a check stopped by its time limit is VERIFY_TIMEOUT (try again), never CODESIGN_FAILED; the zip is kept', async () => {
  for (const o of [{ codesignKilled: true }, { plutilKilled: 'CFBundleShortVersionString' }, { plutilKilled: 'LSMinimumSystemVersion' }]) {
    const t = await readyMac(o);
    const r = await t.u.install();
    assert.deepEqual(r, { ok: false, code: 'VERIFY_TIMEOUT', message: U.MESSAGES.VERIFY_TIMEOUT }, JSON.stringify(o));
    assert.match(r.message, /took too long.*Try again/);
    assert.deepEqual(fs.readdirSync(path.join(t.updates, '0.4.0')), [MAC_NAME]);
    assert.equal(t.u.getState().downloaded, true);
    assert.equal(t.spawned.length, 0);
    assert.deepEqual(stagingLeft(t), []);
  }
  // A real non-zero codesign answer stays CODESIGN_FAILED.
  const t = await readyMac({ codesign: 1 });
  assert.equal((await t.u.install()).code, 'CODESIGN_FAILED');
});

test('macOS: an update that needs a newer macOS (LSMinimumSystemVersion) is refused before anything moves; the check keeps saying so', async () => {
  const t = await readyMac({ minOS: '14.0', systemVersion: '13.6.1' });
  const r = await t.u.install();
  assert.deepEqual(r, { ok: false, code: 'OS_TOO_OLD', message: 'Tunnelview 0.4.0 needs macOS 14.0 or newer, so it was not installed. Tunnelview 0.3.0 stays installed.' });
  assert.equal(t.spawned.length, 0);
  assert.deepEqual(stagingLeft(t), []);
  assert.ok(!t.calls.some((c) => c[0] === '/usr/bin/codesign'), 'refused before codesign');
  assert.deepEqual(fs.readdirSync(path.join(t.updates, '0.4.0')), [MAC_NAME], 'kept: this Mac may be upgraded');
  await F.settle();
  assert.equal(t.quits.n, 0);
  // A later check (the daily one, or Check now) does not offer "Restart and install" again.
  const s = await t.u.check();
  assert.equal(s.status, 'error');
  assert.equal(s.error.code, 'OS_TOO_OLD');
  assert.equal(s.downloaded, true);
  // A new enough macOS installs it; an unknown macOS version refuses.
  for (const [systemVersion, ok] of [['14.0', true], ['14.5.1', true], ['15', true], ['', false], ['13.7', false]]) {
    const m = await readyMac({ minOS: '14.0', systemVersion });
    assert.equal((await m.u.install()).ok, ok, `macOS ${systemVersion || '(unknown)'}`);
  }
});

test('osAtLeast: dotted numbers compared part by part, missing parts are 0, anything else refuses', () => {
  assert.equal(U.osAtLeast('13.6.1', '13.6'), true);
  assert.equal(U.osAtLeast('13', '13.0.0'), true);
  assert.equal(U.osAtLeast('10.15.7', '10.15'), true);
  assert.equal(U.osAtLeast('12.7', '13.0'), false);
  assert.equal(U.osAtLeast('10.9', '10.10'), false, 'numbers, not strings');
  assert.equal(U.osAtLeast('', '11.0'), false);
  assert.equal(U.osAtLeast('14.0', 'abc'), false);
  assert.equal(U.osAtLeast('14.0', '14.0.1.2'), false, 'at most three parts');
  assert.equal(U.osAtLeast('14.0', '-1'), false);
  assert.equal(U.osAtLeast(undefined, '11'), false);
});

test('macOS: a folder other accounts can change (/Users/Shared) is SHARED_LOCATION: refused before anything is unpacked, shown, and reported up front', async () => {
  for (const parentMode of [0o1777, 0o777, 0o757]) {
    const t = await readyMac({ parentMode });
    const blocked = t.u.getState().installBlocked;
    assert.deepEqual(blocked, { code: 'SHARED_LOCATION', message: U.MESSAGES.SHARED_LOCATION });
    assert.equal(t.u.getState().supported, true, 'the download still works');
    const r = await t.u.install();
    assert.deepEqual(r, { ok: false, code: 'SHARED_LOCATION', message: U.MESSAGES.SHARED_LOCATION });
    assert.equal(t.spawned.length, 0);
    assert.ok(!t.calls.some((c) => c[0] === '/usr/bin/ditto'), 'nothing extracted');
    assert.deepEqual(stagingLeft(t), []);
    assert.deepEqual(t.shown, [t.zip]);
    assert.equal(t.u.getState().downloaded, true);
  }
  // A group-writable admin folder (/Applications is root:admin 0775) is fine.
  const ok = await readyMac({ parentMode: 0o775 });
  assert.equal(ok.u.getState().installBlocked, null);
  assert.deepEqual(await ok.u.install(), { ok: true });
});

test('macOS: Tunnelview open in another account (fast user switching) is refused without quitting; a ps that fails proves nothing', async () => {
  const other = (me, real) => `  ${me} ${path.join(real, 'Contents', 'MacOS', 'Tunnelview')}\n  ${me + 1} ${path.join(real, 'Contents', 'Frameworks', 'Tunnelview Helper.app', 'Contents', 'MacOS', 'Tunnelview Helper')}\n`;
  const t = await readyMac({ ps: other });
  const r = await t.u.install();
  assert.deepEqual(r, { ok: false, code: 'IN_USE_BY_OTHER_USER', message: U.MESSAGES.IN_USE_BY_OTHER_USER });
  assert.equal(t.spawned.length, 0);
  assert.deepEqual(stagingLeft(t), []);
  assert.equal(fs.existsSync(path.join(t.updates, 'pending.json')), false);
  await F.settle();
  assert.equal(t.quits.n, 0, 'this copy keeps running');
  const s = t.u.getState();
  assert.equal(s.status, 'ready', 'a refusal: the state goes back');
  assert.equal(s.error, null);
  assert.equal(s.downloaded, true);
  // Another account's copy of ANOTHER bundle, or a path that only starts the same: not ours.
  const lookalike = (me, real) => `  ${me + 1} ${real}-old${path.sep}Contents${path.sep}MacOS${path.sep}Tunnelview\n  ${me + 1} ${path.join(path.dirname(real), 'Other.app', 'Contents', 'MacOS', 'Tunnelview')}\n`;
  assert.deepEqual(await (await readyMac({ ps: lookalike })).u.install(), { ok: true });
  assert.deepEqual(await (await readyMac({ psFails: true })).u.install(), { ok: true }, 'the helper\'s own busy check stays the backstop');
});

test('macOS: an unpack that fails (free space, the time limit) keeps the verified zip; the next try unpacks it again', async () => {
  for (const code of [1, -1]) { // -1: the 300 s limit killed ditto
    const t = await readyMac({ dittoFails: code });
    const r = await t.u.install();
    assert.deepEqual(r, { ok: false, code: 'EXTRACT_FAILED', message: U.MESSAGES.EXTRACT_FAILED });
    assert.notEqual(r.message, CHECK_FAILED);
    assert.match(r.message, /free space/);
    assert.deepEqual(fs.readdirSync(path.join(t.updates, '0.4.0')), [MAC_NAME], 'the zip stays, the x-* folder is gone');
    assert.equal(t.u.getState().downloaded, true);
    assert.equal(t.spawned.length, 0);
    assert.deepEqual(stagingLeft(t), []);
    assert.equal(fs.existsSync(path.join(t.updates, 'pending.json')), false);
    const before = t.calls.length;
    await t.u.install();
    assert.ok(t.calls.slice(before).some((c) => c[0] === '/usr/bin/ditto' && c[1] === '-x'), 'unpacked again without a new download');
  }
});

test('macOS: a failed copy to the app\'s volume (EXDEV) is NOT_WRITABLE and keeps the zip, also when its re-check fails', async () => {
  const exdev = Object.assign(Object.create(fs), {
    renameSync(from, to) {
      if (path.basename(to) === 'Tunnelview.app' && /[\\/]\.Tunnelview-update-[A-Za-z0-9]{6}$/.test(path.dirname(to))) {
        throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
      }
      return fs.renameSync(from, to);
    },
  });
  for (const o of [{ copyFails: true }, { codesignFor: (app) => (/\.Tunnelview-update-/.test(app) ? 1 : 0) }]) {
    const t = await readyMac({ fs: exdev, ...o });
    const r = await t.u.install();
    assert.deepEqual(r, { ok: false, code: 'NOT_WRITABLE', message: U.MESSAGES.NOT_WRITABLE }, Object.keys(o)[0]);
    assert.ok(fs.existsSync(t.zip), 'the zip is kept');
    assert.equal(t.u.getState().downloaded, true);
    assert.deepEqual(t.shown, [t.zip], 'shown in Finder to install by hand');
    assert.deepEqual(stagingLeft(t), []);
    assert.equal(t.spawned.length, 0);
  }
  // The copy works: its codesign check runs on the staged copy, then the helper starts.
  const t = await readyMac({ fs: exdev });
  assert.deepEqual(await t.u.install(), { ok: true });
  assert.ok(t.calls.some((c) => c[0] === '/usr/bin/codesign' && /\.Tunnelview-update-/.test(c[c.length - 1])));
});

test('macOS: pending.json that cannot be written is DISK_ERROR (never the Windows wording); nothing starts', async () => {
  const full = Object.assign(Object.create(fs), {
    writeFileSync(file, data, opts) {
      if (path.basename(String(file)) === 'pending.json.tmp') throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
      return fs.writeFileSync(file, data, opts);
    },
  });
  const t = await readyMac({ fs: full });
  const r = await t.u.install();
  assert.deepEqual(r, { ok: false, code: 'DISK_ERROR', message: U.MESSAGES.DISK_ERROR });
  assert.doesNotMatch(r.message, /Windows/);
  assert.equal(t.spawned.length, 0);
  assert.deepEqual(stagingLeft(t), []);
  assert.ok(fs.existsSync(t.zip));
  assert.equal(t.u.getState().downloaded, true);
  assert.equal(fs.existsSync(path.join(t.updates, 'pending.json')), false);
  await F.settle();
  assert.equal(t.quits.n, 0);

  // Any other unexpected error on a Mac: the helper wording, not "Windows could not start…".
  const odd = await readyMac();
  odd.u._installMac = async () => { throw new Error('boom'); };
  const r2 = await odd.u.install();
  assert.equal(r2.code, 'SPAWN_FAILED');
  assert.doesNotMatch(r2.message, /Windows/);
});

test('macOS: a quit during the checks leaves nothing next to the app and starts no helper (BUSY)', async () => {
  let release;
  const t = await readyMac();
  const fakeExec = t.u._execFile; // the fixture's fake tools; codesign now waits for the test
  t.u._execFile = (file, args, opts, cb) => {
    if (file === '/usr/bin/codesign') { release = () => fakeExec(file, args, opts, cb); return; }
    fakeExec(file, args, opts, cb);
  };
  const p = t.u.install();
  await waitFor(() => !!release, 'codesign');
  assert.deepEqual(stagingLeft(t), [], 'nothing next to the app during the long checks');
  t.u.dispose(); // tray Quit, Cmd+Q, logout
  release();
  const r = await p;
  assert.equal(r.code, 'BUSY');
  assert.equal(t.spawned.length, 0);
  assert.deepEqual(stagingLeft(t), []);
  assert.equal(fs.existsSync(path.join(t.updates, 'pending.json')), false);
  assert.ok(fs.existsSync(t.zip));
  await F.settle();
  assert.equal(t.quits.n, 0);
});

test('macOS: translocated, read-only, unwritable, another owner, not Tunnelview → refused; the zip is kept and shown', async () => {
  const deny = (code) => Object.assign(Object.create(fs), {
    mkdtempSync(prefix, opts) {
      if (path.basename(prefix) === '.Tunnelview-update-') throw Object.assign(new Error(code), { code });
      return fs.mkdtempSync(prefix, opts);
    },
  });
  const cases = [
    [{ translocated: true }, 'TRANSLOCATED', true],
    [{ fs: deny('EROFS') }, 'READ_ONLY_LOCATION', true],
    [{ fs: deny('EACCES') }, 'NOT_WRITABLE', true],
    [{ fs: deny('EPERM') }, 'NOT_WRITABLE', true],
    [{ uid: 987654 }, 'NOT_OWNER', true],
    [{ runningId: 'com.github.Electron' }, 'NOT_TUNNELVIEW', false],
  ];
  for (const [o, code, revealed] of cases) {
    const t = await readyMac(o);
    const r = await t.u.install();
    assert.deepEqual(r, { ok: false, code, message: U.MESSAGES[code] }, code);
    assert.equal(t.spawned.length, 0);
    assert.ok(!t.calls.some((c) => c[0] === '/usr/bin/ditto'), `${code}: nothing extracted`);
    assert.deepEqual(stagingLeft(t), []);
    assert.ok(fs.existsSync(t.zip), `${code}: the download is kept`);
    assert.equal(t.u.getState().downloaded, true);
    assert.deepEqual(t.shown, revealed ? [t.zip] : [], `${code}: zip shown in Finder`);
  }
  // MACFLOW-4: what can be known without a tool is in the state before any click, so the window
  // offers "Download" and "Show in Finder" instead of a Restart and install that must fail.
  for (const [o, code] of [[{ translocated: true }, 'TRANSLOCATED'], [{ uid: 987654 }, 'NOT_OWNER']]) {
    const t = await readyMac(o);
    const s = t.u.getState();
    assert.deepEqual(s.installBlocked, { code, message: U.MESSAGES[code] }, code);
    assert.equal(s.supported, true, `${code}: the download stays offered`);
    assert.equal(s.downloaded, true);
  }
  const fine = await readyMac();
  assert.equal(fine.u.getState().installBlocked, null);
  const translocatedMsg = U.MESSAGES.TRANSLOCATED;
  for (const m of [translocatedMsg, U.MESSAGES.READ_ONLY_LOCATION, U.MESSAGES.SHARED_LOCATION]) {
    assert.match(m, /on a standard account, the Applications folder in your home folder/, 'DOCS-8');
  }
  assert.match(U.MESSAGES.NOT_WRITABLE, /Applications folder in your home folder/);
});

test('macOS: an execPath outside a Tunnelview.app bundle (development) is NOT_TUNNELVIEW', async () => {
  const t = await readyMac();
  t.u._execPath = path.join(t.root, 'node_modules', 'electron', 'dist', 'Electron'); // as `npm start` runs it
  const s = t.u.getState();
  assert.equal(s.supported, false, 'the releases page instead of a download that could never install');
  assert.equal(s.installBlocked, null);
  assert.equal((await t.u.install()).code, 'NOT_TUNNELVIEW');
  assert.deepEqual(t.calls, []);
});

test('macOS: a session right before the hand-over, or a helper that cannot start, leaves the app as it was', async () => {
  // The blocker turns on during codesign, i.e. after install()'s first gate (the long checks).
  let blocker = null;
  let t = await readyMac({ sessionBlocker: () => blocker, onExec: (file) => { if (file === '/usr/bin/codesign') blocker = 'OUTGOING_SESSION'; } });
  const states = [];
  t.u.on('state', (s) => states.push(s));
  const r1 = await t.u.install();
  assert.deepEqual(r1, { ok: false, code: 'OUTGOING_SESSION', message: U.MESSAGES.OUTGOING_SESSION });
  assert.ok(states.some((s) => s.status === 'installing' && s.phase === 'preparing'), 'got past the first gate');
  assert.ok(t.calls.some((c) => c[0] === '/usr/bin/codesign'));
  assert.equal(t.spawned.length, 0);
  assert.deepEqual(stagingLeft(t), []);
  assert.equal(fs.existsSync(path.join(t.updates, 'pending.json')), false);
  assert.ok(fs.existsSync(t.zip));
  const s = t.u.getState();
  assert.equal(s.status, 'ready', 'a refusal: the state goes back');
  assert.equal(s.error, null);
  assert.equal(s.downloaded, true);
  assert.notEqual(states[states.length - 1].status, 'error');

  t = await readyMac({ spawnError: Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }) });
  const r = await t.u.install();
  assert.deepEqual(r, { ok: false, code: 'SPAWN_FAILED', message: U.MESSAGES.SPAWN_FAILED });
  assert.deepEqual(stagingLeft(t), []);
  assert.equal(fs.existsSync(path.join(t.updates, 'pending.json')), false);
  await F.settle();
  assert.equal(t.quits.n, 0);
});

test('macOS under Rosetta downloads and checks the arm64 build', async () => {
  const t = await readyMac({ arch: 'x64', translated: true });
  assert.ok(fs.existsSync(t.zip) && t.zip.endsWith(MAC_NAME));
  assert.deepEqual(await t.u.install(), { ok: true });
  const intel = await readyMac({ arch: 'x64', cpu: CPU_ARM64 });
  assert.ok(intel.zip.endsWith('Tunnelview-0.4.0-mac-x64.zip'));
  assert.equal((await intel.u.install()).code, 'WRONG_ARCH', 'an Intel Mac never gets an arm64 binary');
});

test('MAC_SWAP_SCRIPT: a constant with paths only in $1-$6; sh can parse it', () => {
  const s = U.MAC_SWAP_SCRIPT;
  assert.ok(s.startsWith('pid=$1; dest=$2; stage=$3; old=$4; result=$5; bid=$6\n'));
  assert.ok(!s.includes('${'), 'no JS interpolation');
  assert.ok(!/\$[7-9]/.test(s));
  assert.match(s, /trap '' HUP INT TERM/);
  assert.match(s, /\/bin\/kill -0 "\$pid"/);
  for (const tool of ['/bin/mv', '/bin/rm', '/bin/sleep', '/usr/bin/open', '/usr/bin/tccutil', '/usr/bin/stat', '/usr/bin/id']) assert.ok(s.includes(tool), tool);
  // MACFLOW-1: the helper never deletes the old bundle; the new version removes it on its first
  // successful start (_processPending), so a bundle that cannot launch leaves the old one.
  assert.ok(!s.includes('rm -rf -- "$old"'), 'the backup survives the swap');
  assert.ok(!/\/bin\/rm[^\n]*\$old/.test(s), 'no rm of $old at all');
  // SEC-3: open only a bundle this account owns (never one another account put at $dest).
  assert.ok(s.includes('reopen() { [ "$(/usr/bin/stat -f %u "$dest" 2>/dev/null)" = "$(/usr/bin/id -u)" ] && /usr/bin/open "$dest"; }'));
  assert.equal(s.split('/usr/bin/open').length - 1, 1, 'open only inside reopen()');
  assert.ok(!/(^|[\s;])(mv|rm|open|sleep|ps) /m.test(s), 'every tool by absolute path');
  for (const word of ['ok', 'timeout', 'busy', 'precondition', 'move-old-failed', 'move-new-failed', 'rollback-failed', 'bad-args']) assert.ok(s.includes(`say ${word}`), word);
  // A copy started from the bundle meanwhile (a Dock click) is waited for, then refused, before
  // the first move: full executable paths matched literally, never as a pattern built from $dest.
  const busyLoop = s.indexOf('while busy; do');
  const pidLoop = s.indexOf('/bin/kill -0 "$pid"');
  assert.ok(pidLoop >= 0 && busyLoop > pidLoop, 'after the PID wait');
  assert.ok(busyLoop < s.indexOf('/bin/mv --'), 'before the first move');
  assert.ok(busyLoop < s.indexOf('if [ ! -d "$new" ]'), 'before the precondition check');
  assert.ok(s.includes('/bin/ps -axo comm= |'));
  assert.ok(s.includes('case $c in "$dest"/Contents/*) exit 0'), '"$dest" quoted in the case pattern');
  assert.ok(!s.includes('pgrep'));
  if (process.platform !== 'win32' && fs.existsSync('/bin/sh')) {
    const r = spawnSync('/bin/sh', ['-n', '-c', s], { encoding: 'utf8' }); // -n: parse only, runs nothing
    assert.equal(r.status, 0, r.stderr);
  }
});

/* ================================================================== the next start */

function nextStart(userData, o = {}) {
  const shown = [];
  const u = U.createUpdater({
    appVersion: o.appVersion || '0.4.0',
    isPackaged: true,
    settings: o.settings || F.fakeSettings(),
    userData,
    platform: o.platform || 'win32',
    arch: o.arch || 'x64',
    path,
    fs: o.fs,
    execPath: o.execPath,
    exlockFlag: o.exlockFlag,
    now: o.now,
    timers: o.timers,
    transport: o.transport || F.fakeTransport(() => null),
    keys: KEY.keys,
    getuid: o.getuid,
    showItemInFolder: (f) => shown.push(f),
    log: F.quietLog,
  });
  const r = u.init();
  return { u, r, shown };
}

test('next start (Windows): the new version is running → justUpdated, every leftover removed', () => {
  const userData = F.tmpDir();
  const updates = path.join(userData, 'updates');
  const staged = path.join(updates, 'install-Ab12Cd', WIN_NAME);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, 'installer');
  fs.mkdirSync(path.join(updates, '0.4.0'));
  fs.mkdirSync(path.join(updates, '0.3.0'));
  fs.writeFileSync(path.join(updates, 'pending.json'), JSON.stringify({ v: 1, platform: 'win32', from: '0.3.0', to: '0.4.0', at: 1, staged }));
  const { u, r } = nextStart(userData);
  assert.deepEqual(r, { justUpdated: { from: '0.3.0', to: '0.4.0' } });
  assert.deepEqual(u.justUpdated, { from: '0.3.0', to: '0.4.0' });
  const s = u.getState();
  assert.deepEqual(s.justUpdated, { from: '0.3.0', to: '0.4.0' });
  assert.equal(s.status, 'idle');
  assert.equal(s.error, null);
  assert.deepEqual(fs.readdirSync(updates), [], 'marker, staging folder and old downloads removed');
});

test('next start: justUpdated names the version that is running, also when it is newer than the marker\'s target', () => {
  // WINFLOW-3: 0.4.0 was installed in-app, then 0.4.1 by hand before the first start.
  const userData = F.tmpDir();
  const updates = path.join(userData, 'updates');
  const staged = path.join(updates, 'install-Pp4Oo5', WIN_NAME);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, 'installer');
  fs.writeFileSync(path.join(updates, 'pending.json'), JSON.stringify({ v: 1, platform: 'win32', from: '0.3.0', to: '0.4.0', at: 1, staged }));
  const { u, r } = nextStart(userData, { appVersion: '0.4.1' });
  assert.deepEqual(r, { justUpdated: { from: '0.3.0', to: '0.4.1' } });
  assert.deepEqual(u.getState().justUpdated, { from: '0.3.0', to: '0.4.1' });
  assert.deepEqual(fs.readdirSync(updates), []);
  // A pre-release build reports its plain x.y.z (what ipc.js and the window accept).
  fs.writeFileSync(path.join(updates, 'pending.json'), JSON.stringify({ v: 1, platform: 'win32', from: '0.3.0', to: '0.4.0', at: 1, staged }));
  assert.deepEqual(nextStart(userData, { appVersion: '0.4.2-beta.1' }).r, { justUpdated: { from: '0.3.0', to: '0.4.2' } });
});

test('next start (Windows): an installer that cannot be moved back stays where it is, is shown, and survives the cleanup', () => {
  // WINFLOW-1, next start: antivirus still holds the staged installer.
  const userData = F.tmpDir();
  const updates = path.join(userData, 'updates');
  const staged = path.join(updates, 'install-Hh7Jj8', WIN_NAME);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, 'installer');
  fs.writeFileSync(path.join(updates, 'pending.json'), JSON.stringify({ v: 1, platform: 'win32', from: '0.3.0', to: '0.4.0', at: 1, staged }));
  const held = Object.assign(Object.create(fs), {
    renameSync(from, to) {
      if (from === staged) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return fs.renameSync(from, to);
    },
  });
  const { u, shown } = nextStart(userData, { appVersion: '0.3.0', fs: held });
  const s = u.getState();
  assert.equal(s.status, 'error');
  assert.equal(s.error.code, 'INSTALL_INCOMPLETE');
  assert.ok(fs.existsSync(staged), 'not deleted with the other leftovers');
  assert.deepEqual(u.reveal(), { ok: true });
  assert.deepEqual(shown, [staged], 'Show in folder finds it');
});

test('next start (Windows): still the old version → INSTALL_INCOMPLETE; the installer is kept for another try', () => {
  const userData = F.tmpDir();
  const updates = path.join(userData, 'updates');
  const staged = path.join(updates, 'install-Zz9Yy8', WIN_NAME);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, 'installer');
  fs.mkdirSync(path.join(updates, '0.4.0'));
  fs.writeFileSync(path.join(updates, '0.4.0', `${WIN_NAME}.partial`), 'half');
  fs.writeFileSync(path.join(updates, 'pending.json'), JSON.stringify({ v: 1, platform: 'win32', from: '0.3.0', to: '0.4.0', at: 1, staged }));
  const { u, r, shown } = nextStart(userData, { appVersion: '0.3.0' });
  assert.deepEqual(r, { justUpdated: null });
  const s = u.getState();
  assert.equal(s.status, 'error');
  assert.deepEqual(s.error, { code: 'INSTALL_INCOMPLETE', message: 'The update to 0.4.0 did not complete; Tunnelview 0.3.0 is still installed. Check for updates to try again.' });
  assert.deepEqual(fs.readdirSync(updates), ['0.4.0']);
  assert.deepEqual(fs.readdirSync(path.join(updates, '0.4.0')), [WIN_NAME], 'moved back; the .partial is gone');
  assert.deepEqual(u.reveal(), { ok: true });
  assert.deepEqual(shown, [path.join(updates, '0.4.0', WIN_NAME)]);
});

test('next start (macOS): the helper\'s outcome decides the message; only our own leftovers are removed', () => {
  const root = F.tmpDir();
  const userData = path.join(root, 'userData');
  const updates = path.join(userData, 'updates');
  const apps = path.join(root, 'Applications');
  fs.mkdirSync(updates, { recursive: true });
  fs.mkdirSync(path.join(apps, 'Tunnelview.app'), { recursive: true });
  const dest = path.join(apps, 'Tunnelview.app');
  const stage = path.join(apps, '.Tunnelview-update-Qw3Er4');
  const backup = path.join(apps, '.Tunnelview-old-0123456789ab.app');
  const mk = () => { fs.mkdirSync(path.join(stage, 'Tunnelview.app'), { recursive: true }); fs.mkdirSync(backup, { recursive: true }); };
  const write = (result, extra = {}) => {
    fs.writeFileSync(path.join(updates, 'pending.json'), JSON.stringify({ v: 1, platform: 'darwin', from: '0.3.0', to: '0.4.0', at: 1, dest, stage, backup, ...extra }));
    fs.writeFileSync(path.join(updates, 'install-result'), `${result}\n`);
  };
  const uid = fs.statSync(apps).uid;

  mk();
  write('move-old-failed');
  let t = nextStart(userData, { appVersion: '0.3.0', platform: 'darwin', arch: 'arm64', getuid: () => uid });
  assert.equal(t.u.getState().error.code, 'MAC_REPLACE_FAILED');
  assert.match(t.u.getState().error.message, /App Management/);
  // DOCS-7: the step that brings the install button back (the error state has no latest version).
  assert.match(t.u.getState().error.message, /then click Check now and install it again \(the download is kept\)/);
  assert.equal(fs.existsSync(stage), false, 'staging removed');
  assert.equal(fs.existsSync(backup), true, 'never the old bundle after a failure');
  assert.deepEqual(fs.readdirSync(updates), [], 'marker and result consumed');

  mk();
  write('timeout');
  t = nextStart(userData, { appVersion: '0.3.0', platform: 'darwin', arch: 'arm64', getuid: () => uid });
  assert.equal(t.u.getState().error.code, 'INSTALL_INCOMPLETE');

  mk();
  write('ok');
  t = nextStart(userData, { appVersion: '0.4.0', platform: 'darwin', arch: 'arm64', getuid: () => uid });
  assert.deepEqual(t.r, { justUpdated: { from: '0.3.0', to: '0.4.0' } });
  assert.equal(fs.existsSync(stage), false);
  assert.equal(fs.existsSync(backup), false, 'the old bundle goes after a success');
  assert.equal(fs.existsSync(dest), true);

  // Paths that are not our own leftovers are never touched, whatever pending.json says.
  const other = path.join(apps, 'Keep.app');
  fs.mkdirSync(other);
  write('ok', { stage: other, backup: dest });
  nextStart(userData, { appVersion: '0.4.0', platform: 'darwin', arch: 'arm64', getuid: () => uid });
  assert.equal(fs.existsSync(other), true);
  assert.equal(fs.existsSync(dest), true);
  mk();
  write('ok');
  nextStart(userData, { appVersion: '0.4.0', platform: 'darwin', arch: 'arm64', getuid: () => uid + 1 });
  assert.equal(fs.existsSync(backup), true, 'another user\'s folder stays');
});

test('next start: an unreadable marker is dropped; no marker is a plain start', () => {
  const userData = F.tmpDir();
  const updates = path.join(userData, 'updates');
  fs.mkdirSync(updates, { recursive: true });
  fs.writeFileSync(path.join(updates, 'pending.json'), '{not json');
  let t = nextStart(userData);
  assert.deepEqual(t.r, { justUpdated: null });
  assert.equal(t.u.getState().status, 'idle');
  assert.deepEqual(fs.readdirSync(updates), []);
  fs.writeFileSync(path.join(updates, 'pending.json'), JSON.stringify({ v: 1, to: '../../x' }));
  t = nextStart(userData);
  assert.equal(t.u.getState().status, 'idle');
  t = nextStart(F.tmpDir());
  assert.deepEqual(t.r, { justUpdated: null });
});

test('next start (Windows): an old copy started while the installer still runs leaves the marker; the new version gets justUpdated', () => {
  const userData = F.tmpDir();
  const updates = path.join(userData, 'updates');
  const staged = path.join(updates, 'install-Qq1Ww2', WIN_NAME);
  fs.mkdirSync(path.dirname(staged), { recursive: true });
  fs.writeFileSync(staged, 'installer');
  const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
  const marker = (at) => fs.writeFileSync(path.join(updates, 'pending.json'), JSON.stringify({ v: 1, platform: 'win32', from: '0.3.0', to: '0.4.0', at, staged }));
  const EXLOCK = 0x10000000;
  // NSIS keeps its own exe open for the whole install: the exclusive open fails with EBUSY.
  const running = Object.assign(Object.create(fs), {
    openSync(p, flags, mode) {
      if (typeof flags === 'number' && (flags & EXLOCK)) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      return fs.openSync(p, flags, mode);
    },
  });
  // The installer has exited: the exclusive open works (the flag itself only means something on Windows).
  const free = Object.assign(Object.create(fs), {
    openSync(p, flags, mode) { return fs.openSync(p, typeof flags === 'number' ? flags & ~EXLOCK : flags, mode); },
  });
  marker(NOW - 20 * 1000);
  let t = nextStart(userData, { appVersion: '0.3.0', fs: running, exlockFlag: EXLOCK, now: () => NOW });
  assert.deepEqual(t.r, { justUpdated: null });
  let s = t.u.getState();
  assert.equal(s.status, 'idle', 'no false "did not complete"');
  assert.equal(s.error, null);
  assert.ok(fs.existsSync(path.join(updates, 'pending.json')), 'the marker stays for the next start');
  assert.ok(fs.existsSync(staged), 'the running installer is neither moved nor deleted');

  // The installer finished: the new version starts and knows it was updated.
  t = nextStart(userData, { appVersion: '0.4.0', now: () => NOW + 60 * 1000 });
  assert.deepEqual(t.r, { justUpdated: { from: '0.3.0', to: '0.4.0' } });
  assert.deepEqual(fs.readdirSync(updates), []);

  // A stale marker (older than 15 min) or an installer that can be opened again: did not complete.
  for (const [at, fsx] of [[NOW - 16 * 60 * 1000, running], [NOW - 20 * 1000, free]]) {
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.writeFileSync(staged, 'installer');
    marker(at);
    t = nextStart(userData, { appVersion: '0.3.0', fs: fsx, exlockFlag: EXLOCK, now: () => NOW });
    s = t.u.getState();
    assert.equal(s.status, 'error');
    assert.equal(s.error.code, 'INSTALL_INCOMPLETE');
    assert.equal(fs.existsSync(path.join(updates, 'pending.json')), false);
    fs.rmSync(updates, { recursive: true, force: true });
    fs.mkdirSync(updates, { recursive: true });
  }
});

test('next start (macOS): before the helper wrote an outcome the marker is left alone; `busy` is MAC_APP_IN_USE and the zip stays', () => {
  const root = F.tmpDir();
  const userData = path.join(root, 'userData');
  const updates = path.join(userData, 'updates');
  const apps = path.join(root, 'Applications');
  const dest = path.join(apps, 'Tunnelview.app');
  const stage = path.join(apps, '.Tunnelview-update-Zx9Cv8');
  const backup = path.join(apps, '.Tunnelview-old-abcdef012345.app');
  fs.mkdirSync(path.join(stage, 'Tunnelview.app'), { recursive: true });
  fs.mkdirSync(path.join(dest, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(updates, '0.4.0'), { recursive: true });
  fs.writeFileSync(path.join(updates, '0.4.0', MAC_NAME), 'zip');
  const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
  fs.writeFileSync(path.join(updates, 'pending.json'), JSON.stringify({ v: 1, platform: 'darwin', from: '0.3.0', to: '0.4.0', at: NOW - 3000, dest, stage, backup }));
  const uid = fs.statSync(apps).uid;
  const mac = { platform: 'darwin', arch: 'arm64', getuid: () => uid, execPath: path.join(dest, 'Contents', 'MacOS', 'Tunnelview') };

  // A Dock click right after the old app quit: the helper may be swapping right now.
  let t = nextStart(userData, { ...mac, appVersion: '0.3.0', now: () => NOW });
  assert.equal(t.u.getState().status, 'idle', 'no false failure');
  assert.ok(fs.existsSync(path.join(updates, 'pending.json')));
  assert.ok(fs.existsSync(path.join(stage, 'Tunnelview.app')), 'the staged bundle is not deleted under the helper');

  // The helper refused to move a bundle that was running (`busy`, MACFLOW-5: possibly in another
  // account): its own message says what to quit, zip kept.
  fs.writeFileSync(path.join(updates, 'install-result'), 'busy\n');
  t = nextStart(userData, { ...mac, appVersion: '0.3.0', now: () => NOW + 10 * 1000 });
  let s = t.u.getState();
  assert.deepEqual(s.error, { code: 'MAC_APP_IN_USE', message: 'The update to 0.4.0 did not complete because Tunnelview was still open, possibly in another user account on this Mac. Quit Tunnelview there, then check for updates to try again.' });
  assert.ok(fs.existsSync(path.join(updates, '0.4.0', MAC_NAME)), 'the zip stays for another try');
  assert.deepEqual(t.u.reveal(), { ok: true });
  assert.equal(fs.existsSync(stage), false, 'our staging folder goes');
  assert.equal(fs.existsSync(path.join(updates, 'pending.json')), false);

  // No outcome after the helper's window: did not complete.
  fs.mkdirSync(path.join(stage, 'Tunnelview.app'), { recursive: true });
  fs.writeFileSync(path.join(updates, 'pending.json'), JSON.stringify({ v: 1, platform: 'darwin', from: '0.3.0', to: '0.4.0', at: NOW - 151 * 1000, dest, stage, backup }));
  t = nextStart(userData, { ...mac, appVersion: '0.3.0', now: () => NOW });
  s = t.u.getState();
  assert.equal(s.error.code, 'INSTALL_INCOMPLETE');
});

test('next start (macOS): staging folders no marker names (a quit or crash before the hand-over) are removed; only ours', () => {
  const root = F.tmpDir();
  const userData = path.join(root, 'userData');
  const apps = path.join(root, 'Applications');
  const dest = path.join(apps, 'Tunnelview.app');
  fs.mkdirSync(path.join(dest, 'Contents', 'MacOS'), { recursive: true });
  const stale = path.join(apps, '.Tunnelview-update-AbC123');
  fs.mkdirSync(path.join(stale, 'Tunnelview.app', 'Contents'), { recursive: true });
  const other = path.join(apps, '.Tunnelview-update-notours'); // not our pattern
  fs.mkdirSync(other);
  const keep = path.join(apps, 'Other.app');
  fs.mkdirSync(keep);
  const uid = fs.statSync(apps).uid;
  const mac = { platform: 'darwin', arch: 'arm64', appVersion: '0.3.0', execPath: path.join(dest, 'Contents', 'MacOS', 'Tunnelview') };
  nextStart(userData, { ...mac, getuid: () => uid + 1 });
  assert.ok(fs.existsSync(stale), 'another user\'s folder stays');
  nextStart(userData, { ...mac, getuid: () => uid });
  assert.equal(fs.existsSync(stale), false);
  assert.ok(fs.existsSync(other));
  assert.ok(fs.existsSync(keep));
  assert.ok(fs.existsSync(dest));
});

test('next start: an automatic check keeps MAC_REPLACE_FAILED (what to do) while it offers that version again; Check now clears it', async () => {
  const root = F.tmpDir();
  const userData = path.join(root, 'userData');
  const updates = path.join(userData, 'updates');
  const apps = path.join(root, 'Applications');
  const dest = path.join(apps, 'Tunnelview.app');
  fs.mkdirSync(path.join(dest, 'Contents', 'MacOS'), { recursive: true });
  const setup = () => {
    fs.mkdirSync(path.join(updates, '0.4.0'), { recursive: true });
    fs.writeFileSync(path.join(updates, '0.4.0', MAC_NAME), REL.assets[MAC_NAME]);
    fs.writeFileSync(path.join(updates, 'pending.json'), JSON.stringify({ v: 1, platform: 'darwin', from: '0.3.0', to: '0.4.0', at: 1, dest, stage: path.join(apps, '.Tunnelview-update-Qw3Er4'), backup: path.join(apps, '.Tunnelview-old-0123456789ab.app') }));
    fs.writeFileSync(path.join(updates, 'install-result'), 'move-old-failed\n');
  };
  for (const online of [true, false]) {
    setup();
    const clock = F.fakeClock();
    const settings = F.fakeSettings({ lastUpdateCheckAt: clock.now() - 30 * 60 * 60 * 1000 });
    const transport = online ? directGithub() : F.fakeTransport(() => null);
    const t = nextStart(userData, { appVersion: '0.3.0', platform: 'darwin', arch: 'arm64', settings, transport, now: clock.now, timers: clock.timers });
    assert.equal(t.u.getState().error.code, 'MAC_REPLACE_FAILED');
    const seen = [];
    t.u.on('state', (st) => seen.push(`${st.status}:${st.error && st.error.code}`));
    t.u.start();
    await clock.advance(61 * 1000);
    await waitFor(() => t.u._op === null, 'the automatic check');
    assert.ok(transport.requests.length > 0, 'the automatic check ran');
    assert.ok(seen.length > 0);
    assert.deepEqual(seen.filter((x) => x !== 'error:MAC_REPLACE_FAILED'), [], 'the instructions never blink away while it checks');
    const s = t.u.getState();
    assert.equal(s.status, 'error', online ? 'online' : 'offline');
    assert.equal(s.error.code, 'MAC_REPLACE_FAILED');
    assert.match(s.error.message, /App Management/);
    if (online) {
      assert.equal(s.latest.version, '0.4.0');
      assert.equal(s.downloaded, true, 'the verified zip is offered again');
      // A manual "Check now" clears it, as the message tells the user.
      const m = await t.u.check();
      assert.equal(m.status, 'ready');
      assert.equal(m.error, null);
    } else {
      assert.deepEqual(t.u.reveal(), { ok: true }, 'the zip can still be shown');
    }
    t.u.dispose();
    fs.rmSync(updates, { recursive: true, force: true });
  }
});
