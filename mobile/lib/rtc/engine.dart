// The ONLY file in the app that may import package:flutter_webrtc. CI fails
// the build if any other Dart file does (.github/workflows/android.yml).
//
// Why: flutter_webrtc initialises itself with default options (no network
// mask) the first time any of its APIs is used, and the native
// PeerConnectionFactory keeps the options it was created with. If anything
// touched WebRTC before the masked initialisation, libwebrtc would gather
// candidates on Wi-Fi and mobile data, outside the Tailscale tunnel. So
// main() awaits [RtcEngine.initialize] before runApp, and everything else
// goes through this file and checks [RtcEngine.ready] first.
import 'dart:async';
import 'dart:io' show Platform;

import 'package:flutter_webrtc/flutter_webrtc.dart';

import 'self_test.dart';

/// Platforms with their own network mask rules.
enum RtcPlatform { android, ios, unsupported }

/// The platform this process runs on.
RtcPlatform get currentRtcPlatform {
  if (Platform.isAndroid) return RtcPlatform.android;
  if (Platform.isIOS) return RtcPlatform.ios;
  return RtcPlatform.unsupported;
}

/// Adapter types libwebrtc must never gather candidates on. Only VPN stays.
///
/// Each entry appears once: the Android plugin adds the bits up, so a repeated
/// entry would set a wrong bit. Android also masks ANY, because libwebrtc falls
/// back to ANY-address networks when enumeration is empty. iOS must never get
/// ANY: there it sets every ignore flag, VPN included, and nothing is gathered.
List<String> networkIgnoreMaskFor(RtcPlatform platform) {
  const common = <AdapterType>[
    AdapterType.adapterTypeEthernet,
    AdapterType.adapterTypeWifi,
    AdapterType.adapterTypeCellular,
    AdapterType.adapterTypeLoopback,
  ];
  switch (platform) {
    case RtcPlatform.android:
      return [for (final t in common) t.name, AdapterType.adapterTypeAny.name];
    case RtcPlatform.ios:
      return [for (final t in common) t.name];
    case RtcPlatform.unsupported:
      return const [];
  }
}

/// Remote audio must not pause the user's music or switch the phone to call
/// mode: no audio focus, normal mode, media usage.
AndroidAudioConfiguration androidAudioConfiguration() =>
    AndroidAudioConfiguration(
      manageAudioFocus: false,
      androidAudioMode: AndroidAudioMode.normal,
      androidAudioAttributesUsageType: AndroidAudioAttributesUsageType.media,
      androidAudioAttributesContentType:
          AndroidAudioAttributesContentType.movie,
    );

/// The options for the one and only `WebRTC.initialize` call.
Map<String, dynamic> initOptionsFor(RtcPlatform platform) => {
  'networkIgnoreMask': networkIgnoreMaskFor(platform),
  'zeroPlayoutDelay': true,
  if (platform == RtcPlatform.android)
    'androidAudioConfiguration': androidAudioConfiguration().toMap(),
};

/// Outcome of the start-up initialisation.
class RtcInitResult {
  const RtcInitResult.ok() : ok = true, error = null;
  const RtcInitResult.failed(String this.error) : ok = false;

  final bool ok;
  final String? error;
}

/// Owner of the process-wide WebRTC factory.
class RtcEngine {
  RtcEngine._();

  static Future<RtcInitResult>? _init;
  static RtcInitResult? _result;

  /// Initialises WebRTC with the tunnel-only mask. Safe to call more than
  /// once: every call returns the first call's future.
  static Future<RtcInitResult> initialize() =>
      _init ??= _initialize(currentRtcPlatform);

  /// True once [initialize] completed with the mask applied.
  static bool get ready => _result?.ok ?? false;

  /// The start-up result, or null before [initialize] completed.
  static RtcInitResult? get result => _result;

  /// Throws unless [initialize] completed successfully. Every future
  /// peer-connection or renderer factory in this file calls it first.
  static void ensureReady() {
    if (!ready) {
      throw StateError('WebRTC is not initialised with the tunnel-only mask');
    }
  }

  static Future<RtcInitResult> _initialize(RtcPlatform platform) async {
    if (platform == RtcPlatform.unsupported) {
      return _result = const RtcInitResult.failed('unsupported platform');
    }
    if (WebRTC.initialized) {
      // Something used flutter_webrtc first, so the factory already exists
      // without the mask. Refuse instead of running unmasked.
      return _result = const RtcInitResult.failed(
        'WebRTC was initialised before the network mask was applied',
      );
    }
    try {
      await WebRTC.initialize(options: initOptionsFor(platform));
      if (platform == RtcPlatform.android) {
        await Helper.setAndroidAudioConfiguration(androidAudioConfiguration());
      }
      return _result = const RtcInitResult.ok();
    } catch (e) {
      return _result = RtcInitResult.failed('WebRTC initialisation failed: $e');
    }
  }
}

/// Settings for every peer connection. No ICE servers: no STUN or TURN, so
/// nothing is ever sent to a third party and only host candidates exist.
Map<String, dynamic> peerConnectionConfig() => {
  'iceServers': <Map<String, dynamic>>[],
  'bundlePolicy': 'max-bundle',
  'rtcpMuxPolicy': 'require',
  'sdpSemantics': 'unified-plan',
  'tcpCandidatePolicy': 'disabled',
};

/// Throws unless [config] has an empty `iceServers` list.
void assertNoIceServers(Map<String, dynamic> config) {
  final servers = config['iceServers'];
  if (servers is! List || servers.isNotEmpty) {
    throw StateError('peer connections must have no ICE servers');
  }
}

/// The real [LocalIceGatherer]: a local peer connection with one data
/// channel and an offer, gathered until complete or the timeout, then closed.
/// The offer and the candidates never leave this function's result.
class EngineIceGatherer implements LocalIceGatherer {
  const EngineIceGatherer();

  @override
  Future<GatherOutcome> gather({
    Duration timeout = const Duration(seconds: 5),
  }) async {
    final watch = Stopwatch()..start();
    if (!RtcEngine.ready) {
      return GatherOutcome.failed('webrtc-unavailable', watch.elapsed);
    }
    RTCPeerConnection? pc;
    final lines = <String>[];
    final complete = Completer<void>();
    try {
      final config = peerConnectionConfig();
      assertNoIceServers(config);
      pc = await createPeerConnection(config);
      pc.onIceCandidate = (c) {
        final line = c.candidate;
        if (line != null && line.isNotEmpty) lines.add(line);
      };
      pc.onIceGatheringState = (state) {
        if (state == RTCIceGatheringState.RTCIceGatheringStateComplete &&
            !complete.isCompleted) {
          complete.complete();
        }
      };
      await pc.createDataChannel('self-test', RTCDataChannelInit());
      final offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      var completed = true;
      try {
        await complete.future.timeout(timeout);
      } on TimeoutException {
        completed = false;
      }
      final local = await pc.getLocalDescription();
      final sdpLines = (local?.sdp ?? '')
          .split(RegExp(r'\r?\n'))
          .where((l) => l.startsWith('a=candidate:'));
      final stats = await pc.getStats();
      return GatherOutcome(
        candidates: mergeCandidates(
          [...lines, ...sdpLines],
          [
            for (final r in stats)
              if (r.type == 'local-candidate') r.values,
          ],
        ),
        completed: completed,
        elapsed: watch.elapsed,
      );
    } catch (e) {
      return GatherOutcome.failed(_describeError(e), watch.elapsed);
    } finally {
      final p = pc;
      if (p != null) {
        try {
          await p.close();
        } catch (_) {
          // Closing a connection that already failed must not hide the result.
        }
        try {
          await p.dispose();
        } catch (_) {
          // As above.
        }
      }
    }
  }
}

/// flutter_webrtc throws plain strings; keep them short.
String _describeError(Object e) {
  final s = e is String ? e : e.runtimeType.toString();
  return s.length > 160 ? '${s.substring(0, 160)}…' : s;
}
