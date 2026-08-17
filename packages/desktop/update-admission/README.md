# @tutti-os/desktop-update-admission

Shared daemon and Electron mechanics for minimum-version admission, forced
desktop upgrades, and version-scoped feature availability.

The package provides:

- a Go daemon core for proactive policy checks, timeout, throttling,
  single-flight, strict response validation, and feature-only persistence
- TypeScript contracts for daemon snapshots and refresh results
- Electron startup admission, forced-updater lease, restricted IPC, preload
  API, shared React UI, and i18n resources
- deterministic development policy/updater scenarios and a loopback mock
  server

Tutti integrates the Go core in `tuttid`; TSH integrates it in `desktopd`.
Electron talks only to its authenticated local daemon and never calls the
public policy endpoint directly.

Hosts may show their business UI before awaiting startup admission. When the
startup result requires an upgrade, the Electron controller keeps the business
window visible and presents the forced-upgrade window as its modal child. A
slow policy check therefore does not create a blank startup, while a resolved
block prevents further interaction with the parent business window.

## Daemon API

The product daemon exposes:

- `GET /v1/desktop-update-admission` — current snapshot, no remote side effect
- `GET /v1/desktop-update-admission/startup` — waits for the proactive initial
  check
- `POST /v1/desktop-update-admission/refresh` — sends a `foreground` or `retry`
  lifecycle trigger

The daemon owns the 3-second startup timeout, 10-second foreground timeout,
30-minute foreground interval, request single-flight, and fail-open result.
Resolved policy checks and invalid responses enter the foreground throttle
window. Failed-open transport and timeout checks remain immediately eligible so
a restored network can recover admission. Electron owns lifecycle signals,
foreground recovery retries, and presentation.

## Development scenarios

Packaged applications ignore all development variables. Invalid enabled
development configuration fails startup.

Client identity and updater fields:

| Variable                                   | Meaning                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `DESKTOP_UPDATE_ADMISSION_DEV`             | Enables an unpackaged development scenario.                                 |
| `DESKTOP_UPDATE_ADMISSION_CURRENT_VERSION` | One current version injected into both daemon admission and updater.        |
| `DESKTOP_UPDATE_ADMISSION_LATEST_VERSION`  | Updater target for available/downloaded outcomes.                           |
| `DESKTOP_UPDATE_ADMISSION_UPDATER`         | `available`, `downloaded`, `unavailable`, `error`, or `targetBelowMinimum`. |
| `DESKTOP_UPDATE_ADMISSION_DOWNLOAD`        | `success` or `error`.                                                       |
| `DESKTOP_UPDATE_ADMISSION_INSTALL`         | `simulated` or `error`; neither invokes the production installer.           |
| `DESKTOP_UPDATE_ADMISSION_TRANSPORT`       | `in-process` (default) or `loopback`.                                       |
| `DESKTOP_UPDATE_ADMISSION_MOCK_SERVER_URL` | Exact `http://127.0.0.1:<port>` origin used by the daemon in loopback mode. |

Daemon-owned in-process policy fields:

| Variable                                          | Meaning                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `DESKTOP_UPDATE_ADMISSION_MINIMUM_VERSION`        | Default minimum for policy steps that require one.                         |
| `DESKTOP_UPDATE_ADMISSION_POLICY`                 | One policy outcome.                                                        |
| `DESKTOP_UPDATE_ADMISSION_POLICY_SEQUENCE`        | Per-request sequence such as `upgradeRequired@1.1.0,minimumNotConfigured`. |
| `DESKTOP_UPDATE_ADMISSION_SCENARIO`               | Named coordinated policy/updater scenario.                                 |
| `DESKTOP_UPDATE_ADMISSION_FEATURE_KEYS`           | Comma-separated feature keys returned by the in-process policy checker.    |
| `DESKTOP_UPDATE_ADMISSION_FOREGROUND_INTERVAL_MS` | Daemon foreground interval override; integer at least 100.                 |

The shortest in-process forced-upgrade scenario is:

```bash
DESKTOP_UPDATE_ADMISSION_DEV=1 \
DESKTOP_UPDATE_ADMISSION_CURRENT_VERSION=1.0.0 \
DESKTOP_UPDATE_ADMISSION_POLICY=upgradeRequired \
DESKTOP_UPDATE_ADMISSION_MINIMUM_VERSION=1.1.0 \
DESKTOP_UPDATE_ADMISSION_LATEST_VERSION=1.2.0 \
DESKTOP_UPDATE_ADMISSION_UPDATER=available
```

Named scenarios:

- `startup-force-success`
- `startup-policy-timeout`
- `startup-updater-unavailable`
- `startup-target-below-minimum`
- `startup-download-error`
- `retry-policy-released`
- `foreground-upgrade-required`

For a complete HTTP test, start the server in a separate process containing all
server-owned policy fields:

```bash
DESKTOP_UPDATE_ADMISSION_DEV=1 \
DESKTOP_UPDATE_ADMISSION_POLICY=upgradeRequired \
DESKTOP_UPDATE_ADMISSION_MINIMUM_VERSION=1.4.0 \
DESKTOP_UPDATE_ADMISSION_FEATURE_KEYS=workspace.example \
DESKTOP_UPDATE_ADMISSION_MOCK_SERVER_PORT=43210 \
pnpm exec desktop-update-admission-mock-server
```

Then start the client without policy fields:

```bash
DESKTOP_UPDATE_ADMISSION_DEV=1 \
DESKTOP_UPDATE_ADMISSION_CURRENT_VERSION=1.0.0 \
DESKTOP_UPDATE_ADMISSION_TRANSPORT=loopback \
DESKTOP_UPDATE_ADMISSION_MOCK_SERVER_URL=http://127.0.0.1:43210
```

Add `DESKTOP_UPDATE_ADMISSION_UPDATER=available` and a
`DESKTOP_UPDATE_ADMISSION_LATEST_VERSION` to the client process to exercise the
forced updater. Policy variables in a loopback client are rejected, preventing
a second policy authority.

## Feature availability

A valid `featureAvailability.keys` envelope replaces the daemon's
exact-identity cache. Missing or invalid feature data retains the prior cache
without changing a valid admission decision. The cache stores only identity,
feature keys, policy revision, and fetch time; it never stores a minimum version
or admission decision. The daemon always serializes `keys` as a JSON array,
including `[]` when no feature keys are available.

Electron keeps only an in-memory projection for trusted renderer IPC:

```ts
const snapshot = await desktopApi.featureAvailability.getSnapshot();
const enabled = await desktopApi.featureAvailability.isSupported(
  "workspace.exampleFeature"
);
```

Renderer code does not read environment variables or access daemon cache files.
