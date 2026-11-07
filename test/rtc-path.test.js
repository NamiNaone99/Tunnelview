'use strict';
/* src/renderer/shared/rtc.js — selected-pair verification and the capture size cap (pure helpers). */
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.TunnelviewProtocol = require('../src/shared/protocol');

const load = () => import('../src/renderer/shared/rtc.js');
const cand = (address, extra = {}) => ({ address, protocol: 'udp', type: 'host', ...extra });

test('pairIsTailnet: both ends must be Tailscale addresses when present', async () => {
  const { pairIsTailnet } = await load();
  assert.equal(pairIsTailnet({ local: cand('100.64.0.1'), remote: cand('100.127.255.254') }), true);
  assert.equal(pairIsTailnet({ local: cand('fd7a:115c:a1e0::1'), remote: cand('[fd7a:115c:a1e0:ab12::2]') }), true);
  assert.equal(pairIsTailnet({ local: cand('100.64.0.1'), remote: cand('192.168.1.20') }), false);
  assert.equal(pairIsTailnet({ local: cand('10.0.0.5'), remote: cand('100.64.0.2') }), false);
  assert.equal(pairIsTailnet({ local: cand('100.64.0.1'), remote: cand('203.0.113.9') }), false);
  assert.equal(pairIsTailnet({ local: cand('100.128.0.1'), remote: cand('100.64.0.2') }), false);
  assert.equal(pairIsTailnet({ local: cand('100.64.0.1'), remote: cand('fe80::1%eth0') }), false, 'zone stripped, LAN v6');
  // A redacted (peer-reflexive) remote address cannot contradict the invariant.
  assert.equal(pairIsTailnet({ local: cand('100.64.0.1'), remote: cand(null, { type: 'prflx' }) }), true);
  assert.equal(pairIsTailnet({ local: cand('100.64.0.1'), remote: cand('') }), true);
  // Not a pair → not verifiable.
  assert.equal(pairIsTailnet(null), false);
  assert.equal(pairIsTailnet({ local: cand('100.64.0.1') }), false);
});

test("pairIsTailnet: Chromium's 'redacted-ip.invalid' prflx remote is unknown (allowed); the local end stays strict", async () => {
  const { pairIsTailnet, describePair } = await load();
  // getSelectedCandidatePair() on a fast tailnet: the viewer's checks beat its trickled candidates.
  const redacted = { local: cand('100.64.1.2'), remote: cand('redacted-ip.invalid', { type: 'prflx' }) };
  assert.equal(pairIsTailnet(redacted), true);
  assert.deepEqual(describePair(redacted), {
    ok: true, local: '100.64.1.2', remote: null, pair: true, protocol: 'udp', localType: 'host', remoteType: 'prflx',
  });
  // An mDNS host name is not an address either (such candidates are never signalled or added).
  assert.equal(pairIsTailnet({ local: cand('100.64.0.1'), remote: cand('3f1c9a2e-77b0-4c1d-9e1a-0b6c2d1e4f00.local') }), true);
  // A real IP outside the tailnet still fails, on either end.
  assert.equal(describePair({ local: cand('100.64.1.2'), remote: cand('192.168.1.5', { type: 'prflx' }) }).ok, false);
  assert.equal(describePair({ local: cand('192.168.1.5'), remote: cand('100.64.0.2') }).ok, false);
  // Local: a host name or a missing address cannot be verified → false.
  assert.equal(describePair({ local: cand('abc.local'), remote: cand('100.64.0.2') }).ok, false);
  assert.equal(describePair({ local: cand('redacted-ip.invalid'), remote: cand('100.64.0.2') }).ok, false);
  assert.equal(pairIsTailnet({ local: cand(null), remote: cand('100.64.0.2') }), false);
  assert.equal(pairIsTailnet({ local: cand(''), remote: cand('100.64.0.2') }), false);
  // A malformed numeric remote is not a host name: fail closed.
  assert.equal(pairIsTailnet({ local: cand('100.64.0.1'), remote: cand('100.64.0.01') }), false);
  assert.equal(pairIsTailnet({ local: cand('100.64.0.1'), remote: cand('fd7a::115c::1') }), false);
});

test('describePair: verifyTailnetPath-shaped summary', async () => {
  const { describePair } = await load();
  assert.deepEqual(describePair({ local: cand('100.64.0.1'), remote: cand('100.64.0.2', { type: 'srflx', protocol: 'udp' }) }), {
    ok: true, local: '100.64.0.1', remote: '100.64.0.2', pair: true, protocol: 'udp', localType: 'host', remoteType: 'srflx',
  });
  assert.equal(describePair({ local: cand('100.64.0.1'), remote: cand('8.8.8.8') }).ok, false);
  assert.equal(describePair({ local: cand('[fd7a:115c:a1e0::1]'), remote: cand('100.64.0.2') }).local, 'fd7a:115c:a1e0::1');
});

/** Fake pc whose getStats() reports one selected pair with these candidate stats entries. */
const statsPc = (local, remote) => ({
  getStats: async () => new Map([
    ['T', { type: 'transport', selectedCandidatePairId: 'CP' }],
    ['CP', { type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R' }],
    ['L', { type: 'local-candidate', protocol: 'udp', candidateType: 'host', ...local }],
    ['R', { type: 'remote-candidate', protocol: 'udp', candidateType: 'prflx', ...remote }],
  ]),
});

test('verifyTailnetPath: same address parsing; a missing local stays allowed, a local host name fails', async () => {
  const { verifyTailnetPath } = await load();
  let r = await verifyTailnetPath(statsPc({ address: '100.64.1.2' }, { address: '' }));
  assert.deepEqual(r, { ok: true, local: '100.64.1.2', remote: null, pair: true, protocol: 'udp', localType: 'host', remoteType: 'prflx' });
  r = await verifyTailnetPath(statsPc({ address: '100.64.1.2' }, { address: 'redacted-ip.invalid' }));
  assert.equal(r.ok, true);
  assert.equal(r.remote, null);
  assert.equal((await verifyTailnetPath(statsPc({ address: '100.64.1.2' }, { address: '192.168.1.5' }))).ok, false);
  assert.equal((await verifyTailnetPath(statsPc({ address: '192.168.1.5' }, { address: '100.64.0.2' }))).ok, false);
  assert.equal((await verifyTailnetPath(statsPc({ address: 'abc.local' }, { address: '100.64.0.2' }))).ok, false);
  assert.equal((await verifyTailnetPath(statsPc({}, { address: '100.64.0.2' }))).ok, true, 'stats may omit the local address');
  assert.equal((await verifyTailnetPath(statsPc({ ip: '10.1.2.3' }, {}))).ok, false, 'legacy `ip` field');
  // No selected pair / getStats failing → not verified, nothing contradicts the invariant.
  assert.deepEqual(await verifyTailnetPath({ getStats: async () => new Map() }), {
    ok: true, local: null, remote: null, pair: false, protocol: null, localType: null, remoteType: null,
  });
  assert.equal((await verifyTailnetPath({ getStats: async () => { throw new Error('closed'); } })).pair, false);
});

test('captureSizeLimit: no cap up to 4K', async () => {
  const { captureSizeLimit } = await load();
  assert.equal(captureSizeLimit({ width: 3840, height: 2160, scaleFactor: 1.5 }), null);
  assert.equal(captureSizeLimit({ width: 2560, height: 1440, scaleFactor: 1 }), null);
  assert.equal(captureSizeLimit({ width: 2160, height: 3840, scaleFactor: 1 }), null, 'portrait 4K fits');
  assert.equal(captureSizeLimit(null), null);
  assert.equal(captureSizeLimit({ width: 0, height: 0 }), null);
});

test('captureSizeLimit: larger displays FIT 3840×2160, aspect ratio kept, even (HiDPI not quartered)', async () => {
  const { captureSizeLimit } = await load();
  // 16" MacBook Pro (just above the box): 3341.5×2160 → 3340×2160, not the 1728×1116 logical size.
  assert.deepEqual(captureSizeLimit({ width: 3456, height: 2234, scaleFactor: 2 }), { width: 3340, height: 2160 });
  assert.deepEqual(captureSizeLimit({ width: 3840, height: 2400, scaleFactor: 2 }), { width: 3456, height: 2160 });
  assert.deepEqual(captureSizeLimit({ width: 4480, height: 2520, scaleFactor: 2 }), { width: 3840, height: 2160 }, 'iMac 4.5K');
  assert.deepEqual(captureSizeLimit({ width: 5120, height: 2880, scaleFactor: 2 }), { width: 3840, height: 2160 }, 'Studio Display 5K');
  assert.deepEqual(captureSizeLimit({ width: 6016, height: 3384, scaleFactor: 2 }), { width: 3840, height: 2160 }, 'Pro Display XDR');
  // 5K at 1× (Windows): the same fit.
  assert.deepEqual(captureSizeLimit({ width: 5120, height: 2880, scaleFactor: 1 }), { width: 3840, height: 2160 });
  // 5120-wide ultrawide: limited by width, aspect kept.
  assert.deepEqual(captureSizeLimit({ width: 5120, height: 1440, scaleFactor: 1 }), { width: 3840, height: 1080 });
  assert.deepEqual(captureSizeLimit({ width: 5120, height: 2160, scaleFactor: 1.25 }), { width: 3840, height: 1620 });
  assert.deepEqual(captureSizeLimit({ width: 7680, height: 2160, scaleFactor: 2 }), { width: 3840, height: 1080 });
  // Portrait: the box is 2160×3840.
  assert.deepEqual(captureSizeLimit({ width: 2234, height: 3456, scaleFactor: 2 }), { width: 2160, height: 3340 });
  assert.deepEqual(captureSizeLimit({ width: 2880, height: 5120, scaleFactor: 2 }), { width: 2160, height: 3840 });
  // Odd results round down to even numbers; every result fits the box.
  const r = captureSizeLimit({ width: 5001, height: 3001, scaleFactor: 1 });
  assert.equal(r.width % 2, 0);
  assert.equal(r.height % 2, 0);
  assert.ok(r.width <= 3840 && r.height <= 2160);
  for (let h = 2161; h <= 3840; h++) { // landscape (h ≤ w), fit scale ≥ 0.5625
    const f = captureSizeLimit({ width: 3840, height: h });
    assert.equal(f.height, 2160, `the limiting side is exact (3840×${h})`);
  }
});

test('captureSizeLimit: an exact 2× downsample only when the fit scale is ≤ 0.55', async () => {
  const { captureSizeLimit } = await load();
  // 7000×3900: fit s = 0.5486 → exact half 3500×1950 (fit would be 3840×2138).
  assert.deepEqual(captureSizeLimit({ width: 7000, height: 3900, scaleFactor: 2 }), { width: 3500, height: 1950 });
  // 8K: s = 0.5 → half == fit.
  assert.deepEqual(captureSizeLimit({ width: 7680, height: 4320, scaleFactor: 1 }), { width: 3840, height: 2160 });
  // s = 0.6 (6400×3600): the aspect fit, not the half.
  assert.deepEqual(captureSizeLimit({ width: 6400, height: 3600, scaleFactor: 2 }), { width: 3840, height: 2160 });
  // s < 0.5: the half would not fit → fit.
  assert.deepEqual(captureSizeLimit({ width: 10240, height: 4320, scaleFactor: 2 }), { width: 3840, height: 1620 });
});

test("capped captures as Chromium delivers them still get a reducing, even 'speed' scale", async () => {
  const { captureSizeLimit, speedScaleFor } = await load();
  const displays = [
    [3456, 2234], [4096, 2160], [5120, 2880], [6016, 3384], [5120, 1440], [5120, 2160], [3840, 2400],
    [4480, 2520], [2234, 3456], [7000, 3900], [5001, 3001],
  ];
  for (const [dw, dh] of displays) {
    const box = captureSizeLimit({ width: dw, height: dh });
    assert.ok(box, `${dw}×${dh} is capped`);
    // The box itself is reduced; Chromium may also land a little short of it (aligned to even
    // sizes): never an odd or upscaled result there either.
    for (const [w, h] of [[box.width, box.height], [box.width - 2, box.height], [box.width, box.height - 2], [box.width - 2, box.height - 2]]) {
      const s = speedScaleFor(w, h);
      const tag = `${dw}×${dh} delivered ${w}×${h}: ${s}`;
      if (w === box.width && h === box.height) assert.ok(s >= 1.3, tag);
      if (s === 1) continue;
      for (const [v, side] of [[w / s, w], [h / s, h]]) {
        assert.equal(Math.round(v), Math.floor(v), `${tag} → ${v}`);
        assert.equal(Math.floor(v) % 2, 0, `${tag} → ${v}`);
        assert.ok(v < side, `${tag} → ${v}`);
      }
    }
  }
  // The reviewer's measured sizes.
  for (const [w, h, want] of [[3340, 2158, [1672, 1080]], [3838, 2024, [2048, 1080]], [2561, 1440, [1920, 1080]]]) {
    const s = speedScaleFor(w, h);
    assert.deepEqual([Math.floor(w / s), Math.floor(h / s)], want, `${w}×${h}`);
  }
});

test('presetStartKbps: max bitrate in kbps, capped at 4000', async () => {
  const { presetStartKbps } = await load();
  assert.equal(presetStartKbps('quality'), 4000);
  assert.equal(presetStartKbps('balanced'), 4000);
  assert.equal(presetStartKbps('speed'), 4000);
  assert.equal(presetStartKbps('nope'), 4000);
});
