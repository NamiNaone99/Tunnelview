/*
 * Tunnelview — incoming-connection approval prompt (window.tunnelviewPrompt, src/preload/prompt.js).
 *
 * This window grants remote control of the computer, so accepting must be deliberate:
 *   - Enter / Space NEVER accept (keyboard activation of the button is ignored), so typing
 *     elsewhere when the window pops up can't approve anything by accident.
 *   - Accept is disabled for a short arming delay after the window appears, and a click that
 *     merely focused the window (click-through) is ignored.
 *   - The only shortcut is the explicit Alt+A (⇧⌘A on macOS — never ⌘A, the Select All reflex, or ⌥A,
 *     which types “å”); the A is the key that types “a” on the user's layout (AZERTY too). main never
 *     focuses this window from code (windows.js shows it inactive), so it normally gets the keyboard
 *     only when the user activates it (the OS can also hand it over when a window above it closes).
 *     A shortcut within FOCUS_GUARD_MS of gaining focus is treated as meant for
 *     the previous window: it is ignored AND keyboard accept stays off until the user deliberately
 *     re-activates the window (a click in it, or switching away and back) — never "press again".
 *     Esc dismisses (the safe direction).
 * All peer/viewer strings are untrusted (viewer fields are self-reported over the network):
 * they are sanitized with safeText() and rendered as text nodes only.
 */
import { h, icon, osIcon, safeText } from '../shared/ui.js';
import { describeRequester, isTaggedPeer, canAlwaysAllow, TAGGED_LOGIN } from './identity.js';

const api = window.tunnelviewPrompt || null;
const PERMISSION_KEYS = (window.TunnelviewProtocol && window.TunnelviewProtocol.PERMISSION_KEYS) || ['control', 'clipboard', 'files', 'audio'];

const ARM_DELAY_MS = 900; // Accept stays inert this long after the request is shown
const FOCUS_GUARD_MS = 450; // …and this long after the window gains focus
const EXPIRY_FALLBACK_MS = 4000; // main auto-denies at zero; answer ourselves if it hasn't closed us
const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_R = 15;
const RING_C = 2 * Math.PI * RING_R;
const OS_LABEL = { windows: 'Windows', macos: 'macOS', linux: 'Linux', ios: 'iOS', android: 'Android', other: 'device' };
const TAGS_MAX = 8; // PromptInit.peer.tags: ≤ 8 entries of ≤ 64 chars (main caps them too)
const TAG_LEN_MAX = 64;

const PERM_DEFS = {
  control: { title: 'Control', on: 'Keyboard & mouse', off: 'Off — view only', icon: 'mouse' },
  clipboard: { title: 'Clipboard', on: 'Copy & paste', off: 'Off', icon: 'clipboard' },
  files: { title: 'Files', on: 'Send & receive files', off: 'Off', icon: 'file' },
  audio: { title: 'Audio', on: 'Hear this computer', off: 'Off', icon: 'volume' },
};

const st = {
  init: null,
  phase: 'loading', // loading | ready | sending | done | cancelled | expired | error
  perms: {},
  trust: false,
  armedAt: Infinity,
  focusAt: 0,
  keyLocked: false, // keyboard accept off until the user re-activates the window (see the header)
  blurred: false,
  deadline: 0,
  totalMs: 0,
  timer: 0,
  expiryFallback: 0,
};

const ui = {
  app: document.getElementById('app'),
  main: document.getElementById('pt-main'),
  ring: document.getElementById('pt-ring'),
  acceptBtn: null,
  dismissBtn: null,
  hint: null,
  ringProgress: null,
  ringNum: null,
};

/* ------------------------------------------------------------------ helpers */

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isMac = () => st.init && st.init.hostOs === 'macos';
const OSES = new Set(Object.keys(OS_LABEL));

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** Validate + sanitize PromptInit (see src/preload/prompt.js). Returns null when unusable. */
function normalizeInit(raw) {
  if (!isObj(raw) || typeof raw.requestId !== 'string' || !raw.requestId || raw.requestId.length > 200) return null;
  const peer = isObj(raw.peer) ? raw.peer : {};
  const user = isObj(peer.user) ? peer.user : {};
  const viewer = isObj(raw.viewer) ? raw.viewer : {};
  const defaults = isObj(raw.defaults) ? raw.defaults : {};
  const audioSupported = raw.audioSupported === true;
  const version = typeof viewer.version === 'string' && /^[0-9A-Za-z.+-]{1,32}$/.test(viewer.version) ? viewer.version : '';
  const timeout = Number(raw.timeoutSec);
  const rawTags = Array.isArray(peer.tags) ? peer.tags : [];
  const tags = rawTags.filter((t) => typeof t === 'string').slice(0, TAGS_MAX).map((t) => safeText(t, TAG_LEN_MAX)).filter(Boolean);
  return {
    requestId: raw.requestId,
    peer: {
      ip: safeText(peer.ip, 64),
      hostname: safeText(peer.hostname, 63),
      os: OSES.has(peer.os) ? peer.os : 'other',
      user: { login: safeText(user.login, 80), displayName: safeText(user.displayName, 64) },
      stableId: typeof peer.stableId === 'string' ? peer.stableId : '',
      tags,
      // Fail closed: any non-empty tags list marks the node as tagged, even if no entry survives
      // cleaning; without tags (older main) the 'tagged-devices' pseudo-user is the signal.
      tagged: rawTags.length > 0 || user.login === TAGGED_LOGIN,
      sameUser: peer.sameUser === true,
      isSelf: peer.isSelf === true,
    },
    viewer: { hostname: safeText(viewer.hostname, 63), version },
    timeoutSec: Number.isFinite(timeout) && timeout > 0 ? Math.min(600, Math.round(timeout)) : 30,
    // Strict: a permission is only pre-enabled when main explicitly says so.
    defaults: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, defaults[k] === true && (k !== 'audio' || audioSupported)])),
    audioSupported,
    hostOs: raw.hostOs === 'macos' ? 'macos' : 'windows',
  };
}

/* ------------------------------------------------------------------ rendering */

function renderMark() {
  document.getElementById('pt-mark').replaceChildren(icon('logo', { size: 16 }));
}

function renderRing() {
  const svg = svgEl('svg', { viewBox: '0 0 36 36', width: 36, height: 36, 'aria-hidden': 'true', class: 'ring-svg' });
  svg.appendChild(svgEl('circle', { cx: 18, cy: 18, r: RING_R, class: 'ring-track' }));
  ui.ringProgress = svgEl('circle', {
    cx: 18, cy: 18, r: RING_R, class: 'ring-progress',
    'stroke-dasharray': RING_C.toFixed(2), 'stroke-dashoffset': '0', transform: 'rotate(-90 18 18)',
  });
  svg.appendChild(ui.ringProgress);
  ui.ringNum = h('span', { class: 'ring-num' });
  ui.ring.replaceChildren(svg, ui.ringNum);
}

function render(init) {
  const p = init.peer;
  // Self-connections are NOT a verified "you": any local app or OS user can make one.
  const { name, login, note, badges: badgeDefs } = describeRequester(p);

  const badges = badgeDefs.map((b) => h('span', { class: b.tone && b.tone !== 'neutral' ? `badge badge-${b.tone}` : 'badge', title: b.title || null },
    icon(b.icon, { size: 12 }), b.text));
  if (init.viewer.version) badges.push(h('span', { class: 'badge', title: 'Tunnelview version reported by the viewer' }, `Tunnelview ${init.viewer.version}`));

  const who = h('section', { class: p.isSelf ? 'pt-who is-self' : 'pt-who' },
    h('div', { class: 'pt-avatar', title: OS_LABEL[p.os] }, osIcon(p.os, { size: 26 })),
    h('div', { class: 'pt-id' },
      h('div', { class: 'pt-name ellipsis', title: name }, name),
      login ? h('div', { class: 'pt-login ellipsis', title: login }, login) : null,
      note ? h('div', { class: 'pt-note', id: 'pt-note' }, note) : null,
      // Only the hostname may be shortened — the verified Tailscale IP always stays visible.
      h('div', { class: 'pt-from', id: 'pt-desc' },
        // (edge spaces keep the accessible text readable; they collapse visually in flex items)
        h('span', { class: 'pt-from-lead' }, 'wants to connect from '),
        h('b', { title: p.hostname }, p.hostname || 'an unnamed device'),
        p.ip ? h('span', { class: 'mono pt-ip' }, ` · ${p.ip}`) : null)));

  // Permissions
  st.perms = { ...init.defaults };
  const keys = PERMISSION_KEYS.filter((k) => PERM_DEFS[k] && (k !== 'audio' || init.audioSupported));
  const tiles = keys.map((k) => {
    const def = PERM_DEFS[k];
    const input = h('input', { type: 'checkbox', 'aria-label': `${def.title}: ${def.on}` });
    input.checked = !!st.perms[k];
    const sub = h('span', { class: 'pt-perm-sub' }, input.checked ? def.on : def.off);
    const tile = h('label', { class: input.checked ? 'toggle pt-perm on' : 'toggle pt-perm' },
      input, h('span'),
      h('div', { class: 'pt-perm-icon' }, icon(def.icon, { size: 16 })),
      h('div', { class: 'pt-perm-text' }, h('span', { class: 'pt-perm-title' }, def.title), sub));
    input.addEventListener('change', () => {
      st.perms[k] = input.checked;
      sub.textContent = input.checked ? def.on : def.off;
      tile.classList.toggle('on', input.checked);
    });
    return tile;
  });

  // Trust ("always allow"): meaningless for this computer itself (self is always prompted) and for
  // tagged nodes, which the host never auto-accepts (ARCHITECTURE §4 "Trusted").
  const canTrust = canAlwaysAllow(p);
  const trustInput = h('input', { type: 'checkbox' });
  trustInput.addEventListener('change', () => { st.trust = trustInput.checked; });
  let trust = null;
  if (canTrust) {
    trust = h('label', { class: 'check pt-trust' }, trustInput,
      h('span', null, 'Always allow this device ', h('span', { class: 'faint' }, '(auto-accept in future, for anyone using it)')));
  } else if (!p.isSelf && isTaggedPeer(p)) {
    trust = h('div', { class: 'pt-trust-note' }, icon('info', { size: 14 }), 'Tagged devices can’t be set to always allow.');
  }

  const mac = init.hostOs === 'macos';
  ui.dismissBtn = h('button', { class: 'btn btn-lg pt-dismiss', type: 'button', onClick: () => respond(false) },
    'Dismiss', h('span', { class: 'kbd' }, 'Esc'));
  ui.acceptBtn = h('button', {
    class: 'btn btn-primary btn-lg pt-accept', type: 'button', disabled: true,
    'aria-keyshortcuts': acceptAria(mac),
  }, icon('check'), 'Accept', h('span', { class: 'kbd kbd-accent' }, acceptLabel(mac)));
  ui.acceptBtn.addEventListener('click', onAcceptClick);
  // Swallow keyboard activation keys on the Accept button entirely.
  for (const type of ['keydown', 'keyup']) {
    ui.acceptBtn.addEventListener(type, (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        if (type === 'keydown') showHint(`Click Accept or press ${acceptLabel(mac)}`);
      }
    });
  }
  ui.hint = h('div', { class: 'pt-hint', role: 'status', 'aria-live': 'polite' });

  // (replaceChildren() would stringify a null, so the optional trust row is filtered out.)
  ui.main.replaceChildren(...[
    who,
    h('div', { class: 'pt-badges' }, badges),
    h('div', { class: 'pt-section' },
      h('div', { class: 'label' }, 'Allow'),
      h('div', { class: `pt-perms n${tiles.length}` }, tiles)),
    trust,
    h('div', { class: 'spacer' }),
    h('footer', { class: 'pt-foot' }, ui.hint, h('span', { class: 'spacer' }), ui.dismissBtn, ui.acceptBtn),
  ].filter(Boolean));
  ui.main.setAttribute('aria-busy', 'false');
  if (note) ui.app.setAttribute('aria-describedby', 'pt-note pt-desc'); // screen readers hear the warning too
}

function showOverlay(kind, title, text, { action = null } = {}) {
  const ICONS = { done: 'check-circle', dismissed: 'x', cancelled: 'info', expired: 'clock', error: 'alert' };
  const old = ui.app.querySelector('.pt-overlay');
  if (old) old.remove();
  ui.app.appendChild(h('div', { class: `pt-overlay is-${kind}`, role: 'status', 'aria-live': 'assertive' },
    h('div', { class: 'pt-overlay-icon' }, icon(ICONS[kind] || 'info', { size: 26 })),
    h('div', { class: 'pt-overlay-title' }, title),
    text ? h('div', { class: 'pt-overlay-text' }, text) : null,
    action));
  ui.ring.classList.add('is-stopped'); // a frozen countdown would be misleading
  setControlsDisabled(true);
}

let hintTimer = 0;
function showHint(text) {
  if (!ui.hint) return;
  ui.hint.textContent = text;
  ui.hint.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => ui.hint && ui.hint.classList.remove('show'), 2600);
}

function setControlsDisabled(disabled) {
  for (const el of ui.main.querySelectorAll('button, input')) el.disabled = disabled;
}

/* ------------------------------------------------------------------ countdown */

function startCountdown(timeoutSec) {
  st.totalMs = timeoutSec * 1000;
  st.deadline = performance.now() + st.totalMs;
  let lastSec = -1;
  const tick = () => {
    const remaining = Math.max(0, st.deadline - performance.now());
    const frac = st.totalMs ? remaining / st.totalMs : 0;
    ui.ringProgress.setAttribute('stroke-dashoffset', (RING_C * (1 - frac)).toFixed(2));
    const sec = Math.ceil(remaining / 1000);
    if (sec !== lastSec) {
      lastSec = sec;
      ui.ringNum.textContent = String(sec);
      ui.ring.setAttribute('aria-label', `Declines automatically in ${sec} second${sec === 1 ? '' : 's'}`);
      ui.ring.classList.toggle('is-warn', sec <= 10 && sec > 5);
      ui.ring.classList.toggle('is-danger', sec <= 5);
    }
    if (remaining <= 0) {
      clearInterval(st.timer);
      onExpired();
    }
  };
  tick();
  st.timer = setInterval(tick, 200);
}

function stopCountdown() {
  clearInterval(st.timer);
  clearTimeout(st.expiryFallback);
}

/* ------------------------------------------------------------------ keyboard accept */

/**
 * ⇧⌘A on macOS (never ⌘A = Select All, never ⌥A = “å”), Alt+A elsewhere (AltGr = Ctrl+Alt excluded).
 * "A" is the key that types a Latin a on the current layout (AZERTY: the KeyQ position); layouts
 * that type no Latin letter there (Thai, Cyrillic, IME) fall back to the physical KeyA.
 */
export function isAcceptChord(e, mac) {
  if (!e || e.ctrlKey) return false;
  const k = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  const isA = /^[a-z]$/.test(k) ? k === 'a' : e.code === 'KeyA';
  if (!isA) return false;
  return mac ? (e.metaKey === true && e.shiftKey === true && !e.altKey) : (e.altKey === true && !e.metaKey && !e.shiftKey);
}
const acceptLabel = (mac) => (mac ? '⇧⌘A' : 'Alt+A');
const acceptAria = (mac) => (mac ? 'Shift+Meta+A' : 'Alt+A');

/* ------------------------------------------------------------------ actions */

function onAcceptClick(e) {
  // Keyboard/AT activation produces detail 0 (and untrusted events come from scripts): ignore.
  if (!e.isTrusted || e.detail === 0) {
    showHint(`Click Accept or press ${acceptLabel(isMac())}`);
    return;
  }
  // The click that brought this window to the front is not a decision.
  if (performance.now() - st.focusAt < FOCUS_GUARD_MS) {
    showHint('Click Accept again to confirm');
    return;
  }
  tryAccept();
}

function tryAccept() {
  if (st.phase !== 'ready') return;
  if (performance.now() < st.armedAt) {
    showHint('One moment…');
    return;
  }
  respond(true);
}

async function respond(accept) {
  if (!api) return;
  if (st.phase === 'error') {
    // Malformed request: we can only decline.
    try { await api.respond({ accept: false }); } catch { /* window is closed by main */ }
    return;
  }
  if (st.phase !== 'ready') return;
  st.phase = 'sending';
  setControlsDisabled(true);
  const btn = accept ? ui.acceptBtn : ui.dismissBtn;
  btn.replaceChildren(h('span', { class: `spinner spinner-sm${accept ? ' spinner-on-accent' : ''}` }), accept ? 'Accepting…' : 'Dismissing…');

  const answer = accept
    ? {
      accept: true,
      permissions: Object.fromEntries(PERMISSION_KEYS.map((k) => [k, !!st.perms[k] && (k !== 'audio' || st.init.audioSupported)])),
      // Never for self or tagged nodes, whatever the checkbox state (main and the host refuse too).
      trust: !!st.trust && canAlwaysAllow(st.init.peer),
    }
    : { accept: false };

  try {
    const res = await api.respond(answer);
    // Main resolves {ok:false} (instead of throwing) when the request is no longer pending.
    if (res && res.ok === false) {
      st.phase = 'done';
      stopCountdown();
      showOverlay('expired', 'Request no longer pending', 'It was withdrawn or timed out before your answer arrived. Nothing was shared.');
      return;
    }
    st.phase = 'done';
    stopCountdown();
    if (accept) showOverlay('done', 'Accepted', 'Starting the session… a session panel will stay visible while they are connected.');
    else showOverlay('dismissed', 'Request declined', null);
  } catch (err) {
    console.error('[Tunnelview] prompt respond failed', err);
    st.phase = 'ready';
    setControlsDisabled(false);
    ui.acceptBtn.disabled = performance.now() < st.armedAt;
    restoreButtons();
    showHint('Couldn’t send your answer. The request may have expired.');
  }
}

function restoreButtons() {
  const mac = isMac();
  ui.dismissBtn.replaceChildren('Dismiss', h('span', { class: 'kbd' }, 'Esc'));
  ui.acceptBtn.replaceChildren(icon('check'), 'Accept', h('span', { class: 'kbd kbd-accent' }, acceptLabel(mac)));
}

function onCancelled() {
  if (st.phase === 'done' || st.phase === 'cancelled') return;
  const wasLoading = st.phase === 'loading';
  st.phase = 'cancelled';
  stopCountdown();
  if (!wasLoading) showOverlay('cancelled', 'Request withdrawn', 'The other side cancelled, signed in with the password, or the request expired.');
}

function onExpired() {
  if (st.phase !== 'ready') return;
  st.phase = 'expired';
  showOverlay('expired', 'Request expired', 'Nobody answered in time, so the connection was declined.');
  // Main denies with reason 'timeout' and closes this window; if it hasn't after a moment, decline explicitly.
  st.expiryFallback = setTimeout(() => {
    api.respond({ accept: false }).catch(() => {});
  }, EXPIRY_FALLBACK_MS);
}

function fail(message) {
  st.phase = 'error';
  stopCountdown();
  ui.main.replaceChildren();
  ui.main.setAttribute('aria-busy', 'false');
  ui.ring.replaceChildren();
  const btn = h('button', { class: 'btn', type: 'button', onClick: () => { respond(false); setTimeout(() => window.close(), 300); } }, 'Dismiss');
  showOverlay('error', 'Couldn’t show this request', message, { action: btn });
  btn.disabled = !api;
}

/* ------------------------------------------------------------------ boot */

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    if (st.phase === 'ready' || st.phase === 'error') respond(false);
    return;
  }
  if (isAcceptChord(e, isMac())) {
    e.preventDefault();
    // Only a real keystroke (not a synthetic event), not auto-repeat from a held key, and not one
    // typed into whatever had focus a moment before this window took it.
    if (!e.isTrusted || e.repeat) return;
    if (st.keyLocked || performance.now() - st.focusAt < FOCUS_GUARD_MS) {
      // Most likely a shortcut meant for the window that had the keyboard a moment ago (Zoom mute,
      // tab search…): do not invite the same keystroke again.
      st.keyLocked = true;
      showHint('Shortcut ignored: this window had only just opened. Click Accept.');
      return;
    }
    tryAccept();
    return;
  }
  // Enter must never accept: block it while Accept has focus (other buttons behave normally).
  if (e.key === 'Enter' && document.activeElement === ui.acceptBtn) e.preventDefault();
}, true);

window.addEventListener('blur', () => { st.blurred = true; });
window.addEventListener('focus', () => {
  st.focusAt = performance.now();
  // Switching away and back is a deliberate re-activation: keyboard accept may work again.
  if (st.blurred) { st.blurred = false; st.keyLocked = false; }
});
// A real click in the window shows the user is dealing with this prompt.
window.addEventListener('pointerdown', (e) => { if (e.isTrusted) st.keyLocked = false; }, true);

async function boot() {
  renderMark();
  if (!api) { fail('The connection to Tunnelview is missing. The request will be declined automatically.'); return; }
  api.onCancelled(onCancelled); // register before ready() so a fast cancel isn't missed

  let raw;
  try {
    raw = await api.ready();
  } catch (err) {
    fail('Tunnelview couldn’t load the details of this request.');
    return;
  }
  if (st.phase === 'cancelled') {
    showOverlay('cancelled', 'Request withdrawn', 'The other side cancelled the request.');
    return;
  }
  const init = normalizeInit(raw);
  if (!init) { fail('The request details were incomplete, so it can’t be accepted.'); return; }

  st.init = init;
  st.phase = 'ready';
  renderRing();
  render(init);
  startCountdown(init.timeoutSec);

  // Arm Accept only after a short delay, so a click already in progress can't land on it.
  st.armedAt = performance.now() + ARM_DELAY_MS;
  if (document.hasFocus()) st.focusAt = performance.now();
  setTimeout(() => { if (st.phase === 'ready') ui.acceptBtn.disabled = false; }, ARM_DELAY_MS);

  // Focus the dialog itself — never a button — so stray keystrokes do nothing.
  ui.app.focus({ preventScroll: true });
}

boot();
