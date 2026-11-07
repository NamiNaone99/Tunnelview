'use strict';
/*
 * Tray / menu-bar icon.
 *
 *   tray.create({ onOpen, onToggleHost(enabled), onEndSession, onQuit })
 *   tray.update(appState)    // AppState (preload/main.js); rebuilds the menu only when it changed
 *   tray.destroy()
 *
 * Menu: status line (Tailscale + "Listening on <ip>:<port>" / "Incoming disabled"), Open Tunnelview,
 * "Accept incoming connections" checkbox (settings.hostEnabled), "End session with <name>" while a
 * host session is active, Quit. The icon switches to its 'active' variant during a host session.
 * AppState.host.warning (e.g. a Windows Firewall Block rule) adds a status line under the host line.
 */
const icons = require('./icons');

let electron = null;
const E = () => electron || (electron = require('electron'));

const TS_LABELS = {
  running: 'Connected',
  stopped: 'Stopped',
  'needs-login': 'Needs login',
  'not-installed': 'Not installed',
  error: 'Error',
};

let tray = null;
let handlers = {};
let lastMenuKey = null;
let lastIconState = null;
let lastTooltip = null;
let lastState = null;

const clip = (s, n = 60) => {
  const str = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

function describe(state) {
  const ts = (state && state.tailscale) || {};
  const host = (state && state.host) || {};
  const tsLine = `Tailscale: ${TS_LABELS[ts.state] || 'Unknown'}`;
  let hostLine;
  if (!host.enabled) hostLine = 'Incoming disabled';
  else if (host.listening && Array.isArray(host.addresses) && host.addresses.length) {
    const ip = host.addresses.find((a) => !String(a).includes(':')) || host.addresses[0];
    const shown = String(ip).includes(':') ? `[${ip}]` : ip;
    hostLine = `Listening on ${shown}:${host.port}`;
  } else hostLine = host.error ? `Not listening (${clip(host.error, 40)})` : 'Not listening';
  const session = host.session || null;
  const peerName = session && session.peer ? (session.peer.hostname || session.peer.ip || 'peer') : null;
  const warning = host.enabled && typeof host.warning === 'string' && host.warning ? host.warning : null;
  const warningLine = warning ? `⚠ ${clip(warning, 70)}` : null;
  return { tsLine, hostLine, warningLine, session, peerName, enabled: !!host.enabled, tsRunning: ts.state === 'running', listening: !!host.listening };
}

function iconState(d) {
  if (d.session) return 'active';
  if (!d.enabled || !d.tsRunning || !d.listening) return 'off';
  return 'idle';
}

function call(name, ...args) {
  const fn = handlers[name];
  if (typeof fn === 'function') {
    try { fn(...args); } catch (err) { console.error(`[tray] ${name} failed:`, err); }
  }
}

function create(opts = {}) {
  if (tray) return tray;
  handlers = opts;
  const { Tray } = E();
  tray = new Tray(icons.trayIcon('off'));
  lastIconState = 'off';
  tray.setToolTip('Tunnelview');
  if (process.platform !== 'darwin') {
    // Windows: left click opens the window, right click shows the menu (default behaviour).
    tray.on('click', () => call('onOpen'));
    // Taskbar light/dark switch → redraw with the matching glyph colour.
    try {
      E().nativeTheme.on('updated', () => {
        if (!tray || tray.isDestroyed() || !lastIconState) return;
        tray.setImage(icons.trayIcon(lastIconState));
      });
    } catch { /* ignore */ }
  }
  update(lastState);
  return tray;
}

function update(state) {
  lastState = state || lastState;
  if (!tray || tray.isDestroyed()) return;
  const { Menu } = E();
  const d = describe(lastState);

  const st = iconState(d);
  if (st !== lastIconState) {
    tray.setImage(icons.trayIcon(st));
    lastIconState = st;
  }
  // (Windows truncates tray tooltips at 127 chars, so the warning lives in the menu only.)
  const tooltip = d.session ? `Tunnelview — ${clip(d.peerName)} is connected`
    : `Tunnelview — ${d.hostLine}${d.warningLine ? ' ⚠' : ''}`;
  if (tooltip !== lastTooltip) {
    tray.setToolTip(tooltip);
    lastTooltip = tooltip;
  }

  const key = JSON.stringify([d.tsLine, d.hostLine, d.warningLine, d.enabled, d.peerName]);
  if (key === lastMenuKey) return;
  lastMenuKey = key;

  const template = [
    { label: d.tsLine, enabled: false },
    { label: d.hostLine, enabled: false },
    ...(d.warningLine ? [{ label: d.warningLine, enabled: false }] : []),
    { type: 'separator' },
    { label: 'Open Tunnelview', click: () => call('onOpen') },
    {
      label: 'Accept incoming connections',
      type: 'checkbox',
      checked: d.enabled,
      click: (item) => call('onToggleHost', !!item.checked),
    },
  ];
  if (d.session) {
    template.push({ type: 'separator' });
    template.push({ label: `End session with ${clip(d.peerName, 40)}`, click: () => call('onEndSession') });
  }
  template.push({ type: 'separator' });
  template.push({ label: 'Quit Tunnelview', click: () => call('onQuit') });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function destroy() {
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
  lastMenuKey = null;
  lastIconState = null;
  lastTooltip = null;
}

module.exports = { create, update, destroy, describe };
