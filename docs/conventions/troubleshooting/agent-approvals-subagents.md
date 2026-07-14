# Troubleshooting: Agent Approvals And Sub-Agents

[Agent runtime index](./agent-runtime.md) · [All troubleshooting](./README.md)

Approval gates, plan exits, parent/child event attribution, background agents, and Message Center.

### External PR review approvals do not refresh gate status

- Symptom:
  An external contributor's PR has an internal approval, but GitHub still shows
  a red `external-pr-review-gate / external-pr-review-gate` check, often next
  to a green `external-pr-review-gate` commit status.
- Quick checks:
  Inspect the failing run event with `gh run view <run-id> --json event`. If
  the event is `pull_request_review`, check the log for missing
  `TUTTI_RD_MEMBERS` or `Resource not accessible by integration` when creating
  a commit status.
- Root cause:
  `pull_request_review` workflows for external PRs can run with reduced token,
  variable, and secret access. They are not a reliable place to write the
  branch-protection status. A direct review-event gate can also create a second
  check run with the same job name as the trusted `pull_request_target` gate.
- Fix:
  Keep the status-writing gate on trusted `pull_request_target` or
  `workflow_run` execution. If approvals must refresh the gate automatically,
  use a low-privilege `pull_request_review` signal workflow and a trusted
  `workflow_run` refresh workflow that resolves the PR and calls the reusable
  gate.
- Validation:
  Confirm the old caller workflow no longer directly invokes the gate from
  `pull_request_review`. After an internal approval, expect a signal run and a
  refresh run; the refresh run should update the `external-pr-review-gate`
  commit status to match the latest approved, requested-changes, or dismissed
  review state.
- References:
  [.github/workflows/external-pr-review-gate.yml](../../../.github/workflows/external-pr-review-gate.yml)
  [.github/workflows/external-pr-review-gate-review-signal.yml](../../../.github/workflows/external-pr-review-gate-review-signal.yml)
  [.github/workflows/external-pr-review-gate-review-refresh.yml](../../../.github/workflows/external-pr-review-gate-review-refresh.yml)

### Cursor approval card shows only title and options, no command/path detail

- Symptom:
  A Cursor provider approval prompt renders its title (for example "Cursor
  requests your authorization") and the allow/reject options, but the detail
  row that should show the command, file path, or query is empty — unlike the
  same prompt for Codex or Claude Code.
- Quick checks:
  Speak ACP directly to a local `cursor-agent acp` process (initialize,
  `session/new`, `session/set_mode` to `agent`, then a prompt that requires a
  shell/file tool) and inspect the raw `session/request_permission` payload.
  Cursor's permission `toolCall` repeats only `toolCallId`/`title`/`kind`/
  `status`/`content` for a call that already streamed via an earlier
  `session/update` `tool_call`; it does not repeat `rawInput`. Compare against
  the preceding `tool_call` notification for the same `toolCallId`, which does
  carry `rawInput.command`.
- Root cause:
  `normalizedApprovalDisplayInput` only read the permission request's own
  inline `toolCall`. Codex and Claude Code repeat enough of the original input
  on their approval-equivalent requests for that to work, but Cursor's ACP
  implementation does not, so the approval projection had no command/path/
  query fields to show and the card fell back to title-only.
- Fix:
  Track per-turn tool-call state in `acpTurnNormalizer` (already recorded from
  `tool_call`/`tool_call_update`) and expose it by raw `toolCallId` via
  `KnownToolCallInput`. `standardACPPermissionRequested` now passes the
  normalizer through, and `normalizedApprovalDisplayInput` fills any field
  (`command`, `file_path`, `query`, ...) missing from the permission request's
  own `toolCall` from that known prior input before giving up. Other ACP-style
  interactive paths (Codex app-server, Claude SDK) keep passing `nil` for this
  fallback since they do not need it.
- Validation:
  `cd packages/agent/daemon && go test ./runtime/... -run
TestCursorPermissionRequestFallsBackToKnownToolCallInput`. For a live check,
  run the same direct ACP probe from Quick checks with a tier-"agent" session
  and confirm the emitted approval payload's `input` carries the command.
- References:
  [acp_turn_normalizer.go](../../../packages/agent/daemon/runtime/acp_turn_normalizer.go)
  [interactive_projection.go](../../../packages/agent/daemon/runtime/interactive_projection.go)
  [standard_acp_events.go](../../../packages/agent/daemon/runtime/standard_acp_events.go)

### Agent approval controls submit stale permission requests after restart

- Symptom:
  After refreshing or restarting the app around a pending agent approval, the
  conversation may show the turn as ready or complete while an approval/cancel
  control still submits an old request id. Logs can include
  `permission request "...id..." is no longer live` or
  `agent session cancel skipped because no active turn exists`.
- Quick checks:
  Compare the durable agent session status with the runtime session status.
  If the persisted session is `working` or `waiting` but the resumed runtime is
  already idle/ready, verify the service reconciles the stale persisted turn
  before forwarding approve/cancel to the runtime. In the renderer, inspect the
  notification region as well as the in-conversation approval card; a stale
  toast can outlive the message-center waiting item.
- Root cause:
  Runtime permission requests are process-local. After a restart, durable
  activity can still contain an open turn whose provider-side request is no
  longer live. The backend must mark that restored turn idle/failed instead of
  forwarding stale approval or cancel actions. Renderer notifications also need
  to dismiss when the waiting item disappears from the activity snapshot.
- Fix:
  Reconcile stale persisted agent turns on session get/resume and before
  approve/cancel/interactive submit. Mark open tool-call messages in the latest
  turn failed, then report the session idle. Track active renderer approval
  toast ids and dismiss them when their waiting keys are no longer present.
- Validation:
  Add service tests for stale approve and cancel paths, then run
  `pnpm lint:go`, `cd services/tuttid && go test ./... && go build ./...`.
  For desktop UI, run `make dev-web`, trigger a command approval, approve from
  the conversation card, and confirm the waiting count and notification region
  both clear.
- References:
  [service.go](../../../services/tuttid/service/agent/service.go)
  [activity_projection.go](../../../services/tuttid/service/agent/activity_projection.go)
  [WorkspaceChrome.tsx](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/WorkspaceChrome.tsx)

### Claude SDK ExitPlanMode fails as interrupted after plan is ready

- Symptom:
  Claude Code SDK writes a plan, then `ExitPlanMode` appears failed with
  `request interrupted by application restart`. The composer or dock can briefly
  show a spinner, then clear without user approval.
- Quick checks:
  Compare runtime and durable session state. A live SDK interactive turn can
  report `Status=created` while `TurnLifecycle.ActiveTurnID` is non-empty and
  `TurnLifecycle.Phase=waiting_approval`. That is live, not stale. A bare
  runtime `Status=waiting` without `pendingInteractive`, a live background
  agent, or a non-empty active turn lifecycle is stale and should not block
  reconciliation.
- Root cause:
  Stale resume reconciliation is only for restored persisted turns whose
  provider callback no longer exists. If service read/ensure paths look only at
  runtime `Status`, they can misclassify a live SDK synthetic interactive turn
  as idle and mark the pending `ExitPlanMode` tool failed.
- Fix:
  Gate stale reconciliation with full runtime turn state: status, active turn
  id, and phase. Treat `submitted`, `working`, `running`, `streaming`,
  `waiting`, `waiting_approval`, `waiting_input`, and `awaiting_approval` with a
  non-empty active turn id as live. Also treat a runtime pending interactive
  prompt with a non-empty request id as live: a call message can reach durable
  storage before the corresponding turn-lifecycle patch, and stale
  reconciliation must not fail that just-created prompt during the race window.
  Do not treat runtime `Status=waiting` alone as live. When a pending
  interactive request fails or is canceled, emit the failed call and an
  interrupted turn completion so the controller and durable session leave
  `waiting_approval`.
  Only reconcile when no live runtime turn or pending interactive prompt is
  present, or when resuming from durable state after process loss.
- Validation:
  Add agent service tests for `Status=created` plus
  `TurnLifecycle.Phase=waiting_approval` and a synthetic active turn id. `Get`
  and `ensureRuntimeSessionResult` must not call stale reconciliation. Also add
  coverage for `Status=waiting` with no pending interactive/live turn, which
  must reconcile stale durable state.

### Codex app-server subagent output appears as the parent reply

- Symptom:
  A parent Codex AgentGUI turn that spawned subagents ends with a subagent-only
  answer such as `{"n":7}`, or a failed Agent/subagent tool detail shows the
  prompt again under Output even though the tool never returned a result.
- Quick checks:
  Compare `workspace_agent_sessions.provider_session_id` with app-server
  notification `threadId` values in `tuttid.log`/run traces. Inspect
  `workspace_agent_messages.payload` for the suspect tool call: if it has
  `input.prompt`/`input.task` but no `output` or `error`, the GUI must not
  synthesize an Output section from the summary or prompt.
- Root cause:
  Codex app-server streams parent and child-thread notifications over the same
  connection. Transcript, tool, and `turn/completed` notifications must be
  scoped to the active provider thread before they update the parent turn. On
  the renderer side, task-like tools use the summary/title for compact labels,
  but missing result payloads are not tool output.
- Fix:
  Drop notifications that carry a non-empty `threadId` different from the
  session `provider_session_id`, with debug logging that records expected
  thread, event thread, turn, item id/type/status, and method. Keep notifications
  without `threadId` compatible. For Agent/task cards, render Output only from
  actual `output`/`error` payload text, not from the prompt or summary.
- Validation:
  Add a Codex app-server test that injects foreign-thread `agentMessage` and
  `turn/completed` notifications during a parent turn, plus AgentGUI projection
  tests for failed Agent calls with prompt-only payloads. Run the focused Go and
  GUI specs for those paths.

### Claude SDK subagent events overwrite or complete the parent turn

- Symptom:
  A Claude Code SDK parent turn that launched `Task` subagents loses the parent
  answer, finishes early when a child returns `result`, or shows child tool calls
  as unrelated top-level activity instead of under the parent task.
- Quick checks:
  Inspect raw sidecar SDK messages for `parent_tool_use_id`. If that value is
  non-empty, the event belongs to a nested subagent and must not update parent
  assistant text, thinking text, usage, resume cursor, or terminal result state.
  The projected tool metadata should preserve `parentToolUseId` so AgentGUI can
  fold nested calls under the parent tool.
- Root cause:
  Claude Code SDK streams parent and subagent messages through the same query
  loop. Without filtering on `parent_tool_use_id`, nested assistant/result
  messages look like normal parent-turn messages. A parent turn may also settle
  while `runtimeContext.backgroundAgents.count` is still positive; service-layer
  stale resume reconciliation must treat that as live runtime state, otherwise
  it can mark late child tools or approvals as failed with the
  application-restart interruption message while the sidecar reader is still
  draining background events. After the child finishes, the parent may continue
  in a synthetic SDK turn; if that turn emits messages/tools without a
  `turn_started` lifecycle event, AgentGUI can show completed thinking/tool
  rows while the parent is still working and the composer spinner stays idle.
  If a previously failed tool message later completes, durable payload merge
  must clear stale `error` payload data so the UI does not display both the old
  failure and final success.
- Fix:
  Treat non-empty `parent_tool_use_id` as a nested scope marker. Keep child tool
  lifecycle events, but attach `metadata.parentToolUseId`; ignore nested
  assistant text/thinking/usage/result for parent-turn state. For `Task` parents,
  also keep child terminal payloads in task `metadata.steps` when available.
  When the Agent tool reports an async launch, parse `agentId` and `output_file`
  into structured metadata and mark the delegated task status as running. The Go
  SDK adapter must own a persistent single-reader dispatcher for each live
  sidecar session: `Exec` waits on a per-turn waiter, but the reader keeps
  draining after terminal turn events and publishes late background/subagent
  events through the session event sink. Do not make `task_notification` settle
  the parent turn; treat it as task progress/completion metadata only. If a late
  `task_notification` has no task or agent id but there is exactly one running
  delegated task, resolve it to that task so the background agent count can
  clear. Also emit delegated-task completion from the SDK `TaskCompleted` hook;
  some SDK runs finish the child JSONL without a usable `task_notification`, and
  the hook must still clear the runtime background-agent count. When the SDK
  emits `TaskCreated` with only `task_id`, do not bind it to a running
  delegated task by count. Use `parentToolUseId` as the canonical key and treat
  `agentId`/`taskId` as aliases resolved back to an existing Agent tool call;
  otherwise concurrent subagents can cross-bind ids and keep
  `backgroundAgents.count` stale. The same rule applies to `task_started`,
  `task_progress`, `task_notification`, and `TaskCompleted`: Claude Code often
  puts the agent id into `task_id`, so resolve each alias against both the
  task-id and agent-id maps, and never bind an alias that fails to resolve to
  "the only running" task while any registered delegated task already has a
  known alias. During concurrent launches, a child `task_started` can race
  ahead of its own Agent launch result; binding that unknown alias to the
  single already-registered task attributes one agent's completion to another,
  drops the second agent's runtime entry, and clears the composer wait count
  early. The daemon-side `backgroundAgents` map must also treat a sidecar
  update that carries an explicit `parentToolUseId` as canonical: it may merge
  through `agentId`/`taskId` aliases only into an entry whose recorded parent
  tool call is empty or identical, and it must not overwrite an entry's
  recorded `agentId`/`taskId` with a different value. Child assistant messages
  tagged with `parent_tool_use_id` stream through the parent query while the
  child is still running (often seconds after launch), so they are never a
  completion signal; settle a delegated task only from the child `result`
  message, the `task_notification` system message, or the `TaskCompleted`
  hook. Otherwise the first child message marks the task completed, the next
  `task_progress` flips it back to running, and the running background-agent
  count oscillates (for example 2 -> 3 -> 2) without any new launch. A
  `task_progress` that arrives after the task has settled must not resurrect
  it; only an explicit `task_started` may restart a task. When the SDK
  resumes parent work after a background agent, the sidecar must emit
  `turn_started` for the synthetic continuation and the Go adapter must map it
  to `EventTurnStarted`; keep the background-agent wait banner separate from
  this turn lifecycle. The adapter must also forward that synthetic turn's
  `turn_completed` / `turn_failed` / `turn_canceled` through the same session
  event sink. Synthetic turns never register an Exec waiter; treating every
  waiter-less terminal as an untracked orphan drops the close event, leaves
  durable `activeTurn.phase=running`, and keeps AgentGUI on
  "正在规划下一步" after the final assistant message is already complete. Only
  terminals for turns that never published `EventTurnStarted` on the session
  sink should stay dropped (true queued orphans). Top-level assistant text and
  thinking must be keyed by SDK message/content-block segments rather than by
  turn id. Treat the live `content_block.index` as a stream locator only, not
  as durable message identity. Consolidated assistant messages are
  fallback/tail compensation only, because their content array indexes can
  differ from live `stream_event` block indexes when thinking or tools are
  present. Projection code that merges repeated tool-message updates should
  remove stale `error` data when the canonical status becomes completed.
- Validation:
  Add sidecar normalizer coverage for `parentToolUseId`/task steps and adapter
  coverage that terminal-after events still reach DB/UI through the session
  event sink. SDK task lifecycle events should also update
  `runtimeContext.backgroundAgents` from running to completed so composer wait
  copy clears when the background agent finishes. Add service coverage that
  runtime `backgroundAgents.count > 0` suppresses stale resume reconciliation
  even when there is no active parent turn. Add sidecar/adapter coverage for
  synthetic continuation `turn_started` plus the matching waiter-less
  `turn_completed` closing through the session sink, and projection coverage
  that a completed tool update drops an earlier failed `error` payload. Keep
  coverage that never-started queued orphan terminals still drop. For alias
  binding, keep sidecar coverage that an unknown `task_id` racing ahead of its
  own launch does not bind to another running task, and Go adapter coverage
  that an alias conflict with a different recorded parent tool call keeps two
  background-agent entries separate. For completion semantics, keep sidecar
  coverage that a mid-run child assistant message does not complete the
  delegated task (only the child `result` does) and that a trailing
  `task_progress` after settlement does not resurrect the task.

### Claude SDK subagent approval stuck in Message Center

- Symptom:
  A concurrent Claude Code SDK parent turn launches several `Task` subagents, the
  parent turn settles to idle, and Message Center still shows a
  `waiting_approval` tool call for a nested subagent Bash command. Clicking
  approve/reject fails with `interactive request ... is no longer live`, Agent
  GUI may never show the approval card, and `runtimeContext.backgroundAgents`
  can stay positive even though some subagents already returned text in the raw
  JSONL.
- Quick checks:
  Compare runtime `pendingInteractive` with durable `waiting_approval` rows.
  Inspect tuttid logs for `message_update ... is missing turnId` on
  `approval_resolved`. In sidecar logs, check whether the approval resolved
  after the parent turn cleared `activeTurnId`. In the raw Claude session JSONL,
  look for nested assistant messages with `parent_tool_use_id` and
  `stop_reason=end_turn` but no child `result` event.
- Root cause:
  Subagent tool approvals can outlive the parent turn lifecycle. The sidecar may
  emit `approval_resolved` after the active turn id is cleared, so the Go
  adapter persists the completion without `turnId`. Service stale reconciliation
  previously treated live background agents as proof that every open approval
  was still live, leaving ghost durable approvals. Text-only subagent completions
  that finish with a nested `end_turn` assistant message never emitted
  `task_completed`, so background-agent counts stayed stale and submit paths
  kept blocking. For nested launches (a subagent launching its own async
  agents), the grandchild `Task` tool_use blocks only appear inside
  child-stream assistant messages that the sidecar previously dropped, so the
  grandchild task state was never registered: its approvals resolved no turn
  id (the daemon rejects turnless `message_update`s, silently dropping the
  approval card and deadlocking the grandchild), and a child `end_turn`
  assistant could settle the child task while grandchildren were still
  running.
- Fix:
  Store the originating turn id on pending interactive requests in the sidecar and
  Go adapter, and reuse it when emitting `approval_resolved` if the event omits
  `turnId`. Reconcile ghost open approvals whenever runtime has no live
  `pendingInteractive`, even if background agents are still running. When
  `SubmitInteractive` returns a stale no-longer-live error, reconcile the
  persisted approval instead of surfacing the raw failure. Treat nested assistant
  messages with non-empty `parent_tool_use_id` and `stop_reason=end_turn` as
  delegated-task completion when no child `result` arrives, but only once no
  delegated child task launched by that subagent is still running. In the
  Claude SDK sidecar, also parse fold-in `queued_command` attachments and
  user-string `<task-notification>` payloads (not only
  `system/task_notification`), binding completion by
  `tool-use-id`/`tool_use_id` so concurrent async agents settle independently.
  For nested launches: register tool_use blocks from child-stream assistant
  messages, treat the `Async agent launched successfully` result text as the
  authoritative subagent-launch signal even when the tool name is unknown,
  inherit the delegated-task turn id along the parent tool-use chain, and do
  not settle a nested `end_turn` assistant while it still has a child tool_use
  whose tool_result has not been processed. Use the sidecar's pending
  `toolByID` entry for that pre-result window, then rely on the delegated task
  created from the launch result while the grandchild is running. Let
  interactive requests fall back to any delegated task's turn id (settled ones
  included) and open a synthetic turn as last resort rather than emit a turnless
  event.
- Validation:
  Add adapter coverage that stored pending turn ids survive missing
  `approval_resolved.turnId`. Add service coverage for ghost approval reconcile
  with live background agents and stale submit reconciliation. Add sidecar
  coverage that nested `end_turn` assistant text completes the delegated task,
  fold-in `queued_command` notifications complete running agents, and dequeued
  user-string task notifications complete by parent tool use id. For nested
  launches, keep sidecar coverage that a grandchild launch registers with the
  inherited turn id (with and without an observed tool_use block), that a
  nested approval after the parent task completed still carries a turn id, and
  that a child `end_turn` assistant defers completion both while a grandchild
  tool_result is still pending and while the resulting grandchild task is
  running.

### Claude SDK parent waits forever for background agents that already finished

- Symptom:
  A Claude Code SDK parent session launches several async subagents, replies to
  some results ("received result N, waiting for the rest..."), then goes idle
  and never acknowledges the remaining results or produces the final summary.
  `runtimeContext.backgroundAgents` shows every task completed, so the composer
  wait copy has already cleared while the transcript still says it is waiting.
- Quick checks:
  Open the raw Claude session JSONL under
  `~/.claude/projects/<project>/<provider-session-id>.jsonl` and correlate
  three record kinds. `queue-operation enqueue` entries carry each
  `<task-notification>`; a matching later `dequeue` means the notification ran
  as its own follow-up (synthetic) turn, while `remove` plus a
  `queued_command` attachment with `commandMode: "task-notification"` means it
  was folded into the still-active turn instead. Also check for `api_error`
  records (provider 429/limits) that stretch the active turn and widen the
  fold-in window.
- Root cause:
  This is upstream Claude Code queue behavior, not a tutti event loss. Task
  notifications that arrive while a turn is still streaming are removed from
  the pending prompt queue and injected into the active turn as
  `queued_command` attachments. The attachment contains the full notification
  including `<status>`, `<summary>`, and `<result>`, is appended to the model
  `messages`, and stays in the conversation history for later turns, but
  Claude Code will never schedule a dedicated follow-up turn for it. The
  information is therefore in the model context the whole time; weaker or
  custom models can ignore the attachments, keep an incorrect "still waiting"
  count across every later turn, and stall the workflow. Notifications that
  arrive after the turn settles are dequeued normally and produce synthetic
  turns.
- Fix:
  There is no daemon/sidecar data fix because tutti-side projections already
  record the completed tasks; the gap is only in the model's own accounting.
  Reproduce with a stronger model before treating this as a tutti regression.
  If product-level mitigation is required, design it as an explicit nudge
  prompt that restates the sidecar-known completed task list in text, because
  the model already failed to read the same facts from context attachments.
  Keep the composer wait copy semantics driven by
  `runtimeContext.backgroundAgents`; do not try to infer "results not yet
  acknowledged" from transcript text.
- Validation:
  Compare the raw JSONL queue operations against the persisted
  `workspace_agent_messages` rows for the session: every removed notification
  should still have its Agent tool row marked completed from the
  `task_notification` system message, which confirms the daemon saw the
  completion even though the parent model never acknowledged it.

### Interactive response or exact-turn cancel succeeds in the provider but durable state stays pending

- Symptom:
  The provider has consumed an approval response or canceled the requested turn,
  but the HTTP call reports a persistence error, the interaction remains pending,
  or the turn remains active after a daemon restart. Repeating the request may
  report that the interactive request is no longer live.
- Quick checks:
  Inspect `workspace_agent_runtime_operations` for the deterministic
  workspace/session/subject operation. Check `status`, `attempt`,
  `next_attempt_at_unix_ms`, lease owner/expiry, and `last_error`. For a completed
  operation, verify that `workspace_agent_runtime_operation_events` contains an
  unpublished event rather than assuming the activity stream was delivered.
- Root cause:
  A provider side effect and SQLite cannot share one transaction. Calling the
  provider before recording durable intent, or persisting the turn/interaction
  separately from completion and its event, creates a crash window where a
  one-shot provider response is consumed without a recoverable local transition.
- Fix:
  Prepare a deterministic runtime operation before invoking the provider. Claim
  it with a lease, then commit the domain transition, completed operation, and
  event outbox row in one SQLite transaction. Leave an operation leased when
  completion fails, requeue prior-process leases before startup stale-turn
  settlement, and use bounded retry backoff for typed transient errors. Startup
  stale settlement must exclude turns referenced by every prepared/leased
  operation, including operations whose next attempt is still in the future;
  the interrupted turn, session active pointer, pending interaction, and
  restart system notice must commit in one transaction; a settlement database
  error must fail daemon startup. Exact cancel with no controller turn-registry entry must
  reach the adapter and return typed target-absent evidence; do not synthesize
  a completed outcome from the session view. Treat an
  interactive request as already consumed only when a typed runtime error and
  the live registry agree for the same request id. Drain outbox events
  independently; a publish failure must not acknowledge or delete the row.
- Validation:
  Use a fake clock and step-driven worker tests for prepare-before-side-effect,
  atomic completion rollback, lease expiry/takeover, duplicate submission after
  completion, startup lease recovery ordering, typed transient backoff, and
  outbox publish failure. Include a database failure after provider success and
  verify recovery reaches exactly one terminal operation without reverting a
  terminal interaction.
