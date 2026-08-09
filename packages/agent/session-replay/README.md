# Agent Session Replay core

Provider-neutral contracts and lifecycle rules for:

- mutable `Recording` tasks;
- portable `Cassette` artifacts with immutable replay payloads and mutable names;
- fixed-batch replay preparation.

The package owns identities, status transitions, and the Recording application
workflow: one active Recording, create/continue start, bind, ordered activity
event sequencing, final settlement, provider-tape completion, expected state
capture, artifact publication, metadata commit, cancellation, and recovery. It
also owns deletion of inactive Recordings and their candidate or published
Cassette, and validates and resolves immutable Cassettes for replay. Product runtime
adapters own ephemeral process identity, progress, cancellation, and settlement.
Arming process capture freezes the Recording ID as its generation. Every
Provider input unit and commit context carries that generation back to the
Workflow; delayed callbacks from an older Recording are ignored before
candidate artifacts or entity bindings can be mutated. Immediately before
`Arm`, Workflow admits only that prepared generation so a synchronous first
callback is accepted; the admission is cleared when arming or transition fails.

`PrepareReplayBatch` prepares one fixed Cassette batch. It resolves and
validates every immutable artifact without creating mutable execution metadata.
Every returned request carries its Cassette and resolved artifact.

Products own persistence mapping, HTTP APIs, state-root paths, state capture,
provider runtime adapters, process/VM isolation, and Electron windows. The
portable Cassette must not contain an absolute path or depend on product
metadata storage.

`ScopeID` is the product-selected capture boundary. Tutti maps it to a
Workspace; TSH may map it to a Room. The shared core does not assign product
meaning to it. It belongs only to mutable Recording metadata and capture-time
event filtering. Published Cassettes do not serialize it.

Provider process capture and playback mechanics remain in
`packages/agent/daemon/runtime`. The projected tape manifest, version
vocabulary, and portable-data audit are shared Cassette contracts owned here,
so artifact adapters validate a tape without importing a Provider runtime.
Replay uses a separate product runtime composition; it must not toggle real
provider preparation through a `ProcessSpec` replay flag.

The registry currently declares two complete adapters: Codex JSON-RPC and
Claude Code version-7 sidecar NDJSON. A descriptor selects its codec, outbound
matcher, input observer, projection, audit policy, generated identity fields,
and isolated Provider home. Claude launch environment is never persisted or
matched; Replay provides an isolated `CLAUDE_CONFIG_DIR`. Claude
`providerSessionId` is accepted as a generated outbound start identity while
the recorded inbound value remains the Provider-owned semantic identity.
Unregistered providers fail closed.

Recording portability is applied before candidate bytes are persisted.
Product-owned Activity Event storage replaces only the structural
Engine `session/activate` effect CWD and in-tree rail project path with
`${REPLAY_CWD}`. API-origin `session.create` direct stimuli use the same
projection because they remain a valid non-UI caller path, and they retain the
effective create-only `isolation` mode so a recorded Worktree launch creates an
equivalent isolated checkout during replay. Prompt image blocks
in activation `content`, `runtimeContent`, and `initialContent` replace only
their state-owned asset path with inline bytes; persisted Agent attachments use
the content-addressed blob manifest instead. Native generated-image outputs use
the same manifest with the distinct `agent-generated-image` kind and a safe
`generated_images/...` path relative to the isolated Provider home. Provider
frames and semantic state represent that home as `${REPLAY_HOME}`.
Provider-tape recording uses its own versioned protocol projection. Neither
boundary globally rewrites prompt, display, or provider text.

The portable Cassette schema, required-file allowlist, file roles, blob
vocabulary, byte limits, and hash/inventory validation are public contracts of
this package. `cassette-policy.json` is the cross-language policy source used by
the Go validators and the temporary Node runner. `activity-contract.json` is the
matching cross-language interaction contract: for every replayable intent type
it declares the allowed effect command types and whether at least one effect is
required. The renderer recorder/replay registry, the Go record/complete/cassette
validators, and the cassette audit script all consume this one file, so a new
interaction type is a single declared change instead of scattered table edits.
Product artifact adapters perform filesystem or archive I/O and must call these
validators.

Cassette schema v7 uses one ordered `activity-events.jsonl`. `intent` events
drive the activity engine, `effect` events verify commands produced by that
engine, and `direct-stimulus` events replay API/CLI caller paths that did not
traverse the activity engine. Engine-origin HTTP requests carry provenance so
recording does not emit a duplicate direct stimulus. Effects point to their
causing intent by stable event id. Only v7 is accepted; there is no legacy
reader, migration, or fallback.

Schema v7 requires `checkpoint-plan.json`. The manifest also contains the
portable `replayPrerequisites.composerDefaults` required to restore model,
permission mode, reasoning effort, and speed before Replay starts. Checkpoint
plan schema v2 combines a
vector cursor over the Activity lane and every Provider connection, one
bootstrap, Activity-boundary, or Provider-observation trigger, portable Entity
Addresses, and canonical readiness predicates. There is no checkpoint plan v1
reader or migration; existing Cassettes must be recorded again.

An Entity Address is owned by Replay. It is an entity kind plus the immutable
Cassette fact that introduced the entity:

- `recording-root` identifies only the selected root Session;
- `initial-state` uses an absolute path into the immutable
  `initial-state.json`;
- `activity-event` uses the ordered Activity Event sequence;
- `provider-observation` uses the exact Provider connection, chunk, input unit,
  and observation event position.

The registered state codec assigns initial-state paths. Tutti's captured
Session graph has deterministic serialized Session, Turn, Message, and
Interaction order, so a path remains stable for the lifetime of the Cassette.
The path identifies the captured node, not a live canonical ordinal.
`create-session` has no initial state: its root is bound after Recording bind
and later entities originate from Activity Events or Provider observations.
`continue-session` captures settled initial state before arming transport, so
every pre-existing entity can be addressed before new traffic is accepted.
Its recorder seeds Entity Addresses from the Workflow's cached copy of that
exact initial-state capture. Observation entrypoints idempotently add only
missing bindings; Start or Bind completion must not reset the registry because
Provider bindings may already have arrived.

Runtime and canonical Session, Turn, Message, Tool Call, and Interaction IDs
are commit-time bindings to Entity Addresses. They are not serialized into
checkpoint subjects or commit correlations. A replay process may rebuild those
bindings by replaying from the Cassette start. Resuming in place across a
runtime restart requires an implementation to persist the binding table and
Replay cursor atomically; canonical state alone cannot recover a Provider
observation origin.

Activity intent and correlated effects remain one indivisible boundary.
The recorder does not cut a later Activity checkpoint while any earlier intent
with declared effects is unresolved, even when an interleaved intent has
already completed. This keeps every checkpoint plan valid against the complete
ordered Activity lane rather than only the latest report batch.
Provider checkpoints are anchored after decoded Provider Input Units, not raw
transport frames.

Recording keeps `.recording/observation-journal.jsonl` only in the mutable
candidate. It links provider-neutral observations to exact canonical commit
facts through the same Entity Address. Publication rejects an observation
unless its selected commit correlation confirms that exact address, Provider
observation position, and observation fingerprint. Rewriting an existing
observation or correlation identity is a recording conflict, not a
last-write-wins update. Publication excludes the journal from the portable
Cassette.

`ProviderObservationBatch` and `ProviderObservationEvent` are Replay-owned
metadata, not canonical Store commands. Canonical `ReportSession*Input` values
remain observation-free. The local report adapter carries observations beside
the canonical command and pairs that independent context with Host's
post-commit `CommittedDelta` for the same Store transaction. Host itself
remains unaware of Replay metadata. Remote HTTP
reporting strips the local Replay context; an in-process reporter that cannot
preserve it fails closed instead of silently committing an uncorrelated
observation.

`initial-state.json` and `expected-state.json` share one Tutti-owned semantic
shape. `continue-session` requires the initial state; `create-session` forbids
it; every Cassette requires the expected state. `cassette.json.stateFormat`
identifies the product codec (`tutti.agent-session-replay-state.v1`); a
consumer must reject a format it has not registered.

New recordings use their UTC creation timestamp as the Cassette name. Renaming
a completed recording rewrites `cassette.json`, recalculates its SHA-256, and
updates the product metadata store without changing replay payload files.
Deleting an inactive recording removes both its metadata and its candidate or
published Cassette. Active recordings must be canceled before deletion.

The daemon creates a fresh Tutti `WorkspaceID` for every Replay Workspace,
validates and merges all semantic initial states before mutation, restores
canonical Agent history through Host before normal recovery, and verifies the
semantic expected state. Runtime registrations carry the current `UserID`
beside the Workspace target; Host binds it during restore, while the portable
Agent graph remains user-independent. Every batch declares one semantic
profile. Tutti uses the full Agent, Tutti Mode, Workflow, and Issue profile;
consumers that implement only Agent semantics use the Agent profile. A
Cassette that contains state from an unsupported domain fails before restore,
and actual state is checked against the same profile during verification.
Product composition supplies a non-empty target User through runtime registration; the
JavaScript runner injects the replay-created Workspace identity only into
product Activity Event envelopes.
The runner also binds every scenario to one user-project root outside the Tutti
checkout. A caller may supply an absolute
`TUTTI_AGENT_SESSION_REPLAY_PROJECT_ROOT`; otherwise the direct CLI creates a
run-scoped Git project under the operating-system temporary directory and
removes it on exit. `--keep-runtime` retains that project for diagnosis.
Semantic settings readiness compares every recorded composer setting with the
live canonical value but ignores live-only default fields. Final-state
transport verification uses the same composer-settings contract for
`Session.settings`, so a Replay recorded before a provider began materializing
a new default such as `speed` or `codexSaverMode:false` remains valid, while a
missing or changed recorded model, reasoning, permission, plan, or non-default
speed / saver value still fails closed.
