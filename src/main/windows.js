'use strict';
/*
 * BrowserWindow factories + registry — docs/ARCHITECTURE.md §3.
 *
 *   windows.createMain()                → BrowserWindow (singleton)
 *   windows.createViewer(ctx)           → BrowserWindow (one per outgoing session)
 *   windows.createPanel(ctx, {onClose, hidden}) → BrowserWindow (host session panel; onClose(event) may
 *                                         preventDefault; hidden = pre-created while the prompt shows,
 *                                         stays invisible until windows.revealPanel(win))
 *   windows.revealPanel(win)            show a hidden panel (as soon as its page is ready)
 *   windows.createPrompt(ctx)           → BrowserWindow (incoming request approval)
 *   windows.getEntry(x) / getKind(x)    x = WebContents | WebFrameMain | IpcMain(Invoke)Event
 *   windows.isOwnMainFrame(event)       sender is the main frame of a registered window, on its own page
 *   windows.isAllowedUrl(wc, url)       navigation guard helper
 *   windows.getMain(), windows.list(kind), windows.showMain(), windows.setPanelExpanded(win, bool)
 *   windows.sessionUiAt(hit) / windows.sessionUiFocused()   session-UI guards for
 *                                         input.setPointerGuard / setKeyGuard (§1.7)
 *
 * Registry: webContents.id → { kind, win, ctx, fileUrl, wcId }.
 * Every window: contextIsolation, sandbox, no nodeIntegration, webSecurity, no spellcheck,
 * preload ../preload/<kind>.js, renderer ../renderer/<kind>/index.html via loadFile().
 * Viewer + panel: setWebRTCUDPPortRange(RTC_UDP_MIN..MAX) right after creation (§1.8).
 * DevTools exist only in unpackaged runs (--dev opens them detached); packaged builds disable them.
 *
 * macOS Dock: never call app.dock.hide() — neither directly nor implicitly through
 * setVisibleOnAllWorkspaces(…, {visibleOnFullScreen:true}) without skipTransformProcessType, which
 * makes Electron TransformProcessType() Tunnelview into a UIElement app (no Dock icon, no Cmd+Tab
 * entry, no menu bar) and nothing would ever show it again. The session panel floats over other
 * apps' full-screen Spaces as a non-activating NSPanel (type 'panel') instead.
 */
const path = require('path');
const { pathToFileURL } = require('url');
const PROTOCOL = require('../shared/protocol');

let electron = null;
const E = () => electron || (electron = require('electron'));

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';
/** --dev is honoured only in unpackaged runs (security: no DevTools in shipped builds). */
const isDev = () => !E().app.isPackaged && process.argv.includes('--dev');

const BG = { dark: '#0f1115', light: '#f5f6f8' }; // theme.css --bg (dark / light)

const PANEL = { width: 360, compactHeight: 140, expandedHeight: 540, margin: 16 };

const registry = new Map(); // webContents.id → entry

function htmlPath(kind) {
  return path.join(__dirname, '..', 'renderer', kind, 'index.html');
}

function preloadPath(kind) {
  return path.join(__dirname, '..', 'preload', `${kind}.js`);
}

function themeBackground() {
  try { return E().nativeTheme.shouldUseDarkColors ? BG.dark : BG.light; } catch { return BG.dark; }
}

function windowIcon() {
  if (!IS_WIN) return undefined; // macOS uses the bundle icon; window icons are ignored there
  try {
    const img = require('./icons').appIcon();
    return img && !img.isEmpty() ? img : undefined;
  } catch {
    return undefined;
  }
}

function webPreferences(kind, extra = {}) {
  return {
    preload: preloadPath(kind),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    spellcheck: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    devTools: !E().app.isPackaged,
    ...extra,
  };
}

/* ------------------------------------------------------------------ registry */

function wcOf(x) {
  if (!x) return null;
  try {
    if (typeof x.isDestroyed === 'function' && typeof x.send === 'function' && typeof x.getURL === 'function') return x; // WebContents
    if (x.sender && typeof x.sender.send === 'function') return x.sender; // IPC event
    if (typeof x.routingId === 'number' && typeof x.processId === 'number') return E().webContents.fromFrame(x) || null; // WebFrameMain
  } catch { /* destroyed */ }
  return null;
}

function getEntry(x) {
  const wc = wcOf(x);
  if (!wc) return null;
  try {
    if (wc.isDestroyed()) return null;
    return registry.get(wc.id) || null;
  } catch {
    return null;
  }
}

function getKind(x) {
  const e = getEntry(x);
  return e ? e.kind : null;
}

function sameDoc(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.protocol === 'file:' && ub.protocol === 'file:' && decodeURIComponent(ua.pathname).toLowerCase() === decodeURIComponent(ub.pathname).toLowerCase();
  } catch {
    return false;
  }
}

/** Navigation is only allowed to the window's own renderer page. */
function isAllowedUrl(wc, url) {
  const e = getEntry(wc);
  return !!(e && typeof url === 'string' && sameDoc(url, e.fileUrl));
}

/**
 * True when an IPC event comes from the MAIN frame of a registered window that still shows its
 * own renderer page (not a sub-frame, not something it navigated to).
 */
function isOwnMainFrame(event) {
  const e = getEntry(event);
  if (!e) return false;
  const frame = event.senderFrame;
  if (!frame) return false;
  try {
    const main = event.sender.mainFrame;
    if (!main || frame.processId !== main.processId || frame.routingId !== main.routingId) return false;
    return sameDoc(frame.url, e.fileUrl);
  } catch {
    return false;
  }
}

function list(kind) {
  const out = [];
  for (const e of registry.values()) {
    if (kind && e.kind !== kind) continue;
    if (e.win.isDestroyed()) continue;
    out.push(e);
  }
  return out;
}

/* ------------------------------------------------------------------ session-UI guard (input) */

const SESSION_UI_KINDS = ['panel', 'prompt'];
const GUARD_MARGIN_DIP = 4; // window shadow / rounding at the edges (geometric fallback only)

/** The visible session panel(s) and approval prompt(s). */
function sessionUiWindows() {
  const out = [];
  for (const kind of SESSION_UI_KINDS) {
    for (const e of list(kind)) {
      try {
        if (e.win.isVisible() && !e.win.isMinimized()) out.push(e.win);
      } catch { /* destroyed meanwhile */ }
    }
  }
  return out;
}

/** A native modal of the session UI is up (Windows: the owner is disabled; macOS: a sheet is attached). */
function sessionUiModal(wins = sessionUiWindows()) {
  return wins.some((w) => {
    try { return w.isEnabled() === false; } catch { return false; }
  });
}

/** HWND of a BrowserWindow as BigInt (Windows); null elsewhere / unknown. */
function nativeHandle(win) {
  try {
    const b = win.getNativeWindowHandle();
    if (!Buffer.isBuffer(b)) return null;
    if (b.length >= 8) return b.readBigUInt64LE(0);
    if (b.length >= 4) return BigInt(b.readUInt32LE(0));
  } catch { /* destroyed */ }
  return null;
}

/**
 * input.setPointerGuard predicate: is a remote press at `hit` on the host's session UI?
 * hit.window (Windows): BigInt top-level owner HWND really under the point → exact, z-order aware
 * (flyouts and menus drawn above the panel stay clickable; the panel's own dialogs count as the
 * panel); null → nothing there. Otherwise (macOS, or the HWND is unknown) hit.dip is compared with
 * the windows' bounds plus a small margin — and while a native modal of the session UI is up (a
 * macOS sheet can reach outside those bounds), every press counts as guarded.
 */
function sessionUiAt(hit) {
  const wins = sessionUiWindows();
  if (!wins.length || !hit || typeof hit !== 'object') return false;
  if (typeof hit.window === 'bigint') return wins.some((w) => nativeHandle(w) === hit.window);
  if (hit.window === null) return false;
  if (sessionUiModal(wins)) return true;
  const p = hit.dip;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return false;
  return wins.some((w) => {
    const b = w.getBounds();
    return p.x >= b.x - GUARD_MARGIN_DIP && p.x < b.x + b.width + GUARD_MARGIN_DIP
      && p.y >= b.y - GUARD_MARGIN_DIP && p.y < b.y + b.height + GUARD_MARGIN_DIP;
  });
}

/**
 * input.setKeyGuard predicate: does the host's session panel or prompt have keyboard focus — or one
 * of their native modals (the "Send files…" chooser, the end-session question), which disable their
 * owner and leave no BrowserWindow focused?
 */
function sessionUiFocused() {
  if (sessionUiModal()) return true;
  let w = null;
  try { w = E().BrowserWindow.getFocusedWindow(); } catch { w = null; }
  if (!w) return false;
  try {
    if (w.isDestroyed()) return false;
    const e = registry.get(w.webContents.id);
    return !!e && SESSION_UI_KINDS.includes(e.kind);
  } catch {
    return false;
  }
}

function getMain() {
  const e = list('main')[0];
  return e ? e.win : null;
}

/* ------------------------------------------------------------------ factory */

function create(kind, options, ctx = {}) {
  const { BrowserWindow } = E();
  const win = new BrowserWindow(options);
  const wc = win.webContents;
  const wcId = wc.id;
  const fileUrl = pathToFileURL(htmlPath(kind)).href;
  const entry = { kind, win, ctx, fileUrl, wcId };
  registry.set(wcId, entry);
  let gone = false;
  win.on('closed', () => { gone = true; registry.delete(wcId); });

  if (kind === 'viewer' || kind === 'panel') {
    // Must happen before the renderer creates any RTCPeerConnection (ARCHITECTURE §1.8).
    try {
      wc.setWebRTCUDPPortRange({ min: PROTOCOL.RTC_UDP_MIN, max: PROTOCOL.RTC_UDP_MAX });
    } catch (err) {
      console.error(`[windows] setWebRTCUDPPortRange failed for ${kind}:`, err && err.message);
    }
  }

  wc.on('render-process-gone', (_e, details) => {
    console.error(`[windows] ${kind} renderer gone:`, details && details.reason);
  });

  win.loadFile(htmlPath(kind)).catch((err) => {
    // A window destroyed while its page was still loading (e.g. the hidden pre-created session
    // panel of a prompt declined / cancelled / timed out before it loaded) rejects with
    // ERR_FAILED (-2) / ERR_ABORTED (-3): expected, not a broken install. A live window's load
    // failure is still reported.
    let destroyed = gone;
    try { destroyed = destroyed || win.isDestroyed() || wc.isDestroyed(); } catch { destroyed = true; }
    if (destroyed) return;
    console.error(`[windows] failed to load ${kind} renderer:`, err && err.message);
  });
  if (isDev()) wc.once('did-finish-load', () => { try { wc.openDevTools({ mode: 'detach' }); } catch { /* ignore */ } });
  return win;
}

function createMain() {
  const existing = getMain();
  if (existing) return existing;
  return create('main', {
    width: 1040,
    height: 700,
    minWidth: 860,
    minHeight: 580,
    show: false,
    title: 'Tunnelview',
    backgroundColor: themeBackground(),
    icon: windowIcon(),
    autoHideMenuBar: true,
    webPreferences: webPreferences('main'),
  }, {});
}

function showMain() {
  const win = getMain() || createMain();
  const reveal = () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
  if (win.webContents.isLoading()) win.once('ready-to-show', reveal);
  else reveal();
  return win;
}

function createViewer(ctx) {
  // ctx.hostname is the Tailscale-verified name (ipc.js verifiedName), never the peer's self-report.
  const name = (ctx && typeof ctx.hostname === 'string' && ctx.hostname) || (ctx && ctx.target ? ctx.target.ip : '');
  const win = create('viewer', {
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 400,
    show: false,
    title: name ? `${name} — Tunnelview` : 'Tunnelview',
    backgroundColor: '#000000',
    icon: windowIcon(),
    autoHideMenuBar: true,
    fullscreenable: true,
    webPreferences: webPreferences('viewer'),
  }, ctx);
  win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
  const sendFs = (on) => { if (!win.isDestroyed()) win.webContents.send('viewer:fullscreen', on); };
  win.on('enter-full-screen', () => sendFs(true));
  win.on('leave-full-screen', () => sendFs(false));
  // The renderer sets a meaningful title; don't let <title> changes override it with nothing.
  win.on('page-title-updated', (e) => e.preventDefault());
  return win;
}

function panelBounds(expanded) {
  const { screen } = E();
  const wa = screen.getPrimaryDisplay().workArea;
  const height = expanded ? PANEL.expandedHeight : PANEL.compactHeight;
  return {
    x: Math.round(wa.x + wa.width - PANEL.width - PANEL.margin),
    y: Math.round(wa.y + wa.height - height - PANEL.margin),
    width: PANEL.width,
    height,
  };
}

function createPanel(ctx, { onClose, hidden = false } = {}) {
  const b = panelBounds(false);
  const win = create('panel', {
    ...b,
    // macOS: a non-activating NSPanel floats over other apps' full-screen Spaces without turning
    // Tunnelview into a UIElement app (see the Dock note at the top). It stays focusable for its buttons.
    ...(IS_MAC ? { type: 'panel' } : {}),
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    minimizable: true,
    closable: true,
    alwaysOnTop: true,
    skipTaskbar: false, // keep it reachable from the taskbar/dock when minimized
    title: 'Tunnelview session',
    backgroundColor: themeBackground(),
    icon: windowIcon(),
    hasShadow: true,
    webPreferences: webPreferences('panel', { backgroundThrottling: false }),
  }, ctx);
  if (IS_MAC) {
    win.setAlwaysOnTop(true, 'floating');
    // Visible on every Space and over full-screen apps: the host user must always see the session.
    // skipTransformProcessType: keep the Dock icon / menu bar (see the note at the top).
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); } catch { /* ignore */ }
  }
  win.on('close', (e) => { if (typeof onClose === 'function') onClose(e); });
  const entry = registry.get(win.webContents.id);
  entry.panel = { readyToShow: false, reveal: !hidden };
  // Show without stealing focus (unattended sessions should not disturb the local user's typing).
  win.once('ready-to-show', () => {
    entry.panel.readyToShow = true;
    if (entry.panel.reveal && !win.isDestroyed()) win.showInactive();
  });
  return win;
}

/** Show a panel created with {hidden:true} — now, or as soon as its page is ready. */
function revealPanel(win) {
  if (!win || win.isDestroyed()) return;
  const entry = registry.get(win.webContents.id);
  if (!entry || !entry.panel) { win.showInactive(); return; }
  entry.panel.reveal = true;
  if (entry.panel.readyToShow) win.showInactive();
}

/** Resize the panel between compact and expanded, keeping its bottom edge anchored. */
function setPanelExpanded(win, expanded) {
  if (!win || win.isDestroyed()) return;
  const { screen } = E();
  const cur = win.getBounds();
  const height = expanded ? PANEL.expandedHeight : PANEL.compactHeight;
  if (cur.height === height) return;
  const wa = screen.getDisplayMatching(cur).workArea;
  let y = cur.y + cur.height - height;
  y = Math.max(wa.y, Math.min(y, wa.y + wa.height - height));
  const x = Math.max(wa.x, Math.min(cur.x, wa.x + wa.width - PANEL.width));
  win.setBounds({ x, y, width: PANEL.width, height });
}

function createPrompt(ctx) {
  const win = create('prompt', {
    width: 440,
    height: 420,
    center: true,
    show: false,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    title: 'Incoming connection — Tunnelview',
    // macOS: a non-activating NSPanel (like the session panel) is the only kind of window that shows
    // over another app's full-screen Space without activating Tunnelview — the prompt is shown
    // inactive (below), so a regular window would stay invisible there. Clicking it still focuses it.
    ...(IS_MAC ? { type: 'panel' } : {}),
    backgroundColor: themeBackground(),
    icon: windowIcon(),
    webPreferences: webPreferences('prompt'),
  }, ctx);
  if (IS_MAC) {
    win.setAlwaysOnTop(true, 'floating');
    // Announced by notification + Dock bounce (index.js). skipTransformProcessType keeps Tunnelview
    // a regular app (see the Dock note at the top).
    try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); } catch { /* ignore */ }
  }
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    centerOnCursorDisplay(win);
    // Never take the keyboard from code: whatever the user is typing into (another app, a viewer
    // controlling another computer, chat) keeps it, so no keystroke meant for it can reach the
    // prompt. It appears on top and asks for attention (index.js: notification, taskbar flash /
    // Dock bounce). The user activates it: a click, the notification, or switching to it.
    win.showInactive();
    win.moveTop();
  });
  return win;
}

/** Centre a window on the display the mouse pointer is on (where the user most likely looks). */
function centerOnCursorDisplay(win) {
  try {
    const { screen } = E();
    const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const b = win.getBounds();
    win.setBounds({
      x: Math.round(wa.x + Math.max(0, wa.width - b.width) / 2),
      y: Math.round(wa.y + Math.max(0, wa.height - b.height) / 2),
      width: b.width,
      height: b.height,
    });
  } catch {
    try { win.center(); } catch { /* ignore */ }
  }
}

module.exports = {
  createMain,
  createViewer,
  createPanel,
  revealPanel,
  createPrompt,
  showMain,
  getMain,
  getEntry,
  getKind,
  isOwnMainFrame,
  sessionUiAt,
  sessionUiFocused,
  isAllowedUrl,
  list,
  setPanelExpanded,
  themeBackground,
  htmlPath,
};
