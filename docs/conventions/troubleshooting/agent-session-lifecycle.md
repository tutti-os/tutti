# Troubleshooting: Agent Sessions And Lifecycle

[Agent runtime index](./agent-runtime.md) · [All troubleshooting](./README.md)

Turn state, loading, cancel, restore, file-change undo, rail projection, event updates, imports, and performance.

### Codex WebSocket reconnect rejects a long prompt metadata header

- Symptom:
  A long-running Codex turn disconnects, then its WebSocket reconnect fails with
  `did not receive a valid HTTP request; Separator is found, but chunk is longer than limit`.
  The same prompt may succeed when the original connection stays open.
- Quick checks:
  Inspect the Codex app-server `turn/start` params without logging prompt text.
  Compare prompt byte count with any client metadata byte count. An unbounded
  prompt copy in `responsesapiClientMetadata` can cross a WebSocket HTTP
  parser's roughly 32 KiB line limit during reconnect.
- Root cause:
  Codex may forward Responses API client metadata through the WebSocket HTTP
  handshake. Duplicating the full prompt into that metadata turns prompt size
  into header size. Reconnect then fails before the provider can process the
  normal `input` payload.
- Fix:
  Keep the full materialized prompt in `turn/start.input`. Do not duplicate it
  into auxiliary metadata, truncate it in AgentGUI, or compensate with reconnect
  retries. Provider-specific metadata stays inside the provider adapter and must
  follow a demonstrated provider contract.
- Validation:
  Cover a prompt larger than 32 KiB. Assert `turn/start.input` preserves it
  exactly and `responsesapiClientMetadata` contains no prompt copy. Run
  `go test ./packages/agent/daemon/runtime`.
- References:
  [codex_appserver_event_params.go](../../../packages/agent/daemon/runtime/codex_appserver_event_params.go)
  [codex_appserver_adapter_test.go](../../../packages/agent/daemon/runtime/codex_appserver_adapter_test.go)
  [agent-gui-node.md](../../architecture/agent-gui-node.md)

### AgentGUI turn actions return plain-text route 404s

- Symptom:
  A turn-scoped action such as Stop sends the documented OpenAPI URL but gets
  `404 page not found` with `text/plain`, even though nearby daemon APIs work.
- Quick checks:
  Distinguish the default mux response from a domain 404. A route-level miss is
  plain text; a matched daemon handler returns the structured API error schema.
  Then compare the operation in the OpenAPI document and generated server with
  `services/tuttid/api/routes.go`.
- Root cause:
  The daemon currently mounts generated handlers through a hand-maintained
  `RegisterRoutes` table. Adding an operation to OpenAPI and regenerating the
  server does not automatically add it to that runtime table, so the handler
  can compile and pass direct tests while remaining unreachable over HTTP.
- Fix:
  Register every new generated operation in `RegisterRoutes`, including its
  exact method and path pattern. For related protocol operations introduced
  together, audit the whole group rather than only the first reported URL.
- Validation:
  Add a mux-level test that calls `RegisterRoutes`, sends the real method/path,
  asserts path parameters reach the service, and checks the structured
  response. Rebuild and restart the dev daemon, then verify the live endpoint
  no longer returns the default plain-text 404.
- References:
  [routes.go](../../../services/tuttid/api/routes.go)
  [daemon_test.go](../../../services/tuttid/api/daemon_test.go)
  [tuttid.v1.yaml](../../../services/tuttid/api/openapi/tuttid.v1.yaml)

### AgentGUI rejects a pasted image as unsupported before send

- Symptom:
  Pasting or dropping a supported PNG, JPEG, or WebP into a provider that
  advertises `imageInput` fails with
  `agent prompt image input is unsupported`. Desktop diagnostics may show
  `agent.gui.composer.image_upload.resolved` with `hasPath = true`, followed by
  a daemon failure at `service.send.prompt_validated`; no provider turn starts.
- Quick checks:
  Confirm the submitted image block is path-backed after the desktop host
  archives the draft. If the block has `path` but no `data`, `url`, or
  `attachmentId`, verify the controller is using preflight validation rather
  than the strict runtime validator before `PersistRequestContent` runs.
- Root cause:
  A managed desktop path is an ingress staging source. The daemon must accept
  it during capability preflight, then copy and hydrate it before runtime
  execution. Applying the strict provider-content validator during preflight
  rejects the path before the attachment store can canonicalize it.
- Fix:
  Keep separate preflight and runtime image validators. Preflight accepts and
  preserves the managed path for adapter capability checks. Runtime execution
  remains strict and receives only the hydrated image representation. Do not
  retain base64 in the renderer or move attachment persistence before provider
  capability checks.
- Validation:
  Cover the full path-backed chain: controller preflight accepts the path,
  service execution receives hydrated data without a path, direct runtime
  execution still rejects path-only content, and unsupported providers create
  no attachment files. Run `go test ./packages/agent/daemon/runtime
./services/tuttid/service/agent`.
- References:
  [prompt_content.go](../../../packages/agent/daemon/runtime/prompt_content.go)
  [controller.go](../../../packages/agent/daemon/runtime/controller.go)
  [service_send_input.go](../../../services/tuttid/service/agent/service_send_input.go)

### AgentGUI Stop reports no active turn after cancel succeeds

- Symptom:
  Pressing Stop settles the AgentGUI turn as canceled, but the renderer also
  logs a `workspace_operation_failed`/502 error whose daemon cause is
  `agent session has no active turn`.
- Quick checks:
  Compare daemon `agent_session.cancel.adapter_failed` with nearby activity
  state patches. If the same turn reports `turnPhase = settled` and
  `outcome = canceled` at the same timestamp, the cancel result won the event
  race while the synchronous cancel RPC still observed a stale controller turn
  record.
- Root cause:
  The runtime controller and provider adapter keep separate active-turn views.
  During cancel-after-settle races, the controller can still have a turn record
  while the Codex app-server adapter has already cleared its active turn and
  returns `ErrSessionNoActiveTurn`.
- Fix:
  Treat `ErrSessionNoActiveTurn` from the controller active-turn cancel path as
  an idempotent settled-turn result: clear the stale controller turn record,
  reconcile any still-blocked view, and return without surfacing a 502.
- Validation:
  Add controller coverage where `controller.turns` still has a record, the
  stored session is already settled/canceled, and the adapter returns
  `ErrSessionNoActiveTurn`.
- References:
  [controller.go](../../../packages/agent/daemon/runtime/controller.go)
  [controller_test.go](../../../packages/agent/daemon/runtime/controller_test.go)

### AgentGUI send blocked by active_turn after settled snapshot

- Symptom:
  AgentGUI shows `turnPhase = settled` and no `activeTurnId`, but a follow-up
  prompt fails with `agent session already has an active turn`, or the runtime
  snapshot still reports `submitAvailabilityState = blocked` with
  `reason = active_turn`.
- Quick checks:
  Compare renderer state with `tuttid.log` submit traces. If `api.send.failed`
  reports `agent session already has an active turn` after a settled/available
  state patch, inspect whether the controller still has an in-memory `c.turns`
  entry while the adapter lifecycle snapshot has already settled. For Codex
  app-server sessions, also compare `turn/completed` notification timing with
  the triggering `turn/start` RPC result; a stale provider turn id with no
  active turn object indicates that the late result rebound an already-settled
  slot.
- Root cause:
  The controller's async turn registry is separate from adapter lifecycle
  projection. Async execution must clear `c.turns` when the owning adapter
  publishes a non-live `TurnLifecycleSnapshot`, even if the event type is not a
  terminal `turn.completed`/`turn.failed` event. The settled session and the
  registry cleanup must also become visible together; storing `ready` first
  leaves a follow-up rejection window. Separately, app-server notifications can
  settle a turn before the `turn/start` response is applied, so binding that
  response without checking turn identity can recreate a stale active id.
- Fix:
  Treat same-turn non-live lifecycle snapshots as async turn completion, in
  addition to terminal event types and steered prompt messages. Clear the
  matching controller turn record before publishing/storing the terminal
  session view. Bind a provider turn id only while the exact active-turn object
  that issued the request still owns the adapter slot.
- Validation:
  Add controller coverage where an async adapter emits only a settled lifecycle
  snapshot for the turn and no terminal event, then verify a follow-up `Exec`
  no longer returns `ErrSessionActiveTurn`. Also cover a terminal snapshot that
  waits for an open call and assert `ready` is never observable with an active
  controller turn. For Codex, deliver `turn/completed` before the `turn/start`
  result and verify the late result cannot restore the provider turn id. Run
  `go test ./packages/agent/daemon/runtime`.
- References:
  [controller.go](../../../packages/agent/daemon/runtime/controller.go)
  [controller_test.go](../../../packages/agent/daemon/runtime/controller_test.go)
  [codex_appserver_adapter.go](../../../packages/agent/daemon/runtime/codex_appserver_adapter.go)
  [codex_appserver_adapter_test.go](../../../packages/agent/daemon/runtime/codex_appserver_adapter_test.go)

### AgentGUI loading disappears before active turn settles

- Symptom:
  AgentGUI loses the in-progress/loading affordance while the app-server turn is
  still active, normal composer sends hit the active-turn guard instead of
  queueing, or a later terminal event arrives for a turn that the runtime
  already cleared.
- Quick checks:
  First compare the renderer `runtimeSession` and `sessionState` diagnostics.
  If `runtimeSession.turnLifecycle.activeTurnId` is non-empty with a live phase
  but `sessionState.turnLifecycle.phase = settled` and
  `submitAvailabilityState = available`, the bug is in AgentGUI derived state:
  the active composer/projection is trusting stale selected-session control
  state over the runtime snapshot. Separately inspect app-server terminal
  payloads. A `turn/completed` or `turn/failed` notification with an empty
  provider turn id must not settle a bound active turn unless that turn was
  explicitly adopted from a preceding goal-continuation `turn/started`.
- Root cause:
  There are two distinct failure modes. In AgentGUI, the runtime activity
  snapshot can be live while the selected session view/control state is stale;
  composer loading, projection turn lifecycle, `canSubmit`, and local queue
  decisions must prefer the runtime live lifecycle. In the Codex app-server
  adapter, `settleActiveTurn` is allowed to adopt a mismatched provider turn id
  only for the steer case where `turn/start` returned an unconfirmed stub id and
  codex later completes the running turn with a non-empty provider id. Treating
  an empty terminal id as a wildcard clears active turn state too early and
  removes loading.
- Fix:
  In AgentGUI, drive active projection, active live state, submit blocking, and
  queue decisions from a live `AgentActivityRuntime` lifecycle before falling
  back to `activeSessionState`. Ordinary composer sends while busy should
  queue; explicit send-now intents must use capability-selected native guidance
  or exact-turn cancel-then-send. In the daemon,
  keep the steer exception, but require the terminal provider id to be non-empty
  and drop empty-id terminal notifications for bound active turns. Keep the
  narrow exception for goal-adopted turns whose ownership came from
  `turn/started`.
- Validation:
  Keep tests for both sides: a stale settled `sessionState` plus live runtime
  lifecycle should still render processing/loading, set `canSubmit = false`,
  allow local queueing, and avoid direct `exec`; steered stub turns must settle
  on the running turn's non-empty completion id; empty-id terminal notifications
  must not settle confirmed or unconfirmed active turns; goal continuation must
  still complete its adopted turn.
- References:
  [useAgentGUINodeController.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts)
  [useAgentGUINodeController.spec.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx)
  [codex_appserver_turn_machine.go](../../../packages/agent/daemon/runtime/codex_appserver_turn_machine.go)
  [codex_appserver_adapter_test.go](../../../packages/agent/daemon/runtime/codex_appserver_adapter_test.go)

### Busy-turn message insertion fails or ends without sending the prompt

- Symptom:
  Sending a prompt with the composer guidance shortcut or choosing “send now”
  on a queued prompt fails for ACP-backed agents, reports a turn-scoped
  cancellation/guidance error, or cancels the turn without sending the prompt.
- Quick checks:
  Inspect the canonical session capabilities and engine commands. Codex and
  Claude sessions should advertise `activeTurnGuidance`; standard ACP sessions
  should advertise `interrupt` without `activeTurnGuidance`. Confirm that no
  renderer branch selects behavior from a provider ID.
- Root cause:
  Message insertion is one product intent with two transport realizations.
  Treating every provider as native guidance sends a same-turn request that the
  standard ACP protocol does not define. Treating every provider as
  cancel-then-send discards
  Codex `turn/steer` and Claude SDK `guide`, and can couple prompt delivery to a
  server-owned queue that does not exist.
- Fix:
  Keep the prompt queue in the workspace `AgentSessionEngine`. Resolve send-now
  from typed runtime capabilities: use native guidance when
  `activeTurnGuidance` is true; otherwise use exact-turn cancel when `interrupt`
  is true, retain the prompt in the frontend queue, and send it normally only
  after validated cancellation or authoritative turn settlement. Route both the
  composer shortcut and queued-item action through the same atomic engine
  transition.
- Validation:
  Cover both entry points and both capability combinations. Native guidance must
  emit a guidance send with no cancel. ACP fallback must emit cancel with no
  prompt send, then emit one normal prompt send after cancellation settles.
- References:
  [promptQueue.reducer.ts](../../../packages/agent/activity-core/src/engine/promptQueue.reducer.ts)
  [sessionLifecycle.reducer.ts](../../../packages/agent/activity-core/src/engine/sessionLifecycle.reducer.ts)
  [controller_exec.go](../../../packages/agent/daemon/runtime/controller_exec.go)

### Cursor or OpenCode turn settles before late ACP activity arrives

- Symptom:
  A Cursor or OpenCode turn appears complete, then a delayed tool or permission
  event is projected onto the old turn; the composer may relock, persistence
  may reject a settled-to-running transition, or a synthetic turn may appear.
  A Cursor background Task may also appear launched successfully while its
  detached child later requests permissions that never reach the UI.
- Quick checks:
  Correlate `session/prompt` response timing with later `session/update` or
  `session/request_permission` messages. If the prompt response arrived first,
  the late event no longer has an active canonical turn owner. Also verify the
  terminal report is `root_provider_turn.completed`, not a direct canonical
  `turn.completed` from the ACP adapter. For Cursor Task/subagent probes,
  correlate `agent_session.cursor.task_tool_update` with
  `agent_session.cursor.task_extension`; the latter records only redacted
  identity, ordering, field-presence, and duration facts. A background Task
  tool result with `isBackground=true` and a very short duration is a launch
  acknowledgement, not child terminal evidence. Permission requests arriving
  after the root prompt result confirm the child is still running out of scope.
- Root cause:
  Standard ACP has one active prompt handler and a session-level fallback
  handler. Reusing a recent turn ID in the fallback path treats temporal
  proximity as ownership. That can reopen a settled root or fabricate a turn,
  and ordinary tool display fields do not supply the stable child identity and
  terminal lifecycle required for a provider-native child session. Cursor's
  background Task implementation records eventual completion in an internal
  work registry, but Cursor ACP `2026.07.01-41b2de7` does not expose that
  terminal to Tutti.
- Fix:
  Route every Standard ACP prompt terminal through the daemon-owned root
  provider lifecycle. Drop turn-scoped tool/message updates outside the active
  prompt call and reject out-of-band permission callbacks; never synthesize a
  canonical turn. Keep Cursor/OpenCode root-only until their ACP transports
  expose stable child, parent, and child-terminal facts. Cursor Agent
  `2026.07.01-41b2de7` does not merge `--plugin-dir` hooks into ACP, so the
  dormant `preToolUse` Task guard is deliberately not advertised or
  materialized. Do not treat background Task as supported or blocked, do not
  write hooks into user/project configuration, and do not settle a detached
  child from a guessed timeout.
- Validation:
  Cover Cursor and OpenCode normal completion with
  `root_provider_turn.started/completed` and no canonical terminal from the
  adapter. Deliver a late tool update and late permission after prompt return
  and verify neither creates a turn, interaction, or child session. Make a
  `session/cancel` write fail and verify the error reaches the caller. Also
  fail an automatic permission-response write and verify the adapter does not
  report a false approval while the provider is still waiting. Verify the
  dormant Cursor hook allows foreground Task inputs, rejects snake-case and
  camel-case background flags, does not match flag-like text inside the Task
  prompt, and fails closed for malformed input; separately verify the current
  ACP plugin manifest does not advertise or materialize that hook.
- References:
  [standard_acp_turn.go](../../../packages/agent/daemon/runtime/standard_acp_turn.go)
  [standard_acp_stream.go](../../../packages/agent/daemon/runtime/standard_acp_stream.go)
  [provider-native subagents](../../specs/2026-07-15-provider-native-subagents.md)

### Codex goal stops after a turn while the goal remains active

- Symptom:
  A `/goal` completes or fails one turn, remains `active`, but never starts a
  continuation turn. The conversation looks idle even though the goal banner
  still says it is running.
- Quick checks:
  Enable `TUTTI_TEST_LOGS=1` for a focused runtime reproduction and compare
  `agent_session.app_server.goal.status_changed` with
  `agent_session.app_server.goal.continuation_nudge`. If the first turn settles
  before the initial `thread/goal/set` response records the active goal, an
  eager scheduling check can return without ever creating the continuation
  timer.
- Root cause:
  App-server notifications and the response for their triggering RPC do not
  have a safe application-order guarantee. A `turn/completed` notification may
  settle the first goal turn while `thread/goal/set` is still in flight, so
  local goal state can still be empty when the settle path schedules its nudge.
- Fix:
  Before sending a goal-setting RPC that can start a turn, record a local
  `active` goal snapshot with the requested objective. This makes goal
  activation causally visible to terminal notifications that overtake the RPC
  response. Restore the previous local goal if the RPC fails; on success,
  replace the provisional snapshot with the authoritative response. The
  continuation timer must still re-read both active-turn and goal state after
  its grace window before sending a nudge.
- Validation:
  Keep a scripted protocol test that deliberately delivers goal turn
  notifications before the `thread/goal/set` result, then verify the next turn
  is adopted. Cover both a clean first turn and a failed mid-goal turn with
  repeated focused runs; use event channels rather than polling shared slices.
- References:
  [codex_appserver_goal.go](../../../packages/agent/daemon/runtime/codex_appserver_goal.go)
  [codex_appserver_adapter_test.go](../../../packages/agent/daemon/runtime/codex_appserver_adapter_test.go)

### Codex goal shows active but produces no response

- Symptom:
  Sending `/goal …` updates the Goal banner to active, but no assistant text or
  tool activity appears. Logs show `turn/started`, followed shortly by
  `agent_session.app_server.goal.turn_provenance_unproven` and an exact
  `turn/interrupt`.
- Quick checks:
  Inspect the installed Codex app-server schema and the raw
  `thread/goal/updated` payload. In affected versions, `turnId` is optional and
  the external `thread/goal/set` update omits it. Verify the Goal operation and
  generation fingerprint were persisted successfully before investigating
  transport or model failures.
- Root cause:
  Tutti required `thread/goal/updated.turnId` as the only Goal-to-Turn
  correlation signal. Codex externally applies the Goal, emits a session-scoped
  update without `turnId`, then starts the continuation Turn. The adapter
  therefore treated valid work as unproven and deliberately interrupted it
  after the provenance grace window.
- Fix:
  Keep exact turn-scoped Goal evidence as the preferred path. For versions that
  omit `turnId`, use an adapter-local, single-use continuation claim scoped to
  the successful Goal RPC's immutable operation/revision. Chain the next claim
  only from settlement of an adopted Goal Turn, serialize Goal control against
  ordinary submit setup, and invalidate the claim on revision change, inactive
  status, restart, or multiple unowned Turns. Never bind an arbitrary unowned
  Turn from the mutable current Goal snapshot and do not fix this by merely
  extending the provenance timeout.
- Validation:
  Reproduce the real protocol order
  `goal/set response -> goal/updated without turnId -> turn/started` and verify
  assistant output is persisted without an interrupt. Also cover chained
  continuation Turns without another Goal RPC and a delayed old Turn after a
  newer revision, which must still be interrupted.
- References:
  [codex_appserver_goal_provenance.go](../../../packages/agent/daemon/runtime/codex_appserver_goal_provenance.go)
  [codex_appserver_goal.go](../../../packages/agent/daemon/runtime/codex_appserver_goal.go)
  [controller_exec.go](../../../packages/agent/daemon/runtime/controller_exec.go)
  [codex_appserver_adapter_test.go](../../../packages/agent/daemon/runtime/codex_appserver_adapter_test.go)

### Active Codex goal has no elapsed timer

- Symptom:
  The Goal banner shows an active objective but no elapsed value, even though
  Codex continues working and its Goal database reports non-zero usage time.
- Root cause:
  Codex exposes `timeUsedSeconds` and `tokensUsed`, while Tutti's canonical
  session Goal contract exposes `durationMs` and `tokens`. Passing provider
  fields through runtime context causes the typed durable session boundary to
  discard them. A newly created Goal may also omit canonical `durationMs`
  because zero is an optional counter.
- Fix:
  Normalize provider counters in the Codex adapter before publishing session
  state or Goal observations. The renderer reads only `durationMs`, hides time
  while the Goal is an optimistic projection, and starts only after canonical
  provider state arrives. If that canonical state omits the optional zero
  baseline, start at zero and advance locally between server updates.
- Validation:
  Verify provider-to-canonical normalization with non-zero counters, verify an
  optimistic Goal shows no time, verify canonical confirmation adopts the
  provider duration and advances, and verify a paused Goal without a duration
  still omits the timer.
- References:
  [codex_appserver_goal.go](../../../packages/agent/daemon/runtime/codex_appserver_goal.go)
  [AgentGoalBanner.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/AgentGoalBanner.tsx)

### Codex goal reappears after pause, edit, or clear

- Symptom:
  A goal control succeeds, but the banner shortly returns to an older objective
  or status; a cleared goal can reappear as paused.
- Quick checks:
  Compare the startup background `thread/goal/get` with later goal-control RPCs.
  If the get began before the control and completed afterwards, inspect whether
  its older snapshot was applied unconditionally.
- Root cause:
  Startup restores the persisted thread goal asynchronously. Its response can
  race with newer user controls or provider goal notifications, so arrival
  order is not a safe freshness signal.
- Fix:
  Version the session goal state. Capture the session identity and revision
  before the startup fetch, and apply its result only when both are unchanged;
  increment the revision on every update and clear.
- Validation:
  Capture a startup refresh guard, clear the goal, then attempt to apply the
  older paused snapshot and verify it is rejected.
- References:
  [codex_appserver_adapter.go](../../../packages/agent/daemon/runtime/codex_appserver_adapter.go)
  [codex_appserver_events.go](../../../packages/agent/daemon/runtime/codex_appserver_events.go)
  [codex_appserver_adapter_test.go](../../../packages/agent/daemon/runtime/codex_appserver_adapter_test.go)

### Clearing a goal hides Stop or appends a provider acknowledgement

- Symptom:
  Clearing a goal while its current turn is still running leaves the composer
  on a non-clickable send spinner. The transcript shows `/goal clear` followed
  by a new processing row even though no new user turn started. Claude Code may
  instead append a native `Goal cleared: …` assistant message at the bottom of
  the transcript after the interrupted turn.
- Quick checks:
  Inspect the AgentGUI clear handler and the engine pending-submit records. If
  clear calls `executePrompt` with an immediate `/goal clear`, the control has
  entered the normal message pipeline and received a pseudo turn identity. For
  Claude Code, correlate the bottom assistant message's turn ID with the
  adapter-generated turn carrying the native clear command.
- Root cause:
  Goal clear changes thread metadata rather than submitting user work. For a
  provider such as Codex that leaves the active turn running, submitting clear
  as a prompt creates a pending submit without a real provider turn. That local
  submit owns the send spinner and its visible user message becomes the last
  timeline turn, so canonical processing is projected under the wrong item.
  Claude Code instead interrupts the live goal turn and requires a separate
  native command turn to execute clear; projecting that control turn's provider
  acknowledgement as ordinary assistant content creates an unrelated transcript
  row at the bottom.
- Fix:
  Route every goal action, including clear, through the dedicated runtime
  goal-control API. Do not create a user message, pending submit, or pseudo turn.
  If the provider needs an internal clear-command turn, register its generated
  turn ID and suppress only that turn's assistant/thinking acknowledgement at
  the runtime-adapter boundary before persistence. Do not filter by localized
  acknowledgement text and do not move the message into the interrupted turn.
  Preserve goal/session updates and terminal cleanup, but do not register the
  internal command as a root provider turn or feed its terminal into canonical
  root settlement.
  Keep Stop and processing derived from the canonical active turn, and report a
  successful clear with a localized transient toast. Render that toast in an
  AgentGUI detail-scoped viewport and use UI System themed surface, foreground,
  and border tokens so it centers within the content area and follows the
  active light or dark theme instead of using the inverted neutral toast style.
- Validation:
  Clear a goal while a turn is running and verify the goal-control API is called
  without an engine submit dispatch. The clear command must not appear in the
  transcript, the original processing row must remain in place, and Stop must
  remain clickable until the active turn settles or is interrupted. For Claude
  Code, verify the native acknowledgement is absent both live and after reload,
  while identical text from an ordinary assistant turn remains visible.
- References:
  [useAgentGUISubmitInteractionActions.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUISubmitInteractionActions.ts)
  [claude_sdk_goal.go](../../../packages/agent/daemon/runtime/claude_sdk_goal.go)
  [claude_sdk_events.go](../../../packages/agent/daemon/runtime/claude_sdk_events.go)
  [agent-gui-node.md](../../architecture/agent-gui-node.md)

### Agent session stays loading after a completed turn

- Symptom:
  AgentGUI shows the assistant response as completed, but the conversation or
  sidebar remains in a loading/running state. Desktop logs may contain
  `agent.activity.store.session_version_regression` where the previous session
  is `settled`/`available` and the next session is older
  `running`/`active_turn`.
- Quick checks:
  Compare the desktop `reconcile.state_fetch.resolved` session timestamp with
  the latest inline `state_patch` timestamp. In `tuttid.log`, check whether
  runtime emitted a terminal `turn_phase=settled` event before the fetch
  response was applied.
- Root cause:
  Activity projection can accept and broadcast a newer completed state while
  `GetWorkspaceAgentSession` still prefers an older live runtime snapshot for
  the same session. The projection store has timestamp regression protection,
  but the service read path can bypass it when a runtime session is present.
- Fix:
  In service read paths, compare persisted projection freshness against the
  runtime snapshot. If persisted state is newer, return the projected session
  state and synthesize non-live turn lifecycle/submit availability instead of
  exposing the stale runtime active turn.
- Validation:
  Add service coverage where runtime reports `working/running/active_turn` with
  an older `UpdatedAtUnixMS`, while persisted state reports
  `completed/idle/available` with a newer `LastEventUnixMS`. Validate both
  `Get` and `List` do not return the old active turn. Run
  `go test ./services/tuttid/service/agent`.
- References:
  [service_session.go](../../../services/tuttid/service/agent/service_session.go)
  [service.go](../../../services/tuttid/service/agent/service.go)
  [service_session_list.go](../../../services/tuttid/service/agent/service_session_list.go)

### AgentGUI pin or unpin appears stuck for a live session

- Symptom:
  Pinning or unpinning a conversation backed by a live runtime succeeds in the
  daemon, but the rail does not move the row or update its action until a later
  list refresh. Old conversations without a live runtime update immediately. In
  another variant, the pin command completes quickly but the whole rail becomes
  disabled or changes to a skeleton while section membership refreshes. A third
  variant renders the mutation in two steps: unpin first removes the pinned row,
  then removes the pinned section and inserts the ordinary row; delete first
  shrinks the section, then shrinks and refills it.
- Quick checks:
  Correlate `pin_result` with `agent.activity.store.session_version_regression`.
  Compare the command response's `updatedAtUnixMs` with the engine's current
  session version, then inspect the exported session for a newer
  `pinnedAtUnixMs`. A fast command carrying the new pin value but an older
  `updatedAtUnixMs` identifies a stale runtime projection, not a slow database
  write. If the pin value applies promptly, correlate
  `agent_gui.conversation_rail.first_pages_slow` with
  `workspace.agent_session.sections.list_slow`. The renderer event should report
  `refreshReason=membership_change`; the daemon event separates
  `projects_ms`, `store_ms`, and `hydrate_ms` and reports current/non-empty
  project counts, target-scoped visible sessions, and returned first-page rows.
- Root cause:
  Durable metadata updates advance the persisted session timestamp. When a live
  runtime session is also present, the service merges persisted metadata such
  as `pinnedAtUnixMs` into the runtime projection. If that merge keeps the older
  runtime timestamp, the frontend's monotonic session reducer correctly rejects
  the whole stale response, including the new pin value.
  When the entity update is accepted, pin membership still requires
  authoritative pinned and ordinary first-page reads. Triggering an aggregate
  section query or workspace activity load turns that targeted revalidation
  into a multi-second blocking reload on large histories. Rendering the updated
  or tombstoned canonical entity against the previous page membership creates
  the two-step variant: entity projection changes before the authoritative page
  replacement knows the final bounded list and refill row.
- Fix:
  Merge session freshness monotonically across runtime and persistence using
  the newer timestamp. Pin responses that advance the session version must also
  include protocol-v2 active/latest turn state so accepting the metadata update
  cannot clear a running turn. Do not weaken frontend version checks or hide the
  mismatch behind delayed refetches. For an accepted membership update, compare
  canonical before/after membership and request only pinned plus the exact
  ordinary section page. Route pin and delete through engine mutation intents;
  the command result and canonical follow-up must drain before subscribers are
  notified. Make the rail query controller the sole publisher of a composite
  entity-plus-membership snapshot, retain its previous committed value while
  targeted reads run, and publish the complete next value once. The view must
  not subscribe to live engine rows separately or keep stale section snapshots.
  Do not inspect mutation history from the Rail; compare canonical membership
  before and after each engine notification. Keep the committed snapshot on
  targeted failure and lock membership actions until a scoped authoritative
  refresh succeeds. Do not call
  `listSessionSections` or workspace `load` from delete, pin/unpin, or rename.
  Lock scope-sensitive actions only while displayed membership belongs to a
  different or unresolved scope; do not patch daemon-owned membership locally.
- Validation:
  Cover a live runtime session whose persisted pin update is newer, a newer
  runtime snapshot that must not regress, and a running turn that remains
  attached to the pin response. Run `go test ./services/tuttid/service/agent`
  plus daemon lint, tests, and build when daemon persistence changed. Add
  reducer interleaving coverage proving command success and canonical follow-up
  share one engine notification. Add controller coverage proving same-scope
  pin/unpin calls only the pinned and exact ordinary page endpoints, keeps the
  old composite projection until both resolve, publishes once, and never calls
  the aggregate section endpoint.
- References:
  [service.go](../../../services/tuttid/service/agent/service.go)
  [service_session.go](../../../services/tuttid/service/agent/service_session.go)
  [sessionEntities.reducer.ts](../../../packages/agent/activity-core/src/engine/sessionEntities.reducer.ts)
  [AgentGUIConversationRailQueryController.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/AgentGUIConversationRailQueryController.ts)

### AgentGUI model switch changes defaults but not the active session

- Symptom:
  A user selects a different AgentGUI model, but the next provider call still
  uses the previous model. Logs may show
  `agent.gui.composer_defaults.remembered` for the new model while
  `workspace_agent_sessions.settings_json`, `runtimeContext.model`, or
  app-server `turn/start` still show the old model. For an Agent Extension, the
  selected model may also change back to Auto as soon as a new session is
  created, even though the durable session row contains the requested model.
- Quick checks:
  Search desktop and daemon logs for the full settings chain:
  `agent.gui.composer_settings.default_only`,
  `agent.gui.composer_settings.update_requested`,
  `workspace.agent_session.settings.update_requested`,
  `agent_session.settings.update.requested`,
  `agent_session.app_server.settings.applied`, and
  `agent_session.app_server.turn_start.params`. If only the defaults event is
  present, the UI changed the target default draft, not the active session. If
  daemon settings update completed but `turn_start.params.model` is old or
  empty, inspect the app-server adapter path. If persistence and the provider
  request both contain the selected model but the daemon session response omits
  `settings.model`, inspect the service projection before debugging the
  renderer selector.
- Root cause:
  AgentGUI has two distinct composer surfaces. The target home composer writes
  remembered defaults and node drafts. An active conversation composer must
  additionally call `updateSessionSettings`; Codex app-server providers then
  apply model changes as per-turn overrides on the next `turn/start`, not to an
  already-running turn. If the daemon applies the settings but the update
  response still reports the old model, check the service merge path:
  `serviceSessionWithPersistedFreshness` must not let a newer activity
  projection snapshot overwrite live runtime settings after an explicit
  settings update. For extension-owned open provider IDs, established runtime
  and persisted sessions must use open-provider-aware normalization. Applying
  the closed built-in composer registry to an ID such as `acp:<extension>`
  produces an empty built-in provider, clamps the model, and makes the UI
  correctly render Auto from an already-corrupted session projection.
- Fix:
  Preserve the default-draft path, but make active-session model changes
  observable at every layer. Do not conclude that a provider ignored the model
  until the logs show the active session settings update reached the daemon and
  the following `turn/start` carried the requested model. Keep closed
  normalization for unverified composer requests, but preserve provider-owned
  settings when projecting or resuming a session that was already authorized
  through an Agent Target.
- Validation:
  Reproduce by switching a model in a running session and sending a follow-up.
  Confirm the logs include the update chain above and that
  `workspace.agent_session.settings.update_completed` reports the requested
  model and the next `turn/start` carries it. If the persisted
  `workspace_agent_sessions.settings_json.model` is older while the runtime is
  live, `Get` responses should still expose live runtime settings instead of
  the stale projection value. Add a service regression with a generic open
  provider ID and assert `serviceSession` retains its model; also assert an
  invalid provider still loses stale settings.
- References:
  [useAgentGUINodeController.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts)
  [createDesktopAgentActivityRuntime.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.ts)
  [workspaceAgentActivityService.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.ts)
  [service_session.go](../../../services/tuttid/service/agent/service_session.go)
  [controller.go](../../../packages/agent/daemon/runtime/controller.go)
  [codex_appserver_adapter.go](../../../packages/agent/daemon/runtime/codex_appserver_adapter.go)

### Historical AgentGUI permission changes time out or stop responding

- Symptom:
  Changing permission mode in a historical conversation appears to do nothing,
  or the first selection times out and later selections are ignored. Logs may
  show a 30-second settings request with no provider settings application.
- Quick checks:
  Confirm the selected session is absent from the live runtime but present in
  `workspace_agent_sessions`. Check whether one menu choice emitted two settings
  requests. After a timeout, inspect the engine settings operation: `unknown`
  plus a later request without `retry` explains a silent drop.
- Root cause:
  Historical settings were routed through runtime preparation, so a metadata
  change could block on provider resume and sidecar startup. The permission
  menu also handled both item pointer-down and Select value-change, duplicating
  one user action. When the first command timed out, the engine correctly kept
  uncertainty but the controller did not mark a later explicit choice as a
  retry.
- Fix:
  Send one settings intent from Select value-change. Read the current engine
  operation at action time and mark an explicit choice as retry when its status
  is `unknown`. In the daemon, update inactive-session settings through the
  durable activity projection and publish reconciliation; reserve provider
  runtime updates for sessions that are already live. Serialize runtime resume
  with durable settings read-modify-write per session, preventing stale resume
  inputs and lost concurrent partial patches. Do not copy an active session
  setting into target defaults.
- Validation:
  Cover one pointer selection producing one callback, timeout followed by an
  explicit retry, and a historical Claude Code settings update that persists
  while runtime resume and live adapter update counts remain zero. Run the
  AgentGUI, activity-core, store-sqlite, and agent-service focused tests.
- References:
  [AgentComposerSettingsMenus.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/AgentComposerSettingsMenus.tsx)
  [useAgentGUIComposerSettingsActions.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUIComposerSettingsActions.ts)
  [service_settings.go](../../../services/tuttid/service/agent/service_settings.go)
  [agent-gui-node.md](../../architecture/agent-gui-node.md)

### Agent GUI provider tab shows fused or stale conversations

- Symptom:
  Switching the Agent GUI aggregation rail between All, Cursor, Codex, or Claude
  makes the selected row disappear, collapses a loaded page, or briefly flashes
  missing Show more controls. The same switch may remain visibly blocked even
  when each individual session query takes only tens of milliseconds, because
  the first-page bootstrap repeats count, sort, entity projection, and turn /
  interaction hydration once per current project section. Five page rows plus
  one selected overlay may show
  Show more/Show less even when only six sessions exist, or a nine-session
  section may ignore the first Show more click. Restart can reproduce the same
  selected-row loss. On cold startup, All may also show section headers without
  session rows until selecting Codex and then returning to All.
- Quick checks:
  Inspect `workspace_agent_sessions.agent_target_id` and `rail_section_key`.
  Confirm section requests carry the selected `agentTargetId` before pagination
  and responses preserve `totalCount`, `hasMore`, and `nextCursor`. In the
  renderer, distinguish daemon-owned section membership ids from engine-owned
  session entities; activating or hydrating one session must not rewrite the
  loaded membership page. For latency, count repository section reads per
  bootstrap: production must issue one `ListSessionSections` batch read, not one
  `ListSessionSection` call per project plus pinned and Chats. Run
  `EXPLAIN QUERY PLAN` and confirm ordinary branches use
  `idx_workspace_agent_sessions_rail_section_page`, pinned branches use
  `idx_workspace_agent_sessions_pinned_page`, and selected page entities load
  by the session primary key after narrow id trimming. A target-filtered rail
  must instead use `idx_workspace_agent_sessions_rail_section_target_page` and
  `idx_workspace_agent_sessions_pinned_target_page` with an exact target
  predicate; an optional `OR` predicate cannot narrow the index range. For a
  rail that shows only the active/new session, inspect `*_failed` events for
  `no such index`, then compare those required indexes with `sqlite_master`
  even when their migration markers exist. Store startup must idempotently
  restore missing rail pagination indexes; do not weaken `INDEXED BY` or fall
  back to a full session scan. For a reported slow switch, correlate
  `agent_gui.conversation_rail.first_pages_slow` with
  `workspace.agent_session.sections.list_slow`: the renderer event separates
  request and controller-apply time, while the daemon event separates current
  projects, store, and hydration time. Corresponding `*_failed` events record
  real failures. Successful requests below 250 ms, aborted requests, and stale
  responses are intentionally silent; these diagnostics must not log project
  paths, section keys, session titles, or prompts. Use `refreshReason` to
  distinguish attach, scope change, and membership invalidation. Interpret
  `rail_visible_session_count` as the target-scoped total across requested
  sections and `returned_session_count` as only the bounded first-page rows;
  neither requires another full-workspace count query.
  For provider switching, inspect `agent_gui.provider_switch.completed` or
  `agent_gui.provider_switch.failed`. They report source/target ids, fresh/stale/
  miss cache status, request time, controller-apply time, and total controller
  readiness time. Correlate target and timestamp with
  `agent.composer_options.load`, which records composer transport duration and
  status. A fresh rail hit with no composer transport indicates both caches were
  reused; a long rail request isolates section loading, while a long composer
  event isolates target option discovery.
  For the cold-start empty-row variant, compare
  `agent.gui.runtime.snapshot_changed` session counts with
  `agent_gui.conversation_rail.first_pages_slow`. If historical reconciliation
  finishes while the first-page request is unresolved, confirm no section-page
  request is emitted with `refreshReason=membership_change`.
- Root cause:
  A second React summary cache mixed entity data, section membership, active
  selection, and visible-item limits. Effects manually patched section rows
  from changing conversation summaries, so provider/detail reconciliation could
  collapse pages or synthesize membership. Counting the active overlay as a
  pageable row also corrupted Show more decisions. Bounded engine snapshots can
  recreate the loss if omission is treated as deletion. The latency variant is
  an N-section daemon read: current projects are a small requested set, while
  the workspace DB retains history for removed projects. Scanning that full
  history or repeating canonical turn / interaction hydration per section makes
  the rail wait scale with project count even when every leaf query looks fast.
  A database opened by different worktrees or intermediate builds can retain a
  migration marker after a required physical index disappears; treating the
  marker alone as proof of the schema invariant makes every section bootstrap
  fail while an active-session overlay can misleadingly remain visible.
  Historical `session/snapshotReceived` hydration can also be mistaken for a
  live rail membership mutation, causing a targeted section refresh to race the
  unresolved bootstrap request. Caching session payloads or a separate ingestion
  marker makes that race worse by splitting entity ownership from the engine.
- Fix:
  Keep page sessions in the workspace engine. Cache only ordered membership ids,
  cursor, `hasMore`, and `totalCount` in the controller query, then join ids to
  engine entities with a pure model projection. Keep active and pending sessions
  as display overlays outside pagination. Preserve old scope chrome and metadata
  atomically while a provider refetch is pending. Engine snapshots merge
  monotonically; only explicit `session/removed` owns deletion. Keep first-page
  bootstrap as a required narrow repository seam: one requested-section-driven
  batch query, independent pinned and ordinary index branches, count/sort/limit
  on narrow session ids, then one cross-section canonical entity hydration.
  Reassert required rail indexes with idempotent `CREATE INDEX IF NOT EXISTS`
  during every store migration pass, including when the corresponding marker is
  already recorded, so schema drift repairs itself without rewriting session
  data.
  While workspace reconciliation is loading, update only the rail membership
  comparison baseline; do not target-refresh pages for historical snapshot
  hydration. Upsert first-page response entities into the workspace engine before
  publishing their membership ids. Resolved query cache entries must not contain
  session entities or ingestion ownership state.
  Do not add one `UNION ALL` arm per section; that restores section-count scaling
  and inherits SQLite's compound-select term limit.
- Validation:
  Run `pnpm --filter @tutti-os/agent-gui test`,
  `pnpm --filter @tutti-os/agent-activity-core test`, and
  `pnpm check:agent-activity-runtime-boundaries`. Also run
  `cd packages/agent/store-sqlite && go test ./... -run 'SessionSection|TurnsBackfill'`
  and
  `cd services/tuttid && go test ./service/agent ./api -run 'ListPage|SessionList|SessionSection'`
  so cursor metadata and daemon ordering are covered. Run
  `cd packages/agent/store-sqlite && go test -run '^$' -bench 'BenchmarkStoreListSessionSectionsLargeRemovedProjectHistory' -benchmem`
  to compare the batch reader with the serial reference across sparse and dense
  requested-section histories. Cover Codex -> All -> Codex,
  client restart restore, active row outside first page, five-plus-active totals,
  nine-session Show more, slow provider refetch, and bounded snapshot omission.
  Add a cold-start ordering case where historical workspace hydration arrives
  before the first section response and assert that no targeted membership refresh
  is issued.
- References:
  [useAgentGUIConversationRailQuery.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUIConversationRailQuery.ts)
  [agentGuiConversationRail.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/model/agentGuiConversationRail.ts)
  [AgentGUIConversationRailSection.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/view/AgentGUIConversationRailSection.tsx)
  [sessionEntities.reducer.ts](../../../packages/agent/activity-core/src/engine/sessionEntities.reducer.ts)
  [service_session_sections.go](../../../services/tuttid/service/agent/service_session_sections.go)

### Agent GUI no-project sessions appear under a user project

- Symptom:
  A conversation started with the "No project" selection appears in the Agent
  GUI rail under a parent user-project group such as the user's home directory.
  Imported Codex or Claude Code conversations with `cwd` equal to `$HOME`, and
  claude.ai data-export conversations that have no cwd at all, can show the
  same symptom even though the user never selected a project.
- Quick checks:
  Inspect the session `cwd` from the activity snapshot. Generated no-project
  sessions should carry `runtimeContext.noProject: true` in the daemon report
  before `cwd` is matched against parent user-project paths. If the create
  request contains that marker but the reported state does not, inspect
  `runtime.Controller.State`: it must preserve the session launch context while
  adding provider adapter state. For imported sessions, inspect `runtimeContext`
  for the daemon-owned `externalImportNoProject` marker. Claude data-export
  sessions should also carry `externalImportResumeSupported: false`. Check both
  the in-memory `rememberNoProjectPath` path and the restart fallback that
  recognizes `Documents/tutti/session-<uuid>`. Codex external history can also
  record its own scratch cwd under
  `Documents/Codex/<yyyy-mm-dd>/<conversation>`.
- Root cause:
  Rail membership is classified once by the daemon when the session is first
  persisted, using `cwd`, runtime no-project markers, and current user projects.
  If a generated no-project marker is lost before that write, longest-parent
  matching can assign the immutable `railSectionKey` to a broad project such as
  `$HOME`. External import has a similar trap because provider transcripts may
  record `$HOME` or a provider-owned scratch working directory as the cwd when
  no project was selected; that intent must reach initial persistence as session
  metadata. A second loss point is runtime state projection:
  rebuilding `runtimeContext` from only `cwd`, title, permissions, and visibility,
  or replacing it wholesale with `StateAdapter` output, drops launch-scoped
  markers such as `noProject` before durable rail classification runs.
- Fix:
  Build runtime state from a clone of the session launch `RuntimeContext`, overlay
  canonical session fields, and merge provider `StateAdapter` context as a patch
  instead of replacing the map. Provider values win on collisions, while
  launch-only markers remain available to the durable classifier.
  Persist Agent GUI rail grouping in daemon-owned
  `workspace_agent_sessions.rail_section_*` fields from the shared
  `services/tuttid/data/workspace` classifier. Migration and session-state
  upsert should both use that classifier, matching exact user projects first,
  then preserving no-project/provider scratch cwd shapes as conversations, then
  applying longest parent-project matches. Do not rederive historical rail
  assignment from the current user-project list or a later cwd observation;
  preserve every valid existing rail key unconditionally. A successful Create
  response must synchronously read back the persisted session and its nonblank
  key rather than racing the runtime's asynchronous activity reporter. AgentGUI
  must project sessions only by exact key equality and must not retain a cwd-based
  grouping fallback.
- Validation:
  Run
  `pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/model/agentGuiConversationModel.spec.ts`,
  `cd packages/agent/daemon && go test ./runtime`,
  `cd services/tuttid && go test ./service/agent ./api -run 'ExternalImport|ParseCodex|ParseClaude'`,
  `node --import ./test/register-asset-stub.mjs --test --experimental-strip-types ./src/renderer/src/features/workspace-user-project/services/internal/desktopWorkspaceUserProjectService.test.ts`
  from `apps/desktop`, then run `pnpm check:changed`.
- References:
  [controller_state.go](../../../packages/agent/daemon/runtime/controller_state.go)
  [controller_state_test.go](../../../packages/agent/daemon/runtime/controller_state_test.go)
  [external_import_parse.go](../../../services/tuttid/service/agent/external_import_parse.go)
  [external_import_projects.go](../../../services/tuttid/service/agent/external_import_projects.go)
  [agentGuiConversationModel.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/model/agentGuiConversationModel.ts)
  [desktopWorkspaceUserProjectService.ts](../../../apps/desktop/src/renderer/src/features/workspace-user-project/services/internal/desktopWorkspaceUserProjectService.ts)
  [agentGuiConversationProjectResolver.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/model/agentGuiConversationProjectResolver.ts)
  [agentGuiConversationListStore.ts](../../../packages/agent/gui/contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore.ts)

### Agent session restore breaks when durable snapshot ownership is split

- Symptom:
  Workspace agent sessions still appear recoverable after a renderer refresh,
  but after a `tuttid` restart the session list is empty, the detail pane
  falls back to an unavailable state, or a newly reported session overwrites
  older history for the same workspace.
- Quick checks:
  Confirm `services/tuttid/data/workspace` has a durable snapshot row for the
  workspace and that `services/tuttid/wiring.go` hydrates the in-memory agent
  activity store from it before new runtime reports are applied.
  If restore reads use a different source than write-time projection, verify
  both `List/Get` and message-history queries are reading the same durable
  snapshot shape.
  If the durable row has `provider_session_id` but ACP returns
  `Resource not found`, confirm the restore path re-runs the agent sidecar
  preparer and passes the prepared runtime environment, such as the per-session
  `CODEX_HOME`, into runtime resume.
- Root cause:
  Agent runtime reports are projected into an in-memory activity store, but
  restore paths survive daemon restarts only if the projected snapshot is also
  written to daemon-owned local state and reloaded before the next activity
  report. If only the renderer cache or only the daemon process memory holds
  the projection, session metadata and message history diverge after restart.
- Fix:
  Make `tuttid` own a durable agent snapshot in `data/workspace`, persist it
  from the activity-store update listener, and hydrate the in-memory activity
  store from that snapshot on first room tracking. Service-level
  session/message restore should read from the same durable snapshot source,
  and runtime mutations should on-demand resume a persisted session before
  accepting new input. Provider-session resume must use the same prepared
  sidecar runtime root and env as the original session, because provider ids
  are often scoped to provider-local state under that root.
- Validation:
  Add store round-trip coverage for the snapshot row, service tests that fall
  back to persisted sessions and resume them into runtime, then run
  `pnpm lint:go` plus `cd services/tuttid && go test ./... && go build ./...`.
- References:
  [service.go](../../../services/tuttid/service/agent/service.go)
  [wiring.go](../../../services/tuttid/wiring.go)

### Agent activity live updates fail after event schema changes

- Symptom:
  AgentGUI stays busy after a turn has finished, while durable
  `workspace_agent_sessions` state is already idle and daemon logs show
  `publish workspace agent activity update failed` with a
  `decode ... data: json: unknown field` error.
- Quick checks:
  Compare the new field in
  `packages/events/protocol/definitions/agent/activity.updated.event.json`,
  generated event protocol outputs, and the hand-written strict validators in
  `services/tuttid/service/eventstream/catalog.go`.
- Root cause:
  The shared business event schema and generated Go/TypeScript protocol files
  can be current while the daemon event-stream catalog still rejects the same
  payload through `DisallowUnknownFields` on a hand-written validation struct.
  The activity projection may persist the correct session state, but the live
  `agent.activity.updated` publish is rejected before the renderer runtime sees
  the settling patch.
- Fix:
  Keep `catalog.go` validation DTOs in sync with new event fields, especially
  for `agent.activity.updated` top-level, `session_update`, and `state_patch`
  payloads. Add a positive validator test for the new field, not only generated
  protocol checks.
- Validation:
  Run `go test ./services/tuttid/service/eventstream` and
  `pnpm check:event-protocol-generated` when event protocol sources changed.
- References:
  [catalog.go](../../../services/tuttid/service/eventstream/catalog.go)
  [activity.updated.event.json](../../../packages/events/protocol/definitions/agent/activity.updated.event.json)

### AgentGUI file-change undo reports a generic failure

- Symptom:
  Clicking Undo on a changed-files summary shows a failure even though the
  target directory is a Git repository and the file appears unchanged since
  the agent edit.
- Quick checks:
  Search desktop and daemon logs for the `agent-git-patch` diagnostic family.
  Inspect `errorCode`, Git `stderr`, the diff byte count and hash, and the
  affected paths. For `invalid-patch`, inspect the durable tool output for
  malformed unified-diff control markers. A no-newline marker must begin with
  `\`, not a leading context-space followed by `\`. For
  `patch-does-not-apply`, compare the recorded after-state with the current
  file rather than assuming the original turn is still the latest writer.
- Root cause:
  Provider display diffs can contain syntax that a viewer tolerates but
  `git apply` rejects. Treating that display payload as executable patch data
  produces corrupt hunks. A separate failure occurs when the patch is valid
  but later edits changed its context.
- Fix:
  Canonicalize provider file-change metadata at the runtime adapter boundary
  before persistence, and canonicalize historical no-newline markers on read.
  The daemon must preflight with `git apply --check` using the same execution
  options, return `invalid-patch` for syntax failures and
  `patch-does-not-apply` for state mismatch, and avoid mutating the worktree on
  either result.
- Validation:
  Cover leading-whitespace no-newline markers, historical activity projection,
  corrupt-patch preflight without mutation, worktree divergence, reverse
  application, and the existing untracked-created-file behavior.
- References:
  [claude_sdk_activity.go](../../../packages/agent/daemon/runtime/claude_sdk_activity.go)
  [agentPatchMetadata.ts](../../../packages/agent/gui/shared/agentConversation/rules/agentPatchMetadata.ts)
  [git_patch.go](../../../services/tuttid/service/agent/git_patch.go)

### Cursor deleted files appear as created or modified

- Symptom:
  After Cursor deletes a file, the settled turn's changed-files summary or tool
  detail labels it as created or modified instead of deleted.
- Quick checks:
  Inspect the original completed ACP tool payload, its following `turn.updated`
  event, and the durable turn row. Cursor reports deletion with ACP
  `kind = delete`, but its canonical tool name is still `Write`. The
  `turn.updated.metadata.fileChanges.files[]` entry and durable
  `file_changes_json` must both say `change = deleted`.
- Root cause:
  The canonical tool name describes the file-writing tool family, not the
  change direction. Inferring every `Write` as creation discards Cursor's
  explicit ACP delete semantic. A second failure mode is normalizing the tool
  call correctly but omitting canonical `fileChanges` from the subsequent turn
  state patch, leaving AgentGUI without its authoritative response-tail input.
- Fix:
  Normalize recognized provider change kinds inside the shared runtime
  file-change projector, accumulate the result per turn, and persist it through
  `turn.updated`. The session-detail response must return all durable root turns,
  and the desktop reconcile bridge must insert them into the existing activity
  engine turn store. AgentGUI reads only the matching canonical turn's
  `fileChanges`; do not add Cursor/ACP/Codex/Claude field inference to
  conversation projection. Keep tool `changes` payloads independently for
  Undo/Reapply patch batches. Do not backfill sessions whose historical turns
  have no canonical file changes.
- Validation:
  Cover the Cursor completed-call to `turn.updated` path, durable turn state,
  and canonical AgentGUI projection. Also cover Codex `changes[].kind.type` and
  Claude Code started/completed tool merging because all three providers share
  the same turn-level contract.
- References:
  [tool_file_changes.go](../../../packages/agent/daemon/runtime/tool_file_changes.go)
  [acp_turn_normalizer.go](../../../packages/agent/daemon/runtime/acp_turn_normalizer.go)
  [reporter_message.go](../../../packages/agent/daemon/runtime/reporter_message.go)
  [reporter_state.go](../../../packages/agent/daemon/runtime/reporter_state.go)
  [agentTurnSummaryProjection.ts](../../../packages/agent/gui/shared/agentConversation/projection/agentTurnSummaryProjection.ts)

### Remote agent cancel does not stop the local turn

- Symptom:
  A cancel request returns successfully and the provider adapter logs a remote
  cancel notification, but the session remains `running` and continues to emit
  model output.
- Quick checks:
  Inspect the runtime controller path for the active turn's local
  `context.CancelFunc`. A provider-level cancel or ACP notification is not
  enough if the local `Exec` goroutine is still waiting on the original turn
  context.
- Root cause:
  Some providers treat cancel as a notification and may return no immediate
  terminal events. If the controller does not also cancel the local active turn
  context, `runExecTurn` cannot converge through its context-canceled path.
- Fix:
  Once an active turn is found, cancel its local context as part of the
  controller cancel flow, then call the provider adapter cancel hook so both
  local and remote paths are interrupted.
- Validation:
  Add a controller test with an adapter that returns no cancel events and only
  exits when its `Exec` context is canceled. A direct API smoke should return
  HTTP 200 and final session status `canceled`.
- References:
  [controller.go](../../../packages/agent/daemon/runtime/controller.go)
  [controller_test.go](../../../packages/agent/daemon/runtime/controller_test.go)

### Claude Code cancel leaves Write/tool cards or thinking stuck in progress

- Symptom:
  User stops a Claude Code turn while a tool such as Write is running, or while
  the assistant is still in a thinking disclosure. The turn settles as
  canceled/interrupted, but the transcript still shows the tool as in progress
  or thinking as forever-"thinking".
- Quick checks:
  Compare durable tool-call / `assistant_thinking` message status with turn
  outcome. If the turn is interrupted/canceled and an open `tool_call` is still
  `running`, or thinking is still `streaming`/`working`, the Claude SDK turn
  lifecycle did not finish dangling normalizer-owned rows. Confirm Codex/ACP
  cancel of the same shape closes open tools and thinking via
  `acpTurnNormalizer.FinishInterrupted`.
- Root cause:
  Claude Code SDK first projected tool events without owning the shared turn
  event lifecycle (`acpTurnNormalizer`), so cancel settled the turn without
  `Finish*` and open tools never received terminal `call.failed`. A follow-on
  gap kept thinking/assistant snapshots off that same normalizer: only tools
  were tracked, so Stop could fail open Write cards while leaving an in-flight
  thinking row at `streamState=streaming`.
- Fix:
  Attach per-turn `acpTurnNormalizer` on the Claude SDK session. Track
  `call.started/completed/failed` against that normalizer, route thinking and
  assistant snapshots through the same normalizer, and call
  `FinishInterrupted` / `FinishFailed` / `FinishCompleted` as part of turn
  terminalization (`Cancel`, sidecar `turn_*`, reader failure). Drop late tool
  events after the turn is already settled.
  Also: controller Cancel cancels the Exec context before `adapter.Cancel`.
  Claude Exec unregisters its waiter on that context cancel, so Cancel must
  finish open tools/streams from the turn-normalizer map (not only live
  waiters). The controller Exec context-canceled path must retain those
  adapter-produced close events via `retainTurnCallLifecycleEvents` — not only
  `call.failed`, but also failed/completed assistant/thinking message
  snapshots — instead of replacing the whole event slice with a bare
  turn.canceled. Otherwise FinishInterrupted runs in Exec, then the controller
  drops the thinking settlement and the durable row stays `streaming`.
- Validation:
  `go test ./packages/agent/daemon/runtime -run 'TestClaudeCodeSDKAdapter(CancelFailsOpenToolCalls|CancelFailsOpenToolsAfterWaiterUnregistered|TurnCanceledFailsOpenToolCalls|CancelFailsOpenThinking|MapsThinkingEvents)|TestRetainTurnCallLifecycleEvents'`.
  Manually: rebuild/restart desktop so `tuttid` includes the fix, then start
  Claude Code, stop during thinking and during a long Write; confirm thinking
  leaves the active state and the tool card leaves "in progress". In
  `~/.tutti-dev/tuttid.db`, the reasoning message status should leave
  `streaming` after cancel.
- References:
  [claude_sdk_turn.go](../../../packages/agent/daemon/runtime/claude_sdk_turn.go)
  [claude_sdk_events.go](../../../packages/agent/daemon/runtime/claude_sdk_events.go)
  [claude_sdk_execution.go](../../../packages/agent/daemon/runtime/claude_sdk_execution.go)
  [controller_turn_exec.go](../../../packages/agent/daemon/runtime/controller_turn_exec.go)
  [controller_turn_state.go](../../../packages/agent/daemon/runtime/controller_turn_state.go)
  [acp_turn_normalizer.go](../../../packages/agent/daemon/runtime/acp_turn_normalizer.go)
  [acp_turn_normalizer_snapshots.go](../../../packages/agent/daemon/runtime/acp_turn_normalizer_snapshots.go)

### Claude Code starts another command after Stop

- Symptom:
  User stops a Claude Code turn after a Bash command becomes a background task.
  The turn settles as canceled, but background completion is followed by a new
  assistant continuation, approval, or Bash command such as `ls`. The new
  provider id may be synthetic even though no sub-agent exists.
- Quick checks:
  Correlate provider session id, canonical root turn id, and sidecar events. If
  a background `task_notification` arrives after `turn_canceled`, followed by
  synthetic `turn_started` or `approval_requested`, inspect SDK Query lifetime.
  Confirm the exported session has no child-session relation before classifying
  the continuation as a sub-agent.
- Root cause:
  Claude Agent SDK `interrupt()` stops current query execution but does not
  terminate the Query or all background resources. Reusing that Query lets a
  late background completion trigger another root inference. Filtering the
  synthetic event in AgentGUI or daemon persistence is too late: provider code
  may already have requested or executed the tool, especially under
  `bypassPermissions`.
- Fix:
  Treat each SDK Query as an execution generation. Cancel revokes the generation
  before calling the SDK, rejects its pending interactions, awaits the interrupt
  acknowledgment, then closes it in cleanup. Fence messages, hooks, and
  `canUseTool` by generation identity. Give the next real user prompt a fresh
  prompt queue and Query using `resume: providerSessionId`. Consume a canceled
  generation's replayed terminal task notification and paired result before
  they can settle the new canonical Turn. Keep normal non-canceled child
  completion continuations enabled. As defense in depth, reject a new pending
  Interaction whose canonical owning Turn is already settled.
- Validation:
  Run `pnpm --filter @tutti-os/claude-sdk-sidecar test` and
  `go test ./packages/agent/store-sqlite -run 'TestUpsertInteractionRejectsNewPendingRequestOnSettledTurn'`.
  Cover default and `bypassPermissions`, assert no synthetic turn, approval, or
  tool permission after cancel, then assert a new real prompt resumes the same
  provider session.
- References:
  [sessionRuntime.ts](../../../packages/agent/claude-sdk-sidecar/src/sessionRuntime.ts)
  [queryGeneration.ts](../../../packages/agent/claude-sdk-sidecar/src/queryGeneration.ts)
  [activity_turns.go](../../../packages/agent/store-sqlite/activity_turns.go)

### AgentGUI freezes when session history is large

- Symptom:
  The workspace renderer freezes, tears visually in screen recordings, or feels
  stuck while opening AgentGUI or submitting an agent prompt in a workspace with
  a long agent history.
- Quick checks:
  Inspect developer logs for `agent.gui.runtime.snapshot_changed` diagnostics.
  If `sessionCount` is in the hundreds or thousands, check whether the desktop
  adapter is calling `listWorkspaceAgentSessions` without a `limit`.
- Root cause:
  Unbounded session-list loads push every historical agent session into
  `AgentActivityRuntime`, and each live event can make AgentGuiNode rebuild
  conversation projections for history the visible rail does not need.
- Fix:
  Keep broad runtime session-list requests bounded at the desktop adapter or
  daemon API boundary. Use targeted message/session fetches for the selected
  detail rather than widening the runtime snapshot.
- Validation:
  Reproduce with a large session table and confirm runtime diagnostics report a
  bounded `sessionCount`. Run the desktop adapter tests and `pnpm check:changed`
  for mixed AgentGUI/desktop changes.
- References:
  [desktopAgentActivityAdapter.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.ts)
  [createDesktopAgentActivityRuntime.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.ts)

### AgentGUI @ Sessions tab is empty

- Symptom:
  Opening the composer `@` palette (default Sessions tab) shows no session
  rows, even though the workspace has agent history.
- Quick checks:
  In `tuttid.log`, look for `event=workspace.agent_session.api.list_completed`
  from `GET /v1/workspaces/{workspaceID}/agent-sessions` (the Sessions-tab
  source). Check `session_count`. Do not confuse it with
  `workspace.agent_session.messages.api.list_*` or
  `workspace.agent_session.section.list_failed`.
- Root cause:
  The Sessions tab loads through `listWorkspaceAgentSessions`. Successful calls
  previously left no durable log, so empty palettes could not be distinguished
  from "API never ran" or "API returned zero sessions" in exported logs.
- Fix:
  Successful list responses now emit
  `workspace.agent_session.api.list_completed` with `session_count`. If the
  event is missing, the client never hit the endpoint; if `session_count=0`,
  the daemon truly returned an empty list.
- Validation:
  Click the composer `@` button, confirm a
  `workspace.agent_session.api.list_completed` line appears with a non-zero
  `session_count` when sessions exist.
- References:
  [daemon_agent_session_list.go](../../../services/tuttid/api/daemon_agent_session_list.go)
  [desktopRichTextAtAgentContributors.ts](../../../apps/desktop/src/renderer/src/features/rich-text-at/services/internal/desktopRichTextAtAgentContributors.ts)
  [agent-gui-node.md](../../architecture/agent-gui-node.md)

### Agent diagnostics flood while a turn is streaming

- Symptom:
  Exported developer logs are dominated by agent diagnostics and the app feels
  sluggish while a streaming turn is active or while switching AgentGUI sessions.
- Quick checks:
  Count repeated `agent submit trace`, `agent.activity.reconcile.trace`, and
  `agent.gui.node.render_state_changed` lines before blaming one visible click.
  Runtime event emissions should appear as
  `runtime.events_emitted.summary`/`runtime.async_events_emitted.summary`;
  successful inline reconciles should appear as `inline.applied.summary`.
  If the old per-event names dominate a new log, the running app is stale.
- Root cause:
  Per-token runtime events and renderer inline reconcile commits can produce
  thousands of diagnostic writes. Those writes compete with rendering and also
  inflate trace/log exports enough to obscure the actual session-switch work.
- Fix:
  Keep success-path diagnostics aggregated by turn or short time window. Reserve
  per-event logging for failures or rare state transitions.
- Validation:
  Reproduce a streaming turn and confirm the high-volume success paths collapse
  to summary entries while `inline.not_applied` and submit failures still retain
  event-level detail.
- References:
  [controller.go](../../../packages/agent/daemon/runtime/controller.go)
  [workspaceAgentActivityService.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.ts)
  [useAgentGUINodeController.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts)

### Claude export leaks hidden data, flattens branches, or resumes as Claude Code

- Symptom:
  Imported claude.ai history shows internal thinking/tool payload text, mixes
  mutually exclusive edited/retried messages into one timeline, or the composer
  tries to resume an imported web conversation as if its UUID were a local
  Claude Code session id.
- Quick checks:
  Inspect the source message shape without logging its content. Visible text
  must come from ordered `content[type=text]` blocks; legacy human messages
  with no content blocks may fall back to top-level `message.text`, but
  assistant messages never may (that field mixes in hidden thinking and tool
  material). Inspect the persisted runtime context for
  `externalImportResumeSupported: false`, and confirm the source path is not
  forwarded as an external Claude Code rollout path. For a branched fixture,
  confirm every imported message belongs to the selected latest leaf's ancestor
  path and carries the same `sourceBranchLeafId`.
- Root cause:
  Claude data exports use top-level `message.text` as a convenience aggregate
  that can include hidden thinking and tool material. Their conversation UUIDs
  belong to claude.ai, not the local Claude Code runtime, and referenced files
  in `conversations.json` do not imply that file payloads exist in the ZIP.
  `chat_messages` is a parent graph rather than a guaranteed linear list, so
  timestamp-sorting every node can combine incompatible sibling branches.
- Fix:
  Parse only the exact root `conversations.json` entry without extracting the
  archive. Project visible text from text blocks, keep file-only messages as
  unavailable references, select one deterministic latest root-to-leaf branch,
  seed persisted message ids from source UUIDs, and include the selected sibling
  choices in imported session identity so a future retry-branch change cannot
  append into the old branch. Place sessions in the no-project Chats section and
  mark them non-resumable while preserving the normal continue-in-new-chat
  recovery action.
- Validation:
  Run `cd services/tuttid && go test ./service/agent ./api -run
'ExternalImport|ClaudeExport|ExternalRollout'`, then run
  `pnpm --filter @tutti-os/desktop test` and `pnpm check:i18n`.
- References:
  [external_import_claude_export.go](../../../services/tuttid/service/agent/external_import_claude_export.go)
  [ExternalAgentSessionImportWizard.tsx](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/ExternalAgentSessionImportWizard.tsx)
  [service_session.go](../../../services/tuttid/service/agent/service_session.go)

### Imported sessions trigger fresh-completion indicators

- Symptom:
  After importing Codex or Claude Code history, Agent GUI conversation rows show
  unread-completion lamps, or Message Center's priority view briefly shows many
  items under the recently-completed group, even though those sessions are
  historical imports rather than newly finished local runs.
- Quick checks:
  Inspect the session `runtimeContext`. Imported sessions should carry
  `imported: true`. Conversation summaries and Message Center items derived from
  them should preserve that marker before unread-completion or priority grouping
  is derived.
- Root cause:
  Agent GUI unread-completion lamps and Message Center's recently-completed
  group are notification-style surfaces. Imported history is persisted as
  completed agent activity, so if projection models treat imported sessions the
  same as live runtime completions, a bulk import can look like a burst of fresh
  completed work.
- Fix:
  Keep imported sessions visible in Agent GUI, Message Center, and completed
  filters, but exclude `runtimeContext.imported` items from unread-completion
  lamps and recently-completed groups.
- Validation:
  For Agent GUI rail read-state changes, run
  `pnpm --dir packages/agent/gui exec vitest run --environment jsdom contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore.spec.ts`.
  For Message Center grouping changes, run
  `pnpm --dir packages/agent/gui exec vitest run --environment jsdom agent-message-center/workspaceAgentMessageCenterModel.spec.ts agent-message-center/workspaceAgentMessageCenterViewModel.spec.ts`.
- References:
  [agentGuiConversationListStore.ts](../../../packages/agent/gui/contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore.ts)
  [workspaceAgentMessageCenterModel.ts](../../../packages/agent/gui/agent-message-center/workspaceAgentMessageCenterModel.ts)
  [workspaceAgentMessageCenterViewModel.ts](../../../packages/agent/gui/agent-message-center/workspaceAgentMessageCenterViewModel.ts)

### Realtime agent completion does not show unread attention

- Symptom:
  A turn settles while Agent GUI is open, but its conversation row never shows
  unread-completion attention. Historical sessions may behave correctly and
  must not acquire attention merely because their snapshot was loaded.
- Quick checks:
  Trace the event path into the activity engine. A realtime `turn_update`
  should trigger an authoritative session fetch and reduce `session/upserted`
  before `turn/upserted`. Initial, restored, and imported history should enter
  through `session/snapshotReceived` only. Also confirm the projected desktop
  session carries the shared local Agent GUI user id used by read-state actions.
- Root cause:
  Realtime and historical data lost their provenance when both were folded into
  a mutable controller snapshot and re-emitted as `session/snapshotReceived`.
  The attention reducer correctly treats snapshots as non-live, so it recorded
  the settled completion without producing unread attention; a later live
  update with the same completion key could no longer recover the transition.
- Fix:
  Keep the activity engine as the single mutable owner. Feed pull/bootstrap
  results through `session/snapshotReceived`, feed authoritative realtime
  reconciliation through `session/upserted` followed by `turn/upserted`, and
  use inline message events only for message deltas. Preserve the realtime
  marker outside the fetched snapshot, and use one shared local identity for
  session projection and read-state commands.
- Validation:
  Run
  `pnpm --filter @tutti-os/desktop test -- workspaceAgentActivityService.test.ts`
  and verify the service integration coverage proves that realtime completion
  becomes unread while a settled historical load remains read.
- References:
  [workspaceAgentActivityReconcileBridge.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityReconcileBridge.ts)
  [workspaceAgentActivityService.test.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.test.ts)
  [attentionReadState.reducer.ts](../../../packages/agent/activity-core/src/engine/attentionReadState.reducer.ts)

### Completed agent session stays activating and disables the composer

- Symptom:
  A new conversation visibly completes and its assistant reply is present, but
  opening it leaves the composer disabled. Roughly one activation-expiry window
  later, AgentGUI reports that the agent session could not be started.
- Quick checks:
  Correlate activation diagnostics with the authoritative session updates. If
  the session create and turn both succeeded while the presentation remains
  `activating` until `engine/intentExpired`, inspect which session intent
  reached the pending-activation reducer. Also check that a failed realtime
  session fetch does not consume the live-reconcile marker before a retry.
- Root cause:
  An engine migration introduced `session/upserted` for authoritative mutation
  and realtime results, while pending activation still confirmed only from the
  historical `session/snapshotReceived` path. The canonical session therefore
  existed and could render, but the independent activation intent expired and
  overrode the composer with a false failure. Consuming realtime provenance
  before a fallible fetch can produce a related retry-only mismatch.
- Fix:
  Confirm activation from both authoritative session intents. Preserve the
  semantic distinction only where it matters: historical snapshots remain
  neutral for unread attention, while realtime reconciliation additionally
  emits the live turn update. Move a consumed realtime marker to an in-flight
  state and restore it after fetch failure until a live session is applied or
  the session is deleted.
- Validation:
  Cover the reducer with a pending activation followed by `session/upserted`.
  At the desktop service boundary, run a real engine activation through the
  create result, manually expire its old deadline, and verify the presentation
  remains active. Also fail the first realtime reconciliation, retry it, and
  verify the settled turn still gains unread attention.
- References:
  [pendingIntents.reducer.ts](../../../packages/agent/activity-core/src/engine/pendingIntents.reducer.ts)
  [workspaceAgentActivityReconcileBridge.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityReconcileBridge.ts)
  [workspaceAgentActivityService.test.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.test.ts)

### AgentGUI submit clears the composer but creates no session or turn

- Symptom:
  Sending from AgentGUI clears or switches the composer, but the conversation
  rail and transcript do not change. Renderer diagnostics stop at
  `renderer_adapter.create.http_requested` or
  `renderer_adapter.send.http_requested`, and the daemon has no matching
  `clientSubmitId`.
- Quick checks:
  Correlate `clientSubmitId` across the desktop and daemon logs. If the engine
  records an immediate failed activation while the daemon has no create/send
  business log, compare the adapter's exact JSON body with the generated
  request type and the OpenAPI schema, including `additionalProperties`.
- Root cause:
  A conditional object spread can add a stale property to an otherwise typed
  request without triggering excess-property checking. Strict OpenAPI request
  validation then rejects the body before the business handler, while eager
  composer clearing makes the failed request look successful for an instant.
- Fix:
  Keep `clientSubmitId` as the top-level idempotency field and carry optional
  evidence through the typed `submitDiagnostics` contract from AgentGUI through
  the session engine to the desktop adapter. Assign the final body to the
  generated request type before sending. Clear a draft only after the engine
  queues, accepts, or confirms the exact submitted content; failed sends retain
  the draft.
- Validation:
  Assert the adapter's complete create/send body with generated request types,
  verify the generated client serializes `submitDiagnostics`, and cover that
  Composer does not clear before its parent applies engine acknowledgment.
- References:
  [agent-gui-node.md](../architecture/agent-gui-node.md)
  [desktopAgentActivityAdapter.ts](../../apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.ts)
  [useAgentGUISubmitInteractionActions.ts](../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUISubmitInteractionActions.ts)

### AgentGUI send reports `workspace_agent.send_response_turn_required`

- Symptom:
  Sending or continuing a conversation reaches the provider, but the renderer
  rejects the HTTP result with `workspace_agent.send_response_turn_required`.
  A realtime reconcile may make the conversation recover moments later, so the
  failure can appear release- or timing-dependent.
- Quick checks:
  Correlate one `clientSubmitId` across `runtime.submitted`,
  `api.send.completed`, and the following `turn_update`. If the API completes
  with a submitted runtime Turn while its session projection is still settled,
  then the response raced the asynchronous activity report. Inspect the raw
  response: a Turn-producing branch missing either `turnId` or `turn` violates
  the protocol even if realtime state arrives afterward.
- Root cause:
  `RuntimeController.Exec` queued the submitted Turn report asynchronously,
  started provider work, and returned. The service immediately refreshed the
  older durable Session, while the API conditionally copied `session.activeTurn`.
  The exact Turn therefore disappeared from an otherwise successful response.
- Fix:
  Make the submitted Turn report a synchronous durable-acceptance barrier.
  Commit the session pointer and Turn atomically before publishing or starting
  provider work; roll runtime state back on report failure. Read the exact Turn
  by the runtime-returned `turnId` in the service, and model send output as an
  OpenAPI discriminated union whose Turn branch requires both fields. Keep Goal
  control Turn-less. Do not add renderer polling, sleeps, or synthetic Turns.
- Validation:
  Block the activity reporter and prove both `Exec` and provider startup wait;
  fail it and prove no provider execution or active Turn survives. Cover stale
  Session plus exact-Turn service reads, required API Turn output, and the
  Turn-less Goal-control branch. Run API generation drift checks and the Agent
  session engine suite.
- References:
  [agent-gui-node.md](../../architecture/agent-gui-node.md)
  [controller_exec.go](../../../packages/agent/daemon/runtime/controller_exec.go)
  [service_send_input.go](../../../services/tuttid/service/agent/service_send_input.go)
  [daemon_agent_submit_handlers.go](../../../services/tuttid/api/daemon_agent_submit_handlers.go)

### AgentGUI new session times out and appears completed without a reply

- Symptom:
  A new conversation shows the optimistic user prompt, then becomes idle or
  completed with no assistant reply. The session has no canonical turn or
  messages.
- Quick checks:
  Correlate the create `clientSubmitId`. A characteristic sequence is desktop
  `renderer_adapter.create.failed errorCode=ETIMEDOUT` at 30 seconds, followed
  by daemon `provider_runtime_status=failed`, `agent session is not connected`,
  and a rejected turnless `visible-error` message.
- Root cause:
  Runtime command-guide construction asked the CLI registry to run live
  capability filters. The agent-context filter probes provider availability,
  so static guide construction could consume the entire create-request budget.
  Cancellation then reached provider startup. The failed startup was also
  published as a durable session plus a message without a turn, creating a
  phantom session that the UI could only project as idle/completed.
- Fix:
  Build runtime command guides from static capability registration with live
  capability filters skipped. Treat provider startup as transactional: return a
  typed runtime error when the provider fails to start; for create-with-prompt,
  keep the runtime Session provisional until the first Turn is accepted. A
  failed or rolled-back attempt must not publish or store a canonical Session,
  Turn, command/config snapshot, or turnless message.
- Validation:
  Cover the non-blocking command-catalog context, typed failed-start mapping,
  provisional provider callback isolation and rollback, and controller behavior
  proving that startup failure returns diagnostics but creates no canonical
  session or activity report.
- References:
  [command_catalog.go](../../services/tuttid/service/agentsidecar/command_catalog.go)
  [controller_session_lifecycle.go](../../packages/agent/daemon/runtime/controller_session_lifecycle.go)
  [agent_runtime_adapter.go](../../services/tuttid/agent_runtime_adapter.go)

### AgentGUI cannot stop Cursor immediately after the first message

- Symptom:
  The first Cursor message enters an activating state, but Stop is absent or
  does nothing until a canonical session and Turn appear. Codex and Claude Code
  often appear unaffected because their startup completes before a user can hit
  the same window.
- Quick checks:
  Correlate the activation request with process spawn, ACP `initialize`,
  `session/new`, and the first Turn. If Stop becomes available only after the
  Turn id is known, the UI and engine are treating cancellation as turn-only.
  Also inspect failed-create cleanup after request cancellation for provisional
  runtime state left under the session id.
- Root cause:
  New-session activation is an abortable engine command before it becomes a
  canonical Turn. A turn-only Stop gate cannot target that command, and a cancel
  operation stored only under existing session entities is lost on an empty
  reconciliation snapshot. Cleanup that reuses the canceled request context
  can then fail to close the provisional runtime.
- Fix:
  Dispatch one provider-neutral session Stop intent. Abort the exact activation
  command by command id, preserve a detached workspace/session-scoped
  `awaitingTurn` cancel through snapshots, and convert it to exact-turn cancel
  when the first Turn arrives. Expire the detached operation after a bounded
  window. Run failed-create close and cleanup with a bounded context detached
  from request cancellation.
- Validation:
  Cover immediate activation abort, empty-snapshot preservation, late first-Turn
  cancel, expiry before an unrelated future Turn, and identical lifecycle
  behavior for Cursor, Codex, and Claude Code. Verify AgentGUI exposes Stop
  while new-conversation activation is still submitting.
- References:
  [createAgentSessionEngine.ts](../../../packages/agent/activity-core/src/engine/createAgentSessionEngine.ts)
  [sessionLifecycle.reducer.ts](../../../packages/agent/activity-core/src/engine/sessionLifecycle.reducer.ts)
  [pendingIntents.reducer.ts](../../../packages/agent/activity-core/src/engine/pendingIntents.reducer.ts)
  [useAgentGUIDetailModel.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/view/useAgentGUIDetailModel.tsx)
  [service.go](../../../services/tuttid/service/agent/service.go)

### Cursor session/new is canceled before its 30-second timeout

- Symptom:
  Sending the first message to Cursor leaves AgentGUI activating until Tutti
  reports a timeout. Cursor logs show `session/new` started, but it is canceled
  substantially before the ACP runtime's configured 30-second deadline.
- Quick checks:
  Correlate `service.create.entered`, provider-status completion,
  `runtime_start_requested`, ACP `initialize`, and `session/new`. If a full
  provider-status probe runs inside `Service.Create`, or the renderer activation
  expires 30 seconds after the click rather than 30 seconds after `session/new`
  starts, the protocol call is receiving only a leftover budget.
- Root cause:
  Provider readiness was treated as a per-session precondition even though it
  performs application-scoped binary, version, and auth detection. Cursor auth
  fallback commands can consume several seconds before ACP starts. An outer
  30-second activation timer then propagates cancellation into the daemon and
  truncates the independent 30-second `session/new` timeout.
- Fix:
  Cache provider readiness in `tuttid` per provider with completion-time TTL and
  single-flight refresh. Explicit setup refreshes bypass that cache; ordinary
  session creation does not run status, version, auth, network, or hidden model
  discovery. Let the actual process spawn and ACP handshake be authoritative.
  Give new-session activation a larger outer safety deadline while preserving
  the ACP runtime's own 30-second `session/new` deadline.
- Validation:
  Cover cache reuse across all-provider and single-provider requests, forced
  refresh, concurrent single-flight reads, absence of availability checks from
  `Service.Create`, and a new-session activation timeout larger than 30 seconds.
- References:
  [status_cache.go](../../../services/tuttid/service/agentstatus/status_cache.go)
  [service.go](../../../services/tuttid/service/agent/service.go)
  [pendingIntents.reducer.ts](../../../packages/agent/activity-core/src/engine/pendingIntents.reducer.ts)
  [acp_shared.go](../../../packages/agent/daemon/runtime/acp_shared.go)

### Cursor auto-continue invents interrupted work after a network drop

- Symptom:
  After a Cursor `RetriableError` / TLS drop and Tutti's automatic
  `transport_retry`, the agent does not answer the user's last message
  (for example a simple greeting). Instead it talks about recovering prior
  context, reading transcripts, or continuing an interrupted task that never
  started.
- Quick checks:
  In the session transcript, confirm the failed attempt produced only the
  `Error: RetriableError:` / `Error: ConnectError:` tail (no useful assistant
  text and no tool calls) before the retry notice. Check
  `agent_session.acp.exec.auto_continue` in `tuttid` logs for
  `has_useful_progress=false`.
- Root cause:
  Cursor keeps conversation history on its backend; Tutti can mainly control the
  synthetic auto-continue `session/prompt`. Mid-task wording
  ("Continue exactly where you left off") misleads the model when the attempt
  died before any useful output.
- Fix:
  Branch the auto-continue prompt by useful progress: zero-progress retries ask
  the model to answer the user's most recent message normally and not invent
  interrupted work; mid-task retries keep the continue wording. Progress is
  assistant text after stripping the retriable error tail, or any observed tool
  call.
- Validation:
  `cd packages/agent/daemon && go test ./runtime/ -run
'TestACPAutoContinueHasUsefulProgress|TestACPAutoContinuePromptContentBranches|TestCursorAdapterAutoContinuesAfterRetriableTurnError|TestCursorAdapterAutoContinueMidTaskUsesContinuePrompt'`.
  Live: send a short Cursor message that fails before any reply, confirm the
  retry answers the user instead of recovering a phantom task, and that
  mid-task drops still resume in place.
- References:
  [acp_auto_continue.go](../../../packages/agent/daemon/runtime/acp_auto_continue.go)
  [standard_acp_turn.go](../../../packages/agent/daemon/runtime/standard_acp_turn.go)
  [acp_auto_continue_test.go](../../../packages/agent/daemon/runtime/acp_auto_continue_test.go)

### Canceling an old AgentGUI turn stops a newer turn

- Symptom:
  A `cancelTurn(turnId)` request targets an older turn, but a newer turn in the
  same session stops, or the requested turn is reported canceled even though
  the runtime continued with a different active turn.
- Quick checks:
  Compare `requested_turn_id` and `active_turn_id` in
  `agent_session.cancel.turn_mismatch`. Also check whether a new `Exec` entered
  between the exact-turn lookup and the provider cancel call.
- Root cause:
  Session-level provider cancel APIs do not carry a turn id. Validating the id
  before calling the adapter is insufficient unless validation and cancel are
  protected by the same session lifecycle lock used to start turns.
- Fix:
  Carry the requested turn id through HTTP service, runtime adapter, and
  controller. Return an idempotent no-op on mismatch, and hold the per-session
  lifecycle lock across the active-turn comparison and `adapter.Cancel` so a
  new turn cannot enter the gap.
- Validation:
  Cover both a mismatched active turn (the adapter must not be called) and a
  blocking adapter cancel (a second lifecycle operation must remain blocked
  until cancel returns).
- References:
  [service_turns.go](../../services/tuttid/service/agent/service_turns.go)
  [controller_cancel.go](../../packages/agent/daemon/runtime/controller_cancel.go)
  [controller_test.go](../../packages/agent/daemon/runtime/controller_test.go)

### Historical Agent completions notify again when a workspace opens

- Symptom:
  Opening a workspace produces completion or failure notifications for turns
  that settled before the window was opened.
- Quick checks:
  Compare notification-controller creation with the first agent activity
  `load`. If the engine was empty at subscription time and the first populated
  snapshot contains settled turns, verify those turns were treated as initial
  hydration rather than live transitions.
- Root cause:
  Taking an empty engine snapshot as the history baseline is insufficient when
  durable loading happens asynchronously after subscribers are registered.
  The first hydrated settled turn then looks indistinguishable from a newly
  settled turn.
- Fix:
  Keep outcome notifications behind an explicit hydration boundary. Record all
  settled turns observed before the initial durable load resolves as baseline
  history. After hydration, notify only the first observation of each
  session-scoped turn key; a live non-settled turn can also establish readiness
  when the initial load is unavailable.
- Validation:
  Cover the real startup order: subscribe against an empty engine, hydrate a
  historical settled turn without notifying, finish hydration, then verify a
  later running-to-settled turn notifies exactly once.
- References:
  [workspaceAgentOutcomeNotification.ts](../../apps/desktop/src/renderer/src/features/workspace-workbench/services/workspaceAgentOutcomeNotification.ts)
  [workspaceAgentOutcomeNotification.test.ts](../../apps/desktop/src/renderer/src/features/workspace-workbench/services/workspaceAgentOutcomeNotification.test.ts)

### Agent GUI context usage is absent or has the wrong total

- Symptom:
  The Agent GUI composer never shows context usage even though provider usage
  logs are present. Alternatively, Claude Code GUI usage shows a 200k context
  window for a model that should have 1M context, or a 200k model keeps showing
  the prior 1M total after a model switch. After one Claude Code request runs
  several tools, the used-token count may also jump from the latest iteration's
  value to nearly the sum of every iteration in that turn. A related lifecycle
  symptom is that Claude has rendered its final answer but Agent GUI remains in
  the working state until a delayed context-usage control request returns.
- Quick checks:
  Trace the provider update first: use
  `agent_session.claude_sdk.usage_update` for Claude SDK and
  `agent_session.acp.usage_update` for ACP providers. Then inspect the daemon
  session response for its typed `usage.contextWindow` field and confirm the
  desktop canonical session preserves it. If provider logs contain nonzero
  used and total tokens but the API field is null, inspect the runtime-context
  split into typed session metadata. If the API field is populated but the
  footer is absent, inspect the desktop adapter and the active canonical
  session passed to the composer capability projection. For Claude, if the
  payload keys include
  `modelUsage` but `raw_total_tokens` is `0`, the daemon did not parse the
  model-usage context window. If `previous_context_model` and
  `current_context_model` differ but `current_total_tokens` equals
  `previous_total_tokens`, daemon usage normalization reused a stale context
  window across models. For a tool-loop spike, compare the streamed
  `normalized_used_tokens` values with the final Result update. If the final
  value equals their sum, the cumulative Result usage was mistaken for current
  context occupancy. For a stuck working indicator, compare the Claude SDK
  `result` lifecycle timestamp with the later `context_window` usage update and
  `turn_completed`; a long result-to-completion gap isolates telemetry on the
  terminal path rather than unfinished provider work.
- Root cause:
  Protocol v2 intentionally removed raw `runtimeContext` from the public
  session model. If the refactor removes that legacy field without adding a
  typed `usage` field across persistence, API generation, the desktop adapter,
  and the canonical session, the provider still records correct telemetry but
  Agent GUI has no public data to render. A wrong Claude total is a separate
  normalization failure: Claude SDK result messages expose model usage as a map
  keyed by model id, for example
  `modelUsage["claude-sonnet-5"].contextWindow`. If either sidecar or daemon
  only parses array-shaped `modelUsage`, the context-window total is missing and
  daemon normalization falls back to 200k. Claude SDK Result `usage` is
  cumulative across the model iterations in a client-side tool loop, whereas
  each streamed usage update describes one iteration. The authoritative
  `Query.getContextUsage()` snapshot must therefore win at Result time. Calling
  that method after detaching it from the Query object loses its `this` binding;
  if the best-effort error is swallowed, the cumulative fallback remains
  visible as a false context spike. Conversely, awaiting a correctly bound
  `getContextUsage()` call before emitting `turn_completed` makes optional
  telemetry a lifecycle dependency and leaves the GUI working for the duration
  of a slow control response.
- Fix:
  Define usage in the protocol-v2 OpenAPI contract and carry it as typed durable
  session metadata through the generated client, desktop adapter, canonical
  activity session, and composer projection. Keep raw runtime context private
  to provider recovery; do not restore a GUI runtime-context dependency.
  Parse `modelUsage` recursively as both arrays and maps before using fallback
  context-window values. Track the model associated with a cached context
  window, and only reuse the previous total for the same model or when the model
  is unknown. Do not hard-code alias-to-model mappings in Tutti. Invoke
  `getContextUsage()` through its owning Query object after the Result has
  terminalized the turn. Keep the authoritative snapshot and cumulative Result
  fallback in an asynchronous telemetry path, and invalidate a delayed snapshot
  when a newer snapshot request starts or a later root user prompt begins so
  older usage cannot overwrite newer work.
- Validation:
  Cover runtime-context splitting and metadata persistence, generated API
  projection, desktop canonical-session adaptation, activity-core usage
  resolution, and the composer hook.
  Add sidecar and daemon coverage with map-shaped `modelUsage` carrying
  `contextWindow: 1_000_000`, plus daemon coverage for Haiku -> Sonnet5 -> Haiku
  usage updates where the last payload lacks `totalTokens`. Add a sidecar query
  fixture whose `getContextUsage()` depends on `this`, and give its Result a
  multi-iteration cumulative usage total; assert that only the authoritative
  context snapshot is emitted. Also cover a context query that remains pending:
  `turn_completed` must be emitted first, and a delayed snapshot must be dropped
  after a newer snapshot request or the next root user prompt. Then run the
  Claude SDK sidecar tests, daemon Go tests, AgentGUI tests, and typechecks.
- References:
  [agent-activity-packages.md](../architecture/agent-activity-packages.md)
  [session_metadata.go](../../packages/agent/store-sqlite/session_metadata.go)
  [desktopAgentActivityAdapter.ts](../../apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.ts)
  [main.ts](../../packages/agent/claude-sdk-sidecar/src/main.ts)
  [main.test.ts](../../packages/agent/claude-sdk-sidecar/src/main.test.ts)
  [claude_sdk_adapter.go](../../packages/agent/daemon/runtime/claude_sdk_adapter.go)
  [compaction.ts](../../../packages/agent/claude-sdk-sidecar/src/compaction.ts)
  [messageRouter.ts](../../../packages/agent/claude-sdk-sidecar/src/messageRouter.ts)
  [sessionRuntime.session.test.ts](../../../packages/agent/claude-sdk-sidecar/src/sessionRuntime.session.test.ts)

### AgentActivity replication repeatedly rejects message batches as invalid

- Symptom:
  A downstream AgentActivity replica repeatedly returns `INVALID_ARGUMENT` for
  the same message batch. The source session has a higher `messageVersion`, but
  the destination has no messages or stops at an earlier version.
- Quick checks:
  Compare the session watermark with the current message rows. Values such as
  `1,3` or `1,5` are valid when an intermediate snapshot of the same
  `messageId` was overwritten. Check whether the destination requires
  `incomingVersion == maxStoredVersion + 1` or treats a message version as
  immutable identity.
- Root cause:
  `Message.Version` is a per-session change cursor on a mutable snapshot. Each
  accepted update advances the cursor, and updating the same `messageId`
  replaces its prior row. Current rows therefore need not contain every cursor
  value, and the same message identity legitimately moves to a higher version.
- Fix:
  Replicas must accept any positive version for a new message, accept a higher
  version for an existing `messageId`, and ignore or reject only stale lower
  versions. Use a version-guarded atomic upsert so concurrent stale snapshots
  cannot overwrite newer state. Do not add an event-history table merely to
  make the current snapshot appear contiguous.
- Validation:
  Record message A at v1, message B at v2, then update B to v3. Verify the
  current snapshot is `A@1,B@3`, `afterVersion=1` returns B at v3, and a
  rejected projection does not consume another cursor. Downstream replication
  coverage should also accept an initial v3, update it to v5, and preserve v5
  when v4 arrives later.
- References:
  [activity_messages.go](../../../packages/agent/store-sqlite/activity_messages.go)
  [activity_message_read.go](../../../packages/agent/store-sqlite/activity_message_read.go)
  [repository.go](../../../packages/agent/store-sqlite/repository.go)

### Goal clear stays planning and leaves the session running

- Symptom:
  Immediately clearing a newly set Goal leaves the first response in thinking,
  `/goal clear` in planning, or the conversation permanently running.
- Quick checks:
  Inspect the Goal control response: its Turn ID must be empty. List persisted
  Turns and verify no Turn was created solely for the clear action. Inspect the
  Goal state endpoint for `desired`, `observed`, `revision`, `syncStatus`, and
  `pendingOperationId`. For any real Goal Turn, verify `origin` and source Goal
  operation/revision are present.
- Root cause:
  The prompt path allocated a Turn ID before classifying `/goal`. Provider Goal
  control is session-level and did not start that Turn, but message persistence
  manufactured a row for the unknown ID. With no real `turn_started` or
  terminal event, loading and session-running projections never settled.
- Fix:
  Route Goal controls through the typed Goal API before Turn allocation. Persist
  desired/observed Goal state and an independent operation, reject messages that
  reference unknown Turns, and adopt only provider-started continuation Turns.
  Use durable origin and revision correlation so clear does not cancel unrelated
  user work and stale continuation timers cannot revive an older Goal.
- Validation:
  Set then immediately clear a Goal and assert that no control Turn exists, the
  operation reaches a terminal state, and the session has no phantom active
  Turn. Cover unknown-Turn message rejection, Claude goal-arm quiescing, Codex
  adopted continuation provenance, stale observation protection, and revision-
  guarded continuation nudges.
- References:
  [Agent Goal Control Design](../../specs/2026-07-15-agent-goal-control-design.md)
  [controller_exec.go](../../../packages/agent/daemon/runtime/controller_exec.go)
  [goal_state.go](../../../packages/agent/store-sqlite/goal_state.go)
