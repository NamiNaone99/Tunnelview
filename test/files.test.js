'use strict';
/* node --test test/files.test.js — pure Node, no Electron (download dir + shell injected). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { FileReceiver, sanitizeName, uniquePath } = require('../src/main/files');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tunnelview-files-'));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ticks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
/** Poll `cond` every 5 ms for up to `ms`. */
async function waitFor(cond, ms = 2000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await sleep(5);
  }
  return true;
}

// Receivers whose FileHandles abortAllSync() closed stay reachable for the whole run (as the
// production singleton does): see the GC regression check at the end of this file.
const keepAlive = [];

const GIB = 1024 * 1024 * 1024;
/** statfs stand-in: `freeGiB` available on a `totalGiB` volume (4 KiB blocks). */
const fakeStatfs = (freeGiB, totalGiB) => async () => ({ bsize: 4096, bavail: (freeGiB * GIB) / 4096, blocks: (totalGiB * GIB) / 4096 });

function receiver(dir, opts = {}) {
  const calls = [];
  const shell = {
    showItemInFolder: (p) => calls.push(['show', p]),
    openPath: async (p) => { calls.push(['open', p]); return ''; },
  };
  // Generous fake free space by default so the suite does not depend on the test machine's disk.
  return { rx: new FileReceiver({ getDir: () => dir, shell, statfs: fakeStatfs(500, 1000), ...opts }), calls };
}

/* ------------------------------------------------------------------ sanitizeName */

test('sanitizeName: path traversal → basename only', () => {
  assert.equal(sanitizeName('../../x'), 'x');
  assert.equal(sanitizeName('..\\..\\Windows\\System32\\evil.dll'), 'evil.dll');
  assert.equal(sanitizeName('/etc/passwd'), 'passwd');
  assert.equal(sanitizeName('C:\\Users\\a\\doc.txt'), 'doc.txt');
  assert.equal(sanitizeName('..'), 'file');
  assert.equal(sanitizeName('.'), 'file');
  assert.equal(sanitizeName('a/..'), 'file');
});

test('sanitizeName: strips forbidden and control characters', () => {
  assert.equal(sanitizeName('a:b*c?d"e<f>g|h.txt'), 'abcdefgh.txt');
  assert.equal(sanitizeName('bad\u0000name\u0007\u001f.txt'), 'badname.txt');
  assert.equal(sanitizeName('tab\there\nnew\rline.txt'), 'tabherenewline.txt');
  assert.equal(sanitizeName('del\u007fc1\u0085.txt'), 'delc1.txt');
  // RTL override used to disguise "photo\u202Egnp.exe" as "photoexe.png"
  assert.equal(sanitizeName('photo\u202egnp.exe'), 'photognp.exe');
});

test('sanitizeName: trailing dots/spaces, empty and non-string input', () => {
  assert.equal(sanitizeName('report.pdf. . '), 'report.pdf');
  assert.equal(sanitizeName('   spaced name.txt  '), 'spaced name.txt');
  assert.equal(sanitizeName(''), 'file');
  assert.equal(sanitizeName('***'), 'file');
  assert.equal(sanitizeName(null), 'file');
  assert.equal(sanitizeName(42), 'file');
  assert.equal(sanitizeName('.bashrc'), '.bashrc');
});

test('sanitizeName: reserved Windows device names get a "_" prefix', () => {
  assert.equal(sanitizeName('CON'), '_CON');
  assert.equal(sanitizeName('con.txt'), '_con.txt');
  assert.equal(sanitizeName('Nul.tar.gz'), '_Nul.tar.gz');
  assert.equal(sanitizeName('COM1'), '_COM1');
  assert.equal(sanitizeName('lpt9.log'), '_lpt9.log');
  assert.equal(sanitizeName('aux'), '_aux');
  assert.equal(sanitizeName('PRN.'), '_PRN');
  assert.equal(sanitizeName('CONIN$'), '_CONIN$');
  assert.equal(sanitizeName('COM\u00b9.txt'), '_COM\u00b9.txt');
  // not reserved
  assert.equal(sanitizeName('console.txt'), 'console.txt');
  assert.equal(sanitizeName('com10.txt'), 'com10.txt');
  assert.equal(sanitizeName('my con.txt'), 'my con.txt');
});

test('sanitizeName: long names capped at 200 chars, extension preserved', () => {
  const long = 'a'.repeat(500) + '.docx';
  const out = sanitizeName(long);
  assert.ok(out.length <= 200, `len ${out.length}`);
  assert.ok(out.endsWith('.docx'));
  // multi-byte: capped by UTF-8 bytes as well (APFS/NTFS 255-unit limits)
  const cjk = '\u6f22'.repeat(300) + '.txt';
  const out2 = sanitizeName(cjk);
  assert.ok(Buffer.byteLength(out2) <= 230, `bytes ${Buffer.byteLength(out2)}`);
  assert.ok(out2.endsWith('.txt'));
  // emoji are not split in half
  const emoji = '\u{1F600}'.repeat(150) + '.png';
  const out3 = sanitizeName(emoji);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])/.test(out3), 'no lone high surrogate');
  assert.ok(out3.endsWith('.png'));
});

/* ------------------------------------------------------------------ uniquePath */

test('uniquePath: dedupes "name (n).ext" and respects .part files', () => {
  const dir = tmpDir();
  assert.equal(uniquePath(dir, 'a.txt'), path.join(dir, 'a.txt'));
  fs.writeFileSync(path.join(dir, 'a.txt'), '');
  assert.equal(uniquePath(dir, 'a.txt'), path.join(dir, 'a (1).txt'));
  fs.writeFileSync(path.join(dir, 'a (1).txt.part'), '');
  assert.equal(uniquePath(dir, 'a.txt'), path.join(dir, 'a (2).txt'));
  fs.writeFileSync(path.join(dir, 'noext'), '');
  assert.equal(uniquePath(dir, 'noext'), path.join(dir, 'noext (1)'));
  // injectable existence check
  const taken = new Set([path.join(dir, 'x.bin'), path.join(dir, 'x (1).bin')]);
  assert.equal(uniquePath(dir, 'x.bin', (p) => taken.has(p)), path.join(dir, 'x (2).bin'));
});

/* ------------------------------------------------------------------ FileReceiver */

test('begin/chunk/end writes the file via .part and returns its path', async () => {
  const dir = path.join(tmpDir(), 'nested', 'downloads'); // created on demand
  const { rx, calls } = receiver(dir);
  const data = Buffer.from('hello Tunnelview');
  assert.deepEqual(await rx.begin(1, { id: 't1', name: '../../evil/../hello.txt', size: data.length, purpose: 'file' }), { ok: true });
  assert.ok(fs.existsSync(path.join(dir, 'hello.txt.part')));
  assert.deepEqual(await rx.chunk(1, 't1', new Uint8Array(data.subarray(0, 5))), { ok: true });
  assert.deepEqual(await rx.chunk(1, 't1', new Uint8Array(data.subarray(5))), { ok: true });
  const r = await rx.end(1, 't1');
  assert.equal(r.ok, true);
  assert.equal(r.path, path.join(dir, 'hello.txt'));
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'hello Tunnelview');
  assert.ok(!fs.existsSync(path.join(dir, 'hello.txt.part')));
  assert.deepEqual(await rx.reveal(1, 't1'), { ok: true });
  assert.deepEqual(calls[0], ['show', r.path]);
  assert.deepEqual((await rx.reveal(2, 't1')).ok, false, 'other owner cannot reveal');
});

test('existing files are never overwritten', async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'doc.txt'), 'original');
  const { rx } = receiver(dir);
  await rx.begin(1, { id: 'a', name: 'doc.txt', size: 3, purpose: 'file' });
  rx.chunk(1, 'a', Buffer.from('new'));
  const r = await rx.end(1, 'a');
  assert.equal(r.ok, true);
  assert.equal(r.path, path.join(dir, 'doc (1).txt'));
  assert.equal(fs.readFileSync(path.join(dir, 'doc.txt'), 'utf8'), 'original');
});

test('concurrent transfers with the same name get distinct files', async () => {
  const dir = tmpDir();
  const { rx } = receiver(dir);
  const [r1, r2] = await Promise.all([
    rx.begin(1, { id: 'x', name: 'same.bin', size: 1, purpose: 'file' }),
    rx.begin(2, { id: 'x', name: 'same.bin', size: 1, purpose: 'file' }),
  ]);
  assert.ok(r1.ok && r2.ok);
  rx.chunk(1, 'x', Buffer.from([1]));
  rx.chunk(2, 'x', Buffer.from([2]));
  const [e1, e2] = await Promise.all([rx.end(1, 'x'), rx.end(2, 'x')]);
  assert.ok(e1.ok && e2.ok);
  assert.notEqual(e1.path, e2.path);
});

test('declared size is enforced: extra bytes → error and .part removed', async () => {
  const dir = tmpDir();
  const { rx } = receiver(dir);
  await rx.begin(7, { id: 'big', name: 'over.bin', size: 4, purpose: 'file' });
  assert.deepEqual(await rx.chunk(7, 'big', Buffer.from([1, 2, 3])), { ok: true });
  assert.deepEqual(await rx.chunk(7, 'big', Buffer.from([4, 5])), { ok: false, reason: 'size-exceeded' });
  assert.deepEqual(await rx.chunk(7, 'big', Buffer.from([4])), { ok: false, reason: 'size-exceeded' }, 'failed transfer rejects further chunks');
  const r = await rx.end(7, 'big');
  assert.deepEqual(r, { ok: false, reason: 'size-exceeded' });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('declared size is enforced: missing bytes at end → size-mismatch', async () => {
  const dir = tmpDir();
  const { rx } = receiver(dir);
  await rx.begin(7, { id: 's', name: 'short.bin', size: 10, purpose: 'file' });
  rx.chunk(7, 's', Buffer.alloc(4));
  assert.deepEqual(await rx.end(7, 's'), { ok: false, reason: 'size-mismatch' });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('zero-byte files work', async () => {
  const dir = tmpDir();
  const { rx } = receiver(dir);
  assert.equal((await rx.begin(1, { id: 'z', name: 'empty.txt', size: 0, purpose: 'file' })).ok, true);
  const r = await rx.end(1, 'z');
  assert.equal(r.ok, true);
  assert.equal(fs.statSync(r.path).size, 0);
});

test('abort and abortAll clean up partial files', async () => {
  const dir = tmpDir();
  const { rx } = receiver(dir);
  await rx.begin(3, { id: 'a', name: 'a.bin', size: 100, purpose: 'file' });
  await rx.begin(3, { id: 'b', name: 'b.bin', size: 100, purpose: 'file' });
  await rx.begin(4, { id: 'c', name: 'c.bin', size: 1, purpose: 'file' });
  rx.chunk(3, 'a', Buffer.alloc(10));
  assert.equal(await rx.abort(3, 'a'), true);
  assert.ok(!fs.existsSync(path.join(dir, 'a.bin.part')));
  assert.deepEqual(await rx.end(3, 'a'), { ok: false, reason: 'unknown-transfer' });
  assert.equal(await rx.abortAll(3), 1);
  assert.ok(!fs.existsSync(path.join(dir, 'b.bin.part')));
  assert.ok(fs.existsSync(path.join(dir, 'c.bin.part')), 'other owner untouched');
  assert.equal(rx.activeCount(4), 1);
  await rx.forgetOwner(4);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('begin validates metadata', async () => {
  const dir = tmpDir();
  const { rx } = receiver(dir, { maxSize: 1000 });
  assert.deepEqual(await rx.begin(1, null), { ok: false, reason: 'bad-request' });
  assert.deepEqual(await rx.begin(1, { id: '', name: 'a', size: 1, purpose: 'file' }), { ok: false, reason: 'bad-request' });
  assert.deepEqual(await rx.begin(1, { id: 'has space', name: 'a', size: 1, purpose: 'file' }), { ok: false, reason: 'bad-request' });
  assert.deepEqual(await rx.begin(1, { id: 'i', name: 'a', size: -1, purpose: 'file' }), { ok: false, reason: 'bad-request' });
  assert.deepEqual(await rx.begin(1, { id: 'i', name: 'a', size: 1.5, purpose: 'file' }), { ok: false, reason: 'bad-request' });
  assert.deepEqual(await rx.begin(1, { id: 'i', name: 'a', size: 1001, purpose: 'file' }), { ok: false, reason: 'too-large' });
  assert.deepEqual(await rx.begin(1, { id: 'i', name: 'a', size: 1, purpose: 'clipboard-image' }), { ok: false, reason: 'unsupported-purpose' });
  assert.deepEqual(await rx.begin(1, { id: 'i', name: 'a', size: 1, purpose: 'file' }), { ok: true });
  assert.deepEqual(await rx.begin(1, { id: 'i', name: 'a', size: 1, purpose: 'file' }), { ok: false, reason: 'duplicate-id' });
  assert.deepEqual(await rx.chunk(1, 'i', 'not bytes'), { ok: false, reason: 'bad-chunk' });
  assert.deepEqual(await rx.chunk(1, 'nope', Buffer.from([1])), { ok: false, reason: 'unknown-transfer' });
  assert.deepEqual(await rx.end(1, 'i'), { ok: false, reason: 'bad-chunk' });
});

test('per-owner concurrency limit', async () => {
  const dir = tmpDir();
  const { rx } = receiver(dir);
  for (let i = 0; i < 4; i++) assert.equal((await rx.begin(9, { id: `t${i}`, name: `f${i}`, size: 1, purpose: 'file' })).ok, true);
  assert.deepEqual(await rx.begin(9, { id: 't4', name: 'f4', size: 1, purpose: 'file' }), { ok: false, reason: 'busy' });
  assert.equal((await rx.begin(10, { id: 't4', name: 'f4', size: 1, purpose: 'file' })).ok, true, 'other owners unaffected');
  await rx.abortAll(9);
  await rx.abortAll(10);
});

test('openFolder creates the directory and opens it', async () => {
  const dir = path.join(tmpDir(), 'later');
  const { rx, calls } = receiver(dir);
  const r = await rx.openFolder();
  assert.deepEqual(r, { ok: true, path: dir });
  assert.ok(fs.existsSync(dir));
  assert.deepEqual(calls[0], ['open', dir]);
});

/* ------------------------------------------------------------------ back-pressure (ipc-4) */

test('chunk() resolves only after its bytes are on disk', async () => {
  const dir = tmpDir();
  const { rx } = receiver(dir);
  const big = Buffer.alloc(1024 * 1024, 7);
  await rx.begin(1, { id: 'bp', name: 'bp.bin', size: big.length * 3, purpose: 'file' });
  const part = path.join(dir, 'bp.bin.part');
  for (let i = 1; i <= 3; i++) {
    const r = await rx.chunk(1, 'bp', big);
    assert.deepEqual(r, { ok: true });
    assert.equal(fs.statSync(part).size, big.length * i, `written before resolve (chunk ${i})`);
  }
  assert.equal((await rx.end(1, 'bp')).ok, true);
});

test('a failed write resolves {ok:false, reason} and fails the transfer', async () => {
  const dir = tmpDir();
  const { rx } = receiver(dir);
  await rx.begin(1, { id: 'w', name: 'w.bin', size: 8, purpose: 'file' });
  const rec = rx._active.get(rx._key(1, 'w'));
  rec.fh.write = async () => { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; };
  assert.deepEqual(await rx.chunk(1, 'w', Buffer.alloc(4)), { ok: false, reason: 'no-space' });
  assert.deepEqual(await rx.chunk(1, 'w', Buffer.alloc(4)), { ok: false, reason: 'no-space' }, 'later chunks fail at once');
  assert.deepEqual(await rx.end(1, 'w'), { ok: false, reason: 'no-space' });
  assert.deepEqual(fs.readdirSync(dir), []);
});

/* ------------------------------------------------------------------ untrusted marking (security-4) */

test('published files carry Mark-of-the-Web (win32 Zone.Identifier ZoneId=3)', { skip: process.platform !== 'win32' }, async () => {
  const dir = tmpDir();
  const { rx } = receiver(dir);
  await rx.begin(1, { id: 'm', name: 'setup.exe', size: 2, purpose: 'file' });
  await rx.chunk(1, 'm', Buffer.from('MZ'));
  const r = await rx.end(1, 'm');
  assert.equal(r.ok, true);
  const zone = fs.readFileSync(`${r.path}:Zone.Identifier`, 'utf8');
  assert.match(zone, /\[ZoneTransfer\]/);
  assert.match(zone, /ZoneId=3/);
  assert.equal(fs.readFileSync(r.path, 'utf8'), 'MZ', 'data stream untouched');
});

test('macOS: published files get a com.apple.quarantine value', async () => {
  const dir = tmpDir();
  const calls = [];
  const { rx } = receiver(dir, { platform: 'darwin', writeQuarantine: async (file, value) => { calls.push([file, value]); return true; } });
  await rx.begin(1, { id: 'q', name: 'app.dmg', size: 1, purpose: 'file' });
  await rx.chunk(1, 'q', Buffer.from([1]));
  const r = await rx.end(1, 'q');
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], r.path);
  assert.match(calls[0][1], /^0081;[0-9a-f]+;Tunnelview;$/);
});

test('tagging failures never fail the transfer', async () => {
  const dir = tmpDir();
  const { rx } = receiver(dir, { platform: 'darwin', writeQuarantine: async () => { throw new Error('no xattr'); } });
  await rx.begin(1, { id: 't', name: 't.txt', size: 1, purpose: 'file' });
  await rx.chunk(1, 't', Buffer.from('x'));
  assert.equal((await rx.end(1, 't')).ok, true);
});

/* ------------------------------------------------------------------ free-space floor (security-4) */

test('free-space floor: max(1 GiB, min(2 % of the volume, 4 GiB)) must remain after the file', async () => {
  const { freeSpaceFloor } = require('../src/main/files');
  assert.equal(freeSpaceFloor(10 * GIB), GIB, 'small volume → 1 GiB');
  assert.equal(freeSpaceFloor(128e9), 2.56e9, '128 GB volume → 2.56 GB (2 %)');
  assert.equal(freeSpaceFloor(100 * GIB), 2 * GIB, '2 %');
  assert.equal(freeSpaceFloor(1e12), 4 * GIB, '1 TB → capped at 4 GiB');
  assert.equal(freeSpaceFloor(100000 * GIB), 4 * GIB, '2 % part capped on huge volumes');
  assert.equal(freeSpaceFloor(NaN), GIB, 'unknown size → 1 GiB');
  assert.equal(freeSpaceFloor(undefined), GIB, 'unknown size → 1 GiB');

  const dir = tmpDir();
  // A nearly full 1 TB disk (40 GiB free) still receives a small file (the old floor wanted ~47 GiB).
  const { rx: big } = receiver(dir, { statfs: async () => ({ bsize: 4096, bavail: (40 * GIB) / 4096, blocks: 1e12 / 4096 }) });
  assert.deepEqual(await big.begin(9, { id: 'tiny', name: 'tiny.txt', size: 10 * 1000, purpose: 'file' }), { ok: true });
  await big.abortAll(9);

  // 100 GiB volume, 3 GiB free → floor 2 GiB → at most ~1 GiB may be received.
  const { rx } = receiver(dir, { statfs: fakeStatfs(3, 100) });
  assert.deepEqual(await rx.begin(1, { id: 'a', name: 'a.bin', size: 2 * GIB, purpose: 'file' }), { ok: false, reason: 'no-space' });
  assert.deepEqual(await rx.begin(1, { id: 'b', name: 'b.bin', size: GIB / 2, purpose: 'file' }), { ok: true });
  // Bytes still owed to in-flight transfers count against the floor too.
  assert.deepEqual(await rx.begin(1, { id: 'c', name: 'c.bin', size: GIB * 0.75, purpose: 'file' }), { ok: false, reason: 'no-space' });
  // 1.5 GiB free on a 10 GiB volume: the 1 GiB minimum applies.
  const { rx: rx2 } = receiver(dir, { statfs: fakeStatfs(1.5, 10) });
  assert.deepEqual(await rx2.begin(2, { id: 'd', name: 'd.bin', size: GIB, purpose: 'file' }), { ok: false, reason: 'no-space' });
  assert.deepEqual(await rx2.begin(2, { id: 'e', name: 'e.bin', size: 1024, purpose: 'file' }), { ok: true });
  // statfs failure → no precheck.
  const { rx: rx3 } = receiver(dir, { statfs: async () => { throw new Error('ENOSYS'); } });
  assert.deepEqual(await rx3.begin(3, { id: 'f', name: 'f.bin', size: 1, purpose: 'file' }), { ok: true });
  await rx.abortAll(1); await rx2.abortAll(2); await rx3.abortAll(3);
});

/* ------------------------------------------------------------------ OS shutdown (lifecycle-5) */

test('abortAllSync closes descriptors and deletes every .part synchronously', async () => {
  const dir = tmpDir();
  const { rx } = receiver(dir);
  keepAlive.push(rx);
  await rx.begin(1, { id: 'a', name: 'a.bin', size: 100, purpose: 'file' });
  await rx.begin(2, { id: 'b', name: 'b.bin', size: 100, purpose: 'file' });
  await rx.chunk(1, 'a', Buffer.alloc(10));
  assert.equal(rx.abortAllSync(), 2);
  assert.deepEqual(fs.readdirSync(dir), [], 'no .part files left');
  assert.equal(rx.activeCount(), 0);
  assert.deepEqual(await rx.chunk(1, 'a', Buffer.alloc(1)), { ok: false, reason: 'unknown-transfer' });
  assert.deepEqual(await rx.end(2, 'b'), { ok: false, reason: 'unknown-transfer' });
  assert.equal(rx.abortAllSync(), 0, 'idempotent');
  assert.equal(rx._closedSync.length, 2, 'closed handles stay referenced (no GC double close)');
});

/* ------------------------------------------------------------------ receive-folder access (macos2-1) */

const accessError = (code) => Object.assign(new Error(`${code}: operation not permitted`), { code });

test('EPERM / EACCES on the folder or the file → reason no-access (not io-error)', async () => {
  const dir = tmpDir();
  for (const code of ['EPERM', 'EACCES']) {
    let r = receiver(dir, { fsp: { mkdir: async () => { throw accessError(code); } } });
    assert.deepEqual(await r.rx.begin(1, { id: 'm', name: 'a.txt', size: 1, purpose: 'file' }), { ok: false, reason: 'no-access' });
    assert.equal(r.rx.activeCount(), 0, 'the reservation is released');
    r = receiver(dir, { fsp: { open: async () => { throw accessError(code); } } });
    assert.deepEqual(await r.rx.begin(1, { id: 'o', name: 'a.txt', size: 1, purpose: 'file' }), { ok: false, reason: 'no-access' });
    r = receiver(dir, { statfs: async () => { throw accessError(code); } });
    assert.deepEqual(await r.rx.begin(1, { id: 's', name: 'a.txt', size: 1, purpose: 'file' }), { ok: false, reason: 'no-access' });
  }
  // Anything else is still io-error.
  const r = receiver(dir, { fsp: { mkdir: async () => { throw accessError('EIO'); } } });
  assert.deepEqual(await r.rx.begin(1, { id: 'x', name: 'a.txt', size: 1, purpose: 'file' }), { ok: false, reason: 'io-error' });
});

test('a hanging mkdir (macOS privacy alert) is single-flight and time-boxed to no-access', async () => {
  const dir = tmpDir();
  let mkdirCalls = 0;
  let release;
  const hang = new Promise((r) => { release = r; });
  const { rx } = receiver(dir, {
    prepTimeoutMs: 30,
    fsp: { mkdir: async (...args) => { mkdirCalls++; await hang; return fs.promises.mkdir(...args); } },
  });
  const t0 = Date.now();
  const [a, b] = await Promise.all([
    rx.begin(1, { id: 'a', name: 'a.txt', size: 1, purpose: 'file' }),
    rx.begin(2, { id: 'b', name: 'b.txt', size: 1, purpose: 'file' }),
  ]);
  assert.deepEqual(a, { ok: false, reason: 'no-access' });
  assert.deepEqual(b, { ok: false, reason: 'no-access' });
  assert.ok(Date.now() - t0 >= 25, 'answered after the time box');
  assert.equal(mkdirCalls, 1, 'one mkdir syscall for both');
  // While it is still pending, a retry joins it instead of issuing another syscall.
  assert.deepEqual(await rx.begin(1, { id: 'c', name: 'c.txt', size: 1, purpose: 'file' }), { ok: false, reason: 'no-access' });
  assert.equal(mkdirCalls, 1);
  assert.equal(rx.activeCount(), 0);
  // The user answered "Allow": the shared promise settles, the next offer works. (No 30 ms box
  // around real disk I/O from here on: the .part creation is time-boxed too.)
  rx._prepTimeoutMs = 10000;
  release();
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(await rx.begin(1, { id: 'd', name: 'd.txt', size: 1, purpose: 'file' }), { ok: true });
  assert.equal(mkdirCalls, 2, 'a fresh preparation once the old one settled');
  await rx.abortAll(1);
});

test('prepareDir creates the folder and checks it is writable', async () => {
  const dir = path.join(tmpDir(), 'later');
  let r = receiver(dir);
  assert.deepEqual(await r.rx.prepareDir(), { ok: true, path: dir });
  assert.ok(fs.existsSync(dir));
  r = receiver(dir, { fsp: { access: async () => { throw accessError('EACCES'); } } });
  assert.deepEqual(await r.rx.prepareDir(), { ok: false, reason: 'no-access' });
  r = receiver(dir, { fsp: { mkdir: async () => { throw accessError('EPERM'); } } });
  assert.deepEqual(await r.rx.prepareDir(), { ok: false, reason: 'no-access' });
});

/* ------------------------------------------------------------------ macOS consent probe + .part time box (main3-1) */

const PROBE = `.tunnelview-write-test-${process.pid}`;

/**
 * fs.promises stand-ins that log [op, basename, flags?] (and each handle's close) into `calls`
 * and collect the opened handles in `handles`. mkdir resolves at once (the folder exists), so no
 * real disk I/O runs inside a short test time box.
 */
function loggingFs(calls, { openGate = null, handles = [] } = {}) {
  return {
    mkdir: async () => undefined,
    open: async (p, flags, mode) => {
      calls.push(['open', path.basename(p), flags]);
      if (openGate) await openGate;
      const fh = await fs.promises.open(p, flags, mode);
      const close = fh.close.bind(fh);
      fh.close = async () => { calls.push(['close', path.basename(p)]); return close(); };
      handles.push(fh);
      return fh;
    },
    unlink: async (p) => { await fs.promises.unlink(p); calls.push(['unlink', path.basename(p)]); }, // logged once done
  };
}
const noXattr = async () => true;

test('macOS: preparing an EXISTING folder creates, closes and deletes a probe file (TCC data access)', async () => {
  const dir = tmpDir(); // already exists: mkdir -p alone would not touch protected data
  const calls = [];
  let r = receiver(dir, { platform: 'darwin', writeQuarantine: noXattr, fsp: loggingFs(calls) });
  assert.deepEqual(await r.rx.prepareDir(), { ok: true, path: dir });
  assert.deepEqual(calls, [['open', PROBE, 'wx'], ['close', PROBE], ['unlink', PROBE]]);
  assert.deepEqual(fs.readdirSync(dir), [], 'no probe file left behind');

  // begin() joins the same preparation: probe first, then the .part file.
  calls.length = 0;
  assert.deepEqual(await r.rx.begin(1, { id: 'p', name: 'p.txt', size: 0, purpose: 'file' }), { ok: true });
  assert.deepEqual(calls.filter((c) => c[0] === 'open').map((c) => c[1]), [PROBE, 'p.txt.part']);
  assert.equal((await r.rx.end(1, 'p')).ok, true);
  assert.deepEqual(fs.readdirSync(dir), ['p.txt']);

  // Denied (EPERM / EACCES on the probe) → no-access.
  for (const code of ['EPERM', 'EACCES']) {
    r = receiver(dir, { platform: 'darwin', fsp: { open: async () => { throw accessError(code); } } });
    assert.deepEqual(await r.rx.prepareDir(), { ok: false, reason: 'no-access' });
    assert.deepEqual(await r.rx.begin(1, { id: 'd', name: 'd.txt', size: 1, purpose: 'file' }), { ok: false, reason: 'no-access' });
    assert.equal(r.rx.activeCount(), 0);
  }
  r = receiver(dir, { platform: 'darwin', fsp: { unlink: async () => { throw accessError('EPERM'); } } });
  assert.deepEqual(await r.rx.prepareDir(), { ok: false, reason: 'no-access' }, 'probe created but not deletable');
  fs.unlinkSync(path.join(dir, PROBE));

  // A file that already has the probe's name is not ours: success, and it is left alone.
  fs.writeFileSync(path.join(dir, PROBE), 'keep');
  r = receiver(dir, { platform: 'darwin' });
  assert.deepEqual(await r.rx.prepareDir(), { ok: true, path: dir });
  assert.equal(fs.readFileSync(path.join(dir, PROBE), 'utf8'), 'keep');
  fs.unlinkSync(path.join(dir, PROBE));

  // Windows has no such consent: no probe there.
  calls.length = 0;
  r = receiver(dir, { platform: 'win32', fsp: loggingFs(calls) });
  assert.deepEqual(await r.rx.prepareDir(), { ok: true, path: dir });
  assert.deepEqual(calls, []);
});

test('macOS: a probe that waits for the privacy alert is single-flight and time-boxed; offers are never "busy"', async () => {
  const dir = tmpDir();
  const calls = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const { rx } = receiver(dir, { platform: 'darwin', prepTimeoutMs: 30, fsp: loggingFs(calls, { openGate: gate }) });
  const offer = (id) => rx.begin(1, { id, name: `${id}.txt`, size: 1, purpose: 'file' });
  const t0 = Date.now();
  const first = await Promise.all(['a', 'b', 'c', 'd'].map(offer));
  assert.ok(Date.now() - t0 >= 25, 'answered after the time box');
  for (const r of first) assert.deepEqual(r, { ok: false, reason: 'no-access' });
  assert.equal(rx.activeCount(), 0, 'every reservation released');
  // The 5th and 6th offers are refused the same way (not 'busy'), without another syscall.
  assert.deepEqual(await Promise.all(['e', 'f'].map(offer)), [{ ok: false, reason: 'no-access' }, { ok: false, reason: 'no-access' }]);
  assert.deepEqual(calls.filter((c) => c[0] === 'open'), [['open', PROBE, 'wx']], 'one blocked open in total');
  // The user clicks "Allow": the probe completes and is deleted; the next offer works.
  rx._prepTimeoutMs = 10000; // real disk I/O from here on
  release();
  assert.ok(await waitFor(() => calls.some((c) => c[0] === 'unlink')), 'probe deleted');
  assert.deepEqual(await offer('g'), { ok: true });
  await rx.abortAll(1);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('begin(): a .part creation that never answers → no-access within the box; the late file is closed and deleted', async () => {
  const dir = tmpDir(); // exists; mkdir resolves at once
  const calls = [];
  const handles = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  // win32 flavour: no probe, so the .part open itself is what hangs.
  const { rx } = receiver(dir, { platform: 'win32', prepTimeoutMs: 30, fsp: loggingFs(calls, { openGate: gate, handles }) });
  const t0 = Date.now();
  assert.deepEqual(await rx.begin(1, { id: 'a', name: 'a.txt', size: 1, purpose: 'file' }), { ok: false, reason: 'no-access' });
  assert.ok(Date.now() - t0 >= 25, 'answered after the time box');
  assert.ok(Date.now() - t0 < 2000, 'not left waiting');
  assert.equal(rx.activeCount(), 0, '_active is empty');
  assert.equal(rx._reserved.size, 0);
  assert.deepEqual(await rx.chunk(1, 'a', Buffer.from([1])), { ok: false, reason: 'unknown-transfer' });
  // The open answers late: the handle is closed and the .part it created deleted.
  release();
  assert.ok(await waitFor(() => calls.some((c) => c[0] === 'unlink' && c[1] === 'a.txt.part')), 'late .part deleted');
  assert.deepEqual(calls.filter((c) => c[1] === 'a.txt.part').map((c) => c[0]), ['open', 'close', 'unlink']);
  assert.equal(handles.length, 1);
  assert.equal(handles[0].fd, -1, 'late handle closed');
  assert.deepEqual(fs.readdirSync(dir), []);
  // The same id can be offered again and now works.
  rx._prepTimeoutMs = 10000; // real disk I/O from here on
  assert.deepEqual(await rx.begin(1, { id: 'a', name: 'a.txt', size: 1, purpose: 'file' }), { ok: true });
  assert.deepEqual(await rx.chunk(1, 'a', Buffer.from([7])), { ok: true });
  assert.ok(fs.existsSync(path.join(dir, 'a.txt.part')));
  await rx.abortAll(1);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('begin(): a .part open that fails or succeeds inside the box behaves as before', async () => {
  const dir = tmpDir();
  // EEXIST (another process created that .part meanwhile) is still retried, not a failure.
  let n = 0;
  const { rx } = receiver(dir, {
    prepTimeoutMs: 1000,
    writeQuarantine: noXattr,
    fsp: { open: async (p, f, m) => { if (p.endsWith('x.txt.part') && n++ === 0) throw Object.assign(new Error('exists'), { code: 'EEXIST' }); return fs.promises.open(p, f, m); } },
  });
  assert.deepEqual(await rx.begin(1, { id: 'x', name: 'x.txt', size: 0, purpose: 'file' }), { ok: true });
  assert.equal(n, 2, 'retried');
  assert.equal(path.basename((await rx.end(1, 'x')).path), 'x.txt');
  // A synchronous throw from open() is a plain failure, not a hang.
  const r = receiver(dir, { fsp: { open: () => { throw accessError('EACCES'); } } });
  assert.deepEqual(await r.rx.begin(1, { id: 'y', name: 'y.txt', size: 0, purpose: 'file' }), { ok: false, reason: 'no-access' });
});

/* ------------------------------------------------------------------ GC regression (contracts3-1): keep last */

/** global.gc, or the same function exposed at runtime (jest's LeakDetector trick); null if neither works. */
function gcFunction() {
  if (typeof global.gc === 'function') return global.gc;
  try {
    require('v8').setFlagsFromString('--expose-gc');
    const gc = require('vm').runInNewContext('gc');
    return typeof gc === 'function' ? gc : null;
  } catch {
    return null;
  }
}

test('a full GC finalizes no FileHandle whose descriptor abortAllSync() closed (no EBADF)', async (t) => {
  const gc = gcFunction();
  if (!gc) { t.skip('no way to force a garbage collection in this runtime'); return; }
  // A double close surfaces as an uncaughtException from a native immediate ("EBADF: Closing file
  // descriptor N on garbage collection failed"). node:test cannot attribute that to a test and
  // fails the whole file ("asynchronous activity after the test ended"); also record it here.
  const errors = [];
  const onError = (err) => errors.push(String(err && err.message));
  process.on('uncaughtException', onError);
  try {
    // Another receiver, dropped right away: only the module-level reference keeps its handles alive.
    await (async () => {
      const { rx } = receiver(tmpDir());
      await rx.begin(1, { id: 'g', name: 'g.bin', size: 10, purpose: 'file' });
      rx.abortAllSync();
    })();
    // FileHandle finalizers run from GC weak callbacks and report a failed close on a later turn.
    for (let i = 0; i < 3; i++) {
      gc();
      await ticks(10);
      await sleep(25);
    }
  } finally {
    process.removeListener('uncaughtException', onError);
  }
  assert.deepEqual(errors.filter((m) => /garbage collection/.test(m)), []);
});
