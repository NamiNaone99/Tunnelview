/// User-visible text (English), kept in one place so it can be translated
/// later. Texts follow PLAN §6.11 and ux §4.2.
library;

import '../platform/tailnet_state.dart';
import '../rtc/self_test.dart';

/// Title and message of an inline status card.
class CardText {
  const CardText(this.title, this.message, {this.pointsToDiagnostics = false});
  final String title;
  final String message;

  /// The card offers a way to Diagnostics (a fault the user can only report).
  final bool pointsToDiagnostics;
}

/// True when [s] is "checking" because of a fault, not a transition: the
/// platform and the Dart rules disagree, or the platform call fails. Both
/// repeat on every snapshot, so the state would never clear on its own.
bool isDetectionFault(TailnetState s) =>
    s.status == TailnetStatus.checking &&
    (s.reason == TailnetStateReason.mismatch ||
        s.reason == TailnetStateReason.platformError);

abstract final class Strings {
  static const appTitle = 'Tunnelview';
  static const openTailscale = 'Open Tailscale';
  static const diagnostics = 'Diagnostics';
  static const pairComputer = 'Pair a computer';
  static const comingSoon = 'Coming soon';
  static const computers = 'Computers';
  static const noComputers =
      'No computers yet. Pairing with a computer arrives in a later build.';
  static const tailscaleNotInstalled =
      "Tailscale isn't installed on this phone. Install it from Google Play "
      'or F-Droid, sign in to your tailnet, then come back.';
  static const tailscaleOpenFailed = "Couldn't open Tailscale.";
  static const copyReport = 'Copy report';
  static const reportCopied =
      'Report copied. It contains no addresses of other devices.';
  static const reportCopyFailed = "Couldn't copy the report.";
  static const runSelfTest = 'Run self-test again';
  static const selfTestBlockedTitle = 'Connections are blocked';

  /// The pill label for a state.
  static String pill(TailnetState s) {
    switch (s.status) {
      case TailnetStatus.ok:
        final a = s.primaryAddress;
        return a == null ? 'Tailscale' : 'Tailscale · $a';
      case TailnetStatus.checking:
        return isDetectionFault(s)
            ? "Can't check Tailscale"
            : 'Checking Tailscale…';
      case TailnetStatus.off:
        return 'Tailscale is off';
      case TailnetStatus.anotherVpn:
        return 'Another VPN is on';
      case TailnetStatus.excluded:
        return 'Not using Tailscale';
      case TailnetStatus.several:
        return 'Tailscale network unclear';
      case TailnetStatus.unsupported:
        return 'Not available on this device yet';
    }
  }

  /// The inline card under the pill, or null when none is shown.
  static CardText? card(TailnetState s) {
    switch (s.status) {
      case TailnetStatus.ok:
        return null;
      case TailnetStatus.checking:
        if (!isDetectionFault(s)) return null;
        return const CardText(
          "Can't check Tailscale",
          "Tunnelview can't tell whether Tailscale is connected, so it won't "
              'connect. Open Diagnostics and copy the report to show what '
              'the phone sees.',
          pointsToDiagnostics: true,
        );
      case TailnetStatus.off:
        return const CardText(
          "Tailscale isn't connected",
          'Turn on Tailscale on this phone, then try again. Tunnelview only '
              'connects inside your tailnet.',
        );
      case TailnetStatus.anotherVpn:
        return const CardText(
          'Another VPN is on',
          'Android allows one VPN at a time. Switch your VPN to Tailscale to '
              'use Tunnelview.',
        );
      case TailnetStatus.excluded:
        return const CardText(
          'Tunnelview is excluded from Tailscale',
          'In the Tailscale app, open App-based split tunneling and include '
              'Tunnelview.',
        );
      case TailnetStatus.several:
        return const CardText(
          'More than one Tailscale network',
          'This phone shows more than one network with a Tailscale address, '
              "so Tunnelview won't connect. Turn Tailscale off and on again.",
        );
      case TailnetStatus.unsupported:
        return const CardText(
          'Not available on this device yet',
          'Tunnelview cannot check Tailscale on this device yet, so it '
              "won't connect.",
        );
    }
  }

  /// One line for a self-test verdict.
  static String selfTestVerdict(SelfTestVerdict v) {
    switch (v) {
      case SelfTestVerdict.pass:
        return "Passed: WebRTC uses only this phone's Tailscale addresses.";
      case SelfTestVerdict.foreignCandidate:
        return 'Failed: WebRTC found an address outside Tailscale. '
            'Connections are blocked.';
      case SelfTestVerdict.noCandidates:
        return 'Failed: WebRTC found no network inside the Tailscale tunnel. '
            'Connections are blocked.';
      case SelfTestVerdict.incomplete:
        return 'Failed: the check did not finish in time. '
            'Connections are blocked.';
      case SelfTestVerdict.error:
        return 'Failed: WebRTC could not run the check. '
            'Connections are blocked.';
    }
  }

  /// Text for a session refusal code (see `session_gate.dart`).
  static String sessionRefusal(String? code) {
    switch (code) {
      case null:
        return 'Allowed';
      case 'tailscale-off':
        return "Refused: Tailscale isn't usable";
      case 'tailscale-excluded':
        return 'Refused: Tunnelview is excluded from Tailscale';
      case 'self-test-pending':
        return 'Waiting for the network self-test';
      case 'self-test-failed':
        return 'Refused: the network self-test failed';
      case 'self-test-stale':
        return "Refused: this phone's Tailscale addresses changed since the "
            'self-test; run it again';
      default:
        return 'Refused ($code)';
    }
  }
}
