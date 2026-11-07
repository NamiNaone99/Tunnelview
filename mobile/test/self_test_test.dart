import 'package:flutter_test/flutter_test.dart';
import 'package:tunnelview_mobile/rtc/self_test.dart';

import 'support/fake_tailnet.dart';

const own = ['100.101.12.7', 'fd7a:115c:a1e0:ab12:4843:cd96:6265:c07'];
final at = DateTime.utc(2026, 11, 7, 12);

void main() {
  group('GatheredCandidate', () {
    test('parses a libwebrtc host candidate line', () {
      final c = GatheredCandidate.fromLine(
        'candidate:842163049 1 UDP 1677729535 100.64.0.7 39713 typ host '
        'generation 0 ufrag Ab12 network-id 3 network-cost 10',
      )!;
      expect(c.address, '100.64.0.7');
      expect(c.port, 39713);
      expect(c.protocol, 'udp');
      expect(c.type, 'host');
      expect(c.networkId, 3);
      expect(c.networkCost, 10);
      expect(c.adapterLabel, 'unknown');
    });

    test('malformed lines are null', () {
      expect(GatheredCandidate.fromLine('a=end-of-candidates'), isNull);
      expect(GatheredCandidate.fromLine('candidate:1 1 udp 1 x 1 host'), isNull);
    });

    test('stats entries carry the adapter type', () {
      final c = GatheredCandidate.fromStats({
        'address': '100.64.0.7',
        'port': 39713,
        'protocol': 'udp',
        'candidateType': 'host',
        'networkType': 'vpn',
        'networkAdapterType': 'vpn',
        'vpn': true,
      });
      expect(c.adapterLabel, 'vpn');
      expect(c.key, '100.64.0.7|39713|udp');
    });
  });

  group('mergeCandidates', () {
    test('lines, SDP lines and stats merge by address, port and protocol', () {
      final merged = mergeCandidates(
        [
          'candidate:1 1 udp 2122260223 100.101.12.7 41234 typ host',
          'a=candidate:1 1 udp 2122260223 100.101.12.7 41234 typ host',
        ],
        [
          {
            'address': '100.101.12.7',
            'port': 41234,
            'protocol': 'udp',
            'networkType': 'vpn',
          },
          {
            'address': '192.168.1.23',
            'port': 41236,
            'protocol': 'udp',
            'networkType': 'wifi',
          },
        ],
      );
      expect(merged.length, 2);
      expect(merged.first.adapterLabel, 'vpn');
      expect(merged.last.address, '192.168.1.23');
    });

    test('an unparsable line is kept, so the verdict refuses it', () {
      final merged = mergeCandidates(['candidate:garbage'], const []);
      expect(merged.length, 1);
      expect(merged.single.address, isNull);
      final r = evaluateSelfTest(
        outcome: GatherOutcome(
          candidates: merged,
          completed: true,
          elapsed: Duration.zero,
        ),
        selfAddrs: own,
        at: at,
      );
      expect(r.verdict, SelfTestVerdict.foreignCandidate);
    });
  });

  group('evaluateSelfTest', () {
    test('only own tun addresses: pass', () {
      final r = evaluateSelfTest(
        outcome: ownCandidates(),
        selfAddrs: own,
        at: at,
      );
      expect(r.verdict, SelfTestVerdict.pass);
      expect(r.allowsSessions, isTrue);
      expect(r.foreign, isEmpty);
    });

    test('the comparison is exact, in canonical form', () {
      final r = evaluateSelfTest(
        outcome: ownCandidates(),
        selfAddrs: const [
          '100.101.12.7',
          'FD7A:115C:A1E0:AB12:4843:CD96:6265:0C07',
        ],
        at: at,
      );
      expect(r.verdict, SelfTestVerdict.pass);
    });

    test('any other address refuses sessions (mask not applied)', () {
      final r = evaluateSelfTest(
        outcome: leakyCandidates(),
        selfAddrs: own,
        at: at,
      );
      expect(r.verdict, SelfTestVerdict.foreignCandidate);
      expect(r.allowsSessions, isFalse);
      expect(r.foreign.single.address, '192.168.1.23');
    });

    test('another phone on the carrier CGNAT range is not "own"', () {
      final r = evaluateSelfTest(
        outcome: GatherOutcome(
          candidates: [
            GatheredCandidate.fromLine(
              'candidate:1 1 udp 1 100.70.1.2 41234 typ host',
            )!,
          ],
          completed: true,
          elapsed: Duration.zero,
        ),
        selfAddrs: own,
        at: at,
      );
      expect(r.verdict, SelfTestVerdict.foreignCandidate);
    });

    test('an mDNS name is not an own address', () {
      final r = evaluateSelfTest(
        outcome: GatherOutcome(
          candidates: [
            GatheredCandidate.fromLine(
              'candidate:1 1 udp 1 3f2a1c4e-aaaa.local 41234 typ host',
            )!,
          ],
          completed: true,
          elapsed: Duration.zero,
        ),
        selfAddrs: own,
        at: at,
      );
      expect(r.verdict, SelfTestVerdict.foreignCandidate);
    });

    test('no candidates, incomplete or error: refused', () {
      expect(
        evaluateSelfTest(
          outcome: const GatherOutcome(
            candidates: [],
            completed: true,
            elapsed: Duration.zero,
          ),
          selfAddrs: own,
          at: at,
        ).verdict,
        SelfTestVerdict.noCandidates,
      );
      expect(
        evaluateSelfTest(
          outcome: GatherOutcome(
            candidates: ownCandidates().candidates,
            completed: false,
            elapsed: const Duration(seconds: 5),
          ),
          selfAddrs: own,
          at: at,
        ).verdict,
        SelfTestVerdict.incomplete,
      );
      final failed = evaluateSelfTest(
        outcome: const GatherOutcome.failed('webrtc-unavailable', Duration.zero),
        selfAddrs: own,
        at: at,
      );
      expect(failed.verdict, SelfTestVerdict.error);
      expect(failed.allowsSessions, isFalse);
    });
  });
}
