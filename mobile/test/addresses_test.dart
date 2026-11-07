// Port of the address helpers in the desktop src/renderer/shared/rtc.js.
// Every expected value below was produced by running the REAL desktop
// functions (rtc.js parseIPv4 / parseIPv6 / isTailscaleAddress /
// candidateAddress, tailscale.js normalizeIp) on the same input. The inputs
// are the desktop test cases (test/tailscale.test.js, test/rtc-path.test.js,
// test/viewer-validate.test.js) plus edge cases of the port. The shared JSON
// vectors (test/vectors) replace these lists in a later milestone.
import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/net/addresses.dart';

// (input, isTailscaleAddress, parseIPv4, parseIPv6)
const List<(String, bool, List<int>?, List<int>?)> addressVectors = [
  ('100.63.255.255', false, [100, 63, 255, 255], null),
  ('100.64.0.0', true, [100, 64, 0, 0], null),
  ('100.100.100.100', true, [100, 100, 100, 100], null),
  ('100.127.255.255', true, [100, 127, 255, 255], null),
  ('100.128.0.0', false, [100, 128, 0, 0], null),
  ('10.0.0.1', false, [10, 0, 0, 1], null),
  ('192.168.1.1', false, [192, 168, 1, 1], null),
  ('0.0.0.0', false, [0, 0, 0, 0], null),
  ('255.255.255.255', false, [255, 255, 255, 255], null),
  ('fd7a:115c:a1e0::1', true, null, [64890, 4444, 41440, 0, 0, 0, 0, 1]),
  ('FD7A:115C:A1E0::1', true, null, [64890, 4444, 41440, 0, 0, 0, 0, 1]),
  ('fd7a:115c:a1e0:0:0:0:0:1', true, null, [64890, 4444, 41440, 0, 0, 0, 0, 1]),
  ('fd7a:115c:a1e0:ffff:ffff:ffff:ffff:ffff', true, null, [64890, 4444, 41440, 65535, 65535, 65535, 65535, 65535]),
  ('fd7a:115c:a1e0::', true, null, [64890, 4444, 41440, 0, 0, 0, 0, 0]),
  ('fd7a:115c:a1e1::1', false, null, [64890, 4444, 41441, 0, 0, 0, 0, 1]),
  ('fd7a:115c::1', false, null, [64890, 4444, 0, 0, 0, 0, 0, 1]),
  ('fd7a:115c:a1e:0::1', false, null, [64890, 4444, 2590, 0, 0, 0, 0, 1]),
  ('::1', false, null, [0, 0, 0, 0, 0, 0, 0, 1]),
  ('fe80::1', false, null, [65152, 0, 0, 0, 0, 0, 0, 1]),
  ('::ffff:100.100.1.1', true, null, [0, 0, 0, 0, 0, 65535, 25700, 257]),
  ('::FFFF:100.64.0.1', true, null, [0, 0, 0, 0, 0, 65535, 25664, 1]),
  ('::ffff:6464:0101', true, null, [0, 0, 0, 0, 0, 65535, 25700, 257]),
  ('::ffff:10.0.0.1', false, null, [0, 0, 0, 0, 0, 65535, 2560, 1]),
  ('[fd7a:115c:a1e0::1]', true, null, null),
  ('fd7a:115c:a1e0::1%utun3', true, null, null),
  ('[fd7a:115c:a1e0::1%14]', true, null, null),
  (' 100.64.0.1 ', true, null, null),
  ('', false, null, null),
  ('100.64.0', false, null, null),
  ('100.64.0.1.2', false, null, null),
  ('100.064.0.1', false, null, null),
  ('100.64.0.256', false, null, null),
  ('100.64.0.1/32', false, null, null),
  ('fd7a:115c:a1e0::1::2', false, null, null),
  ('fd7a:115c:a1e0:::1', false, null, null),
  ('fd7a:115c:a1e0:1:2:3:4:5:6', false, null, null),
  ('fd7a:115c:a1e0::g', false, null, null),
  ('host.example', false, null, null),
  ('100.64.0.1:47800', false, null, null),
  ('::ffff:100.64.0', false, null, null),
  ('100.64.0.1', true, [100, 64, 0, 1], null),
  ('100.127.255.254', true, [100, 127, 255, 254], null),
  ('[fd7a:115c:a1e0:ab12::2]', true, null, null),
  ('192.168.1.20', false, [192, 168, 1, 20], null),
  ('10.0.0.5', false, [10, 0, 0, 5], null),
  ('203.0.113.9', false, [203, 0, 113, 9], null),
  ('100.128.0.1', false, [100, 128, 0, 1], null),
  ('fe80::1%eth0', false, null, null),
  ('redacted-ip.invalid', false, null, null),
  ('3f1c9a2e-77b0-4c1d-9e1a-0b6c2d1e4f00.local', false, null, null),
  ('abc.local', false, null, null),
  ('100.64.0.01', false, null, null),
  ('fd7a::115c::1', false, null, null),
  ('8.8.8.8', false, [8, 8, 8, 8], null),
  ('100.101.102.103', true, [100, 101, 102, 103], null),
  ('fd7a:115c:a1e0::1234', true, null, [64890, 4444, 41440, 0, 0, 0, 0, 4660]),
  ('3f2a1c4e-aaaa-bbbb-cccc-0123456789ab.local', false, null, null),
  ('[fd7a:115c:a1e0::1]:47800', true, null, null),
  ('[fd7a:115c:a1e0::1', false, null, null),
  ('[]', false, null, null),
  ('%eth0', false, null, null),
  ('[%1]', false, null, null),
  ('\t100.64.0.1\n', true, null, null),
  ('\u{85}100.64.0.1', false, null, null),
  ('100.64.0.1\u{85}', false, null, null),
  ('\u{a0}100.64.0.1', true, null, null),
  ('\u{feff}100.64.0.1', true, null, null),
  ('\u{2028}100.64.0.1', true, null, null),
  ('\u{3000}fd7a:115c:a1e0::1', true, null, null),
  ('\u{180e}100.64.0.1', false, null, null),
  ('::100.64.0.1', false, null, [0, 0, 0, 0, 0, 0, 25664, 1]),
  ('::ffff:100.64.0.1', true, null, [0, 0, 0, 0, 0, 65535, 25664, 1]),
  ('0:0:0:0:0:ffff:6440:1', true, null, [0, 0, 0, 0, 0, 65535, 25664, 1]),
  ('::ffff:0:100.64.0.1', false, null, [0, 0, 0, 0, 65535, 0, 25664, 1]),
  ('fd7a:115c:a1e0:1:2:3:100.64.0.1', true, null, [64890, 4444, 41440, 1, 2, 3, 25664, 1]),
  ('fd7a:115c:a1e0:1:2:3:4:100.64.0.1', false, null, null),
  ('fd7a:115c:a1e0::100.64.0.1', true, null, [64890, 4444, 41440, 0, 0, 0, 25664, 1]),
  ('1:2:3:4:5:6:7::', false, null, [1, 2, 3, 4, 5, 6, 7, 0]),
  ('::2:3:4:5:6:7:8', false, null, [0, 2, 3, 4, 5, 6, 7, 8]),
  ('1:2:3:4:5:6:7:8', false, null, [1, 2, 3, 4, 5, 6, 7, 8]),
  ('1::2:3:4:5:6:7:8', false, null, null),
  ('::', false, null, [0, 0, 0, 0, 0, 0, 0, 0]),
  (':', false, null, null),
  (':::', false, null, null),
  ('fd7a:115c:a1e0::1:', false, null, null),
  (':fd7a:115c:a1e0::1', false, null, null),
  ('fd7a:115c:a1e0:00000::1', false, null, null),
  ('fd7a:115c:a1e0:0::01', true, null, [64890, 4444, 41440, 0, 0, 0, 0, 1]),
  ('100.64.0.1.', false, null, null),
  ('.100.64.0.1', false, null, null),
  ('1000.64.0.1', false, null, null),
  ('100.64.0.-1', false, null, null),
  ('100.64.0.+1', false, null, null),
  ('100.64.0.1e0', false, null, null),
  ('100.64.0.0x1', false, null, null),
  ('\u{661}\u{660}\u{660}.64.0.1', false, null, null),
  ('fd7a:115c:a1e0::\u{663}', false, null, null),
  ('fd7a:115c:a1e0:0000:0000:0000:0000:0001', true, null, [64890, 4444, 41440, 0, 0, 0, 0, 1]),
  ('fd7a:115c:a1e0:0000:0000:0000:0000:0001%xxxxxxxxxxxxxxxxxxxxxxxx', true, null, null),
  ('fd7a:115c:a1e0:0000:0000:0000:0000:0001%xxxxxxxxxxxxxxxxxxxxxxxxx', false, null, null),
  ('0000:0000:0000:0000:0000:ffff:100.064.0.1', false, null, null),
  ('0000:0000:0000:0000:0000:ffff:100.064.000.001', false, null, null),
  ('0000:0000:0000:0000:0000:ffff:100.64.255.255', true, null, [0, 0, 0, 0, 0, 65535, 25664, 65535]),
  ('                                                      100.64.0.1', true, null, null),
  ('                                                       100.64.0.1', false, null, null),
  ('FD7A:115C:A1E0:ABCD:EF01:2345:6789:ABCD', true, null, [64890, 4444, 41440, 43981, 61185, 9029, 26505, 43981]),
  ('64:ff9b::100.64.0.1', false, null, [100, 65435, 0, 0, 0, 0, 25664, 1]),
];

// (input, canonical form from tailscale.js normalizeIp)
const List<(String, String)> canonicalVectors = [
  ('100.64.0.1', '100.64.0.1'),
  ('FD7A:115C:A1E0:0:0:0:0:1', 'fd7a:115c:a1e0::1'),
  ('fd7a:115c:a1e0:0000:0000:1234:5678:0001', 'fd7a:115c:a1e0::1234:5678:1'),
  ('[fd7a:115c:a1e0::1%tun0]', 'fd7a:115c:a1e0::1'),
  ('::ffff:100.64.1.2', '100.64.1.2'),
  ('::ffff:6440:102', '100.64.1.2'),
  ('fd7a:0:0:1:0:0:0:1', 'fd7a:0:0:1::1'),
  ('fd7a:115c:a1e0:0:0:1:0:0', 'fd7a:115c:a1e0::1:0:0'),
  ('fd7a:115c:a1e0:0:1:0:0:1', 'fd7a:115c:a1e0:0:1::1'),
  ('1:0:0:2:0:0:0:3', '1:0:0:2::3'),
  ('0:0:0:0:0:0:0:0', '::'),
  ('0:0:0:0:0:0:0:1', '::1'),
  ('fd7a:115c:a1e0:1:2:3:4:5', 'fd7a:115c:a1e0:1:2:3:4:5'),
  ('fd7a:115c:a1e0::100.64.0.1', 'fd7a:115c:a1e0::6440:1'),
  (' 100.100.100.100 ', '100.100.100.100'),
  ('fe80::1%tun0', 'fe80::1'),
  ('2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'),
  ('2001:0:0:1:0:0:0:1', '2001:0:0:1::1'),
  ('fd7a:115c:a1e0:ab12:4843:cd96:6258:b240', 'fd7a:115c:a1e0:ab12:4843:cd96:6258:b240'),
];

void main() {
  group('rtc.js port', () {
    for (final (input, ts, v4, v6) in addressVectors) {
      test('address "${Uri.encodeComponent(input)}"', () {
        expect(isTailscaleAddress(input), ts, reason: 'isTailscaleAddress');
        expect(parseIPv4(input), v4, reason: 'parseIPv4');
        expect(parseIPv6(input), v6, reason: 'parseIPv6');
      });
    }

    test('non-strings are never addresses', () {
      for (final v in <Object?>[
        null,
        42,
        1.5,
        true,
        const <int>[100, 64, 0, 1],
      ]) {
        expect(isTailscaleAddress(v), isFalse);
        expect(parseIPv4(v), isNull);
        expect(parseIPv6(v), isNull);
        expect(candidateAddress(v), isNull);
        expect(canonicalAddress(v), isNull);
      }
    });

    test('trim follows JavaScript (U+0085 is not whitespace there)', () {
      expect(jsTrim('\u0085x\u0085'), '\u0085x\u0085');
      expect(jsTrim(' ﻿ 　x\t\n'), 'x');
      expect(jsTrim('᠎x'), '᠎x');
      expect(jsTrim('   '), '');
    });
  });

  group('candidateAddress', () {
    const cases = <(String, String?)>[
      (
        'candidate:1 1 udp 2122260223 100.101.102.103 47810 typ host '
            'generation 0',
        '100.101.102.103',
      ),
      (
        'a=candidate:3 1 udp 2122129151 fd7a:115c:a1e0::1234 47812 typ host '
            'generation 0',
        'fd7a:115c:a1e0::1234',
      ),
      (
        'candidate:4 1 udp 2122063615 '
            '3f2a1c4e-aaaa-bbbb-cccc-0123456789ab.local 47813 typ host '
            'generation 0',
        '3f2a1c4e-aaaa-bbbb-cccc-0123456789ab.local',
      ),
      (
        'candidate:5 1 udp 1686052607 203.0.113.9 47814 typ srflx raddr '
            '0.0.0.0 rport 0',
        '203.0.113.9',
      ),
      (
        'candidate:842163049 1 udp 1677729535 100.64.0.7 39713 typ host '
            'generation 0 ufrag Ab12 network-id 3 network-cost 10',
        '100.64.0.7',
      ),
      ('  candidate:1 1 udp 1 100.64.0.1 47801 typ host  ', '100.64.0.1'),
      ('candidate:1  1 udp 1 100.64.0.1 47801 typ host', '100.64.0.1'),
      ('candidate:1 1 udp 1 100.64.0.1 47801 host', null),
      ('candidate:1 1 udp 1 100.64.0.1 47801 typ', null),
      ('candidate:1 1 udp 1 100.64.0.1 47801 type host', null),
      ('a=end-of-candidates', null),
      ('', null),
      ('candidate:', null),
      ('xcandidate:1 1 udp 1 100.64.0.1 47801 typ host', null),
      ('candidate:1\t1\tudp\t1\t100.64.0.1\t47801\ttyp\thost', '100.64.0.1'),
    ];
    for (final (line, want) in cases) {
      test(line, () => expect(candidateAddress(line), want));
    }

    test('2048 characters is the longest line', () {
      const base = 'candidate:1 1 udp 1 100.64.0.1 47801 typ host ';
      expect(candidateAddress('$base${'x' * 2000}'), '100.64.0.1');
      expect(candidateAddress('$base${'x' * 2010}'), isNull);
    });
  });

  group('canonicalAddress (same as desktop normalizeIp)', () {
    for (final (input, want) in canonicalVectors) {
      test(input, () => expect(canonicalAddress(input), want));
    }

    test('non-addresses have no canonical form', () {
      for (final s in [
        '',
        'host.example',
        '100.64.0.01',
        '[fd7a::1',
        'abc.local',
      ]) {
        expect(canonicalAddress(s), isNull, reason: s);
      }
    });
  });

  group('addressBytes', () {
    test('IPv4, IPv6 and mapped IPv4', () {
      expect(addressBytes('100.64.0.1'), [100, 64, 0, 1]);
      expect(addressBytes('::ffff:100.64.0.1'), [100, 64, 0, 1]);
      expect(addressBytes('fd7a:115c:a1e0::1'), [
        0xfd, 0x7a, 0x11, 0x5c, 0xa1, 0xe0, 0, 0, //
        0, 0, 0, 0, 0, 0, 0, 1,
      ]);
      expect(addressBytes('desk.example.ts.net'), isNull);
    });
  });

  group('family helpers', () {
    test('v4 and v6 Tailscale ranges', () {
      expect(isTailscaleV6Address('fd7a:115c:a1e0::1'), isTrue);
      expect(isTailscaleV6Address('::ffff:100.64.0.1'), isFalse);
      expect(isTailscaleV6Address('100.64.0.1'), isFalse);
      expect(isTailscaleV4Address('100.64.0.1'), isTrue);
      expect(isTailscaleV4Address('::ffff:100.64.0.1'), isTrue);
      expect(isTailscaleV4Address('fd7a:115c:a1e0::1'), isFalse);
      expect(isInsideTailscaleV4Range('100.64.0.0', 10), isTrue);
      expect(isInsideTailscaleV4Range('100.64.0.0', 9), isFalse);
      expect(isInsideTailscaleV4Range('100.88.1.4', 32), isTrue);
      expect(isInsideTailscaleV4Range('100.128.0.0', 10), isFalse);
    });
  });
}
