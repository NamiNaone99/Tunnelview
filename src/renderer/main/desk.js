/*
 * Main window — left column "This Desk": identity, addresses, host status, macOS permissions,
 * active incoming session and outgoing viewer sessions.
 *
 * Re-renders only when its inputs actually change (main may push AppState every poll), and
 * restores keyboard focus across re-renders via data-fid markers.
 */
import { h, icon, osIcon, toast, formatDuration, initials, safeText } from '../shared/ui.js';
import {
  api, store, subscribe, saveSettings, copyText, errMsg, ipv4Of, ipv6Of, refreshState, OS_NAMES,
  securityLocked, canFocusViewer, focusViewer, activeTrustedCount,
} from './store.js';
import { openPasswordDialog, confirmDialog } from './dialogs.js';

const LOCKED_HINT = 'Locked while someone is connected to this computer';

const VIA_LABEL = {
  password: 'with the unattended password',
  prompt: 'approved by you',
  trusted: 'trusted device',
  'same-user': 'your own device',
  self: 'this computer',
};

const PHASE = {
  connecting: ['Connecting…', ''],
  hello: ['Connecting…', ''],
  'auth-required': ['Needs password', 'badge-warn'],
  waiting: ['Waiting for approval', 'badge-warn'],
  accepted: ['Connected', 'badge-ok'],
  closed: ['Ended', ''],
};

const SCREEN_STATUS = {
  granted: ['dot-ok', 'Allowed'],
  denied: ['dot-danger', 'Not allowed'],
  'not-determined': ['dot-warn', 'Not requested yet'],
  restricted: ['dot-danger', 'Blocked by a device policy'],
  unknown: ['dot-warn', 'Unknown'],
};

const INPUT_REASON = {
  'accessibility-permission': 'Needs the Accessibility permission',
  'unsupported-platform': 'Not supported on this operating system',
};

/** Run fn (which rebuilds children of root) and put focus back on the equivalent element. */
export function preserveFocus(root, fn) {
  const active = document.activeElement;
  const fid = active && root.contains(active) && active.dataset ? active.dataset.fid : null;
  fn();
  if (fid) {
    const again = root.querySelector(`[data-fid="${CSS.escape(fid)}"]`);
    if (again && typeof again.focus === 'function') again.focus({ preventScroll: true });
  }
}

export function mountDesk(root, { openSettings }) {
  let lastSig = '';
  let ticker = 0;

  function render() {
    const { state, settings } = store;
    const sig = JSON.stringify([
      state.loaded, state.platform, state.tailscale.state, state.tailscale.self, state.host, state.viewers,
      state.permissions, state.input,
      settings.passwordSet, settings.acceptMode, settings.allowFrom, settings.allowList.length,
      settings.autoAcceptSameUser, activeTrustedCount(settings), settings.hostEnabled,
    ]);
    if (sig === lastSig) return;
    lastSig = sig;
    preserveFocus(root, () => root.replaceChildren(build()));
    startTicker();
  }

  function startTicker() {
    clearInterval(ticker);
    ticker = 0;
    const session = store.state.host.session;
    if (!session) return;
    const el = root.querySelector('[data-role="session-time"]');
    if (!el) return;
    const tick = () => { el.textContent = formatDuration(Date.now() - session.startedAt); };
    tick();
    ticker = setInterval(tick, 1000);
  }

  function build() {
    const { state, settings } = store;
    const ts = state.tailscale;
    const self = ts.self;
    const running = ts.state === 'running';
    const known = state.loaded && ts.state !== 'unknown';

    const parts = [];
    if (state.host.session) parts.push(sessionBanner(state.host.session));
    if (state.host.pending) {
      parts.push(h('div', { class: 'banner banner-accent small pending-note' },
        h('span', { class: 'spinner spinner-sm' }),
        h('div', null, h('b', null, 'Connection request'), h('div', { class: 'dim' }, 'Answer it in the approval window.'))));
    }

    // Identity
    const name = self ? (self.shortName || self.hostname || 'This computer') : (known ? 'Not on a tailnet' : '');
    const userLine = self && (self.user.displayName || self.user.login)
      ? [self.user.displayName, self.user.login && self.user.login !== self.user.displayName ? self.user.login : ''].filter(Boolean).join(' · ')
      : '';
    parts.push(h('div', { class: 'desk-id' },
      h('div', { class: 'label' }, 'This Desk'),
      h('div', { class: 'desk-name-row' },
        h('span', { class: 'desk-os', title: self ? OS_NAMES[self.os] : '' }, osIcon(self ? self.os : state.platform || 'other', { size: 20 })),
        self || known
          ? h('h1', { class: 'desk-name ellipsis selectable', title: name }, name)
          : h('div', { class: 'skel skel-title' })),
      userLine ? h('div', { class: 'desk-user small dim ellipsis', title: userLine }, userLine) : null,
      running ? h('div', { class: 'desk-hint small faint' }, 'People on your tailnet connect to this name or IP.') : null));

    // Addresses
    if (self && running) {
      const v4 = ipv4Of(self.ips);
      const v6 = ipv6Of(self.ips);
      parts.push(h('div', { class: 'addr-list' },
        self.dnsName ? addrRow('MagicDNS name', self.dnsName, 'dns') : null,
        v4 ? addrRow('Tailscale IPv4', v4, 'v4') : null,
        v6 ? addrRow('IPv6', v6, 'v6', true) : null));
    } else if (!known) {
      parts.push(h('div', { class: 'addr-list' }, h('div', { class: 'skel skel-addr' }), h('div', { class: 'skel skel-addr' })));
    }

    // Status
    parts.push(h('div', { class: 'label desk-section' }, 'Status'));
    parts.push(h('div', { class: 'status-list' },
      incomingRow(state, settings, running),
      passwordRow(settings, securityLocked(state)),
      acceptRow(settings),
      !state.input.available ? statusRow({
        dot: 'dot-warn',
        title: 'Remote control',
        value: INPUT_REASON[state.input.reason] || (state.input.reason ? `Unavailable (${state.input.reason})` : 'Unavailable'),
        sub: 'Viewers can see this screen but not control it.',
      }) : null));

    // macOS permissions
    if (state.platform === 'macos' || (state.permissions.screen !== 'n/a' && state.permissions.screen !== '')) {
      parts.push(permissionsBlock(state.permissions));
    }

    // Outgoing — each row brings its (possibly minimised) viewer window to the front.
    const viewers = state.viewers.filter((v) => v.phase !== 'closed');
    if (viewers.length) {
      const clickable = canFocusViewer();
      parts.push(h('div', { class: 'label desk-section' }, `Outgoing sessions · ${viewers.length}`));
      parts.push(h('div', { class: 'viewer-list' }, viewers.map((v) => {
        const [label, cls] = PHASE[v.phase] || [v.phase || 'Active', ''];
        const name = v.hostname || 'Remote desk';
        const content = [
          h('span', { class: 'viewer-icon' }, icon('monitor', { size: 16 })),
          h('span', { class: 'grow ellipsis strong', title: v.hostname }, name),
          h('span', { class: `badge ${cls}` }, label),
        ];
        if (!clickable || !(v.id > 0)) return h('div', { class: 'viewer-row' }, content);
        return h('button', {
          class: 'viewer-row is-button', type: 'button', dataset: { fid: `viewer-${v.id}` },
          title: `Show the session window for ${name}`, 'aria-label': `Show the session with ${name} (${label})`,
          onClick: () => focusViewer(v.id),
        }, content);
      })));
    }

    return h('div', { class: 'desk-inner' }, parts);
  }

  function addrRow(label, value, fid, small = false) {
    return h('div', { class: small ? 'addr-row addr-small' : 'addr-row' },
      h('div', { class: 'addr-text' },
        h('span', { class: 'addr-label' }, label),
        h('span', { class: 'addr-value mono selectable' }, value)),
      h('button', {
        class: 'btn btn-ghost btn-icon btn-sm', type: 'button', title: `Copy ${label}`, 'aria-label': `Copy ${label}`,
        dataset: { fid: `copy-${fid}` }, onClick: () => copyText(value, label),
      }, icon('copy')));
  }

  function statusRow({ dot = '', title, value, sub = null, action = null, mono = false }) {
    return h('div', { class: 'status-row' },
      h('span', { class: `dot ${dot}` }),
      h('div', { class: 'grow status-text' },
        h('div', { class: 'status-title' }, title),
        h('div', { class: mono ? 'status-value mono' : 'status-value', title: typeof value === 'string' ? value : null }, value),
        sub ? h('div', { class: 'status-sub' }, sub) : null),
      action);
  }

  function incomingRow(state, settings, running) {
    const host = state.host;
    const enabled = state.loaded ? host.enabled : settings.hostEnabled;
    const input = h('input', { type: 'checkbox', 'aria-label': 'Accept incoming connections', dataset: { fid: 'host-toggle' } });
    input.checked = enabled;
    input.addEventListener('change', async () => {
      input.disabled = true;
      const res = await saveSettings({ hostEnabled: input.checked });
      if (res) toast(res.hostEnabled ? 'Incoming connections turned on' : 'Incoming connections turned off', { kind: 'ok', timeout: 2000 });
      input.disabled = false;
    });
    const action = h('label', { class: 'toggle', title: enabled ? 'Turn off' : 'Turn on' }, input, h('span'));

    let dot = '';
    let value;
    let mono = false;
    if (!enabled) value = 'Disabled';
    else if (host.error) { dot = 'dot-danger'; value = host.error; }
    else if (host.listening) {
      const addr = host.addresses.find((a) => !a.includes(':')) || host.addresses[0] || '';
      dot = 'dot-ok';
      value = addr ? `Listening on ${addr.includes(':') ? `[${addr}]` : addr}:${host.port}` : `Listening on port ${host.port}`;
      mono = true;
    } else { dot = 'dot-warn'; value = running ? 'Starting…' : 'Waiting for Tailscale'; }
    // A problem main detected even though we listen (e.g. Windows Firewall blocks Tunnelview).
    const sub = enabled && host.warning
      ? h('span', { class: 'status-warn' }, h('span', { class: 'dot dot-warn' }), h('span', null, host.warning))
      : null;
    return statusRow({ dot, title: 'Incoming connections', value, sub, action, mono });
  }

  function passwordRow(settings, locked) {
    const btn = h('button', {
      class: 'btn btn-sm', type: 'button', dataset: { fid: 'pw-btn' }, disabled: locked,
      title: locked ? LOCKED_HINT : null,
      onClick: () => openPasswordDialog({ hasPassword: settings.passwordSet }),
    }, settings.passwordSet ? 'Change' : 'Set password');
    return statusRow({
      dot: settings.passwordSet ? 'dot-ok' : '',
      title: 'Unattended access',
      value: settings.passwordSet ? 'Password set' : 'Not set',
      action: btn,
    });
  }

  function acceptRow(settings) {
    const mode = settings.acceptMode === 'password-only' ? 'Password only' : 'Ask every time';
    const who = settings.allowFrom === 'same-user' ? 'only my devices'
      : settings.allowFrom === 'list' ? `allow list (${settings.allowList.length})`
        : 'anyone on my tailnet';
    const extras = [];
    if (settings.autoAcceptSameUser) extras.push('auto-accepts my devices');
    // Entries saved for tagged nodes never auto-accept anything, so they don't count.
    const trustedCount = activeTrustedCount(settings);
    if (trustedCount) extras.push(`${trustedCount} trusted device${trustedCount === 1 ? '' : 's'}`);
    let dot = 'dot-ok';
    let sub = extras.join(' · ') || null;
    if (settings.acceptMode === 'password-only' && !settings.passwordSet) { dot = 'dot-warn'; sub = 'No password set — nobody can connect'; }
    if (settings.allowFrom === 'list' && !settings.allowList.length) { dot = 'dot-warn'; sub = 'Allow list is empty — nobody can connect'; }
    return statusRow({
      dot,
      title: 'Accept mode',
      value: `${mode} · ${who}`,
      sub,
      action: h('button', {
        class: 'btn btn-ghost btn-sm', type: 'button', dataset: { fid: 'accept-edit' },
        onClick: () => openSettings('security'),
      }, 'Edit'),
    });
  }

  function permissionsBlock(perms) {
    const screen = SCREEN_STATUS[perms.screen] || SCREEN_STATUS.unknown;
    const acc = perms.accessibility === 'granted' ? SCREEN_STATUS.granted : ['dot-danger', 'Not allowed'];
    const canRelaunch = !!api && typeof api.relaunchApp === 'function';
    const actions = (kind, status) => {
      if (status === 'granted') return null;
      // Electron reports Screen Recording only as granted/denied (never 'not-determined'), so
      // offer Grant whenever it's missing: the capture attempt behind it is what adds Tunnelview
      // to the Screen Recording list in System Settings (and shows the prompt the first time).
      return h('div', { class: 'row gap-4 perm-btns' },
        h('button', {
          class: 'btn btn-sm btn-primary', type: 'button', dataset: { fid: `grant-${kind}` },
          onClick: () => requestPermission(kind),
        }, 'Grant'),
        h('button', {
          class: 'btn btn-sm', type: 'button', dataset: { fid: `open-${kind}` },
          onClick: () => openPermissionSettings(kind),
        }, 'Open Settings'),
        kind === 'screen' && canRelaunch ? h('button', {
          class: 'btn btn-sm', type: 'button', dataset: { fid: 'relaunch' },
          title: 'Quit Tunnelview and open it again so macOS applies the permission',
          onClick: relaunch,
        }, icon('refresh'), 'Quit & Reopen') : null);
    };
    const allGood = perms.screen === 'granted' && perms.accessibility === 'granted';
    return h('div', { class: allGood ? 'perm-block ok' : 'perm-block' },
      h('div', { class: 'perm-block-head' }, icon(allGood ? 'shield-check' : 'shield', { size: 16 }), h('span', null, 'macOS permissions')),
      permRow('Screen Recording', 'Lets viewers see this screen.', screen, actions('screen', perms.screen)),
      permRow('Accessibility', 'Lets viewers use the mouse and keyboard.', acc, actions('accessibility', perms.accessibility)),
      perms.screen === 'granted' ? null : h('div', { class: 'status-sub' }, canRelaunch
        ? 'macOS applies Screen Recording only after Tunnelview is reopened — click Quit & Reopen after allowing it.'
        : 'macOS applies Screen Recording only after Tunnelview is reopened — quit and reopen Tunnelview after allowing it.'));
  }

  async function relaunch() {
    // Restarting ends every session; only ask when there is one to lose.
    const { state } = store;
    if (state.host.session || state.viewers.some((v) => v.phase !== 'closed')) {
      const ok = await confirmDialog({
        title: 'Quit and reopen Tunnelview?',
        message: 'Open sessions on this computer will end. Tunnelview opens again by itself in a moment.',
        confirmLabel: 'Quit & Reopen',
        iconName: 'refresh',
      });
      if (!ok) return;
    }
    try {
      const res = await api.relaunchApp();
      if (res && res.ok === false) throw new Error(res.error || 'Unknown error');
    } catch (err) {
      toast(`Couldn't restart Tunnelview: ${errMsg(err)}`, { kind: 'danger' });
    }
  }

  function permRow(title, desc, [dot, label], action) {
    return h('div', { class: 'perm-item' },
      h('div', { class: 'row' },
        h('span', { class: `dot ${dot}` }),
        h('div', { class: 'grow' }, h('div', { class: 'status-title' }, title), h('div', { class: 'status-sub' }, `${label} · ${desc}`))),
      action ? h('div', { class: 'perm-actions' }, action) : null);
  }

  async function requestPermission(kind) {
    try {
      const status = await api.requestPermission(kind);
      if (status === 'granted') toast('Permission granted', { kind: 'ok' });
      else if (kind === 'screen') {
        // macOS keeps reporting "not allowed" until the app restarts, even right after allowing it.
        toast('Allow Tunnelview under Screen Recording in System Settings, then quit and reopen Tunnelview.', { timeout: 7000 });
      }
    } catch (err) {
      toast(`Couldn't request the permission: ${errMsg(err)}`, { kind: 'danger' });
    }
    refreshState();
  }

  async function openPermissionSettings(kind) {
    try {
      await api.openPermissionSettings(kind);
      toast(`Enable Tunnelview under ${kind === 'screen' ? 'Screen Recording' : 'Accessibility'}, then come back here.`, { timeout: 6000 });
    } catch (err) {
      toast(`Couldn't open System Settings: ${errMsg(err)}`, { kind: 'danger' });
    }
  }

  function sessionBanner(session) {
    const who = session.peer.user.displayName || session.peer.user.login || session.peer.hostname || 'Someone';
    const since = new Date(session.startedAt);
    const sinceText = Number.isFinite(since.getTime()) ? since.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const endBtn = h('button', {
      class: 'btn btn-danger btn-sm', type: 'button', dataset: { fid: 'end-session' },
      onClick: async () => {
        endBtn.disabled = true;
        try {
          await api.endHostSession();
          toast('Session ended', { kind: 'ok' });
        } catch (err) {
          toast(`Couldn't end the session: ${errMsg(err)}`, { kind: 'danger' });
          endBtn.disabled = false;
        }
      },
    }, icon('power'), 'End session');
    return h('div', { class: 'session-banner', role: 'status' },
      h('div', { class: 'sb-head' },
        h('span', { class: 'live-dot' }),
        h('span', { class: 'sb-label' }, 'Someone is connected'),
        h('span', { class: 'spacer' }),
        h('span', { class: 'sb-time mono', dataset: { role: 'session-time' } }, formatDuration(Date.now() - session.startedAt))),
      h('div', { class: 'row gap-12' },
        h('span', { class: 'avatar' }, initials(who)),
        h('div', { class: 'grow' },
          h('div', { class: 'strong ellipsis', title: who }, who),
          h('div', { class: 'small dim ellipsis' }, `from ${session.peer.hostname || 'unknown device'}${session.peer.ip ? ` · ${session.peer.ip}` : ''}`))),
      h('div', { class: 'small faint' }, [sinceText && `Since ${sinceText}`, VIA_LABEL[session.via] || safeText(session.via, 30)].filter(Boolean).join(' · ')),
      endBtn);
  }

  subscribe('state', render);
  subscribe('settings', render);
  render();
}
