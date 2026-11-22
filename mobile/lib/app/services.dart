/// What the screens need to pair and connect, in one place so tests can
/// swap every part.
library;

import '../rtc/peer.dart';
import '../session/hosts.dart';
import '../session/transport.dart';

class AppServices {
  const AppServices({
    required this.hosts,
    required this.transport,
    required this.peerFactory,
    this.now = DateTime.now,
  });

  /// The paired computers.
  final HostStore hosts;

  /// Opens signaling connections.
  final SignalTransport transport;

  /// Creates the WebRTC peer of a session.
  final PeerFactory peerFactory;

  final DateTime Function() now;
}
