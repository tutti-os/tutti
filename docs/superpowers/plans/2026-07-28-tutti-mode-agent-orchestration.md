# Tutti Mode Agent-Orchestrated Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace mechanical Tutti task chaining with a durable, source-Agent-owned execution workflow, including exact scheduling, task and Goal Review checkpoints, a fixed five-minute watchdog, managed-Issue protections, and explicit stop-and-archive before source-session deletion.

**Architecture:** Add a daemon-owned Tutti execution aggregate and conformance suite under `services/tuttid`; use Agent Host only for canonical Session/Turn lifecycle. All product transitions are persisted before external delivery, fenced by graph/checkpoint revisions, and recovered by leased workers. Generic Issue Manager remains unchanged for manual/traditional Issues and becomes read-only for Tutti-owned Issues.

**Tech Stack:** Go, SQLite, Agent Host conformance, Tutti daemon CLI/OpenAPI, TypeScript/React, Vitest/Testing Library, pnpm repository checks.

---

## File Structure

New backend ownership:

- `services/tuttid/biz/tuttimodeexecution/model.go`: execution, checkpoint, wake, review, archive, and mutation identities
- `services/tuttid/service/tuttimodeexecution/service.go`: public product command contract and orchestration invariants
- `services/tuttid/service/tuttimodeexecution/worker.go`: leased wake/review/watchdog/archive recovery
- `services/tuttid/service/tuttimodeexecution/prompts.go`: main/reviewer prompt construction
- `services/tuttid/service/tuttimodeexecution/conformance/*`: black-box product scenarios over a narrow Driver
- `services/tuttid/data/workspace/migrations_tutti_mode_execution.go`: additive durable schema and migration
- `services/tuttid/data/workspace/sqlite_tutti_mode_execution.go`: transactions, CAS, leases, and recovery queries

Existing integration owners:

- `packages/agent/host/*`: provider-neutral deletion-admission guard only
- `packages/workspace/issues/*`: managed mutation invariant and logical supersession model
- `services/tuttid/service/workspace/*`: exact Run admission/launch and settlement facts
- `services/tuttid/service/tuttimodeplan/*`: inert materialization and execution creation
- `services/tuttid/service/cli/providers/tuttimodeplan/*`: source-scoped commands
- `services/tuttid/api/*` plus OpenAPI fragments: typed query, conflict, archive, and deletion contracts
- `packages/workspace/issue-manager/*`: managed read-only UI and source-session navigation
- `packages/agent/gui/*` and `apps/desktop/*`: protected deletion and exact-session composer activation

Before every focused `go test` command that includes `services/tuttid`, run
`pnpm generate:builtin-apps`. This is a prerequisite, not an additional final
validation lane.

## Task 1: Host Deletion-Admission Guard

**Files:**

- Modify: `packages/agent/host/types.go`
- Modify: `packages/agent/host/host.go`
- Modify: `packages/agent/host/session_management.go`
- Modify: `packages/agent/host/conformance/conformance.go`
- Modify: `packages/agent/host/conformance/session_management_scenarios.go`
- Modify: `packages/agent/host/session_batch_management_test.go`
- Modify: `packages/agent/host/README.md`
- Modify: `services/tuttid/service/agent/host_conformance_test.go`

- [ ] **Step 1: Write failing Host conformance scenarios**

Add scenarios that program only against the Host Driver:

```go
func runDeleteSessionAdmissionRejected(ctx context.Context, driver Driver) error
func runDeleteSessionsAdmissionReplanned(ctx context.Context, driver Driver) error
```

Assert rejection occurs before any runtime close or store deletion, receives the
exact Host-owned closure, and a changed deletion plan is guarded before new
closure members are closed.

- [ ] **Step 2: Run conformance tests and verify RED**

Run:

```bash
pnpm generate:builtin-apps
go test ./packages/agent/host/conformance ./packages/agent/host ./services/tuttid/service/agent -run 'Delete.*Admission|HostConformance' -count=1
```

Expected: FAIL because Host has no deletion-admission guard contract.

- [ ] **Step 3: Add the minimal provider-neutral Host seam**

Introduce a contract shaped like:

```go
type DeleteSessionsAdmission interface {
    AdmitDeleteSessions(context.Context, DeleteSessionsPlan) error
    CompleteDeleteSessions(context.Context, DeleteSessionsPlan, error)
}
```

Host resolves the plan, calls admission before runtime close, and reports the
attempt outcome. On `ErrDeleteSessionsPlanChanged`, Host replans and calls the
guard for the changed exact closure before closing any additional runtime.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Run Agent Host boundary checks**

Run:

```bash
pnpm check:agent-host-boundary
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/host services/tuttid/service/agent
git commit -s -m "feat(agent): guard session deletion admission"
```

## Task 2: Durable Execution Aggregate and Inert Materialization

**Files:**

- Create: `services/tuttid/biz/tuttimodeexecution/model.go`
- Create: `services/tuttid/biz/tuttimodeexecution/normalize.go`
- Create: `services/tuttid/service/tuttimodeexecution/service.go`
- Create: `services/tuttid/service/tuttimodeexecution/conformance/driver.go`
- Create: `services/tuttid/service/tuttimodeexecution/conformance/catalog.go`
- Create: `services/tuttid/service/tuttimodeexecution/conformance/materialization_scenarios.go`
- Create: `services/tuttid/service/tuttimodeexecution/conformance_test.go`
- Create: `services/tuttid/data/workspace/migrations_tutti_mode_execution.go`
- Create: `services/tuttid/data/workspace/sqlite_tutti_mode_execution.go`
- Create: `services/tuttid/data/workspace/sqlite_tutti_mode_execution_test.go`
- Modify: `services/tuttid/data/workspace/migrations.go`
- Modify: `services/tuttid/data/workspace/store.go`
- Modify: `services/tuttid/service/tuttimodeplan/issue_materializer.go`
- Modify: `services/tuttid/service/tuttimodeplan/issue_materializer_test.go`
- Modify: `services/tuttid/service/workspace/issues.go`
- Modify: `services/tuttid/service/workspace/issue_sequential_dispatch_test.go`
- Modify: `services/tuttid/wiring.go`

- [ ] **Step 1: Define the conformance Driver and RED materialization scenario**

The scenario must accept/materialize a plan through the public service seam and
assert:

```go
snapshot.Execution.Status == awaiting_schedule
snapshot.Execution.GraphRevision == 1
len(snapshot.Checkpoints) == 1
snapshot.Checkpoints[0].Reason == initial_schedule
len(snapshot.Runs) == 0
launcher.Calls() == 0
```

- [ ] **Step 2: Run the scenario and verify RED**

Run:

```bash
pnpm generate:builtin-apps
go test ./services/tuttid/service/tuttimodeexecution ./services/tuttid/service/tuttimodeplan ./services/tuttid/service/workspace -run 'Materializ|InitialSchedule|AutoAcceptTaskCompletionAdvancesDispatch' -count=1
```

Expected: FAIL because materialization still dispatches automatically and no
execution aggregate exists.

- [ ] **Step 3: Add schema and aggregate transactions**

Create additive tables:

```text
workspace_tutti_executions
workspace_tutti_execution_checkpoints
workspace_tutti_execution_wakes
workspace_tutti_goal_reviews
workspace_tutti_archive_operations
workspace_tutti_execution_mutations
workspace_source_session_deletion_admissions
workspace_issue_run_launch_intents
```

Use CHECK constraints, deterministic uniqueness, foreign keys scoped by
workspace/Issue, graph revision CAS, and lease columns. Add migration tests for
fresh and upgraded databases.

- [ ] **Step 4: Make Tutti plan materialization inert**

Create the Issue/tasks and execution initial state without calling
`dispatchEligibleIssueTasks`. Preserve existing behavior for manual and
traditional-plan Issues.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command plus:

```bash
pnpm generate:builtin-apps
go test ./services/tuttid/data/workspace -run 'TuttiModeExecution|WorkspaceIssues' -count=1
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/tuttid/biz/tuttimodeexecution services/tuttid/service/tuttimodeexecution services/tuttid/data/workspace services/tuttid/service/tuttimodeplan services/tuttid/service/workspace services/tuttid/wiring.go
git commit -s -m "feat(tutti-mode): persist inert execution aggregate"
```

## Task 3: Source-Scoped Exact-Set Scheduling

**Files:**

- Create: `services/tuttid/service/workspace/issue_scheduled_dispatch.go`
- Create: `services/tuttid/data/workspace/sqlite_issue_run_admission.go`
- Modify: `packages/workspace/issues/store.go`
- Modify: `services/tuttid/data/workspace/sqlite_issues.go`
- Modify: `services/tuttid/service/tuttimodeexecution/service.go`
- Create: `services/tuttid/service/tuttimodeexecution/conformance/schedule_scenarios.go`
- Modify: `services/tuttid/service/cli/providers/tuttimodeplan/provider.go`
- Modify: `services/tuttid/service/cli/providers/tuttimodeplan/commands.go`
- Modify: `services/tuttid/service/cli/providers/tuttimodeplan/provider_test.go`
- Modify: `packages/agent/daemon/runtime/tutti_mode_host_context.go`
- Modify: `packages/agent/daemon/runtime/tutti_mode_host_context_test.go`

- [ ] **Step 1: Add RED conformance scenarios**

Cover:

- source caller schedules A and C and no B Run is admitted
- wrong caller, stale revision/checkpoint, invalid dependency, over-capacity,
  or duplicate task ID rejects the whole set without Run mutation
- same `requestId` and payload replays the same result
- same identity with a different payload conflicts

- [ ] **Step 2: Run schedule scenarios and verify RED**

Run:

```bash
pnpm generate:builtin-apps
go test ./services/tuttid/service/tuttimodeexecution ./services/tuttid/service/workspace ./services/tuttid/service/cli/providers/tuttimodeplan -run 'Schedule|ExactSet|Caller' -count=1
```

Expected: FAIL because source-scoped scheduling does not exist.

- [ ] **Step 3: Implement atomic admission and recoverable launch intents**

Validate the whole requested set under the Issue mutation lock, then one SQLite
transaction creates all Runs, task-running projections, launch intents, and
resolves the active checkpoint. Launch outside the transaction. Reconcile
undelivered intents by deterministic `issue-run:<runId>` identity.

- [ ] **Step 4: Add `tutti plan issue schedule`**

Read caller identity only from `invoke.Request.Context.AgentSessionID`. Do not
accept a caller session flag. Parse `task-ids-json`, require request/checkpoint
and revision, and emit execution/checkpoint/revision/Run IDs in JSON.

- [ ] **Step 5: Rewrite Tutti host context**

Remove guidance that `autoAccept` causes automatic successors. Explain that the
source Agent must inspect the checkpoint and invoke exact schedule commands.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/workspace/issues packages/agent/daemon/runtime services/tuttid
git commit -s -m "feat(tutti-mode): require explicit task scheduling"
```

## Task 4: Settlement Checkpoint Backlog and Durable Main Wakes

**Files:**

- Create: `services/tuttid/service/tuttimodeexecution/checkpoints.go`
- Create: `services/tuttid/service/tuttimodeexecution/wakes.go`
- Create: `services/tuttid/service/tuttimodeexecution/prompts.go`
- Create: `services/tuttid/service/tuttimodeexecution/conformance/settlement_scenarios.go`
- Create: `services/tuttid/service/tuttimodeexecution/conformance/wake_scenarios.go`
- Modify: `services/tuttid/service/workspace/issues_runs.go`
- Modify: `services/tuttid/service/workspace/issue_run_observer.go`
- Modify: `services/tuttid/service/workspace/issues_reconciler.go`
- Modify: `services/tuttid/data/workspace/sqlite_tutti_mode_execution.go`
- Modify: `services/tuttid/tutti_mode_issue_completion_dispatcher.go`
- Modify: `services/tuttid/service/cli/providers/tuttimodeplan/provider.go`
- Modify: `services/tuttid/service/cli/providers/tuttimodeplan/commands.go`
- Modify: `services/tuttid/service/cli/providers/tuttimodeplan/provider_test.go`
- Modify: `services/tuttid/wiring.go`

- [ ] **Step 1: Add RED settlement/backlog scenarios**

For completed, failed, canceled, and timed-out Runs assert one deterministic
checkpoint, zero successor Runs, and no `autoAccept` bypass. Settle two parallel
Runs before review and assert one active plus one pending checkpoint in order.
Replay the terminal observation and assert no duplicate checkpoint/wake. An
external launch failure after Task 3 admission must become an authoritative
failed Run/checkpoint.

- [ ] **Step 2: Add RED delivery-loss scenarios**

Assert a prepared wake survives restart, a lost SendInput response recovers the
same Turn via `clientSubmitId`, a busy source keeps the wake prepared, and a
settled main Turn without command remains unacknowledged.

Also add RED scenarios for:

- two parallel Runs that are both terminal before review, acknowledged in order
  until Goal Review becomes active
- deterministic repair of a terminal Run persisted without its checkpoint

- [ ] **Step 3: Run and verify RED**

Run:

```bash
pnpm generate:builtin-apps
go test ./services/tuttid/service/tuttimodeexecution ./services/tuttid/service/workspace -run 'Settlement|Checkpoint|Wake|ResponseLoss' -count=1
```

Expected: FAIL because the current notifier is fire-and-forget/in-memory.

- [ ] **Step 4: Implement ordered checkpoint transitions**

Terminal Run facts append deterministic checkpoints. Exactly one head is
active; resolution promotes the next. Add deterministic repair from terminal
Runs at startup/periodic reconciliation to close transaction crash windows.

- [ ] **Step 5: Replace the in-memory completion dispatcher**

Persist wake first, lease it, check canonical source liveness, call Agent
service with deterministic client submit ID, and recover canonical Turn
identity before marking dispatched. Delete in-memory dedupe authority and all
automatic successor calls for Tutti Issues.

- [ ] **Step 6: Add acknowledge service and public CLI command**

`acknowledge` resolves normal checkpoints only when another Run or checkpoint
exists and never resolves Goal Review. Register and test
`tutti plan issue acknowledge`; derive caller identity from invoke context and
cover same-payload replay plus conflicting-payload rejection. Task 7 owns the
complete transactional `mutate` command, including mutate-then-schedule.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the Step 3 command. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add services/tuttid/service/tuttimodeexecution services/tuttid/service/workspace services/tuttid/data/workspace services/tuttid/tutti_mode_issue_completion_dispatcher.go services/tuttid/wiring.go
git commit -s -m "feat(tutti-mode): checkpoint every task settlement"
```

## Task 5: Fixed Five-Minute Watchdog and Startup Recovery

**Files:**

- Create: `services/tuttid/service/tuttimodeexecution/worker.go`
- Create: `services/tuttid/service/tuttimodeexecution/conformance/watchdog_scenarios.go`
- Create: `services/tuttid/service/tuttimodeexecution/worker_test.go`
- Modify: `services/tuttid/data/workspace/sqlite_tutti_mode_execution.go`
- Modify: `services/tuttid/app/app.go`
- Modify: `services/tuttid/wiring.go`
- Modify: `services/tuttid/service/agent/service_send_input.go`
- Modify: `services/tuttid/service/agent/activity_projection.go`
- Modify: `services/tuttid/service/agent/model_plan_binding.go`
- Modify: `services/tuttid/wiring_daemon_api.go`

- [ ] **Step 1: Add RED clock-driven contract scenarios**

Use an injected clock, never sleeps. Assert:

- due time is exactly last relevant activity plus five minutes
- task settlement and source user/Agent activity reset it
- child streaming does not reset it
- active source Turn/open wake/reviewer suppresses duplicate SendInput
- main Turn with no command produces a new wake sequence after five minutes
- expired leases requeue on startup with the same operation identity

- [ ] **Step 2: Run and verify RED**

Run:

```bash
pnpm generate:builtin-apps
go test ./services/tuttid/service/tuttimodeexecution ./services/tuttid/service/agent -run 'Watchdog|ActivityReset|Lease|Startup' -count=1
```

Expected: FAIL because no durable watchdog worker exists.

- [ ] **Step 3: Implement the worker**

Claim due rows with bounded leases, perform short infrastructure retries, and
keep the product interval fixed at five minutes. Publish events only after
durable transitions.

- [ ] **Step 4: Wire source activity observation**

Reset only executions whose exact source session changed. Do not alter Host
session lifecycle rules.

- [ ] **Step 5: Run focused and race tests**

Run:

```bash
pnpm generate:builtin-apps
go test ./services/tuttid/service/tuttimodeexecution ./services/tuttid/service/agent -run 'Watchdog|ActivityReset|Lease|Startup' -count=1
go test -race ./services/tuttid/service/tuttimodeexecution -count=1
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add services/tuttid/service/tuttimodeexecution services/tuttid/service/agent services/tuttid/data/workspace services/tuttid/app services/tuttid/wiring.go
git commit -s -m "feat(tutti-mode): add durable execution watchdog"
```

## Task 6: Goal Review and Independent Reviewer

**Files:**

- Create: `services/tuttid/service/tuttimodeexecution/reviews.go`
- Create: `services/tuttid/service/tuttimodeexecution/reviewer_launcher.go`
- Create: `services/tuttid/service/tuttimodeexecution/conformance/review_scenarios.go`
- Create: `services/tuttid/service/cli/providers/tuttigoalreview/provider.go`
- Create: `services/tuttid/service/cli/providers/tuttigoalreview/commands.go`
- Create: `services/tuttid/service/cli/providers/tuttigoalreview/provider_test.go`
- Modify: `services/tuttid/service/tuttimodeexecution/prompts.go`
- Modify: `services/tuttid/data/workspace/sqlite_tutti_mode_execution.go`
- Modify: `services/tuttid/service/tuttimodeplan/markdown.go`
- Modify: `services/tuttid/service/tuttimodeplan/markdown_test.go`
- Modify: `services/tuttid/service/tuttimodeplan/issue_materializer.go`
- Modify: `services/tuttid/service/cli/providers/tuttimodeplan/commands.go`
- Modify: `services/tuttid/service/cli/providers/tuttimodeplan/provider_test.go`
- Modify: `packages/agent/daemon/runtime/tutti_mode_host_context.go`
- Modify: `services/tuttid/api/openapi/tuttid.v1.yaml`
- Modify: `services/tuttid/api/daemon_agent_sessions.go`
- Modify: `services/tuttid/api/daemon_test.go`
- Modify: `services/tuttid/wiring.go`

- [ ] **Step 1: Add RED Goal Review scenarios**

Assert:

- all-terminal enters `pending_goal_review`, never completed
- Goal Review cannot use generic acknowledge
- self review requires main `complete --decision goal_satisfied`
- independent reviewer submits structured recommendation only
- reviewer cannot mutate/schedule/complete
- negative/inconclusive recommendation requires a nonempty audited main
  disagreement reason before completion
- reviewer failure returns control to main and never completes
- reviewer receives only a dedicated verdict capability, never source-main
  schedule/mutate/acknowledge/complete capabilities
- an explicit user action can switch a failed independent review to self
  review, records an audit entry, and never happens automatically

- [ ] **Step 2: Run and verify RED**

Run:

```bash
pnpm generate:builtin-apps
go test ./services/tuttid/service/tuttimodeexecution ./services/tuttid/service/tuttimodeplan ./services/tuttid/service/cli/providers/tuttimodeplan ./services/tuttid/service/cli/providers/tuttigoalreview ./services/tuttid/api -run 'GoalReview|Reviewer|CompleteDecision' -count=1
```

Expected: FAIL because Goal Review is not durable.

- [ ] **Step 3: Implement review state and exact reviewer Turns**

Store reviewer operations and recommendations. Launch independent review via
Agent Host with a dedicated deterministic session/submit identity. Require the
reviewer to call a structured verdict command; never parse prose. Build and
wire a verdict-only `tutti-goal-review` provider/capability; its review session
must not receive any main orchestration command.

- [ ] **Step 4: Add review configuration to plan schema**

Add:

```yaml
review:
  mode: self # or independent
  agentTargetId: ""
```

Validate target requirements and materialize them onto the execution aggregate.
Keep omitted mode defaulting to `self`.

- [ ] **Step 5: Add complete, verdict, and explicit fallback contracts**

Main identity comes from invoke context. Reviewer identity is matched to the
durable review operation/session. Emit verdict evidence and audit fields.
Register `tutti plan issue complete` with same-payload replay and
conflicting-payload tests. Add an audited HTTP/service action for a user to
switch one failed independent review to self review; worker failure must never
invoke it automatically.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add services/tuttid packages/agent/daemon/runtime
git commit -s -m "feat(tutti-mode): require explicit goal review"
```

## Task 7: Managed-Issue Mutation Protection and Logical Supersession

**Files:**

- Modify: `packages/workspace/issues/errors.go`
- Modify: `packages/workspace/issues/model.go`
- Modify: `packages/workspace/issues/service_issues.go`
- Modify: `packages/workspace/issues/service_tasks.go`
- Modify: `packages/workspace/issues/service_test.go`
- Modify: `services/tuttid/service/workspace/issues.go`
- Modify: `services/tuttid/service/workspace/issues_runs.go`
- Modify: `services/tuttid/api/daemon_issue_errors.go`
- Modify: `packages/workspace/issue-manager/openapi/issue-manager.v1.yaml`
- Modify: `services/tuttid/api/workspace/issues_test.go`
- Modify: `services/tuttid/service/cli/providers/issuemanager/provider_test.go`
- Modify: `services/tuttid/service/cli/providers/tuttimodeplan/provider.go`
- Modify: `services/tuttid/service/cli/providers/tuttimodeplan/commands.go`
- Modify: `services/tuttid/service/cli/providers/tuttimodeplan/provider_test.go`
- Modify: `services/tuttid/service/tuttimodeexecution/service.go`
- Create: `services/tuttid/service/tuttimodeexecution/conformance/mutation_scenarios.go`

- [ ] **Step 1: Add RED public mutation matrix**

Table-drive every generic Issue/task graph mutation and bypass:

```text
issue update/delete
task create/update/delete/reorder/accept/rework
context-ref add/remove
run create/cancel
dispatch/profile/budget mutation
```

Tutti-owned returns typed managed conflict; manual/traditional retains current
behavior. Orchestrator-scoped mutate succeeds only for the exact source caller,
checkpoint, and revision.

- [ ] **Step 2: Add RED supersession scenario**

Assert superseded tasks, Runs, outputs, and audit remain queryable; completed
tasks are immutable; running tasks require cancel/settlement first.

Add a RED mutate-then-schedule scenario: mutate increments and rebinds the
active checkpoint revision, a later schedule with the returned revision
resolves it, stale revision rejects, same request/payload replays, and a
conflicting payload fails closed.

- [ ] **Step 3: Run and verify RED**

Run:

```bash
pnpm generate:builtin-apps
go test ./packages/workspace/issues ./services/tuttid/service/workspace ./services/tuttid/service/tuttimodeexecution ./services/tuttid/api ./services/tuttid/service/cli/providers/issuemanager ./services/tuttid/service/cli/providers/tuttimodeplan -run 'Managed|Mutation|Supersed' -count=1
```

Expected: FAIL because generic mutation is currently allowed.

- [ ] **Step 4: Add the domain invariant and typed wire error**

Use one sentinel carrying Issue/source details. Generic adapters return 409 with
`tutti_issue_managed` and `open_source_session`. Do not add a bypass boolean.

- [ ] **Step 5: Implement transactional orchestrator mutation**

Apply add/update/rework/supersede operations all-or-none, record idempotent
mutation identity, increment graph revision, supersede stale Goal Review, and
retain the active checkpoint.

Register and test `tutti plan issue mutate`. Derive caller identity from invoke
context and cover caller fencing plus the replay/conflict/revision behavior
from Step 2.

- [ ] **Step 6: Regenerate clients and run focused tests**

Use repository generation command discovered from the OpenAPI fragment's
nearest README/package scripts, then rerun Step 3. Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/workspace services/tuttid
git commit -s -m "feat(issue-manager): protect Tutti-managed graphs"
```

## Task 8: Stop-and-Archive and Race-Free Source Deletion

**Files:**

- Create: `services/tuttid/service/tuttimodeexecution/archive.go`
- Create: `services/tuttid/service/tuttimodeexecution/deletion_admission.go`
- Create: `services/tuttid/service/tuttimodeexecution/conformance/archive_scenarios.go`
- Create: `services/tuttid/service/tuttimodeexecution/conformance/deletion_scenarios.go`
- Modify: `services/tuttid/service/workspace/issue_execution_coordinator.go`
- Modify: `services/tuttid/service/agent/source_session_deletion.go`
- Modify: `services/tuttid/service/agent/service_session_sections.go`
- Modify: `services/tuttid/service/tuttimodeplan/source_session_deletion.go`
- Modify: `services/tuttid/data/workspace/source_session_deletion.go`
- Modify: `services/tuttid/data/workspace/sqlite_tutti_mode_execution.go`
- Modify: `services/tuttid/api/openapi/tuttid.v1.yaml`
- Modify: `services/tuttid/api/daemon_agent_session_errors.go`
- Modify: `services/tuttid/api/daemon_agent_sessions.go`
- Modify: `services/tuttid/api/daemon_test.go`
- Modify: `services/tuttid/wiring_daemon_api.go`

- [ ] **Step 1: Add RED archive scenarios**

Cover idempotent request, schedule/wake/reviewer fence, exact Run cancellation,
waiting for authoritative settlements, cancel failure fail-closed, restart
recovery, completed archive metadata, and no force archive.

- [ ] **Step 2: Add RED deletion-admission scenarios**

Assert:

- active single/batch/clear rejects before runtime close with zero side effects
- whole batch fails when one source is protected
- admitted closure creates a durable fence that blocks concurrent execution
  materialization
- archived/completed sources delegate canonical deletion to Host
- Host replan re-guards the changed exact closure

- [ ] **Step 3: Run and verify RED**

Run:

```bash
pnpm generate:builtin-apps
go test ./services/tuttid/service/tuttimodeexecution ./services/tuttid/service/agent ./services/tuttid/service/tuttimodeplan ./services/tuttid/api -run 'Archive|DeletionAdmission|ProtectedSource' -count=1
```

Expected: FAIL because current deletion implicitly cancels after runtime close.

- [ ] **Step 4: Implement the durable archive saga**

Fence operations, pause Issues, cancel exact Turns, wait/reconcile settlements,
seal history, and record archive audit before allowing deletion.

- [ ] **Step 5: Install the Host deletion-admission adapter**

Remove adapter-side pre-closing. Host plans the closure and invokes the durable
Tutti guard before closing. Finalize product cleanup only after Host success.

- [ ] **Step 6: Add typed HTTP contracts**

Add archive operation POST/query and `tutti_execution_active` 409 details.
Regenerate relevant clients.

- [ ] **Step 7: Run focused tests and verify GREEN**

Run the Step 3 command and Task 1 Host conformance command. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/agent/host services/tuttid
git commit -s -m "feat(tutti-mode): archive execution before source deletion"
```

## Task 9: Managed Issue and Protected Deletion UX

**Files:**

- Modify: `packages/workspace/issue-manager/src/services/internal/model.ts`
- Modify: `packages/workspace/issue-manager/src/ui/internal/shell/IssueManagerPanels.tsx`
- Modify: `packages/workspace/issue-manager/src/ui/internal/shell/IssueManagerTaskDrawerSections.tsx`
- Modify: `packages/workspace/issue-manager/src/ui/internal/orchestration/IssueManagerOrchestrationFields.tsx`
- Modify: `packages/workspace/issue-manager/src/i18n/issueManagerI18n.ts`
- Create: `packages/workspace/issue-manager/src/ui/internal/orchestration/ManagedTuttiIssueActions.tsx`
- Create: `packages/workspace/issue-manager/src/ui/internal/orchestration/ManagedTuttiIssueActions.test.ts`
- Modify: `packages/workspace/issue-manager/src/ui/react/internal/controller/useIssueManagerController.ts`
- Modify: `packages/workspace/issue-manager/src/index.ts`
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/TuttiWorkflowDock.tsx`
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/TuttiWorkflowDock.spec.tsx`
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUIConversationDeletion.ts`
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUIConversationDeletion.spec.tsx`
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUIConversationBatchDeletion.ts`
- Modify: `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUIConversationBatchDeletion.spec.tsx`
- Modify: `packages/agent/gui/app/renderer/i18n/locales/en.agentGui.ts`
- Modify: `packages/agent/gui/app/renderer/i18n/locales/zh-CN.agentGui.ts`
- Modify: `packages/agent/gui/app/renderer/i18n/locales/en.agentGuiSessionActions.ts`
- Modify: `packages/agent/gui/app/renderer/i18n/locales/zh-CN.agentGuiSessionActions.ts`
- Modify: `apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceIssueManagerContribution.ts`
- Modify: `apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentGUIOpenSessionActivation.ts`
- Create: `apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentGUIOpenSessionComposerActivation.ts`
- Create: `apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentGUIOpenSessionComposerActivation.test.ts`
- Modify: `apps/desktop/src/renderer/src/features/workspace-agent/ui/DesktopAgentGUIWorkbenchBody.tsx`

- [ ] **Step 1: Add RED managed-Issue component tests**

Assert Tutti Issue/task surfaces render no edit/delete/create/run/accept/context
mutation controls and render a read-only badge, tooltip, and “Modify in main
conversation”. Manual/traditional rendering remains unchanged.

- [ ] **Step 2: Add RED exact-session composer activation tests**

Assert navigation selects the exact `sourceSessionId`, appends an Issue/task
reference prompt without overwriting a nonempty draft, focuses composer, and
never auto-submits.

- [ ] **Step 3: Add RED protected-deletion tests**

Assert typed conflict does not unactivate, switch Home, close runtime, or remove
the rail item. Render Back/View/Stop-and-archive. After archive completion,
require a separate delete confirmation. Batch is fail-closed. Also test the
explicit user action that switches a failed independent review to self review
and renders its audit/result state.

- [ ] **Step 4: Run and verify RED**

Run package-local test scripts discovered from:

```bash
pnpm --filter @tutti-os/workspace-issue-manager test
pnpm --filter @tutti-os/agent-gui test
pnpm --filter @tutti-os/desktop test
```

Expected: failing new behavior assertions.

- [ ] **Step 5: Implement with existing UI System primitives and i18n**

Reuse Tooltip, Button, Badge, Dialog, semantic tokens, typography, and spacing.
Do not hardcode user-visible copy or raw colors. Chinese copy must not end with
`。`.

- [ ] **Step 6: Run focused tests and i18n validation**

Run the Step 4 commands plus:

```bash
pnpm check:i18n
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/workspace/issue-manager packages/agent/gui apps/desktop
git commit -s -m "feat(issue-manager): route managed edits to source agent"
```

## Task 10: Migration, Durable Documentation, and Final Integration

**Files:**

- Create/Modify: migration tests under `services/tuttid/data/workspace`
- Modify: `services/tuttid/service/tuttimodeexecution/conformance/*`
- Modify: `docs/architecture/workspace-workflows.md`
- Modify: `docs/architecture/workspace-issue-manager.md`
- Modify: `docs/architecture/agent-gui-node.md`
- Modify: `docs/architecture/issue-execution.md`
- Modify: relevant CLI/API generated documentation

- [ ] **Step 1: Add RED legacy migration scenarios**

Cover:

- active legacy Run continues but cannot auto-dispatch a successor
- idle legacy execution gets a migration checkpoint/wake
- historical `autoAccept` is preserved but ignored
- missing/tombstoned source becomes `orphaned_source`
- orphaned source creates no shadow session/wake/watchdog and can only archive

- [ ] **Step 2: Run migration/conformance suite and verify RED**

Run:

```bash
pnpm generate:builtin-apps
go test ./services/tuttid/service/tuttimodeexecution ./services/tuttid/data/workspace -run 'Migration|Legacy|OrphanedSource' -count=1
```

Expected: FAIL until startup migration/reconciliation is implemented.

- [ ] **Step 3: Implement migration and startup repair**

Backfill execution rows deterministically, preserve running Runs, create one
migration checkpoint, and classify missing sources without inventing sessions.

- [ ] **Step 4: Update durable architecture docs**

Document ownership, data flow, source-session deletion guard, read-only UX,
explicit scheduling, checkpoint backlog, watchdog, Goal Review, archive, and
validation commands. Remove obsolete claims about automatic dispatch or
implicit source deletion cancellation.

- [ ] **Step 5: Run focused suites**

Run:

```bash
pnpm generate:builtin-apps
go test ./packages/agent/host/conformance ./packages/agent/host ./services/tuttid/service/agent ./services/tuttid/service/tuttimodeplan ./services/tuttid/service/tuttimodeexecution ./services/tuttid/service/workspace ./services/tuttid/data/workspace ./services/tuttid/api -count=1
pnpm --filter @tutti-os/workspace-issue-manager test
pnpm --filter @tutti-os/agent-gui test
```

Expected: PASS.

- [ ] **Step 6: Run final architecture review**

Use `tutti-architecture-review` on the complete diff. Fix all blocking ownership,
boundary, lifecycle, generated-contract, and documentation findings, then rerun
only the directly affected focused tests.

- [ ] **Step 7: Inspect changed-aware validation plan**

Run:

```bash
pnpm check:changed -- --dry-run
```

Confirm it selects Go tests/lint/build, TypeScript tests/typecheck, Host boundary,
OpenAPI/generated contract, and i18n lanes. Add only a required standalone lane
that the dry-run omits.

- [ ] **Step 8: Run the single final changed-aware validation**

Run:

```bash
pnpm check:changed
```

If it fails, fix and use:

```bash
pnpm check:changed -- --failed-only
```

Expected: PASS with no failed lanes.

- [ ] **Step 9: Commit**

```bash
git add services/tuttid packages/agent packages/workspace apps/desktop docs
git commit -s -m "docs(tutti-mode): document agent-orchestrated execution"
```
