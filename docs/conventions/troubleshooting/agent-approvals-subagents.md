# Agent Approvals And Child Sessions

Approval gates, plan exits, provider-native child-session attribution, root
settlement, cancellation, and Message Center.

The canonical child-agent architecture is
[`2026-07-15-provider-native-subagents.md`](../../specs/2026-07-15-provider-native-subagents.md).
Do not diagnose current recordings through retired timeline ownership fields or
session-level child summaries.

### External PR review approvals do not refresh gate status

- Symptom: an external review is approved, but the gate remains waiting.
- Check: compare the external review event identity with the persisted
  interaction request and its latest version.
- Cause: the refresh path updated display data without resolving the canonical
  interaction.
- Fix: normalize the provider event to the same request identity and commit the
  interaction transition before publishing the activity update.
- Validate: replay the same event twice and confirm one terminal interaction and
  one stable UI state.

### Approval card lacks command or file-change detail

- Symptom: a Cursor or Codex approval card shows only a generic title and
  options, without the command or changed-file paths.
- Check: correlate the approval request with the earlier same-turn tool item.
  Cursor may omit `rawInput` from `session/request_permission`; Codex may send
  `changes` on `item/started` but only the matching `itemId` on
  `item/fileChange/requestApproval`.
- Cause: a later empty or partial tool update replaced the earlier input, or
  the approval path consulted the root normalizer instead of the exact child
  turn normalizer.
- Fix: merge partial tool updates into the per-turn snapshot, expose the saved
  input through `KnownToolCallInput`, and pass the exact root or child turn
  normalizer into approval projection. AgentGUI renders structured `changes`
  or `fileChanges`, `grantRoot`, and a standalone `reason`; approval reasons and
  correlated file-change directories render directly below the title without
  duplicate Summary or Path cards, and the title states that the authorization
  is for editing files. Runtime adapters normalize the provider tool kind into
  interaction metadata `approvalPurpose=edit-files`; GUI prompt projection uses
  that semantic purpose and must not infer authorization intent from rendered
  file details. A lone `grantRoot` outside a file-change approval remains a
  labeled path detail. These remain approval previews, not evidence that a file
  change executed.
- Validate: cover Cursor known-input fallback and Codex root and child
  file-change approvals. When absolute paths share a directory, render that
  directory once and show relative file paths beneath it. Confirm the reason
  and correlated directory appear once below the title.
- References:
  [acp_turn_normalizer.go](../../../packages/agent/daemon/runtime/acp_turn_normalizer.go)
  [codex_appserver_event_interactive.go](../../../packages/agent/daemon/runtime/codex_appserver_event_interactive.go)
  [interactive_projection.go](../../../packages/agent/daemon/runtime/interactive_projection.go)

### Approval controls submit a stale request after restart

- Symptom: approve/reject returns that the request is no longer live, while the
  UI still shows it pending.
- Check: compare the durable interaction tuple
  `(agentSessionId, turnId, requestId)` with the live adapter registry and
  `workspace_agent_runtime_operations`.
- Cause: startup settlement or a provider terminal resolved the live request,
  but its durable interaction did not transition atomically.
- Fix: prepare the runtime operation before provider submission; complete the
  interaction, operation, and outbox event in one transaction. Startup recovery
  must process leased operations before settling stale turns.
- Validate: inject a database failure after provider success and confirm retry
  reaches one terminal operation without submitting the provider response twice.

### Approved call remains waiting after the Turn completes

- Symptom: the provider accepts an approval and completes the Turn, but the
  historical approval row has no `call.completed` event or an adapter test
  intermittently waits forever for that event.
- Check: compare the write of the provider response, emission of the matching
  call-resolution event, and handling of the provider's immediate Turn terminal.
- Cause: provider acknowledgement and call resolution were not serialized with
  Turn finalization. A fast terminal notification closed the event stream before
  the response goroutine emitted `call.completed`.
- Fix: hold the active Turn processing boundary across the response write and
  call-resolution commit. Let the queued terminal notification finalize only
  after that boundary is released.
- Validate: use a transport that emits the terminal notification immediately
  after receiving the approval response, then stress the test and assert the
  call-resolution event always precedes the Turn terminal.

### Kimi Code split-frame approval or AskUserQuestion lacks detail

- Symptom: the Turn says it is waiting for an answer, and the transcript may
  contain an `AskUserQuestion` tool row, but AgentGUI shows no selectable
  question card.
- For an ordinary approval, the unsafe variant is a selectable card with only a
  generic title and options because the file path or command has not arrived.
- A second failure can appear after the card is fixed: AgentGUI shows
  `回答：<choice>`, but Kimi's tool output contains `answers: {}` and says the
  user dismissed the question.
- Check: compare the pending canonical Interaction with the matching tool-call
  message. The broken signature has `kind=question` and
  `tool_name=AskUserQuestion`, but its `input.questions` is absent while the
  same-Turn tool row contains the complete questions and options.
- For the empty-answer form, inspect the response to
  `session/request_permission`. Kimi expects
  `outcome.outcome=selected` with
  `outcome.optionId=q0_opt_<index>`; a renderer-shaped
  `outcome.outcome=submit` with an answer payload is treated as cancellation.
- Cause: Kimi Code can send `session/request_permission` with the request
  identity and selectable outcomes before sending the matching `tool_call`
  update with the question body. A synchronous permission handler blocks that
  later frame; publishing the partial Interaction first also makes the missing
  input permanent because pending Interaction input is immutable. After the
  user answers, ACP still requires one of the provider's opaque option IDs;
  canonical GUI answer labels are not themselves a valid permission response.
- Fix: keep the ACP reader active while the provider waits, correlate the two
  frames by exact Turn and `toolCallId`, and publish `interaction.requested`
  only after the question input is complete. Hide the same incomplete request
  from `SessionState.PendingInteractive`; otherwise session-state reconciliation
  can persist an immutable partial Interaction before the event is ready. Keep
  response delivery and local call resolution ahead of the provider terminal
  caused by that response.
  Apply the same hidden-until-detail rule to ordinary Kimi approvals: never
  publish an actionable approval without display input, never join a different
  Turn or `toolCallId`, and do not use a timer to expose partial state. If no
  matching detail frame arrives, normal Turn cancellation sends ACP
  `session/cancel`, interrupts and removes the pending request, and emits no
  `interaction.requested` or `interaction.superseded` for that hidden request.
  For Kimi Code 0.29.x's one-shot question bridge, require exactly one
  single-select question whose labels map one-to-one to the request's
  non-rejection permission options; mark it option-only and fail the provider
  request for multi-question, multi-select, free-text, malformed, duplicate,
  or mismatched shapes. Preserve the accepted canonical answer payload
  locally, resolve the single scalar `answersByQuestionId[questionId]` value
  against the request's permission options, and send ACP `outcome=selected`
  with the matching `optionId`. Never use the display-oriented flat `answers`
  list as a routing fallback. Do not generalize this one-shot limit to ACP
  providers that emit a correlated sequence of question permission requests;
  those require an explicit multi-request transaction before Tutti may expose
  a richer question surface.
- Validate: replay permission-before-tool-input ordering, assert exactly one
  question Interaction with the complete question/options, submit an answer,
  assert the provider receives `selected` with the expected opaque option ID,
  and assert `call.completed` precedes the provider Turn terminal. Also replay
  multi-question and multi-select inputs and assert no
  `interaction.requested` is published, plus submit an ambiguous canonical
  answer and assert the Interaction is superseded rather than completed.
  For an ordinary approval, cover matching and mismatched Turn/tool identities,
  preserve a Windows path in the joined input, and cancel a no-update request;
  assert the provider receives `session/cancel`, the pending entry is removed,
  its terminal disposition is interrupted, and neither requested nor
  superseded Interaction is emitted.
  Repeat under the Go race detector.
- References:
  [acp_pending.go](../../../packages/agent/daemon/runtime/acp_pending.go),
  [standard_acp_turn.go](../../../packages/agent/daemon/runtime/standard_acp_turn.go),
  [standard_acp_stream.go](../../../packages/agent/daemon/runtime/standard_acp_stream.go),
  [standard_acp_events.go](../../../packages/agent/daemon/runtime/standard_acp_events.go)

### Claude SDK ExitPlanMode is reported as interrupted after plan completion

- Symptom: the plan is visible, but the approval row becomes interrupted or
  the follow-up implementation never starts.
- Check: distinguish provider-native `ExitPlanMode` interaction from Tutti's
  synthetic plan-implementation decision.
- Cause: the two paths were treated as one request or a terminal event was
  attributed to the wrong turn.
- Fix: provider-native exit-plan stays on the exact interaction tuple. Synthetic
  implementation uses its durable plan-decision operation and stable
  `clientSubmitId` reconciliation.
- Validate: cover both paths independently, including replay after daemon
  restart.

### Codex child output appears as the root reply

- Symptom: the root answer contains child-only output, or child tools render as
  top-level root rows.
- Check: correlate app-server `threadId` with the root
  `provider_session_id` and the child session's provider thread handle.
- Cause: notifications sharing one connection were normalized against the root
  session instead of their registered child thread. The live publication
  boundary can also receive root and child Activity Events in one callback; if
  that mixed batch is projected under the root scope, the business-event bridge
  rejects every child delta and emits a reconcile request for every delta.
- Fix: unknown foreign threads never mutate the root. A registered child thread
  emits events owned by its child session/turn and carries immutable root and
  parent relations. The Controller groups live projections by canonical
  `AgentSessionID` before publication, and AgentGUI keeps child rows out of the
  root transcript and attaches them under `parentToolCallId`. The business-event
  bridge coalesces concurrent/recent reconcile requests per workspace/session
  while retaining bounded retries.
- Validate: inject root, known-child, and unknown-thread notifications in one
  run; assert three distinct routing outcomes. Then replay one root plus at
  least three children with high-frequency deltas and assert each scope matches
  its payload and one reconcile request is emitted per throttle window.

### Codex subagents ran but AgentGUI shows no child lanes

- Symptom: Codex rollout data contains child threads, but the canonical store
  has no child sessions and AgentGUI shows only the root conversation.
- Check: compare `thread/read(includeTurns=true)` spawn items with
  `workspace_agent_sessions`. A current Codex app-server may report a spawn as
  `subAgentActivity(kind=started, id, agentThreadId)` instead of
  `collabAgentToolCall(tool=spawnAgent, receiverThreadIds)`.
- Cause: the adapter recognized only one provider-native spawn representation,
  so it persisted neither the parent delegation card nor the child
  Session/Turn. This is an adapter normalization gap, not an AgentGUI lane
  projection bug.
- Fix: normalize both explicit representations into the same parent call and
  canonical child relation. Keep duplicate notifications idempotent and retain
  the existing post-cancel interrupt boundary.
- Validate: replay the exact observed item shape; assert parent call plus child
  Session/Turn creation, duplicate suppression, and late-child interruption
  after root cancellation.

### Claude SDK child events overwrite or complete the root turn

- Symptom: a child result replaces the root answer, the root completes while a
  child is still running, or nested tools appear at root level.
- Check: inspect `parent_tool_use_id`, child session/turn ids, and the retained
  root provider terminal record. For Claude SDK continuation ordering, filter
  `tuttid.log` by
  `event=agent_session.claude_sdk.lifecycle_event` and the root agent session
  id, then compare the per-session `sequence` values. An
  `sdk_lifecycle_observed` entry records the bounded raw SDK message type and
  subtype before the sidecar projection; the following `task_completed`,
  `turn_started`, and terminal entries record the normalized order. These
  diagnostics intentionally exclude prompt, content, summary, and error text.
  The former failure signature has the final child `task_completed` and SDK
  `task_notification` followed by canonical root settlement/composer unlock,
  then a later root assistant observation and synthetic `turn_started`.
- Cause: a nested SDK message was treated as root-owned, or SDK
  `turn_completed` was projected directly as canonical root completion.
- Fix:
  - Create the child session and submitted child turn from the earliest parent
    `Task` tool-use event.
  - Bind `taskId` and `agentId` only as aliases of that recorded child.
  - Keep child messages, tools, interactions, and terminals on the exact child
    session/turn.
  - Normalize SDK root terminal as a root-provider fact. `services/tuttid`
    settles the root only after every nested child turn is terminal.
  - Treat later SDK continuation ids as provider turns attached to the same
    canonical root turn.
  - At the final async-child notification boundary, reserve the synthetic root
    provider turn before emitting the child terminal. The expected normalized
    order is `turn_started` and then `task_completed`; the later root assistant
    confirms that reserved provider turn instead of opening another one.
  - Identify background follow-up results from
    `origin.kind=task-notification`. Do not compare task-notification and result
    counts: the SDK may coalesce queued follow-ups.
  - If the background level or task notifications make continuation pending
    before the ordinary root result, retain the original root Turn until
    session idle. Do not emit `turn_completed(root)` followed by
    `turn_started(synthetic)`: with every child already terminal, durable state
    can settle between those events and must reject the late provider start.
  - Settle normally on `session_state_changed: idle`, after the SDK has flushed
    its held-back result and exited the background-agent loop. Do not start a
    post-result settlement timeout: queued follow-ups may begin several seconds
    apart, so interrupting that wait converts valid work into provider errors.
  - If root output does not begin within 30 seconds, emit the
    `continuation_delayed` warning, complete the reservation with
    `stop_reason=background_agent_continuation_timeout`, interrupt the pending
    SDK query, and drop that continuation's later output. Cancellation disarms
    the same timeout and the pending background-task quiescence timer, and
    preserves the durable canceled outcome.
  - Record a failed or canceled root result in the background-task lifecycle
    owner. A later empty level or task notification may finish child state, but
    must not reserve another synthetic root Turn.

  Do not infer native SDK order from persisted message timestamps. Use the
  per-session lifecycle sequence to verify that the adapter-established
  provider start precedes the final normalized child terminal and that root
  output either confirms that provider turn or reaches the bounded timeout.

- Validate: test both event orders—root terminal before the last child and last
  child before root terminal—plus coalesced notifications/results, session
  idle, delayed idle without early settlement, continuation start, timeout,
  late-output rejection, cancellation during the quiescence grace, late
  empty-level/task-notification signals after root failure, and guidance during
  the reserved window. Confirm that composer availability follows only the
  durable canonical root.

### Claude child card shows a generic Agent title and no task detail

- Symptom: the child lifecycle is correct, but AgentGUI renders a generic
  `Agent` name and only a last-activity label such as `Bash` or `Read`; the
  delegation description or prompt is missing.
- Check: compare the earliest `tool_started` payload with the later matching
  `tool_completed` payload, then inspect the persisted child title and the
  parent turn's tool-call row. A healthy completion keeps the full input and
  does not end as `turn_completed_without_call_result`.
- Cause: Claude may emit a generic start before the full delegation input. If
  the adapter resolves the later completion through the spawned child's own
  alias, it moves that completion from the parent turn into the child turn.
  The parent normalizer then falsely closes the still-open call as missing a
  result, while the child session keeps its early generic title.
- Fix: keep every lifecycle event for the delegation tool call on its launching
  parent turn; use only an explicit nested `parent_tool_use_id` to select a
  parent child turn. Resolve that same owner before applying the closed-Turn
  fence; checking child aliases first can discard a valid parent completion
  after the child settles. Merge a later real description into the existing
  child session and publish a normal child title update. The compact card may
  still show only the latest child activity, but its name and task strip come
  from canonical child/parent data rather than that activity label.
- Validate: start with a generic Agent event, finish the same call with a full
  description and prompt, then settle the root provider turn. Assert one
  completed parent call with full input, one updated child title, no synthetic
  missing-result failure, and a child lane containing the expected name/task.

### Claude Goal completes while a child is still running

- Symptom: Goal shows complete and the SDK root call has returned, but the root
  composer remains busy and the conversation still shows waiting.
- Check: inspect the three independent facts: Claude Goal metadata, the retained
  root provider terminal, and canonical child turns under the root turn.
- Expected: `goal=complete`, canonical root `turn=waiting`, and child
  `turn=running` is valid. The SDK must not be held open, and Goal completion
  must not clear the root active-turn reference, unlock the composer, or permit
  a new canonical turn.
- Fix: keep Goal as provider-native session metadata, normalize Claude
  `turn_completed` as `root_provider_turn_completed`, and let
  `services/tuttid` apply the retained provider outcome when the last child
  becomes terminal. Do not wait for Claude to send a second terminal event.
- Validate: cover the valid three-state combination, assert the root composer
  remains blocked, then settle only the child and assert the root completes
  without another Claude terminal.

### Child approval is stuck or persisted on the root

- Symptom: a child approval remains visible or submission reports that the
  request is no longer live. Another form renders and submits correctly, but
  the durable interaction and approval call row belong to the root session and
  turn instead of the child. In a transport-correlation variant, the
  interaction is on the correct child and `interactive_response` remains
  prepared after approval. Its error says the sidecar disposition is unknown.
  In a projection variant, the interaction and operation are already answered,
  but the project-list attention icon remains until the turn settles and the
  runtime log reports `workspace agent session kind is immutable`.
- Check: confirm the UI action carries the exact child
  `(agentSessionId, turnId, requestId)` tuple. Then verify the child's root
  relation points to the live root provider session. For Claude SDK, also
  inspect the permission callback and sidecar `approval_requested` payload:
  a child callback must carry SDK `agentID` through as provider `agentId`.
  Compare the canonical child turn stored on the interaction with the provider
  `turnId` from that callback and with the `turnId` sent in both
  `submit_interactive` and `interactive_disposition`. If durable state is
  already answered, inspect the resolved event report: its agent session id,
  session kind, root/parent fields, and turn id must consistently describe the
  child. For Codex, correlate the app-server server request's `threadId` and
  `itemId` with the persisted command tool call. If the command is child-owned
  while the Approval row is root-owned, the server-request path bypassed the
  registered child-thread route.
- Cause: the prompt was aggregated into the root conversation and later
  submitted using the root tuple, or the controller tried to find a separate
  live runtime for the child. Claude-specific root attribution can also happen
  when the sidecar drops the callback `agentID`; the callback still carries the
  current provider/root turn id, which identifies transport lifecycle but not
  the canonical owner of the interaction. Conversely, once ownership is
  correctly scoped to the child, reusing that canonical child turn id as the
  sidecar correlation id makes the sidecar look in the wrong pending-request
  bucket. A separate projection bug occurs when a child-scoping helper writes
  only relation fields but leaves the root agent session id on an acknowledgment
  event; persistence correctly rejects that mixed identity. Codex has the same
  ownership hazard when notifications route by `threadId` but JSON-RPC server
  requests are normalized directly against the active root turn. Its
  `serverRequest/resolved` notification can also strand child pending state if
  child-notification filtering drops it before the shared registry is reached.
- Fix: `services/tuttid` resolves the durable child relation and supplies both
  root and target identity. The controller locates the shared runtime by root
  session and passes the child target to the adapter. The Claude sidecar
  preserves `agentID`, and the adapter resolves it through the recorded child
  aliases before persisting the interaction. The adapter retains the original
  provider turn id separately and uses it only for sidecar submission and
  disposition queries. Do not register a second mutable child-state authority
  in the controller, infer ownership from the provider turn id alone, or replace
  provider correlation with the canonical child turn. Child event scoping must
  replace the event agent/provider session identity and relation fields as one
  operation, even though the event is delivered through the shared root runtime.
  The Codex adapter applies the registered child-thread lookup to both
  notifications and server requests, stores pending state under the canonical
  child tuple, and resolves provider out-of-band notifications through that
  child target. An unknown non-root request is rejected rather than persisted
  on the root.
- Validate: keep a focused test where only the root runtime is registered, yet
  the adapter receives the exact child target and the durable child interaction
  becomes answered/superseded. For Claude, cover a child permission callback
  whose `turnId` is the root provider turn and whose `agentId` identifies the
  child; both requested and resolved events must use the child session/turn,
  while initial submit and lost-ack disposition query both retain the provider
  `turnId`. Also cover the acknowledgment path and assert its projected state
  patch and message update are child-owned, so the pending indicator clears
  before the root turn settles. For Codex, request an approval on a registered
  child `threadId`, submit it through the child tuple, and assert both requested
  and resolved events remain child-owned. Separately send
  `serverRequest/resolved` on that thread and assert the child request becomes
  superseded without a root interaction.

### Root remains active after all child turns settle

- Symptom: child lanes are terminal but the root composer remains busy.
- Check:
  - root provider terminal row and pending outcome;
  - every child session whose `rootTurnId` equals the active root turn;
  - each child's canonical active/latest turn;
  - root session `active_turn_id`.

- Cause: a child terminal did not trigger root-gate evaluation, or a later
  provider continuation opened without publishing its root-provider lifecycle.
  In the Codex adapter, a child can outlive the root Turn. If its terminal
  notification arrives after that root active-Turn emitter is detached, the
  session-level handler must not discard the reduced child event or attach it
  to a newer root Turn's emitter. A newly started client must also refresh the
  live root provider-thread identity before routing that notification; the
  startup Session snapshot predates `thread/start` and may not contain it.
  If provider logs contain `turn/completed` and the controller emits an event,
  but the root turn's persisted root-provider columns are empty, check that the
  runtime reportable-event filter includes both root-provider lifecycle event
  types; stream publication alone does not update durable state.
- Fix: child terminal, exact child-cancel completion, and root-provider terminal
  transitions all run the same durable root settlement check. The Codex
  session-level handler refreshes the live root provider-thread identity and
  compares each child event's canonical `rootTurnId` with the active root
  Turn. Matching events stay on that Turn's emitter; detached events go through
  the root runtime's Session event sink with an adapter lifecycle snapshot. The
  Controller applies the same commit-before-publish barrier to terminal events
  from that sink, so a child terminal is durable before consumers observe it.
  It does not replay unrelated unowned root events. The final
  transition atomically clears the root active-turn pointer, emits the root turn
  update, and reconciles the controller's root runtime view. Root-provider
  lifecycle events must reach `services/tuttid` through the state-report path.
- Validate: cover concurrent and nested children, failed children, and a later
  root continuation. Complete the root first and deliver a child terminal
  through the actual session-level transport handler both with no active root
  Turn and while a newer root Turn is active. Assert that the child terminal
  bypasses the newer emitter, reaches the Session event sink, waits for the
  durable report before stream publication, and remains unpublished when that
  report fails. Child failure may remain visible without forcing root failure.

### Provider terminal report replays a settled root as running

- Symptom: the UI and durable root appear settled, but logs immediately report
  `workspace agent activity turn transition was rejected`. Older summaries may
  misleadingly show `turn=-` on the rejected state patch.
- Check: inspect the same patch's explicit `Turn`, runtime `TurnLifecycle`, and
  `RootProviderTurn` fields. A provider lifecycle patch may legitimately have
  no explicit canonical `Turn`; it must not inherit a running/waiting lifecycle
  that `services/tuttid` then converts into a turn transition.
- Cause: persistence-report enrichment copied the controller's runtime
  lifecycle snapshot onto every state patch, while the service treated a bare
  `TurnLifecycle` as a fallback canonical turn fact. A late provider terminal
  could therefore attempt `settled -> running`; SQLite correctly rejected the
  invalid regression and rolled back the report.
- Fix: persisted event reports receive stable session metadata only. Keep full
  runtime lifecycle enrichment on the live stream, and require an explicit
  structured `Turn` patch for every canonical turn mutation. Do not relax the
  SQLite transition guard. Log summaries should include both
  `turnLifecycle` and `rootProviderTurn` so the two facts are distinguishable.
- Validate: settle a root, then report a matching provider terminal while the
  controller snapshot still says waiting/running. Assert the provider terminal
  persists, no canonical turn transition is derived, the root stays settled,
  and no transition-rejected error is emitted.

### Root cancellation does not stop or settle child turns

- Symptom: root stop returns, but one or more child lanes keep running or
  reappear after late provider events. A second form looks correct in the UI,
  but provider logs show a later unowned root `turn/started` or another child
  spawn after the canonical root was canceled. A third form looks correct in
  the UI while `publish runtime operation outbox` retries every second with
  `data.turn.error requires failed or interrupted outcome`. In Claude Code, the
  UI and final rows may both be correctly canceled while a late
  `tool_failed(user_interrupt)` report logs
  `workspace agent activity turn transition was rejected`.
- Check: inspect the cancel operation payload. It must contain
  `rootAgentSessionId` plus every active canonical target
  `(agentSessionId, turnId)` for that root turn. Also compare the timestamps of
  cancel preparation, late spawn registration, provider `turn/started`, and
  `turn/interrupt`; query for child sessions created after cancel preparation
  and for a settled canonical root whose `root_provider_turn_phase` remains
  `running`. If `confirmed_target_count` includes only a child, inspect the
  provider rollout: a root that continues with another `spawn_agent`, message,
  or `wait_agent` after the canonical cancel did not receive its native
  interrupt even though the UI correctly rendered the durable root as stopped.
- Cause: the adapter discovered children privately, the controller looked up a
  child as an independent live session, only the root turn committed, or the
  controller canceled its local Exec context before invoking the adapter. The
  last case can unregister the live root provider-turn handle, so child
  interruption succeeds while the root native turn receives no interrupt and
  continues its multi-agent queue behind an already-canceled canonical turn.
- Fix:
  - `services/tuttid` enumerates the durable tree before provider invocation.
  - Preparing the root cancel operation closes durable child creation for that
    root turn, so a child revealed after the target snapshot cannot race into
    SQLite before cancel completion.
  - The controller finds the live adapter through the root session.
  - The controller invokes the bounded provider cancel before canceling its
    local Exec context. Provider termination uses the still-live native root
    handle; local context cancellation runs afterwards as cleanup even when the
    provider call fails.
  - The adapter maps only supplied targets to provider-native handles.
  - Codex interrupts the root provider turn before waiting for known child
    interrupts, preventing a slow child RPC from leaving the root free to
    launch the next serial child.
  - The provider adapter keeps an execution-local cancellation boundary: late
    unowned root turns and newly revealed native child threads are interrupted,
    and the latter never receive canonical child identities.
  - Claude records the daemon-supplied exact root/child turn targets at that
    boundary before issuing its root-query cancel. A later SDK
    `task_completed(status=stopped)` or `tool_failed(user_interrupt)` for one of
    those child turns is dropped in the adapter instead of being projected as a
    contradictory child failure. Do not match the rejection error text or
    weaken the durable turn state machine.
  - The controller returns the exact provider-acknowledged target subset and
    never settles durable turns itself.
  - Target turn transitions, pending interaction supersession, operation
    completion, and outbox data commit together.
  - Canonical canceled turns clear transport-only errors such as
    `context canceled`; outbound turn projection omits errors unless the
    outcome is `failed` or `interrupted`, so an old dirty row cannot block the
    reliable notification queue.
  - Confirmed cancellations settle `canceled`; targets without terminal
    confirmation settle `interrupted` after the bounded timeout. Late events
    never resurrect the root.
  - A matching late root provider terminal may close the provider lifecycle
    projection on an already settled canonical root, but cannot change its
    canonical canceled outcome or publish another settlement.

- Validate: include nested children, a child that finishes during cancellation,
  a provider handle that cannot confirm cancellation, restart recovery, and a
  late child terminal. Also cover a spawn racing after the durable cancel
  operation is prepared and a server-initiated root turn after cancellation.
  For the serial-spawn regression, cancel after the first child appears and
  assert that provider requests include interrupts for both the live root turn
  and that child, the root is provider-confirmed, and any already-in-flight
  second child is interrupted without receiving a canonical session. For
  Claude, also assert that ordinary root-provider-first/child-terminal-later
  ordering still settles the child, while a late cancel-caused child terminal
  emits no second activity transition and produces no rejected-report log.

### Claude reply completed but a detached command keeps the turn busy

- Symptom: Claude has printed its final answer after starting a long-lived
  `run_in_background` command, while the session rail and composer remain
  loading. The launch tool may end as `turn_completed_without_call_result`.
- Check: correlate the root `turn_completed` with SDK `task_started` and
  `background_tasks_changed`. If the task has a `tool_use_id` but no subagent
  identity (`agent_id` or explicit agent task type), inspect whether the Host
  created a child session/turn for it or left the launch call running.
- Cause: generic Claude task-system events were classified as delegated
  subagents. A persistent server therefore became child work whose terminal
  notification might never arrive, so it gated root activity indefinitely.
- Fix: classify detached processes separately in the Claude sidecar. A
  successful provider result completes a root `run_in_background` launch even
  if `task_started` arrives later; retain the provider task id only for stop
  routing. Do not emit child task lifecycle events or reserve a delegated
  continuation for the process.
- Validate: cover `task_started` both before and after the successful result,
  leave the process running indefinitely, and assert the launch call and root
  turn complete with no child session, call failure, or synthetic continuation.

### Deleted root leaves orphan child sessions

- Symptom: a deleted conversation disappears from the rail, but its child
  sessions, turns, or interactions remain in SQLite or later projections.
- Cause: deletion targeted only the selected session row instead of expanding
  its immutable parent tree.
- Fix: resolve the selected session and every nested child in the deletion
  transaction and tombstone the full tree with one deletion generation. Keep
  its Turns, Interactions, submit claims, history, and Messages intact for
  restore; terminalize only active work. Remove those rows only during the
  separate permanent-purge transaction.
- Validate: cover both single-session and batch deletion with a nested child
  tree, assert every descendant receives the same tombstone, restore the exact
  tree atomically, and verify legacy incomplete tombstones fail closed.

### Interactive response or exact-turn cancel succeeds but durable state stays pending

- Symptom: the provider consumed the response/cancel, while HTTP reports a
  persistence error or durable state remains active.
- Check: inspect `workspace_agent_runtime_operations` status, lease,
  `next_attempt_at_unix_ms`, payload targets, and its unpublished outbox rows.
- Cause: provider side effects and SQLite cannot share a transaction; durable
  intent was absent or completion was split across writes.
- Fix: prepare a deterministic operation, lease it, invoke the provider, then
  commit the domain transitions, completed operation, and outbox rows
  atomically. Recovery requeues old leases before stale-turn settlement.
- Validate: use a fake clock and failure injection around every boundary. An
  idempotent replay must reach exactly one terminal operation and must not
  revert a terminal interaction or turn.
