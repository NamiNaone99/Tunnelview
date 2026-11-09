'use strict';
/* node --test test/pairing.test.js — src/main/pairing.js (pure: the pairing link, the signed hello,
 * pair proofs, fingerprints) and the protocol constants it adds; then the host side: the real
 * HostServer with the fake tailscale over 127.0.0.1 (hello.ident, the client-nonce header, offers,
 * `pair`, /info features), driven by the Node phone simulator in test/support/phone-sim.js. Where
 * a test needs another node, 127.0.0.1 is made that node by whois (remoteFrom), so no loopback
 * alias is needed and macOS runs every test. test/vectors/{ident,pair,links,fingerprint}.json pin
 * the pure functions for the phone. No real Tailscale, no OS input; sessions grant no permission. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const vm = require('vm');
const crypto = require('crypto');
const WebSocket = require('ws');

const P = require('../src/shared/protocol');
const pairing = require('../src/main/pairing');
const auth = require('../src/main/auth');
const HostServer = require('../src/main/host-server');
const ViewerSession = require('../src/main/viewer-client');
const { createIdentity } = require('../src/main/identity');
const { SELF_ID, SELF_LOGIN, FakeTailscale, FakeSettings, viewerTs } = require('./support/fake-tailscale');
const { PhoneSim, newClientNonce } = require('./support/phone-sim');

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const keyFromSeed = (byte) => {
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.alloc(32, byte)]), format: 'der', type: 'pkcs8' });
  return { privateKey, pub: crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(12) };
};
const HOST = keyFromSeed(0x21);
const OTHER = keyFromSeed(0x42);
const NONCE = Buffer.alloc(32, 0x11).toString('base64');
const CNONCE = Buffer.alloc(32, 0x22).toString('base64');
const CNONCE_2 = Buffer.alloc(32, 0x33).toString('base64');
const HOST_ID = 'nHOSTabc123CNTRL';
const PHONE_ID = 'nPHONEp1x2CNTRL';
const RELAY_ID = 'nMALLORYm1CNTRL';
const TOKEN = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const b64url = (b) => Buffer.from(b).toString('base64url');

/** A signed hello as host-server will send it (fields beyond auth.nonce and ident are irrelevant here). */
function signedHello(key, { nonce = NONCE, cnonce = CNONCE, hostId = HOST_ID, viewerId = PHONE_ID } = {}) {
  const sig = crypto.sign(null, pairing.identBytes(nonce, cnonce, hostId, viewerId), key.privateKey).toString('base64');
  return { t: 'hello', protocol: 2, app: 'Tunnelview', auth: { nonce }, ident: { v: 1, alg: 'ed25519', hostId, viewerId, cnonce, sig } };
}

const LINK = {
  v: 1, id: HOST_ID, n: 'office-pc.tail1234.ts.net', a: ['100.101.102.103', 'fd7a:115c:a1e0::1234:5678'],
  p: 47800, k: b64url(HOST.pub), t: b64url(TOKEN), x: 1762520000,
};
/** A link with LINK's keys in order but any values, written without encodeLink's checks. */
const rawLink = (obj) => P.PAIR.LINK_PREFIX + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
const linkWith = (patch) => rawLink({ ...LINK, ...patch });

/* --------------------------------------------------------------------------------------------- */

test('protocol: pairing constants added, protocol version and deny reasons unchanged', () => {
  assert.equal(P.PROTOCOL_VERSION, 2);
  assert.equal(P.CLIENT_NONCE_HEADER, 'x-tunnelview-client-nonce');
  assert.equal(P.CLIENT_NONCE_HEADER, P.CLIENT_NONCE_HEADER.toLowerCase(), 'Node lower-cases incoming header names');
  assert.equal(P.CLIENT_NONCE_BYTES, 32);
  assert.deepEqual({ ...P.IDENT }, { CONTEXT: 'Tunnelview-hello-v1|', ALG: 'ed25519', VERSION: 1 });
  assert.deepEqual({ ...P.PAIR }, {
    CONTEXT: 'Tunnelview-pair-v1|', TTL_MS: 120000, TOKEN_BYTES: 16, LINK_PREFIX: 'tunnelview://pair/1/',
    LINK_VERSION: 1, MAX_FAILURES: 3, FAILED: 'failed',
  });
  assert.equal(P.MSG.PAIR, 'pair');
  assert.equal(P.MSG.PAIR_RESULT, 'pair-result');
  assert.deepEqual([...P.INFO_FEATURES], ['ident-v1', 'pair-v1']);
  for (const o of [P, P.MSG, P.IDENT, P.PAIR, P.INFO_FEATURES]) assert.ok(Object.isFrozen(o));
  // The pair-result reason is not a deny reason: ARCHITECTURE §4 lists DENY exactly (CRITIQUE N11).
  assert.ok(!Object.values(P.DENY).includes(P.PAIR.FAILED));
  assert.equal(P.AUTH.CONTEXT, 'Tunnelview-auth-v2|');
});

test('protocol.js still loads as the renderer\'s classic script (window.TunnelviewProtocol)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared', 'protocol.js'), 'utf8');
  const sandbox = {};
  sandbox.self = sandbox; // a page has `self`, and neither `module` nor `require`
  vm.runInNewContext(src, sandbox, { filename: 'protocol.js' });
  const R = sandbox.TunnelviewProtocol;
  assert.ok(R, 'the global is set');
  assert.equal(JSON.stringify(R), JSON.stringify(P), 'the same constants as the CommonJS export');
  assert.equal(R.PAIR.LINK_PREFIX, 'tunnelview://pair/1/');
});

test('validCnonce: canonical base64 of exactly 32 bytes', () => {
  assert.equal(pairing.validCnonce(CNONCE), true);
  assert.equal(pairing.validCnonce(crypto.randomBytes(32).toString('base64')), true);
  for (const bad of [
    CNONCE.slice(0, -1), `${CNONCE}=`, ` ${CNONCE}`, `${CNONCE}\n`, CNONCE.replace(/=$/, 'A'),
    Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), Buffer.alloc(16).toString('base64'),
    b64url(Buffer.alloc(32, 0xfb)), `${'A'.repeat(42)}B=`, '', null, undefined, 42, Buffer.alloc(32),
  ]) {
    assert.equal(pairing.validCnonce(bad), false, String(bad));
  }
});

test('identBytes: the exact text that is signed; bad fields refused in argument order', () => {
  assert.equal(
    pairing.identBytes(NONCE, CNONCE, HOST_ID, PHONE_ID).toString('utf8'),
    `Tunnelview-hello-v1|${NONCE}|${CNONCE}|${HOST_ID}|${PHONE_ID}`,
  );
  assert.equal(pairing.identBytes(NONCE, null, '12', '7').toString('utf8'), `Tunnelview-hello-v1|${NONCE}||12|7`);
  assert.ok(Buffer.isBuffer(pairing.identBytes(NONCE, undefined, HOST_ID, PHONE_ID)));
  const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
  assert.equal(code(() => pairing.identBytes('nope', CNONCE, HOST_ID, PHONE_ID)), 'BAD_NONCE');
  assert.equal(code(() => pairing.identBytes(b64url(Buffer.alloc(32, 0xfb)), CNONCE, HOST_ID, PHONE_ID)), 'BAD_NONCE');
  assert.equal(code(() => pairing.identBytes(NONCE, '', HOST_ID, PHONE_ID)), 'BAD_CNONCE');
  assert.equal(code(() => pairing.identBytes(NONCE, CNONCE.slice(1), HOST_ID, PHONE_ID)), 'BAD_CNONCE');
  assert.equal(code(() => pairing.identBytes(NONCE, CNONCE, 'a|b', PHONE_ID)), 'BAD_BINDING');
  assert.equal(code(() => pairing.identBytes(NONCE, CNONCE, HOST_ID, 'x'.repeat(65))), 'BAD_BINDING');
  assert.equal(code(() => pairing.identBytes('nope', 'nope', 'a|b', '')), 'BAD_NONCE');
  assert.equal(code(() => pairing.identBytes(NONCE, 'nope', 'a|b', '')), 'BAD_CNONCE');
});

test('verifyIdent: a hello signed by the pinned key for this connection passes', () => {
  const hello = signedHello(HOST);
  assert.deepEqual(
    pairing.verifyIdent(HOST.pub, hello, { cnonce: CNONCE, hostId: HOST_ID, viewerId: PHONE_ID }),
    { ok: true, reason: null, hostId: HOST_ID, viewerId: PHONE_ID, cnonce: CNONCE },
  );
  assert.equal(pairing.verifyIdent(new Uint8Array(HOST.pub), hello).ok, true, 'any Uint8Array key');
  // A desktop viewer sends no client nonce: the host signs an empty field and echoes null.
  const desktop = signedHello(HOST, { cnonce: null, viewerId: 'nDESKTOP1' });
  assert.equal(desktop.ident.cnonce, null);
  assert.deepEqual(pairing.verifyIdent(HOST.pub, desktop, { cnonce: null, hostId: HOST_ID }).ok, true);
});

test('verifyIdent: each refusal has its reason, in the order a phone acts on them', () => {
  const expect = { cnonce: CNONCE, hostId: HOST_ID, viewerId: PHONE_ID };
  const reason = (pub, hello, e = expect) => pairing.verifyIdent(pub, hello, e).reason;
  const good = signedHello(HOST);
  const withIdent = (patch) => ({ ...good, ident: { ...good.ident, ...patch } });

  assert.equal(reason(HOST.pub, { ...good, ident: undefined }), 'no-ident', 'a host older than identities');
  assert.equal(reason(HOST.pub, { ...good, ident: null }), 'no-ident');
  for (const hello of [null, 'hello', [], 42, { ...good, auth: null }, { ...good, auth: { nonce: 'short' } }]) {
    assert.equal(reason(HOST.pub, hello), 'malformed', JSON.stringify(hello).slice(0, 60));
  }
  for (const patch of [
    { v: 2 }, { v: '1' }, { alg: 'ed448' }, { alg: undefined }, { sig: undefined }, { sig: good.ident.sig.slice(0, -4) },
    { sig: b64url(Buffer.from(good.ident.sig, 'base64')) }, { cnonce: undefined }, { cnonce: '' },
    { cnonce: Buffer.alloc(31).toString('base64') }, { hostId: 'a|b' }, { viewerId: '' }, { hostId: 7 },
  ]) {
    assert.equal(reason(HOST.pub, withIdent(patch)), 'malformed', JSON.stringify(patch));
  }
  assert.equal(reason(HOST.pub, { ...good, ident: 'signed' }), 'malformed');

  const flipped = Buffer.from(good.ident.sig, 'base64');
  flipped[40] ^= 0x80;
  assert.equal(reason(OTHER.pub, good), 'bad-signature', 'another computer\'s key');
  assert.equal(reason(HOST.pub, withIdent({ sig: flipped.toString('base64') })), 'bad-signature');
  assert.equal(reason(HOST.pub, withIdent({ viewerId: RELAY_ID })), 'bad-signature', 'a signed field changed afterwards');
  assert.equal(reason(HOST.pub, withIdent({ cnonce: null })), 'bad-signature');
  assert.equal(reason(HOST.pub, { ...good, auth: { nonce: Buffer.alloc(32, 9).toString('base64') } }), 'bad-signature');

  // Authentic signatures that were made for something else.
  assert.equal(reason(HOST.pub, signedHello(HOST, { cnonce: CNONCE_2 })), 'cnonce-mismatch', 'replayed from another connection');
  assert.equal(reason(HOST.pub, signedHello(HOST, { hostId: 'nOTHERhost1' })), 'host-mismatch');
  assert.equal(reason(HOST.pub, signedHello(HOST, { cnonce: CNONCE_2, viewerId: RELAY_ID })), 'cnonce-mismatch', 'first mismatch wins');
  assert.equal(reason(OTHER.pub, signedHello(HOST, { cnonce: CNONCE_2 })), 'bad-signature', 'the signature is checked before any mismatch');
});

test('verifyIdent: a relay forwarding the phone\'s client nonce is caught by viewerId', () => {
  // Phone P dials what it thinks is host H, but reaches tailnet node M, which opens its own
  // connection to H and forwards P's client nonce. H signs honestly: it sees M as the viewer.
  const relayed = signedHello(HOST, { viewerId: RELAY_ID });
  const atPhone = pairing.verifyIdent(HOST.pub, relayed, { cnonce: CNONCE, hostId: HOST_ID, viewerId: PHONE_ID });
  assert.deepEqual(atPhone, { ok: false, reason: 'viewer-mismatch' });
  // Without the viewerId expectation the relay would pass: the phone must always pin its own ID.
  assert.equal(pairing.verifyIdent(HOST.pub, relayed, { cnonce: CNONCE, hostId: HOST_ID }).ok, true);
});

test('verifyIdent: a wrong-size key is a caller error (BAD_KEY); a hostile hello never throws', () => {
  for (const key of [HOST.pub.subarray(0, 31), Buffer.concat([HOST.pub, Buffer.alloc(1)]), b64url(HOST.pub), null, undefined]) {
    assert.throws(() => pairing.verifyIdent(key, signedHello(HOST)), { code: 'BAD_KEY' });
  }
  const good = signedHello(HOST);
  const hostile = [
    { ident: { v: 1, alg: 'ed25519', hostId: HOST_ID, viewerId: PHONE_ID, cnonce: CNONCE, sig: 'A'.repeat(100000) }, auth: { nonce: NONCE } },
    { ident: { ...good.ident, hostId: { toString: 'x' } }, auth: good.auth },
    { ident: { ...good.ident, sig: ['x'] }, auth: good.auth },
    { ident: good.ident, auth: { nonce: { length: 44 } } },
    { ident: Object.create(null), auth: good.auth },
  ];
  for (const h of hostile) assert.equal(pairing.verifyIdent(HOST.pub, h).ok, false);
});

test('pair proofs: HMAC-SHA256(token, context|nonce|cnonce|hostId|viewerId), checked in constant time', () => {
  const message = `Tunnelview-pair-v1|${NONCE}|${CNONCE}|${HOST_ID}|${PHONE_ID}`;
  assert.equal(pairing.pairMessage(NONCE, CNONCE, HOST_ID, PHONE_ID), message);
  const proof = pairing.pairProof(TOKEN, NONCE, CNONCE, HOST_ID, PHONE_ID);
  assert.equal(proof, crypto.createHmac('sha256', TOKEN).update(message, 'utf8').digest('base64'));
  assert.equal(pairing.verifyPairProof(TOKEN, proof, NONCE, CNONCE, HOST_ID, PHONE_ID), true);
  assert.equal(pairing.verifyPairProof(new Uint8Array(TOKEN), proof, NONCE, CNONCE, HOST_ID, PHONE_ID), true);

  const no = (...args) => assert.equal(pairing.verifyPairProof(...args), false, JSON.stringify(args.slice(1)).slice(0, 90));
  no(Buffer.alloc(16, 9), proof, NONCE, CNONCE, HOST_ID, PHONE_ID); // another offer's token
  no(TOKEN, proof, NONCE, CNONCE, HOST_ID, RELAY_ID); // relayed: whois says the relay is the viewer
  no(TOKEN, proof, NONCE, CNONCE, PHONE_ID, HOST_ID);
  no(TOKEN, proof, NONCE, CNONCE_2, HOST_ID, PHONE_ID);
  no(TOKEN, proof, Buffer.alloc(32, 5).toString('base64'), CNONCE, HOST_ID, PHONE_ID);
  no(TOKEN, proof, NONCE, null, HOST_ID, PHONE_ID); // pairing always has a client nonce
  no(TOKEN, proof.replace(/=$/, ''), NONCE, CNONCE, HOST_ID, PHONE_ID);
  no(TOKEN, `${proof} `, NONCE, CNONCE, HOST_ID, PHONE_ID);
  no(TOKEN, Buffer.from(proof, 'base64').toString('hex'), NONCE, CNONCE, HOST_ID, PHONE_ID);
  for (const junk of ['', null, undefined, 42, {}, Buffer.from(proof, 'base64')]) no(TOKEN, junk, NONCE, CNONCE, HOST_ID, PHONE_ID);
  for (const tok of [TOKEN.subarray(0, 15), Buffer.alloc(17), TOKEN.toString('hex'), null]) no(tok, proof, NONCE, CNONCE, HOST_ID, PHONE_ID);

  assert.throws(() => pairing.pairMessage(NONCE, null, HOST_ID, PHONE_ID), { code: 'BAD_CNONCE' });
  assert.throws(() => pairing.pairProof(TOKEN.subarray(1), NONCE, CNONCE, HOST_ID, PHONE_ID), { code: 'BAD_TOKEN' });
  assert.throws(() => pairing.pairProof(b64url(TOKEN), NONCE, CNONCE, HOST_ID, PHONE_ID), { code: 'BAD_TOKEN' });
  assert.throws(() => pairing.pairProof(TOKEN, NONCE, CNONCE, HOST_ID, 'a b'), { code: 'BAD_BINDING' });
});

test('links: encodeLink → parseLink round trip; one canonical spelling, keys in order', () => {
  const link = pairing.encodeLink(LINK);
  assert.ok(link.startsWith('tunnelview://pair/1/'));
  assert.match(link.slice(20), /^[A-Za-z0-9_-]+$/, 'base64url without padding');
  assert.deepEqual(pairing.parseLink(link), LINK);
  const json = Buffer.from(link.slice(20), 'base64url').toString('utf8');
  assert.deepEqual(Object.keys(JSON.parse(json)), ['v', 'id', 'n', 'a', 'p', 'k', 't', 'x']);
  assert.equal(json, JSON.stringify(LINK));
  // Input key order does not matter; the output is the same text.
  assert.equal(pairing.encodeLink(Object.fromEntries(Object.entries(LINK).reverse())), link);
  // parseLink returns a fresh object.
  const parsed = pairing.parseLink(link);
  parsed.a.push('x');
  assert.deepEqual(pairing.parseLink(link).a, LINK.a);

  for (const ok of [
    { ...LINK, n: '', a: ['100.64.0.1'] },
    { ...LINK, a: ['fd7a:115c:a1e0::1'] },
    { ...LINK, id: '12', p: 1024, x: 1 },
    { ...LINK, p: 65535, x: Number.MAX_SAFE_INTEGER },
    { ...LINK, n: 'xn--caf-dma.office-pc' },
  ]) {
    assert.deepEqual(pairing.parseLink(pairing.encodeLink(ok)), ok, JSON.stringify(ok).slice(0, 80));
  }
});

test('links: the longest valid link stays under LINK_MAX_LENGTH', () => {
  const label = (n, ch) => ch.repeat(n);
  const worst = {
    v: 1, id: `n${'A'.repeat(63)}`, n: [label(63, 'a'), label(63, 'b'), label(63, 'c'), label(61, 'd')].join('.'),
    a: ['100.127.255.255', 'fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff'], p: 65535, k: b64url(HOST.pub), t: b64url(TOKEN),
    x: Number.MAX_SAFE_INTEGER,
  };
  assert.equal(worst.n.length, 253);
  const link = pairing.encodeLink(worst);
  assert.ok(link.length < pairing.LINK_MAX_LENGTH, `${link.length}`);
  assert.deepEqual(pairing.parseLink(link), worst);
});

test('links: strict parse refuses every malformed or non-canonical link with a reason', () => {
  const link = pairing.encodeLink(LINK);
  const json = JSON.stringify(LINK);
  const without = (key) => { const o = { ...LINK }; delete o[key]; return rawLink(o); };
  const cases = [
    // shape of the text
    [42, 'LINK_FORMAT'], [null, 'LINK_FORMAT'], ['', 'LINK_FORMAT'],
    [link.replace('tunnelview:', 'TUNNELVIEW:'), 'LINK_FORMAT'],
    [link.replace('/pair/1/', '/pair/2/'), 'LINK_FORMAT'],
    [` ${link}`, 'LINK_FORMAT'],
    [`${P.PAIR.LINK_PREFIX}${'A'.repeat(1100)}`, 'LINK_FORMAT'],
    [`${link} `, 'LINK_ENCODING'], [`${link}\n`, 'LINK_ENCODING'], [`${link}=`, 'LINK_ENCODING'],
    [P.PAIR.LINK_PREFIX, 'LINK_ENCODING'],
    [P.PAIR.LINK_PREFIX + Buffer.from(json).toString('base64').replace(/=+$/, '') + '+/', 'LINK_ENCODING'],
    // the JSON
    [rawLink([1]), 'LINK_JSON'], [rawLink('x'), 'LINK_JSON'],
    [P.PAIR.LINK_PREFIX + Buffer.from('{"v":1').toString('base64url'), 'LINK_JSON'],
    [P.PAIR.LINK_PREFIX + Buffer.from([0x7b, 0xc3, 0x28, 0x7d]).toString('base64url'), 'LINK_JSON'],
    [linkWith({ v: 2 }), 'LINK_VERSION'], [without('v'), 'LINK_VERSION'],
    [linkWith({ extra: true }), 'LINK_FIELDS'], [without('t'), 'LINK_FIELDS'],
    // fields
    [linkWith({ id: '' }), 'LINK_ID'], [linkWith({ id: 'a|b' }), 'LINK_ID'], [linkWith({ id: 'x'.repeat(65) }), 'LINK_ID'],
    [linkWith({ n: 'Office-PC.tail1234.ts.net' }), 'LINK_NAME'],
    [linkWith({ n: 'office-pc.tail1234.ts.net.' }), 'LINK_NAME'],
    [linkWith({ n: 'office pc.ts.net' }), 'LINK_NAME'],
    [linkWith({ n: `office-pc.${'a'.repeat(64)}.ts.net` }), 'LINK_NAME'],
    [linkWith({ n: 'a.'.repeat(126) + 'ab' }), 'LINK_NAME'], // 254 characters
    [linkWith({ n: `caf${String.fromCharCode(0xe9)}.ts.net` }), 'LINK_NAME'],
    [linkWith({ n: 42 }), 'LINK_NAME'],
    [linkWith({ a: ['100.64.0.1', 'fd7a:115c:a1e0::1', 'fd7a:115c:a1e0::2'] }), 'LINK_ADDRESS'],
    [linkWith({ a: ['100.64.0.1', '100.64.0.2'] }), 'LINK_ADDRESS'],
    [linkWith({ a: ['fd7a:115c:a1e0::1', 'fd7a:115c:a1e0::2'] }), 'LINK_ADDRESS'],
    [linkWith({ a: ['fd7a:115c:a1e0::1', '100.64.0.1'] }), 'LINK_ADDRESS'],
    [linkWith({ a: ['192.168.1.20'] }), 'LINK_ADDRESS'],
    [linkWith({ a: ['100.128.0.1'] }), 'LINK_ADDRESS'],
    [linkWith({ a: ['FD7A:115C:A1E0::1'] }), 'LINK_ADDRESS'],
    [linkWith({ a: ['::ffff:100.64.0.1'] }), 'LINK_ADDRESS'],
    [linkWith({ a: ['100.64.0.01'] }), 'LINK_ADDRESS'],
    [linkWith({ a: [] }), 'LINK_ADDRESS'], [linkWith({ a: '100.64.0.1' }), 'LINK_ADDRESS'],
    [linkWith({ p: 1023 }), 'LINK_PORT'], [linkWith({ p: 65536 }), 'LINK_PORT'], [linkWith({ p: '47800' }), 'LINK_PORT'], [linkWith({ p: 47800.5 }), 'LINK_PORT'],
    [linkWith({ k: b64url(HOST.pub.subarray(1)) }), 'LINK_KEY'], [linkWith({ k: `${b64url(HOST.pub)}=` }), 'LINK_KEY'],
    [linkWith({ k: HOST.pub.toString('base64') }), 'LINK_KEY'],
    [linkWith({ t: b64url(Buffer.alloc(15)) }), 'LINK_TOKEN'], [linkWith({ t: b64url(Buffer.alloc(17)) }), 'LINK_TOKEN'],
    [linkWith({ t: `${b64url(TOKEN)}==` }), 'LINK_TOKEN'],
    [linkWith({ x: 0 }), 'LINK_EXPIRY'], [linkWith({ x: 1.5 }), 'LINK_EXPIRY'], [linkWith({ x: '1762520000' }), 'LINK_EXPIRY'],
    // valid values, but not the one canonical spelling
    [P.PAIR.LINK_PREFIX + Buffer.from(JSON.stringify(LINK, null, 2)).toString('base64url'), 'LINK_NONCANONICAL'],
    [P.PAIR.LINK_PREFIX + Buffer.from(json.replace('"p":47800', '"p":47800,"p":47800')).toString('base64url'), 'LINK_NONCANONICAL'],
    [P.PAIR.LINK_PREFIX + Buffer.from(json.replace('"p":47800', '"p":4.78e4')).toString('base64url'), 'LINK_NONCANONICAL'],
    [P.PAIR.LINK_PREFIX + Buffer.from(json.replace('office', 'offic\\u0065')).toString('base64url'), 'LINK_NONCANONICAL'],
    [rawLink(Object.fromEntries(Object.entries(LINK).sort())), 'LINK_NONCANONICAL'],
  ];
  for (const [text, code] of cases) {
    assert.throws(() => pairing.parseLink(text), { code }, `${code}: ${String(text).slice(0, 120)}`);
  }
});

test('links: random damage never yields anything but a LINK_* refusal or the canonical link itself', () => {
  const link = pairing.encodeLink(LINK);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_=+/ .';
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let i = 0; i < 3000; i++) {
    const chars = [...link];
    for (let j = 1 + rand(3); j > 0; j--) {
      const at = rand(chars.length);
      const op = rand(3);
      if (op === 0) chars[at] = alphabet[rand(alphabet.length)];
      else if (op === 1) chars.splice(at, 1);
      else chars.splice(at, 0, alphabet[rand(alphabet.length)]);
    }
    const text = chars.join('');
    let parsed;
    try {
      parsed = pairing.parseLink(text);
    } catch (e) {
      assert.match(String(e.code), /^LINK_[A-Z]+$/, text);
      continue;
    }
    assert.equal(pairing.encodeLink(parsed), text, 'an accepted text is the canonical spelling');
  }
});

test('encodeLink refuses what parseLink would refuse', () => {
  const cases = [
    [null, 'LINK_JSON'], [[], 'LINK_JSON'], ['x', 'LINK_JSON'],
    [{ ...LINK, v: 2 }, 'LINK_VERSION'], [{ ...LINK, extra: 1 }, 'LINK_FIELDS'],
    [{ ...LINK, a: ['10.0.0.1'] }, 'LINK_ADDRESS'], [{ ...LINK, n: 'A.ts.net' }, 'LINK_NAME'],
    [{ ...LINK, k: Buffer.from(HOST.pub) }, 'LINK_KEY'], [{ ...LINK, x: -5 }, 'LINK_EXPIRY'],
  ];
  for (const [obj, code] of cases) assert.throws(() => pairing.encodeLink(obj), { code }, JSON.stringify(obj).slice(0, 80));
});

test('fingerprint: TV- and 20 base32 characters of SHA-256(pub) in groups of 4', () => {
  // RFC 8032 7.1 TEST 1 public key: a fixed, published input.
  const rfcPub = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex');
  assert.equal(pairing.fingerprint(rfcPub), 'TV-EH7D-DX5B-KSRG-CYTL-7BKA');
  const digest = crypto.createHash('sha256').update(rfcPub).digest();
  assert.equal(pairing.base32(digest).slice(0, 20), 'EH7DDX5BKSRGCYTL7BKA');
  for (const key of [HOST.pub, OTHER.pub, Buffer.alloc(32), crypto.randomBytes(32)]) {
    assert.match(pairing.fingerprint(key), /^TV-[A-Z2-7]{4}(?:-[A-Z2-7]{4}){4}$/);
  }
  assert.notEqual(pairing.fingerprint(HOST.pub), pairing.fingerprint(OTHER.pub));
  for (const bad of [Buffer.alloc(31), Buffer.alloc(33), b64url(HOST.pub), null]) {
    assert.throws(() => pairing.fingerprint(bad), { code: 'BAD_KEY' });
  }
});

test('base32 / decodeB64url: RFC 4648 encodings, strict decoding', () => {
  const vectors = { '': '', f: 'MY', fo: 'MZXQ', foo: 'MZXW6', foob: 'MZXW6YQ', fooba: 'MZXW6YTB', foobar: 'MZXW6YTBOI' };
  for (const [plain, enc] of Object.entries(vectors)) assert.equal(pairing.base32(Buffer.from(plain)), enc, plain);
  const key = b64url(HOST.pub);
  assert.ok(pairing.decodeB64url(key, 32).equals(HOST.pub));
  assert.equal(pairing.decodeB64url(key, 31), null);
  // 43 characters carry 258 bits: flipping the lowest bit of the last one only sets an unused bit.
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const unusedBitSet = key.slice(0, -1) + ALPHABET[ALPHABET.indexOf(key.at(-1)) ^ 1];
  assert.ok(Buffer.from(unusedBitSet, 'base64url').equals(HOST.pub), 'Buffer itself would accept it');
  for (const bad of [unusedBitSet, `${key}=`, `${key} `, key.replace(/.$/, '+'), HOST.pub.toString('base64'), 42, null]) {
    assert.equal(pairing.decodeB64url(bad, 32), null, String(bad));
  }
  assert.equal(pairing.decodeB64url('A'), null, 'a length that leaves 6 bits');
});

/* ===================================================================== host side (HostServer) */

const VH = { [P.PROTOCOL_HEADER]: String(P.PROTOCOL_VERSION) };
// The test host listens on loopback; a link may only carry Tailscale addresses (host._linkAddress).
const LINK_V4 = '100.64.0.1';
const PHONE = {
  node: { id: '11', stableId: 'nPHONE0001CNTRL', name: 'pixel-8.example.ts.net', hostname: 'Pixel 8', os: 'android', ips: ['127.0.0.1'], tags: [] },
  user: { id: '1001', login: SELF_LOGIN, displayName: 'Alice' },
  isSelf: false,
};
const MALLORY = {
  node: { id: '9', stableId: 'nMALLORY0CNTRL', name: 'mallory-pc.example.ts.net', hostname: 'mallory-pc', os: 'windows', ips: ['127.0.0.1'], tags: [] },
  user: { id: '7', login: 'mallory@example.com', displayName: 'Mallory' },
  isSelf: false,
};
const NO_PERMISSIONS = { control: false, clipboard: false, files: false, audio: false };
const FAILED = { t: 'pair-result', ok: false, reason: 'failed' };

/** identity.js's interface over a fixed key (HOST unless given). */
function fakeIdentity(key = HOST, { unavailable = false } = {}) {
  return {
    unavailable,
    error: unavailable ? 'CORRUPT' : null,
    wasReset: false,
    publicKeyRaw: () => (unavailable ? null : Buffer.from(key.pub)),
    publicKeyB64url: () => (unavailable ? null : b64url(key.pub)),
    fingerprint: () => (unavailable ? null : pairing.fingerprint(key.pub)),
    sign(bytes) {
      if (unavailable) throw Object.assign(new Error('unavailable'), { code: 'IDENTITY_UNAVAILABLE' });
      return crypto.sign(null, bytes, key.privateKey);
    },
  };
}

async function startPairHost(t, { identity = fakeIdentity(), settings = {}, ts = new FakeTailscale() } = {}) {
  const s = new FakeSettings(settings);
  const host = new HostServer({ tailscale: ts, settings: s, auth, appVersion: '0.3.0-test', osName: 'windows', identity });
  host._linkAddress = (ip) => (ip === '127.0.0.1' ? LINK_V4 : ip);
  await host.start();
  t.after(() => host.stop());
  const st = host.status();
  assert.equal(st.listening, true, `host not listening: ${st.error}`);
  const events = [];
  host.on('pairing', (e) => events.push(e));
  return { host, ts, settings: s, port: st.port, events };
}

/** Raw client. Resolves {status} for an HTTP refusal, else {ws, msgs, closed, next(t), send(o)}. */
function rawWs(port, { cnonce, headers = VH, localAddress } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const hdrs = { ...headers };
    if (cnonce !== undefined) hdrs[P.CLIENT_NONCE_HEADER] = cnonce;
    const ws = new WebSocket(`ws://127.0.0.1:${port}${P.WS_PATH}`, { headers: hdrs, localAddress, perMessageDeflate: false });
    const msgs = [];
    const closed = new Promise((r) => ws.on('close', (code) => r(code)));
    ws.on('message', (d) => msgs.push(JSON.parse(String(d))));
    const next = async (type, timeout = 3000) => {
      const end = Date.now() + timeout;
      for (;;) {
        const m = msgs.find((x) => x.t === type);
        if (m) return m;
        if (Date.now() > end || ws.readyState > WebSocket.OPEN) return null;
        await new Promise((r) => setTimeout(r, 10));
      }
    };
    ws.on('open', () => finish({ ws, msgs, closed, next, send: (o) => ws.send(JSON.stringify(o)) }));
    ws.on('unexpected-response', (_req, res) => { finish({ status: res.statusCode }); ws.terminate(); });
    ws.on('error', (error) => finish({ error }));
  });
}

function getInfo(port) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: P.INFO_PATH }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const linkOf = (offer) => pairing.parseLink(offer.link);
const tokenOf = (offer) => pairing.decodeB64url(linkOf(offer).t, P.PAIR.TOKEN_BYTES);
/** The proof a phone holding `offer` computes on this raw connection (it learns viewerId from ident). */
const proofFor = (offer, hello, cnonce) => pairing.pairProof(tokenOf(offer), hello.auth.nonce, cnonce, hello.ident.hostId, hello.ident.viewerId);
/** A phone whose every dial reaches the test host on 127.0.0.1 (PHONE once remoteFrom(ts) ran). */
const phoneVia = (port, extra = {}) => new PhoneSim({ dial: (_ip, p) => ({ host: '127.0.0.1', port: p || port }), ...extra });

/**
 * From now on a connection from 127.0.0.1 is `who` (another node, identified by whois), not this
 * node, like makeRemoteBob in signaling.test.js: macOS has no 127.0.0.2 source address, so these
 * tests must not need one. The host stays bound to 127.0.0.1 because no 'change' event is sent;
 * settings changes in between must be quiet for the same reason (a rebind would drop 127.0.0.1).
 * @returns {() => void} back to 127.0.0.1 = this node
 */
function remoteFrom(ts, who = PHONE) {
  ts.last.self.ips = ['127.0.0.9'];
  ts.whoisMap['127.0.0.1'] = structuredClone(who);
  return () => {
    ts.last.self.ips = ['127.0.0.1'];
    delete ts.whoisMap['127.0.0.1'];
  };
}

test('host: hello.ident is signed by the identity key and echoes the client nonce', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnelview-pairhost-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const identity = createIdentity({ file: path.join(dir, 'identity.json') });
  assert.equal(identity.load().ok, true);
  const { port } = await startPairHost(t, { identity });

  const cnonce = newClientNonce();
  const c = await rawWs(port, { cnonce });
  const hello = await c.next('hello');
  assert.deepEqual(Object.keys(hello.ident), ['v', 'alg', 'hostId', 'viewerId', 'cnonce', 'sig']);
  assert.equal(hello.ident.v, 1);
  assert.equal(hello.ident.alg, 'ed25519');
  assert.equal(hello.ident.hostId, SELF_ID);
  assert.equal(hello.ident.viewerId, SELF_ID, 'a self-connection: the viewer is this node');
  assert.equal(hello.ident.cnonce, cnonce, 'echoed');
  assert.equal(Buffer.from(hello.ident.sig, 'base64').length, 64);
  assert.deepEqual(
    pairing.verifyIdent(identity.publicKeyRaw(), hello, { cnonce, hostId: SELF_ID, viewerId: SELF_ID }),
    { ok: true, reason: null, hostId: SELF_ID, viewerId: SELF_ID, cnonce },
  );
  // Exactly the documented bytes.
  const signed = Buffer.from(`Tunnelview-hello-v1|${hello.auth.nonce}|${cnonce}|${SELF_ID}|${SELF_ID}`, 'utf8');
  const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), identity.publicKeyRaw()]), format: 'der', type: 'spki' });
  assert.equal(crypto.verify(null, signed, pub, Buffer.from(hello.ident.sig, 'base64')), true);
  // Another connection: another hello nonce, another client nonce, another signature.
  const c2 = await rawWs(port, { cnonce: newClientNonce() });
  const hello2 = await c2.next('hello');
  assert.notEqual(hello2.ident.sig, hello.ident.sig);
  assert.equal(pairing.verifyIdent(identity.publicKeyRaw(), hello2, { cnonce }).reason, 'cnonce-mismatch', 'not replayable onto another connection');
  c.ws.close();
  c2.ws.close();
});

test('host: without the header cnonce is null, and a desktop viewer is unaffected', async (t) => {
  const { host, ts, port } = await startPairHost(t);
  const c = await rawWs(port);
  const hello = await c.next('hello');
  assert.equal(hello.ident.cnonce, null);
  assert.equal(pairing.verifyIdent(HOST.pub, hello, { cnonce: null, hostId: SELF_ID, viewerId: SELF_ID }).ok, true);
  c.ws.close();

  // A desktop viewer ignores ident: prompt → accepted, as before (nothing granted).
  host.on('request', (req) => req.respond({ accept: true, permissions: NO_PERMISSIONS }));
  const vs = new ViewerSession({ tailscale: viewerTs(ts), auth, target: { ip: '127.0.0.1', port, peer: null }, password: null, self: { hostname: 'desk', os: 'windows', version: '0.2.0' } });
  t.after(() => vs.close('test-cleanup'));
  const accepted = new Promise((resolve) => vs.on('status', (s) => { if (s.phase === 'accepted') resolve(s); }));
  vs.connect();
  const acc = await accepted;
  assert.equal(acc.via, 'self');
  assert.deepEqual(acc.permissions, NO_PERMISSIONS);
  host.endSession('host-ended');
});

test('host: no ident and no features without a usable key; /info features with one', async (t) => {
  // Built without an identity (0.2 behaviour): no ident, no features field at all.
  const plain = new HostServer({ tailscale: new FakeTailscale(), settings: new FakeSettings(), auth, appVersion: '0.3.0-test', osName: 'windows' });
  plain._linkAddress = (ip) => (ip === '127.0.0.1' ? LINK_V4 : ip);
  await plain.start();
  t.after(() => plain.stop());
  const p0 = plain.status().port;
  const c0 = await rawWs(p0, { cnonce: newClientNonce() });
  assert.equal('ident' in (await c0.next('hello')), false);
  c0.ws.close();
  assert.equal('features' in (await getInfo(p0)).body, false);
  assert.throws(() => plain.startPairing(), { code: 'NO_IDENTITY' });

  // Key present but unusable (a damaged identity.json): no ident, features [].
  const broken = await startPairHost(t, { identity: fakeIdentity(HOST, { unavailable: true }) });
  const c1 = await rawWs(broken.port, { cnonce: newClientNonce() });
  assert.equal('ident' in (await c1.next('hello')), false);
  c1.ws.close();
  assert.deepEqual((await getInfo(broken.port)).body.features, []);
  assert.throws(() => broken.host.startPairing(), { code: 'NO_IDENTITY' });

  // A paired phone reaching that host is told its identity is unavailable (Retry / Reset on that
  // computer), not that it needs an update, and the pairing is not thrown away (no key mismatch).
  const phone = phoneVia(broken.port);
  t.after(() => phone.closeAll());
  const record = { hostId: SELF_ID, keyPub: b64url(HOST.pub), name: '', ips: [LINK_V4], port: broken.port, selfId: PHONE.node.stableId };
  assert.deepEqual(await phone.connect(record), { ok: false, reason: 'host-identity-unavailable' });
  assert.deepEqual(phone.sent, [], 'nothing sent');

  // Usable: both features, and the rest of /info as before.
  const good = await startPairHost(t);
  const info = (await getInfo(good.port)).body;
  assert.deepEqual(info.features, ['ident-v1', 'pair-v1']);
  assert.equal(info.app, 'Tunnelview');
  assert.equal(info.protocol, 2);
});

test('host: a malformed client nonce is refused with 400 before whois and before any slot', async (t) => {
  const { host, ts, port } = await startPairHost(t);
  // A full table of idle hellos from other nodes: a slot check would evict one of them.
  const sent = [];
  const fakes = [];
  for (let i = 0; i < 8; i++) {
    for (let j = 0; j < 2; j++) {
      const c = { id: `f${i}${j}`, ip: `127.0.2.${i}`, state: 'hello', closed: false, ident: { node: { stableId: `nIDLE${i}` } }, timer: null, killTimer: null };
      c.ws = { readyState: WebSocket.OPEN, send: (s) => sent.push([c.id, JSON.parse(s)]), close() {}, terminate() {}, ping() {} };
      fakes.push(c);
      host._conns.add(c);
    }
  }
  t.after(() => fakes.forEach((c) => { clearTimeout(c.killTimer); host._conns.delete(c); }));

  const cn = newClientNonce();
  const bad = [
    '', 'AAAA', cn.slice(0, -1), `${cn}=`, b64url(Buffer.alloc(32, 7)), Buffer.alloc(31, 7).toString('base64'),
    Buffer.alloc(33, 7).toString('base64'), `${cn}, ${cn}`, `${'A'.repeat(42)}B=`, `${cn.slice(0, -2)}#=`,
  ];
  // From another node (whois-identified).
  const asSelf = remoteFrom(ts);
  for (const value of bad) {
    assert.equal((await rawWs(port, { cnonce: value })).status, 400, JSON.stringify(value));
  }
  assert.equal(ts.whoisCalls, 0, 'whois never ran for a malformed header');
  assert.deepEqual(sent, [], 'nobody was evicted');
  // Self-connections too (no whois there anyway).
  asSelf();
  assert.equal((await rawWs(port, { cnonce: 'nope' })).status, 400);
  // The protocol header is still checked first: 426, not 400.
  assert.equal((await rawWs(port, { cnonce: 'nope', headers: {} })).status, 426);

  // A well-formed one goes on as before: whois, then a slot (the busiest idle node's oldest hello).
  remoteFrom(ts);
  const ok = await rawWs(port, { cnonce: cn });
  assert.ok(ok.ws);
  assert.equal((await ok.next('hello')).ident.cnonce, cn);
  assert.equal(ts.whoisCalls, 1);
  assert.deepEqual(sent, [['f00', { t: 'denied', reason: 'busy' }]]);
  ok.ws.close();
});

test('pair: success → paired event and pair-result with both IDs; consumed; the phone then connects verified', async (t) => {
  const { host, ts, port, events } = await startPairHost(t);
  remoteFrom(ts);
  const offer = host.startPairing();
  assert.match(offer.offerId, /^[0-9a-f-]{36}$/);
  assert.ok(Math.abs(offer.expiresAt - (Date.now() + P.PAIR.TTL_MS)) < 2000);
  const link = linkOf(offer);
  assert.deepEqual(link, {
    v: 1, id: SELF_ID, n: 'test-host.example.ts.net', a: [LINK_V4], p: port, k: b64url(HOST.pub),
    t: link.t, x: Math.floor(offer.expiresAt / 1000),
  });
  assert.equal(tokenOf(offer).length, 16);
  assert.deepEqual(offer.host, { id: SELF_ID, name: 'test-host.example.ts.net', ips: [LINK_V4], port });
  assert.deepEqual(host.pairingOffer, { offerId: offer.offerId, expiresAt: offer.expiresAt, failures: 0 });

  const confirmed = [];
  const phone = phoneVia(port, { confirm: (c) => { confirmed.push(c); return true; } });
  t.after(() => phone.closeAll());
  const r = await phone.pair(offer.link);
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(confirmed, [{ name: 'test-host.example.ts.net', address: LINK_V4, port, fingerprint: pairing.fingerprint(HOST.pub) }]);
  assert.deepEqual(r.record, { hostId: SELF_ID, keyPub: b64url(HOST.pub), name: 'test-host.example.ts.net', ips: [LINK_V4], port, selfId: PHONE.node.stableId });
  assert.deepEqual(r.seenAs, { name: 'pixel-8.example.ts.net', login: SELF_LOGIN });
  // On the wire: exactly one frame from the phone, the pair message.
  assert.equal(phone.sent.length, 1);
  assert.deepEqual(Object.keys(phone.sent[0]), ['t', 'proof', 'device']);
  const conn = phone.connections[0];
  assert.deepEqual(conn.frames.find((f) => f.t === 'pair-result'), {
    t: 'pair-result', ok: true, hostId: SELF_ID, viewerId: PHONE.node.stableId, peer: { name: 'pixel-8.example.ts.net', login: SELF_LOGIN },
  });
  assert.equal((await conn.closed).code, 1000, 'a normal close after success');
  assert.deepEqual(events, [{ offerId: offer.offerId, phase: 'paired', peer: { name: 'pixel-8.example.ts.net', login: SELF_LOGIN, os: 'android' } }]);
  assert.equal(host.pairingOffer, null, 'consumed');
  assert.equal(host.activeSession, null, 'a pair connection never becomes a session');

  // Single use: the same link again fails, uniformly, and reports nothing.
  const again = phoneVia(port);
  t.after(() => again.closeAll());
  assert.deepEqual(await again.pair(offer.link), { ok: false, reason: 'failed' });
  assert.deepEqual(again.connections[0].frames.find((f) => f.t === 'pair-result'), FAILED);
  assert.equal(events.length, 1);

  // Every later connection: verified before anything is sent, then the normal desktop flow.
  const requests = [];
  host.on('request', (req) => { requests.push(req); req.respond({ accept: false }); });
  const c = await phone.connect(r.record);
  assert.equal(c.ok, true, c.reason);
  assert.deepEqual(c.binding, { hostId: SELF_ID, viewerId: PHONE.node.stableId });
  c.conn.send({ t: 'request', protocol: 2, viewer: { hostname: 'pixel-8', os: 'android', version: '0.3.0' }, proof: null });
  const denied = await c.conn.next('denied');
  assert.equal(denied.reason, 'rejected');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].peer.stableId, PHONE.node.stableId);
  assert.equal(requests[0].peer.os, 'android');
});

test('pair: wrong proofs all get the same reply; the 3rd burns the offer and lists who tried', async (t) => {
  const { host, ts, port, events } = await startPairHost(t);
  remoteFrom(ts);
  const offer = host.startPairing();
  const attempt = async (proofOf) => {
    const cnonce = newClientNonce();
    const c = await rawWs(port, { cnonce });
    const hello = await c.next('hello');
    c.send({ t: 'pair', proof: proofOf(hello, cnonce), device: { name: 'x', os: 'android', version: '1' } });
    const reply = await c.next('pair-result');
    return { reply, code: await c.closed };
  };
  const wrongToken = (hello, cnonce) => pairing.pairProof(Buffer.alloc(16, 9), hello.auth.nonce, cnonce, SELF_ID, PHONE.node.stableId);
  assert.deepEqual(await attempt(wrongToken), { reply: FAILED, code: 4000 });
  assert.equal(host.pairingOffer.failures, 1);
  assert.deepEqual(await attempt(() => 42), { reply: FAILED, code: 4000 }, 'a malformed proof is a wrong proof');
  assert.ok(host.pairingOffer, 'two failures leave the offer live');
  // The right token, bound to another connection's nonces (a replayed proof).
  assert.deepEqual(await attempt((hello) => pairing.pairProof(tokenOf(offer), hello.auth.nonce, CNONCE, SELF_ID, PHONE.node.stableId)), { reply: FAILED, code: 4000 });
  assert.equal(host.pairingOffer, null, 'burnt by the 3rd wrong proof');
  const who = { name: 'pixel-8.example.ts.net', login: SELF_LOGIN, os: 'android' };
  assert.deepEqual(events, [
    { offerId: offer.offerId, phase: 'attempt-failed', peer: who },
    { offerId: offer.offerId, phase: 'attempt-failed', peer: who },
    { offerId: offer.offerId, phase: 'attempt-failed', peer: who },
    { offerId: offer.offerId, phase: 'failed', reason: 'too-many-attempts' },
  ]);
  // Now even the right proof gets the very same reply, and nothing is reported.
  assert.deepEqual(await attempt((hello, cnonce) => proofFor(offer, hello, cnonce)), { reply: FAILED, code: 4000 });
  assert.equal(events.length, 4);
});

test('pair: no offer, an expired offer and a self-connection get the same failed reply', async (t) => {
  const { host, ts, port, events } = await startPairHost(t);
  const wrongProof = () => crypto.randomBytes(32).toString('base64');
  const tryPair = async (offer) => {
    const cnonce = newClientNonce();
    const c = await rawWs(port, { cnonce });
    const hello = await c.next('hello');
    c.send({ t: 'pair', proof: offer ? proofFor(offer, hello, cnonce) : wrongProof(), device: {} });
    const reply = await c.next('pair-result');
    await c.closed;
    return reply;
  };

  // No offer at all.
  const asSelf = remoteFrom(ts);
  assert.deepEqual(await tryPair(null), FAILED);
  assert.deepEqual(events, []);

  // Self: never pairs, and the attempt does not count against the offer.
  const live = host.startPairing();
  asSelf();
  assert.deepEqual(await tryPair(live), FAILED);
  assert.equal(host.pairingOffer.failures, 0);
  assert.deepEqual(events, []);

  // Expired (clock moved past expiresAt): refused, and the offer is retired as 'expired'.
  remoteFrom(ts);
  const realNow = host._now;
  host._now = () => Date.now() + P.PAIR.TTL_MS + 1000;
  try {
    assert.deepEqual(await tryPair(live), FAILED);
  } finally {
    host._now = realNow;
  }
  assert.deepEqual(events, [{ offerId: live.offerId, phase: 'expired' }]);
  assert.equal(host.pairingOffer, null);

  // The expiry timer retires an offer by itself.
  host._pairTtlMs = 60;
  const short = host.startPairing();
  await tick(150);
  assert.deepEqual(events.at(-1), { offerId: short.offerId, phase: 'expired' });
  assert.equal(host.pairingOffer, null);
  // A phone checks the link's expiry itself before dialling.
  const late = new PhoneSim({ dial: () => { throw new Error('must not dial'); }, now: () => Date.now() + 1000 });
  assert.deepEqual(await late.pair(short.link), { ok: false, reason: 'expired' });
});

test('pair: only in state hello and only with a client nonce; otherwise ignored like other out-of-state frames', async (t) => {
  const { host, ts, port, events } = await startPairHost(t);
  remoteFrom(ts);
  const offer = host.startPairing();
  const requests = [];
  host.on('request', (req) => requests.push(req)); // leaves the prompt showing

  // A desktop-style connection (no client nonce): `pair` is ignored, the connection stays in hello.
  const plain = await rawWs(port);
  const ph = await plain.next('hello');
  plain.send({ t: 'pair', proof: pairing.pairProof(tokenOf(offer), ph.auth.nonce, CNONCE, SELF_ID, PHONE.node.stableId) });
  await tick(150);
  assert.deepEqual(plain.msgs.map((m) => m.t), ['hello'], 'no pair-result');
  assert.equal(plain.ws.readyState, WebSocket.OPEN);
  plain.send({ t: 'request', protocol: 2, viewer: { hostname: 'pc', os: 'windows', version: '0.2.0' }, proof: null });
  assert.ok(await plain.next('pending'), 'still in hello: the request is handled as usual');
  // Withdrawn by the viewer (no prompt back-off for this node, unlike a dismissal).
  plain.send({ t: 'bye', reason: 'viewer-closed' });
  await plain.closed;
  assert.equal(host.hasPending, false);

  // After `request` (prompt showing): a correct proof is ignored, the offer is untouched.
  const cnonce = newClientNonce();
  const c = await rawWs(port, { cnonce });
  const hello = await c.next('hello');
  c.send({ t: 'request', protocol: 2, viewer: { hostname: 'pixel-8', os: 'android', version: '0.3.0' }, proof: null });
  assert.ok(await c.next('pending'));
  c.send({ t: 'pair', proof: proofFor(offer, hello, cnonce), device: {} });
  await tick(150);
  assert.deepEqual(c.msgs.map((m) => m.t), ['hello', 'pending']);
  assert.equal(host.hasPending, true, 'the prompt is still showing');
  assert.deepEqual(host.pairingOffer, { offerId: offer.offerId, expiresAt: offer.expiresAt, failures: 0 });
  assert.deepEqual(events, []);
  requests[1].respond({ accept: false });
  await c.closed;
});

test('startPairing: refusals; the offer ends on cancel, replacement, session start, a new node ID and stop()', async (t) => {
  const { host, ts, settings, port, events } = await startPairHost(t);

  // Cancel: only the named offer (a closing dialog never cancels a newer one).
  const a = host.startPairing();
  assert.equal(host.cancelPairing('some-other-offer'), false);
  assert.equal(host.cancelPairing(a.offerId), true);
  assert.equal(host.cancelPairing(a.offerId), false);
  assert.deepEqual(events.splice(0), [{ offerId: a.offerId, phase: 'cancelled', reason: 'cancelled' }]);
  // Replaced by a new one; main's identity reset cancels whatever is live; unknown reasons are 'cancelled'.
  const b = host.startPairing();
  const c = host.startPairing();
  assert.notEqual(b.offerId, c.offerId);
  assert.notEqual(linkOf(b).t, linkOf(c).t, 'a fresh token every time');
  assert.equal(host.cancelPairing(null, 'identity-reset'), true);
  const d = host.startPairing();
  assert.equal(host.cancelPairing(undefined, 'nonsense'), true);
  assert.deepEqual(events.splice(0), [
    { offerId: b.offerId, phase: 'cancelled', reason: 'replaced' },
    { offerId: c.offerId, phase: 'cancelled', reason: 'identity-reset' },
    { offerId: d.offerId, phase: 'cancelled', reason: 'cancelled' },
  ]);

  // Our StableNodeID changes (signed in as someone else): the link names the old one.
  const e = host.startPairing();
  ts.last.self.stableId = 'nNEWSELF01';
  ts.emit('status', ts.last);
  assert.deepEqual(events.splice(0), [{ offerId: e.offerId, phase: 'cancelled', reason: 'host-id-changed' }]);
  assert.equal(linkOf(host.startPairing()).id, 'nNEWSELF01');
  host.cancelPairing();
  ts.last.self.stableId = SELF_ID;

  // A MagicDNS name the link format refuses is left out.
  ts.last.self.dnsName = 'Test_Host.example.ts.net';
  assert.equal(linkOf(host.startPairing()).n, '');
  ts.last.self.dnsName = 'test-host.example.ts.net';
  host.cancelPairing();
  events.length = 0;

  // No Tailscale address to put in the link → HOSTING_OFF.
  const mapAddr = host._linkAddress;
  host._linkAddress = (ip) => ip;
  assert.throws(() => host.startPairing(), { code: 'HOSTING_OFF' });
  host._linkAddress = mapAddr;
  // Hosting switched off (main stops the server right after; the setting alone already refuses).
  settings.quiet = true;
  settings.update({ hostEnabled: false });
  assert.throws(() => host.startPairing(), { code: 'HOSTING_OFF' });
  settings.update({ hostEnabled: true });
  settings.quiet = false;

  // A session starts (self-connection prompt, nothing granted): the live offer is cancelled at
  // once, and no new one can be started while it lasts.
  const f = host.startPairing();
  host.on('request', (req) => req.respond({ accept: true, permissions: NO_PERMISSIONS }));
  const vs = new ViewerSession({ tailscale: viewerTs(ts), auth, target: { ip: '127.0.0.1', port, peer: null }, password: null, self: { hostname: 'desk', os: 'windows', version: '0.3.0' } });
  t.after(() => vs.close('test-cleanup'));
  const started = new Promise((resolve) => host.once('session-start', resolve));
  vs.connect();
  await started;
  assert.deepEqual(events.splice(0), [{ offerId: f.offerId, phase: 'cancelled', reason: 'session' }]);
  assert.throws(() => host.startPairing(), { code: 'SESSION_ACTIVE' });
  host.endSession('host-ended');
  await tick(50);

  // Tailscale stops → TS_DOWN.
  const g = host.startPairing();
  ts.setState('stopped', []);
  await tick(50);
  assert.throws(() => host.startPairing(), { code: 'TS_DOWN' });
  // stop() ends a live offer ('host-stopped') and refuses new ones.
  await host.stop();
  assert.deepEqual(events.splice(0), [{ offerId: g.offerId, phase: 'cancelled', reason: 'host-stopped' }]);
  assert.throws(() => host.startPairing(), { code: 'HOSTING_OFF' });
});

test("relay: a node forwarding the phone's client nonce gets an ident naming itself; the phone stops, sending nothing", async (t) => {
  // H sees M as another node (whois: MALLORY). The phone P, paired with H, reaches M instead
  // (simulated: WireGuard makes this impossible for H's real address) and M relays P's client
  // nonce to H. H signs honestly, for the viewer it sees: M. All of it runs on 127.0.0.1, M on a
  // port of its own.
  const { host, ts, port: hPort } = await startPairHost(t);
  remoteFrom(ts, MALLORY);
  const requests = [];
  host.on('request', (r) => requests.push(r));
  const m = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  t.after(() => m.close());
  await new Promise((r) => m.once('listening', r));
  const fromH = [];
  let forwarded = null;
  m.on('connection', (pws, req) => {
    forwarded = req.headers[P.CLIENT_NONCE_HEADER];
    const hws = new WebSocket(`ws://127.0.0.1:${hPort}${P.WS_PATH}`, {
      headers: { ...VH, [P.CLIENT_NONCE_HEADER]: forwarded }, perMessageDeflate: false,
    });
    t.after(() => hws.terminate());
    hws.on('message', (d) => { fromH.push(JSON.parse(String(d))); pws.send(String(d)); });
    pws.on('message', (d) => { if (hws.readyState === WebSocket.OPEN) hws.send(String(d)); });
  });
  const record = { hostId: SELF_ID, keyPub: b64url(HOST.pub), name: 'test-host.example.ts.net', ips: [LINK_V4], port: m.address().port, selfId: PHONE.node.stableId };
  const phone = new PhoneSim({ dial: (_ip, p) => ({ host: '127.0.0.1', port: p }) });
  t.after(() => phone.closeAll());
  assert.deepEqual(await phone.connect(record), { ok: false, reason: 'identity-mismatch' });
  assert.deepEqual(phone.sent, [], 'no request, no hostname, no proof');
  const hello = fromH.find((x) => x.t === 'hello');
  assert.equal(hello.ident.cnonce, forwarded, "H echoed the phone's client nonce");
  assert.equal(hello.ident.viewerId, MALLORY.node.stableId, 'but signed for the node it sees');
  assert.equal(pairing.verifyIdent(HOST.pub, hello, { cnonce: forwarded, hostId: SELF_ID }).ok, true, 'the signature itself is genuine');
  await tick(50);
  assert.deepEqual(requests, []);
  assert.equal(fromH.length, 1, 'H heard nothing from the phone');
});

test('phone simulator: a hello from the wrong key, an old host or another connection never gets an answer', async (t) => {
  // A fake "host" that answers every connection with a scripted hello (no HostServer).
  let script = null;
  const srv = new WebSocket.Server({ host: '127.0.0.1', port: 0 });
  t.after(() => srv.close());
  await new Promise((r) => srv.once('listening', r));
  const heard = [];
  srv.on('connection', (ws, req) => {
    ws.on('message', (d) => heard.push(JSON.parse(String(d))));
    ws.send(JSON.stringify(script(req.headers[P.CLIENT_NONCE_HEADER])));
  });
  const nonce = Buffer.alloc(32, 4).toString('base64');
  const base = { t: 'hello', protocol: 2, app: 'Tunnelview', version: '0.3.0', host: { hostname: 'h', os: 'windows', user: { login: '', displayName: '' } }, auth: { passwordSet: false, acceptMode: 'ask', salt: null, kdf: null, nonce, autoAccept: false, passwordLocked: false } };
  const signed = (key, cn, { hostId = SELF_ID, viewerId = PHONE.node.stableId } = {}) => ({
    ...base, ident: { v: 1, alg: 'ed25519', hostId, viewerId, cnonce: cn, sig: crypto.sign(null, pairing.identBytes(nonce, cn, hostId, viewerId), key.privateKey).toString('base64') },
  });
  const record = { hostId: SELF_ID, keyPub: b64url(HOST.pub), name: '', ips: [LINK_V4, 'fd7a:115c:a1e0::1'], port: srv.address().port, selfId: PHONE.node.stableId };
  const phone = new PhoneSim({ dial: (_ip, p) => ({ host: '127.0.0.1', port: p }) });
  t.after(() => phone.closeAll());
  const run = (fn) => { script = fn; return phone.connect(record); };

  // No ident: from a 0.3+ host its key is unavailable right now (Retry there), not "update it";
  // from an older one, an update is what it needs. Nothing is sent in either case.
  assert.deepEqual(await run(() => base), { ok: false, reason: 'host-identity-unavailable' });
  assert.deepEqual(await run(() => ({ ...base, version: '0.2.0' })), { ok: false, reason: 'host-update-needed' });
  assert.deepEqual(await run(() => ({ ...base, version: '1.0.0' })), { ok: false, reason: 'host-identity-unavailable' });
  assert.deepEqual(await run(() => ({ ...base, version: 'nonsense' })), { ok: false, reason: 'host-update-needed' });
  assert.deepEqual(await run((cn) => signed(OTHER, cn)), { ok: false, reason: 'host-key-mismatch' }, 'another key, on both addresses');
  assert.deepEqual(await run(() => signed(HOST, CNONCE_2)), { ok: false, reason: 'host-key-mismatch' }, 'replayed from another connection');
  assert.deepEqual(await run((cn) => signed(HOST, cn, { hostId: 'nOTHERHOST' })), { ok: false, reason: 'host-key-mismatch' });
  assert.deepEqual(await run(() => ({ ...base, protocol: 1 })), { ok: false, reason: 'protocol' });
  await tick(50);
  assert.deepEqual(phone.sent, []);
  assert.deepEqual(heard, []);
  const ok = await run((cn) => signed(HOST, cn));
  assert.equal(ok.ok, true);
  ok.conn.close();
});

test('pair: the policy is checked again when `pair` arrives; a node it now refuses uses up nothing', async (t) => {
  const { host, ts, settings, port, events } = await startPairHost(t);
  const asSelf = remoteFrom(ts);
  settings.quiet = true; // read when `pair` arrives; no rebind (see remoteFrom)
  const offer = host.startPairing();
  const live = { offerId: offer.offerId, expiresAt: offer.expiresAt, failures: 0 };
  const cases = [
    ['Who can connect no longer lists the phone', { allowFrom: 'list', allowList: ['nSOMEONEELSE'] }],
    ['hosting switched off', { hostEnabled: false }],
  ];
  for (const [name, change] of cases) {
    // The connection reached hello while the phone was still allowed …
    const cnonce = newClientNonce();
    const c = await rawWs(port, { cnonce });
    const hello = await c.next('hello');
    assert.ok(hello, name);
    // … and sends the right proof after the change.
    settings.update(change);
    c.send({ t: 'pair', proof: proofFor(offer, hello, cnonce), device: {} });
    assert.deepEqual(await c.next('pair-result'), FAILED, name);
    assert.equal(await c.closed, 4000, name);
    assert.deepEqual(host.pairingOffer, live, `${name}: the offer is untouched`);
    assert.deepEqual(events, [], `${name}: nothing reported`);
    settings.update({ allowFrom: 'tailnet', allowList: [], hostEnabled: true });
  }

  // A node the policy refuses from the start never gets a connection to send `pair` on (D4).
  settings.update({ allowFrom: 'list', allowList: ['nSOMEONEELSE'] });
  assert.equal((await rawWs(port, { cnonce: newClientNonce() })).status, 403);
  assert.deepEqual(host.pairingOffer, live);
  settings.update({ allowFrom: 'tailnet', allowList: [] });

  // With the policy as it was, the same steps pair: the refusals above were the policy's.
  const cnonce = newClientNonce();
  const c = await rawWs(port, { cnonce });
  const hello = await c.next('hello');
  c.send({ t: 'pair', proof: proofFor(offer, hello, cnonce), device: {} });
  assert.equal((await c.next('pair-result')).ok, true);
  assert.equal(await c.closed, 1000);

  // Switching hosting off withdraws a live offer at once, without waiting for stop().
  asSelf();
  settings.quiet = false;
  const next = host.startPairing();
  events.length = 0;
  settings.update({ hostEnabled: false });
  assert.deepEqual(events, [{ offerId: next.offerId, phase: 'cancelled', reason: 'host-stopped' }]);
  assert.equal(host.pairingOffer, null);
  assert.throws(() => host.startPairing(), { code: 'HOSTING_OFF' });
});

test('startPairing: Tailscale running without a StableNodeID of our own → TS_DOWN', async (t) => {
  const { host, ts } = await startPairHost(t);
  ts.last.self.stableId = '';
  assert.throws(() => host.startPairing(), { code: 'TS_DOWN' });
  ts.last.self.stableId = SELF_ID;
  assert.ok(host.startPairing().offerId);
  host.cancelPairing();
});
