; Tunnelview — custom NSIS hooks for electron-builder (nsis.include in electron-builder.yml).
;
; Adds Windows Defender Firewall rules so the tailnet can reach Tunnelview, and ONLY the tailnet
; (docs/ARCHITECTURE.md §1.8):
;   IN  allow TCP (any local port)  signaling WebSocket + /tunnelview/v1/info. No localport= filter:
;                                   Settings → Network lets the user pick any port 1024-65535 and
;                                   Windows shows no new prompt once a rule for Tunnelview.exe exists,
;                                   so a port-pinned rule silently dropped every connection after a
;                                   port change. The host server only ever binds the node's own
;                                   Tailscale IPs, so the rule never exposes a LAN listener.
;   IN  allow UDP 47801-47899       WebRTC media + data channels   (PROTOCOL.RTC_UDP_MIN..MAX)
;   OUT block UDP 47801-47899       toward the Tailscale ranges over WIRELESS adapters only (see below)
; Every rule is bound to the installed executable (program=) and to the Tailscale address ranges
; (remoteip=100.64.0.0/10 and fd7a:115c:a1e0::/48), on every network profile — the Tailscale
; adapter can be classified Public, Private or Domain. All Electron processes (main, network
; utility process that owns the WebRTC sockets, renderers) run from the same Tunnelview.exe.
;
; Outbound block: Chromium gathers ICE candidates on every adapter, so the sockets bound to the
; Wi-Fi address also send STUN connectivity checks to the peer's 100.x / fd7a: addresses. Windows
; uses the strong host model, so those packets leave through the Wi-Fi gateway into ISP CGNAT
; space instead of the tunnel. Nothing secret is in them (ICE candidates that are not Tailscale IPs
; are dropped and the selected pair is verified), but they reveal session activity to the LAN and
; ISP. The rule drops them on wireless interfaces. It is deliberately NOT extended to
; interfacetype=ras: whether Windows Firewall classifies the Tailscale (Wintun) adapter as RAS is
; unverified, and such a rule could block the media path itself.
; Residual behaviour: on a WIRED LAN adapter (interfacetype=lan) and on macOS (no installer, no
; packet filter) the same checks still leave through the LAN gateway. They are harmless and fail
; there; the session itself always runs over the tunnel.
;
; The installer is per-machine (nsis.perMachine) and therefore elevated, which netsh requires.
; Hook names/insertion points: node_modules/app-builder-lib/templates/nsis/installSection.nsh
; (customInstall, after files are installed) and uninstaller.nsh (customUnInstall). On upgrade the
; old uninstaller runs first (removing the rules it knows) and customInstall then deletes every
; rule name before re-creating the rules for the new install path.

!ifndef TUNNELVIEW_FW_RULE_TCP
  !define TUNNELVIEW_FW_RULE_TCP "Tunnelview (Tailscale only) - TCP signaling"
!endif
!ifndef TUNNELVIEW_FW_RULE_UDP
  !define TUNNELVIEW_FW_RULE_UDP "Tunnelview (Tailscale only) - UDP 47801-47899"
!endif
!ifndef TUNNELVIEW_FW_RULE_WIFI_BLOCK
  !define TUNNELVIEW_FW_RULE_WIFI_BLOCK "Tunnelview - no tailnet UDP via Wi-Fi"
!endif
!ifndef TUNNELVIEW_FW_REMOTE
  !define TUNNELVIEW_FW_REMOTE "100.64.0.0/10,fd7a:115c:a1e0::/48"
!endif
; Login item written by app.setLoginItemSettings(): Electron names the HKCU Run value (and its
; StartupApproved twin) after app.getAppUserModelId() unless `name` is passed, and
; src/main/index.js sets the AppUserModelId to the appId.
!ifndef TUNNELVIEW_RUN_VALUE
  !define TUNNELVIEW_RUN_VALUE "io.github.naminaone99.tunnelview"
!endif

; Run `netsh <ARGS>` and log its output + exit code. Preserves $0/$1.
!macro _tunnelviewNetsh ARGS
  Push $0
  Push $1
  ; The NSIS stub is a 32-bit process: under WOW64 $SYSDIR is redirected to SysWOW64. Prefer the
  ; native netsh through the "Sysnative" alias (only visible to 32-bit processes); fall back to
  ; $SYSDIR (native on 32-bit Windows). Absolute paths — never resolve netsh through PATH.
  StrCpy $1 "$WINDIR\Sysnative\netsh.exe"
  IfFileExists "$1" +2 0
    StrCpy $1 "$SYSDIR\netsh.exe"
  nsExec::ExecToLog '"$1" ${ARGS}'
  Pop $0
  DetailPrint "Tunnelview firewall: netsh exit code $0"
  Pop $1
  Pop $0
!macroend

!macro _tunnelviewDeleteFirewallRules
  ; "delete rule name=…" removes every rule with that name (also ones from an older install path).
  ; Exit code 1 ("No rules match") is expected on a clean machine.
  !insertmacro _tunnelviewNetsh 'advfirewall firewall delete rule name="${TUNNELVIEW_FW_RULE_TCP}"'
  !insertmacro _tunnelviewNetsh 'advfirewall firewall delete rule name="${TUNNELVIEW_FW_RULE_UDP}"'
  !insertmacro _tunnelviewNetsh 'advfirewall firewall delete rule name="${TUNNELVIEW_FW_RULE_WIFI_BLOCK}"'
!macroend

!macro customInstall
  DetailPrint "Adding Windows Firewall rules for Tunnelview (Tailscale addresses only)..."
  !insertmacro _tunnelviewDeleteFirewallRules
  !insertmacro _tunnelviewNetsh 'advfirewall firewall add rule name="${TUNNELVIEW_FW_RULE_TCP}" dir=in action=allow enable=yes profile=any program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" protocol=TCP remoteip=${TUNNELVIEW_FW_REMOTE} description="Tunnelview signaling on the port set in Settings (default 47800). Only Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48) peers may connect."'
  !insertmacro _tunnelviewNetsh 'advfirewall firewall add rule name="${TUNNELVIEW_FW_RULE_UDP}" dir=in action=allow enable=yes profile=any program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" protocol=UDP localport=47801-47899 remoteip=${TUNNELVIEW_FW_REMOTE} description="Tunnelview WebRTC media. Only Tailscale (100.64.0.0/10, fd7a:115c:a1e0::/48) peers may connect."'
  !insertmacro _tunnelviewNetsh 'advfirewall firewall add rule name="${TUNNELVIEW_FW_RULE_WIFI_BLOCK}" dir=out action=block enable=yes profile=any program="$INSTDIR\${APP_EXECUTABLE_FILENAME}" protocol=UDP localport=47801-47899 remoteip=${TUNNELVIEW_FW_REMOTE} interfacetype=wireless description="Keeps Tunnelview WebRTC connectivity checks toward Tailscale addresses off the Wi-Fi adapter; they belong in the Tailscale tunnel."'
!macroend

!macro customUnInstall
  DetailPrint "Removing Tunnelview Windows Firewall rules..."
  !insertmacro _tunnelviewDeleteFirewallRules
  ; Real uninstall only: an upgrade runs the old uninstaller with --updated, and the new version
  ; keeps the user's "Start Tunnelview at login" choice. Best effort: the elevated uninstaller sees
  ; the HKCU hive of the account that approved elevation, so the login item of a standard user who
  ; had an administrator elevate (over-the-shoulder) or of any other account is not removed; it
  ; keeps pointing at the deleted exe until that user turns it off in Settings → Apps → Startup.
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${TUNNELVIEW_RUN_VALUE}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${TUNNELVIEW_RUN_VALUE}"
  ${endIf}
!macroend
