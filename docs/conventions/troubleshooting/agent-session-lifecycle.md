# Troubleshooting: Agent Sessions And Lifecycle

[Agent runtime index](./agent-runtime.md) · [All troubleshooting](./README.md)

Turn state, loading, cancel, restore, rail projection, event updates, imports, and performance.

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

### AgentGUI model switch changes defaults but not the active session

- Symptom:
  A user selects a different AgentGUI model, but the next provider call still
  uses the previous model. Logs may show
  `agent.gui.composer_defaults.remembered` for the new model while
  `workspace_agent_sessions.settings_json`, `runtimeContext.model`, or
  app-server `turn/start` still show the old model.
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
  empty, inspect the app-server adapter path.
- Root cause:
  AgentGUI has two distinct composer surfaces. The target home composer writes
  remembered defaults and node drafts. An active conversation composer must
  additionally call `updateSessionSettings`; Codex app-server providers then
  apply model changes as per-turn overrides on the next `turn/start`, not to an
  already-running turn. If the daemon applies the settings but the update
  response still reports the old model, check the service merge path:
  `serviceSessionWithPersistedFreshness` must not let a newer activity
  projection snapshot overwrite live runtime settings after an explicit
  settings update.
- Fix:
  Preserve the default-draft path, but make active-session model changes
  observable at every layer. Do not conclude that a provider ignored the model
  until the logs show the active session settings update reached the daemon and
  the following `turn/start` carried the requested model.
- Validation:
  Reproduce by switching a model in a running session and sending a follow-up.
  Confirm the logs include the update chain above and that
  `workspace.agent_session.settings.update_completed` reports the requested
  model and the next `turn/start` carries it. If the persisted
  `workspace_agent_sessions.settings_json.model` is older while the runtime is
  live, `Get` responses should still expose live runtime settings instead of
  the stale projection value.
- References:
  [useAgentGUINodeController.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts)
  [createDesktopAgentActivityRuntime.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.ts)
  [workspaceAgentActivityService.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.ts)
  [service_session.go](../../../services/tuttid/service/agent/service_session.go)
  [controller.go](../../../packages/agent/daemon/runtime/controller.go)
  [codex_appserver_adapter.go](../../../packages/agent/daemon/runtime/codex_appserver_adapter.go)

### Agent GUI provider tab shows fused or stale conversations

- Symptom:
  Switching the Agent GUI aggregation rail between All, Cursor, Codex, or Claude
  leaves the middle list and right detail panel out of sync. A provider tab can
  still show other providers' sessions, or the right panel keeps the previous
  agent after the middle list already changed.
- Quick checks:
  Inspect `workspace_agent_sessions.agent_target_id` for legacy Cursor rows. Old
  Cursor imports may be missing `agent_target_id` while still carrying
  `provider=cursor`. Confirm the active `conversationFilter` in the controller
  and the per-query `agentGuiConversationListStore` projection for the selected
  `local:<provider>` target.
- Root cause:
  Conversation retention in `agentGuiConversationListStore` previously kept
  every targetless session under any agent-target tab. The rail also merged
  unfiltered store conversations into runtime sections, and filter switches did
  not always re-project the shared list or clear an active conversation outside
  the new filter.
- Fix:
  Match agent-target tabs with `matchesAgentGUIConversationSummaryFilter`, using
  `session.provider` as a fallback for legacy `local:<provider>` targets.
  Backfill Cursor `agent_target_id` in daemon storage, re-project the list store
  when `conversationFilter` changes, filter rail merges in `AgentGUINodeView`,
  and open the selected target home composer when the active conversation no
  longer matches the tab.
- Validation:
  Run
  `pnpm --dir packages/agent/gui exec vitest run --environment jsdom agent-gui/agentGuiNode/model/agentGuiConversationFilter.spec.ts contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore.spec.ts agent-gui/agentGuiNode/controller/useAgentGUINodeController.spec.tsx -t "opens the selected target home composer when the active conversation is outside the new rail filter"`,
  then `cd services/tuttid && go test ./data/workspace/...`.
- References:
  [agentGuiConversationFilter.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/model/agentGuiConversationFilter.ts)
  [agentGuiConversationListStore.ts](../../../packages/agent/gui/contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore.ts)
  [useAgentGUINodeController.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts)
  [AgentGUINodeView.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/AgentGUINodeView.tsx)
  [agent_store.go](../../../services/tuttid/data/workspace/agent_store.go)

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
  Conversation project grouping is a view-model join of `cwd x userProjects`.
  If a generated no-project cwd is not recognized before prefix/parent project
  matching, the longest-parent project match can assign the session to a broad
  project such as `$HOME`. Keep generated-path recognition in the host
  `isNoProjectPath` callback because it has the user home-directory context;
  a package-level suffix check would misclassify real projects that contain a
  `Documents/tutti/session-<uuid>` subdirectory. External import has a similar
  trap because provider transcripts may record `$HOME` or a provider-owned
  scratch working directory as the cwd when no project was selected; that intent
  must be persisted as session metadata rather than inferred later from
  user-project prefix matching. A second loss point is runtime state projection:
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
  assignment from the current user-project list during read pagination; keep
  existing rail fields stable when a session's final cwd has not changed.
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

### Claude Code cancel leaves Write/tool cards stuck in progress

- Symptom:
  User stops a Claude Code turn while a tool such as Write is running. The turn
  settles as canceled/interrupted, but the transcript still shows the tool as
  in progress.
- Quick checks:
  Compare durable tool-call message status with turn outcome. If the turn is
  interrupted/canceled and the open `tool_call` is still `running`, the Claude
  SDK turn lifecycle did not finish dangling calls. Confirm Codex/ACP cancel of
  the same shape closes open tools via `acpTurnNormalizer.FinishInterrupted`.
- Root cause:
  Claude Code SDK projected tool events without owning the shared turn event
  lifecycle (`acpTurnNormalizer`). Cancel and sidecar `turn_canceled` settled
  the turn without `Finish*`, so open tools never received a terminal
  `call.failed`.
- Fix:
  Attach per-turn `acpTurnNormalizer` on the Claude SDK session. Track
  `call.started/completed/failed` against that normalizer, and call
  `FinishInterrupted` / `FinishFailed` / `FinishCompleted` as part of turn
  terminalization (`Cancel`, sidecar `turn_*`, reader failure). Drop late tool
  events after the turn is already settled.
  Also: controller Cancel cancels the Exec context before `adapter.Cancel`.
  Claude Exec unregisters its waiter on that context cancel, so Cancel must
  finish open tools from the turn-normalizer map (not only live waiters), and
  the Exec context-canceled path must retain CallFailed events instead of
  replacing the whole event slice with a bare turn.canceled.
- Validation:
  `go test ./packages/agent/daemon/runtime -run 'TestClaudeCodeSDKAdapter(CancelFailsOpenToolCalls|CancelFailsOpenToolsAfterWaiterUnregistered|TurnCanceledFailsOpenToolCalls)'`.
  Manually: start a long Write on Claude Code, press Stop, confirm the tool
  card leaves "in progress". Rebuild/restart desktop so the running `tuttid`
  binary includes the fix.
- References:
  [claude_sdk_turn.go](../../../packages/agent/daemon/runtime/claude_sdk_turn.go)
  [claude_sdk_events.go](../../../packages/agent/daemon/runtime/claude_sdk_events.go)
  [claude_sdk_execution.go](../../../packages/agent/daemon/runtime/claude_sdk_execution.go)
  [controller_turn_exec.go](../../../packages/agent/daemon/runtime/controller_turn_exec.go)
  [acp_turn_normalizer.go](../../../packages/agent/daemon/runtime/acp_turn_normalizer.go)

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
  the prior 1M total after a model switch.
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
  window across models.
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
  daemon normalization falls back to 200k.
- Fix:
  Define usage in the protocol-v2 OpenAPI contract and carry it as typed durable
  session metadata through the generated client, desktop adapter, canonical
  activity session, and composer projection. Keep raw runtime context private
  to provider recovery; do not restore a GUI runtime-context dependency.
  Parse `modelUsage` recursively as both arrays and maps before using fallback
  context-window values. Track the model associated with a cached context
  window, and only reuse the previous total for the same model or when the model
  is unknown. Do not hard-code alias-to-model mappings in Tutti.
- Validation:
  Cover runtime-context splitting and metadata persistence, generated API
  projection, desktop canonical-session adaptation, activity-core usage
  resolution, and the composer hook.
  Add sidecar and daemon coverage with map-shaped `modelUsage` carrying
  `contextWindow: 1_000_000`, plus daemon coverage for Haiku -> Sonnet5 -> Haiku
  usage updates where the last payload lacks `totalTokens`. Then run the Claude
  SDK sidecar tests, daemon Go tests, AgentGUI tests, and typechecks.
- References:
  [agent-activity-packages.md](../architecture/agent-activity-packages.md)
  [session_metadata.go](../../packages/agent/store-sqlite/session_metadata.go)
  [desktopAgentActivityAdapter.ts](../../apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.ts)
  [main.ts](../../packages/agent/claude-sdk-sidecar/src/main.ts)
  [main.test.ts](../../packages/agent/claude-sdk-sidecar/src/main.test.ts)
  [claude_sdk_adapter.go](../../packages/agent/daemon/runtime/claude_sdk_adapter.go)
