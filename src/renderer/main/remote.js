/*
 * Main window — "Remote Desk": Tailscale-down banner, connect form, recent sessions strip.
 */
import { h, icon, osIcon, timeAgo, toast, safeText } from '../shared/ui.js';
import {
  api, store, subscribe, connectTo, refreshTailscale, saveSettings, peerName, peerTarget, ipv4Of, errMsg,
} from './store.js';

/* ------------------------------------------------------------------ Tailscale banner */

// text: array of strings; the token DOWNLOAD_LINK becomes a link-style button.
const DOWNLOAD_LINK = Symbol('download-link');
const TS_BANNERS = {
  'not-installed': {
    title: 'Tailscale isn’t installed',
    text: ['Tunnelview works only inside a Tailscale network (tailnet) — it never connects over the open internet. Install Tailscale from ',
      DOWNLOAD_LINK, ', sign in, and this window updates on its own.'],
    action: 'download',
  },
  stopped: {
    title: 'Tailscale isn’t running',
    text: ['Open the Tailscale app and connect. Until Tailscale is up, this computer can’t receive connections and you can’t reach other devices.'],
    action: 'open',
    showMessage: true,
  },
  'needs-login': {
    title: 'Sign in to Tailscale',
    text: ['Tailscale is installed but not signed in (or the login expired, or a tailnet admin still has to approve this device). Open the Tailscale app to finish, then come back — your devices will appear here.'],
    action: 'open',
    showMessage: true,
  },
  error: {
    title: 'Can’t read Tailscale status',
    text: ['Tunnelview couldn’t talk to Tailscale. Make sure the Tailscale app is running and up to date.'],
    action: 'open',
  },
};

const hasApi = (name) => !!api && typeof api[name] === 'function';

async function openTailscaleDownload() {
  try {
    const res = await api.openTailscaleDownload();
    if (res && res.ok === false) throw new Error(res.error || 'Unknown error');
  } catch (err) {
    toast(`Couldn't open the download page: ${errMsg(err)}`, { kind: 'danger' });
  }
}

async function openTailscaleApp() {
  try {
    const res = await api.openTailscale();
    if (res && res.ok === false) throw new Error(res.error || 'Unknown error');
  } catch (err) {
    toast(`Couldn't open Tailscale: ${errMsg(err)}. Start it from your apps instead.`, { kind: 'danger', timeout: 6000 });
  }
}

/** Banner primary action for a Tailscale state, or null when main can't do it. */
function primaryAction(info) {
  if (info.action === 'download' && hasApi('openTailscaleDownload')) {
    return h('button', { class: 'btn btn-primary', type: 'button', onClick: openTailscaleDownload }, icon('download'), 'Download Tailscale');
  }
  if (info.action === 'open' && hasApi('openTailscale')) {
    return h('button', { class: 'btn btn-primary', type: 'button', onClick: openTailscaleApp }, icon('external'), 'Open Tailscale');
  }
  return null;
}

export function mountTsBanner(root) {
  let lastSig = '';
  function render() {
    const ts = store.state.tailscale;
    const sig = `${ts.state}|${ts.message}`;
    if (sig === lastSig) return;
    lastSig = sig;
    const info = TS_BANNERS[ts.state];
    if (!info) { root.replaceChildren(); root.hidden = true; return; }
    root.hidden = false;
    let checking = false;
    const checkBtn = h('button', {
      class: 'btn', type: 'button',
      onClick: async () => {
        if (checking) return;
        checking = true;
        checkBtn.disabled = true;
        checkBtn.replaceChildren(h('span', { class: 'spinner spinner-sm' }), 'Checking…');
        await refreshTailscale(); // runs `tailscale status` now (getState() is the cached poll)
        checking = false;
        checkBtn.disabled = false;
        if (checkBtn.isConnected) {
          checkBtn.replaceChildren(icon('refresh'), 'Check again');
          // Same state → the banner didn't change; say that we did look.
          if (store.state.tailscale.state === ts.state) toast('Checked Tailscale — nothing has changed yet.', { timeout: 2500 });
        }
      },
    }, icon('refresh'), 'Check again');

    const text = info.text.map((part) => {
      if (part !== DOWNLOAD_LINK) return part;
      return hasApi('openTailscaleDownload')
        ? h('button', { class: 'link-btn', type: 'button', onClick: openTailscaleDownload }, 'tailscale.com/download')
        : 'tailscale.com/download';
    });
    // Main's own words for the state, e.g. "This device is waiting for approval by a tailnet admin."
    const message = ts.message && (ts.state === 'error' || info.showMessage)
      ? h('p', { class: ts.state === 'error' ? 'small faint mono selectable ts-banner-msg' : 'ts-banner-sub' }, ts.message)
      : null;
    const primary = primaryAction(info);
    // Secondary: the admin console can't install, start or sign in this computer's client.
    const admin = h('button', {
      class: primary ? 'link-btn ts-banner-link' : 'btn btn-primary', type: 'button',
      onClick: () => api.openTailscaleAdmin().catch(() => {}),
    }, icon('external', { size: 14 }), 'Tailscale admin console');

    root.replaceChildren(h('div', { class: `ts-banner ${ts.state === 'error' ? 'is-danger' : 'is-warn'}`, role: 'alert' },
      h('div', { class: 'ts-banner-icon' }, icon(ts.state === 'not-installed' ? 'plug' : ts.state === 'needs-login' ? 'user' : 'alert', { size: 22 })),
      h('div', { class: 'grow' },
        h('h2', null, info.title),
        ts.state === 'error' ? null : message,
        h('p', { class: 'dim' }, text),
        ts.state === 'error' ? message : null,
        h('div', { class: 'row gap-4 ts-banner-actions' }, primary ? [primary, checkBtn, admin] : [admin, checkBtn]))));
  }
  subscribe('state', render);
  render();
}

/* ------------------------------------------------------------------ connect card */

export function mountConnect(root) {
  const targetInput = h('input', {
    class: 'input input-lg', id: 'connect-target', type: 'text', list: 'target-suggest',
    placeholder: 'Device name or Tailscale IP', autocomplete: 'off', spellcheck: 'false', maxlength: 300,
    'aria-label': 'Device name or Tailscale IP',
  });
  const datalist = h('datalist', { id: 'target-suggest' });
  const pwInput = h('input', {
    class: 'input', type: 'password', placeholder: 'Unattended access password', autocomplete: 'off',
    maxlength: 128, 'aria-label': 'Password for the remote computer',
  });
  const withPw = h('input', { type: 'checkbox' });
  const viewOnly = h('input', { type: 'checkbox' });
  const pwRow = h('div', { class: 'connect-pw', hidden: true }, icon('lock', { className: 'connect-pw-icon' }), pwInput);
  const submitBtn = h('button', { class: 'btn btn-primary btn-lg connect-btn', type: 'submit' }, 'Connect', icon('arrow-right'));

  withPw.addEventListener('change', () => {
    pwRow.hidden = !withPw.checked;
    if (withPw.checked) pwInput.focus();
    else pwInput.value = '';
  });

  let busy = false;
  const form = h('form', { class: 'connect-form', novalidate: true, autocomplete: 'off' },
    h('div', { class: 'connect-field' }, icon('monitor', { size: 18, className: 'connect-field-icon' }), targetInput),
    submitBtn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (busy) return;
    const target = targetInput.value.trim();
    if (!target) {
      targetInput.focus();
      form.classList.remove('shake');
      void form.offsetWidth; // restart the animation
      form.classList.add('shake');
      return;
    }
    if (/\s/.test(target)) {
      toast('Enter a single device name, MagicDNS name or Tailscale IP (no spaces).', { kind: 'warn' });
      return;
    }
    if (withPw.checked && !pwInput.value) {
      toast('Enter the password, or untick “Connect with password”.', { kind: 'warn' });
      pwInput.focus();
      return;
    }
    busy = true;
    submitBtn.disabled = true;
    submitBtn.replaceChildren(h('span', { class: 'spinner spinner-sm spinner-on-accent' }), 'Connecting…');
    const res = await connectTo({ target, password: withPw.checked ? pwInput.value : '', viewOnly: viewOnly.checked });
    busy = false;
    submitBtn.replaceChildren('Connect', icon('arrow-right'));
    applyTsState();
    pwInput.value = ''; // never keep a typed password around after use
    if (res.ok) {
      targetInput.select();
    } else {
      targetInput.focus();
      targetInput.select();
    }
  });

  const tsNote = h('div', { class: 'connect-note small faint' }, icon('shield-check', { size: 14 }), 'Only devices in your tailnet can be reached.');
  root.replaceChildren(
    h('div', { class: 'connect-head' },
      h('div', null,
        h('h1', { id: 'connect-title' }, 'Remote Desk'),
        h('p', { class: 'dim' }, 'Connect to another computer on your tailnet.')),
      h('span', { class: 'connect-glyph', 'aria-hidden': 'true' }, icon('logo', { size: 26 }))),
    form,
    datalist,
    h('div', { class: 'connect-opts' },
      h('label', { class: 'check' }, withPw, h('span', null, 'Connect with password')),
      h('label', { class: 'check' }, viewOnly, h('span', null, 'View only')),
      h('span', { class: 'spacer' }),
      tsNote),
    pwRow);

  function applyTsState() {
    const running = store.state.tailscale.state === 'running';
    submitBtn.disabled = busy || (store.state.loaded && !running);
    submitBtn.title = running || !store.state.loaded ? '' : 'Tailscale must be running to connect';
  }

  let sugSig = '';
  function updateSuggestions() {
    const list = store.peers.list || [];
    const values = [];
    for (const p of list) {
      const n = peerName(p);
      if (n && n !== 'Unknown device') values.push(n);
    }
    const sig = values.join('\n');
    if (sig === sugSig) return;
    sugSig = sig;
    datalist.replaceChildren(...[...new Set(values)].slice(0, 300).map((v) => h('option', { value: v })));
  }

  subscribe('state', applyTsState);
  subscribe('peers', updateSuggestions);
  applyTsState();
  return { focus: () => { targetInput.focus(); targetInput.select(); } };
}

/* ------------------------------------------------------------------ recent strip */

export function mountRecent(root) {
  let lastSig = '';
  const busyKeys = new Set();

  function render() {
    const recent = [...store.settings.recent].sort((a, b) => b.ts - a.ts).slice(0, 8);
    const running = store.state.tailscale.state === 'running';
    const sig = JSON.stringify([recent, running, [...busyKeys], Math.floor(Date.now() / 60000)]);
    if (sig === lastSig) return;
    lastSig = sig;
    if (!store.settingsLoaded) { root.hidden = true; return; }
    root.hidden = false;

    const head = h('div', { class: 'section-head' },
      h('h2', null, icon('history', { size: 16 }), 'Recent'),
      h('span', { class: 'spacer' }),
      recent.length ? h('button', {
        class: 'btn btn-ghost btn-sm', type: 'button',
        onClick: async () => { if (await saveSettings({ recent: [] })) toast('Recent sessions cleared', { kind: 'ok', timeout: 1800 }); },
      }, 'Clear') : null);

    if (!recent.length) {
      root.replaceChildren(head, h('div', { class: 'recent-empty small faint' }, 'Devices you connect to will show up here for quick access.'));
      return;
    }

    const peers = store.peers.list || [];
    const chips = recent.map((r) => {
      const key = r.stableId || r.ip || r.hostname;
      // Prefer the device's CURRENT Tailscale IP (resolved by stableId) over the stored one.
      const live = r.stableId ? peers.find((p) => p.stableId === r.stableId) : null;
      const target = live ? peerTarget(live) : r.ip || r.hostname;
      const name = (live && peerName(live)) || r.hostname || r.ip || 'Device';
      const online = running && live ? live.online : null; // cached peer list is stale while Tailscale is down
      const busy = busyKeys.has(key);
      return h('button', {
        class: 'recent-chip', type: 'button', disabled: !running || busy || !target,
        title: [name, (live && ipv4Of(live.ips)) || r.ip, r.ts ? `last used ${timeAgo(r.ts)}` : ''].filter(Boolean).join(' · '),
        onClick: async () => {
          busyKeys.add(key); render();
          await connectTo({ target, label: name });
          busyKeys.delete(key); render();
        },
      },
      h('span', { class: 'recent-os' }, busy ? h('span', { class: 'spinner spinner-sm' }) : osIcon(r.os, { size: 16 })),
      h('span', { class: 'recent-text' },
        h('span', { class: 'recent-name ellipsis' }, safeText(name, 60)),
        h('span', { class: 'recent-meta ellipsis' },
          online === null ? null : h('span', { class: `dot ${online ? 'dot-ok' : ''}` }),
          r.ts ? timeAgo(r.ts) : (r.ip || ''))));
    });
    root.replaceChildren(head, h('div', { class: 'recent-strip' }, chips));
  }

  subscribe('settings', render);
  subscribe('peers', render);
  subscribe('state', render);
  setInterval(render, 60000); // keep "5 min ago" fresh (sig includes the minute)
  render();
}
