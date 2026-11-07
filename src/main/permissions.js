'use strict';
/*
 * macOS privacy permissions needed for the HOST role — docs/ARCHITECTURE.md §11.
 *   Screen Recording  → systemPreferences.getMediaAccessStatus('screen')
 *   Accessibility     → systemPreferences.isTrustedAccessibilityClient(false)  (CGEvent posting)
 * Windows has no equivalent gates → 'n/a'.
 *
 *   permissions.init({ input })     // re-check on app focus; informs input.refreshPermission()
 *   permissions.status()            → { screen, accessibility }
 *   await permissions.request(kind) → new status string ('screen' | 'accessibility'); screen also opens
 *                                     System Settings while it is not granted
 *   await permissions.register('screen') → status (adds Tunnelview to the Screen Recording list, no UI)
 *   await permissions.open(kind)    → { ok }   (deep link into System Settings)
 *   permissions.refresh()           → status (emits 'change' when it differs)
 *   events: 'change' (status)
 *
 * macOS notes: Screen Recording changes usually only take effect after the app restarts (the
 * main window offers 'app:relaunch'); the TCC prompt for it is triggered by the first capture
 * attempt (desktopCapturer.getSources). getMediaAccessStatus('screen') answers only
 * granted/denied (never 'not-determined'), so the UI must offer "Grant" for anything not granted.
 */
const { EventEmitter } = require('events');

const IS_MAC = process.platform === 'darwin';
const KINDS = ['screen', 'accessibility'];
const SETTINGS_URLS = {
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
  accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
};
const SCREEN_STATES = ['granted', 'denied', 'not-determined', 'restricted', 'unknown'];

let electron = null;
const E = () => electron || (electron = require('electron'));

class Permissions extends EventEmitter {
  constructor() {
    super();
    this._input = null;
    this._last = null;
    this._inited = false;
  }

  init({ input } = {}) {
    this._input = input || null;
    this._last = this.status();
    if (this._inited || !IS_MAC) return;
    this._inited = true;
    const { app } = E();
    // The user typically flips the switch in System Settings and comes back to the app.
    const recheck = () => this.refresh();
    app.on('did-become-active', recheck);
    app.on('browser-window-focus', recheck);
  }

  screenStatus() {
    if (!IS_MAC) return 'n/a';
    try {
      const s = E().systemPreferences.getMediaAccessStatus('screen');
      return SCREEN_STATES.includes(s) ? s : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  accessibilityStatus() {
    if (!IS_MAC) return 'n/a';
    try {
      return E().systemPreferences.isTrustedAccessibilityClient(false) ? 'granted' : 'denied';
    } catch {
      return 'denied';
    }
  }

  status() {
    return { screen: this.screenStatus(), accessibility: this.accessibilityStatus() };
  }

  /** Re-check; tell the input injector; emit 'change' if anything moved. */
  refresh() {
    const next = this.status();
    const prev = this._last;
    this._last = next;
    if (!prev || prev.screen !== next.screen || prev.accessibility !== next.accessibility) {
      if (this._input && typeof this._input.refreshPermission === 'function') {
        try { this._input.refreshPermission(); } catch (err) { console.warn('[permissions] input.refreshPermission failed:', err && err.message); }
      }
      this.emit('change', next);
    }
    return next;
  }

  /**
   * User asked to grant a permission (macOS). Screen Recording: a capture attempt registers the
   * app in the list (and shows the TCC prompt the first time); getMediaAccessStatus('screen')
   * never reports 'not-determined', and a grant only applies after a relaunch, so whenever the
   * status is still not 'granted' the Screen Recording pane is opened as well.
   * @returns {Promise<string>} new status for that kind
   */
  async request(kind) {
    if (!KINDS.includes(kind)) throw new Error('unknown permission kind');
    if (!IS_MAC) return 'n/a';
    if (kind === 'screen') {
      const s = await this.register('screen');
      if (s !== 'granted') {
        try { await E().shell.openExternal(SETTINGS_URLS.screen); } catch (err) { console.warn('[permissions] could not open System Settings:', err && err.message); }
      }
      return s;
    }
    try { E().systemPreferences.isTrustedAccessibilityClient(true); } catch { /* ignore */ }
    return this.refresh().accessibility;
  }

  /**
   * Register Tunnelview in the Screen Recording list without opening System Settings: one capture
   * attempt (desktopCapturer.getSources). macOS shows its TCC prompt only the first time; later
   * calls are silent. Used at startup so an unattended host can be set up before any session.
   * @returns {Promise<string>} screen status
   */
  async register(kind = 'screen') {
    if (kind !== 'screen') throw new Error('only screen can be registered');
    if (!IS_MAC) return 'n/a';
    try {
      await E().desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    } catch { /* denied → status says so */ }
    return this.refresh().screen;
  }

  /** Open the matching System Settings pane (macOS). */
  async open(kind) {
    if (!KINDS.includes(kind)) return { ok: false, error: 'unknown permission kind' };
    if (!IS_MAC) return { ok: false, error: 'not-applicable' };
    try {
      await E().shell.openExternal(SETTINGS_URLS[kind]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : 'failed' };
    }
  }
}

module.exports = new Permissions();
module.exports.KINDS = KINDS;
