/*
 * Tunnelview host panel — DOM view. Builds everything with ui.h(); every peer-provided string
 * (names, chat, file names, reasons) is inserted as a text node or attribute, never as HTML.
 *
 * Layout: compact header (360×140: LIVE + timer + path badge, who/where, permission toggles,
 * expand, Disconnect) and an expanded area (360×540 window) with Chat / Files / Connection tabs.
 */
import { h, icon, osIcon, formatBytes, formatDuration } from '../shared/ui.js';

const P = globalThis.TunnelviewProtocol;
const F = P.FILE;
const MAX_CHAT_LOG = 500;
const TERMINAL = new Set(['done', 'rejected', 'error', 'cancelled']);

const OS_LABEL = { windows: 'Windows', macos: 'macOS', linux: 'Linux', ios: 'iOS', android: 'Android', other: 'Unknown OS' };
const VIA_LABEL = {
  password: 'Unattended-access password',
  prompt: 'Accepted by you',
  trusted: 'Trusted device (auto-accepted)',
  'same-user': 'Same Tailscale user (auto-accepted)',
  self: 'This computer (self-connection)',
};
const QUALITY_LABEL = { quality: 'Best quality', balanced: 'Balanced', speed: 'Fast response' };
const LIMIT_LABEL = { none: 'None', cpu: 'CPU', bandwidth: 'Bandwidth', other: 'Other' };
const PHASE = {
  starting: { text: 'Starting', cls: 'pending' },
  capturing: { text: 'Starting', cls: 'pending' },
  connecting: { text: 'Connecting', cls: 'pending' },
  live: { text: 'LIVE', cls: 'on' },
  reconnecting: { text: 'Reconnecting', cls: 'pending' },
  ended: { text: 'Ended', cls: 'off' },
};
const END_TEXT = {
  'host-ended': 'You ended the session.',
  'non-tailnet-path': 'Stopped: the connection was not on your Tailscale network.',
  'connection-failed': 'The connection failed.',
  'connection-lost': 'The connection was lost.',
  'connection-timeout': 'The connection could not be established.',
  'negotiation-failed': 'The connection could not be established.',
  'setup-failed': 'The session could not be started.',
  'capture-failed': 'Screen capture failed.',
  'capture-ended': 'Screen capture stopped.',
  'capture-blocked': 'macOS is waiting for someone at this Mac to allow screen recording.',
  'media-failed': 'Streaming failed.',
  'panel-closed': 'The session panel was closed.',
  network: 'The network connection was lost.',
  timeout: 'The connection timed out.',
};
// Reasons the VIEWER detected and main forwarded (panel:ended). Some share a name with a reason
// this panel raises itself (non-tailnet-path, media-failed), so they are looked up only for those.
const PEER_END_TEXT = {
  'non-tailnet-path': (name) => `${name}'s viewer stopped the session: the video path left your Tailscale network.`,
  'media-timeout': (name) => `The video never reached ${name}. Check that Tailscale ACLs allow UDP ${P.RTC_UDP_MIN}–${P.RTC_UDP_MAX}.`,
  'media-failed': (name) => `${name} couldn't open the video connection.`,
};
const INPUT_BLOCKED_TEXT = 'An administrator window or secure screen is in front — remote input can\'t reach it.';

/** Text for the end-of-session row. byPeer = the reason came from main (e.g. the viewer's bye). */
export function endText(reason, name, byPeer = false) {
  const entry = (byPeer && PEER_END_TEXT[reason]) || END_TEXT[reason] || PEER_END_TEXT[reason];
  if (entry) return typeof entry === 'function' ? entry(name) : entry;
  return /viewer|peer|bye|left/i.test(reason || '') ? `${name} disconnected.` : 'Session ended.';
}
const PERMS = [
  { key: 'control', icon: 'mouse', label: 'Keyboard & mouse control' },
  { key: 'clipboard', icon: 'clipboard', label: 'Clipboard sync' },
  { key: 'files', icon: 'file', label: 'File transfer' },
  { key: 'audio', icon: 'volume', iconOff: 'volume-off', label: 'Computer sound' },
];
const INPUT_REASON = {
  'accessibility-permission': 'macOS Accessibility permission is missing, so the remote user can only watch. Open System Settings › Privacy & Security › Accessibility, turn on Tunnelview, then press Re-check.',
  'unsupported-platform': 'Remote keyboard and mouse are not supported on this platform.',
};

// C0/C1 controls, zero-width chars, LRM/RLM/ALM, bidi embeddings/overrides/isolates, BOM: a
// tailnet user's display name or hostname must not be able to visually spoof another name.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f​‌‎‏؜‪-‮⁦-⁩﻿]/g;

/** Untrusted string → bounded plain text for display (always used as a text node / attribute). */
export function cleanText(value, max = 120) {
  const s = typeof value === 'string' ? value.replace(UNSAFE_TEXT_RE, '').trim() : '';
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function peerDisplayName(init) {
  if (init.peer.isSelf) return 'You (this computer)';
  const u = init.peer.user || {};
  return cleanText(u.displayName, 80) || cleanText(u.login, 80) || cleanText(init.peer.hostname, 80) || init.peer.ip || 'Remote user';
}

function formatBitrate(kbps) {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
}

function reasonText(reason) {
  return typeof reason === 'string' && reason ? reason.replace(/[-_]+/g, ' ') : 'unknown';
}

export class PanelView {
  /**
   * @param {HTMLElement} root
   * @param {object} init normalized PanelInit
   * @param {object} handlers onTogglePermission(key), onExpand(bool), onMinimize(), onDisconnect(),
   *   onSendChat(text) → bool, onSendFiles(File[]), onCancelTransfer(id), onReveal(id),
   *   onOpenFolder(), onRecheckInput(), onClose()
   */
  constructor(root, init, handlers) {
    this.root = root;
    this.init = init;
    this.handlers = handlers;
    this.name = peerDisplayName(init);
    this.phase = 'starting';
    this.expanded = false;
    this.tab = 'chat';
    this.unread = 0;
    this.endedAt = null;
    this.perms = { ...init.permissions };
    this.input = { ...init.input };
    this.audioSupported = !!init.audioSupported;
    this.xfers = new Map(); // id → row state
    this.el = {};
    root.replaceChildren(this._build());
    this.root.classList.add('ready');
    this.setPhase('starting');
    this.setPermissions(this.perms);
    this._tick();
    this._clock = setInterval(() => this._tick(), 1000);
  }

  /* ================================ build ================================ */

  _build() {
    const { init } = this;
    const e = this.el;

    // ---- compact header (whole area is a window drag region; buttons are no-drag via theme.css)
    e.live = h('span', { class: 'live pending', role: 'status' }, h('span', { class: 'live-dot' }), e.liveText = h('span', null, 'Starting'));
    e.timer = h('span', { class: 'timer mono', title: 'Session duration' }, '00:00');
    e.pathBadge = h('span', { class: 'path-badge', title: 'Checking that the connection stays on your tailnet…' },
      icon('shield', { size: 12 }), h('span', null, 'Tailscale'));
    e.inputWarn = h('button', {
      class: 'btn btn-ghost btn-xs btn-icon warn-btn', type: 'button', hidden: true,
      title: 'Remote control is not available on this computer — details',
      'aria-label': 'Remote control unavailable — show details',
      onClick: () => this._openTab('connection'),
    }, icon('alert', { size: 14 }));
    e.minimize = h('button', {
      class: 'btn btn-ghost btn-xs btn-icon', type: 'button', title: 'Minimize', 'aria-label': 'Minimize',
      onClick: () => this.handlers.onMinimize(),
    }, icon('minimize', { size: 14 }));
    const topbar = h('div', { class: 'topbar' }, e.live, e.timer, e.pathBadge, h('span', { class: 'spacer' }), e.inputWarn, e.minimize);

    const hostLine = `${cleanText(init.peer.hostname, 64) || cleanText(init.viewer.hostname, 64) || 'unknown device'} · `;
    e.verb = h('span', null, ' is connecting…');
    e.title = h('div', { class: 'ident-title ellipsis' }, h('strong', null, this.name), e.verb);
    e.title.title = this.name;
    e.sub = h('div', { class: 'ident-sub ellipsis' }, hostLine, h('span', { class: 'mono' }, init.peer.ip || '—'));
    // Replaces the host line while injected input cannot reach the foreground window.
    e.blockedNote = h('div', { class: 'ident-sub ident-blocked ellipsis', role: 'status', hidden: true, title: INPUT_BLOCKED_TEXT },
      icon('alert', { size: 12 }), h('span', null, INPUT_BLOCKED_TEXT));
    const avatar = h('span', { class: 'avatar', title: OS_LABEL[init.peer.os] || OS_LABEL.other }, osIcon(init.peer.os));
    const ident = h('div', { class: 'ident' }, avatar, h('div', { class: 'ident-text' }, e.title, e.sub, e.blockedNote));

    e.perm = {};
    const permButtons = PERMS.filter((p) => p.key !== 'audio' || this.audioSupported).map((p) => {
      const btn = h('button', {
        class: `btn btn-sm btn-icon perm${p.iconOff ? ' swap-icon' : ''}`, type: 'button', 'aria-pressed': 'false',
        onClick: () => this.handlers.onTogglePermission(p.key),
      }, icon(p.icon));
      e.perm[p.key] = btn;
      return btn;
    });
    e.unreadDot = h('span', { class: 'unread-dot', hidden: true });
    e.expand = h('button', {
      class: 'btn btn-ghost btn-sm btn-icon expand-btn', type: 'button',
      title: 'Show chat, files and connection details', 'aria-label': 'Expand', 'aria-expanded': 'false',
      onClick: () => this.setExpanded(!this.expanded),
    }, icon('chevron-down'), e.unreadDot);
    e.disconnect = h('button', {
      class: 'btn btn-danger btn-sm disconnect', type: 'button', title: 'End this session now',
      onClick: () => this.handlers.onDisconnect(),
    }, icon('power'), 'Disconnect');
    e.actions = h('div', { class: 'actions' }, ...permButtons, h('span', { class: 'spacer' }), e.expand, e.disconnect);

    e.endedText = h('span', { class: 'ended-text ellipsis' }, 'Session ended');
    e.endedRow = h('div', { class: 'ended-row', hidden: true },
      icon('info', { size: 14 }), e.endedText, h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm', type: 'button', onClick: () => this.handlers.onClose() }, 'Close'));

    const compact = h('header', { class: 'compact drag' }, topbar, ident, e.actions, e.endedRow);

    // ---- expanded area
    e.tabs = {};
    e.chatCount = h('span', { class: 'tab-count', hidden: true }, '0');
    const tabDefs = [
      ['chat', 'chat', 'Chat', e.chatCount],
      ['files', 'folder', 'Files', null],
      ['connection', 'shield', 'Connection', null],
    ];
    const tabButtons = tabDefs.map(([key, ic, label, extra]) => {
      const b = h('button', {
        type: 'button', role: 'tab', 'aria-selected': 'false', id: `tab-${key}`, 'aria-controls': `pane-${key}`,
        onClick: () => this.setTab(key),
      }, icon(ic, { size: 14 }), label, extra);
      e.tabs[key] = b;
      return b;
    });
    const tabbar = h('div', { class: 'tabbar' }, h('div', { class: 'segmented', role: 'tablist' }, ...tabButtons));

    e.panes = {
      chat: this._buildChat(),
      files: this._buildFiles(),
      connection: this._buildConnection(),
    };
    for (const [key, pane] of Object.entries(e.panes)) {
      pane.id = `pane-${key}`;
      pane.setAttribute('role', 'tabpanel');
      pane.setAttribute('aria-labelledby', `tab-${key}`);
    }
    e.expanded = h('section', { class: 'expanded', hidden: true }, tabbar, e.panes.chat, e.panes.files, e.panes.connection);
    this._renderTabs();

    return h('div', { class: 'panel-root' }, compact, e.expanded);
  }

  _buildChat() {
    const e = this.el;
    e.chatEmpty = h('div', { class: 'empty small' }, icon('chat', { size: 20 }),
      `Messages you send appear on ${this.name}'s screen.`);
    e.chatLog = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite' }, e.chatEmpty);
    e.chatInput = h('input', {
      class: 'input', type: 'text', maxlength: String(P.CONTROL.MAX_CHAT), placeholder: 'Type a message…',
      autocomplete: 'off', 'aria-label': 'Chat message',
    });
    e.chatSend = h('button', { class: 'btn btn-primary btn-icon', type: 'submit', title: 'Send', 'aria-label': 'Send message' }, icon('send'));
    const form = h('form', { class: 'chat-form' }, e.chatInput, e.chatSend);
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const text = e.chatInput.value;
      if (!text.trim()) return;
      if (this.handlers.onSendChat(text)) e.chatInput.value = '';
    });
    return h('div', { class: 'pane pane-chat' }, e.chatLog, form);
  }

  _buildFiles() {
    const e = this.el;
    e.fileInput = h('input', { type: 'file', multiple: true, hidden: true });
    e.fileInput.addEventListener('change', () => {
      const files = Array.from(e.fileInput.files || []);
      e.fileInput.value = '';
      if (files.length) this.handlers.onSendFiles(files);
    });
    e.sendFiles = h('button', { class: 'btn btn-sm', type: 'button', onClick: () => e.fileInput.click() }, icon('upload'), 'Send files…');
    const openFolder = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => this.handlers.onOpenFolder() },
      icon('folder'), 'Received files');
    e.filesOff = h('div', { class: 'banner banner-warn small', hidden: true }, icon('lock'),
      h('div', null, 'File transfer is turned off for this session. Use the file button above to allow it.'));
    e.drop = h('div', { class: 'dropzone small' }, icon('download', { size: 18 }), h('span', null, `Drop files here to send them to ${this.name}`));
    e.xferEmpty = h('div', { class: 'faint small xfer-empty' }, 'No transfers yet.');
    e.xferList = h('div', { class: 'xfer-list', role: 'list' }, e.xferEmpty);

    const pane = h('div', { class: 'pane pane-files' },
      h('div', { class: 'row' }, e.sendFiles, h('span', { class: 'spacer' }), openFolder), e.fileInput, e.filesOff, e.drop, e.xferList);

    let depth = 0;
    const hasFiles = (ev) => !!ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
    pane.addEventListener('dragenter', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth++;
      e.drop.classList.add('over');
    });
    pane.addEventListener('dragover', (ev) => {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = this.perms.files && this.phase !== 'ended' ? 'copy' : 'none';
    });
    pane.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) e.drop.classList.remove('over');
    });
    pane.addEventListener('drop', (ev) => {
      ev.preventDefault();
      depth = 0;
      e.drop.classList.remove('over');
      const dt = ev.dataTransfer;
      if (!dt) return;
      const files = [];
      let folders = 0;
      const items = Array.from(dt.items || []);
      if (items.length) {
        for (const it of items) {
          if (it.kind !== 'file') continue;
          const entry = typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
          if (entry && entry.isDirectory) { folders++; continue; }
          const f = it.getAsFile();
          if (f) files.push(f);
        }
      } else {
        files.push(...Array.from(dt.files || []));
      }
      if (folders) this.handlers.onNotice?.('Folders cannot be sent — drop the files inside instead.');
      if (files.length) this.handlers.onSendFiles(files);
    });
    return pane;
  }

  _buildConnection() {
    const e = this.el;
    const c = (e.conn = {});
    const kv = (label, key, initial = '—') => {
      c[key] = h('dd', { class: 'ellipsis' }, initial);
      return [h('dt', null, label), c[key]];
    };
    const { init } = this;
    const login = cleanText(init.peer.user && init.peer.user.login, 80);
    const display = cleanText(init.peer.user && init.peer.user.displayName, 80);

    c.pathIcon = h('span', { class: 'path-icon' }, icon('shield', { size: 18 }));
    c.pathTitle = h('div', { class: 'strong' }, 'Verifying the Tailscale path…');
    c.pathDetail = h('div', { class: 'small dim mono ellipsis' }, 'Only Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48) candidates are used.');
    c.pathCard = h('div', { class: 'banner path-card' }, c.pathIcon, h('div', { class: 'grow' }, c.pathTitle, c.pathDetail));

    c.inputText = h('div', { class: 'small' }, '');
    c.inputCard = h('div', { class: 'banner banner-warn', hidden: true }, icon('alert', { size: 16 }),
      h('div', { class: 'grow col gap-4' }, h('div', { class: 'strong' }, 'Remote control unavailable'), c.inputText,
        h('div', null, h('button', { class: 'btn btn-sm', type: 'button', onClick: () => this.handlers.onRecheckInput() },
          icon('refresh'), 'Re-check'))));
    c.blockedCard = h('div', { class: 'banner banner-warn', hidden: true }, icon('alert', { size: 16 }),
      h('div', { class: 'grow col gap-4' }, h('div', { class: 'strong' }, 'Remote input is blocked'),
        h('div', { class: 'small' }, INPUT_BLOCKED_TEXT)));

    const peerSection = h('dl', { class: 'kv' },
      ...kv('User', 'user', login && display && login !== display ? `${display} (${login})` : (display || login || '—')),
      ...kv('Device', 'device', `${cleanText(init.peer.hostname, 64) || '—'} · ${OS_LABEL[init.peer.os] || OS_LABEL.other}`),
      ...kv('Tailscale IP', 'ip', init.peer.ip || '—'),
      ...kv('Accepted via', 'via', VIA_LABEL[init.via] || reasonText(init.via)),
      ...kv('Tunnelview', 'version', cleanText(init.viewer.version, 32) ? `v${cleanText(init.viewer.version, 32)}` : '—'));
    c.user.title = c.user.textContent;
    c.device.title = c.device.textContent;
    c.ip.classList.add('mono');

    const streamSection = h('dl', { class: 'kv' },
      ...kv('Display', 'display'),
      ...kv('Codec', 'codec'),
      ...kv('Resolution', 'resolution'),
      ...kv('Frame rate', 'fps'),
      ...kv('Bitrate', 'bitrate'),
      ...kv('Round trip', 'rtt'),
      ...kv('Packet loss', 'loss'),
      ...kv('Limited by', 'limit'),
      ...kv('Quality', 'quality', QUALITY_LABEL[init.settings.quality] || '—'),
      ...kv('Sound', 'audio'),
      ...kv('Input', 'input'));

    return h('div', { class: 'pane pane-connection' },
      c.pathCard, c.inputCard, c.blockedCard,
      h('div', { class: 'label' }, 'Remote'), peerSection,
      h('div', { class: 'label' }, 'Stream'), streamSection);
  }

  /* ================================ state → DOM ================================ */

  setPhase(phase) {
    this.phase = phase;
    const p = PHASE[phase] || PHASE.starting;
    this.el.live.className = `live ${p.cls}`;
    this.el.liveText.textContent = p.text;
    this._renderTitle();
  }

  setPermissions(perms) {
    this.perms = { ...perms };
    for (const def of PERMS) {
      const btn = this.el.perm[def.key];
      if (!btn) continue;
      const on = !!perms[def.key];
      btn.classList.toggle('active', on);
      btn.classList.toggle('off', !on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      const label = `${def.label}: ${on ? 'allowed — click to block' : 'blocked — click to allow'}`;
      btn.title = label;
      btn.setAttribute('aria-label', label);
      if (def.iconOff) btn.replaceChildren(icon(on ? def.icon : def.iconOff));
    }
    const filesOn = !!perms.files && this.phase !== 'ended';
    this.el.filesOff.hidden = !!perms.files || this.phase === 'ended';
    this.el.sendFiles.disabled = !filesOn;
    this.el.drop.classList.toggle('disabled', !filesOn);
    this._renderTitle();
    this._renderInput();
  }

  setPermissionBusy(key, busy) {
    const btn = this.el.perm[key];
    if (btn) btn.disabled = !!busy || this.phase === 'ended';
  }

  /** status = {available, reason, blocked: null|'secure-desktop'|'elevated-window'} */
  setInputStatus(status) {
    this.input = { available: !!status.available, reason: status.reason || null, blocked: status.blocked || null };
    this._renderTitle();
    this._renderInput();
  }

  _renderTitle() {
    let verb;
    if (this.phase === 'ended') verb = ' was connected to this computer';
    else if (this.phase === 'starting' || this.phase === 'capturing' || this.phase === 'connecting') verb = ' is connecting…';
    else verb = this.perms.control && this.input.available ? ' is controlling this computer' : ' is viewing this computer';
    this.el.verb.textContent = verb;
    this.el.title.title = `${this.name}${verb}`;
  }

  _renderInput() {
    const c = this.el.conn;
    const blocked = !this.input.available;
    this.el.inputWarn.hidden = !(blocked && this.perms.control && this.phase !== 'ended');
    c.inputCard.hidden = !blocked || this.phase === 'ended';
    c.inputText.textContent = INPUT_REASON[this.input.reason] || `Remote keyboard and mouse are unavailable (${reasonText(this.input.reason)}).`;
    const fgBlocked = !blocked && !!this.perms.control && !!this.input.blocked && this.phase !== 'ended';
    c.blockedCard.hidden = !fgBlocked;
    this.el.blockedNote.hidden = !fgBlocked;
    this.el.sub.hidden = fgBlocked;
    if (!this.perms.control) c.input.textContent = 'View only (control blocked by you)';
    else if (blocked) c.input.textContent = 'Unavailable on this computer';
    else c.input.textContent = fgBlocked ? 'Blocked by an administrator window or secure screen' : 'Keyboard & mouse allowed';
  }

  setExpanded(expanded) {
    if (this.expanded === !!expanded) return;
    this.expanded = !!expanded;
    this.el.expanded.hidden = !this.expanded;
    this.root.classList.toggle('is-expanded', this.expanded);
    this.el.expand.setAttribute('aria-expanded', this.expanded ? 'true' : 'false');
    this.el.expand.title = this.expanded ? 'Hide details' : 'Show chat, files and connection details';
    this.handlers.onExpand(this.expanded);
    if (this.expanded && this.tab === 'chat') this._clearUnread();
    if (this.expanded && this.tab === 'chat' && this.phase !== 'ended') setTimeout(() => this.el.chatInput.focus(), 0);
  }

  setTab(tab) {
    if (!this.el.panes[tab]) return;
    this.tab = tab;
    this._renderTabs();
    if (tab === 'chat') {
      this._clearUnread();
      if (this.phase !== 'ended') this.el.chatInput.focus();
    }
  }

  _openTab(tab) {
    this.setTab(tab);
    this.setExpanded(true);
  }

  _renderTabs() {
    for (const [key, btn] of Object.entries(this.el.tabs)) {
      const on = key === this.tab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
      this.el.panes[key].hidden = !on;
    }
  }

  _clearUnread() {
    this.unread = 0;
    this._renderUnread();
  }

  _renderUnread() {
    this.el.unreadDot.hidden = this.unread === 0;
    this.el.chatCount.hidden = this.unread === 0;
    this.el.chatCount.textContent = this.unread > 99 ? '99+' : String(this.unread);
  }

  _tick() {
    const start = this.init.startedAt;
    const end = this.endedAt || Date.now();
    this.el.timer.textContent = formatDuration(Math.max(0, end - start));
  }

  /* ---------------- chat ---------------- */

  addChat(msg) {
    const mine = msg.from === 'me';
    const time = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const el = h('div', { class: `msg ${mine ? 'me' : 'peer'}` },
      h('div', { class: 'bubble' }, msg.text),
      h('div', { class: 'meta' }, `${mine ? 'You' : this.name} · ${time}`));
    const log = this.el.chatLog;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    this.el.chatEmpty.hidden = true;
    log.append(el);
    let count = log.querySelectorAll('.msg').length;
    while (count-- > MAX_CHAT_LOG) {
      const oldest = log.querySelector('.msg');
      if (oldest) oldest.remove();
    }
    if (mine || nearBottom) log.scrollTop = log.scrollHeight;
    if (!mine && !(this.expanded && this.tab === 'chat')) {
      this.unread++;
      this._renderUnread();
    }
  }

  /* ---------------- connection ---------------- */

  setPath(r) {
    const c = this.el.conn;
    const badge = this.el.pathBadge;
    c.pathCard.classList.remove('banner-ok', 'banner-danger', 'banner-warn');
    badge.classList.remove('ok', 'bad');
    if (r.status === 'ok') {
      c.pathCard.classList.add('banner-ok');
      c.pathTitle.textContent = 'Verified Tailscale path ✓';
      const proto = r.protocol ? ` (${String(r.protocol).toUpperCase()})` : '';
      c.pathDetail.textContent = `${r.local || 'this computer'} ↔ ${r.remote || 'peer'}${proto}`;
      badge.classList.add('ok');
      badge.title = `Verified: the session runs over your tailnet${r.local && r.remote ? ` (${r.local} ↔ ${r.remote})` : ''}`;
    } else if (r.status === 'unverified') {
      c.pathCard.classList.add('banner-warn');
      c.pathTitle.textContent = 'Tailscale-only candidates';
      c.pathDetail.textContent = 'All ICE candidates were Tailscale addresses; the selected pair was not reported.';
      badge.title = 'Only Tailscale addresses were offered; the selected pair was not reported';
    } else if (r.status === 'failed') {
      c.pathCard.classList.add('banner-danger');
      c.pathTitle.textContent = 'Connection left the tailnet — stopped';
      c.pathDetail.textContent = `${r.local || '?'} ↔ ${r.remote || '?'}`;
      badge.classList.add('bad');
      badge.title = 'The connection was not on your tailnet; the session was stopped';
    }
  }

  setStats(s) {
    if (!s) return;
    const c = this.el.conn;
    c.codec.textContent = s.codec ? (s.implementation ? `${s.codec} · ${s.implementation}` : s.codec) : '—';
    c.codec.title = c.codec.textContent;
    c.resolution.textContent = s.width && s.height ? `${s.width} × ${s.height}` : '—';
    c.fps.textContent = s.fps != null ? `${s.fps} fps` : '—';
    c.bitrate.textContent = s.bitrateKbps != null ? formatBitrate(s.bitrateKbps) : '—';
    c.rtt.textContent = s.rttMs != null ? `${s.rttMs} ms` : '—';
    c.loss.textContent = s.packetsLost != null
      ? `${s.packetsLost} packets${s.jitterMs != null ? ` · jitter ${s.jitterMs} ms` : ''}`
      : '—';
    c.limit.textContent = s.qualityLimitation ? (LIMIT_LABEL[s.qualityLimitation] || reasonText(s.qualityLimitation)) : '—';
  }

  setStream(info) {
    if (!info) return;
    const c = this.el.conn;
    const d = info.display;
    c.display.textContent = d ? `${d.name || 'Display'}${d.width && d.height ? ` (${d.width}×${d.height})` : ''}${info.displays.length > 1 ? ` · 1 of ${info.displays.length}` : ''}` : '—';
    c.display.title = c.display.textContent;
    c.quality.textContent = QUALITY_LABEL[info.quality] || '—';
    c.audio.textContent = {
      on: 'Streaming', off: 'Off (blocked by you)', unavailable: 'Could not capture system audio', unsupported: 'Not supported on this computer',
    }[info.audio] || '—';
  }

  /* ---------------- transfers ---------------- */

  updateTransfer(t) {
    if (t.purpose !== F.PURPOSE_FILE) return; // clipboard images are internal
    let row = this.xfers.get(t.id);
    if (!row) {
      row = this._xferRow(t);
      this.xfers.set(t.id, row);
      this.el.xferEmpty.hidden = true;
      this.el.xferList.prepend(row.el);
      if (this.xfers.size > 100) {
        for (const [id, r] of this.xfers) {
          if (TERMINAL.has(r.t.state)) { r.el.remove(); this.xfers.delete(id); break; }
        }
      }
    }
    row.t = t;
    const active = t.state === 'sending' || t.state === 'receiving';
    const n = performance.now();
    if (active) {
      if (row.prevTs && n - row.prevTs >= 400) {
        const inst = ((t.bytes - row.prevBytes) * 1000) / (n - row.prevTs);
        row.rate = row.rate ? row.rate * 0.6 + inst * 0.4 : inst;
        row.prevTs = n;
        row.prevBytes = t.bytes;
      } else if (!row.prevTs) {
        row.prevTs = n;
        row.prevBytes = t.bytes;
      }
    }
    const pct = t.size > 0 ? Math.min(100, (t.bytes / t.size) * 100) : t.state === 'done' ? 100 : 0;
    row.bar.style.width = `${pct.toFixed(1)}%`;
    row.progress.hidden = !(active || t.state === 'offered' || t.state === 'queued');
    row.cancel.hidden = TERMINAL.has(t.state) || this.phase === 'ended';
    const revealable = t.direction === 'in' && t.state === 'done';
    row.el.className = `xfer ${t.direction} state-${t.state}${revealable ? ' clickable' : ''}`;
    row.el.title = revealable ? 'Show in folder' : '';
    row.status.textContent = this._xferStatus(t, row);
  }

  _xferStatus(t, row) {
    const size = formatBytes(t.size);
    switch (t.state) {
      case 'queued': return `Waiting · ${size}`;
      case 'offered': return t.direction === 'out' ? `Waiting for ${this.name}… · ${size}` : `Preparing… · ${size}`;
      case 'sending':
      case 'receiving': {
        const rate = row.rate > 0 ? ` · ${formatBytes(row.rate)}/s` : '';
        return `${formatBytes(t.bytes)} of ${size}${rate}`;
      }
      case 'done': return t.direction === 'out' ? `Sent · ${size}` : `Received · ${size} · click to show`;
      case 'rejected': return `Declined (${reasonText(t.reason)})`;
      case 'cancelled': return t.reason === 'peer-cancelled' ? `Cancelled by ${this.name}` : 'Cancelled';
      case 'error': return `Failed (${reasonText(t.reason)})`;
      default: return '';
    }
  }

  _xferRow(t) {
    const bar = h('i');
    const progress = h('div', { class: 'progress' }, bar);
    const status = h('div', { class: 'xfer-status tiny dim ellipsis' });
    const cancel = h('button', {
      class: 'btn btn-ghost btn-xs btn-icon', type: 'button', title: 'Cancel', 'aria-label': `Cancel ${t.name}`,
      onClick: (ev) => { ev.stopPropagation(); this.handlers.onCancelTransfer(t.id); },
    }, icon('x', { size: 14 }));
    const name = h('div', { class: 'xfer-name ellipsis' }, t.name);
    name.title = t.name;
    const el = h('div', { class: 'xfer', role: 'listitem' },
      h('span', { class: 'xfer-icon' }, icon(t.direction === 'out' ? 'upload' : 'download')),
      h('div', { class: 'xfer-main' }, name, progress, status),
      cancel);
    el.addEventListener('click', () => {
      const cur = this.xfers.get(t.id);
      if (cur && cur.t.direction === 'in' && cur.t.state === 'done') this.handlers.onReveal(t.id);
    });
    return { el, bar, progress, status, cancel, t, prevTs: 0, prevBytes: 0, rate: 0 };
  }

  /* ---------------- end ---------------- */

  /** @param {string} reason  @param {{byPeer?:boolean}} [opts] byPeer: reported by main (viewer-side reason) */
  showEnded(reason, { byPeer = false } = {}) {
    if (this.endedAt) return;
    this.endedAt = Date.now();
    this._tick();
    clearInterval(this._clock);
    this.setPhase('ended');
    const text = endText(reason, this.name, byPeer);
    this.el.endedText.textContent = text;
    this.el.endedText.title = text;
    this.el.actions.hidden = true;
    this.el.endedRow.hidden = false;
    this.el.inputWarn.hidden = true;
    this.el.chatInput.disabled = true;
    this.el.chatInput.placeholder = 'Session ended';
    this.el.chatSend.disabled = true;
    this.el.sendFiles.disabled = true;
    this.el.drop.classList.add('disabled');
    this.el.filesOff.hidden = true;
    this.el.conn.inputCard.hidden = true;
    this.el.conn.blockedCard.hidden = true;
    this.el.blockedNote.hidden = true;
    this.el.sub.hidden = false;
    for (const row of this.xfers.values()) row.cancel.hidden = true;
    this.root.classList.add('is-ended');
  }
}
