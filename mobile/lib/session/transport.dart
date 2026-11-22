/// The WebSocket to a host's signaling port, over dart:io.
///
/// The upgrade is done by hand (instead of `WebSocket.connect`) for three
/// reasons: the HTTP status of a refusal is needed (403, 429, 503 mean
/// different things), the socket must be bound to one of this phone's own
/// Tailscale addresses, and the address is always an IP literal, so nothing
/// is ever resolved through DNS.
///
/// About the local address: dart:io cannot report it for an outgoing socket
/// (`Socket.address` is the address that was connected TO). So the socket is
/// bound to the phone's Tailscale address before it connects; the OS refuses
/// that bind unless the address is on this device. Together with the process
/// being bound to the Tailscale network (TailnetPlugin) and the signed hello
/// (link.dart), this is the phone's form of the desktop's local-address
/// check.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:crypto/crypto.dart' as crypto;

import '../net/addresses.dart';
import '../proto/pairing.dart';

const String wsPath = '/tunnelview/v1';
const String protocolHeader = 'x-tunnelview-protocol';
const int protocolVersion = 2;
const int maxFrameLength = 1024 * 1024;
const Duration handshakeTimeout = Duration(seconds: 8);

/// dart:io sends a ping this long after the last pong and closes the socket
/// when its pong is not back within the same time again. It must be longer
/// than a session's disconnect grace (35 s), so a short stall is left to the
/// media timers and to the host, which can restart ICE. 40 s is the desktop
/// viewer's liveness window too; the host drops a dead phone by its own
/// pings.
const Duration pingInterval = Duration(seconds: 40);
const String _wsGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/// Why a dial failed before a WebSocket existed.
class DialFailure implements Exception {
  const DialFailure(this.reason, {this.status});

  /// 'unreachable' | 'timeout' | 'http' (see [status]) | 'not-tunnelview' |
  /// 'not-tailnet-route' (no usable Tailscale address to bind).
  final String reason;
  final int? status;

  @override
  String toString() => 'DialFailure($reason, $status)';
}

/// An open signaling connection.
abstract interface class SignalConnection {
  /// The address this end of the socket is bound to, or null when unknown.
  String? get localAddress;

  /// Text frames from the host. Done when the socket closes; a binary or
  /// oversized frame arrives as an error.
  Stream<String> get frames;

  /// The WebSocket close code, once [frames] is done.
  int? get closeCode;

  void send(String text);

  Future<void> close([int code]);
}

/// Opens signaling connections.
abstract interface class SignalTransport {
  /// Connects to `ws://ip:port/tunnelview/v1` with the protocol header and
  /// the client nonce, from a socket bound to [bindAddress]: one of this
  /// phone's own Tailscale addresses, of the same family as [ip]. Throws
  /// [DialFailure].
  Future<SignalConnection> dial(
    String ip,
    int port,
    String cnonce, {
    required String bindAddress,
  });
}

/// The entry of [selfAddrs] to bind for a connection to [ip]: this phone's
/// first Tailscale address of the same family, in canonical form. Null when
/// there is none.
String? bindAddressFor(String ip, List<String> selfAddrs) {
  final target = canonicalAddress(ip);
  if (target == null) return null;
  for (final a in selfAddrs) {
    final own = canonicalAddress(a);
    if (own != null &&
        isTailscaleAddress(own) &&
        own.contains(':') == target.contains(':')) {
      return own;
    }
  }
  return null;
}

/// 32 fresh random bytes as canonical base64: a client nonce.
String newClientNonce([Random? random]) {
  final r = random ?? Random.secure();
  return base64.encode([
    for (var i = 0; i < clientNonceBytes; i++) r.nextInt(256),
  ]);
}

/// The real transport.
class IoSignalTransport implements SignalTransport {
  const IoSignalTransport();

  @override
  Future<SignalConnection> dial(
    String ip,
    int port,
    String cnonce, {
    required String bindAddress,
  }) async {
    final canonical = canonicalAddress(ip);
    // Only Tailscale addresses are ever dialed.
    if (canonical == null || !isTailscaleAddress(canonical)) {
      throw const DialFailure('unreachable');
    }
    final address = InternetAddress.tryParse(canonical);
    if (address == null) throw const DialFailure('unreachable');
    // And only from this phone's own Tailscale address of the same family.
    final own = canonicalAddress(bindAddress);
    if (own == null ||
        !isTailscaleAddress(own) ||
        own.contains(':') != canonical.contains(':')) {
      throw const DialFailure('not-tailnet-route');
    }
    final source = InternetAddress.tryParse(own);
    if (source == null) throw const DialFailure('not-tailnet-route');
    final client = HttpClient()
      ..connectionTimeout = handshakeTimeout
      ..userAgent = null
      ..findProxy = (_) => 'DIRECT';
    // Bind, then connect. The bind fails (a SocketException, reported as
    // unreachable) when the address is no longer on this device.
    client.connectionFactory = (uri, proxyHost, proxyPort) =>
        Socket.startConnect(address, port, sourceAddress: source);
    final random = Random.secure();
    final key = base64.encode([
      for (var i = 0; i < 16; i++) random.nextInt(256),
    ]);
    try {
      final uri = Uri(
        scheme: 'http',
        host: canonical,
        port: port,
        path: wsPath,
      );
      final request = await client
          .openUrl('GET', uri)
          .timeout(handshakeTimeout);
      request.followRedirects = false;
      request.headers
        ..set(HttpHeaders.connectionHeader, 'Upgrade')
        ..set(HttpHeaders.upgradeHeader, 'websocket')
        ..set('Sec-WebSocket-Key', key)
        ..set('Sec-WebSocket-Version', '13')
        ..set(protocolHeader, '$protocolVersion')
        ..set(clientNonceHeader, cnonce)
        ..removeAll(HttpHeaders.acceptEncodingHeader);
      final response = await request.close().timeout(handshakeTimeout);
      if (response.statusCode != HttpStatus.switchingProtocols) {
        final status = response.statusCode;
        unawaited(response.drain<void>().catchError((_) {}));
        client.close(force: true);
        throw DialFailure('http', status: status);
      }
      final accept = response.headers.value('sec-websocket-accept');
      final expected = base64.encode(
        crypto.sha1.convert(ascii.encode('$key$_wsGuid')).bytes,
      );
      final upgrade = response.headers.value(HttpHeaders.upgradeHeader) ?? '';
      if (accept != expected || upgrade.toLowerCase() != 'websocket') {
        client.close(force: true);
        throw const DialFailure('not-tunnelview');
      }
      final socket = await response.detachSocket();
      // No compression was negotiated. A frame above the limit fails at its
      // length header instead of being buffered.
      final ws = WebSocket.fromUpgradedSocket(
        socket,
        serverSide: false,
        compression: CompressionOptions.compressionOff,
        maxPayloadLength: maxFrameLength,
      )..pingInterval = pingInterval;
      return _IoConnection(ws, own);
    } on DialFailure {
      rethrow;
    } on TimeoutException {
      client.close(force: true);
      throw const DialFailure('timeout');
    } on SocketException {
      client.close(force: true);
      throw const DialFailure('unreachable');
    } on HttpException {
      client.close(force: true);
      throw const DialFailure('not-tunnelview');
    } catch (_) {
      client.close(force: true);
      throw const DialFailure('unreachable');
    }
  }
}

class _IoConnection implements SignalConnection {
  _IoConnection(this._ws, this.localAddress) {
    _sub = _ws.listen(
      (data) {
        if (data is String && data.length <= maxFrameLength) {
          _frames.add(data);
        } else {
          _frames.addError(const FormatException('bad frame'));
        }
      },
      onError: (Object _) {},
      onDone: () {
        closeCode = _ws.closeCode;
        unawaited(_frames.close());
      },
      cancelOnError: false,
    );
  }

  final WebSocket _ws;
  final StreamController<String> _frames = StreamController<String>();
  // Kept so the subscription lives as long as the connection.
  // ignore: unused_field
  late final StreamSubscription<dynamic> _sub;

  @override
  final String? localAddress;

  @override
  int? closeCode;

  @override
  Stream<String> get frames => _frames.stream;

  @override
  void send(String text) {
    if (_ws.readyState == WebSocket.open) _ws.add(text);
  }

  @override
  Future<void> close([int code = WebSocketStatus.normalClosure]) async {
    try {
      await _ws.close(code).timeout(const Duration(seconds: 2));
    } catch (_) {
      // The peer is gone; nothing to wait for.
    }
  }
}
