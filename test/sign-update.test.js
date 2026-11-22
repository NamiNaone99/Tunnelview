'use strict';
/*
 * node --test test/sign-update.test.js — scripts/sign-update.js end to end with a throwaway key
 * and fake release assets (DECISIONS U1, U8): the manifest it writes verifies, and updater.js
 * accepts it and the files it describes. The production key is never involved (its private half
 * is not in this repository); the child-process runs show the update-keys.js cross-check.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const M = require('../src/main/update-manifest');
const U = require('../src/main/updater');
const { main } = require('../scripts/sign-update');
const F = require('./support/update-fixtures');

test.after(F.cleanupTmp);

const SCRIPT = path.join(__dirname, '..', 'scripts', 'sign-update.js');
const PROD_PUB = 'HpauGGB_6J3ZetoaaXAdBZbrj4DXVpwzODsP2mzIiIE';
const KEY = F.makeKey();
const PEM = KEY.privateKey.export({ format: 'pem', type: 'pkcs8' });
const PEM_BODY = PEM.split('\n').filter((l) => l && !l.startsWith('-----')).join('');
const VERSION = '0.4.0';

/** A dist folder with the four assets (plus a dmg the manifest ignores). */
function distDir() {
  const dir = F.tmpDir('tunnelview-dist-');
  const rel = F.makeRelease(VERSION, { 'win32-x64': crypto.randomBytes(3000), 'darwin-arm64': crypto.randomBytes(5000) });
  for (const [name, body] of Object.entries(rel.assets)) fs.writeFileSync(path.join(dir, name), body);
  fs.writeFileSync(path.join(dir, `Tunnelview-${VERSION}-mac-arm64.dmg`), 'dmg');
  return { dir, rel };
}

async function run(argv, { env = { UPDATE_SIGNING_KEY: PEM }, keys = KEY.keys } = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, { env, keys, log: (s) => out.push(String(s)), error: (s) => err.push(String(s)) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const noSecrets = (text) => {
  assert.ok(!text.includes(PEM_BODY.slice(0, 40)), 'the private key is never printed');
  assert.ok(!text.includes('PRIVATE KEY'));
};

test('sign-update: writes a manifest that verifies, and the updater accepts it and its files', async () => {
  const { dir, rel } = distDir();
  const notesFile = path.join(dir, 'notes.txt');
  fs.writeFileSync(notesFile, '\ufeffWhat\'s new\r\n\r\n- in-app updates\t(beta)\r\n\r\n');
  const r = await run(['--version', VERSION, '--dir', dir, '--pub', KEY.pub, '--notes-file', notesFile, '--date', F.DATE]);
  assert.equal(r.code, 0, r.err);
  noSecrets(r.out + r.err);
  assert.match(r.out, new RegExp(`tunnelview-update\\.json written for ${VERSION} \\(key id ${KEY.kid}`));
  const bytes = fs.readFileSync(path.join(dir, 'tunnelview-update.json'));
  const v = M.verifyManifest(bytes, { keys: KEY.keys, currentVersion: '0.3.0' });
  assert.equal(v.ok, true);
  assert.equal(v.kid, KEY.kid);
  assert.equal(v.manifest.version, VERSION);
  assert.equal(v.manifest.date, F.DATE);
  assert.equal(v.manifest.notes, 'What\'s new\n\n- in-app updates\t(beta)');
  assert.deepEqual(JSON.parse(JSON.stringify(v.manifest.files)), rel.files, 'size and SHA-256 of each asset; the dmg is not listed');
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);

  // The updater, fed exactly these files by a fake GitHub, offers and verifies the download.
  const transport = F.fakeTransport((url) => {
    if (url === U.MANIFEST_URL) return { status: 200, body: bytes };
    const m = /\/releases\/download\/v0\.4\.0\/([^/]+)$/.exec(url);
    return m && fs.existsSync(path.join(dir, m[1])) ? { status: 200, body: fs.readFileSync(path.join(dir, m[1])) } : { status: 404 };
  });
  const u = U.createUpdater({
    appVersion: '0.3.0', isPackaged: true, settings: F.fakeSettings(), userData: F.tmpDir(), platform: 'darwin', arch: 'arm64',
    path, transport, keys: KEY.keys, log: F.quietLog,
  });
  assert.equal((await u.check()).status, 'available');
  assert.deepEqual(await u.download(), { ok: true });
  assert.equal(u.getState().status, 'ready');
});

test('sign-update: without notes the manifest has empty notes and today\'s date', async () => {
  const { dir } = distDir();
  const r = await run(['--version', VERSION, `--dir=${dir}`, `--pub=${KEY.pub}`]);
  assert.equal(r.code, 0, r.err);
  const v = M.verifyManifest(fs.readFileSync(path.join(dir, 'tunnelview-update.json')), { keys: KEY.keys });
  assert.equal(v.manifest.notes, '');
  assert.ok(Math.abs(Date.parse(v.manifest.date) - Date.now()) < 60000);
});

test('sign-update: refuses bad input with a clear message and writes nothing', async () => {
  const { dir } = distDir();
  const out = path.join(dir, 'tunnelview-update.json');
  const base = ['--version', VERSION, '--dir', dir, '--pub', KEY.pub];
  const rsaPem = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ format: 'pem', type: 'pkcs8' });
  const longNotes = path.join(dir, 'long.txt');
  fs.writeFileSync(longNotes, 'x'.repeat(4001));
  const ctlNotes = path.join(dir, 'ctl.txt');
  fs.writeFileSync(ctlNotes, 'bell \u0007');
  const bidiNotes = path.join(dir, 'bidi.txt');
  fs.writeFileSync(bidiNotes, 'evil \u202e txt.exe');
  const cases = [
    [[], {}, 2, /--version is required/],
    [[...base, '--force'], {}, 2, /unknown argument: --force/],
    [[...base, '--version', '0.4.1'], {}, 2, /given twice/],
    [['--version', '0.4', '--dir', dir, '--pub', KEY.pub], {}, 2, /X\.Y\.Z/],
    [['--version', VERSION, '--dir', path.join(dir, 'nope'), '--pub', KEY.pub], {}, 1, /not a folder/],
    [['--version', VERSION, '--dir', dir, '--pub', 'abc'], {}, 2, /32-byte Ed25519 public key/],
    [['--version', VERSION, '--dir', dir, '--pub', F.makeKey().pub], {}, 1, /not a key embedded in src\/main\/update-keys\.js/],
    [base, { env: {} }, 1, /UPDATE_SIGNING_KEY is not set/],
    [base, { env: { UPDATE_SIGNING_KEY: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n' } }, 1, /not a readable private key/],
    [base, { env: { UPDATE_SIGNING_KEY: rsaPem } }, 1, /not an Ed25519 key/],
    [base, { env: { UPDATE_SIGNING_KEY: F.makeKey().privateKey.export({ format: 'pem', type: 'pkcs8' }) } }, 1, /does not belong to --pub/],
    [[...base, '--notes-file', longNotes], {}, 1, /4001 characters/],
    [[...base, '--notes-file', ctlNotes], {}, 1, /control, bidi or separator/],
    [[...base, '--notes-file', bidiNotes], {}, 1, /control, bidi or separator/],
    [[...base, '--notes-file', path.join(dir, 'missing.txt')], {}, 1, /cannot read --notes-file/],
    [[...base, '--date', '2026-11-07'], {}, 2, /--date/],
    [['--version', '0.4.1', '--dir', dir, '--pub', KEY.pub], {}, 1, /missing release asset: Tunnelview-Setup-0\.4\.1-x64\.exe/],
  ];
  for (const [argv, opts, code, re] of cases) {
    const r = await run(argv, opts);
    assert.equal(r.code, code, `${argv.join(' ')} → ${r.err}`);
    assert.match(r.err, re);
    noSecrets(r.out + r.err);
    assert.equal(fs.existsSync(out), false, 'nothing written');
  }
  fs.writeFileSync(path.join(dir, M.assetName('darwin-x64', VERSION)), '');
  const empty = await run(base);
  assert.equal(empty.code, 1);
  assert.match(empty.err, /is 0 bytes/);
});

test('sign-update CLI: the key must be the one embedded in the app; the private key is never printed', () => {
  const { dir } = distDir();
  const env = { ...process.env, UPDATE_SIGNING_KEY: PEM };
  // A throwaway key is not in src/main/update-keys.js: refused before anything is signed.
  let r = spawnSync(process.execPath, [SCRIPT, '--version', VERSION, '--dir', dir, '--pub', KEY.pub], { env, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /is not a key embedded in src\/main\/update-keys\.js/);
  noSecrets(r.stdout + r.stderr);
  // The production public key is embedded, but this private key does not belong to it.
  r = spawnSync(process.execPath, [SCRIPT, '--version', VERSION, '--dir', dir, '--pub', PROD_PUB], { env, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /UPDATE_SIGNING_KEY does not belong to --pub/);
  noSecrets(r.stdout + r.stderr);
  r = spawnSync(process.execPath, [SCRIPT], { env, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
  assert.equal(fs.existsSync(path.join(dir, 'tunnelview-update.json')), false);
});
