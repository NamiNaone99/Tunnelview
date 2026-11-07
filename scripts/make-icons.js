#!/usr/bin/env node
'use strict';
/*
 * Generates the packaging icons from src/main/icon-art.js — no external dependencies.
 *
 *   build/icon.png            1024×1024, macOS icon-grid style (824 px body + shadow).
 *                             electron-builder converts it to the .icns for the mac targets.
 *   build/icon.ico            Windows icon with 16, 20, 24, 32, 40, 48, 64, 128 and 256 px images,
 *                             each rasterized natively at its size (hinted art, near full-bleed),
 *                             instead of letting electron-builder downscale the 1024 px PNG —
 *                             that would leave the 16/24/32 px taskbar/Explorer icons blurry and
 *                             shrunken by the macOS margin. 256 px is PNG-compressed, smaller
 *                             sizes are classic 32-bit BMP/DIB entries (what every Windows API,
 *                             resedit and NSIS accept).
 *   build/icons/<n>x<n>.png   16, 32, 48, 64, 128, 256, 512 px full-bleed PNGs (Linux-style icon set,
 *                             docs, store listings).
 *
 * Usage: npm run icons            (the dist / dist:win / dist:mac scripts run it first)
 *        node scripts/make-icons.js [--out <dir>]   (default: <repo>/build)
 * All outputs are generated files (git-ignored).
 */
const fs = require('node:fs');
const path = require('node:path');
const { drawAppIcon, encodePNG } = require('../src/main/icon-art');

const ROOT = path.resolve(__dirname, '..');
const MAC_ICON_SIZE = 1024;
const ICON_SET_SIZES = [16, 32, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

/**
 * 32-bit BMP (DIB) icon image: BITMAPINFOHEADER with doubled height, bottom-up BGRA rows
 * (straight alpha), then the 1-bpp AND mask (1 = transparent; rows padded to 32 bits).
 */
function encodeDIB({ width: w, height: h, data }) {
  const xorSize = w * h * 4;
  const maskStride = Math.ceil(w / 32) * 4;
  const maskSize = maskStride * h;
  const buf = Buffer.alloc(40 + xorSize + maskSize);
  buf.writeUInt32LE(40, 0); // biSize
  buf.writeInt32LE(w, 4); // biWidth
  buf.writeInt32LE(h * 2, 8); // biHeight: XOR + AND bitmaps
  buf.writeUInt16LE(1, 12); // biPlanes
  buf.writeUInt16LE(32, 14); // biBitCount
  buf.writeUInt32LE(0, 16); // biCompression = BI_RGB
  buf.writeUInt32LE(xorSize + maskSize, 20); // biSizeImage
  // biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant stay 0
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4; // bottom-up
    const dst = 40 + y * w * 4;
    const mask = 40 + xorSize + y * maskStride;
    for (let x = 0; x < w; x++) {
      const s = src + x * 4;
      const d = dst + x * 4;
      buf[d] = data[s + 2]; // B
      buf[d + 1] = data[s + 1]; // G
      buf[d + 2] = data[s]; // R
      buf[d + 3] = data[s + 3]; // A
      if (data[s + 3] === 0) buf[mask + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return buf;
}

/**
 * Pack images (RGBA straight alpha, ≤ 256 px, square) into an .ico file.
 * @param {{width:number,height:number,data:Buffer}[]} images
 * @returns {Buffer}
 */
function encodeICO(images) {
  if (!Array.isArray(images) || images.length === 0 || images.length > 255) {
    throw new TypeError('encodeICO: expected 1–255 images');
  }
  const entries = images.map((img) => {
    const { width: w, height: h, data } = img;
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 256 || h > 256) {
      throw new RangeError(`encodeICO: invalid image size ${w}×${h} (max 256)`);
    }
    if (!(data instanceof Uint8Array) || data.length !== w * h * 4) {
      throw new TypeError('encodeICO: image data must be RGBA bytes');
    }
    return { w, h, payload: w === 256 ? encodePNG(img) : encodeDIB(img) };
  });
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach((e, i) => {
    const o = 6 + 16 * i;
    header[o] = e.w === 256 ? 0 : e.w; // 0 means 256
    header[o + 1] = e.h === 256 ? 0 : e.h;
    header[o + 2] = 0; // palette size
    header[o + 3] = 0; // reserved
    header.writeUInt16LE(1, o + 4); // colour planes
    header.writeUInt16LE(32, o + 6); // bits per pixel
    header.writeUInt32LE(e.payload.length, o + 8);
    header.writeUInt32LE(offset, o + 12);
    offset += e.payload.length;
  });
  return Buffer.concat([header, ...entries.map((e) => e.payload)]);
}

/** Write via temp file + rename so an interrupted run never leaves a truncated icon behind. */
function writeFileAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

function parseArgs(argv) {
  const opts = { out: path.join(ROOT, 'build') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) opts.out = path.resolve(argv[++i]);
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log('usage: node scripts/make-icons.js [--out <dir>]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argv[i]}`);
    }
  }
  return opts;
}

function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const written = [];
  const put = (rel, buf) => {
    writeFileAtomic(path.join(out, rel), buf);
    written.push(`${rel} (${(buf.length / 1024).toFixed(1)} KiB)`);
  };

  put('icon.png', encodePNG(drawAppIcon(MAC_ICON_SIZE, { style: 'macos' })));
  put('icon.ico', encodeICO(ICO_SIZES.map((s) => drawAppIcon(s, { style: 'full' }))));
  for (const s of ICON_SET_SIZES) {
    put(path.join('icons', `${s}x${s}.png`), encodePNG(drawAppIcon(s, { style: 'full' })));
  }

  const rel = path.relative(ROOT, out) || '.';
  for (const w of written) console.log(`  ${rel}/${w.split(path.sep).join('/')}`);
  console.log(`✓ wrote ${written.length} icon files in ${Date.now() - started} ms`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`✗ make-icons: ${err && err.stack ? err.stack : err}`);
    process.exit(1);
  }
}

module.exports = { encodeICO, encodeDIB };
