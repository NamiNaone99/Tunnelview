'use strict';
/*
 * node --test test/mobile-vectors.test.js
 * test/vectors/*.json (written by scripts/make-mobile-fixtures.js) are what the mobile port is tested
 * against, so they must keep matching the desktop code:
 *   - each file is byte-identical to what the generator makes from the current modules: a behaviour
 *     change fails here until the vectors (and with them the phone) are updated on purpose;
 *   - every case replays against the real modules through the adapters below, written separately
 *     from the generator and reading the files the way a Dart test will.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const fixtures = require('../scripts/make-mobile-fixtures');

const VECTORS = path.join(__dirname, 'vectors');
const load = (file) => JSON.parse(fs.readFileSync(path.join(VECTORS, file), 'utf8'));

let generated = null;
const regenerate = () => (generated ||= fixtures.generate());

let loaded = null;
function modules() {
  loaded ||= (async () => {
    globalThis.TunnelviewProtocol = require('../src/shared/protocol');
    return {
      auth: require('../src/main/auth'),
      pairing: require('../src/main/pairing'),
      ipc: require('../src/main/ipc'),
      injector: require('../src/main/input')._internals, // pure validator only, never the backend
      rtc: await import('../src/renderer/shared/rtc.js'),
      viewerValidate: await import('../src/renderer/viewer/validate.js'),
      reasons: await import('../src/renderer/viewer/reasons.js'),
      panelValidate: await import('../src/renderer/panel/validate.js'),
    };
  })();
  return loaded;
}

/** The host's input path: panel renderer, then main's IPC handler, then the injector. */
const hostStages = (m) => ({ panel: m.panelValidate.sanitizeInput, ipc: m.ipc.sanitizeInput, injector: m.injector.validate });
const pipeline = (fns) => (msg) => fns.reduce((x, f) => (x === null ? null : f(x)), msg);

/** How each file's functions.<name>.cases are called. */
const REPLAY = {
  'auth-v2.json': ({ auth }) => ({
    validateKdf: auth.validateKdf,
    normalizeBinding: auth.normalizeBinding,
    decodeB64: (s, min, max) => auth.decodeB64(s, min, max)?.toString('hex') ?? null,
    computeProof: auth.computeProof,
    verifyProof: auth.verifyProof,
  }),
  'addresses.json': ({ rtc }) => ({
    isTailscaleAddress: rtc.isTailscaleAddress,
    candidateAddress: rtc.candidateAddress,
    isAllowedCandidate: rtc.isAllowedCandidate,
  }),
  'tailnet-path.json': ({ rtc }) => ({
    // args[0].stats is the getStats() report in order; getStatsFails makes it reject.
    verifyTailnetPath: (spec) => rtc.verifyTailnetPath({
      getStats: () => (spec.getStatsFails
        ? Promise.reject(new Error('closed'))
        : Promise.resolve(new Map(spec.stats.map((s) => [s.id, s])))),
    }),
  }),
  'validate.json': ({ rtc, viewerValidate }) => ({
    validateSignal: viewerValidate.validateSignal,
    validateControl: viewerValidate.validateControl,
    sanitizeSdp: (sdp) => viewerValidate.sanitizeSdp(sdp, rtc.isAllowedCandidate),
  }),
  'reasons.json': ({ reasons }) => ({
    describeClose: reasons.describeClose,
    effectiveCloseReason: reasons.effectiveCloseReason,
    retrySentence: reasons.retrySentence,
    controlBlockReason: reasons.controlBlockReason,
  }),
  'input-limits.json': (m) => ({ hostInput: pipeline(Object.values(hostStages(m))) }),
  // Keys and tokens travel as base64url in the files; the functions take bytes.
  'ident.json': ({ pairing }) => ({
    identBytes: (...args) => pairing.identBytes(...args).toString('utf8'),
    validCnonce: pairing.validCnonce,
    verifyIdent: (pub, hello, expect) => pairing.verifyIdent(Buffer.from(pub, 'base64url'), hello, expect),
  }),
  'pair.json': ({ pairing }) => ({
    pairMessage: pairing.pairMessage,
    pairProof: (token, ...rest) => pairing.pairProof(Buffer.from(token, 'base64url'), ...rest),
    verifyPairProof: (token, proof, ...rest) => pairing.verifyPairProof(Buffer.from(token, 'base64url'), proof, ...rest),
  }),
  'links.json': ({ pairing }) => ({ parseLink: pairing.parseLink, encodeLink: pairing.encodeLink }),
  'fingerprint.json': ({ pairing }) => ({
    fingerprint: (pub) => pairing.fingerprint(Buffer.from(pub, 'base64url')),
    base32: (hex) => pairing.base32(Buffer.from(hex, 'hex')),
  }),
};

/** A KeyObject for a raw 32-byte Ed25519 public key (SPKI DER = fixed prefix + key). */
const ed25519Public = (raw) => crypto.createPublicKey({
  key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki',
});

test('test/vectors holds exactly the files the generator produces, each with a replay', () => {
  const files = fixtures.PRODUCERS.map((p) => p.file);
  assert.equal(new Set(files).size, files.length, 'duplicate producer');
  assert.deepEqual(fs.readdirSync(VECTORS).filter((f) => f.endsWith('.json')).sort(), [...files].sort());
  assert.deepEqual(Object.keys(REPLAY).sort(), [...files].sort());
});

for (const { file } of fixtures.PRODUCERS) {
  test(`${file} is what the current desktop code produces (node scripts/make-mobile-fixtures.js)`, async () => {
    const want = (await regenerate()).get(file);
    const have = fs.readFileSync(path.join(VECTORS, file), 'utf8');
    assert.deepEqual(JSON.parse(have), JSON.parse(want), `${file}: the desktop behaviour changed; regenerate and update the mobile port`);
    assert.equal(have, want, `${file}: not in canonical form; regenerate`);
  });

  test(`${file}: every case replays against the real modules`, async () => {
    const doc = load(file);
    assert.equal(doc.format, fixtures.FORMAT);
    assert.equal(typeof doc.about, 'string');
    const fns = REPLAY[file](await modules());
    assert.deepEqual(Object.keys(doc.functions).sort(), Object.keys(fns).sort());
    for (const [name, { about, cases }] of Object.entries(doc.functions)) {
      assert.equal(typeof about, 'string', `${name}.about`);
      assert.ok(cases.length > 0, `${name} has no cases`);
      for (const c of cases) {
        const label = `${name}(${JSON.stringify(c.args).slice(0, 160)})`;
        assert.ok(Array.isArray(c.args), label);
        assert.ok(('result' in c) !== ('error' in c), `${label}: exactly one of result / error`);
        assert.deepEqual(Object.keys(c).filter((k) => !['args', 'result', 'error', 'note'].includes(k)), [], label);
        if ('error' in c) await assert.rejects(async () => fns[name](...c.args), { code: c.error }, label);
        else assert.deepEqual(await fns[name](...c.args), c.result, label);
      }
    }
  });
}

test('auth-v2.json proofs: a viewer reproduces key, message and proof; the host verifies them', async () => {
  const { auth } = await modules();
  const doc = load('auth-v2.json');
  assert.equal(doc.context, globalThis.TunnelviewProtocol.AUTH.CONTEXT);
  // The published protocol vectors stay in the file with their published values.
  const byName = (prefix) => doc.proofs.find((p) => p.name.startsWith(prefix));
  assert.equal(byName('protocol 3.6.3 vector 1').proof, 'XIc59V892Z5TTBp3wSmxmA2Cdc3hZ2XeUeaFeCD0ujE=');
  assert.equal(byName('protocol 3.6.3 vector 2').proof, 'A+x4LqT9YsfifsfP7iPTwaSU8oWlHeEm3cB//9527SE=');
  assert.ok(doc.proofs.length >= 5);
  for (const p of doc.proofs) {
    const binding = { hostId: p.hostId, viewerId: p.viewerId };
    const pw = Buffer.from(p.password.normalize('NFC'), 'utf8');
    assert.equal(pw.toString('hex'), p.passwordNfcUtf8Hex, p.name);
    const { N, r, p: par, keylen } = p.kdf;
    const key = crypto.scryptSync(pw, Buffer.from(p.salt, 'base64'), keylen, { N, r, p: par, maxmem: auth.SCRYPT_MAXMEM });
    assert.equal(key.toString('base64'), p.key, p.name);
    assert.equal(p.message, `${doc.context}${p.nonce}|${p.hostId}|${p.viewerId}`, p.name);
    assert.equal(crypto.createHmac('sha256', key).update(p.message, 'utf8').digest('base64'), p.proof, p.name);
    assert.equal(await auth.computeProof(p.password, { salt: p.salt, kdf: p.kdf }, p.nonce, binding), p.proof, p.name);
    const stored = { salt: p.salt, ...p.kdf, key: p.key };
    assert.equal(auth.verifyProof(stored, p.nonce, p.proof, binding), true, p.name);
    assert.equal(auth.verifyProof(stored, p.nonce, p.proof, { hostId: p.viewerId, viewerId: p.hostId }), false, `${p.name}: swapped`);
  }
  for (const h of doc.hmacVectors) {
    const binding = { hostId: h.hostId, viewerId: h.viewerId };
    assert.equal(h.message, `${doc.context}${h.nonce}|${h.hostId}|${h.viewerId}`, h.name);
    assert.equal(crypto.createHmac('sha256', Buffer.from(h.stored.key, 'base64')).update(h.message, 'utf8').digest('base64'), h.proof, h.name);
    assert.equal(auth.verifyProof(h.stored, h.nonce, h.proof, binding), true, h.name);
  }
  assert.equal(doc.hmacVectors[0].proof, 'xvxr3gGEkhZ1evAYiFYNgw1qM/T0yQgaGJaDelvsEc4=', 'test/auth.test.js fixed vector');
});

test('input-limits.json: each limit is the exact boundary of its stage, and host is the strictest', async () => {
  const m = await modules();
  const stages = hostStages(m);
  const doc = load('input-limits.json');
  const all = { ...stages, host: pipeline(Object.values(stages)) };
  assert.deepEqual(Object.keys(doc.stages).sort(), Object.keys(stages).sort());
  for (const [name, f] of Object.entries(all)) {
    const lim = name === 'host' ? doc.host : doc.stages[name];
    const ok = (msg) => f(msg) !== null;
    const md = (extra) => ({ t: 'md', b: 0, x: 0.5, y: 0.5, n: 1, ...extra });
    const kd = (extra) => ({ t: 'kd', code: 'KeyA', key: '', ...extra });
    const tag = (k) => `${name}.${k}`;
    assert.ok(ok({ t: 'combo', codes: Array(lim.comboMaxCodes).fill('KeyB') }), tag('comboMaxCodes'));
    assert.ok(!ok({ t: 'combo', codes: Array(lim.comboMaxCodes + 1).fill('KeyB') }), tag('comboMaxCodes'));
    assert.equal(f(md({ n: lim.clickCountMax })).n, lim.clickCountMax, tag('clickCountMax'));
    assert.equal(f(md({ n: lim.clickCountMax + 1 })).n, lim.clickCountMax, tag('clickCountMax'));
    const w = f({ t: 'wh', dx: -(lim.wheelMaxAbs + 0.5), dy: lim.wheelMaxAbs * 4 });
    assert.deepEqual([w.dx, w.dy], [-lim.wheelMaxAbs, lim.wheelMaxAbs], tag('wheelMaxAbs'));
    assert.equal(f({ t: 'wh', dx: lim.wheelMaxAbs, dy: 0 }).dx, lim.wheelMaxAbs, tag('wheelMaxAbs'));
    assert.ok(ok({ t: 'txt', text: 'b'.repeat(lim.textMaxUnits) }), tag('textMaxUnits'));
    assert.ok(!ok({ t: 'txt', text: 'b'.repeat(lim.textMaxUnits + 1) }), tag('textMaxUnits'));
    assert.ok(ok(kd({ code: 'B'.repeat(lim.codeMaxLength) })), tag('codeMaxLength'));
    assert.ok(!ok(kd({ code: 'B'.repeat(lim.codeMaxLength + 1) })), tag('codeMaxLength'));
    assert.equal(f(kd({ key: 'q'.repeat(lim.keyMaxLength) })).key.length, lim.keyMaxLength, tag('keyMaxLength'));
    assert.equal(f(kd({ key: 'q'.repeat(lim.keyMaxLength + 1) })).key, '', tag('keyMaxLength'));
    assert.ok(ok(md({ b: lim.buttonMax })), tag('buttonMax'));
    assert.ok(!ok(md({ b: lim.buttonMax + 1 })), tag('buttonMax'));
  }
  for (const k of Object.keys(doc.host)) {
    assert.equal(doc.host[k], Math.min(...Object.values(doc.stages).map((s) => s[k])), `host.${k}`);
  }
  // The values the mobile plan builds on (protocol notes §5.2).
  assert.deepEqual(
    [doc.host.comboMaxCodes, doc.host.clickCountMax, doc.host.wheelMaxAbs, doc.host.textMaxUnits],
    [6, 3, 10000, globalThis.TunnelviewProtocol.INPUT.MAX_TEXT],
  );
});

test('reasons.json: hostReasons is the module set; every protocol deny reason has a describeClose case', async () => {
  const { reasons } = await modules();
  const doc = load('reasons.json');
  assert.deepEqual(doc.hostReasons, [...reasons.HOST_REASONS].sort());
  const described = new Set(doc.functions.describeClose.cases.map((c) => c.args[0]));
  for (const r of Object.values(globalThis.TunnelviewProtocol.DENY)) assert.ok(described.has(`denied:${r}`), r);
});

test('ident.json: keys come from their seeds, RFC 8032 known answers hold, every signature verifies', async () => {
  const doc = load('ident.json');
  const P = globalThis.TunnelviewProtocol || require('../src/shared/protocol');
  assert.deepEqual([doc.context, doc.alg, doc.version], [P.IDENT.CONTEXT, P.IDENT.ALG, P.IDENT.VERSION]);
  assert.deepEqual([doc.clientNonceHeader, doc.clientNonceBytes], [P.CLIENT_NONCE_HEADER, P.CLIENT_NONCE_BYTES]);
  const pkcs8Prefix = Buffer.from('302e020100300506032b657004220420', 'hex'); // RFC 8410
  const keyFromSeed = (seedHex) => crypto.createPrivateKey({ key: Buffer.concat([pkcs8Prefix, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
  const rawPub = (priv) => crypto.createPublicKey(priv).export({ format: 'der', type: 'spki' }).subarray(12);
  const byName = {};
  for (const k of doc.keys) {
    assert.equal(k.pkcs8, Buffer.concat([pkcs8Prefix, Buffer.from(k.seedHex, 'hex')]).toString('base64'), k.name);
    const priv = keyFromSeed(k.seedHex);
    assert.equal(rawPub(priv).toString('base64url'), k.pub, k.name);
    assert.equal(Buffer.from(k.pub, 'base64url').toString('hex'), k.pubHex, k.name);
    byName[k.name] = priv;
  }
  assert.equal(doc.rfc8032.length, 2);
  for (const r of doc.rfc8032) {
    const priv = keyFromSeed(r.seed);
    assert.equal(rawPub(priv).toString('hex'), r.pub, r.name);
    assert.equal(crypto.sign(null, Buffer.from(r.message, 'hex'), priv).toString('hex'), r.sig, r.name);
  }
  assert.equal(doc.rfc8032[0].sig.slice(0, 16), 'e5564300c360ac72', 'RFC 8032 TEST 1 as published');
  for (const s of doc.signatures) {
    assert.equal(s.signedText, `${doc.context}${s.nonce}|${s.cnonce || ''}|${s.hostId}|${s.viewerId}`, s.name);
    const bytes = Buffer.from(s.signedText, 'utf8');
    assert.equal(crypto.sign(null, bytes, byName[s.key]).toString('base64'), s.sig, `${s.name}: Ed25519 is deterministic`);
    assert.ok(crypto.verify(null, bytes, ed25519Public(rawPub(byName[s.key])), Buffer.from(s.sig, 'base64')), s.name);
  }
  // Every refusal reason a phone acts on is covered.
  const reasons = new Set(doc.functions.verifyIdent.cases.filter((c) => 'result' in c).map((c) => c.result.reason));
  for (const r of [null, 'no-ident', 'malformed', 'bad-signature', 'cnonce-mismatch', 'host-mismatch', 'viewer-mismatch']) assert.ok(reasons.has(r), String(r));
});

test('pair.json: each proof is HMAC-SHA256(token, message) over exactly the documented message', async () => {
  const { pairing } = await modules();
  const doc = load('pair.json');
  const P = globalThis.TunnelviewProtocol || require('../src/shared/protocol');
  assert.deepEqual(
    [doc.context, doc.tokenBytes, doc.ttlMs, doc.maxFailures, doc.failedReason, doc.messages],
    [P.PAIR.CONTEXT, P.PAIR.TOKEN_BYTES, P.PAIR.TTL_MS, P.PAIR.MAX_FAILURES, P.PAIR.FAILED, { pair: P.MSG.PAIR, pairResult: P.MSG.PAIR_RESULT }],
  );
  assert.ok(doc.proofs.length >= 2);
  for (const p of doc.proofs) {
    const token = Buffer.from(p.token, 'base64url');
    assert.equal(token.toString('hex'), p.tokenHex, p.name);
    assert.equal(token.length, doc.tokenBytes, p.name);
    assert.equal(p.message, `${doc.context}${p.nonce}|${p.cnonce}|${p.hostId}|${p.viewerId}`, p.name);
    assert.equal(crypto.createHmac('sha256', token).update(p.message, 'utf8').digest('base64'), p.proof, p.name);
    assert.equal(pairing.verifyPairProof(token, p.proof, p.nonce, p.cnonce, p.hostId, p.viewerId), true, p.name);
  }
});

test('links.json: every accepted link re-encodes to itself as canonical JSON, keys in order', async () => {
  const { pairing } = await modules();
  const doc = load('links.json');
  const P = globalThis.TunnelviewProtocol || require('../src/shared/protocol');
  assert.equal(doc.prefix, P.PAIR.LINK_PREFIX);
  assert.deepEqual(doc.keys, ['v', 'id', 'n', 'a', 'p', 'k', 't', 'x']);
  const accepted = doc.functions.parseLink.cases.filter((c) => 'result' in c);
  assert.ok(accepted.length >= 5);
  for (const c of accepted) {
    const [text] = c.args;
    assert.ok(text.length <= doc.maxLength);
    assert.equal(pairing.encodeLink(c.result), text, c.note);
    // The files store objects with sorted keys; the link writes them in doc.keys order.
    const json = Buffer.from(text.slice(doc.prefix.length), 'base64url').toString('utf8');
    assert.equal(json, JSON.stringify(Object.fromEntries(doc.keys.map((k) => [k, c.result[k]]))), c.note);
    assert.deepEqual(Object.keys(JSON.parse(json)), doc.keys, c.note);
  }
  // Every refusal code appears, so a port cannot skip one.
  const codes = new Set(doc.functions.parseLink.cases.map((c) => c.error).filter(Boolean));
  for (const code of ['FORMAT', 'ENCODING', 'JSON', 'VERSION', 'FIELDS', 'ID', 'NAME', 'ADDRESS', 'PORT', 'KEY', 'TOKEN', 'EXPIRY', 'NONCANONICAL']) {
    assert.ok(codes.has(`LINK_${code}`), code);
  }
});

test('fingerprint.json: SHA-256 and base32 recomputed independently give every fingerprint', () => {
  const doc = load('fingerprint.json');
  const base32 = (buf) => { // RFC 4648, the slow obvious way
    const bits = [...buf].map((b) => b.toString(2).padStart(8, '0')).join('');
    let out = '';
    for (let i = 0; i < bits.length; i += 5) out += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
    return out;
  };
  assert.ok(doc.keys.length >= 4);
  for (const k of doc.keys) {
    const digest = crypto.createHash('sha256').update(Buffer.from(k.pub, 'base64url')).digest();
    assert.equal(digest.toString('hex'), k.sha256Hex, k.name);
    assert.equal(base32(digest), k.base32, k.name);
    assert.equal(k.fingerprint, `TV-${k.base32.slice(0, 20).match(/.{4}/g).join('-')}`, k.name);
  }
  const rfc = Object.fromEntries(doc.functions.base32.cases.map((c) => [Buffer.from(c.args[0], 'hex').toString('latin1'), c.result]));
  assert.deepEqual([rfc[''], rfc.f, rfc.fo, rfc.foo, rfc.foob, rfc.fooba, rfc.foobar], ['', 'MY', 'MZXQ', 'MZXW6', 'MZXW6YQ', 'MZXW6YTB', 'MZXW6YTBOI']);
});

test('the vectors and their generator are never packaged (electron-builder excludes test/ and scripts/)', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  const files = /^files:\s*\n((?:[ \t]+-[^\n]*\n)+)/m.exec(yml);
  assert.ok(files, 'no files: list in electron-builder.yml');
  const entries = files[1].split('\n').map((l) => l.trim().replace(/^-\s*/, '').replace(/^"(.*)"$/, '$1')).filter(Boolean);
  for (const dir of ['test', 'scripts']) assert.ok(entries.includes(`!${dir}{,/**/*}`), `electron-builder.yml must exclude ${dir}/`);
  assert.ok(!entries.some((e) => /^(test|scripts)\b/.test(e)), 'test/ or scripts/ included explicitly');
});
