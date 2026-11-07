# Security policy

Tunnelview lets another device see and control a computer, so security problems matter more here
than in most apps. Thank you for reporting them responsibly.

## Supported versions

Only the [latest release](https://github.com/NamiNaone99/Tunnelview/releases/latest) receives
security fixes.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through GitHub:

1. Go to the [Security tab](https://github.com/NamiNaone99/Tunnelview/security) of this repository.
2. Click **Report a vulnerability** and describe the problem: what an attacker can do, the steps
   to reproduce it, and the Tunnelview, Tailscale and OS versions involved.

If that button is ever missing, open an issue that only asks for a private contact, without any
details of the problem.

You should get a first answer within 7 days. Once a fix is released, the report is published as a
security advisory with credit to you, unless you prefer to stay anonymous.

## Scope

Examples of what counts:

- getting screen, input, clipboard, files or audio from a host without the host user accepting,
  a valid password, or a device the host chose to trust;
- connecting from outside the host's tailnet, or traffic leaving the Tailscale tunnel;
- bypassing *Who can connect*, the password lockouts or the approval prompt;
- a viewer driving the host's session panel or prompt directly with its clicks or keystrokes
  (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §1, item 7, for what the session-panel guard
  does and does not cover);
- a viewer or host executing code or reading files on the other side.

Out of scope: problems that need an attacker who already controls the host's or viewer's operating
system account, and the security of Tailscale itself (report those to
[Tailscale](https://tailscale.com/security)).
