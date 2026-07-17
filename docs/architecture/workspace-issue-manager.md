# Workspace Issue Manager

This document records the reusable issue-manager architecture shared by
`tutti` and `tsh`.

The TypeScript package `packages/workspace/issue-manager` is the current public
frontend/package surface for this boundary. Complementary daemon-side or Go
domain packaging may continue to evolve behind the same host-adapter model.

## Direction

The issue manager is a workspace-domain capability that should be implemented
as reusable packages plus host adapters.

The shared domain model is:

```text
Issue -> Task -> Run
```

- `Issue` is the top-level work item or theme inside one workspace.
- `Task` is an executable unit under an issue.
- `Run` is one agent execution attempt for a task.

Workbench integration should expose this capability as an issue manager node.
The node kind should be `issueManager`, and React-facing names should use
`IssueManagerNode` / `IssueManagerWorkbenchFeature`.

## Package Split

Use two thick packages:

```text
packages/workspace/issues
packages/workspace/issue-manager
```

### `packages/workspace/issues`

This Go package owns transport-agnostic issue-manager behavior:

- issue, task, run, output, and context-reference models
- status, priority, pagination, and search normalization
- task status projection onto issue summaries
- run lifecycle orchestration
- a `Store` interface for concrete persistence adapters

It must not own:

- HTTP, gRPC, OpenAPI, or protobuf contracts
- Electron IPC or desktop preload details
- `tsh` room membership, visitor share tokens, or invite capability
- `tuttid` process wiring
- concrete MySQL or SQLite queries

`tuttid` should adapt this package to local SQLite-backed storage. `tsh-server`
should adapt it to the existing remote control-plane storage and room policy
surface.

### `packages/workspace/issue-manager`

This TypeScript package owns the reusable workbench feature surface:

- shared DTOs and service adapter interfaces
- reusable OpenAPI fragment under `openapi/issue-manager.v1.yaml`
- issue-manager view state and workbench node registration helpers
- React-facing issue manager node components and controller logic
- default i18n resources and UI-system-backed Tailwind utility styling
- host-agnostic rich-text context reference handling
- host-agnostic run lifecycle UI flow

It must not read product globals such as `window.tutti`, `legacy TSH preload globals`, or
any host-specific preload surface. Hosts provide explicit adapters instead.

Expected exports:

```text
.
./contracts
./core
./i18n
./services
./ui
./workbench
```

`./core` owns stateless primitives and feature foundation. `./services` should
be the default dependency-injection entry for hosts. It owns service/session
creation plus shared state orchestration. `./ui` should consume those services
and stay focused on rendering, DOM interaction, and imperative UI bridges.
Issue and task content editors consume host-provided `@` rich-text trigger
providers through the workbench node seam. The default issue-manager picker uses
the shared rich-text mention palette with top-level Agent and App tabs,
aligned with Agent GUI mention behavior: Agent mentions resolve
`agent-target` providers, App mentions resolve `workspace-app` providers, and
the menu opens as soon as the `@` trigger is typed, before a search term exists.
Files and issue references should stay on their explicit reference actions
instead of appearing in this `@` picker, and the Task Center app itself should
be excluded from issue-manager app mentions.

Issue run creation is target-first. UI, CLI, and AgentGUI sidecar flows pass
`agentTargetId`/`--agent-target-id` as the launch authority; the daemon derives
and persists the provider for display, filtering, and legacy compatibility.

## Plan Conversion And Execution Orchestration

Issue Manager accepts two distinct planning origins:

- A provider-native Plan can still be converted through the traditional
  AgentGUI **Break into an Issue** flow. Its source is
  `traditional_plan`.
- An accepted Tutti Mode Plan task graph is materialized by the daemon-owned
  workspace workflow service. Its source is `tutti_mode_plan`.

Tutti Mode Plan does not masquerade as a provider interaction and does not
send an ephemeral renderer draft through the traditional conversion path.
The Agent creates immutable `tutti-mode-plan/v1` revisions through the Tutti
CLI; the user decides daemon-owned checkpoints; and tuttid projects tasks only
from the accepted current task-graph revision. See
[Workspace Workflows And Tutti Mode Plan](./workspace-workflows.md).

For the Tutti-owned path, the Markdown revision already contains the
Issue-level reasoning/orchestration profile, auto/fixed token budget, task
assignments, model choices, execution directories, and dependencies. The
workflow service derives read-only `ActionableItem`s, then invokes Issue
Manager with one atomic Issue-and-task-graph request. The SQLite adapter commits
the Issue, all Tasks, and topic activity atomically; task failure rolls the
Issue back, and update events are published only after commit. A deterministic
workflow operation and Issue ID make repeated decisions and waiters
idempotent. The reserved Issue namespace is owned by the daemon
`workspaceworkflow` business model rather than the reusable workspace Issue
package, so generic Issue consumers cannot become a second Tutti workflow
authority. AgentGUI neither parses an Agent message into this graph nor calls
Issue creation itself.

`sourceSessionId` is the durable planning link for both origins. Issue and Task
headers can open that source Session, while successful atomic creation projects
one idempotent, credential-free workspace-Issue mention back into the source
timeline. Tutti Mode Plan additionally keeps its durable workflow, immutable
revisions, checkpoints, and the operation's `issueId`; those records represent
review provenance and do not compete with the Issue as the execution entity.

On the traditional AgentGUI path, `Create only` persists the graph without
dispatch, while sequential `Create and start` records
`sequentialExecution=true`. On the Tutti-owned path there is no Desktop
conversion action: accepting the task-graph revision causes the daemon
materializer to map `execution.mode: sequential` or `parallel` to the matching
Issue execution flag. After successful materialization, tuttid dispatches the
eligible Tasks for either origin. In sequential mode it creates one durable Run
and starts only the first stable eligible Task. The dispatcher is daemon-owned
so progress does not depend on an open Desktop window. It refuses to dispatch
while the Issue's explicit future-dispatch pause is set, a Run is active, a
Task awaits acceptance, a failure needs user action, or the Issue budget gate
is active. Pausing is durable and does not cancel or interrupt already-running
work; clearing it immediately re-evaluates eligible Tasks.
After a successful Run, no successor starts until the user explicitly accepts
that Task. Acceptance then re-evaluates dependencies and starts at most one
next Task in stable order.

On the traditional AgentGUI path, parallel `Create and start` records
`parallelExecution=true`; Desktop creates or reuses a distinct Git worktree for
every assigned Task before submitting the atomic graph. On the Tutti-owned
path, Desktop never prepares worktrees or rewrites the graph: the accepted
immutable revision must already carry a unique absolute execution directory
for every assigned Task. The daemon rejects parallel materialization for
either origin unless that isolation invariant holds. It then starts every
stable DAG-ready root in the same dispatch pass, subject to a workspace-wide
maximum of four running Issue Runs. Every completion refills the available
slots. A successor still waits until every
dependency is completed and explicitly user-accepted. A failed Task blocks new
dispatch, while already-running independent roots remain durable and visible.
Sequential and parallel flags are mutually exclusive.
Each daemon-dispatched Task is also a `delegate` CollaborationRun. The daemon
creates the running collaboration before the Agent Session, links the exact
Task Agent/Plan/model and target Session, and projects it into the originating
planning Session timeline when the Issue has a source Session. Target turn
settlement updates the same collaboration card; launch failure settles both
the Issue Run and CollaborationRun as failed.

Desktop does not run a second Issue scheduler. For traditional AgentGUI
conversion it submits the graph once; for a Tutti-owned workflow it does not
submit a graph at all. In both cases it only projects the authoritative Issue
and Task states returned by tuttid. Compatibility with daemons that predate
daemon-owned dispatch is intentionally unsupported because renderer fallback
scheduling can bypass budget, acceptance, CollaborationRun, and atomic-claim
rules. A Task's explicit execution directory is respected.
Otherwise the daemon inherits the source planning Session directory. Launch
failure completes the matching Run as failed and never satisfies a dependency.

Tasks carry optional WorkspaceAgent, ModelPlan/model, execution directory, and
dependency ids. Strength and budget are never task-level controls: every Task
inherits the Issue execution profile and budget policy. The domain rejects
missing/self/cycle dependencies and incompatible assignment values before
persistence. The shared Issue detail editor uses the same host-supplied Agent
and Model Plan catalogs for structured selectors and protocol filtering. An
external host that has no Model Plan catalog adapter retains the generic text
fallback, but Tutti Desktop supplies the authoritative workspace catalog.
Dispatch carries the saved Task Plan/model through both embedded-workbench and
standalone-window draft launch paths and applies it to the new Session draft;
it never mutates an active Session. Run-level Agent/Plan/model overrides record the actual attempt
without rewriting task defaults. Desktop passes an assigned `modelPlanId`
through the session-create contract; `tuttid` resolves the secret-bearing Plan
and rejects disabled, protocol-incompatible, or model-incompatible launches, so
the Run audit record cannot claim a Plan that the runtime did not use.

Completion uses a three-step acceptance ladder:

```text
agent_claimed -> auto_checked -> user_accepted
```

A successful Run moves its task to `pending_acceptance`/`agent_claimed`; it is
only the executor's completion claim. An enabled fixed Review AutomationRule
must independently complete with a syntactically valid final
`VERDICT: PASS` line before the task advances to `auto_checked`. A FAIL or
malformed verdict records the review summary without advancing acceptance.
Only an explicit user acceptance reaches `user_accepted` and closes the Task as
`completed`. Failed Runs leave the task retryable and do not satisfy
dependencies. Repeated terminal completion and review settlement are
idempotent.

Parallelism stays honest at two boundaries. Materializing a plan normalizes
the durable `parallelizable` flag against dependencies: a task that depends on
a member of its own consecutive parallelizable group can never run alongside
it, so the misleading flag is stripped (dependencies are never touched — they
are the safe side of the contradiction). At dispatch, a successor whose direct
dependencies ran in isolated per-run worktrees receives their exact branch
names in its launch prompt ("Dependency outputs"), so parallel results are
merged forward instead of stranding on `tutti/task/*` branches; the planning
guide pairs this with the convention of an integration task after every
parallel group.

Two adjacent flows reuse this ladder without weakening it. A task whose
durable `autoAccept` flag is set (proposed by the planning agent, adjustable
in plan review) skips the human gate: run completion is accepted
programmatically through the same `UpdateTask` path a manual acceptance takes,
so dispatch advance and the whole-issue completion check stay identical.
Sending a `pending_acceptance` task back to `not_started` (rework) resets its
acceptance to `agent_claimed` and immediately re-opens the dispatch frontier —
the daemon re-dispatches without waiting for an unrelated event. When every
non-canceled task of a `tutti_mode_plan` Issue is `completed`/`user_accepted`,
the daemon notifies the source conversation once (deduped per Issue) so the
planning agent resumes with a verification/summary turn.

## Usage, Budget, Quota, And Cost

Issue and Run usage records four token categories: input, output, cache read,
and cache write. Run completion aggregates all four into the Issue ledger.
Budgets are either fixed or auto-compiled, bounded to
32,000–2,000,000 tokens. The deterministic compiler starts from task count and
the Issue's reasoning/orchestration profile. When the workspace has completed
runs with the same explicit Plan/model assignments as the proposed Tasks,
tuttid sums their average usage, adds 25% headroom, and blends that history
50/50 with the deterministic result. Missing history keeps the deterministic
result. Reasoning/orchestration intensity is stored on the profile as
`0..100`; it influences the auto budget but does not grant permissions.

The budget is a soft dispatch gate. Before each automatic dispatch, the daemon
reserves one conservative per-Run allowance compiled from the current Issue
intensities; parallel dispatch also counts allowances for Runs already started
in the same scheduling pass. If consumed plus reserved tokens would exceed the
limit, or a reported subscription `remainingQuotaPercent` crosses its
configured waterline, the Issue moves to `soft_limited` and no new Run starts.
In-flight Runs continue and can report their final usage. Subscription quota
remains a provider-reported percentage; it is never converted into fake
currency.

The execution overview keeps a soft-limit recovery surface visible: users can
raise the budget, lower intensity for future dispatch, or continue remaining
tasks manually. Lowering intensity reduces both Issue-level controls, clears
the soft limit, and deliberately leaves automatic dispatch paused so the user
can review/rearrange assignments before explicitly resuming. Raising the
budget can recover normal dispatch immediately; manual execution remains a
separate user-authorized path. New estimates use matching completed Task runs
from the same workspace (same explicit Plan/model) when history exists;
otherwise they fall back to the Issue's remaining per-task budget allocation.

Optional pricing on an `api_metered` ModelPlan supplies currency micros per
million tokens for all four categories. tuttid computes exact estimates from
recorded usage and a projected Issue estimate from remaining budget and known
rates. Reported actual cost is preserved. `subscription_quota` Plans bypass
monetary lookup even if a legacy record contains price metadata. Unknown prices
remain unknown, and currencies are not silently converted.

The npm package name should be `@tutti-os/workspace-issue-manager`.
It participates in the shared public npm release group documented in
[npm Package Release](../conventions/npm-package-release.md).

The OpenAPI fragment is a transport contract for hosts that expose the shared
issue-manager capability over HTTP. Host daemons keep their own aggregate API
entrypoints and compose the fragment instead of duplicating issue-manager paths,
parameters, and schemas. `tuttid` composes it from
`services/tuttid/api/openapi/tuttid.v1.yaml`.

## Scope Model

The shared packages use `workspaceId` as the stable scope.

`tutti` can pass the local workspace id directly. `tsh` keeps `roomId` in its
host adapter for collaboration, authorization, sharing, and visitor access, then
maps requests into the shared workspace-scoped model.

Room-specific behavior must remain outside the shared core.

Examples of host-owned `tsh` behavior:

- room membership checks
- visitor share token validation
- room invite capacity and share links
- room member display names and avatars

## Context References

Context references are first-class domain entities.

Rich text content may render and edit references, but storage and service logic
should not rely on parsing rich text as the only source of truth. This keeps
search, delete, upload, prompt construction, and future audit behavior stable.

The shared model should support references attached to either an issue or a
task. A task-level reference is used for agent execution context. Issue-level
references are available for higher-level planning and task creation flows.

## Agent Run Boundary

The shared packages own run lifecycle state, not concrete agent startup.

The TypeScript feature receives an `agentRunner` adapter. The Go package stores
and transitions run records. Hosts decide how to start Codex, Claude Code,
OpenClaw, Hermes, or any other supported provider.

This boundary lets `tutti` and `tsh` share the issue-manager UX while keeping
their runtime/session integration separate.

## Current Adapters

The reusable Go domain, TypeScript feature/UI, OpenAPI fragment, tuttid SQLite
adapter, generated Tutti client, Desktop host adapter, and Issue CLI commands
are implemented. A remote room host still owns its own membership, visitor,
invite, storage, and Agent proxy adapter; those policies do not move into the
shared workspace core.
