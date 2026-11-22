// The desktop's shared test vectors (../test/vectors, written by
// scripts/make-mobile-fixtures.js from the real desktop modules), run against
// the Dart ports in lib/proto.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/proto/auth.dart';
import 'package:tunnelview_mobile/proto/codec.dart';
import 'package:tunnelview_mobile/proto/pairing.dart';

Map<String, dynamic> vectors(String name) =>
    jsonDecode(File('../test/vectors/$name.json').readAsStringSync())
        as Map<String, dynamic>;

List<Map<String, dynamic>> cases(Map<String, dynamic> file, String fn) =>
    ((file['functions'] as Map)[fn] as Map)['cases']
            .cast<Map<String, dynamic>>()
        as List<Map<String, dynamic>>;

String hex(List<int> b) =>
    b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();

List<int> unhex(String s) => [
  for (var i = 0; i < s.length; i += 2)
    int.parse(s.substring(i, i + 2), radix: 16),
];

/// Runs [body]; its value, or `{'error': code}` for a [ProtoError].
Future<Object?> outcome(Future<Object?> Function() body) async {
  try {
    return await body();
  } on ProtoError catch (e) {
    return {'error': e.code};
  }
}

Object? expected(Map<String, dynamic> c) =>
    c.containsKey('error') ? {'error': c['error']} : c['result'];

void main() {
  group('auth-v2.json', () {
    final file = vectors('auth-v2');

    test('context', () => expect(file['context'], authContext));

    test('decodeB64', () {
      for (final c in cases(file, 'decodeB64')) {
        final a = c['args'] as List;
        final got = decodeB64(a[0], a[1] as int, a[2] as int);
        expect(got == null ? null : hex(got), c['result'], reason: '$a');
      }
    });

    test('normalizeBinding', () {
      for (final c in cases(file, 'normalizeBinding')) {
        final b = normalizeBinding((c['args'] as List)[0]);
        expect(
          b == null ? null : {'hostId': b.hostId, 'viewerId': b.viewerId},
          c['result'],
          reason: '${c['args']}',
        );
      }
    });

    test('validateKdf', () {
      for (final c in cases(file, 'validateKdf')) {
        expect(
          validateKdf((c['args'] as List)[0]),
          c['result'],
          reason: '${c['args']} ${c['note']}',
        );
      }
    });

    test('computeProof', () async {
      for (final c in cases(file, 'computeProof')) {
        final a = c['args'] as List;
        final got = await outcome(() => computeProof(a[0], a[1], a[2], a[3]));
        expect(got, expected(c), reason: '$a');
      }
    }, timeout: const Timeout(Duration(minutes: 5)));

    // Expected values from the desktop's auth.computeProof (real scrypt).
    test('computeProof matches the desktop for real passwords', () async {
      const binding = {
        'hostId': 'nHOSTabc123CNTRL',
        'viewerId': 'nPHONEp1x2CNTRL',
      };
      const nonce = 'EBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8=';
      const salt = 'AAECAwQFBgcICQoLDA0ODw==';
      expect(
        await computeProof(
          'correct horse battery staple',
          {
            'salt': salt,
            'kdf': {'N': 32768, 'r': 8, 'p': 1, 'keylen': 32},
          },
          nonce,
          binding,
        ),
        'S4eEkuRt3czBGN91lHIVyra8NY1nH1XNjMgzsnA7PVc=',
      );
      expect(
        await computeProof(
          'รหัสผ่าน-ทดสอบ-1',
          {
            'salt': salt,
            'kdf': {'N': 16384, 'r': 8, 'p': 2, 'keylen': 32},
          },
          nonce,
          binding,
        ),
        'n3lNI9zmwJOwk+6XsncoFgfOeGWdbFDqbw+IxsFJqm4=',
      );
    }, timeout: const Timeout(Duration(minutes: 5)));

    test('hmac vectors', () {
      for (final v in (file['hmacVectors'] as List).cast<Map>()) {
        final b = Binding(v['hostId'] as String, v['viewerId'] as String);
        final message = authMessage(v['nonce'] as String, b);
        expect(message, v['message']);
        final key = base64.decode((v['stored'] as Map)['key'] as String);
        expect(hmacB64(key, message), v['proof']);
      }
    });
  });

  group('fingerprint.json', () {
    final file = vectors('fingerprint');

    test('base32', () {
      for (final c in cases(file, 'base32')) {
        expect(base32(unhex((c['args'] as List)[0] as String)), c['result']);
      }
    });

    test('fingerprint', () async {
      for (final c in cases(file, 'fingerprint')) {
        final arg = (c['args'] as List)[0] as String;
        final got = await outcome(
          () async => fingerprint(base64Url.decode(base64Url.normalize(arg))),
        );
        expect(got, expected(c), reason: arg);
      }
    });
  });

  group('links.json', () {
    final file = vectors('links');

    test('constants', () {
      expect(file['prefix'], linkPrefix);
      expect(file['maxLength'], linkMaxLength);
    });

    test('parseLink', () async {
      for (final c in cases(file, 'parseLink')) {
        final arg = (c['args'] as List)[0];
        final got = await outcome(() async => parseLink(arg).toJson());
        expect(got, expected(c), reason: '${c['note']} $arg');
      }
    });

    test('a parsed link encodes back to itself', () {
      for (final c in cases(file, 'parseLink')) {
        if (c.containsKey('error')) continue;
        final text = (c['args'] as List)[0] as String;
        final link = parseLink(text);
        expect(
          linkPrefix + encodeB64Url(utf8.encode(link.canonicalJson())),
          text,
        );
      }
    });
  });

  group('ident.json', () {
    final file = vectors('ident');

    test('constants', () {
      expect(file['context'], identContext);
      expect(file['clientNonceHeader'], clientNonceHeader);
      expect(file['clientNonceBytes'], clientNonceBytes);
    });

    test('validCnonce', () {
      for (final c in cases(file, 'validCnonce')) {
        expect(
          validCnonce((c['args'] as List)[0]),
          c['result'],
          reason: '${c['args']}',
        );
      }
    });

    test('identBytes', () async {
      for (final c in cases(file, 'identBytes')) {
        final a = c['args'] as List;
        final got = await outcome(
          () async => utf8.decode(identBytes(a[0], a[1], a[2], a[3])),
        );
        expect(got, expected(c), reason: '$a');
      }
    });

    test('verifyIdent', () async {
      for (final c in cases(file, 'verifyIdent')) {
        final a = c['args'] as List;
        final want = a.length > 2 && a[2] is Map ? a[2] as Map : const {};
        final got = await outcome(() async {
          final r = await verifyIdent(
            base64Url.decode(base64Url.normalize(a[0] as String)),
            a[1],
            IdentExpect(
              cnonce: want['cnonce'] as String?,
              checkCnonce: want.containsKey('cnonce'),
              hostId: want['hostId'] as String?,
              viewerId: want['viewerId'] as String?,
            ),
          );
          return r.ok
              ? {
                  'ok': true,
                  'reason': null,
                  'hostId': r.hostId,
                  'viewerId': r.viewerId,
                  'cnonce': r.cnonce,
                }
              : {'ok': false, 'reason': r.reason};
        });
        expect(got, expected(c), reason: '${c['note']}');
      }
    });
  });

  group('pair.json', () {
    final file = vectors('pair');

    test('constants', () {
      expect(file['context'], pairContext);
      expect(file['tokenBytes'], pairTokenBytes);
    });

    test('pairMessage', () async {
      for (final c in cases(file, 'pairMessage')) {
        final a = c['args'] as List;
        final got = await outcome(
          () async => pairMessage(a[0], a[1], a[2], a[3]),
        );
        expect(got, expected(c), reason: '$a');
      }
    });

    test('pairProof', () async {
      for (final c in cases(file, 'pairProof')) {
        final a = c['args'] as List;
        final got = await outcome(
          () async => pairProof(
            base64Url.decode(base64Url.normalize(a[0] as String)),
            a[1],
            a[2],
            a[3],
            a[4],
          ),
        );
        expect(got, expected(c), reason: '$a');
      }
    });
  });
}
