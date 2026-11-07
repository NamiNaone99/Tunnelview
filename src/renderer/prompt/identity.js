/*
 * Tunnelview — how the approval prompt presents WHO is asking (pure; unit-tested in Node).
 *
 * peer = the normalized PromptInit.peer from prompt.js:
 *   { user:{login, displayName}, stableId, tags:[], tagged, sameUser, isSelf, … }.
 * describeRequester() returns { name, login, note, badges:[{ tone:'ok'|'warn'|'accent'|'neutral', icon, text, title }] }.
 *
 * A self-connection comes from this computer's own Tailscale address. Tailscale identifies the
 * DEVICE, not the program or OS user behind the socket, so any local app or other local account
 * can produce one. It must never look like a verified "you".
 *
 * A tagged node is owned by its ACL tags, not by a person: whois reports the pseudo-user
 * 'tagged-devices' / 'Tagged Devices'. The host never auto-accepts tagged nodes (ARCHITECTURE §4
 * "Trusted"), so the prompt must not offer "Always allow" for them.
 */

export const TAGGED_LOGIN = 'tagged-devices';

const VERIFIED_TITLE = 'Tailscale confirms which device this is and the account that owns it (whois). It can’t be faked by the other side, but it doesn’t tell which person or app on that device is asking.';

/**
 * Tagged node? PromptInit.peer.tags is the primary signal (any entry counts, so a malformed list
 * fails closed); older mains send no tags, so the pseudo-user login is the fallback. prompt.js
 * also sets `tagged` when main's raw list was non-empty but no entry survived cleaning.
 */
export function isTaggedPeer(peer) {
  const p = peer && typeof peer === 'object' ? peer : {};
  if (p.tagged === true) return true;
  if (Array.isArray(p.tags) && p.tags.length > 0) return true;
  const user = p.user && typeof p.user === 'object' ? p.user : {};
  return user.login === TAGGED_LOGIN;
}

/** "Always allow this device" only means something for another, untagged node with a stableId. */
export function canAlwaysAllow(peer) {
  const p = peer && typeof peer === 'object' ? peer : {};
  return p.isSelf !== true && typeof p.stableId === 'string' && p.stableId !== '' && !isTaggedPeer(p);
}

export function describeRequester(peer) {
  const p = peer && typeof peer === 'object' ? peer : {};
  const user = p.user && typeof p.user === 'object' ? p.user : {};
  if (p.isSelf === true) {
    return {
      name: 'A program on this computer',
      login: '',
      note: 'Any app or user on this computer can make this request — accept only if you started it.',
      badges: [{
        tone: 'warn',
        icon: 'alert',
        text: 'This computer (unverified user)',
        title: 'The request comes from this computer’s own Tailscale address. Tailscale can’t tell which app or user on this computer sent it.',
      }],
    };
  }
  const verified = { tone: 'ok', icon: 'shield-check', text: 'Device verified by Tailscale', title: VERIFIED_TITLE };
  if (isTaggedPeer(p)) {
    // The "user" is the 'Tagged Devices' pseudo-user: show the node's tags instead. The verified
    // device name stays on the "wants to connect from …" line (prompt.js).
    const tags = Array.isArray(p.tags) ? p.tags.filter((t) => typeof t === 'string' && t) : [];
    return {
      name: tags.length ? tags.join(', ') : 'Tagged device',
      login: '',
      note: '',
      badges: [verified, {
        tone: 'neutral',
        icon: 'server',
        text: 'Tagged device',
        title: 'Owned by Tailscale ACL tags rather than a person. Tagged devices are never accepted automatically.',
      }],
    };
  }
  const name = user.displayName || user.login || 'Unknown Tailscale user';
  const badges = [verified];
  if (p.sameUser === true) badges.push({ tone: 'accent', icon: 'user', text: 'Your device', title: 'Signed in to the same Tailscale account as this computer' });
  return {
    name,
    login: user.login && user.login !== name ? user.login : '',
    note: '',
    badges,
  };
}
