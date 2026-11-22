/// User-visible text (English) for pairing and sessions.
library;

import 'strings.dart';

abstract final class SessionStrings {
  static const hostsUnreadable =
      "The list of paired computers couldn't be read on this phone. Pair "
      'again to replace it.';
  static const pairNeedsTailscale = 'Connect Tailscale on this phone first.';
  static const scanCode = 'Scan the QR code';
  static const pasteLink = 'Paste the pairing link';
  static const pairHint =
      'On the computer, open Tunnelview and choose "Pair a phone". The code '
      'is valid for 2 minutes.';
  static const pairing = 'Pairing…';
  static const pair = 'Pair';
  static const connect = 'Connect';
  static const disconnect = 'Disconnect';
  static const reconnect = 'Connect again';
  static const back = 'Back';
  static const remove = 'Remove';
  static const cancel = 'Cancel';
  static const password = 'Password';
  static const usePassword = 'Use the password instead';
  static const keyboard = 'Keyboard';
  static const keys = 'Key combinations';
  static const display = 'Display';
  static const quality = 'Quality';
  static const resetZoom = 'Reset zoom';
  static const menu = 'Session menu';
  static const connecting = 'Connecting…';
  static const startingPicture = 'Starting the picture…';
  static const gestureHelp =
      'Tap to click · touch and hold to right-click · drag to drag · two '
      'fingers to scroll · pinch to zoom. While the keyboard is open, two '
      'fingers move the picture.';
  static const cameraUnavailable =
      "Tunnelview can't use the camera. Allow the camera for Tunnelview in "
      "the phone's settings, or paste the pairing link instead.";

  /// "Waiting for someone at office-pc to allow this."
  static String waiting(String host) =>
      'Waiting for someone at $host to allow this…';

  /// "Paired with office-pc".
  static String paired(String host) => 'Paired with $host';

  /// Why pairing failed (`PairFailure.reason`).
  static String pairFailure(String reason) {
    switch (reason) {
      case 'link':
        return "This isn't a Tunnelview pairing code. Scan the code shown by "
            '"Pair a phone" on the computer.';
      case 'expired':
        return 'This pairing code has expired. Show a new one on the '
            'computer. If that keeps happening, check that the clocks of the '
            'phone and the computer are right.';
      case 'refused':
        return "The computer didn't accept the code. It may have been used "
            'already or replaced. Show a new one on the computer.';
      default:
        return closeText(reason).message;
    }
  }

  /// The label of a quality preset.
  static String qualityLabel(String preset) => switch (preset) {
    'quality' => 'Best picture',
    'speed' => 'Fastest',
    _ => 'Balanced',
  };

  /// What to say about a wrong password.
  static String passwordError(String code, int? remaining) => switch (code) {
    'wrong' =>
      remaining == null || remaining <= 0
          ? 'Wrong password.'
          : 'Wrong password. $remaining ${remaining == 1 ? 'try' : 'tries'} '
                'left.',
    'locked' => 'Password sign-in is locked on the computer for now.',
    'no-password' => 'The computer has no password set.',
    'busy' => 'Still checking the previous password.',
    'invalid' => 'Enter the password.',
    _ => 'Not connected.',
  };

  /// Why the phone does not control the computer right now
  /// (`RemoteSession.controlBlock`), or null.
  static String? controlBlock(String? code, String? inputBlocked) {
    switch (code) {
      case null:
        return switch (inputBlocked) {
          'secure-desktop' =>
            "The computer shows a system prompt that can't be controlled "
                'remotely.',
          'elevated-window' =>
            "The window in front runs as administrator and can't be "
                'controlled remotely.',
          _ => null,
        };
      case 'view-only':
        return 'View only: the computer has not allowed control.';
      case 'host-paused':
        return 'View only: control is paused on the computer.';
      case 'recovering':
        return 'View only: reconnecting…';
      default:
        return null;
    }
  }

  /// Title and message for the end of a session or a failed connection
  /// (`LinkFailure.reason`).
  static CardText closeText(
    String reason, {
    String host = 'the computer',
    int? retryAfterSec,
    String? hostReason,
  }) {
    // The session gate refused: 'gate:' + a SessionRefusal code.
    if (reason.startsWith('gate:')) {
      return CardText("Can't connect", cannotConnect(reason.substring(5)));
    }
    switch (reason) {
      case 'local':
        return const CardText('Disconnected', 'You ended the session.');
      case 'unreachable':
      case 'timeout':
        return CardText(
          "Can't reach $host",
          "$host didn't answer over Tailscale. Check that it is on, connected "
              'to Tailscale and that Tunnelview is running there.',
        );
      case 'not-tunnelview':
        return CardText(
          "Tunnelview isn't answering",
          "Something else answered on $host's port. Check that Tunnelview is "
              'running there.',
        );
      case 'protocol':
      case 'denied:protocol':
        return const CardText(
          'Versions do not match',
          'This app and the Tunnelview on the computer do not understand each '
              'other. Update both.',
        );
      case 'rate-limited':
        return const CardText(
          'Too many attempts',
          'The computer is refusing new connections for a moment. Try again '
              'in a minute.',
        );
      case 'not-tailnet-route':
        return const CardText(
          'Not going through Tailscale',
          'The connection did not go through Tailscale, so Tunnelview stopped '
              'before sending anything.',
        );
      case 'host-too-old':
        return const CardText(
          'Update Tunnelview on the computer',
          'Phones need Tunnelview 0.3 or later on the computer.',
        );
      case 'identity-unavailable':
        return CardText(
          "$host can't prove its identity",
          'Its identity key is not available right now. Open Tunnelview on '
              'the computer and check Settings.',
        );
      case 'identity-mismatch':
        return const CardText(
          "This isn't the computer you paired with",
          "The answer wasn't signed by the paired computer's key, so nothing "
              'was sent. If its identity was reset, pair again.',
        );
      case 'viewer-changed':
        return const CardText(
          'Pair again',
          "This phone's Tailscale identity changed since it was paired. "
              'Remove the computer and pair again.',
        );
      case 'host-updating':
        return CardText(
          '$host is updating',
          'Tunnelview is installing an update there. Try again in a moment.',
        );
      case 'network':
        return const CardText(
          'Connection lost',
          'The connection to the computer was lost.',
        );
      case 'non-tailnet-path':
        return const CardText(
          'Not going through Tailscale',
          'The picture would not have travelled through Tailscale, so the '
              'session was stopped.',
        );
      case 'media-timeout':
      case 'media-failed':
        return const CardText(
          "The picture didn't start",
          'The phone and the computer could not set up the video connection '
              'over Tailscale.',
        );
      case 'host-ended':
        return CardText(
          'Session ended',
          hostReason == 'capture-blocked'
              ? '$host is waiting for someone there to allow screen '
                    'recording.'
              : 'The session was ended on the computer.',
        );
      case 'denied:rejected':
        return CardText('Declined', 'The request was declined on $host.');
      case 'denied:timeout':
        return CardText('No answer', 'Nobody answered the request on $host.');
      case 'denied:busy':
        return CardText(
          '$host is busy',
          'Another session or request is active there. Try again shortly.',
        );
      case 'denied:not-allowed':
        return CardText(
          'Not allowed',
          "$host's settings don't allow this phone to connect.",
        );
      case 'denied:bad-password':
        return const CardText('Wrong password', 'Too many wrong passwords.');
      case 'denied:password-required':
        return CardText('Password needed', '$host only accepts its password.');
      case 'denied:locked':
      case 'denied:suspended':
        return const CardText(
          'Password sign-in is locked',
          'Too many failed password attempts. Try again in 15 minutes, or '
              'have someone accept the request on the computer.',
        );
      case 'denied:disabled':
        return CardText(
          'Not accepting connections',
          'Incoming connections are switched off on $host.',
        );
      case 'denied:auth-timeout':
        return const CardText('Timed out', 'The password took too long.');
      case 'denied:try-later':
        return CardText(
          'Try again later',
          retryAfterSec == null
              ? 'The computer is not showing new requests from this phone '
                    'for a moment.'
              : 'The computer is not showing new requests from this phone '
                    'yet. Try again in $retryAfterSec seconds.',
        );
      default:
        return const CardText('Disconnected', 'The session ended.');
    }
  }

  /// Why a session cannot start (a `SessionRefusal` code), for the list.
  static String cannotConnect(String code) {
    switch (code) {
      case 'tailscale-off':
        return pairNeedsTailscale;
      case 'tailscale-excluded':
        return 'Tunnelview is excluded from Tailscale on this phone.';
      case 'self-test-pending':
        return 'Still checking the network. Try again in a moment.';
      default:
        return 'Connections are blocked: the network self-test failed. Open '
            'Diagnostics.';
    }
  }
}
