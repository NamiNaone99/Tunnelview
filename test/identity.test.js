'use strict';
/* node --test test/identity.test.js — src/main/identity.js in temp directories. Pure Node, no
 * Electron; failures are simulated with an injected fs. The rule under test (mobile DECISIONS D1,
 * CRITIQUE B3): the key never changes unless reset() is called, and no key file is destroyed. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { createIdentity, parseIdentity } = require('../src/main/identity');
const pairing = require('../src/main/pairing');

const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const verifyRaw = (pub, msg, sig) => crypto.verify(null, msg, crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: 'der', type: 'spki' }), sig);
const FINGERPRINT_RE = /^TV-[A-Z2-7]{4}(?:-[A-Z2-7]{4}){4}$/;

/** A temp dir with identity.json paths; console.error (expected warnings) is silenced. */
function setup(t) {
  t.mock.method(console, 'error', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnelview-identity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'identity.json');
  let clock = 1762520000000;
  const make = (opts = {}) => createIdentity({ file, now: () => clock++, ...opts });
  return { dir, file, bak: `${file}.bak`, old: `${file}.old`, make };
}

/** Every file in dir → its bytes (base64), to prove nothing was touched. */
const snapshot = (dir) => Object.fromEntries(fs.readdirSync(dir).sort().map((n) => [n, fs.readFileSync(path.join(dir, n)).toString('base64')]));
const filesLike = (dir, re) => fs.readdirSync(dir).filter((n) => re.test(n));
const ioError = (code) => Object.assign(new Error(`simulated ${code}`), { code });

/** The real fs with some functions replaced; `log` records the calls that write. */
function fakeFs(overrides = {}) {
  const log = [];
  const rec = (name) => (...args) => {
    log.push([name, ...args.filter((a) => typeof a === 'string' || typeof a === 'number')]);
    return (overrides[name] || fs[name])(...args);
  };
  const out = { ...fs, ...overrides };
  for (const name of ['openSync', 'renameSync', 'writeFileSync', 'unlinkSync', 'copyFileSync']) out[name] = rec(name);
  return { fs: out, log };
}

/** A valid identity.json made by a throwaway instance (another key than the one under test). */
function otherKeyFile(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnelview-identity-other-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const id = createIdentity({ file: path.join(dir, 'identity.json') });
  assert.equal(id.load().ok, true);
  return { bytes: fs.readFileSync(path.join(dir, 'identity.json')), pub: id.publicKeyRaw() };
}

test('first load creates one key and stores it twice: identity.json and .bak with the same bytes', (t) => {
  const { dir, file, bak, make } = setup(t);
  const id = make();
  assert.equal(id.unavailable, true);
  assert.equal(id.error, 'NOT_LOADED');
  assert.deepEqual(id.load(), { ok: true, error: null });
  assert.equal(id.unavailable, false);
  assert.equal(id.error, null);
  assert.equal(id.wasReset, false);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['identity.json', 'identity.json.bak']);
  const bytes = fs.readFileSync(file);
  assert.ok(bytes.equals(fs.readFileSync(bak)));
  const doc = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(Object.keys(doc).sort(), ['createdAt', 'priv', 'pub', 'v']);
  assert.equal(doc.v, 1);
  assert.equal(doc.createdAt, 1762520000000, 'createdAt comes from the injected clock');
  assert.equal(doc.pub, id.publicKeyB64url());
  assert.match(doc.pub, /^[A-Za-z0-9_-]{43}$/);
  const priv = crypto.createPrivateKey({ key: Buffer.from(doc.priv, 'base64'), format: 'der', type: 'pkcs8' });
  assert.equal(priv.asymmetricKeyType, 'ed25519');
  const der = crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' });
  assert.ok(der.subarray(12).equals(id.publicKeyRaw()), 'priv and pub are one key pair');
  assert.ok(!bytes.includes(Buffer.from('safeStorage')), 'stored like settings.json, no safeStorage');
  if (process.platform !== 'win32') {
    for (const f of [file, bak]) assert.equal(fs.statSync(f).mode & 0o777, 0o600, `${path.basename(f)} is user-only`);
  }
});

test('sign(): Ed25519 over the given bytes, verifiable with the raw public key; refuses anything else', (t) => {
  const { make } = setup(t);
  const id = make();
  assert.throws(() => id.sign(Buffer.from('x')), { code: 'IDENTITY_UNAVAILABLE' }, 'nothing to sign with before load()');
  id.load();
  const msg = pairing.identBytes(Buffer.alloc(32, 7).toString('base64'), null, 'nHOST1', 'nVIEW2');
  const sig = id.sign(msg);
  assert.equal(sig.length, 64);
  assert.ok(verifyRaw(id.publicKeyRaw(), msg, sig));
  assert.ok(!verifyRaw(id.publicKeyRaw(), Buffer.concat([msg, Buffer.from('!')]), sig));
  assert.ok(verifyRaw(id.publicKeyRaw(), Buffer.from('abc'), id.sign(new Uint8Array([0x61, 0x62, 0x63]))));
  for (const bad of ['text', null, undefined, 42, [1, 2]]) assert.throws(() => id.sign(bad), TypeError);
  // publicKeyRaw hands out a copy: changing it cannot change the identity.
  const copy = id.publicKeyRaw();
  copy.fill(0);
  assert.ok(verifyRaw(id.publicKeyRaw(), msg, sig));
});

test('the key survives a restart: a new instance loads the same key and signs identically', (t) => {
  const { dir, make } = setup(t);
  const first = make();
  first.load();
  const before = snapshot(dir);
  const second = make();
  assert.deepEqual(second.load(), { ok: true, error: null });
  assert.ok(second.publicKeyRaw().equals(first.publicKeyRaw()));
  assert.equal(second.fingerprint(), first.fingerprint());
  const msg = Buffer.from('Tunnelview-hello-v1|n|c|h|v');
  assert.ok(second.sign(msg).equals(first.sign(msg)), 'Ed25519 is deterministic');
  assert.deepEqual(snapshot(dir), before, 'loading a healthy key writes nothing');
});

test('publicKeyB64url and fingerprint() describe publicKeyRaw', (t) => {
  const { make } = setup(t);
  const id = make();
  assert.equal(id.publicKeyRaw(), null);
  assert.equal(id.publicKeyB64url(), null);
  assert.equal(id.fingerprint(), null);
  id.load();
  const raw = id.publicKeyRaw();
  assert.equal(raw.length, 32);
  assert.equal(id.publicKeyB64url(), raw.toString('base64url'));
  assert.match(id.fingerprint(), FINGERPRINT_RE);
  assert.equal(id.fingerprint(), pairing.fingerprint(raw));
});

test('writes go through a 0600 temp file and a rename, never straight to identity.json or .bak', (t) => {
  const { file, bak, make } = setup(t);
  const { fs: spy, log } = fakeFs();
  const id = make({ fs: spy });
  id.load();
  id.reset();
  const opened = log.filter(([n]) => n === 'openSync');
  const renamed = log.filter(([n]) => n === 'renameSync');
  assert.equal(log.filter(([n]) => n === 'writeFileSync' || n === 'copyFileSync').length, 0);
  for (const [, p, flags, mode] of opened) {
    assert.match(p, /\.tmp$/, `${p} is a temp file`);
    assert.deepEqual([flags, mode], ['w', 0o600]);
  }
  const targets = renamed.map(([, from, to]) => {
    assert.match(from, /\.tmp$/, `${to} is replaced by a rename from a temp file`);
    assert.ok(opened.some(([, p]) => p === from), 'the temp file was written first');
    return to;
  });
  assert.ok(targets.includes(file) && targets.includes(bak) && targets.includes(`${file}.old`));
});

test('a failed first write hands out no key and leaves no file behind; the next start tries again', (t) => {
  const { dir, file, make } = setup(t);
  const { fs: broken } = fakeFs({
    renameSync: (from, to) => { if (to === file) throw ioError('EIO'); return fs.renameSync(from, to); },
  });
  const id = make({ fs: broken });
  assert.deepEqual(id.load(), { ok: false, error: 'WRITE_FAILED' });
  assert.equal(id.unavailable, true);
  assert.equal(id.publicKeyRaw(), null, 'a key that is not on disk would change at the next start');
  assert.deepEqual(fs.readdirSync(dir), [], 'no identity.json, no .bak, no temp file');
  const next = make();
  assert.deepEqual(next.load(), { ok: true, error: null });
  assert.ok(fs.existsSync(file));
});

test('a damaged or missing identity.json is restored from .bak: same key, damaged bytes kept aside', (t) => {
  const { dir, file, bak, make } = setup(t);
  const original = make();
  original.load();
  const good = fs.readFileSync(file);
  const doc = JSON.parse(good.toString('utf8'));
  const variants = [
    ['garbage', Buffer.from('not json at all')],
    ['a torn write', good.subarray(0, 40)],
    ['empty', Buffer.alloc(0)],
    ['valid JSON, but pub is another key', Buffer.from(JSON.stringify({ ...doc, pub: Buffer.alloc(32, 1).toString('base64url') }))],
    ['missing', null],
  ];
  for (const [name, bytes] of variants) {
    for (const n of filesLike(dir, /corrupt/)) fs.unlinkSync(path.join(dir, n));
    if (bytes) fs.writeFileSync(file, bytes);
    else fs.unlinkSync(file);
    const id = make();
    assert.deepEqual(id.load(), { ok: true, error: null }, name);
    assert.ok(id.publicKeyRaw().equals(original.publicKeyRaw()), `${name}: the key did not change`);
    assert.ok(fs.readFileSync(file).equals(good), `${name}: identity.json rewritten from .bak`);
    assert.ok(fs.readFileSync(bak).equals(good), name);
    const aside = filesLike(dir, /^identity\.json\.corrupt-\d+$/);
    if (bytes) {
      assert.equal(aside.length, 1, `${name}: the damaged file is kept`);
      assert.ok(fs.readFileSync(path.join(dir, aside[0])).equals(bytes), name);
    } else {
      assert.equal(aside.length, 0, name);
    }
  }
});

test('a damaged .bak next to a valid identity.json is kept aside and rewritten', (t) => {
  const { dir, file, bak, make } = setup(t);
  const original = make();
  original.load();
  fs.writeFileSync(bak, '{"v":1,');
  const id = make();
  assert.deepEqual(id.load(), { ok: true, error: null });
  assert.ok(id.publicKeyRaw().equals(original.publicKeyRaw()));
  assert.ok(fs.readFileSync(bak).equals(fs.readFileSync(file)));
  const aside = filesLike(dir, /^identity\.json\.bak\.corrupt-\d+$/);
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{"v":1,');
});

test('a .bak holding another valid key (reset interrupted after identity.json) is kept as .prev and replaced', (t) => {
  const { dir, file, bak, make } = setup(t);
  const a = make();
  a.load();
  const aBytes = fs.readFileSync(file);
  const b = otherKeyFile(t);
  fs.writeFileSync(file, b.bytes); // the new key reached identity.json, the .bak still has the old one
  const id = make();
  assert.deepEqual(id.load(), { ok: true, error: null });
  assert.ok(id.publicKeyRaw().equals(b.pub), 'identity.json wins');
  assert.ok(fs.readFileSync(bak).equals(b.bytes), 'the backup follows identity.json');
  const prev = filesLike(dir, /^identity\.json\.bak\.prev-\d+$/);
  assert.equal(prev.length, 1);
  assert.ok(fs.readFileSync(path.join(dir, prev[0])).equals(aBytes), 'the other key is not destroyed');
});

test('nothing usable → unavailable with a code, no new key, every file byte-identical', (t) => {
  const { dir, file, bak, make } = setup(t);
  const seed = make();
  seed.load();
  const good = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cases = [
    ['both damaged', 'garbage-1', 'garbage-2', 'CORRUPT'],
    ['damaged, no .bak', 'garbage', null, 'CORRUPT'],
    ['no identity.json, damaged .bak', null, '{', 'CORRUPT'],
    ['written by a newer Tunnelview', JSON.stringify({ ...good, v: 2 }), null, 'VERSION'],
    ['newer identity.json, damaged .bak', JSON.stringify({ ...good, v: 3 }), 'x', 'VERSION'],
  ];
  for (const [name, main, backup, code] of cases) {
    for (const n of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, n));
    if (main !== null) fs.writeFileSync(file, main);
    if (backup !== null) fs.writeFileSync(bak, backup);
    const before = snapshot(dir);
    const id = make();
    assert.deepEqual(id.load(), { ok: false, error: code }, name);
    assert.equal(id.unavailable, true, name);
    assert.equal(id.error, code, name);
    assert.equal(id.publicKeyRaw(), null, name);
    assert.equal(id.publicKeyB64url(), null, name);
    assert.equal(id.fingerprint(), null, name);
    assert.throws(() => id.sign(Buffer.from('x')), { code: 'IDENTITY_UNAVAILABLE' }, name);
    assert.deepEqual(snapshot(dir), before, `${name}: nothing written, renamed or deleted`);
    assert.deepEqual(id.retry(), { ok: false, error: code }, `${name}: retry without a fix`);
    assert.deepEqual(snapshot(dir), before, name);
  }
});

test('retry() after the file is repaired brings back the original key, not a new one', (t) => {
  const { file, bak, make } = setup(t);
  const original = make();
  original.load();
  const good = fs.readFileSync(file);
  fs.writeFileSync(file, 'damaged');
  fs.writeFileSync(bak, 'damaged too');
  const id = make();
  assert.equal(id.load().ok, false);
  fs.writeFileSync(file, good); // e.g. restored from a backup by the user
  assert.deepEqual(id.retry(), { ok: true, error: null });
  assert.ok(id.publicKeyRaw().equals(original.publicKeyRaw()));
  assert.equal(id.wasReset, false);
});

test('an identity.json that cannot be read (I/O error) is never written over', (t) => {
  const { file, bak, make } = setup(t);
  const original = make();
  original.load();
  const denied = (p, ...rest) => { if (p === file) throw ioError('EACCES'); return fs.readFileSync(p, ...rest); };

  const { fs: withBak, log: log1 } = fakeFs({ readFileSync: denied });
  const id = make({ fs: withBak });
  assert.deepEqual(id.load(), { ok: true, error: null }, 'the .bak copy is used');
  assert.ok(id.publicKeyRaw().equals(original.publicKeyRaw()));
  assert.deepEqual(log1, [], 'nothing written, renamed or deleted');

  fs.unlinkSync(bak);
  const { fs: noBak, log: log2 } = fakeFs({ readFileSync: denied });
  const id2 = make({ fs: noBak });
  assert.deepEqual(id2.load(), { ok: false, error: 'READ_FAILED' });
  assert.deepEqual(log2, []);
  assert.ok(fs.existsSync(file));
});

test('the public key never changes across loads and retries; only reset() changes it', (t) => {
  const { make } = setup(t);
  const id = make();
  id.load();
  const pub = id.publicKeyRaw();
  for (let i = 0; i < 5; i++) {
    id.load();
    id.retry();
    const again = make();
    again.load();
    assert.ok(id.publicKeyRaw().equals(pub));
    assert.ok(again.publicKeyRaw().equals(pub));
  }
  assert.equal(id.reset().ok, true);
  assert.ok(!id.publicKeyRaw().equals(pub));
});

test('reset(): a new key, the previous identity.json kept as .old, .bak follows, wasReset', (t) => {
  const { dir, file, bak, old, make } = setup(t);
  const id = make();
  id.load();
  const before = { pub: id.publicKeyRaw(), fp: id.fingerprint(), bytes: fs.readFileSync(file) };
  assert.deepEqual(id.reset(), { ok: true, error: null });
  assert.equal(id.wasReset, true);
  assert.equal(id.unavailable, false);
  assert.ok(!id.publicKeyRaw().equals(before.pub));
  assert.notEqual(id.fingerprint(), before.fp);
  assert.ok(fs.readFileSync(old).equals(before.bytes), 'the old key is kept');
  assert.ok(fs.readFileSync(file).equals(fs.readFileSync(bak)));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['identity.json', 'identity.json.bak', 'identity.json.old']);
  const msg = Buffer.from('after reset');
  assert.ok(verifyRaw(id.publicKeyRaw(), msg, id.sign(msg)));
  // The next start loads the new key; wasReset is about this run only.
  const restarted = make();
  restarted.load();
  assert.ok(restarted.publicKeyRaw().equals(id.publicKeyRaw()));
  assert.equal(restarted.wasReset, false);
});

test('reset() is refused during an incoming session', (t) => {
  const { dir, make } = setup(t);
  const id = make();
  id.load();
  const pub = id.publicKeyRaw();
  const before = snapshot(dir);
  assert.deepEqual(id.reset({ sessionActive: true }), { ok: false, error: 'SESSION_ACTIVE' });
  assert.ok(id.publicKeyRaw().equals(pub));
  assert.equal(id.wasReset, false);
  assert.deepEqual(snapshot(dir), before);
});

test('reset() keeps the old key when the new one cannot be written', (t) => {
  const { file, make } = setup(t);
  const seed = make();
  seed.load();
  const bytes = fs.readFileSync(file);
  const { fs: broken } = fakeFs({
    renameSync: (from, to) => { if (to === file) throw ioError('ENOSPC'); return fs.renameSync(from, to); },
  });
  const id = make({ fs: broken });
  id.load();
  assert.deepEqual(id.reset(), { ok: false, error: 'WRITE_FAILED' });
  assert.ok(id.publicKeyRaw().equals(seed.publicKeyRaw()));
  assert.equal(id.wasReset, false);
  assert.ok(fs.readFileSync(file).equals(bytes));
});

test('reset() from the unavailable state keeps the unreadable file as .old and a damaged .bak aside', (t) => {
  const { dir, file, bak, old, make } = setup(t);
  fs.writeFileSync(file, 'damaged identity');
  fs.writeFileSync(bak, 'damaged backup');
  const id = make();
  assert.equal(id.load().error, 'CORRUPT');
  assert.deepEqual(id.reset(), { ok: true, error: null });
  assert.equal(id.unavailable, false);
  assert.equal(id.error, null);
  assert.equal(fs.readFileSync(old, 'utf8'), 'damaged identity');
  const aside = filesLike(dir, /^identity\.json\.bak\.corrupt-\d+$/);
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), 'damaged backup');
  assert.ok(fs.readFileSync(file).equals(fs.readFileSync(bak)));
  assert.ok(make().load().ok);
});

test('a second and third reset() keep every earlier key: an existing .old is set aside, never written over', (t) => {
  const { dir, file, bak, old, make } = setup(t);
  // One clock value for everything: the aside names must not collide either.
  const id = make({ now: () => 1762520000000 });
  id.load();
  const keys = [fs.readFileSync(file)];
  for (let i = 0; i < 3; i++) {
    assert.deepEqual(id.reset(), { ok: true, error: null });
    keys.push(fs.readFileSync(file));
  }
  assert.ok(fs.readFileSync(old).equals(keys[2]), '.old is the key the last reset retired');
  assert.ok(fs.readFileSync(bak).equals(keys[3]));
  const aside = filesLike(dir, /^identity\.json\.old\.prev-\d+(-\d+)?$/).sort();
  assert.deepEqual(aside, ['identity.json.old.prev-1762520000000', 'identity.json.old.prev-1762520000000-1']);
  const onDisk = fs.readdirSync(dir).map((n) => fs.readFileSync(path.join(dir, n)));
  for (const [i, k] of keys.entries()) assert.ok(onDisk.some((b) => b.equals(k)), `key ${i} is still on disk`);
});

test('reset() over a damaged identity.json keeps the valid .old it would replace', (t) => {
  const { dir, file, bak, old, make } = setup(t);
  const id = make();
  id.load();
  id.reset();
  const retired = fs.readFileSync(old);
  fs.writeFileSync(file, 'damaged identity');
  fs.unlinkSync(bak);
  const again = make();
  assert.equal(again.load().error, 'CORRUPT');
  assert.deepEqual(again.reset(), { ok: true, error: null });
  assert.equal(fs.readFileSync(old, 'utf8'), 'damaged identity', 'what identity.json held');
  const prev = filesLike(dir, /^identity\.json\.old\.prev-\d+$/);
  assert.equal(prev.length, 1);
  assert.ok(fs.readFileSync(path.join(dir, prev[0])).equals(retired), 'the earlier retired key survives');
});

test('reset() with an unreadable identity.json sets an existing .old aside before moving the file there', (t) => {
  const { dir, file, old, make } = setup(t);
  const first = make();
  first.load();
  first.reset();
  const retired = fs.readFileSync(old);
  const current = fs.readFileSync(file);
  const denied = (p, ...rest) => { if (p === file) throw ioError('EACCES'); return fs.readFileSync(p, ...rest); };
  const { fs: noRead } = fakeFs({ readFileSync: denied });
  const id = make({ fs: noRead });
  assert.equal(id.load().ok, true, 'from .bak');
  assert.deepEqual(id.reset(), { ok: true, error: null });
  assert.ok(fs.readFileSync(old).equals(current), 'the unreadable file was moved to .old as it is');
  const prev = filesLike(dir, /^identity\.json\.old\.prev-\d+$/);
  assert.equal(prev.length, 1);
  assert.ok(fs.readFileSync(path.join(dir, prev[0])).equals(retired));

  // .old cannot be moved aside → nothing changes, and the reset is refused.
  const before = snapshot(dir);
  const { fs: stuck } = fakeFs({
    readFileSync: denied,
    renameSync: (from, to) => { if (from === old) throw ioError('EPERM'); return fs.renameSync(from, to); },
  });
  const id2 = make({ fs: stuck });
  id2.load();
  const pub = id2.publicKeyRaw();
  assert.deepEqual(id2.reset(), { ok: false, error: 'WRITE_FAILED' });
  assert.ok(id2.publicKeyRaw().equals(pub));
  assert.deepEqual(snapshot(dir), before);
});

test('retry() makes no key once a key file existed in this run: both files gone → MISSING until reset()', (t) => {
  const { dir, file, bak, make } = setup(t);
  // The banner case: identity.json damaged, no .bak; the user then deletes the damaged file.
  fs.writeFileSync(file, 'damaged');
  const id = make();
  assert.deepEqual(id.load(), { ok: false, error: 'CORRUPT' });
  fs.unlinkSync(file);
  assert.deepEqual(id.retry(), { ok: false, error: 'MISSING' });
  assert.equal(id.unavailable, true);
  assert.equal(id.fingerprint(), null);
  assert.equal(id.wasReset, false);
  assert.deepEqual(fs.readdirSync(dir), [], 'no new key was written');
  // Same for a key that was in use when its files went away.
  const used = make();
  used.load();
  fs.unlinkSync(file);
  fs.unlinkSync(bak);
  assert.deepEqual(used.retry(), { ok: false, error: 'MISSING' });
  assert.deepEqual(fs.readdirSync(dir), []);
  // reset() is the way to a new key, and it says so.
  assert.deepEqual(id.reset(), { ok: true, error: null });
  assert.equal(id.wasReset, true);
  assert.equal(id.unavailable, false);
  // The next start with no files at all is a first start (D1 step 3).
  for (const n of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, n));
  assert.deepEqual(make().load(), { ok: true, error: null });
});

test('retry() after a failed first write tries again: this run never had a key file', (t) => {
  const { file, make } = setup(t);
  let failing = true;
  const { fs: flaky } = fakeFs({
    renameSync: (from, to) => { if (failing && to === file) throw ioError('ENOSPC'); return fs.renameSync(from, to); },
  });
  const id = make({ fs: flaky });
  assert.deepEqual(id.load(), { ok: false, error: 'WRITE_FAILED' });
  failing = false; // the user freed some disk space
  assert.deepEqual(id.retry(), { ok: true, error: null });
  assert.equal(id.wasReset, false);
  assert.ok(fs.existsSync(file));
});

test('temp files left by a crash are removed at load; other files stay', (t) => {
  const { dir, make } = setup(t);
  const leftovers = ['identity.json.123.1762520000000.1.tmp', 'identity.json.bak.9.1.2.tmp'];
  const keep = ['notes.txt', 'identity.json.old', 'settings.json.1.2.tmp'];
  for (const n of [...leftovers, ...keep]) fs.writeFileSync(path.join(dir, n), 'x');
  make().load();
  const names = fs.readdirSync(dir);
  for (const n of leftovers) assert.ok(!names.includes(n), n);
  for (const n of keep) assert.ok(names.includes(n), n);
});

test('parseIdentity: only a complete, self-consistent v1 record is a key', (t) => {
  const { file, make } = setup(t);
  make().load();
  const good = JSON.parse(fs.readFileSync(file, 'utf8'));
  const parse = (v) => parseIdentity(Buffer.isBuffer(v) ? v : Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)));
  assert.equal(parse(good).ok, true);
  assert.equal(parse({ ...good, note: 'kept for later versions' }).ok, true, 'unknown fields are ignored');
  assert.equal(parse(String.fromCharCode(0xfeff) + JSON.stringify(good)).ok, true, 'a BOM (an editor saved it) is tolerated');
  const x25519 = crypto.generateKeyPairSync('x25519').privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64');
  const cases = [
    [{ ...good, v: 2 }, 'VERSION'],
    [{ ...good, v: '1' }, 'CORRUPT'],
    [{ ...good, v: 0 }, 'CORRUPT'],
    [{ ...good, createdAt: 0 }, 'CORRUPT'],
    [{ ...good, createdAt: '2026-11-07' }, 'CORRUPT'],
    [{ ...good, pub: Buffer.from(good.pub, 'base64url').toString('base64') }, 'CORRUPT'],
    [{ ...good, pub: good.pub.slice(0, -1) }, 'CORRUPT'],
    [{ ...good, priv: good.priv.slice(0, -4) }, 'CORRUPT'],
    [{ ...good, priv: `${good.priv}\n` }, 'CORRUPT'],
    [{ ...good, priv: x25519 }, 'CORRUPT'],
    [{ ...good, priv: Buffer.alloc(48).toString('base64') }, 'CORRUPT'],
    [{ v: 1, createdAt: good.createdAt, pub: good.pub }, 'CORRUPT'],
    [[good], 'CORRUPT'],
    ['null', 'CORRUPT'],
    [Buffer.from([0x7b, 0xff, 0x7d]), 'CORRUPT'],
    [Buffer.alloc(70 * 1024, 0x20), 'CORRUPT'],
  ];
  for (const [input, code] of cases) assert.deepEqual(parse(input), { ok: false, code }, JSON.stringify(input).slice(0, 80));
});

test('createIdentity needs an absolute path to identity.json', () => {
  for (const file of [undefined, '', 'identity.json', './x/identity.json', 42]) {
    assert.throws(() => createIdentity({ file }), TypeError);
  }
  assert.throws(() => createIdentity(), TypeError);
});
