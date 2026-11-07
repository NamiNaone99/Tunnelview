'use strict';
/*
 * Tunnelview icon art — pure Node (no Electron import). Contract: docs/ARCHITECTURE.md §7.
 *
 *   drawAppIcon(size[, { style }])                    → { width, height, data }  RGBA, straight alpha
 *   drawTrayIcon(size, { template, state[, theme] })  → { width, height, data }
 *   encodePNG({ width, height, data })                → Buffer (PNG, RGBA 8-bit, filter 0)
 *
 * Used at runtime by src/main/icons.js (nativeImage) and at build time by scripts/make-icons.js.
 *
 * Rendering model
 *   Every shape is a signed distance function (SDF) evaluated at pixel centres in device pixels
 *   (negative = inside). Coverage = clamp(0.5 − d, 0, 1) is an analytic ~1 px box-filter
 *   anti-alias that stays crisp at 16 px and smooth at 1024 px — no supersampling needed. Soft
 *   effects (drop shadow) widen that ramp. Layers are composited "source-over" in premultiplied
 *   Float32 and converted to 8-bit straight alpha with a tiny ordered dither (kills gradient
 *   banding at 1024 px; never changes pure black/white or alpha).
 *   At small sizes the art switches to simplified variants with edges snapped to whole pixels
 *   (manual "hinting"), because a downscaled 1024 px drawing turns to mush at 16 px.
 *
 * App icon styles
 *   'macos' — Big Sur+ icon grid: 824/1024 body centred with a soft drop shadow (macOS applies no
 *             mask of its own, so the margin is part of the art). Used for build/icon.png → .icns.
 *   'full'  — near full-bleed body for Windows / Linux / tiny sizes (taskbar, .ico, window icons).
 *   Default: 'macos' on darwin, otherwise 'full'.
 *
 * Tray icon states (documented choice)
 *   non-template: white glyph (or near-black with theme:'light') + status dot in the corner:
 *     idle   → green dot  (host is listening on the tailnet, ready)
 *     active → red dot    (an incoming session is live — "recording light"), screen drawn filled
 *     off    → grey dot   (hosting disabled or Tailscale down), glyph dimmed
 *   template (macOS menu bar; black + alpha only, the system tints it): no colour is possible, so
 *     the state is encoded in the shape instead: idle = outline screen, active = filled screen,
 *     off = outline at reduced opacity.
 */
const zlib = require('node:zlib');

/* ------------------------------------------------------------------------------------------ */
/* math helpers                                                                                */
/* ------------------------------------------------------------------------------------------ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/** '#rrggbb' → [r, g, b, a] floats 0..1 (sRGB, straight alpha). */
function rgb(hex, alpha = 1) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha];
}

function mixColor(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];
}

/** stops: [[t, color], …] sorted by t. */
function sampleStops(stops, t) {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    const [t1, c1] = stops[i];
    if (t <= t1) {
      const [t0, c0] = stops[i - 1];
      return mixColor(c0, c1, (t - t0) / (t1 - t0 || 1));
    }
  }
  return stops[stops.length - 1][1];
}

function linearGradient(x0, y0, x1, y1, stops) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy || 1;
  return (x, y) => sampleStops(stops, clamp01(((x - x0) * dx + (y - y0) * dy) / len2));
}

function radialGradient(cx, cy, radius, stops) {
  return (x, y) => sampleStops(stops, clamp01(Math.hypot(x - cx, y - cy) / radius));
}

/* ------------------------------------------------------------------------------------------ */
/* signed distance functions (pixel space, negative inside)                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * Rounded rectangle [x0,x1]×[y0,y1] with corner radius r. With n > 2 the corners are
 * superellipse arcs (|x|^n + |y|^n = r^n) that meet the straight sides with zero curvature —
 * the "continuous corner" squircle look of macOS / iOS icons. The Lⁿ distance is converted to an
 * approximately Euclidean one by dividing by its gradient magnitude (first-order distance
 * estimate), which keeps the anti-aliasing ramp 1 px wide along the whole outline.
 */
function sdRoundRect(x0, y0, x1, y1, r, n = 2) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const rr = Math.max(0, Math.min(r, (x1 - x0) / 2, (y1 - y0) / 2));
  const hx = (x1 - x0) / 2 - rr;
  const hy = (y1 - y0) / 2 - rr;
  return (px, py) => {
    const qx = Math.abs(px - cx) - hx;
    const qy = Math.abs(py - cy) - hy;
    if (qx > 0 && qy > 0) {
      if (n === 2) return Math.hypot(qx, qy) - rr;
      const m = Math.pow(Math.pow(qx, n) + Math.pow(qy, n), 1 / n);
      const g = Math.hypot(Math.pow(qx, n - 1), Math.pow(qy, n - 1)) / Math.pow(m, n - 1);
      return (m - rr) / (g || 1);
    }
    return Math.max(qx, qy) - rr;
  };
}

function sdCircle(cx, cy, r) {
  return (px, py) => Math.hypot(px - cx, py - cy) - r;
}

/** Exact signed distance to a simple polygon (pts = [[x,y], …]); r > 0 rounds every corner. */
function sdPolygon(pts, r = 0) {
  const n = pts.length;
  return (px, py) => {
    let d = Infinity;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      const ex = xj - xi;
      const ey = yj - yi;
      const wx = px - xi;
      const wy = py - yi;
      const t = clamp01((wx * ex + wy * ey) / (ex * ex + ey * ey || 1));
      const bx = wx - ex * t;
      const by = wy - ey * t;
      d = Math.min(d, bx * bx + by * by);
      // even-odd crossing test
      if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return (inside ? -Math.sqrt(d) : Math.sqrt(d)) - r;
  };
}

const sdUnion = (...fs) => (x, y) => {
  let d = Infinity;
  for (const f of fs) d = Math.min(d, f(x, y));
  return d;
};
const sdSubtract = (a, b) => (x, y) => Math.max(a(x, y), -b(x, y));
/** Band of width w just inside the outline of f (an inner border). */
const sdInnerStroke = (f, w) => (x, y) => {
  const d = f(x, y);
  return Math.max(d, -(d + w));
};
const sdOffset = (f, dx, dy) => (x, y) => f(x - dx, y - dy);
const sdGrow = (f, g) => (x, y) => f(x, y) - g;

/* ------------------------------------------------------------------------------------------ */
/* raster                                                                                      */
/* ------------------------------------------------------------------------------------------ */

class Raster {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.px = new Float32Array(width * height * 4); // premultiplied RGBA
  }

  /**
   * Paint shape `sdf` with `paint` ([r,g,b,a] or (x,y) → [r,g,b,a]).
   * opts.bbox [x0,y0,x1,y1] limits the scan (pure optimisation), opts.soft widens the edge ramp
   * to ±soft px (shadows), opts.opacity scales alpha, opts.mode 'over' | 'erase'
   * (destination-out: punches transparent holes, used for the tray status-dot gap).
   */
  fill(sdf, paint, opts = {}) {
    const { bbox = null, soft = 0, opacity = 1, mode = 'over' } = opts;
    const { width: w, height: h, px } = this;
    const pad = 1 + soft;
    let x0 = 0;
    let y0 = 0;
    let x1 = w;
    let y1 = h;
    if (bbox) {
      x0 = Math.max(0, Math.floor(bbox[0] - pad));
      y0 = Math.max(0, Math.floor(bbox[1] - pad));
      x1 = Math.min(w, Math.ceil(bbox[2] + pad));
      y1 = Math.min(h, Math.ceil(bbox[3] + pad));
    }
    const isFn = typeof paint === 'function';
    for (let y = y0; y < y1; y++) {
      const cy = y + 0.5;
      for (let x = x0; x < x1; x++) {
        const cx = x + 0.5;
        const d = sdf(cx, cy);
        const cov = soft > 0 ? smoothstep(soft, -soft, d) : clamp01(0.5 - d);
        if (cov <= 0) continue;
        const c = isFn ? paint(cx, cy) : paint;
        const a = c[3] * cov * opacity;
        if (a <= 0) continue;
        const i = (y * w + x) * 4;
        const k = 1 - a;
        if (mode === 'erase') {
          px[i] *= k;
          px[i + 1] *= k;
          px[i + 2] *= k;
          px[i + 3] *= k;
        } else {
          px[i] = c[0] * a + px[i] * k;
          px[i + 1] = c[1] * a + px[i + 1] * k;
          px[i + 2] = c[2] * a + px[i + 2] * k;
          px[i + 3] = a + px[i + 3] * k;
        }
      }
    }
  }

  /** → { width, height, data: Buffer } RGBA 8-bit, straight (un-premultiplied) alpha. */
  toImage({ dither = true } = {}) {
    const { width: w, height: h, px } = this;
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const a = px[i + 3];
        if (a <= 1 / 512) continue; // fully transparent → 0,0,0,0
        // 4×4 Bayer offset in [-0.5, 0.5): ±½ LSB, so exact 0 and 255 never move.
        const t = dither ? BAYER4[(y & 3) * 4 + (x & 3)] : 0;
        for (let c = 0; c < 3; c++) {
          const v = Math.round((px[i + c] / a) * 255 + t);
          out[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
        }
        const av = Math.round(a * 255);
        out[i + 3] = av > 255 ? 255 : av;
      }
    }
    return { width: w, height: h, data: out };
  }
}

const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);

function validateSize(size, name) {
  if (!Number.isInteger(size) || size < 8 || size > 2048) {
    throw new RangeError(`${name}: size must be an integer between 8 and 2048 (got ${size})`);
  }
  return size;
}

/* ------------------------------------------------------------------------------------------ */
/* palette (matches src/renderer/shared/theme.css accent #5b8cff)                              */
/* ------------------------------------------------------------------------------------------ */

const COLORS = Object.freeze({
  bgTop: rgb('#6c9cff'), // a touch brighter than the UI accent #5b8cff
  bgMid: rgb('#4c6ef2'),
  bgBottom: rgb('#3a2fb8'), // deep indigo
  displayTop: rgb('#24318f'),
  displayBottom: rgb('#3446c7'),
  white: rgb('#ffffff'),
  black: rgb('#000000'),
  ink: rgb('#1d2230'), // tray glyph on light taskbars
  shadow: rgb('#0b1033'),
  dotIdle: rgb('#34c77b'), // theme --ok
  dotActive: rgb('#ff4d4d'), // theme --danger, slightly deeper for small sizes
  dotOff: rgb('#9aa3b5'),
});

/* ------------------------------------------------------------------------------------------ */
/* app icon                                                                                    */
/* ------------------------------------------------------------------------------------------ */

/**
 * @param {number} size  output edge in px (8…2048)
 * @param {{style?: 'macos'|'full'}} [opts]
 * @returns {{width:number, height:number, data:Buffer}} RGBA, straight alpha
 */
function drawAppIcon(size, opts = {}) {
  validateSize(size, 'drawAppIcon');
  const style = opts && (opts.style === 'macos' || opts.style === 'full')
    ? opts.style
    : process.platform === 'darwin' ? 'macos' : 'full';
  const R = new Raster(size, size);

  // ---- body placement (px) ----
  let inset;
  if (style === 'macos') {
    inset = size * (100 / 1024); // Apple icon grid: 824 px body on a 1024 px canvas
    if (size < 256) inset = Math.round(inset); // whole-pixel edges at small sizes
  } else {
    inset = size < 24 ? 0 : Math.round(size / 32); // Windows icons run nearly full-bleed
  }
  const S = size - 2 * inset; // body edge length in px
  const bx = inset;
  const by = inset;
  const X = (u) => bx + u * S;
  const Y = (v) => by + v * S;
  const snap = S < 64 ? Math.round : (v) => v; // pixel-grid snapping for small renders
  const SX = (u) => snap(X(u));
  const SY = (v) => snap(Y(v));

  // Squircle body: continuous corners (superellipse n=4). Radius tuned to read like the
  // Big Sur template at large sizes; relatively a bit smaller at tiny sizes so the
  // silhouette doesn't turn into a circle.
  const bodyR = S * (S < 24 ? 0.25 : 0.3);
  const body = sdRoundRect(bx, by, bx + S, by + S, bodyR, S < 24 ? 2 : 4);
  const bodyBox = [bx, by, bx + S, by + S];

  if (style === 'macos' && size >= 32) {
    // Soft drop shadow inside the grid margin (two layers: contact + ambient).
    R.fill(sdOffset(body, 0, S * 0.012), rgb('#000000', 0.22), { soft: S * 0.018, bbox: bodyBox });
    R.fill(sdOffset(body, 0, S * 0.03), rgb('#000000', 0.16), { soft: S * 0.05, bbox: bodyBox });
  }

  const level = S < 24 ? 'tiny' : S < 64 ? 'small' : 'full';
  const gradient = linearGradient(X(0.2), Y(0), X(0.8), Y(1), [
    [0, COLORS.bgTop],
    [0.5, COLORS.bgMid],
    [1, COLORS.bgBottom],
  ]);
  // Top sheen (large renders only), folded into one opaque body paint so the gap drawn around
  // the front monitor can repaint exactly the same colour.
  const sheen = level === 'full'
    ? radialGradient(X(0.5), Y(-0.25), S * 0.95, [
      [0, rgb('#ffffff', 0.26)],
      [0.55, rgb('#ffffff', 0.08)],
      [1, rgb('#ffffff', 0)],
    ])
    : null;
  const bg = sheen
    ? (x, y) => {
      const c = gradient(x, y);
      const s = sheen(x, y);
      return [lerp(c[0], s[0], s[3]), lerp(c[1], s[1], s[3]), lerp(c[2], s[2], s[3]), 1];
    }
    : gradient;
  R.fill(body, bg, { bbox: bodyBox });
  if (level === 'full') {
    // Hairline inner rim for depth.
    R.fill(sdInnerStroke(body, Math.max(1, S * 0.006)), rgb('#ffffff', 0.16), { bbox: bodyBox });
  }

  if (level === 'tiny') drawTinyGlyph(R, S, SX, SY, bg);
  else drawMonitorGlyph(R, S, level, X, Y, SX, SY, bg);

  return R.toImage();
}

/**
 * Two-screen glyph (≥ 24 px body): a translucent "remote" screen behind, separated by a
 * background-coloured gap from the front monitor (white bezel, deep display, white pointer).
 */
function drawMonitorGlyph(R, S, level, X, Y, SX, SY, bg) {
  const small = level === 'small';
  const P = small ? SX : X;
  const Q = small ? SY : Y;

  // Front monitor frame.
  const f = { x0: P(0.165), y0: Q(0.335), x1: P(0.715), y1: Q(0.695) };
  const frameR = S * 0.06;
  const front = sdRoundRect(f.x0, f.y0, f.x1, f.y1, frameR, 2);
  const frontBox = [f.x0, f.y0, f.x1, f.y1];

  // Back ("remote") screen, up and to the right.
  const b = { x0: P(0.385), y0: Q(0.185), x1: P(0.845), y1: Q(0.535) };
  const back = sdRoundRect(b.x0, b.y0, b.x1, b.y1, S * 0.055, 2);
  R.fill(back, rgb('#ffffff', small ? 0.5 : 0.42), { bbox: [b.x0, b.y0, b.x1, b.y1] });
  if (!small) {
    // Brighter top edge on the back screen so it reads as a device, not a smudge.
    R.fill(sdInnerStroke(back, Math.max(1, S * 0.012)), rgb('#ffffff', 0.35), { bbox: [b.x0, b.y0, b.x1, b.y1] });
  }

  // Gap: repaint the background around the front monitor (keeps the body opaque, unlike erase).
  const gap = Math.max(1, S * (small ? 0.045 : 0.032));
  R.fill(sdGrow(front, gap), bg, { bbox: [f.x0 - gap, f.y0 - gap, f.x1 + gap, f.y1 + gap] });

  // Stand: neck + foot.
  const cx = (f.x0 + f.x1) / 2;
  const neckW = small ? Math.max(2, Math.round(S * 0.09)) : S * 0.085;
  const neckX0 = small ? Math.round(cx - neckW / 2) : cx - neckW / 2;
  const footY0 = small ? SY(0.765) : Y(0.762);
  const footH = small ? Math.max(2, Math.round(S * 0.05)) : S * 0.046;
  const footW = S * 0.3;
  const footX0 = small ? Math.round(cx - footW / 2) : cx - footW / 2;
  const footX1 = small ? footX0 + Math.round(footW) : cx + footW / 2;
  const neck = sdRoundRect(neckX0, f.y1 - S * 0.02, neckX0 + neckW, footY0 + footH / 2, 0, 2);
  const foot = sdRoundRect(footX0, footY0, footX1, footY0 + footH, footH / 2, 2);
  R.fill(sdUnion(neck, foot), COLORS.white, { bbox: [footX0, f.y1 - S * 0.02, footX1, footY0 + footH] });

  // Frame (white) and display (deep blue gradient).
  R.fill(front, COLORS.white, { bbox: frontBox });
  const bezel = small ? Math.max(2, Math.round(S * 0.05)) : S * 0.042;
  const d = { x0: f.x0 + bezel, y0: f.y0 + bezel, x1: f.x1 - bezel, y1: f.y1 - bezel };
  const display = sdRoundRect(d.x0, d.y0, d.x1, d.y1, Math.max(0.5, frameR - bezel * 0.85), 2);
  R.fill(display, linearGradient(0, d.y0, 0, d.y1, [[0, COLORS.displayTop], [1, COLORS.displayBottom]]), {
    bbox: [d.x0, d.y0, d.x1, d.y1],
  });
  if (!small) {
    // Faint glass reflection across the upper display.
    const glass = sdSubtract(display, sdPolygon([[d.x0, d.y1], [d.x1, d.y0 + (d.y1 - d.y0) * 0.15], [d.x1, d.y1]]));
    R.fill(glass, rgb('#ffffff', 0.06), { bbox: [d.x0, d.y0, d.x1, d.y1] });
  }

  // Mouse pointer inside the display.
  if (small) {
    // Hinted: whole-pixel tip and height so the vertical left edge lands on the pixel grid.
    const h = Math.max(4, Math.round((d.y1 - d.y0) * 0.8));
    const tipX = Math.round(d.x0 + (d.x1 - d.x0) * 0.38);
    const tipY = Math.round(d.y0 + (d.y1 - d.y0 - h) / 2);
    R.fill(pixelPointer(tipX, tipY, h), COLORS.white, { bbox: [tipX - 1, tipY - 1, tipX + h, tipY + h + 1] });
    return;
  }
  const h = (d.y1 - d.y0) * 0.7;
  const tipX = d.x0 + (d.x1 - d.x0) * 0.4;
  const tipY = d.y0 + (d.y1 - d.y0) * 0.15;
  const arrow = pointerPolygon(tipX, tipY, h);
  const round = Math.max(0.35, h * 0.035);
  R.fill(sdOffset(sdPolygon(arrow, round), h * 0.03, h * 0.05), rgb('#050a2e', 0.35), {
    soft: h * 0.05,
    bbox: polyBox(arrow, h * 0.2),
  });
  R.fill(sdPolygon(arrow, round), COLORS.white, { bbox: polyBox(arrow, 2) });
}

/**
 * Staircase pointer for tiny renders (h = 4…12 px): a union of whole-pixel rectangles shaped
 * like the classic arrow (diagonal right edge, short wing, tail). Exact pixel coverage — the
 * analytic polygon turns into a grey smudge below ~12 px.
 */
function pixelPointer(x, y, h) {
  // Row widths as a fraction of h, then one tail pixel offset to the right.
  const rows = [];
  const wing = Math.max(2, Math.round(h * 0.62)); // row index where the wing ends
  for (let i = 0; i < h; i++) {
    let x0 = 0;
    let x1;
    if (i <= wing) x1 = i + 1; // the diagonal edge
    else {
      // below the wing: a narrow stem leaning right (the tail)
      const k = i - wing;
      x0 = Math.min(Math.floor(k * 0.7) + 1, wing - 1);
      x1 = x0 + Math.max(1, Math.round(h / 6));
      if (k === 1) x0 = 0; // keep the notch joined to the body
    }
    rows.push(sdRoundRect(x + x0, y + i, x + x1, y + i + 1, 0, 2));
  }
  return sdUnion(...rows);
}

/** Simplified glyph for bodies < 24 px: solid white front screen, ghost screen, stand. */
function drawTinyGlyph(R, S, SX, SY, bg) {
  const u = S / 16; // design grid: 16 units
  const px = (v) => Math.round(v * u);
  const o = SX(0);
  const oy = SY(0);
  // Ghost (remote) screen: top-right outline band.
  const back = sdRoundRect(o + px(6), oy + px(2), o + px(14), oy + px(8), Math.max(0.5, u), 2);
  R.fill(back, rgb('#ffffff', 0.5), { bbox: [o, oy, o + S, oy + S] });
  // Gap around the front screen: repaint the body gradient over the ghost.
  const front = sdRoundRect(o + px(2), oy + px(5), o + px(11), oy + px(11), Math.max(0.5, u), 2);
  R.fill(sdGrow(front, u), bg, { bbox: [o, oy, o + S, oy + S] });
  // Front screen: white frame, dark display.
  R.fill(front, COLORS.white, { bbox: [o, oy, o + S, oy + S] });
  const disp = sdRoundRect(o + px(3), oy + px(6), o + px(10), oy + px(10), 0, 2);
  R.fill(disp, COLORS.displayBottom, { bbox: [o, oy, o + S, oy + S] });
  // Stand.
  const neck = sdRoundRect(o + px(6), oy + px(11), o + px(7), oy + px(12), 0, 2);
  const foot = sdRoundRect(o + px(4), oy + px(12), o + px(9), oy + px(13), 0, 2);
  R.fill(sdUnion(neck, foot), COLORS.white, { bbox: [o, oy, o + S, oy + S] });
}

/** Classic arrow pointer, tip at (x, y), total height h. */
function pointerPolygon(x, y, h) {
  const pts = [
    [0, 0],
    [0, 0.8],
    [0.205, 0.625],
    [0.335, 0.93],
    [0.47, 0.872],
    [0.345, 0.575],
    [0.6, 0.575],
  ];
  return pts.map(([a, b]) => [x + a * h, y + b * h]);
}

function polyBox(pts, pad) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

/* ------------------------------------------------------------------------------------------ */
/* tray icon                                                                                   */
/* ------------------------------------------------------------------------------------------ */

const TRAY_STATES = new Set(['idle', 'active', 'off']);

/**
 * Monochrome monitor glyph designed on a 16-unit grid; all edges are snapped to whole pixels
 * so 16 px (1×) and 32 px (@2x) are both sharp, and 20/24 px (125 %/150 % Windows DPI) stay clean.
 *
 * @param {number} size
 * @param {{template?:boolean, state?:'idle'|'active'|'off', theme?:'dark'|'light'}} [opts]
 *   template — macOS template image: pure black + alpha (the menu bar tints it).
 *   theme    — non-template only: the surface the icon sits on. 'dark' (default) → white glyph;
 *              'light' → near-black glyph (e.g. Windows light taskbar; see
 *              nativeTheme.shouldUseDarkColorsForSystemIntegratedUI).
 */
function drawTrayIcon(size, opts = {}) {
  validateSize(size, 'drawTrayIcon');
  const o = opts || {};
  const template = o.template === true;
  const state = TRAY_STATES.has(o.state) ? o.state : 'idle';
  const theme = o.theme === 'light' ? 'light' : 'dark';
  const R = new Raster(size, size);
  const u = size / 16;
  const p = (v) => Math.round(v * u); // grid → px, snapped
  const stroke = Math.max(1, Math.round(1.75 * u)); // 2 px @16, 4 px @32

  const color = template ? COLORS.black : theme === 'light' ? COLORS.ink : COLORS.white;
  const glyphOpacity = state === 'off' ? (template ? 0.45 : 0.6) : 1;

  // Screen.
  const sx0 = p(1);
  const sy0 = p(2);
  const sx1 = size - p(1);
  const sy1 = p(12);
  const corner = Math.max(1, 1.5 * u);
  const outer = sdRoundRect(sx0, sy0, sx1, sy1, corner, 2);
  const inner = sdRoundRect(sx0 + stroke, sy0 + stroke, sx1 - stroke, sy1 - stroke, Math.max(0, corner - stroke * 0.6), 2);
  const screen = state === 'active' ? outer : sdSubtract(outer, inner);

  // Stand: neck + foot, centred on the screen.
  const cx = size / 2;
  const neckW = Math.max(1, stroke);
  const neckX0 = Math.round(cx - neckW / 2);
  const footY0 = p(13);
  const footY1 = Math.max(footY0 + 1, footY0 + stroke);
  const footHalf = p(4);
  const neck = sdRoundRect(neckX0, sy1 - 0.5, neckX0 + neckW, footY0 + 0.5, 0, 2);
  const foot = sdRoundRect(Math.round(cx) - footHalf, footY0, Math.round(cx) + footHalf, footY1, (footY1 - footY0) / 2, 2);

  let glyph = sdUnion(screen, neck, foot);

  // Active: a pointer cut out of the filled screen keeps it reading as "screen being
  // controlled" rather than a slab (staircase pointer below 24 px for exact pixels).
  if (state === 'active') {
    const sh = sy1 - sy0;
    if (size < 24) {
      const h = Math.max(4, Math.round(sh * 0.6));
      const tipX = Math.round(sx0 + (sx1 - sx0) * 0.33);
      const tipY = Math.round(sy0 + (sh - h) / 2);
      glyph = sdSubtract(glyph, pixelPointer(tipX, tipY, h));
    } else {
      const h = sh * 0.62;
      const arrow = pointerPolygon(sx0 + (sx1 - sx0) * 0.36, sy0 + sh * 0.18, h);
      glyph = sdSubtract(glyph, sdPolygon(arrow, Math.max(0.3, 0.04 * h)));
    }
  }

  if (template) {
    R.fill(glyph, color, { opacity: glyphOpacity });
    return R.toImage({ dither: false });
  }

  // Non-template: glyph + status dot (bottom-right) with a transparent gap around the dot.
  R.fill(glyph, color, { opacity: glyphOpacity });
  const dotR = 2.75 * u;
  const dcx = size - dotR - 0.25 * u;
  const dcy = size - dotR - 0.25 * u;
  const gap = Math.max(1, Math.round(1.25 * u));
  R.fill(sdCircle(dcx, dcy, dotR + gap), COLORS.black, { mode: 'erase' });
  const dotColor = state === 'active' ? COLORS.dotActive : state === 'off' ? COLORS.dotOff : COLORS.dotIdle;
  R.fill(sdCircle(dcx, dcy, dotR), dotColor);
  return R.toImage({ dither: false });
}

/* ------------------------------------------------------------------------------------------ */
/* PNG encoder                                                                                 */
/* ------------------------------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ISO-HDLC / zlib polynomial 0xEDB88320), as PNG requires. */
function crc32(buf, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(payload.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(payload, crc32(head.subarray(4, 8))), 0);
  return Buffer.concat([head, payload, crc]);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Encode RGBA 8-bit straight-alpha pixels as PNG (colour type 6, filter type 0 on every row,
 * zlib-deflated IDAT).
 * @param {{width:number, height:number, data:Buffer|Uint8Array}} img
 * @returns {Buffer}
 */
function encodePNG(img) {
  if (!img || typeof img !== 'object') throw new TypeError('encodePNG: expected {width, height, data}');
  const { width, height, data } = img;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) {
    throw new RangeError(`encodePNG: invalid dimensions ${width}×${height}`);
  }
  if (!(data instanceof Uint8Array) || data.length !== width * height * 4) {
    throw new TypeError(`encodePNG: data must be a Uint8Array/Buffer of ${width * height * 4} bytes`);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour + alpha
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    Buffer.from(data.buffer, data.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

module.exports = { drawAppIcon, drawTrayIcon, encodePNG, crc32 };
