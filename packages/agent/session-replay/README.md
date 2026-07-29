# Agent Session Replay core

Provider-neutral contracts and lifecycle rules for:

- mutable `Recording` tasks;
- portable `Cassette` artifacts with immutable replay payloads and mutable names;
- isolated `ReplayRun` executions.

The package owns identities, status transitions, and the Recording application
workflow: one active Recording, create/continue start, bind, ordered activity
event sequencing, final settlement, provider-tape completion, expected fixture
capture, artifact publication, metadata commit, cancellation, and recovery. It
also owns Replay Run preparation, start, cancellation, recovery, and terminal
settlement. External runtime adapters use the explicit
prepare/running/complete/fail transitions; an in-process consumer may implement
`ReplayRuntime`.

Products own SQLite schemas, HTTP APIs, state-root paths, fixture contributors,
provider runtime adapters, process/VM isolation, and Electron windows. The
portable Cassette must not contain an absolute path or depend on product
metadata storage.

`ScopeID` is the product-selected capture boundary. Tutti maps it to a
Workspace; TSH may map it to a Room. The shared core does not assign product
meaning to it.

Provider protocol tape mechanics remain in `packages/agent/daemon/runtime`.
Replay uses a separate runtime composition through `ReplayRuntime`; it must not
toggle real provider preparation through a `ProcessSpec` replay flag.

The portable Cassette schema, required-file allowlist, file roles, blob
vocabulary, byte limits, and hash/inventory validation are public contracts of
this package. `cassette-policy.json` is the cross-language policy source used by
the Go validators and the temporary Node runner. Product artifact adapters
perform filesystem or archive I/O and must call these validators.

Cassette schema v3 uses one ordered `activity-events.jsonl`. `intent` events
drive the activity engine, `effect` events verify commands produced by that
engine, and `direct-stimulus` events drive operations with no activity-engine
entrypoint. Effects point to their causing intent by stable event id. Only v3
is accepted; there is no legacy reader, migration, or fallback.

Schema v3 requires `checkpoints.jsonl`. Checkpoint `0` is the stable bootstrap
state after seed import and before the first activity event. Later checkpoints
identify a stable boundary by `afterActivityEventSequence` and carry the
expected queue projection. Provider connection cursors are opaque markers; this
package validates their portable shape but does not define transport progress.

New recordings use their UTC creation timestamp as the Cassette name. Renaming
a completed recording rewrites `cassette.json`, recalculates its SHA-256, and
updates the product metadata store without changing replay payload files.

The current JavaScript replay runner maps shared `ScopeID` to Tutti
`WorkspaceID`. It is a temporary Electron adapter and is not the shared runtime
contract.
