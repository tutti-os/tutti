# Glossary — Codex app-server refactor

- **codexproto** — tutti's generated protocol package
  (`packages/agent/daemon/runtime/codexproto`); typed protocol boundary
  (enabling infra, per D6). Holds generated types + RPC stubs + hand-maintained
  type supplement.
- **Generated surface** — the full set of protocol types / RPC method stubs /
  notification types emitted by the codegen pipeline from upstream `export`.
- **Wired subset** — the methods/notifications a refactor step actually connects
  to tutti behavior. This refactor wires only the four-state-machine subset.
- **export bin** — `codex-rs/app-server-protocol/src/bin/export.rs`; emits
  `codex_app_server_protocol.schemas.json` (+ `.v2`) and filtered TypeScript.
- **Pinned commit** — the codex git commit codexproto is generated against and
  stamped with; distinct from the binary version baseline (`codex-cli 0.142.5`)
  captured in Step 0.
- **Four state machines** — thread identity (B) / turn+compaction (C) /
  session-lifecycle (D) / hydration-snapshot (A); the real refactor target (D6).
- **Used-but-unexported method** — a method tutti calls at runtime that is absent
  from the upstream exported schema (e.g. `collaborationMode/list`). Lives in the
  manual type supplement + relies on the runtime binary actually serving it.
- **Unknown-method fallback** — dispatch path for a notification/server-request
  whose method is not in the generated surface; logs + degrades, never crashes.
  Preserves `map[string]any`'s tolerance of a floating runtime binary.
- **Pinned source SHA vs binary baseline** — two distinct version axes: the codex
  git commit codexproto is generated from, vs the `codex-cli` version the daemon
  spawns (`0.142.5`, Step 0). CI drift only guards the former.
- **OwnerThreadID** — new optional field on `activityshared.Event`. Empty =
  main/top-level agent; non-empty = the sub-agent child thread that produced the
  event. Preserves child identity so nested sub-agent cards are a cheap later UI
  addition. tutti's analogue of traycer's `parentBlockId`.
- **Identity-preserving routing (option 丙)** — Step 3's chosen model: suppress
  child lifecycle noise, re-home substantive child events tagged with
  `OwnerThreadID`, keep the summary card parent-item-driven. Contrast: option 1
  (drop all) and t3code flat re-tag (garbles concurrent output).
- **receiverThreadIds** — required array on the `collabAgentToolCall` item; the
  parent declaring which child threads it spawned. The linkage source for routing
  (not `Thread.parentThreadId`).
- **Delivery cursor (Version)** — redefined (ADR 0004) as a store-assigned
  per-session monotonic, gap-free counter used only for incremental sync
  (`afterVersion`). NOT a timestamp, NOT a stable cross-load key. Display order
  uses `OccurredAtUnixMS`; identity uses `MessageID`.
- **Same-ms collision** — the pre-fix daemon bug: user row + first reply event
  sharing one ms-timestamp Version, both skippable by an `afterVersion` cursor.
- **Load-relative counter** — the Version counter restarts and re-assigns per
  session load (store is replay-rebuilt, not durable); safe because the desktop
  resyncs at 0 and keys by MessageID. Contrast t3code/traycer durable sequences.
- **Unified projection** — the optimal end state (ADR 0005): one per-session reducer
  folds turn state + messages + compaction + approvals into explicit state,
  reconciled against the Step-4 snapshot; matches t3code's single `sequence` log /
  traycer's single chat event log. Replaces tutti's two parallel mechanisms.
- **turnPhase** — explicit turn state enum (idle/running/compacting/interrupting/
  terminal{completed|failed|canceled}) owned by the reducer; terminal is a phase,
  not a status whitelist. Replaces the scattered 7-field implicit state.
- **Command/observe split** — non-blocking `Exec` (submit → handle; observe via
  event stream + projected state), reached via a strangler shim over the blocking
  signature. Removes the wedge/floor/single-turn constraints by construction.
- **Strangler shim (Exec inversion)** — the risk control for ADR 0005 Step 7: keep
  the blocking `Exec([]events,error)` as a thin wrapper over the async core; migrate
  callers incrementally; delete the wrapper last. Reversible, no big-bang.
- **serverRequest/resolved** — codex notification that a server-request was resolved
  (possibly out-of-band). The authoritative terminal for a pending approval; tutti
  does not handle it today → the stall class (1ec14c03). ADR 0006 adds it.
- **Durable pending approval** — an approval represented as a reconcilable item in the
  unified projection (pending/resolved/interrupted), not a parked goroutine on a
  channel. Responder holds codex's RPC and responds async. (ADR 0006)
- **Interrupted-pending policy** — on reconnect, a surviving pending approval is marked
  interrupted + re-offered/re-driven, never silently rejected; RPC revival is not
  assumed (bounded by codex re-issue behavior on resume). (ADR 0006)
