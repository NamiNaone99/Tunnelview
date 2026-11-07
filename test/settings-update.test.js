'use strict';
/*
 * node --test test/settings-update.test.js — the in-app update settings in src/main/settings.js
 * (DECISIONS U3): autoUpdateCheck and lastUpdateCheckAt. Pure Node, temp folders.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Settings, DEFAULTS } = require('../src/main/settings');

const dirs = [];
test.after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

function make(onDisk) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnelview-settings-update-'));
  dirs.push(dir);
  if (onDisk) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(onDisk));
  const s = new Settings({ dir, downloadsDir: path.join(dir, 'Downloads') });
  s.load();
  return { s, dir, file: path.join(dir, 'settings.json') };
}

test('defaults: automatic checks on, never checked', () => {
  assert.equal(DEFAULTS.autoUpdateCheck, true);
  assert.equal(DEFAULTS.lastUpdateCheckAt, null);
  const { s, file } = make();
  assert.equal(s.get().autoUpdateCheck, true);
  assert.equal(s.get().lastUpdateCheckAt, null);
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.autoUpdateCheck, true);
  assert.equal(disk.lastUpdateCheckAt, null);
  // The renderer view carries both (the UI shows "last checked …").
  assert.equal(s.getPublic().autoUpdateCheck, true);
  assert.equal(s.getPublic().lastUpdateCheckAt, null);
});

test('an older settings file without the keys gets the defaults and is rewritten', () => {
  const { s, file } = make({ version: 1, theme: 'dark', closeToTray: false });
  assert.equal(s.get().theme, 'dark');
  assert.equal(s.get().autoUpdateCheck, true);
  assert.equal(s.get().lastUpdateCheckAt, null);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).autoUpdateCheck, true);
});

test('autoUpdateCheck: booleans only; round-trips through disk', () => {
  const { s, dir } = make();
  s.update({ autoUpdateCheck: false });
  assert.equal(s.get().autoUpdateCheck, false);
  for (const bad of ['false', 0, 1, null, {}, [], 'yes']) {
    s.update({ autoUpdateCheck: bad });
    assert.equal(s.get().autoUpdateCheck, false, `${JSON.stringify(bad)} keeps the old value`);
  }
  const again = new Settings({ dir, downloadsDir: path.join(dir, 'Downloads') });
  again.load();
  assert.equal(again.get().autoUpdateCheck, false);
  assert.equal(make({ version: 1, autoUpdateCheck: 'no' }).s.get().autoUpdateCheck, true, 'garbage on disk → default');
});

test('lastUpdateCheckAt: null or a non-negative safe integer; anything else keeps the old value', () => {
  const { s, dir } = make();
  const t = Date.UTC(2026, 10, 7, 12, 0, 0);
  s.update({ lastUpdateCheckAt: t });
  assert.equal(s.get().lastUpdateCheckAt, t);
  for (const bad of [-1, 1.5, '1700000000000', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, {}, true]) {
    s.update({ lastUpdateCheckAt: bad });
    assert.equal(s.get().lastUpdateCheckAt, t, `${String(bad)} rejected`);
  }
  const again = new Settings({ dir, downloadsDir: path.join(dir, 'Downloads') });
  again.load();
  assert.equal(again.get().lastUpdateCheckAt, t);
  s.update({ lastUpdateCheckAt: null });
  assert.equal(s.get().lastUpdateCheckAt, null);
  s.update({ lastUpdateCheckAt: 0 });
  assert.equal(s.get().lastUpdateCheckAt, 0);
  assert.equal(make({ version: 1, lastUpdateCheckAt: -5 }).s.get().lastUpdateCheckAt, null, 'garbage on disk → default');
  // A value in the future is stored as it is; updater.js ignores one more than a day ahead.
  const future = Date.now() + 10 * 24 * 3600 * 1000;
  s.update({ lastUpdateCheckAt: future });
  assert.equal(s.get().lastUpdateCheckAt, future);
});
