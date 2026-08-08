# `@tutti-os/agent-session-replay-runner`

Product-neutral **JS runner kernel** for Agent Session Replay.

## Status

**Local-link / relative-path only for now.** Do not publish this package.
Products (Tutti, TSH, …) consume it from a Tutti checkout via workspace
relative import or an explicit filesystem path.

Shared Go Cassette / Replay contracts stay in `packages/agent/session-replay`.
This package owns Node orchestration helpers that must stay isomorphic across
products.

## What products must supply

- Cassette policy JSON **directory** resolution (Tutti: fixed
  `packages/agent/session-replay/cassette-policy.json`; TSH:
  `resolve-session-replay-core.mjs` chooses Tutti-core only — fail-closed,
  no vendor JSON). The shared loader only reads/validates **file bytes** once
  a path is known.
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
- Tutti checkout resolver (for TSH local path)
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
  `replayStimuli` / `waitForSessionIdle`** — parameterized by
  `ReplayProductPorts` (no product-named forks)
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

## TSH local path

Prefer resolving Tutti from:

1. `TUTTI_CHECKOUT_ROOT` (or `TUTTI_AGENT_SESSION_REPLAY_TUTTI_ROOT`)
2. `go.work` `use` entries that point at Tutti `packages/agent/...`
3. sibling layout `../../tutti-os/tutti` from the TSH repo root

Then import:

`{tuttiRoot}/packages/agent/session-replay-runner/src/index.mjs`

Cassette **policy JSON** resolution stays in TSH
`resolve-session-replay-core.mjs` (env → go.work → layout → local-link;
**fail-closed**, no vendor). That module then calls this package's
`loadCassettePolicy(path)` for bytes + shape validation (also fail-closed if
the shared runner package itself cannot be resolved).
