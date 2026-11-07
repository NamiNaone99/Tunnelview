/*
 * Main window — "Your tailnet" device grid: search, filters, probe/refresh, device cards.
 *
 * Peer data (hostnames, user names, tags) is chosen by other tailnet members, so it is only
 * ever rendered as text via h(). Cards are rebuilt when the inputs change; focus is restored.
 */
import { h, icon, osIcon, timeAgo, toast } from '../shared/ui.js';
import {
  api, store, subscribe, loadPeers, saveSettings, connectTo, copyText, tsRunning,
  peerKey, peerName, peerTarget, ipv4Of, OS_NAMES,
} from './store.js';
import { preserveFocus } from './desk.js';

const FILTERS = [
  ['all', 'All'],
  ['ready', 'Tunnelview ready'],
  ['online', 'Online'],
  ['favorites', 'Favorites'],
];
const FILTER_KEY = 'tunnelview.devices.filter';
const DESKTOP = new Set(['windows', 'macos']);

function loadFilter() {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return FILTERS.some(([id]) => id === v) ? v : 'all';
  } catch { return 'all'; }
}
function saveFilter(v) {
  try { localStorage.setItem(FILTER_KEY, v); } catch { /* storage unavailable — not important */ }
}

const isReady = (p) => p.online && !!p.tunnelview && !p.tunnelview.busy;

/**
 * Badge for an online desktop peer where the probe found no usable Tunnelview (PeerInfo.probe).
 * A timeout usually means something in between drops the TCP connection, not that Tunnelview is off.
 */
export function probeBadgeInfo(probe) {
  if (probe === 'timeout') {
    return { text: 'No answer', cls: 'badge badge-warn', title: 'Tunnelview may be blocked by a Tailscale ACL or firewall (TCP port)' };
  }
  if (probe === 'not-allowed') {
    return { text: 'Not allowed', cls: 'badge badge-warn', title: 'Tunnelview is running there, but its “Who can connect” setting excludes you' };
  }
  if (probe === 'incompatible') {
    return { text: 'Update needed', cls: 'badge badge-warn', title: 'Tunnelview is running there, but it is a different version — update both devices' };
  }
  return { text: 'Not running', cls: 'badge', title: 'Tunnelview did not answer on this device' };
}
function probeBadge(probe) {
  const b = probeBadgeInfo(probe);
  return h('span', { class: b.cls, title: b.title }, b.text);
}
const isUnsupported = (p) => !p.tunnelview && !DESKTOP.has(p.os);

export function mountDevices(root) {
  const ui = { search: '', filter: loadFilter() };
  const connecting = new Set();

  const searchInput = h('input', {
    class: 'input', type: 'search', id: 'device-search', placeholder: 'Search name, person or IP',
    'aria-label': 'Search devices', spellcheck: 'false', autocomplete: 'off', maxlength: 120,
  });
  searchInput.addEventListener('input', () => { ui.search = searchInput.value; render(); });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && searchInput.value) { e.stopPropagation(); searchInput.value = ''; ui.search = ''; render(); }
  });

  const refreshBtn = h('button', {
    class: 'btn btn-icon', type: 'button', title: 'Refresh and check which devices run Tunnelview (F5)', 'aria-label': 'Refresh devices',
    onClick: () => loadPeers({ probe: true }),
  }, icon('refresh'));
  const countEl = h('span', { class: 'count-pill', hidden: true });
  const chipsEl = h('div', { class: 'filter-chips', role: 'tablist', 'aria-label': 'Filter devices' });
  const noticeEl = h('div', { class: 'devices-notice', hidden: true });
  const gridEl = h('div', { class: 'device-grid', role: 'list', 'aria-live': 'polite', 'aria-busy': 'false' });

  root.replaceChildren(
    h('div', { class: 'section-head devices-head' },
      h('h2', { id: 'devices-title' }, icon('network', { size: 16 }), 'Your tailnet'),
      countEl,
      h('span', { class: 'spacer' }),
      h('div', { class: 'search-field' }, icon('search', { className: 'search-icon' }), searchInput),
      refreshBtn),
    chipsEl,
    noticeEl,
    gridEl);

  /* -------------------------------------------------------------- actions */

  async function connect(p) {
    const key = peerKey(p);
    if (connecting.has(key)) return;
    const target = peerTarget(p);
    if (!target) return;
    connecting.add(key);
    render(true);
    await connectTo({ target, label: peerName(p) });
    connecting.delete(key);
    render(true);
  }

  async function toggleFavorite(p) {
    if (!p.stableId) return;
    let adding = false;
    // Read-modify-write inside the save queue so rapid clicks toggle from the latest list.
    const saved = await saveSettings((s) => {
      const favs = new Set(s.favorites);
      adding = !favs.has(p.stableId);
      if (adding) favs.add(p.stableId); else favs.delete(p.stableId);
      return { favorites: [...favs] };
    });
    if (saved) toast(adding ? `${peerName(p)} added to favorites` : `${peerName(p)} removed from favorites`, { kind: 'ok', timeout: 1600 });
  }

  /* -------------------------------------------------------------- rendering */

  function matches(p, q) {
    if (!q) return true;
    const hay = [peerName(p), p.hostname, p.dnsName, p.user.login, p.user.displayName, OS_NAMES[p.os], ...p.ips, ...p.tags]
      .join('\n').toLowerCase();
    return q.split(/\s+/).every((t) => hay.includes(t));
  }

  function sortPeers(list, favs) {
    return [...list].sort((a, b) =>
      (favs.has(b.stableId) - favs.has(a.stableId))
      || (isReady(b) - isReady(a))
      || (b.online - a.online)
      || (isUnsupported(a) - isUnsupported(b))
      || peerName(a).localeCompare(peerName(b), undefined, { sensitivity: 'base', numeric: true }));
  }

  let lastSig = '';
  function render(force = false) {
    const pr = store.peers;
    const running = tsRunning();
    const favs = new Set(store.settings.favorites);
    const sig = JSON.stringify([
      store.state.tailscale.state, store.state.loaded, pr.list, pr.loading, pr.probing, pr.probed, pr.error,
      ui.search, ui.filter, [...favs], [...connecting], Math.floor(Date.now() / 60000),
    ]);
    if (!force && sig === lastSig) return;
    lastSig = sig;

    const busy = pr.loading || pr.probing;
    refreshBtn.disabled = !running || busy;
    refreshBtn.firstElementChild.classList.toggle('spinning', busy && running);
    searchInput.disabled = !running;
    gridEl.setAttribute('aria-busy', String(busy));
    const known = store.state.loaded && store.state.tailscale.state !== 'unknown';
    root.classList.toggle('is-disabled', !running && known);

    // Tailscale down → the grid is disabled (the banner above explains why).
    if (!running) {
      countEl.hidden = true;
      chipsEl.replaceChildren();
      noticeEl.hidden = true;
      gridEl.replaceChildren(...(known
        ? [emptyState('plug', 'Device list unavailable', 'Your tailnet devices appear here once Tailscale is connected.')]
        : skeletons(3)));
      return;
    }

    const list = pr.list || [];
    const counts = {
      all: list.length,
      ready: list.filter(isReady).length,
      online: list.filter((p) => p.online).length,
      favorites: list.filter((p) => favs.has(p.stableId)).length,
    };
    countEl.hidden = pr.list === null;
    countEl.textContent = `${counts.online} online · ${counts.all}`;
    countEl.title = `${counts.online} of ${counts.all} devices online`;

    chipsEl.replaceChildren(...FILTERS.map(([id, label]) => h('button', {
      type: 'button', role: 'tab', class: ui.filter === id ? 'filter-chip active' : 'filter-chip',
      'aria-selected': String(ui.filter === id), dataset: { fid: `filter-${id}` },
      onClick: () => { ui.filter = id; saveFilter(id); render(); },
    }, id === 'favorites' ? icon('star', { size: 13 }) : id === 'ready' ? h('span', { class: 'dot dot-ok' }) : null,
    label,
    pr.list ? h('span', { class: 'filter-count' }, String(counts[id])) : null)));

    // Inline error when we still have (stale) data to show.
    if (pr.error && pr.list) {
      noticeEl.hidden = false;
      noticeEl.replaceChildren(h('div', { class: 'banner banner-danger small' }, icon('alert'),
        h('div', { class: 'grow' }, `Couldn’t refresh the device list: ${pr.error}`),
        h('button', { class: 'btn btn-sm', type: 'button', onClick: () => loadPeers({ probe: true }) }, 'Retry')));
    } else noticeEl.hidden = true;

    preserveFocus(gridEl, () => gridEl.replaceChildren(...buildGrid(list, favs, counts)));
  }

  function buildGrid(list, favs, counts) {
    const pr = store.peers;
    if (pr.list === null) {
      if (pr.error) {
        return [emptyState('alert', 'Couldn’t load your devices', pr.error,
          h('button', { class: 'btn', type: 'button', onClick: () => loadPeers({ probe: true }) }, icon('refresh'), 'Try again'))];
      }
      return skeletons(6);
    }
    if (!list.length) {
      return [emptyState('network', 'No other devices yet',
        'Install Tailscale on another computer and sign in to the same tailnet. It will show up here automatically.',
        h('button', { class: 'btn', type: 'button', onClick: () => api.openTailscaleAdmin().catch(() => {}) }, icon('external'), 'Open admin console'))];
    }

    const q = ui.search.trim().toLowerCase();
    let shown = list.filter((p) => matches(p, q));
    if (ui.filter === 'ready') shown = shown.filter(isReady);
    else if (ui.filter === 'online') shown = shown.filter((p) => p.online);
    else if (ui.filter === 'favorites') shown = shown.filter((p) => favs.has(p.stableId));

    if (!shown.length) {
      if (q) {
        return [emptyState('search', `No devices match “${ui.search.trim().slice(0, 60)}”`, 'Try a different name, person or IP address.',
          h('button', { class: 'btn', type: 'button', onClick: () => { searchInput.value = ''; ui.search = ''; render(); searchInput.focus(); } }, 'Clear search'))];
      }
      if (ui.filter === 'ready') {
        return [pr.probing && !pr.probed
          ? emptyState('search', 'Looking for Tunnelview…', 'Checking which devices in your tailnet are running Tunnelview.')
          : emptyState('monitor', 'No Tunnelview devices yet',
            'Install Tunnelview on another Windows PC or Mac in your tailnet and leave it running. It will show a Ready badge here.')];
      }
      if (ui.filter === 'favorites') return [emptyState('star', 'No favorites yet', 'Star a device to pin it to the top of the list.')];
      if (ui.filter === 'online') return [emptyState('plug', 'No devices online', `All ${counts.all} devices in your tailnet are offline right now.`)];
    }
    return sortPeers(shown, favs).map((p) => card(p, favs.has(p.stableId)));
  }

  function card(p, fav) {
    const pr = store.peers;
    const key = peerKey(p);
    const name = peerName(p);
    const v4 = ipv4Of(p.ips);
    const unsupported = isUnsupported(p);
    const busy = connecting.has(key);
    const target = peerTarget(p);
    const canConnect = p.online && !unsupported && !!target && !busy;
    const who = p.tags.length ? p.tags.join(', ') : (p.user.displayName || p.user.login || '');

    // Tunnelview badge
    let badge;
    if (unsupported) badge = h('span', { class: 'small faint dc-na' }, 'Tunnelview host not available');
    else if (!p.online) badge = h('span', { class: 'badge' }, 'Offline');
    else if (p.tunnelview && p.tunnelview.busy) badge = h('span', { class: 'badge badge-warn', title: 'Someone is already connected to this device' }, 'Busy');
    else if (p.tunnelview && p.tunnelview.passwordSet) badge = h('span', { class: 'badge badge-ok', title: 'Tunnelview is running · unattended password set' }, icon('lock', { size: 11 }), 'Password set');
    else if (p.tunnelview) badge = h('span', { class: 'badge badge-ok', title: p.tunnelview.version ? `Tunnelview ${p.tunnelview.version}` : 'Tunnelview is running' }, 'Ready');
    else if (!pr.probed) badge = pr.probing ? h('span', { class: 'badge skel-badge' }, 'Checking…') : h('span', { class: 'badge' }, 'Unknown');
    else badge = probeBadge(p.probe);

    const status = p.online
      ? h('span', { class: 'dc-status' }, h('span', { class: 'dot dot-ok' }), 'Online')
      : h('span', { class: 'dc-status faint' }, h('span', { class: 'dot' }),
        p.lastSeen && timeAgo(p.lastSeen) ? `Offline · ${timeAgo(p.lastSeen)}` : 'Offline');

    const ipBtn = v4
      ? h('button', {
        class: 'dc-ip mono', type: 'button', title: 'Copy Tailscale IP', 'aria-label': `Copy IP address ${v4}`,
        dataset: { fid: `ip-${key}` },
        onClick: (e) => { e.stopPropagation(); copyText(v4, 'IP address'); },
      }, v4, icon('copy', { size: 12 }))
      : h('span', { class: 'dc-ip mono faint' }, p.ips[0] || '—');

    const connectBtn = h('button', {
      class: 'btn btn-sm btn-primary dc-connect', type: 'button', disabled: !canConnect,
      dataset: { fid: `connect-${key}` },
      title: unsupported ? 'Tunnelview runs on Windows and macOS' : !p.online ? 'This device is offline' : `Connect to ${name}`,
      onClick: (e) => { e.stopPropagation(); connect(p); },
    }, busy ? h('span', { class: 'spinner spinner-sm spinner-on-accent' }) : null, busy ? 'Connecting…' : 'Connect');

    const starBtn = h('button', {
      class: fav ? 'dc-star is-fav' : 'dc-star', type: 'button', disabled: !p.stableId,
      'aria-pressed': String(fav), 'aria-label': fav ? `Remove ${name} from favorites` : `Add ${name} to favorites`,
      title: fav ? 'Remove from favorites' : 'Add to favorites', dataset: { fid: `star-${key}` },
      onClick: (e) => { e.stopPropagation(); toggleFavorite(p); },
    }, icon(fav ? 'star-fill' : 'star', { size: 16 }));

    const el = h('article', {
      class: ['device-card', !p.online && 'is-offline', unsupported && 'is-dim', isReady(p) && 'is-ready'],
      role: 'listitem', tabindex: '0', 'aria-label': `${name}, ${p.online ? 'online' : 'offline'}`,
      dataset: { fid: `card-${key}` },
      // Double-click on the card body connects; double-clicks on its own buttons (star, IP) must not.
      onDblclick: (e) => { if (canConnect && !e.target.closest('button')) connect(p); },
      onKeydown: (e) => { if (e.key === 'Enter' && e.target === el && canConnect) { e.preventDefault(); connect(p); } },
    },
    h('div', { class: 'dc-head' },
      h('span', { class: 'dc-avatar', title: OS_NAMES[p.os] }, osIcon(p.os, { size: 20 }), p.online ? h('span', { class: 'dc-online' }) : null),
      h('div', { class: 'dc-title' },
        h('div', { class: 'dc-name ellipsis', title: p.dnsName || name }, name),
        h('div', { class: 'dc-user ellipsis', title: who }, who || OS_NAMES[p.os])),
      starBtn),
    h('div', { class: 'dc-meta' }, ipBtn, status),
    h('div', { class: 'dc-foot' }, badge, h('span', { class: 'spacer' }), connectBtn));
    return el;
  }

  function skeletons(n) {
    return Array.from({ length: n }, () => h('div', { class: 'device-card skel-card', 'aria-hidden': 'true' },
      h('div', { class: 'dc-head' }, h('div', { class: 'skel skel-avatar' }), h('div', { class: 'grow col gap-4' }, h('div', { class: 'skel skel-line w70' }), h('div', { class: 'skel skel-line w45' }))),
      h('div', { class: 'skel skel-line w55' }),
      h('div', { class: 'dc-foot' }, h('div', { class: 'skel skel-pill' }), h('span', { class: 'spacer' }), h('div', { class: 'skel skel-btn' }))));
  }

  function emptyState(iconName, title, text, action = null) {
    return h('div', { class: 'empty devices-empty' },
      h('span', { class: 'empty-icon' }, icon(iconName, { size: 22 })),
      h('div', { class: 'strong empty-title' }, title),
      h('div', { class: 'small empty-text' }, text),
      action);
  }

  subscribe('peers', render);
  subscribe('state', render);
  subscribe('settings', render);
  setInterval(render, 60000); // keep "last seen" fresh
  render();

  return {
    focusSearch() { if (!searchInput.disabled) { searchInput.focus(); searchInput.select(); } },
  };
}
