'use strict';
// Unit tests for the Android APK manifest and dex gates (scripts/check-apk.js). The fixture is
// `aapt2 dump xmltree --file AndroidManifest.xml` output of a Tunnelview release build.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseXmlTree, checkManifest, dexMentionsVpnService, errors } = require('../scripts/check-apk.js');

const NS = 'http://schemas.android.com/apk/res/android';
const PKG = 'io.github.naminaone99.tunnelview';

const FIXTURE = `N: android=${NS} (line=2)
  E: manifest (line=2)
    A: ${NS}:versionCode(0x0101021b)=300
    A: ${NS}:versionName(0x0101021c)="0.3.0" (Raw: "0.3.0")
    A: package="${PKG}" (Raw: "${PKG}")
      E: uses-sdk (line=7)
        A: ${NS}:minSdkVersion(0x0101020c)=24
        A: ${NS}:targetSdkVersion(0x01010270)=36
      E: uses-permission (line=12)
        A: ${NS}:name(0x01010003)="android.permission.INTERNET" (Raw: "android.permission.INTERNET")
      E: uses-permission (line=14)
        A: ${NS}:name(0x01010003)="android.permission.ACCESS_NETWORK_STATE" (Raw: "android.permission.ACCESS_NETWORK_STATE")
      E: uses-permission (line=16)
        A: ${NS}:name(0x01010003)="android.permission.CAMERA" (Raw: "android.permission.CAMERA")
      E: queries (line=24)
          E: package (line=25)
            A: ${NS}:name(0x01010003)="com.tailscale.ipn" (Raw: "com.tailscale.ipn")
      E: uses-permission (line=28)
        A: ${NS}:name(0x01010003)="android.permission.USE_BIOMETRIC" (Raw: "android.permission.USE_BIOMETRIC")
      E: uses-permission (line=29)
        A: ${NS}:name(0x01010003)="android.permission.USE_FINGERPRINT" (Raw: "android.permission.USE_FINGERPRINT")
      E: permission (line=31)
        A: ${NS}:name(0x01010003)="${PKG}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" (Raw: "${PKG}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        A: ${NS}:protectionLevel(0x01010009)=0x00000002
      E: uses-permission (line=35)
        A: ${NS}:name(0x01010003)="${PKG}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" (Raw: "${PKG}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
      E: application (line=37)
        A: ${NS}:label(0x01010001)="Tunnelview" (Raw: "Tunnelview")
        A: ${NS}:icon(0x01010002)=@0x7f0d0000
        A: ${NS}:allowBackup(0x01010280)=false
        A: ${NS}:fullBackupContent(0x010104eb)=false
        A: ${NS}:usesCleartextTraffic(0x010104ec)=false
        A: ${NS}:networkSecurityConfig(0x01010527)=@0x7f110002
        A: ${NS}:dataExtractionRules(0x0101063e)=@0x7f110000
          E: activity (line=48)
            A: ${NS}:name(0x01010003)="${PKG}.MainActivity" (Raw: "${PKG}.MainActivity")
            A: ${NS}:exported(0x01010010)=true
            A: ${NS}:launchMode(0x0101001d)=1
              E: meta-data (line=64)
                A: ${NS}:name(0x01010003)="io.flutter.embedding.android.NormalTheme" (Raw: "io.flutter.embedding.android.NormalTheme")
                A: ${NS}:resource(0x01010025)=@0x7f0f00a3
              E: meta-data (line=68)
                A: ${NS}:name(0x01010003)="flutter_deeplinking_enabled" (Raw: "flutter_deeplinking_enabled")
                A: ${NS}:value(0x01010024)=false
              E: intent-filter (line=71)
                  E: action (line=72)
                    A: ${NS}:name(0x01010003)="android.intent.action.MAIN" (Raw: "android.intent.action.MAIN")
                  E: category (line=74)
                    A: ${NS}:name(0x01010003)="android.intent.category.LAUNCHER" (Raw: "android.intent.category.LAUNCHER")
          E: meta-data (line=81)
            A: ${NS}:name(0x01010003)="flutterEmbedding" (Raw: "flutterEmbedding")
            A: ${NS}:value(0x01010024)=2
          E: provider (line=85)
            A: ${NS}:name(0x01010003)="io.flutter.plugins.imagepicker.ImagePickerFileProvider" (Raw: "io.flutter.plugins.imagepicker.ImagePickerFileProvider")
            A: ${NS}:exported(0x01010010)=false
            A: ${NS}:authorities(0x01010018)="${PKG}.flutter.image_provider" (Raw: "${PKG}.flutter.image_provider")
          E: service (line=95)
            A: ${NS}:name(0x01010003)="androidx.camera.core.impl.MetadataHolderService" (Raw: "androidx.camera.core.impl.MetadataHolderService")
            A: ${NS}:enabled(0x0101000e)=false
            A: ${NS}:exported(0x01010010)=false
`;

const SERVICE_NAME_LINE = 'name(0x01010003)="androidx.camera.core.impl.MetadataHolderService"';
const APPLICATION_LINE = 'E: application (line=37)';

// Returns the fixture with [line] inserted after the first line containing [anchor], indented
// like that line plus [delta] spaces (negative: shallower).
function insertAfter(text, anchor, line, delta = 0) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.includes(anchor));
  assert.ok(i >= 0, `anchor not found: ${anchor}`);
  const indent = ' '.repeat(/^\s*/.exec(lines[i])[0].length + delta);
  lines.splice(i + 1, 0, indent + line);
  return lines.join('\n');
}

function replaceLine(text, from, to) {
  assert.ok(text.includes(from), `not found: ${from}`);
  return text.replace(from, to);
}

function check(text, pkg = PKG) {
  errors.length = 0;
  const log = console.log;
  console.log = () => {};
  try {
    checkManifest(parseXmlTree(text), pkg);
  } finally {
    console.log = log;
  }
  return [...errors];
}

function expectFailure(text, re) {
  const errs = check(text);
  assert.ok(errs.some((e) => re.test(e)), `expected a failure matching ${re}, got:\n${errs.join('\n')}`);
}

test('the release manifest fixture passes', () => {
  assert.deepEqual(check(FIXTURE), []);
});

test('the launcher must turn Flutter deep links off', () => {
  const without = FIXTURE.split('\n').filter((l) => !l.includes('flutter_deeplinking_enabled')).join('\n')
    .replace(`                A: ${NS}:value(0x01010024)=false\n`, '');
  expectFailure(without, /flutter_deeplinking_enabled.*found none/);
  const enabled = replaceLine(FIXTURE, `${NS}:value(0x01010024)=false`, `${NS}:value(0x01010024)=true`);
  expectFailure(enabled, /flutter_deeplinking_enabled.*found true/);
  const asString = replaceLine(FIXTURE, `${NS}:value(0x01010024)=false`, `${NS}:value(0x01010024)="no" (Raw: "no")`);
  expectFailure(asString, /flutter_deeplinking_enabled.*found no/);
});

test('a resource reference for exported, debuggable or testOnly fails', () => {
  const exportedRef = replaceLine(FIXTURE,
    `            A: ${NS}:exported(0x01010010)=false\n            A: ${NS}:authorities`,
    `            A: ${NS}:exported(0x01010010)=@0x7f050001\n            A: ${NS}:authorities`);
  expectFailure(exportedRef, /ImagePickerFileProvider android:exported is not a literal/);
  expectFailure(exportedRef, /ImagePickerFileProvider is exported/);
  const debuggableRef = insertAfter(FIXTURE, 'allowBackup(0x01010280)', `A: ${NS}:debuggable(0x0101000f)=@0x7f050002`);
  expectFailure(debuggableRef, /application android:debuggable is not a literal/);
  const testOnlyRef = insertAfter(FIXTURE, 'allowBackup(0x01010280)', `A: ${NS}:testOnly(0x01010272)=@0x7f050003`);
  expectFailure(testOnlyRef, /application android:testOnly is not a literal/);
  const debuggable = insertAfter(FIXTURE, 'allowBackup(0x01010280)', `A: ${NS}:debuggable(0x0101000f)=true`);
  expectFailure(debuggable, /^application: debuggable$/);
  const notDebuggable = insertAfter(FIXTURE, 'allowBackup(0x01010280)', `A: ${NS}:debuggable(0x0101000f)=false`);
  assert.deepEqual(check(notDebuggable), []);
});

test('a separate process fails, on a component or on <application>', () => {
  const remote = insertAfter(FIXTURE, SERVICE_NAME_LINE, `A: ${NS}:process(0x01010011)=":remote" (Raw: ":remote")`);
  expectFailure(remote, /MetadataHolderService runs in a separate process \(:remote\)/);
  const app = insertAfter(FIXTURE, APPLICATION_LINE, `A: ${NS}:process(0x01010011)=":ui" (Raw: ":ui")`, 2);
  expectFailure(app, /application: android:process is set/);
});

test('a VPN service fails, even when it is not exported', () => {
  const perm = insertAfter(FIXTURE, SERVICE_NAME_LINE,
    `A: ${NS}:permission(0x01010006)="android.permission.BIND_VPN_SERVICE" (Raw: "android.permission.BIND_VPN_SERVICE")`);
  expectFailure(perm, /MetadataHolderService is a VPN service/);
  let action = insertAfter(FIXTURE, `            A: ${NS}:enabled(0x0101000e)=false`, 'E: intent-filter (line=200)', 2);
  action = insertAfter(action, 'E: intent-filter (line=200)', 'E: action (line=201)', 4);
  action = insertAfter(action, 'E: action (line=201)',
    `A: ${NS}:name(0x01010003)="android.net.VpnService" (Raw: "android.net.VpnService")`, 2);
  expectFailure(action, /MetadataHolderService is a VPN service/);
});

test('existing rules still hold: exported components and VIEW filters', () => {
  const exported = replaceLine(FIXTURE,
    `            A: ${NS}:enabled(0x0101000e)=false\n            A: ${NS}:exported(0x01010010)=false`,
    `            A: ${NS}:enabled(0x0101000e)=false\n            A: ${NS}:exported(0x01010010)=true`);
  expectFailure(exported, /service androidx.camera.core.impl.MetadataHolderService is exported/);
  let view = insertAfter(FIXTURE, '"android.intent.action.MAIN" (Raw', 'E: action (line=73)', -2);
  view = insertAfter(view, 'E: action (line=73)',
    `A: ${NS}:name(0x01010003)="android.intent.action.VIEW" (Raw: "android.intent.action.VIEW")`, 2);
  expectFailure(view, /VIEW intent filter on activity/);
  expectFailure(view, /launcher .* has extra actions/);
  assert.ok(check(FIXTURE, `${PKG}.dev`).some((e) => /package is/.test(e)));
});

test('the dex scan finds android.net.VpnService type descriptors', () => {
  const clean = Buffer.concat([Buffer.from('dex\n039\0'), Buffer.from('Landroid/net/ConnectivityManager;\0')]);
  assert.equal(dexMentionsVpnService(clean), false);
  assert.equal(dexMentionsVpnService(Buffer.concat([clean, Buffer.from('Landroid/net/VpnService;\0')])), true);
  assert.equal(dexMentionsVpnService(Buffer.concat([clean, Buffer.from('Landroid/net/VpnService$Builder;\0')])), true);
  // The dotted action string alone (for example in another app's intent) is not a type use.
  assert.equal(dexMentionsVpnService(Buffer.concat([clean, Buffer.from('android.net.VpnService\0')])), false);
});
