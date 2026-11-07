/*
 * Tunnelview viewer — small modal used by "Type text…" (special keys menu).
 * The user pastes/types text locally; it is then typed on the host as Unicode (`txt`), which
 * works where clipboard sync is off or the target app blocks paste (password fields, consoles…).
 */
import { h, icon } from '../shared/ui.js';

/**
 * @param {object} o
 * @param {string} o.title
 * @param {string} o.hint
 * @param {string} [o.initial]
 * @param {number} o.max                          max characters
 * @param {(text:string) => boolean} o.onSubmit  return false to keep the dialog open
 * @param {() => void} [o.onClose]
 * @returns {() => void} close function
 */
export function openTextDialog(o) {
  const ta = h('textarea', {
    class: 'textarea dlg-text mono', rows: '6', maxlength: String(o.max), spellcheck: 'false',
    'aria-label': o.title, placeholder: 'Paste or type the text to send…',
  });
  ta.value = typeof o.initial === 'string' ? o.initial.slice(0, o.max) : '';
  const counter = h('span', { class: 'tiny faint' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('keyboard', { size: 16 }), 'Type on remote');
  const cancel = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Cancel');
  const form = h('form', { class: 'dlg card', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title },
    h('h2', null, o.title),
    h('p', { class: 'small dim' }, o.hint),
    ta,
    h('div', { class: 'row' }, counter, h('span', { class: 'spacer' }), cancel, submit));
  const backdrop = h('div', { class: 'dlg-backdrop', 'data-local-keys': '' }, form);

  const update = () => {
    counter.textContent = `${ta.value.length.toLocaleString()} / ${o.max.toLocaleString()}`;
    submit.disabled = ta.value.length === 0;
  };
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    backdrop.remove();
    if (o.onClose) o.onClose();
  };

  ta.addEventListener('input', update);
  cancel.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
  backdrop.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    // Ctrl/Cmd+Enter submits; plain Enter inserts a newline (it is typed as Enter on the host).
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!ta.value) return;
    if (o.onSubmit(ta.value) !== false) close();
  });

  document.body.append(backdrop);
  update();
  requestAnimationFrame(() => { ta.focus({ preventScroll: true }); ta.select(); });
  return close;
}
