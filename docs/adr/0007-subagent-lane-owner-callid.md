# ADR 0007 — Sub-agent lane ownership is recorded, not inferred (`OwnerCallID`)

- Date: 2026-07-03
- Status: Accepted
- Extends: ADR 0003 (thread registry + sub-agent event routing)

## Problem

ADR 0003 stamps every child-thread row with `OwnerThreadID`, but the edge
"which spawn call created this child" was never emitted. The GUI projection
(`subAgentTimelinePartition.ts`) re-derived it at read time through a
three-step heuristic chain: spawn-card `receiverThreadIds` → output-string
match → time affinity.

That chain assumes the projection sees the **complete** timeline. Message
pagination (100-item window, older pages load only when the user scrolls
near the top) broke the assumption: with the spawn card outside the loaded
window, lanes attached to the wrong collab card (wait/close cards also
declare `receiverThreadIds`) or to a time-affine stranger — the transcript
rendered wrong data until the older page happened to load, then snapped
correct. The daemon-side comment in `codex_appserver_events.go` already
admitted time affinity "mis-attributes lanes"; the fix at the time
(forwarding `receiverThreadIds`) patched one symptom (concurrent spawns)
without fixing the cause: the edge was never recorded.

## Decision

**Record the edge at write time; the projection becomes a lookup.**

1. `activityshared.Event` (and `EventContext`) gain an optional
   **`OwnerCallID string`** next to `OwnerThreadID`. Non-empty = the
   `collabAgentToolCall` item id (== the GUI tool call's `callId`) of the
   spawn that created the emitting child thread. The registry already holds
   this as `codexAppServerThreadContext.parentItemID`; it was simply never
   emitted.
2. Every path that stamps `OwnerThreadID` stamps `OwnerCallID` from the
   registry: the reducer route, the child terminal-status markers, the
   nickname markers, and the cancel-all lifecycle markers. The reporter
   persists it as `payload["ownerCallId"]` alongside `payload["ownerThreadId"]`.
3. Only **spawn-kind** collab cards may claim `parentItemID` in
   `rememberAppServerChildThreads`; wait/close control cards register the
   thread for routing but never claim ownership (fixes the first-wins
   ordering edge where a control card could permanently steal the lane).
4. The GUI attaches lanes **only** by `ownerCallId`. The heuristic chain is
   deleted. Seeding placeholder lanes from a spawn card's own
   `receiverThreadIds` input stays — that reads recorded data on the card
   itself, not an inferred cross-item relation.

## Consequences

- Partial timeline windows degrade honestly: a child row whose spawn card is
  not loaded renders nothing (consistent with the rest of the unloaded
  transcript) instead of rendering wrong; the lane appears when the older
  page loads. The projection no longer needs to know whether the window is
  complete.
- Sessions recorded before this change (rows without `ownerCallId`) no
  longer render sub-agent lanes. Accepted trade-off: correctness of new
  recordings over heuristic display of old ones.
- Rule of thumb this encodes: a projection may only reconstruct facts the
  log records per item; any relation that needs the whole log to guess must
  be recorded at write time instead.
