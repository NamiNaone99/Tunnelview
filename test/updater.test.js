'use strict';
/*
 * node --test test/updater.test.js — src/main/updater.js: checking, the redirect allow-list,
 * downloading with hash / size verification, the daily schedule (manual clock) and the session
 * gate (DECISIONS U2-U5, U8). The HTTPS layer is a fake (test/support/update-fixtures.js): no
 * connection is ever made. Files go to temp folders. Install flows: test/updater-install.test.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const U = require('../src/main/updater');
const F = require('./support/update-fixtures');

test.after(F.cleanupTmp);

const KEY = F.makeKey();
const REL = F.makeRelease('0.4.0');
const MANIFEST = F.signedManifest(KEY, REL);
const NOTES = 'Fixes and improvements.\n\n- one\n- two';
const GH = 'https://github.com/NamiNaone99/Tunnelview';
const WIN_NAME = 'Tunnelview-Setup-0.4.0-x64.exe';
const HEADERS = { 'User-Agent': 'Tunnelview-Updater/0.3.0', Accept: 'application/octet-stream' };

/** Split a body in 5 pieces (several progress steps). */
function pieces(buf, n = 5) {
  const out = [];
  const step = Math.ceil(buf.length / n);
  for (let i = 0; i < buf.length; i += step) out.push(buf.subarray(i, i + step));
  return out;
}

/**
 * GitHub as it answers: latest/download → 302 → releases/download/vX → 302 → an asset host.
 * `over` maps a URL to a different answer.
 */
function github({ manifest = MANIFEST, release = REL, over = {}, assetBody = null } = {}) {
  const manifestAt = `${GH}/releases/download/v${release.version}/tunnelview-update.json`;
  return (url) => {
    if (over[url] !== undefined) return typeof over[url] === 'function' ? over[url]() : over[url];
    if (url === U.MANIFEST_URL) return { status: 302, headers: { location: manifestAt } };
    if (url === manifestAt) return { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/1/m?sp=r&sig=x' } };
    if (url.startsWith('https://release-assets.githubusercontent.com/github-production-release-asset/1/m?')) {
      return { status: 200, headers: { 'content-length': String(manifest.length), 'content-type': 'application/octet-stream' }, body: manifest };
    }
    for (const [name, body] of Object.entries(release.assets)) {
      const cdn = `https://objects.githubusercontent.com/github-production-release-asset/2/${name}?sig=y`;
      if (url === `${GH}/releases/download/v${release.version}/${name}`) return { status: 302, headers: { location: cdn } };
      if (url === cdn) {
        const b = assetBody || body;
        return { status: 200, headers: { 'content-length': String(b.length) }, body: pieces(b) };
      }
    }
    return { status: 404 };
  };
}

function make(o = {}) {
  const userData = o.userData || F.tmpDir();
  if (o.elevate) { // installed by the NSIS installer: elevate.exe, and the uninstaller next to the exe
    fs.mkdirSync(path.join(userData, 'resources'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'resources', 'elevate.exe'), 'MZ');
    if (o.elevate !== 'unpacked') fs.writeFileSync(path.join(userData, 'Uninstall Tunnelview.exe'), 'MZ');
  }
  const settings = o.settings || F.fakeSettings();
  const transport = o.transport || F.fakeTransport(github(o.github));
  const quits = { n: 0 };
  const u = U.createUpdater({
    appVersion: '0.3.0',
    isPackaged: true,
    settings,
    userData,
    resourcesPath: path.join(userData, 'resources'),
    execPath: path.join(userData, 'Tunnelview.exe'),
    platform: 'win32',
    arch: 'x64',
    path,
    transport,
    keys: KEY.keys,
    quit: () => { quits.n++; },
    log: F.quietLog,
    ...o.deps,
  });
  const states = [];
  u.on('state', (s) => states.push(s));
  return { u, settings, transport, userData, updates: path.join(userData, 'updates'), states, quits };
}

/* ================================================================== pure helpers */

test('allowedUrl: https on github.com and the two asset hosts only, default port, no user info', () => {
  for (const ok of [
    'https://github.com/NamiNaone99/Tunnelview/releases/latest/download/tunnelview-update.json',
    'https://objects.githubusercontent.com/x?y=1',
    'https://release-assets.githubusercontent.com/x',
    'https://GITHUB.com:443/x',
  ]) assert.ok(U.allowedUrl(ok), ok);
  for (const bad of [
    'http://github.com/x', 'https://github.com:8443/x', 'https://user@github.com/x', 'https://u:p@github.com/x',
    'https://api.github.com/x', 'https://github.com.evil.example/x', 'https://evil.example/github.com',
    'https://raw.githubusercontent.com/x', 'ftp://github.com/x', 'file:///etc/passwd', 'https://[::1]/x', 'not a url', '',
  ]) assert.equal(U.allowedUrl(bad), null, bad);
  assert.deepEqual([...U.ALLOWED_HOSTS], ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
  assert.equal(U.MANIFEST_URL, `${GH}/releases/latest/download/tunnelview-update.json`);
});

test('assetUrl: versioned release URL for an allow-listed name only', () => {
  assert.equal(U.assetUrl('win32-x64', '0.4.0', WIN_NAME), `${GH}/releases/download/v0.4.0/${WIN_NAME}`);
  assert.equal(U.assetUrl('darwin-x64', '1.2.3', 'Tunnelview-1.2.3-mac-x64.zip'), `${GH}/releases/download/v1.2.3/Tunnelview-1.2.3-mac-x64.zip`);
  for (const [key, v, name] of [
    ['win32-x64', '0.4.0', '../Tunnelview-Setup-0.4.0-x64.exe'],
    ['win32-x64', '0.4.0', 'Tunnelview-Setup-0.4.1-x64.exe'],
    ['win32-x64', '0.4.0', 'Tunnelview-Setup-0.4.0-arm64.exe'],
    ['darwin-arm64', '0.4.0', 'Tunnelview-0.4.0-mac-arm64.dmg'],
    ['linux-x64', '0.4.0', 'x'],
    ['win32-x64', '0.4', WIN_NAME],
  ]) assert.throws(() => U.assetUrl(key, v, name), (e) => e.updaterCode === 'MANIFEST_INVALID', name);
});

test('platformKeyFor: same architecture on Windows; Rosetta gets the arm64 Mac build; others none', () => {
  assert.equal(U.platformKeyFor('win32', 'x64', false), 'win32-x64');
  assert.equal(U.platformKeyFor('win32', 'arm64', false), 'win32-arm64');
  assert.equal(U.platformKeyFor('win32', 'x64', true), 'win32-x64', 'x64 under ARM64 emulation keeps x64');
  assert.equal(U.platformKeyFor('win32', 'ia32', false), null);
  assert.equal(U.platformKeyFor('darwin', 'arm64', false), 'darwin-arm64');
  assert.equal(U.platformKeyFor('darwin', 'x64', false), 'darwin-x64');
  assert.equal(U.platformKeyFor('darwin', 'x64', true), 'darwin-arm64', 'x64 build under Rosetta');
  assert.equal(U.platformKeyFor('linux', 'x64', false), null);
});

test('machoCpuTypes: thin 64-bit and fat headers; anything else none', () => {
  const thin = (cpu) => { const b = Buffer.alloc(32); b.writeUInt32LE(0xfeedfacf, 0); b.writeUInt32LE(cpu, 4); return b; };
  assert.deepEqual(U.machoCpuTypes(thin(0x0100000c)), [0x0100000c]);
  assert.deepEqual(U.machoCpuTypes(thin(0x01000007)), [0x01000007]);
  const fat = Buffer.alloc(48);
  fat.writeUInt32BE(0xcafebabe, 0);
  fat.writeUInt32BE(2, 4);
  fat.writeUInt32BE(0x01000007, 8);
  fat.writeUInt32BE(0x0100000c, 28);
  assert.deepEqual(U.machoCpuTypes(fat), [0x01000007, 0x0100000c]);
  assert.deepEqual(U.machoCpuTypes(Buffer.from('#!/bin/sh\necho hi\n')), []);
  assert.deepEqual(U.machoCpuTypes(Buffer.alloc(4)), []);
});

test('parseRunningVersion: X.Y.Z with an optional pre-release / build suffix', () => {
  assert.deepEqual(U.parseRunningVersion('0.3.0'), { base: '0.3.0', pre: false });
  assert.deepEqual(U.parseRunningVersion('0.4.0-beta.1'), { base: '0.4.0', pre: true });
  assert.deepEqual(U.parseRunningVersion('0.4.0+build.7'), { base: '0.4.0', pre: false });
  assert.equal(U.parseRunningVersion('dev'), null);
  assert.equal(U.parseRunningVersion(''), null);
});

/* ================================================================== check */

test('check: a verified newer release is offered; requests carry only User-Agent and Accept', async () => {
  const { u, transport, settings, states } = make();
  assert.equal(u.getState().status, 'idle');
  const s = await u.check();
  assert.equal(s.status, 'available');
  assert.deepEqual(s.latest, { version: '0.4.0', date: F.DATE, notes: NOTES, size: REL.files['win32-x64'].size });
  assert.equal(s.downloaded, false);
  assert.equal(s.error, null);
  assert.equal(s.currentVersion, '0.3.0');
  assert.equal(s.platform, 'windows');
  assert.deepEqual(transport.requests.map((r) => r.url), [
    U.MANIFEST_URL,
    `${GH}/releases/download/v0.4.0/tunnelview-update.json`,
    'https://release-assets.githubusercontent.com/github-production-release-asset/1/m?sp=r&sig=x',
  ]);
  for (const r of transport.requests) assert.deepEqual(r.headers, HEADERS, 'no cookies, no credentials, no user data');
  assert.equal(typeof settings.data.lastUpdateCheckAt, 'number');
  assert.equal(s.lastCheckAt, settings.data.lastUpdateCheckAt);
  assert.deepEqual(states.map((x) => x.status), ['checking', 'available']);
});

test('check: the same or an older version is "up to date"; a pre-release of it is not', async () => {
  for (const v of ['0.4.0', '0.4.1', '1.0.0']) {
    const s = await make({ deps: { appVersion: v } }).u.check();
    assert.equal(s.status, 'up-to-date', v);
    assert.equal(s.latest, null);
  }
  assert.equal((await make({ deps: { appVersion: '0.4.0-beta.2' } }).u.check()).status, 'available');
  // The User-Agent names the running version, nothing else.
  const t = make({ deps: { appVersion: '0.4.0-beta.2' } });
  await t.u.check();
  assert.equal(t.transport.requests[0].headers['User-Agent'], 'Tunnelview-Updater/0.4.0-beta.2');
});

test('redirects: http downgrade, foreign hosts, ports and user info are never followed', async () => {
  const bad = [
    'http://github.com/NamiNaone99/Tunnelview/releases/download/v0.4.0/tunnelview-update.json',
    'https://evil.example/tunnelview-update.json',
    'https://github.com.evil.example/x',
    'https://api.github.com/x',
    'https://github.com:8443/x',
    'https://me:pw@github.com/x',
    'https://',
  ];
  for (const location of bad) {
    const t = make({ github: { over: { [U.MANIFEST_URL]: { status: 302, headers: { location } } } } });
    const s = await t.u.check();
    assert.equal(s.status, 'error', location);
    assert.equal(s.error.code, 'BAD_REDIRECT', location);
    assert.equal(s.error.message, U.MESSAGES.BAD_REDIRECT);
    assert.equal(t.transport.requests.length, 1, `${location} was never requested`);
    assert.equal(typeof t.settings.data.lastUpdateCheckAt, 'number', 'it would fail the same way again: the day\'s check');
  }
  for (const headers of [{}, { location: '' }]) {
    const t = make({ github: { over: { [U.MANIFEST_URL]: { status: 301, headers } } } });
    assert.equal((await t.u.check()).error.code, 'BAD_REDIRECT');
  }
  // A relative Location resolves against the current (allowed) URL.
  const rel = make({ github: { over: { [U.MANIFEST_URL]: { status: 307, headers: { location: '/NamiNaone99/Tunnelview/releases/download/v0.4.0/tunnelview-update.json' } } } } });
  assert.equal((await rel.u.check()).status, 'available');
});

test('redirects: at most 5 hops', async () => {
  const chain = (hops) => F.fakeTransport((url) => {
    const m = /\/hop\/(\d+)$/.exec(url);
    const n = url === U.MANIFEST_URL ? 0 : m ? Number(m[1]) : -1;
    if (n >= 0 && n < hops) return { status: 302, headers: { location: `https://github.com/hop/${n + 1}` } };
    if (n === hops) return { status: 200, body: MANIFEST };
    return { status: 404 };
  });
  const five = make({ transport: chain(5) });
  assert.equal((await five.u.check()).status, 'available');
  assert.equal(five.transport.requests.length, 6);
  const six = make({ transport: chain(6) });
  const s = await six.u.check();
  assert.equal(s.error.code, 'BAD_REDIRECT');
  assert.equal(six.transport.requests.length, 6, 'the 6th redirect is not followed');
});

test('check failures: one code each, quiet; only those that may pass soon are left unrecorded', async () => {
  const env = JSON.parse(MANIFEST.toString('utf8'));
  const sig = Buffer.from(env.sig, 'base64');
  sig[3] ^= 1;
  const tampered = Buffer.from(JSON.stringify({ ...env, sig: sig.toString('base64') }));
  // transient = nothing usable came back; tried again within the day. Anything else would fail the
  // same way again, so it counts as the day's check (lastUpdateCheckAt is written).
  const cases = [
    ['404', { status: 404 }, 'NO_MANIFEST', true],
    ['500', { status: 500 }, 'HTTP_STATUS', true],
    ['503', { status: 503 }, 'HTTP_STATUS', true],
    ['429', { status: 429 }, 'HTTP_STATUS', true],
    ['403', { status: 403 }, 'HTTP_STATUS', false],
    ['oversized by header', { status: 200, headers: { 'content-length': '70000' }, body: MANIFEST }, 'MANIFEST_TOO_LARGE', false],
    ['oversized body', { status: 200, body: [Buffer.alloc(40000, 0x20), Buffer.alloc(40000, 0x20)] }, 'MANIFEST_TOO_LARGE', false],
    ['compressed', { status: 200, headers: { 'content-encoding': 'gzip' }, body: MANIFEST }, 'BAD_RESPONSE', false],
    ['html', { status: 200, body: '<html>rate limited</html>' }, 'MANIFEST_MALFORMED', false],
    ['unknown key', { status: 200, body: F.signedManifest(F.makeKey(), REL) }, 'MANIFEST_UNKNOWN_KEY', false],
    ['bad signature', { status: 200, body: tampered }, 'MANIFEST_BAD_SIGNATURE', false],
    ['invalid payload', { status: 200, body: F.signRaw(KEY, Buffer.from('{"v":1}')) }, 'MANIFEST_INVALID', false],
    ['dns', { error: Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' }) }, 'NETWORK', true],
    ['reset', { error: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }, 'NETWORK', true],
    ['socket timeout', { error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }, 'TIMEOUT', true],
    ['tls', { error: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }) }, 'TLS', false],
    ['tls proxy', { error: Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' }) }, 'TLS', false],
  ];
  for (const [what, answer, code, transient] of cases) {
    const t = make({ transport: F.fakeTransport((url) => (url === U.MANIFEST_URL ? answer : null)) });
    const s = await t.u.check();
    assert.equal(s.status, 'error', what);
    assert.equal(s.error.code, code, what);
    assert.equal(s.error.message, U.messageFor(code, { status: answer.status }), what);
    assert.equal(s.latest, null, what);
    if (transient) assert.equal(t.settings.data.lastUpdateCheckAt, null, `${what}: not recorded`);
    else assert.equal(typeof t.settings.data.lastUpdateCheckAt, 'number', `${what}: recorded as the day's check`);
  }
  assert.match(U.messageFor('HTTP_STATUS', { status: 500 }), /HTTP 500/);
});

test('check: the whole check is capped at 30 s', async () => {
  const clock = F.fakeClock();
  const t = make({
    transport: F.fakeTransport((url) => (url === U.MANIFEST_URL ? { status: 200, hang: true } : null)),
    deps: { now: clock.now, timers: clock.timers },
  });
  const pending = t.u.check();
  await F.settle();
  assert.equal(t.u.getState().status, 'checking');
  await clock.advance(29999);
  assert.equal(t.u.getState().status, 'checking');
  await clock.advance(1);
  const s = await pending;
  assert.equal(s.status, 'error');
  assert.equal(s.error.code, 'TIMEOUT');
});

/* ================================================================== download */

test('download: streamed, size + SHA-256 checked, renamed; only the newest version folder stays', async () => {
  const t = make();
  fs.mkdirSync(path.join(t.updates, '0.3.5'), { recursive: true });
  fs.writeFileSync(path.join(t.updates, '0.3.5', 'Tunnelview-Setup-0.3.5-x64.exe'), 'old');
  fs.mkdirSync(path.join(t.updates, '0.3.9'));
  fs.writeFileSync(path.join(t.updates, 'unrelated.txt'), 'x');
  await t.u.check();
  t.states.length = 0;
  const r = await t.u.download();
  assert.deepEqual(r, { ok: true });
  const s = t.u.getState();
  assert.equal(s.status, 'ready');
  assert.equal(s.downloaded, true);
  assert.equal(s.progress, null);
  const file = path.join(t.updates, '0.4.0', WIN_NAME);
  assert.ok(fs.readFileSync(file).equals(REL.assets[WIN_NAME]));
  assert.deepEqual(fs.readdirSync(path.join(t.updates, '0.4.0')), [WIN_NAME], 'no .partial left');
  assert.deepEqual(fs.readdirSync(t.updates).sort(), ['0.4.0', 'unrelated.txt']);
  const urls = t.transport.requests.map((x) => x.url);
  assert.ok(urls.includes(`${GH}/releases/download/v0.4.0/${WIN_NAME}`), 'the versioned URL, never latest/download for assets');
  assert.ok(!urls.some((x) => x.includes('/latest/download/Tunnelview')));
  for (const req of t.transport.requests) assert.deepEqual(req.headers, HEADERS);
  // Progress: increasing percentages up to 100 while downloading.
  const pct = t.states.filter((x) => x.status === 'downloading').map((x) => x.progress.percent);
  assert.ok(pct.length >= 3, `progress pushed (${pct})`);
  assert.deepEqual([...pct].sort((a, b) => a - b), pct);
  assert.equal(pct[pct.length - 1], 100);
  assert.equal(t.states[t.states.length - 1].status, 'ready');
  assert.deepEqual(await t.u.download(), { ok: true }, 'already downloaded');
});

test('download: a hash mismatch deletes the file; the release can be downloaded again', async () => {
  const wrong = Buffer.from(REL.assets[WIN_NAME]);
  wrong[5] ^= 0xff;
  const t = make({ github: { assetBody: wrong } });
  await t.u.check();
  const r = await t.u.download();
  assert.deepEqual(r, { ok: false, code: 'HASH_MISMATCH', message: U.MESSAGES.HASH_MISMATCH });
  const s = t.u.getState();
  assert.equal(s.status, 'error');
  assert.equal(s.downloaded, false);
  assert.equal(s.latest.version, '0.4.0', 'still offered');
  assert.deepEqual(fs.readdirSync(path.join(t.updates, '0.4.0')), [], 'neither the file nor the .partial is kept');
});

test('download: too many bytes stop at once, too few fail, a wrong Content-Length is refused unread', async () => {
  const body = REL.assets[WIN_NAME];
  const long = make({ github: { over: { [`https://objects.githubusercontent.com/github-production-release-asset/2/${WIN_NAME}?sig=y`]: { status: 200, body: [body, Buffer.alloc(1024 * 1024)] } } } });
  await long.u.check();
  assert.equal((await long.u.download()).code, 'SIZE_MISMATCH');
  assert.deepEqual(fs.readdirSync(path.join(long.updates, '0.4.0')), []);

  const short = make({ github: { over: { [`https://objects.githubusercontent.com/github-production-release-asset/2/${WIN_NAME}?sig=y`]: { status: 200, body: body.subarray(0, body.length - 1) } } } });
  await short.u.check();
  assert.equal((await short.u.download()).code, 'SIZE_MISMATCH');
  assert.deepEqual(fs.readdirSync(path.join(short.updates, '0.4.0')), []);

  const header = make({ github: { over: { [`https://objects.githubusercontent.com/github-production-release-asset/2/${WIN_NAME}?sig=y`]: { status: 200, headers: { 'content-length': String(body.length + 1) }, body } } } });
  await header.u.check();
  assert.equal((await header.u.download()).code, 'SIZE_MISMATCH');
});

test('download: refused before a check, while busy, and on an unsupported platform', async () => {
  const t = make();
  assert.deepEqual(await t.u.download(), { ok: false, code: 'NOT_AVAILABLE', message: U.MESSAGES.NOT_AVAILABLE });
  assert.equal(t.transport.requests.length, 0);
  const linux = make({ deps: { platform: 'linux' } });
  assert.equal((await linux.u.download()).code, 'NOT_SUPPORTED');
  const s = await linux.u.check();
  assert.equal(s.error.code, 'NOT_SUPPORTED');
  assert.equal(linux.transport.requests.length, 0, 'no request from a build that has no download');
});

test('after a restart a check finds the verified earlier download; a damaged one is deleted', async () => {
  const first = make();
  await first.u.check();
  await first.u.download();
  const again = make({ userData: first.userData });
  const s = await again.u.check();
  assert.equal(s.status, 'ready');
  assert.equal(s.downloaded, true);
  assert.ok(!again.transport.requests.some((r) => r.url.includes(WIN_NAME)), 'not downloaded twice');

  fs.writeFileSync(path.join(first.updates, '0.4.0', WIN_NAME), Buffer.alloc(REL.files['win32-x64'].size, 0x41));
  const third = make({ userData: first.userData });
  assert.equal((await third.u.check()).status, 'available');
  assert.equal(fs.existsSync(path.join(first.updates, '0.4.0', WIN_NAME)), false);
});

test('dispose aborts a running download and leaves no .partial', async () => {
  const t = make({ github: { over: { [`https://objects.githubusercontent.com/github-production-release-asset/2/${WIN_NAME}?sig=y`]: { status: 200, hang: true } } } });
  await t.u.check();
  const p = t.u.download();
  await F.settle();
  assert.equal(t.u.getState().status, 'downloading');
  t.u.dispose();
  const r = await p;
  assert.equal(r.ok, false);
  await F.settle();
  assert.deepEqual(fs.readdirSync(path.join(t.updates, '0.4.0')), []);
});

/* ================================================================== schedule (U3) */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

test('schedule: first check 60 s after start, then every 24 h; each completed check is recorded', async () => {
  const clock = F.fakeClock();
  const t = make({ deps: { now: clock.now, timers: clock.timers } });
  const t0 = clock.now();
  t.u.start();
  assert.deepEqual(clock.pending(), [60000]);
  await clock.advance(59999);
  assert.equal(t.transport.requests.length, 0);
  await clock.advance(1);
  assert.equal(t.u.getState().status, 'available');
  assert.equal(t.settings.data.lastUpdateCheckAt, t0 + 60000);
  assert.deepEqual(clock.pending(), [DAY]);
  const before = t.transport.requests.length;
  await clock.advance(DAY - 1);
  assert.equal(t.transport.requests.length, before);
  await clock.advance(1);
  assert.ok(t.transport.requests.length > before, 'checked again a day later');
  assert.equal(t.settings.data.lastUpdateCheckAt, t0 + 60000 + DAY);
  // A manual check moves the next automatic one to a day after it.
  await clock.advance(5 * HOUR);
  await t.u.check();
  assert.deepEqual(clock.pending(), [DAY]);
  t.u.dispose();
  assert.deepEqual(clock.pending(), []);
});

test('schedule: a restart within 24 h waits for the rest of the day; a far-future value counts as never', async () => {
  let clock = F.fakeClock();
  let t = make({ settings: F.fakeSettings({ lastUpdateCheckAt: clock.now() - 2 * HOUR }), deps: { now: clock.now, timers: clock.timers } });
  t.u.start();
  assert.deepEqual(clock.pending(), [22 * HOUR]);
  clock = F.fakeClock();
  t = make({ settings: F.fakeSettings({ lastUpdateCheckAt: clock.now() - 30 * HOUR }), deps: { now: clock.now, timers: clock.timers } });
  t.u.start();
  assert.deepEqual(clock.pending(), [60000], 'overdue: still not before 60 s');
  clock = F.fakeClock();
  t = make({ settings: F.fakeSettings({ lastUpdateCheckAt: clock.now() + 48 * HOUR }), deps: { now: clock.now, timers: clock.timers } });
  t.u.start();
  assert.deepEqual(clock.pending(), [60000], 'the clock went back: checks never stop');
});

test('schedule: off with autoUpdateCheck false or in an unpackaged build; a manual check always works', async () => {
  let clock = F.fakeClock();
  const settings = F.fakeSettings({ autoUpdateCheck: false });
  const t = make({ settings, deps: { now: clock.now, timers: clock.timers } });
  t.u.start();
  assert.deepEqual(clock.pending(), []);
  assert.equal(t.u.getState().autoCheck, false);
  await clock.advance(3 * DAY);
  assert.equal(t.transport.requests.length, 0);
  assert.equal((await t.u.check()).status, 'available', 'manual check');
  settings.update({ autoUpdateCheck: true });
  t.states.length = 0;
  t.u.settingsChanged(['autoUpdateCheck']);
  assert.deepEqual(clock.pending(), [DAY], 'on again: a day after the manual check');
  assert.equal(t.states.length, 1);
  assert.equal(t.states[0].autoCheck, true);
  settings.update({ autoUpdateCheck: false });
  t.u.settingsChanged(['autoUpdateCheck']);
  assert.deepEqual(clock.pending(), []);

  clock = F.fakeClock();
  const dev = make({ deps: { isPackaged: false, now: clock.now, timers: clock.timers } });
  dev.u.start();
  assert.deepEqual(clock.pending(), [], 'npm start never checks by itself');
  assert.equal((await dev.u.check()).status, 'available');
  assert.equal(dev.u.getState().supported, false, 'and cannot install');
});

test('schedule: a failed automatic check is quiet and tried again 2 h later', async () => {
  const clock = F.fakeClock();
  let fail = true;
  const route = github();
  const t = make({ transport: F.fakeTransport((url, n) => (fail ? { status: 503 } : route(url, n))), deps: { now: clock.now, timers: clock.timers } });
  t.u.start();
  await clock.advance(60000);
  assert.equal(t.u.getState().error.code, 'HTTP_STATUS');
  assert.equal(t.settings.data.lastUpdateCheckAt, null);
  assert.deepEqual(clock.pending(), [2 * HOUR]);
  fail = false;
  await clock.advance(2 * HOUR);
  assert.equal(t.u.getState().status, 'available');
  assert.deepEqual(clock.pending(), [DAY]);
});

test('schedule: transient failures back off (2, 4, 8, 16 h, then a day); a success starts over at 2 h', async () => {
  const clock = F.fakeClock();
  let fail = true;
  const route = github();
  const t = make({ transport: F.fakeTransport((url, n) => (fail ? null : route(url, n))), deps: { now: clock.now, timers: clock.timers } });
  t.u.start();
  await clock.advance(60000);
  const waits = [];
  for (let i = 0; i < 6; i++) {
    assert.equal(t.u.getState().error.code, 'NETWORK');
    const [next] = clock.pending();
    waits.push(next / HOUR);
    await clock.advance(next);
  }
  assert.deepEqual(waits, [2, 4, 8, 16, 24, 24]);
  assert.equal(t.settings.data.lastUpdateCheckAt, null);
  fail = false;
  await clock.advance(clock.pending()[0]);
  assert.equal(t.u.getState().status, 'available');
  fail = true;
  await clock.advance(DAY);
  assert.deepEqual(clock.pending(), [2 * HOUR], 'back to 2 h after a success');
  t.u.dispose();
});

test('schedule: a check that would fail the same way again (key rotation) counts as the day\'s check, restarts included', async () => {
  const clock = F.fakeClock();
  const other = F.signedManifest(F.makeKey(), REL); // signed with a key this version does not know
  const settings = F.fakeSettings();
  const transport = F.fakeTransport((url) => (url === U.MANIFEST_URL ? { status: 200, body: other } : null));
  const t = make({ settings, transport, deps: { now: clock.now, timers: clock.timers } });
  t.u.start();
  await clock.advance(60000);
  assert.equal(t.u.getState().error.code, 'MANIFEST_UNKNOWN_KEY');
  assert.equal(settings.data.lastUpdateCheckAt, clock.now(), 'recorded');
  assert.deepEqual(clock.pending(), [DAY], 'once a day, not every 2 h');
  await clock.advance(3 * DAY);
  assert.equal(transport.requests.length, 4, 'one request a day');
  // A restart does not check again 60 s later.
  t.u.dispose();
  const again = make({ settings, transport, deps: { now: clock.now, timers: clock.timers } });
  again.u.start();
  assert.deepEqual(clock.pending(), [DAY]);
  again.u.dispose();
});

test('schedule: after a sleep (macOS timers count awake time only) reschedule() works the due time out from the wall clock again', async () => {
  const clock = F.fakeClock();
  let slept = 0; // wall-clock time the timer clock did not see
  const wall = () => clock.now() + slept;
  const t = make({ deps: { now: wall, timers: clock.timers } });
  t.u.start();
  t.u.reschedule(); // before the first check: still 60 s
  assert.deepEqual(clock.pending(), [60000]);
  await clock.advance(60000);
  assert.equal(t.u.getState().status, 'available');
  assert.deepEqual(clock.pending(), [DAY]);
  const n = t.transport.requests.length;
  // 30 h of wall-clock time pass while the timer clock stands still (the Mac slept). Without
  // reschedule() the next check would still be a whole awake day away.
  slept += 30 * HOUR;
  t.u.reschedule();
  assert.deepEqual(clock.pending(), [60000], 'overdue: 60 s after waking, so the network is back first');
  await clock.advance(60000);
  assert.ok(t.transport.requests.length > n, 'checked');
  assert.equal(t.settings.data.lastUpdateCheckAt, wall());
  assert.deepEqual(clock.pending(), [DAY]);
  // Not yet due: the rest of the day, by the wall clock.
  slept += 5 * HOUR;
  t.u.reschedule();
  assert.deepEqual(clock.pending(), [19 * HOUR]);
  // Disposed, off, or not started: nothing.
  t.u.dispose();
  t.u.reschedule();
  assert.deepEqual(clock.pending(), []);
  const idle = make({ deps: { now: wall, timers: clock.timers } });
  idle.u.reschedule();
  assert.deepEqual(clock.pending(), [], 'not started');
  const off = make({ settings: F.fakeSettings({ autoUpdateCheck: false }), deps: { now: wall, timers: clock.timers } });
  off.u.reschedule();
  off.u.start();
  off.u.reschedule();
  assert.deepEqual(clock.pending(), []);
  off.u.dispose();
});

test('check: the same version re-signed with other bytes (a rebuilt release) drops the earlier download', async () => {
  const rebuilt = F.makeRelease('0.4.0', { 'win32-x64': Buffer.from(`rebuilt installer ${'y'.repeat(300)}`) });
  let release = REL;
  let manifest = MANIFEST;
  const t = make({ transport: F.fakeTransport((url, n) => github({ release, manifest })(url, n)) });
  await t.u.check();
  assert.deepEqual(await t.u.download(), { ok: true });
  const file = path.join(t.updates, '0.4.0', WIN_NAME);
  assert.ok(fs.readFileSync(file).equals(REL.assets[WIN_NAME]));
  release = rebuilt;
  manifest = F.signedManifest(KEY, rebuilt);
  let s = await t.u.check();
  assert.equal(s.status, 'available', 'not "ready" with the old bytes');
  assert.equal(s.downloaded, false);
  assert.equal(s.latest.size, rebuilt.files['win32-x64'].size);
  assert.equal(fs.existsSync(file), false, 'the old file is deleted');
  assert.deepEqual(await t.u.download(), { ok: true });
  assert.ok(fs.readFileSync(file).equals(rebuilt.assets[WIN_NAME]), 'the rebuilt bytes');
  // The same manifest again keeps the download.
  s = await t.u.check();
  assert.equal(s.status, 'ready');
  assert.ok(fs.existsSync(file));
});

test('schedule: while a download runs the automatic check waits', async () => {
  const clock = F.fakeClock();
  const t = make({
    github: { over: { [`https://objects.githubusercontent.com/github-production-release-asset/2/${WIN_NAME}?sig=y`]: { status: 200, hang: true } } },
    deps: { now: clock.now, timers: clock.timers },
  });
  await t.u.check();
  t.u.start();
  const dl = t.u.download();
  await F.settle();
  const n = t.transport.requests.length;
  await clock.advance(DAY);
  assert.equal(t.transport.requests.length, n, 'no check during the download');
  assert.deepEqual(clock.pending(), [30 * 60 * 1000]);
  t.u.dispose();
  await dl;
});

/* ================================================================== session gate */

test('install is refused during an incoming session, a pending request or an outgoing session', async () => {
  let blocker = null;
  const t = make({ elevate: true, deps: { sessionBlocker: () => blocker } });
  await t.u.check();
  await t.u.download();
  assert.equal(t.u.getState().supported, true);
  for (const code of ['INCOMING_SESSION', 'INCOMING_REQUEST', 'OUTGOING_SESSION']) {
    blocker = code;
    assert.deepEqual(await t.u.install(), { ok: false, code, message: U.MESSAGES[code] });
    const s = t.u.getState();
    assert.equal(s.status, 'ready', 'a refusal changes nothing');
    assert.equal(s.blocked, code);
  }
  assert.equal(t.quits.n, 0);
  assert.ok(fs.existsSync(path.join(t.updates, '0.4.0', WIN_NAME)));
  assert.deepEqual(fs.readdirSync(t.updates), ['0.4.0'], 'nothing staged, no pending marker');
  // A broken callback blocks too.
  blocker = 'something-else';
  assert.equal((await t.u.install()).code, 'SESSION_ACTIVE');
  const throwing = make({ deps: { sessionBlocker: () => { throw new Error('boom'); } } });
  assert.equal(throwing.u.getState().blocked, 'SESSION_ACTIVE');
});

test('sessionsChanged pushes the state only when `blocked` changes', () => {
  let blocker = null;
  const t = make({ deps: { sessionBlocker: () => blocker } });
  t.u.sessionsChanged();
  const n = t.states.length;
  t.u.sessionsChanged();
  assert.equal(t.states.length, n);
  blocker = 'OUTGOING_SESSION';
  t.u.sessionsChanged();
  assert.equal(t.states.length, n + 1);
  assert.equal(t.states[t.states.length - 1].blocked, 'OUTGOING_SESSION');
  t.u.sessionsChanged();
  assert.equal(t.states.length, n + 1);
  blocker = null;
  t.u.sessionsChanged();
  assert.equal(t.states[t.states.length - 1].blocked, null);
});

test('install: refused before a download and in builds that cannot install', async () => {
  const t = make({ elevate: true });
  assert.equal((await t.u.install()).code, 'NOT_READY');
  await t.u.check();
  assert.equal((await t.u.install()).code, 'NOT_READY');
  for (const deps of [{ isPackaged: false }, { arch: 'ia32' }]) {
    const x = make({ elevate: true, deps });
    assert.equal(x.u.getState().supported, false);
    assert.deepEqual(await x.u.install(), { ok: false, code: 'NOT_SUPPORTED', message: U.MESSAGES.NOT_SUPPORTED });
  }
  const noElevate = make();
  assert.equal(noElevate.u.getState().supported, false, 'no resources\\elevate.exe (development run)');
  // dist\win-unpacked (or a copied folder): elevate.exe is there, the NSIS uninstaller is not. The
  // silent installer would update the per-machine install instead of this copy.
  const unpacked = make({ elevate: 'unpacked' });
  assert.equal(unpacked.u.getState().supported, false);
  await unpacked.u.check();
  await unpacked.u.download();
  assert.deepEqual(await unpacked.u.install(), { ok: false, code: 'NOT_SUPPORTED', message: U.MESSAGES.NOT_SUPPORTED });
  assert.equal(make({ elevate: true }).u.getState().supported, true, 'the installed copy');
});
