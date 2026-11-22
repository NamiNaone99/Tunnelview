'use strict';
/*
 * QR code of the pairing link (mobile DECISIONS D6), for the main window's Pair-a-phone dialog.
 *
 *   encode(text) → {size, bits}
 *     size  modules per side (version * 4 + 17), without the quiet zone: the renderer draws at
 *           least 4 light modules around it
 *     bits  base64 of the size*size modules, row by row from the top left, packed 8 per byte with
 *           the first module in the most significant bit; 1 = dark. Bits after the last module are 0.
 *
 * Byte mode over UTF-8 (never the numeric or alphanumeric modes), error correction level MEDIUM
 * (the library raises it when the same version allows), the smallest version that fits and the
 * library's automatic mask. The encoder is the vendored Project Nayuki library (vendor/qrcodegen.js);
 * test/qr.test.js checks it against golden symbols from an independent encoder.
 */
const { QrCode, QrSegment } = require('./vendor/qrcodegen');

/** The QR symbol for `text` (the library object: version, mask, errorCorrectionLevel, getModule). */
function symbolFor(text) {
  if (typeof text !== 'string') throw new TypeError('qr: text must be a string');
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  return QrCode.encodeSegments([QrSegment.makeBytes(bytes)], QrCode.Ecc.MEDIUM);
}

/** Row-major module bits, MSB first. */
function pack(symbol) {
  const { size } = symbol;
  const out = Buffer.alloc(Math.ceil((size * size) / 8));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!symbol.getModule(x, y)) continue;
      const i = y * size + x;
      out[i >>> 3] |= 0x80 >>> (i & 7);
    }
  }
  return out;
}

/** @returns {{size:number, bits:string}} throws RangeError when the text does not fit version 40 */
function encode(text) {
  const symbol = symbolFor(text);
  return { size: symbol.size, bits: pack(symbol).toString('base64') };
}

module.exports = { encode, symbolFor };
