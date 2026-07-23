# Issue Execution Coordination

Issue execution combines two independent domains:

- Workspace Issue owns Issue, Task, Run, dependency, acceptance, budget, and
  dispatch-pause facts.
- Agent Host owns Session, Turn, runtime-operation, terminal outcome, and
  lifecycle recovery semantics.

Neither domain mirrors the other's state. `IssueExecutionCoordinator` in
`services/tuttid/service/workspace` is the product-owned integration seam that
maps user intent and canonical Agent facts into Issue commands.

## Execution flow

Dispatch is split into two phases:

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
- Agent Host: Session and Turn lifecycle

UI and orchestration phases are derived from those facts. New boolean flags
must not be used to simulate transactions or hide incomplete cross-domain
operations.

## Recovery

The reconciliation queue is daemon-context-bound and retries transient
failures. It is a fallback for delayed or missed projection delivery, not the
authority for Agent lifecycle semantics. Product timeouts may fail an Issue
Run, but Agent terminal outcomes should come from exact canonical Turn facts.
