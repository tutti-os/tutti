# Agent Host contracts

`packages/agent/host` is the provider-neutral application boundary for
canonical agent session and turn lifecycle orchestration. The package now owns
the create, resume, send, durable submit-claim, canonical title, session read,
settings, pin, delete, cancel, session fork,
interactive response, plan decision, durable runtime-operation, and complete
goal-control/reconcile application core. `tuttid` routes those commands through
`Host`; transport adapters translate their own HTTP or RPC shapes into these
provider-neutral contracts.

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
  and startup recovery order;
- the direct and typed goal-control saga, revision actor, durable operation and
  reconcile-inbox workers, exact Goal-generation fences, provider evidence
  repair, and goal recovery policy;
- the provider-neutral Session Fork saga, selected-Turn binding check, source
  mutation fence, exact capability resolution, frozen canonical snapshot,
  attachment staging, durable lineage, and startup recovery policy;
- the durable edit-retry saga, effective-history revision fence, authoritative
  provider-history reconciliation, and explicit replacement recovery policy;
- the provider-neutral runtime-only Side lifecycle, including live-source
  capability checks, idempotent open, transient execution, and cleanup;
- typed conformance scenarios under `conformance`.

`CreateSession` has three explicit modes: an empty session, one command with
`InitialContent`, or one typed `InitialGoalControl`. Initial content prepares
its submit claim before provider delivery and rolls back the provisional
canonical shell when delivery fails. Typed initial Goal is mutually exclusive
with non-empty initial content; it creates a non-provisional Session and enters
the same durable Goal saga under `ClientSubmitID` without opening a Turn.
When the provider confirms that the accepted `set` command will begin
autonomous execution, Host persists `execution_pending` on that Goal
generation. Only a canonical `goal_arm` or `goal_continuation` Turn carrying the
exact operation, revision, and repair epoch clears it; terminal/non-active Goal
observation, divergence, failure, replacement, and clear also release it. This
fact bridges loading presentation without making Goal convergence imply a Turn.
Before runtime preparation or provider startup, a retry with that identity
checks the canonical Goal operation. A completed retry returns the existing
Session and operation; an in-progress or failed operation returns its existing
state instead of starting another provider Session. This preflight is durable
across Host process restarts and does not depend on the runtime's in-memory
Session registry.

Session creation also has a Host-owned canonical initialization barrier. Every
Runtime used by `CreateSession` must implement
`RuntimeSessionInitializationPublisher`. Host calls
`Start(CanonicalInitPending=true)`, durably initializes the exact canonical
Session (including immutable rail placement), and only then calls
`PublishSessionInitialization`. While that barrier is pending, the Runtime may
start its provider connection but must buffer activity reports, stream events,
configuration updates, and command snapshots so none of them can create or
expose canonical state before Host commits it. Publication is idempotent and
releases the buffered observations in order. An initial-content Session keeps
its separate provisional submit barrier after canonical initialization and
does not become visible until its submitted intent is durable.

`RuntimeStartResult.Created` records ownership of the live Runtime for the
exact `Start` call. Failed-create compensation may close only a Runtime with
`Created=true` and may roll back only a canonical Session created by that
attempt. A retry that reuses an existing Runtime or canonical Session must not
close or delete the earlier owner's resources; it must validate the existing
immutable rail and fail closed on a mismatch. Host consumers must preserve the
`Start -> canonical initialize -> publish` sequence instead of publishing a
runtime-start report directly from `Start`.

Provider Turn acceptance is a cross-process barrier, not a generic lifecycle
notification. The runtime may move through `queued`, `dispatched`,
`provider_observed`, and `resolving_identity`, but it must not expose provider
output or interaction until the exact provider identity has been resolved. The
adapter then blocks its provider event path while the Host atomically persists
`canonicalTurnId + providerSessionId + providerTurnId`; only that commit moves
the Turn to `durably_accepted`. Streaming, waiting for approval/input, running
tools, checkpoints, and provider-root terminal events all follow the barrier
and retain the same authoritative provider Turn ID. Correlation IDs are never
provider IDs. A provider may instead fail before any provider Turn identity
exists. In that case the adapter returns an exact canonical `turn.failed`
terminal without inventing a provider ID. Runtime dispatch remains an
independent admission fact, and the runtime releases its local active-Turn
fence only after that canonical terminal crosses the synchronous durable-report
barrier. A failed or acknowledgement-lost terminal commit remains pending and
is retried idempotently; exact daemon settlement reconciliation is the only
other path allowed to release that fence.

Canonical external identity inheritance is separate from provider acceptance
and Turn lifecycle. A Turn may carry one immutable `IdentityAnchorTurnID`
pointing to an ultimate Turn in the same Session. Plan-decision completion uses
that generic relation when it confirms the implementation Turn, and commits the
anchor before the completed notice in the same canonical transaction. Host and
downstream projections consume only the relation; they never recover it from
plan text, status notices, submit IDs, or transcript page history.

The acceptance barrier does not decide whether the user's prompt is durable.
After `Exec` returns an explicit rejection or an outcome-unknown timeout, Host
records the submit provenance and lossless replay envelope on a
cancellation-independent context. An explicit rejection settles an existing
canonical Turn as failed and transitions its submit claim to terminal
`rejected`; replaying the same `ClientSubmitID` returns that failed Turn without
provider dispatch. For an initial-Session rejection, Host then closes the
startup runtime with canonical completion suppressed: the failed Session, Turn,
and prompt remain historical facts, but that runtime cannot be reactivated.
An outcome-unknown result retains the prepared submit claim for reconciliation
and never blindly redispatches. Only a new provisional Session with no visible
message or provider identity may be compensated away.

Adapters must carry the structured action/objective instead of reconstructing
it from presentation text. `ParseTypedGoalControl` remains the compatibility
path for callers that still send `/goal ...` as initial content. Resume
eligibility is decided by `ResolveResumePolicy`: root sessions resume normally,
explicit imports may recreate a missing provider session, and child,
tombstoned, or non-resumable imports are rejected. Canonical titles may be
empty; only an explicit title or the first eligible prompt establishes one.
For typed initial Goal, the display prompt (or a synthesized `/goal` command)
is the eligible prompt and is established before provider startup, even though
the Goal path does not create a Turn.
`ReprepareRuntimeSession` is the non-destructive boundary for replacing an
idle provider connection with freshly prepared MCP bindings. Host serializes
it with other Session commands, rejects both canonical and runtime active-Turn
evidence, and preserves the canonical Session, provider session ID, and
history. Its trusted `RuntimeContextOverlay` is visible only to runtime
preparation (for example to mint an Invocation-scoped bearer); it is not
persisted or installed as provider RuntimeContext. A successful reprepare must
precede the Turn whose tools use that binding.
`DisconnectWorkspaceRuntime` is the attachment-loss boundary for releasing
every live provider transport in one Workspace without deleting canonical or
Controller Session state. Host serializes each Session against ordinary
mutations, preserves the provider Session identity and history, and never
resumes a provider or replays a prompt. Provider adapters terminalize active
work and pending interactions before dropping the transport, and transport-only
disconnect must not invoke a destructive provider `session/close`. A later
user command follows the ordinary just-in-time Resume path.
Host consumers that perform a provisional runtime mutation use
`WithWorkspaceRuntimeOperation`; its callback receives the reentrant admitted
context and must own startup through cleanup. Attachment observers first call
`AcquireWorkspaceRuntimeDisconnectFence`, which closes admission immediately,
then retry `Wait` until already-admitted mutations drain. Canceling one Wait
does not reopen admission; every joined owner must call `Release`, and one
owner cannot reopen the Workspace while another disconnect remains active.
`CreateSessionInput.RailPlacement` optionally carries the caller-selected,
versioned canonical rail identity. Host validates it before provider startup
and persists its opaque `SectionKey` exactly on first creation. An idempotent
retry that supplies a placement must use the same placement; project deletion
or another adapter-side view change never reassigns an existing session to
`conversations`.
By default, a new explicit project placement must still exist in the Host's
local project registry, which fences a stale local selection after project
deletion. A trusted adapter may set
`CreateSessionInput.RailPlacementAuthoritative` when an external canonical
authority already fixed the placement. That opt-in accepts a project absent
from the local registry, but it applies only to first initialization and never
allows an existing session's immutable placement to change.
Before provider startup, Host resolves the final placement from the immutable
existing session, an explicit caller placement, or the prepared cwd through the
canonical store. It then installs the prepared cwd in `TUTTI_AGENT_CWD` and the
normalized versioned `RailPlacement` JSON in
`TUTTI_AGENT_RAIL_PLACEMENT`. Create, resume, runtime reprepare, and historical
Session Fork sources all receive that same pair. Nested callers inherit it when
they omit an explicit cwd; an explicit cwd is a new placement-selection request,
not a request to reinterpret the caller's environment. Adapters must not derive
placement from a session id, binding id, PeerCommand, or another view lookup.

Host supplies the exact canonical assignments last; the runtime process adapter
owns target-platform environment-key semantics when it materializes the child
process environment.

Cancellation exposes durable intent acceptance, provider confirmation, and
canonical settlement as separate facts. `GoalControl`, `GetGoalState`, and
`ReconcileGoal` are provider-neutral Host APIs; typed `/goal` commands enter the
same durable saga without opening a turn. `GoalControlResult.Goal` is always
the durable desired projection after persistence; provider output is retained
separately in `GoalState.Observed`. A provider may return no observation for
pause or resume without erasing the visible Goal, and only a durable tombstone
returns a nil Goal. `GoalControlResult.IntentAccepted` becomes true as soon as
that durable operation exists, even when immediate runtime readiness or
delivery returns an error; `GoalState` then distinguishes pending delivery
from terminal failure. A provider-accepted or applied Goal is also canonical
resume evidence for a turnless Goal session after the live runtime disappears.

An exact-provider cancel response can be delivery-unconfirmed: the provider
received the request but could not prove it stopped the requested Turn. Host
retains that exact durable operation for retry and canonical reconciliation; it
does not infer either `canceled` or `failed` from the response. If the canonical
Turn reaches a terminal state first, the operation completes as a no-op and
preserves that existing outcome.

`AdoptProviderGoal` is the narrow
reverse boundary for a Goal created by a provider tool during an already
accepted Turn. It atomically records the active provider generation as a
completed, applied operation and converged desired/observed state; it never
dispatches another provider mutation. The provider session plus immutable
generation fingerprint form its replay identity. A conflicting pending or
active durable generation is rejected, so runtime continuation remains
fail-closed instead of inheriting whichever Goal happens to be current.
Every adoption also carries the canonical Goal revision observed before its
asynchronous dispatch. Host compares that revision inside the serialized Goal
actor, so an observation queued before a newer set, clear, pause, or resume
cannot advance after the newer mutation commits. Terminal and cleared
generations may advance to a genuinely later provider-authored Goal; that
transition observes the current revision and receives a new durable revision.
A caller-stable `ClientSubmitID`
makes one goal mutation idempotent across retries and Host restarts (and takes
precedence over the legacy metadata field). `GetGoalState` is a pure canonical
read: only `GoalControl`, `AdoptProviderGoal`, `ReconcileGoal`, and recovery
workers may create or change the durable goal projection. `Recover` first
requeues and recovers
durable runtime operations, then goal operations and the goal reconcile inbox,
then settles unrecoverable stale turns. Configuring a goal store
without its runtime or inbox consumer fails recovery with
`ErrGoalConsumerUnavailable` instead of silently accumulating work.

`FenceGoalGeneration` is the durable boundary for revoking work created by one
exact Goal operation. The caller supplies the original operation identity; Host
persists `(operationId, revision, repairEpoch)` in
`workspace_agent_goal_generation_fences` before attempting any provider call.
`IntentAccepted` means Host owns later retries even when the provider is
offline. Accepting or recovering a fence never resumes an offline provider
Session. Host immediately prepares a revision-conditional local clear so the
revoked target cannot replay. During startup recovery, an absent Runtime
Session completes that clear and the fence locally without resuming a provider;
the operation remains explicit that provider application is unknown. Provider
delivery waits until the Session is already live or a user action resumes it.
A pre-crash live revocation may already have prepared its exact-Turn cancel;
startup completes that internal operation locally with an interrupted outcome
instead of retrying a missing Runtime or letting the operation shield a stale
Turn from restart settlement.
A fence is an admission rule, not session deletion: completed rows remain
durable and are loaded into Runtime resume before the Session can accept Goal
or Turn work, so a delayed provider generation cannot become canonical. The
runtime Controller retains the exact fence set independently of an adapter
connection and installs it into every replacement connection before dispatching
a user operation; failed installation closes the unprotected connection. Host
cancels a live Turn only when its
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

`GetGoalActivityTurn` is the read-only projection proof for consumers that
observe a turnless Goal Session. A candidate must be the latest active Turn,
have a Goal-owned origin, and carry an exact operation/revision/repair-epoch
identity backed by the durable Goal operation store. Consumers may use the
returned Session and Turn to authorize live projection; they must not infer
Goal ownership from `Session.ActiveTurnID`, Turn recency, or origin alone.

> **Currently disabled.** Durable edit-and-retry is neutralized in production via
> `Config.EditRetryDisabled`: its saga can strand a session in a rolled-back-but-
> not-resent state whose runtime operation becomes a cold-recovery poison pill
> that crashes `tuttid` on launch. While disabled, `GetEditRetryAvailability`
> reports unsupported, `EditRetry`/`RecoverEditRetry` refuse, and recovery
> quarantines any leftover operation (failing it and clearing the session's
> history fence back to `ready`). Re-enable only once the resend/recovery gap is
> fixed. See the troubleshooting entry "A stuck edit-and-retry operation crashes
> the daemon on every launch". The behavior below describes the feature when
> enabled.

A completed latest user Turn may be edited and retried only through
`GetEditRetryAvailability`, `EditRetry`, and `RecoverEditRetry`. Host owns the
complete lifecycle: it snapshots the lossless submitted content, serializes the
Session mutation, checkpoints before provider rollback, retracts exactly one
effective Turn only after authoritative confirmation, then submits a stable
replacement Turn. The replacement keeps attachments, mentions, capability
references, and the Tutti mode snapshot while replacing only the first text
block. Retraction changes model-visible history and canonical projections; it
does not compensate filesystem changes produced by the original Turn.
Conversation timelines hide retracted Turns, while audit reads and generated
file projections retain their submitted content and filesystem side effects.

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
The authoritative absence proof is consumed in the same SQLite transaction
that removes a discardable failed replacement placeholder and advances the
stable replacement attempt. There is no separately committed redispatch
authorization checkpoint. Replaying the same proof is idempotent; a later
authoritative proof advances a new attempt only after the previous failed
placeholder and claim are safely discarded.

A provider-accepted Goal operation has crossed the delivery boundary. The
steady-state worker waits for applied evidence and never resubmits that
mutation; the accepted convergence deadline terminates a lost-evidence case.
Startup recovery may replay an accepted mutation only according to the
adapter's recovery policy. In particular, a query-incapable adapter may replay
an idempotent clear once to resolve a crash window, while unsafe set replay
remains rejected.

`GetSession` reads canonical session truth plus an optional live runtime
observation without starting a provider. `GetSessionWithRailPlacement` adds
the Host-owned immutable rail proof for idempotent recovery; application
adapters must not reproduce rail normalization from canonical fields.
`GetTurn`, `GetInteraction`,
`ListSessionTurns`, `ListSessionMessages`, `FindTurnByClientSubmitID`, and
`GetSessionInteractionSnapshot` expose canonical queries without leaking an
adapter's concrete store. `GetSessionInteractionTreeSnapshot` is the
execution-tree read boundary: it accepts only a root Session, resolves an
optional latest root Turn in the same read transaction, and returns that root
Turn plus every descendant Session's latest-Turn interactions. Deleted
Sessions and retracted latest Turns are excluded, and the full result is
ordered by Session, Turn, and request identity. Turn pages are newest-first,
bounded metadata reads with stable cursors. Message pages use per-session
version cursors and may be narrowed to one turn. `GetInteraction` requires the complete
`(workspaceId, agentSessionId, turnId, requestId)` identity. The interaction
snapshot contains every interaction on the latest turn and derives its pending
subset from that same read; older-turn pending rows can never become current
actionable state. Canonical transaction participation derives one deduplicated
`interaction_tree/dirty` fact for every affected execution tree. Interaction
changes, Turn creation/settlement/retraction, and Session deletion are all
covered; the fact carries the immutable root Session and root Turn identity so
consumers wake and reread one tree without reconstructing lineage. A root
Session deletion uses an empty root Turn as an explicit all-turns wake. These
facts are invalidation hints, not partial row updates. Consumers publish the
reread result as one complete `interaction_snapshot` carrying the returned
exact root Turn; an empty interactions array is an authoritative clear only for
that explicit root. Collection contents or authorization-list order must never
be used to infer the current root. `CreateSessionInput.ClientSubmitID` and
`SendInput.ClientSubmitID` are the typed idempotency identities and override
the legacy metadata value when both are present. The matching durable submit
claim's immutable `CreatedAtUnixMS` is the canonical occurrence of that user
message. Host passes it to both runtime execution and durable submit-provenance
reporting; adapters must derive the same message sequence from that occurrence
regardless of which report reaches storage first. `ClientSubmitID` identifies
the submission but is not itself an ordering value.

Guidance is a mutation of an existing canonical Turn, not a request to steer
whatever happens to be current when transport completes. `SendInput.Guidance`
therefore requires an explicit `TurnID` at the Host boundary. Host and the
runtime Controller compare that identity with the live active Turn under the
session lifecycle lock before provider admission. A mismatch returns a typed
`NotDispatched` result, makes zero provider calls, and removes a prepared
submit claim; callers must surface the rejection or retry with a newly captured
target rather than silently redirecting the guidance.
Accepted guidance follows the provider's native active-turn semantics while
keeping the canonical Turn active. A soft-steering adapter may insert guidance
into the current provider response without interrupting it. A preemptive
adapter must close the interrupted response's live message/tool projections
and publish its provider-turn terminal boundary before admitting guided output.
Neither form is a canonical Turn cancel or a second user Turn.

Interactive responses follow the same ownership rule. Runtime may return a
provider-neutral follow-up intent after an interactive denial, but it does not
dispatch that prompt itself. Host checkpoints the intent on the leased
interactive operation, waits for the answered Turn to become idle, and submits
the prompt through `SendInput` with the stable id
`interactive-deny:<operation-id>`. The checkpoint also persists the terminal
interactive disposition, so recovery does not depend on Controller memory or
an existing Runtime Session. Recovery reuses that disposition and id; if the
provider connection is temporarily absent, the operation remains retryable
until ordinary Host admission can replay the prompt without creating a
duplicate Turn.

Accepted runtime Session reports reconcile their Goal snapshot through the
canonical bottom-up observation path without overwriting a newer desired
intent. When that changes the public Goal projection, the same transaction
emits a `goal_state` mutation; timestamp- or evidence-only refreshes remain
silent. A matching applied observation may also complete the pending Goal
operation in that transaction. Consumers use these post-commit facts only as
wake hints and reread canonical Goal state.
For a user Turn, runtime acceptance is not complete until the provider returns
its exact Turn identity and the activity reporter durably installs
`canonicalTurnId -> providerSessionId + providerTurnId`. The direct acceptance
path is synchronous with the Host command while subsequent provider output
remains asynchronous. A local persistence failure after provider acceptance is
reported as delivery-unknown and retains the submit claim; it must never cause
an automatic redispatch. Providers receive only the opaque `ClientSubmitID` as
a correlation identity. Canonical Turn ids remain Tutti-owned and are not
projected into provider client-identity fields.

`CaptureHistoricalSessionGraph` and `RestoreHistoricalSessionGraph` are the
provider-neutral Replay boundary for settled Session, Turn, Message,
Interaction, Goal, hierarchy, stable settings state, and the narrow portable
`providerResumeCheckpoint` required to resume an already-initialized protocol
boundary. The checkpoint is opaque to Host; full provider runtime context is
not exported. Restore is for a fresh isolated Workspace before normal Host
recovery. `HistoricalSessionGraphRestoreInput` carries the target Workspace and
required current User outside the portable graph; restore binds every imported Session
to that runtime-owned identity without serializing it into a Cassette. It is
idempotent only for identical content and the same target User, rejects graph
or ownership conflicts, and never starts or resumes a Provider.

Runtime adapters preserve explicit downstream failures as `ProviderError` so
Host consumers can distinguish provider-owned rejection from preparation,
canonical-store, timeout, and other local failures with `errors.As`. The
provider code and diagnostic text remain local observations rather than a
stable cross-service taxonomy; coordination layers persist only their own
coarse product reason when needed. `NewProviderError` deliberately leaves
cancellation and deadline failures unclassified because their delivery result
is unknown and must remain recoverable. The narrow
`NewProviderStartTimeoutError` exception is used only after the runtime owner
has observed the provider adapter's Start stage time out before establishing a
runtime Session. The daemon keeps the existing `request_timed_out` AppError
code for API and presentation behavior and carries that narrow verdict as
`ErrProviderStartTimeout` in the error chain. The Host runtime adapter maps the
marker to `provider_start_timeout` while preserving the deadline cause; callers
must not infer that verdict from an arbitrary context deadline.
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
adapter. When durable adapter-owned filesystem cleanup is required, its intent
must commit in the same product transaction as the canonical hard delete; the
adapter performs that work after commit and retries failures. Host neither
chooses those paths nor treats cleanup failure as a canonical purge failure.
Each candidate is
fenced by the exact persisted `deleted_at` value, so a concurrently restored or
recreated row is preserved.
Candidate selection groups each topmost tombstone with its complete descendant
tree. A tree containing a live or too-new member is retained, while an eligible
tree is removed in one transaction even when its row or payload count exceeds a
normal batch bound; unrelated eligible trees cannot be starved by blocked
ancestors. Purge results expose only content-free session descriptors and
aggregate message/payload counts. The shared conformance scenario verifies
live and too-new preservation, exact-cutoff removal, complete-tree atomicity,
and idempotent replay through Host.

Recoverable deletion is a separate lossless tombstone lifecycle. New deletes
preserve every selected root/child Session component, its Turns, Messages,
Interactions, effective-history records, provider resume identity, and
attachment references; only live work is terminalized. Batch deletion computes
component size from connectivity inside that exact delete set, so sibling child
subtrees under one canonical root remain independently restorable. If a later
delete selects a live ancestor, complete current-version descendant tombstones
are absorbed into one new component generation without settling their work a
second time. Legacy or incomplete descendants are never upgraded: the new
topmost component stays unavailable for restore but remains permanently
deletable.
Stable Goal and effective-history state is left byte-for-byte unchanged. A
pending Goal operation is failed and detached from the state, while its desired
Goal, observed Goal, revision, and tombstone semantics remain available after
restore.
`ListDeletedSessions` exposes workspace-scoped topmost tombstones—those with no
tombstoned parent—with stable `updatedAt + sessionId` paging and explicitly
marks legacy lossy tombstones unavailable. Its summaries, project-option
catalog, and optional filter use the exact persisted `railSectionKey` as their
identity; the retained project path is presentation metadata only.
`RestoreDeletedSession` restores the
exact component atomically without starting or resuming a provider.
`PurgeDeletedSessionTrees` permanently removes selected topmost components, or
all such components in one Workspace. The optional
`DeletedSessionLifecycleScenarios` conformance catalog verifies that
delete-to-restore boundary independently from retention maintenance.

`ForkSession` creates an independent root Session through an inclusive
canonical `SessionForkPoint`. The provider driver must attest native
`throughTurn` support and the selected canonical Turn must be settled. A
non-empty provider Turn id is not sufficient: the owning Agent must also have
written opaque `provider_turn_binding_json`, and its `CanForkProviderTurn` hook
must accept that exact id/JSON pair. Session-detail projection and Fork
execution call the same hook. Rows created before the JSON binding existed
intentionally remain unbound. Descendants, active work on other Turns, and
pending Interactions are not eligibility inputs.
If an otherwise eligible historical Turn is missing only that binding,
`ForkSession` performs one read-only provider-history repair before repeating
the canonical boundary check. The primary proof is the durable submit claim's
opaque correlation identity. Truly old Claude text-only submissions may use a
per-request HMAC equality proof over one complete text block; multimodal,
attachment-bearing, context-enriched, incomplete, duplicated, and ambiguous
history fails closed. Codex has no legacy text recovery because its stable
`thread/read` shape does not expose an equally authoritative complete prompt.
No provider Turn is ever selected by index. The SQLite repair is an idempotent
empty-binding compare-and-swap and rejects provider Turn identities already
owned by another canonical Turn. Recovery and provider-owned Fork results pass
through the owning Agent's binding writer. Claude stores its checkpoint inside
its private JSON payload; Codex and Tutti Agent `thread/fork(lastTurnId)` use
the shared app-server payload schema and provider Turn id while retaining
separate runtime version attestations and isolated provider homes.
Target titles use one lineage-family sequence (`Title (2)`, `Title (3)`, ...)
rather than restarting the suffix when a child Session becomes the next source.
Every fail-closed boundary rejection retains a stable, content-free reason
through Host. HTTP adapters may project it as structured diagnostic metadata
while preserving their existing coarse conflict reason; transcript payloads
and attachment contents never enter that reason.

Session Fork is exposed directly when the provider/runtime attestation and the
selected canonical Turn satisfy the capability boundary. Product adapters do
not add a separate feature-preference gate; execution still revalidates the
exact provider and Turn facts before dispatch.

Capability projection is preparation-free. It reads either the live runtime
observation or the persisted runtime/driver attestation and never resolves
credentials, prepares a target context, or starts a provider process merely to
render a Fork action. `ForkSession` performs the complete preparation and
revalidates the exact driver before dispatch.

Prepare freezes the complete canonical snapshot through the selected Turn,
allocates all target canonical identities, and stages only the attachments
referenced by that snapshot. Source reporting and Goal/runtime/submit activity
continue against the live source; only physical deletion is retained while the
operation may still need frozen resources. Multiple explicit Forks from the
same boundary are valid. Host eligibility remains independent of source
activity. The shared GUI exposes Fork only on settled Turns whose provider
binding is durably `bound`, including earlier settled Turns while newer work is
active. A `recovery_required` Turn must be repaired and reprojected as `bound`
before the action is exposed; the Fork action is not a binding-repair control.
The GUI disables only the exact Turn whose own Fork request is currently in
flight.

Fork uses the durable
`prepared -> dispatching -> provider_accepted -> committed` saga. Provider
dispatch happens only after `dispatching` commits. The selected provider Turn
must exist in the provider source; earlier provider history is trusted and is
not compared with Tutti's canonical prefix. Provider acceptance, including the
child provider Session id, is persisted before any host-copy binding or
canonical materialization. A `provider_accepted` retry therefore performs only
idempotent local binding and commit and never invokes the provider again.
If provider-owned acceptance evidence cannot cover every provider-bound Turn
in the frozen canonical snapshot, Host treats that evidence as permanently
inconsistent rather than inventing provider identities. It atomically marks
the operation `failed`, preserves the provider acceptance evidence and source
history, removes any incomplete target, and releases the target reservation
and source-boundary barrier so startup and later operations can continue.
Failure to persist that quarantine remains a startup recovery error; transient
SQLite failures are never reclassified as permanent inconsistency.

`prepared` is safe to continue during startup recovery because provider
dispatch has not begun. A crash in `dispatching` becomes `unknown` and is never
automatically redispatched. There is no deterministic-replay compatibility
path. Public status retains `accepted / committed / failed / unknown`, while
the operation phase exposes `frozen / dispatching / materializing / committed /
failed / deliveryUnknown`.

Canonical commit consumes the frozen snapshot rather than re-reading the live
source. It remaps Session, Turn, Message, Interaction, and attachment ids,
persists immutable lineage, normalizes a nonterminal boundary to
`settled/interrupted`, and changes copied pending Interactions to `superseded`.
Provider-owned mode records the returned selected-Turn mapping; host-copy mode
first makes the accepted provider child independently readable. The target cwd,
settings, and runtime context come from the same prepared runtime observation
used for provider dispatch.

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

`tuttid` production wiring resolves canonical/runtime ports and grouped adapter
dependencies before constructing the agent service. It creates shared narrow
components, uses their `HostSupportPorts` with canonical/runtime ports to
compose one long-lived `Host`, then passes that completed Host and the same
components to `NewService`. Production never mutates Service fields or calls a
post-construction Host setter. Support adapters retain only their narrow
component dependencies, never the complete Service facade. Runtime preparation
may read Session Fork lineage and its operation through a committed-only seam:
the lineage is created atomically with the committed fork, and the seam performs
no canonical write or lifecycle reconciliation. That reader is a required
canonical composition port rather than an optional runtime assertion, so
provider-state binding cannot silently omit committed Fork identity
verification.

Startup invokes `Host.Recover` before serving traffic and starts the Host-owned
runtime and goal workers. Adapters can use the supervised
`Host.Run` entrypoint to start the runtime-operation, goal-operation, and goal
reconcile-inbox workers as one lifecycle; an
infrastructure-level worker exit cancels its siblings, while retryable item
failures remain worker-local. The
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

`TerminalFailureObserver` is the aggregated failure-only seam. A failed command
or a Turn whose canonical outcome is `failed` may produce one observation;
`completed`, `canceled`, and startup-reconciled `interrupted` Turns do not.
Consumers that need the exhaustive terminal population must read
`CommittedDelta.RootTurnsSettled` from `CommitObserver` and classify the
canonical outcome instead of inferring cancellation from a failure callback.

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
with recovery ordering, recovery failure propagation, post-commit failure
semantics, and exact-tombstone permanent removal semantics.
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
