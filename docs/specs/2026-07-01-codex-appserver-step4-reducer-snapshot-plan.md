# Codex app-server Step 4 reducer and snapshot plan

## Scope

Implement the daemon half of ADR 0004 and create the reducer boundary required
by ADR 0005, without changing `Exec` blocking semantics yet.

## Current state

- Runtime message updates use `Seq = OccurredAtUnixMS`; the activity store copies
  that into `WorkspaceAgentSessionMessage.Version`.
- `ListSessionMessages(afterVersion)` filters by that timestamp-like version, so
  same-ms user/reply collisions can make both rows invisible after a cursor.
- App-server notifications are still reduced inside the adapter event file,
  leaving Step 5 without a single notification-to-projection boundary.

## Implementation

1. Make `Version` a store-assigned, per-session, monotonic cursor:
   - assign on first insert of a `MessageID` under the session entry lock;
   - preserve existing `Version` on merge;
   - keep `LatestVersion` as the session cursor;
   - ignore runtime `Seq` for local cursor assignment.
2. Sort message snapshots by `OccurredAtUnixMS` for display, with `Version`,
   `ID`, then `MessageID` as stable tiebreakers.
3. Keep `MessageID` identity unchanged, including `clientSubmitId`-derived IDs.
4. Add tests for:
   - same-ms user/reply rows receiving distinct gap-free versions;
   - `afterVersion=0` returning the full deduped snapshot;
   - message display order following `OccurredAtUnixMS`, not ingest cursor;
   - merges preserving the original message version.
5. Introduce a focused app-server reducer boundary:
   - adapter message handling delegates notification reduction to the reducer;
   - reducer output carries activity events plus the current state-patch stream
     used for turn/session status;
   - existing behavior is preserved while Step 5 can move turn terminal authority
     behind this reducer.

## Validation

- `go test ./activity/... -count=1`
- `go test ./runtime/ -count=1`
- Step 0 bug corpus
- `go build ./runtime/...`
