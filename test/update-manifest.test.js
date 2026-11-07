'use strict';
/*
 * node --test test/update-manifest.test.js — the signed update manifest (DECISIONS U1, U8):
 * src/main/update-manifest.js and src/main/update-keys.js. Pure: throwaway keys, no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const M = require('../src/main/update-manifest');
const { KEYS } = require('../src/main/update-keys');
const { makeKey, makeRelease, signedManifest, signRaw, DATE } = require('./support/update-fixtures');

const KEY = makeKey();
const OTHER = makeKey();
const REL = makeRelease('0.4.0');
const GOOD = signedManifest(KEY, REL);

const payloadOf = (overrides = {}) => ({ ...M.buildPayload({ version: '0.4.0', date: DATE, notes: 'n', files: REL.files }), ...overrides });
const raw = (p) => Buffer.from(JSON.stringify(p), 'utf8');
const verify = (bytes, opts = {}) => M.verifyManifest(bytes, { keys: KEY.keys, ...opts });

/* ------------------------------------------------------------------ keys */

test('update-keys.js: the production key is listed under the kid derived from it', () => {
  const prod = KEYS.find((k) => k.publicKey === 'HpauGGB_6J3ZetoaaXAdBZbrj4DXVpwzODsP2mzIiIE');
  assert.ok(prod, 'the production key is embedded');
  assert.equal(prod.kid, '3f8c892c42f7ffac');
  for (const k of KEYS) {
    assert.deepEqual(Object.keys(k).sort(), ['kid', 'publicKey']);
    const rawKey = M.decodeB64url(k.publicKey, 32);
    assert.ok(rawKey, `${k.kid}: 32 raw bytes, canonical base64url`);
    assert.equal(k.kid, M.keyId(rawKey), 'kid = first 16 hex of SHA-256(raw key)');
    assert.equal(k.kid, crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 16));
    assert.doesNotThrow(() => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), format: 'der', type: 'spki' }));
  }
  assert.equal(new Set(KEYS.map((k) => k.kid)).size, KEYS.length, 'kids are unique');
  assert.ok(Object.isFrozen(KEYS) && KEYS.every(Object.isFrozen));
});

/* ------------------------------------------------------------------ good manifest */

test('a manifest signed by an embedded key verifies; the result is frozen and canonical', () => {
  const r = verify(GOOD);
  assert.equal(r.ok, true);
  assert.equal(r.kid, KEY.kid);
  assert.deepEqual(Object.keys(r.manifest), ['v', 'app', 'version', 'date', 'notes', 'files']);
  assert.equal(r.manifest.version, '0.4.0');
  assert.equal(r.manifest.app, 'Tunnelview');
  assert.equal(r.manifest.date, DATE);
  assert.deepEqual(Object.keys(r.manifest.files), ['win32-x64', 'win32-arm64', 'darwin-arm64', 'darwin-x64']);
  assert.deepEqual(r.manifest.files['win32-x64'], REL.files['win32-x64']);
  assert.ok(Object.isFrozen(r.manifest) && Object.isFrozen(r.manifest.files['darwin-x64']));
  // The file is the envelope JSON with a trailing newline; a string works as well as bytes.
  assert.equal(GOOD[GOOD.length - 1], 0x0a);
  assert.deepEqual(Object.keys(JSON.parse(GOOD.toString('utf8'))), ['payload', 'sig', 'kid']);
  assert.equal(verify(GOOD.toString('utf8')).ok, true);
  // Notes keep newlines and tabs.
  const withTabs = signedManifest(KEY, REL, { notes: 'a\tb\n\nc' });
  assert.equal(verify(withTabs).manifest.notes, 'a\tb\n\nc');
});

test('currentVersion: only a strictly newer version is offered (no downgrade, no replay)', () => {
  assert.equal(verify(GOOD, { currentVersion: '0.3.0' }).ok, true);
  assert.equal(verify(GOOD, { currentVersion: '0.3.99' }).ok, true);
  assert.deepEqual(verify(GOOD, { currentVersion: '0.4.0' }), { ok: false, code: 'NOT_NEWER', version: '0.4.0' });
  assert.equal(verify(GOOD, { currentVersion: '0.4.1' }).code, 'NOT_NEWER');
  assert.equal(verify(GOOD, { currentVersion: '1.0.0' }).code, 'NOT_NEWER');
  assert.throws(() => verify(GOOD, { currentVersion: '0.4' }), TypeError);
});

/* ------------------------------------------------------------------ signature and key */

test('bad signature: a changed payload byte, a changed signature byte, or the payload of another manifest', () => {
  const env = JSON.parse(GOOD.toString('utf8'));
  const flip = (b64, i) => { const b = Buffer.from(b64, 'base64'); b[i] ^= 0x01; return b.toString('base64'); };
  const reenc = (o) => M.encodeEnvelope(o);
  assert.equal(verify(reenc({ ...env, sig: flip(env.sig, 10) })).code, 'BAD_SIGNATURE');
  assert.equal(verify(reenc({ ...env, payload: flip(env.payload, 20) })).code, 'BAD_SIGNATURE');
  const other = JSON.parse(signedManifest(KEY, makeRelease('9.9.9')).toString('utf8'));
  assert.equal(verify(reenc({ ...env, payload: other.payload })).code, 'BAD_SIGNATURE', 'signature of 0.4.0 over 9.9.9');
});

test('wrong key: unknown kid → UNKNOWN_KEY; another key under a known kid → BAD_SIGNATURE', () => {
  const byOther = signedManifest(OTHER, REL);
  assert.deepEqual(verify(byOther), { ok: false, code: 'UNKNOWN_KEY' }, 'OTHER is not in the list');
  // OTHER's signature relabelled with KEY's kid.
  const env = JSON.parse(byOther.toString('utf8'));
  assert.equal(verify(M.encodeEnvelope({ ...env, kid: KEY.kid })).code, 'BAD_SIGNATURE');
  // A list entry whose kid does not belong to its key never matches.
  assert.equal(verify(GOOD, { keys: [{ kid: KEY.kid, publicKey: OTHER.pub }] }).code, 'UNKNOWN_KEY');
  assert.equal(verify(GOOD, { keys: [{ kid: KEY.kid, publicKey: 'not-a-key' }] }).code, 'UNKNOWN_KEY');
  assert.equal(verify(GOOD, { keys: [] }).code, 'UNKNOWN_KEY');
  assert.equal(verify(GOOD, { keys: undefined }).code, 'UNKNOWN_KEY');
  // Several keys (rotation): the kid picks the right one.
  assert.equal(verify(GOOD, { keys: [...OTHER.keys, ...KEY.keys] }).ok, true);
  assert.equal(verify(byOther, { keys: [...KEY.keys, ...OTHER.keys] }).ok, true);
});

/* ------------------------------------------------------------------ envelope */

test('malformed envelopes are refused before any signature work', () => {
  const env = JSON.parse(GOOD.toString('utf8'));
  const cases = [
    ['not json', Buffer.from('<html>not found</html>')],
    ['not utf-8', Buffer.from([0x7b, 0xff, 0xfe, 0x7d])],
    ['array', Buffer.from('[1,2,3]')],
    ['null', Buffer.from('null')],
    ['extra key', Buffer.from(JSON.stringify({ ...env, extra: 'x' }))],
    ['missing kid', Buffer.from(JSON.stringify({ payload: env.payload, sig: env.sig }))],
    ['__proto__ key', Buffer.from(`{"payload":"${env.payload}","sig":"${env.sig}","kid":"${env.kid}","__proto__":{}}`)],
    ['kid not a string', Buffer.from(JSON.stringify({ ...env, kid: 7 }))],
    ['kid upper case', M.encodeEnvelope({ ...env, kid: env.kid.toUpperCase() })],
    ['kid too short', M.encodeEnvelope({ ...env, kid: env.kid.slice(0, 15) })],
    ['payload with base64url characters', M.encodeEnvelope({ ...env, payload: `${env.payload.slice(0, -4)}ab-_` })],
    ['payload with non-canonical padding bits', M.encodeEnvelope({ ...env, payload: 'QR==' })],
    ['payload with whitespace', M.encodeEnvelope({ ...env, payload: ` ${env.payload}` })],
    ['payload empty', M.encodeEnvelope({ ...env, payload: '' })],
    ['sig 63 bytes', M.encodeEnvelope({ ...env, sig: Buffer.alloc(63).toString('base64') })],
    ['sig 65 bytes', M.encodeEnvelope({ ...env, sig: Buffer.alloc(65).toString('base64') })],
  ];
  for (const [what, bytes] of cases) assert.equal(verify(bytes).code, 'MALFORMED', what);
  assert.equal(verify(12345).code, 'MALFORMED');
});

test('oversized: anything over 64 KiB is refused unread', () => {
  assert.equal(M.MAX_MANIFEST_BYTES, 65536);
  const padded = Buffer.concat([GOOD.subarray(0, GOOD.length - 1), Buffer.alloc(M.MAX_MANIFEST_BYTES - GOOD.length + 1, 0x20)]);
  assert.equal(padded.length, M.MAX_MANIFEST_BYTES);
  assert.equal(verify(padded).ok, true, 'exactly 64 KiB (trailing JSON whitespace) is still read');
  assert.deepEqual(verify(Buffer.concat([padded, Buffer.from(' ')])), { ok: false, code: 'TOO_LARGE' });
  assert.equal(verify(Buffer.alloc(1024 * 1024, 0x7b)).code, 'TOO_LARGE');
});

/* ------------------------------------------------------------------ payload rules (signed) */

test('signed payloads that break a rule are INVALID, naming the field', () => {
  const files = (key, patch) => ({ ...REL.files, [key]: { ...REL.files[key], ...patch } });
  const cases = [
    ['keys', { ...payloadOf(), extra: 1 }],
    ['keys', (() => { const p = payloadOf(); delete p.notes; return p; })()],
    ['v', payloadOf({ v: 2 })],
    ['v', payloadOf({ v: '1' })],
    ['app', payloadOf({ app: 'tunnelview' })],
    ['version', payloadOf({ version: '0.4' })],
    ['version', payloadOf({ version: '0.04.0' })],
    ['version', payloadOf({ version: '0.4.0-beta.1' })],
    ['version', payloadOf({ version: ' 0.4.0' })],
    ['version', payloadOf({ version: 400 })],
    ['date', payloadOf({ date: '2026-02-30T00:00:00.000Z' })],
    ['date', payloadOf({ date: '2026-11-07T12:00:00Z' })],
    ['date', payloadOf({ date: '2026-11-07' })],
    ['notes', payloadOf({ notes: 'x'.repeat(4001) })],
    ['notes', payloadOf({ notes: 'line\r\nline' })],
    ['notes', payloadOf({ notes: 'bell\u0007' })],
    ['notes', payloadOf({ notes: 'nul\u0000' })],
    ['notes', payloadOf({ notes: 'c1\u0085' })],
    ['notes', payloadOf({ notes: 'evil\u202egnp.exe' })],
    ['notes', payloadOf({ notes: 'isolate\u2066x\u2069' })],
    ['notes', payloadOf({ notes: 'sep\u2028x' })],
    ['notes', payloadOf({ notes: 'lone \ud800 surrogate' })],
    ['notes', payloadOf({ notes: null })],
    ['files', payloadOf({ files: { ...REL.files, 'linux-x64': REL.files['win32-x64'] } })],
    ['files', payloadOf({ files: (() => { const f = { ...REL.files }; delete f['darwin-x64']; return f; })() })],
    ['files', payloadOf({ files: [] })],
    ['files.win32-x64', payloadOf({ files: files('win32-x64', { extra: true }) })],
    ['files.win32-x64.name', payloadOf({ files: files('win32-x64', { name: 'Tunnelview-Setup-0.3.9-x64.exe' }) })],
    ['files.win32-x64.name', payloadOf({ files: files('win32-x64', { name: '../Tunnelview-Setup-0.4.0-x64.exe' }) })],
    ['files.win32-x64.name', payloadOf({ files: files('win32-x64', { name: 'Tunnelview-Setup-0.4.0-arm64.exe' }) })],
    ['files.darwin-arm64.name', payloadOf({ files: files('darwin-arm64', { name: 'Tunnelview-0.4.0-mac-arm64.dmg' }) })],
    ['files.darwin-x64.name', payloadOf({ files: files('darwin-x64', { name: 'sub/Tunnelview-0.4.0-mac-x64.zip' }) })],
    ['files.win32-arm64.size', payloadOf({ files: files('win32-arm64', { size: 0 }) })],
    ['files.win32-arm64.size', payloadOf({ files: files('win32-arm64', { size: 400 * 1024 * 1024 + 1 }) })],
    ['files.win32-arm64.size', payloadOf({ files: files('win32-arm64', { size: 10.5 }) })],
    ['files.win32-arm64.size', payloadOf({ files: files('win32-arm64', { size: '100' }) })],
    ['files.darwin-x64.sha256', payloadOf({ files: files('darwin-x64', { sha256: 'A'.repeat(64) }) })],
    ['files.darwin-x64.sha256', payloadOf({ files: files('darwin-x64', { sha256: 'a'.repeat(63) }) })],
  ];
  for (const [detail, p] of cases) {
    const r = verify(signRaw(KEY, raw(p)));
    assert.deepEqual(r, { ok: false, code: 'INVALID', detail }, `${detail}: ${JSON.stringify(p).slice(0, 80)}`);
    assert.equal(M.validatePayload(p), detail);
  }
  // Signed bytes that are not JSON, and JSON that is not the one canonical spelling.
  assert.deepEqual(verify(signRaw(KEY, Buffer.from('not json'))), { ok: false, code: 'INVALID', detail: 'json' });
  assert.deepEqual(verify(signRaw(KEY, Buffer.from(JSON.stringify(payloadOf(), null, 2)))), { ok: false, code: 'INVALID', detail: 'not-canonical' });
  const reordered = { app: 'Tunnelview', ...payloadOf() };
  assert.deepEqual(verify(signRaw(KEY, raw(reordered))), { ok: false, code: 'INVALID', detail: 'not-canonical' });
  // Exactly the limits are fine.
  assert.equal(verify(signRaw(KEY, M.encodePayload(payloadOf({ notes: 'x'.repeat(4000) })))).ok, true);
  assert.equal(verify(signRaw(KEY, M.encodePayload(payloadOf({ files: files('win32-x64', { size: 400 * 1024 * 1024 }) })))).ok, true);
});

test('signManifest refuses an invalid payload, a non-Ed25519 key and a kid of another key', () => {
  assert.throws(() => M.signManifest(payloadOf({ version: '1.2' }), KEY.privateKey), /not valid \(version\)/);
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
  assert.throws(() => M.signManifest(payloadOf(), rsa), (e) => e.code === 'BAD_KEY');
  assert.throws(() => M.signManifest(payloadOf(), KEY.privateKey, OTHER.kid), (e) => e.code === 'BAD_KEY');
  // A PEM string works as well as a KeyObject, and the kid comes from the key.
  const pem = KEY.privateKey.export({ format: 'pem', type: 'pkcs8' });
  const bytes = M.signManifest(payloadOf(), pem);
  assert.equal(JSON.parse(bytes.toString('utf8')).kid, KEY.kid);
  assert.equal(verify(bytes).ok, true);
});

/* ------------------------------------------------------------------ versions, names, notes */

test('compareVersions: numeric per part; anything but X.Y.Z throws', () => {
  const ordered = ['0.0.0', '0.0.1', '0.1.0', '0.2.0', '0.2.9', '0.2.10', '0.3.0', '0.10.0', '0.99.99', '1.0.0', '1.0.10', '2.0.0', '10.0.0'];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = 0; j < ordered.length; j++) {
      assert.equal(M.compareVersions(ordered[i], ordered[j]), Math.sign(i - j), `${ordered[i]} vs ${ordered[j]}`);
    }
  }
  for (const bad of ['1.0', '1.0.0.0', 'v1.0.0', '1.0.0-beta', '01.0.0', '1.0.x', '', null, undefined, 1]) {
    assert.throws(() => M.compareVersions(bad, '1.0.0'), TypeError, String(bad));
    assert.equal(M.validVersion(bad), false);
  }
});

test('asset names: exactly the release names per platform; the allow-list refuses everything else', () => {
  assert.equal(M.assetName('win32-x64', '0.4.0'), 'Tunnelview-Setup-0.4.0-x64.exe');
  assert.equal(M.assetName('win32-arm64', '0.4.0'), 'Tunnelview-Setup-0.4.0-arm64.exe');
  assert.equal(M.assetName('darwin-arm64', '0.4.0'), 'Tunnelview-0.4.0-mac-arm64.zip');
  assert.equal(M.assetName('darwin-x64', '0.4.0'), 'Tunnelview-0.4.0-mac-x64.zip');
  assert.throws(() => M.assetName('linux-x64', '0.4.0'), (e) => e.code === 'BAD_PLATFORM');
  assert.throws(() => M.assetName('win32-x64', '0.4'), (e) => e.code === 'BAD_VERSION');
  for (const bad of ['Tunnelview-0.4.0-mac-arm64.dmg', '../Tunnelview-Setup-0.4.0-x64.exe', 'Tunnelview-Setup-0.4.0-x64.exe/', 'Tunnelview-Setup-0.4.0-x64.exe\u0000', 'x/Tunnelview-Setup-0.4.0-x64.exe', 'Tunnelview-Setup-0.4.0-x64.EXE']) {
    for (const re of Object.values(M.ASSET_NAME_RE)) assert.equal(re.test(bad), false, bad);
  }
});

test('notes: \\n and \\t allowed; normalizeNotes makes CRLF files signable', () => {
  assert.equal(M.validNotes('a\n\tb'), true);
  assert.equal(M.validNotes(''), true);
  assert.equal(M.validNotes('emoji 😀 ok'), true, 'a surrogate pair is fine');
  assert.equal(M.normalizeNotes('\ufeffFirst\r\nSecond\rThird  \n\n'), 'First\nSecond\nThird');
  assert.equal(M.validNotes(M.normalizeNotes('a\r\nb')), true);
});
