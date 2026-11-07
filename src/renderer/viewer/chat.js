/*
 * Tunnelview viewer — chat drawer (`control` channel, t:'chat', ≤ MAX_CHAT chars).
 * Peer text is rendered as text nodes only (white-space: pre-wrap), never as HTML.
 */
import { h, icon } from '../shared/ui.js';
import { Drawer } from './drawer.js';

const P = window.TunnelviewProtocol;
const MAX_CHAT = P.CONTROL.MAX_CHAT;
const MAX_MESSAGES = 500;

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

export class ChatDrawer {
  /**
   * @param {HTMLElement} host
   * @param {object} o
   * @param {(text:string) => boolean} o.send       false when the control channel is not open
   * @param {() => string} o.peerName
   * @param {(n:number) => void} o.onUnread
   * @param {(title:string, body:string) => void} o.notify   system notification (window unfocused)
   * @param {(opts:{restoreFocus:boolean}) => void} o.onClosed  drawer closed (give focus back to the
   *        remote unless restoreFocus is false)
   */
  constructor(host, o) {
    this.o = o;
    this.unread = 0;
    this.enabled = false;
    this.drawer = new Drawer(host, { title: 'Chat', iconName: 'chat', onClose: (opts) => o.onClosed && o.onClosed(opts) });

    this.list = h('div', { class: 'chat-list', role: 'log', 'aria-live': 'polite', 'aria-label': 'Messages' });
    this.empty = h('div', { class: 'empty small' }, icon('chat', { size: 22 }), 'Messages you exchange with the remote user appear here.');
    this.list.append(this.empty);

    this.input = h('textarea', {
      class: 'textarea chat-input', rows: '1', maxlength: String(MAX_CHAT), placeholder: 'Type a message…',
      'aria-label': 'Chat message', spellcheck: 'true',
    });
    this.sendBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-icon', title: 'Send (Enter)', 'aria-label': 'Send message' }, icon('send', { size: 16 }));
    const form = h('form', { class: 'chat-compose' }, this.input, this.sendBtn);
    form.addEventListener('submit', (e) => { e.preventDefault(); this.#submit(); });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.#submit(); }
    });
    this.input.addEventListener('input', () => this.#autosize());

    this.drawer.body.append(this.list);
    this.drawer.foot.hidden = false;
    this.drawer.foot.append(form);
    this.setEnabled(false);
  }

  get isOpen() {
    return this.drawer.isOpen;
  }

  open() {
    this.drawer.open();
    this.#setUnread(0);
    this.#scrollToEnd();
    requestAnimationFrame(() => { if (!this.input.disabled) this.input.focus({ preventScroll: true }); });
  }

  /** @param {{restoreFocus?:boolean}} [opts]  see Drawer.close */
  close(opts) {
    this.drawer.close(opts);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.input.disabled = !this.enabled;
    this.sendBtn.disabled = !this.enabled;
    this.input.placeholder = this.enabled ? 'Type a message…' : 'Chat is available while connected';
  }

  /** Message from the remote user (already validated/cleaned by validate.js). */
  receive(text) {
    this.#append('peer', text);
    const peer = this.o.peerName();
    if (!this.isOpen) this.#setUnread(this.unread + 1);
    if (!document.hasFocus()) this.o.notify(`Message from ${peer}`, text.length > 180 ? `${text.slice(0, 179)}…` : text);
  }

  /** System line (e.g. "Session ended"). */
  note(text) {
    this.#append('system', text);
  }

  #submit() {
    if (!this.enabled) return;
    const text = this.input.value.replace(/\r\n?/g, '\n').trim();
    if (!text) return;
    if (text.length > MAX_CHAT) return; // maxlength already prevents this
    if (!this.o.send(text)) {
      this.#append('system', 'Message not sent — the connection is not ready.');
      return;
    }
    this.#append('me', text);
    this.input.value = '';
    this.#autosize();
  }

  #append(from, text) {
    this.empty.remove();
    const meta = from === 'system' ? null : h('div', { class: 'chat-meta tiny faint' },
      `${from === 'me' ? 'You' : this.o.peerName()} · ${timeFmt.format(new Date())}`);
    const row = h('div', { class: `chat-msg ${from}` }, h('div', { class: 'chat-bubble selectable' }, text), meta);
    const atEnd = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 40;
    this.list.append(row);
    while (this.list.childElementCount > MAX_MESSAGES) this.list.firstElementChild.remove();
    if (atEnd || from === 'me') this.#scrollToEnd();
  }

  #scrollToEnd() {
    requestAnimationFrame(() => { this.list.scrollTop = this.list.scrollHeight; });
  }

  #autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(120, this.input.scrollHeight + 2)}px`;
  }

  #setUnread(n) {
    this.unread = n;
    this.o.onUnread(n);
  }
}
