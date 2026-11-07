/*
 * Tunnelview viewer — file transfer UI: Transfers drawer (progress / cancel / reveal, and the
 * per-file consent card for files the host wants to send), plus the window-wide drag-and-drop zone.
 * The engine is shared/transfer.js (FileTransfer, §10).
 * File names and reasons can come from the peer → cleaned and inserted as text only.
 */
import { h, icon, toast, formatBytes } from '../shared/ui.js';
import { Drawer } from './drawer.js';
import { cleanLabel } from './validate.js';

const P = window.TunnelviewProtocol;
const ACTIVE = new Set(['queued', 'offered', 'sending', 'receiving']);
const TERMINAL = new Set(['done', 'rejected', 'error', 'cancelled']);
const MAX_ROWS = 200;
const DEFAULT_CONSENT_MS = 45000; // below transfer.js's 60 s accept timeout

/**
 * How an incoming file offer (which the host can send at any time) gets the user's attention
 * without ever taking them out of a drawer they are using:
 *   'none'           the Transfers drawer is already open (the consent card appears there);
 *   'notify'         the chat drawer is open: leave it alone (the user may be typing a message),
 *                    point at the request with a toast whose button opens Transfers;
 *   'open-transfers' no drawer is open: open Transfers, without taking keyboard focus.
 * @param {{chatOpen:boolean, transfersOpen:boolean}} s
 * @returns {'none'|'notify'|'open-transfers'}
 */
export function offerAttention({ chatOpen, transfersOpen }) {
  if (transfersOpen) return 'none';
  return chatOpen ? 'notify' : 'open-transfers';
}

export class TransfersDrawer {
  /**
   * @param {HTMLElement} host
   * @param {object} o
   * @param {(id:string) => Promise<unknown>} o.reveal     show a received file in Explorer/Finder
   * @param {() => Promise<unknown>} o.openFolder
   * @param {() => void} o.pickFiles                       open the file picker
   * @param {(n:number) => void} o.onBadge                 active + unseen-received count
   * @param {(opts:{restoreFocus:boolean}) => void} o.onClosed
   */
  constructor(host, o) {
    this.o = o;
    this.ft = null;
    this.gen = 0;
    this.rows = new Map(); // `${gen}:${id}` → row state
    this.consents = new Map(); // `${gen}:${id}` → { el, resolve, timer } (incoming file awaiting the user)
    this.unseen = 0;
    this.onUpdate = (e) => this.#update(this.gen, e.detail);

    this.sendBtn = h('button', { type: 'button', class: 'btn btn-sm', onClick: () => o.pickFiles() }, icon('upload', { size: 14 }), 'Send files…');
    const folderBtn = h('button', {
      type: 'button', class: 'btn btn-ghost btn-icon btn-sm', title: 'Open the folder where received files are saved',
      'aria-label': 'Open received files folder', onClick: () => o.openFolder().catch(() => {}),
    }, icon('folder', { size: 16 }));
    this.drawer = new Drawer(host, { title: 'File transfer', iconName: 'download', headerActions: [folderBtn], onClose: (opts) => o.onClosed && o.onClosed(opts) });

    this.hint = h('p', { class: 'xfer-hint tiny faint' });
    this.list = h('div', { class: 'xfer-list', role: 'list' });
    this.empty = h('div', { class: 'empty small' }, icon('upload', { size: 22 }),
      'Drop files anywhere on the window, or use “Send files…”. Files the host sends you need your OK and are saved to your Tunnelview download folder (Settings › Files).');
    this.list.append(this.empty);
    this.consentHost = h('div', { class: 'xfer-consents' });
    this.drawer.body.append(this.consentHost, this.list);
    this.drawer.foot.hidden = false;
    this.drawer.foot.append(h('div', { class: 'row' }, this.sendBtn, this.hint));
    this.setCanSend(false, 'Not connected');
  }

  get isOpen() { return this.drawer.isOpen; }

  open() {
    this.drawer.open();
    this.unseen = 0;
    this.#badge();
  }

  /** @param {{restoreFocus?:boolean}} [opts]  see Drawer.close */
  close(opts) { this.drawer.close(opts); }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  /** Keyboard focus on the drawer container (never on Accept): typing stays on this computer. */
  focus() { this.drawer.focus(); }

  /** Incoming files still waiting for the user's answer. */
  get pendingConsents() { return this.consents.size; }

  setCanSend(ok, reason = '') {
    this.sendBtn.disabled = !ok;
    this.hint.textContent = ok ? '' : reason;
  }

  /** Follow a FileTransfer instance (one per session). */
  attach(ft) {
    this.detach();
    this.gen++;
    this.ft = ft;
    ft.addEventListener('update', this.onUpdate);
    for (const t of ft.transfers.values()) this.#update(this.gen, t);
  }

  /** Session over: stop listening, decline pending consent requests, mark unfinished rows as interrupted. */
  detach() {
    if (this.ft) this.ft.removeEventListener('update', this.onUpdate);
    this.ft = null;
    this.clearConsents();
    for (const row of this.rows.values()) {
      if (ACTIVE.has(row.t.state)) this.#render(row, { ...row.t, state: 'error', reason: 'connection closed' });
    }
    this.#badge();
  }

  /**
   * Ask the user whether to accept an incoming file (current FileTransfer). Renders a card at the
   * top of the drawer; the caller opens the drawer. Focus is NOT moved there: the user may be
   * typing on the remote and must not accept by accident (e.g. with Enter).
   * @param {{id:string, name:string, size:number, from:string, timeoutMs?:number}} req
   * @returns {Promise<{accept:boolean, all:boolean}>}  declined on timeout, cancel or session end
   */
  requestConsent({ id, name, size, from, timeoutMs = DEFAULT_CONSENT_MS }) {
    const key = `${this.gen}:${id}`;
    this.#settleConsent(key, false); // a stale request with the same id
    const fileName = cleanLabel(name, 120) || 'file';
    const who = cleanLabel(from, 64) || 'The remote computer';
    const secs = Math.round(timeoutMs / 1000);
    return new Promise((resolve) => {
      const all = h('input', { type: 'checkbox' });
      const el = h('div', { class: 'xfer-consent', role: 'group', 'aria-label': `Incoming file from ${who}` },
        h('div', { class: 'xfer-consent-head' },
          h('div', { class: 'xfer-icon' }, icon('download', { size: 16 })),
          h('p', { class: 'grow xfer-consent-text' }, `${who} wants to send you `,
            h('strong', { class: 'xfer-consent-name' }, fileName), ` (${formatBytes(Number(size) || 0)})`)),
        h('p', { class: 'tiny faint' },
          `Only accept files you expect. Accepted files are saved to your Tunnelview download folder (Settings › Files › Download folder). Declined automatically after ${secs} seconds.`),
        h('label', { class: 'xfer-consent-all small' }, all, h('span', null, 'Accept all files for this session')),
        h('div', { class: 'xfer-consent-actions' },
          h('button', { type: 'button', class: 'btn btn-sm', onClick: () => this.#settleConsent(key, false) }, 'Decline'),
          h('button', { type: 'button', class: 'btn btn-primary btn-sm', onClick: () => this.#settleConsent(key, true, all.checked) },
            icon('check', { size: 14 }), 'Accept')));
      const timer = setTimeout(() => this.#settleConsent(key, false), timeoutMs);
      this.consents.set(key, { el, resolve, timer });
      this.consentHost.prepend(el);
      this.drawer.body.scrollTop = 0;
    });
  }

  /** Decline every pending consent request (session ended). */
  clearConsents() {
    for (const key of [...this.consents.keys()]) this.#settleConsent(key, false);
  }

  #settleConsent(key, accept, all = false) {
    const c = this.consents.get(key);
    if (!c) return;
    this.consents.delete(key);
    clearTimeout(c.timer);
    c.el.remove();
    c.resolve({ accept: !!accept, all: !!(accept && all) });
  }

  #update(gen, t) {
    if (!t || typeof t !== 'object' || t.purpose === P.FILE.PURPOSE_CLIPBOARD_IMAGE) return;
    const key = `${gen}:${t.id}`;
    // Offer cancelled by either side (or timed out) while the user was still deciding.
    if (TERMINAL.has(t.state)) this.#settleConsent(key, false);
    let row = this.rows.get(key);
    if (!row) {
      row = this.#createRow(gen, t);
      this.rows.set(key, row);
      this.empty.remove();
      this.list.prepend(row.el);
      this.#trim();
    }
    const prev = row.t ? row.t.state : null;
    this.#render(row, t);
    if (t.direction === 'in' && t.state === 'done' && prev !== 'done') this.#receivedToast(row);
    if (t.state === 'rejected' && prev !== 'rejected' && t.direction === 'out') {
      toast(`${row.name} was declined${t.reason ? ` (${cleanLabel(t.reason, 60)})` : ''}`, { kind: 'warn' });
    }
    if (t.state === 'error' && prev !== 'error') {
      toast(`Transfer failed: ${row.name}${t.reason ? ` — ${cleanLabel(t.reason, 80)}` : ''}`, { kind: 'danger' });
    }
    this.#badge();
  }

  #createRow(gen, t) {
    const name = cleanLabel(t.name, 120) || 'file';
    const refs = {
      bar: h('i'),
      status: h('div', { class: 'xfer-status tiny dim' }),
      actions: h('div', { class: 'xfer-actions' }),
    };
    const el = h('div', { class: 'xfer-row', role: 'listitem' },
      h('div', { class: 'xfer-icon' }, icon(t.direction === 'in' ? 'download' : 'upload', { size: 16 })),
      h('div', { class: 'xfer-main' },
        h('div', { class: 'xfer-name ellipsis', title: name }, name),
        h('div', { class: 'progress' }, refs.bar),
        refs.status),
      refs.actions);
    return { gen, id: t.id, name, el, refs, t: null, speed: 0, lastBytes: 0, lastAt: 0 };
  }

  #render(row, t) {
    const now = performance.now();
    const bytes = Number.isFinite(t.bytes) ? Math.max(0, t.bytes) : 0;
    const size = Number.isFinite(t.size) ? Math.max(0, t.size) : 0;
    if (row.lastAt && (t.state === 'sending' || t.state === 'receiving')) {
      const dt = (now - row.lastAt) / 1000;
      if (dt > 0.05) {
        const inst = Math.max(0, bytes - row.lastBytes) / dt;
        row.speed = row.speed ? row.speed * 0.7 + inst * 0.3 : inst;
      }
    }
    row.lastAt = now;
    row.lastBytes = bytes;
    const prevState = row.t ? row.t.state : null;
    row.t = { ...t };

    const pct = size > 0 ? Math.min(100, (bytes / size) * 100) : t.state === 'done' ? 100 : 0;
    row.refs.bar.style.width = `${pct.toFixed(1)}%`;
    row.el.dataset.state = t.state;
    row.refs.status.textContent = this.#statusText(t, pct, bytes, size, row.speed);

    if (prevState === t.state && row.refs.actions.childElementCount) return; // actions unchanged
    row.refs.actions.replaceChildren();
    if (ACTIVE.has(t.state) && this.ft && row.gen === this.gen) {
      row.refs.actions.append(h('button', {
        type: 'button', class: 'btn btn-ghost btn-icon btn-sm', title: 'Cancel', 'aria-label': `Cancel ${row.name}`,
        onClick: () => { try { this.ft && this.ft.cancel(row.id); } catch { /* already finished */ } },
      }, icon('x', { size: 14 })));
    } else if (t.state === 'done' && t.direction === 'in') {
      row.refs.actions.append(h('button', {
        type: 'button', class: 'btn btn-ghost btn-icon btn-sm', title: 'Show in folder', 'aria-label': `Show ${row.name} in folder`,
        onClick: () => this.o.reveal(row.id).catch(() => toast('Could not open the folder', { kind: 'warn' })),
      }, icon('folder', { size: 14 })));
    }
  }

  #statusText(t, pct, bytes, size, speed) {
    const reason = t.reason ? `: ${cleanLabel(t.reason, 80)}` : '';
    switch (t.state) {
      case 'queued': return `Queued · ${formatBytes(size)}`;
      case 'offered': return t.direction === 'out' ? 'Waiting for the host to accept…' : 'Waiting for you to accept…';
      case 'sending':
      case 'receiving':
        return `${Math.floor(pct)}% · ${formatBytes(bytes)} of ${formatBytes(size)}${speed > 0 ? ` · ${formatBytes(speed)}/s` : ''}`;
      case 'done': return t.direction === 'out' ? `Sent · ${formatBytes(size)}` : `Saved · ${formatBytes(size)}`;
      case 'rejected': return `Declined${reason}`;
      case 'error': return `Failed${reason}`;
      case 'cancelled': return 'Cancelled';
      default: return '';
    }
  }

  #receivedToast(row) {
    if (!this.isOpen) this.unseen++;
    const show = h('button', { type: 'button', class: 'btn btn-sm', onClick: () => this.o.reveal(row.id).catch(() => {}) }, 'Show');
    toast(h('div', { class: 'row' }, h('span', { class: 'grow ellipsis' }, `Received ${row.name}`), show), { kind: 'ok', timeout: 6000 });
  }

  #trim() {
    if (this.rows.size <= MAX_ROWS) return;
    for (const [key, row] of this.rows) {
      if (this.rows.size <= MAX_ROWS) break;
      if (ACTIVE.has(row.t ? row.t.state : 'queued')) continue;
      row.el.remove();
      this.rows.delete(key);
    }
  }

  #badge() {
    let active = 0;
    for (const row of this.rows.values()) if (row.t && ACTIVE.has(row.t.state) && row.gen === this.gen && this.ft) active++;
    this.o.onBadge(active + this.unseen);
  }
}

/* ------------------------------------------------------------------------------------------ */
/* Drag & drop anywhere on the window                                                          */
/* ------------------------------------------------------------------------------------------ */

function hasFiles(e) {
  const types = e.dataTransfer && e.dataTransfer.types;
  return !!types && Array.prototype.includes.call(types, 'Files');
}

/**
 * @param {HTMLElement} host            where the overlay lives
 * @param {object} o
 * @param {() => {ok:boolean, reason?:string}} o.canDrop
 * @param {(files:File[]) => void} o.onFiles
 * @param {() => string} o.targetName
 * @returns {() => void} uninstall
 */
export function installDropZone(host, o) {
  const title = h('h2', { class: 'ov-title' });
  const sub = h('p', { class: 'ov-sub dim' });
  const overlay = h('div', { class: 'drop-overlay', hidden: true, 'aria-hidden': 'true' },
    h('div', { class: 'drop-card' }, icon('upload', { size: 36 }), title, sub));
  host.append(overlay);
  let depth = 0;

  const show = () => {
    const st = o.canDrop();
    overlay.classList.toggle('denied', !st.ok);
    title.textContent = st.ok ? `Drop to send to ${o.targetName()}` : "Files can't be sent right now";
    sub.textContent = st.ok ? "Files are saved to the remote computer's Tunnelview downloads folder." : st.reason || '';
    overlay.hidden = false;
  };
  const hide = () => { depth = 0; overlay.hidden = true; };

  const ac = new AbortController();
  const opt = { signal: ac.signal };
  // Electron would otherwise NAVIGATE to a file:// URL dropped on the window (main also blocks
  // navigation, but never rely on that alone).
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (!hasFiles(e)) return;
    depth++;
    if (depth === 1) show();
  }, opt);
  window.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = hasFiles(e) && o.canDrop().ok ? 'copy' : 'none';
  }, opt);
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  }, opt);
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    hide();
    if (!hasFiles(e)) return;
    const st = o.canDrop();
    if (!st.ok) {
      toast(st.reason || "Files can't be sent right now", { kind: 'warn' });
      return;
    }
    const files = [];
    let folders = 0;
    const items = e.dataTransfer.items ? [...e.dataTransfer.items] : [];
    if (items.length) {
      for (const item of items) {
        if (item.kind !== 'file') continue;
        const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
        if (entry && entry.isDirectory) { folders++; continue; }
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    } else {
      files.push(...e.dataTransfer.files);
    }
    if (folders) toast(`Folders can't be sent — zip ${folders === 1 ? 'it' : 'them'} first.`, { kind: 'warn' });
    if (files.length) o.onFiles(files);
  }, opt);
  window.addEventListener('blur', hide, opt);

  return () => { ac.abort(); overlay.remove(); };
}
