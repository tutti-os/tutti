# DeviceLink

`packages/device-link` is the release-enabled, transport-only DeviceLink core
for Tutti Desktop, Android, and the pending TSH cutover. It owns ICE candidate
negotiation, QUIC over the selected packet path, and mutual ephemeral
certificate pinning. It does not own Agent, Session, Turn,
Workspace, pairing, account, rendezvous, or Relay product policy.

The initial implementation was upstreamed from TSH's production
`core/devicelink` package. It is eligible for Tutti's stable package cohort
after the authenticated Android/Desktop lifecycle and reproducible Mobile AAR
consumer build pass. Consumer adapters keep their product policy outside this
module.

The low-level candidate, ICE, TLS, and QUIC types remain provisional primitives.
Product consumers use `authenticated.Participant`, which composes ICE,
peer-fingerprint-pinned TLS/QUIC, stream creation, cancellation, and close
ordering. The `authenticated` subpackage is the one narrow aggregation layer
required by Go's dependency direction; it does not own account, pairing,
rendezvous, or Agent behavior. Product bridges must not expose raw
`QUICEndpoint.Listen` or `Dial`.

## Managed connection lifecycle

The `linkmanager` package owns the reusable lifecycle mechanics that sit above
an authenticated link:

- generation-fenced admission, so a connection completed after invalidation
  cannot re-enter the pool;
- one in-flight establishment per opaque peer key;
- authenticated link reuse, stream reference counting, idle retirement, and
  deterministic collision resolution;
- a delayed two-path race that closes every losing late connection;
- an annealed direct-probe cache with bounded peer state and explicit
  environment invalidation.

The manager does not name or authenticate direct, Relay, room, account, or
rendezvous paths. Product adapters inject opaque keys and metadata, dial
functions, path timing, and policy. In particular, a consumer may let a
preferred-path probe continue after a fallback path wins so it can learn direct
reachability; that detached probe must have its own deadline and close every
connection it does not register. Cache only path reachability failures, never
authorization, control-plane, or product-policy failures. `ClaimProbe` returns
a generation-bound lease; complete it with `RecordFailure`, `RecordSuccess`, or
`Close` so invalidation can fence every late probe result.

The intended integration is:

```text
product attempt + credentials
  -> linkmanager admission snapshot
  -> product-supplied direct/fallback dial policy
  -> authenticated.Participant.Connect
  -> linkmanager.Register
  -> shared OpenStream / incoming stream handler
```

One admission snapshot may register at most one link. Network, credential, or
ownership changes invalidate the relevant peer generation before the old
attempt is cancelled. A product-wide availability gate uses `SetEnabled(false)`
to fence current and future admissions until explicitly re-enabled. Shutdown
first begins manager quiescence, which rejects new admissions and streams, then
waits for accepted stream handlers to finish. Link observations carry a
per-connection sequence; projections must ignore older deliveries and treat
`disconnected` as terminal for that globally comparable connection ID.

Tutti's `mobileremote` Desktop owner is the first production adapter: it keeps
pairing, identity proof, rendezvous, and Agent framing in `tuttid`, while the
shared manager owns the authenticated link and incoming stream lifecycle.

## Trickle ICE and protocol migration

Consumers that exchange candidates incrementally call
`StartLocalDescription`, publish candidate additions from
`LocalCandidateChanges`, and publish a final
`LocalDescriptionSnapshot` when `LocalGatheringComplete` closes. Remote
candidates may arrive before or after `Connect` through
`AddRemoteCandidates`. A `Participant` represents one connection attempt and
must not be reused after completion or cancellation.

`ALPN` remains the canonical protocol name. During a rolling migration, a
consumer may add a bounded list of `CompatibleProtocols`; the canonical value
is always offered first. After connection, `Link.NegotiatedProtocol` lets the
product adapter select only the matching application framing. Compatibility
entries are a temporary cutover tool, not a promise that old wire protocols
share semantics.

`authenticated.ErrorPhase` distinguishes connectivity failures from
authenticated transport failures so consumers can keep network probe caches
free of certificate, ALPN, QUIC-handshake, and caller-cancellation failures.
`authenticated.FailurePhase` additionally reports the layer interrupted by a
caller cancellation. It is reserved for callers that own a dedicated probe
deadline and verify that exact context cause before recording a verdict.

## Mobile vertical slice

The `mobile` package deliberately exposes only a gomobile-safe authenticated
link facade:

- the current application-stream protocol epoch;
- creation from server-authoritative STUN endpoints;
- a JSON local description containing the ephemeral fingerprint and ICE
  material;
- caller/owner connection using the peer description;
- authenticated bidirectional stream open/accept/read/write/deadline/close;
- the loopback integration probe used by the Android build gate.

The mobile read boundary intentionally fills a caller-owned byte buffer and
returns only a scalar count. Do not replace it with a Go `[]byte` plus `error`
return while the pinned Go/cgo toolchain is affected by packed-result alignment
failures: gomobile cannot preserve final bytes returned together with `io.EOF`,
and the generated pointer-bearing result may abort the Android process before
Java receives it.

Account identity signatures, DeviceLink attempts, pairing scope, Agent HTTP
framing, and foreground/background policy remain in the Android and tuttid
product adapters. The mobile facade never accepts account cookies or Agent
DTOs.

Run the portable checks:

```sh
make test
make android-crosscompile
make android-bindings-check
```

### Android

Build the AAR with JDK 17, minSdk 26, compileSdk 36, targetSdk 35, Android Build
Tools 36.0.0, and the pinned NDK r27d (`27.3.13750724`). Set `JAVA_HOME` and
`ANDROID_HOME`:

```sh
make android-aar
```

The AAR is written to `dist/tutti-device-link.aar` by default. Build artifacts
under `dist/` are not source and must not be committed. The build verifies the
Java binding plus `armeabi-v7a`, `arm64-v8a`, `x86`, and `x86_64` native
libraries before succeeding.

Build the minimal arm64 Android probe APK without adding a Gradle project:

```sh
make android-probe-apk
```

The probe Activity invokes the same exported gomobile API and writes either
`PASS` or `FAIL` under the `TuttiDeviceLinkProbe` logcat tag. It is a transport
integration fixture, not a product App shell. The generated APK and its stable
local debug keystore remain under ignored `dist/` so repeated local installs
keep the same signature.

The Android link step passes `-checklinkname=0` because Pion's Android network
enumeration dependency `github.com/wlynxg/anet` uses the Go standard library's
zone cache through `go:linkname`. Go 1.23 and newer reject that reference unless
the documented linker compatibility flag is explicit. Keep the flag scoped to
the gomobile build; ordinary host tests and builds do not use it.

### iOS

The Mobile app host binds the same DeviceLink facade and Agent-owned live
Subscriber into one XCFramework containing iOS device and iOS Simulator
slices. Full Xcode and the iOS SDK are required:

```sh
pnpm --filter @tutti-os/mobile check:ios-bindings
pnpm --filter @tutti-os/mobile ios:framework
```

The generated
`apps/mobile/ios/Frameworks/TuttiMobileGo.xcframework` is ignored build output.
The iOS product adapter owns HTTP/application framing, lifecycle grace, account
identity, pairing, and Agent event emission exactly as the Android adapter does;
the Go `mobile` package remains transport-only.

## Privacy invariants

- Raw candidates, IP addresses, credentials, certificates, and application
  payloads must never enter ordinary logs or metrics.
- Pion logging remains fully discarded because upstream messages may include
  candidate addresses.
- Callers expose only categorical path scope and sanitized failure reasons.
