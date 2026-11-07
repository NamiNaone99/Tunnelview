/*
 * Main window — overlay layers (settings sheet, modals) + reusable dialogs.
 *
 * Layers are appended to <body>; everything else in <body> (except the toast host) is made
 * `inert` while a layer is on top, which gives a real focus trap and blocks clicks/keys behind it.
 */
import { h, icon, toast } from '../shared/ui.js';
import { api, errMsg, refreshSettings } from './store.js';

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
