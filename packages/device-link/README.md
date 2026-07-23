# DeviceLink

`packages/device-link` is the provisional, transport-only DeviceLink core being
validated first by Tutti Personal Desktop and Android. It owns ICE candidate
negotiation, QUIC over the selected packet path, and mutual ephemeral
certificate pinning. It does not own Agent, Session, Turn,
Workspace, pairing, account, rendezvous, or Relay product policy.

The initial implementation was upstreamed from TSH's production
`core/devicelink` package. This module is intentionally excluded from stable Go
package tags until the Personal product path proves the authenticated
Android/Desktop lifecycle. TSH cutover is a later consumer migration, not a
condition of this spike.

The currently exported candidate, ICE, TLS, and QUIC types are low-level
provisional primitives used by the integration probe. They do not by themselves
authenticate a product device. The Personal adapter must require the registered
peer identity, pin the expected certificate fingerprint, and own
connect/cancel/lifecycle ordering. Do not expose raw `QUICEndpoint.Listen` or
`Dial` directly through a product or mobile bridge.

## Android vertical slice

The `mobile` package deliberately exposes only:

- the current application-stream protocol epoch;
- a loopback integration probe that negotiates ICE, runs pinned QUIC, and
  echoes one bidirectional stream.

This is the M0 gomobile boundary. Product rendezvous remains in the host adapter;
the next package surface is a lifecycle-safe authenticated link facade, added
only as the Personal Desktop/Android consumer is wired.

Run the portable checks:

```sh
make test
make android-crosscompile
make android-bindings-check
```

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

## Privacy invariants

- Raw candidates, IP addresses, credentials, certificates, and application
  payloads must never enter ordinary logs or metrics.
- Pion logging remains fully discarded because upstream messages may include
  candidate addresses.
- Callers expose only categorical path scope and sanitized failure reasons.
