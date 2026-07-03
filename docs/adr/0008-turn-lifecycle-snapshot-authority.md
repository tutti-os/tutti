# ADR 0008 — Turn lifecycle snapshot authority: one source of truth for "is a turn running"

- Date: 2026-07-03
- Status: Accepted (Phase A implemented for codex; Phase B pending for other providers)
- Extends: ADR 0005 (reducer as the codex turn-lifecycle source of truth) — this ADR
  promotes that principle from inside the codex adapter to the whole chain
  (controller → persisted store → service → GUI).

## Problem

"Is this conversation running a turn" had eight independent representations:
the controller turn registry (`c.turns`), the codex turn machine, the
`Session.{Status,TurnLifecycle,SubmitAvailability}` mirror (folded from
discrete events and kept coherent by three patch mechanisms —
`preserveActiveTurnStatus`, `reconcileSessionStatusLocked`, the sink's
ready-guard), the discrete `turn.*` events on the wire, the persisted state
patch (with a codex-only shaping path), an independent service-layer
predicate, the GUI's four-level display-status fallback, and GUI/desktop local
bookkeeping. Every recent lifecycle bug (stuck spinners, status flapping,
stale-store overwrites, processing-row misfires) was drift between two of
these.

## Decision

**The turn owner publishes idempotent `TurnLifecycle` snapshots; every other
layer copies or purely derives. No layer recomputes lifecycle from discrete
events, and no reconciliation patches exist for snapshot-authority sessions.**

1. **Snapshot contract** (`activityshared.TurnLifecycleSnapshot`, stamped into
   `Payload.Metadata["turnLifecycle"]` on the `turn.*` event emitted at each
   transition — no new event type; `turn.*` events already project to state
   patches only and never to message updates):
   `{v, origin: adapter|controller, seq, activeTurnId, phase, outcome?, settling?}`.
   - Full snapshot, consumers replace, never merge.
   - `seq` is monotonic per session; consumers drop lower-seq snapshots
     (snapshots reach the controller over two channels: the Exec emit closure
     and the session event sink).
   - Only `origin:"adapter"` snapshots flip a session into snapshot-authority
     mode; the controller authors exactly two snapshot kinds — the submit
     moment and the finishTurn settle fallback — which apply to any provider
     without flipping legacy sessions.
2. **Codex adapter** stamps every emitted turn event at its emission choke
   points (`execBlocking`'s emit, adoption emitters), derived from the very
   transition the event states. The approval error path additionally emits a
   back-to-running event so the lifecycle cannot strand in `waiting_approval`.
3. **Controller** (authority sessions): `Session.TurnLifecycle` = last valid
   snapshot; `Session.Status` = `statusForAuthoritySession(lifecycle,
session-level signals)`; `SubmitAvailability` =
   `submitAvailabilityForAuthoritySession(lifecycle)`. The legacy folding path
   (`applySessionEvents` status fold, `applyTurnLifecycleFromEvents`,
   `preserveActiveTurnStatus`, `reconcileSessionStatusLocked`) survives only
   for non-authority sessions and is deleted in Phase B.
4. **Persisted store**: `applyLifecycleSnapshotToPatch` copies the snapshot
   into the state patch provider-agnostically (replacing the codex-only
   `applyExplicitTurnLifecycleToPatch`, kept as legacy fallback). The resume
   stale-turn reconcile also repairs the persisted lifecycle to settled — the
   only lifecycle writer besides snapshot copies, and only when the runtime
   confirmed no live turn exists.
5. **Live-phase vocabulary** lives in exactly one place:
   `activityshared.LiveTurnLifecyclePhases` / `TurnLifecyclePhaseIsLive`
   (accepting documented legacy tokens), mirrored in TypeScript as
   `LIVE_TURN_LIFECYCLE_PHASES` / `isLiveTurnLifecyclePhase`
   (activity-core selectors.ts). Parity is pinned by tests on both sides.
6. **GUI**: a present lifecycle decides the display status entirely
   (status/currentPhase fallbacks apply only to lifecycle-less records); the
   processing indicator and the desktop queue-drain busy check gate on the
   lifecycle through the shared predicate.

## Phase B (pending)

Standard ACP and Claude SDK adapters stamp their existing turn-event call
sites; the authority flag then flips automatically per session. Afterwards the
legacy folding path, the patch-shaping fallback, the snapshot-enrichment
overwrite, and the GUI lifecycle-less fallbacks are deleted.

## Invariant tests

`TestStatusForAuthoritySession` (derivation table),
`TestControllerCodexStreamNeverIdlesMidTurn` (no available/settled patch
between submit and settle), `TestApplyLifecycleSnapshotToPatchProviderAgnostic`,
`TestCodexAppServerAdapterApprovalErrorPathResumesLifecycle`,
`TestLiveTurnLifecyclePhasesCanonicalList` + the TS mirror test, plus the
existing goal/cancel/adoption/steer behavior pins.
