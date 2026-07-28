# Tutti Mode Agent-Orchestrated Execution Design

## Summary

Tutti Mode execution becomes an agent-orchestrated, durable workflow after a
plan is accepted. The daemon records facts, validates explicit commands, and
recovers delivery; it never chooses or automatically dispatches a successor
task for a Tutti-owned Issue.

The original planning Agent session is the sole graph author. Every task
settlement creates a durable checkpoint and wakes that session. The main Agent
must review the result and explicitly mutate, schedule, or finish the
execution. A fixed five-minute inactivity watchdog is a durable debounce
fallback. All-terminal task graphs enter Goal Review and do not complete until
the main Agent explicitly accepts a `goal_satisfied` verdict.

Tutti-owned Issues are read-only through generic Issue Manager mutation
surfaces. Users modify them by returning to the source conversation and
describing the desired change. Active source conversations cannot be deleted
until their executions are explicitly stopped and archived.

## Ownership

The orchestration aggregate, checkpoints, graph revisions, wakes, Goal Review,
watchdog, and archive policy are Tutti product semantics owned by
`services/tuttid`. Durable rows live in `services/tuttid/data/workspace`.

`packages/agent/host` continues to own the canonical lifecycle of Agent
sessions, turns, goals, and runtime operations. Tutti workers use existing Host
contracts to create/send/cancel/recover sessions and turns. This feature does
not add Issue graph semantics to Host.

`packages/workspace/issues` remains the reusable Issue/task/run domain. It gains
only reusable model invariants such as managed-mutation rejection and logical
task supersession. Product orchestration remains in the daemon.

## Execution Aggregate

Each accepted Tutti plan materializes one Issue and one
`workspace_tutti_execution` aggregate with:

- `workspaceId`, `issueId`, `workflowId`, and `sourceSessionId`
- `status`: `awaiting_schedule`, `running`, `awaiting_main`,
  `pending_goal_review`, `orphaned_source`, `completed`, `archiving`, or
  `archived`
- monotonically increasing `graphRevision`
- the active head checkpoint identity, derived from an ordered durable backlog
- `lastOrchestratorActivityAt` and `watchdogDueAt`
- `reviewMode`: `self` or `independent`
- optional `reviewAgentTargetId`
- completion and archive audit timestamps

Existing `Issue.Status` remains a projection of task/run counts and is not used
as the orchestration completion authority.

Plan materialization is inert:

- it creates the Issue, tasks, execution aggregate, and initial checkpoint
- it creates no Run and calls no task launcher
- it prepares an immediate durable wake for the source session
- the first task batch requires the same explicit schedule command as every
  later batch

Existing `autoAccept` values remain readable for migration compatibility but
have no dispatch authority for Tutti-owned executions.

## Checkpoints and Main-Agent Commands

Every relevant state change creates or updates a durable checkpoint:

- `initial_schedule`
- `task_settled`
- `task_failed`
- `task_canceled`
- `watchdog`
- `all_tasks_terminal`
- `migration`

A checkpoint carries a deterministic identity, monotonically increasing
sequence, graph revision, subject task/run when applicable, creation reason,
status, and Goal Review requirement. Replaying the same terminal run cannot
create a second checkpoint.

Checkpoints form an ordered durable backlog:

- statuses are `pending`, `active`, `resolved`, `superseded`, or `canceled`
- exactly one checkpoint per execution may be `active`
- new task settlements append `pending` checkpoints while a head is active;
  they never replace or merge away an earlier task review
- resolving the active head atomically promotes the next pending checkpoint
  and prepares its immediate wake
- an `all_tasks_terminal` checkpoint is ordered after every settlement that
  contributed to that projection
- when a later graph mutation makes a pending Goal Review stale, reconciliation
  marks it `superseded` instead of presenting an obsolete completion question

This guarantees that two parallel task settlements each receive a review even
when both occur before the main Agent handles the first wake.

Main-Agent commands derive the caller identity from trusted CLI invoke context
(`TUTTI_AGENT_SESSION_ID`). They reject calls whose caller is not the Issue's
`sourceSessionId`.

The public Agent-facing command family is:

```text
tutti plan issue schedule
  --issue-id
  --checkpoint-id
  --expected-graph-revision
  --task-ids-json
  --request-id

tutti plan issue mutate
  --issue-id
  --checkpoint-id
  --expected-graph-revision
  --operations-json
  --request-id

tutti plan issue complete
  --issue-id
  --checkpoint-id
  --expected-graph-revision
  --decision goal_satisfied
  --summary
  --review-disagreement-reason <required only when overriding independent review>
  --request-id

tutti plan issue acknowledge
  --issue-id
  --checkpoint-id
  --expected-graph-revision
  --request-id
```

`schedule` admits exactly the requested task IDs or none. One transaction
validates identity, checkpoint freshness, graph revision, dependencies, task
state, budget, isolation, and workspace concurrency, then commits every Run
claim plus durable launch intent. It must not silently shrink the requested set
or add another eligible task. External worktree/Host delivery happens after
admission and is independently recoverable through deterministic
`issue-run:<runId>` identities; an individual delivery failure becomes a
failed settlement checkpoint rather than rolling back already delivered work.

`mutate` supports add, update, rework, and logical supersede operations.
Completed task/run history is immutable. A running task must be canceled and
settled before it can be superseded. Successful graph mutations increment
`graphRevision`, rebind the still-active checkpoint to that new revision, and
leave the checkpoint open so the Agent can follow with `schedule`, another
mutation, or `acknowledge`.

`acknowledge` resolves a normal task-settlement checkpoint without admitting
new work. It is valid only while at least one previously scheduled Run is still
active or at least one later checkpoint is pending. It allows the main Agent
to review parallel settlements in order without manufacturing a new task.
It is never valid for `all_tasks_terminal` or any Goal Review checkpoint. When
neither condition holds, an idle nonterminal execution cannot use it to escape
the convergence watchdog.

`complete` is accepted only from the source session, at a Goal Review
checkpoint, with a current graph revision and a main-Agent-owned
`goal_satisfied` decision. It is the only command that changes the execution
to `completed`. An independent reviewer verdict is recommendation evidence,
not a prerequisite or veto. When the independent verdict is
`more_work_required` or `inconclusive`, the main Agent may still complete only
by recording a nonempty audited disagreement reason.

Command transitions are:

| Command | Wake acknowledged | Checkpoint resolved | Graph revision |
| --- | --- | --- | --- |
| `mutate` | yes | no | increments and rebinds active head |
| `schedule` | yes | yes after exact-set admission | unchanged after validation |
| `acknowledge` | yes | yes | unchanged |
| `complete` | yes | yes | unchanged |

If `mutate` is not followed by a resolving command, the same active checkpoint
remains subject to the five-minute watchdog and receives a later wake sequence.

Every command is idempotent by `(sourceSessionId, kind, issueId, requestId)`.
Reusing an identity with a different payload fails closed.

## Task Settlement

A terminal task Run records its authoritative exact-turn settlement, updates
the task projection, and ensures one durable checkpoint. It does not:

- auto-accept the task
- dispatch a successor
- refill a parallel slot
- retry a failure
- mark the execution complete

The checkpoint immediately prepares a wake for the main Agent. The main Agent
reviews evidence and then uses `mutate`, `schedule`, or, at Goal Review,
`complete`.

To close the crash window in the existing multi-step run settlement path,
startup and periodic reconciliation deterministically repair a missing
checkpoint from terminal Run facts. A post-commit notification may reduce
latency but is not the durability boundary.

The same settlement transaction fences launch recovery: it seals any prepared
or leased launch intent before returning, and repair repeats that seal for
legacy rows even when the checkpoint already exists. Prepared listing,
claiming, and the strict current-owner dispatched CAS all require a running
Run. If an Agent create finishes after another replica made the Run terminal,
the stale delivery is canceled by its exact `issue-run:<runID>` submit
identity; lease reclaim while the Run remains running is reconciled without
canceling the valid Turn. The terminal transaction atomically prepares a
separately leased cancel-compensation operation whenever the launch intent was
leased or dispatched. A failed or interrupted exact cancel therefore remains
durable and startup/periodic recovery retries the same submit identity until
the request is accepted. Retryable cancel outcomes do not fail daemon startup
or prevent other launch and running-Run recovery in that workspace; integrity
or persistence corruption remains fail-closed.

## Durable Wakes and Five-Minute Watchdog

Wakes are durable leased operations. Each records:

- wake identity, checkpoint identity, target kind, and sequence
- deterministic `clientSubmitId`
- target/source session or reviewer target
- canonical Agent session/turn IDs
- `prepared`, `leased`, `dispatched`, `turn_settled`, `acknowledged`, `failed`,
  or `canceled`
- due time, attempts, lease owner/expiry, dispatch timestamps, and last error

A wake is `dispatched` only after Host returns a canonical Turn ID or the
worker recovers that Turn by `clientSubmitId`. Losing the SendInput response
cannot create a duplicate Turn.

A main wake is acknowledged only by a valid checkpoint-fenced main-Agent
command. Merely settling the awakened Turn does not resolve the checkpoint. If
the Agent returns without a command, the execution remains active and a later
wake uses a new sequence and `clientSubmitId`.

The watchdog interval is fixed at five minutes:

- task settlement/failure and valid main-Agent activity reset
  `watchdogDueAt = now + 5m`
- source-session user/Agent turns reset it
- child Agent streaming does not reset it
- a busy source session, open main wake, or active independent review suppresses
  duplicate SendInput while retaining the durable operation
- infrastructure retries use short leases; they do not change the five-minute
  product interval
- startup requeues expired leases and scans every nonterminal execution

The existing 45-minute Run timeout remains a hard safety limit. A timeout
creates a failed settlement checkpoint; it never retries or schedules work.

## Goal Review

When all nonsuperseded tasks are terminal, the execution becomes
`pending_goal_review`; it never becomes `completed` from task counts.

Review modes:

- `self`: the Goal Review checkpoint wakes the source/main Agent
- `independent`: a configured Workspace Agent Target receives a review prompt
  in a dedicated review session

The reviewer reads Issue/task/run/output evidence and submits a structured
verdict:

- `goal_satisfied`
- `more_work_required`
- `inconclusive`

The reviewer is read-only. It cannot mutate the graph, schedule tasks,
complete/archive the execution, or veto a main-Agent decision. A verdict is
persisted as recommendation evidence and prepares a main-Agent wake:

- `goal_satisfied` recommends, but does not perform, main-Agent `complete`
- `more_work_required` asks the main Agent to mutate/schedule
- `inconclusive` fails closed and returns judgment to the main Agent

At the Goal Review checkpoint the main Agent must either mutate/schedule more
work or submit `complete --decision goal_satisfied`. It cannot use generic
`acknowledge`. Overriding a negative or inconclusive independent recommendation
requires an audited disagreement reason visible in the execution history.

Reviewer failure also fails closed. An explicit audited user action may switch
the execution to self review; there is no automatic fallback that silently
weakens review.

Reviewer prompts and verdicts use a dedicated `tutti-goal-review` capability
contract rather than provider-specific review commands. Exact reviewer Turn
identity and verdict operations are durable and recoverable.

## Managed-Issue Mutation Policy

Generic Issue/Task create, update, delete, reorder, acceptance, run, context
reference, dispatch, execution-profile, and budget mutation endpoints reject
Tutti-owned Issues with a typed managed-mutation conflict. Manual and
traditional-plan Issues retain their existing behavior.

The error includes:

- reason `tutti_issue_managed`
- `issueId`
- `sourceSessionId`
- recommended action `open_source_session`

No public boolean bypass exists. Only source-session-scoped orchestration
commands can mutate the graph.

Deleting a Tutti task means logical supersession through `mutate`. The task,
runs, outputs, and audit trail remain queryable.

Issue Manager renders managed Issues as read-only and replaces mutation
controls with “Modify in main conversation”. Its tooltip explains that Tutti
owns the task graph and changes should be described in the source conversation.
The action opens the exact source session, appends a suggested prompt without
overwriting an existing draft, focuses the composer, and never auto-submits.

## Stop and Archive

`Stop and archive execution` is an explicit durable terminal-abandonment
operation, distinct from session deletion and Goal completion.

Archive states are:

```text
requested -> canceling_runs -> archiving -> completed
                                         \-> failed
```

The operation:

1. fences schedule, watchdog, reviewer, and pending wake operations
2. changes the execution to `archiving`
3. pauses every owned Issue
4. cancels every exact running child Turn through Agent Host
5. waits for authoritative settlements and reconciles after restart
6. seals the graph as read-only
7. records `archivedAt`, `archivedBy`, reason, and an audit summary
8. changes the execution to `archived`

Archive never means `goal_satisfied`. Cancellation failure leaves the
execution blocked in `archiving`/failed and the source session remains
protected. Version one has no force-archive escape hatch.

Source-session deletion uses a provider-neutral Host deletion-admission guard
before any runtime close, activation change, selection change, or persistence
deletion. Agent Host remains the sole owner of canonical root/child closure
planning, replanning, runtime close, and tombstoning:

1. Host resolves the exact canonical deletion closure under its existing
   deletion coordinator
2. before closing any runtime, Host presents that exact closure to the
   configured admission guard
3. the Tutti guard performs one workspace transaction that rejects the whole
   closure when a source has a nonterminal execution, or records durable
   deletion fences for the admitted closure
4. execution materialization and source ownership changes check the same fence
   in their creating transaction
5. Host alone closes runtimes and commits canonical tombstones
6. if Host replans a changed closure, it invokes the guard for the new exact
   plan before any additional close; stale admission is superseded/released
7. Host success finalizes Tutti product projections; failure releases or
   durably retries admission without pretending deletion succeeded

This is a provider-neutral Agent lifecycle capability, so its behavior is
specified first in `packages/agent/host/conformance`: guard rejection occurs
before runtime closure and has zero canonical side effects; the guard receives
the exact Host-owned closure; and replan invokes guard again before acting on a
changed closure. Startup reconciles abandoned product admission operations.

If one or more active executions exist, single, batch, and clear operations
fail closed with typed conflict `tutti_execution_active` and the complete
protected Issue list. The conflict has zero runtime, activation, selection, or
persistence side effects. The UI offers:

- Back
- View execution
- Stop and archive execution

After archive completes, deletion is a separate second confirmation and still
uses Agent Host's canonical deletion lifecycle.

## Migration

For existing Tutti Issues:

- do not cancel a currently running Run
- stop all future mechanical dispatch
- create or repair an execution aggregate and migration checkpoint
- preserve existing `autoAccept` data as historical metadata
- when a current Run settles, enter the new checkpoint flow
- if no Run is active, wake the source Agent to review and explicitly schedule
  or finish
- if the source session is missing or tombstoned, mark the execution
  `orphaned_source`, suppress wakes/watchdog, and expose only an audited
  `Stop and archive` action from the managed Issue surface

Version one does not create a shadow source session and does not support
rebinding an orphaned execution. Its only legal convergence path is explicit
archive; its task/run history remains read-only and queryable.

Manual and traditional-plan Issue behavior is unchanged.

## Contract Testing Strategy

Add `services/tuttid/service/tuttimodeexecution/conformance`. Scenarios program
only against a public orchestration Driver contract. At least one driver uses
real SQLite persistence plus service ports; transport tests separately verify
HTTP/CLI mapping.

Required scenarios:

1. plan materialization is inert and requires explicit initial schedule
2. schedule atomically admits exactly the requested valid Run set, then
   recovers each external launch independently
3. wrong source caller, stale checkpoint/revision, and conflicting replay fail
4. every terminal outcome produces one checkpoint and no successor dispatch
5. all-terminal graphs enter Goal Review and never auto-complete
6. reviewer verdict is advisory; only the source Agent can mutate/complete
7. fixed five-minute debounce resets correctly and suppresses duplicate wakes
8. response loss and daemon restart recover one canonical wake Turn
9. a settled wake Turn without a command remains unacknowledged and wakes later
10. two parallel settlements queue two ordered reviews without overwriting
    either checkpoint
11. two already-terminal parallel Runs can be acknowledged in order until Goal
    Review becomes active
12. mutate increments the revision while retaining the active checkpoint, then
    schedule resolves it using the returned revision
13. Goal Review rejects generic acknowledge and resolves only through more work
    or main-Agent complete
14. a main Agent can override negative/inconclusive independent review only
    with an audited disagreement reason
15. generic managed-Issue mutations fail while manual/traditional behavior
    remains unchanged
16. logical supersession preserves task/run history
17. archive fences new work, cancels exact Runs, waits for settlement, and
    survives restart
18. active source deletion/batch/clear has zero side effects and returns typed
    conflict
19. Host invokes the deletion guard with its exact closure before runtime close
    and invokes it again on replan
20. a deletion admission fence excludes concurrent execution materialization
    and delegates canonical closure/tombstoning to Host
21. archived/completed source deletion delegates to Host successfully
22. migrated missing-source executions become `orphaned_source`, never create
    a shadow session, and can only be explicitly archived
23. terminal Run/checkpoint crash windows are repaired deterministically

Data tests cover migrations, constraints, deterministic identities, lease
expiry/requeue, graph CAS, atomic archive fencing, and rollback. UI component
tests cover read-only controls, navigation/prompt append, protected deletion,
and archive progress. OpenAPI/CLI contract tests cover typed requests,
responses, conflicts, and caller identity.

## Documentation Impact

The implementation updates:

- `docs/architecture/workspace-workflows.md`
- `docs/architecture/workspace-issue-manager.md`
- `docs/architecture/agent-gui-node.md`
- CLI/API documentation generated from the changed contracts

Agent Host documentation changes only if implementation discovers a genuinely
missing provider-neutral Host capability.
