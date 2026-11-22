/// Pairing with a computer from its QR code or link.
library;

import '../proto/pairing.dart';
import '../proto/signal.dart';
import 'hosts.dart';
import 'link.dart';
import 'transport.dart';

/// Why pairing failed. [reason] is 'link:CODE' for an unusable link,
/// 'expired', 'refused' (the computer said no: the code was already used,
/// replaced or closed), or a [LinkFailure] reason.
class PairFailure implements Exception {
  const PairFailure(this.reason);

  final String reason;

  @override
  String toString() => 'PairFailure($reason)';
}

/// Parses scanned or pasted text into a link that has not expired.
PairLink readPairLink(String text, DateTime now) {
  final PairLink link;
  try {
    link = parseLink(text.trim());
  } on Exception {
    throw const PairFailure('link');
  }
  if (link.expiresAt * 1000 <= now.millisecondsSinceEpoch) {
    throw const PairFailure('expired');
  }
  return link;
}

/// Pairs with the computer [link] names and returns its record.
///
/// The phone connects with a fresh client nonce, checks that the hello is
/// signed by the link's key for this connection and this host, and only then
/// sends the pair proof (an HMAC with the link's one-time token over the
/// values the host signed). Pairing admits nothing by itself: every later
/// session still goes through the computer's own rules.
Future<PairedHost> pairWithLink(
  PairLink link, {
  required SignalTransport transport,
  required List<String> selfAddrs,
  required String deviceName,
  required String appVersion,
  required DateTime Function() now,
}) async {
  if (link.expiresAt * 1000 <= now().millisecondsSinceEpoch) {
    throw const PairFailure('expired');
  }
  final HostLink conn;
  try {
    conn = await HostLink.open(
      transport: transport,
      addresses: link.addresses,
      port: link.port,
      key: link.keyBytes,
      hostId: link.hostId,
      selfAddrs: selfAddrs,
    );
  } on LinkFailure catch (e) {
    throw PairFailure(e.reason);
  }
  try {
    conn.send({
      't': 'pair',
      'proof': pairProof(
        link.tokenBytes,
        conn.hello.nonce,
        conn.cnonce,
        conn.hostId,
        conn.viewerId,
      ),
      'device': {'name': deviceName, 'os': 'android', 'version': appVersion},
    });
    while (true) {
      final Map<String, dynamic>? msg;
      try {
        msg = await conn.next().timeout(handshakeTimeout);
      } on LinkFailure catch (e) {
        throw PairFailure(e.reason);
      } on Exception {
        throw const PairFailure('timeout');
      }
      if (msg == null) throw const PairFailure('refused');
      if (msg['t'] != 'pair-result') continue; // unknown frames are ignored
      if (msg['ok'] != true ||
          msg['hostId'] != conn.hostId ||
          msg['viewerId'] != conn.viewerId) {
        throw const PairFailure('refused');
      }
      final name = conn.hello.hostname.isNotEmpty
          ? conn.hello.hostname
          : cleanLabel(link.name.split('.').first, 64);
      return PairedHost(
        hostId: conn.hostId,
        name: name,
        dnsName: link.name,
        addresses: link.addresses,
        port: link.port,
        key: link.key,
        viewerId: conn.viewerId,
        os: conn.hello.os,
        pairedAt: now().millisecondsSinceEpoch,
      );
    }
  } finally {
    await conn.close();
  }
}
