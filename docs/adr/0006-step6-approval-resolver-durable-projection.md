# ADR 0006 — Step 6: approval / interactive resolver — full optimal (durable pending in the unified projection)

- Date: 2026-07-02
- Status: Accepted (grilling session) — approval goes full optimal, the approval-side of ADR 0005.
- Context: Step 6 (Cluster E). Verified against tutti code; compared to t3code
  (`pendingApprovals` + `approvalCorrelations` + `serverRequest/resolved`) and the
  openclaw-codex-app-server durable pending-input model.

## Finding

tutti's server-request handling (`item/{commandExecution,fileChange,permissions}/requestApproval`,
`item/tool/requestUserInput`, MCP elicitation) is a **blocking RPC handler**: the
JSON-RPC handler goroutine builds a `pendingACPRequest{ response chan }`, registers it
in an in-memory `pendingRequests` map, and **parks on `<-response`**; `SubmitInteractive`
non-blocking-sends the decision (`default` → "already answered"). The RPC reply to codex
IS the handler's return. Two structural gaps:

1. **No `serverRequest/resolved` handling.** When codex resolves a server-request
   out-of-band (auto-approve, codex cancel, timeout, another client), tutti never
   learns → the parked handler + the durable `waiting_input` event stall forever.
   This is the cua-driver stall class (1ec14c03).
2. **Pending lifecycle is not durable/reconcilable.** On reconnect/recycle,
   `rejectPendingRequests` rejects all pending; nothing is restored/re-offered.

The approval **detail** IS already emitted durably (`EventCallStarted` + payload;
`TurnPhaseWaitingApproval` already exists), so #418 was a narrower rendering gap —
the deep gap is the pending STATE and its resolution.

## Decision: full optimal — the approval-side of ADR 0005

Cluster E is the same "blocking RPC handler → durable projection + command/observe
responder" inversion as ADR 0005. Unify it into the SAME per-session projection:

1. **Approval = durable pending item in the unified projection.** Its state
   (`pending → resolved{decision} | interrupted`) is reconciled from authoritative
   events + snapshot — not held only in an in-memory map + a parked channel.
2. **`serverRequest/resolved` is the authoritative terminal** for a pending approval
   (the approval-side analog of ADR 0005's "snapshot-says-not-running" terminal
   transition). Handling it fixes the stall class (1ec14c03) and is the immediate,
   low-risk win. Also cover the **unknown/unsupported server-request** path with an
   explicit reject/error surface (design's stated Step 6 requirement).
3. **The responder holds codex's RPC request id and responds async** when the durable
   pending item is resolved — decoupled from a live handler goroutine (cf. t3code's
   `Deferred` + `approvalCorrelations`).
4. **Reconnect policy — interrupted, not silent reject.** A pending approval that
   survives a reconnect is marked **interrupted** in the projection and **re-offered
   / re-driven** (re-run the turn), NOT silently rejected.

## Protocol dependency to verify at implementation

Whether a pending approval can resolve the ORIGINAL RPC after reconnect depends on
**whether codex re-issues the server-request on `thread/resume`** (tutti does not
replay it; not yet confirmed codex re-issues). If codex does NOT re-issue, the
original RPC is dead on reconnect → the durable model can only \*\*display interrupted

- re-drive\*\*, not resolve the dead RPC. So the reconnect policy (item 4) must not
  assume RPC revival. `serverRequest/resolved` is the reconcile signal that keeps the
  durable state honest regardless.

## Sequencing (gate + independence)

- **Gated on Step 4** (like ADR 0005 C): a durable pending approval reconcilable
  against the snapshot needs the Step-4 unified projection to exist first.
- **Does NOT depend on Step 7's Exec inversion.** "Hold codex's RPC + respond async"
  is already what the current blocking-goroutine handler does (a goroutine is cheap
  and holds the JSON-RPC request open); Step 6 keeps that as the strangler shim while
  making the pending STATE durable and adding `serverRequest/resolved`. So Step 6
  (approval) legitimately precedes Step 7 (Exec inversion); it introduces the
  responder-over-durable-state pattern that Step 7 later generalizes to turns.

## Risk control

- **Strangler shim:** keep the current blocking handler as a thin shim OVER the
  durable pending item (park until the durable item resolves), migrate consumers to
  the durable-state + responder API incrementally, remove the shim last. Reversible.
- **`serverRequest/resolved` first** — a small, isolated addition that fixes the
  stall class immediately, independent of the full inversion.
- Per-step green: Cluster E regression tests (#418 detail, approve/deny mapping,
  requestUserInput, unknown-request reject) gate the step; Step-0 corpus stays green.

## Relations

- **Unifies with ADR 0005** — approvals become items in the same projection that
  carries turn state + messages; `SubmitInteractive` is a responder like the turn
  command; both reconcile against the Step-4 snapshot.
- #418 detail is largely handled today; this ADR targets the pending STATE + resolution.

## Live verification (2026-07-02, Phase 0)

Ran against the real binary (`codex-cli 0.142.5`) via the env-gated test
`TestLiveProtocolResumeServerRequestReissue`
(`packages/agent/daemon/runtime/liveprotocol_verify_test.go`,
`TUTTI_LIVE_PROTOCOL_VERIFY=1`): provoke `item/commandExecution/requestApproval`
(read-only sandbox + untrusted policy), leave it unanswered, kill the client
process, resume the thread from a fresh process.

**Verdict: codex does NOT re-issue the pending server-request after
`thread/resume`.** Additionally: the interrupted-mid-approval turn does not
resume (thread status returns `idle`), and the unanswered approval item is NOT
replayed by resume — so a daemon restart leaves no zombie `waiting_input` row
in the rebuilt store either. The conservative reconnect policy stands
confirmed: no RPC revival is possible; pending approvals die with their turn
and the user re-drives. No code change required.
