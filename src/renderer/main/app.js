/*
 * Tunnelview — main window entry (This Desk / Remote Desk / tailnet devices / settings).
 * Talks to main only through window.tunnelview (src/preload/main.js).
 */
import { h, $, icon, applyTheme, toast } from '../shared/ui.js';
import {
  api, store, subscribe, setState, setSettings, refreshState, refreshSettings, scheduleSettingsRefresh,
  loadPeers, tsRunning, errMsg,
} from './store.js';
import { mountDesk } from './desk.js';
import { mountTsBanner, mountConnect, mountRecent } from './remote.js';
import { mountDevices } from './devices.js';
import { createSettingsView } from './settings-view.js';
import { hasLayer } from './dialogs.js';
import { warmRtcWhileHidden } from './rtc-warmup.js';

const PEER_REFRESH_MS = 30000;

if (!api) {
  // Opened outside Electron or the preload failed — say so instead of rendering a broken UI.
  document.body.replaceChildren(h('div', { class: 'fatal' },
    h('div', { class: 'fatal-icon' }, icon('alert', { size: 28 })),
    h('h1', null, 'Tunnelview couldn’t start'),
    h('p', { class: 'dim' }, 'The connection to the app’s background process is missing. Please quit Tunnelview and open it again.')));
} else {
  boot().catch((err) => {
    console.error('[Tunnelview] boot failed', err);
    toast(`Something went wrong while starting: ${errMsg(err)}`, { kind: 'danger', timeout: 0 });
  });
}

async function boot() {
  const settingsView = createSettingsView();

  mountHeader(settingsView);
  mountDesk($('#desk'), { openSettings: (section) => settingsView.open(section) });
  mountTsBanner($('#ts-banner'));
  const connect = mountConnect($('#connect'));
  mountRecent($('#recent'));
  const devices = mountDevices($('#devices'));

  // Theme follows settings.theme; platform drives a few CSS tweaks.
  subscribe('settings', () => applyTheme(store.settings.theme));
  subscribe('state', () => {
    if (store.state.platform) document.documentElement.dataset.platform = store.state.platform;
  });

  // Pushed state (register before the first fetch so no update is missed).
  let prevViewers = '';
  let prevRunning = false;
  api.onState((raw) => {
    setState(raw);
    const viewers = JSON.stringify(store.state.viewers.map((v) => v.id));
    if (viewers !== prevViewers) { prevViewers = viewers; scheduleSettingsRefresh(); } // new session → settings.recent changed
  });
  subscribe('state', () => {
    const running = tsRunning();
    if (running && !prevRunning) firstPeerLoad(); // Tailscale just came up (or first state)
    prevRunning = running;
  });

  const [st, se] = await Promise.allSettled([api.getState(), api.getSettings()]);
  if (se.status === 'fulfilled') setSettings(se.value);
  else toast(`Couldn't load settings: ${errMsg(se.reason)}`, { kind: 'danger', timeout: 8000 });
  if (st.status === 'fulfilled') setState(st.value);
  else toast(`Couldn't read the app state: ${errMsg(st.reason)}`, { kind: 'danger', timeout: 8000 });

  // Peers auto-refresh (with Tunnelview probe) while the window is visible.
  setInterval(() => {
    if (document.visibilityState === 'visible' && tsRunning()) loadPeers({ probe: true });
  }, PEER_REFRESH_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && tsRunning() && Date.now() - store.peers.updatedAt > PEER_REFRESH_MS) {
      loadPeers({ probe: true });
    }
  });

  // Coming back to the window (e.g. from System Settings after granting a macOS permission):
  // re-read state + settings so permission rows and recent sessions are current.
  let lastFocusRefresh = 0;
  window.addEventListener('focus', () => {
    if (Date.now() - lastFocusRefresh < 2000) return;
    lastFocusRefresh = Date.now();
    refreshState();
    refreshSettings();
  });

  // Keyboard shortcuts.
  window.addEventListener('keydown', (e) => {
    const mod = store.state.platform === 'macos' ? e.metaKey : e.ctrlKey;
    if (mod && !e.shiftKey && !e.altKey && e.key === ',') {
      e.preventDefault();
      settingsView.open();
    } else if (hasLayer()) {
      // shortcuts below only apply to the main view
    } else if (mod && !e.shiftKey && !e.altKey && (e.key === 'l' || e.key === 'L')) {
      e.preventDefault();
      connect.focus();
    } else if (mod && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      devices.focusSearch();
    } else if (e.key === 'F5' && !mod) {
      e.preventDefault();
      if (tsRunning()) loadPeers({ probe: true });
    }
  });

  if (!hasLayer()) connect.focus();

  // Hidden (tray / login item / hidden to tray later): pay WebRTC's one-time startup cost now,
  // not on the first incoming session's critical path. Never runs while the window is visible.
  warmRtcWhileHidden();
}

let firstLoadDone = false;
async function firstPeerLoad() {
  if (!firstLoadDone && store.peers.list === null) {
    firstLoadDone = true;
    await loadPeers(); // fast: straight from `tailscale status`
  }
  loadPeers({ probe: true }); // then ask each online device whether Tunnelview is running
}

function mountHeader(settingsView) {
  $('#brand').replaceChildren(
    h('span', { class: 'brand-mark' }, icon('logo', { size: 18 })),
    h('span', { class: 'wordmark' }, 'any', h('b', null, 'View')));

  const gear = $('#btn-settings');
  gear.replaceChildren(icon('settings', { size: 18 }));
  gear.addEventListener('click', () => settingsView.open());
  subscribe('state', () => {
    gear.title = `Settings (${store.state.platform === 'macos' ? '⌘,' : 'Ctrl+,'})`;
  });

  const pill = $('#ts-pill');
  let lastSig = '';
  const render = () => {
    const ts = store.state.tailscale;
    const self = ts.self;
    const sig = JSON.stringify([ts.state, ts.message, self && self.user, ts.magicDnsSuffix]);
    if (sig === lastSig) return;
    lastSig = sig;

    let tone = 'warn';
    let text;
    let suffix = '';
    switch (ts.state) {
      case 'running':
        tone = 'ok';
        text = self && (self.user.login || self.user.displayName)
          ? h('span', null, 'Connected as ', h('b', null, self.user.login || self.user.displayName))
          : 'Connected';
        suffix = ts.magicDnsSuffix;
        break;
      case 'stopped': text = 'Not running'; break;
      case 'needs-login': text = 'Needs login'; break;
      case 'not-installed': text = 'Not installed'; tone = 'danger'; break;
      case 'error': text = 'Error'; tone = 'danger'; break;
      default: text = 'Checking…'; tone = 'idle';
    }
    pill.className = `ts-pill is-${tone}`;
    pill.title = ts.state === 'running'
      ? `Tailscale is connected${suffix ? ` — tailnet ${suffix}` : ''}`
      : ts.message || 'Tailscale status';
    // (replaceChildren() would stringify a null, so optional parts are filtered out.)
    pill.replaceChildren(...[
      h('span', { class: `dot ${tone === 'ok' ? 'dot-ok' : tone === 'danger' ? 'dot-danger' : tone === 'warn' ? 'dot-warn' : ''}` }),
      h('span', { class: 'ts-pill-brand' }, 'Tailscale'),
      h('span', { class: 'ts-pill-text ellipsis' }, text),
      suffix ? h('span', { class: 'ts-pill-suffix ellipsis' }, `· ${suffix}`) : null,
    ].filter(Boolean));
  };
  subscribe('state', render);
  render();
}
