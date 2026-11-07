'use strict';
/*
 * Runtime nativeImages built from the pure-Node rasterizer in icon-art.js (ARCHITECTURE §7).
 *
 *   icons.appIcon()          → NativeImage (window/dock icon, multi-resolution)
 *   icons.trayIcon(state)    → NativeImage; state 'idle' | 'active' | 'off'
 *                              macOS: template image (black + alpha, auto-tinted by the menu bar;
 *                              state shown by shape). Windows: glyph matched to the taskbar's
 *                              light/dark mode + coloured status dot.
 *
 * nativeImage.createFromBitmap() takes Skia's native N32 layout, which is BGRA with
 * PREMULTIPLIED alpha on both Windows and macOS; icon-art returns straight-alpha RGBA, so we swap
 * R/B and premultiply. Extra scale factors are added with addRepresentation() so HiDPI screens
 * get crisp pixels. If icon-art.js is missing or throws, we fall back to an empty image.
 */

let art = null;
try {
  art = require('./icon-art');
} catch (err) {
  console.warn('[icons] icon-art unavailable, using empty icons:', err && err.message);
}

let electron = null;
const E = () => electron || (electron = require('electron'));

const IS_MAC = process.platform === 'darwin';
const cache = new Map();

/** Straight-alpha RGBA → premultiplied BGRA (Skia N32 on little-endian Windows/macOS). */
function rgbaToBgraPremul(rgba) {
  const src = rgba.data;
  const out = Buffer.allocUnsafe(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3];
    if (a === 255) {
      out[i] = src[i + 2]; out[i + 1] = src[i + 1]; out[i + 2] = src[i]; out[i + 3] = 255;
    } else if (a === 0) {
      out[i] = 0; out[i + 1] = 0; out[i + 2] = 0; out[i + 3] = 0;
    } else {
      out[i] = Math.round((src[i + 2] * a) / 255);
      out[i + 1] = Math.round((src[i + 1] * a) / 255);
      out[i + 2] = Math.round((src[i] * a) / 255);
      out[i + 3] = a;
    }
  }
  return out;
}

function validBitmap(bmp, size) {
  return bmp && bmp.width === size && bmp.height === size && Buffer.isBuffer(bmp.data) && bmp.data.length === size * size * 4;
}

/**
 * @param {number} base   logical size (1x) in px
 * @param {number[]} scales scale factors to add
 * @param {(px:number)=>{width,height,data}} draw
 */
function build(base, scales, draw) {
  const { nativeImage } = E();
  if (!art) return nativeImage.createEmpty();
  try {
    let img = null;
    for (const scale of scales) {
      const px = Math.round(base * scale);
      const bmp = draw(px);
      if (!validBitmap(bmp, px)) continue;
      const buffer = rgbaToBgraPremul(bmp);
      if (!img) {
        img = nativeImage.createFromBitmap(buffer, { width: px, height: px, scaleFactor: scale });
      } else {
        img.addRepresentation({ scaleFactor: scale, width: px, height: px, buffer });
      }
    }
    return img || nativeImage.createEmpty();
  } catch (err) {
    console.warn('[icons] rendering failed:', err && err.message);
    return nativeImage.createEmpty();
  }
}

/** Window / taskbar / dock icon. */
function appIcon() {
  if (cache.has('app')) return cache.get('app');
  const img = build(32, [1, 1.25, 1.5, 2, 4, 8], (px) => art.drawAppIcon(px));
  cache.set('app', img);
  return img;
}

/** Large icon for notifications / About (256 px). */
function appIconLarge() {
  if (cache.has('app-large')) return cache.get('app-large');
  const img = build(256, [1], (px) => art.drawAppIcon(px));
  cache.set('app-large', img);
  return img;
}

/** Windows: the taskbar follows the SYSTEM light/dark mode, not the app theme. */
function taskbarTheme() {
  try {
    const nt = E().nativeTheme;
    const dark = typeof nt.shouldUseDarkColorsForSystemIntegratedUI === 'boolean'
      ? nt.shouldUseDarkColorsForSystemIntegratedUI : nt.shouldUseDarkColors;
    return dark ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

/** @param {'idle'|'active'|'off'} state */
function trayIcon(state = 'idle') {
  const st = ['idle', 'active', 'off'].includes(state) ? state : 'idle';
  const theme = IS_MAC ? 'template' : taskbarTheme();
  const key = `tray-${st}-${theme}`;
  if (cache.has(key)) return cache.get(key);
  let img;
  if (IS_MAC) {
    // macOS menu bar: 18 pt (+@2x) template image (black + alpha, tinted by the system); icon-art
    // encodes the state in the shape (filled screen = active session).
    img = build(18, [1, 2], (px) => art.drawTrayIcon(px, { template: true, state: st }));
    if (!img.isEmpty()) img.setTemplateImage(true);
  } else {
    // Windows notification area: 16 px at 100 %, up to 32 px at 200 %; glyph + coloured status dot.
    img = build(16, [1, 1.25, 1.5, 2], (px) => art.drawTrayIcon(px, { template: false, state: st, theme }));
  }
  cache.set(key, img);
  return img;
}

module.exports = { appIcon, appIconLarge, trayIcon, rgbaToBgraPremul, available: () => !!art };
