# ADR 0004 — Step 4: hydration snapshot cursor (monotonic sequence, not timestamp)

- Date: 2026-07-02
- Status: Accepted (grilling session)
- Context: Step 4 (Cluster A, daemon-half). Corroborated by t3code (event-sourced
  `sequence`) and traycer (append-only chat event log + snapshot reconcile).

## Finding that reframes the design

The design says "the daemon correctly holds the user row **at version=1**; the
defect is desktop-rooted." **Version is not 1,2,3 — it is a millisecond
wall-clock timestamp**: `reporter.go:375,510` set `Seq: uint64(timestamp)` where
`timestamp = event.OccurredAtUnixMS` (fallback `time.Now().UnixMilli()`), and the
store maps `Version = update.Seq` (`service.go:2495`). Consequences:

- **Not gap-free** (design calls the contract "gap-free"; a timestamp cannot be).
- **Same-millisecond collision:** the user-prompt row and the first turn/reply
  event can share one Version V. With the desktop cursor at V, the
  `Version <= afterVersion` filter (`service.go:234`) drops BOTH — a **daemon-side**
  path to "user message disappears", independent of the desktop reconcile bug.
- **Non-monotonic across sources / no user-before-reply guarantee** (ms clock).

So the "gap-free, clientSubmitId-keyed, resyncable" contract the design assigns to
Step 4 does NOT hold today; the "defect is purely desktop-rooted" claim is
incomplete — timestamp-as-cursor is a co-conspirator.

## Decision: split delivery-cursor from display-order

Both reference implementations separate a monotonic sequence (ordering/cursor)
from a wall-clock timestamp (display) — t3code `sequence` + `occurredAt`;
traycer append-log order + `timestamp`. tutti's conflation is the anomaly. Adopt
the split, minimally:

1. **`Version` becomes a store-assigned per-session monotonic, gap-free counter**
   — the delivery cursor. Assigned at store ingest (`upsertSessionMessagesLocked`,
   the single `entry.mu` lock point) on first insert of a `MessageID`, in commit
   order; **preserved on merge** (already done, `service.go:2605`) so it is stable
   within a load and the cursor never regresses. Stop deriving it from `Seq=timestamp`.
2. **Display order sorts primarily by `OccurredAtUnixMS`** (existing field), with
   the counter as tiebreak — replacing "sort by Version(=timestamp) then ID".
   This stays robust to out-of-order replay (a pure ingest-order counter would
   mis-order history if replay is not chronological).
3. **Identity stays `MessageID = f(clientSubmitId)`** (`prompt_content.go:155-161`)
   — cf. traycer `messageId` + `clientActionId`. Already correct in tutti.
4. **Self-heal = full resync at `afterVersion=0`** (already returns the complete,
   deduped, ordered set; desktop already loads at 0 — `createDesktopAgentHostApi.test.ts:1627`).

## Blast radius (verified)

- **No daemon data migration.** No disk persistence (`repo.go` 20 lines; no
  sqlite/bolt/WriteFile in `packages/agent/daemon`); `sessionMessages` is an
  in-memory map rebuilt from provider replay each load. Nothing persisted a
  timestamp-Version to be incompatible with.
- **Per-session only.** Version comparison/sort is already per-session
  (`latestVersionBySession[sessionID]`, single-session sort) — a per-session
  counter drops in; no cross-session global comparison exists.
- **Version is load-relative & ordering-only** (counter restarts per load; values
  shift if the replay prefix differs). Identity is `MessageID`, never the counter.
  Any consumer treating Version as a stable/global key must be corrected; the
  daemon does not.
- **Mixed fleet absorbed:** desktop starts each session view at `afterVersion=0`
  and re-keys by `MessageID`, so a new-daemon/old-desktop pair renders correctly;
  cursor advances in-memory, not persisted across reloads.
- **"User chats based on history":** replay assigns 1..N to history in order, new
  user prompt = N+1, reply = N+2; desktop reconciles the optimistic echo by
  `MessageID` regardless of counter values. History cannot disappear (always
  re-fetched at 0, keyed by MessageID).

## Scope boundary (explicit)

- **NOT in scope:** durable append-only event log / event sourcing (both
  references have it; tutti does not). The ephemeral store + monotonic cursor +
  resync-at-0 is sufficient to close the bug. Durable log = **future direction**,
  a separate effort.

## Corrections to the design

- "daemon holds user row at version=1 / defect is desktop-rooted" → **version is a
  ms timestamp; same-ms collision is a daemon-side contributor** to Cluster A.
- Step 4 "gap-free contract" is an ASPIRATION today; this ADR makes it real via the
  monotonic counter.
