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
