# Agent Turn Lifecycle Ledger

This document maps where turn state lives across the agent turn lifecycle
chain and how those views are reconciled. Use it when debugging symptoms such
as `already active turn`, stale submit availability, infinite loading, or cancel
desync.

## Flow

```text
GUI (AgentGUI composer)
  -> tuttid HTTP/WS (activity projection)
    -> runtime Controller (c.turns)
      -> provider Adapter (per-turn waiter)
        -> Claude SDK sidecar / Codex app-server
```

## Four ledgers (reconciled only by conventions today)

| Ledger         | Key                                                  | Set                      | Cleared                         |
| -------------- | ---------------------------------------------------- | ------------------------ | ------------------------------- |
| Controller     | `c.turns[sessionKey]`                                | `beginTurn`              | `finishTurn` only               |
| Claude adapter | `adapterSession.turns[turnID]` waiter                | `Exec` register          | terminal / ctx cancel           |
| Sidecar        | `activeTurnId`, `turnQueue`, synthetic/delegated ids | sidecar runtime          | sidecar settle                  |
| GUI store      | `submitAvailability`, `turnLifecycle`                | inline patch / reconcile | newer version or derived settle |

A mismatch between any two ledgers can wedge the session until cancel or
reconcile clears the stale record. `Controller.DetectStaleActiveTurns`
(`controller.go`) reports `c.turns` records with no renewed activity for a
given threshold, but is observation-only: it never cancels or clears a
record automatically, because a turn can legitimately sit active for a long
time (a slow tool call, a human reviewing an approval prompt). Wiring a safe
automatic action on top of this detection is future work.

## Turn ID sources

- **Controller-authoritative**: `newID()` in `controller.go`, sent to sidecar as
  `exec.turnId`.
- **Sidecar echo**: normally equals the controller id.
- **Sidecar-generated**: `synthetic-*`, queued `turnQueue` ids, delegated/subagent
  ids. These must not be confused with controller-tracked exec turns.

## Submit availability

- **Single mapper (Go)**: `SubmitAvailabilityForPhase` in
  `packages/agent/daemon/activity/events/turn_lifecycle_snapshot.go`.
- **Live push path**: `statePatchFromSessionEvent` in
  `packages/agent/daemon/runtime/reporter.go` → tuttid
  `activityStatePatchEventPayload`.
- **GUI derivation (ADR 0008)**: `resolveSubmitAvailability` in
  `packages/agent/activity-core/src/selectors.ts` derives from
  `turnLifecycle` + `runtimeContext`; wire `submitAvailability` is a hint for
  lifecycle-less records only.

Omitting `submitAvailability` from a live-phase patch leaves the GUI on a
stale value because incremental patches mean "no opinion".

## Settle paths

1. Adapter terminal event completes the registered waiter → `Exec` returns →
   `finishTurn` clears `c.turns`.
2. Controller cancel cancels turn ctx → adapter `Cancel` → synthetic terminal.
3. GUI version regression guard rejects older reconcile snapshots
   (`isSessionVersionRegression` in `activity-core`).

## Related docs

- [ADR 0008 Turn Lifecycle Snapshot Authority](../adr/0008-turn-lifecycle-snapshot-authority.md)
- [Agent Activity Packages](./agent-activity-packages.md)
- [Troubleshooting: Agent turn fix landed on dead code](../conventions/troubleshooting.md)
