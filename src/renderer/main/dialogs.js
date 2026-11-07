/*
 * Main window — overlay layers (settings sheet, modals) + reusable dialogs.
 *
 * Layers are appended to <body>; everything else in <body> (except the toast host) is made
 * `inert` while a layer is on top, which gives a real focus trap and blocks clicks/keys behind it.
 */
import { h, icon, toast } from '../shared/ui.js';
import {
  api, errMsg, refreshSettings, copyText, canPair, normPairingOffer, normPairingStatus, PAIRING_ERRORS, OS_NAMES,
} from './store.js';

const stack = [];

function syncInert() {
  const top = stack[stack.length - 1] || null;
  for (const child of document.body.children) {
    if (child.classList.contains('toast-host')) continue;
    child.inert = top ? child !== top.el : false;
  }
}

/** Put `el` on top. onEscape() is called for Esc while it is the top layer. Returns pop(). */
export function pushLayer(el, { onEscape } = {}) {
  const layer = { el, onEscape, prevFocus: document.activeElement };
  stack.push(layer);
  document.body.appendChild(el);
  syncInert();
  return () => {
    const i = stack.indexOf(layer);
    if (i < 0) return;
    stack.splice(i, 1);
    el.remove();
    syncInert();
    const pf = layer.prevFocus;
    if (pf && pf.isConnected && typeof pf.focus === 'function' && !pf.closest('[inert]')) pf.focus({ preventScroll: true });
  };
}

export const hasLayer = () => stack.length > 0;

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !stack.length) return;
  const top = stack[stack.length - 1];
  if (typeof top.onEscape === 'function') {
    e.preventDefault();
    e.stopPropagation();
    top.onEscape();
  }
}, true);

let uid = 0;

/**
 * Generic modal. actions: [{ label, kind:'primary'|'danger'|'ghost'|'', onClick(modal) → bool|Promise<bool> (true = close), id }]
 * Returns { close, setBusy, el, buttons }.
 */
export function openModal({ title, iconName = null, tone = 'accent', body = null, actions = [], onClose = null, initialFocus = null }) {
  const titleId = `modal-title-${++uid}`;
  let closed = false;
  let busy = false;
  const buttons = {};

  const footer = h('div', { class: 'modal-foot' });
  const card = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'modal-head' },
      iconName ? h('div', { class: `modal-icon tone-${tone}` }, icon(iconName, { size: 20 })) : null,
      h('h2', { id: titleId }, title),
      h('button', { class: 'btn btn-ghost btn-icon btn-sm modal-x', type: 'button', 'aria-label': 'Close', onClick: () => close() }, icon('x'))),
    body ? h('div', { class: 'modal-body' }, body) : null,
    footer);
  const wrap = h('div', { class: 'layer modal-layer' },
    h('div', { class: 'scrim', onClick: () => close() }),
    card);

  const modal = {
    el: card,
    buttons,
    close,
    setBusy(on) {
      busy = !!on;
      for (const b of Object.values(buttons)) b.disabled = busy;
      card.classList.toggle('is-busy', busy);
    },
  };

  for (const a of actions) {
    const b = h('button', {
      type: 'button',
      class: ['btn', a.kind === 'primary' && 'btn-primary', a.kind === 'danger' && 'btn-danger', a.kind === 'ghost' && 'btn-ghost'],
      onClick: async () => {
        if (busy) return;
        let shouldClose = true;
        if (typeof a.onClick === 'function') shouldClose = await a.onClick(modal);
        if (shouldClose !== false) close();
      },
    }, a.label);
    buttons[a.id || a.label] = b;
    footer.appendChild(b);
  }

  const pop = pushLayer(wrap, { onEscape: () => close() });
  requestAnimationFrame(() => wrap.classList.add('open'));

  function close(result) {
    if (closed || busy) return;
    closed = true;
    wrap.classList.remove('open');
    setTimeout(pop, 160);
    if (typeof onClose === 'function') onClose(result);
  }

  // Focus: explicit element (or fn(modal) → element), else first field, else the last button.
  queueMicrotask(() => {
    const explicit = typeof initialFocus === 'function' ? initialFocus(modal) : initialFocus;
    const target = explicit || card.querySelector('input, select, textarea') || footer.querySelector('button:last-child');
    if (target) target.focus();
  });
  return modal;
}

/** Yes/no confirmation. @returns {Promise<boolean>} */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, iconName = 'alert' }) {
  return new Promise((resolve) => {
    let answered = false;
    openModal({
      title,
      iconName,
      tone: danger ? 'danger' : 'warn',
      body: h('p', { class: 'dim' }, message),
      actions: [
        { label: 'Cancel', id: 'cancel', onClick: () => true },
        { label: confirmLabel, id: 'ok', kind: danger ? 'danger' : 'primary', onClick: () => { answered = true; return true; } },
      ],
      onClose: () => resolve(answered),
      // A stray Enter must never trigger a destructive action.
      initialFocus: danger ? (m) => m.buttons.cancel : null,
    });
  });
}

const PW_MIN = 8;
const PW_MAX = 128;

function passwordField(labelText, autocomplete) {
  const input = h('input', { class: 'input', type: 'password', autocomplete, maxlength: PW_MAX, spellcheck: 'false' });
  const eye = h('button', {
    type: 'button', class: 'btn btn-ghost btn-icon btn-sm pw-eye', 'aria-label': 'Show password', tabindex: '-1',
    onClick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      eye.replaceChildren(icon(show ? 'eye-off' : 'eye'));
      eye.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
      input.focus();
    },
  }, icon('eye'));
  const field = h('label', { class: 'field' }, h('span', { class: 'field-label' }, labelText), h('div', { class: 'pw-wrap' }, input, eye));
  return { field, input };
}

/**
 * Set / change the unattended-access password (min 8, max 128 chars) via tunnelview.setPassword().
 * @returns {Promise<boolean>} true when a password was saved.
 */
export function openPasswordDialog({ hasPassword = false } = {}) {
  return new Promise((resolve) => {
    let saved = false;
    const pw = passwordField(hasPassword ? 'New password' : 'Password', 'new-password');
    const confirm = passwordField('Confirm password', 'new-password');
    const ruleLen = h('li', null, icon('check-circle', { size: 14 }), `At least ${PW_MIN} characters`);
    const ruleMatch = h('li', null, icon('check-circle', { size: 14 }), 'Both entries match');
    const errorEl = h('div', { class: 'form-error', role: 'alert', hidden: true });

    const valid = () => {
      const a = pw.input.value;
      return a.length >= PW_MIN && a.length <= PW_MAX && a === confirm.input.value;
    };
    const update = () => {
      const a = pw.input.value;
      ruleLen.classList.toggle('ok', a.length >= PW_MIN);
      ruleMatch.classList.toggle('ok', a.length > 0 && a === confirm.input.value);
      errorEl.hidden = true;
      if (modal.buttons.save) modal.buttons.save.disabled = !valid();
    };

    const body = h('div', { class: 'col gap-12' },
      h('p', { class: 'dim small' },
        'Lets you connect to this computer without anyone accepting. The password never leaves this device — viewers only prove they know it.'),
      pw.field,
      confirm.field,
      h('ul', { class: 'pw-rules' }, ruleLen, ruleMatch),
      errorEl);

    const submit = async (m) => {
      if (!valid()) return false;
      m.setBusy(true);
      m.buttons.save.replaceChildren(h('span', { class: 'spinner spinner-sm' }), 'Saving…');
      let res;
      try {
        res = await api.setPassword(pw.input.value);
      } catch (err) {
        res = { ok: false, error: errMsg(err) };
      }
      m.setBusy(false);
      m.buttons.save.replaceChildren('Save password');
      if (res && res.ok) {
        saved = true;
        toast(hasPassword ? 'Password changed' : 'Unattended access password set', { kind: 'ok' });
        refreshSettings();
        return true;
      }
      errorEl.textContent = res && res.error ? `Couldn't save: ${errMsg(res.error)}` : "Couldn't save the password.";
      errorEl.hidden = false;
      m.buttons.save.disabled = !valid();
      return false;
    };

    const modal = openModal({
      title: hasPassword ? 'Change unattended password' : 'Set unattended password',
      iconName: 'key',
      body,
      actions: [
        { label: 'Cancel', id: 'cancel', onClick: () => true },
        { label: 'Save password', id: 'save', kind: 'primary', onClick: submit },
      ],
      onClose: () => {
        // Don't leave secrets sitting in detached DOM nodes.
        pw.input.value = '';
        confirm.input.value = '';
        resolve(saved);
      },
      initialFocus: pw.input,
    });

    pw.input.addEventListener('input', update);
    confirm.input.addEventListener('input', update);
    confirm.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && valid() && !modal.buttons.save.disabled) {
        e.preventDefault();
        modal.buttons.save.click();
      }
    });
    update();
  });
}

/** Remove the password after confirmation. @returns {Promise<boolean>} */
export async function removePassword({ passwordOnly = false } = {}) {
  const ok = await confirmDialog({
    title: 'Remove unattended password?',
    message: passwordOnly
      ? 'Accept mode is “Password only”, so nobody will be able to connect to this computer until you set a new password or switch to “Ask every time”.'
      : 'Viewers will no longer be able to connect without someone accepting on this computer.',
    confirmLabel: 'Remove password',
    danger: true,
    iconName: 'lock',
  });
  if (!ok) return false;
  try {
    const res = await api.setPassword(null);
    if (!res || !res.ok) throw new Error((res && res.error) || 'Unknown error');
    toast('Unattended access password removed', { kind: 'ok' });
    refreshSettings();
    return true;
  } catch (err) {
    toast(`Couldn't remove the password: ${errMsg(err)}`, { kind: 'danger', timeout: 6000 });
    return false;
  }
}

/* ---------------------------------------------------------------- pairing a phone */

const QR_QUIET_ZONE = 4; // light modules around the symbol (ISO/IEC 18004)
const QR_CSS_PX = 232;
export const PAIRING_NOTE = 'Pairing lets your phone recognise this computer. It does not let anyone in: the password, Who can connect and the approval prompt still decide.';

const PAIR_CANCELLED = {
  session: 'Cancelled because someone connected to this computer.',
  'host-stopped': 'Cancelled because incoming connections stopped.',
  'host-id-changed': 'Cancelled because this computer’s Tailscale identity changed.',
  'identity-reset': 'Cancelled because this computer’s identity was reset.',
  replaced: 'Replaced by a newer code.',
};

/** {size, bits} (main/qr.js) → rows of booleans, true = dark; null when malformed. */
export function qrModules(qr) {
  if (!qr || !Number.isInteger(qr.size) || qr.size < 21 || qr.size > 177 || typeof qr.bits !== 'string') return null;
  let bin;
  try { bin = atob(qr.bits); } catch { return null; }
  if (bin.length !== Math.ceil((qr.size * qr.size) / 8)) return null;
  const rows = [];
  for (let y = 0; y < qr.size; y++) {
    const row = new Array(qr.size);
    for (let x = 0; x < qr.size; x++) {
      const i = y * qr.size + x;
      row[x] = ((bin.charCodeAt(i >>> 3) >>> (7 - (i & 7))) & 1) === 1;
    }
    rows.push(row);
  }
  return rows;
}

/** The window's device pixels per CSS pixel (another monitor or the zoom level changes it). */
function qrDpr() {
  const dpr = Number(globalThis.devicePixelRatio);
  return dpr > 0 && Number.isFinite(dpr) ? Math.min(8, dpr) : 1;
}

/**
 * Draw the symbol: black on white whatever the theme (phone cameras read dark-on-light best),
 * a 4-module quiet zone, and the same whole number of device pixels for every module. The CSS
 * size is set to match the bitmap exactly: a bitmap the browser scales into a fixed box gets
 * modules of uneven width (nearest-neighbour) or blurred edges, which costs scanning margin.
 * @returns {boolean} false when the canvas cannot draw (the link can still be copied)
 */
export function drawQr(canvas, qr) {
  const rows = qrModules(qr);
  const ctx = rows && canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!ctx) return false;
  const total = qr.size + QR_QUIET_ZONE * 2;
  const dpr = qrDpr();
  // Rounded down, so the code stays within QR_CSS_PX (the dialog has to fit the window) unless
  // 2 device pixels per module, the least a camera reads reliably, need more.
  const scale = Math.max(2, Math.floor((QR_CSS_PX * dpr) / total));
  canvas.width = total * scale;
  canvas.height = total * scale;
  if (canvas.style) {
    canvas.style.width = `${(total * scale) / dpr}px`;
    canvas.style.height = canvas.style.width;
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (rows[y][x]) ctx.fillRect((x + QR_QUIET_ZONE) * scale, (y + QR_QUIET_ZONE) * scale, scale, scale);
    }
  }
  return true;
}

/**
 * Paint the whole canvas white. An ended code is cleared rather than faded: a phone scanner that
 * adapts to local contrast still reads a faded symbol, and would then report a dead code.
 * @returns {boolean} false when the canvas cannot draw
 */
export function blankQr(canvas) {
  const ctx = canvas && typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null;
  if (!ctx) return false;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  return true;
}

/**
 * Call fn whenever devicePixelRatio changes (the window moved to another monitor, the zoom
 * changed), so the code is drawn again at whole device pixels. @returns {() => void} stop
 */
function onDprChange(fn) {
  if (typeof globalThis.matchMedia !== 'function') return () => {};
  let mq = null;
  const fire = () => { arm(); fn(); };
  function arm() {
    try {
      mq = globalThis.matchMedia(`(resolution: ${qrDpr()}dppx)`);
      mq.addEventListener('change', fire, { once: true });
    } catch {
      mq = null;
    }
  }
  arm();
  return () => {
    if (mq) mq.removeEventListener('change', fire);
    mq = null;
  };
}

const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Ask main for a pairing offer. @returns {Promise<{offer}|{error}>} */
async function requestOffer() {
  let res;
  try {
    res = await api.startPairing();
  } catch (err) {
    return { error: `Couldn’t start pairing: ${errMsg(err)}` };
  }
  const offer = normPairingOffer(res);
  if (offer) return { offer };
  const code = res && typeof res.code === 'string' ? res.code : '';
  return { error: PAIRING_ERRORS[code] || 'Couldn’t start pairing.' };
}

/**
 * "Pair a phone": a QR code of a pairing link valid for 2 minutes, the computer's name and ID to
 * compare with the phone's confirm sheet, and what happens to the offer as it happens. Closing
 * the dialog withdraws the offer (pairing:cancel), so a code is never usable unseen.
 * @returns {Promise<{paired:boolean}>}
 */
export async function openPairingDialog() {
  if (!canPair()) return { paired: false };
  const first = await requestOffer();
  if (!first.offer) {
    toast(first.error, { kind: 'warn', timeout: 6000 });
    return { paired: false };
  }

  return new Promise((resolve) => {
    let offer = first.offer;
    let ended = false;
    let paired = false;
    let ticker = 0;
    const retired = new Set(); // offers this dialog replaced: their last events are old news

    const QR_LABEL = 'Pairing QR code. Scan it with Tunnelview on your phone.';
    const canvas = h('canvas', { class: 'pair-qr-canvas', role: 'img', 'aria-label': QR_LABEL });
    const qrEnded = h('div', { class: 'pair-qr-ended', 'aria-hidden': 'true', hidden: true });
    const qrBox = h('div', { class: 'pair-qr' }, canvas, qrEnded);
    const qrFallback = h('div', { class: 'pair-qr-fallback small dim', hidden: true }, 'The code can’t be drawn here. Use Copy pairing link instead.');
    const countdown = h('span', { class: 'mono', role: 'timer', 'aria-live': 'off' });
    const expiryLine = h('div', { class: 'pair-expiry small dim' }, 'Expires in ', countdown);
    const nameEl = h('span', { class: 'strong ellipsis selectable' });
    const fpEl = h('span', { class: 'mono selectable pair-fp' });
    const statusEl = h('div', { class: 'pair-status small', role: 'status', 'aria-live': 'polite' });
    const failTitleId = `pair-fail-${++uid}`;
    const failList = h('ul', { class: 'pair-failures small', 'aria-labelledby': failTitleId });
    const failBox = h('div', { class: 'pair-failbox', hidden: true },
      h('div', { class: 'strong small', id: failTitleId }, 'Failed attempts'),
      h('div', { class: 'faint small' }, 'Devices that tried this code with the wrong proof, as Tailscale identifies them.'),
      failList);

    const body = h('div', { class: 'pair col gap-12' },
      h('p', { class: 'pair-lead strong' }, 'Scan with Tunnelview on your phone'),
      qrBox,
      qrFallback,
      expiryLine,
      h('dl', { class: 'pair-facts' },
        h('dt', null, 'Computer'), h('dd', null, nameEl),
        h('dt', null, 'ID'), h('dd', null, fpEl)),
      h('p', { class: 'faint small' }, 'Your phone shows this ID before it pairs. Pair only if both match.'),
      statusEl,
      failBox,
      h('p', { class: 'small dim pair-note' }, PAIRING_NOTE));

    const setStatus = (text, tone = '') => {
      statusEl.className = ['pair-status', 'small', tone && `pair-status-${tone}`].filter(Boolean).join(' ');
      statusEl.textContent = text;
    };

    const stopTicker = () => { clearInterval(ticker); ticker = 0; };

    /** The code is gone from the screen (not just faded), with a word on what happened. */
    function clearCode(label) {
      blankQr(canvas);
      canvas.setAttribute('aria-label', `Pairing QR code: ${label.toLowerCase()}.`);
      qrEnded.textContent = label;
      qrEnded.hidden = false;
      qrBox.classList.add('is-ended');
    }

    function endOffer(text, tone = 'warn') {
      ended = true;
      stopTicker();
      clearCode('Code ended');
      expiryLine.hidden = true;
      modal.buttons.copy.disabled = true;
      modal.buttons.renew.hidden = false;
      setStatus(text, tone);
      // Copy (now disabled) loses the keyboard focus to <body>: hand it to New code instead.
      const active = document.activeElement;
      if (!active || active === document.body || active === modal.buttons.copy) modal.buttons.renew.focus();
    }

    const tick = () => {
      const left = offer.expiresAt - Date.now();
      countdown.textContent = mmss(left);
      if (left <= 0 && !ended) endOffer('This code expired. Make a new one to pair.');
    };

    function showOffer() {
      ended = false;
      paired = false;
      failList.replaceChildren();
      failBox.hidden = true;
      const drawn = drawQr(canvas, offer.qr);
      qrBox.hidden = !drawn;
      qrFallback.hidden = drawn;
      qrBox.classList.remove('is-ended');
      qrEnded.hidden = true;
      canvas.setAttribute('aria-label', QR_LABEL);
      // Only what the link carries: without a MagicDNS name the phone shows the address.
      nameEl.textContent = offer.host.name || offer.host.ips[0] || 'This computer';
      nameEl.title = offer.host.name;
      fpEl.textContent = offer.fingerprint;
      expiryLine.hidden = false;
      setStatus('Waiting for your phone…');
      modal.buttons.copy.hidden = false;
      modal.buttons.copy.disabled = false;
      modal.buttons.renew.hidden = true;
      modal.buttons.close.replaceChildren('Close');
      stopTicker();
      tick();
      ticker = setInterval(tick, 1000);
    }

    function onStatus(raw) {
      const st = normPairingStatus(raw);
      if (!st || st.offerId !== offer.offerId || retired.has(st.offerId) || paired) return;
      if (st.phase === 'attempt-failed') {
        const p = st.peer || { name: '', login: '', os: 'other' };
        failList.appendChild(h('li', null,
          h('span', { class: 'strong' }, p.name || 'Unknown device'),
          [p.login, OS_NAMES[p.os] || ''].filter(Boolean).map((t) => ` · ${t}`).join('')));
        failBox.hidden = false;
        if (!ended) setStatus('A pairing attempt failed. If it wasn’t your phone, close this window.', 'warn');
        return;
      }
      if (st.phase === 'paired') {
        paired = true;
        ended = true;
        stopTicker();
        const who = st.peer ? [st.peer.name, st.peer.login].filter(Boolean).join(' · ') : '';
        clearCode('Paired');
        expiryLine.hidden = true;
        modal.buttons.copy.hidden = true;
        modal.buttons.renew.hidden = true;
        modal.buttons.close.replaceChildren('Done');
        setStatus(who ? `Paired with ${who}. Your phone now recognises this computer.` : 'Paired. Your phone now recognises this computer.', 'ok');
        modal.buttons.close.focus();
        return;
      }
      if (st.phase === 'expired') endOffer('This code expired. Make a new one to pair.');
      else if (st.phase === 'failed') endOffer('This code was blocked after 3 wrong attempts. Make a new one if that was you.', 'danger');
      else endOffer(PAIR_CANCELLED[st.reason] || 'This code was cancelled.');
    }

    const unsubscribe = typeof api.onPairingStatus === 'function' ? api.onPairingStatus(onStatus) : () => {};
    // Redrawn at the new scale while live; an ended code stays cleared.
    const stopDprWatch = onDprChange(() => { if (!ended) drawQr(canvas, offer.qr); });

    const modal = openModal({
      title: 'Pair a phone',
      iconName: 'phone',
      body,
      actions: [
        { label: 'Copy pairing link', id: 'copy', kind: 'ghost', onClick: () => { if (!ended) copyText(offer.link, 'Pairing link'); return false; } },
        {
          label: 'New code', id: 'renew', kind: 'primary',
          onClick: async (m) => {
            m.setBusy(true);
            retired.add(offer.offerId);
            const next = await requestOffer();
            m.setBusy(false);
            if (next.offer) {
              offer = next.offer;
              showOffer();
              // New code, which had the focus, is hidden again.
              m.buttons.copy.focus();
            } else {
              retired.delete(offer.offerId);
              // setBusy(false) enabled every button, but the offer on screen is still the dead one.
              m.buttons.copy.disabled = true;
              setStatus(next.error, 'danger');
              m.buttons.renew.focus();
            }
            return false;
          },
        },
        { label: 'Close', id: 'close', onClick: () => true },
      ],
      onClose: () => {
        stopTicker();
        stopDprWatch();
        try { unsubscribe(); } catch { /* ignore */ }
        // A code nobody is looking at must not stay usable for the rest of its 2 minutes.
        if (!paired && typeof api.cancelPairing === 'function') Promise.resolve(api.cancelPairing(offer.offerId)).catch(() => {});
        resolve({ paired });
      },
      initialFocus: (m) => m.buttons.close,
    });
    modal.el.classList.add('modal-pair');
    showOffer();
  });
}
