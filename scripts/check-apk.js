#!/usr/bin/env node
'use strict';
/*
 * Release gates for the Tunnelview Android APK (Node 18+, no dependencies).
 * Used by .github/workflows/android.yml: the build job (no secrets) and the sign jobs.
 *
 *   node scripts/check-apk.js lock <pubspec.lock> <pubspec-allow.txt>
 *       Every package in pubspec.lock is on the allow-list (and the reverse); hosted packages
 *       come from https://pub.dev only.
 *   node scripts/check-apk.js classpath <gradle-dependencies.txt> <allow.txt> [--print]
 *       The resolved releaseRuntimeClasspath (`gradlew :app:dependencies --configuration
 *       releaseRuntimeClasspath`) equals the allow-list; no banned groups. --print writes the
 *       parsed list to stdout, to review and paste into the allow-list.
 *   node scripts/check-apk.js apk <file.apk> --package <applicationId> --build-tools <dir>
 *         [--mapping <mapping.txt>] (--unsigned | --cert <SHA-256 colon hex>)
 *       Manifest policy (permissions, exported components, intent filters, <queries>,
 *       application flags), APK entries, R8 mapping ban-list, zipalign -c -P 16 -v 4, and
 *       either "not signed at all" or "signed by exactly this certificate with v2 + v3".
 *
 * Exits 1 with a list of every failure.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// ---- Policy -------------------------------------------------------------------------------

const ANDROID_NS = 'http://schemas.android.com/apk/res/android:';
const LAUNCHER_ACTIVITY = 'io.github.naminaone99.tunnelview.MainActivity';
const MIN_SDK = 24;
const TARGET_SDK = 36;

// Exactly these permissions (PLAN §6.10). Libraries' extras are removed in AndroidManifest.xml.
const PERMISSIONS = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.CAMERA',
  // local_auth / androidx.biometric (biometric or device-credential prompt, DECISIONS M-S9).
  // Both are install-time "normal" permissions with no network or data access.
  'android.permission.USE_BIOMETRIC',
  'android.permission.USE_FINGERPRINT',
];
// androidx.core declares and uses <applicationId>.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION
// (signature-level, for its own non-exported dynamic receivers). It may appear or not.
const OPTIONAL_PERMISSION_SUFFIX = '.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION';

const QUERIES_PACKAGES = ['com.tailscale.ipn'];

// No analytics, crash reporting, ML Kit, Firebase or Play-services code (Tailscale-only promise).
const BANNED_PREFIXES = [
  'com.google.mlkit',
  'com.google.firebase',
  'com.google.android.gms',
  'com.google.android.play',
  'com.google.android.datatransport',
  'io.sentry',
  'com.crashlytics',
  'com.bugsnag',
];
const BANNED_ENTRY_RE = /firebase|play-services|mlkit|crashlytics|sentry|barhopper|bugsnag/i;
const REQUIRED_ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64'];

// ---- Small helpers ------------------------------------------------------------------------

const errors = [];
const fail = (msg) => errors.push(msg);
const info = (msg) => console.log(msg);

function readLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/);
}

function readAllowList(file) {
  return readLines(file)
    .map((l) => l.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

function compareSets(label, actual, allowed) {
  const a = new Set(actual);
  const b = new Set(allowed);
  const extra = [...a].filter((x) => !b.has(x)).sort();
  const missing = [...b].filter((x) => !a.has(x)).sort();
  for (const x of extra) fail(`${label}: not on the allow-list: ${x}`);
  for (const x of missing) fail(`${label}: on the allow-list but not present (update the list): ${x}`);
  return extra.length === 0 && missing.length === 0;
}

function bannedPrefix(name) {
  return BANNED_PREFIXES.find((p) => name === p || name.startsWith(p + '.') || name.startsWith(p + ':'));
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`${cmd}: ${r.error.message}`);
  return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (['unsigned', 'print'].includes(k)) opt[k] = true;
      else opt[k] = argv[++i];
    } else pos.push(a);
  }
  return { pos, opt };
}

// ---- pubspec.lock -------------------------------------------------------------------------

function parsePubspecLock(text) {
  const pkgs = [];
  let inPackages = false;
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inPackages = line.trim() === 'packages:';
      cur = null;
      continue;
    }
    if (!inPackages) continue;
    let m = /^ {2}([A-Za-z0-9_]+):\s*$/.exec(line);
    if (m) {
      cur = { name: m[1], source: null, url: null };
      pkgs.push(cur);
      continue;
    }
    if (!cur) continue;
    if ((m = /^ {4}source:\s*(\S+)/.exec(line))) cur.source = m[1].replace(/"/g, '');
    else if ((m = /^ {6}url:\s*"?([^"\s]+)"?/.exec(line))) cur.url = m[1];
  }
  return pkgs;
}

function checkLock(lockFile, allowFile) {
  const pkgs = parsePubspecLock(fs.readFileSync(lockFile, 'utf8'));
  if (pkgs.length === 0) fail(`${lockFile}: no packages found`);
  for (const p of pkgs) {
    if (p.source === 'hosted') {
      if (p.url !== 'https://pub.dev') fail(`pubspec.lock: ${p.name} is hosted at ${p.url}, not https://pub.dev`);
    } else if (p.source !== 'sdk') {
      fail(`pubspec.lock: ${p.name} has source ${p.source} (only hosted and sdk are allowed)`);
    }
    const b = bannedPrefix(p.name);
    if (/firebase|mlkit|sentry|crashlytics|analytics|google_mobile_ads|play_services/i.test(p.name)) {
      fail(`pubspec.lock: banned package ${p.name}${b ? ` (${b})` : ''}`);
    }
  }
  compareSets('pubspec.lock', pkgs.map((p) => p.name), readAllowList(allowFile));
  info(`pubspec.lock: ${pkgs.length} packages checked`);
}

// ---- Gradle runtime classpath -------------------------------------------------------------

function parseGradleDependencies(text) {
  const out = new Set();
  let started = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!started) {
      if (/^releaseRuntimeClasspath\b/.test(line)) started = true;
      continue;
    }
    if (line === '') {
      if (out.size > 0) break;
      continue;
    }
    if (/^No dependencies/.test(line)) break;
    const m = /^[|\s]*[+\\]--- (.*)$/.exec(line);
    if (!m) continue;
    let dep = m[1].trim();
    let marker = null;
    const mm = / \(([*cn])\)$/.exec(dep);
    if (mm) {
      marker = mm[1];
      dep = dep.slice(0, mm.index).trim();
    }
    if (marker === 'c') continue; // a version constraint, not a dependency
    if (marker === 'n') {
      fail(`classpath: unresolved dependency: ${dep}`);
      continue;
    }
    if (/ FAILED$/.test(dep)) {
      fail(`classpath: FAILED dependency: ${dep}`);
      continue;
    }
    if (dep.startsWith('project ')) {
      out.add(dep);
      continue;
    }
    let version = null;
    let coords = dep;
    const arrow = dep.indexOf(' -> ');
    if (arrow >= 0) {
      coords = dep.slice(0, arrow).trim();
      version = dep.slice(arrow + 4).trim();
    }
    const parts = coords.split(':');
    if (parts.length < 2) {
      fail(`classpath: cannot parse: ${line}`);
      continue;
    }
    if (!version) version = parts.slice(2).join(':');
    if (!version) {
      fail(`classpath: no version for ${coords}`);
      continue;
    }
    out.add(`${parts[0]}:${parts[1]}:${version}`);
  }
  if (!started) fail('classpath: no "releaseRuntimeClasspath" section found');
  return [...out].sort();
}

function checkClasspath(depsFile, allowFile, print) {
  const deps = parseGradleDependencies(fs.readFileSync(depsFile, 'utf8'));
  if (print) {
    console.log(deps.join('\n'));
    return;
  }
  for (const d of deps) {
    const b = bannedPrefix(d);
    if (b) fail(`classpath: banned dependency ${d} (${b})`);
  }
  compareSets('releaseRuntimeClasspath', deps, readAllowList(allowFile));
  info(`releaseRuntimeClasspath: ${deps.length} entries checked`);
}

// ---- Binary manifest (aapt2 dump xmltree) -------------------------------------------------

function parseAttrValue(v) {
  const q = /^"((?:[^"\\]|\\.)*)"/.exec(v);
  if (q) return q[1].replace(/\\(.)/g, '$1');
  return v.replace(/^\(type 0x[0-9a-f]+\)/i, '').split(' ')[0];
}

function parseXmlTree(text) {
  const root = { name: '#root', attrs: {}, children: [], indent: -1 };
  const stack = [root];
  for (const raw of text.split(/\r?\n/)) {
    const m = /^(\s*)([NEAT]): (.*)$/.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    const kind = m[2];
    const rest = m[3];
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (kind === 'A') {
      const eq = rest.indexOf('=');
      if (eq < 0) continue;
      let key = rest.slice(0, eq).replace(/\(0x[0-9a-fA-F]+\)$/, '');
      key = key.startsWith(ANDROID_NS) ? 'android:' + key.slice(ANDROID_NS.length) : key;
      parent.attrs[key] = parseAttrValue(rest.slice(eq + 1));
    } else if (kind === 'E' || kind === 'N') {
      const node = {
        name: kind === 'E' ? rest.replace(/ \(line=\d+\)$/, '') : '#ns',
        attrs: {},
        children: [],
        indent,
      };
      parent.children.push(node);
      stack.push(node);
    }
  }
  return root;
}

// Element children, looking through namespace nodes.
function kids(node, name) {
  const out = [];
  for (const c of node.children) {
    if (c.name === '#ns') out.push(...kids(c, name));
    else if (!name || c.name === name) out.push(c);
  }
  return out;
}

function boolAttr(v) {
  if (v === undefined) return undefined;
  if (['true', '0xffffffff', '-1'].includes(v)) return true;
  if (['false', '0x0', '0x00000000', '0'].includes(v)) return false;
  return v;
}

function checkManifest(tree, expectedPackage) {
  const [manifest] = kids(tree, 'manifest');
  if (!manifest) {
    fail('manifest: no <manifest> element');
    return;
  }
  if (manifest.attrs.package !== expectedPackage) {
    fail(`manifest: package is ${manifest.attrs.package}, expected ${expectedPackage}`);
  }
  info(`manifest: package ${manifest.attrs.package}, versionName ${manifest.attrs['android:versionName']}, versionCode ${manifest.attrs['android:versionCode']}`);

  const [sdk] = kids(manifest, 'uses-sdk');
  const minSdk = Number(sdk && sdk.attrs['android:minSdkVersion']);
  const targetSdk = Number(sdk && sdk.attrs['android:targetSdkVersion']);
  if (!(minSdk >= MIN_SDK)) fail(`manifest: minSdkVersion ${minSdk} < ${MIN_SDK}`);
  if (targetSdk !== TARGET_SDK) fail(`manifest: targetSdkVersion ${targetSdk}, expected ${TARGET_SDK}`);

  // Permissions.
  const optional = expectedPackage + OPTIONAL_PERMISSION_SUFFIX;
  const perms = [...kids(manifest, 'uses-permission'), ...kids(manifest, 'uses-permission-sdk-23')]
    .map((e) => e.attrs['android:name']);
  info(`manifest: permissions: ${perms.join(', ')}`);
  compareSets('permissions', perms.filter((p) => p !== optional), PERMISSIONS);
  for (const p of kids(manifest, 'permission')) {
    if (p.attrs['android:name'] !== optional) fail(`manifest: declares permission ${p.attrs['android:name']}`);
  }

  // <queries>: one package, nothing else.
  const queried = [];
  for (const q of kids(manifest, 'queries')) {
    for (const c of kids(q)) {
      if (c.name === 'package') queried.push(c.attrs['android:name']);
      else fail(`manifest: <queries> contains <${c.name}> (only <package> is allowed)`);
    }
  }
  compareSets('queries', queried, QUERIES_PACKAGES);

  // <application> flags.
  const [app] = kids(manifest, 'application');
  if (!app) {
    fail('manifest: no <application>');
    return;
  }
  const a = app.attrs;
  if (boolAttr(a['android:allowBackup']) !== false) fail('application: allowBackup is not false');
  if (boolAttr(a['android:fullBackupContent']) === true) fail('application: fullBackupContent is true');
  if (boolAttr(a['android:debuggable']) === true) fail('application: debuggable');
  if (boolAttr(a['android:testOnly']) === true) fail('application: testOnly');
  if (boolAttr(a['android:usesCleartextTraffic']) !== false) fail('application: usesCleartextTraffic is not false');
  if (!a['android:networkSecurityConfig']) fail('application: no networkSecurityConfig');
  if (!a['android:dataExtractionRules']) fail('application: no dataExtractionRules');

  // Components.
  const launchers = [];
  for (const type of ['activity', 'activity-alias', 'service', 'receiver', 'provider']) {
    for (const c of kids(app, type)) {
      const name = c.attrs['android:name'];
      const filters = kids(c, 'intent-filter');
      const actions = filters.flatMap((f) => kids(f, 'action').map((x) => x.attrs['android:name']));
      const categories = filters.flatMap((f) => kids(f, 'category').map((x) => x.attrs['android:name']));
      const exportedAttr = boolAttr(c.attrs['android:exported']);
      const exported = exportedAttr === undefined ? filters.length > 0 : exportedAttr === true;
      const isLauncher = type === 'activity' &&
        actions.includes('android.intent.action.MAIN') &&
        categories.includes('android.intent.category.LAUNCHER');
      if (isLauncher) launchers.push(name);
      info(`  ${type} ${name} exported=${exported}${filters.length ? ` actions=${actions.join(',')}` : ''}`);
      if (actions.includes('android.intent.action.VIEW')) fail(`manifest: VIEW intent filter on ${type} ${name}`);
      if (exported && !(isLauncher && name === LAUNCHER_ACTIVITY)) fail(`manifest: ${type} ${name} is exported`);
      if (isLauncher && actions.some((x) => x !== 'android.intent.action.MAIN')) {
        fail(`manifest: launcher ${name} has extra actions: ${actions.join(', ')}`);
      }
    }
  }
  if (launchers.length !== 1 || launchers[0] !== LAUNCHER_ACTIVITY) {
    fail(`manifest: launcher activities ${JSON.stringify(launchers)}, expected [${LAUNCHER_ACTIVITY}]`);
  }
}

// ---- APK ----------------------------------------------------------------------------------

function checkMapping(file) {
  let classes = 0;
  let mentions = 0;
  for (const line of readLines(file)) {
    if (!line || line.startsWith('#')) continue;
    if (/^\s/.test(line)) {
      if (BANNED_PREFIXES.some((p) => line.includes(p + '.'))) mentions++;
      continue;
    }
    classes++;
    const original = line.split(' -> ')[0];
    const b = bannedPrefix(original);
    if (b) fail(`mapping: banned class ${original} (${b})`);
  }
  if (classes === 0) fail('mapping: no classes (is R8 on?)');
  info(`mapping: ${classes} classes checked${mentions ? `, ${mentions} member lines mention a banned package (warning)` : ''}`);
}

function checkEntries(apk) {
  const r = run('unzip', ['-Z1', apk]);
  if (r.status !== 0) {
    fail(`unzip -Z1 failed: ${r.out.slice(0, 500)}`);
    return;
  }
  const entries = r.out.split(/\r?\n/).filter(Boolean);
  for (const e of entries) {
    if (BANNED_ENTRY_RE.test(e)) fail(`apk: banned entry ${e}`);
  }
  for (const abi of REQUIRED_ABIS) {
    if (!entries.includes(`lib/${abi}/libflutter.so`)) fail(`apk: not universal, lib/${abi}/libflutter.so missing`);
  }
  info(`apk: ${entries.length} entries checked`);
}

function checkAlignment(apk, bt) {
  const r = run(path.join(bt, 'zipalign'), ['-c', '-P', '16', '-v', '4', apk]);
  const summary = r.out.trim().split(/\r?\n/).filter((l) => /Verification|BAD|\(BAD/.test(l));
  info(`zipalign -c -P 16 -v 4: exit ${r.status} ${summary.slice(-3).join(' | ')}`);
  if (r.status !== 0) fail(`zipalign -c -P 16 -v 4 failed:\n${summary.join('\n')}`);
}

function normHex(s) {
  return String(s || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
}

function checkSignature(apk, bt, opt) {
  const r = run(path.join(bt, 'apksigner'), ['verify', '--verbose', '--print-certs', apk]);
  if (opt.unsigned) {
    if (r.status === 0) fail('apk: expected an UNSIGNED APK, but apksigner verify succeeded (a signingConfig is set?)');
    else info('apk: unsigned, as expected (apksigner verify fails)');
    return;
  }
  const want = normHex(opt.cert);
  if (want.length !== 64) {
    fail('signature: --cert is not a SHA-256 fingerprint (is the repository variable set?)');
    return;
  }
  if (r.status !== 0) {
    fail(`signature: apksigner verify failed:\n${r.out.slice(0, 2000)}`);
    return;
  }
  const has = (re) => re.test(r.out);
  if (!has(/Verified using v2 scheme \(APK Signature Scheme v2\): true/)) fail('signature: not verified with v2');
  if (!has(/Verified using v3 scheme \(APK Signature Scheme v3\): true/)) fail('signature: not verified with v3');
  if (!has(/Number of signers: 1\b/)) fail('signature: not exactly one signer');
  const certs = [...r.out.matchAll(/Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]+)/g)].map((m) => normHex(m[1]));
  if (certs.length !== 1) fail(`signature: ${certs.length} signer certificates`);
  else if (certs[0] !== want) fail(`signature: signer certificate SHA-256 ${certs[0]} does not match the expected one`);
  else info(`signature: v2+v3, one signer, certificate SHA-256 matches (${certs[0]})`);
}

function checkApk(apk, opt) {
  if (!opt.package) throw new Error('--package is required');
  if (!opt['build-tools']) throw new Error('--build-tools is required');
  if (!opt.unsigned && !opt.cert) throw new Error('either --unsigned or --cert is required');
  const bt = opt['build-tools'];
  const dump = run(path.join(bt, 'aapt2'), ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk]);
  if (dump.status !== 0) fail(`aapt2 dump xmltree failed: ${dump.out.slice(0, 500)}`);
  else checkManifest(parseXmlTree(dump.out), opt.package);
  checkEntries(apk);
  if (opt.mapping) checkMapping(opt.mapping);
  checkAlignment(apk, bt);
  checkSignature(apk, bt, opt);
}

// ---- Main ---------------------------------------------------------------------------------

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  if (cmd === 'lock' && pos.length === 2) checkLock(pos[0], pos[1]);
  else if (cmd === 'classpath' && pos.length === 2) checkClasspath(pos[0], pos[1], opt.print);
  else if (cmd === 'apk' && pos.length === 1) checkApk(pos[0], opt);
  else {
    console.error('usage: check-apk.js lock <pubspec.lock> <allow.txt>\n' +
      '       check-apk.js classpath <deps.txt> <allow.txt> [--print]\n' +
      '       check-apk.js apk <file.apk> --package <id> --build-tools <dir> [--mapping <f>] (--unsigned | --cert <sha256>)');
    process.exit(2);
  }
  if (errors.length) {
    console.error(`\n✗ ${errors.length} problem(s):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  console.log('✓ all checks passed');
}

if (require.main === module) main();

module.exports = { parsePubspecLock, parseGradleDependencies, parseXmlTree, kids, boolAttr, checkManifest, errors };
