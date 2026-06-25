# Codex App Server Fast Submit Plan

Status: implementation plan for `codex/agent-appserver-startup-metadata`

## Background

Codex App Server can be slow to produce the first visible turn output. PR #353
started addressing this by moving startup metadata and thread readiness work out
of the session start critical path:

- skip slow startup metadata probes when the session already has explicit
  settings
- start `thread/start` asynchronously
- refresh models and rate limits in the background
- expose `runtimeContext.appServerStartup` so Agent GUI can show loading state
- add bounded startup and turn tracing
- tighten cancel sequencing around active turns

That direction is still correct. If the current branch does not yet contain
asynchronous `thread/start`, this work should implement or restore it as part of
the same PR. The part that should not continue is Codex App Server
renderer-side recovery logic that tries to infer turn lifecycle from transcript
shape. For Codex App Server sessions that emit the explicit lifecycle contract,
the GUI should not decide whether a turn is active, waiting, settling, or
complete by inspecting message `role`, `kind`, `status`, notice text, or command
text.

The current branch should remain one complete PR. Do not split this work into a
stack of smaller PRs unless the branch is intentionally abandoned.

## Goal

Keep the fast submit path while making the runtime/App Server contract deep
enough for the GUI to render Codex App Server lifecycle state without guessing.
This is not a global replacement of the existing provider lifecycle model. It
adds a more explicit lifecycle branch for Codex App Server while keeping
existing provider behavior intact.

The desired user path is:

```text
Agent GUI submit
  -> runtime accepts the prompt quickly and returns a typed turn id
  -> controller records an active submitted turn
  -> Codex adapter waits for async thread readiness only if needed
  -> App Server starts or resumes the provider turn
  -> runtime publishes authoritative turn lifecycle patches
  -> Agent GUI renders from the lifecycle contract
```

Fast accept is the key product behavior. Waiting for `thread/start` may still
happen inside the runtime goroutine, but it must not force the renderer to
invent a long-lived pending-turn state machine.

## Non-Goals

- Do not revert the async App Server startup direction from PR #353.
- Do not split the implementation into multiple PRs.
- Do not make Agent GUI a second owner of Codex App Server lifecycle rules.
- For Codex App Server lifecycle decisions, do not infer lifecycle from
  `"Context compacted."`, `"/compact"`, assistant row presence, or system notice
  payload shape.
- Do not introduce a broad generic event center. Extend the existing Agent
  Activity contracts.

## Contract

Add an explicit turn lifecycle contract to the Agent Activity surface. Existing
`status`, `currentPhase`, and `turnPhase` remain the normal lifecycle surface
for providers and paths that do not emit `turnLifecycle`. Treat
`turnLifecycle` as an additive Codex App Server capability first; when present,
Agent GUI must treat it as authoritative for Codex App Server lifecycle
decisions.

```ts
export type AgentActivityTurnPhase =
  | "submitted"
  | "running"
  | "waiting"
  | "settled";

export type AgentActivityTurnOutcome =
  | "completed"
  | "failed"
  | "canceled"
  | string;

export interface AgentActivityCompletedCommand {
  kind: "compact" | "review" | "undo" | "goal" | string;
  status: "completed" | "failed" | "canceled" | string;
}

export interface AgentActivityTurnLifecycle {
  activeTurnId: string | null;
  phase: AgentActivityTurnPhase;
  settling?: boolean;
  outcome?: AgentActivityTurnOutcome | null;
  completedCommand?: AgentActivityCompletedCommand | null;
}

export interface AgentActivitySubmitAvailability {
  state: "available" | "blocked" | "queueable" | string;
  reason?: string;
}

export interface AgentActivityMessageSemantics {
  userVisibleAssistantResponse?: boolean;
  turnSettling?: boolean;
  noticeCommand?: "compact" | "review" | "undo" | "goal" | string;
  noticeCommandStatus?:
    | "running"
    | "completed"
    | "failed"
    | "canceled"
    | string;
}
```

Wire these through:

- `AgentActivitySession`
- `AgentActivityStatePatch.turn`
- `AgentActivityMessage.semantics`
- daemon activity DTOs
- host DTOs used by desktop and Agent GUI
- session control-state responses

Change `sendInput` from returning a session with hidden extra fields to a typed
submit result:

```ts
export interface AgentActivitySendInputResult {
  session: AgentActivitySession;
  turnId: string;
  turnLifecycle: AgentActivityTurnLifecycle;
  submitAvailability: AgentActivitySubmitAvailability;
}
```

Do not remove or reinterpret existing lifecycle fields globally. New Codex App
Server lifecycle decisions must read `turnLifecycle` or lifecycle-rich `turn`
patch fields when they are present. Existing fallback inference may remain for
providers and paths that do not emit the new contract.

## Runtime Rules

The runtime/controller owns the authoritative lifecycle.

### Submit Accepted

When `Controller.Exec` accepts input:

- allocate `turnId`
- call `beginTurn`
- store `activeTurnId = turnId`
- publish or return `phase = "submitted"`
- return the typed submit result immediately

This keeps submit latency low even if the provider thread is still starting.

### Thread Readiness

`CodexAppServerAdapter.Start` may keep `thread/start` asynchronous. If a turn is
submitted before the thread is ready:

- the active turn remains `submitted`
- the adapter waits for thread readiness in the background turn goroutine
- when the provider turn actually starts, emit `phase = "running"`
- if thread start fails, emit `phase = "settled"` with `outcome = "failed"`

### Waiting

When the provider is waiting for user input, approval, permission, or another
interactive response:

- emit `phase = "waiting"`
- keep `activeTurnId`
- set `submitAvailability` according to the intended UX

The GUI can still render the specific prompt from transcript rows, but for
Codex App Server lifecycle it must not derive the session lifecycle from those
rows when structured lifecycle state is present.

### Settled

On successful, failed, or canceled terminal events:

- emit `phase = "settled"`
- clear `activeTurnId`
- set `outcome`
- set `submitAvailability.state = "available"` unless another runtime rule says
  otherwise

### Notice-Only Commands

Commands such as `/compact` must be completed by structured runtime state, not
by GUI text matching.

For `/compact`, `codex_appserver_adapter.go` already waits for App Server turn
completion. That path should emit:

```ts
turnLifecycle: {
  activeTurnId: null,
  phase: "settled",
  outcome: "completed",
  completedCommand: { kind: "compact", status: "completed" }
}
```

The system notice may still render `"Context compacted."`, but the GUI must not
use that copy to settle the turn.

## Agent GUI Rules

Agent GUI may keep short-lived optimistic UI for immediate visual feedback, but
it must not own durable lifecycle truth for Codex App Server sessions that emit
`turnLifecycle`.

The controller should:

- read typed `sendInput` result instead of `recordValue(result)?.turnId`
- read `turnLifecycle.phase` for submitted/running/waiting/settled
- read `submitAvailability` for composer availability
- read `message.semantics.userVisibleAssistantResponse` when it needs to know
  whether a message should count as visible assistant output
- read command completion from `turnLifecycle.completedCommand` or
  `message.semantics.noticeCommandStatus`

For Codex App Server sessions/events that include `turnLifecycle`, the
controller must not use these as durable lifecycle truth:

- latest message role
- assistant row existence
- system notice payload shape
- `"/compact"` prompt text
- `"Context compacted."` notice text

Those existing inference paths may remain as fallback behavior for providers or
legacy paths that do not emit the new lifecycle contract.

## Implementation Scope

Implement this in the current branch as one complete PR.

Primary files:

- `packages/agent/activity-core/src/types.ts`
- `packages/agent/activity-core/src/controller.ts`
- `packages/agent/activity-core/src/adapter.ts`
- `packages/agent/daemon/activity/types.go`
- `packages/agent/daemon/runtime/controller.go`
- `packages/agent/daemon/runtime/codex_appserver_adapter.go`
- `packages/agent/daemon/runtime/codex_appserver_events.go`
- `services/tuttid/service/agent/session_types.go`
- `services/tuttid/service/agent/service.go`
- `services/tuttid/agent_runtime_adapter.go`
- `services/tuttid/api/daemon_agent_sessions.go`
- `packages/agent/gui/agentActivityRuntime.tsx`
- `packages/agent/gui/shared/workspaceAgentActivityTypes.ts`
- `packages/agent/gui/shared/contracts/dto/agentHost.ts`
- `packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts`
- `apps/desktop/src/renderer/src/features/workspace-agent/services/workspaceAgentActivityService.interface.ts`
- `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.ts`
- `apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.ts`
- `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/desktopAgentHostProjection.ts`

If the HTTP session/control-state shape changes, also update:

- `services/tuttid/api/openapi/tuttid.v1.yaml`
- generated `services/tuttid/api/generated/*`
- generated `packages/clients/tuttid-ts/src/generated/*`
- hand-written client wrappers that expose the changed fields

## Acceptance Criteria

- New Codex session submit returns a typed `turnId` quickly without waiting for
  App Server `thread/start` readiness.
- A submitted turn remains visible as `submitted` until provider execution
  starts.
- App Server provider execution moves the same turn to `running`.
- Interactive prompts move the same turn to `waiting`.
- Terminal events move the turn to `settled`, clear `activeTurnId`, and set
  `outcome`.
- `/compact` completion is represented by structured lifecycle fields; GUI does
  not inspect `"Context compacted."` to settle the turn.
- Reloading session control state preserves `activeTurnId`, phase, and submit
  availability.
- `AgentActivityRuntime.sendInput` no longer requires callers to read hidden
  fields from `AgentActivitySession`.
- For Codex App Server sessions with structured lifecycle state, Agent GUI has
  no durable lifecycle inference based on transcript role, kind, status, or
  content.
- The fast startup metadata behavior from PR #353 is preserved.

Useful checks are listed below:

- Typecheck and focused tests before broad changed checks.
- Run the focused Agent Activity core tests.
- Run the focused Agent GUI controller tests.
- Run the desktop workspace activity service tests.
- Run daemon runtime and activity Go tests.
- Run `pnpm check:changed` before broad validation.
