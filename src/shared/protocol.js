/*
 * Tunnelview shared protocol constants.
 * UMD: `require('../shared/protocol')` in main, `window.TunnelviewProtocol` in renderers
 * (load with a classic <script src="../../shared/protocol.js"> before module scripts).
 * See docs/ARCHITECTURE.md §4–§5.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TunnelviewProtocol = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 2: password proofs are bound to both endpoints' Tailscale node IDs (AUTH.CONTEXT v2, §4).
  const PROTOCOL_VERSION = 2;

  return Object.freeze({
    PROTOCOL_VERSION,
    APP_ID: 'Tunnelview',
    DEFAULT_PORT: 47800,
    RTC_UDP_MIN: 47801, // WebRTC UDP port range (webContents.setWebRTCUDPPortRange)
    RTC_UDP_MAX: 47899,
    WS_PATH: '/tunnelview/v1',
    INFO_PATH: '/tunnelview/v1/info',
    PROTOCOL_HEADER: 'x-tunnelview-protocol', // lower-case (Node lowercases incoming header names)
    // Optional upgrade header (mobile viewers): canonical base64 of CLIENT_NONCE_BYTES random bytes.
    // The host echoes it in hello.ident, so a signature cannot be replayed onto another connection.
    // Desktop viewers do not send it; a malformed value is refused with HTTP 400.
    CLIENT_NONCE_HEADER: 'x-tunnelview-client-nonce',
    CLIENT_NONCE_BYTES: 32,
    MAX_WS_PAYLOAD: 1024 * 1024,
    HANDSHAKE_TIMEOUT_MS: 8000,
    PING_INTERVAL_MS: 15000,

    // Tailscale address space
    TS_IPV4_CIDR: '100.64.0.0/10',
    TS_IPV6_PREFIX: 'fd7a:115c:a1e0:', // first 48 bits of fd7a:115c:a1e0::/48

    // Signaling message types (WebSocket)
    MSG: Object.freeze({
      HELLO: 'hello',
      REQUEST: 'request',
      AUTH: 'auth',
      PENDING: 'pending',
      AUTH_FAILED: 'auth-failed',
      ACCEPTED: 'accepted',
      DENIED: 'denied',
      SDP: 'sdp',
      ICE: 'ice',
      PERMISSIONS: 'permissions',
      BYE: 'bye',
      PAIR: 'pair', // V→H, only in state hello and only with a client nonce (PAIR below)
      PAIR_RESULT: 'pair-result',
    }),

    DENY: Object.freeze({
      REJECTED: 'rejected',
      TIMEOUT: 'timeout',
      BUSY: 'busy',
      NOT_ALLOWED: 'not-allowed',
      BAD_PASSWORD: 'bad-password',
      PASSWORD_REQUIRED: 'password-required',
      LOCKED: 'locked', // too many failed passwords from this node / account / the tagged devices
      PROTOCOL: 'protocol',
      DISABLED: 'disabled',
      AUTH_TIMEOUT: 'auth-timeout', // no request / next password arrived in time (TIMEOUT = prompt unanswered)
      SUSPENDED: 'suspended', // host-wide password suspension (many failures from several devices)
      TRY_LATER: 'try-later', // prompt back-off / prompt rate limit; carries retryAfterSec:int 1..3600
    }),

    AUTH: Object.freeze({
      // proof = base64(HMAC-SHA256(key, CONTEXT + nonceB64 + '|' + hostId + '|' + viewerId)),
      // hostId / viewerId = the two nodes' Tailscale StableNodeIDs
      CONTEXT: 'Tunnelview-auth-v2|',
      MAX_ATTEMPTS_PER_CONNECTION: 3,
      KDF_DEFAULT: Object.freeze({ N: 32768, r: 8, p: 1, keylen: 32 }),
      KDF_LIMITS: Object.freeze({ maxN: 131072, maxR: 16, maxP: 4, keylen: 32 }),
    }),

    // hello.ident: the host's Ed25519 identity key signs
    //   utf8(CONTEXT + nonce + '|' + (clientNonce || '') + '|' + hostId + '|' + viewerId)
    // so a paired phone knows the hello comes from the computer it paired with (src/main/pairing.js).
    IDENT: Object.freeze({ CONTEXT: 'Tunnelview-hello-v1|', ALG: 'ed25519', VERSION: 1 }),

    // Pairing a phone: a single live offer with a TOKEN_BYTES token, shown as a QR code / link
    //   LINK_PREFIX + base64url(JSON {v, id, n, a, p, k, t, x})
    // proof = base64(HMAC-SHA256(token, CONTEXT + nonce + '|' + clientNonce + '|' + hostId + '|' + viewerId)).
    // Every refusal answers pair-result {ok:false, reason: FAILED}, so a reply never tells another
    // node whether an offer exists; MAX_FAILURES wrong proofs burn the offer.
    PAIR: Object.freeze({
      CONTEXT: 'Tunnelview-pair-v1|',
      TTL_MS: 120000,
      TOKEN_BYTES: 16,
      LINK_PREFIX: 'tunnelview://pair/1/',
      LINK_VERSION: 1,
      MAX_FAILURES: 3,
      FAILED: 'failed',
    }),

    // GET /info `features` while the identity key is available ([] otherwise).
    INFO_FEATURES: Object.freeze(['ident-v1', 'pair-v1']),

    // WebRTC data channel labels (all created by the host, ordered + reliable)
    CHANNEL: Object.freeze({ INPUT: 'input', CONTROL: 'control', FILE: 'file' }),

    INPUT: Object.freeze({
      MOUSE_MOVE: 'mm',
      MOUSE_DOWN: 'md',
      MOUSE_UP: 'mu',
      WHEEL: 'wh',
      KEY_DOWN: 'kd',
      KEY_UP: 'ku',
      TEXT: 'txt',
      COMBO: 'combo',
      RELEASE_ALL: 'release-all',
      MAX_TEXT: 2000,
    }),

    CONTROL: Object.freeze({
      DISPLAYS: 'displays',
      SELECT_DISPLAY: 'select-display',
      QUALITY: 'quality',
      CLIPBOARD: 'clipboard',
      CHAT: 'chat',
      HOST_STATE: 'host-state',
      MAX_CLIPBOARD_TEXT: 200000,
      MAX_CHAT: 4000,
      // Large clipboard text travels in parts of ≤ CLIPBOARD_CHUNK_CHARS (at most CLIPBOARD_MAX_PARTS);
      // a single 'clipboard' message is used while it stays ≤ CLIPBOARD_SINGLE_MAX_BYTES.
      CLIPBOARD_CHUNK_CHARS: 40000,
      CLIPBOARD_MAX_PARTS: 16,
      CLIPBOARD_SINGLE_MAX_BYTES: 240000,
    }),

    FILE: Object.freeze({
      OFFER: 'file-offer',
      ACCEPT: 'file-accept',
      REJECT: 'file-reject',
      END: 'file-end',
      DONE: 'file-done',
      ERROR: 'file-error',
      CANCEL: 'file-cancel',
      PAUSE: 'file-pause', // receiver flow control for {id}
      RESUME: 'file-resume',
      LANE_FILE: 0, // transfer lanes: clipboard images never queue behind files
      LANE_CLIPBOARD: 1,
      CHUNK_SIZE: 64 * 1024,
      HIGH_WATER: 4 * 1024 * 1024,
      LOW_WATER: 1024 * 1024,
      MAX_SIZE: 50 * 1024 * 1024 * 1024,
      PURPOSE_FILE: 'file',
      PURPOSE_CLIPBOARD_IMAGE: 'clipboard-image',
      MAX_CLIPBOARD_IMAGE: 32 * 1024 * 1024,
    }),

    QUALITY_PRESETS: Object.freeze(['quality', 'balanced', 'speed']),
    CODECS: Object.freeze(['auto', 'h264', 'vp9', 'vp8', 'av1']),
    PERMISSION_KEYS: Object.freeze(['control', 'clipboard', 'files', 'audio']),
  });
});
