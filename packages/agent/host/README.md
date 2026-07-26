# Agent Host contracts

`packages/agent/host` is the provider-neutral application boundary for
canonical agent session and turn lifecycle orchestration. The package now owns
the create, resume, send, durable submit-claim, canonical title, session read,
settings, pin, delete, cancel, session fork,
interactive response, plan decision, durable runtime-operation, and complete
goal-control/reconcile application core. `tuttid` routes those commands through
`Host`; transport and HTTP shapes remain unchanged.

Tutti Mode turn snapshots use `PreferenceVersion` to separate the current
`Effect`/`Speed` pair from the deprecated single-axis
`OrchestrationIntensity`. Current writers set
`TuttiModePreferenceVersionEffectSpeed` and populate the legacy alias with the
effect value. Runtime readers treat version zero as a legacy snapshot, mapping
its intensity to effect and using balanced speed (`50`). This is an upgrade
read path, not support for connecting a new client to an older daemon.

The module owns:

- lifecycle command and runtime observation types;
- narrow canonical store, runtime, preparation, attachment, clock, scheduler,
  and post-commit observer ports;
- the runtime-operation coordinator, worker, typed interactive dispositions,
  startup recovery order, and adapter-specific worktree GC scheduling;
- the direct and typed goal-control saga, revision actor, durable operation and
  reconcile-inbox workers, exact Goal-generation fences, provider evidence
  repair, and goal recovery policy;
- the provider-neutral Session Fork saga, source mutation fence, exact
  capability resolution, durable lineage, and startup recovery policy;
- the durable edit-retry saga, effective-history revision fence, authoritative
  provider-history reconciliation, and explicit replacement recovery policy;
- typed conformance scenarios under `conformance`.

`CreateSession` has two explicit modes: an empty session, or one command with
`InitialContent`. The latter prepares its submit claim before provider delivery
and rolls back the provisional canonical shell when delivery fails. Resume
eligibility is decided by `ResolveResumePolicy`: root sessions resume normally,
explicit imports may recreate a missing provider session, and child,
tombstoned, or non-resumable imports are rejected. Canonical titles may be
empty; only an explicit title or the first eligible prompt establishes one.
`CreateSessionInput.RailPlacement` optionally carries the caller-selected,
versioned canonical rail identity. Host validates it before provider startup
and persists its opaque `SectionKey` exactly on first creation. An idempotent
retry that supplies a placement must use the same placement; project deletion
or another adapter-side view change never reassigns an existing session to
`conversations`.
Cancellation exposes durable intent acceptance, provider confirmation, and
canonical settlement as separate facts. `GoalControl`, `GetGoalState`, and
`ReconcileGoal` are provider-neutral Host APIs; typed `/goal` commands enter the
same durable saga without opening a turn. A caller-stable `ClientSubmitID`
makes one goal mutation idempotent across retries and Host restarts (and takes
precedence over the legacy metadata field). `GetGoalState` is a pure canonical
read: only `GoalControl`, `ReconcileGoal`, and recovery workers may create or
change the durable goal projection. `Recover` first requeues and recovers
durable runtime operations, then goal operations and the goal reconcile inbox,
then settles unrecoverable stale turns, and finally invokes the adapter's
worktree-isolation sweep. Configuring a goal store
without its runtime or inbox consumer fails recovery with
`ErrGoalConsumerUnavailable` instead of silently accumulating work.

`FenceGoalGeneration` is the durable boundary for revoking work created by one
exact Goal operation. The caller supplies the original operation identity; Host
persists `(operationId, revision, repairEpoch)` in
`workspace_agent_goal_generation_fences` before attempting any provider call.
`IntentAccepted` means Host owns later retries even when the provider is
offline. Accepting or recovering a fence never resumes an offline provider
Session. Host immediately prepares a revision-conditional local clear so the
revoked target cannot replay; provider delivery waits until the Session is
already live or a user action resumes it. A fence is an admission rule, not
session deletion: completed rows remain durable and are restored to the
runtime after restart or resume so a delayed provider generation cannot become
canonical. The runtime Controller retains the exact fence set independently
of an adapter connection and installs it into every replacement connection
before dispatching a user operation; failed installation closes the
unprotected connection. Host cancels a live Turn only when its
immutable Goal provenance exactly matches the fenced identity; that internal
cancel is require-live and never reconnects an offline provider. The fence
remains unsettled until the Turn reaches an authoritative terminal state. It
never retargets
`session.activeTurnId`, clears a newer Goal revision, or infers ownership from
the current session state. `FindGoalControlOperationByClientSubmitID`
lets an adapter recover the original operation after an
accept-before-response crash without duplicating Host's operation-ID
algorithm. Startup and steady-state workers process fences before ordinary
Goal operations; otherwise a prepared revoked Goal could be replayed during
recovery before its fence reached the runtime.

A completed latest user Turn may be edited and retried only through
`GetEditRetryAvailability`, `EditRetry`, and `RecoverEditRetry`. Host owns the
complete lifecycle: it snapshots the lossless submitted content, serializes the
Session mutation, checkpoints before provider rollback, retracts exactly one
effective Turn only after authoritative confirmation, then submits a stable
replacement Turn. The replacement keeps attachments, mentions, capability
references, and the Tutti mode snapshot while replacing only the first text
block. Retraction changes model-visible history and canonical projections; it
does not compensate filesystem changes produced by the original Turn.

`operationId`, replacement `turnId`, and `clientSubmitId` remain stable across
retries and process restarts. A direct provider acceptance receipt completes
the operation without polling. If a rollback or replacement response is lost,
Host reads the provider's effective history and fails closed on identity
divergence. An uncertain rollback is never dispatched twice. An uncertain
replacement is never resent until an explicit `retry_replacement` command has
proved its absence from authoritative history; a read-only `reconcile` command
cannot dispatch provider work. While history is fenced in
`rollback_pending`, `resend_pending`, or `recovery_required`, ordinary sends
are rejected rather than appended to an uncertain model context.

A provider-accepted Goal operation has crossed the delivery boundary. The
steady-state worker waits for applied evidence and never resubmits that
mutation; the accepted convergence deadline terminates a lost-evidence case.
Startup recovery may replay an accepted mutation only according to the
adapter's recovery policy. In particular, a query-incapable adapter may replay
an idempotent clear once to resolve a crash window, while unsafe set replay
remains rejected.

`GetSession` reads canonical session truth plus an optional live runtime
observation without starting a provider. `GetTurn`, `ListSessionTurns`,
`ListSessionMessages`, `FindTurnByClientSubmitID`, and
`GetSessionInteractionSnapshot` expose canonical queries without leaking an
adapter's concrete store. Turn pages are newest-first, bounded metadata reads
with stable cursors. Message pages use per-session version cursors and may be
narrowed to one turn. The interaction
snapshot contains every interaction on the latest turn and derives its pending
subset from that same read; older-turn pending rows can never become current
actionable state. `CreateSessionInput.ClientSubmitID` and
`SendInput.ClientSubmitID` are the typed idempotency identities and override
the legacy metadata value when both are present. The matching durable submit
claim's immutable `CreatedAtUnixMS` is the canonical occurrence of that user
message. Host passes it to both runtime execution and durable submit-provenance
reporting; adapters must derive the same message sequence from that occurrence
regardless of which report reaches storage first. `ClientSubmitID` identifies
the submission but is not itself an ordering value.
Runtime adapters preserve explicit downstream failures as `ProviderError` so
Host consumers can distinguish provider-owned rejection from preparation,
canonical-store, timeout, and other local failures with `errors.As`. The
provider code and diagnostic text remain local observations rather than a
stable cross-service taxonomy; coordination layers persist only their own
coarse product reason when needed. `NewProviderError` deliberately leaves
cancellation and deadline failures unclassified because their delivery result
is unknown and must remain recoverable.
`UpdateSettings` serializes with runtime resume:
historical sessions persist settings only, while live sessions update the
runtime first and persist the resulting settings only after the runtime
accepts the change. Provider-specific model, reasoning, and speed normalization
stays behind `SettingsPolicy`. A model change invalidates the previous model's
context-window usage in both the live observation and canonical metadata;
provider quotas remain valid and are preserved. `UpdatePin` mutates canonical
metadata only.
`DeleteSession` and `DeleteSessions` enter one deletion coordinator. The
canonical store first resolves the complete root/child closure; Host acquires
the shared session-mutation actor and session locks in stable order, closes
every live runtime in that closure, and commits only if the store resolves the
same closure inside the write transaction. An optional provider-neutral
`SessionDeletionGuard` receives that exact Host-owned closure before any
runtime close or canonical delete. A rejected admission returns with no
canonical lifecycle side effects. Every admitted attempt is reported as
completed or failed; reporting is observational and cannot change the command
result. A changed child tree is reported as a failed attempt, replanned, and
re-admitted with its new exact closure before Host closes any newly discovered
runtime or writes a tombstone. A requested runtime that is live before its
first canonical report is still closed and cleaned up by the same coordinator;
the empty canonical plan simply skips the tombstone transaction, so deleting an
already absent session is a successful no-op and batch responses retain empty
arrays for their ID fields. Goal provider mutations use the same outer
session-mutation actor, so clear/set/reconcile work
cannot race session deletion. Post-commit runtime cleanup failures are reported
separately from the committed delete result. Authorization, shared bindings,
transport DTOs,
and local view cleanup remain adapter responsibilities.

`PurgeDeletedSessions` is the separate permanent-removal command for bounded
batches of canonical tombstones. Host owns the command boundary and delegates
the atomic hard delete to its narrow `SessionPurgeStore`; retention timing,
daemon-idle scheduling, HTTP exposure, and optional compaction stay in the host
adapter. The current retention adapter deliberately performs no filesystem
deletion. Each candidate is fenced by the exact persisted
`deleted_at` value, so a concurrently restored or recreated row is preserved.
Leaf-first selection retains an ancestor while any child or nested descendant
row remains without starving deep trees, so a restored descendant can never be
orphaned by maintenance. Purge results expose only content-free session
descriptors and aggregate message/payload counts. The shared conformance
scenario verifies live and too-new preservation, exact-cutoff removal, and
idempotent replay through Host.

`ForkSession` creates a new root Session from an inclusive canonical
`ThroughTurnID`. Host resolves that Turn to its durable provider root Turn id,
pins the exact provider Session and runtime driver descriptor, and reserves the
caller-supplied target Session id before invoking provider code. Provider
support is advertised at Session scope only when the exact adapter/version
attests native `throughTurn` support and the product context policy can safely
transfer Host-owned runtime facts. A live adapter supplies its initialized
version directly; a historical Codex Session uses one cached, short-lived
initialize probe and does not create a canonical Turn or register a live
Session. Historical capability and dispatch probes pass through the same
`RuntimePreparation` contract as resume so cwd, env, provider target, settings,
and runtime context match the runtime that would be resumed. One Fork attempt
freezes that prepared observation across driver attestation and provider
dispatch; an existing live observation bypasses preparation. Consumers hide
settled Turn actions when that capability is absent.
Boundary validity remains a separate transactional proof, so an unavailable
latest Turn does not suppress an earlier valid boundary.
Every fail-closed boundary rejection retains a stable, content-free reason
through Host. HTTP adapters may project it as structured diagnostic metadata
while preserving their existing coarse conflict reason; transcript payloads
and attachment contents never enter that reason.

Fork uses a durable `prepared -> dispatching -> provider_accepted -> committed`
saga. `RequestID` is the replay key. A source fence serializes the snapshot
with report, Goal/runtime mutation, deletion, and competing Fork writes.
An accepted provider child is not checkpointed as `provider_accepted` until a
provider-state binder has made the exact child state independently discoverable
from the target Session runtime namespace. Binding failure is delivery-unknown,
because the provider mutation may already exist.
Provider dispatch starts only after its marker commits. Provider acceptance is
checkpointed with a detached bounded context and recovery retries only the
atomic canonical prefix clone; a crash with an indeterminate provider result
becomes `unknown`. Drivers are never blindly redispatched. A driver may
explicitly attest deterministic target identity: Host then derives the provider
child UUID from the durable operation id, requires the returned identity to
match, and may reconcile `dispatching` or `unknown` by repeating the same
request. The provider adapter must first verify an existing child at that UUID
and create it only when absent. Drivers without that attestation keep the
fail-closed `unknown` behavior. A later request for the same source boundary
recovers the durable operation. A committed operation also retains the boundary
barrier until the Engine explicitly acknowledges that its authoritative child
Session has entered canonical UI state. Thus, losing a committed HTTP response
and restarting with fresh request/target ids returns the original operation and
child instead of creating another provider identity. The ACK is committed-only
and idempotent; it releases the barrier so a later explicit action may create
another branch from the same Turn. `unknown` cannot be acknowledged. Startup
marks abandoned `prepared` work failed—its marker proves provider dispatch
never began—and releases its source fence and target reservation without
requiring a live runtime.
Public adapters keep the operation as the response once its durable row
exists: internal `prepared`, `dispatching`, and `provider_accepted` phases
collapse to `accepted`, while `committed`, `failed`, and `unknown` remain
terminal results. Operation lookup by id returns the same snapshot; committed
results reconstruct the fully projected target Session and durable lineage
from the immutable operation snapshot even after the canonical child is
deleted.
The commit re-proves the frozen prefix and provider identity, remaps
session-scoped canonical ids, persists lineage, and emits the complete
transaction delta.
The target cwd and runtime context are produced from the same prepared runtime
identity used for provider attestation and dispatch, validated by
`SessionForkContextPolicy`, and frozen at prepare together with settings. Tutti
currently rejects worktree-isolated sources
instead of copying their ownership. Prefixes with session-scoped attachment
references fail closed until an immutable resource-manifest binding exists;
copying an entire Session attachment namespace is forbidden because it can
cross the selected Turn boundary.

Interactive responses establish their winner at the canonical interaction
transition, not in a GUI or CLI adapter. Preparing an interactive runtime
operation atomically moves the interaction from `pending` to `answered` with
the requested action, option, and payload. A competing response compares its
request with that durable output: an identical response is `answered`, while a
different response is `superseded`; neither path leaks operation-conflict or
in-progress errors to the responder. The Interaction's pre-delivery `answered`
state is a durable claim marker, not the runtime's terminal result; completed
operation and responder dispositions follow an authoritative runtime
`superseded` result instead of being overwritten by that marker.
Interactive identity is always the typed `InteractionRef` tuple
`(workspaceId, agentSessionId, turnId, requestId)`. Provider request ids remain
unchanged and are only unique within their owning Turn. The response payload
contains no identity fields. Durable operation idempotency uses the same tuple;
an operation id that disagrees with its structured identity is an invariant
failure and must fail closed rather than guessing or rewriting stored data.

Adapters retain authorization and identity, transport, runtime process or VM
selection, desktop APIs, attachment ingress, and cloud inbox/outbox behavior.
Adapter-only create fields such as transcript source paths and materialized
skill bundles intentionally remain outside the Host contract.

`tuttid` production wiring constructs one long-lived `Host`, installs it on the
agent service adapter, invokes `Host.Recover` before serving traffic, and starts
the Host-owned runtime and goal workers. Adapters can use the supervised
`Host.Run` entrypoint to start the runtime-operation, goal-operation, goal
reconcile-inbox, and periodic worktree-GC workers as one lifecycle; an
infrastructure-level worker exit cancels its siblings, while retryable item
failures remain worker-local. Host owns when GC runs, while the adapter port
retains all Git, filesystem, and eligibility decisions. The
individual worker entrypoints remain available for existing focused wiring and
tests. The service package translates
HTTP/query/composer/analytics concerns and provider-specific preparation only;
session, turn, runtime-operation, and goal lifecycle decisions remain in Host.
Isolated service tests may lazily compose the same adapter set, but production
startup never creates a Host per request or per session.

Canonical commits have two distinct extension points. A store-sqlite
`TransactionParticipant` may append a caller-owned durable marker inside the
same transaction as runtime/goal intent and canonical facts; it receives a
narrow transaction writer rather than `*sql.Tx`. After commit, Host emits a
typed `CommittedDelta` to `CommitObserver` for view invalidation, event-stream
wakeups, analytics, and worker scheduling. Observer failure never rolls back or
changes the command result. Work that must survive observer failure must first
be represented by the transaction participant's durable marker; legacy
workspace-only change notifiers are optional latency optimizations.

Re-derivable adapter projections are deliberately outside the participant
contract. Adapters repair those while consuming canonical state rather than
coupling their schema to every Host transaction.

Canonical deletion tombstones are not re-derivable after hard deletion, so
session delete, batch clear, and failed-create compensation also participate
before commit.

The conformance harness depends only on the public Host contract. An
implementation supplies a `conformance.Driver`, seeds its own canonical and
runtime fakes in `Reset`, and runs every value returned by
`conformance.Scenarios`. This lets `tuttid`, the extracted Host, and downstream
adapters share one behavior baseline without importing one another.
Coordinator, goal, and commit-observer scenario groups extend the same driver
with recovery ordering through the worktree sweep, recovery failure
propagation, post-commit failure semantics, and exact-tombstone permanent
removal semantics.
Deletion-admission scenarios are required members of both the standard adapter
and application-core catalogs; the focused deletion-admission catalog reuses
those same scenario values rather than defining a second behavior suite.

The conformance package keeps its shared fixture and driver contract in
`conformance.go`, explicit scenario membership in `scenarios.go`, and scenario
runners in capability-named files. A scenario shared by multiple catalogs must
reuse the same package-level scenario value; catalog ownership must not be
inferred by matching its display name.

The Host release module depends on `store-sqlite` and
`store-sqlite/canonical`, but not on `daemon`, sidecars, or `tuttid`. Canonical
activity snapshots, report observer types, provider identities, capability
vocabulary, and plan-decision strategy live in `store-sqlite/canonical`.
Daemon packages retain source-compatible aliases for existing consumers;
runtime mechanics remain daemon-owned. Title normalization and initial-title
CAS derivation are Host application behavior rather than canonical vocabulary.
