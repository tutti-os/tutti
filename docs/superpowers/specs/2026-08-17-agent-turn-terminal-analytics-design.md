# Agent Turn Terminal Analytics Design

## Summary

Add reliable local-desktop analytics for the terminal result of a user-submitted Agent turn. The implementation reuses the VM event family without the VM suffix:

- `agent.turn_completed`
- `agent.turn_failed`
- `agent.turn_cancelled`

The canonical Host turn settlement is the only terminal trigger. The desktop UI mode is captured when the user submits the turn, persisted with the turn submission envelope, and reused when the daemon reports the terminal event. Therefore every reported event has `mode=os` or `mode=agent`; the implementation never reports a terminal event with a missing, `null`, inferred, or hard-coded mode.

This event measures a technical terminal result. `completed` means that the canonical Agent turn completed successfully; it does not prove that the answer satisfied the user's goal.

## Motivation and VM Evidence

The VM implementation established the useful three-event model, but its current data has two producers:

- a renderer producer that knows the UI mode but can miss a settlement after its window closes;
- a daemon producer that observes canonical settlements but does not know the submitting window's mode.

A diagnostic DataFinder query for 2026-08-03 through 2026-08-16 found a `null` mode on 286 of 970 VM completed events, 33 of 103 failed events, and 38 of 61 cancelled events. Copying either VM producer alone would retain one of those defects.

The local implementation must combine the useful properties of both paths: durable submission-time mode and canonical daemon-side settlement.

## Goals

- Report one terminal analytics event for each newly submitted, user-prompt root turn that reaches a canonical terminal outcome.
- Preserve the exact submitting window mode, even if the window closes, the user changes modes, or the daemon restarts before settlement.
- Keep completion, failure, and cancellation definitions aligned with canonical Host outcomes.
- Exclude child Agent turns, automatic Goal turns, provider-initiated turns, imported history, and legacy turns that have no validated submission mode from the product completion metric.
- Reuse VM-compatible parameter names where the local product has an authoritative value.
- Keep prompts, responses, paths, raw error messages, and other content out of analytics.

## Non-goals

- Semantic grading of whether the Agent solved the user's problem.
- User feedback, thumbs-up/down, or answer-quality analytics.
- Retrofitting terminal events for turns created before this release.
- Measuring provider-native child/subagent success with the product event family.
- Changing Host turn lifecycle or settlement semantics.
- Updating the existing DataFinder dashboard in this pull request.

## Considered Approaches

### 1. Persist submission mode and report canonical settlement (selected)

Capture `os` or `agent` on create/send, persist it with the canonical turn's submission envelope, and report from `CommittedDelta.RootTurnsSettled`.

This remains correct when the renderer disappears and preserves mode across restarts. It adds a narrow request-contract and persistence change, but it is the only approach that satisfies both reliability and mode completeness.

### 2. Port the VM renderer observer

Observe settled turns in the renderer and rely on the renderer reporter's common `mode` parameter. This is smaller, but it misses turns that settle after the window closes and risks duplicate reports across reloads or multiple observers.

### 3. Report directly from the daemon without submission mode

Observe canonical settlements in the daemon without adding submission provenance. This gives reliable outcomes but reproduces the VM `mode=null` bucket and makes OS-versus-Agent rollout analysis incomplete.

## Architecture and Ownership

The change does not define when a turn becomes terminal. `packages/agent/host` remains the sole owner of lifecycle semantics and already exposes exhaustive post-commit settlements through `CommittedDelta.RootTurnsSettled`.

The implementation has three bounded responsibilities:

1. **Desktop submission context**: the workspace window composition passes its already-authoritative route mode (`os` or `agent`) into the desktop Agent activity adapter. The adapter adds that value to typed submit diagnostics for create and send requests.
2. **Durable submission provenance**: the daemon validates the mode, carries it in Host submission metadata, and persists the metadata JSON in the existing `TurnSubmission` envelope. The Host does not interpret the product mode or change lifecycle behavior.
3. **Analytics adapter**: `services/tuttid/service/agent` consumes `RootTurnsSettled`, reads the matching submission envelope, applies the product population rules, and emits one terminal event through the existing daemon analytics reporter.

The analytics adapter belongs in `services/tuttid` because event naming, population policy, and DataFinder parameters are product analytics concerns. No second settlement state machine is introduced.

## Data Flow

1. A user submits an initial prompt or follow-up from a workspace window.
2. The desktop adapter sends `submitDiagnostics.uiMode` with the exact route mode.
3. The daemon accepts only `os` or `agent` and adds the value to submission metadata.
4. Host admits the turn and persists the existing turn submission envelope, including the metadata JSON and client submit ID.
5. The canonical turn reaches `settled` with outcome `completed`, `failed`, `canceled`, or `interrupted`.
6. Host publishes the committed `RootTurnSettled` fact after the canonical transaction commits.
7. The tuttid analytics adapter reads the persisted envelope by workspace, session, and turn ID.
8. If the turn is eligible and has a valid mode, the adapter reports exactly one event. Missing or invalid mode causes the event to be skipped and logged as a content-free diagnostic; it is never replaced with a guessed value.

## Product Population

A terminal event is reported only when all of the following are true:

- the committed entity is a canonical root turn;
- `is_child_session` is false;
- `turn.origin` is `user_prompt`;
- `turn.backfilled` is false;
- the persisted submission mode is exactly `os` or `agent`.

Goal arm/continuation turns, provider-initiated turns, child sessions, imported turns, and legacy turns without mode are excluded. This keeps the terminal numerator compatible with user-submission analytics and prevents automatic work from inflating completion counts.

## Outcome Mapping

| Canonical outcome | Event | `status` | Notes |
| --- | --- | --- | --- |
| `completed` | `agent.turn_completed` | `completed` | Technical completion |
| `failed` | `agent.turn_failed` | `failed` | Canonical failure |
| `canceled` | `agent.turn_cancelled` | `cancelled` | User/runtime cancellation |
| `interrupted` | `agent.turn_cancelled` | `cancelled` | Distinguished by `turn_outcome=interrupted`; startup recovery is identified separately |

The event family is mutually exclusive for a canonical turn. A repeated observation that does not represent a newly accepted canonical settlement must not create another event.

## Event Parameters

All three events include:

| Parameter | Value |
| --- | --- |
| `mode` | Required `os` or `agent` captured at submission |
| `agent_session_id` | Canonical Agent session ID |
| `turn_id` | Canonical turn ID |
| `client_submit_id` | Stable submit correlation ID when present |
| `invocation_id` | Canonical turn ID for VM-compatible correlation |
| `operation_id` | Canonical turn ID for VM-compatible correlation |
| `provider` | Canonical provider, normalized to `unknown` only if absent |
| `duration_ms` | Non-negative `settled_at - started_at` when timestamps are valid |
| `duration_bucket` | Stable bounded duration category |
| `turn_outcome` | Exact canonical outcome |
| `turn_origin` | `user_prompt` |
| `status` | Event-family status from the mapping above |
| `event_source` | `canonical_turn_settled` |
| `interaction_source` | `user` |
| `surface` | `direct_session` |
| `agent_kind` | `local-agent` |
| `is_child_session` | `false` |
| `startup_reconciled` | Whether Host settled the turn during startup recovery |
| `viewer_relationship` | `self` |
| `viewer_role` | `owner` |

`agent.turn_completed` additionally includes `value_enum=completed`.

`agent.turn_failed` additionally includes:

- `failure_stage=settled`;
- `error_category=runtime` for VM compatibility in the first version;
- a bounded, content-free `error_code`, falling back to `agent_unknown_error`.

It does not include the canonical raw error message. Provider error messages may contain paths, prompts, command output, or credentials and are not safe analytics dimensions.

`agent.turn_cancelled` additionally includes `source=runtime_event` or `source=startup_reconciliation`.

Workspace IDs, prompt/response content, file paths, command output, and raw errors are not reported.

## Reliability and Failure Handling

- Terminal analytics is triggered only after canonical commit and cannot affect the command result.
- The existing analytics reporter remains best effort and owns transport buffering/retry behavior.
- Failure to read a submission envelope or validate its mode skips the event and emits only a local structured diagnostic with correlation IDs. It does not produce a `null`, `unknown`, or fabricated mode.
- A startup-reconciled interrupted turn is eligible only if its original user submission already persisted a valid mode. It reports as cancelled with `startup_reconciled=true`.
- Old rows receive an empty metadata value during migration and are intentionally excluded.

## Storage and Compatibility

The existing turn-submission table gains a non-null metadata JSON column with an empty-object default. Record/get conflict checks include the new field so an idempotent replay cannot silently change the submitting mode.

The OpenAPI submit diagnostics schema gains optional `uiMode` with the closed enum `os | agent`; generated Go and TypeScript clients are regenerated from the schema. Older clients remain compatible because the field is optional. New desktop requests always populate it for user submissions.

The storage and transport changes are platform-neutral. They add no paths, process behavior, shell behavior, native dependencies, or OS branches, so Windows and POSIX behavior are identical.

## Testing

Focused tests cover:

- desktop create and send requests include the exact workspace window mode;
- the OpenAPI adapter accepts `os` and `agent` and rejects/omits invalid values;
- turn submission metadata persists and is preserved across reads and idempotent replay;
- completed, failed, canceled, and interrupted canonical settlements map to the expected event and parameters;
- child, Goal, provider-initiated, backfilled, missing-mode, and invalid-mode turns produce no product terminal event;
- startup-reconciled interruption reports cancellation with the recovery marker;
- raw error messages are never present in event parameters;
- repeated/non-accepted settlement projections do not double-report.

Validation uses the repository's changed-aware check plus focused desktop, store-sqlite, and tuttid Agent package tests. The Agent Host boundary check must pass because the change observes existing lifecycle facts rather than adding adapter-owned lifecycle behavior.

## Rollout and Data Validation

After a build containing this change reaches production, DataFinder validation should use that app version or later and verify:

- `mode` contains only `os` and `agent`; `null` is zero;
- a `turn_id` appears in at most one event across the three-event family;
- `turn_origin=user_prompt` and `is_child_session=false` for all rows;
- completed, failed, and cancelled event totals reconcile with canonical user-turn terminal outcomes;
- the dashboard excludes `startup_reconciled=true` from ordinary user cancellation-rate interpretation.

Recommended product metrics are:

- technical completion rate = completed terminal turns / all terminal turns;
- failure rate = failed terminal turns / all terminal turns;
- cancellation rate = cancelled terminal turns / all terminal turns;
- terminal coverage = terminal turns / submissions after applying an observation window long enough for active work to settle.

OS-versus-Agent comparisons group these metrics by the required submission-time `mode`. Existing dashboards are unaffected until they explicitly add the new event family.
