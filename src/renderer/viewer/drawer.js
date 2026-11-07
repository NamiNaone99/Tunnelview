/*
 * Tunnelview viewer — right-hand side drawer used by Chat and Transfers.
 * Marked data-local-keys: while focus is inside, typing stays local (input.js). The drawer itself
 * is focusable (tabindex -1) so a programmatic switch can park the keyboard inside it instead of
 * handing it to the remote.
 */
import { h, icon } from '../shared/ui.js';

export class Drawer {
  /**
   * @param {HTMLElement} host container to append to
   * @param {{title:string, iconName:string, onClose?:(opts:{restoreFocus:boolean}) => void, headerActions?:Node[]}} opts
   */
  constructor(host, { title, iconName, onClose, headerActions = [] }) {
    this.onClose = onClose;
    this.closeBtn = h('button', {
      type: 'button', class: 'btn btn-ghost btn-icon btn-sm', title: 'Close', 'aria-label': `Close ${title}`,
      onClick: () => this.close(),
    }, icon('x', { size: 16 }));
    this.body = h('div', { class: 'drawer-body' });
    this.foot = h('div', { class: 'drawer-foot', hidden: true });
    this.el = h('aside', {
      class: 'drawer', role: 'complementary', 'aria-label': title, 'data-local-keys': '', tabindex: '-1', inert: true,
    },
    h('header', { class: 'drawer-head' },
      icon(iconName, { size: 16 }),
      h('h3', { class: 'grow ellipsis' }, title),
      ...headerActions,
      this.closeBtn),
    this.body,
    this.foot);
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.close(); }
    });
    host.append(this.el);
  }

  get isOpen() {
    return this.el.classList.contains('open');
  }

  open() {
    this.el.classList.add('open');
    this.el.inert = false;
  }

  /**
   * @param {{restoreFocus?:boolean}} [opts]  restoreFocus:false → the owner must not give the
   *        keyboard back to the remote (another drawer takes over; passed on to onClose).
   */
  close({ restoreFocus = true } = {}) {
    if (!this.isOpen) return;
    this.el.classList.remove('open');
    // inert: closed drawer is off-screen; keep it out of the tab order / accessibility tree.
    this.el.inert = true;
    if (this.onClose) this.onClose({ restoreFocus: restoreFocus !== false });
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Put keyboard focus on the (open) drawer itself: keys stay local, no control is activated. */
  focus() {
    if (!this.isOpen) return;
    try { this.el.focus({ preventScroll: true }); } catch { /* detached */ }
  }
}
