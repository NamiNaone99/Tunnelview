/// The WebSocket to a host's signaling port, over dart:io.
///
/// The upgrade is done by hand (instead of `WebSocket.connect`) for three
/// reasons: the HTTP status of a refusal is needed (403, 429, 503 mean
/// different things), the socket's local address is needed (it must be one of
/// this phone's Tailscale addresses), and the address is always an IP literal,
/// so nothing is ever resolved through DNS.
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
const Duration pingInterval = Duration(seconds: 15);
const String _wsGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/// Why a dial failed before a WebSocket existed.
class DialFailure implements Exception {
  const DialFailure(this.reason, {this.status});

  /// 'unreachable' | 'timeout' | 'http' (see [status]) | 'not-tunnelview'.
  final String reason;
  final int? status;

  @override
  String toString() => 'DialFailure($reason, $status)';
}

/// An open signaling connection.
abstract interface class SignalConnection {
  /// This end's address of the socket, or null when unknown.
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
  /// the client nonce. Throws [DialFailure].
  Future<SignalConnection> dial(String ip, int port, String cnonce);
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
  Future<SignalConnection> dial(String ip, int port, String cnonce) async {
    final canonical = canonicalAddress(ip);
    // Only Tailscale addresses are ever dialed.
    if (canonical == null || !isTailscaleAddress(canonical)) {
      throw const DialFailure('unreachable');
    }
    final address = InternetAddress.tryParse(canonical);
    if (address == null) throw const DialFailure('unreachable');
    final client = HttpClient()
      ..connectionTimeout = handshakeTimeout
      ..userAgent = null
      ..findProxy = (_) => 'DIRECT';
    String? local;
    client.connectionFactory = (uri, proxyHost, proxyPort) async {
      final task = await Socket.startConnect(address, port);
      return ConnectionTask.fromSocket(
        task.socket.then((s) {
          local = s.address.address;
          return s;
        }),
        task.cancel,
      );
    };
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
      final ws = WebSocket.fromUpgradedSocket(socket, serverSide: false)
        ..pingInterval = pingInterval;
      return _IoConnection(ws, local);
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
