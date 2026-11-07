#!/usr/bin/env node
'use strict';
/*
 * Syntax-checks JavaScript files.
 *   node scripts/check.js              → every .js under src/, scripts/, test/
 *   node scripts/check.js a.js b.js    → only those files
 * Files under src/renderer/ (and *.mjs) are parsed as ES modules (vm.SourceTextModule);
 * everything else as CommonJS. (`node --check` is NOT reliable for ESM: it exits 0 on errors.)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (!process.execArgv.includes('--experimental-vm-modules')) {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', __filename, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

const vm = require('vm');
const Module = require('module');
const root = path.resolve(__dirname, '..');

function walk(dir, out) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name.startsWith('.')) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(c|m)?js$/.test(ent.name)) out.push(p);
  }
  return out;
}

const files = process.argv.length > 2
  ? process.argv.slice(2).map((f) => path.resolve(f))
  : ['src', 'scripts', 'test'].flatMap((d) => walk(path.join(root, d), []));

let failed = 0;
for (const file of files) {
  const rel = path.relative(root, file).split(path.sep).join('/');
  const isEsm = file.endsWith('.mjs') || rel.startsWith('src/renderer/');
  let src;
  try { src = fs.readFileSync(file, 'utf8'); } catch (e) { console.error(`✗ ${rel}: ${e.message}`); failed++; continue; }
  if (src.startsWith('#!')) src = '//' + src.slice(2);
  try {
    if (isEsm) new vm.SourceTextModule(src, { identifier: file });
    else new vm.Script(Module.wrap(src), { filename: file });
  } catch (e) {
    failed++;
    const loc = e.stack && e.stack.split('\n').find((l) => l.includes(file));
    console.error(`✗ ${rel} [${isEsm ? 'esm' : 'cjs'}]: ${e.message}${loc ? `\n    ${loc.trim()}` : ''}`);
  }
}
console.log(`${failed ? '✗' : '✓'} checked ${files.length} file(s), ${failed} with syntax errors`);
process.exit(failed ? 1 : 0);
