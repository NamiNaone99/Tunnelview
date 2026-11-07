# Tunnelview

**Remote desktop for Windows and macOS that only works inside your [Tailscale](https://tailscale.com) tailnet.**

Tunnelview works like AnyDesk or TeamViewer: you see another computer's screen and control it with your
mouse and keyboard. It has no accounts, no cloud service and no relay servers of its own. Both
computers talk directly over Tailscale's WireGuard network, and Tunnelview refuses any connection that
does not come from a verified device on your tailnet.

```
  Viewer (the computer you sit at)                      Host (the computer you control)
 ┌──────────────────────────┐   TCP 47800  signaling   ┌──────────────────────────────┐
 │ Tunnelview viewer window │ ───────────────────────▶ │ Tunnelview listening ONLY on │
 │                          │                          │ its Tailscale IPs            │
 │ WebRTC  ◀════════════════╪═ UDP 47801–47899 ════════╪▶ WebRTC: screen, audio,      │
 │                          │   video · audio · input  │ input, clipboard, files, chat│
 └──────────────────────────┘   clipboard · files      └──────────────────────────────┘
        └──────────── everything travels inside Tailscale's WireGuard tunnel ───────┘
                       (100.64.0.0/10 and fd7a:115c:a1e0::/48 addresses only)
```

## Contents

- [Features](#features)
- [How the Tailscale-only guarantee works](#how-the-tailscale-only-guarantee-works)
- [Requirements](#requirements)
- [Installation](#installation)
- [macOS permissions](#macos-permissions)
- [Using Tunnelview](#using-tunnelview)
- [Ports and firewalls](#ports-and-firewalls)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Project layout](#project-layout)

## Features

- **Screen streaming over WebRTC.** The codec is chosen automatically (H.264 first, then VP9, then
  VP8), or you can force H.264, VP9, VP8 or AV1. Chromium uses hardware encoding when the GPU and
  driver support the codec. Decoding uses the GPU on macOS; on Windows it runs in software by default,
  because some GPU H.264 decoders freeze the picture for a second or two at a time (Settings →
  Streaming → *GPU video decoding* turns it back on after a restart). The stream runs at up to 60 fps
  with low-latency playout.
- **Quality presets:** *Best* (up to 25 Mbps, full resolution), *Balanced* (up to 10 Mbps) and
  *Fast* (up to 4 Mbps at reduced resolution, smoothest motion). You can switch presets during a
  session.
- **Full keyboard and mouse control.** All buttons, the back and forward buttons, the scroll wheel,
  double and triple clicks and drag are supported. Keys are sent as physical key codes, so the remote
  keyboard layout applies. Text with special characters can be typed through *Type clipboard text…*.
- **Cmd/Ctrl swap.** By default this is on only when one computer is a Mac and the other runs
  Windows. You can also set it to always on or off.
- **Special keys menu** with OS-specific shortcuts, such as Win+R, Alt+Tab, Ctrl+Shift+Esc, ⌘Space,
  ⌘Tab and Force Quit.
- **Fullscreen keyboard capture.** In fullscreen, system shortcuts such as Alt+Tab, the Windows key
  and ⌘Tab go to the remote computer. Hold Esc to leave fullscreen.
- **Multi-monitor support.** Pick which remote display to stream and switch at any time.
- **Clipboard sync in both directions,** for text and images.
- **File transfer in both directions,** with drag and drop, progress and cancel, up to 50 GiB per
  file. The viewer asks before accepting each file the host sends.
- **Chat** between the viewer and the person at the host.
- **Computer audio from Windows hosts** through system loopback capture.
- **Unattended access** with a password. The password never crosses the network (see
  [Security](#how-the-tailscale-only-guarantee-works)).
- **Trusted devices** that connect without a prompt, and optional auto-accept for your own devices.
- **View-only mode.** Watch the screen without sending any input.
- **Screenshots** of the remote screen, saved as PNG to `Pictures/Tunnelview`.
- **Live statistics:** fps, resolution, bitrate, round-trip time, packet loss, jitter, codec and
  the Tailscale route (direct or through a DERP relay).
- **Host-side session panel.** Whenever someone is connected, the host sees an always-on-top panel
  showing who is connected. From it the host can change permissions, chat, send files or disconnect.
  This panel cannot be turned off.
- **Device grid** built from your tailnet. It shows which devices run Tunnelview, whether they have an
  unattended password and whether they are busy.
- **Tray / menu-bar icon** that shows the hosting state: ready, session active or off.

## How the Tailscale-only guarantee works

Tunnelview treats every network input as hostile. The rules below are enforced in code. The full
contract is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §1 and §4.

1. **Tunnelview listens only on Tailscale addresses.** The host's signaling server binds to the
   computer's own Tailscale IPs, read from `tailscale status --json`. It never binds to
   `0.0.0.0`/`::`, so it is not reachable on your LAN or the internet. If Tailscale is not running,
   Tunnelview does not listen at all. It rechecks every 10 s and rebinds when the addresses change.
2. **Every inbound connection is identified.** The remote address must be in `100.64.0.0/10` or
   `fd7a:115c:a1e0::/48`, **and** `tailscale whois` must recognise it as a node of your tailnet. The
   range check alone would not be enough, because 100.64.0.0/10 is also used for ISP carrier-grade
   NAT. The Tailscale identity returned by whois (user login and device) is what the host sees in the
   approval prompt and what the *Who can connect* policy checks.
3. **Browsers cannot reach it.** WebSocket upgrades that carry an `Origin` header are rejected. A
   custom `X-Tunnelview-Protocol` header is required, and web pages cannot set it.
4. **The viewer only dials the tailnet.** It connects only to an IP that belongs to a peer in the
   current `tailscale status` (or to itself). Names are resolved through `tailscale status`, never
   through system DNS. Before sending anything it checks that the connection really leaves through
   Tailscale, and stops if another network adapter or VPN took it.
5. **Media stays on the tailnet.** WebRTC runs with no STUN or TURN servers (`iceServers: []`). Both
   sides discard every ICE candidate whose address is not a Tailscale IP. After connecting, both
   sides inspect the selected candidate pair. They end the session if this computer's end is not a
   Tailscale IP, or if the other end is an IP address outside the tailnet. An address Chromium
   hides is accepted, because every candidate was already filtered. Chromium's mDNS candidate
   obfuscation is disabled so that these checks see real addresses.
6. **Traffic is encrypted twice.** Tailscale encrypts everything with WireGuard. WebRTC adds its own
   DTLS-SRTP encryption on top. Packets relayed through Tailscale's DERP servers (when a direct path
   is impossible) are still end-to-end WireGuard-encrypted.
7. **Passwords never leave the computer.** The unattended password is stored as an
   [scrypt](https://en.wikipedia.org/wiki/Scrypt) hash (N=32768, r=8, p=1). To connect, the viewer
   proves it knows the password by sending HMAC-SHA256 of a one-time nonce and both computers'
   Tailscale device IDs, keyed with the scrypt key. The host checks that proof with a constant-time
   comparison. Each connection gets 3 attempts. After 10 wrong passwords in 15 minutes from one
   device or one Tailscale account (tagged devices count together), passwords from that device or
   account are refused for 15 minutes. After 30 wrong passwords in 15 minutes from all devices
   together, the host **pauses password sign-in** for 15 minutes; devices it let in recently and
   your own devices can still use the password. A lockout only stops passwords: trusted devices,
   auto-accept and the approval prompt keep working.
8. **The host user always knows.** The session panel is shown for the whole session and cannot be
   disabled. Connections from the computer to itself always ask, even for trusted devices.
9. **Ports are fixed** (TCP 47800 by default, UDP 47801–47899), so Tailscale ACLs and firewall
   rules can be exact. The Windows installer lets Tunnelview receive connections only from Tailscale
   addresses.
10. **Installed builds run only their own code.** Release builds switch off Electron's debugging
    and scripting back doors (`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `--inspect`) and refuse a
    modified `app.asar`. So no other program can borrow Tunnelview's screen-recording and
    accessibility permissions. `--dev` works only when running from source.

## Requirements

| | |
|---|---|
| **Operating system** | Windows 10 or 11 (x64 or ARM64) · macOS 13 Ventura or newer (Apple Silicon or Intel) |
| **Tailscale** | Installed, running and signed in on **both** computers, in the same tailnet (or shared with you through [node sharing](https://tailscale.com/kb/1084/sharing)). Tunnelview finds the CLI automatically: `C:\Program Files\Tailscale\tailscale.exe` on Windows; `/Applications/Tailscale.app/Contents/MacOS/Tailscale`, Homebrew or `PATH` on macOS. |
| **Tailscale policy** | The viewer must be allowed to reach the host on **TCP 47800** and **UDP 47801–47899**. |

### Tailscale access policy

New tailnets start with an allow-all policy, which needs no change. If you use a restrictive policy,
add a rule in the admin console (**Access controls**). This example lets every member reach Tunnelview
on **their own** devices:

```jsonc
{
  "grants": [
    {
      // Each user may remote-control their own devices with Tunnelview.
      "src": ["autogroup:member"],
      "dst": ["autogroup:self"],
      "ip":  ["tcp:47800", "udp:47801-47899"]
    }
  ]
}
```

To let one person help another, for example a helpdesk group helping Bob:

```jsonc
{
  "groups": {
    "group:helpdesk": ["alice@example.com"]
  },
  "grants": [
    {
      "src": ["group:helpdesk"],
      "dst": ["bob@example.com"],
      "ip":  ["tcp:47800", "udp:47801-47899"]
    },
    {
      // Optional: WebRTC connectivity checks run in both directions. Tailscale lets replies through,
      // but allowing the reverse UDP direction makes connection setup faster and more robust.
      "src": ["bob@example.com"],
      "dst": ["group:helpdesk"],
      "ip":  ["udp:47801-47899"]
    }
  ]
}
```

<details>
<summary>The same first rule in the legacy <code>acls</code> syntax</summary>

```jsonc
{
  "acls": [
    { "action": "accept", "src": ["autogroup:member"], "proto": "tcp", "dst": ["autogroup:self:47800"] },
    { "action": "accept", "src": ["autogroup:member"], "proto": "udp", "dst": ["autogroup:self:47801-47899"] }
  ]
}
```
</details>

Tunnelview applies its own policy on top of Tailscale's, under **Settings → Security → Who can
connect**. *Only my devices* excludes tagged devices.

## Installation

Install Tunnelview on **both** computers, and make sure both are signed in to Tailscale (see
[Requirements](#requirements)). Ready-made installers are on the
[**Releases** page](https://github.com/NamiNaone99/Tunnelview/releases/latest).

### Windows

1. Download `Tunnelview-Setup-<version>-x64.exe` from [Releases](https://github.com/NamiNaone99/Tunnelview/releases/latest), or
   `-arm64.exe` for Windows on ARM.
2. Run it and approve the administrator prompt. Tunnelview installs for all users, because the
   installer has to create firewall rules. You can change the install folder.
3. The installer adds **Windows Defender Firewall** rules for `Tunnelview.exe`. They apply only to
   Tailscale addresses (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`), on every network profile:
   - `Tunnelview (Tailscale only) - TCP signaling`: incoming connections on whichever port Tunnelview
     listens on (47800 unless you change it). Tunnelview only ever listens on its Tailscale
     addresses.
   - `Tunnelview (Tailscale only) - UDP 47801-47899`: incoming WebRTC media.
   - `Tunnelview - no tailnet UDP via Wi-Fi`: blocks outgoing WebRTC connectivity checks toward
     Tailscale addresses on Wi-Fi adapters. They belong in the Tailscale tunnel (see
     [Ports and firewalls](#ports-and-firewalls)).

   Uninstalling Tunnelview removes these rules.
4. Release builds are not code-signed, so SmartScreen may say *"Windows protected your PC"*. Click
   **More info → Run anyway**.

### macOS

**Install a release build** (quickest), or **build it on the Mac** (no Gatekeeper warning).

**Build it on the Mac.** Install [Node.js](https://nodejs.org) 22.12 or newer, then in Terminal:

```sh
git clone https://github.com/NamiNaone99/Tunnelview.git
cd Tunnelview
bash scripts/mac-install.sh
```

The first `git` command may offer to install Apple's Command Line Tools; accept and run it again.
Without git, use **Code → Download ZIP** on the GitHub page, unzip it and `cd` into the
`Tunnelview-main` folder instead.

The script checks for macOS 13+ and Node, runs `npm ci` and the unit tests, builds `Tunnelview.app` for
this Mac's processor (Apple Silicon or Intel), verifies its fuses, installs it into Applications and
opens it. A Mac-built app carries no quarantine flag, so Gatekeeper does not block it. If it replaces
an earlier build, the script resets Tunnelview's Screen Recording, Accessibility and Downloads
permissions, because a rebuild has a new signature (see [macOS permissions](#macos-permissions)).

**Install a release build:**

1. Download `Tunnelview-<version>-mac-arm64.dmg` for Apple Silicon, or `-mac-x64.dmg` for Intel,
   from [Releases](https://github.com/NamiNaone99/Tunnelview/releases/latest). Open it and drag **Tunnelview** to **Applications**.
2. Release builds are ad-hoc signed but **not notarized**, so Gatekeeper blocks the first launch:
   - **macOS 13 and 14:** Control-click Tunnelview in Applications, choose **Open**, then **Open**.
   - **macOS 15 and later:** open Tunnelview once, then go to **System Settings → Privacy & Security**
     and click **Open Anyway**.
   - Or remove the quarantine flag in Terminal:
     ```sh
     xattr -dr com.apple.quarantine /Applications/Tunnelview.app
     ```
3. If the macOS firewall is on, allow Tunnelview when it asks to *accept incoming network connections*.

### Updating

Tunnelview does not update itself. To hear about new versions (including security fixes), click
**Watch → Custom → Releases** on the [GitHub page](https://github.com/NamiNaone99/Tunnelview). Install the same version on both
computers.

- **Windows:** run the new installer; it replaces the old version and keeps your settings.
- **macOS:** replace the app in Applications. If you built it yourself, run `git pull` and
  `bash scripts/mac-install.sh` again in that folder (with Download ZIP: download the new ZIP and run
  the script from the new folder). A new build has a new signature: macOS keeps the old Screen Recording and Accessibility
  entries switched on, but they no longer work. Remove and re-add Tunnelview there (see
  [macOS permissions](#macos-permissions)); `mac-install.sh` resets them for you.

## macOS permissions

A Mac that you want to **control** needs Screen Recording and Accessibility; viewing other
computers needs neither. A Mac that receives files also needs access to the Downloads folder.

| Permission | Why | Where |
|---|---|---|
| **Screen Recording** (*Screen & System Audio Recording* on macOS 15) | To stream this Mac's screen | System Settings → Privacy & Security |
| **Accessibility** | To move the mouse and type for the remote user | System Settings → Privacy & Security |
| **Files and Folders › Downloads Folder** | To save files people send you in `Downloads/Tunnelview`, the default folder for received files | System Settings → Privacy & Security → Files and Folders |

The **This Desk** view shows the status of Screen Recording and Accessibility. **Grant** asks macOS
for the permission, which adds Tunnelview to the list, and opens the right settings pane. After you
switch on Screen Recording, click **Quit & Reopen**, because macOS only applies that permission at
launch.

macOS asks for the **Downloads folder** the first time Tunnelview writes there. Tunnelview does that on
purpose (it writes and deletes a small test file) when it starts with incoming connections on,
when you turn them on, and when you change the download folder. So the alert also appears after
an update or a `tccutil reset`, even though the folder already exists. Click **Allow** while you
are at the Mac: nobody can answer that question remotely, and until it is allowed, files sent to
this Mac fail with *no-access*.

> **macOS 15 and later** periodically ask whether Tunnelview may *bypass the system private window
> picker*. Until someone at the Mac clicks **Allow**, macOS blocks screen capture. An unattended
> session then shows no video, and the viewer's session ends with *Screen recording needs approval*.
> Someone has to be at the Mac to click Allow.

> **After every update or rebuild, re-grant the permissions.** Ad-hoc signed builds get a new code
> signature each time, so macOS treats each one as a new app. The old entries stay switched on but
> no longer work. Symptoms are a black screen or clicks that do nothing. To fix it, select Tunnelview
> in both lists, remove it with **–**, add it again (or toggle it on), and relaunch. Alternatively,
> run:
> ```sh
> tccutil reset ScreenCapture io.github.naminaone99.tunnelview
> tccutil reset Accessibility io.github.naminaone99.tunnelview
> tccutil reset SystemPolicyDownloadsFolder io.github.naminaone99.tunnelview   # Downloads folder: macOS asks again
> ```

## Using Tunnelview

### Connect to another computer

1. Start Tunnelview on both computers. **This Desk** shows your device name, its Tailscale address and
   whether incoming connections are ready.
2. In **Remote Desk**, enter the other computer's **device name**, MagicDNS name or **Tailscale
   IP** (optionally followed by `:port`). You can also pick it from **Your tailnet** or **Recent**.
   The device grid marks each device: *Password set*, *Busy*, *Not allowed*, *Update needed*,
   *No answer* or *Not running*.
   Press **F5** to refresh it. If you type no port, Tunnelview uses the port that device answered on.
3. Wait for the person at the other computer to accept, or enter the unattended password.

### Accept an incoming connection

When someone connects, a prompt shows their **Tailscale identity** (user and device) as verified
through `tailscale whois`. In the prompt you can:

- choose what to allow: *Control keyboard & mouse*, *Clipboard*, *File transfer*, *Computer audio*
  (the defaults are set in Settings → Security);
- **trust this device**, so it connects without asking in the future;
- **Accept**, or **Dismiss** (or press Esc). If nobody answers, the request is denied after the approval timeout
  (default 30 s, adjustable from 10 to 300 s).

The prompt appears on top **without taking the keyboard**, so what you are typing elsewhere keeps
going there. Click it (or switch to it), then click **Accept** or press **Alt+A** (**⇧⌘A** on macOS;
the key that types "a" on your keyboard layout). Enter and Space never accept, and a shortcut
pressed the instant the prompt becomes active is ignored: then click **Accept**. In a full-screen
viewer, click the prompt (it stays on top) or leave full screen first (hold **Esc**, or press
Ctrl+Alt+Shift and use the toolbar's Fullscreen button), because the viewer sends your keys,
including Alt+Tab and ⌘Tab, to the remote computer.

During the session the **session panel** stays on top. It shows who is connected and lets you
change permissions, chat, exchange files or **Disconnect**. The person controlling your computer
sees the panel in their stream, but their clicks on it (and on the approval prompt) are dropped,
and their keystrokes are dropped while the panel has the keyboard. This keeps the panel yours; it
is not a sandbox, since someone with control of your desktop can still minimize windows or run
programs. Closing the panel ends the session after a confirmation. You can also end the session from the main window or the tray menu.

While someone is connected, Tunnelview keeps this computer's display awake (it can still lock if you
lock it manually).

Only one incoming session (plus one waiting request) is allowed at a time. Further requests are
answered with *busy*. A viewer that enters the password, a trusted device or an auto-accepted
device does not wait behind a request you have not answered yet: it gets in, and that request is
withdrawn. If you deny a request, the same device cannot ask again for a while: 30 s,
then 2 and 10 minutes if you keep denying it. An unanswered request costs 30 s, and a device can
show at most 3 prompts in 5 minutes. Its viewer is told *Try again later* and how long to wait. A
viewer that knows the password still gets in.

### Unattended access

1. Go to **Settings → Security** and set a password (8–128 characters).
2. Choose an **Accept mode**:
   - **Ask every time:** the prompt appears, but a viewer who knows the password can type it while
     waiting and get in without the prompt being answered.
   - **Password only (unattended):** nobody is prompted. Trusted devices, and your own devices when
     auto-accept is on, are let in without being asked for the password. Every other viewer must
     enter the password or is refused.
3. Optionally list **trusted devices** and enable auto-accept for devices signed in to your own
   Tailscale account. Tagged devices never count as your own, and they cannot be set to *Always
   allow*.

While someone is connected to this computer, the security settings are **locked**: accept mode,
who can connect, the allow list, auto-accept, default permissions, the password and the download
folder. End the session to change them.

### Who can connect

**Settings → Security → Who can connect** is checked before anything else:

- *Anyone on my tailnet:* any device verified by `tailscale whois`.
- *Only my devices:* the same Tailscale login as this computer, excluding tagged devices.
- *Only these users & devices:* Tailscale logins, device (MagicDNS) names or node IDs that you
  list. A short device name (`laptop`) only matches devices in your own tailnet; for a device
  shared with you from another tailnet, use its full name (`laptop.other-tailnet.ts.net`).
  Devices this setting excludes see this computer as *Not allowed*.

You can also turn incoming connections off entirely. Tunnelview then stops listening. Viewers see
*Tunnelview is not available there*, and the device grid shows the computer as *Not running*.

### Keep running in the background

With **Settings → Behaviour → Keep running when closed** (on by default), closing the main window
keeps Tunnelview running in the tray (Windows) or the menu bar (macOS), so the computer stays
reachable. Turn it off to quit Tunnelview when you close the window. The setting works the same way
on Windows and macOS.

### During a session (viewer)

The toolbar sits at the top centre of the viewer window and hides automatically. Press
**Ctrl+Alt+Shift** (⌃⌥⇧ on a Mac) to show it at any time, including in fullscreen, or pin it.

| Toolbar item | What it does |
|---|---|
| Display | Choose which remote monitor to show |
| Picture | Quality preset (*Best / Balanced / Fast*) and scaling (*Fit window / 1:1*) |
| View only | Stop sending mouse and keyboard input |
| Special keys | OS-specific shortcuts, the Cmd/Ctrl swap (*Auto / On / Off*) and *Type clipboard text…* |
| Clipboard sync | Turn clipboard sharing on or off for this session |
| Send files / File transfers | Send files (or drop them on the window) and follow progress |
| Chat | Message the person at the host |
| Screenshot | Save the remote screen as PNG to `Pictures/Tunnelview` |
| Statistics | fps, resolution, bitrate, RTT, packet loss, jitter, codec, decode time per frame, and the **Route** (*Direct* or *Relayed via DERP*) |
| Audio | Mute or unmute the remote computer's sound |
| Fullscreen | Capture system shortcuts. Hold **Esc** to leave fullscreen |
| Disconnect | End the session |

**Direct or relayed.** Tailscale connects the two computers directly whenever it can. When a
direct path is impossible, for example behind strict NATs or firewalls, it relays the
WireGuard-encrypted packets through one of Tailscale's **DERP** servers. The session still works
and stays end-to-end encrypted, but it has more latency and less bandwidth. The **Route** row in
**Statistics** shows *Direct* or *Relayed via DERP (region)*. `tailscale ping <device>` shows the
same thing from the command line.

If the host is showing an administrator (UAC) prompt, the lock screen or a window that runs as
administrator, the viewer shows a **banner**. Windows does not accept remote input there, so the
person at the host has to handle that screen.

While the connection is recovering or the picture is frozen, the viewer sends no mouse or keyboard
input (*View only · recovering* / *View only · video stalled*), so nothing runs on a screen you
cannot see. Control comes back by itself.

**Files.** The viewer asks you before accepting each file the host sends. Received files go to
`Downloads/Tunnelview` by default. You can change this under Settings → Files. Files are written as
`.part` and renamed when complete. They are **marked as downloaded from the internet**
(Mark-of-the-Web on Windows, quarantine on macOS), so Windows and macOS treat them with the same
caution as a browser download. The default codec and quality are in Settings → Streaming.

## Ports and firewalls

| Port | Protocol | Purpose |
|---|---|---|
| 47800 | TCP | Signaling WebSocket and `GET /tunnelview/v1/info` (configurable in Settings → Network) |
| 47801–47899 | UDP | WebRTC media and data channels (screen, audio, input, clipboard, files, chat) |

- **Changing the signaling port:** update your Tailscale policy to match. On Windows, the
  installer's TCP rule already covers any port Tunnelview listens on, and only for connections from
  Tailscale addresses. Tunnelview never listens on LAN or internet addresses.
- **Connecting without a port:** if you type no `:port`, Tunnelview uses the port the device answered
  on in the device grid, or 47800 if it was not probed.
- **Wi-Fi:** WebRTC also tries connectivity checks from your other network adapters. Those checks
  toward the other computer's Tailscale address would leave through your Wi-Fi router into your
  ISP's network instead of the Tailscale tunnel. They carry nothing secret and fail, but they show
  that a session is running. The Windows installer therefore adds an **outbound block** for
  Tunnelview's UDP media ports (47801–47899) toward Tailscale addresses on Wi-Fi adapters. Wired
  Ethernet adapters and Macs are not covered, so the checks still leave (and fail) there. The
  session itself always runs through Tailscale.

Windows rules for a manual setup (run in an **elevated** PowerShell, and adjust the program path):

```powershell
$exe = "C:\Program Files\Tunnelview\Tunnelview.exe"
netsh advfirewall firewall add rule name="Tunnelview (Tailscale only) - TCP signaling" dir=in action=allow enable=yes profile=any program="$exe" protocol=TCP remoteip=100.64.0.0/10,fd7a:115c:a1e0::/48
netsh advfirewall firewall add rule name="Tunnelview (Tailscale only) - UDP 47801-47899" dir=in action=allow enable=yes profile=any program="$exe" protocol=UDP localport=47801-47899 remoteip=100.64.0.0/10,fd7a:115c:a1e0::/48
# optional: keep connectivity checks toward the tailnet off Wi-Fi
netsh advfirewall firewall add rule name="Tunnelview - no tailnet UDP via Wi-Fi" dir=out action=block enable=yes profile=any program="$exe" protocol=UDP localport=47801-47899 remoteip=100.64.0.0/10,fd7a:115c:a1e0::/48 interfacetype=wireless
```

For development runs (`npm start`), see
[Windows Firewall is blocking Tunnelview](#windows-firewall-is-blocking-tunnelview).

## Limitations

- **One incoming session at a time** per host. A computer can run several outgoing viewer sessions.
- **Windows elevation (UIPI):** Windows blocks remote input into windows of programs running as
  administrator, and into the UAC prompt on the secure desktop, the lock screen and the sign-in
  screen. The UAC prompt, lock screen and sign-in screen cannot be captured either. When this
  happens, the viewer shows a banner, and **the person at the host has to handle it** (approve
  or cancel the prompt, unlock, or use that window themselves). **Ctrl+Alt+Del** and **Win+L**
  cannot be injected, because Windows accepts them only from a physical keyboard.
- **macOS login window and lock screen:** Tunnelview runs inside your user session. It cannot show or
  control the login window, FileVault unlock or a locked screen. The Mac must be logged in.
- **System audio from a Mac host:** off by default. Electron 45 documents loopback audio capture for
  Windows only, so sessions to a Mac are video-only. An unsupported, experimental opt-in exists
  (start Tunnelview with `TUNNELVIEW_MAC_LOOPBACK=1` on macOS 14.2+). Audio from Windows hosts works
  normally, including to Mac viewers.
- **Tailscale is required for the whole session.** If Tailscale stops, the host stops listening and
  running sessions end. When Tailscale cannot make a direct connection it relays through DERP,
  which works but adds latency and limits bandwidth.
- Release builds are **not code-signed (Windows) or notarized (macOS)**. See
  [Installation](#installation).

## Troubleshooting

| Symptom | What to check |
|---|---|
| *Tailscale isn't installed / isn't running / Sign in to Tailscale* | Start Tailscale and sign in on both computers. The Tailscale menu should show *Connected*, and `tailscale status` should list the other device. |
| Mac: *Can't read Tailscale status* | On a Mac, Tailscale's command-line tool is the Tailscale app itself; Tunnelview runs it with `TAILSCALE_BE_CLI=1` so it answers as a command-line tool. Update Tailscale, then click **Check again**. If it still fails, run `/Applications/Tunnelview.app/Contents/MacOS/Tunnelview` in Terminal to see Tunnelview's `[tailscale] …` messages, and report them with the banner text in an issue. |
| Mac: *Tailscale isn't running* although Tailscale is on | Tunnelview asks Tailscale only while this Mac has a Tailscale address, because running Tailscale's command-line tool while Tailscale is starting can switch it off again. Make sure the Tailscale menu shows *Connected* (not only that the app is open). Run `/Applications/Tunnelview.app/Contents/MacOS/Tunnelview` in Terminal to see Tunnelview's `[tailscale] …` messages. |
| *That address isn't on your tailnet* / *Not in your tailnet* | The address you entered is not a Tailscale IP of a device in `tailscale status`, so Tunnelview will not dial it. Use the device name or pick it from **Your tailnet**. Devices shared with you must be accepted first. |
| *Connection didn't go through Tailscale* | The device is on your tailnet, but this computer sent the connection out through another network adapter, so Tunnelview stopped before sending anything. Another network or VPN may be using Tailscale's address range (`100.64.0.0/10`), or Tailscale is still starting. Check that `tailscale status` shows this computer connected, and look for routes to `100.64.0.0/10` that do not go through Tailscale (`route print` on Windows, `netstat -rn` on macOS); turn off the conflicting VPN or adapter and try again. |
| *No device called "…" on your tailnet* | No device with that name is in `tailscale status`. Try the MagicDNS short name, the full name (`host.tailnet-name.ts.net`) or the `100.x.y.z` IP. |
| Device shows *Not running*, or *didn't answer over Tailscale* | Tunnelview is not started there, incoming connections are off, or something blocks **TCP 47800**: the Tailscale policy, Windows Firewall or another app using the port. Test with `tailscale ping <device>`, then `curl http://<tailscale-ip>:47800/tunnelview/v1/info`, which should print Tunnelview's JSON. |
| Accepted, but the picture never appears | **UDP 47801–47899** is blocked by the Tailscale policy or a firewall. Allow it, in both directions between different users. On a Mac host running macOS 15 or later, someone may need to click **Allow** on the screen-recording alert ([macOS permissions](#macos-permissions)). |
| The picture freezes for a second or two now and then (the viewer shows *Video stalled — recovering…*) | On a Windows viewer with **Settings → Streaming → GPU video decoding** turned on, turn it off and restart Tunnelview: some GPU H.264 decoders drop frames until the next keyframe. Otherwise check the route in the statistics overlay (a relayed DERP route can stall under load) and try the *Fast* preset. |
| *Stopped to protect your session* | The WebRTC path was not on the tailnet, for example because of an unusual VPN or proxy setup, so the session was torn down on purpose. |
| Windows: *Windows Firewall is blocking Tunnelview (a Block rule exists for this program)*, or it works only after disabling the firewall, or only when connecting to itself | Windows Firewall blocks Tunnelview. See [Windows Firewall is blocking Tunnelview](#windows-firewall-is-blocking-tunnelview). |
| Windows: *Windows Firewall blocks all incoming connections on the network profile of the Tailscale adapter ("Block all incoming connections")* | That network profile (usually *Private*) has **Block all incoming connections** switched on. It overrides every allow rule, including the installer's. Untick it for that profile: step 3 of [Windows Firewall is blocking Tunnelview](#windows-firewall-is-blocking-tunnelview). |
| The session ended and the viewer names a reason from the host, e.g. *Screen sharing failed* or *Screen recording needs approval* | The host ended the session for that reason. On a Mac host, *Screen sharing failed* usually means the **Screen Recording** permission is missing or stale: re-grant it there and click **Quit & Reopen**. *Screen recording needs approval* means someone at the Mac must click **Allow**. |
| Black screen from a Mac | **Screen Recording** permission is missing, or stale after an update. Re-grant it and relaunch Tunnelview ([macOS permissions](#macos-permissions)). |
| Clicks and keys do nothing on a Mac | **Accessibility** permission is missing or stale. Re-grant it. |
| A file sent to a Mac is declined or fails with *no-access* | Tunnelview may not write to that Mac's download folder. On the Mac, allow Tunnelview under **System Settings → Privacy & Security → Files and Folders** (*Downloads Folder*), see [macOS permissions](#macos-permissions). |
| A banner says the remote computer shows a secure screen or an administrator window | Windows blocks remote input into UAC prompts, the lock screen and windows that run as administrator. The person at the host has to handle that screen. |
| *… is busy* | Someone is already connected to that host, or another device's request is waiting for approval there (a correct password, or a trusted or auto-accepted device, still gets in), or this device already has two requests open there. Try again in a moment. |
| *Too many attempts* | This device tried to connect to that host too often (more than 20 times in a minute). Wait a minute, then connect again. This is not a password lockout. |
| *Temporarily locked* | Too many wrong passwords from this device or your Tailscale account (tagged devices count together). Passwords are refused for 15 minutes. Trusted devices, auto-accepted devices and requests the person at the host accepts still work. |
| *Passwords paused on …* | That host received many wrong passwords from several devices (30 in 15 minutes) and stopped accepting passwords from devices it has not let in recently, for 15 minutes. Wait, or ask the person there to accept your request. Trusted devices, the owner's own devices and accepted requests are not affected. |
| *Try again later* | A recent request from this device was declined or not answered there, or it asked too often (3 prompts in 5 minutes). Wait the time shown, then connect again. A correct password still gets in. |
| *Not allowed*, or the device grid shows *Not allowed* | The host's **Who can connect** setting excludes your user or device. A short device name there only matches devices of the host's own tailnet. |
| *Tunnelview is not available there*, and the device shows *Not running* | Incoming connections are turned off on that computer (This Desk / Settings → Security), Tunnelview is not running there, or it listens on a different port. |
| *Incompatible versions*, or the device grid shows *Update needed* | The two computers run Tunnelview versions that cannot talk to each other. Install the same release on both devices. |

On macOS, if `tailscale` is not on your `PATH`, run the CLI that ships inside the app:
`/Applications/Tailscale.app/Contents/MacOS/Tailscale status`.

### Windows Firewall is blocking Tunnelview

When a program opens a network port for the first time and nobody allows it in the *Windows
Security Alert*, Windows silently creates inbound **Block** rules for it. Block rules override every
allow rule. This mostly affects development runs (`npm start` runs `electron.exe`) and builds that
were not installed with the installer. In an **elevated** PowerShell:

1. Remove the inbound Block rules (the second command is for `Tunnelview.exe`; the `Inbound` filter
   keeps the installer's outbound Wi-Fi rule):
   ```powershell
   Get-NetFirewallRule | Where-Object DisplayName -like '*electron.exe*' | Where-Object Action -eq Block | Where-Object Direction -eq Inbound | Remove-NetFirewallRule
   Get-NetFirewallRule | Where-Object DisplayName -like '*Tunnelview*' | Where-Object Action -eq Block | Where-Object Direction -eq Inbound | Remove-NetFirewallRule
   ```
2. Add the Tailscale-only allow rules. For an installed Tunnelview, rerun the installer or use the
   commands in [Ports and firewalls](#ports-and-firewalls). For development runs, point them at
   the repository's Electron binary:
   ```powershell
   $exe = "C:\path\to\Tunnelview\node_modules\electron\dist\electron.exe"   # <repo>\node_modules\electron\dist\electron.exe
   netsh advfirewall firewall add rule name="Tunnelview dev (Tailscale only) - TCP signaling" dir=in action=allow enable=yes profile=any program="$exe" protocol=TCP remoteip=100.64.0.0/10,fd7a:115c:a1e0::/48
   netsh advfirewall firewall add rule name="Tunnelview dev (Tailscale only) - UDP 47801-47899" dir=in action=allow enable=yes profile=any program="$exe" protocol=UDP localport=47801-47899 remoteip=100.64.0.0/10,fd7a:115c:a1e0::/48
   ```
3. If Tunnelview warns that Windows Firewall **blocks all incoming connections** on the network
   profile of the Tailscale adapter, that profile has *Block all incoming connections* switched on.
   This blocks Tunnelview even when no Block rule exists. Find the profile: in PowerShell,
   `Get-NetConnectionProfile -InterfaceAlias Tailscale` shows it as `NetworkCategory` (usually
   *Private*). Then either:
   - open **Windows Security › Firewall & network protection**, click that network (for example
     *Private network*) and untick **Blocks all incoming connections, including those in the list
     of allowed apps**; or
   - in an elevated PowerShell, run the command below, replacing `Private` with the adapter's
     profile:
     ```powershell
     Set-NetFirewallProfile -Profile Private -AllowInboundRules True
     ```

   If the Tailscale adapter is on *Public* and you want to keep blocking incoming connections on
   public networks, set the adapter to Private instead:
   `Set-NetConnectionProfile -InterfaceAlias Tailscale -NetworkCategory Private`. On a managed
   computer, Group Policy may enforce the setting and override local changes; ask the
   administrator.
4. Test from a **second device** on your tailnet. Connecting to this computer's own Tailscale IP
   does not pass through Windows Firewall, so a self-test succeeds even while other devices are
   blocked.

## Development

Requirements: **Node.js 22.12+** and npm. For real sessions you also need Tailscale running.

```sh
git clone https://github.com/NamiNaone99/Tunnelview.git
cd Tunnelview
npm ci               # Electron 45, electron-builder, koffi, ws (exact versions from package-lock.json)
npm start            # run Tunnelview
npm run dev          # run with --dev (DevTools; development runs only, packaged builds refuse it)
npm test             # unit tests: node --test, pure Node (no Electron needed)
npm run check        # syntax-check every .js file (scripts/check.js; ESM-aware)
npm run icons        # regenerate build/icon.png, build/icon.ico, build/icons/*
```

You can test with a single computer by connecting to its own Tailscale IP. Connections to self are
always prompted.

### Building installers

```sh
npm run dist:win -- nsis:x64             # on Windows → dist/Tunnelview-Setup-<v>-x64.exe
npm run dist:win                          # x64 + arm64: add the arm64 koffi binary first (below)
npm run dist:mac -- --arm64 --x64         # on a Mac → dist/Tunnelview-<v>-mac-{arm64,x64}.{dmg,zip}
```

- **macOS builds need a Mac** for dmg creation and code signing. Without one, use the GitHub Actions
  workflow ([`.github/workflows/build.yml`](.github/workflows/build.yml)). Run it manually
  (*workflow_dispatch*) or push a `v*` tag. Tag builds are attached to a GitHub release.
- **koffi native binaries are per-architecture.** npm installs only the one for the machine you
  build on. To package the other architecture, add its binary first. This is the same step CI runs:
  ```sh
  npm install --no-save --force @koromix/koffi-win32-arm64@$(node -p "require('./node_modules/koffi/package.json').version")   # Windows arm64
  npm install --no-save --force @koromix/koffi-darwin-x64@$(node -p "require('./node_modules/koffi/package.json').version")    # Intel build on Apple Silicon
  ```
- **Signing:** macOS builds are ad-hoc signed (`mac.identity: "-"` in `electron-builder.yml`) with
  the hardened runtime and `build/entitlements.mac.plist`. To ship with a Developer ID and
  notarization, override the identity and set `notarize` (see the comment in
  `electron-builder.yml`). Windows signing uses electron-builder's standard `CSC_LINK` /
  `CSC_KEY_PASSWORD` variables.
- **Electron fuses:** `electronFuses` in `electron-builder.yml` disables `ELECTRON_RUN_AS_NODE`,
  `NODE_OPTIONS` and `--inspect` in packaged builds and enables ASAR integrity validation, so a
  packaged Tunnelview only runs its own, unmodified `app.asar`. Check a build with
  `node scripts/verify-fuses.js dist/win-unpacked/Tunnelview.exe` (or `dist/mac-arm64/Tunnelview.app`).
  CI runs it after every build.
- Icons are drawn in code by [`src/main/icon-art.js`](src/main/icon-art.js), a small anti-aliased
  SDF rasterizer with its own PNG encoder. The same code produces the runtime window and tray icons.
  Generated files under `build/` are git-ignored.

## Project layout

```
src/main/        Electron main process: Tailscale CLI, host server, viewer client, auth, input
                 injection (koffi → SendInput / CGEvent), capture, clipboard, files, tray, IPC
src/preload/     contextBridge APIs, one per window type (the exact IPC surface)
src/renderer/    main window, viewer, host session panel, approval prompt, shared UI and WebRTC code
src/shared/      protocol constants shared by main and renderers
build/           entitlements.mac.plist, installer.nsh (firewall rules), generated icons
scripts/         make-icons.js, check.js, verify-fuses.js (packaged-build fuse check),
                 mac-install.sh (build + install on a Mac)
test/            node --test unit tests
docs/            ARCHITECTURE.md: the binding contract (security invariants, wire protocol,
                 data channels, IPC, module APIs, settings)
```

Start with [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before changing anything that crosses a
process or network boundary.

## Security

Tunnelview gives the other side control of a computer, so please report vulnerabilities privately,
not in a public issue. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).

Tunnelview is an independent project. It is not affiliated with or endorsed by Tailscale Inc.,
AnyDesk Software GmbH or TeamViewer. Tailscale is a trademark of Tailscale Inc.
