/*
 * Tunnelview viewer — full-window state overlay for every pre-stream / post-stream phase:
 *   connecting · hello · waiting · password (auth-required, or "use password instead") ·
 *   accepted ("Starting video…", with Disconnect) · closed (friendly reason + Reconnect / Close).
 * Also the persistent, non-modal NoticeBanner shown during the stream (e.g. the host's input is
 * blocked by an administrator window or the secure desktop), and the pure admission helpers
 * viewer.js uses for the waiting / password phases (admissionState, waitingView; unit-tested).
 * All strings are inserted as text (ui.js h()), never as HTML — host names, user names and
 * messages ultimately come from the network.
 */
import { h, icon, osIcon, initials } from '../shared/ui.js';

const LEAVE_MS = 220;

/**
 * Text for host-state.inputBlocked ('secure-desktop' | 'elevated-window'), or '' for anything else.
 * @param {string|null} kind
 * @param {string} host  already-sanitized display name
 */
export function inputBlockedMessage(kind, host) {
  const name = host || 'the remote device';
  if (kind === 'secure-desktop') {
    return `${name} is showing a secure screen (administrator prompt or lock screen). The person at ${name} must handle it — remote input can't reach it.`;
  }
  if (kind === 'elevated-window') {
    return `The window you're controlling on ${name} runs as administrator, so Tunnelview can't control it. Ask the person there to handle it.`;
  }
  return '';
}

/**
 * Admission bookkeeping for a status from main (connecting · hello · waiting · auth-required):
 * the next {phase, remaining, passwordMode}. `remaining` = password attempts left on this
 * connection after a wrong password; viewer-client repeats it with every later 'waiting'. In ask
 * mode a wrong password (typed in "Connect with password") is answered with auth-failed and then a
 * prompt at the host, so 'auth-required' only lasts an instant and the request waits for approval:
 * the waiting card must still say the password was wrong. A fresh connection starts without it.
 * @param {{remaining?:number, passwordMode?:boolean}} prev
 * @param {{phase:string, remaining?:number}} st  normalizeStatus() result
 * @returns {{phase:string, remaining:number|undefined, passwordMode:boolean}}
 */
export function admissionState(prev, st) {
  switch (st.phase) {
    case 'waiting':
      return { phase: 'waiting', remaining: typeof st.remaining === 'number' ? st.remaining : prev.remaining, passwordMode: !!prev.passwordMode };
    case 'auth-required':
      return { phase: 'auth-required', remaining: st.remaining, passwordMode: false };
    default: // 'connecting' / 'hello': a new connection
      return { phase: st.phase, remaining: undefined, passwordMode: false };
  }
}

/**
 * Overlay view for the 'waiting' phase: the waiting card, or the password form after "Use
 * password instead". Both carry `remaining` (number after a wrong password), so the waiting card
 * explains why it waits and the form shows "Incorrect password. N attempts left."
 * @param {object} base  host/ip/port/os/user  @param {{passwordMode:boolean, passwordSet:boolean, remaining?:number}} o
 */
export function waitingView(base, { passwordMode, passwordSet, remaining }) {
  const rem = typeof remaining === 'number' ? { remaining } : {};
  return passwordMode
    ? { ...base, kind: 'password', fromWaiting: true, ...rem }
    : { ...base, kind: 'waiting', passwordSet: !!passwordSet, ...rem };
}

/** Waiting card note after a wrong password, or '' when no password was tried. */
export function waitingPasswordNote(remaining) {
  if (typeof remaining !== 'number' || !Number.isInteger(remaining) || remaining < 0) return '';
  const left = remaining > 0 ? ` (${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} left)` : '';
  return `The password was incorrect${left}, so the request is waiting for approval instead.`;
}

/** Persistent, non-modal notice shown under the toolbar while a condition lasts (text only). */
export class NoticeBanner {
  /**
   * @param {HTMLElement} host
   * @param {{tone?:'warn'|'danger'|'accent', iconName?:string}} [o]
   */
  constructor(host, { tone = 'warn', iconName = 'alert' } = {}) {
    this.text = h('span', { class: 'grow' });
    this.el = h('div', { class: `banner banner-${tone} notice-banner`, role: 'status', hidden: true },
      icon(iconName, { size: 16 }), this.text);
    host.append(this.el);
  }

  /** Show `message`; an empty message hides the banner. */
  set(message) {
    const text = typeof message === 'string' ? message : '';
    if (this.text.textContent !== text) this.text.textContent = text;
    this.el.hidden = !text;
  }
}

export class Overlay {
  /**
   * @param {HTMLElement} root
   * @param {object} actions
   * @param {() => void} actions.cancel          abort the attempt and close the window
   * @param {(pw:string) => Promise<{ok:boolean, error?:string}>} actions.submitPassword
   * @param {() => void} actions.usePassword     switch the waiting card to the password form
   * @param {() => void} actions.backToWaiting
   * @param {() => void} actions.reconnect
   * @param {() => void} actions.close
   */
  constructor(root, actions) {
    this.root = root;
    this.actions = actions;
    this.key = null;
    this.card = null;
    this.refs = null;
    this.sig = '';
    this.hideTimer = 0;
    // Static "Starting…" card from index.html: cross-faded out by the first show().
    const boot = root.querySelector('.ov-boot');
    if (boot) { this.card = boot; this.key = 'boot'; }
    root.setAttribute('data-local-keys', ''); // keys typed here never go to the remote
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
  }

  get visible() {
    return !this.root.hidden && !this.root.classList.contains('leaving');
  }

  /** Show (or update in place) a view: {kind, host, ip, port, os, user, …kind-specific}. */
  show(view) {
    clearTimeout(this.hideTimer);
    this.root.hidden = false;
    this.root.classList.remove('leaving');
    this.root.classList.toggle('translucent', view.kind === 'accepted');

    const key = view.kind;
    const sig = JSON.stringify(view);
    if (this.card && this.key === key) {
      // render() runs on every state change; only touch the card when its data really changed
      // (otherwise e.g. the password form would lose its busy state / re-shake).
      if (sig !== this.sig) {
        this.sig = sig;
        if (key === 'password') {
          this.#update(view); // keep the field the user is typing in
        } else {
          this.refs = {};
          const next = this.#build(view); // e.g. host name / password option became known
          this.card.replaceWith(next);
          this.card = next;
          this.#autofocus();
        }
      }
      return;
    }
    this.sig = sig;
    const old = this.card;
    if (old) {
      old.classList.add('leaving');
      setTimeout(() => old.remove(), LEAVE_MS);
    }
    this.key = key;
    this.refs = {};
    this.card = this.#build(view);
    this.card.classList.add('entering');
    this.root.append(this.card);
    requestAnimationFrame(() => this.card && this.card.classList.remove('entering'));
    this.root.setAttribute('aria-label', view.kind === 'closed' ? view.title : 'Connection status');
    this.#autofocus();
  }

  hide() {
    if (this.root.hidden) return;
    this.root.classList.add('leaving');
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      this.root.hidden = true;
      this.root.classList.remove('leaving');
      this.card?.remove();
      this.card = null;
      this.key = null;
      this.refs = null;
    }, LEAVE_MS);
  }

  /* ------------------------------------------------------------------------------------ */

  #autofocus() {
    const r = this.refs;
    requestAnimationFrame(() => {
      const target = (r && (r.password || r.primary)) || null;
      if (target && !target.disabled) target.focus({ preventScroll: true });
    });
  }

  #build(view) {
    switch (view.kind) {
      case 'connecting': return this.#progress(view, `Connecting to ${view.host} over Tailscale…`, 'Opening an encrypted connection inside your tailnet.');
      case 'hello': return this.#progress(view, `Requesting access to ${view.host}…`, 'Connected. Asking the host to let you in.');
      // Can take up to 30 s when UDP is blocked: always offer a way out.
      case 'accepted': return this.#progress(view, 'Starting video…', 'Access granted. Setting up a direct, encrypted stream over Tailscale.', 'Disconnect');
      case 'waiting': return this.#waiting(view);
      case 'password': return this.#password(view);
      case 'closed': return this.#closed(view);
      default: return this.#progress(view, 'Please wait…', '');
    }
  }

  #update(view) {
    if (view.kind === 'password') this.#updatePassword(view);
  }

  #targetChip(view) {
    if (!view.ip) return null;
    const addr = view.ip.includes(':') ? `[${view.ip}]:${view.port}` : `${view.ip}:${view.port}`;
    return h('div', { class: 'ov-chip', title: 'Tailscale address of the remote device' },
      icon('shield', { size: 14 }), h('span', { class: 'mono selectable' }, addr));
  }

  #hostBadge(view) {
    return h('div', { class: 'ov-host' }, osIcon(view.os, { size: 14 }), h('span', { class: 'ellipsis' }, view.host));
  }

  #cancelBtn(label = 'Cancel') {
    return h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => this.actions.cancel() }, label);
  }

  #progress(view, title, sub, cancelLabel = 'Cancel') {
    return h('section', { class: 'ov-card card' },
      h('div', { class: 'spinner spinner-lg ov-spinner', role: 'progressbar', 'aria-label': 'Working' }),
      h('h2', { class: 'ov-title' }, title),
      sub ? h('p', { class: 'ov-sub dim' }, sub) : null,
      this.#targetChip(view),
      h('div', { class: 'ov-actions' }, this.#cancelBtn(cancelLabel)));
  }

  #waiting(view) {
    const who = view.user || 'the remote user';
    const actions = h('div', { class: 'ov-actions' });
    if (view.passwordSet) {
      const usePw = h('button', { type: 'button', class: 'btn', onClick: () => this.actions.usePassword() },
        icon('key', { size: 16 }), 'Use password instead');
      actions.append(usePw);
    }
    actions.append(this.#cancelBtn());
    // A wrong password (e.g. from "Connect with password") turned into a request for approval.
    const note = waitingPasswordNote(view.remaining);
    return h('section', { class: 'ov-card card' },
      h('div', { class: 'ov-avatar-wrap' },
        h('div', { class: 'avatar ov-avatar' }, initials(view.user || view.host)),
        h('span', { class: 'ov-pulse', 'aria-hidden': 'true' })),
      h('h2', { class: 'ov-title' }, `Waiting for ${who} to accept on ${view.host}…`),
      note ? h('div', { class: 'banner banner-warn ov-notice small', role: 'alert' }, icon('alert', { size: 16 }), h('span', null, note)) : null,
      h('p', { class: 'ov-sub dim' }, 'They see your device name and decide what you may do (control, clipboard, files, audio).'),
      this.#targetChip(view),
      actions);
  }

  #password(view) {
    const input = h('input', {
      type: 'password', class: 'input input-lg', placeholder: 'Password', autocomplete: 'off',
      spellcheck: 'false', maxlength: '128', 'aria-label': `Password for ${view.host}`,
    });
    const error = h('p', { class: 'ov-error small', role: 'alert' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-lg ov-submit' }, icon('unlock', { size: 16 }), 'Connect');
    const form = h('form', { class: 'ov-form', autocomplete: 'off' }, input, error,
      h('div', { class: 'ov-actions' }, submit, this.#cancelBtn()));
    const back = view.fromWaiting
      ? h('button', { type: 'button', class: 'btn btn-ghost btn-sm', onClick: () => this.actions.backToWaiting() }, 'Back to waiting for approval')
      : null;

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      this.#submitPassword();
    });
    this.refs = { password: input, error, submit, form, busy: false };

    const card = h('section', { class: 'ov-card card' },
      h('div', { class: 'avatar ov-avatar ov-avatar-lock' }, icon('lock', { size: 20 })),
      h('h2', { class: 'ov-title' }, view.passwordOnly ? `${view.host} requires a password` : `Enter the password for ${view.host}`),
      h('p', { class: 'ov-sub dim' }, 'The password is never sent — only a one-time proof derived from it.'),
      form,
      this.#targetChip(view),
      back);
    this.#updatePassword(view);
    return card;
  }

  #updatePassword(view) {
    const r = this.refs;
    if (!r || !r.form) return;
    r.busy = false;
    this.#setBusy(false);
    if (typeof view.remaining === 'number') {
      r.error.textContent = view.remaining > 0
        ? `Incorrect password. ${view.remaining} ${view.remaining === 1 ? 'attempt' : 'attempts'} left.`
        : 'Incorrect password. No attempts left on this connection.';
      r.password.value = '';
      r.password.classList.add('shake');
      setTimeout(() => r.password && r.password.classList.remove('shake'), 400);
      if (view.remaining === 0) {
        r.password.disabled = true;
        r.submit.disabled = true;
      } else {
        r.password.focus({ preventScroll: true });
      }
    } else {
      r.error.textContent = '';
    }
  }

  #setBusy(busy) {
    const r = this.refs;
    if (!r || !r.submit) return;
    r.busy = busy;
    r.password.disabled = busy;
    r.submit.disabled = busy;
    r.submit.replaceChildren(busy ? h('span', { class: 'spinner ov-btn-spinner' }) : icon('unlock', { size: 16 }), busy ? 'Verifying…' : 'Connect');
  }

  async #submitPassword() {
    const r = this.refs;
    if (!r || r.busy) return;
    const pw = r.password.value;
    if (!pw) {
      r.error.textContent = 'Enter the password.';
      r.password.focus({ preventScroll: true });
      return;
    }
    r.error.textContent = '';
    this.#setBusy(true);
    r.password.value = ''; // do not keep the secret in the DOM while the proof is computed
    let res;
    try {
      res = await this.actions.submitPassword(pw);
    } catch (err) {
      res = { ok: false, error: err && err.message };
    }
    if (this.refs !== r) return; // the card changed meanwhile (accepted / closed)
    if (!res || !res.ok) {
      this.#setBusy(false);
      r.error.textContent = (res && typeof res.error === 'string' && res.error.slice(0, 200)) || "Couldn't send the password.";
      r.password.focus({ preventScroll: true });
    }
    // On success the next status (accepted / auth-required with remaining) updates the card.
  }

  #closed(view) {
    const primary = h('button', { type: 'button', class: 'btn btn-primary', onClick: () => this.actions.reconnect() },
      icon('refresh', { size: 16 }), 'Reconnect');
    this.refs = { primary };
    return h('section', { class: `ov-card card ov-closed tone-${view.tone || 'info'}` },
      h('div', { class: 'avatar ov-avatar ov-avatar-tone' }, icon(view.icon || 'info', { size: 20 })),
      h('h2', { class: 'ov-title' }, view.title),
      h('p', { class: 'ov-sub dim' }, view.message),
      view.detail && view.detail !== view.message ? h('p', { class: 'ov-detail tiny faint selectable' }, view.detail) : null,
      this.#hostBadge(view),
      h('div', { class: 'ov-actions' }, primary,
        h('button', { type: 'button', class: 'btn btn-ghost', onClick: () => this.actions.close() }, 'Close')));
  }
}
