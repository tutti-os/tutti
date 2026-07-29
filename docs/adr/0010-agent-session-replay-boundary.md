# Agent Session Replay has a shared application core

**Accepted**

Tutti and TSH both record and replay Agent Sessions, so provider-neutral
Recording, Cassette, and Replay Run contracts live in
`packages/agent/session-replay`. The package owns their identities, status
transitions, Recording workflow, Replay Run workflow, Cassette schema,
allowlist, size policy, and integrity validation. Its ports cover metadata,
SessionGraph fixtures, artifact publication, provider-tape recording, and
optional in-process replay runtime composition. Products that launch replay
through an external UI process use the same prepare/running/complete/fail
workflow transitions.

Recording is a mutable task that produces zero or one Cassette. Its replay
payload is immutable, while its user-visible name may change.
Cancelling a Recording discards its candidate artifact and metadata, so
canceled Recordings do not appear in recording history.
Cassette is a portable artifact whose local database row is only a rebuildable
catalog entry. Each Replay Run belongs to one Cassette and is stored separately
because one Cassette may be replayed many times.

The name lives in `cassette.json`, defaults to the Recording creation timestamp,
and may be edited from Desktop. A rename rewrites that manifest, recalculates
its SHA-256, and commits the new Recording and Cassette metadata together.

Each product supplies adapters. Tutti keeps SQLite migrations, fixture
contributors, HTTP, local state-root resolution, daemon composition, and
Electron launch in `services/tuttid` and `apps/desktop`. TSH supplies equivalent
adapters without importing Tutti product code. Tutti's filesystem artifact
adapter lives under `services/tuttid/data/agentsessionreplay`; its service layer
only maps Workspace DTOs and applies local target policy. Runtime metadata uses a durable
product store locally and may use an isolated temporary store in CI. Cassette
content never depends on either database.

Final replay verification compares durable Session behavior and settings. It
does not compare provider-discovered runtime context, capability catalogs, or
usage counters because those values describe the current runtime environment,
not the recorded scenario. Replay-generated Session and Turn identifiers are
normalized through stable provider identity and per-Session Turn order before
durable rows are compared; ambiguous identity matches remain validation
failures.

Recording candidates and published Cassettes also have separate physical
locations. A completed candidate is published under its own Cassette id only
after an allowlist audit. The portable artifact may contain scenario metadata,
ordered activity events, an optional seed SessionGraph, the expected SessionGraph,
provider protocol tape, and blobs explicitly referenced by those fixtures. It
must reject logs, screenshots, SQLite databases, workspace copies, credentials,
and every other unrecognized file. Provider frames are limited to 8 MiB per
decoded payload and 256 MiB on disk; the complete Cassette is limited to 384
MiB. Manifests record per-file and per-provider-frame size evidence so anomalous
growth is attributable instead of hidden by compression.

Provider protocol tape mechanics remain in `packages/agent/daemon/runtime`.
Tutti Desktop asks the daemon to prepare and persist a Replay Run, then launches
the separate Electron adapter with that daemon-owned Run id. The isolated
daemon uses a fail-closed replay transport and does not install the real runtime
preparer, provider command resolver, extension runtime resolver, or provider
availability probe. Replay does not add a switch to `ProcessSpec`.

The JavaScript replay runner remains a temporary Tutti Electron adapter. It
reads the shared `cassette-policy.json`; it does not define a second Cassette
schema or size policy. Activity-engine intents are dispatched into the isolated
renderer engine, their correlated command effects are verified there, and only
operations without an engine entrypoint use direct daemon stimuli. A normal
direct `session.send` waits for canonical Session idle; steer does not.

Desktop owns the recording toolbar, recording list, replay-window controls,
feature gating, and product copy. Completed recording rows launch Replay
directly. The primary workspace window does not own a selected Recording or
render Replay pause/checkpoint controls. AgentGUI exposes only generic host
render slots and contains no recording/replay contracts, state, provider
policy, controls, or copy.

Replay playback is monotonic inside one Replay Run. Pause and resume keep the
same Run. Moving to the next stable checkpoint temporarily fast-forwards
recorded timing, but still consumes every provider frame and performs every
outbound assertion. Moving backward, restarting, or selecting another Cassette
replaces the active Run; it must not rewind an already-mutated daemon, database,
or provider cursor in place.

Provider frames and activity events share the daemon playback state. Activity
events advance by their recorded `occurredAtUnixMs` offset, freeze while Replay
is paused, scale with Replay speed, and skip recorded waits during checkpoint
fast-forward. Effect verification starts only when its recorded time is
reached; a long-running Turn must not be shortened into a runner timeout.

Cassette schema v3 is the only accepted schema. It stores one global ordered
stream in `activity-events.jsonl`; no v2 reader, migration, or fallback exists.
Queue and steer are recorded as activity-engine intents plus correlated command
effects, so replay rebuilds the same transient engine state instead of reducing
those actions to HTTP calls.

Schema v3 records stable playback boundaries in `checkpoints.jsonl`. Checkpoint
zero is the bootstrap state before activity events. Later checkpoints identify
the last fully applied activity-event sequence, carry the expected queue
projection, and may carry opaque per-connection provider cursors. The shared
core validates the portable structure. The product replay adapter decides when
the isolated runtime has actually reached that boundary and advances the
durable Replay Run checkpoint monotonically.
