# Issue Execution Coordination

Issue execution combines two independent domains:

- Workspace Issue owns Issue, Task, Run, dependency, acceptance, budget, and
  dispatch-pause facts.
- Agent Host owns Session, Turn, runtime-operation, terminal outcome, and
  lifecycle recovery semantics.

Neither domain mirrors the other's state. `IssueExecutionCoordinator` in
`services/tuttid/service/workspace` is the product-owned integration seam that
maps user intent and canonical Agent facts into Issue commands.

This generic dispatch flow applies to manual and `traditional_plan` Issues.
Accepted `tutti_mode_plan` Issues instead materialize atomically with a
Tutti-owned execution aggregate and active `initial_schedule` checkpoint.
Their materialization creates no Run and never enters the generic eligible-task
dispatcher; later work requires an explicit Tutti execution schedule command.
Every active Tutti checkpoint instead owns one durable main-conversation wake.
The wake asks the source Agent to review canonical execution state and choose a
fenced `schedule` or `acknowledge` command; settling a task never mechanically
dispatches a successor.

## Execution flow

Generic Issue dispatch is split into two phases:

1. Under the per-Issue mutation lock, Issue Manager rechecks policy and creates
   a durable running Run. That Run is the claim that prevents duplicate
   dispatch.
2. After releasing the lock, the Issue run launcher prepares any worktree and
   creates the Agent Session. A launch failure settles the claimed Run through
   the normal idempotent completion command.

Stopping is also split:

1. Under the Issue lock, set `dispatchPaused=true` and snapshot the Issue's
   running Runs.
2. After releasing the lock, request cancellation of each bound Agent Session
   by resolving the exact `issue-run:<runID>` Turn.
3. Settle a Run as canceled only from exact canonical Turn settlement, or from
   a typed adapter result that carries authoritative canceled evidence.

Agent cancellation may synchronously publish a canonical settled-Turn fact.
Because no Issue lock is held across the Agent call, that callback can safely
settle the Run. A failed cancellation leaves the Run running, keeps dispatch
paused, and returns an error; Issue intent must not fabricate Agent outcome.

The non-blocking Run launch gate closes the claim-to-launch race without
holding a mutex across external work. Stop records cancel intent and returns
without waiting for an in-flight Agent create call. Launch revalidates the
durable Run and Issue pause fact before external work; when it completes, it
observes any concurrent cancel intent and performs exact-Turn compensation. If
pause wins before launch begins, the unlaunched claim is canceled without
creating an Agent Session.

Tutti-owned launch intents add a cross-process fence to that local gate. Run
terminalization seals any `prepared` or `leased` intent in the same database
transaction as its settlement checkpoint; prepared scans and lease claims also
require the Run to remain `running`. `MarkDispatched` is a strict current-owner
CAS and is the successful delivery linearization point. If an external create
returns after another replica terminalized the Run, either success or an
ambiguous error performs exact-Turn cancellation. A stale owner whose lease was
reclaimed while the Run is still running does not cancel the valid same-ID
Turn; it schedules reconciliation instead. Startup repair repeats the intent
seal even when the settlement checkpoint already exists. When a leased or
dispatched launch may have created a Turn, the settlement transaction also
prepares a durable cancel-compensation operation. Those operations have their
own owner/lease/attempt state, use the same deterministic submit identity, and
are retried on startup and the regular reconciliation cadence until exact
cancellation is accepted. Compensation uses a bounded context detached from
the original delivery cancellation signal. A retryable cancellation outcome
keeps the operation prepared and queues another pass without aborting startup
or starving launch/running-Run recovery in the same workspace. A successful
stale owner also revalidates the Run before compensating: lease reclaim while
the Run remains running is recovery work, not a cancellation signal.

Tutti main-conversation delivery follows the same durable-operation pattern.
Creating or promoting an active checkpoint prepares its wake in the same
SQLite transaction. The canonical identities are
`<checkpointID>:wake:main:1` and
`clientSubmitID=tutti-execution-wake:<wakeID>`; they are interoperability
contracts, not presentation values. An existing row with different checkpoint,
target, sequence, client-submit, or source-session identity fails closed.

Delivery first checks the exact workspace/source Session and leaves the wake
prepared while that Session is busy. A daemon-unique owner leases the wake,
then sends through Agent Service while Host remains the authority for canonical
Session liveness and `clientSubmitID` lookup. Response loss is recovered by
looking up the same deterministic submit ID. Every external send has a bounded
deadline shorter than its remaining lease. Canonical lookup, release, integrity
failure, and final dispatch CAS use their own bounded contexts detached from
caller cancellation, so cancellation cannot strand the row in `leased` after
external work has returned. They are cleanup bounds, not permission to continue
an unbounded Agent call.

Recovery recomputes execution, wake, client-submit, target, sequence, and source
Session identity from durable Issue/checkpoint evidence before claim and again
before delivery. Corrupt identity fails closed and is recorded as `failed`;
immutable workspace/execution/checkpoint relationships are also protected by
the wake table's composite foreign key. Main recovery lists only `main` targets;
a separate integrity scan recognizes deterministic main-form identities whose
target kind was corrupted. Goal Review delivery has its own durable review
operation and lease and therefore is never claimed by the main-wake worker.
Only a lease owner whose lease is still live may enter `SendInput` or win the
final dispatch CAS. The final CAS uses the injected product clock, so a lease
that expires during the external call cannot be finalized by its stale owner.
These fences make restart or replica races converge on one canonical Turn.

The exact Session/Turn settlement changes the wake to `turn_settled`, but does
not resolve the checkpoint: only a correctly fenced checkpoint command may
atomically acknowledge that wake and promote the next backlog checkpoint.

Every nonterminal Tutti execution also carries a fixed inactivity deadline:
`watchdogDueAt = lastOrchestratorActivityAt + 5m`. Valid schedule and
acknowledge commands, Run settlement (including failed or canceled), exact
source-session user input, and exact source root-Turn settlement reset that
deadline. Delegate/child activity and activity from another workspace or
Session do not. The Agent adapter only projects these facts after Host accepts
the user Turn or reports the canonical root Turn settled; it does not change
Host lifecycle semantics. The projection carries the canonical Turn identity
and user-message occurrence or root-Turn settlement time rather than callback
wall time. SQLite advances the deadline only for a strictly newer event time,
so at-least-once replay and out-of-order delivery cannot drift it. Internal
watchdog prompts are excluded only for their exact target source Session;
reusing the same submit identity in another Session remains user activity.

When a deadline becomes due with no active checkpoint, the daemon atomically
creates a `watchdog` checkpoint and its deterministic sequence-1 main wake. If
the awakened Turn settles without a fenced command, the checkpoint remains
active and the next fixed deadline creates sequence 2 (then 3, and so on) on
that same checkpoint, each with the normal deterministic wake and
`clientSubmitID` identity. A valid command acknowledges every wake for the
resolved checkpoint; later inactivity creates a new watchdog checkpoint
rather than another generation on resolved history.

Source activity that arrives while a prepared or leased watchdog wake is
suppressed moves that same durable operation to the new five-minute deadline;
it does not replace its identity. A busy source Turn, an already dispatched
main wake, or an active independent reviewer suppresses duplicate delivery.
Reviewer state is read through an injected port and is never written by the
watchdog. Infrastructure leases and retries do not move either the execution
deadline or wake due time.

Accepted source-user submissions and settled source Turns do not depend on a
best-effort post-commit callback for this clock. The canonical Agent SQLite
transaction atomically appends a product-owned activity-inbox marker for the
exact message or Turn mutation. Every watchdog sweep drains those markers
before due materialization, resolves the canonical user-message occurrence or
root-Turn settlement timestamp, and advances the execution clock
monotonically. A transaction cannot commit the canonical activity while
silently losing its marker. Replays are harmless, and user messages whose
`clientSubmitID` and Session match the target of a durable Tutti main wake are
excluded so an internal prompt cannot debounce itself. Direct observers remain
low-latency wake hints only.

When every task is terminal, settlement atomically promotes an
`all_tasks_terminal` checkpoint and changes the execution to
`pending_goal_review`. Completion is never inferred from task count. In `self`
mode the checkpoint owns a normal main wake. In `independent` mode the same
transaction instead prepares one deterministic Goal Review operation:
`reviewID=<checkpointID>:review`, a deterministic reviewer Session, and
`clientSubmitID=tutti-goal-review:<reviewID>`.

The independent reviewer runs in a hidden, strict read-only Session. Runtime
preparation uses an exact capability allowlist: canonical Issue, Task, Run, and
output reads plus the structured
`tutti-goal-review.goal-review.verdict` integration capability. Tutti plan,
Agent control, dynamic app commands, generic Issue/Task/Run mutation, browser,
and computer capabilities are absent. That projection is part of the immutable
Session runtime snapshot so a resumed reviewer receives the same command
surface. The reviewer may inspect canonical evidence, then submit exactly one fenced
`goal_satisfied`, `more_work_required`, or `inconclusive` verdict. A verdict
must match the exact review Session, Turn, checkpoint, graph revision, and
idempotency request.

For session-aware CLI requests, the daemon resolves this projection from the
canonical Agent Host Session and applies it to both capability listing and
command invocation. A missing resolver, unreadable Session, or malformed
snapshot fails closed. Codex runtime preparation also narrows automatic CLI
approval from the whole binary to the exact projected command paths.

This is a product-policy and defense-in-depth boundary, not hostile-process
isolation. The local daemon bearer credential is shared with same-OS-user CLI
clients, and a same-user process that can read the global listener-info file
can deliberately make a sessionless request. Therefore the independent
reviewer contract assumes the configured provider runtime follows Tutti's
session environment and permission policy. It does not claim containment
against a malicious reviewer that strips its environment or reads and reuses
the global credential. Closing that stronger threat model requires a separate
process/filesystem isolation design or removal of unscoped CLI credentials; it
must not be inferred from command projection alone.

Reviewer dispatch uses deterministic Session and submit identities with
canonical Host lookup for response-loss recovery. Verdict admission may race
the dispatch response: while the delivery lease is current it atomically binds
the canonical Turn and records the verdict, and the later dispatch mark is an
idempotent confirmation. Conversely, a Turn observed settled before that bind
fails closed rather than losing a verdict-less settlement. A reviewer Turn
that settles without the structured command also fails the review. Both a
submitted verdict and a failed review atomically prepare the main wake, which
includes the reviewer evidence.

The independent verdict is advisory but cannot be silently ignored.
`more_work_required` and `inconclusive` require an audited disagreement reason
before the source Agent may complete. A failed independent review requires an
explicit audited user action to switch the execution to `self`; there is no
automatic fallback. The final `complete` command is accepted only from the
source Session at the exact active Goal Review checkpoint and graph revision.
It resolves that checkpoint and marks the execution `completed` atomically.
Choosing more work instead changes and schedules the graph through the normal
fenced plan commands.

Goal Review lifecycle remains separate from watchdog delivery. Its activity
reader treats only durable `prepared` or `dispatched` reviews as active
duplicate-suppression ownership; the watchdog never creates or advances a
review row. The daemon worker performs reviewer recovery on its normal sweeps,
including its first listener-ready sweep, so a restart cannot strand a prepared
review.

A leased wake is checked against its current durable due time immediately
before `SendInput`. Source activity in the claim-to-send window therefore
releases the same operation without sending. The final dispatched transition
also compares the due time observed before sending, so activity during the
idempotent Agent submission prevents a stale owner from finalizing an older
generation. A newer canonical marker fences either transition only while its
derived five-minute deadline remains in the future; an already-due marker
cannot strand the wake lease and a later drain does not create another
canonical Turn.

Startup and periodic recovery also inspect dispatched wakes. Using only each
wake's persisted source Session and `clientSubmitID`, the Agent adapter queries
the canonical Turn without resuming its provider. A settled Turn repairs a
lost observer projection with its canonical settlement time, allowing the
next fixed five-minute wake sequence to resume. Pending-only recovery markers
remain quiet, while independent integrity or persistence errors joined with a
pending retry are still reported and do not stop later worker sweeps.

Execution states `orphaned_source`, `completed`, `archiving`, and `archived`
suppress every still-open wake, including `turn_settled`. Suppression is stored
as `canceled` and clears any lease rather than deleting recovery evidence.

## Identity and settlement

Every dispatched Run stamps `clientSubmitID=issue-run:<runID>`. A settled Agent
Turn may complete a Run only when the coordinator resolves that submit ID and
the exact initiating Turn ID matches the settled Turn ID.

Missing, failed, or ambiguous identity resolution is fail-closed: the Run
remains running and reconciliation is scheduled. Reconciliation combines the
same `FindTurnByClientSubmitID` and canonical `GetTurn` queries to recover the
exact settled fact. A different Turn in the same Agent Session must never
settle the Run.

The coordinator consumes `IssueRunSettlement`, a narrow typed fact. Translation
from Agent canonical projection DTOs is isolated at the coordinator adapter;
Issue Manager does not interpret Agent Session or Turn state.

## Lock and transaction rules

The per-Issue mutex serializes local read-modify-write commands in one daemon
process. It must never be held while invoking Agent Host, creating a git
worktree, notifying another Agent conversation, or performing another
potentially re-entrant cross-module action.

The mutex is not a durable transaction boundary. Store commands still need
database-level atomicity or revision/CAS protection for invariants spanning
Run, Task, Issue projection, and budget. Until those store commands are
introduced, the mutex remains a local serialization aid and must not be
described as sufficient cross-process correctness.

## State model

This flow does not need a general-purpose state-machine framework. Durable
facts remain small and direct:

- Issue: `dispatchPaused`, execution policy, budget
- Task: status, acceptance state, latest Run
- Run: running or terminal outcome, Agent Session binding
- Goal Review: mode, reviewer operation/lease, structured verdict, audit
- Agent Host: Session and Turn lifecycle

UI and orchestration phases are derived from those facts. New boolean flags
must not be used to simulate transactions or hide incomplete cross-domain
operations.

## Recovery

The reconciliation queue is daemon-context-bound and retries transient
failures. It is a fallback for delayed or missed projection delivery, not the
authority for Agent lifecycle semantics. Product timeouts may fail an Issue
Run, but Agent terminal outcomes should come from exact canonical Turn facts.

Durable main wakes enter that queue after Tutti Issue materialization and Run
settlement. Root-Turn settlement also enqueues rather than sending inline, so a
source conversation that was busy is reconsidered without re-entering Agent
delivery from the projection callback. Every queue pass first performs
idempotent suppression and expired-lease repair, then attempts delivery.
Integrity, Session observation, claim, and delivery failures are isolated per
wake: the pass continues through later executions in the workspace and returns
their joined errors afterward. Released delivery failures return a pending
signal so the existing bounded queue cadence retains the workspace even when it
has no running Runs.

During daemon construction, startup performs only the local durable repair.
It does not call Agent `SendInput` or start the queue while CLI routes and the
listener are unavailable. A one-shot listener-ready hook enqueues the
workspaces after listener information has been published. A readiness gate also
turns any earlier internal enqueue into a pending retry without reaching
`SendInput`. A transient repair or Session observation is retained for queue
retry instead of preventing the daemon from serving other workspaces. Startup
never reclaims an unexpired lease owned by another process.

After listener readiness, a daemon-owned watchdog worker scans every current
workspace on a short infrastructure cadence. Each scan materializes all
expired nonterminal deadlines and then delegates delivery to the same durable
main-wake recovery path, then recovers prepared independent Goal Reviews.
Startup requeues only expired leases, preserves live owners, and performs the
same all-execution scan; terminal and orphaned executions never create a
watchdog operation. The scan cadence is not a backoff policy—the persisted
product interval remains exactly five minutes.

The former in-memory Tutti Issue completion notifier and dispatcher are not
orchestration authorities. Checkpoint/wake rows plus canonical Agent Host
queries are the restart-safe source of truth.
