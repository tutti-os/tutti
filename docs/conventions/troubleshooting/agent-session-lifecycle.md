# Troubleshooting: Agent Sessions And Lifecycle

[Agent runtime index](./agent-runtime.md) · [All troubleshooting](./README.md)

Turn state, loading, cancel, restore, rail projection, event updates, imports, and performance.

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
  entry while the adapter lifecycle snapshot has already settled.
- Root cause:
  The controller's async turn registry is separate from adapter lifecycle
  projection. Async execution must clear `c.turns` when the owning adapter
  publishes a non-live `TurnLifecycleSnapshot`, even if the event type is not a
  terminal `turn.completed`/`turn.failed` event.
- Fix:
  Treat same-turn non-live lifecycle snapshots as async turn completion, in
  addition to terminal event types and steered prompt messages.
- Validation:
  Add controller coverage where an async adapter emits only a settled lifecycle
  snapshot for the turn and no terminal event, then verify a follow-up `Exec`
  no longer returns `ErrSessionActiveTurn`. Run
  `go test ./packages/agent/daemon/runtime`.
- References:
  [controller.go](../../../packages/agent/daemon/runtime/controller.go)
  [controller_test.go](../../../packages/agent/daemon/runtime/controller_test.go)

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
  back to `activeSessionState`. Keep guidance/steer as the explicit queue
  bypass path; ordinary composer sends while busy should queue. In the daemon,
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
  Always create the continuation grace timer for a settled goal-driven turn.
  After the grace window, re-read both the active turn and goal state; send the
  nudge only when no turn has continued and the goal is then `active`. Do not
  gate timer creation on the immediate local goal snapshot.
- Validation:
  Keep a scripted protocol test that deliberately delivers goal turn
  notifications before the `thread/goal/set` result, then verify the next turn
  is adopted. Cover both a clean first turn and a failed mid-goal turn with
  repeated focused runs; use event channels rather than polling shared slices.
- References:
  [codex_appserver_adapter.go](../../../packages/agent/daemon/runtime/codex_appserver_adapter.go)
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
  Imported Codex or Claude Code conversations with `cwd` equal to `$HOME` can
  show the same symptom even though the user never selected a project.
- Quick checks:
  Inspect the session `cwd` from the activity snapshot. Generated no-project
  sessions should resolve as no-project before `cwd` is matched against parent
  user-project paths. For imported sessions, inspect `runtimeContext` for the
  daemon-owned `externalImportNoProject` marker. Check both the in-memory
  `rememberNoProjectPath` path and the restart fallback that recognizes
  `Documents/tutti/session-<uuid>`. Codex external history can also record its
  own scratch cwd under `Documents/Codex/<yyyy-mm-dd>/<conversation>`.
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
  user-project prefix matching.
- Fix:
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
  `cd services/tuttid && go test ./service/agent ./api -run 'ExternalImport|ParseCodex|ParseClaude'`,
  `node --import ./test/register-asset-stub.mjs --test --experimental-strip-types ./src/renderer/src/features/workspace-user-project/services/internal/desktopWorkspaceUserProjectService.test.ts`
  from `apps/desktop`, then run `pnpm check:changed`.
- References:
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
