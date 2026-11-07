#!/usr/bin/env node
'use strict';
/*
 * Verifies the Electron fuses and the ASAR integrity data of packaged Tunnelview builds.
 *   node scripts/verify-fuses.js dist/win-unpacked/Tunnelview.exe dist/mac-arm64/Tunnelview.app …
 * For every app given:
 *  - each fuse listed under `electronFuses` in electron-builder.yml has exactly that state in the
 *    packaged Electron binary (a misspelt key or an electron-builder change would otherwise ship
 *    stock fuses, i.e. ELECTRON_RUN_AS_NODE / NODE_OPTIONS / --inspect working again);
 *  - when enableEmbeddedAsarIntegrityValidation is on, the integrity data electron-builder embeds
 *    (Windows: INTEGRITY/ELECTRONASAR exe resource; macOS: Info.plist ElectronAsarIntegrity) exists
 *    and equals the SHA-256 of resources/app.asar's header. Otherwise Electron refuses to start.
 * Reads binaries only; never launches the app. No dependencies (the helpers are unit-tested in
 * test/packaging.test.js).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// @electron/fuses FuseV1Options order (the index of each fuse in the V1 fuse wire).
const FUSE_V1_INDEX = Object.freeze({
  runAsNode: 0,
  enableCookieEncryption: 1,
  enableNodeOptionsEnvironmentVariable: 2,
  enableNodeCliInspectArguments: 3,
  enableEmbeddedAsarIntegrityValidation: 4,
  onlyLoadAppFromAsar: 5,
  loadBrowserProcessSpecificV8Snapshot: 6,
  grantFileProtocolExtraPrivileges: 7,
});
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'latin1');
const FUSE_DISABLE = 0x30; // '0'
const FUSE_ENABLE = 0x31; // '1'

/** Parses the top-level `electronFuses:` block of electron-builder.yml → { key: boolean }. */
function parseFuseConfig(yml) {
  const lines = String(yml).split(/\r?\n/);
  const start = lines.findIndex((l) => /^electronFuses:\s*(#.*)?$/.test(l));
  if (start < 0) throw new Error('electron-builder.yml has no top-level electronFuses section');
  const out = {};
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) continue; // blank or comment
    if (!/^\s/.test(line)) break; // next top-level key
    const m = /^\s+([A-Za-z][A-Za-z0-9]*):\s*(true|false)\s*(#.*)?$/.exec(line);
    if (!m) throw new Error(`unsupported electronFuses line: ${line.trim()}`);
    if (Object.prototype.hasOwnProperty.call(out, m[1])) throw new Error(`duplicate fuse ${m[1]}`);
    out[m[1]] = m[2] === 'true';
  }
  return out;
}

/** Every fuse wire in an Electron binary (a universal macOS binary carries two). */
function readFuseWires(buf) {
  const wires = [];
  for (let at = buf.indexOf(SENTINEL); at !== -1; at = buf.indexOf(SENTINEL, at + SENTINEL.length)) {
    const pos = at + SENTINEL.length;
    if (pos + 2 > buf.length) break;
    const version = buf[pos];
    const length = buf[pos + 1];
    if (pos + 2 + length > buf.length) break;
    wires.push({ offset: at, version, states: [...buf.subarray(pos + 2, pos + 2 + length)] });
  }
  return wires;
}

/** → array of human-readable problems (empty when every configured fuse matches). */
function compareFuses(expected, wire) {
  const problems = [];
  if (wire.version !== 1) problems.push(`unknown fuse wire version ${wire.version}`);
  for (const [name, want] of Object.entries(expected)) {
    const idx = FUSE_V1_INDEX[name];
    if (idx === undefined) { problems.push(`unknown fuse "${name}"`); continue; }
    if (idx >= wire.states.length) { problems.push(`${name}: not present in this Electron's fuse wire`); continue; }
    const got = wire.states[idx];
    const ok = got === (want ? FUSE_ENABLE : FUSE_DISABLE);
    if (!ok) {
      const label = got === FUSE_ENABLE ? 'enabled' : got === FUSE_DISABLE ? 'disabled' : `state 0x${got.toString(16)}`;
      problems.push(`${name}: expected ${want ? 'enabled' : 'disabled'}, binary has ${label}`);
    }
  }
  return problems;
}

/** SHA-256 (hex) of an asar archive's JSON header — what Electron's integrity check hashes. */
function asarHeaderHash(buf) {
  // Chromium pickles: [u32 payload=4][u32 headerPickleSize] then [u32 payload][i32 strLen][str…].
  if (buf.length < 16) throw new Error('asar too short');
  const headerSize = buf.readUInt32LE(4);
  const strLen = buf.readInt32LE(12);
  if (strLen < 0 || 16 + strLen > 8 + headerSize || 16 + strLen > buf.length) throw new Error('corrupt asar header');
  return crypto.createHash('sha256').update(buf.subarray(16, 16 + strLen)).digest('hex');
}

/** Windows: the JSON list electron-builder stores in the exe's INTEGRITY/ELECTRONASAR resource. */
function findWinIntegrity(exeBuf) {
  const marker = Buffer.from('[{"file":', 'latin1');
  for (let at = exeBuf.indexOf(marker); at !== -1; at = exeBuf.indexOf(marker, at + 1)) {
    const end = exeBuf.indexOf(0x5d /* ] */, at);
    if (end === -1 || end - at > 4096) continue;
    try {
      const list = JSON.parse(exeBuf.subarray(at, end + 1).toString('utf8'));
      if (Array.isArray(list) && list.every((e) => e && typeof e.file === 'string' && typeof e.value === 'string')) {
        return list.map((e) => ({ file: e.file.replace(/\\/g, '/'), algorithm: e.alg, hash: e.value }));
      }
    } catch { /* not the resource; keep searching */ }
  }
  return null;
}

/** macOS: Info.plist → ElectronAsarIntegrity entries (electron-builder writes XML plists). */
function findMacIntegrity(plistXml) {
  const m = /<key>ElectronAsarIntegrity<\/key>\s*<dict>([\s\S]*?)<\/dict>\s*<\/dict>/.exec(String(plistXml));
  if (!m) return null;
  const out = [];
  const re = /<key>([^<]+)<\/key>\s*<dict>\s*<key>algorithm<\/key>\s*<string>([^<]*)<\/string>\s*<key>hash<\/key>\s*<string>([^<]*)<\/string>/g;
  for (let e; (e = re.exec(m[1]));) out.push({ file: e[1], algorithm: e[2], hash: e[3] });
  return out;
}

function appLayout(appPath) {
  if (/\.app\/?$/i.test(appPath)) {
    const contents = path.join(appPath, 'Contents');
    return {
      platform: 'mac',
      fuseBinary: path.join(contents, 'Frameworks', 'Electron Framework.framework', 'Electron Framework'),
      asar: path.join(contents, 'Resources', 'app.asar'),
      asarKey: 'Resources/app.asar',
      plist: path.join(contents, 'Info.plist'),
    };
  }
  return {
    platform: 'win',
    fuseBinary: appPath,
    asar: path.join(path.dirname(appPath), 'resources', 'app.asar'),
    asarKey: 'resources/app.asar',
  };
}

function verifyApp(appPath, expected) {
  const layout = appLayout(appPath);
  const problems = [];
  const bin = fs.readFileSync(layout.fuseBinary);
  const wires = readFuseWires(bin);
  if (!wires.length) problems.push(`no fuse wire found in ${layout.fuseBinary}`);
  for (const wire of wires) problems.push(...compareFuses(expected, wire));

  if (expected.enableEmbeddedAsarIntegrityValidation) {
    try {
      const want = asarHeaderHash(fs.readFileSync(layout.asar));
      const entries = layout.platform === 'mac'
        ? findMacIntegrity(fs.readFileSync(layout.plist, 'utf8'))
        : findWinIntegrity(bin);
      const entry = entries && entries.find((e) => e.file.toLowerCase() === layout.asarKey.toLowerCase());
      if (!entry) problems.push(`no ASAR integrity entry for ${layout.asarKey}`);
      else if (String(entry.algorithm).toUpperCase() !== 'SHA256' || entry.hash.toLowerCase() !== want) {
        problems.push(`ASAR integrity mismatch for ${layout.asarKey}: embedded ${entry.algorithm}:${entry.hash}, app.asar header ${want}`);
      }
    } catch (err) {
      problems.push(`ASAR integrity: ${err.message}`);
    }
  }
  return problems;
}

function main(argv) {
  const apps = argv.slice(2);
  if (!apps.length) {
    console.error('usage: node scripts/verify-fuses.js <Tunnelview.exe | Tunnelview.app> [...]');
    return 2;
  }
  const yml = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8');
  const expected = parseFuseConfig(yml);
  let failed = 0;
  for (const app of apps) {
    let problems;
    try { problems = verifyApp(app, expected); } catch (err) { problems = [err.message]; }
    if (problems.length) {
      failed++;
      for (const p of problems) console.error(`✗ ${app}: ${p}`);
    } else {
      console.log(`✓ ${app}: ${Object.keys(expected).length} fuse(s) as configured, ASAR integrity ok`);
    }
  }
  return failed ? 1 : 0;
}

module.exports = {
  FUSE_V1_INDEX, parseFuseConfig, readFuseWires, compareFuses, asarHeaderHash,
  findWinIntegrity, findMacIntegrity, appLayout,
};

if (require.main === module) process.exit(main(process.argv));
