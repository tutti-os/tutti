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
- title-only issue and task list search; content does not produce list matches
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

Completion uses a three-step acceptance ladder:

```text
agent_claimed -> auto_checked -> user_accepted
```

A successful Run moves its task to `pending_acceptance`/`agent_claimed`; it is
only the executor's completion claim. Only an explicit user acceptance reaches
`user_accepted` and closes the Task as `completed`. Failed Runs leave the task
retryable and do not satisfy dependencies. Repeated terminal completion and
review settlement are idempotent.

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

## Landing Slices

The boundary-setting slice established the reusable package shape. The current
repository already includes the published TypeScript issue-manager package and
this section tracks the broader cross-host rollout model:

1. Add this architecture document.
2. Scaffold `packages/workspace/issues` with models, service, store interface,
   and focused service tests against a fake store.
3. Scaffold `packages/workspace/issue-manager` with contracts, adapter
   interfaces, i18n defaults, and workbench registration types.

The next local-first slice wires `tuttid` to the shared contracts:

- `tuttid` SQLite adapter and OpenAPI routes under `/v1/workspaces/{workspaceID}`
- generated `@tutti-os/client-tuttid-ts` issue-manager methods

Later slices can add:

- full React node UI migration from `tsh`
- `tsh-server` adapter from room-scoped APIs to the shared package
- `tsh-desktop` adapter from existing IPC to the shared workbench feature
