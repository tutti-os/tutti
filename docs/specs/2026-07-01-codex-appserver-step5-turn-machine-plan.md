# Codex App-Server Step 5 Turn Machine Plan

Step 5 implements ADR 0005 A+B without opening the Step 7 controller/API seam.
The adapter keeps its blocking `Exec` signature, but the wait becomes a
subscriber to a reducer-owned turn projection.

## Scope

- Add an explicit app-server turn phase machine:
  `idle`, `running`, `compacting`, `interrupting`, `completed`, `failed`,
  `canceled`.
- Make reducer transitions the single path that terminates a turn:
  `turn/completed`, non-retry `error`, already-terminal initial snapshots, and
  forced/canceled interruptions.
- Treat `/compact` as a first-class machine phase. It still waits for
  `turn/completed`, preserving the streamed compact banner before terminal
  events close the turn.
- Preserve the current blocking adapter contract. Step 7 will introduce the
  non-blocking command/observe facade after review.

## Implementation

1. Add a small turn-machine module under `runtime` with pure transition helpers
   and terminal classification. Keep all mutations guarded by
   `CodexAppServerAdapter.mu`.
2. Replace the direct `activeTurn.done` producer with reducer transition
   delivery. `awaitTurnCompletion` subscribes to the projected terminal channel.
3. Route non-retry app-server `error` notifications through the same transition
   so a failed turn cannot park the active slot forever.
4. Add shadow comparison between the projection terminal classification and the
   legacy `appServerTurnTerminalEvents` status mapping. Log mismatches while the
   Step 5 tests assert the golden cases agree.
5. Extend focused tests for terminal error unblocking, compact phase ordering,
   and terminal classification.

## Validation

- Step 0 corpus stays green.
- `go test ./runtime/ -count=1`
- `go build ./runtime/...`
- `go test ./activity/... -count=1` if shared turn phase constants change.
