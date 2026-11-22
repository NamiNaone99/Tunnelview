// The real IoSignalTransport (dart:io) against a hand-made WebSocket server
// on loopback: what the upgrade request looks like, how refusals are
// reported, and the limits on what the phone will buffer.
//
// IOOverrides sends the socket the app asks for (to a Tailscale address,
// bound to a Tailscale address) to 127.0.0.1 and records what was asked.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:crypto/crypto.dart' as crypto;
import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/proto/pairing.dart';
import 'package:tunnelview_mobile/session/transport.dart';

const String hostIp = '100.64.0.1';
const String phoneIp = '100.64.1.2';
const String wsGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

typedef Dial = ({String host, String? source, int port});

String? addressText(Object? a) => switch (a) {
  null => null,
  InternetAddress() => a.address,
  _ => a.toString(),
};

/// dart:io as it really is: the base class forwards to the real sockets.
final class RealIo extends IOOverrides {}

Future<T> onLoopback<T>(List<Dial> dials, Future<T> Function() body) =>
    IOOverrides.runZoned(
      body,
      socketStartConnect: (host, port, {sourceAddress, sourcePort = 0}) {
        dials.add((
          host: addressText(host)!,
          source: addressText(sourceAddress),
          port: port,
        ));
        // The real connect. It stays in this zone tree (an error raised in
        // the root zone would never reach the app's code), with the override
        // switched off for this one call (a nested runZoned would inherit
        // it and call itself).
        return IOOverrides.runWithIOOverrides(
          () => Socket.startConnect(InternetAddress.loopbackIPv4, port),
          RealIo(),
        );
      },
    );

/// One server-to-client frame (never masked).
Uint8List frame(int opcode, List<int> payload, {bool fin = true}) {
  final b = BytesBuilder();
  b.addByte((fin ? 0x80 : 0) | opcode);
  final n = payload.length;
  if (n < 126) {
    b.addByte(n);
  } else if (n < 65536) {
    b.add([126, n >> 8, n & 0xff]);
  } else {
    b.add([
      127,
      0,
      0,
      0,
      0,
      (n >> 24) & 0xff,
      (n >> 16) & 0xff,
      (n >> 8) & 0xff,
      n & 0xff,
    ]);
  }
  b.add(payload);
  return b.toBytes();
}

const int opContinuation = 0;
const int opText = 1;

/// A one-connection server: reads the upgrade request, then lets the test
/// answer.
class RawServer {
  RawServer._(this._server);

  final ServerSocket _server;
  final Completer<String> _request = Completer();
  final Completer<void> closed = Completer();
  Socket? socket;

  static Future<RawServer> start() async {
    final server = await ServerSocket.bind(InternetAddress.loopbackIPv4, 0);
    final s = RawServer._(server);
    server.listen((socket) {
      s.socket = socket;
      final head = BytesBuilder();
      socket.listen(
        (data) {
          if (s._request.isCompleted) return;
          head.add(data);
          final text = latin1.decode(head.toBytes());
          if (text.contains('\r\n\r\n')) s._request.complete(text);
        },
        onError: (Object _) {},
        onDone: () {
          if (!s.closed.isCompleted) s.closed.complete();
        },
      );
    });
    return s;
  }

  int get port => _server.port;

  /// The upgrade request, as text.
  Future<String> get request => _request.future;

  /// Its headers, lower-case names.
  Future<Map<String, String>> get headers async {
    final lines = (await request).split('\r\n').skip(1);
    return {
      for (final l in lines)
        if (l.contains(':'))
          l.substring(0, l.indexOf(':')).toLowerCase(): l
              .substring(l.indexOf(':') + 1)
              .trim(),
    };
  }

  /// Completes the WebSocket handshake.
  Future<void> accept({String? acceptKey}) async {
    final key = (await headers)['sec-websocket-key']!;
    final accept =
        acceptKey ??
        base64.encode(crypto.sha1.convert(ascii.encode('$key$wsGuid')).bytes);
    socket!.add(
      ascii.encode(
        'HTTP/1.1 101 Switching Protocols\r\n'
        'Upgrade: websocket\r\n'
        'Connection: Upgrade\r\n'
        'Sec-WebSocket-Accept: $accept\r\n\r\n',
      ),
    );
    await socket!.flush();
  }

  Future<void> refuse(int status) async {
    await request;
    socket!.add(
      ascii.encode('HTTP/1.1 $status Refused\r\nContent-Length: 0\r\n\r\n'),
    );
    await socket!.flush();
  }

  void send(List<int> bytes) => socket!.add(bytes);

  Future<void> stop() async {
    socket?.destroy();
    await _server.close();
  }
}

void main() {
  HttpOverrides.global = null;
  const transport = IoSignalTransport();
  final cnonce = newClientNonce();
  late RawServer server;
  late List<Dial> dials;

  setUp(() async {
    server = await RawServer.start();
    dials = [];
  });

  tearDown(() => server.stop());

  Future<SignalConnection> dial() =>
      transport.dial(hostIp, server.port, cnonce, bindAddress: phoneIp);

  test('the upgrade request: what the host checks, and nothing more', () async {
    await onLoopback(dials, () async {
      final pending = dial();
      final request = await server.request;
      final h = await server.headers;
      expect(request.split('\r\n').first, 'GET /tunnelview/v1 HTTP/1.1');
      expect(h['host'], '$hostIp:${server.port}');
      expect(h['upgrade']!.toLowerCase(), 'websocket');
      expect(h['connection']!.toLowerCase(), contains('upgrade'));
      expect(h['sec-websocket-version'], '13');
      expect(base64.decode(h['sec-websocket-key']!), hasLength(16));
      expect(h['x-tunnelview-protocol'], '2');
      expect(h[clientNonceHeader], cnonce);
      expect(validCnonce(h[clientNonceHeader]), isTrue);
      // The host refuses these, or they would say something about the phone.
      for (final absent in [
        'origin',
        'sec-websocket-origin',
        'sec-websocket-protocol',
        'sec-websocket-extensions',
        'user-agent',
        'cookie',
        'authorization',
      ]) {
        expect(h.containsKey(absent), isFalse, reason: absent);
      }
      await server.accept();
      final conn = await pending;
      // The socket was asked for at the Tailscale address, bound to the
      // phone's Tailscale address, and that bound address is reported.
      expect(dials, [(host: hostIp, source: phoneIp, port: server.port)]);
      expect(conn.localAddress, phoneIp);
      await conn.close();
    });
  });

  test(
    'frames: text arrives, a split message is joined, the phone can send',
    () async {
      await onLoopback(dials, () async {
        final pending = dial();
        await server.accept();
        final conn = await pending;
        final frames = StreamIterator(conn.frames);
        server.send(frame(opText, utf8.encode('{"t":"hello"}')));
        expect(await frames.moveNext(), isTrue);
        expect(frames.current, '{"t":"hello"}');
        server.send(frame(opText, utf8.encode('{"t":"sp'), fin: false));
        server.send(frame(opContinuation, utf8.encode('lit"}')));
        expect(await frames.moveNext(), isTrue);
        expect(frames.current, '{"t":"split"}');
        // A message of just under the limit is fine.
        final big = '{"t":"big","pad":"${'x' * (maxFrameLength - 64)}"}';
        server.send(frame(opText, utf8.encode(big)));
        expect(await frames.moveNext(), isTrue);
        expect(frames.current.length, big.length);
        await conn.close();
      });
    },
  );

  test(
    'one frame above the limit ends the connection, nothing is delivered',
    () async {
      await onLoopback(dials, () async {
        final pending = dial();
        await server.accept();
        final conn = await pending;
        server.send(frame(opText, Uint8List(maxFrameLength + 1)));
        final got = <String>[];
        await conn.frames
            .handleError((Object _) {})
            .forEach(got.add)
            .timeout(const Duration(seconds: 10));
        expect(got, isEmpty);
      });
    },
  );

  test(
    'a message split into many frames is cut off at the limit too',
    () async {
      await onLoopback(dials, () async {
        final pending = dial();
        await server.accept();
        final conn = await pending;
        // Each frame is well below the per-frame limit; together they are far
        // above the limit for a message, and the last frame never comes.
        final chunk = Uint8List(256 * 1024)..fillRange(0, 256 * 1024, 0x61);
        server.send(frame(opText, chunk, fin: false));
        var sent = 1;
        final feeder = Timer.periodic(const Duration(milliseconds: 5), (_) {
          if (sent++ < 40) {
            try {
              server.send(frame(opContinuation, chunk, fin: false));
            } catch (_) {
              // The phone hung up, as it should.
            }
          }
        });
        final got = <String>[];
        await conn.frames
            .handleError((Object _) {})
            .forEach(got.add)
            .timeout(const Duration(seconds: 20));
        feeder.cancel();
        expect(got, isEmpty);
        // The phone dropped the socket long before 10 MiB were sent.
        await server.closed.future.timeout(const Duration(seconds: 10));
      });
    },
  );

  test('HTTP refusals carry their status', () async {
    await onLoopback(dials, () async {
      // The expectation listens before the server answers.
      final refused = expectLater(
        dial(),
        throwsA(
          isA<DialFailure>()
              .having((e) => e.reason, 'reason', 'http')
              .having((e) => e.status, 'status', 403),
        ),
      );
      await server.refuse(403);
      await refused;
    });
  });

  test('a wrong Sec-WebSocket-Accept is not a Tunnelview host', () async {
    await onLoopback(dials, () async {
      final refused = expectLater(
        dial(),
        throwsA(
          isA<DialFailure>().having(
            (e) => e.reason,
            'reason',
            'not-tunnelview',
          ),
        ),
      );
      await server.accept(acceptKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=');
      await refused;
    });
  });

  test('only Tailscale addresses are dialed, only Tailscale addresses of the '
      'same family are bound', () async {
    await onLoopback(dials, () async {
      Future<String> reason(String ip, String bind) async {
        try {
          await transport.dial(ip, server.port, cnonce, bindAddress: bind);
          return 'connected';
        } on DialFailure catch (e) {
          return e.reason;
        }
      }

      expect(await reason('192.168.1.20', phoneIp), 'unreachable');
      expect(await reason('office-pc.tail1234.ts.net', phoneIp), 'unreachable');
      expect(await reason(hostIp, '192.168.1.20'), 'not-tailnet-route');
      expect(await reason(hostIp, 'fd7a:115c:a1e0::2'), 'not-tailnet-route');
      expect(await reason('fd7a:115c:a1e0::1', phoneIp), 'not-tailnet-route');
      expect(await reason(hostIp, ''), 'not-tailnet-route');
      expect(dials, isEmpty, reason: 'none of these reached the OS');
    });
  });

  test('nobody answering is unreachable', () async {
    await onLoopback(dials, () async {
      final port = server.port;
      await server.stop();
      await expectLater(
        transport.dial(hostIp, port, cnonce, bindAddress: phoneIp),
        throwsA(
          isA<DialFailure>().having((e) => e.reason, 'reason', 'unreachable'),
        ),
      );
    });
  });
}
