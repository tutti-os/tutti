# Claude Code sub-agents render as sub-agent lanes

Date: 2026-07-07 · Extends ADR 0007 (owner-stamped lane attachment) to the
Claude Code provider.

## Problem

Codex collab sub-agents render as first-class sub-agent lane cards
(`AgentSubAgentCards`: live status, elapsed timer, latest activity), while
Claude Code delegations (Task/Agent tool) rendered as a static
`AgentTaskCallCard` with a metadata-driven step list. Same concept, two
different visual treatments.

Claude Code's delegation semantics also differ from codex in two ways the
rendering must absorb:

1. The main agent can keep messaging a running sub-agent (SendMessage /
   continued child streams). Follow-up activity must land in the original
   lane, never spawn a duplicate card.
2. Sub-agents can spawn their own sub-agents (nesting depth > 1). The GUI
   attaches lanes only to main-transcript cards, so nested delegation
   activity must flatten into the root lane instead of getting lost.

## Approach

Per ADR 0007: the daemon stamps the edge, the GUI looks it up exactly. The
Claude adapter now emits the same owner-stamped rows the codex adapter does,
so the existing GUI lane pipeline (`partitionSubAgentTimelineItems` →
`buildSubAgentLanesByCallId` → `attachSubAgentLanesToConversationVM` →
`AgentSubAgentCards`) picks Claude delegations up without new GUI machinery.

Claude Code has no provider child-thread ids; the lane identity is synthetic:
`ownerThreadId = "claude-subagent:<root tool_use id>"`,
`ownerCallId = <root tool_use id>` (matches the Task card's `payload.callId`).

## Changes

### Daemon (`packages/agent/daemon/runtime/claude_sdk_adapter.go`)

- `claudeSDKAdapterSession.subagentToolParents`: tool_use id →
  `parentToolUseId` registry, fed by every sidecar tool event. Lives for the
  session, so late child streams (follow-up messages to a running agent)
  keep resolving to the original lane.
- `subagentRootToolID`: walks the parent chain to the top-level delegate
  call. Grandchild tool rows stamp the **root** lane (nested delegations
  flatten). Self-referential parent ids (the sidecar's delegated-task parent
  updates echo the call's own id) are ignored.
- `claudeSDKToolEvents`: child tool events (non-empty
  `metadata.parentToolUseId`) get `OwnerThreadID`/`OwnerCallID`; the generic
  reporter path (`withOwnerThreadID`) persists them as
  `payload.ownerThreadId`/`payload.ownerCallId` rows exactly like codex.
- Lane markers (same payload contract as codex, reporter.go:390-400):
  - `claudeSDKSubAgentNameEvent` (`messageKind: subAgentName`): from the
    delegate call's `input.description` (fallback `subagent_type`), emitted
    on change only.
  - `claudeSDKSubAgentLifecycleEvent` (`messageKind: subAgentLifecycle`):
    "started" at delegate `tool_started` (the lane renders immediately, like
    a codex spawn card), terminal status from the delegate call's own
    completion (sync) or from `task_completed` lifecycle events (async).
    An async launch result (`subagentStatus: running`) emits no terminal.
    Single marker row per lane (stable message id) so later states overwrite
    earlier ones.
  - `claudeSDKSubAgentProgressEvent`: `task_progress` summaries stream into
    the lane as its latest-activity text.
- Only depth-1 delegated tasks drive lane lifecycle; a nested task's
  terminal state must not settle its root lane
  (`claudeSDKSubagentTaskMarkerEvents` guard).
- `claudeSDKSubagentInterruptEvents`: on `turn_canceled`/`turn_failed`,
  still-running lanes launched by that turn get a "stopped" marker so no
  lane ticks forever. A sub-agent that survives the interrupt self-heals:
  its later task events update the same marker row.

### GUI (`packages/agent/gui`)

- `subAgentTimelinePartition.ts` `collectCollabCards`: the lane task strip
  falls back `input.task` → `input.prompt` → `input.description` (Claude
  delegate calls carry prompt/description, not task).
- Everything else is reused as-is. `AgentToolGroupRow` already short-circuits
  any task-VM call with attached lanes to `AgentSubAgentCards`.

## Compatibility

- Old recordings (no owner stamps) keep the legacy path: child calls nest
  into the Task card's step list via `nestDelegatedToolCallsAcrossTurns`.
- The sidecar still aggregates `metadata.steps` onto the parent Task call,
  so static surfaces that render the task VM keep their step list.
- No event-schema changes: the payload keys (`ownerThreadId`, `ownerCallId`,
  `subAgentName`, `subAgentLifecycleStatus`, `detail`, `messageKind`) are the
  ones codex already publishes.

## Tests

- Go: `TestClaudeCodeSDKAdapterEmitsSubagentLaneMarkersOnTaskStart`,
  `TestClaudeCodeSDKAdapterFlattensNestedSubagentsIntoRootLane`,
  `TestClaudeCodeSDKAdapterSettlesRunningLanesOnTurnCancel`, plus owner
  assertions in `TestClaudeCodeSDKAdapterPreservesSubagentParentToolUseID`
  and updated background-agent tests.
- GUI: `subAgentTimelinePartition.spec.ts` "claude code delegate lanes".
