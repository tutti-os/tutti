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
  startup recovery order, and adapter-specific worktree GC scheduling;
- the direct and typed goal-control saga, revision actor, durable operation and
  reconcile-inbox workers, exact Goal-generation fences, provider evidence
  repair, and goal recovery policy;
- the provider-neutral Session Fork saga, selected-Turn binding check, source
  mutation fence, exact capability resolution, frozen canonical snapshot,
  attachment staging, durable lineage, and startup recovery policy;
- the durable edit-retry saga, effective-history revision fence, authoritative
  provider-history reconciliation, and explicit replacement recovery policy;
- typed conformance scenarios under `conformance`.

`CreateSession` has three explicit modes: an empty session, one command with
`InitialContent`, or one typed `InitialGoalControl`. Initial content prepares
its submit claim before provider delivery and rolls back the provisional
canonical shell when delivery fails. Typed initial Goal is mutually exclusive
with non-empty initial content; it creates a non-provisional Session and enters
the same durable Goal saga under `ClientSubmitID` without opening a Turn.
Before runtime preparation or provider startup, a retry with that identity
checks the canonical Goal operation. A completed retry returns the existing
Session and operation; an in-progress or failed operation returns its existing
state instead of starting another provider Session. This preflight is durable
across Host process restarts and does not depend on the runtime's in-memory
Session registry.

Provider Turn acceptance is a cross-process barrier, not a generic lifecycle
notification. The runtime may move through `queued`, `dispatched`,
`provider_observed`, and `resolving_identity`, but it must not expose provider
output or interaction until the exact provider identity has been resolved. The
adapter then blocks its provider event path while the Host atomically persists
`canonicalTurnId + providerSessionId + providerTurnId`; only that commit moves
the Turn to `durably_accepted`. Streaming, waiting for approval/input, running
tools, checkpoints, and terminal events all follow the barrier and retain the
same authoritative provider Turn ID. Correlation IDs are never provider IDs.

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
`CreateSessionInput.RailPlacement` optionally carries the caller-selected,
versioned canonical rail identity. Host validates it before provider startup
and persists its opaque `SectionKey` exactly on first creation. An idempotent
retry that supplies a placement must use the same placement; project deletion
or another adapter-side view change never reassigns an existing session to
`conversations`.
Cancellation exposes durable intent acceptance, provider confirmation, and
canonical settlement as separate facts. `GoalControl`, `GetGoalState`, and
`ReconcileGoal` are provider-neutral Host APIs; typed `/goal` commands enter the
same durable saga without opening a turn. `GoalControlResult.Goal` is always
the durable desired projection after persistence; provider output is retained
separately in `GoalState.Observed`. A provider may return no observation for
pause or resume without erasing the visible Goal, and only a durable tombstone
returns a nil Goal. `AdoptProviderGoal` is the narrow
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
workers may create or change the durable goal projection. `RecoverCore` is the
cold-start boundary: it validates ports and performs only local durable
requeue/invariant work, never claims a runtime operation or calls a provider.
If local runtime-operation lease requeue cannot commit, Host retains the exact
lease fence, records a scoped store degradation, and retries that repair from
the runtime worker after listener publication instead of failing startup.
After the daemon publishes its listener, `Run` supervises bounded
post-listener recovery for goals, forks, and stale turns plus the periodic
workers. Stale settlement is ownership-fenced and skips a session protected by
a prepared, leased, or blocked runtime operation. Configuring a goal store
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

> **Production admits V2 edit retries.** Product composition supplies the Host
> with `AllowNew + Drain`; provider support remains a per-session capability.
> Admission is deliberately separate from lifecycle recovery: an already
> durable operation remains owned by its exact fence and is stepped or
> reconciled from its checkpoint after listener publication. A future rollback
> policy can use `DenyNew + Drain` without revoking that durable ownership; an
> emergency `ReconcileOnly` policy permits only provider reads and converts
> uncertain work to a durable local blocked fence, never a new rollback or
> replacement mutation. Unknown evidence remains fenced and is never implicitly
> abandoned. Production binaries have no environment-controlled enable path.
> See the troubleshooting entry "A stuck edit-and-retry operation crashes the
> daemon on every launch". The behavior below describes admitted V2 work.

## Durable edit-retry V2 contract

V2 is the only scheduler-eligible protocol. Its durable payload has exactly
these checkpoints: `prepared`, `rollback_dispatched`, `rollback_confirmed`,
`replacement_dispatched`, and `rollback_aborted`. `completed` and `failed` are
terminal operation statuses; `abandoned` is a completed result, never an
execution checkpoint. `prepared`, `leased`, and `blocked` are nonterminal;
`prepared` with a future retry timestamp is deferred and `blocked` is never
claimable. A durable step result (`completed`, `deferred`, `blocked`,
`quarantined`, or ordinary terminal failure) means the item has already reached
a durable local disposition. It is worker-local: the worker continues with
later items and the daemon must not convert it into a listener/startup failure.
Only an error without a reliable durable disposition remains an operation
error; it is still not, by itself, a daemon-fatal error.

The closed provider-neutral reason vocabulary separates state from cause.
`retry_wait` is the automatic backoff disposition and is valid only with
`automatic=true` plus a positive retry timestamp. `retry_budget_exhausted`
means automatic attempts have stopped at the durable age/attempt budget and
therefore has `automatic=false` and no retry timestamp. `local_state_inconsistent`
means the operation, exact fence, or history cannot prove a local transition;
it is session-local blocked recovery, not a daemon failure. Existing
`provider_rejected`, `provider_outcome_unknown`, `operation_conflict`, and
`recovery_required` remain distinct stable causes. An explicit provider
rejection is blocked with no automatic retry timestamp; an unknown provider
outcome remains a reconciliation boundary. A provider-negative
`not_dispatched` receipt is also blocked without a retry timestamp; only an
explicit CAS-bound retry or abandon action can advance it. Raw provider and
SQLite diagnostics are never reason codes.

The contract has three fixed scopes:

| Scope  | V2 boundary                                                                                                                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Impact | `EditRetryImpactScopeSession`: one exact agent Session. A poisoned or fenced operation can reject only conflicting mutations for that Session; reads, diagnostics, and every other Session remain available.     |
| Retry  | One Session plus its provider's bounded attempt/age budget and authoritative reconciliation evidence. Unknown evidence is `blocked`/`reconcile`, never automatic replay.                                         |
| Data   | One workspace operation and its exact Session-history fence, plus affected turn history, action ledger, audit, and outbox facts in the same compound transaction. The daemon is never an operation impact scope. |

Every transition checks the operation ID, operation version, checkpoint, and
the exact fence owner. Only the operation named by `fence.operation_id` can
advance or release that fence. `reconcile`, `retry_replacement`, and `abandon`
are CAS-bound commands: they carry a stable client-action identity and the
expected operation/history revisions. Replaying the same identity returns its
durable result; changing the identity conflicts. A mismatch is rejected before
provider work.

Provider boundaries are durable-before-effect. Capability and pre-effect
history snapshots are evidence, not mutation permission. Rollback and
replacement calls occur only after their dispatch checkpoints commit. A missing
or unknown provider outcome retains the exact fence and exposes only the safe
Host-derived recovery action. Replacement redispatch additionally consumes one
authoritative absence proof in the same transaction that authorizes its next
dispatch identity. No absence proof, unknown outcome, or restart can justify a
blind rollback or replacement replay. Stable reason codes and `availableActions`
are the only control-plane contract; raw provider or SQLite errors never cross
this boundary.

Errors detected before a rollback-intent checkpoint (for example, an unsupported
history capability or invalid local submission) use the compound abort
transition. It records `rollback_aborted`, marks the operation terminal, and
restores the exact Session fence in one SQLite transaction. They therefore
cannot leave an otherwise healthy Session parked in `rollback_pending` or be
reclaimed after lease expiry. A malformed protocol or claimable terminal
checkpoint is instead blocked as a session-local recovery incident.

The payload version is also a safety boundary: a missing, unknown, or newer
saga version is fail-closed and grants neither claim nor execution. Current
V2 readers may retain such a row only as a local recovery incident; claim SQL
and upgrade compatibility tests own the enforcement. This does not promise
that an older binary can safely interpret a V2 database.

A completed latest user Turn may be edited and retried only through
`GetEditRetryAvailability`, `EditRetry`, and CAS-bound
`RecoverEditRetryCommand`. Host owns the
complete lifecycle: it first durably prepares the operation and its exact
Session fence, then reads provider history and durably records that read-only
pre-effect snapshot while the operation remains `prepared`. Only that persisted
snapshot can qualify the later rollback-intent checkpoint. Host retracts exactly
one effective Turn only after authoritative confirmation, then submits a stable
replacement Turn. The replacement keeps attachments, mentions, capability
references, and the Tutti mode snapshot while replacing only the first text
block. Retraction changes model-visible history and canonical projections; it
does not compensate filesystem changes produced by the original Turn.

Only the current durable edit-retry saga version is scheduler eligible. The
additive SQLite cutover terminalizes a legacy row only when its persisted
checkpoint explicitly proves no rollback was dispatched (`prepared` or
`rollback_aborted`); missing, malformed, or later checkpoints become a
non-executable session-local `recovery_required` incident with its fence
retained. A deleted session is the sole exception: its exact fence is cleared
inside the same deletion transaction and is excluded from current health.
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
If a read-only provider-history reconciliation is temporarily unavailable, the
same operation is released to a future `retry_wait` with its fence retained;
the worker does not hold the lease until expiry or widen the failure to another
Session.
If the provider has already accepted the replacement but SQLite reports a
transient busy/locked error while recording the local acceptance facts, Host
uses the same scoped `retry_wait` path and keeps `replacement_dispatched`; the
next reconciliation proves the provider Turn before completing, so it never
redispatches the provider call. Semantic conflicts and other local invariant
failures remain blocked for explicit recovery.
If the provider-attempt context is canceled while Host is unwinding an edit
retry, the final local transition uses a separate bounded persistence context;
the operation therefore does not retain its lease merely because the provider
deadline elapsed. This context is never passed to provider work.
For `retry_replacement`, Host reads authoritative provider history before any
database transaction, then calls one compound Store transition. That
transition CAS-checks the operation/history/fence, binds the proof to the
client action ledger, consumes it, advances the stable dispatch attempt, and
writes the recovery outbox event together. A commit failure leaves every fact
unchanged; a caller loss after commit is recovered from the ledger. The
durable authorization alone is never permission for a restarted worker to
send: a crash before the live provider call is reconcile-only. Replaying the
same action identity is idempotent; a different identity conflicts.

Runtime-operation outbox events are canonical consequences, not another
provider mutation. Their stable event ID is the consumer idempotency key.
Each recovery fact also has a durable occurrence identity (the action/proof
identity); replay of that same command reuses its event, while a later legal
wake or replacement authorization creates a distinct event even for the same
operation and kind.
Publish or mark-sent failure durably defers only that event with exponential
backoff; it never rolls back the canonical transition or prevents a later
workspace/session event from being delivered. A mark-sent failure is
at-least-once delivery of the same stable ID, rather than exactly-once publish.
Pending-event diagnostics list every unpublished row; only the worker's
ready-event query applies `next_attempt_at`, so deferred rows remain observable
without becoming scheduler-eligible early.

Ordinary runtime-operation execution retains its synchronous upstream worker
contract. Only edit-retry attempts use the process-local bounded recovery lane
and receive a provider deadline. A context-aware edit-retry provider cannot
head-of-line block another eligible edit-retry Session; a provider that ignores
context holds at most one bounded edit-retry slot until it returns and cannot
create a new goroutine on every worker tick. Durable leases and edit-retry
dispatched checkpoints remain the cross-process safety boundary, so an
uncertain edit-retry attempt reconciles instead of repeating its external
mutation.

Edit-retry recovery additionally uses a dedicated recovery lane. Its admission
uses the canonical Session provider identity (one in-flight recovery per
provider and two per workspace by default); a missing provider is isolated as
`unknown:<workspace>:<session>`, never pooled with unrelated unknown Sessions.
Because edit-retry is queried separately, cancel, interactive, and
plan-decision operations retain their upstream query and synchronous worker
semantics and are not hidden by a recovery batch. These are process-local
reservations only and remain held until an ignore-context call
actually returns; durable leases/backoff remain restart safety.

`RuntimeOperationHealth` separates process-local historical worker totals from
current durable degradation. Current edit-retry entries are read only from the
canonical SQLite operation plus Session-fence projection, never from provider
calls or a raw `last_error`. A completed/abandoned operation with its exact
fence cleared disappears after restart; blocked, leased, future-deferred work,
and orphan non-ready fences remain visible. Missing, mismatched, or orphaned
fence rows are fail-closed as `recovery_required`; an orphan grants no recovery
action and is never silently reported healthy.

Enabled edit-retry retry handling uses a durable processing-lease ordinal:
claiming a lease increments `attempt` before the Host reaches a provider
boundary. The configured limit of eight therefore permits the eighth lease;
after that lease's durable outcome it becomes `blocked`, while a would-be
ninth lease is rejected before provider work. The retry timestamp is
exponential (capped at the eighth exponent) plus stable operation-ID jitter in
the range `[0, base/4]`; it is always later than the base delay and is derived
again after restart. Reaching the 24-hour age budget blocks before a provider
boundary. A blocked operation retains its Session fence, has no claimable
retry timestamp, and exposes only Host-derived recovery state.

Blocked `reconcile` is a read-only provider operation. It persists the action
ledger and a projection event even when evidence remains unknown, so caller
loss cannot turn a repeated click into a stale-CAS ambiguity. The Store accepts
only this checkpoint/canonical-history evidence matrix; every other pairing
remains `blocked` with only `reconcile` available:

| Provider observation                  | Durable checkpoint                               | Canonical source/replacement requirement                                                                                           | Result                                                                 |
| ------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| unknown, unsupported, or read failure | any                                              | any                                                                                                                                | retain `blocked` fence                                                 |
| source present                        | `prepared`                                       | source is still `effective`                                                                                                        | terminal abandoned, release exact fence                                |
| replacement absent                    | `rollback_confirmed` or `replacement_dispatched` | source is `retracted` by this operation                                                                                            | persist `replacement_dispatched` + absence fact; expose explicit retry |
| replacement present                   | `replacement_dispatched`                         | source is retracted by this operation and local replacement receipt/submit claim match the provider ID and stable client-submit ID | complete and release exact fence                                       |

When provider history proves a replacement but a crash or local provenance
failure left its replay envelope missing, Host reconstructs that envelope from
the original durable submission and the edited text. The Store persists the
replacement submission, promotes the exact prepared claim, links history, and
releases the fence in one local transaction. This repair path never calls the
provider; missing or conflicting source data remains blocked.

Before persisting a `prepared` edit-retry operation, Host records a read-only
provider-history snapshot as evidence when the runtime can supply one. That
snapshot can prove the source-present row only while the checkpoint remains
`prepared` and the local source is still effective. Once rollback intent is
durable, reappearance can never restore a turn: the operation stays blocked
until authoritative reconciliation supplies a later safe disposition.

A provider-accepted Goal operation has crossed the delivery boundary. The
steady-state worker waits for applied evidence and never resubmits that
mutation; the accepted convergence deadline terminates a lost-evidence case.
Startup recovery may replay an accepted mutation only according to the
adapter's recovery policy. In particular, a query-incapable adapter may replay
an idempotent clear once to resolve a crash window, while unsafe set replay
remains rejected.

`GetSession` reads canonical session truth plus an optional live runtime
observation without starting a provider. `GetTurn`, `GetInteraction`,
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
reread result as one complete `interaction_snapshot`; an empty interactions
array is an authoritative clear. `CreateSessionInput.ClientSubmitID` and
`SendInput.ClientSubmitID` are the typed idempotency identities and override
the legacy metadata value when both are present. The matching durable submit
claim's immutable `CreatedAtUnixMS` is the canonical occurrence of that user
message. Host passes it to both runtime execution and durable submit-provenance
reporting; adapters must derive the same message sequence from that occurrence
regardless of which report reaches storage first. `ClientSubmitID` identifies
the submission but is not itself an ordering value.
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
recovery. It is idempotent for identical content, rejects conflicts, and never
starts or resumes a Provider.

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

Session Fork is default-off behind the `lab.agentSessionFork` product flag.
Desktop exposes the persisted switch in Developer settings, and Desktop plus
Tuttid enforce the same opt-in for new Fork writes while retaining read and
acknowledgement access to existing durable operations.

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

Startup invokes `Host.RecoverCore` before serving traffic. `RecoverCore` only
repairs local durable state: it does not claim/drain runtime operations or call
a provider. After the adapter publishes its listener, it starts supervised
`Host.Run`; `Run` first performs deterministic post-listener recovery, then
starts the runtime-operation, goal-operation, goal-reconcile-inbox, and
periodic worktree-GC workers. An infrastructure-level worker exit cancels its
siblings, while retryable item failures remain worker-local. Host owns when GC
runs, while the adapter port retains all Git, filesystem, and eligibility decisions. The
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
