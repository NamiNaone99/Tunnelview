/*
 * Tunnelview viewer — pointer geometry (pure; unit-tested from Node in test/viewer-geometry.test.js).
 *
 * Wire coordinates (§5) are floats in [0,1] relative to the streamed display. The viewer shows
 * the stream in a <video> element in one of two modes:
 *   - 'fit'      element fills the stage, `object-fit: contain` letterboxes the picture;
 *   - 'original' element is sized to videoWidth/devicePixelRatio CSS px (1 video px = 1 device px)
 *                inside a scrollable stage.
 * In both cases getBoundingClientRect() of the element (which already reflects scroll offsets)
 * plus the contain math below yields the rectangle the picture actually occupies; in 'original'
 * mode the element's aspect ratio equals the video's, so the contain step is the identity.
 */

const PRECISION = 1e5; // 5 decimals ≈ 0.1 px even on a 10k-px-wide display; keeps JSON small

/**
 * Rectangle (client coordinates) covered by a videoW×videoH picture drawn with
 * object-fit: contain inside `box` ({left, top, width, height}). null if unknown/empty.
 */
export function contentRect(box, videoW, videoH) {
  if (!box || !(videoW > 0) || !(videoH > 0) || !(box.width > 0) || !(box.height > 0)) return null;
  // Keep the limiting dimension exact (no float drift) so the picture edges map to exactly 0 / 1.
  const sx = box.width / videoW;
  const sy = box.height / videoH;
  const width = sx <= sy ? box.width : videoW * sy;
  const height = sx <= sy ? videoH * sx : box.height;
  return {
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function round(v) {
  return Math.round(v * PRECISION) / PRECISION;
}

/**
 * Client point → normalized point on the picture. `inside` is false when the point is in the
 * letterbox / outside the picture; x/y are then clamped to the nearest edge.
 */
export function normalizePoint(clientX, clientY, content) {
  if (!content || !(content.width > 0) || !(content.height > 0)) return null;
  const rx = (clientX - content.left) / content.width;
  const ry = (clientY - content.top) / content.height;
  if (!Number.isFinite(rx) || !Number.isFinite(ry)) return null;
  const inside = rx >= 0 && rx <= 1 && ry >= 0 && ry <= 1;
  return { x: round(clamp01(rx)), y: round(clamp01(ry)), inside };
}

/** CSS size that shows the video 1:1 in device pixels ('original' scale mode). */
export function originalCssSize(videoW, videoH, dpr) {
  const r = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  return { width: Math.max(1, Math.round((videoW / r) * 100) / 100), height: Math.max(1, Math.round((videoH / r) * 100) / 100) };
}

/**
 * Edge auto-pan for 'original' mode: when the pointer is within `edge` px of a side of the
 * visible stage `rect`, return a scroll delta (px per frame) towards that side, growing as the
 * pointer gets closer (max `maxStep`). {dx:0, dy:0} otherwise.
 */
export function edgePanDelta(clientX, clientY, rect, edge = 28, maxStep = 22) {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) return { dx: 0, dy: 0 };
  const axis = (p, lo, size) => {
    const fromLo = p - lo;
    const fromHi = lo + size - p;
    if (fromLo < 0 || fromHi < 0) return 0; // pointer outside the stage
    if (fromLo < edge) return -Math.ceil(((edge - fromLo) / edge) * maxStep);
    if (fromHi < edge) return Math.ceil(((edge - fromHi) / edge) * maxStep);
    return 0;
  };
  return { dx: axis(clientX, rect.left, rect.width), dy: axis(clientY, rect.top, rect.height) };
}

/** DOM MouseEvent.button → bit in MouseEvent.buttons (0→1, 1→4, 2→2, 3→8, 4→16). */
export function buttonBit(button) {
  switch (button) {
    case 0: return 1;
    case 1: return 4;
    case 2: return 2;
    case 3: return 8;
    case 4: return 16;
    default: return 0;
  }
}
