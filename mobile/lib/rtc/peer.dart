/// The viewer's side of a WebRTC session, as the session logic sees it. The
/// real one lives in engine.dart (the only file that may import
/// flutter_webrtc); tests use a fake.
library;

import 'package:flutter/widgets.dart';

import '../proto/signal.dart';

/// ICE connectivity, reduced to what the session acts on.
enum PeerState { connecting, connected, disconnected, failed, closed }

/// Callbacks from a [ViewerPeer]. All run on the UI isolate.
class PeerEvents {
  const PeerEvents({
    required this.onCandidate,
    required this.onState,
    required this.onChannel,
    required this.onControl,
  });

  /// A local candidate to send to the host. Only Tailscale candidates are
  /// ever reported.
  final void Function(Map<String, Object?> candidate) onCandidate;

  final void Function(PeerState state) onState;

  /// A data channel ('input', 'control', 'file') opened or closed.
  final void Function(String label, bool open) onChannel;

  /// A text message on the `control` channel.
  final void Function(String text) onControl;
}

/// One peer connection that answers the host's offers.
abstract interface class ViewerPeer {
  /// Applies the host's offer and returns the answer SDP that was applied
  /// locally. Candidates outside the tailnet are stripped from both.
  Future<String> answer(String offerSdp);

  /// Adds a candidate from the host (already checked by the caller).
  Future<void> addCandidate(SignalCandidate candidate);

  /// Sends text on a data channel. False unless that channel is open.
  bool send(String label, String text);

  /// The getStats() report: one map per entry, with `id` and `type`.
  Future<List<Map<dynamic, dynamic>>> stats();

  /// Notifies when the size of the remote picture changes.
  Listenable get videoChanges;

  /// The remote picture's size in pixels; zero before the first frame.
  Size get videoSize;

  /// The remote picture, filling the box it is given.
  Widget buildVideo();

  Future<void> close();
}

/// Creates the peer for a session.
typedef PeerFactory = Future<ViewerPeer> Function(PeerEvents events);
