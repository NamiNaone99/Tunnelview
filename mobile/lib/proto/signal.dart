/// Validation of everything the remote host sends once a session runs:
/// signaling (offers, candidates), `control` data-channel messages and the
/// selected ICE path. Ported from the desktop `src/renderer/viewer/validate.js`
/// and `src/renderer/shared/rtc.js`; checked against test/vectors/validate.json,
/// addresses.json and tailnet-path.json.
library;

import '../net/addresses.dart';
import 'codec.dart';

const int maxSdpLength = 1024 * 1024;
const int _maxDisplays = 32;
const int _maxDisplayId = 128;

// C0/C1 controls, zero-width characters, direction marks, bidi embeddings,
// overrides and isolates, BOM. A host-chosen name with U+202E could look like
// another device.
final RegExp _unsafeLabelRe = RegExp(
  '[\u0000-\u001f\u007f-\u009f\u200b\u200c\u200e\u200f\u061c'
  '\u202a-\u202e\u2066-\u2069\ufeff]',
);

/// Untrusted value to a single-line display string: unsafe characters
/// stripped, capped at [max] code points.
String cleanLabel(Object? value, [int max = 80]) {
  if (value == null) return '';
  final text = value is String ? value : _jsString(value);
  var s = jsTrim(text.replaceAll(_unsafeLabelRe, ''));
  if (s.length > max) {
    final cps = s.runes.toList();
    if (cps.length > max) {
      final keep = max - 1 < 1 ? 1 : max - 1;
      s = '${String.fromCharCodes(cps.take(keep))}…';
    }
  }
  return s;
}

String _jsString(Object value) {
  if (value is double && value == value.truncateToDouble() && value.isFinite) {
    return value.toInt().toString();
  }
  if (value is Map) return '[object Object]';
  if (value is List) {
    return value.map((e) => e == null ? '' : _jsString(e)).join(',');
  }
  return value.toString();
}

/// ICE candidate init (a decoded JSON value). Null, or a missing or empty
/// candidate line (end of candidates) is allowed; otherwise the address must
/// be a Tailscale IP.
bool isAllowedCandidate(Object? init) {
  if (init == null) return true;
  if (init is! Map) return false;
  final c = init['candidate'];
  if (c == null || c == '') return true;
  if (c is! String) return false;
  return isTailscaleAddress(candidateAddress(c));
}

/// A clean ICE candidate from the host.
class SignalCandidate {
  const SignalCandidate(
    this.candidate,
    this.sdpMid,
    this.sdpMLineIndex,
    this.usernameFragment,
  );

  final String candidate;
  final String? sdpMid;
  final int? sdpMLineIndex;
  final String? usernameFragment;

  Map<String, Object?> toJson() => {
    'candidate': candidate,
    'sdpMid': sdpMid,
    'sdpMLineIndex': sdpMLineIndex,
    'usernameFragment': usernameFragment,
  };
}

/// A clean signaling message from the host: an offer, a candidate, or the
/// end of candidates.
class Signal {
  const Signal.offer(String this.sdp) : isOffer = true, candidate = null;
  const Signal.ice(this.candidate) : isOffer = false, sdp = null;

  final bool isOffer;
  final String? sdp;

  /// Null for an offer, and for the end of candidates.
  final SignalCandidate? candidate;

  Map<String, Object?> toJson() => isOffer
      ? {
          't': 'sdp',
          'description': {'type': 'offer', 'sdp': sdp},
        }
      : {'t': 'ice', 'candidate': candidate?.toJson()};
}

({bool ok, String? value}) _optString(Object? v, int max) {
  if (v == null) return (ok: true, value: null);
  if (v is! String || v.length > max) return (ok: false, value: null);
  return (ok: true, value: v);
}

/// Host to viewer signaling: shapes only. The viewer is always the answerer,
/// so only offers are accepted. Null for anything else.
Signal? validateSignal(Object? msg) {
  if (msg is! Map) return null;
  if (msg['t'] == 'sdp') {
    final d = msg['description'];
    if (d is! Map || d['type'] != 'offer') return null;
    final sdp = d['sdp'];
    if (sdp is! String ||
        sdp.isEmpty ||
        sdp.length > maxSdpLength ||
        !sdp.startsWith('v=0')) {
      return null;
    }
    return Signal.offer(sdp);
  }
  if (msg['t'] == 'ice') {
    final c = msg['candidate'];
    if (c == null) return const Signal.ice(null);
    if (c is! Map) return null;
    final line = c['candidate'];
    if (line is! String || line.length > maxCandidateLength) return null;
    final mid = _optString(c['sdpMid'], 64);
    final ufrag = _optString(c['usernameFragment'], 256);
    if (!mid.ok || !ufrag.ok) return null;
    int? mline;
    final rawMline = c['sdpMLineIndex'];
    if (rawMline != null) {
      if (!isSafeInteger(rawMline)) return null;
      final n = (rawMline as num).toInt();
      if (n < 0 || n > 255) return null;
      mline = n;
    }
    if (line.isNotEmpty && mid.value == null && mline == null) return null;
    return Signal.ice(SignalCandidate(line, mid.value, mline, ufrag.value));
  }
  return null;
}

final RegExp _eolRe = RegExp(r'\r\n|\n');

/// Removes every `a=candidate:` line whose address is not a Tailscale IP, from
/// an offer we received or an answer we send. Lines are joined with CRLF.
String sanitizeSdp(Object? sdp) {
  if (sdp is! String) return '';
  return sdp
      .split(_eolRe)
      .where(
        (line) =>
            !line.startsWith('a=candidate:') ||
            isAllowedCandidate({'candidate': line.substring(2)}),
      )
      .join('\r\n');
}

/// One of the host's displays.
class RemoteDisplay {
  const RemoteDisplay({
    required this.id,
    required this.name,
    required this.primary,
    required this.width,
    required this.height,
    required this.scaleFactor,
  });

  final String id;
  final String name;
  final bool primary;
  final int width;
  final int height;
  final num scaleFactor;

  Map<String, Object?> toJson() => {
    'id': id,
    'name': name,
    'primary': primary,
    'width': width,
    'height': height,
    'scaleFactor': scaleFactor,
  };
}

/// A clean `control` message from the host.
sealed class ControlMessage {
  const ControlMessage();
}

/// The host's display list.
class DisplaysMessage extends ControlMessage {
  const DisplaysMessage(this.displays, this.current);

  final List<RemoteDisplay> displays;

  /// The streamed display's id, or null when it is not in [displays].
  final String? current;
}

/// Informational host state.
class HostStateMessage extends ControlMessage {
  const HostStateMessage({
    this.audio,
    this.controlAllowed,
    this.hasInputBlocked = false,
    this.inputBlocked,
  });

  final bool? audio;
  final bool? controlAllowed;

  /// Whether the message carried a valid `inputBlocked` (null included).
  final bool hasInputBlocked;

  /// 'secure-desktop' | 'elevated-window' while the host OS refuses injected
  /// input, else null.
  final String? inputBlocked;
}

num _jsRound(num v) => (v + 0.5).floor();

RemoteDisplay? _normalizeDisplay(Object? d, int index) {
  if (d is! Map) return null;
  final rawId = d['id'];
  if (rawId is! String && !isSafeInteger(rawId)) return null;
  final id = rawId is String ? rawId : (rawId as num).toInt().toString();
  // Never truncated: the id is echoed back in select-display.
  if (id.isEmpty || id.length > _maxDisplayId) return null;
  int dim(Object? v) =>
      v is num && v.isFinite && v > 0 && v <= 65536 ? _jsRound(v).toInt() : 0;
  final sf = d['scaleFactor'];
  final name = cleanLabel(d['name'], 60);
  return RemoteDisplay(
    id: id,
    name: name.isEmpty ? 'Display ${index + 1}' : name,
    primary: d['primary'] == true,
    width: dim(d['width']),
    height: dim(d['height']),
    scaleFactor: sf is num && sf.isFinite && sf >= 0.25 && sf <= 8 ? sf : 1,
  );
}

/// A parsed `control` message from the host: [DisplaysMessage],
/// [HostStateMessage], or null to ignore. The phone does not handle
/// `clipboard` and `chat` yet, so they are ignored too.
ControlMessage? validateControl(Object? msg) {
  if (msg is! Map || msg['t'] is! String) return null;
  switch (msg['t']) {
    case 'displays':
      final list = msg['displays'];
      if (list is! List) return null;
      final seen = <String>{};
      final displays = <RemoteDisplay>[];
      for (final raw in list.take(_maxDisplays)) {
        final d = _normalizeDisplay(raw, displays.length);
        if (d != null && seen.add(d.id)) displays.add(d);
      }
      final c = msg['current'];
      final current = c is String
          ? c
          : isSafeInteger(c)
          ? (c as num).toInt().toString()
          : null;
      return DisplaysMessage(
        List.unmodifiable(displays),
        displays.any((d) => d.id == current) ? current : null,
      );
    case 'host-state':
      final blocked = msg['inputBlocked'];
      final known =
          msg.containsKey('inputBlocked') &&
          (blocked == null ||
              blocked == 'secure-desktop' ||
              blocked == 'elevated-window');
      return HostStateMessage(
        audio: msg['audio'] is bool ? msg['audio'] as bool : null,
        controlAllowed: msg['controlAllowed'] is bool
            ? msg['controlAllowed'] as bool
            : null,
        hasInputBlocked: known,
        inputBlocked: known ? blocked as String? : null,
      );
    default:
      return null;
  }
}

/// `{control, clipboard, files, audio}`: anything not literally true is false.
class Permissions {
  const Permissions({
    this.control = false,
    this.clipboard = false,
    this.files = false,
    this.audio = false,
  });

  factory Permissions.from(Object? p) {
    final m = p is Map ? p : const {};
    return Permissions(
      control: m['control'] == true,
      clipboard: m['clipboard'] == true,
      files: m['files'] == true,
      audio: m['audio'] == true,
    );
  }

  final bool control;
  final bool clipboard;
  final bool files;
  final bool audio;
}

/// The selected ICE pair, checked against the tunnel-only rule.
class PathCheck {
  const PathCheck({
    required this.ok,
    required this.pair,
    this.local,
    this.remote,
    this.protocol,
    this.localType,
    this.remoteType,
  });

  /// False iff an address is present and is not a Tailscale IP.
  final bool ok;

  /// Whether a selected pair was found.
  final bool pair;
  final String? local;
  final String? remote;
  final String? protocol;
  final String? localType;
  final String? remoteType;

  Map<String, Object?> toJson() => {
    'ok': ok,
    'local': local,
    'remote': remote,
    'pair': pair,
    'protocol': protocol,
    'localType': localType,
    'remoteType': remoteType,
  };
}

final RegExp _hostNameRe = RegExp(
  r'^(?=.*[A-Za-z])[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.?$',
);

String? _rawAddress(Map? cand) {
  if (cand == null) return null;
  final a = cand['address'] ?? cand['ip'];
  return a is String && a.isNotEmpty ? a : null;
}

String? _strip(String addr) {
  var s = jsTrim(addr);
  if (s.startsWith('[')) {
    final end = s.indexOf(']');
    if (end == -1) return null;
    s = s.substring(1, end);
  }
  final pct = s.indexOf('%');
  if (pct != -1) s = s.substring(0, pct);
  return s;
}

/// The candidate's IP literal (brackets and zone stripped), or null.
String? _statsAddress(Map? cand) {
  final a = _rawAddress(cand);
  final s = a == null ? null : _strip(a);
  if (s == null || s.isEmpty) return null;
  return parseIPv4(s) != null || parseIPv6(s) != null ? s : null;
}

bool _remoteOk(Map? cand) {
  final ip = _statsAddress(cand);
  if (ip != null) return isTailscaleAddress(ip);
  final a = _rawAddress(cand);
  return a == null || _hostNameRe.hasMatch(jsTrim(a));
}

bool _localOk(Map? cand) {
  final ip = _statsAddress(cand);
  if (ip != null) return isTailscaleAddress(ip);
  return _rawAddress(cand) == null;
}

String? _nonEmpty(Object? v) => v is String && v.isNotEmpty ? v : null;

/// Checks the selected candidate pair in a getStats() report ([stats]: one
/// map per entry, with `id` and `type`). A local address that is present must
/// be a Tailscale IP; a remote IP literal must be one; a remote with no
/// address or a host name is unknown and allowed. No selected pair: ok, with
/// `pair` false.
PathCheck verifyTailnetPath(List<Map> stats) {
  const none = PathCheck(ok: true, pair: false);
  final byId = <Object?, Map>{};
  for (final r in stats) {
    byId[r['id']] = r;
  }
  Map? pair;
  for (final r in stats) {
    final sel = r['selectedCandidatePairId'];
    if (r['type'] == 'transport' && sel != null && sel != '') {
      pair = byId[sel];
      if (pair != null) break;
    }
  }
  if (pair == null) {
    for (final r in stats) {
      if (r['type'] == 'candidate-pair' &&
          (r['selected'] == true ||
              (_truthy(r['nominated']) && r['state'] == 'succeeded'))) {
        pair = r;
        break;
      }
    }
  }
  if (pair == null) return none;
  final lc = byId[pair['localCandidateId']];
  final rc = byId[pair['remoteCandidateId']];
  return PathCheck(
    ok: _localOk(lc) && _remoteOk(rc),
    pair: true,
    local: _statsAddress(lc),
    remote: _statsAddress(rc),
    protocol: _nonEmpty(lc?['protocol']),
    localType: _nonEmpty(lc?['candidateType']),
    remoteType: _nonEmpty(rc?['candidateType']),
  );
}

bool _truthy(Object? v) =>
    !(v == null || v == false || v == 0 || v == '' || (v is double && v.isNaN));
