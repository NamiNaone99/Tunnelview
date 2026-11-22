#!/usr/bin/env node
'use strict';
/*
 * Builds, signs and verifies tunnelview-update.json for a release (DECISIONS U1).
 *
 *   UPDATE_SIGNING_KEY="$(cat key.pem)" node scripts/sign-update.js \
 *     --version 0.3.0 --dir dist --pub <base64url raw public key> [--notes-file notes.txt] [--date ISO]
 *
 *   --version X.Y.Z   the release version (every asset name contains it)
 *   --dir <folder>    holds the four release assets (Tunnelview-Setup-X.Y.Z-x64.exe,
 *                     Tunnelview-Setup-X.Y.Z-arm64.exe, Tunnelview-X.Y.Z-mac-arm64.zip,
 *                     Tunnelview-X.Y.Z-mac-x64.zip); <folder>/tunnelview-update.json is written
 *   --pub <b64url>    the public key the manifest must verify with (repository variable
 *                     UPDATE_PUBLIC_KEY); it must also be the key embedded in src/main/update-keys.js
 *   --notes-file <f>  release notes, plain text: CRLF → LF, trailing whitespace trimmed, at most 4000
 *                     characters, no control characters except newline and tab (default: none)
 *   --date <ISO>      the manifest date, as Date#toISOString() writes it (default: now)
 *   UPDATE_SIGNING_KEY  the Ed25519 private key, PKCS8 PEM (CI secret in the `release` environment)
 *
 * Node built-ins plus src/main/update-manifest.js and update-keys.js only, so the CI job that signs
 * runs no npm install. Steps: size + SHA-256 of the four assets → payload → signature → the file
 * is verified twice before it is written, against --pub and against update-keys.js (both must
 * pass, so a manifest the app would reject is never uploaded). The private key is never printed.
 * Exit codes: 0 written and verified, 1 failed, 2 bad usage.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const manifest = require('../src/main/update-manifest');
const { KEYS } = require('../src/main/update-keys');

const OPTIONS = ['version', 'dir', 'pub', 'notes-file', 'date'];
const REQUIRED = ['version', 'dir', 'pub'];
const USAGE = 'usage: UPDATE_SIGNING_KEY=<PEM> node scripts/sign-update.js --version X.Y.Z --dir <folder> --pub <base64url> [--notes-file <file>] [--date <ISO>]';

class Failure extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = /^--([a-z-]+)(?:=(.*))?$/s.exec(a);
    if (!m || !OPTIONS.includes(m[1])) throw new Failure(`unknown argument: ${String(a).slice(0, 60)}\n${USAGE}`, 2);
    if (Object.prototype.hasOwnProperty.call(out, m[1])) throw new Failure(`--${m[1]} given twice\n${USAGE}`, 2);
    let v = m[2];
    if (v === undefined) {
      v = argv[i + 1];
      i++;
    }
    if (typeof v !== 'string' || v === '') throw new Failure(`--${m[1]} needs a value\n${USAGE}`, 2);
    out[m[1]] = v;
  }
  for (const k of REQUIRED) if (!out[k]) throw new Failure(`--${k} is required\n${USAGE}`, 2);
  return out;
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    let size = 0;
    fs.createReadStream(file)
      .on('data', (c) => { size += c.length; hash.update(c); })
      .on('error', reject)
      .on('end', () => resolve({ size, sha256: hash.digest('hex') }));
  });
}

/** The private key from the environment; any failure is reported without the key or OpenSSL text. */
function signingKey(env) {
  const pem = env.UPDATE_SIGNING_KEY;
  if (typeof pem !== 'string' || !pem.trim()) throw new Failure('UPDATE_SIGNING_KEY is not set.');
  let key;
  try {
    key = crypto.createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new Failure('UPDATE_SIGNING_KEY is not a readable private key (expected Ed25519 PKCS8 PEM).');
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Failure('UPDATE_SIGNING_KEY is not an Ed25519 key.');
  return key;
}

/**
 * @param {string[]} argv
 * @param {{env?:object, keys?:Array, log?:Function, error?:Function}} [opts] keys: the embedded key
 *   list (tests pass a throwaway one); default src/main/update-keys.js
 * @returns {Promise<number>} exit code
 */
async function main(argv, { env = process.env, keys = KEYS, log = console.log, error = console.error } = {}) {
  try {
    const args = parseArgs(argv);
    const version = args.version;
    if (!manifest.validVersion(version)) throw new Failure(`--version must be X.Y.Z (digits only): ${version.slice(0, 40)}`, 2);
    const dir = path.resolve(args.dir);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Failure(`--dir is not a folder: ${dir}`);

    // The expected public key: well-formed, and the one the app embeds under its kid.
    const pubRaw = manifest.decodeB64url(args.pub, 32);
    if (!pubRaw) throw new Failure('--pub must be a raw 32-byte Ed25519 public key in base64url without padding.', 2);
    const kid = manifest.keyId(pubRaw);
    const embedded = Array.isArray(keys) ? keys.find((k) => k && k.kid === kid) : null;
    if (!embedded || embedded.publicKey !== args.pub) {
      throw new Failure(`--pub (key id ${kid}) is not a key embedded in src/main/update-keys.js: the app would reject this manifest.`);
    }
    const key = signingKey(env);
    if (!manifest.rawPublicKey(key).equals(pubRaw)) throw new Failure('UPDATE_SIGNING_KEY does not belong to --pub.');

    let notes = '';
    if (args['notes-file']) {
      let text;
      try { text = fs.readFileSync(path.resolve(args['notes-file']), 'utf8'); } catch (e) { throw new Failure(`cannot read --notes-file: ${e.code || e.message}`); }
      notes = manifest.normalizeNotes(text);
      if (notes.length > manifest.MAX_NOTES_LENGTH) throw new Failure(`the release notes are ${notes.length} characters; at most ${manifest.MAX_NOTES_LENGTH} are allowed.`);
      if (!manifest.validNotes(notes)) throw new Failure('the release notes contain control, bidi or separator characters (only newline and tab are allowed).');
    }
    const date = args.date || new Date().toISOString();
    if (!manifest.validDate(date)) throw new Failure('--date must be an ISO date as toISOString() writes it (YYYY-MM-DDTHH:MM:SS.sssZ).', 2);

    const files = {};
    for (const platformKey of manifest.PLATFORM_KEYS) {
      const name = manifest.assetName(platformKey, version);
      const file = path.join(dir, name);
      let st;
      try { st = fs.statSync(file); } catch { throw new Failure(`missing release asset: ${name}`); }
      if (!st.isFile()) throw new Failure(`not a file: ${name}`);
      if (st.size < 1 || st.size > manifest.MAX_ASSET_BYTES) throw new Failure(`${name} is ${st.size} bytes; allowed: 1 … ${manifest.MAX_ASSET_BYTES}.`);
      const h = await sha256File(file);
      if (h.size !== st.size) throw new Failure(`${name} changed while it was read.`);
      files[platformKey] = { name, size: h.size, sha256: h.sha256 };
    }

    const payload = manifest.buildPayload({ version, date, notes, files });
    const bad = manifest.validatePayload(payload);
    if (bad) throw new Failure(`the manifest is not valid (${bad}).`);
    const bytes = manifest.signManifest(payload, key, kid);

    // Verified exactly as the app will verify it: against --pub, and against the embedded list.
    for (const [what, list] of [['--pub', [{ kid, publicKey: args.pub }]], ['src/main/update-keys.js', keys]]) {
      const v = manifest.verifyManifest(bytes, { keys: list });
      if (!v.ok) throw new Failure(`the signed manifest does not verify against ${what} (${v.code}${v.detail ? `: ${v.detail}` : ''}).`);
      if (!manifest.encodePayload(v.manifest).equals(manifest.encodePayload(payload))) throw new Failure(`the verified manifest differs from what was signed (${what}).`);
    }

    const out = path.join(dir, manifest.MANIFEST_NAME);
    const tmp = `${out}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, out);
    log(`${manifest.MANIFEST_NAME} written for ${version} (key id ${kid}, ${bytes.length} bytes): ${out}`);
    for (const k of manifest.PLATFORM_KEYS) log(`  ${k.padEnd(13)} ${files[k].name}  ${files[k].size} bytes  sha256 ${files[k].sha256}`);
    return 0;
  } catch (e) {
    if (e instanceof Failure) {
      error(`sign-update: ${e.message}`);
      return e.exitCode;
    }
    error(`sign-update: failed: ${e && e.code ? e.code : 'error'}`);
    return 1;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { main };
