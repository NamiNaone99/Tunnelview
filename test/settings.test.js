'use strict';
/* node --test test/settings.test.js — pure Node, no Electron (dir + auth injected). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { Settings, DEFAULTS } = require('../src/main/settings');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tunnelview-settings-'));
}

/** Stand-in for auth.hashPassword with the StoredPassword shape (fast scrypt params are fine here). */
const fakeAuth = {
  async hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(Buffer.from(pw.normalize('NFC'), 'utf8'), salt, 32, { N: 1024, r: 8, p: 1 });
    return { salt: salt.toString('base64'), N: 1024, r: 8, p: 1, keylen: 32, key: key.toString('base64') };
  },
};

function make(dir = tmpDir()) {
  const s = new Settings({ dir, auth: fakeAuth, downloadsDir: path.join(dir, 'Downloads') });
  s.load();
  return { s, dir, file: path.join(dir, 'settings.json') };
}

test('fresh load yields defaults and writes the file', () => {
  const { s, file } = make();
  const cur = s.get();
  for (const k of Object.keys(DEFAULTS)) assert.deepEqual(cur[k], DEFAULTS[k], k);
  assert.ok(fs.existsSync(file));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
});

test('gpuVideoDecode: default false, booleans only, round-trips through disk', () => {
  const { s, dir } = make();
  assert.equal(s.get().gpuVideoDecode, false);
  assert.equal(s.getPublic().gpuVideoDecode, false);
  s.update({ gpuVideoDecode: 'yes' });
  assert.equal(s.get().gpuVideoDecode, false);
  s.update({ gpuVideoDecode: true });
  assert.equal(s.get().gpuVideoDecode, true);
  const again = new Settings({ dir, auth: fakeAuth });
  again.load();
  assert.equal(again.get().gpuVideoDecode, true);
});

test('get() returns a deep copy', () => {
  const { s } = make();
  const a = s.get();
  a.defaultPermissions.control = false;
  a.allowList.push('evil');
  assert.equal(s.get().defaultPermissions.control, true);
  assert.deepEqual(s.get().allowList, []);
});

test('update validates per field: unknown keys dropped, wrong types keep old value', () => {
  const { s } = make();
  s.update({
    port: 'abc',            // wrong type
    hostEnabled: 'yes',     // wrong type
    acceptMode: 'whatever', // not in enum
    theme: 'dark',          // valid
    bogus: 1,               // unknown
    version: 99,            // not settable
  });
  const cur = s.get();
  assert.equal(cur.port, 47800);
  assert.equal(cur.hostEnabled, true);
  assert.equal(cur.acceptMode, 'ask');
  assert.equal(cur.theme, 'dark');
  assert.equal(cur.version, 1);
  assert.ok(!('bogus' in cur));
});

test('port range 1024–65535', () => {
  const { s } = make();
  s.update({ port: 80 });
  assert.equal(s.get().port, 47800);
  s.update({ port: 70000 });
  assert.equal(s.get().port, 47800);
  s.update({ port: 1.5 });
  assert.equal(s.get().port, 47800);
  s.update({ port: 1024 });
  assert.equal(s.get().port, 1024);
  s.update({ port: 65535 });
  assert.equal(s.get().port, 65535);
});

test('allowList: ≤ 100 strings of ≤ 128 chars, trimmed + deduped', () => {
  const { s } = make();
  s.update({ allowList: [' alice@example.com ', 'alice@example.com', '', 'node-1'] });
  assert.deepEqual(s.get().allowList, ['alice@example.com', 'node-1']);
  s.update({ allowList: Array.from({ length: 101 }, (_, i) => `u${i}`) });
  assert.deepEqual(s.get().allowList, ['alice@example.com', 'node-1'], 'too many entries keeps old');
  s.update({ allowList: ['x'.repeat(129)] });
  assert.deepEqual(s.get().allowList, ['alice@example.com', 'node-1'], 'too long entry keeps old');
  s.update({ allowList: [1, 2] });
  assert.deepEqual(s.get().allowList, ['alice@example.com', 'node-1'], 'non-strings keep old');
});

test('defaultPermissions merges booleans only', () => {
  const { s } = make();
  s.update({ defaultPermissions: { control: false, files: 'no', extra: true } });
  assert.deepEqual(s.get().defaultPermissions, { control: false, clipboard: true, files: true, audio: true });
});

test('downloadDir must be absolute; effectiveDownloadDir defaults to <Downloads>/Tunnelview', () => {
  const { s, dir } = make();
  assert.equal(s.effectiveDownloadDir(), path.join(dir, 'Downloads', 'Tunnelview'));
  s.update({ downloadDir: 'relative/path' });
  assert.equal(s.get().downloadDir, null);
  const abs = path.join(dir, 'incoming');
  s.update({ downloadDir: abs });
  assert.equal(s.get().downloadDir, abs);
  assert.equal(s.effectiveDownloadDir(), abs);
  s.update({ downloadDir: null });
  assert.equal(s.get().downloadDir, null);
});

test('password cannot be set through update()', () => {
  const { s } = make();
  s.update({ password: { salt: 'AAAA', N: 1024, r: 8, p: 1, keylen: 32, key: 'AAAA' } });
  assert.equal(s.get().password, null);
});

test('setPassword: length rules, hashing, public view hides it', async () => {
  const { s, dir } = make();
  assert.equal((await s.setPassword('short')).ok, false);
  assert.equal((await s.setPassword('x'.repeat(129))).ok, false);
  assert.equal((await s.setPassword(12345678)).ok, false);
  assert.equal(s.get().password, null);

  const r = await s.setPassword('correct horse');
  assert.equal(r.ok, true);
  const stored = s.get().password;
  assert.equal(stored.keylen, 32);
  assert.equal(Buffer.from(stored.salt, 'base64').length, 16);

  const pub = s.getPublic();
  assert.ok(!('password' in pub));
  assert.equal(pub.passwordSet, true);
  assert.equal(pub.effectiveDownloadDir, path.join(dir, 'Downloads', 'Tunnelview'));
  assert.ok(!JSON.stringify(pub).includes(stored.key), 'hash never leaks into the public view');

  // persisted and reloaded
  const again = new Settings({ dir, auth: fakeAuth });
  again.load();
  assert.deepEqual(again.get().password, stored);

  assert.equal((await s.setPassword(null)).ok, true);
  assert.equal(s.getPublic().passwordSet, false);
});

test('change event fires with changed keys only when something changed', () => {
  const { s } = make();
  const events = [];
  s.on('change', (cur, keys) => events.push(keys));
  s.update({ theme: 'light', quality: 'speed' });
  s.update({ theme: 'light' }); // no-op
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].sort(), ['quality', 'theme']);
});

test('atomic persistence: no tmp files left, reload round-trips', () => {
  const { s, dir, file } = make();
  s.update({ port: 50000, closeToTray: false, favorites: ['nA', 'nB', 'nA'] });
  const left = fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
  assert.deepEqual(left, []);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(onDisk.port, 50000);
  const again = new Settings({ dir, auth: fakeAuth });
  again.load();
  assert.equal(again.get().port, 50000);
  assert.equal(again.get().closeToTray, false);
  assert.deepEqual(again.get().favorites, ['nA', 'nB']);
});

test('stale tmp files are cleaned on load', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'settings.json.1234.5678.tmp'), '{');
  make(dir);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp')), []);
});

test('corrupt file is backed up and defaults are used', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{ not json');
  const { s } = make(dir);
  assert.equal(s.get().port, 47800);
  assert.ok(fs.readdirSync(dir).some((n) => n.startsWith('settings.json.corrupt-')));
});

test('migration/validation from disk: bad fields fall back to defaults, invalid password dropped', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
    port: 22,
    acceptMode: 'password-only',
    password: { salt: 'nope', N: 3, r: 8, p: 1, keylen: 32, key: 'x' },
    trustedNodes: [{ stableId: 'nX', name: 'box', login: 'a@b', addedAt: 1 }],
    recent: 'garbage',
    unknownFutureField: true,
  }));
  const { s } = make(dir);
  const cur = s.get();
  assert.equal(cur.version, 1);
  assert.equal(cur.port, 47800);
  assert.equal(cur.acceptMode, 'password-only');
  assert.equal(cur.password, null);
  assert.equal(cur.trustedNodes.length, 1);
  assert.deepEqual(cur.recent, []);
  assert.ok(!('unknownFutureField' in cur));
});

test('trustedNodes: addTrusted/removeTrusted, update() validates + dedupes', () => {
  const { s } = make();
  assert.equal(s.addTrusted({ stableId: 'n1', name: 'one', login: 'a@x' }), true);
  s.addTrusted({ stableId: 'n2', name: 'two', login: 'b@x' });
  s.addTrusted({ stableId: 'n1', name: 'one-renamed', login: 'a@x' }); // dedupe
  assert.deepEqual(s.get().trustedNodes.map((t) => t.stableId), ['n2', 'n1']);
  assert.equal(s.isTrusted('n1'), true);

  // Main-process update() (host-server's trust path): valid entries accepted, duplicates collapsed.
  s.update({ trustedNodes: [...s.get().trustedNodes, { stableId: 'n3', name: 'three', login: 'c@x', addedAt: 5 }, { stableId: 'n3' }] });
  assert.deepEqual(s.get().trustedNodes.map((t) => t.stableId), ['n2', 'n1', 'n3']);
  // One malformed entry rejects the whole value (keeps old).
  s.update({ trustedNodes: [{ stableId: '' }] });
  assert.deepEqual(s.get().trustedNodes.map((t) => t.stableId), ['n2', 'n1', 'n3']);

  assert.equal(s.removeTrusted('n2'), true);
  assert.equal(s.removeTrusted('n2'), false);
  s.update({ trustedNodes: [] });
  assert.deepEqual(s.get().trustedNodes, []);
  assert.equal(s.addTrusted({ name: 'no id' }), false);
});

test('recent: newest first, deduped per node, max 20', () => {
  const { s } = make();
  for (let i = 0; i < 25; i++) s.addRecent({ stableId: `n${i}`, hostname: `h${i}`, ip: `100.64.0.${i}`, os: 'windows' });
  s.addRecent({ stableId: 'n3', hostname: 'h3', ip: '100.64.0.3', os: 'weird-os' });
  const rec = s.get().recent;
  assert.equal(rec.length, 20);
  assert.equal(rec[0].stableId, 'n3');
  assert.equal(rec[0].os, 'other');
  assert.equal(rec.filter((r) => r.stableId === 'n3').length, 1);
  s.update({ recent: [] });
  assert.deepEqual(s.get().recent, []);
});

test('recent: optional port is kept when valid and omitted otherwise (also from disk)', () => {
  const { s, dir } = make();
  s.addRecent({ stableId: 'p1', hostname: 'h', ip: '100.64.0.1', os: 'macos', port: 48000 });
  s.addRecent({ stableId: 'p2', hostname: 'h2', ip: '100.64.0.2', os: 'windows' });
  s.addRecent({ stableId: 'p3', hostname: 'h3', ip: '100.64.0.3', os: 'windows', port: 70000 });
  s.addRecent({ stableId: 'p4', hostname: 'h4', ip: '100.64.0.4', os: 'windows', port: '48000' });
  s.addRecent({ stableId: 'p5', hostname: 'h5', ip: '100.64.0.5', os: 'windows', port: 4.5 });
  const byId = Object.fromEntries(s.get().recent.map((r) => [r.stableId, r]));
  assert.equal(byId.p1.port, 48000);
  for (const id of ['p2', 'p3', 'p4', 'p5']) assert.ok(!('port' in byId[id]), `${id} has no port`);
  // Re-adding the node without a port drops the stale one; round-trips through the file.
  const s2 = new Settings({ dir, auth: fakeAuth, downloadsDir: path.join(dir, 'Downloads') });
  s2.load();
  assert.equal(s2.get().recent.find((r) => r.stableId === 'p1').port, 48000);
  s2.addRecent({ stableId: 'p1', hostname: 'h', ip: '100.64.0.1', os: 'macos' });
  assert.ok(!('port' in s2.get().recent[0]));
});

test('toggleFavorite flips membership', () => {
  const { s } = make();
  assert.equal(s.toggleFavorite('nZ'), true);
  assert.deepEqual(s.get().favorites, ['nZ']);
  assert.equal(s.toggleFavorite('nZ'), false);
  assert.deepEqual(s.get().favorites, []);
  assert.equal(s.toggleFavorite(''), false);
});

test('enums: quality, codec, swapCmdCtrl, allowFrom, promptTimeoutSec', () => {
  const { s } = make();
  s.update({ quality: 'ultra', codec: 'hevc', swapCmdCtrl: 'maybe', allowFrom: 'everyone', promptTimeoutSec: 5 });
  let cur = s.get();
  assert.equal(cur.quality, 'balanced');
  assert.equal(cur.codec, 'auto');
  assert.equal(cur.swapCmdCtrl, 'auto');
  assert.equal(cur.allowFrom, 'tailnet');
  assert.equal(cur.promptTimeoutSec, 30);
  s.update({ quality: 'speed', codec: 'vp9', swapCmdCtrl: 'on', allowFrom: 'list', promptTimeoutSec: 60 });
  cur = s.get();
  assert.deepEqual([cur.quality, cur.codec, cur.swapCmdCtrl, cur.allowFrom, cur.promptTimeoutSec], ['speed', 'vp9', 'on', 'list', 60]);
});

test('loginItemApplied: boolean bookkeeping flag, default false, persisted', () => {
  const { s, dir } = make();
  assert.equal(s.get().loginItemApplied, false);
  s.update({ loginItemApplied: 'yes' });
  assert.equal(s.get().loginItemApplied, false, 'non-boolean ignored');
  s.update({ loginItemApplied: true });
  assert.equal(s.get().loginItemApplied, true);
  const again = new Settings({ dir, auth: fakeAuth, downloadsDir: path.join(dir, 'Downloads') });
  again.load();
  assert.equal(again.get().loginItemApplied, true, 'round-trips through settings.json');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ version: 1, loginItemApplied: 1 }));
  const bad = new Settings({ dir, auth: fakeAuth, downloadsDir: path.join(dir, 'Downloads') });
  bad.load();
  assert.equal(bad.get().loginItemApplied, false, 'invalid value on disk → default');
});
