# `@tutti-os/agent-session-replay-runner`

Product-neutral **JS runner kernel** for Agent Session Replay.

## Status

This is a public npm package in Tutti's fixed `@tutti-os/*` release cohort.
External products install the same exact cohort version as their other Tutti
dependencies:

```sh
pnpm add --save-exact @tutti-os/agent-session-replay-runner@<version>
```

```js
import {
  createReplayProductPorts,
  runReplayCassetteBatch
} from "@tutti-os/agent-session-replay-runner";
```

Shared Go Cassette / Replay contracts stay in `packages/agent/session-replay`.
This package owns Node orchestration helpers that must stay isomorphic across
products.

## Bundled contracts

The published tarball carries the canonical cross-language contracts from the
Go core at these public subpaths:

- `@tutti-os/agent-session-replay-runner/cassette-policy.json`
- `@tutti-os/agent-session-replay-runner/activity-contract.json`

Consumers resolve those package subpaths and read the files from the installed
package. They do not locate or read a Tutti source checkout.

## What products must supply

- Desktop / Electron launch + ports (CDP, daemon listener, control path).
- Room / Workspace / shared-agent product surfaces (TSH Room bootstrap, Tutti
  workspace rail, ui-drive product adapters).
- A `ReplayProductPorts` object via `createReplayProductPorts(...)` for path
  scope, transport command dialect, and session-observation mode.

## Vertical slice (current)

Extracted and wired from both runners:

- cassette policy loader (`loadCassettePolicy`) — path-agnostic bytes + shape
- managed replay log prefixes + control router document helper
- serial async queue
- checkpoint plan load / validate (schemaVersion injected by product)
- stimulus idle precondition + duplicate engine-send guard +
  `replayStimulusRequest` (scope segment: `workspaces` / `rooms`)
- recording helpers (`resolveRecordScenarioProject`, binding verify,
  `assertForbiddenPathAbsent`, `seedRecordingUserProject`)
- playback sub-helpers (activity clock, provider cursor math, status/failure
  log routing, submit-idle gate, retryable stimulus statuses, registration
  validation, hydration/session-terminal diagnostics, transport health GET)
- turn freshness / pending-interaction identity helpers + renderer snapshot
  collapse (`activityTurnFromRendererSnapshot`)
- evidence helpers (checkpoint PNG path, clip/label, settle predicates)
- managed Desktop shutdown binder (`bindManagedReplayShutdown`; products inject
  `stopDesktop`)
- wait diagnostics (`configureReplayWaitDiagnostics`, `pollUntilReady`,
  compact/format helpers) — no CDP/Room embedding
- ui-drive scenario shell (`loadUiScenario`, `runUiDriveScenario`, checkpoint
  screenshot/plan helpers) — products inject prepare/launch/surface ports
- **`createReplayPlaybackController` / `createReplayTurnIdentityTracker` /
  `runReplayCassetteBatch` / `replayStimuli` / `waitForSessionIdle`** —
  parameterized by `ReplayProductPorts` (no product-named forks); a cassette
  wave preserves the first failure as the shared abort cause and emits one
  terminal outcome per cassette
- cassette verify / parse / blobs / portable activity payload /
  turn-identity plan (`createCassetteHelpers`, `verifyCassette`,
  `parseActivityEvents`, `materializeReplayWorkspaceBlobs`, …) — products
  bind policy + optional ports (TSH shared-agent prerequisite fork,
  Tutti realpath canonicalization)

## Product ports (dialect injection)

Build ports with `createReplayProductPorts`. Command name helpers:

| Concern                  | Typical Tutti wiring                      | Typical Room/TSH wiring                  |
| ------------------------ | ----------------------------------------- | ---------------------------------------- |
| Timing / cursor commands | `KEBAB_REPLAY_TRANSPORT_COMMANDS`         | `CAMEL_REPLAY_TRANSPORT_COMMANDS`        |
| Timing wire values       | `encodeKebabTimingModeValue`              | `encodeCamelTimingModeValue`             |
| Playback state           | `normalizePlaybackStateRequireTimingMode` | `normalizePlaybackStateDeriveTimingMode` |
| HTTP scope               | `workspaces`                              | `rooms`                                  |
| Session GET              | no `/state`                               | `agentSessionStateSuffix: true`          |
| Observation              | `sessionObservation: "canonical"`         | `"lean-activity"` (+ baselines)          |
| Session watch            | off                                       | `watchSessionsDuringPlayback: true`      |

Products keep a thin wrapper that injects their ports; shared modules must not
hardcode product names.

Still product-local:

- runtime / ui-drive / Room bootstrap / Electron launch / CDP evaluate waits
- TSH shared-agent target rewrite + Room project-binding helpers that sit
  beside the shared cassette kernel ports
