# Sub-agent lanes: authoritative `ownerCallId` attachment

Date: 2026-07-03 · See ADR 0007 for the decision record.

## Bug this fixes

Scrolling up from the bottom of a long collab session, sub-agent rows render
wrong (attached to the wrong card, fallback `#N` names, wrong statuses) and
snap correct only once the user scrolls within 240px of the top
(`AGENT_GUI_TOP_HISTORY_PREFETCH_THRESHOLD_PX`), because that is when older
message pages load and the spawn card finally enters the projection's input.

Root cause: lane→card attachment was inferred at read time over a paginated
window (`buildSubAgentLanesByCallId` heuristics), while the daemon always knew
the true edge (`codexAppServerThreadContext.parentItemID`) and never emitted it.

## Changes

### Daemon (`packages/agent/daemon`)

- `activity/events/activity_types.go`: `Event.OwnerCallID`,
  `EventContext.OwnerCallID`, copied by `eventFromContext`.
- `runtime/codex_appserver_events.go`:
  - `appServerNotificationRoute` carries `ownerCallID` (= `child.parentItemID`)
    on both the terminal-marker path and the streaming path.
  - `appServerEventsWithOwnerThreadID` → `appServerEventsWithOwner`, stamps
    both fields.
  - `rememberAppServerChildThreads`: only spawn-kind collab items claim
    `parentItemID`; control cards (wait/close) register the thread only.
- `runtime/codex_appserver_reducer.go`: stamps both fields from the route.
- `runtime/codex_appserver_adapter.go`: nickname markers and cancel-all
  lifecycle markers stamp `OwnerCallID` from the registry.
- `runtime/reporter.go`: `withOwnerThreadID` also persists
  `payload["ownerCallId"]`.

### GUI (`packages/agent/gui`)

- `shared/agentConversation/projection/subAgentTimelinePartition.ts`:
  - New `timelineItemOwnerCallId(item)` (mirror of `timelineItemOwnerThreadId`).
  - `buildSubAgentLanesByCallId`: lane's card = `cardsByCallId.get(ownerCallId)`.
    Rows without `ownerCallId`, or whose card is outside the loaded window,
    produce no lanes.
  - Deleted: receiver-match / output-strings / time-affinity attachment chain
    (`matchCardByTimeAffinity`, `outputStrings`, `collectStringValues`).
  - Kept: placeholder-lane seeding and the spawn-pending lane, which read the
    spawn card's own recorded input.

## Non-goals

- No proactive fetching of older pages when orphan child rows are detected
  (possible follow-up; honest degradation makes it unnecessary for
  correctness).
- No migration for pre-`ownerCallId` recordings; their sub-agent lanes stop
  rendering by design.

## Verification

- Go: route/reducer/reporter/marker stamping + spawn-only ownership guard
  (`packages/agent/daemon` module tests; pre-existing reporter failures are
  known and unrelated).
- TS: `subAgentTimelinePartition.spec.ts` rewritten around lookup attachment,
  partial-window honesty, legacy-row skip, unchanged seeding.
- Manual: long collab session — no wrong styling while scrolling up from the
  bottom; lanes appear correctly after history pages load.
