/*
 * Main window — Settings slide-over.
 *
 * Built once (lazily) and kept in sync through "binders": every control registers a function
 * that copies the current PublicSettings into it. Every change calls updateSettings() and the
 * whole view re-syncs from the returned, validated settings — so the UI always shows what was
 * actually persisted, and focus/scroll position survive saves.
 */
import { h, icon, toast, applyTheme, timeAgo, safeText } from '../shared/ui.js';
import {
  api, store, subscribe, saveSettings, PROTO, errMsg, peerName, copyText, OS_NAMES, securityLocked, isTaggedTrust,
  hasIdentityApi, resetIdentity, retryIdentity, hasUpdateApi, normUpdateState,
} from './store.js';
import { pushLayer, openPasswordDialog, removePassword, confirmDialog } from './dialogs.js';
import {
  describeUpdate, updatePlan, revealLabel, checkNow, setAutoCheck, downloadAndInstall, installWithConfirm,
  revealDownloaded, openReleases, cancelDownload,
} from './updates.js';

const SECTIONS = [
  ['security', 'Security', 'shield'],
  ['streaming', 'Streaming', 'gauge'],
  ['behaviour', 'Behaviour', 'keyboard'],
  ['files', 'Files', 'folder'],
  ['network', 'Network', 'network'],
  ['appearance', 'Appearance', 'sun'],
  ['updates', 'Updates', 'download'], // only with the updater API (src/preload/main.js)
  ['about', 'About', 'info'],
];

const QUALITY_LABELS = { quality: 'Best quality', balanced: 'Balanced', speed: 'Fastest' };
const CODEC_LABELS = {
  auto: 'Automatic (H.264 → VP9 → VP8)',
  h264: 'H.264 (hardware accelerated)',
  vp9: 'VP9',
  vp8: 'VP8',
  av1: 'AV1',
};
const PERMS = [
  ['control', 'Control keyboard & mouse', 'mouse'],
  ['clipboard', 'Clipboard', 'clipboard'],
  ['files', 'File transfer', 'file'],
  ['audio', 'Computer audio', 'volume'],
];
// Mirrors the settings store's limits (src/main/settings.js LIMITS.ALLOW_LIST_MAX / ALLOW_ENTRY_MAX).
const ALLOW_MAX = 100;
const ALLOW_ENTRY_MAX = 128;

export function createSettingsView() {
  const binders = [];
  const bind = (fn) => binders.push(fn);
  let built = null;
  let pop = null;
  let closing = null; // { pop, timer } while the close animation runs

  function sync() {
    if (!built) return;
    for (const fn of binders) {
      try { fn(store.settings, store.state); } catch (err) { console.error('[Tunnelview] settings binder failed', err); }
    }
  }
  subscribe('settings', sync);
  subscribe('state', sync);
  subscribe('identity', sync);
  subscribe('update', sync);
  subscribe('peers', () => { if (built) built.updateSuggestions(); });

  /* ------------------------------------------------------------------ controls */

  // Controls marked with data-lock are disabled while someone is connected to this computer:
  // main refuses those security-relevant changes then (see store.securityLocked).
  const LOCK = { lock: '1' };

  function toggle(get, set, label, { lock = false } = {}) {
    const input = h('input', { type: 'checkbox', 'aria-label': label, dataset: lock ? LOCK : null });
    input.addEventListener('change', () => set(input.checked));
    bind((s) => { input.checked = !!get(s); });
    return h('label', { class: 'toggle' }, input, h('span'));
  }

  function segmented(options, get, set, label, { lock = false } = {}) {
    let current;
    const btns = options.map(([value, text]) =>
      h('button', { type: 'button', role: 'radio', dataset: lock ? LOCK : null, onClick: () => { if (value !== current) set(value); } }, text));
    bind((s) => {
      current = get(s);
      btns.forEach((b, i) => {
        const on = options[i][0] === current;
        b.classList.toggle('active', on);
        b.setAttribute('aria-checked', String(on));
      });
    });
    return h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label }, btns);
  }

  function select(options, get, set, label) {
    const el = h('select', { class: 'select', 'aria-label': label },
      options.map(([value, text]) => h('option', { value }, text)));
    el.addEventListener('change', () => set(el.value));
    bind((s) => { el.value = get(s); });
    return el;
  }

  function numberInput({ min, max, step = 1, get, set, label, unit }) {
    const input = h('input', { class: 'input num-input', type: 'number', min, max, step, 'aria-label': label, inputmode: 'numeric' });
    const reset = () => { input.value = String(get(store.settings)); };
    input.addEventListener('change', () => {
      const v = Number(input.value);
      if (!Number.isInteger(v) || v < min || v > max) {
        toast(`${label}: enter a whole number from ${min} to ${max}`, { kind: 'warn' });
        reset();
        return;
      }
      if (v !== get(store.settings)) set(v);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { reset(); input.blur(); e.stopPropagation(); }
    });
    bind((s) => { if (document.activeElement !== input) input.value = String(get(s)); });
    return h('div', { class: 'num-wrap' }, input, unit ? h('span', { class: 'num-unit' }, unit) : null);
  }

  function row(title, desc, control, { stack = false } = {}) {
    return h('div', { class: stack ? 'set-row stack' : 'set-row' },
      h('div', { class: 'set-text' },
        h('div', { class: 'set-title' }, title),
        desc ? (desc instanceof Node ? desc : h('div', { class: 'set-desc' }, desc)) : null),
      control ? h('div', { class: 'set-ctl' }, control) : null);
  }

  function lockBanner() {
    const el = h('div', { class: 'banner banner-warn small set-lock', role: 'status', hidden: true },
      icon('lock'),
      h('div', { class: 'grow' },
        'Security settings are locked while someone is connected to this computer. End the session to change them.'));
    bind((_s, st) => { el.hidden = !securityLocked(st); });
    return el;
  }

  function section(id, title, iconName, ...content) {
    // The heading can take the focus (open(id, {focusSection:true})), but is not a Tab stop.
    return h('section', { class: 'set-card', id: `set-${id}`, dataset: { section: id }, 'aria-labelledby': `set-${id}-title` },
      h('header', { class: 'set-card-head' }, h('span', { class: 'set-card-icon' }, icon(iconName, { size: 16 })), h('h3', { id: `set-${id}-title`, tabindex: '-1' }, title)),
      ...content);
  }

  /* ------------------------------------------------------------------ Security */

  function buildSecurity() {
    const hostRow = row('Accept incoming connections',
      'Let devices on your tailnet ask to view or control this computer. Tunnelview listens only on this device’s Tailscale addresses.',
      toggle((s) => s.hostEnabled, (v) => saveSettings({ hostEnabled: v }), 'Accept incoming connections'));

    // Accept mode
    const modeDesc = h('div', { class: 'set-desc' });
    const modeWarn = h('div', { class: 'banner banner-warn small', hidden: true },
      icon('alert'),
      h('div', { class: 'grow' }, 'No password is set — in “Password only” mode nobody can connect.'),
      h('button', { class: 'btn btn-sm', type: 'button', dataset: LOCK, onClick: () => openPasswordDialog({ hasPassword: false }) }, 'Set password…'));
    bind((s) => {
      modeDesc.textContent = s.acceptMode === 'password-only'
        ? 'Unattended: only viewers who enter the password get in. No approval window is shown.'
        : 'An approval window appears and you decide. Viewers who know the password can skip it.';
      modeWarn.hidden = !(s.acceptMode === 'password-only' && !s.passwordSet);
    });
    const modeRow = h('div', { class: 'set-row stack' },
      h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, 'When someone connects'), modeDesc),
      segmented([['ask', 'Ask every time'], ['password-only', 'Password only (unattended)']],
        (s) => s.acceptMode, (v) => saveSettings({ acceptMode: v }), 'Accept mode', { lock: true }),
      modeWarn);

    // Who can connect
    const ALLOW = [
      ['tailnet', 'Anyone on my tailnet', 'Any verified device in your tailnet can ask to connect.', 'globe'],
      ['same-user', 'Only my devices', 'Devices signed in to the same Tailscale account as this one. Tagged devices are excluded.', 'user'],
      ['list', 'Only these users & devices', 'Only the Tailscale logins, device names or node IDs listed below.', 'users'],
    ];
    const radios = ALLOW.map(([value, title, desc, ic]) => {
      const input = h('input', { type: 'radio', name: 'allow-from', value, dataset: LOCK });
      input.addEventListener('change', () => { if (input.checked) saveSettings({ allowFrom: value }); });
      const el = h('label', { class: 'radio-card' },
        input,
        h('span', { class: 'radio-icon' }, icon(ic, { size: 16 })),
        h('div', { class: 'grow' }, h('div', { class: 'set-title' }, title), h('div', { class: 'set-desc' }, desc)),
        h('span', { class: 'radio-dot', 'aria-hidden': 'true' }));
      return { value, input, el };
    });
    bind((s) => radios.forEach((r) => {
      r.input.checked = s.allowFrom === r.value;
      r.el.classList.toggle('active', r.input.checked);
    }));

    // Allow-list editor
    const chips = h('div', { class: 'tag-list' });
    const listEmpty = h('div', { class: 'banner banner-warn small' }, icon('alert'),
      h('div', null, 'Nobody can connect until you add at least one user or device.'));
    const datalist = h('datalist', { id: 'allow-suggest' });
    const addInput = h('input', {
      class: 'input', type: 'text', list: 'allow-suggest', maxlength: ALLOW_ENTRY_MAX, spellcheck: 'false', autocomplete: 'off',
      placeholder: 'alice@example.com, office-pc or a node ID', 'aria-label': 'User or device to allow', dataset: LOCK,
    });
    const addEntry = async () => {
      const v = addInput.value.trim();
      if (!v) { addInput.focus(); return; }
      // eslint-disable-next-line no-control-regex
      if (v.length > ALLOW_ENTRY_MAX || /[\s\u0000-\u001f\u007f]/.test(v)) { toast('Enter one login, device name or node ID (no spaces)', { kind: 'warn' }); return; }
      const list = store.settings.allowList;
      if (list.some((x) => x.toLowerCase() === v.toLowerCase())) { toast('That entry is already in the list'); addInput.value = ''; return; }
      if (list.length >= ALLOW_MAX) { toast(`The list can hold up to ${ALLOW_MAX} entries`, { kind: 'warn' }); return; }
      const saved = await saveSettings((s) => (s.allowList.includes(v) ? null : { allowList: [...s.allowList, v] }));
      if (!saved) return;
      // The store validates entries; make sure ours survived instead of failing silently.
      if (saved.allowList.includes(v)) addInput.value = '';
      else toast('That entry wasn’t accepted. Use a Tailscale login, device name or node ID.', { kind: 'warn' });
    };
    addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addEntry(); } });
    const listBox = h('div', { class: 'allow-editor' },
      chips,
      listEmpty,
      h('div', { class: 'row' }, addInput, h('button', { class: 'btn', type: 'button', dataset: LOCK, onClick: addEntry }, icon('plus'), 'Add')),
      datalist,
      h('div', { class: 'set-desc' }, 'A login allows all of that person’s devices; a device name or node ID allows just that device. A short device name only matches devices in your own tailnet; use the full MagicDNS name for a device shared from another tailnet.'));
    let allowSig = null;
    bind((s) => {
      listBox.hidden = s.allowFrom !== 'list';
      listEmpty.hidden = s.allowList.length > 0;
      const sig = JSON.stringify(s.allowList);
      if (sig === allowSig) return;
      allowSig = sig;
      chips.replaceChildren(...s.allowList.map((v) =>
        h('span', { class: 'tag', title: v },
          h('span', { class: 'ellipsis' }, safeText(v, 80)),
          h('button', {
            type: 'button', class: 'tag-x', 'aria-label': `Remove ${safeText(v, 80)}`, dataset: LOCK,
            onClick: () => saveSettings((s) => ({ allowList: s.allowList.filter((x) => x !== v) })),
          }, icon('x', { size: 12 })))));
    });
    const updateSuggestions = () => {
      const peers = store.peers.list || [];
      const suffix = ((store.state && store.state.tailscale && store.state.tailscale.magicDnsSuffix) || '').toLowerCase();
      const values = new Set();
      for (const p of peers) {
        if (p.user.login) values.add(p.user.login);
        // A short name only matches devices of this tailnet (host-server _policyAllows): suggest the
        // full MagicDNS name for a device shared in from another tailnet.
        const dns = (p.dnsName || '').toLowerCase();
        const foreign = dns && (!suffix || !dns.endsWith(`.${suffix}`));
        const n = foreign ? p.dnsName : peerName(p);
        if (n && n !== 'Unknown device') values.add(n);
      }
      datalist.replaceChildren(...[...values].slice(0, 300).map((v) => h('option', { value: v })));
    };

    const whoRow = h('div', { class: 'set-row stack' },
      h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, 'Who can connect'),
        h('div', { class: 'set-desc' }, 'Checked before anything else — devices that don’t match are refused without a prompt.')),
      h('div', { class: 'radio-group', role: 'radiogroup', 'aria-label': 'Who can connect' }, radios.map((r) => r.el)),
      listBox);

    // Auto-accept own devices
    const loginEl = h('b');
    const autoWarn = h('div', { class: 'banner banner-warn small', hidden: true }, icon('alert'),
      h('div', null, 'Any device signed in as ', loginEl,
        ' can take control without a prompt. Only use this if all of your devices are locked and kept secure. This computer itself always asks.'));
    bind((s, st) => {
      const login = st.tailscale.self && st.tailscale.self.user.login;
      loginEl.textContent = login || 'your Tailscale account';
      autoWarn.hidden = !s.autoAcceptSameUser;
    });
    const autoRow = h('div', { class: 'set-row-group' },
      row('Auto-accept my own devices',
        'Skip the approval window when the viewer is signed in to the same Tailscale account.',
        toggle((s) => s.autoAcceptSameUser, (v) => saveSettings({ autoAcceptSameUser: v }), 'Auto-accept my own devices', { lock: true })),
      autoWarn);

    // Unattended password
    const pwDesc = h('div', { class: 'set-desc with-dot' });
    const pwBtn = h('button', { class: 'btn btn-sm', type: 'button', dataset: LOCK, onClick: () => openPasswordDialog({ hasPassword: store.settings.passwordSet }) });
    const pwRemove = h('button', {
      class: 'btn btn-sm btn-ghost text-danger', type: 'button', dataset: LOCK,
      onClick: () => removePassword({ passwordOnly: store.settings.acceptMode === 'password-only' }),
    }, 'Remove');
    bind((s) => {
      pwDesc.replaceChildren(
        h('span', { class: `dot ${s.passwordSet ? 'dot-ok' : ''}` }),
        s.passwordSet ? 'A password is set. Viewers can use it to connect without approval.' : 'Not set. Set one to reach this computer when nobody is in front of it.');
      pwBtn.textContent = s.passwordSet ? 'Change…' : 'Set password…';
      pwRemove.hidden = !s.passwordSet;
    });
    const pwRow = row('Unattended access password', pwDesc, h('div', { class: 'row gap-4' }, pwRemove, pwBtn));

    // Trusted devices
    const trusted = h('div', { class: 'trusted-list' });
    let trustedSig = null;
    bind((s) => {
      const sig = JSON.stringify(s.trustedNodes);
      if (sig === trustedSig) return;
      trustedSig = sig;
      if (!s.trustedNodes.length) {
        trusted.replaceChildren(h('div', { class: 'empty-inline' }, icon('shield-check', { size: 18 }),
          h('div', null, 'No trusted devices yet. Tick “Always allow this device” when you accept a connection to add one.')));
        return;
      }
      trusted.replaceChildren(...s.trustedNodes.map((n) => {
        const added = n.addedAt ? timeAgo(n.addedAt) : '';
        // Saved for a tagged node (older versions offered "Always allow" for them): the host
        // never auto-accepts tagged nodes, so say so instead of implying it works.
        const tagged = isTaggedTrust(n);
        const owner = tagged ? 'Tagged device' : n.login;
        return h('div', { class: tagged ? 'trusted-row is-inactive' : 'trusted-row' },
          h('span', { class: 'avatar avatar-sm' }, icon(tagged ? 'shield' : 'shield-check')),
          h('div', { class: 'grow' },
            h('div', { class: 'strong ellipsis' }, n.name || n.stableId),
            h('div', { class: 'small faint ellipsis' }, [owner, added && `added ${added}`].filter(Boolean).join(' · ') || n.stableId),
            tagged ? h('div', { class: 'small faint trusted-note' }, 'Not applied — tagged devices are never auto-accepted') : null),
          h('button', {
            class: 'btn btn-sm btn-ghost', type: 'button', 'aria-label': `Stop trusting ${n.name || n.stableId}`,
            onClick: () => removeTrusted(n.stableId),
          }, icon('trash'), 'Remove'));
      }));
    });
    const trustedRow = h('div', { class: 'set-row stack' },
      h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, 'Trusted devices'),
        h('div', { class: 'set-desc' }, 'These devices are accepted automatically — no approval window.')),
      trusted);

    // Default permissions
    const permGrid = h('div', { class: 'perm-grid' }, PERMS.map(([k, label, ic]) =>
      h('div', { class: 'perm-cell' },
        h('span', { class: 'perm-icon' }, icon(ic, { size: 16 })),
        h('span', { class: 'grow' }, label),
        toggle((s) => s.defaultPermissions[k], (v) => saveSettings((s) => ({ defaultPermissions: { ...s.defaultPermissions, [k]: v } })), label, { lock: true }))));
    const permRow = h('div', { class: 'set-row stack' },
      h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, 'Default permissions for new sessions'),
        h('div', { class: 'set-desc' }, 'Pre-selected in the approval window. You can change them during a session from the session panel.')),
      permGrid);

    const timeoutRow = row('Approval timeout',
      'If nobody answers the approval window in time, the request is declined.',
      numberInput({ min: 10, max: 300, step: 5, label: 'Approval timeout', unit: 'sec', get: (s) => s.promptTimeoutSec, set: (v) => saveSettings({ promptTimeoutSec: v }) }));

    return {
      el: section('security', 'Security', 'shield', lockBanner(), hostRow, modeRow, whoRow, autoRow, pwRow, trustedRow, permRow, timeoutRow, identityRow()),
      updateSuggestions,
    };
  }

  /**
   * This computer's ID for phones (identity.js fingerprint). Resetting it is locked during an
   * incoming session like the other security settings; Retry only reloads the file, so it is not.
   */
  function identityRow() {
    const ID_ERRORS = {
      CORRUPT: 'The identity file is damaged.',
      READ_FAILED: 'The identity file can’t be read.',
      VERSION: 'The identity file was written by a newer version of Tunnelview.',
      WRITE_FAILED: 'A new identity couldn’t be saved.',
      MISSING: 'The identity file and its backup are gone. Put one back and Retry before you restart Tunnelview, or reset the identity.',
    };
    // Where identity.js keeps the key (index.js identityFileFor()), so the user knows what to check.
    const ID_FOLDERS = {
      windows: '%LOCALAPPDATA%\\Tunnelview',
      macos: '~/Library/Application Support/Tunnelview',
    };
    const fpEl = h('span', { class: 'mono selectable' });
    const copyBtn = h('button', {
      class: 'btn btn-ghost btn-icon btn-sm', type: 'button', title: 'Copy this computer’s ID', 'aria-label': 'Copy this computer’s ID',
      onClick: () => copyText(store.identity && store.identity.fingerprint, 'ID'),
    }, icon('copy'));
    const title = h('div', { class: 'set-title id-title' }, "This computer's ID: ", fpEl, copyBtn);
    const confirmReset = async () => {
      const ok = await confirmDialog({
        title: 'Reset this computer’s identity?',
        message: 'Tunnelview makes a new ID for this computer. Phones paired with it will stop connecting until you pair them again. Connections from computers are not affected.',
        confirmLabel: 'Reset identity',
        danger: true,
        iconName: 'key',
      });
      if (ok && await resetIdentity()) toast('This computer has a new ID. Pair your phones again.', { kind: 'ok', timeout: 5000 });
    };
    const resetBtn = h('button', { class: 'btn btn-sm btn-ghost text-danger', type: 'button', dataset: LOCK, onClick: confirmReset }, 'Reset identity…');
    const errText = h('div', { class: 'dim' });
    const whereText = h('div', { class: 'dim selectable id-where' });
    const retry = async (e) => {
      const b = e && e.currentTarget;
      if (b) b.disabled = true;
      const ok = await retryIdentity();
      if (b) b.disabled = false;
      if (ok) toast('This computer’s identity is available again', { kind: 'ok' });
      else toast('Still unavailable', { kind: 'warn' });
    };
    const unavailable = h('div', { class: 'banner banner-danger small id-banner', role: 'alert', hidden: true },
      icon('alert'),
      h('div', { class: 'grow' },
        h('div', { class: 'strong' }, "This computer can't prove its identity to phones right now"),
        errText,
        whereText,
        h('div', { class: 'dim' }, 'Phones keep their pairing. Retry once the cause is fixed, or reset the identity so phones pair again.'),
        h('div', { class: 'row gap-4 id-actions' },
          h('button', { class: 'btn btn-sm', type: 'button', onClick: retry }, icon('refresh'), 'Retry'),
          h('button', { class: 'btn btn-sm btn-ghost text-danger', type: 'button', dataset: LOCK, onClick: confirmReset }, 'Reset identity…'))));
    const wasReset = h('div', { class: 'banner banner-warn small', role: 'status', hidden: true },
      icon('info'), h('div', { class: 'grow' }, 'Phones paired with this computer must pair again'));
    const desc = h('div', { class: 'set-desc' }, 'Phones you pair check this ID every time they connect, so they only talk to this computer.');
    const el = h('div', { class: 'set-row stack id-row', hidden: true },
      h('div', { class: 'row gap-16 id-head' }, h('div', { class: 'set-text grow' }, title, desc), h('div', { class: 'set-ctl' }, resetBtn)),
      unavailable,
      wasReset);
    bind((s, st) => {
      const id = store.identity;
      el.hidden = !hasIdentityApi() || !id;
      if (el.hidden) return;
      fpEl.textContent = id.available ? id.fingerprint : 'unavailable';
      copyBtn.hidden = !id.available;
      resetBtn.hidden = !id.available;
      unavailable.hidden = id.available;
      errText.textContent = ID_ERRORS[id.error] || '';
      errText.hidden = !ID_ERRORS[id.error];
      const folder = ID_FOLDERS[st && st.platform];
      whereText.textContent = folder ? `The files are identity.json and identity.json.bak in ${folder}.` : '';
      whereText.hidden = !folder;
      wasReset.hidden = !id.wasReset;
    });
    return el;
  }

  async function removeTrusted(stableId) {
    // Main only allows REMOVING trusted nodes from here; send the remaining entries back as-is.
    const saved = await saveSettings((s, raw) => {
      const list = raw && Array.isArray(raw.trustedNodes) ? raw.trustedNodes : s.trustedNodes;
      return { trustedNodes: list.filter((n) => n && n.stableId !== stableId) };
    });
    if (saved && !saved.trustedNodes.some((n) => n.stableId === stableId)) toast('Device removed from trusted devices', { kind: 'ok' });
  }

  /* ------------------------------------------------------------------ other sections */

  function buildStreaming() {
    const presets = PROTO.QUALITY_PRESETS.map((p) => [p, QUALITY_LABELS[p] || p]);
    const codecs = PROTO.CODECS.map((c) => [c, CODEC_LABELS[c] || c.toUpperCase()]);
    // Windows only: the GPU decoder is off by default (main reads this before startup).
    const gpuRow = row('GPU video decoding', 'Decode the remote screen on the graphics card. Off by default because some GPU decoders freeze the picture for a second or two at a time. Takes effect after Tunnelview restarts.',
      toggle((s) => s.gpuVideoDecode, (v) => saveSettings({ gpuVideoDecode: v }), 'GPU video decoding'));
    bind((s, st) => { gpuRow.hidden = st.platform !== 'windows'; });
    return section('streaming', 'Streaming', 'gauge',
      row('Default quality', 'Used when you start a session. You can switch any time from the viewer toolbar.',
        segmented(presets, (s) => s.quality, (v) => saveSettings({ quality: v }), 'Default quality'), { stack: true }),
      row('Video codec', 'Automatic picks hardware H.264 when both computers support it. Codecs the other side lacks are skipped.',
        select(codecs, (s) => s.codec, (v) => saveSettings({ codec: v }), 'Video codec')),
      gpuRow);
  }

  function buildBehaviour() {
    const trayDesc = h('div', { class: 'set-desc' });
    bind((s, st) => {
      trayDesc.textContent = st.platform === 'macos'
        ? 'Closing the window keeps Tunnelview in the menu bar so this Mac stays reachable.'
        : 'Closing the window keeps Tunnelview in the notification area so this PC stays reachable.';
    });
    return section('behaviour', 'Behaviour', 'keyboard',
      row('Sync clipboard', 'Share copied text and images between both computers during a session (when the host allows it).',
        toggle((s) => s.clipboardSync, (v) => saveSettings({ clipboardSync: v }), 'Sync clipboard')),
      row('Swap Cmd and Ctrl', 'Auto swaps when exactly one of the two computers is a Mac, so copy, paste and other shortcuts feel native.',
        segmented([['auto', 'Auto'], ['on', 'On'], ['off', 'Off']], (s) => s.swapCmdCtrl, (v) => saveSettings({ swapCmdCtrl: v }), 'Swap Cmd and Ctrl')),
      row('Start at login', 'Open Tunnelview in the background when you sign in to this computer.',
        toggle((s) => s.startAtLogin, (v) => saveSettings({ startAtLogin: v }), 'Start at login')),
      row('Keep running when closed', trayDesc,
        toggle((s) => s.closeToTray, (v) => saveSettings({ closeToTray: v }), 'Keep running when closed')));
  }

  function buildFiles() {
    const pathEl = h('div', { class: 'path-box mono selectable' });
    const resetBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', dataset: LOCK, onClick: () => saveSettings({ downloadDir: null }) }, 'Use default');
    bind((s) => {
      pathEl.textContent = s.effectiveDownloadDir || s.downloadDir || 'Downloads/Tunnelview';
      pathEl.title = pathEl.textContent;
      resetBtn.hidden = !s.downloadDir;
    });
    const change = async () => {
      try {
        const dir = await api.chooseDownloadDir();
        if (typeof dir === 'string' && dir) {
          const saved = await saveSettings({ downloadDir: dir });
          if (saved) toast('Download folder updated', { kind: 'ok' });
        }
      } catch (err) {
        toast(`Couldn't choose a folder: ${errMsg(err)}`, { kind: 'danger' });
      }
    };
    const openFolder = async () => {
      try { await api.openDownloads(); } catch (err) { toast(`Couldn't open the folder: ${errMsg(err)}`, { kind: 'danger' }); }
    };
    return section('files', 'Files', 'folder',
      lockBanner(),
      h('div', { class: 'set-row stack' },
        h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, 'Download folder'),
          h('div', { class: 'set-desc' }, 'Files sent to this computer are saved here.')),
        pathEl,
        h('div', { class: 'row gap-4' },
          h('button', { class: 'btn btn-sm', type: 'button', dataset: LOCK, onClick: change }, icon('folder'), 'Change…'),
          h('button', { class: 'btn btn-sm', type: 'button', onClick: openFolder }, icon('external'), 'Open'),
          h('span', { class: 'spacer' }),
          resetBtn)));
  }

  function buildNetwork() {
    const aclText = h('span');
    const listenEl = h('div', { class: 'set-desc with-dot' });
    bind((s, st) => {
      aclText.textContent = `TCP ${s.port} and UDP ${PROTO.RTC_UDP_MIN}–${PROTO.RTC_UDP_MAX}`;
      const host = st.host;
      let dot = '';
      let text;
      if (!host.enabled) text = 'Incoming connections are turned off.';
      else if (host.error) { dot = 'dot-danger'; text = host.error; }
      else if (host.listening && host.addresses.length) { dot = 'dot-ok'; text = `Listening on ${host.addresses.map((a) => (a.includes(':') ? `[${a}]` : a)).join(', ')} port ${host.port}`; }
      else { dot = 'dot-warn'; text = 'Not listening yet — waiting for Tailscale.'; }
      listenEl.replaceChildren(h('span', { class: `dot ${dot}` }), h('span', null, text));
    });
    const copyAcl = () => copyText(`tcp:${store.settings.port}, udp:${PROTO.RTC_UDP_MIN}-${PROTO.RTC_UDP_MAX}`, 'Port list');
    return section('network', 'Network', 'network',
      row('Port', 'Signaling port (TCP) this computer listens on. When you connect without typing a port, Tunnelview uses the port the other device answers on (or this one). On Windows, the installer’s firewall rule allows Tunnelview on any port, from Tailscale addresses only.',
        numberInput({ min: 1024, max: 65535, label: 'Port', get: (s) => s.port, set: (v) => saveSettings({ port: v }) })),
      h('div', { class: 'set-row stack' },
        h('div', { class: 'set-text' }, h('div', { class: 'set-title' }, 'Listener'), listenEl)),
      h('div', { class: 'banner banner-accent small acl-note' },
        icon('info'),
        h('div', { class: 'grow' },
          h('div', { class: 'strong' }, 'Using Tailscale ACLs or grants?'),
          h('div', { class: 'dim' }, 'Allow ', aclText, ' between the devices that use Tunnelview. Video and input travel over your tailnet only — no open ports on the internet. When no direct path exists, Tailscale relays the (still end-to-end encrypted) traffic through its DERP servers.')),
        h('button', { class: 'btn btn-sm', type: 'button', onClick: copyAcl }, icon('copy'), 'Copy')));
  }

  function buildAppearance() {
    return section('appearance', 'Appearance', 'sun',
      row('Theme', 'System follows your computer’s light or dark setting.',
        segmented([['system', 'System'], ['dark', 'Dark'], ['light', 'Light']], (s) => s.theme,
          (v) => { applyTheme(v); saveSettings({ theme: v }); }, 'Theme')));
  }

  /**
   * In-app updates (updates.js; main: updater.js). The daily check is locked during an incoming
   * session like the security settings (main refuses the change then). Check now and the download
   * stay available; Install waits until no session runs, and the reason stays in view.
   */
  function buildUpdates() {
    const TONE_DOT = { ok: 'dot-ok', accent: 'dot-accent', danger: 'dot-danger' };
    // UpdateState as main last sent it; before its first answer, what settings and AppState say.
    const current = () => store.update || normUpdateState({
      status: 'idle', currentVersion: store.state.version, platform: store.state.platform,
      autoCheck: store.settings.autoUpdateCheck, lastCheckAt: store.settings.lastUpdateCheckAt,
    });
    // A busy button, and one that has the keyboard focus, stays focusable (aria-disabled):
    // Chromium moves the focus of a control that becomes disabled to <body>, out of this sheet
    // (a session that starts while Install has the focus, a check that starts on its own). Clicks
    // are checked against the plan anyway. Any other button that cannot be used now is disabled.
    const setBtn = (btn, { enabled, busy }) => {
      if (busy || (!enabled && document.activeElement === btn)) {
        btn.disabled = false;
        btn.setAttribute('aria-disabled', 'true');
      } else {
        btn.removeAttribute('aria-disabled');
        btn.disabled = !enabled;
      }
      if (busy) btn.setAttribute('data-busy', ''); else btn.removeAttribute('data-busy'); // progress cursor
    };

    // Daily check
    const lockHint = h('div', { class: 'set-desc update-lock-hint', hidden: true },
      icon('lock', { size: 12 }), h('span', null, 'Locked while someone is connected to this computer.'));
    bind((_s, st) => { lockHint.hidden = !securityLocked(st); });
    const autoRow = h('div', { class: 'set-row-group' },
      row('Check for updates automatically',
        'Contacts GitHub once a day to look for a signed update. Tunnelview sends no names or tailnet details, and installs nothing without your click.',
        toggle(() => current().autoCheck, (v) => setAutoCheck(v), 'Check for updates automatically (contacts GitHub once a day)', { lock: true })),
      lockHint);

    // Version, Check now, status
    const versionEl = h('div', { class: 'set-title' });
    const lastEl = h('div', { class: 'set-desc' });
    const checkBtn = h('button', {
      class: 'btn btn-sm', type: 'button',
      onClick: () => { if (updatePlan(current(), store.updateOps).check.enabled) checkNow(); },
    });
    const statusIcon = h('span', { class: 'update-status-icon' });
    const statusText = h('span', { class: 'update-status-text' });
    const statusLine = h('div', { class: 'update-status' }, statusIcon, statusText);
    const detailEl = h('div', { class: 'set-desc update-detail' });
    const bar = h('i');
    const progress = h('div', {
      class: 'progress update-progress', role: 'progressbar', 'aria-label': 'Download progress',
      'aria-valuemin': '0', 'aria-valuemax': '100', hidden: true,
    }, bar);
    // Read out when the status changes, never once per percent of a download.
    const live = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite' });

    // What's new: text only (textContent), line breaks kept by CSS, scrolls within a capped height.
    const notesTitle = h('div', { class: 'set-title', id: 'update-notes-title' });
    const notesDate = h('span', { class: 'small faint' });
    const notesBox = h('div', { class: 'update-notes selectable', tabindex: '0', role: 'region', 'aria-labelledby': 'update-notes-title' });
    const notesBlock = h('div', { class: 'update-notes-block', hidden: true },
      h('div', { class: 'row update-notes-head' }, notesTitle, notesDate),
      notesBox);

    // Download and install / Restart and install, Show in folder, Releases page
    const primaryBtn = h('button', { class: 'btn btn-sm btn-primary', type: 'button', 'aria-describedby': 'update-hint', onClick: onPrimary });
    const revealBtn = h('button', { class: 'btn btn-sm', type: 'button', onClick: () => revealDownloaded() });
    const cancelBtn = h('button', {
      class: 'btn btn-sm', type: 'button', hidden: true,
      onClick: () => { if (updatePlan(current(), store.updateOps).cancel) cancelDownload(); },
    }, icon('x'), 'Cancel download');
    const releasesBtn = h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onClick: () => openReleases() }, icon('external'), 'Releases page');
    const hintText = h('span');
    const hint = h('div', { class: 'small update-hint', id: 'update-hint', hidden: true }, icon('lock', { size: 14 }), hintText);

    async function onPrimary() {
      const p = updatePlan(current(), store.updateOps).primary;
      if (!p || !p.enabled) return;
      if (p.action === 'download') await downloadAndInstall();
      else if (p.action === 'install') await installWithConfirm();
      else if (p.action === 'reveal') await revealDownloaded();
      else if (p.action === 'releases') await openReleases();
    }

    let notesSig = null;
    let spoken = null;
    bind((_s, st) => {
      const u = current();
      const d = describeUpdate(u);
      const plan = updatePlan(u, store.updateOps);

      versionEl.textContent = `Tunnelview ${u.currentVersion || st.version}`.trim();
      lastEl.textContent = u.lastCheckAt ? `Last checked ${timeAgo(u.lastCheckAt)}` : 'Not checked yet';
      setBtn(checkBtn, plan.check);
      checkBtn.replaceChildren(...(plan.check.busy ? [h('span', { class: 'spinner spinner-sm' }), 'Checking…'] : [icon('refresh'), 'Check now']));

      statusLine.hidden = !d.text;
      statusLine.className = d.tone ? `update-status is-${d.tone}` : 'update-status';
      statusIcon.replaceChildren(d.tone === 'busy' ? h('span', { class: 'spinner spinner-sm' }) : h('span', { class: `dot ${TONE_DOT[d.tone] || ''}` }));
      statusText.textContent = d.text;
      detailEl.textContent = d.detail;
      detailEl.hidden = !d.detail;
      progress.hidden = d.progress === null;
      if (d.progress !== null) {
        bar.style.width = `${d.progress}%`;
        progress.setAttribute('aria-valuenow', String(d.progress));
        progress.setAttribute('aria-valuetext', d.detail ? `${d.progress}% (${d.detail})` : `${d.progress}%`);
      }

      const sig = u.latest ? JSON.stringify([u.latest.version, u.latest.date, u.latest.notes]) : '';
      if (sig !== notesSig) {
        notesSig = sig;
        notesBlock.hidden = !u.latest;
        if (u.latest) {
          notesTitle.textContent = `What’s new in ${u.latest.version}`;
          // YYYY-MM-DD: the rest of the window is English, so no locale month names here.
          const day = u.latest.date ? new Date(u.latest.date) : null;
          notesDate.textContent = day && Number.isFinite(day.getTime()) ? `Released ${day.toISOString().slice(0, 10)}` : '';
          notesBox.textContent = u.latest.notes || 'No release notes for this version.';
          notesBox.classList.toggle('is-empty', !u.latest.notes);
          notesBox.scrollTop = 0;
        }
      }

      const p = plan.primary;
      primaryBtn.hidden = !p;
      if (p) {
        setBtn(primaryBtn, p);
        const lead = p.busy && p.label.endsWith('…') ? h('span', { class: 'spinner spinner-sm spinner-on-accent' })
          : icon(p.action === 'releases' ? 'external' : p.action === 'install' ? 'refresh' : p.action === 'reveal' ? 'folder' : 'download');
        primaryBtn.replaceChildren(lead, p.label);
      }
      revealBtn.hidden = !plan.reveal;
      revealBtn.replaceChildren(icon('folder'), revealLabel(u.platform));
      cancelBtn.hidden = !plan.cancel;
      releasesBtn.hidden = !plan.releases;
      hint.hidden = !plan.hint;
      hintText.textContent = plan.hint;

      const key = JSON.stringify([u.status, u.phase, u.error && u.error.code, u.latest && u.latest.version]);
      if (key !== spoken) {
        spoken = key;
        live.textContent = d.announce;
      }
    });

    return section('updates', 'Updates', 'download',
      autoRow,
      h('div', { class: 'set-row stack update-row' },
        h('div', { class: 'row gap-16 update-head' },
          h('div', { class: 'set-text grow' }, versionEl, lastEl),
          h('div', { class: 'set-ctl' }, checkBtn)),
        statusLine,
        detailEl,
        progress,
        notesBlock,
        h('div', { class: 'row gap-4 update-actions' }, primaryBtn, cancelBtn, revealBtn, h('span', { class: 'spacer' }), releasesBtn),
        hint,
        live));
  }

  function buildAbout() {
    const verEl = h('span', { class: 'mono' });
    const platEl = h('span');
    bind((s, st) => {
      verEl.textContent = st.version ? `v${st.version}` : '';
      platEl.textContent = st.platform ? (OS_NAMES[st.platform] || st.platform) : '';
    });
    const facts = [
      'Listens only on this device’s Tailscale IPs — never on your LAN or the open internet.',
      'Every incoming connection is verified with Tailscale (whois) before anything else happens.',
      'Screen, input and files travel peer-to-peer inside the tailnet: WireGuard plus DTLS-SRTP, with no STUN/TURN servers; Tailscale may relay through DERP when no direct path exists.',
      'Passwords never leave this device; viewers prove they know them.',
      'While someone is connected, a session panel is always visible on this computer.',
      hasUpdateApi()
        ? 'The only connection outside your tailnet goes to GitHub, for updates: HTTPS requests that carry no names or tailnet details. Turn the daily check off under Updates.'
        : null,
    ].filter(Boolean);
    const quit = async () => {
      const ok = await confirmDialog({
        title: 'Quit Tunnelview?',
        message: 'This computer will stop accepting connections and any open sessions will end.',
        confirmLabel: 'Quit',
        danger: true,
        iconName: 'power',
      });
      if (ok) api.quit();
    };
    return section('about', 'About', 'info',
      h('div', { class: 'about-head' },
        h('div', { class: 'brand-mark brand-mark-lg' }, icon('logo', { size: 26 })),
        h('div', null, h('div', { class: 'wordmark wordmark-lg' }, 'any', h('b', null, 'View')), h('div', { class: 'small dim row gap-4' }, verEl, platEl))),
      h('div', { class: 'banner banner-ok small' }, icon('shield-check'),
        h('div', null, h('b', null, 'Tailscale-only: '), 'connections are only accepted from verified tailnet peers.')),
      h('ul', { class: 'fact-list' }, facts.map((f) => h('li', null, icon('check', { size: 14 }), h('span', null, f)))),
      h('div', { class: 'row gap-4 about-actions' },
        h('button', { class: 'btn btn-sm', type: 'button', onClick: () => api.openTailscaleAdmin().catch(() => {}) }, icon('external'), 'Tailscale admin console'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm btn-ghost text-danger', type: 'button', onClick: quit }, icon('power'), 'Quit Tunnelview')));
  }

  /* ------------------------------------------------------------------ sheet */

  function build() {
    const sec = buildSecurity();
    const withUpdates = hasUpdateApi();
    const body = h('div', { class: 'sheet-body' },
      sec.el, buildStreaming(), buildBehaviour(), buildFiles(), buildNetwork(), buildAppearance(),
      withUpdates ? buildUpdates() : null, buildAbout(),
      h('div', { class: 'sheet-foot faint small' }, 'Changes are saved automatically.'));

    const navBtns = SECTIONS.filter(([id]) => id !== 'updates' || withUpdates).map(([id, label]) =>
      h('button', { type: 'button', class: 'nav-chip', dataset: { target: id }, onClick: () => scrollToSection(id, true) }, label));
    const closeBtn = h('button', { class: 'btn btn-ghost btn-icon', type: 'button', 'aria-label': 'Close settings', title: 'Close (Esc)', onClick: close }, icon('x', { size: 18 }));
    // Registered after every section's binders, so it also covers controls they just (re)built.
    bind((_s, st) => {
      const locked = securityLocked(st);
      for (const el of body.querySelectorAll('[data-lock]')) {
        el.disabled = locked;
        if (locked) el.title = 'Locked while someone is connected to this computer';
        else el.removeAttribute('title');
      }
    });

    const sheet = h('aside', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'settings-title' },
      h('header', { class: 'sheet-head' },
        h('div', { class: 'grow' }, h('h2', { id: 'settings-title' }, 'Settings'),
          h('div', { class: 'small faint' }, hasUpdateApi()
            ? 'Remote sessions stay inside your tailnet; only updates come from GitHub'
            : 'Remote sessions stay inside your tailnet')),
        closeBtn),
      h('nav', { class: 'sheet-nav', 'aria-label': 'Settings sections' }, navBtns),
      body);
    const wrap = h('div', { class: 'layer sheet-layer' }, h('div', { class: 'scrim', onClick: close }), sheet);

    // Scroll-spy for the section chips.
    let raf = 0;
    body.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        let active = SECTIONS[0][0];
        const top = body.scrollTop + 24;
        for (const [id] of SECTIONS) {
          const el = body.querySelector(`#set-${id}`);
          if (el && el.offsetTop <= top) active = id;
        }
        if (body.scrollTop + body.clientHeight >= body.scrollHeight - 4) active = SECTIONS[SECTIONS.length - 1][0];
        for (const b of navBtns) b.classList.toggle('active', b.dataset.target === active);
      });
    }, { passive: true });

    function scrollToSection(id, smooth) {
      const el = body.querySelector(`#set-${id}`);
      if (!el) return;
      body.scrollTo({ top: Math.max(0, el.offsetTop - 12), behavior: smooth ? 'smooth' : 'auto' });
      for (const b of navBtns) b.classList.toggle('active', b.dataset.target === id);
    }

    return { wrap, sheet, body, closeBtn, scrollToSection, updateSuggestions: sec.updateSuggestions };
  }

  /**
   * Show the sheet (scrolled to sectionId). focusSection: the section's heading takes the keyboard
   * focus, so Tab continues inside it (used by the update banner's "View update").
   */
  function open(sectionId = null, { focusSection = false } = {}) {
    if (!built) {
      built = build();
      built.updateSuggestions();
      sync();
    }
    if (closing) {
      // Re-opened during the close animation: finish removing the old layer first.
      clearTimeout(closing.timer);
      closing.pop();
      closing = null;
    }
    if (!pop) {
      pop = pushLayer(built.wrap, { onEscape: close });
      requestAnimationFrame(() => built.wrap.classList.add('open'));
      built.closeBtn.focus({ preventScroll: true });
    }
    const target = sectionId && SECTIONS.some(([id]) => id === sectionId) ? sectionId : 'security';
    built.scrollToSection(target, false);
    if (focusSection) {
      const head = built.body.querySelector(`#set-${target}-title`);
      if (head) head.focus({ preventScroll: true });
    }
  }

  function close() {
    if (!pop || !built) return;
    built.wrap.classList.remove('open');
    const p = pop;
    pop = null;
    closing = { pop: p, timer: setTimeout(() => { closing = null; p(); }, 220) };
  }

  return { open, close, isOpen: () => !!pop };
}
