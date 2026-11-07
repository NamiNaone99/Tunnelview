'use strict';
/* node --test test/auth.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const PROTOCOL = require('../src/shared/protocol');
const auth = require('../src/main/auth');

// Smallest parameters validateKdf accepts (N·r = 2^17, ~30 ms) keep the suite fast.
const FAST_KDF = { N: 16384, r: 8, p: 1, keylen: 32 };
// Proof binding (protocol v2): the two nodes' Tailscale StableNodeIDs.
//   viewer: {hostId: node owning the IP it dialed, viewerId: itself}; host: {itself, whois(remote IP)}.
const HOST_ID = 'nHoSt1234CNTRL';
const VIEWER_ID = 'nV1ewer567CNTRL';
const B = { hostId: HOST_ID, viewerId: VIEWER_ID };
const B_NUMERIC = { hostId: '12', viewerId: '7' }; // e.g. Headscale numeric IDs
const params = (stored) => ({ salt: stored.salt, kdf: { N: stored.N, r: stored.r, p: stored.p, keylen: stored.keylen } });

test('protocol v2 auth context', () => {
  assert.equal(PROTOCOL.PROTOCOL_VERSION, 2);
  assert.equal(PROTOCOL.AUTH.CONTEXT, 'Tunnelview-auth-v2|');
});

test('hashPassword → computeProof → verifyProof round-trip (node-ID bindings)', async () => {
  const stored = await auth.hashPassword('correct horse battery', FAST_KDF);
  assert.deepEqual(Object.keys(stored).sort(), ['N', 'key', 'keylen', 'p', 'r', 'salt']);
  assert.equal(Buffer.from(stored.salt, 'base64').length, 16);
  assert.equal(Buffer.from(stored.key, 'base64').length, 32);
  assert.equal(auth.isStoredPassword(stored), true);

  const nonce = auth.newNonce();
  assert.equal(Buffer.from(nonce, 'base64').length, 32);
  for (const b of [B, B_NUMERIC]) {
    const proof = await auth.computeProof('correct horse battery', params(stored), nonce, b);
    assert.equal(auth.verifyProof(stored, nonce, proof, b), true);
    // the proof is bound to the nonce (no replay on another connection)
    assert.equal(auth.verifyProof(stored, auth.newNonce(), proof, b), false);
  }
});

test('proof is bound to both node IDs (no relay through another tailnet node)', async () => {
  const stored = await auth.hashPassword('relay-me-not', FAST_KDF);
  const nonce = auth.newNonce();
  // Viewer V dialed mallory M: its proof names M as the host …
  const atViewer = { hostId: 'nMALLORY', viewerId: VIEWER_ID };
  const proof = await auth.computeProof('relay-me-not', params(stored), nonce, atViewer);
  assert.equal(auth.verifyProof(stored, nonce, proof, atViewer), true);
  // … while the real host H sees M as the viewer (whois) and itself as the host.
  assert.equal(auth.verifyProof(stored, nonce, proof, { hostId: HOST_ID, viewerId: 'nMALLORY' }), false);
  assert.equal(auth.verifyProof(stored, nonce, proof, { hostId: HOST_ID, viewerId: VIEWER_ID }), false, 'host ID differs');
  assert.equal(auth.verifyProof(stored, nonce, proof, { hostId: 'nMALLORY', viewerId: 'nOTHER' }), false, 'viewer ID differs');
  assert.equal(auth.verifyProof(stored, nonce, proof, { hostId: VIEWER_ID, viewerId: 'nMALLORY' }), false, 'swapped');
});

test('node IDs are compared exactly (case-sensitive, no trimming)', async () => {
  const stored = await auth.hashPassword('exact-ids', FAST_KDF);
  const nonce = auth.newNonce();
  const proof = await auth.computeProof('exact-ids', params(stored), nonce, B);
  assert.equal(auth.verifyProof(stored, nonce, proof, { hostId: HOST_ID.toLowerCase(), viewerId: VIEWER_ID }), false);
  assert.equal(auth.verifyProof(stored, nonce, proof, { hostId: HOST_ID, viewerId: VIEWER_ID.toUpperCase() }), false);
  assert.deepEqual(auth.normalizeBinding({ hostId: 'n_A-1', viewerId: 'x'.repeat(64), extra: 1 }), { hostId: 'n_A-1', viewerId: 'x'.repeat(64) });
});

test('missing / invalid binding: verifyProof false, computeProof BAD_BINDING (before scrypt)', async () => {
  const stored = await auth.hashPassword('needs-binding', FAST_KDF);
  const nonce = auth.newNonce();
  const good = await auth.computeProof('needs-binding', params(stored), nonce, B);
  const bad = [undefined, null, {}, 'x', { hostId: HOST_ID }, { viewerId: VIEWER_ID }, { hostId: '', viewerId: VIEWER_ID },
    { hostId: HOST_ID, viewerId: '' }, { hostId: 42, viewerId: VIEWER_ID }, { hostId: 'a|b', viewerId: VIEWER_ID },
    { hostId: HOST_ID, viewerId: 'has space' }, { hostId: ` ${HOST_ID}`, viewerId: VIEWER_ID }, { hostId: 'x'.repeat(65), viewerId: VIEWER_ID },
    { hostId: '100.101.102.103', viewerId: VIEWER_ID }, { hostIp: '100.101.102.103', viewerIp: '100.90.5.6' }];
  for (const b of bad) {
    assert.equal(auth.verifyProof(stored, nonce, good, b), false, JSON.stringify(b));
    await assert.rejects(auth.computeProof('needs-binding', params(stored), nonce, b), { code: 'BAD_BINDING' }, JSON.stringify(b));
  }
  // the binding is checked first: no scrypt run for it, whatever else is wrong
  await assert.rejects(auth.computeProof('pw', { salt: stored.salt, kdf: { N: 1 << 20, r: 8, p: 1, keylen: 32 } }, nonce, null), { code: 'BAD_BINDING' });
});

test('hashPassword defaults to PROTOCOL.AUTH.KDF_DEFAULT', async () => {
  const stored = await auth.hashPassword('default-params-pw');
  const { N, r, p, keylen } = PROTOCOL.AUTH.KDF_DEFAULT;
  assert.deepEqual([stored.N, stored.r, stored.p, stored.keylen], [N, r, p, keylen]);
  // matches the documented derivation exactly
  const key = crypto.scryptSync(Buffer.from('default-params-pw'.normalize('NFC')), Buffer.from(stored.salt, 'base64'), keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  assert.equal(stored.key, key.toString('base64'));
});

test('proof format = base64(HMAC-SHA256(key, CONTEXT + nonceB64 + "|" + hostId + "|" + viewerId))', async () => {
  const stored = await auth.hashPassword('pw-format-check', FAST_KDF);
  const nonce = auth.newNonce();
  const key = Buffer.from(stored.key, 'base64');
  for (const b of [B, B_NUMERIC]) {
    const expected = crypto.createHmac('sha256', key).update(`Tunnelview-auth-v2|${nonce}|${b.hostId}|${b.viewerId}`).digest('base64');
    const proof = await auth.computeProof('pw-format-check', { salt: stored.salt, kdf: FAST_KDF }, nonce, b);
    assert.equal(proof, expected);
  }
});

test('fixed v2 vector (node IDs); the IP-bound and unbound v1 proofs are refused', () => {
  const key = Buffer.alloc(32, 0x11);
  const nonce = Buffer.alloc(32, 0x22).toString('base64');
  const stored = { salt: Buffer.alloc(16, 0x33).toString('base64'), ...FAST_KDF, key: key.toString('base64') };
  const v2 = crypto.createHmac('sha256', key).update(`Tunnelview-auth-v2|${nonce}|${HOST_ID}|${VIEWER_ID}`).digest('base64');
  assert.equal(v2, 'xvxr3gGEkhZ1evAYiFYNgw1qM/T0yQgaGJaDelvsEc4=');
  assert.equal(auth.verifyProof(stored, nonce, v2, B), true);
  assert.equal(auth.verifyProof(stored, nonce, v2, { hostId: VIEWER_ID, viewerId: HOST_ID }), false);
  const ipBound = crypto.createHmac('sha256', key).update(`Tunnelview-auth-v2|${nonce}|100.101.102.103|100.90.5.6`).digest('base64');
  assert.equal(auth.verifyProof(stored, nonce, ipBound, B), false);
  const v1 = crypto.createHmac('sha256', key).update(`Tunnelview-auth-v1|${nonce}`).digest('base64');
  assert.equal(auth.verifyProof(stored, nonce, v1, B), false);
});

test('passwords are NFC-normalized (composed vs decomposed é)', async () => {
  const composed = `caf${String.fromCharCode(0xe9)}-pass`; // precomposed e-acute
  const decomposed = `cafe${String.fromCharCode(0x301)}-pass`; // e + combining acute
  assert.notEqual(composed, decomposed);
  const stored = await auth.hashPassword(composed, FAST_KDF);
  const nonce = auth.newNonce();
  const proof = await auth.computeProof(decomposed, { salt: stored.salt, kdf: FAST_KDF }, nonce, B);
  assert.equal(auth.verifyProof(stored, nonce, proof, B), true);
});

test('verifyProof rejects wrong passwords and malformed input without throwing', async () => {
  const stored = await auth.hashPassword('right-password', FAST_KDF);
  const nonce = auth.newNonce();
  const wrong = await auth.computeProof('wrong-password', { salt: stored.salt, kdf: FAST_KDF }, nonce, B);
  assert.equal(auth.verifyProof(stored, nonce, wrong, B), false);
  const good = await auth.computeProof('right-password', { salt: stored.salt, kdf: FAST_KDF }, nonce, B);
  for (const bad of [null, undefined, 42, '', 'not base64!', good.slice(0, -4), `${good}AAAA`, Buffer.alloc(16).toString('base64'), Buffer.alloc(33).toString('base64'), 'A'.repeat(10000)]) {
    assert.equal(auth.verifyProof(stored, nonce, bad, B), false, `proof ${String(bad).slice(0, 20)}`);
  }
  assert.equal(auth.verifyProof(null, nonce, good, B), false);
  assert.equal(auth.verifyProof({}, nonce, good, B), false);
  assert.equal(auth.verifyProof({ ...stored, key: 'short' }, nonce, good, B), false);
  assert.equal(auth.verifyProof({ ...stored, N: 3 }, nonce, good, B), false);
  assert.equal(auth.verifyProof(stored, '', good, B), false);
  assert.equal(auth.verifyProof(stored, null, good, B), false);
  assert.equal(auth.verifyProof(stored, 'AAAA', good, B), false); // nonce too short
  assert.equal(auth.verifyProof(stored, nonce, good), false); // no binding
});

test('validateKdf: limits, power of two, memory ≤ 64 MiB, minimum work', () => {
  assert.equal(auth.validateKdf(PROTOCOL.AUTH.KDF_DEFAULT), true);
  assert.equal(auth.validateKdf(FAST_KDF), true);
  assert.equal(auth.validateKdf({ N: 16384, r: 16, p: 1, keylen: 32 }), true);
  assert.equal(auth.validateKdf({ N: 32768, r: 8, p: 4, keylen: 32 }), true);
  assert.equal(auth.validateKdf({ N: 65536, r: 4, p: 1, keylen: 32 }), true);
  // outside KDF_LIMITS
  assert.equal(auth.validateKdf({ N: 262144, r: 1, p: 1, keylen: 32 }), false);
  assert.equal(auth.validateKdf({ N: 16384, r: 17, p: 1, keylen: 32 }), false);
  assert.equal(auth.validateKdf({ N: 32768, r: 8, p: 5, keylen: 32 }), false);
  assert.equal(auth.validateKdf({ N: 32768, r: 8, p: 1, keylen: 64 }), false);
  // within KDF_LIMITS but scrypt cannot run them with maxmem 64 MiB
  assert.equal(auth.validateKdf({ N: 131072, r: 16, p: 4, keylen: 32 }), false);
  assert.equal(auth.validateKdf({ N: 65536, r: 8, p: 1, keylen: 32 }), false);
  assert.equal(auth.validateKdf({ N: 131072, r: 1, p: 1, keylen: 32 }), false); // N ≥ 2^(16r)
  // too weak (cheap to brute-force a harvested proof)
  assert.equal(auth.validateKdf({ N: 1024, r: 8, p: 1, keylen: 32 }), false);
  assert.equal(auth.validateKdf({ N: 2, r: 1, p: 1, keylen: 32 }), false);
  // malformed
  assert.equal(auth.validateKdf({ N: 30000, r: 8, p: 1, keylen: 32 }), false);
  assert.equal(auth.validateKdf({ N: 32768, r: 8.5, p: 1, keylen: 32 }), false);
  assert.equal(auth.validateKdf({ N: '32768', r: 8, p: 1, keylen: 32 }), false);
  assert.equal(auth.validateKdf({ N: 32768, r: 0, p: 1, keylen: 32 }), false);
  assert.equal(auth.validateKdf({ N: 32768, r: 8, p: 0, keylen: 32 }), false);
  assert.equal(auth.validateKdf(null), false);
  assert.equal(auth.validateKdf('x'), false);
});

test('validateKdf agrees with what scrypt can actually compute', () => {
  for (const N of [16384, 32768, 65536, 131072]) {
    for (const r of [1, 2, 4, 8, 16]) {
      for (const p of [1, 4]) {
        const kdf = { N, r, p, keylen: 32 };
        if (!auth.validateKdf(kdf)) continue;
        // Every accepted combination must be computable within maxmem (no surprise failures).
        assert.doesNotThrow(() => crypto.scryptSync('x', 'salt', 1, { N, r, p, maxmem: auth.SCRYPT_MAXMEM }), JSON.stringify(kdf));
      }
    }
  }
});

test('computeProof rejects unsafe host parameters with codes', async () => {
  const nonce = auth.newNonce();
  const salt = crypto.randomBytes(16).toString('base64');
  await assert.rejects(auth.computeProof('pw', { salt, kdf: { N: 1 << 20, r: 8, p: 1, keylen: 32 } }, nonce, B), { code: 'BAD_KDF' });
  await assert.rejects(auth.computeProof('pw', { salt, kdf: null }, nonce, B), { code: 'BAD_KDF' });
  await assert.rejects(auth.computeProof('pw', null, nonce, B), { code: 'BAD_KDF' });
  await assert.rejects(auth.computeProof('pw', { salt: 'bad!', kdf: FAST_KDF }, nonce, B), { code: 'BAD_SALT' });
  await assert.rejects(auth.computeProof('pw', { salt: Buffer.alloc(4).toString('base64'), kdf: FAST_KDF }, nonce, B), { code: 'BAD_SALT' });
  await assert.rejects(auth.computeProof('pw', { salt, kdf: FAST_KDF }, 'nope', B), { code: 'BAD_NONCE' });
  await assert.rejects(auth.computeProof('', { salt, kdf: FAST_KDF }, nonce, B), { code: 'BAD_PASSWORD_INPUT' });
  await assert.rejects(auth.computeProof(123, { salt, kdf: FAST_KDF }, nonce, B), { code: 'BAD_PASSWORD_INPUT' });
  await assert.rejects(auth.hashPassword('pw', { N: 8, r: 1, p: 1, keylen: 32 }), { code: 'BAD_KDF' });
  await assert.rejects(auth.hashPassword(''), { code: 'BAD_PASSWORD_INPUT' });
});

test('decodeB64 is strict', () => {
  assert.ok(auth.decodeB64(Buffer.alloc(32, 7).toString('base64'), 32, 32));
  assert.equal(auth.decodeB64('AAAA', 4, 8), null); // 3 bytes < min
  assert.equal(auth.decodeB64('AAA=', 1, 8).length, 2);
  assert.equal(auth.decodeB64('AAB=', 1, 8), null); // non-canonical padding bits
  assert.equal(auth.decodeB64('AA-_', 1, 8), null); // base64url not accepted
  assert.equal(auth.decodeB64('AAAA\n', 1, 8), null);
  assert.equal(auth.decodeB64('AAA', 1, 8), null);
});

test('FailureLimiter: locks after max failures in the window, unlocks after lockMs', () => {
  let now = 1_000_000;
  const lim = new auth.FailureLimiter({ max: 3, windowMs: 1000, lockMs: 5000, now: () => now });
  assert.equal(lim.isLocked('a'), false);
  assert.equal(lim.fail('a'), false);
  assert.equal(lim.remaining('a'), 2);
  now += 2000; // first failure leaves the window
  assert.equal(lim.fail('a'), false);
  assert.equal(lim.fail('a'), false);
  assert.equal(lim.isLocked('a'), false);
  assert.equal(lim.fail('a'), true); // 3 within the window → locked
  assert.equal(lim.isLocked('a'), true);
  assert.equal(lim.isLocked('b'), false, 'keys are independent');
  assert.equal(lim.fail('a'), true, 'still locked');
  now += 4999;
  assert.equal(lim.isLocked('a'), true);
  now += 2;
  assert.equal(lim.isLocked('a'), false, 'lock expired');
  assert.equal(lim.remaining('a'), 3);
  lim.fail('a');
  lim.reset('a');
  assert.equal(lim.remaining('a'), 3);
});

test('FailureLimiter: defaults per contract (10 / 15 min / 15 min) and bounded memory', () => {
  let now = 0;
  const lim = new auth.FailureLimiter({ now: () => now, maxEntries: 16 });
  for (let i = 0; i < 9; i++) assert.equal(lim.fail('ip'), false);
  assert.equal(lim.fail('ip'), true);
  now += 15 * 60e3 - 1;
  assert.equal(lim.isLocked('ip'), true);
  now += 2;
  assert.equal(lim.isLocked('ip'), false);
  for (let i = 0; i < 100; i++) lim.fail(`k${i}`);
  assert.ok(lim._map.size <= 16);
});
