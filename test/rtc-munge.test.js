'use strict';
/* src/renderer/shared/rtc.js mungeAnswerForSend — x-google-start-bitrate + Opus stereo on the applied answer. */
const test = require('node:test');
const assert = require('node:assert/strict');

globalThis.TunnelviewProtocol = require('../src/shared/protocol');

const load = () => import('../src/renderer/shared/rtc.js');

// Representative Chromium answer: recvonly video (H264 ×2, VP8 without fmtp, VP9, AV1, rtx, red,
// ulpfec) + recvonly audio (Opus) + data channel.
const ANSWER = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1 2',
  'a=msid-semantic: WMS',
  'm=video 9 UDP/TLS/RTP/SAVPF 102 103 104 105 96 97 98 99 45 46 116 117 118',
  'c=IN IP4 0.0.0.0',
  'a=rtcp:9 IN IP4 0.0.0.0',
  'a=ice-ufrag:abcd',
  'a=mid:0',
  'a=recvonly',
  'a=rtcp-mux',
  'a=rtpmap:102 H264/90000',
  'a=rtcp-fb:102 nack pli',
  'a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f',
  'a=rtpmap:103 rtx/90000',
  'a=fmtp:103 apt=102',
  'a=rtpmap:104 H264/90000',
  'a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f',
  'a=rtpmap:105 rtx/90000',
  'a=fmtp:105 apt=104',
  'a=rtpmap:96 VP8/90000',
  'a=rtcp-fb:96 nack',
  'a=rtpmap:97 rtx/90000',
  'a=fmtp:97 apt=96',
  'a=rtpmap:98 VP9/90000',
  'a=fmtp:98 profile-id=0',
  'a=rtpmap:99 rtx/90000',
  'a=fmtp:99 apt=98',
  'a=rtpmap:45 AV1/90000',
  'a=fmtp:45 level-idx=5;profile=0;tier=0',
  'a=rtpmap:46 rtx/90000',
  'a=fmtp:46 apt=45',
  'a=rtpmap:116 red/90000',
  'a=rtpmap:117 rtx/90000',
  'a=fmtp:117 apt=116',
  'a=rtpmap:118 ulpfec/90000',
  'm=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  'a=recvonly',
  'a=rtpmap:111 opus/48000/2',
  'a=rtcp-fb:111 transport-cc',
  'a=fmtp:111 minptime=10;useinbandfec=1',
  'a=rtpmap:63 red/48000/2',
  'a=fmtp:63 111/111',
  'a=rtpmap:9 G722/8000',
  'a=rtpmap:0 PCMU/8000',
  'a=rtpmap:8 PCMA/8000',
  'a=rtpmap:13 CN/8000',
  'a=rtpmap:110 telephone-event/48000',
  'a=rtpmap:126 telephone-event/8000',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=mid:2',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
  '',
].join('\r\n');

const lines = (s) => s.split('\r\n');
const fmtp = (s, pt) => lines(s).filter((l) => l.startsWith(`a=fmtp:${pt} `));

test('start bitrate on every H264/VP8/VP9/AV1 payload, never on rtx/red/ulpfec', async () => {
  const { mungeAnswerForSend } = await load();
  const out = mungeAnswerForSend(ANSWER, { startKbps: 4000 });
  assert.deepEqual(fmtp(out, 102), ['a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f;x-google-start-bitrate=4000']);
  assert.deepEqual(fmtp(out, 104), ['a=fmtp:104 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f;x-google-start-bitrate=4000']);
  assert.deepEqual(fmtp(out, 98), ['a=fmtp:98 profile-id=0;x-google-start-bitrate=4000']);
  assert.deepEqual(fmtp(out, 45), ['a=fmtp:45 level-idx=5;profile=0;tier=0;x-google-start-bitrate=4000']);
  // VP8 had no fmtp line: one is inserted right after its rtpmap.
  const l = lines(out);
  assert.equal(l[l.indexOf('a=rtpmap:96 VP8/90000') + 1], 'a=fmtp:96 x-google-start-bitrate=4000');
  for (const pt of [103, 105, 97, 99, 46, 117]) assert.ok(!fmtp(out, pt)[0].includes('x-google'), `pt ${pt}`);
  assert.equal(fmtp(out, 116).length, 0, 'red gets no fmtp');
  assert.equal(fmtp(out, 118).length, 0, 'ulpfec gets no fmtp');
  // Audio untouched without opusStereo.
  assert.deepEqual(fmtp(out, 111), ['a=fmtp:111 minptime=10;useinbandfec=1']);
  // CRLF preserved, trailing empty line kept, nothing else changed.
  assert.ok(out.endsWith('\r\n'));
  assert.ok(!/[^\r]\n/.test(out));
  assert.equal(lines(out).length, lines(ANSWER).length + 1);
});

test('opusStereo: stereo=1;maxaveragebitrate=128000 on Opus only', async () => {
  const { mungeAnswerForSend } = await load();
  const out = mungeAnswerForSend(ANSWER, { startKbps: 4000, opusStereo: true });
  assert.deepEqual(fmtp(out, 111), ['a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;maxaveragebitrate=128000']);
  assert.deepEqual(fmtp(out, 63), ['a=fmtp:63 111/111']);
  const audioOnly = mungeAnswerForSend(ANSWER, { opusStereo: true });
  assert.ok(!audioOnly.includes('x-google-start-bitrate'));
  assert.ok(audioOnly.includes('useinbandfec=1;stereo=1;maxaveragebitrate=128000'));
});

test('keys already present are not duplicated; munging is idempotent', async () => {
  const { mungeAnswerForSend } = await load();
  const pre = ANSWER
    .replace('a=fmtp:111 minptime=10;useinbandfec=1', 'a=fmtp:111 minptime=10;stereo=0;useinbandfec=1')
    .replace('a=fmtp:98 profile-id=0', 'a=fmtp:98 profile-id=0;x-google-start-bitrate=1000');
  const out = mungeAnswerForSend(pre, { startKbps: 4000, opusStereo: true });
  assert.deepEqual(fmtp(out, 111), ['a=fmtp:111 minptime=10;stereo=0;useinbandfec=1;maxaveragebitrate=128000']);
  assert.deepEqual(fmtp(out, 98), ['a=fmtp:98 profile-id=0;x-google-start-bitrate=1000']);
  const twice = mungeAnswerForSend(out, { startKbps: 4000, opusStereo: true });
  assert.equal(twice, out);
});

test('LF-only SDP keeps LF; no-op options and non-strings pass through', async () => {
  const { mungeAnswerForSend } = await load();
  const lf = ANSWER.replace(/\r\n/g, '\n');
  const out = mungeAnswerForSend(lf, { startKbps: 2500 });
  assert.ok(!out.includes('\r'));
  assert.ok(out.includes('a=fmtp:96 x-google-start-bitrate=2500'));
  assert.equal(mungeAnswerForSend(ANSWER, {}), ANSWER);
  assert.equal(mungeAnswerForSend(ANSWER, { startKbps: 0 }), ANSWER);
  assert.equal(mungeAnswerForSend(null, { startKbps: 4000 }), null);
  assert.equal(mungeAnswerForSend('', { startKbps: 4000 }), '');
});

/* ------------------------------------------------------------- 'speed' preset scale */

const encoded = (w, h, s) => [Math.round(w / s), Math.round(h / s)];

test('speedScaleFor: an even encoded size (2560×1440 → 1920×1080, not the odd 1707×960)', async () => {
  const { speedScaleFor } = await load();
  assert.equal(speedScaleFor(2560, 1440), 4 / 3);
  assert.deepEqual(encoded(2560, 1440, speedScaleFor(2560, 1440)), [1920, 1080]);
  assert.equal(speedScaleFor(1920, 1080), 1.5);
  assert.deepEqual(encoded(1920, 1080, 1.5), [1280, 720]);
  assert.equal(speedScaleFor(3840, 2160), 1.5);
  assert.deepEqual(encoded(3840, 2160, 1.5), [2560, 1440]);
  // 16:10: 1080 lines, 1728 wide (a multiple of 8).
  assert.deepEqual(encoded(2560, 1600, speedScaleFor(2560, 1600)), [1728, 1080]);
  // 1366×768: 540 lines would be 960.47 wide and 683×384 is odd → no scaling.
  assert.equal(speedScaleFor(1366, 768), 1);
  // A capped 16" MacBook Pro capture: 1080 lines, 1670 wide exactly.
  assert.equal(speedScaleFor(3340, 2160), 2);
  // 14" MacBook Pro: no exact target; 900 lines with the long side rounded to 1386 (+0.02 % aspect).
  assert.deepEqual(encoded(3024, 1964, speedScaleFor(3024, 1964)), [1386, 900]);
  // Portrait: the short side gets the target.
  assert.deepEqual(encoded(1080, 1920, speedScaleFor(1080, 1920)), [720, 1280]);
  // Unknown size → the preset's default.
  for (const bad of [[0, 1080], [NaN, 1080], [1920.5, 1080], [undefined, undefined], ['x', 1]]) {
    assert.equal(speedScaleFor(...bad), 2, String(bad));
  }
});

const SPEED_TARGETS = [1440, 1080, 900, 720, 540];

/** An even w×h and its speedScaleFor(): even, non-upscaled, rounding = truncation, a real reduction. */
function assertSpeedScale(w, h, s) {
  const tag = `${w}×${h}: ${s}`;
  assert.ok(Number.isFinite(s) && s >= 1, tag);
  if (s === 1) return;
  for (const [v, side] of [[w / s, w], [h / s, h]]) {
    const n = Math.round(v);
    assert.equal(n % 2, 0, `${tag} → ${v}`);
    assert.equal(Math.trunc(v), n, `${tag} → ${v} must not sit just below the integer`);
    assert.ok(n > 0 && n < side, `${tag} → ${v} not reduced`);
  }
  const short = Math.min(w, h);
  const scaledShort = Math.round(short / s);
  if (s === 2) {
    assert.equal(scaledShort, short / 2, tag);
  } else {
    // The short side lands exactly on a target that is at most short / 1.3.
    assert.ok(SPEED_TARGETS.includes(scaledShort), `${tag} → short side ${scaledShort}`);
    assert.ok(scaledShort <= short / 1.3, `${tag} → short side ${scaledShort}`);
  }
}

test('speedScaleFor: even (exact even integers, also when truncated) for every common height', async () => {
  const { speedScaleFor } = await load();
  for (let w = 640; w <= 3840; w += 2) {
    for (const h of [480, 600, 720, 768, 800, 900, 960, 982, 1024, 1050, 1080, 1200, 1440, 1600, 1964, 2024, 2158, 2160]) {
      assertSpeedScale(w, h, speedScaleFor(w, h));
      assertSpeedScale(h, w, speedScaleFor(h, w)); // portrait
    }
  }
});

test('speedScaleFor: coarse sweep of even sizes 640–3840 × 480–2160 is even and never upscaled', async () => {
  const { speedScaleFor } = await load();
  let scaled = 0;
  let total = 0;
  for (let w = 640; w <= 3840; w += 6) {
    for (let h = 480; h <= 2160; h += 4) {
      const s = speedScaleFor(w, h);
      assertSpeedScale(w, h, s);
      total += 1;
      if (s > 1) scaled += 1;
    }
  }
  // Sanity: most sizes are reduced (an even-size rule that gave up everywhere would also "pass").
  assert.ok(scaled / total > 0.6, `${scaled}/${total}`);
});

test('speedScaleFor: an odd (transient) size is floored to even: 2561×1440 → 4/3 like 2560×1440', async () => {
  const { speedScaleFor } = await load();
  assert.equal(speedScaleFor(2561, 1440), 4 / 3);
  assert.equal(speedScaleFor(2560, 1441), 4 / 3);
  assert.equal(speedScaleFor(1921, 1081), 1.5);
  assert.equal(speedScaleFor(3841, 2161), 1.5);
  // The exact results for even sizes are unchanged.
  assert.equal(speedScaleFor(2560, 1440), 4 / 3);
  assert.equal(speedScaleFor(1920, 1080), 1.5);
  assert.equal(speedScaleFor(3840, 2160), 1.5);
  // Degenerate sides: nothing to scale (never 0 / NaN).
  assert.equal(speedScaleFor(1, 4), 1);
  assert.equal(speedScaleFor(4, 1), 1);
  assert.equal(speedScaleFor(1, 1), 1);
  // Always exactly the scale of the even size below: a transient odd report followed by the even
  // size it settles at must not change the scale (the host keys its re-derivation on the even size).
  for (let w = 641; w <= 3841; w += 10) {
    for (const h of [481, 721, 1079, 1081, 1441, 2159]) {
      const s = speedScaleFor(w, h);
      assert.equal(s, speedScaleFor(w - 1, h - 1), `${w}×${h}`);
      assert.equal(s, speedScaleFor(w, h - 1), `${w}×${h}`);
      assert.equal(s, speedScaleFor(w - 1, h), `${w}×${h}`);
      assert.ok(Math.floor(w / s) <= w && Math.floor(h / s) <= h, `${w}×${h}: ${s}`);
    }
  }
  const s = speedScaleFor(2561, 1440);
  assert.deepEqual([Math.floor(2561 / s), Math.floor(1440 / s)], [1920, 1080]);
});

test('speedScaleFor: capped near-aspect captures (16" MacBook Pro, DCI 4K) are reduced to an even size', async () => {
  const { speedScaleFor } = await load();
  // Exact targets do not fit these aspect ratios: nearest even long side within 0.2 % aspect error.
  assert.deepEqual(encoded(3340, 2158, speedScaleFor(3340, 2158)), [1672, 1080]);
  assert.deepEqual(encoded(3838, 2024, speedScaleFor(3838, 2024)), [2048, 1080]);
  assert.deepEqual(encoded(2158, 3340, speedScaleFor(2158, 3340)), [1080, 1672], 'portrait');
  assert.deepEqual(encoded(3340, 2160, speedScaleFor(3340, 2160)), [1670, 1080]);
  for (const [w, h] of [[3340, 2158], [3340, 2159], [3838, 2024], [3340, 2160]]) {
    const s = speedScaleFor(w, h);
    assert.ok(s >= 1.5, `${w}×${h}: Fast must reduce (${s})`);
    for (const [v, max] of [[Math.floor(w / s), w], [Math.floor(h / s), h]]) {
      assert.equal(v % 2, 0, `${w}×${h} → ${v}`);
      assert.ok(v <= max, `${w}×${h} → ${v}`);
    }
  }
  for (const [w, h] of [[3340, 2158], [3838, 2024], [3340, 2160]]) {
    const s = speedScaleFor(w, h);
    const [W, H] = encoded(w, h, s);
    assert.ok(Math.abs(W / H - w / h) / (w / h) < 0.002, `${w}×${h} → ${W}×${H}`);
    assertSpeedScale(w, h, s);
  }
});

test("presetEncoding('speed') starts at scale 2 until the capture size is known", async () => {
  const { presetEncoding, PRESETS } = await load();
  assert.deepEqual(presetEncoding('speed'), { maxBitrate: 4_000_000, maxFramerate: 60, scaleResolutionDownBy: 2 });
  assert.equal(PRESETS.balanced.scaleResolutionDownBy, 1);
  assert.equal(PRESETS.quality.scaleResolutionDownBy, 1);
});

function fakeSender() {
  const sender = {
    track: { kind: 'video', contentHint: '' },
    sets: [],
    getParameters: () => ({ transactionId: 't', encodings: [{ active: true }] }),
    setParameters: async (p) => { sender.sets.push(p); },
  };
  return sender;
}

test('applyPreset: opts.scaleResolutionDownBy overrides the preset scale (finite, ≥ 1 only)', async () => {
  const { applyPreset } = await load();
  const s = fakeSender();
  assert.equal(await applyPreset(s, 'speed', { scaleResolutionDownBy: 4 / 3 }), true);
  assert.deepEqual(s.sets[0].encodings, [{ active: true, maxBitrate: 4_000_000, maxFramerate: 60, scaleResolutionDownBy: 4 / 3 }]);
  assert.equal(s.sets[0].degradationPreference, 'maintain-framerate');
  assert.equal(s.track.contentHint, 'motion');
  await applyPreset(s, 'speed');
  assert.equal(s.sets[1].encodings[0].scaleResolutionDownBy, 2);
  for (const bad of [0.5, NaN, '1.5x', null]) {
    await applyPreset(s, 'speed', { scaleResolutionDownBy: bad });
    assert.equal(s.sets.at(-1).encodings[0].scaleResolutionDownBy, 2, String(bad));
  }
  await applyPreset(s, 'balanced', null);
  assert.equal(s.sets.at(-1).encodings[0].scaleResolutionDownBy, 1);
});

test('start bitrate is scoped to video sections (an audio "VP8" payload is left alone)', async () => {
  const { mungeAnswerForSend } = await load();
  const weird = ['v=0', 'm=audio 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000', 'm=video 9 UDP/TLS/RTP/SAVPF 96', 'a=rtpmap:96 VP8/90000', ''].join('\r\n');
  const out = mungeAnswerForSend(weird, { startKbps: 3000 });
  assert.equal(lines(out).filter((l) => l.startsWith('a=fmtp:96')).length, 1);
  assert.equal(lines(out)[5], 'a=fmtp:96 x-google-start-bitrate=3000');
});
