'use strict';
/* Unit tests for src/renderer/viewer/geometry.js (ES module, pure). */
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../src/renderer/viewer/geometry.js');

test('contentRect: object-fit contain letterboxing', async () => {
  const { contentRect } = await load();
  // 1920×1080 video in a 1000×1000 box → 1000×562.5, vertically centred
  assert.deepEqual(contentRect({ left: 0, top: 0, width: 1000, height: 1000 }, 1920, 1080),
    { left: 0, top: 218.75, width: 1000, height: 562.5 });
  // 1080×1920 (portrait) in 1000×500 → 281.25×500, horizontally centred, box offset respected
  assert.deepEqual(contentRect({ left: 10, top: 20, width: 1000, height: 500 }, 1080, 1920),
    { left: 10 + (1000 - 281.25) / 2, top: 20, width: 281.25, height: 500 });
  // exact aspect → identity (1:1 mode sizes the element to the video aspect)
  assert.deepEqual(contentRect({ left: -300, top: -50, width: 1280, height: 720 }, 2560, 1440),
    { left: -300, top: -50, width: 1280, height: 720 });
  assert.equal(contentRect({ left: 0, top: 0, width: 100, height: 100 }, 0, 100), null);
  assert.equal(contentRect({ left: 0, top: 0, width: 0, height: 100 }, 10, 10), null);
  assert.equal(contentRect(null, 10, 10), null);
});

test('normalizePoint: inside, letterbox clamping, rounding', async () => {
  const { contentRect, normalizePoint } = await load();
  const c = contentRect({ left: 0, top: 0, width: 1000, height: 1000 }, 1920, 1080);
  assert.deepEqual(normalizePoint(500, 500, c), { x: 0.5, y: 0.5, inside: true });
  assert.deepEqual(normalizePoint(0, 218.75, c), { x: 0, y: 0, inside: true });
  assert.deepEqual(normalizePoint(1000, 781.25, c), { x: 1, y: 1, inside: true });
  // in the top letterbox bar → clamped to the top edge, flagged outside
  assert.deepEqual(normalizePoint(250, 100, c), { x: 0.25, y: 0, inside: false });
  assert.deepEqual(normalizePoint(-20, 900, c), { x: 0, y: 1, inside: false });
  const p = normalizePoint(333.333333, 500, c);
  assert.equal(p.x, 0.33333);
  assert.equal(normalizePoint(1, 1, null), null);
});

test('1:1 mode with scroll offset maps to the right remote pixel', async () => {
  const { contentRect, normalizePoint, originalCssSize } = await load();
  // 3840×2160 remote, dpr 2 → element 1920×1080 CSS px; stage scrolled by (400, 300) → rect starts at (-400,-300)
  const size = originalCssSize(3840, 2160, 2);
  assert.deepEqual(size, { width: 1920, height: 1080 });
  const rect = contentRect({ left: -400, top: -300, width: size.width, height: size.height }, 3840, 2160);
  const p = normalizePoint(560, 240, rect); // client point
  // remote px = ((560 + 400) * 2, (240 + 300) * 2) = (1920, 1080) → exactly the centre
  assert.deepEqual(p, { x: 0.5, y: 0.5, inside: true });
});

test('originalCssSize: devicePixelRatio handling', async () => {
  const { originalCssSize } = await load();
  assert.deepEqual(originalCssSize(1920, 1080, 1), { width: 1920, height: 1080 });
  assert.deepEqual(originalCssSize(1920, 1080, 1.5), { width: 1280, height: 720 });
  assert.deepEqual(originalCssSize(1920, 1080, 0), { width: 1920, height: 1080 });
  assert.deepEqual(originalCssSize(1920, 1080, NaN), { width: 1920, height: 1080 });
});

test('edgePanDelta: pans towards the nearest edge, faster when closer', async () => {
  const { edgePanDelta } = await load();
  const r = { left: 0, top: 0, width: 1000, height: 800 };
  assert.deepEqual(edgePanDelta(500, 400, r), { dx: 0, dy: 0 });
  const near = edgePanDelta(2, 400, r);
  const far = edgePanDelta(20, 400, r);
  assert.ok(near.dx < far.dx && far.dx < 0, 'left edge → negative dx, closer = faster');
  assert.ok(edgePanDelta(999, 400, r).dx > 0);
  assert.ok(edgePanDelta(500, 799, r).dy > 0);
  assert.ok(edgePanDelta(500, 1, r).dy < 0);
  assert.deepEqual(edgePanDelta(-5, 400, r), { dx: 0, dy: 0 }); // outside the stage: no pan
  assert.deepEqual(edgePanDelta(1, 1, null), { dx: 0, dy: 0 });
});

test('buttonBit maps DOM button → MouseEvent.buttons bit', async () => {
  const { buttonBit } = await load();
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(buttonBit), [1, 4, 2, 8, 16, 0]);
});
