'use strict';
/* node --test test/qr.test.js — src/main/qr.js and the vendored encoder (src/main/vendor/qrcodegen.js,
 * Project Nayuki v1.8.0 hand-ported to CommonJS; mobile DECISIONS D6).
 *   - golden symbols from two independent encoders (test/fixtures/qr-golden.json: python-qrcode
 *     for every symbol, segno too where it pads per the standard);
 *   - readSymbol(), written here from ISO/IEC 18004, checks any symbol on its own: finder, timing and
 *     alignment patterns, both format-information copies (BCH 15,5), version information
 *     (BCH 18,6), every Reed-Solomon block (syndromes), the byte-mode payload, terminator and pads;
 *   - the worst-case pairing link fits version 25;
 *   - the vendored file keeps its provenance header and ships with the app. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const qr = require('../src/main/qr');
const { QrCode, QrSegment } = require('../src/main/vendor/qrcodegen');
const pairing = require('../src/main/pairing');

const ROOT = path.join(__dirname, '..');
const GOLD = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'qr-golden.json'), 'utf8'));
const LEVELS = ['L', 'M', 'Q', 'H']; // the library's Ecc ordinal order
const ECC = { L: QrCode.Ecc.LOW, M: QrCode.Ecc.MEDIUM, Q: QrCode.Ecc.QUARTILE, H: QrCode.Ecc.HIGH };
const FORMAT_CODE = { L: 1, M: 0, Q: 3, H: 2 }; // the 2-bit error-correction indicator

/* ---------------------------------------------------------------- GF(256), BCH, masks (ISO 18004) */

const EXP = new Array(512);
const LOG = new Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d; // x^8 + x^4 + x^3 + x^2 + 1
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** Remainder of a GF(2) polynomial division (bit i = coefficient of x^i). */
function bchRemainder(value, generator) {
  const degree = (v) => 31 - Math.clz32(v);
  let v = value;
  while (v && degree(v) >= degree(generator)) v ^= generator << (degree(v) - degree(generator));
  return v;
}

// Data masks, ISO/IEC 18004 Table 10 (i = row = y, j = column = x).
const MASKS = [
  (x, y) => (y + x) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (y + x) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((y * x) % 2) + ((y * x) % 3) === 0,
  (x, y) => (((y * x) % 2) + ((y * x) % 3)) % 2 === 0,
  (x, y) => (((y + x) % 2) + ((y * x) % 3)) % 2 === 0,
];

/* ---------------------------------------------------------------- symbols */

/** qr.encode's {size, bits} as a module grid, after checking the packing. */
function unpack({ size, bits }) {
  assert.ok(Number.isInteger(size) && size >= 21 && size <= 177 && (size - 17) % 4 === 0, `size ${size}`);
  const buf = Buffer.from(bits, 'base64');
  assert.equal(buf.toString('base64'), bits, 'canonical base64');
  assert.equal(buf.length, Math.ceil((size * size) / 8));
  for (let i = size * size; i < buf.length * 8; i++) assert.equal((buf[i >> 3] >> (7 - (i & 7))) & 1, 0, 'bits after the last module are 0');
  const at = (x, y) => {
    const i = y * size + x;
    return ((buf[i >> 3] >> (7 - (i & 7))) & 1) === 1;
  };
  return { size, at };
}

/** Row-major MSB-first packing of a library symbol, written independently of qr.js. */
function pack(symbol) {
  const n = symbol.size;
  const buf = Buffer.alloc(Math.ceil((n * n) / 8));
  for (let i = 0; i < n * n; i++) if (symbol.getModule(i % n, Math.floor(i / n))) buf[i >> 3] |= 1 << (7 - (i & 7));
  return { size: n, bits: buf.toString('base64') };
}

/** Function modules of a version: finders + separators + format areas, timing, alignment, version. */
function functionModules(version) {
  const size = version * 4 + 17;
  const f = Array.from({ length: size }, () => new Uint8Array(size));
  const mark = (x0, y0, w, h) => { for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) f[y][x] = 1; };
  const inFinderArea = (x, y) => (x < 9 && y < 9) || (x >= size - 8 && y < 9) || (x < 9 && y >= size - 8);
  const centers = GOLD.alignment[version] || [];
  for (const cy of centers) for (const cx of centers) if (!inFinderArea(cx, cy)) mark(cx - 2, cy - 2, 5, 5);
  mark(0, 0, 9, 9);
  mark(size - 8, 0, 8, 9);
  mark(0, size - 8, 9, 8);
  mark(6, 0, 1, size);
  mark(0, 6, size, 1);
  if (version >= 7) {
    mark(size - 11, 0, 3, 6);
    mark(0, size - 11, 6, 3);
  }
  return { f, centers: centers.flatMap((cy) => centers.filter((cx) => !inFinderArea(cx, cy)).map((cx) => [cx, cy])) };
}

/**
 * Reads a symbol the way a scanner does and checks every part against ISO/IEC 18004.
 * @returns {{version, level, mask, payload: Buffer, padCodewords}}
 */
function readSymbol(m) {
  const { size } = m;
  const version = (size - 17) / 4;
  const bit = (x, y) => (m.at(x, y) ? 1 : 0);

  // Finder patterns with their light separators, timing patterns, the dark module.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= size || y >= size) continue;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        assert.equal(m.at(x, y), ring !== 2 && ring !== 4, `finder module (${x}, ${y})`);
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    assert.equal(m.at(i, 6), i % 2 === 0, `timing (${i}, 6)`);
    assert.equal(m.at(6, i), i % 2 === 0, `timing (6, ${i})`);
  }
  assert.equal(m.at(8, size - 8), true, 'the dark module');
  const { f, centers } = functionModules(version);
  for (const [cx, cy] of centers) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) assert.equal(m.at(cx + dx, cy + dy), Math.max(Math.abs(dx), Math.abs(dy)) !== 1, `alignment (${cx}, ${cy})`);
    }
  }

  // Format information: two copies, a BCH(15,5) codeword under the 0x5412 mask.
  let a = 0;
  let b = 0;
  for (let i = 0; i <= 5; i++) a |= bit(8, i) << i;
  a |= (bit(8, 7) << 6) | (bit(8, 8) << 7) | (bit(7, 8) << 8);
  for (let i = 9; i < 15; i++) a |= bit(14 - i, 8) << i;
  for (let i = 0; i < 8; i++) b |= bit(size - 1 - i, 8) << i;
  for (let i = 8; i < 15; i++) b |= bit(8, size - 15 + i) << i;
  assert.equal(a, b, 'both format-information copies agree');
  assert.equal(bchRemainder(a ^ 0x5412, 0x537), 0, 'format information is a BCH(15,5) codeword');
  const info = (a ^ 0x5412) >> 10;
  const level = LEVELS.find((l) => FORMAT_CODE[l] === info >> 3);
  const mask = info & 7;
  assert.equal(a, GOLD.formatInfo[level][mask], 'format information as the independent table has it');

  // Version information (version 7 and up): two copies, a BCH(18,6) codeword.
  if (version >= 7) {
    let v1 = 0;
    let v2 = 0;
    for (let i = 0; i < 18; i++) {
      const p = size - 11 + (i % 3);
      const q = Math.floor(i / 3);
      v1 |= bit(p, q) << i;
      v2 |= bit(q, p) << i;
    }
    assert.equal(v1, v2, 'both version-information copies agree');
    assert.equal(bchRemainder(v1, 0x1f25), 0, 'version information is a BCH(18,6) codeword');
    assert.equal(v1 >> 12, version);
    assert.equal(v1, GOLD.versionInfo[version]);
  }

  // Codewords: column pairs from the right, alternating up and down, skipping column 6.
  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < size; k++) {
      const y = upward ? size - 1 - k : k;
      for (const x of [right, right - 1]) if (!f[y][x]) bits.push(m.at(x, y) !== MASKS[mask](x, y) ? 1 : 0);
    }
    upward = !upward;
  }
  const total = Math.floor(bits.length / 8);
  assert.ok(bits.slice(total * 8).every((v) => v === 0), 'remainder bits are 0');
  const codewords = Array.from({ length: total }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((acc, v) => (acc << 1) | v, 0));

  // Blocks (the library's table), de-interleaved; every block must be a Reed-Solomon codeword.
  const ord = LEVELS.indexOf(level);
  const numBlocks = QrCode.NUM_ERROR_CORRECTION_BLOCKS[ord][version];
  const eccLen = QrCode.ECC_CODEWORDS_PER_BLOCK[ord][version];
  const numShort = numBlocks - (total % numBlocks);
  const shortData = Math.floor(total / numBlocks) - eccLen;
  const blocks = Array.from({ length: numBlocks }, (_, i) => ({ data: [], ecc: [], dataLen: shortData + (i < numShort ? 0 : 1) }));
  let k = 0;
  for (let i = 0; i <= shortData; i++) for (const blk of blocks) if (i < blk.dataLen) blk.data.push(codewords[k++]);
  for (let i = 0; i < eccLen; i++) for (const blk of blocks) blk.ecc.push(codewords[k++]);
  assert.equal(k, total);
  for (const [n, blk] of blocks.entries()) {
    const cw = [...blk.data, ...blk.ecc];
    for (let i = 0; i < eccLen; i++) {
      let s = 0;
      for (const c of cw) s = gmul(s, EXP[i]) ^ c;
      assert.equal(s, 0, `block ${n}: syndrome ${i}`);
    }
  }

  // Byte-mode segment, terminator, zero bits to the codeword boundary, pad codewords.
  const data = blocks.flatMap((blk) => blk.data);
  const stream = data.flatMap((c) => Array.from({ length: 8 }, (_, i) => (c >> (7 - i)) & 1));
  let pos = 0;
  const read = (n) => { let v = 0; for (let i = 0; i < n; i++) v = (v << 1) | stream[pos++]; return v; };
  assert.equal(read(4), 0b0100, 'byte mode');
  const count = read(version < 10 ? 8 : 16);
  const payload = Buffer.from(Array.from({ length: count }, () => read(8)));
  assert.ok(pos <= stream.length, 'the payload fits');
  const term = Math.min(4, stream.length - pos);
  assert.equal(read(term), 0, 'terminator');
  while (pos % 8) assert.equal(read(1), 0, 'zero bits up to the codeword boundary');
  const pads = data.slice(pos / 8);
  pads.forEach((c, i) => assert.equal(c, i % 2 ? 0x11 : 0xec, `pad codeword ${i}`));
  return { version, level, mask, payload, padCodewords: pads.length };
}

/* ---------------------------------------------------------------- tests */

test('golden symbols from two independent encoders are reproduced exactly', () => {
  assert.ok(GOLD.symbols.length >= 30 && GOLD.inputs.length >= 10);
  for (const s of GOLD.symbols) {
    const input = GOLD.inputs[s.input];
    const label = `${input.name}, mask ${s.mask}`;
    assert.ok(s.checkedBy.includes('qrcode 8.2'), label);
    const symbol = qr.symbolFor(input.text);
    assert.deepEqual([symbol.version, LEVELS[symbol.errorCorrectionLevel.ordinal]], [input.version, input.ecc], label);
    if (s.mask === input.encodeMask) {
      assert.equal(symbol.mask, s.mask, label);
      assert.deepEqual(qr.encode(input.text), { size: s.size, bits: s.bits }, label);
    }
    const bytes = Array.from(Buffer.from(input.text, 'utf8'));
    const forced = QrCode.encodeSegments([QrSegment.makeBytes(bytes)], ECC[input.ecc], input.version, input.version, s.mask, false);
    assert.deepEqual(pack(forced), { size: s.size, bits: s.bits }, label);
  }
  // Both encoders agree wherever segno pads per the standard (no pad codewords).
  assert.ok(GOLD.symbols.filter((s) => s.checkedBy.includes('segno 1.6.6')).length >= 10);
});

test('every golden symbol reads back: patterns, format and version information, RS blocks, payload, padding', () => {
  for (const s of GOLD.symbols) {
    const input = GOLD.inputs[s.input];
    const r = readSymbol(unpack(s));
    const label = `${input.name}, mask ${s.mask}`;
    assert.deepEqual([r.version, r.level, r.mask, r.padCodewords], [input.version, input.ecc, s.mask, input.padCodewords], label);
    assert.ok(r.payload.equals(Buffer.from(input.text, 'utf8')), label);
  }
});

test('qr.encode: any text reads back, across lengths, byte values and versions 1-25', () => {
  let seed = 12345;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pieces = ['a', 'Z', '0', ' ', '/', ':', '-', '_', '=', String.fromCharCode(0xe9), String.fromCharCode(0x0e2a), String.fromCodePoint(0x1f511)];
  const seen = new Set();
  const texts = ['', '0', '12345', 'HELLO WORLD', 'tunnelview://pair/1/'];
  for (let i = 0; i < 40; i++) {
    let t = '';
    const target = 1 + rand(990);
    while (Buffer.byteLength(t) < target) t += pieces[rand(pieces.length)];
    texts.push(t);
  }
  for (const text of texts) {
    const out = qr.encode(text);
    assert.deepEqual(qr.encode(text), out, 'deterministic');
    const r = readSymbol(unpack(out));
    assert.ok(r.payload.equals(Buffer.from(text, 'utf8')), text.slice(0, 40));
    assert.ok(['M', 'Q', 'H'].includes(r.level), 'level M or better');
    seen.add(r.version);
  }
  assert.ok(seen.size >= 15, `versions covered: ${[...seen].sort((x, y) => x - y)}`);
});

test('byte mode only: digits and upper-case text are not encoded as numeric or alphanumeric', () => {
  for (const text of ['0123456789', 'HELLO WORLD', 'TUNNELVIEW://PAIR/1/ABC']) {
    const r = readSymbol(unpack(qr.encode(text))); // readSymbol requires mode 0100
    assert.equal(r.payload.toString('utf8'), text);
  }
});

test('the worst-case pairing link fits version 25 at level M (DECISIONS D6) and reads back', () => {
  const label = (n, ch) => ch.repeat(n);
  const link = pairing.encodeLink({
    v: 1, id: `n${'A'.repeat(63)}`, n: [label(63, 'a'), label(63, 'b'), label(63, 'c'), label(61, 'd')].join('.'),
    a: ['100.127.255.255', 'fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff'], p: 65535,
    k: Buffer.alloc(32, 0xff).toString('base64url'), t: Buffer.alloc(16, 0xff).toString('base64url'), x: Number.MAX_SAFE_INTEGER,
  });
  const symbol = qr.symbolFor(link);
  assert.ok(symbol.version <= 25, `version ${symbol.version}`);
  assert.ok(symbol.errorCorrectionLevel.ordinal >= QrCode.Ecc.MEDIUM.ordinal);
  const r = readSymbol(unpack(qr.encode(link)));
  assert.equal(r.payload.toString('utf8'), link);
  // A typical link (short name) is much smaller.
  const typical = pairing.encodeLink({
    v: 1, id: 'nXyZ12345CNTRL', n: 'office-pc.tail1234.ts.net', a: ['100.101.102.103', 'fd7a:115c:a1e0::1234:5678'],
    p: 47800, k: Buffer.alloc(32, 1).toString('base64url'), t: Buffer.alloc(16, 2).toString('base64url'), x: 1762520000,
  });
  assert.ok(qr.symbolFor(typical).version <= 15, `typical: version ${qr.symbolFor(typical).version}`);
});

test('format information table: 32 BCH(15,5) codewords, minimum distance 7', () => {
  const all = [];
  for (const level of LEVELS) {
    assert.equal(GOLD.formatInfo[level].length, 8);
    GOLD.formatInfo[level].forEach((word, mask) => {
      assert.equal(bchRemainder(word ^ 0x5412, 0x537), 0, `${level}${mask}`);
      assert.equal((word ^ 0x5412) >> 10, (FORMAT_CODE[level] << 3) | mask, `${level}${mask}`);
      all.push(word);
    });
  }
  assert.equal(GOLD.formatInfo.M[0], 0b101010000010010, 'ISO/IEC 18004 Table C.1: M, mask 0');
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      let d = all[i] ^ all[j];
      let n = 0;
      while (d) { n += d & 1; d >>>= 1; }
      assert.ok(n >= 7, `distance ${n}`);
    }
  }
});

test('version information table: BCH(18,6) codewords for versions 7-40', () => {
  for (let v = 7; v <= 40; v++) {
    const word = GOLD.versionInfo[v];
    assert.equal(word >> 12, v);
    assert.equal(bchRemainder(word, 0x1f25), 0, `version ${v}`);
  }
  assert.equal(GOLD.versionInfo[7], 0x07c94, 'ISO/IEC 18004 Table D.1: version 7');
});

test('Reed-Solomon: known answers and the degree-10 generator', () => {
  // The widely published HELLO WORLD 1-M block (alphanumeric data, so independent of this encoder's
  // byte-only path) pins the known answer; the other blocks are segno's (7 and 26 ECC codewords).
  const hello = GOLD.rs.find((r) => r.data.length === 16 && r.data[0] === 32);
  assert.deepEqual(hello.ecc, [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  for (const r of GOLD.rs) {
    const divisor = QrCode.reedSolomonComputeDivisor(r.ecc.length);
    assert.deepEqual(QrCode.reedSolomonComputeRemainder(r.data, divisor), r.ecc);
  }
  assert.deepEqual(QrCode.reedSolomonComputeDivisor(10), GOLD.rsGeneratorExponents10.map((e) => EXP[e]));
  for (let a = 0; a < 256; a += 17) for (let b = 0; b < 256; b += 13) assert.equal(QrCode.reedSolomonMultiply(a, b), gmul(a, b));
});

test('version choice: byte capacity at level M per version 1-40 matches the independent table', () => {
  assert.equal(GOLD.byteCapacityM.length, 40);
  const versionFor = (n) => {
    const seg = QrSegment.makeBytes(new Array(n).fill(0x61));
    return QrCode.encodeSegments([seg], QrCode.Ecc.MEDIUM, 1, 40, 0).version; // a fixed mask: only the version matters here
  };
  GOLD.byteCapacityM.forEach((cap, i) => {
    const v = i + 1;
    assert.equal(versionFor(cap), v, `${cap} bytes`);
    if (v < 40) assert.equal(versionFor(cap + 1), v + 1, `${cap + 1} bytes`);
  });
  assert.throws(() => qr.encode('a'.repeat(GOLD.byteCapacityM[39] + 1)), RangeError);
});

test('qr.encode refuses anything but a string', () => {
  for (const bad of [42, null, undefined, Buffer.from('x'), ['x'], { text: 'x' }]) assert.throws(() => qr.encode(bad), TypeError);
});

test('the vendored encoder keeps its provenance and licence, and only qr.js uses it', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/main/vendor/qrcodegen.js'), 'utf8');
  for (const s of [
    'v1.8.0',
    'https://raw.githubusercontent.com/nayuki/QR-Code-generator/v1.8.0/typescript-javascript/qrcodegen.ts',
    'c4749095a91bf9696e3a303998b9905e467094f53041e64393e65e6d887737fd',
    'Copyright (c) Project Nayuki. (MIT License)',
    'Permission is hereby granted, free of charge',
  ]) assert.ok(src.includes(s), s);
  assert.match(src, /hand-ported to CommonJS \(types removed\)/i);
  assert.match(src, /^module\.exports = \{ QrCode, QrSegment \};$/m);
  const users = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (p.endsWith('.js') && /vendor\/qrcodegen/.test(fs.readFileSync(p, 'utf8'))) users.push(path.relative(ROOT, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepEqual(users, ['src/main/qr.js']);
});

/** electron-builder `files:` glob (the subset this repo uses: *, **, {a,b}) → RegExp. */
function globToRegExp(glob) {
  const conv = (g) => {
    let re = '';
    for (let i = 0; i < g.length; i++) {
      const c = g[i];
      if (c === '*' && g[i + 1] === '*') {
        if (g[i + 2] === '/') { re += '(?:[^/]+/)*'; i += 2; } else { re += '.*'; i += 1; }
      } else if (c === '*') {
        re += '[^/]*';
      } else if (c === '{') {
        const end = g.indexOf('}', i);
        re += `(?:${g.slice(i + 1, end).split(',').map(conv).join('|')})`;
        i = end;
      } else {
        re += c.replace(/[.+?^$()|[\]\\]/g, '\\$&');
      }
    }
    return re;
  };
  return new RegExp(`^${conv(glob)}$`);
}

test('src/main/vendor is syntax-checked by scripts/check.js and packaged by electron-builder', () => {
  const files = ['src/main/vendor/qrcodegen.js', 'src/main/qr.js', 'src/main/pairing.js', 'src/main/identity.js'];
  const r = spawnSync(process.execPath, ['scripts/check.js', ...files], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /checked 4 file\(s\), 0 with syntax errors/);

  const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
  const list = /^files:\s*\n((?:[ \t]+-[^\n]*\n)+)/m.exec(yml);
  assert.ok(list, 'no files: list in electron-builder.yml');
  const patterns = list[1].split('\n').map((l) => l.trim().replace(/^-\s*/, '').replace(/^"(.*)"$/, '$1')).filter(Boolean);
  // electron-builder applies the patterns in order; a later "!" pattern removes a match.
  const packaged = (rel) => patterns.reduce((inc, p) => (globToRegExp(p.replace(/^!/, '')).test(rel) ? !p.startsWith('!') : inc), false);
  for (const rel of files) assert.equal(packaged(rel), true, rel);
  for (const rel of ['test/qr.test.js', 'test/fixtures/qr-golden.json', 'scripts/make-mobile-fixtures.js', 'docs/ARCHITECTURE.md', 'src/main/README.md']) {
    assert.equal(packaged(rel), false, rel);
  }
});
