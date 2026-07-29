# Issue execution

## Managed task deletion is reported as a stale checkpoint

When a source Agent reports that a canceled task could not be removed because
the current checkpoint rejects graph changes, inspect the two mutation attempts
separately. `tutti issue task delete` must return `tutti_issue_managed` for a
Tutti-owned graph; that is the expected ownership guard. The authorized path is
`tutti plan issue mutate` with the active checkpoint and graph revision.

If the mutate call reports that its caller, checkpoint, revision, or operation
set is not current, first confirm the execution row, active checkpoint, graph
revision, and source Session. When those fences still match, inspect
`--operations-json`: operation objects use `kind`, not `op`, and a `rework`
embeds its replacement under `task`, not `replacement`. Go's permissive JSON
decoder otherwise ignores the alias, leaves the required field empty, and the
service rejects the malformed operation before it evaluates the durable
checkpoint.

The CLI must reject that malformed shape with an actionable `kind` validation,
and the durable wake prompt must include exact supersede and rework examples.
Validate both aliases in the CLI provider tests and the task-canceled
wake-prompt test. Do not weaken the generic Issue ownership guard or physically
delete task/Run audit history; `supersede` and `rework` preserve that history.

## Reworked task scheduling is reported as a stale checkpoint

After a failed or canceled task is reworked, the mutation can succeed but
scheduling its replacement may still be rejected. Run
`tutti plan issue get --issue-id <id> --json` once to separate fence state from
task eligibility. Compare its active checkpoint and graph revision with the
successful mutation result, then use each task's `blockerReason`. Stable
reasons such as `stale_graph_revision`, `missing_agent_target`, and
`dependency_unsatisfied` identify which correction is required instead of
collapsing every failure into a generic schedule rejection.

A replacement submitted with only a new task ID, title, and content is a sparse
rework, not a request to clear launch configuration. The mutation layer must
inherit omitted Agent target, compatible model selection, permission mode,
reasoning effort, execution directory, and dependencies from the superseded
task. Explicit replacement values override those defaults. It must also
redirect dependencies for active `not_started` tasks in the same transaction,
preserve the old task and Run as superseded history, and reject the transaction
if an affected dependent has already started.

Do not query or modify the backing SQLite database to recover or bypass the
rejected command. The daemon and CLI are the supported control plane, and
guessing a production database path while the runtime is in development mode
produces unrelated evidence. If the authoritative CLI snapshot and documented
recovery commands still cannot resolve the failure, retain and report the exact
CLI error.

The checkpoint wake prompt must describe sparse rework inheritance, dependency
redirects, and scheduling with the graph revision returned by the successful
mutation. The injected CLI skill must also define the checkpoint/action matrix
and bound fence or schema recovery to one refresh and one retry. Validate both
failed and canceled terminal-run paths, sparse rework, inherited launch
settings, dependency redirect, and replacement scheduling in the execution
conformance suite.

## Tutti composer stays busy after every task Turn settles

The Tutti composer deliberately shows Stop while its managed Issue still has
nonterminal tasks. When every Agent Turn is terminal but the composer remains
busy, compare the execution graph revision with the active checkpoint revision
and inspect the ordered checkpoint backlog. An `awaiting_main` execution whose
active settlement checkpoint has an older revision cannot pass the source
Agent's schedule or acknowledge fence.

This mismatch can occur when parallel Runs append settlement checkpoints at one
graph revision, the source Agent mutates the graph while reviewing the first
checkpoint, and a later checkpoint is promoted without being rebound to the
new revision. Promotion through both schedule and acknowledge must set the
checkpoint's revision to the current execution revision in the same
transaction. The watchdog repair path must also rebind already-active stale
settlement or watchdog checkpoints, advance their retry deadline, and issue the
next deterministic wake without rewriting task or Run history.

Validate this class with a conformance scenario that mutates the graph before
both schedule-driven and acknowledge-driven backlog promotion. Also validate
watchdog recovery from a pre-existing active checkpoint whose revision trails
the execution revision. Do not change the composer to ignore nonterminal Issue
tasks; that would hide the durable orchestration deadlock while work remains
unreviewed.

When a rework succeeds but the current Issue board shows both the original and
replacement tasks, compare the board with the Issue's active task projection.
Rework deliberately retains the superseded task row and Run history for audit,
but current-task lists, progress counts, and scheduling must exclude tasks whose
`supersededAtUnix` is set. Do not delete the superseded history to make the
counts agree.

## Settled checkpoint keeps reopening the source Session

A terminal Agent Turn does not resolve its Tutti execution checkpoint. When the
checkpoint remains active after that Turn settles, the inactivity watchdog
deliberately creates another deterministic wake after five minutes. Each wake
is a new Agent Turn, so Desktop may show a new generic Turn-completion
notification even though no task Run restarted.

First group the wake records by Issue, checkpoint, and wake sequence. Multiple
Issues may legitimately target the same source Session and therefore share the
same conversation title. If an older Issue was replaced by a new plan but was
never archived, both active checkpoints will continue to wake that Session.
Do not suppress watchdog delivery or mark a Turn terminal as proof that the
Issue is terminal; either action loses durable work.

The source Agent must have an explicit terminal path when it decides an Issue
should not continue. `tutti plan issue stop` derives source authority from the
invoking Session, fences against the active checkpoint and graph revision, and
reuses the recoverable archive flow to cancel Runs and close open wakes. The
durable wake prompt must advertise that command. Validate the source,
checkpoint, and revision fences, plus idempotent replay after the first stop
has already canceled the active checkpoint.

## Paused Tutti Issue keeps reopening and reports no resume command

A stopped task cascade may leave the Tutti-owned Issue nonterminal with
`dispatchPaused=true`. The source conversation should then stay quiet. If it
reopens every five minutes, correlate the daemon's
`client_submit_id=tutti-execution-wake:<checkpoint>:wake:main:<sequence>` with
the Issue pause fact and the wake rows for that checkpoint. A sequence that
keeps increasing while the Issue is paused proves the watchdog delivery path
did not consume the same durable gate as task scheduling.

Do not resolve or delete the checkpoint and do not archive an Issue the user
may resume. Apply the pause at every main-wake boundary: due watchdog
materialization, dispatchable listing, durable claim, and final dispatch CAS.
Retain the prepared or settled wake history so clearing the pause continues
from the same checkpoint and graph revision.

If pause races after Agent Host has already accepted the wake Turn but before
the final dispatch CAS, cancel that Turn before making the wake retryable. An
accepted `clientSubmitId` cannot execute again, so atomically cancel the leased
wake and prepare the next sequence with a fresh identity under the same active
checkpoint. Keep the replacement hidden while paused. If canonical Turn
cancellation fails, retain the lease until expiry to prevent overlapping
orchestrator Turns.

Run `tutti plan issue get --issue-id <id> --json`. A paused snapshot must expose
`dispatchPaused=true`, omit `plan issue schedule` from `allowedActions`, and
advertise `plan issue resume`. Only the original source Session may execute
that resume. For an older Session whose immutable command snapshot lacks the
new capability, the exact compatibility request
`tutti issue update --issue-id <id> --dispatch-paused=false --json` must route
to the same source-scoped control; mixed field updates and other generic
managed-Issue mutations remain rejected.

Validate paused list/claim/finalize races, fresh wake identity after a canceled
accepted Turn, lease retention when cancellation fails, deferred watchdog
sequence creation, idempotent source-scoped resume, the paused execution
snapshot, and both CLI entry points. Restarting Desktop is not a resume
operation and must not create another wake.

## Stop remains pending while the Agent Turn is already canceled

Check the durable Issue, Run, Agent Turn, runtime operation, and Agent outbox
facts separately. A paused Issue with a running Run and a terminal Agent Turn
usually indicates that synchronous Agent settlement re-entered Issue mutation
while the stop caller still held the same per-Issue mutex.

The invariant is:

> Never call Agent Host, git worktree operations, or another re-entrant module
> while holding the Issue mutation lock.

Cancellation should persist `dispatchPaused=true` and snapshot running Runs
under the lock, release it, then cancel Agent Sessions and idempotently settle
Runs from exact canonical Turn facts. A regression test should use a canceller
that publishes settlement synchronously before returning; a passive recorder
cannot reproduce this deadlock class. A second barrier test should pause while
launch is in flight and verify Stop returns immediately while the non-blocking
launch gate still requests exact-Turn compensation after launch.

Do not fix this symptom by treating the UI test as flaky, adding a timeout, or
introducing another pause flag. Those changes hide the blocked command without
repairing the callback cycle.

For the ownership and data-flow contract, see
[Issue Execution Coordination](../../architecture/issue-execution.md).

## Stopping a Tutti source Turn leaves automation recoverable

First compare the canonical source Turn, activity inbox, execution, archive
operation, workflow operation, Run launch intent, wake, and Goal Review rows. A
canceled source Turn followed by `awaiting_main`, `pending_goal_review`, or a
new wake after restart means Stop affected the Agent runtime but did not cross a
durable product boundary. A scan of running Runs is not sufficient: one source
conversation may own several executions, including executions with no current
Run, and bounded workspace scans can omit older Issues.

The source-session Stop path must request archive for every nonterminal
execution belonging to the exact workspace/source Session. The archive
transaction pauses dispatch and cancels checkpoints, wakes, reviews, prepared
or leased launch intents, and workflow recovery before external cancellation.
Archive recovery then cancels exact Run, main-wake, and reviewer Turns. If Stop
wins before a Run has a canonical Turn, settle that unlaunched Run as canceled;
if delivery is already in flight, the launch gate performs exact-Turn
compensation.

The canonical canceled Turn and its `workspace_tutti_source_activity_inbox`
marker are atomic. Draining the marker must create the same archive operations,
must not count the canceled Turn as watchdog activity, and must happen before
reviewer or main-wake dispatch. Create-Issue startup recovery must also reject
an accepted workflow while that canceled-source marker remains undrained. This
is why closing and reopening the app cannot legitimately resume the old
automation.

Validate this class with the source-session archive conformance scenarios,
canceled-source inbox recovery, main-wake and reviewer dispatch-race
compensation, a prepared Run with no canonical Turn, and workflow recovery
fenced before inbox drain. Keep the generic Issue ownership guard intact;
source Stop is a Tutti execution lifecycle operation, not a generic Issue
mutation.
