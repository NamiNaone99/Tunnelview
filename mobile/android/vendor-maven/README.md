# Vendored Maven artifacts

`flutter_webrtc` 1.6.3 depends on
`com.github.davidliu:audioswitch:039a35aefab7747c557242fa216c9ea11743b604`, which only exists on
JitPack (built on demand from a GitHub commit, unsigned). CI never resolves anything from
jitpack.io (see `android/build.gradle.kts`); this local repository serves the artifact instead,
and `gradle/verification-metadata.xml` pins its SHA-256.

| File | SHA-256 |
|---|---|
| `audioswitch-039a35aefab7747c557242fa216c9ea11743b604.aar` | `c8240221daa9a96d4ea01a4dc6f6f6b10b4903d2a71f9b57f838bdfeb6c3fcbc` |
| `audioswitch-039a35aefab7747c557242fa216c9ea11743b604.pom` | `b01278803fe0a007591a44143e1919a406c0c529794b13aa30e86a87532095fd` |

Fetched from `https://jitpack.io/com/github/davidliu/audioswitch/039a35aefab7747c557242fa216c9ea11743b604/`
on 2026-11-07. Upstream: https://github.com/davidliu/audioswitch (fork of twilio/audioswitch),
Apache License 2.0. The AAR's manifest requests `BLUETOOTH` (max SDK 30) and
`MODIFY_AUDIO_SETTINGS`; the app manifest removes both.

To update: download the new `.aar` and `.pom` into a matching directory, update this table, and
regenerate the verification metadata with the `mobile-bootstrap` workflow.
