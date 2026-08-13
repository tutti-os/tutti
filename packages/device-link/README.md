# DeviceLink

`packages/device-link` is the release-enabled, transport-only DeviceLink core
for Tutti Desktop, Android, iOS, and TSH. It owns ICE candidate negotiation,
incremental candidate-exchange coordination, QUIC over the selected packet
path, mutual ephemeral certificate pinning, and product-neutral Relay
byte-stream mechanics. It does not own Agent, Session, Turn, Workspace,
pairing, account, rendezvous, Relay authorization, or Relay product policy.

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

Every direct QUIC session uses a 5-second keepalive period and a 15-second
maximum idle timeout. These defaults apply uniformly to Desktop, mobile, and
TSH consumers so a peer whose network path disappears is retired promptly
without product-specific liveness timers.

## Managed connection lifecycle

The `linkmanager` package owns the reusable lifecycle mechanics that sit above
an authenticated link:

- generation-fenced admission, so a connection completed after invalidation
  cannot re-enter the pool;
- one in-flight establishment per opaque peer key;
- authenticated link reuse, stream reference counting, idle retirement, and
  deterministic collision resolution;
- a delayed two-path race that verifies each candidate with a transport-owned
  stream probe before selecting it and closes every losing late connection;
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

The intended direct-path integration is:

```text
server-authoritative STUN configuration
  -> candidateexchange.Start (credentials immediately; candidates may be empty)
  -> product publishes or joins its authenticated rendezvous attempt
  -> linkmanager admission snapshot
  -> candidateexchange.PublishLocal + FeedRemote run beside Participant.Connect
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

## Relay byte-stream transport

The `relaytransport` package owns the reusable mechanics for Relay-backed byte
streams. `Dial` turns binary WebSocket messages into a `net.Conn` for one
caller stream. `OwnerHost` maintains one WebSocket/yamux owner tunnel while at
least one product driver holds a reference, accepts remote streams only after
the product readiness barrier succeeds, and reconnects with bounded full-jitter
backoff plus `Retry-After`.

`OwnerLifecycle.Activate` returns an `OwnerActivation`: its `Readiness`
context is a continuous product health condition for the complete connection
generation. Cancelling it closes the generation, joins its stream handlers,
reports its cancellation cause through `SessionEnded`, and starts a new
generation while demand remains.

The owner path has an explicit ownership split:

```text
product demand (zero -> one)
  -> product OwnerLifecycle.Prepare
  -> relaytransport WebSocket dial + liveness
  -> product OwnerLifecycle.Activate continuous readiness
  -> relaytransport yamux stream acceptance
  -> product StreamHandler
  -> final product demand release
  -> stop tunnel and handlers
  -> exact OwnerLifecycle.Release
```

The lifecycle factory creates isolated product state for every zero-to-one
demand run. A final release may overlap a new acquire, but the old release can
only clean up its own lifecycle. WebSocket ping/pong owns tunnel liveness, so
yamux keepalive is disabled. Internal yamux logging is discarded; adapters map
sanitized, typed `OwnerEvent` values into product logs or metrics. Retry events
separate the backoff cap, chosen jitter, server `Retry-After`, and total delay;
liveness events expose only ping/pong counts and timestamps, never payloads.

`networkchange.Monitor` is the process-level transport signal for reconnect
self-healing. It starts at generation `1`, publishes only later generations,
and hashes interface status, addresses, and—where the platform exposes a
reliable native table—default-route identity. Darwin uses a no-cgo route socket
as a trigger with 500ms debounce and a 30s safety sample; its default-route
summary comes from the native routing information base. Linux samples
`/proc/net/route` and `/proc/net/ipv6_route`; Windows samples IP Helper's
`GetIpForwardTable2`. Android 10 and newer deny ordinary applications access
to `/proc/net`, so Android retains only the interface/address summary until a
native `ConnectivityManager` source is provided. Android, iOS, and other
unsupported platforms explicitly do not claim default-route coverage. Windows
and mobile fallback to 2s polling, while Darwin watcher failure also falls back
to 2s polling.

`Monitor.Status()` is a read-only diagnostic snapshot with `stopped`,
`starting`, `watching`, or `polling` mode plus a sanitized polling reason and
bounded sample-health counters.
Consumers should derive watcher health from `ModeWatching`; they must not
invent a separate `watcherHealthy` field. An
`OwnerHost.AdvanceNetworkGeneration` call cancels only the current attempt or
retry wait, closes the old Relay transport, and reuses the same owner lifecycle
for an immediate retry. It does not clear credentials; `SessionEnded` remains
the product-owned credential policy boundary.

Default-route changes are included only after successful parsing of the
platform snapshot. A route-table read or parse failure fails that sample and
does not advance generation, preserving the monitor's fail-closed rule rather
than silently pretending that default-route coverage is complete.

Relay endpoints, headers, query values, credentials, leases, registrations,
room or pairing state, application protocols, and token invalidation remain in
consumer adapters. In particular, a shared transport error is evidence for the
adapter to update its product state, not permission for this package to
interpret HTTP status codes as product policy. `DialError` makes a bounded
handshake response body available for adapter-owned wire-reason parsing, but
does not include that body in its error string; adapters must not persist the
raw value in ordinary logs or metrics.

`OwnerHost.Wake` is a product-neutral demand-preserving interrupt for the
current generation or retry wait. It coalesces repeated requests, does not
release or acquire references, and does not reset reconnect backoff.

### Stream readiness probe

`ProbeStream` and `ServeStreamProbe` form the product-neutral readiness barrier
for a newly opened authenticated stream. The caller writes a fresh nonce and
selects the path only after the peer echoes that nonce. This matters for stale
QUIC sessions: `OpenStreamSync` can succeed locally after a network transition
even though the peer is no longer reachable. The probe is deliberately
separate from Agent framing and leaves the verified stream open for the
consumer's application protocol. Owners must run `ServeStreamProbe` before
dispatching the stream to their handler.

## Trickle ICE and protocol migration

The `candidateexchange` package is the consumer-facing Trickle ICE coordinator.
`Start` returns publishable ICE credentials immediately, even when the initial
candidate list is empty. `NextLocalPublication` and
`AcknowledgeLocalPublication` expose the same acknowledgement-bound state
machine used by `PublishLocal`: candidate notifications are coalesced, a failed
publication is reissued with the same ID and exact snapshot after the shared
retry interval, and the stream stops only after the final local snapshot has
been observed. `NotifyRemoteChange` and `WaitRemoteRefresh` expose the same
push-plus-poll scheduler used by `FeedRemote`; fetched candidates are then
deduplicated into an in-progress `Connect`. Fetch failures terminate unless the
consumer explicitly classifies them as retryable. The default authoritative
poll fallback is 500ms.

Callback-free consumers use `ActionPump`. It owns the local-publication and
remote-refresh workers, retry scheduling, stop ordering, and a
one-outstanding-action-per-worker protocol. A consumer may drain the local and
remote actions concurrently, so a slow authoritative read cannot hold up local
candidate publication. It performs only product-authenticated rendezvous I/O
for `publish_local` and `refresh_remote`, then resolves each action with success
plus retryability. A local publication is acknowledged only after that
resolution, so a caller can first verify that the server's returned
authoritative snapshot contains the exact published candidates.

Consumers inject only their rendezvous reads/writes and retry classification.
The shared package does not create attempts, sign requests, interpret room or
pairing state, or authorize peers. Lower-level callers may still use
`StartLocalDescription`, `LocalCandidateChanges`,
`LocalDescriptionSnapshot`, `LocalGatheringComplete`, and
`AddRemoteCandidates` directly, but product adapters should prefer
`candidateexchange` so debounce, exact-snapshot retry, completion, and
push-plus-poll behavior do not drift. A `Participant` represents one connection
attempt and must not be reused after completion or cancellation.

Current integration status:

| Consumer                            | Candidate-exchange path                                                                                                                | Status                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Tutti Desktop owner                 | Go `candidateexchange.Start`, `PublishLocal`, and `FeedRemote` around the signed paired-device attempt adapter                         | Integrated                                                             |
| Tutti Android/iOS caller            | Go `ActionPump` workers exposed as next/resolve actions; TypeScript executes and validates signed authoritative attempt I/O only       | Integrated                                                             |
| TSH Desktop                         | Uses the same low-level `authenticated.Participant` Trickle primitives, but its adapter-local publish/feed loops have not yet cut over | Migrate after the next stable DeviceLink release; no workspace replace |
| tsh-server paired-device rendezvous | Protocol v2 accepts valid credentials with zero candidates and repeated authoritative participant snapshots                            | Compatible; no server schema change required                           |

For the TSH cutover, adapter-local `publishTrickledCandidates` maps to
`Exchange.PublishLocal`, `feedRemoteCandidates` maps to
`Exchange.FeedRemote`, and the local 200ms debounce maps to the shared default.
TSH retains its room lease checks, attempt TTL context, candidate-summary
diagnostics, configurable poll cadence, and product fallback policy. This keeps
the migration behavioral: it deletes duplicated connection mechanics without
moving room authority or Relay policy into this package.

### Network path policy

The default empty `NetworkPolicy` is `system`. It keeps the operating system's
network view, but applies a shared LAN-first candidate preference: private
IPv4/ULA host candidates receive the normal host priority, global-unicast host
candidates receive a lower host priority, and server-reflexive candidates
remain available as the public-network fallback.

`system` includes active TUN interfaces for fallback, while `direct` additionally
binds sockets to physical interfaces where the platform supports it. Product
consumers should use `system` unless they expose an explicit advanced routing
setting.

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
- non-blocking local-description start plus a callback-free Go action pump for
  acknowledgement-bound publication and authoritative remote refresh;
- JSON next/resolve actions, push notification, incremental remote-candidate
  insertion, and Go-owned candidate-worker cancellation while `Connect` runs;
- caller/owner connection using the peer description;
- authenticated bidirectional stream open/accept/read/write/deadline/close;
- `OpenStreamWithRelay`, which races a direct stream dial and an authorized
  Relay stream dial concurrently, requires the shared stream probe on both
  candidates, and closes the losing stream. The returned byte stream has
  crossed the transport readiness barrier; callers still own their application
  protocol handshake and request semantics;
- the loopback integration probe used by the Android build gate.

The mobile read boundary intentionally fills a caller-owned byte buffer and
returns only a scalar count. Do not replace it with a Go `[]byte` plus `error`
return while the pinned Go/cgo toolchain is affected by packed-result alignment
failures: gomobile cannot preserve final bytes returned together with `io.EOF`,
and the generated pointer-bearing result may abort the Android process before
Java receives it.

`mobile.DialRelay` is the corresponding gomobile-safe byte-stream entry point for
an already-authorized Relay caller. It accepts the endpoint, query values,
headers, and WebSocket subprotocol as JSON `map[string][]string` values, then
runs the shared stream probe before returning the same `Stream` abstraction used
by the Agent framing adapter. A successful WebSocket upgrade alone is not proof
that the owner tunnel or Agent handler accepted the stream; the probe confirms
only that the transport owner is responsive. The mobile package does not issue credentials,
select a target, or decide when to fall back; those policies remain in the
Mobile pairing service and native bridge. `Link.OpenStreamWithRelay` uses the
same stream abstraction to start direct and Relay together; a direct stream may
wait for an in-progress `Link.Connect`, while Relay starts immediately. Relay
streams must be closed by the caller after each HTTP request or when the live
subscription ends.

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
