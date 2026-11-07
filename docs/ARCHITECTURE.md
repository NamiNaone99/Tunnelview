# Tunnelview — Architecture & Contracts

Tunnelview is an AnyDesk-style remote desktop app for **Windows and macOS** that only works
**inside a Tailscale tailnet**. This document is the binding contract between modules. If code
and this document disagree, fix the code (or update this document deliberately).

- Runtime: **Electron 45** (Node 22+ in main, Chromium in renderers). Plain JavaScript, no bundler,
  no TypeScript. Main + preload = CommonJS. Renderers = native ES modules (`<script type="module">`)
  plus the classic script `src/shared/protocol.js` (UMD) loaded first.
- Dependencies: `ws` (signaling server/client), `koffi` v3 (FFI for native input injection and
  clipboard change counters). No other runtime deps. Check `node_modules/koffi` docs/typings and
  `node_modules/electron/electron.d.ts` for exact APIs — do not guess.
- Video/audio: WebRTC in the renderer (`RTCPeerConnection`), screen captured with
  `getDisplayMedia()` + `session.setDisplayMediaRequestHandler` in main.
- Input: viewer captures DOM events → `input` data channel → host renderer → IPC → main →
  `src/main/input` (koffi → `SendInput` on Windows, `CGEvent*` on macOS).

## 1. Tailscale-only model (security invariants — MUST hold)

1. **Bind only to Tailscale addresses.** The host signaling server listens on the node's own
   Tailscale IPs (from `tailscale status --json` → `Self.TailscaleIPs`), never `0.0.0.0`/`::`.
   If Tailscale is not running, the host does not listen. Re-check every 10 s and rebind on change.
2. **Every inbound socket is verified**: remote address (normalize `::ffff:` IPv4-mapped) must be in
   `100.64.0.0/10` or `fd7a:115c:a1e0::/48` **and** `tailscale whois --json <ip>` must succeed
   (100.64/10 is also ISP CGNAT space, so the range check alone is not enough). Exception: the
   node's own Tailscale IPs (self-connection for testing) — identity = self.
   Policy and display use only the control-plane identity from whois: user login, node
   `stableId`, tags and MagicDNS name. `peer.hostname` is the **MagicDNS label** (first label of
   the node's MagicDNS name). The OS hostname a node reports about itself (whois `Hostinfo`,
   `hello`/`request` `hostname`) is never used to authorize anything, and `allowList` never
   matches it (§8).
3. **Reject browser-originated WebSockets**: any upgrade carrying an `Origin` header is rejected;
   a custom header `X-Tunnelview-Protocol: 2` (= `PROTOCOL_VERSION`) is required (browsers cannot
   set it).
4. **Outbound**: the viewer only dials an IP that is a Tailscale IP of a peer in the current
   `tailscale status` (or self). Hostnames/MagicDNS names are resolved through `tailscale status`,
   never through system DNS; a target that is not such a device stops with `not-tailnet`. Before
   sending `request` (or anything else) it checks that its socket's local address is one of its
   own Tailscale IPs of the same family, else it stops with `not-tailnet-route` (§7
   viewer-client).
5. **WebRTC stays on the tailnet**: `iceServers: []` (no STUN/TURN). Both peers drop local and
   remote ICE candidates whose address is not a Tailscale IP. After `connectionState === 'connected'`
   the host checks the selected candidate pair (`selectedcandidatepairchange` → `rtc.pairIsTailnet`,
   and `getStats()` → `rtc.verifyTailnetPath`, then every 5 s); the viewer runs the same
   `getStats()` check. The **path rule** (§10 `rtc.js`):
   - **local end** (our own candidate): must be a **Tailscale IP literal**. `pairIsTailnet` /
     `describePair` fail a missing or non-IP local address. `verifyTailnetPath` accepts a missing
     one (getStats may omit it), but a present local address must still be a Tailscale IP. So a
     LAN candidate paired with a `100.x` remote (which could reach a CGNAT impostor) fails;
   - **remote end, IP literal**: must be a Tailscale IP;
   - **remote end with no address or a host name**: unknown and **allowed**, because every
     signalled candidate was already filtered. Chromium reports a peer-reflexive remote (the normal
     case on a fast tailnet) as `redacted-ip.invalid`, and getStats may leave it empty; mDNS names
     are treated the same way;
   - anything else, e.g. a malformed numeric or IPv6-like string (`100.64.0.01`, `fd7a::115c::1`),
     fails.

   A failed check tears the session down (`non-tailnet-path`). Do not read this rule as "any present
   non-Tailscale remote string fails": that reading ended healthy sessions on the redacted
   placeholder. Media is attached to the transceivers only after the host's check passes (§10).
   Main appends `--disable-features=WebRtcHideLocalIpsWithMdns` so host candidates are real IPs.
   Residual: Chromium still gathers candidates on every adapter, so sockets bound to a LAN address
   send STUN connectivity checks toward the peer's Tailscale IPs, and the OS routes those through
   the LAN gateway (into ISP CGNAT space) instead of the tunnel. They carry no secrets and fail, but
   they reveal session activity to the LAN/ISP. The Windows installer blocks them on **wireless**
   adapters (outbound UDP 47801–47899 to the Tailscale ranges, `interfacetype=wireless`). Wired LAN
   adapters on Windows and every adapter on macOS keep this behaviour. There is deliberately no
   `interfacetype=ras` rule, because it is unverified whether Windows classifies the Tailscale
   (Wintun) adapter as RAS.
6. Encryption: WireGuard (Tailscale) + DTLS-SRTP (WebRTC). Passwords never cross the wire
   (scrypt + HMAC challenge/response).
7. Host user is always informed: a visible always-on-top **session panel** exists for the whole
   duration of every session (cannot be disabled), showing who is connected + Disconnect. The
   viewer cannot drive the panel or the approval prompt directly: a remote press on them is dropped,
   a remote drag never moves onto them, and remote keystrokes are dropped while one of them has the
   keyboard (`input.setPointerGuard` / `setKeyGuard`, wired in index.js to `windows.sessionUiAt` /
   `sessionUiFocused`). This is not a sandbox: a viewer with Control has the host's desktop and can
   still minimize or cover the panel through the OS (e.g. Win+D), use OS accessibility input
   (MouseKeys) or run programs. Security settings stay locked during sessions (§6) regardless.
8. **Fixed ports** so Tailscale ACLs / firewalls can be precise: signaling TCP `47800`
   (`settings.port`, user-configurable 1024–65535), WebRTC UDP `47801–47899` — main calls
   `webContents.setWebRTCUDPPortRange({ min: 47801, max: 47899 })` on every panel and viewer window
   before any RTCPeerConnection exists (`PROTOCOL.RTC_UDP_MIN/MAX`). The Windows installer
   (`build/installer.nsh`) adds firewall rules for `program=<install dir>\Tunnelview.exe`, scoped to
   `remoteip=100.64.0.0/10,fd7a:115c:a1e0::/48` only, on every profile:
   - `Tunnelview (Tailscale only) - TCP signaling`: inbound TCP on **any** local port, so a changed
     `settings.port` keeps working. The listener only ever binds Tailscale IPs (§1.1);
   - `Tunnelview (Tailscale only) - UDP 47801-47899`: inbound UDP for WebRTC;
   - `Tunnelview - no tailnet UDP via Wi-Fi`: outbound UDP 47801–47899 block on wireless adapters
     (§1.5).

   A real uninstall (not an upgrade) also removes the login item: the HKCU
   `…\CurrentVersion\Run` value and its `…\Explorer\StartupApproved\Run` twin, both named
   `io.github.naminaone99.tunnelview`, which is the AppUserModelId Electron uses for `setLoginItemSettings`.
9. **Packaged builds run only their own code.** `electronFuses` in `electron-builder.yml` turns
   off `runAsNode` (ELECTRON_RUN_AS_NODE), `enableNodeOptionsEnvironmentVariable` (NODE_OPTIONS)
   and `enableNodeCliInspectArguments` (`--inspect*`, SIGUSR1). It turns on
   `enableEmbeddedAsarIntegrityValidation` and `onlyLoadAppFromAsar` (an edited `app.asar` or a
   side-loaded `resources/app/` will not run) and `enableCookieEncryption`.
   `grantFileProtocolExtraPrivileges` keeps its default, because every renderer is a `file://`
   page importing ES modules. Without these fuses, any local process could run code with Tunnelview's
   macOS Screen Recording / Accessibility grants. `scripts/verify-fuses.js` checks every CI build.
   Main also rejects debugging switches and `--dev` in packaged builds (`app.isPackaged`), so
   `--dev` works only in development runs.

## 2. Repository layout

```
package.json                electron-builder config lives in electron-builder.yml
electron-builder.yml
build/                      icon.png (generated), entitlements.mac.plist, installer.nsh
scripts/make-icons.js       generates build/icon.png (1024²) without external deps
scripts/check.js            syntax-checks every .js file (node --check / vm for ESM)
scripts/verify-fuses.js     checks a packaged app's Electron fuses + ASAR integrity (CI, §1.9)
scripts/mac-install.sh      builds Tunnelview.app on a Mac and installs it (README › macOS)
.github/workflows/build.yml Windows + macOS builds
docs/ARCHITECTURE.md        this file
README.md, SECURITY.md, LICENSE
test/*.test.js              node --test (pure Node; no Electron required)
src/shared/protocol.js      UMD constants (main: require; renderer: window.TunnelviewProtocol)
src/main/
  index.js                  app lifecycle, single-instance, command-line switches, wiring
  settings.js               JSON settings store (userData/settings.json)
  tailscale.js              CLI discovery, status, whois, IP validation, watcher
  auth.js                   scrypt password hashing, challenge/response
  host-server.js            HTTP+WS listener on Tailscale IPs, admission, host session state
  viewer-client.js          outbound WS client for one viewer session
  windows.js                BrowserWindow factories (main, viewer, panel, prompt)
  ipc.js                    every ipcMain handler (validates sender + payloads)
  tray.js                   tray icon + menu
  icon-art.js               pure-Node pixel art (no electron): logo/tray rasterizer + PNG encoder
                            (used by icons.js at runtime AND scripts/make-icons.js at build time)
  icons.js                  runtime nativeImages built from icon-art.js
  clipboard.js              clipboard watcher (change counter) + writer
  files.js                  incoming file writer (downloads dir, sanitizing, .part → final)
  permissions.js            macOS screen-recording / accessibility checks & prompts
  capture.js                desktopCapturer + setDisplayMediaRequestHandler + display mapping
  input/index.js            injector facade, permission gate, display mapping
  input/keymap.js           KeyboardEvent.code → Windows scancode / macOS virtual keycode
  input/win32.js            koffi SendInput / GetSystemMetrics
  input/darwin.js           koffi CoreGraphics CGEvent*
  native/changecount.js     clipboard change counter (Win: GetClipboardSequenceNumber,
                            mac: [NSPasteboard generalPasteboard].changeCount via objc runtime)
src/preload/
  main.js  viewer.js  panel.js  prompt.js      (contextBridge APIs, see §6)
src/renderer/
  shared/theme.css          design tokens + base components (all windows use it)
  shared/ui.js              tiny DOM helpers (h(), toast(), formatBytes(), icons)
  shared/rtc.js             ICE filter, codec prefs, quality presets, stats helpers
  shared/transfer.js        file-transfer engine over the `file` data channel
  shared/keys.js            DOM → wire helpers for keyboard (swap Cmd/Ctrl, special combos)
  main/index.html app.js    main window (This Desk / Remote Desk / devices / settings)
  viewer/index.html viewer.js input.js toolbar.js   viewer window
  panel/index.html panel.js host session panel (visible) — also runs host-side WebRTC
  prompt/index.html prompt.js incoming-connection approval dialog
```

## 3. Process & window model

| Window  | Preload            | Global in renderer   | Lifetime |
|---------|--------------------|----------------------|----------|
| main    | preload/main.js    | `window.tunnelview`     | app; close → hide to tray if `closeToTray` |
| viewer  | preload/viewer.js  | `window.tunnelviewViewer` | one per outgoing session |
| panel   | preload/panel.js   | `window.tunnelviewPanel`  | one per incoming (host) session; runs capture + host RTCPeerConnection; `backgroundThrottling:false`; always on top; minimizable, not closable while session is active (close = end session after confirm) |
| prompt  | preload/prompt.js  | `window.tunnelviewPrompt` | one per pending incoming request |

All windows: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
`webSecurity: true`, navigation and `window.open` blocked, CSP meta in every HTML:
`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: mediastream:; connect-src 'self'`.

Host allows **one active session** at a time and **one pending prompt** at a time (§4 Pending
slot):
- while a session is active, every other request is denied `busy`;
- a request that needs a prompt while another viewer's prompt is pending is denied `busy`;
- a password, trusted or same-user admission does not wait for that prompt: it **withdraws** it
  (that viewer is denied `busy`, main gets `request-cancelled`) and is admitted.

A machine may run several outgoing viewer sessions.

## 4. Signaling protocol (WebSocket, JSON text frames)

- `PROTOCOL_VERSION` is **2**: password proofs are bound to both endpoints' Tailscale node IDs
  (Auth below). A peer speaking any other version is refused: the host answers 426 to a wrong
  `X-Tunnelview-Protocol` header and `denied: protocol` to `request.protocol !== 2`.
- URL: `ws://<tailscale-ip>:<port>/tunnelview/v1` (IPv6 → `ws://[fd7a:…]:<port>/tunnelview/v1`).
  Default port **47800** (`PROTOCOL.DEFAULT_PORT`). Client sends header `X-Tunnelview-Protocol: 2`,
  no `Origin`. `maxPayload` 1 MiB both sides. Handshake timeout 8 s. ws-level ping every 15 s;
  a peer missing 2 pongs is dropped.
- HTTP `GET /tunnelview/v1/info` on the same port (same IP + whois checks and the same `allowFrom`
  policy, refused with 403, because it reveals whether a host is unattended or busy; no Origin
  required since it carries nothing secret) → `200 application/json`:
  `{ app:'Tunnelview', protocol:2, version, hostname, os:'windows'|'macos', passwordSet, acceptMode, busy }`.
  Everything else → 404.
- Refusals before a WebSocket exists are bare HTTP statuses. **403 means policy only**: the
  `allowFrom` policy refused this peer. The other 403 cases (non-Tailscale address, `Origin`
  present, non-IP `Host`) cannot come from a real viewer. A `tailscale whois` failure (often
  transient) is answered **503** like "not ready / too many connections" (connection limits below),
  and the viewer reports it as `denied:busy` ("try again"), never as "not allowed". 426 = wrong
  protocol header. 429 = rate limited (20 WebSocket upgrades or 60 `/info` requests per minute per
  source IP); the viewer reports it as `rate-limited`, not as a password lock. An upgrade that `ws`
  would refuse (not `GET` → 405; a missing or invalid `Upgrade` / `Sec-WebSocket-Version` /
  `Sec-WebSocket-Key`, or any `Sec-WebSocket-Protocol` → 400) is refused before `tailscale whois`
  and before any connection slot is touched.
- Every frame: `{ "t": "<type>", ... }`. Unknown types are ignored. Invalid JSON → close 1003.

Sequence:

```
viewer                                host
  |---- WS upgrade ------------------->|  verify IP range, whois, policy (allowFrom)
  |<--- hello -------------------------|
  |---- request ---------------------->|  proof valid? trusted node? sameUser auto-accept?
  |<--- pending ------------------------|  …else show prompt (timeout promptTimeoutSec)
  |---- auth (optional, while pending)->|  password typed after the fact
  |<--- auth-failed / accepted / denied-|
  |<--- sdp(offer) / ice ---------------|  host renderer (panel) creates offer + data channels
  |---- sdp(answer) / ice ------------->|
  |<--> permissions / bye --------------|
```

Messages:

| t | dir | fields |
|---|-----|--------|
| `hello` | H→V | `protocol:2, app:'Tunnelview', version, host:{hostname, os, user:{login, displayName}}, auth:{passwordSet:bool, acceptMode:'ask'|'password-only', salt:b64|null, kdf:{N,r,p,keylen}|null, nonce:b64, autoAccept:bool, passwordLocked:bool}` |
| `request` | V→H | `protocol:2, viewer:{hostname, os, version}, proof:b64|null` |
| `auth` | V→H | `proof:b64` (only valid while pending or after `auth-failed`) |
| `pending` | H→V | — (waiting for host user) |
| `auth-failed` | H→V | `remaining:int` (attempts left on this connection) |
| `accepted` | H→V | `sessionId, permissions:{control,clipboard,files,audio}, via:'password'|'prompt'|'trusted'|'same-user'|'self'` |
| `denied` | H→V | `reason: 'rejected'|'timeout'|'busy'|'not-allowed'|'bad-password'|'password-required'|'locked'|'protocol'|'disabled'|'auth-timeout'|'suspended'|'try-later'`, plus `retryAfterSec:int 1..3600` with `try-later` only; then close 4000 |
| `sdp` | both | `description:{type:'offer'|'answer', sdp}` |
| `ice` | both | `candidate:{candidate, sdpMid, sdpMLineIndex, usernameFragment}` or `null` (end) |
| `permissions` | H→V | `permissions:{control,clipboard,files,audio}` (host user changed them) |
| `bye` | both | `reason:string` then close 1000 |

- `hello.auth.autoAccept` is true when the host will admit this peer without a password (trusted
  node or same-user auto-accept, the same predicates as admission below; never for self).
- `hello.auth.passwordLocked` is true while password sign-in is locked for this peer (`locked` or
  `suspended`, below), so a proof would be ignored.
- With `autoAccept` or `passwordLocked` the viewer sends `request` **without a proof** and does
  not ask its user for the password. The host then admits it as trusted / same-user, shows the
  prompt, or (password-only mode, locked) answers `locked` / `suspended` right away.
- `denied` reasons:
  - `timeout`: the host user did not answer the prompt in time.
  - `auth-timeout`: no `request` arrived within 120 s of `hello`, or no new proof arrived within
    **120 s** of `auth-failed` (password-only, or during the prompt back-off).
  - `locked`: password sign-in is locked for this device, its Tailscale account or the tagged
    devices (Limits below).
  - `suspended`: password sign-in is paused host-wide (Limits below).
  - `try-later`: the prompt back-off or the prompt rate limit is running for this device;
    `retryAfterSec` (1..3600) says when a new request can show a prompt.
- `bye` from the viewer: the host reports the viewer's reason as the session-end reason when it
  is `non-tailnet-path`, `media-timeout`, `media-failed` or `network`. Any other reason becomes
  `viewer-ended`.
  `bye` from the host: the viewer's `closed` status has `reason:'host-ended'` and carries the host's
  bye reason as `hostReason` (§7 viewer-client), so the viewer can say why (e.g.
  `capture-blocked`, §10).

Auth: stored password = `{ salt:b64(16 bytes), N:32768, r:8, p:1, keylen:32, key:b64 }` where
`key = scrypt(utf8(password.normalize('NFC')), salt, keylen, {N,r,p,maxmem:64MiB})`.
`proof = base64(HMAC-SHA256(key, AUTH.CONTEXT + nonceB64 + '|' + hostId + '|' + viewerId))` with
`AUTH.CONTEXT = 'Tunnelview-auth-v2|'`. `hostId` and `viewerId` are the two nodes' Tailscale
**StableNodeIDs** (`/^[A-Za-z0-9_-]{1,64}$/`, compared exactly):
- the **host** uses its own `self.stableId` from `tailscale status` (taken when the connection
  arrives, else from the last running status) and `whois(remote IP).node.stableId`;
- the **viewer** uses, from the same `tailscale status` it checked before dialing (§1.4), the
  `stableId` of the node that owns the dialed IP (a peer, or self for a self-connection) and its
  own `self.stableId`.

WireGuard authenticates which node an address belongs to, so a tailnet node cannot relay another
host's hello and the viewer's proof back: the proof would be bound to the relay's ID. Unlike IPs,
node IDs stay the same when Tailscale masquerades a shared node's address. Host compares with
`crypto.timingSafeEqual`. The viewer refuses KDF params outside `N ≤ 2^17, r ≤ 16, p ≤ 4,
keylen 32` (malicious host DoS) and below a minimum work of `N·r ≥ 2^17`.

Limits:
- 3 proof attempts per connection, then `bad-password`.
- Failed proofs are counted per node `stableId` (fallback: its IP) **and** per Tailscale login of
  an untagged node. All tagged nodes share **one** budget, because anyone who may tag nodes can
  create new ones. A self-connection counts only against this node, never the owner's login.
  10 failures in 15 min on any of these keys → `locked` for 15 min.
- A host-wide cap of 30 failures in 15 min across all peers **suspends** password sign-in for
  15 min (`suspended`). Exempt from the suspension (still counted, and still subject to their own
  locks): devices admitted before (same `stableId` and login, remembered in memory for 30 days)
  and the owner's own untagged devices. Never self.
- **Locks gate only password verification.** While password sign-in is locked for a peer
  (`hello.auth.passwordLocked`), a proof in `request` is ignored, neither verified nor counted,
  and admission continues as if none was sent: trusted, same-user and prompt admission keep
  working. A request that needs the password (password-only mode) gets `locked` / `suspended`
  instead of `password-required`. An `auth` sent while the prompt is showing is ignored; after
  `auth-failed` it gets `locked` / `suspended`.

Admission decision order (host): `hostEnabled` false → `disabled`; an active session → `busy`; `allowFrom`
policy (`tailnet` = any verified peer; `same-user` = whois login == self login and node not
tagged; `list` = whois login, node `stableId`, full MagicDNS name, or its first label when the node
is in this host's own tailnet (`magicDnsSuffix`) in `allowList` — never the self-reported hostname) → `not-allowed`; password sign-in locked ⇒ the proof is ignored; prompt
back-off running and no usable proof ⇒ `try-later`; proof present → valid ⇒ accept `password` /
invalid ⇒ `auth-failed` (or `bad-password` / `locked` / `suspended`); back-off running after a
failed proof ⇒ a 120 s wait for the next `auth` (no prompt); peer is self IP ⇒ prompt (never
silently auto-accept); trusted node ⇒ `trusted`; `autoAcceptSameUser` && same user ⇒ `same-user`;
`acceptMode==='password-only'` ⇒ `password-required` (`locked` / `suspended` while password
sign-in is locked), or, after a failed proof, a 120 s wait for the next `auth`; else prompt. Every
prompt, self included, first passes the prompt rate limit (else `try-later`), then needs the
pending slot (another viewer's prompt pending ⇒ `busy`). Every admission without a prompt
(`password`, also by a later `auth`; `trusted`; `same-user`) withdraws another viewer's pending
prompt (Pending slot below).
- **Trusted** = a `trustedNodes` entry with the node's `stableId` whose stored `login` equals the
  node's current whois login, and the node has no tags. Tagged nodes cannot be set to *Always
  allow*: the prompt does not offer it, and main and host-server never save it for them.
- **Prompt back-off** (per node, keyed by `stableId`, fallback IP):
  - a prompt the host user **dismisses** starts 30 s, then 2 min, then 10 min for repeated
    dismissals (back to 30 s after 1 h without one);
  - an **unanswered** prompt (timeout) costs a flat 30 s and does not escalate;
  - while it runs, the node's requests without a usable proof are denied `try-later` with
    `retryAfterSec` (no prompt, no pending slot). A valid password still gets in; a wrong one gets
    `auth-failed` and the 120 s wait for the next `auth`;
  - it is cleared when that node is admitted (any path) and when hosting is stopped or switched
    off / on.
- **Prompt rate limit**: at most 3 prompts per node per 5 min, whatever happened to them
  (withdrawn, dismissed or unanswered). A further request that would prompt is denied `try-later`
  until the oldest of the three is 5 min old. Cleared like the back-off.
- **TCP limits** (every accepted socket, before the HTTP layer reads a byte): a socket from a
  non-Tailscale source address, or while the host is not started, is closed at accept. At most
  **4 sockets per source IP** may be not yet handed to `ws` (`MAX_PREUPGRADE_PER_IP`; `/info`
  requests and upgrades still waiting for `tailscale whois` count); more are closed at accept. Such
  a socket idle for **5 s** (`PREUPGRADE_IDLE_MS`) is closed. The HTTP server uses
  `headersTimeout` / `requestTimeout` **5 s**, checked every **1 s** (`connectionsCheckingInterval`),
  `keepAliveTimeout` 2 s and `maxConnections` **512** per listening address
  (`MAX_TCP_CONNECTIONS`).
- **Connection limits** (WebSocket): at most 16 live connections in total and 4 per source IP. A
  node may hold at most **2 unanswered** connections (`hello`, `auth` or `pending`); its 3rd
  WebSocket upgrade gets 503.
- **Eviction**: when all 16 are taken, the host picks the node holding the most unanswered
  connections (on a tie, the one whose oldest candidate is older). Its oldest connection still in
  `hello` or `auth` is denied `busy` to make room; the active session, the pending prompt and a
  closing connection are never candidates. If that node has no candidate, the newcomer gets 503:
  a less busy node's connection is never taken instead. Only an upgrade `ws` will accept can evict:
  invalid WebSocket headers are refused first (400 / 405, above), and a half-closed socket is
  dropped without evicting anyone.
- **Pending slot**: held only by a connection whose **prompt is showing**. It is claimed when the
  prompt starts, after the prompt rate limit, and freed when the prompt is answered, times out or
  is withdrawn. A request that needs a prompt while another connection holds it is denied `busy`.
  A password, trusted or same-user admission withdraws the holder: that viewer is denied `busy`,
  main gets `request-cancelled`, and no back-off is recorded for it. A connection waiting for the
  next `auth` after `auth-failed` does **not** hold the slot, so other viewers are not answered
  `busy` meanwhile.

Accepted sessions start with `settings.defaultPermissions` (prompt may override).

## 5. Data channels (created by host, all ordered + reliable)

### `input` (V→H, JSON strings)
Coordinates `x,y` are floats in `[0,1]` relative to the **currently streamed display**.

| t | fields |
|---|--------|
| `mm` | `x, y` mouse move |
| `md` / `mu` | `b, x, y, n` — `b` DOM button (0 left,1 middle,2 right,3 back,4 forward), `n` click count (`MouseEvent.detail`, ≥1) |
| `wh` | `dx, dy` — DOM wheel deltas in **CSS pixels** (viewer converts `deltaMode` LINE ×40, PAGE ×800). Positive `dy` = scroll down. |
| `kd` / `ku` | `code` (KeyboardEvent.code after optional Cmd/Ctrl swap), `key`, `rep:bool` (kd only), `locks?:{caps:boolean, num?:boolean}` (kd only: the viewer's lock-key state, from `getModifierState`; macOS viewers, whose keyboards have no NumLock, send `num:true`). Before injecting a letter key (caps) or a numpad key (num) the host taps CapsLock / NumLock once if its own state differs, so both sides agree. |
| `txt` | `text` — type Unicode text (≤ 2000 chars per message) |
| `combo` | `codes:[...]` — press in order, release in reverse (special keys menu) |
| `release-all` | — release every held key/button (viewer blur, toolbar, disconnect) |

### `control` (both, JSON strings)
| t | dir | fields |
|---|-----|--------|
| `displays` | H→V | `displays:[{id, name, primary, width, height, scaleFactor}], current:id` (width/height = physical px) |
| `select-display` | V→H | `id` |
| `quality` | V→H | `preset:'quality'|'balanced'|'speed'` |
| `clipboard` | both | `kind:'text', text` (≤ 200 000 chars in total; images go through `file` with `purpose:'clipboard-image'`). Text up to `CONTROL.CLIPBOARD_SINGLE_MAX_BYTES` (240 000) UTF-8 bytes is one message. Longer text is sent as parts `{t:'clipboard', kind:'text', text, part:{id, seq, last}}`: `seq` 0..15 in order, each `text` ≤ `CONTROL.CLIPBOARD_CHUNK_CHARS` (40 000) UTF-16 code units, at most `CONTROL.CLIPBOARD_MAX_PARTS` (16), and `last:true` on the final part. The receiver joins the parts of one `id` and drops incomplete or out-of-order sets. |
| `chat` | both | `text` (≤ 4000 chars), `ts` |
| `host-state` | H→V | `audio:bool, controlAllowed:bool, inputBlocked:null|'secure-desktop'|'elevated-window'` informational. `inputBlocked` is non-null while the host OS refuses injected input (Windows UAC / lock screen, or an elevated foreground window), so the viewer can show a banner. |

### `file` (both; JSON strings + binary `ArrayBuffer` chunks)
Two **lanes** per direction: `FILE.LANE_FILE` (0) for `purpose:'file'` and `FILE.LANE_CLIPBOARD`
(1) for `purpose:'clipboard-image'`. Each lane carries one outgoing transfer at a time and queues
the rest, so clipboard images never wait behind a large file. **Every binary frame starts with
a 1-byte lane id**, followed by the chunk bytes. The receiver routes the frame to that lane's
current incoming transfer. A frame is at most 64 KiB + 1 byte.
`file-offer {id, name, size, mime, purpose:'file'|'clipboard-image'}` → receiver replies
`file-accept {id}` | `file-reject {id, reason}` → sender streams 64 KiB binary chunks
(backpressure: pause while `bufferedAmount > 4 MiB`, resume on `bufferedamountlow` at 1 MiB) →
`file-end {id}` → receiver `file-done {id}` | `file-error {id, reason}`. Either side may send
`file-cancel {id}`. Receiver enforces declared size (extra bytes → error).
- **Receiver flow control** (file lane): the receiver sends `{t:'file-pause', id}` (`FILE.PAUSE`)
  when 16 MiB of received data for that transfer is not yet written to disk, and
  `{t:'file-resume', id}` (`FILE.RESUME`) once that falls to 4 MiB. The sender stops sending
  chunks for `id` in between.
- **Consent**: the viewer asks its user before accepting each incoming `purpose:'file'` offer. A
  refusal is `file-reject {id, reason:'declined'}`. The host side keeps its permission gate
  (`permissions.files`).
- Received files are marked as downloaded from the internet: Mark-of-the-Web (`Zone.Identifier`)
  on Windows, the `com.apple.quarantine` attribute on macOS.

## 6. IPC surface (preloads are the source of truth — see `src/preload/*.js`)

IPC channel names are `area:verb`. Main validates `event.senderFrame` belongs to the expected
window kind and validates payload shapes/types/sizes. Renderer → main fire-and-forget uses
`ipcRenderer.send`; requests use `ipcRenderer.invoke`; main → renderer uses `webContents.send`.

The exact channel list, argument shapes and return values are documented inline in each preload.
Main-side handlers live in `src/main/ipc.js` and call into the modules below. The channels and
shapes that other modules depend on are listed here as well.

**Main window** (`preload/main.js` → `window.tunnelview`)

| Channel | Preload | Contract |
|---|---|---|
| `app:open-tailscale-download` | `openTailscaleDownload()` | opens Tailscale's download page (Tailscale not installed) |
| `app:open-tailscale` | `openTailscale()` | starts / shows the installed Tailscale app (stopped, needs login) |
| `tailscale:refresh` | `refreshTailscale()` | re-reads `tailscale status` now → `AppState` |
| `app:relaunch` | `relaunchApp()` | quits and restarts Tunnelview (e.g. *Quit & Reopen* after granting Screen Recording) |
| `viewer:focus` | `focusViewer(id)` | brings the viewer window `id` (from `AppState.viewers`) to the front |
| `session:connect` | `connect(opts)` | `{ok:true}` \| `{ok:true, existing:true}` (a viewer for that device was already open and was focused instead) \| `{ok:false, error, code}`; `code` adds `'AMBIGUOUS'` (several devices match the name; §7 `resolveTarget`) |
| `settings:update` | `updateSettings(partial)` | while an **incoming session is active**, rejects changes to `acceptMode`, `allowFrom`, `allowList`, `autoAcceptSameUser`, `defaultPermissions` and `downloadDir` |
| `settings:set-password`, `settings:choose-download-dir` | `setPassword`, `chooseDownloadDir` | refused while an incoming session is active |

- `AppState.host.warning: string|null` is a non-fatal problem while listening, e.g. a Windows
  Firewall rule that blocks Tunnelview.
- `PeerInfo.probe: null|'ok'|'not-allowed'|'refused'|'timeout'|'incompatible'|'error'` is the result of the
  last `/tunnelview/v1/info` probe (`null` = not probed). `PeerInfo.tunnelview.port` is the port the
  device answered on. `connect` uses it when the user typed no port.
- `recent` entries may carry `port` (§8).

**Session panel** (`preload/panel.js` → `window.tunnelviewPanel`)

| Channel | Preload | Contract |
|---|---|---|
| `panel:select-display` | `selectDisplay(id)` | chooses the **capture source only** for the next `getDisplayMedia()`; input mapping does not move |
| `panel:commit-display` | `commitDisplay(id)` | → `{ok:true}` \| `{ok:false, error:'not-found', served:string\|null}`; moves input mapping to display `id` once its stream is live. Input mapping moves only on commit. `panel:ready` maps the initial display. When `id` vanished, main's display-media handler served another display (`capture.servedDisplayId()`, the primary): nothing is mapped and `served` names it, so the panel commits `served` and adopts it. |
| `panel:list-displays` | `listDisplays()` | the capture display list, from a cache refreshed when older than 60 s (§7 `capture.js`) |
| `panel:ready` | `ready()` | → `PanelInit`, or `null` when a panel pre-created while the prompt showed is discarded (declined, cancelled, timed out): start nothing |
| `panel:input-status` | `inputStatus()` | → `{available, reason, blocked}`, with `blocked` as `input.blocked` (§7) |
| `files:chunk` | `fileChunk(id, data)` | `invoke`/`handle` (also in `preload/viewer.js`); resolves **after the write**: `{ok:true}` \| `{ok:false, reason}`. Drives the receiver flow control of §5. |

**Viewer** (`preload/viewer.js` → `window.tunnelviewViewer`)

| Channel | Preload | Contract |
|---|---|---|
| `viewer:path-info` | `getPathInfo()` | → `{ok, direct, relay}`: whether Tailscale reaches the host directly or through the DERP region `relay` (§7 Peer extras) |

Viewer windows display the host's **Tailscale-verified** MagicDNS name and owner (resolved
through `tailscale status` / whois), never the self-reported `hostname` from `hello`.

**Prompt** (`preload/prompt.js` → `window.tunnelviewPrompt`)

| Channel | Preload | Contract |
|---|---|---|
| `prompt:ready` | `ready()` | → `PromptInit`; `peer` (like `PanelInit.peer` and the host-server request peer, §7) carries `tags: string[]`, the node's ACL tags (≤ 8 × ≤ 64 chars, `[]` = untagged) |
| `prompt:respond` | `respond({accept, permissions?, trust?})` | `trust` (*Always allow*) is ignored for self, tagged nodes and nodes without a `stableId`; the prompt does not offer it for a tagged node |

## 7. Main-process module APIs

### `tailscale.js`
```js
const ts = require('./tailscale');           // singleton instance of class Tailscale (EventEmitter)
ts.cliPath                                   // string|null after init()
await ts.init()                              // locate CLI; never throws
await ts.status()                            // → TsStatus (below); caches last result
ts.last                                      // last TsStatus or null
await ts.whois(ip)                           // → { node:{id,stableId,name,hostname,os,ips,tags:[]}, user:{id,login,displayName}, isSelf } | null  (cached 60s)
ts.isTailscaleIp(addr)                       // bool; accepts ::ffff:100.x.y.z
ts.normalizeIp(addr)                         // strips ::ffff:, zone ids, brackets
await ts.resolveTarget(str)                  // → { ip, port, portExplicit, peer } ; str = ip | ip:port | [v6]:port | name[:port]
                                             // throws Error with .code 'NOT_TAILNET'|'NOT_FOUND'|'TS_DOWN'|'AMBIGUOUS'
ts.startWatching(ms = 10000) / ts.stopWatching()
// events: 'status' (TsStatus) on every poll; 'change' (TsStatus) when state/self IPs change
```
`resolveTarget` resolves names **only** through the current peer list, in tiers. The first tier
with a match wins:
1. node `stableId`;
2. MagicDNS FQDN (`host.tailnet.ts.net`, trailing dot allowed);
3. MagicDNS short label (`host`);
4. the self-reported OS hostname, only when exactly one peer has it.

Several matches in one tier → `err.code === 'AMBIGUOUS'`. The message lists the candidates, and
the resolver never picks one by online state, OS or list order. An IP must be a Tailscale IP of a
peer (or self) → otherwise `NOT_TAILNET`. `port` is `PROTOCOL.DEFAULT_PORT` unless the string
carried one (`portExplicit: true`).
`TsStatus = { state:'running'|'stopped'|'needs-login'|'not-installed'|'error', message, self:{id,stableId,hostname,dnsName,shortName,os,ips:[...],user:{login,displayName}}|null, magicDnsSuffix, peers:[Peer] }`
`Peer = { id, stableId, hostname, dnsName, shortName, os, ips, online, lastSeen, user:{login,displayName}, tags:[] , isSelf:false, direct:boolean, relay:string }`
`direct` is true while WireGuard talks to the peer over a direct UDP endpoint. Otherwise traffic
is relayed through the DERP region named in `relay` (e.g. `'fra'`, `''` when unknown).
OS strings normalized to `windows|macos|linux|ios|android|other`.
CLI locations: Windows `%ProgramFiles%\Tailscale\tailscale.exe`, `%ProgramFiles(x86)%\…`, PATH;
macOS `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, `~/Applications/…`,
`/opt/homebrew/bin/tailscale`, `/usr/local/bin/tailscale`, PATH (a symlink to the app executable is
replaced by its target, which aborts when run through a link). Windows/Linux: `execFile` with
`windowsHide:true`, 5 s timeout.

**macOS.** The Tailscale CLI there is the Tailscale app's own executable. It acts as the CLI only
when its environment says so (`TAILSCALE_BE_CLI=1`, or shell variables such as `SHLVL`/`TERM`;
Tailscale KB 1080 "CLI on macOS"). An app started from Finder/Dock/login has none of them, so the
executable would start as the menu-bar app instead, print `The Tailscale GUI failed to start…` (or
nothing) and exit 0, or hang. Therefore:
1. The CLI runs with `TAILSCALE_BE_CLI=1` (plus `SHLVL=1`, `TERM=dumb` when unset) in its own process
   group (`spawnRunner`). A timeout SIGKILLs the whole group, so a binary behind the Standalone
   app's `/usr/local/bin/tailscale` shell wrapper cannot outlive it as a menu-bar app.
2. **Tunnel gate** (the singleton on darwin: `tunnelGate: true`). Running that executable while
   Tailscale is quit or still connecting can bring the network extension up and switch Tailscale
   off again (tailscale/tailscale#21825). So `status`/`whois` only run the CLI while a local interface
   carries a Tailscale address: any fd7a:115c:a1e0::/48 address, or a 100.64.0.0/10 address that is
   one of this node's known self IPs. That shared CGNAT range is also used by other VPNs (Cloudflare
   WARP, NetBird). Otherwise `status` is `stopped` ("Tailscale isn't connected on this Mac."), or
   `not-installed` when no CLI exists, and `whois` is null. Gate changes are logged
   (`[tailscale] …`).
3. `statusFromRun` tells the cases apart:
   - exit 0 with the GUI text → "started as the Tailscale app instead of answering";
   - exit 0 with no output → "exited without printing a status";
   - other text → quoted;
   - a signal we did not send (e.g. SIGTRAP) → a crash, not a timeout.

Tailscale's LocalAPI is deliberately **not** used directly. Its credentials point at a 127.0.0.1
port that Tunnelview cannot prove belongs to Tailscale: `/Library/Tailscale/ipnport` survives after
Tailscale quits, and any local account can then bind that port. Trusting it would let another
process supply whois identities.

### `auth.js`
```js
hashPassword(pw) → Promise<StoredPassword>
verifyProof(stored, nonceB64, proofB64, {hostId, viewerId}) → bool        // host: {own stableId, whois stableId of the remote IP}
computeProof(password, {salt, kdf}, nonceB64, {hostId, viewerId}) → Promise<b64>   // viewer: {stableId owning the IP dialed, own stableId}; validates kdf limits
normalizeBinding({hostId, viewerId}) → {hostId, viewerId} | null              // both /^[A-Za-z0-9_-]{1,64}$/
newNonce() → b64 (32 random bytes)
validateKdf(kdf) → bool
const limiter = new FailureLimiter({max:10, windowMs:15*60e3, lockMs:15*60e3}); limiter.isLocked(key); limiter.fail(key); limiter.reset(key)
```
The proof is `base64(HMAC-SHA256(key, AUTH.CONTEXT + nonceB64 + '|' + hostId + '|' + viewerId))`
with `AUTH.CONTEXT = 'Tunnelview-auth-v2|'` and both IDs Tailscale StableNodeIDs (§4). A missing or
invalid binding makes `verifyProof` return false and `computeProof` reject with code
`BAD_BINDING` (the password is not used). host-server keys the limiter `node:<stableId>` (or
`ip:<ip>`), `login:<login>` and `tagged`, plus a separate host-wide limiter (§4 Limits).

### `host-server.js`
```js
const host = new HostServer({ tailscale, settings, auth, appVersion, osName });
await host.start(); await host.stop(); host.status() → {listening, addresses:[], port, error}
host.on('request', req)      // req = {requestId, peer:{ip, hostname, os, user:{login,displayName}, stableId, tags, sameUser, isSelf}, viewer:{hostname,os,version}, respond({accept, permissions, trust}) }
                             //   peer.hostname = MagicDNS label (verified); viewer.hostname = self-reported, display only
                             //   peer.tags: string[] = the node's ACL tags (≤ 8 × ≤ 64 chars, [] = untagged);
                             //   respond({trust:true}) is ignored for self and tagged nodes
host.on('request-cancelled', requestId)   // viewer left, authenticated by password meanwhile, or its prompt was
                                           //   withdrawn by another viewer's password / trusted / same-user admission
host.on('session-start', session)          // session = {id, peer, viewer, permissions, via, startedAt}
host.on('session-signal', msg)             // sdp/ice from viewer → panel renderer
host.on('session-end', {id, reason})       // reason: the viewer's bye reason when it is non-tailnet-path |
                                           //   media-timeout | media-failed | network, else 'viewer-ended';
                                           //   or the host-side reason
host.on('status', status)
host.sendSignal(msg)                       // panel renderer → viewer (only t=sdp|ice)
host.setPermissions(perms)                 // updates + notifies viewer (t=permissions)
host.endSession(reason)
host.activeSession                          // or null
```
Admission policy (order, reasons and numbers in §4):
- **Locks gate only password verification** (`hello.auth.passwordLocked`). The password
  FailureLimiter is keyed by node `stableId` (fallback IP), by the login of an untagged node and by
  one `tagged` key shared by all tagged nodes (10 failures / 15 min each, never by source IP). A
  self-connection only counts against its node key. A host-wide limiter (30 failures / 15 min)
  suspends password sign-in (`suspended`) except for identities admitted before (in memory,
  30 days, same login) and the owner's own untagged devices.
- A **dismissed** prompt starts a per-node back-off of 30 s → 2 min → 10 min, an **unanswered** one a
  flat 30 s; at most 3 prompts per node per 5 min. During the back-off any request without a
  usable proof, and beyond the rate limit any request that would prompt, is denied `try-later`
  with `retryAfterSec`. Both are cleared when the node is admitted and when hosting is stopped or
  `hostEnabled` toggles.
- After `auth-failed` (password-only, or during the back-off) the connection does not hold the
  pending slot and waits up to **120 s** for the next `auth`, then is denied `auth-timeout`.
- Raw TCP sockets: Tailscale sources only, at most 4 per source IP not yet handed to `ws`, each
  closed after 5 s idle; HTTP header / request timeouts 5 s; `maxConnections` 512 (§4 TCP limits).
- At most 2 unanswered (`hello` / `auth` / `pending`) connections per node (else 503); a full
  table (16) denies the oldest `hello` / `auth` connection of the node holding the most unanswered
  connections `busy`, or answers 503 when that node has none (§4 Eviction).
- Only an active session makes every request `busy`. Another viewer's pending prompt blocks only
  requests that need a prompt; a password, trusted or same-user admission withdraws it (§4
  Pending slot).
- **Trusted** entries (`trustedNodes`) admit a node only when the `stableId` matches, its whois
  login equals the entry's `login` (same owner), and the node has no tags. No entry is ever saved
  for a tagged node.
- `hello.auth.autoAccept` mirrors the trusted / same-user predicates (never for self).
- The proof binding is `{hostId: own stableId, viewerId: whois(remote IP).node.stableId}`.
- A `tailscale whois` failure is answered with HTTP 503. 403 is reserved for policy refusals.

### `viewer-client.js`
```js
const vs = new ViewerSession({ tailscale, auth, target:{ip, port, peer}, password, self:{hostname, os, version} });
vs.connect();               // events: 'status' {phase, ...}, 'signal' msg, 'permissions' perms,
                            //   'closed' {reason, message, proofSent, hostReason?}
vs.submitPassword(pw)       // computes proof, sends t=auth (or t=request if not yet sent)
vs.sendSignal(msg)          // only t=sdp|ice
vs.close(reason)
```
Viewer phases: `connecting` → `hello` (host info known) → `auth-required` (password-only mode
unless `hello.auth.autoAccept` or `hello.auth.passwordLocked`, or after `auth-failed`, with
`remaining`) / `waiting` (pending prompt) → `accepted` (`{sessionId, permissions, host}`) →
`closed` (`{reason, message, proofSent}`). Errors use phase `closed` with reasons
`unreachable|not-tailnet|not-tailnet-route|not-tunnelview|timeout|protocol|rate-limited|denied:<reason>|host-ended|network`
(and `local` when the viewer closed it itself):
- `not-tailnet`: the target is not a device in the current `tailscale status` (below);
- `not-tailnet-route`: the target is a tailnet device, but the socket's local address is not one
  of our own Tailscale IPs (below);
- `rate-limited`: HTTP 429 from the host's upgrade rate limit (20 upgrades / min / source IP,
  §4), not a password lock;
- for `denied:try-later` the message ends with the wait from `retryAfterSec` ("Try again in 40
  seconds."). Its text covers both the prompt back-off and the prompt rate limit.

Both closed payloads (the `closed` event and the `status` `{phase:'closed'}`) carry
**`proofSent: boolean`**: true iff this connection put a password proof on the wire (`request.proof`
or an `auth` message). A `denied:locked` without a proof says nothing about the remembered
password (the viewer saw `hello.auth.passwordLocked`, or someone else used up a shared budget).
The ViewerStatus `closed` carries `hostReason` (the host's `bye` reason, e.g. `capture-blocked`)
when `reason` is `host-ended`. With `hello.auth.autoAccept` or `hello.auth.passwordLocked` the
viewer sends `request` without a proof and never asks for the password.

Before dialing, `connect()` reads the current `tailscale status` (not running → `unreachable`;
the IP belongs to neither self nor a peer → `not-tailnet`). Once the WebSocket upgrade completes,
and again on `hello`, the socket's **local address must be one of this node's own Tailscale IPs,
of the same family as the dialed IP**. Otherwise the OS routed the tailnet range elsewhere (a CGNAT
route conflict, Tailscale's route not installed yet) and the viewer stops with `not-tailnet-route`
before it sends `request`, its hostname or a proof. The proof binding is `{hostId: stableId of the node
owning the dialed IP, viewerId: own stableId}`, both from that same status (§4 Auth).

**Remembered password** (`ipc.js`, per viewer window): the connect-form password, or one typed in
the viewer once the host accepted it, is reused by *Reconnect*. It is forgotten on `auth-required`
with `remaining` (a wrong password), on `closed` with `denied:bad-password` or
`denied:password-required`, and on `denied:locked` **only when `proofSent` is not `false`** (a
proof was sent, or unknown). `rate-limited` and a `denied:locked` without a proof keep it. It is
also forgotten when the window closes or the target device's identity changed. ipc passes
`proofSent` through `viewer:status`; the viewer renderer ignores it.

### `input/index.js`
```js
const input = require('./input');
input.available            // bool
input.reason               // why unavailable (e.g. 'accessibility-permission', 'unsupported-platform')
input.setDisplay(display)  // Electron Display object being streamed (bounds in DIP, scaleFactor, id)
input.handle(evt)          // evt = one `input` data-channel message (already JSON-parsed)
input.releaseAll()         // Windows: if Alt or Win is held, first injects the menu-mask key VK 0xE8
                           //   so releasing them does not open the Start menu / activate a menu bar
input.refreshPermission()  // macOS: re-check AXIsProcessTrusted
input.blocked              // getter: null | 'secure-desktop' | 'elevated-window' — the host OS currently
                           //   refuses injected input (UAC / lock screen, or an elevated foreground window);
                           //   reported in control host-state.inputBlocked (§5) and panel:input-status (§6)
input.physicalRect(display) // Windows: exact physical-pixel rect of an Electron Display; else null
input.setPointerGuard(fn)  // fn({dip, window}) → true on the host's session UI: `md` there dropped, held `mm`
                           //   onto it dropped, `mu` there released at the last injected point. dip = the
                           //   point in DIP of the streamed display | null; window (Windows) = BigInt HWND of
                           //   the top-level owner window under the injected pixel | null | undefined (unknown)
input.setKeyGuard(fn)      // fn() → true while the session UI has the keyboard: `kd`/`combo`/`txt` dropped
                           //   (`ku` of a held key still released). A throwing guard counts as true.
input.reset()              // session boundary: releaseAll() + forget the Caps/Num Lock resync state
                           //   (index.js calls it when a host session ends; releaseAll() alone keeps it)
```
`kd` messages with `locks` (§5) resync CapsLock / NumLock before letter / numpad keys. On Windows
the resync tap is injected by **virtual key** (`VK_CAPITAL` / `VK_NUMLOCK`, not the
layout-dependent scancode: CapsLock is Eisu on Japanese layouts), and the next trusted read checks
that it changed the host's state. After **2 taps in a row that did not** (a remapped CapsLock,
"press Shift to turn off Caps Lock", reads that never settle), that lock is no longer resynced
until the viewer's requested state for it changes (or `reset()`), so a key is never tapped on
every keystroke. At most one tap per lock per 300 ms.
Mapping: Windows → physical rect = `screen.dipToScreenRect(null, display.bounds)`, normalized
absolute via `SM_XVIRTUALSCREEN…SM_CYVIRTUALSCREEN` and `MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK`;
keyboard via scancodes (`KEYEVENTF_SCANCODE`, `KEYEVENTF_EXTENDEDKEY` where needed); text via
`KEYEVENTF_UNICODE`. macOS → point = `bounds.x + x*bounds.width` (global display coords in points),
`CGEventCreateMouseEvent` / `CGEventCreateKeyboardEvent` / `CGEventCreateScrollWheelEvent2`,
posted to `kCGHIDEventTap`, modifier flags tracked and applied via `CGEventSetFlags`, click
count via `kCGMouseEventClickState`, drag events while a button is held, text via
`CGEventKeyboardSetUnicodeString`. Held keys/buttons are tracked so `releaseAll()` works.

### `capture.js`
```js
capture.init(session)            // installs setDisplayMediaRequestHandler on the panel session
capture.listDisplays({maxAgeMs = 5000, force = false})  // → [{id, name, primary, width, height, scaleFactor, bounds}]
                                 //   (width/height physical px); maxAgeMs Infinity = any cached list until invalidated
capture.selectDisplay(id, {mapInput = false})  // chooses source for the next getDisplayMedia() (cache of any age);
                                 //   calls input.setDisplay() only when mapInput (panel:ready / panel:commit-display)
capture.commitDisplay(id)        // → {ok:true} | {ok:false, error:'not-found'}: maps input onto display id
capture.servedDisplayId()        // id of the display last served to a getDisplayMedia() request (the selection,
                                 //   or the primary display when the selection had vanished), or null
capture.invalidate()             // drop the cached source enumeration
capture.hasCache()               // a valid (not invalidated) enumeration is cached
capture.setIdleWarm(canWarm, {delayMs}) / capture.scheduleWarm(delayMs)   // idle warm-up, below
capture.audioSupported()         // win32: true (loopback); darwin: best effort
```
Source enumeration (`desktopCapturer.getSources`, which blocks main, and with it input to every
window, for 0.45–2.3 s) is **cached until something invalidates it**: display hot-plug and metric
changes (not work-area-only changes such as a moved taskbar or Dock), `powerMonitor` `resume` and
`unlock-screen`, or the display-media handler failing to resolve a source. An enumeration that
found no capturable screen (macOS without Screen Recording) is never cached.

The list is **warmed at idle**: **3 s** after startup or hosting switched on; **2 s** (debounced)
after an invalidation, a prompt closing or a session end, and after the last outgoing viewer
session closed. A warm-up is skipped while `canWarm()` (index.js) says no:
- hosting off, or a prompt or host session in progress;
- the **OS session is locked** (`powerMonitor` `lock-screen` … `unlock-screen`, or
  `getSystemIdleState` reports `locked`). On the Windows lock screen (secure desktop, no DXGI)
  sources come without `display_id` and would be paired with displays by index. A refusal while
  locked looks again 60 s later, and `unlock-screen` invalidates the cache, which re-warms 2 s
  later on the user's desktop;
- an **outgoing viewer session** is connecting or connected (any viewer window not `closed`): the
  main-process stall would freeze that viewer's remote input. main re-schedules the warm-up when
  the last one closes;
- macOS without Screen Recording.

A prompt enumerates only when nothing valid is cached, and the
prompt and session start reuse the cache whatever its age. Only `panel:list-displays` (the
panel's own display list) refreshes an enumeration older than **60 s**.

### `clipboard.js`
```js
clipboardWatcher.start(); .stop()
clipboardWatcher.on('change', {kind:'text', text} | {kind:'image', png:Buffer})
clipboardWatcher.write({kind:'text', text} | {kind:'image', png:Buffer})   // suppresses echo of its own write
```

### `icon-art.js` (pure Node — no electron import)
```js
drawAppIcon(size) → { width, height, data: Buffer /* RGBA, straight alpha */ }
drawTrayIcon(size, { template = false, state = 'idle' /* 'idle'|'active'|'off' */ }) → { width, height, data }
//   template=true → black glyph + alpha only (macOS template image); state adds a small status dot when not template
encodePNG({ width, height, data }) → Buffer
```
`icons.js` converts RGBA → the platform order `nativeImage.createFromBitmap` expects (BGRA on
Windows/macOS), adds @2x representations, and exports `appIcon()`, `trayIcon(state)`.

### `files.js`
```js
files.begin(ownerId, {id, name, size, purpose}) → {ok, reason?}   // only purpose 'file' (clipboard images are assembled in the renderer and written with clipboard:write)
files.chunk(ownerId, id, Uint8Array) → Promise<{ok:true} | {ok:false, reason}>   // resolves once written
files.end(ownerId, id) → {ok, path?, reason?}
files.abort(ownerId, id)   files.abortAll(ownerId)   files.forgetOwner(ownerId)   files.abortAllSync()
files.reveal(ownerId, id)   files.openFolder()
files.prepareDir() → {ok, path?, reason?}   // create the receive folder and check it is writable
```
Names: basename only, strip `\/:*?"<>|` and control chars, cap 200 chars, reserved Windows names
prefixed with `_`, dedupe `name (1).ext`; write `name.part` then rename. Max 50 GiB per file.
Each renderer's transfers are namespaced by `webContents.id` (`ownerId`). The `files:chunk` IPC
resolves only after the chunk is written (§6). Received files are marked as downloaded from the
internet (Windows Mark-of-the-Web, macOS quarantine).
- `begin()` reasons: `bad-request`, `unsupported-purpose`, `too-large`, `duplicate-id`, `busy`,
  `no-space`, **`no-access`** (`EPERM` / `EACCES` on the receive folder or the file, or the folder
  preparation or the `.part` creation did not answer within 10 s) and `io-error`. The reason reaches the sender as
  `file-reject {reason}` (§5).
- **Free-space floor**: `begin()` refuses with `no-space` when the volume would keep less than
  `max(1 GiB, min(2 % of the volume, 4 GiB))` plus the bytes still owed to running transfers.
- **macOS Downloads folder**: the default receive folder `~/Downloads/Tunnelview` is
  privacy-protected (TCC, `NSDownloadsFolderUsageDescription` in `electron-builder.yml`). The first
  **data** access shows the Downloads-folder alert and blocks until someone at the Mac answers it,
  which a remote controller cannot do. So `index.js` calls `prepareDir()` in the background at
  startup, when hosting is switched on and when the download folder changes (hosting enabled only).
  **Folder preparation** (single-flight per folder, time-boxed to 10 s for `begin()`) runs
  `mkdir -p`, then on macOS creates and deletes a probe file `.tunnelview-write-test-<pid>` inside the
  folder, then `statfs`. The probe is what triggers the alert when the folder already exists (after
  an update or a `tccutil reset`): `mkdir` of an existing folder, `statfs` and `access()` are
  metadata calls that TCC lets through. An existing probe file counts as success and is left alone;
  `EPERM` / `EACCES` from the probe means `no-access`. Being single-flight, a blocked folder ties up
  one pending call, not one per offered file. `begin()`'s own `.part` creation (exclusive `wx`) is
  time-boxed the same way (10 s → `no-access`); a create that completes late is closed and its file
  deleted. Until access is allowed, files sent to the Mac fail with `no-access`.

### `index.js` (lifecycle and wiring)
- While an **incoming** session is active, main holds
  `powerSaveBlocker.start('prevent-display-sleep')` and stops it when the session ends. Chromium's
  WebRTC wake lock only prevents app suspension, so without it the display would sleep (frozen
  video) and a Mac set to ask for the password after the display turns off would lock. Viewer
  sessions do not hold it. Locking the computer by hand still works.
- HostServer is given a **settings view**, not the store. Its `get()` returns a deep copy of
  `settings.get()` with `defaultPermissions.audio` forced to `false` when
  `capture.audioSupported()` is false (a Mac without the loopback opt-in), so sessions admitted by
  password, trusted node or same-user start without audio, as the prompt path does. `update()` and
  `on` / `removeListener` / `off('change')` go to the real store; the stored settings are unchanged.
- **Login item** (packaged builds, at startup; `startAtLogin`, §8). Windows: registers the Run entry
  when the setting is on and the entry is missing; when the user disabled Tunnelview in Task Manager ›
  Startup apps (entry present, StartupApproved off) it turns the setting off instead of
  re-registering. macOS reads the **SMAppService status** (`app.getLoginItemSettings().status`) and
  never re-registers over the user:
  - wanted + `not-registered` after Tunnelview had registered it (`loginItemApplied`, §8): the user
    removed it in System Settings › General › Login Items, so `startAtLogin` is turned off;
  - wanted + `requires-approval`: registered, waiting for the user; a hint notification that opens
    the Login Items settings is shown once per process;
  - wanted + `enabled`: nothing to do; wanted + never registered, `not-found` or unknown: register;
  - not wanted + `enabled` / `requires-approval`: unregister.

  After each macOS (un)registration main records `loginItemApplied` (true when the status is
  `enabled` or `requires-approval`).
- macOS: puts Tunnelview on the Screen Recording list and prepares the receive folder (`files.js`)
  at startup and when hosting is switched on (the folder also when it changes), so both permission
  alerts appear while someone is at the Mac. The probe file of the folder preparation makes the
  Downloads alert appear even when the folder already exists.
- Idle display warm-up gates (`capture.setIdleWarm`, §7 `capture.js`): `lock-screen` /
  `unlock-screen` and `getSystemIdleState` for the locked OS session, `ipc.listViewers()` for
  outgoing viewer sessions (checked on each coalesced state push, which re-schedules the warm-up
  once the last viewer session closed).

## 8. Settings (`userData/settings.json`, written atomically)

```js
{
  version: 1,
  hostEnabled: true,
  port: 47800,
  acceptMode: 'ask',               // 'ask' | 'password-only'
  allowFrom: 'tailnet',            // 'tailnet' | 'same-user' | 'list'
  allowList: [],                   // strings: Tailscale logins, node stable IDs, full MagicDNS names, or the
                                   //   first label for nodes of this tailnet (§4) — never matched against
                                   //   the self-reported OS hostname (§1.2)
  autoAcceptSameUser: false,
  trustedNodes: [],                // [{stableId, name, login, addedAt}] — admits only while the node's
                                   //   whois login === login and it has no tags (§4); never saved for
                                   //   self or a tagged node
  password: null,                  // StoredPassword | null
  defaultPermissions: { control: true, clipboard: true, files: true, audio: true },
  promptTimeoutSec: 30,
  quality: 'balanced',             // 'quality' | 'balanced' | 'speed'
  codec: 'auto',                   // 'auto' | 'h264' | 'vp9' | 'vp8' | 'av1'
  gpuVideoDecode: false,           // Windows viewer: GPU video decoding. false → index.js appends
                                   //   --disable-accelerated-video-decode before 'ready' (read straight
                                   //   from settings.json; applies after a restart). Ignored on macOS.
  clipboardSync: true,
  swapCmdCtrl: 'auto',             // 'auto' (swap when OSes differ) | 'on' | 'off'
  downloadDir: null,               // null → <Downloads>/Tunnelview
  startAtLogin: false,
  loginItemApplied: false,         // main-only: Tunnelview registered the macOS login item (SMAppService);
                                   //   never accepted from the renderer (ipc settings:update drops it)
  closeToTray: true,
  favorites: [],                   // peer stableIds
  recent: [],                      // [{stableId, hostname, ip, os, ts, port?}] max 20 (port: last port used)
  theme: 'system'                  // 'system' | 'dark' | 'light'
}
```
`settings.get()` returns a deep copy; `settings.update(partial)` validates every field (unknown
keys dropped, wrong types → keep old), persists, emits `'change'`. The renderer never sees
`password` — only `passwordSet: bool`.

## 9. Quality presets (`src/renderer/shared/rtc.js`)

| preset | contentHint | maxBitrate | maxFramerate | scaleDownBy | degradationPreference |
|--------|-------------|-----------:|-------------:|------------:|-----------------------|
| quality | `detail` | 25 Mbps | 60 | 1 | `maintain-resolution` |
| balanced | `detail` | 10 Mbps | 60 | 1 | `balanced` |
| speed | `motion` | 4 Mbps | 60 | per capture size (`speedScaleFor`) | `maintain-framerate` |

*Fast* (`speed`) does not use a fixed factor: an odd encoded size (2560×1440 / 1.5 = 1707×960)
drops Chromium from the hardware H.264 encoder to OpenH264. `rtc.speedScaleFor(width, height)`
returns the scale (≥ 1) as follows:
1. An odd side is first **floored to even** (Chromium briefly reports 2561×1440 before a
   2560×1440 capture settles; both get the same scale).
2. **Exact target**: the short side becomes the largest of 1440 / 1080 / 900 / 720 / 540 that is
   at most short ÷ 1.3 and keeps the long side an exact even integer (2560×1440 → 1920×1080,
   1920×1080 → 1280×720, 3840×2160 → 2560×1440).
3. Otherwise **nearest even long side**: the same targets, largest first, with the scaled long side
   rounded to the nearest even integer. A target is accepted when rounding and truncation agree on
   an even short side (the target), the long side is exact, and the aspect ratio moves by less than
   **0.2 %** (3340×2158 → 1672×1080, 3838×2024 → 2048×1080).
4. Otherwise 2 when both halves of the floored size are even, else 1. An unknown size gives the
   preset default, 2.

For an even capture size the encoded size is always a pair of even integers, whether WebRTC rounds
or truncates width ÷ scale, and never larger than the capture. The host applies the scale once
the capture size is known (2 until then) and again when the capture size changes; it compares the
size floored to even, so the transient odd size does not re-apply the same scale.

Codec `auto` → prefer H264 (hardware), then VP9, then VP8 via `transceiver.setCodecPreferences`.
Viewer sets `receiver.jitterBufferTarget = 0` (and legacy `playoutDelayHint = 0`) for low latency.

## 10. Shared renderer modules (ES modules in `src/renderer/shared/`)

Every page loads, in order: `<link rel="stylesheet" href="../shared/theme.css">`,
`<script src="../../shared/protocol.js"></script>` (classic → `window.TunnelviewProtocol`), then its
own `<script type="module" src="./x.js">`. Modules import each other with relative paths
(`import { h } from '../shared/ui.js'`).

### `ui.js` (used by every window)
```js
export function h(tag, attrs = null, ...children)   // attrs: class|className, style (object|string), dataset (object),
                                                    // on<Event> functions (onClick → addEventListener('click')),
                                                    // boolean true → setAttribute(k,''), false/null → skip, else setAttribute.
                                                    // children: string|number (→ text node, never innerHTML) | Node | array | null/false (skipped)
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export function toast(message, { kind = 'info', timeout = 3500 } = {})   // kind: info|ok|warn|danger; uses .toast-host/.toast
export function icon(name, { size = 16, className = '' } = {}) → SVGElement  // inline SVG, stroke=currentColor
//   names: monitor windows apple linux phone server plug power copy check x lock unlock keyboard mouse
//          clipboard file folder chat settings refresh star star-fill fullscreen fullscreen-exit camera
//          gauge eye eye-off send chevron-down more user shield volume volume-off upload download info
//          alert search link minimize maximize grip
export function osIcon(os) → SVGElement             // windows|macos|linux|ios|android|other
export function formatBytes(n) → '1.2 MB'
export function formatDuration(ms) → '1:05:09' | '05:09'
export function timeAgo(tsOrIso) → 'just now' | '5 min ago' | …
export function applyTheme(theme)                   // 'system' removes data-theme, else sets it on <html>
export function initials(name) → 'NB'
```

### `rtc.js` (used by panel + viewer)
```js
export const RTC_CONFIG = { iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' };
export function isTailscaleAddress(addr) → bool            // 100.64.0.0/10 or fd7a:115c:a1e0::/48 (brackets/zone stripped)
export function candidateAddress(candidateLine) → string|null   // 5th field of "candidate:…" line
export function isAllowedCandidate(init) → bool            // init = RTCIceCandidateInit|null; null or empty candidate '' (end-of-candidates) → true
export const PRESETS = { quality:{…}, balanced:{…}, speed:{…} }   // §9 table
export function speedScaleFor(width, height) → number      // 'speed' scaleResolutionDownBy for that capture size (§9):
                                                           //   odd → even floor, exact target, else nearest even long
                                                           //   side within 0.2 % aspect error, else 2 or 1
export function captureSizeLimit(display) → {width, height}|null   // capture cap (below); display in physical px
export function mungeAnswerForSend(sdp, {startKbps, opusStereo}) → sdp   // adds fmtp keys, never duplicates
export async function applyPreset(sender, presetName, opts = null)  // sets track.contentHint + encodings/degradationPreference;
                                                           //   opts.scaleResolutionDownBy (≥ 1) overrides the preset's
export function preferCodecs(transceiver, codec)           // 'auto'|'h264'|'vp9'|'vp8'|'av1'; no-op if unsupported
export function pairIsTailnet(pair) → bool                 // pair = RTCIceTransport.getSelectedCandidatePair();
                                                           //   path rule (§1.5): local must be a Tailscale IP literal
                                                           //   (missing / non-IP → false); remote IP must be a Tailscale
                                                           //   IP, no address / host name (redacted-ip.invalid, mDNS) is
                                                           //   allowed, malformed numeric → false; no local or remote → false
export function describePair(pair) → { ok, local, remote, pair, protocol, localType, remoteType }   // ok = pairIsTailnet
export async function verifyTailnetPath(pc) → { ok, local, remote, pair, protocol, localType, remoteType }
                                                           //   getStats() selected pair, same rule except that a missing
                                                           //   local address is accepted (a present one must be a Tailscale
                                                           //   IP); no selected pair or getStats failure → ok:true, pair:false
                                                           // describePair / verifyTailnetPath local and remote: IP literals
                                                           //   (brackets / zone id stripped) or null, never a host name
export function startStats(pc, cb, intervalMs = 1000) → stopFn
//   cb({ direction:'inbound'|'outbound', fps, width, height, bitrateKbps, rttMs, packetsLost, jitterMs, codec, framesDropped })
export function setLowLatency(receiver)                    // jitterBufferTarget = 0, playoutDelayHint = 0 (try/catch)
export function sendJson(channel, obj) → bool              // false if channel not 'open'
export function parseJson(data) → object|null
```

### WebRTC session behaviour (panel = offerer, viewer = answerer)
- **Fast start**: the host adds its transceivers (video, audio) **without shared `MediaStream`s**
  and creates the data channels. It sends the offer **before capture finishes**, so ICE and DTLS
  run while `getDisplayMedia()` is still pending.
- **Media after verification**: the captured tracks are attached (`sender.replaceTrack`) only
  after `verifyTailnetPath(pc)` has confirmed the selected candidate pair (§1.5).
- **ICE restart**: the host may re-offer mid-session (`createOffer({iceRestart:true})`), e.g. after
  `iceConnectionState` `disconnected`/`failed`. The viewer answers any offer that arrives while its
  signaling state is `stable`.
- **Disconnect grace**: a connection that stays disconnected is given up after **30 s on the
  host** and **35 s on the viewer**, so the host, which can restart ICE, decides first.
- **No input while the picture is not live**: while ICE is disconnected / recovering, or the
  viewer's video decoder is stalled, the viewer sends **no input**. It shows *View only ·
  recovering* / *View only · video stalled*, sends `release-all` when control goes away, and
  control comes back by itself on recovery. The host releases every key and button the viewer
  held as soon as its connection enters `reconnecting`.
- **Decoder stall** (viewer `stats.js` `DecoderStallDetector`, inbound-rtp sampled every 500 ms):
  stalled = frames received (≥ 3) but none decoded for **≥ 1 s**, only after the first decoded
  frame. The 1 s clock runs only while frames keep **arriving** undecoded: after a sample with no
  new frame since the last decoded one (static screen, ICE outage, display switch) it restarts at
  the first sample that sees frames again, so frames resuming after a pause are not a stall. It
  clears as soon as a frame is decoded or the stream is replaced. The viewer shows *Video stalled —
  recovering…* and logs the counters; it never reconnects by itself.
- **Modifiers after a focus loss**: blur sends `release-all`. A modifier still held when the window
  comes back (no new keydown, e.g. ⌘ after a ⌘Tab round trip) is pressed again from the event's
  flags before the next key, click or wheel that uses it, **only while the viewer window has
  focus** (a wheel over the inactive window must not press a modifier whose keyup goes to
  another app).
- **Stats overlay**: shows *Decode time* (average ms per decoded frame, from `totalDecodeTime` /
  `framesDecoded` between samples) once it is known. Chromium does not expose inbound-rtp
  `decoderImplementation` to the viewer page, so a *Decoder* row appears only if Chromium reports
  one; neither row is shown as '—'.
- **SDP munging**: the host munges the viewer's answer before applying it
  (`rtc.mungeAnswerForSend`): it adds `x-google-start-bitrate` to the video codecs' `a=fmtp` and
  `stereo=1` to Opus (its encoder). The **viewer** adds `stereo=1` to the Opus `a=fmtp` of its own
  local answer before `setLocalDescription` (libwebrtc builds the receiving decoder from the local
  description and defaults to mono), on every answer including ICE-restart re-offers. If that
  description is refused it applies the unmodified answer, and it always sends the SDP it applied.
- **Capture size**: capture is capped to fit **3840×2160** (2160×3840 for a portrait display) to
  stay within hardware-encoder limits (`rtc.captureSizeLimit`): the display is scaled to fit that
  box, aspect ratio kept, each side floored to an even number. Only when the fit scale is ≤ 0.55
  is an exact 2× downsample used instead (barely smaller, and text stays crisp).
- **Display switch**: after a new capture is live the panel calls `panel:commit-display`. When the
  wanted display vanished, main served another one (the primary) and answers
  `{ok:false, error:'not-found', served}`; the panel then commits `served`, adopts it as the current
  display and refreshes its display list (§6). When the served display's size cap differs from the
  vanished one's, the panel captures it once more at its own cap (a capture started in a smaller
  box does not grow) and commits that; if this fails, the fallback stream stays.
- **Host end reasons** include `capture-blocked`: capture is waiting for macOS approval, i.e. macOS
  15+ shows its "bypass the system private window picker" alert and nobody at the host has clicked
  *Allow*. The viewer gets it as `hostReason` (§4 `bye`).
- Viewer-side ends that the host reports as such: `non-tailnet-path`, `media-timeout`,
  `media-failed`, `network` (§4 `bye`).

### `transfer.js` (used by panel + viewer)
```js
export class FileTransfer extends EventTarget {
  // channel: the 'file' RTCDataChannel (constructor sets binaryType='arraybuffer',
  //          bufferedAmountLowThreshold = LOW_WATER and attaches its own onmessage).
  // sink: { begin(meta) → Promise<{ok,reason?}>, chunk(id, Uint8Array) → Promise<{ok,reason?}>, end(id) → Promise<{ok,path?,reason?}>, abort(id) }
  //        (pass the preload functions fileBegin/fileChunk/fileEnd/fileAbort). chunk() resolves after the
  //        write (files:chunk, §6); the pending writes drive file-pause / file-resume (§5), and a failed
  //        write is reported to the sender at once (file-error).
  // Wire: every binary frame = [1-byte lane id][≤ 64 KiB] — FILE.LANE_FILE for 'file', FILE.LANE_CLIPBOARD
  //        for 'clipboard-image'; one outgoing transfer per lane, queued per lane (§5).
  // opts: { canReceive: () => bool  (false → auto file-reject 'not-allowed'),
  //         onClipboardImage: (Uint8Array png) => void }  // purpose 'clipboard-image' is assembled in memory (≤ MAX_CLIPBOARD_IMAGE)
  constructor(channel, sink, opts)
  sendFile(file /* File or Blob with .name */) → id        // queued; one outgoing transfer per lane at a time
  sendClipboardImage(png /* Uint8Array */) → id
  cancel(id)
  close()                                                 // cancels everything, detaches
  transfers   // Map id → { id, name, size, direction:'out'|'in', purpose, state, bytes, path?, reason? }
  //   state: 'queued'|'offered'|'sending'|'receiving'|'done'|'rejected'|'error'|'cancelled'
  // events: 'update' (CustomEvent detail = transfer object) on every state/progress change (progress throttled ≤ 10/s)
}
```

### `keys.js` (used by viewer)
```js
export function shouldSwapCmdCtrl(setting, localOs, remoteOs) → bool   // 'auto' → swap iff exactly one side is macos
export function mapCode(code, swap) → code                              // MetaLeft↔ControlLeft, MetaRight↔ControlRight
export function wheelPixels(evt) → { dx, dy }                           // deltaMode normalization (§5)
export const SPECIAL_KEYS = [ { id, label, codes:[…], hosts:['windows'|'macos'] } … ]
```

## 11. Platform notes / known limits
- macOS needs **Screen Recording** and **Accessibility** permissions for the host role; the app
  detects and deep-links to System Settings (`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture` / `?Privacy_Accessibility`).
  Receiving files into the default `~/Downloads/Tunnelview` also needs **Files and Folders ›
  Downloads Folder**, asked while someone is at the Mac (§7 `files.js`); without it, received
  files fail with `no-access`.
- macOS 15+ periodically asks the host user to let Tunnelview "bypass the system private window
  picker". Until someone clicks *Allow*, capture is blocked (`capture-blocked`, §10), so an
  unattended session shows no video.
- Windows: a non-elevated app cannot control elevated windows/UAC/secure desktop (UIPI). Ctrl+Alt+Del cannot be injected.
  `input.blocked` detects the secure desktop and elevated foreground windows. The viewer shows a
  banner (`host-state.inputBlocked`, §5), and the person at the host must handle that screen.
- Viewer system shortcuts (Alt+Tab, Win, Cmd+Tab) are only captured in fullscreen via
  `navigator.keyboard.lock()`.
