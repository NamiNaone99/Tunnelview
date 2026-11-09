'use strict';
/*
 * Main-window + prompt renderer tests (src/renderer/main/*, src/renderer/prompt/identity.js).
 * The views are plain ES modules that build DOM with ui.js h(); a tiny fake DOM below is enough
 * to mount them in Node and check what they render and which preload calls they make.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

/* ------------------------------------------------------------------ fake DOM */

const realSetTimeout = globalThis.setTimeout;
const realSetInterval = globalThis.setInterval;
// UI timers (toasts, tickers) must not keep the test process alive.
globalThis.setTimeout = (...a) => { const t = realSetTimeout(...a); if (t && t.unref) t.unref(); return t; };
globalThis.setInterval = (...a) => { const t = realSetInterval(...a); if (t && t.unref) t.unref(); return t; };
const sleep = (ms = 0) => new Promise((r) => realSetTimeout(r, ms));

class FakeNode {
  constructor() { this.parentNode = null; this.childNodes = []; }
  get isConnected() {
    let n = this;
    while (n.parentNode) n = n.parentNode;
    return n === globalThis.document;
  }
  remove() {
    if (!this.parentNode) return;
    const sib = this.parentNode.childNodes;
    sib.splice(sib.indexOf(this), 1);
    this.parentNode = null;
  }
}
globalThis.Node = FakeNode;

class FakeText extends FakeNode {
  constructor(text) { super(); this.nodeType = 3; this.data = String(text); }
  get textContent() { return this.data; }
}

const kebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attrs = new Map();
    this.listeners = new Map();
    this.style = { setProperty() {} };
    this.checked = false;
    this.inert = false;
    this.offsetTop = 0; this.scrollTop = 0; this.clientHeight = 0; this.scrollHeight = 0;
    const el = this;
    this.dataset = new Proxy({}, {
      get: (_t, k) => (typeof k === 'string' ? el.getAttribute(`data-${kebab(k)}`) ?? undefined : undefined),
      set: (_t, k, v) => { el.setAttribute(`data-${kebab(String(k))}`, String(v)); return true; },
    });
    const cls = () => (this.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    this.classList = {
      contains: (c) => cls().includes(c),
      add: (...cs) => { this.className = [...new Set([...cls(), ...cs])].join(' '); },
      remove: (...cs) => { this.className = cls().filter((c) => !cs.includes(c)).join(' '); },
      toggle: (c, force) => {
        const on = force === undefined ? !cls().includes(c) : !!force;
        if (on) this.classList.add(c); else this.classList.remove(c);
        return on;
      },
    };
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get title() { return this.getAttribute('title') || ''; }
  set title(v) { this.setAttribute('title', v); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(v) { if (v) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get value() { return this._value !== undefined ? this._value : this.getAttribute('value') || ''; }
  set value(v) { this._value = String(v); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.replaceChildren(String(v)); }
  appendChild(n) {
    if (n.parentNode) n.remove();
    n.parentNode = this;
    this.childNodes.push(n);
    return n;
  }
  replaceChildren(...nodes) {
    for (const c of [...this.childNodes]) c.remove();
    for (const n of nodes) this.appendChild(n instanceof FakeNode ? n : new FakeText(n));
  }
  contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; }
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(fn); }
  removeEventListener(type, fn) { const l = this.listeners.get(type); if (l && l.includes(fn)) l.splice(l.indexOf(fn), 1); }
  dispatch(type, extra = {}) {
    const ev = { type, target: this, currentTarget: this, isTrusted: true, detail: 1, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...extra };
    for (const fn of [...(this.listeners.get(type) || [])]) fn(ev);
    return ev;
  }
  click() { if (!this.disabled) this.dispatch('click'); } // browsers never fire click on a disabled control
  focus() { globalThis.document.activeElement = this; }
  blur() { if (globalThis.document.activeElement === this) globalThis.document.activeElement = null; }
  scrollTo() {}
  closest(sel) { for (let n = this; n && n.nodeType === 1; n = n.parentNode) if (matches(n, sel)) return n; return null; }
  querySelectorAll(sel) {
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (matches(c, sel)) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}

/** Compound selectors only (tag, #id, .class, [attr], [attr="v"]), comma lists allowed. */
function matches(el, selector) {
  return selector.split(',').some((part) => {
    const s = part.trim();
    const re = /^[a-zA-Z][\w-]*|#[\w-]+|\.[\w-]+|\[([\w-]+)(?:="([^"]*)")?\]/g;
    let m; let pos = 0;
    while ((m = re.exec(s)) && m.index === pos) {
      pos = re.lastIndex;
      const t = m[0];
      if (t[0] === '#') { if (el.id !== t.slice(1)) return false; }
      else if (t[0] === '.') { if (!el.classList.contains(t.slice(1))) return false; }
      else if (t[0] === '[') {
        if (!el.hasAttribute(m[1])) return false;
        if (m[2] !== undefined && el.getAttribute(m[1]) !== m[2]) return false;
      } else if (el.tagName !== t.toUpperCase()) return false;
    }
    if (pos !== s.length) throw new Error(`fake DOM: unsupported selector ${s}`);
    return true;
  });
}

const doc = new FakeElement('#document');
Object.assign(doc, {
  nodeType: 9,
  activeElement: null,
  visibilityState: 'visible',
  createElement: (tag) => new FakeElement(tag),
  createElementNS: (_ns, tag) => new FakeElement(tag),
  createTextNode: (t) => new FakeText(t),
  hasFocus: () => true,
});
doc.documentElement = doc.appendChild(new FakeElement('html'));
doc.body = doc.documentElement.appendChild(new FakeElement('body'));
globalThis.document = doc;
globalThis.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') };
globalThis.requestAnimationFrame = (fn) => { queueMicrotask(() => fn(0)); return 1; };

/* ------------------------------------------------------------------ fake preload */

const calls = [];
const api = {
  getState: async () => { calls.push(['getState']); return api._state; },
  getSettings: async () => api._settings,
  listPeers: async (opts) => { calls.push(['listPeers', opts]); return api._peers(opts); },
  updateSettings: async (p) => ({ ...api._settings, ...p }),
  connect: async (opts) => { calls.push(['connect', opts]); return api._connect; },
  openTailscaleAdmin: async () => { calls.push(['openTailscaleAdmin']); },
};
globalThis.window = { tunnelview: api, TunnelviewProtocol: require('../src/shared/protocol') };

const load = (p) => import(`../src/renderer/${p}`);

/* ------------------------------------------------------------------ helpers */

const MAC_STATE = {
  version: '0.1.0', platform: 'macos',
  tailscale: { state: 'running', message: '', self: { hostname: 'mac', shortName: 'mac', os: 'macos', ips: ['100.64.0.2'], user: { login: 'me@x', displayName: 'Me' } }, magicDnsSuffix: 'tail.ts.net' },
  host: { enabled: true, listening: true, addresses: ['100.64.0.2'], port: 47800, error: null, session: null, pending: false },
  viewers: [],
  permissions: { screen: 'denied', accessibility: 'denied' },
  input: { available: true, reason: null },
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const SESSION = { id: 's1', peer: { ip: '100.64.0.9', hostname: 'pc', os: 'windows', user: { login: 'bob@x', displayName: 'Bob' } }, startedAt: Date.now(), via: 'prompt' };

function mount() {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}
const buttons = (root) => root.querySelectorAll('button');
const byText = (root, text) => buttons(root).find((b) => b.textContent.trim() === text) || null;
const toasts = () => {
  const host = document.body.querySelector('.toast-host');
  return host ? host.children.map((t) => t.textContent) : [];
};

/* ------------------------------------------------------------------ store */

test('store.normState keeps host.warning as bounded safe text or null', async () => {
  const { normState } = await load('main/store.js');
  const st = (warning) => normState({ ...clone(MAC_STATE), host: { ...MAC_STATE.host, warning } }).host.warning;
  assert.equal(st('Windows Firewall blocks Tunnelview'), 'Windows Firewall blocks Tunnelview');
  assert.equal(st('a\u202Eb\u0000c'), 'abc'); // bidi override + control chars stripped
  assert.ok(st('x'.repeat(1000)).length <= 300);
  assert.equal(st(''), null);
  assert.equal(st('   '), null);
  assert.equal(st(42), null);
  assert.equal(st(undefined), null);
  assert.equal(normState(null).host.warning, null);
});

test('store.normPeer keeps probe (enum) and tunnelview.port', async () => {
  const { normPeer } = await load('main/store.js');
  const base = { stableId: 'n1', hostname: 'pc', ips: ['100.64.0.5'], online: true };
  for (const probe of ['ok', 'not-allowed', 'refused', 'timeout', 'incompatible', 'error']) assert.equal(normPeer({ ...base, probe }).probe, probe);
  assert.equal(normPeer({ ...base, probe: 'bogus' }).probe, null);
  assert.equal(normPeer(base).probe, null);
  assert.equal(normPeer({ ...base, tunnelview: { version: '1', port: 47811 } }).tunnelview.port, 47811);
  assert.equal(normPeer({ ...base, tunnelview: { version: '1', port: 70000 } }).tunnelview.port, null);
  assert.equal(normPeer({ ...base, tunnelview: { version: '1', port: '47800' } }).tunnelview.port, null);
  // COMPAT-2 / DOCS-6: "busy because it installs an update" only with busy, only for a strict true.
  assert.equal(normPeer({ ...base, tunnelview: { version: '1', busy: true, updating: true } }).tunnelview.updating, true);
  assert.equal(normPeer({ ...base, tunnelview: { version: '1', busy: true, updating: 'yes' } }).tunnelview.updating, false);
  assert.equal(normPeer({ ...base, tunnelview: { version: '1', busy: false, updating: true } }).tunnelview.updating, false);
  assert.equal(normPeer({ ...base, tunnelview: { version: '1', busy: true } }).tunnelview.updating, false);
});

test('store.errMsg strips Electron\'s invoke wrapper so main\'s message reads cleanly', async () => {
  const { errMsg } = await load('main/store.js');
  const text = 'Disconnect the remote session to change security settings.';
  assert.equal(errMsg(new Error(`Error invoking remote method 'settings:update': Error: ${text}`)), text);
  assert.equal(errMsg(new Error(`Error invoking remote method 'x': TypeError: bad`)), 'bad');
  assert.equal(errMsg(text), text);
});

test('store.securityLocked follows AppState.host.session', async () => {
  const { securityLocked, normState } = await load('main/store.js');
  assert.equal(securityLocked(normState(clone(MAC_STATE))), false);
  assert.equal(securityLocked(normState({ ...clone(MAC_STATE), host: { ...MAC_STATE.host, session: SESSION } })), true);
});

test('store.refreshTailscale re-runs status in main, falls back to the cached state', async () => {
  const { refreshTailscale, setState, store } = await load('main/store.js');
  setState(clone(MAC_STATE));
  api._state = { ...clone(MAC_STATE), tailscale: { ...MAC_STATE.tailscale, state: 'needs-login', message: 'cached' } };

  api.refreshTailscale = async () => { calls.push(['refreshTailscale']); return { ...clone(MAC_STATE), tailscale: { ...MAC_STATE.tailscale, state: 'not-installed' } }; };
  calls.length = 0;
  await refreshTailscale();
  assert.deepEqual(calls.map((c) => c[0]), ['refreshTailscale']);
  assert.equal(store.state.tailscale.state, 'not-installed');

  api.refreshTailscale = async () => { throw new Error('boom'); };
  calls.length = 0;
  await refreshTailscale();
  assert.deepEqual(calls.map((c) => c[0]), ['getState']);
  assert.equal(store.state.tailscale.message, 'cached');

  delete api.refreshTailscale;
  calls.length = 0;
  await refreshTailscale();
  assert.deepEqual(calls.map((c) => c[0]), ['getState']);
});

test('store.connectTo says "Switched to…" when main focused an existing viewer', async () => {
  const { connectTo } = await load('main/store.js');
  api._connect = { ok: true, existing: true };
  await connectTo({ target: '100.64.0.5', label: 'office-pc' });
  assert.ok(toasts().includes('Switched to your open session with office-pc'), toasts().join(' | '));
  api._connect = { ok: true };
  await connectTo({ target: '100.64.0.5', label: 'office-pc' });
  assert.ok(toasts().includes('Opening a session with office-pc…'));
});

test('store.focusViewer calls the preload when available', async () => {
  const { focusViewer, canFocusViewer } = await load('main/store.js');
  delete api.focusViewer;
  assert.equal(canFocusViewer(), false);
  assert.equal(await focusViewer(3), false);
  api.focusViewer = async (id) => { calls.push(['focusViewer', id]); return { ok: true }; };
  calls.length = 0;
  assert.equal(await focusViewer(3), true);
  assert.equal(await focusViewer(0), false);
  assert.equal(await focusViewer('3'), false);
  assert.deepEqual(calls, [['focusViewer', 3]]);
  api.focusViewer = async () => ({ ok: false });
  assert.equal(await focusViewer(4), false);
  assert.ok(toasts().includes('That session window is no longer open.'));
});

test('store.loadPeers: a plain refresh keeps the last probe result', async () => {
  const { loadPeers, store } = await load('main/store.js');
  const peer = { stableId: 'n1', hostname: 'pc', ips: ['100.64.0.5'], online: true, os: 'windows' };
  api._peers = (opts) => [opts && opts.probe ? { ...peer, tunnelview: null, probe: 'timeout' } : { ...peer, tunnelview: null, probe: null }];
  await loadPeers({ probe: true });
  assert.equal(store.peers.list[0].probe, 'timeout');
  await loadPeers();
  assert.equal(store.peers.list[0].probe, 'timeout');
  api._peers = () => [{ ...peer, online: false, tunnelview: null, probe: null }];
  await loadPeers();
  assert.equal(store.peers.list[0].probe, null); // offline → stale probe info dropped
});

/* ------------------------------------------------------------------ devices */

test('devices: probe outcome picks the badge when Tunnelview did not answer', async () => {
  const { probeBadgeInfo } = await load('main/devices.js');
  assert.equal(probeBadgeInfo('timeout').text, 'No answer');
  assert.match(probeBadgeInfo('timeout').title, /ACL or firewall/);
  assert.equal(probeBadgeInfo('not-allowed').text, 'Not allowed');
  assert.match(probeBadgeInfo('not-allowed').title, /Who can connect/);
  assert.equal(probeBadgeInfo('incompatible').text, 'Update needed');
  assert.match(probeBadgeInfo('incompatible').title, /different version/);
  for (const p of ['refused', 'error', null, undefined]) assert.equal(probeBadgeInfo(p).text, 'Not running');
});

/* ------------------------------------------------------------------ desk */

test('desk: macOS Screen Recording offers Grant + Open Settings + Quit & Reopen whenever not granted', async () => {
  const { setState } = await load('main/store.js');
  const { mountDesk } = await load('main/desk.js');
  api.requestPermission = async (kind) => { calls.push(['requestPermission', kind]); return 'denied'; };
  api.openPermissionSettings = async () => ({ ok: true });
  api.relaunchApp = async () => { calls.push(['relaunchApp']); return { ok: true }; };
  setState(clone(MAC_STATE));
  const root = mount();
  mountDesk(root, { openSettings() {} });

  const grantScreen = root.querySelector('[data-fid="grant-screen"]');
  assert.ok(grantScreen, 'Grant for Screen Recording while "denied"');
  assert.ok(root.querySelector('[data-fid="grant-accessibility"]'));
  assert.ok(root.querySelector('[data-fid="open-screen"]'));
  const relaunch = root.querySelector('[data-fid="relaunch"]');
  assert.ok(relaunch);
  assert.match(root.textContent, /macOS applies Screen Recording only after Tunnelview is reopened — click Quit & Reopen after allowing it\./);

  calls.length = 0;
  grantScreen.click();
  await sleep(5);
  assert.deepEqual(calls[0], ['requestPermission', 'screen']);

  calls.length = 0;
  relaunch.click(); // no open sessions → no confirmation
  await sleep(5);
  assert.deepEqual(calls, [['relaunchApp']]);

  // Granted → no actions, no hint.
  setState({ ...clone(MAC_STATE), permissions: { screen: 'granted', accessibility: 'granted' } });
  assert.equal(root.querySelector('[data-fid="grant-screen"]'), null);
  assert.equal(root.querySelector('[data-fid="relaunch"]'), null);
  assert.doesNotMatch(root.textContent, /only after Tunnelview is reopened/);

  // Older main without relaunchApp → no button, wording doesn't point at it.
  delete api.relaunchApp;
  setState({ ...clone(MAC_STATE), permissions: { screen: 'denied', accessibility: 'granted' } });
  assert.equal(root.querySelector('[data-fid="relaunch"]'), null);
  assert.ok(root.querySelector('[data-fid="grant-screen"]'));
  assert.equal(root.querySelector('[data-fid="grant-accessibility"]'), null);
  assert.match(root.textContent, /quit and reopen Tunnelview after allowing it/);
  root.remove();
});

test('desk: host warning shows under the listening status', async () => {
  const { setState } = await load('main/store.js');
  const { mountDesk } = await load('main/desk.js');
  const root = mount();
  const msg = 'Windows Firewall has a rule that blocks Tunnelview — incoming connections will fail.';
  setState({ ...clone(MAC_STATE), host: { ...MAC_STATE.host, warning: msg } });
  mountDesk(root, { openSettings() {} });
  assert.match(root.textContent, /Listening on 100\.64\.0\.2:47800/);
  const warn = root.querySelector('.status-warn');
  assert.ok(warn);
  assert.ok(warn.querySelector('.dot-warn'));
  assert.equal(warn.textContent, msg);
  setState(clone(MAC_STATE));
  assert.equal(root.querySelector('.status-warn'), null);
  root.remove();
});

test('desk: outgoing sessions are buttons that bring the viewer window forward', async () => {
  const { setState } = await load('main/store.js');
  const { mountDesk } = await load('main/desk.js');
  const root = mount();
  delete api.focusViewer;
  setState({ ...clone(MAC_STATE), viewers: [{ id: 7, hostname: 'office-pc', phase: 'accepted' }, { id: 8, hostname: 'gone', phase: 'closed' }] });
  mountDesk(root, { openSettings() {} });
  assert.ok(root.querySelector('div.viewer-row'), 'plain row without focusViewer');
  assert.equal(root.querySelector('button.viewer-row'), null);

  api.focusViewer = async (id) => { calls.push(['focusViewer', id]); return { ok: true }; };
  setState({ ...clone(MAC_STATE), viewers: [{ id: 7, hostname: 'office-pc', phase: 'accepted' }, { id: 9, hostname: 'lab', phase: 'waiting' }] });
  const rows = root.querySelectorAll('button.viewer-row');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].getAttribute('type'), 'button');
  calls.length = 0;
  rows[0].click();
  await sleep(5);
  assert.deepEqual(calls, [['focusViewer', 7]]);
  setState(clone(MAC_STATE));
  root.remove();
});

test('desk: password button is disabled during an incoming session', async () => {
  const { setState } = await load('main/store.js');
  const { mountDesk } = await load('main/desk.js');
  const root = mount();
  setState({ ...clone(MAC_STATE), host: { ...MAC_STATE.host, session: SESSION } });
  mountDesk(root, { openSettings() {} });
  assert.equal(root.querySelector('[data-fid="pw-btn"]').disabled, true);
  setState(clone(MAC_STATE)); // also stops the session ticker
  assert.equal(root.querySelector('[data-fid="pw-btn"]').disabled, false);
  root.remove();
});

/* ------------------------------------------------------------------ Tailscale banner */

test('remote: Tailscale banner offers the right action per state and re-checks for real', async () => {
  const { setState } = await load('main/store.js');
  const { mountTsBanner } = await load('main/remote.js');
  api.openTailscaleDownload = async () => { calls.push(['openTailscaleDownload']); return { ok: true }; };
  api.openTailscale = async () => { calls.push(['openTailscale']); return { ok: true }; };
  api.refreshTailscale = async () => { calls.push(['refreshTailscale']); return clone(MAC_STATE); };
  const root = mount();
  const ts = (state, message = '') => setState({ ...clone(MAC_STATE), tailscale: { state, message, self: null } });

  ts('not-installed');
  mountTsBanner(root);
  assert.equal(root.hidden, false);
  const dl = byText(root, 'Download Tailscale');
  assert.ok(dl);
  assert.ok(dl.classList.contains('btn-primary'));
  const link = byText(root, 'tailscale.com/download');
  assert.ok(link && link.classList.contains('link-btn'), 'download URL is a real button');
  const admin = byText(root, 'Tailscale admin console');
  assert.ok(admin && !admin.classList.contains('btn-primary'), 'admin console is secondary');
  calls.length = 0;
  dl.click(); link.click(); admin.click();
  await sleep(5);
  assert.deepEqual(calls.map((c) => c[0]), ['openTailscaleDownload', 'openTailscaleDownload', 'openTailscaleAdmin']);

  ts('needs-login', 'This device is waiting for approval by a tailnet admin.');
  assert.ok(byText(root, 'Open Tailscale'));
  assert.equal(byText(root, 'Download Tailscale'), null);
  const h2 = root.querySelector('h2');
  const sub = root.querySelector('.ts-banner-sub');
  assert.ok(sub, 'message rendered for needs-login');
  assert.equal(sub.textContent, 'This device is waiting for approval by a tailnet admin.');
  assert.equal(h2.parentNode.childNodes.indexOf(sub), h2.parentNode.childNodes.indexOf(h2) + 1, 'directly under the title');

  ts('error', 'tailscale: failed to connect to local tailscaled');
  assert.ok(byText(root, 'Open Tailscale'));
  assert.ok(root.querySelector('.ts-banner-msg'));
  calls.length = 0;
  byText(root, 'Open Tailscale').click();
  await sleep(5);
  assert.deepEqual(calls.map((c) => c[0]), ['openTailscale']);

  calls.length = 0;
  byText(root, 'Check again').click();
  await sleep(5);
  assert.deepEqual(calls.map((c) => c[0]), ['refreshTailscale']);
  assert.equal(root.hidden, true, 'fresh state (running) hides the banner');

  // Older preload: admin console stays the primary action; Check again falls back to getState.
  delete api.openTailscale; delete api.openTailscaleDownload; delete api.refreshTailscale;
  api._state = clone(MAC_STATE);
  ts('not-installed');
  assert.equal(byText(root, 'Download Tailscale'), null);
  assert.ok(byText(root, 'Tailscale admin console').classList.contains('btn-primary'));
  assert.match(root.textContent, /tailscale\.com\/download/);
  calls.length = 0;
  byText(root, 'Check again').click();
  await sleep(5);
  assert.deepEqual(calls.map((c) => c[0]), ['getState']);
  root.remove();
});

/* ------------------------------------------------------------------ settings */

test('settings: security controls are locked while someone is connected', async () => {
  const { setState, setSettings } = await load('main/store.js');
  const { createSettingsView } = await load('main/settings-view.js');
  setSettings({ allowFrom: 'list', allowList: ['alice@example.com'], passwordSet: true, acceptMode: 'password-only', downloadDir: '/tmp/x' });
  setState({ ...clone(MAC_STATE), host: { ...MAC_STATE.host, session: SESSION } });
  const view = createSettingsView();
  view.open('security');
  const sheet = document.body.querySelector('.sheet-layer');
  assert.ok(sheet);
  const q = (sel) => sheet.querySelector(sel);
  const locked = sheet.querySelectorAll('[data-lock]');
  assert.ok(locked.length >= 15, `lockable controls: ${locked.length}`);

  const banners = sheet.querySelectorAll('.set-lock');
  assert.equal(banners.length, 2, 'security + files');
  assert.equal(q('#set-security').querySelector('.set-lock').hidden, false);
  assert.equal(q('#set-files').querySelector('.set-lock').hidden, false);
  assert.match(banners[0].textContent, /Security settings are locked while someone is connected to this computer\. End the session to change them\./);

  const lockedNow = () => ({
    acceptMode: q('[aria-label="Accept mode"]').querySelectorAll('button').every((b) => b.disabled),
    allowFrom: sheet.querySelectorAll('[name="allow-from"]').every((i) => i.disabled),
    allowInput: q('[aria-label="User or device to allow"]').disabled,
    allowRemove: q('.tag-x').disabled,
    autoAccept: q('[aria-label="Auto-accept my own devices"]').disabled,
    defaultPerms: q('.perm-grid').querySelectorAll('input').every((i) => i.disabled),
    password: ['Change…', 'Remove'].every((t) => byText(sheet, t).disabled),
    downloads: ['Change…', 'Use default'].every((t) => byText(q('#set-files'), t).disabled),
  });
  for (const [k, v] of Object.entries(lockedNow())) assert.equal(v, true, `${k} locked`);
  // Not security settings — stay usable.
  assert.equal(q('[aria-label="Accept incoming connections"]').disabled, false);
  assert.equal(q('[aria-label="Approval timeout"]').disabled, false);
  assert.equal(q('[aria-label="Video codec"]').disabled, false);
  assert.equal(byText(q('#set-files'), 'Open').disabled, false);

  // Session ends → everything unlocks (state push re-syncs the open sheet).
  setState(clone(MAC_STATE));
  for (const [k, v] of Object.entries(lockedNow())) assert.equal(v, false, `${k} unlocked`);
  assert.ok(banners.every((b) => b.hidden));

  // A chip added while locked is created disabled too.
  setState({ ...clone(MAC_STATE), host: { ...MAC_STATE.host, session: SESSION } });
  setSettings({ allowFrom: 'list', allowList: ['alice@example.com', 'bob@example.com'], passwordSet: true });
  assert.ok(sheet.querySelectorAll('.tag-x').every((b) => b.disabled));
  setState(clone(MAC_STATE));
  view.close();
});

test('settings: port and relay wording match how Tunnelview really behaves', async () => {
  const { createSettingsView } = await load('main/settings-view.js');
  const view = createSettingsView();
  view.open('network');
  const sheet = document.body.querySelectorAll('.sheet-layer').pop();
  const text = sheet.textContent;
  assert.doesNotMatch(text, /must be the same on both computers/);
  assert.match(text, /Signaling port \(TCP\) this computer listens on\. When you connect without typing a port, Tunnelview uses the port the other device answers on \(or this one\)\./);
  assert.match(text, /firewall rule allows Tunnelview on any port, from Tailscale addresses only/);
  assert.doesNotMatch(text, /no relays/);
  assert.doesNotMatch(text, /no STUN\/TURN relays/);
  assert.match(text, /Tailscale relays the \(still end-to-end encrypted\) traffic through its DERP servers/);
  assert.match(text, /with no STUN\/TURN servers; Tailscale may relay through DERP when no direct path exists/);
  view.close();
});

/* ------------------------------------------------------------------ WebRTC warm-up */

test('rtc-warmup: warms once, only while the window is hidden, without ICE', async () => {
  const { warmRtcWhileHidden } = await load('main/rtc-warmup.js');
  const mk = (visibilityState) => {
    const log = [];
    const idle = [];
    const d = new FakeElement('#doc');
    d.visibilityState = visibilityState;
    class PC {
      constructor(cfg) { log.push(['pc', cfg]); }
      close() { log.push(['close']); }
      createOffer() { log.push(['createOffer']); }
      createDataChannel() { log.push(['createDataChannel']); }
    }
    const g = {
      RTCPeerConnection: PC,
      RTCRtpSender: { getCapabilities: (k) => { log.push(['caps', k]); return { codecs: [] }; } },
      requestIdleCallback: (fn, opts) => { idle.push([fn, opts]); return idle.length; },
    };
    return { d, g, log, idle, runIdle: () => { while (idle.length) idle.shift()[0](); } };
  };

  // Visible window: nothing is even scheduled; hiding it later warms exactly once.
  const v = mk('visible');
  const w = warmRtcWhileHidden({ document: v.d, global: v.g });
  assert.equal(v.idle.length, 0);
  v.d.visibilityState = 'hidden';
  v.d.dispatch('visibilitychange');
  assert.equal(v.idle.length, 1);
  assert.ok(v.idle[0][1] && v.idle[0][1].timeout > 0, 'idle callback has a timeout fallback');
  v.runIdle();
  assert.equal(w.warmed, true);
  assert.deepEqual(v.log, [['caps', 'video'], ['pc', { iceServers: [] }], ['close']]);
  v.d.visibilityState = 'visible'; v.d.dispatch('visibilitychange');
  v.d.visibilityState = 'hidden'; v.d.dispatch('visibilitychange');
  v.runIdle();
  assert.equal(v.log.length, 3, 'only once per window');

  // Hidden at start, but shown before the idle callback ran → skipped until the next hide.
  const h2 = mk('hidden');
  const w2 = warmRtcWhileHidden({ document: h2.d, global: h2.g });
  assert.equal(h2.idle.length, 1);
  h2.d.visibilityState = 'visible';
  h2.runIdle();
  assert.equal(w2.warmed, false);
  assert.deepEqual(h2.log, []);
  h2.d.visibilityState = 'hidden'; h2.d.dispatch('visibilitychange');
  h2.runIdle();
  assert.equal(w2.warmed, true);

  // No requestIdleCallback → setTimeout fallback; WebRTC missing → swallowed.
  const n = mk('hidden');
  delete n.g.requestIdleCallback;
  n.g.RTCRtpSender = undefined;
  let timed = null;
  n.g.setTimeout = (fn, ms) => { timed = [fn, ms]; return 1; };
  const w3 = warmRtcWhileHidden({ document: n.d, global: n.g });
  assert.ok(timed);
  assert.doesNotThrow(() => timed[0]());
  assert.equal(w3.warmed, true);
});

/* ------------------------------------------------------------------ prompt */

test('prompt: a self-connection is never presented as a verified "you"', async () => {
  const { describeRequester } = await load('prompt/identity.js');
  const self = describeRequester({ user: { login: 'me@x', displayName: 'Me' }, isSelf: true, sameUser: true });
  assert.equal(self.name, 'A program on this computer');
  assert.equal(self.login, '');
  assert.equal(self.note, 'Any app or user on this computer can make this request — accept only if you started it.');
  assert.deepEqual(self.badges.map((b) => [b.tone, b.text]), [['warn', 'This computer (unverified user)']]);
  assert.ok(!self.badges.some((b) => /Verified/.test(b.text)));

  const peer = describeRequester({ user: { login: 'bob@x', displayName: 'Bob' }, isSelf: false, sameUser: true });
  assert.equal(peer.name, 'Bob');
  assert.equal(peer.login, 'bob@x');
  assert.equal(peer.note, '');
  assert.deepEqual(peer.badges.map((b) => [b.tone, b.text]), [['ok', 'Device verified by Tailscale'], ['accent', 'Your device']]);

  const anon = describeRequester({ user: {}, isSelf: false, sameUser: false });
  assert.equal(anon.name, 'Unknown Tailscale user');
  assert.deepEqual(anon.badges.map((b) => b.text), ['Device verified by Tailscale']);
  assert.equal(describeRequester(null).name, 'Unknown Tailscale user');
});

const TAGGED_USER = { login: 'tagged-devices', displayName: 'Tagged Devices' };

test('prompt: a tagged peer shows its tags and a "Tagged device" badge, not the pseudo-user', async () => {
  const { describeRequester, isTaggedPeer, canAlwaysAllow } = await load('prompt/identity.js');
  const tagged = describeRequester({ user: TAGGED_USER, stableId: 'nT', tags: ['tag:server', 'tag:ci'], isSelf: false, sameUser: false });
  assert.equal(tagged.name, 'tag:server, tag:ci');
  assert.equal(tagged.login, '');
  assert.equal(tagged.note, '');
  assert.deepEqual(tagged.badges.map((b) => [b.tone, b.text]), [['ok', 'Device verified by Tailscale'], ['neutral', 'Tagged device']]);
  assert.match(tagged.badges[1].title, /never accepted automatically/);
  assert.ok(!JSON.stringify(tagged).includes('Tagged Devices'), 'pseudo-user name is not shown');

  // Older main without PromptInit.peer.tags: the pseudo-user login is enough.
  const legacy = describeRequester({ user: TAGGED_USER, stableId: 'nT', isSelf: false });
  assert.equal(legacy.name, 'Tagged device');
  assert.deepEqual(legacy.badges.map((b) => b.text), ['Device verified by Tailscale', 'Tagged device']);

  assert.equal(isTaggedPeer({ user: { login: 'bob@x' }, tags: ['tag:x'] }), true);
  assert.equal(isTaggedPeer({ user: TAGGED_USER, tags: [] }), true);
  assert.equal(isTaggedPeer({ user: { login: 'bob@x' }, tags: [], tagged: true }), true);
  assert.equal(isTaggedPeer({ user: { login: 'bob@x' }, tags: [] }), false);
  assert.equal(isTaggedPeer(null), false);

  assert.equal(canAlwaysAllow({ user: { login: 'bob@x' }, stableId: 'nB', tags: [] }), true);
  assert.equal(canAlwaysAllow({ user: { login: 'bob@x' }, stableId: 'nB', tags: ['tag:x'] }), false);
  assert.equal(canAlwaysAllow({ user: TAGGED_USER, stableId: 'nT' }), false);
  assert.equal(canAlwaysAllow({ user: { login: 'me@x' }, stableId: 'nS', isSelf: true }), false);
  assert.equal(canAlwaysAllow({ user: { login: 'bob@x' }, stableId: '' }), false);
});

/**
 * Boot a fresh copy of prompt.js (it renders on import) against the fake DOM, with a fake
 * window.tunnelviewPrompt whose ready() resolves `init`, and a controllable performance.now().
 */
let promptRun = 0;
async function bootPrompt(init) {
  for (const old of document.body.querySelectorAll('#app')) old.remove();
  const app = h0('div', { id: 'app' },
    h0('span', { id: 'pt-mark' }), h0('div', { id: 'pt-ring' }), h0('main', { id: 'pt-main' }));
  document.body.appendChild(app);
  document.getElementById = (id) => document.querySelector(`#${id}`);
  const winListeners = [];
  window.addEventListener = (type, fn) => winListeners.push([type, fn]);
  const answers = [];
  window.tunnelviewPrompt = {
    onCancelled() {},
    ready: async () => init,
    respond: async (a) => { answers.push(a); return { ok: true }; },
  };
  const clock = { now: 1000 };
  const realPerf = globalThis.performance;
  globalThis.performance = { now: () => clock.now };
  try {
    await import(`../src/renderer/prompt/prompt.js?run=${++promptRun}`);
    await sleep(5);
  } catch (err) {
    globalThis.performance = realPerf;
    throw err;
  }
  const keydown = (e) => {
    const ev = { key: '', code: '', altKey: false, metaKey: false, shiftKey: false, ctrlKey: false, isTrusted: true, repeat: false, preventDefault() {}, ...e };
    for (const [type, fn] of winListeners) if (type === 'keydown') fn(ev);
  };
  return {
    app, main: app.querySelector('#pt-main'), answers, clock, keydown, winListeners,
    restore: () => { globalThis.performance = realPerf; app.remove(); delete window.tunnelviewPrompt; },
  };
}
function h0(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  for (const k of kids) el.appendChild(k);
  return el;
}
const promptInit = (peer) => ({
  requestId: 'r1', timeoutSec: 30, audioSupported: false, hostOs: 'windows',
  defaults: { control: true, clipboard: true, files: false, audio: false },
  viewer: { hostname: 'whatever', version: '0.2.0' },
  peer: { ip: '100.64.0.9', hostname: 'build-box', os: 'linux', stableId: 'nT', sameUser: false, isSelf: false, ...peer },
});

test('prompt window: "Always allow" is offered for an untagged peer and sent as trust:true', async () => {
  const p = await bootPrompt(promptInit({ user: { login: 'bob@x', displayName: 'Bob' }, stableId: 'nB', tags: [] }));
  try {
    const trust = p.main.querySelector('.pt-trust');
    assert.ok(trust, 'trust checkbox shown');
    assert.equal(p.main.querySelector('.pt-trust-note'), null);
    const box = trust.querySelector('input');
    box.checked = true;
    box.dispatch('change');
    p.clock.now += 2000; // past the arming delay
    p.keydown({ key: 'a', code: 'KeyA', altKey: true });
    await sleep(5);
    assert.equal(p.answers.length, 1);
    assert.equal(p.answers[0].accept, true);
    assert.equal(p.answers[0].trust, true);
  } finally { p.restore(); }
});

test('prompt window: a tagged peer gets a note instead of "Always allow" and never sends trust', async () => {
  for (const peer of [
    { user: TAGGED_USER, tags: ['tag:server', 'tag:ci'] }, // current main (PromptInit.peer.tags)
    { user: TAGGED_USER }, // older main: no tags field
    { user: { login: 'bob@x', displayName: 'Bob' }, tags: ['‮'] }, // tags that clean to nothing still count
  ]) {
    const p = await bootPrompt(promptInit(peer));
    try {
      assert.equal(p.main.querySelector('.pt-trust'), null, 'no trust checkbox');
      assert.equal(p.main.querySelectorAll('input').filter((i) => i.getAttribute('type') === 'checkbox' && !i.getAttribute('aria-label')).length, 0);
      const note = p.main.querySelector('.pt-trust-note');
      assert.ok(note, 'note shown');
      assert.equal(note.textContent, 'Tagged devices can’t be set to always allow.');
      assert.match(p.main.textContent, /Tagged device/);
      assert.doesNotMatch(p.main.textContent, /Tagged Devices/);
      assert.match(p.main.querySelector('.pt-from').textContent, /build-box/, 'verified device name kept');
      p.clock.now += 2000;
      p.keydown({ key: 'a', code: 'KeyA', altKey: true });
      await sleep(5);
      assert.equal(p.answers.length, 1);
      assert.equal(p.answers[0].accept, true);
      assert.equal(p.answers[0].trust, false);
    } finally { p.restore(); }
  }
});

test('prompt window: macOS accepts only ⇧⌘A (not ⌘A Select All, not ⌥A “å”), and not right after taking focus', async () => {
  const p = await bootPrompt({ ...promptInit({ user: { login: 'bob@x', displayName: 'Bob' }, tags: [] }), hostOs: 'macos' });
  try {
    const { isAcceptChord } = await import(`../src/renderer/prompt/prompt.js?run=${promptRun}`);
    assert.equal(isAcceptChord({ code: 'KeyA', metaKey: true, shiftKey: true }, true), true);
    assert.equal(isAcceptChord({ code: 'KeyA', metaKey: true }, true), false, '⌘A');
    assert.equal(isAcceptChord({ code: 'KeyA', altKey: true }, true), false, '⌥A');
    assert.equal(isAcceptChord({ code: 'KeyA', metaKey: true, shiftKey: true, altKey: true }, true), false);
    assert.equal(isAcceptChord({ code: 'KeyA', altKey: true }, false), true, 'Alt+A elsewhere');
    assert.equal(isAcceptChord({ code: 'KeyA', altKey: true, ctrlKey: true }, false), false, 'AltGr+A types a character');
    assert.equal(isAcceptChord({ code: 'KeyA', altKey: true, shiftKey: true }, false), false);
    // the key that types "a" on the user's layout: AZERTY has it at KeyQ, and KeyA types "q" there
    assert.equal(isAcceptChord({ key: 'a', code: 'KeyQ', altKey: true }, false), true, 'AZERTY printed A');
    assert.equal(isAcceptChord({ key: 'q', code: 'KeyA', altKey: true }, false), false, 'AZERTY printed Q');
    assert.equal(isAcceptChord({ key: 'A', code: 'KeyQ', metaKey: true, shiftKey: true }, true), true, 'AZERTY Mac ⇧⌘A');
    assert.equal(isAcceptChord({ key: 'q', code: 'KeyA', metaKey: true, shiftKey: true }, true), false, '⇧⌘Q is Log Out');
    // no Latin letter on that key: the physical KeyA
    for (const key of ['ф', 'ฟ', 'Process', 'Unidentified', undefined]) {
      assert.equal(isAcceptChord({ key, code: 'KeyA', altKey: true }, false), true, String(key));
      assert.equal(isAcceptChord({ key, code: 'KeyS', altKey: true }, false), false, String(key));
    }

    assert.match(p.main.querySelector('.pt-accept').textContent, /⇧⌘A/);
    p.clock.now += 2000; // past the arming delay
    p.keydown({ key: 'a', code: 'KeyA', metaKey: true });
    p.keydown({ key: 'å', code: 'KeyA', altKey: true });
    await sleep(5);
    assert.equal(p.answers.length, 0, '⌘A / ⌥A never accept');

    const fire = (type, ev = {}) => { for (const [t, fn] of p.winListeners) if (t === type) fn({ isTrusted: true, ...ev }); };
    // the window just got the keyboard: the chord is a keystroke meant for something else…
    fire('focus');
    p.clock.now += 100;
    p.keydown({ key: 'a', code: 'KeyA', metaKey: true, shiftKey: true });
    await sleep(5);
    assert.equal(p.answers.length, 0, 'inside the focus guard');
    assert.doesNotMatch(p.main.textContent, /again/, 'never invites the same keystroke again');
    // …and pressing it again later still does nothing: keyboard accept stays off
    p.clock.now += 1000;
    p.keydown({ key: 'a', code: 'KeyA', metaKey: true, shiftKey: true });
    await sleep(5);
    assert.equal(p.answers.length, 0, 'locked until the user re-activates the window');
    // switching away and back re-arms it (after the guard)
    fire('blur');
    fire('focus');
    p.clock.now += 1000;
    p.keydown({ key: 'a', code: 'KeyA', metaKey: true, shiftKey: true, repeat: true });
    p.keydown({ key: 'a', code: 'KeyA', metaKey: true, shiftKey: true, isTrusted: false });
    await sleep(5);
    assert.equal(p.answers.length, 0, 'auto-repeat and synthetic events never accept');
    p.keydown({ key: 'a', code: 'KeyA', metaKey: true, shiftKey: true });
    await sleep(5);
    assert.equal(p.answers.length, 1);
    assert.equal(p.answers[0].accept, true);
  } finally { p.restore(); }
});

/* ------------------------------------------------------------------ trusted devices (tagged) */

const TRUSTED = [
  { stableId: 'nB', name: 'office-pc', login: 'bob@x', addedAt: Date.now() - 60000 },
  { stableId: 'nT', name: 'build-box', login: 'tagged-devices', addedAt: Date.now() - 60000 },
];

test('store: trusted entries saved for tagged nodes do not count as active', async () => {
  const { isTaggedTrust, activeTrustedCount, normSettings } = await load('main/store.js');
  const s = normSettings({ trustedNodes: TRUSTED });
  assert.deepEqual(s.trustedNodes.map(isTaggedTrust), [false, true]);
  assert.equal(activeTrustedCount(s), 1);
  assert.equal(activeTrustedCount(normSettings(null)), 0);
  assert.equal(isTaggedTrust(null), false);
});

test('settings: a trusted entry for a tagged node is marked "Not applied" and can still be removed', async () => {
  const { setState, setSettings, store } = await load('main/store.js');
  const { createSettingsView } = await load('main/settings-view.js');
  setState(clone(MAC_STATE));
  setSettings({ trustedNodes: clone(TRUSTED) });
  const view = createSettingsView();
  view.open('security');
  const sheet = document.body.querySelectorAll('.sheet-layer').pop();
  const rows = sheet.querySelectorAll('.trusted-row');
  assert.equal(rows.length, 2);

  assert.ok(!rows[0].classList.contains('is-inactive'));
  assert.equal(rows[0].querySelector('.trusted-note'), null);
  assert.match(rows[0].textContent, /bob@x/);

  assert.ok(rows[1].classList.contains('is-inactive'));
  assert.equal(rows[1].querySelector('.trusted-note').textContent, 'Not applied — tagged devices are never auto-accepted');
  assert.match(rows[1].textContent, /Tagged device/);
  assert.doesNotMatch(rows[1].textContent, /tagged-devices/);

  const sent = [];
  const realUpdate = api.updateSettings;
  api.updateSettings = async (p) => { sent.push(p); return { ...store.rawSettings, ...p }; };
  try {
    const remove = byText(rows[1], 'Remove');
    assert.ok(remove && !remove.disabled, 'Remove stays available');
    remove.click();
    await sleep(5);
    assert.deepEqual(sent.map((p) => p.trustedNodes.map((n) => n.stableId)), [['nB']]);
  } finally {
    api.updateSettings = realUpdate;
    view.close();
    setSettings(null);
  }
});

test('desk: the accept-mode summary counts only trusted entries that can auto-accept', async () => {
  const { setState, setSettings } = await load('main/store.js');
  const { mountDesk } = await load('main/desk.js');
  setState(clone(MAC_STATE));
  setSettings({ trustedNodes: clone(TRUSTED) });
  const root = mount();
  mountDesk(root, { openSettings() {} });
  assert.match(root.textContent, /1 trusted device(?!s)/);

  setSettings({ trustedNodes: [TRUSTED[1]] }); // only the tagged entry → nothing to advertise
  assert.doesNotMatch(root.textContent, /trusted device/);

  setSettings({ trustedNodes: [TRUSTED[0], { ...TRUSTED[0], stableId: 'nC' }] });
  assert.match(root.textContent, /2 trusted devices/);
  setSettings(null);
  root.remove();
});

/* ------------------------------------------------------------------ pairing a phone + identity */

const FP = 'TV-ABCD-EFGH-JKLM-NPQR-ST23';
const realQr = require('../src/main/qr');
const PAIR_LINK = 'tunnelview://pair/1/eyJ2IjoxfQ';
const NOTE = 'Pairing lets your phone recognise this computer. It does not let anyone in: the password, Who can connect and the approval prompt still decide.';

function pairingOffer(extra = {}) {
  return {
    ok: true, offerId: `offer-${Math.random().toString(36).slice(2)}`, link: PAIR_LINK, qr: realQr.encode(PAIR_LINK),
    expiresAt: Date.now() + 120000, fingerprint: FP, host: { name: 'studio-pc.tail1.ts.net', ips: ['100.64.0.2'], port: 47800 }, ...extra,
  };
}

/** Preload pairing calls, recorded; status events are pushed with emitPairing(). */
function installPairingApi({ start = () => pairingOffer() } = {}) {
  const listeners = new Set();
  api.startPairing = async () => { calls.push(['startPairing']); return start(); };
  api.cancelPairing = async (id) => { calls.push(['cancelPairing', id]); return { ok: true }; };
  api.onPairingStatus = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };
  api.copyText = async (t) => { calls.push(['copyText', t]); };
  return { emit: (s) => { for (const cb of [...listeners]) cb(s); }, listeners };
}
function removePairingApi() {
  for (const k of ['startPairing', 'cancelPairing', 'onPairingStatus', 'copyText', 'getIdentity', 'resetIdentity', 'retryIdentity']) delete api[k];
}
const topModal = () => document.body.querySelectorAll('.modal-layer').pop() || null;

test('store: identity and pairing payloads are checked before any view uses them', async () => {
  const { normIdentity, normPairingOffer, normPairingStatus, pairingBlocker, normState } = await load('main/store.js');
  assert.deepEqual(normIdentity({ available: true, fingerprint: FP, wasReset: false }), { available: true, fingerprint: FP, wasReset: false, error: null });
  assert.deepEqual(normIdentity({ available: false, fingerprint: null, wasReset: true, error: 'CORRUPT' }), { available: false, fingerprint: null, wasReset: true, error: 'CORRUPT' });
  assert.equal(normIdentity({ available: true, fingerprint: 'TV-0000' }).available, false, 'a malformed fingerprint is not shown');
  assert.equal(normIdentity({ available: false, error: '<b>x</b>' }).error, 'UNKNOWN');
  assert.equal(normIdentity(null), null);

  const offer = pairingOffer();
  const n = normPairingOffer(offer);
  assert.equal(n.offerId, offer.offerId);
  assert.deepEqual(n.qr, offer.qr);
  assert.equal(n.host.name, 'studio-pc.tail1.ts.net');
  for (const bad of [{ ...offer, ok: false }, { ...offer, link: 'https://evil.example' }, { ...offer, qr: { size: 22, bits: offer.qr.bits } },
    { ...offer, qr: { size: offer.qr.size, bits: 'AAAA' } }, { ...offer, fingerprint: 'nope' }, { ...offer, offerId: '' }]) {
    assert.equal(normPairingOffer(bad), null);
  }

  assert.deepEqual(normPairingStatus({ offerId: 'o1', phase: 'attempt-failed', peer: { name: 'evil\u202Epc', login: 'm@x', os: 'beos' } }),
    { offerId: 'o1', phase: 'attempt-failed', reason: '', peer: { name: 'evilpc', login: 'm@x', os: 'other' } });
  assert.equal(normPairingStatus({ offerId: 'o1', phase: 'started' }), null);

  const st = (patch) => normState({ ...clone(MAC_STATE), ...patch });
  assert.equal(pairingBlocker(st({}), { available: true, fingerprint: FP }), null);
  assert.equal(pairingBlocker(st({}), null), null, 'identity not known yet: main decides');
  assert.equal(pairingBlocker(st({ host: { ...MAC_STATE.host, session: SESSION } })).code, 'SESSION_ACTIVE');
  assert.equal(pairingBlocker(st({ host: { ...MAC_STATE.host, enabled: false } })).code, 'HOSTING_OFF');
  assert.equal(pairingBlocker(st({ tailscale: { ...MAC_STATE.tailscale, state: 'stopped' } })).code, 'TS_DOWN');
  assert.equal(pairingBlocker(st({ host: { ...MAC_STATE.host, listening: false } })).code, 'HOSTING_OFF');
  assert.equal(pairingBlocker(st({}), { available: false, error: 'CORRUPT' }).code, 'NO_IDENTITY');
});

test('dialogs: the QR canvas shows every module, black on white, inside a 4-module quiet zone', async () => {
  const { qrModules, drawQr } = await load('main/dialogs.js');
  const { QrCode, QrSegment } = require('../src/main/vendor/qrcodegen');
  const sym = QrCode.encodeSegments([QrSegment.makeBytes([...Buffer.from(PAIR_LINK, 'utf8')])], QrCode.Ecc.MEDIUM);
  const qr = realQr.encode(PAIR_LINK);
  const rows = qrModules(qr);
  assert.equal(rows.length, sym.size);
  for (let y = 0; y < sym.size; y++) for (let x = 0; x < sym.size; x++) assert.equal(rows[y][x], sym.getModule(x, y), `module ${x},${y}`);
  assert.equal(qrModules({ size: qr.size, bits: 'AAAA' }), null);

  const ops = [];
  const ctx = { set fillStyle(v) { ops.push(['style', v]); }, fillRect: (...r) => ops.push(['rect', ...r]) };
  const canvas = { getContext: (t) => (t === '2d' ? ctx : null), width: 0, height: 0 };
  assert.equal(drawQr(canvas, qr), true);
  const scale = canvas.width / (qr.size + 8);
  assert.ok(Number.isInteger(scale) && scale >= 2, 'whole pixels per module');
  assert.equal(canvas.width, canvas.height);
  assert.deepEqual(ops.slice(0, 3), [['style', '#ffffff'], ['rect', 0, 0, canvas.width, canvas.height], ['style', '#000000']]);
  const dark = ops.slice(3);
  assert.equal(dark.length, rows.flat().filter(Boolean).length);
  assert.ok(dark.every(([, x, y, w, hgt]) => x >= 4 * scale && y >= 4 * scale && w === scale && hgt === scale
    && x + w <= (qr.size + 4) * scale && y + hgt <= (qr.size + 4) * scale), 'quiet zone stays light');
  assert.equal(drawQr({}, qr), false, 'no canvas support → false (the link can still be copied)');
});

test('desk: "Pair a phone" needs a preload that can pair; disabled with the reason when it cannot', async () => {
  const { setState, store } = await load('main/store.js');
  const { mountDesk } = await load('main/desk.js');
  setState(clone(MAC_STATE));
  store.identity = null;
  let root = mount();
  mountDesk(root, { openSettings() {} });
  assert.equal(root.querySelector('[data-fid="pair-phone"]'), null, 'older preload: no button');
  root.remove();

  const pa = installPairingApi();
  root = mount();
  mountDesk(root, { openSettings() {} });
  const btn = () => root.querySelector('[data-fid="pair-phone"]');
  const hint = () => root.querySelector('#pair-phone-hint').textContent;
  assert.ok(btn() && !btn().disabled);
  assert.match(btn().textContent, /Pair a phone/);
  assert.equal(btn().getAttribute('aria-describedby'), 'pair-phone-hint');

  const cases = [
    [{ host: { ...MAC_STATE.host, enabled: false } }, 'Turn on incoming connections to pair a phone.'],
    [{ tailscale: { ...MAC_STATE.tailscale, state: 'needs-login' } }, 'Start Tailscale to pair a phone.'],
    [{ host: { ...MAC_STATE.host, session: SESSION } }, 'Not available during a session.'],
  ];
  for (const [patch, text] of cases) {
    setState({ ...clone(MAC_STATE), ...clone(patch) });
    assert.equal(btn().disabled, true, text);
    assert.equal(hint(), text);
  }
  setState(clone(MAC_STATE));
  api.getIdentity = async () => ({ available: false, fingerprint: null, wasReset: false, error: 'CORRUPT' });
  const { refreshIdentity } = await load('main/store.js');
  await refreshIdentity();
  assert.equal(btn().disabled, true);
  assert.match(hint(), /can’t prove its identity to phones right now/);
  api.getIdentity = async () => ({ available: true, fingerprint: FP, wasReset: false });
  await refreshIdentity();
  assert.equal(btn().disabled, false);

  calls.length = 0;
  btn().click();
  await sleep(5);
  assert.deepEqual(calls[0], ['startPairing']);
  const modal = topModal();
  assert.ok(modal && modal.querySelector('.modal-pair'), 'the pairing dialog opened');
  byText(modal, 'Close').click();
  await sleep(5);
  assert.equal(pa.listeners.size, 0);
  store.identity = null;
  removePairingApi();
  root.remove();
});

test('pairing dialog: QR, name, ID, countdown and the note; live attempts; closing withdraws the offer', async () => {
  const { openPairingDialog } = await load('main/dialogs.js');
  const offer = pairingOffer();
  const pa = installPairingApi({ start: () => offer });
  calls.length = 0;
  const done = openPairingDialog();
  await sleep(5);
  const modal = topModal();
  const card = modal.querySelector('.modal-pair');
  assert.ok(card);
  assert.equal(card.getAttribute('role'), 'dialog');
  const text = () => card.textContent;
  assert.match(text(), /Scan with Tunnelview on your phone/);
  assert.ok(text().includes(NOTE), 'the note, word for word');
  assert.ok(text().includes('studio-pc.tail1.ts.net'));
  assert.ok(text().includes(FP));
  const canvas = card.querySelector('canvas');
  assert.equal(canvas.getAttribute('role'), 'img');
  assert.ok(canvas.getAttribute('aria-label'));
  const timer = card.querySelector('[role="timer"]');
  assert.match(timer.textContent, /^(2:00|1:59)$/);
  assert.ok(card.querySelector('[role="status"]'));
  assert.equal(byText(card, 'New code').hidden, true);

  byText(card, 'Copy pairing link').click();
  await sleep(5);
  assert.deepEqual(calls.find((c) => c[0] === 'copyText'), ['copyText', PAIR_LINK]);

  pa.emit({ offerId: 'some-other-offer', phase: 'attempt-failed', peer: { name: 'ignored', login: '', os: 'ios' } });
  pa.emit({ offerId: offer.offerId, phase: 'attempt-failed', peer: { name: 'mallory-phone', login: 'mallory@example.com', os: 'android' } });
  const failures = card.querySelector('.pair-failures');
  assert.equal(failures.children.length, 1);
  assert.equal(failures.children[0].textContent, 'mallory-phone · mallory@example.com · Android');
  assert.match(card.querySelector('[role="status"]').textContent, /A pairing attempt failed/);
  assert.doesNotMatch(text(), /ignored/);

  pa.emit({ offerId: offer.offerId, phase: 'failed', reason: 'too-many-attempts' });
  assert.match(card.querySelector('[role="status"]').textContent, /blocked after 3 wrong attempts/);
  assert.equal(byText(card, 'New code').hidden, false);
  assert.equal(byText(card, 'Copy pairing link').disabled, true);

  const next = pairingOffer();
  api.startPairing = async () => { calls.push(['startPairing']); return next; };
  byText(card, 'New code').click();
  await sleep(5);
  assert.equal(card.querySelector('.pair-failures').children.length, 0, 'a new code starts a new list');
  assert.equal(byText(card, 'New code').hidden, true);
  pa.emit({ offerId: offer.offerId, phase: 'cancelled', reason: 'replaced' });
  assert.match(card.querySelector('[role="status"]').textContent, /Waiting for your phone/, 'the replaced offer is old news');

  calls.length = 0;
  byText(card, 'Close').click();
  assert.deepEqual(await done, { paired: false });
  assert.deepEqual(calls, [['cancelPairing', next.offerId]], 'only the offer this dialog shows');
  assert.equal(pa.listeners.size, 0, 'unsubscribed');
  removePairingApi();
});

test('pairing dialog: refusals are explained; a paired phone ends it with Done and no cancel', async () => {
  const { openPairingDialog } = await load('main/dialogs.js');
  installPairingApi({ start: () => ({ ok: false, code: 'TS_DOWN' }) });
  const before = document.body.querySelectorAll('.modal-layer').length;
  assert.deepEqual(await openPairingDialog(), { paired: false });
  assert.equal(document.body.querySelectorAll('.modal-layer').length, before, 'no dialog');
  assert.ok(toasts().includes('Start Tailscale to pair a phone.'), toasts().join(' | '));

  const offer = pairingOffer();
  const pa = installPairingApi({ start: () => offer });
  const done = openPairingDialog();
  await sleep(5);
  const card = topModal().querySelector('.modal-pair');
  pa.emit({ offerId: offer.offerId, phase: 'paired', peer: { name: 'pixel-8', login: 'alice@example.com', os: 'android' } });
  assert.match(card.querySelector('[role="status"]').textContent, /Paired with pixel-8 · alice@example.com/);
  assert.ok(byText(card, 'Done'));
  assert.equal(byText(card, 'Copy pairing link').hidden, true);
  calls.length = 0;
  byText(card, 'Done').click();
  assert.deepEqual(await done, { paired: true });
  assert.deepEqual(calls, [], 'nothing left to cancel');
  removePairingApi();
});

/** Canvas elements get a 2d context that records what is painted (the fake DOM has none). */
function recordingCanvas() {
  const ops = [];
  FakeElement.prototype.getContext = function getContext(type) {
    return type === '2d' ? { set fillStyle(v) { ops.push(['style', v]); }, fillRect: (...r) => ops.push(['rect', ...r]) } : null;
  };
  return { ops, restore: () => { delete FakeElement.prototype.getContext; } };
}

/** matchMedia whose 'change' listeners the test fires itself (once, as the dialog asks). */
function fakeMatchMedia() {
  const mqs = [];
  globalThis.matchMedia = (q) => {
    const fns = new Set();
    const mq = { q, fns, addEventListener: (_t, fn) => fns.add(fn), removeEventListener: (_t, fn) => fns.delete(fn) };
    mqs.push(mq);
    return mq;
  };
  const fire = () => { const mq = mqs.at(-1); const fns = [...mq.fns]; mq.fns.clear(); for (const fn of fns) fn(); };
  return { mqs, fire, restore: () => { delete globalThis.matchMedia; } };
}

test('dialogs: drawQr gives every module the same whole number of device pixels and sizes the canvas to match', async () => {
  const { drawQr } = await load('main/dialogs.js');
  const pairing = require('../src/main/pairing');
  // A typical link (version 13) and the worst case D6 allows for (version 21).
  const linkOf = (n) => pairing.encodeLink({
    v: 1, id: 'nHOSTabc123CNTRL', n, a: ['100.101.102.103', 'fd7a:115c:a1e0::1234:5678'], p: 47800,
    k: Buffer.alloc(32, 1).toString('base64url'), t: Buffer.alloc(16, 2).toString('base64url'), x: 1762520000,
  });
  const typical = realQr.encode(linkOf('office-pc.tail1234.ts.net'));
  const worst = realQr.encode(linkOf(`${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}`));
  assert.ok(worst.size > typical.size);
  try {
    for (const qr of [typical, worst]) {
      for (const dpr of [1, 1.25, 1.5, 2, 3]) {
        globalThis.devicePixelRatio = dpr;
        const canvas = { getContext: () => ({ set fillStyle(_v) {}, fillRect() {} }), width: 0, height: 0, style: {} };
        assert.equal(drawQr(canvas, qr), true);
        const total = qr.size + 8;
        const perModule = canvas.width / total;
        assert.ok(Number.isInteger(perModule) && perModule >= 2, `${qr.size}@${dpr}: ${perModule} device px per module`);
        const css = parseFloat(canvas.style.width);
        assert.equal(canvas.style.width, `${css}px`);
        assert.equal(canvas.style.height, canvas.style.width);
        assert.ok(Math.abs(css * dpr - canvas.width) < 1e-9, `${qr.size}@${dpr}: shown 1:1 on device pixels, not rescaled`);
        assert.ok(css <= 232 || perModule === 2, `${qr.size}@${dpr}: ${css}px fits the dialog's box`);
      }
    }
  } finally {
    delete globalThis.devicePixelRatio;
  }
});

test('pairing dialog: an ended or used code is cleared, not faded; New code draws again; a new pixel ratio redraws a live one', async () => {
  const { openPairingDialog } = await load('main/dialogs.js');
  const rec = recordingCanvas();
  const media = fakeMatchMedia();
  const offer = pairingOffer();
  const pa = installPairingApi({ start: () => offer });
  try {
    const done = openPairingDialog();
    await sleep(5);
    const card = topModal().querySelector('.modal-pair');
    const canvas = card.querySelector('canvas');
    const label = card.querySelector('.pair-qr-ended');
    const total = offer.qr.size + 8;
    const painted = () => rec.ops.filter(([k, v]) => k === 'style' && v === '#000000').length;
    assert.ok(painted() > 0, 'the code is drawn');
    assert.equal(canvas.width % total, 0);
    assert.equal(canvas.style.width, `${canvas.width}px`, 'devicePixelRatio 1');
    assert.equal(label.hidden, true);

    // The window moves to a 200 % monitor: drawn again for it, and the new ratio is watched.
    assert.match(media.mqs.at(-1).q, /\(resolution: 1dppx\)/);
    globalThis.devicePixelRatio = 2;
    rec.ops.length = 0;
    media.fire();
    assert.ok(painted() > 0);
    assert.equal(canvas.width / total, Math.floor((232 * 2) / total));
    assert.equal(canvas.style.width, `${canvas.width / 2}px`);
    assert.match(media.mqs.at(-1).q, /\(resolution: 2dppx\)/);

    // Expired: painted over in white (a faded symbol still scans), and the box says why.
    rec.ops.length = 0;
    pa.emit({ offerId: offer.offerId, phase: 'expired' });
    assert.deepEqual(rec.ops, [['style', '#ffffff'], ['rect', 0, 0, canvas.width, canvas.height]]);
    assert.equal(label.hidden, false);
    assert.equal(label.textContent, 'Code ended');
    assert.match(canvas.getAttribute('aria-label'), /code ended/);
    rec.ops.length = 0;
    media.fire();
    assert.deepEqual(rec.ops, [], 'a new pixel ratio does not bring a dead code back');

    const next = pairingOffer();
    api.startPairing = async () => next;
    byText(card, 'New code').click();
    await sleep(5);
    assert.ok(painted() > 0, 'the new code is drawn');
    assert.equal(label.hidden, true);
    assert.match(canvas.getAttribute('aria-label'), /Scan it with Tunnelview/);

    // Used by the phone: cleared as well.
    rec.ops.length = 0;
    pa.emit({ offerId: next.offerId, phase: 'paired', peer: { name: 'pixel-8', login: 'alice@example.com', os: 'android' } });
    assert.deepEqual(rec.ops, [['style', '#ffffff'], ['rect', 0, 0, canvas.width, canvas.height]]);
    assert.equal(label.textContent, 'Paired');
    byText(card, 'Done').click();
    assert.deepEqual(await done, { paired: true });
    assert.equal(media.mqs.at(-1).fns.size, 0, 'no longer watching the pixel ratio');
  } finally {
    rec.restore();
    media.restore();
    delete globalThis.devicePixelRatio;
    removePairingApi();
  }
});

test('pairing dialog: a refused New code keeps Copy disabled; keyboard focus moves with the buttons that are shown', async () => {
  const { openPairingDialog } = await load('main/dialogs.js');
  await sleep(200); // earlier dialogs hand the focus back 160 ms after they close
  const offer = pairingOffer();
  const pa = installPairingApi({ start: () => offer });
  const done = openPairingDialog();
  await sleep(5);
  const card = topModal().querySelector('.modal-pair');
  const copy = byText(card, 'Copy pairing link');
  const renew = byText(card, 'New code');
  const close = byText(card, 'Close');
  const status = () => card.querySelector('[role="status"]').textContent;

  copy.focus();
  pa.emit({ offerId: offer.offerId, phase: 'failed', reason: 'too-many-attempts' });
  assert.equal(copy.disabled, true);
  assert.equal(document.activeElement, renew, 'from the now disabled Copy to New code, not to <body>');

  // Refused (someone connected meanwhile): the code on screen is still the dead one.
  api.startPairing = async () => ({ ok: false, code: 'SESSION_ACTIVE' });
  renew.click();
  await sleep(5);
  assert.equal(status(), 'Not available while someone is connected to this computer.');
  assert.equal(copy.disabled, true, 'Copy stays disabled');
  assert.equal(renew.disabled, false);
  assert.equal(close.disabled, false);
  assert.equal(document.activeElement, renew);

  // Accepted: New code is hidden again, so the focus goes to Copy.
  const next = pairingOffer();
  api.startPairing = async () => next;
  renew.click();
  await sleep(5);
  assert.equal(renew.hidden, true);
  assert.equal(copy.disabled, false);
  assert.equal(document.activeElement, copy);

  // Focus somewhere else in the dialog is left where it is.
  close.focus();
  pa.emit({ offerId: next.offerId, phase: 'cancelled', reason: 'session' });
  assert.equal(document.activeElement, close);
  close.click();
  assert.deepEqual(await done, { paired: false });
  removePairingApi();
});

test('pairing dialog: the countdown running out and an expiry pushed by main both end the code', async () => {
  const { openPairingDialog } = await load('main/dialogs.js');
  const ended = (card) => {
    assert.match(card.querySelector('[role="status"]').textContent, /^This code expired\. Make a new one to pair\.$/);
    assert.equal(card.querySelector('.pair-expiry').hidden, true);
    assert.equal(byText(card, 'New code').hidden, false);
    assert.equal(byText(card, 'Copy pairing link').disabled, true);
  };

  // The dialog's own countdown: the offer's time is up at the first tick.
  installPairingApi({ start: () => pairingOffer({ expiresAt: Date.now() - 1 }) });
  let done = openPairingDialog();
  await sleep(5);
  let card = topModal().querySelector('.modal-pair');
  assert.equal(card.querySelector('[role="timer"]').textContent, '0:00');
  ended(card);
  byText(card, 'Close').click();
  await done;

  // main's 'expired' (host-server's timer) for a code the dialog still counts down.
  const offer = pairingOffer();
  const pa = installPairingApi({ start: () => offer });
  done = openPairingDialog();
  await sleep(5);
  card = topModal().querySelector('.modal-pair');
  assert.match(card.querySelector('[role="status"]').textContent, /Waiting for your phone/);
  pa.emit({ offerId: offer.offerId, phase: 'expired' });
  ended(card);
  byText(card, 'Close').click();
  assert.deepEqual(await done, { paired: false });
  removePairingApi();
});

test('app.css: the pairing dialog scrolls its body, so Close / New code stay in view in a small window', () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'main', 'app.css'), 'utf8');
  const theme = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'shared', 'theme.css'), 'utf8');
  const rule = (sel) => {
    const m = new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm').exec(css);
    assert.ok(m, `no ${sel} rule`);
    return m[1].replace(/\s+/g, ' ');
  };
  // The card is a flex column capped at the window height; the body is the part that gives way.
  assert.match(rule('.modal'), /max-height: calc\(100vh - 48px\)/);
  assert.match(rule('.modal'), /display: flex; flex-direction: column/);
  const body = rule('.modal-pair .modal-body');
  for (const decl of ['flex: 1 1 auto', 'min-height: 0', 'overflow-y: auto']) assert.ok(body.includes(decl), `${decl} in .modal-pair .modal-body`);
  // An ended code is cleared in script and labelled; the label hides with [hidden].
  assert.doesNotMatch(css, /\.pair-qr\.is-ended\s*\{[^}]*opacity/);
  assert.match(rule('.pair-qr-ended'), /position: absolute; inset: 0;/);
  assert.match(theme, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test('pairing dialog: a link without a MagicDNS name shows the address the phone will show', async () => {
  const { openPairingDialog } = await load('main/dialogs.js');
  installPairingApi({ start: () => pairingOffer({ host: { name: '', ips: ['100.64.0.2', 'fd7a:115c:a1e0::2'], port: 47800 } }) });
  const done = openPairingDialog();
  await sleep(5);
  const card = topModal().querySelector('.modal-pair');
  const facts = card.querySelector('.pair-facts').textContent;
  assert.ok(facts.includes('Computer100.64.0.2'), facts);
  byText(card, 'Close').click();
  await done;
  removePairingApi();
});

test('settings: this computer\'s ID, the unavailable banner with Retry, Reset identity… (confirmed, locked in a session)', async () => {
  const { setState, setSettings, store, refreshIdentity } = await load('main/store.js');
  const { createSettingsView } = await load('main/settings-view.js');
  setState(clone(MAC_STATE));
  setSettings({});
  store.identity = null;
  let view = createSettingsView();
  view.open('security');
  let sheet = document.body.querySelectorAll('.sheet-layer').pop();
  assert.equal(sheet.querySelector('.id-row').hidden, true, 'older preload: no identity row');
  view.close();

  let identity = { available: true, fingerprint: FP, wasReset: false };
  api.getIdentity = async () => { calls.push(['getIdentity']); return identity; };
  api.retryIdentity = async () => { calls.push(['retryIdentity']); return identity; };
  api.resetIdentity = async () => {
    calls.push(['resetIdentity']);
    identity = { available: true, fingerprint: 'TV-ZZZZ-YYYY-XXXX-WWWW-VVVV', wasReset: true };
    return { ok: true, ...identity };
  };
  await refreshIdentity();
  view = createSettingsView();
  view.open('security');
  sheet = document.body.querySelectorAll('.sheet-layer').pop();
  const row = sheet.querySelector('.id-row');
  assert.equal(row.hidden, false);
  assert.ok(row.textContent.includes(`This computer's ID: ${FP}`), row.textContent);
  const banner = row.querySelector('.id-banner');
  assert.equal(banner.hidden, true);

  // Unavailable → banner with Retry (and Reset identity…).
  identity = { available: false, fingerprint: null, wasReset: false, error: 'CORRUPT' };
  await refreshIdentity();
  assert.equal(banner.hidden, false);
  assert.match(banner.textContent, /This computer can't prove its identity to phones right now/);
  assert.match(banner.textContent, /The identity file is damaged\./);
  // DOCS-11: the banner names the files and their folder, so the user knows what to check.
  assert.ok(banner.textContent.includes('The files are identity.json and identity.json.bak in ~/Library/Application Support/Tunnelview.'), banner.textContent);
  setState({ ...clone(MAC_STATE), platform: 'windows' });
  assert.ok(banner.textContent.includes('identity.json and identity.json.bak in %LOCALAPPDATA%\\Tunnelview.'), banner.textContent);
  identity = { available: false, fingerprint: null, wasReset: false, error: 'MISSING' };
  await refreshIdentity();
  assert.match(banner.textContent, /Put one back and Retry before you restart Tunnelview, or reset the identity\./);
  setState(clone(MAC_STATE));
  assert.ok(byText(banner, 'Reset identity…'));
  identity = { available: true, fingerprint: FP, wasReset: false };
  calls.length = 0;
  byText(banner, 'Retry').click();
  await sleep(5);
  assert.deepEqual(calls, [['retryIdentity']]);
  assert.equal(banner.hidden, true);

  // Locked while someone is connected; Retry is not a security change.
  setState({ ...clone(MAC_STATE), host: { ...MAC_STATE.host, session: SESSION } });
  const resetBtns = row.querySelectorAll('button').filter((b) => b.textContent === 'Reset identity…');
  assert.equal(resetBtns.length, 2);
  assert.ok(resetBtns.every((b) => b.disabled && b.hasAttribute('data-lock')));
  setState(clone(MAC_STATE));
  const resetBtn = resetBtns.find((b) => !b.closest('.id-banner'));
  assert.equal(resetBtn.disabled, false);

  // Reset asks first; Cancel changes nothing.
  calls.length = 0;
  resetBtn.click();
  await sleep(5);
  byText(topModal(), 'Cancel').click();
  await sleep(5);
  assert.deepEqual(calls, []);
  resetBtn.click();
  await sleep(5);
  const confirmModal = topModal();
  assert.match(confirmModal.textContent, /Phones paired with it will stop connecting until you pair them again/);
  byText(confirmModal, 'Reset identity').click();
  await sleep(5);
  assert.deepEqual(calls, [['resetIdentity']]);
  assert.ok(row.textContent.includes("This computer's ID: TV-ZZZZ-YYYY-XXXX-WWWW-VVVV"));
  assert.ok(row.textContent.includes('Phones paired with this computer must pair again'));
  view.close();
  store.identity = null;
  removePairingApi();
});

/* ------------------------------------------------------------------ in-app updates (DECISIONS U6) */

const LATEST = { version: '0.3.0', date: '2026-11-01T10:00:00.000Z', notes: 'Faster reconnects.\n\tIndented line', size: 104857600 };
/** A full UpdateState (src/preload/main.js) with `patch` applied. */
function updateState(patch = {}) {
  return {
    status: 'idle', phase: null, currentVersion: '0.2.0', platform: 'windows', supported: true, autoCheck: true,
    lastCheckAt: null, latest: null, downloaded: false, progress: null, error: null, blocked: null, justUpdated: null,
    ...patch,
  };
}
const UPDATE_API_KEYS = ['getUpdateState', 'checkForUpdates', 'downloadUpdate', 'installUpdate', 'cancelUpdate', 'setAutoUpdateCheck', 'revealUpdate', 'openReleasesPage', 'onUpdateState'];

/**
 * Preload update:* calls, recorded. push(s) is main's side: it becomes what getUpdateState answers
 * and is pushed (update:state) to the store at once.
 */
async function installUpdateApi(over = {}) {
  const { setUpdateState } = await load('main/store.js');
  let st = updateState();
  Object.assign(api, {
    getUpdateState: async () => { calls.push(['getUpdateState']); return clone(st); },
    checkForUpdates: async () => { calls.push(['checkForUpdates']); return clone(st); },
    downloadUpdate: async () => { calls.push(['downloadUpdate']); return { ok: true }; },
    installUpdate: async () => { calls.push(['installUpdate']); return { ok: true }; },
    cancelUpdate: async () => { calls.push(['cancelUpdate']); return { ok: false, code: 'NOT_DOWNLOADING', message: 'No download is running.' }; },
    setAutoUpdateCheck: async (v) => { calls.push(['setAutoUpdateCheck', v]); st = { ...st, autoCheck: v }; return { ok: true }; },
    revealUpdate: async () => { calls.push(['revealUpdate']); return { ok: true }; },
    openReleasesPage: async () => { calls.push(['openReleasesPage']); return { ok: true }; },
    onUpdateState: () => () => {},
  }, over);
  return { push: (s) => { st = clone(s); setUpdateState(clone(s)); } };
}
async function removeUpdateApi() {
  const { store } = await load('main/store.js');
  for (const k of UPDATE_API_KEYS) delete api[k];
  store.update = null;
}
const updateSection = (sheet) => sheet.querySelector('#set-updates');
const statusText = (sec) => sec.querySelector('.update-status-text').textContent;
const primaryButton = (sec) => sec.querySelector('.update-actions').querySelector('.btn-primary');

test('store.normUpdateState: every key, enums and versions checked, notes stay multi-line plain text', async () => {
  const { normUpdateState, cleanNotes, normUpdateResult } = await load('main/store.js');
  assert.equal(normUpdateState(null), null);
  assert.equal(normUpdateState('idle'), null);
  const keys = ['status', 'phase', 'currentVersion', 'platform', 'supported', 'autoCheck', 'lastCheckAt', 'latest', 'downloaded', 'progress', 'error', 'blocked', 'justUpdated', 'installBlocked'];
  assert.deepEqual(Object.keys(normUpdateState({})).sort(), [...keys].sort());
  assert.equal(normUpdateState({ status: 'bogus' }).status, 'idle');
  // installBlocked (MACFLOW-4): a well-formed code keeps its text; anything else is dropped.
  assert.equal(normUpdateState({}).installBlocked, null);
  assert.deepEqual(normUpdateState({ installBlocked: { code: 'TRANSLOCATED', message: 'Move it.‮', extra: 1 } }).installBlocked,
    { code: 'TRANSLOCATED', message: 'Move it.' });
  assert.equal(normUpdateState({ installBlocked: { code: '<b>', message: 'x' } }).installBlocked, null);
  assert.equal(normUpdateState({ installBlocked: 'TRANSLOCATED' }).installBlocked, null);
  assert.match(normUpdateState({ installBlocked: { code: 'NOT_OWNER' } }).installBlocked.message, /cannot replace itself/);

  const s = normUpdateState(updateState({
    status: 'downloading',
    latest: { ...LATEST, notes: 'a\n\tb\u202e\u0000\u2028c' },
    progress: { received: 5, total: 10, percent: 50.7 },
    error: { code: '<b>x</b>', message: 'm' },
    blocked: 'SOMETHING_ELSE',
    justUpdated: { from: '0.1.0', to: 'v0.3' },
  }));
  assert.equal(s.latest.notes, 'a\n\tbc', 'line breaks and tabs kept; bidi, NUL and U+2028 removed');
  assert.deepEqual(s.progress, { received: 5, total: 10, percent: 50 });
  assert.equal(s.error, null);
  assert.equal(s.blocked, null);
  assert.equal(s.justUpdated, null);
  assert.equal(normUpdateState(updateState({ status: 'ready', progress: { percent: 5 } })).progress, null, 'progress only while downloading');
  assert.equal(normUpdateState(updateState({ status: 'ready', phase: 'quitting' })).phase, null, 'phase only while installing');
  assert.equal(normUpdateState(updateState({ status: 'installing', phase: 'quitting' })).phase, 'quitting');
  assert.equal(normUpdateState(updateState({ latest: { ...LATEST, version: '1.0' } })).latest, null);
  assert.equal(normUpdateState(updateState({ downloaded: true })).downloaded, false, 'nothing is downloaded without a latest version');
  assert.deepEqual(normUpdateState(updateState({ justUpdated: { from: 'x', to: '0.3.0' } })).justUpdated, { from: '', to: '0.3.0' });
  assert.equal(normUpdateState(updateState({ error: { code: 'NETWORK', message: '' } })).error.message, 'The update failed.');

  assert.equal(cleanNotes('x'.repeat(5000)).length, 4000);
  assert.equal(cleanNotes('\n\n  \nHello\n  world\n\n'), 'Hello\n  world', 'leading blank lines and trailing space go, indentation stays');
  assert.equal(cleanNotes(42), '');

  assert.deepEqual(normUpdateResult({ ok: true, extra: 1 }), { ok: true });
  assert.deepEqual(normUpdateResult({ ok: false, code: 'UAC_DECLINED', message: 'm' }), { ok: false, code: 'UAC_DECLINED', message: 'm' });
  assert.deepEqual(normUpdateResult(null), { ok: false, code: 'UNKNOWN', message: 'The update failed.' });
});

test('updates: the status line and the buttons follow UpdateState', async () => {
  const { normUpdateState } = await load('main/store.js');
  const { describeUpdate, updatePlan, BLOCKED_TEXT, NOT_SUPPORTED_TEXT } = await load('main/updates.js');
  const u = (patch) => normUpdateState(updateState(patch));
  const text = (patch) => describeUpdate(u(patch)).text;
  assert.equal(text({ status: 'idle' }), '', 'nothing checked yet: no status line');
  assert.equal(text({ status: 'checking' }), 'Checking for updates…');
  assert.equal(text({ status: 'up-to-date' }), 'Up to date');
  assert.equal(text({ status: 'available', latest: LATEST }), 'Update 0.3.0 available');
  const dl = describeUpdate(u({ status: 'downloading', latest: LATEST, progress: { received: 52428800, total: 104857600, percent: 50 } }));
  assert.equal(dl.text, 'Downloading 50%');
  assert.equal(dl.progress, 50);
  assert.equal(dl.detail, '50 MB of 100 MB');
  assert.doesNotMatch(dl.announce, /%/, 'the live region is not told every percent');
  assert.equal(text({ status: 'ready', latest: LATEST, downloaded: true }), 'Ready to install');
  assert.equal(text({ status: 'installing', phase: 'waiting-for-approval', latest: LATEST, downloaded: true }), 'Waiting for administrator permission…');
  const net = 'Could not reach GitHub. Check the internet connection and try again.';
  const err = describeUpdate(u({ status: 'error', error: { code: 'NETWORK', message: net } }));
  assert.deepEqual([err.tone, err.text], ['danger', net]);
  assert.equal(describeUpdate(u({ status: 'available', latest: LATEST, supported: false })).detail, NOT_SUPPORTED_TEXT);

  const plan = (patch, ops) => updatePlan(u(patch), ops);
  assert.equal(plan({ status: 'up-to-date' }).primary, null);
  assert.deepEqual(plan({ status: 'up-to-date' }).check, { enabled: true, busy: false });
  assert.deepEqual(plan({ status: 'available', latest: LATEST }).primary, { action: 'download', label: 'Download and install', enabled: true, busy: false });
  assert.deepEqual(plan({ status: 'downloading', latest: LATEST }).primary, { action: 'download', label: 'Downloading…', enabled: false, busy: true });
  assert.deepEqual(plan({ status: 'ready', latest: LATEST, downloaded: true }).primary, { action: 'install', label: 'Restart and install', enabled: true, busy: false });
  assert.equal(plan({ status: 'installing', phase: 'preparing', latest: LATEST, downloaded: true }).primary.label, 'Installing…');

  // A session: Install waits and says why; Check now and Download keep working.
  for (const b of ['INCOMING_SESSION', 'INCOMING_REQUEST', 'OUTGOING_SESSION', 'SESSION_ACTIVE']) {
    const p = plan({ status: 'ready', latest: LATEST, downloaded: true, blocked: b });
    assert.equal(p.primary.enabled, false, b);
    assert.equal(p.hint, BLOCKED_TEXT[b]);
    assert.equal(p.check.enabled, true);
  }
  assert.equal(BLOCKED_TEXT.INCOMING_SESSION, 'Someone is connected to this computer. Install the update after the session ends.');
  const dlBlocked = plan({ status: 'available', latest: LATEST, blocked: 'INCOMING_SESSION' });
  assert.equal(dlBlocked.primary.enabled, true);
  assert.equal(dlBlocked.hint, BLOCKED_TEXT.INCOMING_SESSION);
  assert.equal(plan({ status: 'up-to-date', blocked: 'INCOMING_SESSION' }).hint, '', 'nothing to install, nothing to explain');

  // A declined prompt can be tried again, and the file shown; a damaged download is fetched again.
  const declined = plan({ status: 'error', latest: LATEST, downloaded: true, error: { code: 'UAC_DECLINED', message: 'x' } });
  assert.deepEqual([declined.primary.label, declined.primary.enabled, declined.reveal], ['Restart and install', true, true]);
  const damaged = plan({ status: 'error', latest: LATEST, error: { code: 'HASH_MISMATCH', message: 'x' } });
  assert.deepEqual([damaged.primary.label, damaged.reveal], ['Download and install', false]);
  assert.equal(plan({ status: 'error', error: { code: 'INSTALL_INCOMPLETE', message: 'x' } }).reveal, true, 'next start: the installer can be shown');
  assert.equal(plan({ status: 'error', error: { code: 'NETWORK', message: 'x' } }).reveal, false);

  // This copy cannot update itself: the GitHub releases page instead.
  const ns = plan({ status: 'available', latest: LATEST, supported: false });
  assert.deepEqual([ns.primary.action, ns.primary.enabled, ns.releases], ['releases', true, false]);

  // Busy (stays focusable) vs. not usable now; a click this window still waits on counts too.
  assert.deepEqual(plan({ status: 'checking' }).check, { enabled: false, busy: true });
  assert.deepEqual(plan({ status: 'up-to-date' }, { check: true }).check, { enabled: false, busy: true });
  assert.deepEqual(plan({ status: 'downloading', latest: LATEST }).check, { enabled: false, busy: false });
  assert.deepEqual(plan({ status: 'ready', latest: LATEST, downloaded: true }, { install: true }).primary,
    { action: 'install', label: 'Restart and install', enabled: false, busy: true });

  // SEC-5: Cancel is offered only while a download runs.
  assert.equal(plan({ status: 'downloading', latest: LATEST }).cancel, true);
  for (const s of [{ status: 'available', latest: LATEST }, { status: 'ready', latest: LATEST, downloaded: true }, { status: 'checking' }]) {
    assert.equal(plan(s).cancel, false, s.status);
  }
  assert.equal(updatePlan(null).cancel, false);

  // MACFLOW-4: this copy cannot replace itself where it runs. The download still works (labelled
  // "Download"), the status line says why, and once downloaded the primary button shows the file.
  const where = { code: 'TRANSLOCATED', message: 'macOS runs this copy from a temporary place. Move it.' };
  const mac = { platform: 'macos', installBlocked: where };
  const avail = plan({ ...mac, status: 'available', latest: LATEST });
  assert.deepEqual(avail.primary, { action: 'download', label: 'Download', enabled: true, busy: false });
  assert.equal(describeUpdate(u({ ...mac, status: 'available', latest: LATEST })).detail, `Download size: 100 MB. ${where.message}`);
  assert.equal(plan({ ...mac, status: 'downloading', latest: LATEST }).primary.label, 'Downloading…');
  const got = plan({ ...mac, status: 'ready', latest: LATEST, downloaded: true, blocked: 'INCOMING_SESSION' });
  assert.deepEqual(got.primary, { action: 'reveal', label: 'Show in Finder', enabled: true, busy: false });
  assert.equal(got.reveal, false, 'not twice');
  assert.equal(got.hint, '', 'no "install after the session" hint when it cannot be installed here at all');
  const gotText = describeUpdate(u({ ...mac, status: 'ready', latest: LATEST, downloaded: true }));
  assert.deepEqual([gotText.text, gotText.detail], ['Downloaded', `Tunnelview 0.3.0 is downloaded and verified. ${where.message}`]);
  assert.equal(plan({ ...mac, supported: false, status: 'available', latest: LATEST }).primary.action, 'releases', 'not supported wins');

  // MACFLOW-1: this Mac is too old for the downloaded version: nothing to install or show.
  const old = plan({ platform: 'macos', status: 'error', latest: LATEST, downloaded: true, error: { code: 'OS_TOO_OLD', message: 'x' } });
  assert.deepEqual([old.primary, old.reveal, old.releases], [null, false, true]);
});

test('settings › Updates: version, status, notes as text only, the daily check (locked in a session), Check now', async () => {
  const { setState, setSettings } = await load('main/store.js');
  const { createSettingsView } = await load('main/settings-view.js');
  const fake = await installUpdateApi();
  setState(clone(MAC_STATE));
  setSettings({});
  const notes = 'Faster reconnects.\n\n\t<img src=x onerror=alert(1)> stays text\nLast line';
  fake.push(updateState({ status: 'available', lastCheckAt: Date.now() - 5 * 60000, latest: { ...LATEST, notes } }));
  const view = createSettingsView();
  try {
    view.open('updates', { focusSection: true });
    const sheet = document.body.querySelectorAll('.sheet-layer').pop();
    const sec = updateSection(sheet);
    assert.ok(sec, 'Updates section');
    assert.ok(byText(sheet.querySelector('.sheet-nav'), 'Updates'), 'nav chip');
    assert.equal(document.activeElement, sec.querySelector('#set-updates-title'), 'the banner’s "View update" lands in the section');
    assert.equal(sec.querySelector('#set-updates-title').getAttribute('tabindex'), '-1');
    assert.match(sheet.textContent, /Remote sessions stay inside your tailnet; only updates come from GitHub/);
    assert.match(sheet.querySelector('#set-about').textContent, /The only connection outside your tailnet goes to GitHub, for updates/);

    assert.match(sec.textContent, /Tunnelview 0\.2\.0/);
    assert.match(sec.textContent, /Last checked 5 min ago/);
    assert.equal(statusText(sec), 'Update 0.3.0 available');
    assert.match(sec.textContent, /Download size: 100 MB\./);

    // Release notes: the exact text, no element made from it, scrollable by keyboard, labelled.
    const box = sec.querySelector('.update-notes');
    assert.equal(box.textContent, notes);
    assert.equal(box.children.length, 0, 'nothing in the notes became an element');
    assert.equal(box.getAttribute('tabindex'), '0');
    assert.equal(box.getAttribute('role'), 'region');
    assert.equal(sec.querySelector(`#${box.getAttribute('aria-labelledby')}`).textContent, 'What’s new in 0.3.0');
    assert.equal(sec.querySelector('.update-notes-head').textContent, 'What’s new in 0.3.0Released 2026-11-01');

    const live = sec.querySelector('[aria-live="polite"]');
    assert.ok(live && live.getAttribute('role') === 'status', 'status changes are announced');

    // The daily check: labelled, sent to main, shows what main stored.
    const auto = sec.querySelector('[aria-label="Check for updates automatically (contacts GitHub once a day)"]');
    assert.ok(auto);
    assert.equal(auto.checked, true);
    assert.match(sec.textContent, /Contacts GitHub once a day/);
    calls.length = 0;
    auto.checked = false;
    auto.dispatch('change');
    await sleep(5);
    assert.deepEqual(calls.filter((c) => c[0] === 'setAutoUpdateCheck'), [['setAutoUpdateCheck', false]]);
    assert.equal(auto.checked, false);

    // Locked while someone is connected to this computer (like the security settings).
    assert.ok(auto.hasAttribute('data-lock'));
    setState({ ...clone(MAC_STATE), host: { ...MAC_STATE.host, session: SESSION } });
    assert.equal(auto.disabled, true);
    assert.equal(sec.querySelector('.update-lock-hint').hidden, false);
    assert.equal(byText(sec, 'Check now').disabled, false, 'Check now stays available');
    assert.equal(primaryButton(sec).disabled, false, 'so does the download');
    setState(clone(MAC_STATE));
    assert.equal(auto.disabled, false);
    assert.equal(sec.querySelector('.update-lock-hint').hidden, true);

    // main refuses the change anyway: its words are shown and the toggle snaps back.
    api.setAutoUpdateCheck = async (v) => { calls.push(['setAutoUpdateCheck', v]); return { ok: false, code: 'SETTINGS_LOCKED', message: 'Disconnect the remote session to change security settings.' }; };
    auto.checked = true;
    auto.dispatch('change');
    await sleep(5);
    assert.equal(auto.checked, false);
    assert.ok(toasts().includes('Disconnect the remote session to change security settings.'), toasts().join(' | '));

    // Check now
    fake.push(updateState({ status: 'available', latest: { ...LATEST, notes } }));
    const checkBtn = byText(sec, 'Check now');
    checkBtn.focus();
    let answer;
    api.checkForUpdates = async () => {
      calls.push(['checkForUpdates']);
      fake.push(updateState({ status: 'checking', latest: { ...LATEST, notes } }));
      await new Promise((r) => { answer = r; });
      return updateState({ status: 'up-to-date', lastCheckAt: Date.now() });
    };
    calls.length = 0;
    checkBtn.click();
    await sleep(5);
    assert.equal(checkBtn.textContent, 'Checking…');
    assert.equal(checkBtn.getAttribute('aria-disabled'), 'true');
    assert.equal(document.activeElement, checkBtn, 'the focus stays on the busy button');
    assert.equal(live.textContent, 'Checking for updates…');
    checkBtn.click();
    answer();
    await sleep(5);
    assert.deepEqual(calls.map((c) => c[0]), ['checkForUpdates'], 'once');
    assert.equal(checkBtn.textContent, 'Check now');
    assert.equal(checkBtn.hasAttribute('aria-disabled'), false);
    assert.equal(statusText(sec), 'Up to date');
    assert.equal(live.textContent, 'Up to date');
    assert.equal(sec.querySelector('.update-notes-block').hidden, true);
    assert.equal(primaryButton(sec).hidden, true, 'nothing to download');
    assert.match(sec.textContent, /Last checked just now/);
  } finally {
    view.close();
    await removeUpdateApi();
  }
});

test('settings › Updates: Download and install shows progress, then asks; Cancel installs nothing, Restart and install does', async () => {
  const { setState, setSettings } = await load('main/store.js');
  const { createSettingsView } = await load('main/settings-view.js');
  await sleep(200); // earlier dialogs hand the focus back 160 ms after they close
  let release;
  const fake = await installUpdateApi({
    downloadUpdate: async () => {
      calls.push(['downloadUpdate']);
      fake.push(updateState({ status: 'downloading', latest: LATEST, progress: { received: 26214400, total: 104857600, percent: 25 } }));
      await new Promise((r) => { release = r; });
      fake.push(updateState({ status: 'ready', latest: LATEST, downloaded: true }));
      return { ok: true };
    },
  });
  setState(clone(MAC_STATE));
  setSettings({});
  fake.push(updateState({ status: 'available', latest: LATEST }));
  const view = createSettingsView();
  try {
    view.open('updates');
    const sec = updateSection(document.body.querySelectorAll('.sheet-layer').pop());
    const btn = primaryButton(sec);
    assert.equal(btn.textContent, 'Download and install');
    btn.focus();
    calls.length = 0;
    btn.click();
    await sleep(5);
    assert.deepEqual(calls.map((c) => c[0]), ['downloadUpdate']);
    assert.equal(statusText(sec), 'Downloading 25%');
    const bar = sec.querySelector('[role="progressbar"]');
    assert.equal(bar.hidden, false);
    assert.equal(bar.getAttribute('aria-valuenow'), '25');
    assert.equal(bar.getAttribute('aria-label'), 'Download progress');
    assert.equal(bar.querySelector('i').style.width, '25%');
    assert.equal(btn.textContent, 'Downloading…');
    assert.equal(btn.getAttribute('aria-disabled'), 'true');
    assert.equal(document.activeElement, btn, 'the focus stays on the busy button');
    btn.click();
    await sleep(5);
    assert.equal(calls.filter((c) => c[0] === 'downloadUpdate').length, 1, 'a busy button does nothing');
    assert.equal(sec.querySelector('[aria-live="polite"]').textContent, 'Downloading update 0.3.0…');

    // Verified: the confirmation, Windows wording, Cancel focused.
    release();
    await sleep(10);
    assert.equal(bar.hidden, true);
    let modal = topModal();
    assert.ok(modal.querySelector('.modal-update'));
    assert.match(modal.textContent, /Install Tunnelview 0\.3\.0\?/);
    assert.match(modal.textContent, /Windows will ask for permission \(UAC\)\. Tunnelview closes and reopens after the update\./);
    assert.match(modal.textContent, /Unknown publisher/);
    assert.doesNotMatch(modal.textContent, /Screen Recording/);
    assert.equal(document.activeElement, byText(modal, 'Cancel'), 'a stray Enter cancels');
    byText(modal, 'Cancel').click();
    await sleep(5);
    assert.equal(calls.some((c) => c[0] === 'installUpdate'), false, 'nothing installed');
    assert.equal(statusText(sec), 'Ready to install');
    assert.equal(btn.textContent, 'Restart and install');
    assert.equal(btn.disabled, false);
    await sleep(200);
    assert.equal(document.activeElement, btn, 'the focus comes back to the button');

    // Restart and install → confirm → update:install.
    btn.click();
    await sleep(5);
    modal = topModal();
    byText(modal.querySelector('.modal-foot'), 'Restart and install').click();
    await sleep(5);
    assert.deepEqual(calls.filter((c) => c[0] === 'installUpdate'), [['installUpdate']]);

    // A declined UAC prompt: main's words in the status line (no toast), and the file can be shown.
    await sleep(200);
    const declined = 'Update cancelled: administrator permission was not given.';
    api.installUpdate = async () => {
      calls.push(['installUpdate']);
      fake.push(updateState({ status: 'error', latest: LATEST, downloaded: true, error: { code: 'UAC_DECLINED', message: declined } }));
      return { ok: false, code: 'UAC_DECLINED', message: declined };
    };
    fake.push(updateState({ status: 'ready', latest: LATEST, downloaded: true }));
    btn.click();
    await sleep(5);
    byText(topModal().querySelector('.modal-foot'), 'Restart and install').click();
    await sleep(10);
    assert.equal(statusText(sec), declined);
    assert.ok(sec.querySelector('.update-status').classList.contains('is-danger'));
    assert.ok(!toasts().includes(declined), 'shown once, in the status line');
    assert.equal(btn.textContent, 'Restart and install', 'can be tried again');
    const reveal = byText(sec, 'Show in folder');
    assert.ok(reveal && !reveal.hidden);
    calls.length = 0;
    reveal.click();
    await sleep(5);
    assert.deepEqual(calls, [['revealUpdate']]);
  } finally {
    view.close();
    await removeUpdateApi();
    await sleep(200);
  }
});

test('settings › Updates: macOS warns about Screen Recording and Accessibility; Install waits during a session; refusals are explained', async () => {
  const { setState, setSettings } = await load('main/store.js');
  const { createSettingsView } = await load('main/settings-view.js');
  const fake = await installUpdateApi();
  setState(clone(MAC_STATE));
  setSettings({});
  fake.push(updateState({ platform: 'macos', status: 'ready', latest: LATEST, downloaded: true, blocked: 'OUTGOING_SESSION' }));
  const view = createSettingsView();
  try {
    view.open('updates');
    const sec = updateSection(document.body.querySelectorAll('.sheet-layer').pop());
    const btn = primaryButton(sec);
    assert.equal(btn.textContent, 'Restart and install');
    assert.equal(btn.disabled, true);
    const hint = sec.querySelector('#update-hint');
    assert.equal(hint.hidden, false);
    assert.equal(hint.textContent, 'You are connected to another device. Install the update after you disconnect.');
    assert.equal(btn.getAttribute('aria-describedby'), 'update-hint');
    calls.length = 0;
    btn.click();
    await sleep(5);
    assert.deepEqual(calls, [], 'disabled: nothing happens');

    fake.push(updateState({ platform: 'macos', status: 'ready', latest: LATEST, downloaded: true }));
    assert.equal(btn.disabled, false);
    assert.equal(hint.hidden, true);
    btn.click();
    await sleep(5);
    const modal = topModal();
    assert.match(modal.textContent, /Tunnelview quits, replaces itself with version 0\.3\.0 and opens again\./);
    assert.match(modal.textContent, /Allow Screen Recording and Accessibility again afterwards/);
    assert.match(modal.textContent, /ad-hoc signed/);
    assert.doesNotMatch(modal.textContent, /UAC/);

    // Someone asked to connect meanwhile: main refuses, says why, nothing changes.
    const refusal = 'Someone is asking to connect to this computer. Install the update after you answer.';
    api.installUpdate = async () => { calls.push(['installUpdate']); return { ok: false, code: 'INCOMING_REQUEST', message: refusal }; };
    byText(modal.querySelector('.modal-foot'), 'Restart and install').click();
    await sleep(10);
    assert.deepEqual(calls.map((c) => c[0]), ['installUpdate', 'getUpdateState']);
    assert.ok(toasts().includes(refusal), toasts().join(' | '));
    assert.equal(statusText(sec), 'Ready to install');
    assert.equal(byText(sec, 'Show in Finder').hidden, true);

    // The waiting phases have their own words.
    fake.push(updateState({ platform: 'macos', status: 'installing', phase: 'quitting', latest: LATEST, downloaded: true }));
    assert.equal(statusText(sec), 'Restarting Tunnelview…');
    assert.equal(btn.textContent, 'Installing…');
    assert.equal(byText(sec, 'Check now').disabled, true);
  } finally {
    view.close();
    await removeUpdateApi();
    await sleep(200);
  }
});

test('settings › Updates: a button that becomes unusable while it has the keyboard focus keeps it (aria-disabled) and does nothing', async () => {
  const { setState, setSettings } = await load('main/store.js');
  const { createSettingsView } = await load('main/settings-view.js');
  const fake = await installUpdateApi();
  setState(clone(MAC_STATE));
  setSettings({});
  const ready = updateState({ status: 'ready', latest: LATEST, downloaded: true });
  fake.push(ready);
  const view = createSettingsView();
  try {
    view.open('updates');
    const sec = updateSection(document.body.querySelectorAll('.sheet-layer').pop());
    const btn = primaryButton(sec);
    assert.equal(btn.textContent, 'Restart and install');
    btn.focus();
    // Someone asks to connect while Install has the focus: Chromium would move the focus of a
    // disabled control to <body>, out of the sheet.
    fake.push({ ...ready, blocked: 'INCOMING_REQUEST' });
    assert.equal(btn.disabled, false, 'not disabled while it has the focus');
    assert.equal(btn.getAttribute('aria-disabled'), 'true');
    assert.equal(btn.hasAttribute('data-busy'), false, 'unavailable, not busy: no progress cursor');
    assert.equal(document.activeElement, btn);
    assert.equal(sec.querySelector('#update-hint').hidden, false, 'the reason stays in view');
    calls.length = 0;
    btn.click();
    await sleep(5);
    assert.deepEqual(calls, [], 'a click does nothing');
    assert.equal(topModal() && topModal().querySelector('.modal-update'), null, 'no confirmation');
    // The request is answered: usable again.
    fake.push(ready);
    assert.equal(btn.hasAttribute('aria-disabled'), false);
    assert.equal(btn.disabled, false);
    // An automatic check starts while Install has the focus: the same.
    fake.push({ ...ready, status: 'checking' });
    assert.equal(btn.disabled, false);
    assert.equal(btn.getAttribute('aria-disabled'), 'true');
    assert.equal(byText(sec, 'Checking…').getAttribute('data-busy'), '', 'the busy Check now shows the progress cursor');
    fake.push(ready);
    // Without the focus, a button that cannot be used now is really disabled.
    btn.blur();
    fake.push({ ...ready, blocked: 'INCOMING_REQUEST' });
    assert.equal(btn.disabled, true);
    assert.equal(btn.hasAttribute('aria-disabled'), false);
  } finally {
    view.close();
    await removeUpdateApi();
    await sleep(200);
  }
});

test('settings › Updates: Cancel download stops it quietly; a copy that cannot replace itself here shows the file; a too-old Mac is offered nothing', async () => {
  const { setState, setSettings } = await load('main/store.js');
  const { createSettingsView } = await load('main/settings-view.js');
  await sleep(200);
  let finish;
  const fake = await installUpdateApi({
    downloadUpdate: async () => {
      calls.push(['downloadUpdate']);
      fake.push(updateState({ status: 'downloading', latest: LATEST, progress: { received: 0, total: 104857600, percent: 0 } }));
      return new Promise((r) => { finish = r; });
    },
    cancelUpdate: async () => {
      calls.push(['cancelUpdate']);
      // main: the running download ends with CANCELLED and the state goes back to "available".
      fake.push(updateState({ status: 'available', latest: LATEST }));
      finish({ ok: false, code: 'CANCELLED', message: 'Download cancelled.' });
      return { ok: true };
    },
  });
  setState(clone(MAC_STATE));
  setSettings({});
  fake.push(updateState({ status: 'available', latest: LATEST }));
  const view = createSettingsView();
  try {
    view.open('updates');
    const sec = updateSection(document.body.querySelectorAll('.sheet-layer').pop());
    const btn = primaryButton(sec);
    const cancel = byText(sec, 'Cancel download');
    assert.ok(cancel);
    assert.equal(cancel.hidden, true, 'nothing to cancel yet');
    btn.click();
    await sleep(5);
    assert.equal(statusText(sec), 'Downloading 0%');
    assert.equal(cancel.hidden, false);
    calls.length = 0;
    cancel.click();
    await sleep(10);
    assert.deepEqual(calls.filter((c) => c[0] === 'cancelUpdate'), [['cancelUpdate']]);
    assert.equal(statusText(sec), 'Update 0.3.0 available');
    assert.equal(cancel.hidden, true);
    assert.equal(btn.textContent, 'Download and install', 'can be started again');
    assert.ok(!toasts().includes('Download cancelled.'), 'the user’s own Cancel is not reported back');
    assert.equal(topModal() && topModal().querySelector('.modal-update'), null, 'no install confirmation');
    // A Cancel that comes too late (the download ended meanwhile) says nothing either.
    api.cancelUpdate = async () => { calls.push(['cancelUpdate']); return { ok: false, code: 'NOT_DOWNLOADING', message: 'No download is running.' }; };
    fake.push(updateState({ status: 'downloading', latest: LATEST }));
    cancel.click();
    await sleep(10);
    assert.ok(!toasts().includes('No download is running.'));

    // MACFLOW-4: verified, but this copy cannot replace itself where it runs.
    const where = { code: 'READ_ONLY_LOCATION', message: 'Tunnelview is running from a read-only place. Move it.' };
    fake.push(updateState({ platform: 'macos', status: 'ready', latest: LATEST, downloaded: true, installBlocked: where }));
    assert.equal(statusText(sec), 'Downloaded');
    assert.match(sec.textContent, /Tunnelview 0\.3\.0 is downloaded and verified\. Tunnelview is running from a read-only place\. Move it\./);
    assert.equal(btn.textContent, 'Show in Finder');
    assert.equal(buttons(sec).filter((b) => !b.hidden && b.textContent.trim() === 'Show in Finder').length, 1, 'shown once');
    calls.length = 0;
    btn.click();
    await sleep(5);
    assert.deepEqual(calls, [['revealUpdate']], 'shows the file, no install');

    // MACFLOW-1: the downloaded version needs a newer macOS.
    const tooOld = 'Tunnelview 0.3.0 needs macOS 13.0 or later. This Mac runs macOS 12.7.';
    fake.push(updateState({ platform: 'macos', status: 'error', latest: LATEST, downloaded: true, error: { code: 'OS_TOO_OLD', message: tooOld } }));
    assert.equal(statusText(sec), tooOld);
    assert.equal(btn.hidden, true, 'nothing to install or download');
    assert.equal(byText(sec, 'Show in Finder').hidden, true);
    assert.equal(byText(sec, 'Releases page').hidden, false);
  } finally {
    view.close();
    await removeUpdateApi();
    await sleep(200);
  }
});

test('settings › Updates: a copy that cannot update itself points to GitHub; without the updater API there is no section', async () => {
  const { setState, setSettings } = await load('main/store.js');
  const { createSettingsView } = await load('main/settings-view.js');
  const fake = await installUpdateApi();
  setState(clone(MAC_STATE));
  setSettings({});
  fake.push(updateState({ status: 'available', supported: false, latest: LATEST }));
  let view = createSettingsView();
  view.open('updates');
  const sec = updateSection(document.body.querySelectorAll('.sheet-layer').pop());
  const btn = primaryButton(sec);
  assert.equal(btn.textContent, 'Get 0.3.0 from GitHub');
  assert.equal(byText(sec, 'Releases page').hidden, true, 'one way to GitHub is enough');
  assert.match(sec.textContent, /This copy of Tunnelview cannot update itself\./);
  calls.length = 0;
  btn.click();
  await sleep(5);
  assert.deepEqual(calls, [['openReleasesPage']]);
  view.close();
  await removeUpdateApi();

  view = createSettingsView();
  view.open('updates');
  const sheet = document.body.querySelectorAll('.sheet-layer').pop();
  assert.equal(updateSection(sheet), null);
  assert.equal(byText(sheet.querySelector('.sheet-nav'), 'Updates'), null);
  assert.doesNotMatch(sheet.textContent, /GitHub/);
  view.close();
});

test('update banner: a newer version, "View update" opens Settings › Updates, dismissed for that version only', async () => {
  const { setState, setUpdateState, store } = await load('main/store.js');
  const { mountUpdateBanner } = await load('main/updates.js');
  setState(clone(MAC_STATE));
  store.update = null;
  const root = mount();
  const opened = [];
  let handedOn = 0;
  mountUpdateBanner(root, { openSettings: (s, o) => opened.push([s, o]), afterDismiss: () => { handedOn++; } });
  try {
    assert.equal(root.hidden, true);
    setUpdateState(updateState({ status: 'up-to-date' }));
    assert.equal(root.hidden, true);

    setUpdateState(updateState({ status: 'available', latest: LATEST }));
    assert.equal(root.hidden, false);
    const banner = root.querySelector('.update-banner');
    assert.equal(banner.getAttribute('role'), 'status');
    assert.equal(root.querySelector(`#${banner.getAttribute('aria-labelledby')}`).textContent, 'Tunnelview 0.3.0 is available');
    assert.match(root.textContent, /You have 0\.2\.0\./);
    byText(root, 'View update').click();
    assert.deepEqual(opened, [['updates', { focusSection: true }]]);

    setUpdateState(updateState({ status: 'downloading', latest: LATEST, progress: { received: 1, total: 2, percent: 50 } }));
    assert.match(root.textContent, /Downloading Tunnelview 0\.3\.0…/);
    assert.doesNotMatch(root.textContent, /%/, 'no per-percent changes in a live region');
    setUpdateState(updateState({ status: 'ready', latest: LATEST, downloaded: true }));
    assert.match(root.textContent, /Tunnelview 0\.3\.0 is ready to install/);

    // ✕: gone for 0.3.0 and the focus is handed on; back for 0.3.1.
    const x = root.querySelector('[aria-label="Dismiss: Tunnelview 0.3.0 is ready to install"]');
    assert.ok(x);
    x.focus();
    x.click();
    assert.equal(root.hidden, true);
    assert.equal(handedOn, 1);
    setUpdateState(updateState({ status: 'available', latest: LATEST }));
    assert.equal(root.hidden, true, 'still dismissed for 0.3.0');
    setUpdateState(updateState({ status: 'available', latest: { ...LATEST, version: '0.3.1' } }));
    assert.equal(root.hidden, false);
    assert.match(root.textContent, /Tunnelview 0\.3\.1 is available/);

    // Not while it installs (Tunnelview is about to quit).
    setUpdateState(updateState({ status: 'installing', phase: 'preparing', latest: { ...LATEST, version: '0.3.1' }, downloaded: true }));
    assert.equal(root.hidden, true);
  } finally {
    root.remove();
    store.update = null;
  }
});

test('update banner: after an in-app update macOS asks for the permissions again; an install that did not take is reported', async () => {
  const { setState, setUpdateState, store } = await load('main/store.js');
  const { mountUpdateBanner } = await load('main/updates.js');
  setState(clone(MAC_STATE)); // Screen Recording and Accessibility: denied
  store.update = null;
  const root = mount();
  const opened = [];
  mountUpdateBanner(root, { openSettings: (s, o) => opened.push([s, o]) });
  try {
    setUpdateState(updateState({ platform: 'macos', currentVersion: '0.3.0', justUpdated: { from: '0.2.0', to: '0.3.0' } }));
    assert.equal(root.hidden, false);
    assert.match(root.textContent, /Tunnelview was updated to 0\.3\.0/);
    assert.match(root.textContent, /macOS asks again for Screen Recording and Accessibility after every update/);
    assert.ok(root.querySelector('.banner-warn'));
    assert.equal(byText(root, 'View update'), null);
    setState({ ...clone(MAC_STATE), permissions: { screen: 'granted', accessibility: 'granted' } });
    assert.equal(root.hidden, true, 'both allowed again: nothing left to do');

    setUpdateState(updateState({ platform: 'windows', currentVersion: '0.3.0', justUpdated: { from: '0.2.0', to: '0.3.0' } }));
    assert.equal(root.hidden, false);
    assert.match(root.textContent, /Tunnelview was updated to 0\.3\.0/);
    assert.ok(root.querySelector('.banner-ok'));
    root.querySelector('[aria-label="Dismiss: Tunnelview was updated to 0.3.0"]').click();
    assert.equal(root.hidden, true);

    const msg = 'The update to 0.3.0 did not complete; Tunnelview 0.2.0 is still installed. Check for updates to try again.';
    setUpdateState(updateState({ status: 'error', error: { code: 'INSTALL_INCOMPLETE', message: msg } }));
    assert.match(root.textContent, /The update did not complete/);
    assert.ok(root.textContent.includes(msg));
    byText(root, 'Details').click();
    assert.deepEqual(opened, [['updates', { focusSection: true }]]);

    // MACFLOW-5: the app was still running for another user; reported like the other next-start failures.
    setUpdateState(updateState({ platform: 'macos', status: 'error', error: { code: 'MAC_APP_IN_USE', message: 'Tunnelview is open for another user.' } }));
    assert.match(root.textContent, /The update did not complete/);
    assert.ok(root.textContent.includes('Tunnelview is open for another user.'));
  } finally {
    root.remove();
    store.update = null;
  }
});

test('update banner: a too-old Mac gets no "available" banner; a copy that cannot replace itself here says so', async () => {
  const { normUpdateState } = await load('main/store.js');
  const { pickUpdateBanner } = await load('main/updates.js');
  const none = { version: '', justUpdated: '', failure: '' };
  const u = (patch) => normUpdateState(updateState(patch));
  const tooOld = u({ platform: 'macos', status: 'error', latest: LATEST, downloaded: true, error: { code: 'OS_TOO_OLD', message: 'x' } });
  assert.equal(pickUpdateBanner(tooOld, null, none), null, 'MACFLOW-1: nothing this Mac can install');
  const where = { code: 'TRANSLOCATED', message: 'Move Tunnelview with Finder into Applications.' };
  const got = pickUpdateBanner(u({ platform: 'macos', status: 'ready', latest: LATEST, downloaded: true, installBlocked: where }), null, none);
  assert.deepEqual([got.title, got.sub], ['Tunnelview 0.3.0 is downloaded', where.message]);
  const dl = pickUpdateBanner(u({ platform: 'macos', status: 'downloading', latest: LATEST, installBlocked: where }), null, none);
  assert.equal(dl.sub, where.message, 'not "It installs only after you confirm"');
  assert.equal(pickUpdateBanner(u({ status: 'ready', latest: LATEST, downloaded: true }), null, none).title, 'Tunnelview 0.3.0 is ready to install');
});

test('remote: the Tailscale banner no longer claims Tunnelview never goes outside the tailnet', async () => {
  const { setState } = await load('main/store.js');
  const { mountTsBanner } = await load('main/remote.js');
  const root = mount();
  setState({ ...clone(MAC_STATE), tailscale: { state: 'not-installed', message: '', self: null } });
  mountTsBanner(root);
  assert.match(root.textContent, /Tunnelview connects to other devices only inside a Tailscale network \(tailnet\), never over the open internet\./);
  assert.doesNotMatch(root.textContent, /it never connects over the open internet/);
  setState(clone(MAC_STATE));
  root.remove();
});

test('app.css: release notes keep their line breaks and scroll inside a capped height; busy buttons look disabled', () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'main', 'app.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'main', 'index.html'), 'utf8');
  const rule = (sel) => {
    const m = new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'm').exec(css);
    assert.ok(m, `no ${sel} rule`);
    return m[1].replace(/\s+/g, ' ');
  };
  const notes = rule('.update-notes');
  for (const decl of ['max-height: 200px', 'overflow-y: auto', 'white-space: pre-wrap', 'overflow-wrap: anywhere']) assert.ok(notes.includes(decl), `${decl} in .update-notes`);
  assert.match(rule('.btn[aria-disabled="true"]'), /opacity/);
  assert.match(rule('.sr-only'), /position: absolute/);
  assert.match(html, /<div class="update-banner-slot" id="update-banner" hidden><\/div>/);
});
