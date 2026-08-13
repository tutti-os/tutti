# Troubleshooting: Agent Sessions And Lifecycle

[Agent runtime index](./agent-runtime.md) · [All troubleshooting](./README.md)

### Claude cancellation reaches `context deadline exceeded`

- **Symptom:** Canceling a Claude Code Turn, closing its Session, or leaving a
  room waits until the caller deadline and reports `context deadline exceeded`.
  Repeating the action leaves the same Turn active.
- **Quick checks:** Filter daemon logs by `CLAUDE_CODE_CANCEL_DIAGNOSTIC`, then
  group by `requestId`, `agentSessionId`, `turnId`, and `generationId`. Compare
  `interrupt_started` with `interrupt_succeeded`, `interrupt_timed_out`, or
  `interrupt_failed`; then require `query_close_succeeded` and either
  `consumption_settled` or `consumption_timed_out`. The payload deliberately
  excludes prompts, tool inputs, credentials, and provider output.
- **Root cause:** The SDK interrupt is a control request whose Promise has no
  native timeout. A wedged Claude Code process may never return its control
  response. A caller-side Go deadline only stops the RPC waiter and cannot
  terminate that Promise or the provider process.
- **Fix:** Treat cancellation as a Query-lifecycle protocol. Revoke the exact
  generation, bound cooperative interrupt, close the owned SDK transport when
  ACK is missing or fails, and separately bound consumer drain before settling
  canonical Turns. Do not increase only the outer RPC timeout.
- **Validation:** Cover an interrupt Promise that never settles, immediate
  interrupt rejection, and a consumer Promise that never drains. The first two
  must close transport and cancel the Turn; the last must return an explicit
  bounded failure.
- **References:**
  [queryGeneration.ts](../../../packages/agent/claude-sdk-sidecar/src/queryGeneration.ts),
  [sessionRuntime.ts](../../../packages/agent/claude-sdk-sidecar/src/sessionRuntime.ts),
  [claude_sdk_execution.go](../../../packages/agent/daemon/runtime/claude_sdk_execution.go)

### Claude Goal stays active after the model becomes idle

- **Symptom:** Claude has stopped producing output and the Session becomes
  idle, but the Goal banner remains active indefinitely. The elapsed time may
  also reset after leaving and reopening the workspace.
- **Quick checks:** Inspect sidecar events and the root Claude transcript. A
  failed evaluator has an active `active_goal` or `goal_status.met=false`, a
  root `session_state_changed(state=idle)`, and no later
  `goal_status.met=true`.
- **Root cause:** Claude's SDK stream may omit top-level `goal_status`
  attachments. A native evaluator timeout can then reach idle without a
  terminal verdict. Separately, a timer based on React mount time cannot
  survive workspace navigation.
- **Fix:** Tail only new root transcript rows, drain once more at provider idle,
  and transition a still-active Goal to canonical `blocked`. Persist one
  `startedAtUnixMs` per Goal generation and derive active elapsed time from it.
- **Validation:** Cover both boundaries: terminal transcript evidence written
  immediately before idle must win, while idle without terminal evidence must
  emit `blocked`. Unmount and remount the Goal banner with the same canonical
  start and require the elapsed value not to reset.
- **References:**
  [goalProjection.ts](../../../packages/agent/claude-sdk-sidecar/src/goalProjection.ts),
  [messageRouter.ts](../../../packages/agent/claude-sdk-sidecar/src/messageRouter.ts),
  [AgentGoalBanner.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/AgentGoalBanner.tsx)

### Older extension session fails because its launch identity is incomplete

- **Symptom:** Sending a new message to a previously created extension session
  fails with `session runtime snapshot is unavailable: launch identity is
incomplete`, while a newly created session can still launch.
- **Quick checks:** Compare the persisted Session provider with
  `internal_runtime_context.sessionRuntimeSnapshot.provider`. The historical
  defect has an open extension provider such as `acp:kimi-code` on the Session,
  an empty provider in the snapshot, and a provider-native fingerprint produced
  with the same empty provider. An intermediate build may retain the provider
  field while still carrying that legacy empty-provider fingerprint.
- **Root cause:** Registered-only provider normalization was used when writing
  the snapshot and its provider-native model fingerprint. Extension-owned ACP
  provider IDs were therefore collapsed to empty even though the durable
  Session retained the correct provider.
- **Fix:** Persist and fingerprint provider-native configurations with open
  provider normalization. For existing records, recover only when the Session
  carries a valid extension-owned provider and the snapshot exactly matches the
  legacy empty-provider fingerprint; keep malformed, registered-provider, plan,
  and fingerprint-mismatched snapshots fail-closed.
- **Validation:** Prove a newly written extension snapshot binds its provider,
  the exact historical shape resumes through its current enabled Agent Target,
  a strict context-only read still rejects the incomplete identity, and altered
  fingerprints or registered-provider fallbacks remain unavailable.
- **References:**
  [session_runtime_snapshot.go](../../../services/tuttid/service/agent/session_runtime_snapshot.go),
  [model_plan_binding.go](../../../services/tuttid/service/agent/model_plan_binding.go)

### Initial Goal session remains unnamed

- Symptom:
  A new session created from `/goal <objective>` keeps an empty canonical title
  and the UI shows the localized unnamed-conversation label after the optimistic
  activation disappears.
- Quick checks:
  Read `workspace_agent_sessions.title` and the first
  `workspace_agent_messages` row. The affected shape has `kind=session_audit`,
  `role=user`, `goalControl=true`, and no normal text Turn.
- Root cause:
  Typed initial Goal intentionally skips the ordinary initial Turn. Title
  derivation existed only in the normal initial-content `Exec` path, so the
  session was persisted without a title even though the Goal audit contained the
  submitted command.
- Fix:
  Derive the title in Host before provider startup from `InitialDisplayPrompt`;
  when that field is absent, synthesize `/goal <objective>` or `/goal <action>`.
  Mark the derived title established so later runtime state cannot replace it.
- Validation:
  Run the shared initial-Goal conformance scenario through both direct Host and
  service-adapter drivers. Assert the returned canonical title and verify the
  zero-Turn Goal operation still replays without a second provider startup.
- References:
  [packages/agent/host/README.md](../../../packages/agent/host/README.md)
  [lifecycle.go](../../../packages/agent/host/lifecycle.go)
  [session_lifecycle_scenarios.go](../../../packages/agent/host/conformance/session_lifecycle_scenarios.go)

### Goal-control row has no copy action

- Symptom:
  A visible `/goal ...` user bubble has no copy button on hover, while ordinary
  user text bubbles have one.
- Quick checks:
  Inspect the row kind. `goal-control` renders through `AgentGoalControlRow`,
  not `AgentMessageBlock`; search direct `AgentRichTextReadonly` uses for a
  renderer that bypasses `AgentCopyableMessageGroup`.
- Root cause:
  The special row reused the read-only rich-text renderer but not the shared
  message action wrapper.
- Fix:
  Wrap the row in `AgentCopyableMessageGroup` and write through the host
  clipboard, with the browser clipboard as the renderer fallback.
- Validation:
  Render a durable goal-control row, hover it, assert the copy button exists,
  click it, and verify the exact command body is written.
- References:
  [AgentGoalControlRow.tsx](../../../packages/agent/gui/shared/agentConversation/components/AgentGoalControlRow.tsx)
  [AgentMessageActions.tsx](../../../packages/agent/gui/shared/agentConversation/components/AgentMessageActions.tsx)

### Replay startup reports only `building isolated tuttid`

- **Symptom:** Replay fails before the isolated Workspace becomes ready, but
  the toast shows only the runner's first progress line instead of the daemon
  startup failure.
- **Quick checks:** Inspect the managed Replay failure status. New builds store
  `errorCause.code` and `errorCause.message`; the outer `errorMessage` remains
  the supervision summary.
- **Root cause:** The former UI formatter selected the first line from one
  combined process-log string. The actionable daemon stderr appeared on a
  later line and was discarded.
- **Fix:** Preserve daemon startup stderr as a structured `{code, message}`
  cause across Desktop startup, the Replay runner event, and primary Desktop
  status. Render the structured cause before the outer summary.
- **Validation:** Make isolated `tuttid` reject a Cassette during startup and
  require the toast to show the daemon rejection while logs retain both the
  outer startup error and structured cause.

### Replay Workspace stays on the starting toast

- **Symptom:** The source Desktop keeps showing the Replay Workspace starting
  toast. The isolated Desktop may appear only after the daemon startup timeout.
- **Quick checks:** Inspect the isolated runtime under
  `.tmp/agent-session-replay-workspace-*`. The listener must appear at
  `state/run/tuttid.listener.json`; inspect `logs/desktop.log` and the managed
  child output before debugging renderer readiness.
- **Root cause:** The runner waited for the obsolete
  `state/cassette/tuttid.listener.json` path after the daemon moved its listener
  metadata into the canonical runtime `run` directory.
- **Fix:** Resolve Replay daemon discovery through
  `state/run/tuttid.listener.json`, matching every other managed daemon
  consumer. Keep the path in one runner helper and cover it directly.
- **Validation:** Launch a managed Replay Workspace and prove its isolated
  daemon becomes discoverable without waiting for the startup timeout.

### Replay fails because Desktop and tuttid use different event catalogs

- **Symptom:** Replay stops during Desktop startup with
  `desktop/tuttid event stream catalog mismatch (fail-fast)`, or the isolated
  Desktop log contains `Event stream catalog revision mismatch`.
- **Quick checks:** Compare the revisions reported by the runner for the
  prepared `apps/desktop/out` bundle, the event-protocol source, and the
  `tuttid` binary. A prepared Electron bundle can be stale even when the
  current source checkout and daemon build match.
- **Root cause:** The Desktop renderer and daemon perform a strict event-stream
  catalog handshake. Reusing a prepared renderer or daemon from a different
  generated-protocol revision makes the handshake fail before Replay can drive
  a Session.
- **Fix:** For an unmanaged launch, the runner falls back to
  `pnpm-dev-desktop` when the current event-protocol source matches `tuttid`.
  For a managed launch, rebuild `apps/desktop/out` and `tuttid` from the same
  checkout, or clear the prepared Electron environment before retrying.
- **Validation:** Confirm the runner reports matching revisions before launch,
  then run the Replay scenario and require the first checkpoint to become
  ready without a catalog mismatch in `desktop.log`.
- **References:**
  [event-stream-catalog.mjs](../../../tools/scripts/agent-session-replay-runner/event-stream-catalog.mjs),
  [agent-session-replay.md](../../../docs/architecture/agent-session-replay.md)

### Replay starts but the first Turn never becomes idle

- **Symptom:** The isolated Replay Workspace is ready, but playback waits on the
  first Session until transport verification reports unconsumed connections.
- **Quick checks:** Query the Cassette-scoped transport playback state and
  verification endpoint. If the provider tape still has outbound frames while
  the current UI no longer emits the recorded probe sequence, the Cassette is
  incompatible with the current strict transport contract.
- **Root cause:** Session Replay intentionally validates provider traffic in
  order. Benign-looking UI probe or request-order changes can therefore make an
  older Cassette unable to reach its recorded completion frame.
- **Fix:** Record a new Cassette with the current architecture. Do not weaken
  transport ordering or add a compatibility fallback unless the product
  contract explicitly changes.
- **Validation:** The new Cassette must consume every recorded provider
  connection, reach the expected stable checkpoints, and pass final transport
  verification.

### Replay checkpoint waits forever with `observation:null` while the session detail is visible

- **Symptom:** Replay playback dispatches intents and streams provider frames
  normally, but a checkpoint wait stalls on
  `{"ready":false,"observation":null,"hasDetail":true}` and the coordinator
  binding reports `mounted:true, selectedAgentSessionId:null,
detailHydrated:false`.
- **Quick checks:** Enumerate `[data-workbench-window-id]` elements over CDP.
  If two AgentGUI nodes exist — one showing the replayed session and one empty —
  the cassette binding is attached to the wrong node.
- **Root cause:** Something launched an AgentGUI surface before the Replay
  Workspace bootstrap (for example a dock-launch preparation step). The replay
  driver then interacts with the pre-launched node through the DOM while the
  canonical-observation binding waits on the coordinator-launched node, which
  never selects a session.
- **Fix:** In replay mode, never open AgentGUI surfaces outside
  `bridge.bootstrap`. The coordinator-launched node must be the only AgentGUI
  node; the runner waits for its composer after bootstrap instead of
  dock-launching first.
- **Validation:** During replay, exactly one AgentGUI node exists, its binding
  reports the selected session, and the checkpoint wait resolves within the
  recorded timing.

### Replay fails because a recorded SQLite column does not exist

- **Symptom:** Replay startup fails with an error such as
  `table tutti_mode_turn_snapshots has no column named speed`.
- **Quick checks:** Confirm the Cassette schema. Schema v5 contains
  `initial-state.json`/`expected-state.json`; it never contains table rows or
  SQL column names.
- **Root cause:** An obsolete row-fixture experiment recorded `SELECT *`
  output from a database migrated by a different checkout. Import coupled
  Replay to that checkout's physical SQLite schema.
- **Fix:** Re-record with the current schema. Do not add column projection, a
  legacy reader, or a migration fallback. The daemon restores typed semantic
  state before Host recovery.
- **Validation:** Add or reorder an unrelated SQLite column and prove semantic
  capture bytes and Replay behavior are unchanged.

### Managed Replay leaves an orphan Desktop that crashes with `EPIPE`

- **Symptom:** Closing or replacing a managed Replay run leaves an isolated
  Electron process behind. It later shows an Electron main-process JavaScript
  error with `Error: write EPIPE` from the desktop log sink.
- **Quick checks:** Inspect the Electron process parent PID and open files.
  `PPID=1`, a Replay workspace log under
  `.tmp/agent-session-replay-workspace-*`, and disconnected stdout/stderr
  identify an orphaned managed Replay process. Map the built stack location
  back to `apps/desktop/src/main/logging.ts` before attributing the crash to
  cassette data or renderer code.
- **Root cause:** The multi-cassette managed Replay path launched a detached
  Desktop with piped output but did not bind the existing managed shutdown
  lifecycle. When the owner exited, Electron and its managed daemon survived
  while their output pipe had no reader. A later log write emitted an
  unhandled `EPIPE`.
- **Fix:** Bind every managed Replay Desktop to the original owner PID and stop
  its process tree when that owner disappears or its output pipe breaks. Treat
  desktop and forwarded daemon console output as best effort so a closed
  diagnostic pipe cannot crash the Electron main process.
- **Validation:** Prove the shutdown binding stops Desktop once when the owner
  is gone, coalesces a concurrent `EPIPE`, and removes its listeners on
  disposal. Exercise the process log sink with a writable stream that emits
  `EPIPE`, then verify later writes are ignored without an uncaught exception.
- **References:**
  [run-agent-session-replay.mjs](../../../tools/scripts/run-agent-session-replay.mjs),
  [logging.ts](../../../apps/desktop/src/main/logging.ts),
  [tuttidManager.ts](../../../apps/desktop/src/main/daemon/tuttidManager.ts)

### Replay shows the user prompt but never releases assistant output

- **Symptom:** Replay creates the Session and persists the user prompt, but the
  provider tape stops before `turn/started` or assistant notifications.
- **Quick checks:** Compare the next outbound provider frame with daemon RPC
  logs. If the tape expects `thread/read` or `thread/goal/get`, check whether
  that observer query was issued in this renderer lifecycle. Also compare
  recorded and replay JSON-RPC request IDs separately from method and params.
- **Root cause:** Observer-only provider queries and their auxiliary probe
  connections are timing-dependent. Treating them as causal byte-stream frames
  deadlocks replay when the current renderer observes at a different moment.
  Earlier skipped queries can also shift later request IDs.
- **Fix:** Keep causal method/params matching strict, map recorded request IDs
  to replay request IDs, and allow only the declared observer RPCs and
  query-only auxiliary connections to be absent. Suppress only their paired
  responses; preserve interleaved provider notifications. If a causal
  provider response arrives while replay is waiting briefly for a declared
  observer RPC, skip that observer immediately and match the causal response
  against the next recorded frame.
- **Validation:** Replay a real three-Turn Cassette through a fresh Replay
  Workspace, verify every checkpoint and assistant response, require transport
  exhaustion, and compare final durable state.

### One hung provider startup blocks unrelated Agent sessions

- **Symptom:** One provider process starts but never reaches runtime-ready, then
  new or resumed Sessions for other providers also wait without starting their
  own provider processes.
- **Quick checks:** Order `agent_session.process.start.sent` with Host
  `runtime_started` and `runtime_session_ready` lifecycle steps. If later,
  unrelated Sessions accumulate wait time before their own process-start event,
  inspect Controller startup-lock ownership separately from the provider that
  first stopped making progress.
- **Root cause:** The runtime Controller held one process-wide `startMu` across
  `Adapter.Start` and `Adapter.Resume`. A slow or unbounded provider handshake
  therefore formed a lock convoy across every room, Session, and provider.
- **Fix:** Serialize explicit startup requests by `(roomID, agentSessionID)`.
  Keep the legacy no-ID start path idempotent with a narrower room-and-provider
  key, and let startup-lock waiters return when their context is canceled.
  Provider credential coordination remains a separate Host gate.
- **Validation:** Block each of `Start` and `Resume` for one provider and prove
  both operations still complete for an independent provider. Also verify all
  same-Session combinations remain serialized, anonymous start replay reuses
  one Session, canceled waiters release their lock references, and repeated
  shuffled race runs stay clean.
- **References:**
  [controller_session_lifecycle.go](../../../packages/agent/daemon/runtime/controller_session_lifecycle.go),
  [controller_test.go](../../../packages/agent/daemon/runtime/controller_test.go)

### A shared-device connection banner looks terminal while the host is still retrying

- **Symptom:** AgentGUI keeps showing a strong connection-lost notice for a
  shared device, so the user cannot tell whether recovery is still running.
- **Quick checks:** Inspect host logs for
  `shared-agent-query.caller.connection.retry`,
  `shared-agent-query.caller.connection.dormant`, and
  `shared-agent-query.caller.connection.dormant-summary`. Correlate them with
  `desktop.device_link.diagnostic` when distinguishing direct, rendezvous, and
  relay transport attempts. A dormant state means the host has moved from
  short retry delays to low-frequency recovery; it is not a terminal failure.
- **Root cause:** The query channel correctly blocked runtime-dependent
  commands, but its recoverable unavailable state was projected directly as a
  terminal target-connection error. The target event also omitted retry
  progress, so an unchanged banner made periodic recovery invisible.
- **Fix:** Keep Session runtime availability as the command-safety gate.
  Separately project target-scoped connection status with a retry attempt.
  Present recoverable unavailable states as neutral reconnecting progress,
  reserve the strong unavailable notice for explicitly non-retryable failures,
  and remove the notice silently after recovery.
- **Validation:** Force the query channel into dormant recovery and verify each
  failed probe increments the target retry attempt while the composer remains
  blocked. Confirm the reconnecting notice updates without restarting its
  visibility delay, a non-retryable failure is still immediate, and recovery
  produces no success banner.
- **References:**
  [agent-gui-node.md](../../architecture/agent-gui-node.md)

### Deleting an Agent Session leaves a Tutti plan active or emits duplicate removal events

- **Symptom:** Deleting one Session removes the conversation but its pending
  Tutti Mode Plan remains visible, or clients receive duplicate/missing
  `session_deleted` and `workspace.workflow.updated` invalidations. A workspace
  clear may leave orphan workflows in an active state.
- **Quick checks:** Confirm production wiring assigns the Tutti Mode Plan
  service as the Agent service's source-session deletion coordinator. Inspect
  the transaction result for the complete removed Session closure and affected
  workflow/current-checkpoint identities. Verify workflow events are published
  only after the transaction returns and that the activity projection is not
  also running its persistence deleter on the coordinator path.
- **Root cause:** Session persistence, activation cleanup, and workflow
  cancellation form one cross-aggregate use case. Letting
  `data/workspace` choose cancellable states hides business policy in the data
  layer and cannot publish the canonical post-commit workflow event. Calling a
  service coordinator and the legacy projection deleter together instead
  splits the transaction and duplicates `session_deleted` events.
- **Fix:** Keep cancellation policy in `service/tuttimodeplan`: allowed source
  states, canceled targets, actor, reason, and timestamp are all explicit. Pass
  one command to the workspace store so Session closure, Tutti activation/Turn
  snapshots, and workflow transitions commit or roll back together. Return
  affected identities, then publish workflow and Session invalidations from
  the respective services after commit. Reserve persistence-only deletion and
  standalone activation cleanup for isolated tests or legacy orphan fallback.
- **Validation:** Force the workflow update to fail and assert the Session and
  activation still exist. Cover single, descendant batch, runtime-only, and
  workspace-clear scopes; exact cancellation-state selection; no event on
  rollback; one workflow event per reported change; and one
  `session_deleted` event per unique removed Session.
- **References:**
  [workspace-workflows.md](../../architecture/workspace-workflows.md),
  [source_session_deletion.go](../../../services/tuttid/service/tuttimodeplan/source_session_deletion.go),
  [source_session_deletion.go](../../../services/tuttid/data/workspace/source_session_deletion.go)

### Tutti badge is active but no Tutti Mode Plan panel opens

- **Symptom:** The composer shows the Tutti badge and the Agent may even emit a
  provider-native Plan, but no Tutti Mode Plan review panel appears.
- **Quick checks:** Read
  `GET /v1/workspaces/{workspaceID}/agent-sessions/{agentSessionID}/tutti-mode-activation`
  and confirm the current revision is active. Then inspect whether the Agent
  actually invoked `tutti plan propose` with a valid absolute Markdown file
  and Agent Session context. Query
  `GET /v1/workspaces/{workspaceID}/workflows?sourceSessionId=...` for a pending
  authoritative snapshot. Do not inspect transcript markers or provider Plan
  card or historical `capabilityRefs` as current activation or workflow
  evidence.
- **Root cause:** `TuttiModeActivation` and `WorkspaceWorkflow` are independent
  Tutti-owned roots. The badge records a user preference that is snapshotted
  into each new Turn's Host Context; it does not fabricate a proposal. Durable
  review state begins only when the Agent invokes the always-available Tutti
  CLI and commits a `WorkspaceWorkflow`, immutable revision, and pending
  checkpoint. A missing CLI invocation, invalid `tutti-mode-plan/v1` document,
  wrong source Session, or disconnected desktop workflow runtime leaves
  nothing recoverable to render.
- **Fix:** Keep `/plan` and `/tutti` as compatible independent modifiers. Let
  AgentSessionEngine project the daemon activation and let the Agent freely
  invoke the Tutti CLI. AgentGUI must list workflows by active source Session
  and re-pull after `workspace.workflow.updated`; it must never synthesize a
  panel from Agent text, a provider Plan card, the Tutti badge, or capability
  audit records. User decisions go only through the checkpoint HTTP endpoint.
- **Validation:** Cover activation create/update/reload, immutable per-Turn
  snapshot binding before provider dispatch, CLI proposal persistence,
  immutable revision verification, Session-scoped list recovery,
  advisory-event refresh, accept/reject/cancel decisions, and Plan plus Tutti
  badge coexistence. Verify an accepted task graph materializes exactly one
  Issue and reports `issue_created` rather than asking the Agent to create it
  again.
- **References:**
  [workspace-workflows.md](../../architecture/workspace-workflows.md),
  [commands.go](../../../services/tuttid/service/cli/providers/tuttimodeplan/commands.go),
  [useTuttiModePlanPanels.ts](../../../packages/agent/gui/workspaceWorkflow/tuttiModePlan/useTuttiModePlanPanels.ts)

### Existing Session shows Tutti active but the Agent reports Default mode

- **Symptom:** Tutti Mode is enabled on an already-existing Session, but the
  next Turn says the conversation is still in provider Default mode or has not
  entered Tutti Mode because `plan propose` has not run.
- **Quick checks:** Confirm the activation revision is active in the exported
  Session or activation endpoint, then confirm the affected Turn owns an active
  `TuttiModeTurnSnapshot`. For Codex, inspect that Turn's provider rollout
  `turn_context`: the collaboration mode may legitimately remain `default`,
  while its developer instructions must contain `<tutti-host-context>` with
  `"state":"active"`. If both facts are present, existing-Session snapshot
  delivery works and the response is an interpretation failure. If the host
  context is absent, trace snapshot preparation and runtime dispatch instead.
- **Root cause:** Tutti activation, provider Default/Plan collaboration mode,
  and Tutti workflow existence are three independent facts. An instruction
  that says a workflow exists only after `plan propose` can make a provider
  incorrectly use the missing workflow as evidence that activation is
  inactive, even though the active snapshot reached the reused provider
  Session.
- **Fix:** Make the Host Context's snapshot state the sole authority for
  reporting Tutti Mode status. Provider Default/Plan mode and workflow
  existence remain independent facts and cannot override it. A clear plan
  request must still run `plan propose` instead of returning a chat-only plan.
- **Validation:** On an existing Session, activate Tutti Mode and send a new
  Turn while the provider collaboration mode remains Default. Verify the
  provider receives the active Host Context, a status-only question reports
  active without proposing a workflow, and a clear plan-generation request
  invokes `plan propose`. Repeat with an inactive revision and verify it
  reports inactive.
- **References:**
  [workspace-workflows.md](../../architecture/workspace-workflows.md),
  [tutti_mode_host_context.go](../../../packages/agent/daemon/runtime/tutti_mode_host_context.go),
  [tutti_mode_host_context_test.go](../../../packages/agent/daemon/runtime/tutti_mode_host_context_test.go)

### Tutti Mode Plan stops loading after a task-graph revision

- **Symptom:** The configuration review panel works and `tutti plan revise`
  returns a pending task-review checkpoint, but AgentGUI replaces the panel
  with its load-failure state.
- **Quick checks:** Call the session-scoped workspace-workflow list endpoint
  and inspect every task in the returned revision. Required collection fields,
  especially `dependsOn`, must be JSON arrays even when empty. A successful
  CLI mutation and HTTP `200` do not prove that the response still satisfies
  the generated client contract.
- **Root cause:** A Go transport projection copied an empty dependency slice
  onto a nil slice. `encoding/json` emitted `null`, violating the non-nullable
  OpenAPI array contract. The generated TypeScript client therefore exposed a
  value typed as `string[]` whose runtime value was `null`, and the desktop
  adapter failed while cloning it before panel projection.
- **Fix:** Normalize required collections at the daemon API boundary so empty
  values serialize as `[]`. Keep the OpenAPI field non-nullable and do not move
  the repair into AgentGUI business projection, where it would only conceal a
  malformed wire response.
- **Validation:** Exercise the real HTTP route, decode its JSON, and assert an
  empty task dependency list is exactly `[]`, not `null`. Then verify a
  task-graph revision with a root task can be listed and rendered.
- **References:**
  [workspace-workflows.md](../../architecture/workspace-workflows.md),
  [daemon_workspace_workflows.go](../../../services/tuttid/api/daemon_workspace_workflows.go),
  [desktopWorkspaceWorkflowRuntime.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/desktopWorkspaceWorkflowRuntime.ts)

### Retrying a Tutti Mode Plan mutation duplicates or rejects the revision

- **Symptom:** A retry after a CLI timeout creates another workflow/revision,
  or intentionally submitting the same Markdown again with a new request ID
  fails with a revision/document-path uniqueness error.
- **Quick checks:** Confirm `plan propose` or `plan revise` received a stable
  `--request-id`. Read `workspace_workflow_mutations` for the exact workspace,
  source Session, mutation kind, workflow scope, and request ID. Compare its
  `input_sha256` and committed result IDs. For upgraded local databases, check
  that `workspace_workflow_plan_revisions` no longer has a unique index on
  `document_path`.
- **Root cause:** Transport response loss is not the same as repeated content.
  Without a caller mutation key, the daemon cannot distinguish a retry from
  intentional reapplication. Conversely, a content-addressed document path may
  legitimately be shared by multiple immutable revision metadata rows, so it
  cannot be revision identity.
- **Fix:** Reuse the same request ID only for a retry of the same bytes. Use a
  new request ID for an intentional mutation, even when the bytes are equal.
  Keep the ledger claim and workflow/revision/checkpoint write in one SQLite
  transaction. Preserve revision-ID and sequence uniqueness, and let the
  corrective migration remove legacy document-path uniqueness.
- **Validation:** Cover concurrent same-key claims, same key plus same digest
  replay, same key plus different digest conflict, new key plus identical bytes
  creating the next sequence, and upgrade fixtures that retain checkpoints,
  operations, mutations, and a clean `PRAGMA foreign_key_check`.

### One corrupt Tutti Mode Plan prevents daemon startup recovery

- **Symptom:** The daemon cannot finish startup after a task graph was accepted,
  especially when its immutable Markdown file is missing or corrupt and its
  `create_issue` operation is pending or failed.
- **Quick checks:** Inspect accepted workflows with pending/failed
  `create_issue` operations, verify the referenced revision path and SHA-256,
  and check whether the operation received a durable
  `startup_recovery_failed` outcome. Do not require an Agent `wait` call to
  start recovery.
- **Root cause:** Returning the first operation-local read, parse, validation,
  or materialization error from the startup scan makes one damaged workflow a
  process-wide availability failure.
- **Fix:** Run one recovery scan after workflow and Issue service composition
  but before exposing the daemon. Isolate each operation: persist a failed
  outcome and continue. Abort startup only when the scan fails or the daemon
  cannot write a durable outcome. Keep deterministic Issue materialization and
  do not add a background workflow worker.
- **Validation:** Cover pending and failed recovery, failed-before-retry state,
  missing/corrupt revisions, a later operation succeeding after an earlier
  failure, second-scan non-duplication, and outcome-write failure stopping
  startup.

### A stuck edit-and-retry operation crashes the daemon on every launch

- **Symptom:** After updating, `tuttid` exits immediately on every launch and the
  desktop reports `tuttid exited before it published its listener info`; the daemon
  log shows `recover agent host: process runtime operation <id>: agent session not
found` (or `... agent history was rolled back but the edited turn still needs to
be resent`). The app never opens.
- **Quick checks:** Look for a durable `edit_retry` runtime operation stuck at the
  `resend_pending` checkpoint — the last Turn was rolled back on the provider but
  the replacement was never re-sent. While the daemon runs, the live worker only
  logs this at 1 Hz; the fatality appears only on the next cold restart. The
  affected session's `workspace_agent_session_history.recovery_state` is fenced
  (non-`ready`).
- **Root cause:** The cold-recovery pass (`RecoverRuntimeOperations`) treats a
  per-operation error as fatal to `build tuttid server`, so a persisted edit-retry
  operation that can never make progress becomes a boot poison pill. The live
  worker tolerates the same error, which is why the app worked until the restart.
- **Fix:** Durable edit-and-retry is disabled (`Config.EditRetryDisabled`, set in
  production wiring). Recovery quarantines any leftover `edit_retry` operation —
  marks it failed AND clears the session's effective-history fence back to `ready`
  so the conversation can still send — and returns non-fatally, so existing poison
  pills self-heal on the next boot. New edit-retries are refused at the entry
  points. Sessions fenced before the neutralization (owning operation already
  failed, so recovery cannot see it) self-heal at the send gate: the first send
  clears an abandoned fence instead of rejecting. The durable rule: never let one
  runtime operation's error abort daemon startup.
- **Rescue:** For an install that cannot update yet, quit Tutti and run
  `tools/scripts/rescue-edit-retry-poison-pill.sh`, which quarantines the stuck
  rows and clears the session fence in `~/.tutti/tuttid.db` after backing it up.
- **Validation:** `packages/agent/host/edit_retry_disabled_test.go` builds a
  genuinely stuck operation, asserts enabled recovery is boot-fatal, and asserts
  the disabled path quarantines it, returns nil, and leaves the session at
  `recovery_state = ready`.

### Many stopped Tutti Mode conversations start again when the app opens

- **Symptom:** Starting the desktop app makes several old Tutti Mode source
  conversations begin new Turns even though their tasks were previously
  stopped or already terminal.
- **Quick checks:** Correlate the startup time with
  `workspace_tutti_mode_legacy_repair_v5`, listener-ready wake recovery, and
  new canonical Turns. In the execution tables, look for a migration
  checkpoint whose `creation_reason` is
  `legacy_execution_startup_repair`, an idle execution changed to
  `awaiting_main`, and a prepared or dispatched main wake. Do not attribute the
  behavior to generic Agent Host resume unless the exact Session already had a
  recoverable active Turn.
- **Root cause:** The former V5 legacy backfill treated ambiguous idle plans as
  live executions and created a durable main wake. Listener readiness later
  delivered those historical wakes into the source conversations. Startup Run
  settlement repair could also create another checkpoint for an execution
  that was already terminal.
- **Fix:** Make legacy migration side-effect-free: keep an execution running
  only when an authoritative Run is running, classify idle history as
  `completed`, and create no migration wake. Suppress settlement checkpoints
  for terminal/orphaned executions. For databases that already applied V5,
  run the exact-fingerprint V6 cleanup to cancel the old recovery chain and
  normalize execution status from current Runs.
- **Validation:** Cover fresh idle and running legacy fixtures with zero
  migration wakes, a V5-corrupted idle fixture repaired to `completed`, a
  V5-corrupted running fixture retained as `running`, and terminal settlement
  replay producing no checkpoint or wake. Re-run V6 to prove idempotency.
- **References:**
  [issue-execution.md](../../architecture/issue-execution.md),
  [migrations_tutti_mode_legacy.go](../../../services/tuttid/data/workspace/migrations_tutti_mode_legacy.go),
  [sqlite_tutti_mode_settlement.go](../../../services/tuttid/data/workspace/sqlite_tutti_mode_settlement.go)

### Tutti capability audit persistence races the first Turn projection

- **Symptom:** Create or SendInput fails with `sql: no rows in result set`
  immediately after `runtime.submitted`, or a live `turn_update` frame is
  rejected because its outcome is null.
- **Quick checks:** Verify capability provenance is carried on the
  controller-owned submitted event or a lifecycle-neutral same-Turn guidance
  report. Check that no second post-Exec writer tries to update a Turn before
  the asynchronous projection creates it. Confirm the event schema accepts a
  null outcome while a Turn is live.
- **Root cause:** `capabilityRefs` are historical submission audit data, not
  current Tutti activation. Writing them through a second store call races the
  canonical Turn projection. Attaching a synthetic lifecycle phase to guidance
  can also corrupt the running Turn. A bounded reporter queue that falls back
  to inline reporting may reorder projection work or deadlock on reporter
  re-entry.
- **Fix:** Persist provenance with the submitted `TurnTransition`; use a
  lifecycle-neutral state report for same-Turn guidance. Route synchronous
  reporter work through one non-blocking, single-consumer FIFO. Queue pressure
  must neither report inline nor block a reporter observer that can re-enter
  the Controller.
- **Validation:** Verify runtime acceptance may precede Turn projection, live
  null-outcome events validate, later transitions retain references, and a
  backlog beyond the former bounded queue plus reporter re-entry preserves FIFO
  order without deadlocking. Unsupported capability/source values must fail at
  HTTP ingress and event publication without changing activation.

### `tutti agent send` reports unknown delivery after Codex accepted the prompt

- **Symptom:** `tutti agent send` returns
  `agent_submit_delivery_unknown` with an error saying the workspace, Session,
  Turn, and client submit IDs are required. The prompt and attachment may still
  appear in the transcript and Codex may complete the Turn, so retrying the
  command can duplicate the work.
- **Quick checks:** Correlate the command timestamp with the target Session in
  the durable store and runtime logs. If the user message, provider Turn, and
  assistant response exist but the submission provenance has no
  `clientSubmitId`, the runtime accepted the command and only the
  post-dispatch delivery confirmation failed.
- **Root cause:** The Agent service requires a caller-stable client submit ID to
  reconcile ambiguous delivery after runtime dispatch. The CLI Agent provider
  populated workspace and Session context but omitted the typed
  `ClientSubmitID` on both SendInput and initial Session creation.
- **Fix:** Generate one UUID per CLI command invocation and pass it through the
  typed `ClientSubmitID` field. Keep Turn ID allocation in Agent Host; the CLI
  identity exists only to make one semantic submission idempotent and
  recoverable.
- **Validation:** Exercise both `agent start` and `agent send` through the CLI
  provider and assert each service input contains a valid UUID client submit
  identity.
- **References:**
  [session_commands.go](../../../services/tuttid/service/cli/providers/agentcontext/session_commands.go)

### Codex finishes but AgentGUI keeps showing the Session as working

- **Symptom:** Codex has emitted its final assistant message, but AgentGUI keeps
  showing a busy spinner and the Session still has an active Turn. The UI may
  settle several minutes later without a restart.
- **Quick checks:** Search `tuttid.log` for
  `agent_session.activity_report.queue_backlog` and compare its `queue_depth`
  with the final message's `occurredAtUnixMs` and canonical
  `updatedAtUnixMs`. A large gap means provider completion reached the runtime
  before canonical persistence. When prod and dev are both running, identify
  them by listener, PID, state, and workspace paths; a shared log file alone
  does not prove they share a database.
- **Root cause:** Streaming text, reasoning, and tool-output snapshots entered
  the unbounded report FIFO before coalescing. When the single reporter was
  slower than producers, thousands of superseded snapshots accumulated ahead
  of the same Session's terminal report. Tool-call output snapshots were not
  eligible for coalescing at all.
- **Fix:** Coalesce pending streaming snapshots by Session and message while
  they are enqueued. Preserve the latest cumulative tool output, original tool
  input, and earliest start time. Keep terminal and submit-provenance reports
  as same-Session FIFO barriers.
- **Validation:** Enqueue at least 2048 text and tool-output snapshots and prove
  each pending Session occupies one queue slot. Verify the latest snapshot is
  retained, terminal and submit-provenance barriers stay ordered, reporter
  re-entry remains non-blocking, and focused race tests pass.
- **References:**
  [controller_report_queue.go](../../../packages/agent/daemon/runtime/controller_report_queue.go),
  [report_coalescer.go](../../../packages/agent/daemon/runtime/report_coalescer.go),
  [controller_report_queue_test.go](../../../packages/agent/daemon/runtime/controller_report_queue_test.go)

### Claude fails before provider Turn identity but AgentGUI keeps thinking

- **Symptom:** Claude returns no assistant result and the provider invocation
  has already failed, but AgentGUI keeps showing the Turn as processing. Later
  sends may be rejected because the runtime still reports an active Turn.
- **Quick checks:** Correlate the canonical Turn ID across the submit report,
  Claude sidecar event, and runtime controller. The characteristic sequence has
  a durable submitted Turn, `turn_failed` without `providerTurnId`, dispatch
  disposition `applied_without_provider_turn`, and a canonical failed report,
  while `HasActiveTurn` remains true. Do not interpret
  `applied_without_provider_turn` itself as a failure; cancel-before-acceptance
  legitimately uses the same admission result.
- **Root cause:** Provider acceptance and canonical completion are independent
  contracts. The acceptance wrapper treated an exact providerless
  `turn.failed` as premature provider output, while the blocking controller
  released its active-Turn fence only for failures carrying explicit rejection
  metadata. A non-rejection failure could therefore be durable but never close
  the runtime fence.
- **Fix:** Hold an exact canonical terminal behind the acceptance barrier and
  return it to the controller without inventing provider identity. Classify
  completion from the typed terminal event for the exact Turn, never from the
  dispatch disposition or error text. Partition every pre-acceptance batch so
  an exact terminal cannot carry provider-dependent assistant/tool output
  through the barrier. Release the active-Turn fence only after the terminal
  crosses the synchronous durable-report barrier. If that commit fails or its
  acknowledgement is lost, retain the terminal and retry it idempotently until
  the commit succeeds or daemon reconciliation proves the Turn already settled.
  Provider-root completion with an identity continues through canonical
  aggregation.
- **Validation:** Cover Claude translation of a providerless `turn_failed`,
  mixed terminal/provider-output batches, controller settlement after a
  successful terminal report, transient report failure, commit-success/ACK-loss,
  explicit rejection, cancel-before-acceptance, and outcome-unknown. Run the
  Host conformance scenario for initial and ordinary idempotent submissions.
  Retain a root-provider lifecycle test proving provider-root completion does
  not clear the canonical Turn before daemon reconciliation.
- **References:**
  [claude_sdk_execution.go](../../../packages/agent/daemon/runtime/claude_sdk_execution.go),
  [controller_turn_completion.go](../../../packages/agent/daemon/runtime/controller_turn_completion.go),
  [controller_turn_exec.go](../../../packages/agent/daemon/runtime/controller_turn_exec.go)

### Tutti mode is active in the composer but disappears after the first submit

- **Symptom:** The home composer shows Tutti enabled and the submit trace records
  `tutti_mode_active=true`, but the created Session has no activation and its
  first `tutti_mode_turn_snapshots` row is `inactive`.
- **Quick checks:** Trace `initialTuttiModeActivation` at the composer submit,
  controller activation, desktop activity service, renderer HTTP adapter, and
  daemon create ingress. Log only a presence boolean at each boundary. Compare
  the Session export with the durable activation and Turn snapshot rows;
  `capabilityRefs` do not prove current activation.
- **Root cause:** Session creation crosses several adapters that reconstruct
  object literals. A manually projected create input can omit
  `initialTuttiModeActivation` or its Tutti `capabilityRefs` even when the
  upstream type carries them. Reading mutable draft state after submit can also
  lose the exact composer selection. AgentGUI treats
  `capabilityMenuState.tuttiMode.enabled === true` as the host capability for
  the hero toggle, badge activation, and `/tutti`; Tutti Desktop always supplies
  it, while hosts that omit it or set `enabled: false` fail closed.
- **Fix:** Snapshot active/inactive state and orchestration intensity atomically
  with the composer submit. Preserve both activation and capability provenance
  through every create projection, and use the same host capability as the
  visible control for slash actions.
- **Validation:** Keep boundary tests for the service, engine host, and HTTP
  adapter. In a real development launch, submit once with Tutti enabled and
  verify the HTTP boundary sees the activation, the activation revision is
  `active`, and the first Turn snapshot retains its source and intensity.

### A new Tutti conversation briefly reports session not found after submit

- **Symptom:** The optimistic conversation appears after the first submit and
  briefly shows `workspace agent session not found`, then recovers after the
  provider starts and the durable Session and Turn complete normally.
- **Quick checks:** Correlate the Session ID across desktop and daemon submit
  traces. The characteristic order is
  `renderer_adapter.create.http_requested`, then
  `agent.activity.reconcile_session_absent`, then
  `renderer_adapter.create.resolved` and `api.create.completed`. Confirm the
  missing reconcile occurs while the engine still has a requested or uncertain
  new-session activation.
- **Root cause:** Initial Tutti activation can publish
  `workspace.tuttimode.updated` before the create transaction is query-visible
  or its HTTP response returns. The renderer treats the event as a reconcile
  hint and exposes its transient 404 as a detail failure even though the
  independent create command is still in flight.
- **Fix:** Ignore only this Tutti update hint when the exact Session has no
  canonical record and its latest new-session activation is still requested or
  uncertain. Let the authoritative create result confirm the Session. Do not
  broadly swallow reconcile 404s: existing Sessions and other reconcile
  sources still report their real failures. Tombstone only from explicit
  deletion evidence such as `session_deleted` or a successful delete command.
- **Validation:** Hold create in flight, publish
  `workspace.tuttimode.updated`, and verify the Session read is not called and
  no reconcile error is recorded. Then resolve create and verify the canonical
  Session and active activation are present. Also prove the same event still
  reconciles an existing Session and preserves its not-found diagnostic, while
  an explicit `session_deleted` event tombstones it.
- **References:**
  [workspaceAgentActivityReconcileBridge.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityReconcileBridge.ts)
  [workspaceEventCoordinator.ts](../../../packages/agent/activity-core/src/workspaceEventCoordinator.ts)

### A Tutti submission remains `delivery is still being confirmed`

- **Symptom:** Retrying the same composer submission keeps returning
  `agent submit delivery is still being confirmed`. The Session may already
  exist and the Tutti badge may remain active, but the daemon does not start a
  second Turn.
- **Quick checks:** Read the `workspace_agent_submit_claims` row for the exact
  workspace, Session, and `clientSubmitId`. Compare its immutable
  `canonical_turn_id` with `tutti_mode_turn_snapshots.turn_id` and with the
  Turn found by durable message provenance for that `clientSubmitId`. Do not
  change the claim to a runtime-returned mismatched Turn ID. If the barrier
  reports `conflicts with durable submit provenance`, compare the JSON-encoded
  existing and projected message payloads as well as their Go container types.
  In particular, compare `payload.seq` and `occurred_at_unix_ms` from the
  ordinary runtime report and the durable provenance report for the same
  `clientSubmitId`.
  Identical JSON with `[]any` on the SQLite-decoded side and
  `[]map[string]any` on the fresh-report side is an in-memory normalization
  defect, not conflicting submit evidence. Different sequence values for the
  same canonical message mean the two report paths reconstructed its occurrence
  independently.
- **Root cause:** Provider handoff crossed an ambiguity boundary: the daemon
  reserved and snapshotted a canonical Turn before dispatch, but did not
  durably confirm the exact accepted Turn. The ordinary reporter may have
  persisted its Session/Turn state while the atomic client-submit message
  barrier failed, or the process may have stopped around that barrier. A host
  wired only to the compatibility `ActivityReporter` cannot satisfy the
  runtime's required `DurableActivityReporter` contract. The barrier can also
  falsely reject an ordinary message replay when a fresh JSON payload retains
  typed Go slices but the same payload decoded from SQLite uses `[]any`, and
  idempotency compares those concrete types directly. Retrying the provider
  call would risk duplicate work. Separately, the runtime adapter and durable
  provenance barrier can construct the same user message on different
  goroutines. If each path samples its own transient event timestamp, whichever
  path reaches SQLite second carries a different derived `payload.seq`; the
  strict provenance guard correctly rejects it. Scheduling determines whether
  the ordinary report exists before the barrier, so this form is intermittent.
  A compatibility reporter can still supply different transport-only sequence,
  source, or submission timestamps for the same protected user-message
  provenance.
- **Fix:** Preserve the prepared submit claim, Tutti snapshot, activation, and
  Session. Ensure the host supplies `DurableActivityReporter`; decorators
  should embed or otherwise preserve that required interface instead of
  probing an optional capability. Its provenance barrier must run outside the
  Session lifecycle lock, after earlier same-FIFO reports, and atomically write
  the stable user message against an existing Turn.
  Normalize every incoming message payload through the durable JSON
  representation before projection, merge, and idempotency comparison so
  fresh reports and SQLite-decoded rows share one in-memory shape. Do not
  special-case individual typed slices or bypass genuine payload conflicts.
  For the two canonical user-message paths, preserve the durable submit claim's
  immutable creation time through the typed Host and Runtime inputs and derive
  both reports' occurrence and sequence from it. Use `clientSubmitId` only as
  the idempotency identity, not as a numeric sequence. Build both messages with
  the shared canonical user-message constructor. Keep the store's exact-payload
  conflict check for all genuine conflicts; the protected provenance replay may
  accept only transport-only metadata differences after Turn, role, kind,
  status, semantics, `clientSubmitId`, content, content mode, display prompt,
  and text all match.
  Reconcile only from exact durable `clientSubmitId` provenance. If it resolves
  to the reserved Turn, idempotently accept the snapshot and claim; if it is
  absent or resolves elsewhere, keep delivery unknown and never re-dispatch
  that client submission. Definite pre-dispatch rejection is the only path
  allowed to abandon the prepared evidence.
- **Validation:** Cover exact acceptance, accepted Turn-ID mismatch, snapshot
  and claim acceptance failures, message-write rollback, process interruption
  after snapshot binding, reporter re-entry, duplicate replay without a new
  message version, and multiple guidance submissions sharing one active Turn.
  Include an ordinary-message-first replay whose payload contains nested typed
  slices and integer values; assert the provenance barrier reuses the existing
  message version while a real content change still conflicts.
  Exercise both runtime-message-first and provenance-first orderings and assert
  their complete message updates, occurrence times, and derived payload
  sequences are identical. Reopen the submit-claim store and prove an
  idempotent retry retains the original claim creation time. Exercise the
  narrow protected replay with differing transport sequence, source, and
  submission time, while proving a real content or semantics change still
  conflicts.
  Assert the unknown paths execute the provider zero additional times and never
  close the provisional Session or delete its activation.
- **References:**
  [workspace-workflows.md](../../architecture/workspace-workflows.md),
  [submit_claims.go](../../../services/tuttid/service/agent/submit_claims.go),
  [service_tutti_mode_activation.go](../../../services/tuttid/service/agent/service_tutti_mode_activation.go)

Turn state, loading, cancel, restore, file-change undo, rail projection, event updates, imports, and performance.

### AgentGUI restores a provisional conversation after creation fails

- Symptom:
  A new conversation fails to start, but a renderer reload selects the same
  Session ID again. The Rail may show an optimistic row while the canonical
  store has no matching Session.
- Quick checks:
  Correlate the activation request, Workbench
  `lastActiveAgentSessionId`, renderer reload, and canonical Session lookup by
  exact ID. If navigation persistence precedes canonical activation
  confirmation and the lookup returns typed `session.not_found`, this is a
  provisional-selection leak. A bounded Rail page that omits the Session is
  not enough evidence.
- Root cause:
  The new-conversation controller persisted its generated Session ID when it
  selected the optimistic row. A crash or reload could therefore restore that
  ID before Host committed a canonical Session. Reconcile errors also lost
  their typed code in the frontend engine, so AgentGUI could not distinguish a
  proven missing Session from a transient read failure.
- Fix:
  Keep provisional selection in mounted UI only. Persist it after the engine
  confirms activation from canonical Session state. Preserve reconcile
  `errorCode`; clear only the exact global and per-target navigation memories
  when the active reconcile settles with `session.not_found`. Preserve them
  for timeout, transport failure, and bounded-list absence.
- Validation:
  Verify a requested activation performs no persistence, canonical
  confirmation writes once, create failure plus reload cannot restore the
  provisional ID, typed `session.not_found` clears only the matching memories,
  and a transient reconcile error keeps the selection.
- References:
  [agent-gui-node.md](../../architecture/agent-gui-node.md)
  [sessionReconcile.reducer.ts](../../../packages/agent/activity-core/src/engine/sessionReconcile.reducer.ts)
  [useAgentGUIConversationSelectionController.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUIConversationSelectionController.ts)

### New Goal spinner stops before the first reply, then starts after it appears

- Symptom:
  Creating a Session with an initial Goal starts the processing indicator, then
  stops it as soon as the canonical Session appears. The provider continues
  working without an indicator. When the first assistant message and canonical
  Turn arrive, the indicator starts again until the Turn settles. The inverse
  symptom is a completed or failed Turn whose rail status has settled while the
  Composer action still spins.
- Quick checks:
  Compare the Claude SDK `session_state_changed` lifecycle log, activity stream
  connection, Engine runtime activity, canonical Session, and canonical latest
  Turn. The characteristic gap has SDK state `running`, a canonical Session, no
  latest Turn, and Engine runtime activity still `idle`. Do not use assistant
  message arrival as Turn identity. If the desktop log reports `Event stream
catalog revision mismatch`, fully restart `dev:desktop`; renderer HMR cannot
  replace the already running Go daemon binary.
- Root cause:
  Claude emits an exact session-level `running` observation before the first
  provider Turn identity, but the daemon previously logged and discarded it.
  Goal-only creation correctly has `initialTurnExpected = false`, so neither a
  pending prompt nor a canonical Turn can bridge that interval. For the inverse
  symptom, AgentGUI bypassed the Engine's occurrence-time fence and read the
  stale raw `running` flag directly after a canonical Turn had settled.
- Fix:
  Normalize the SDK observation to provider-neutral `running`/`idle` runtime
  activity, publish it as an ephemeral activity-stream event, and let the
  workspace Engine drive AgentGUI and rail busy projection. Once a canonical
  Session exists, AgentGUI must consume the Engine's fenced display status;
  use raw runtime activity only before that projection exists. Clear ephemeral
  runtime activity on disconnect. Keep Goal turnless and do not invent
  lifecycle state, provider-specific timers, or synthetic Turn IDs.
- Validation:
  Cover SDK projection without Turn identity, post-commit event publication,
  activity-stream ingestion before canonical Session hydration, AgentGUI busy
  projection, `idle`, disconnect cleanup, and both completed and failed Turns
  remaining settled when an older raw runtime observation still says
  `running`.
- References:
  [claude_sdk_events.go](../../../packages/agent/daemon/runtime/claude_sdk_events.go)
  [workspaceEventCoordinator.ts](../../../packages/agent/activity-core/src/workspaceEventCoordinator.ts)
  [useAgentGUISessionPresentation.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUISessionPresentation.ts)
  [agent-gui-node.md](../../architecture/agent-gui-node.md)

### AgentGUI detail misses or misplaces a canonical Turn error

- Symptom:
  The AgentGUI rail marks a conversation failed, but opening the conversation
  shows only the preceding tool or assistant rows. Reloading the session does
  not reveal why the Turn failed. A related symptom is a failure from a much
  older Turn appearing at the bottom of the currently loaded conversation,
  immediately before current processing UI.
- Quick checks:
  Inspect the canonical Turn snapshot before debugging React state. Confirm the
  owning Turn is terminal with `outcome = failed` or `interrupted` and has a
  non-empty `error.message`. Then inspect that Turn's timeline messages for a
  structured `visibleError` or a plain assistant message with the same error
  text. Finally, distinguish the session-wide Turn list from the hydrated
  message window: check whether any currently loaded timeline item has the
  exact owning `turnId` and whether older message pages remain.
- Root cause:
  Turn outcome and error are durable canonical state, while provider transcript
  messages are optional evidence. If detail rendering only projects transcript
  messages, a runtime that settles `AgentActivityTurn.error` without emitting a
  visible-error message leaves the rail and detail inconsistent. Reading only
  the active Turn also loses the error as soon as settlement clears
  `activeTurnId`. Conversely, treating the session-wide Turn list as transcript
  membership manufactures an empty Turn for an error whose messages are outside
  the current page, appends it after newer Turns, and makes an old failure look
  current.
- Fix:
  Reconcile terminal `AgentActivityTurn.error` in the shared transcript
  projection by exact `turnId`. Reuse a structured visible error, upgrade a
  matching plain assistant failure, or add one view-only row with a stable
  `(agentSessionId, turnId)` identity. Normally the owning Turn must already
  exist in the hydrated transcript projection. The exact latest failed Turn is
  the narrow exception: if it emitted no transcript item, create its view-only
  error row so the current failure reason remains visible. Historical Turns
  outside the message window still wait for an older page to supply an anchor.
  Do not restore session `lastError`, let session-operation selectors fall back
  to Turn errors, reinterpret a successful attach as activation failure,
  persist a duplicate message, or add component-local failure state.
- Validation:
  Cover a failed Turn with no provider error message, a matching plain failure,
  and an existing structured visible error. The first must render one fallback
  row when its Turn is loaded, and the latter two must remain single rows. With
  a full canonical Turn list and a newest-page-only transcript window, an older
  failed or interrupted Turn must not create a row or change Turn order. After
  prepending the older page, its error must appear exactly once on the owning
  Turn. Also cover the exact latest failed Turn with zero hydrated transcript
  items producing one error row, plus an older failed Turn with a newer active
  Turn whose processing ownership remains current.
- References:
  [workspaceAgentTurnErrorProjection.ts](../../../packages/agent/gui/shared/workspaceAgentTurnErrorProjection.ts)
  [workspaceAgentTurnErrorProjection.spec.ts](../../../packages/agent/gui/shared/workspaceAgentTurnErrorProjection.spec.ts)
  [workspaceAgentTimelineCanonical.ts](../../../packages/agent/gui/shared/workspaceAgentTimelineCanonical.ts)
  [agent-gui-node.md](../../architecture/agent-gui-node.md)

### Mid-turn provider failure renders a generic "request failed" card

- Symptom:
  A root-provider-lifecycle turn (Codex, Cursor, OpenCode) fails mid-turn —
  for example quota exhaustion — but the conversation shows only a generic
  "request failed" card with no detail and no classification code. The real
  reason appears only in the durable Turn record and daemon logs.
- Quick checks:
  Confirm the canonical Turn settled with a non-empty `error.message`. If the
  durable Turn carries the reason but the live card does not, inspect the
  synthesized `daemonRootTurnSettlement` event metadata, not the provider
  adapter — the adapter already reported the failure correctly.
- Root cause:
  Root-provider adapters do not emit `EventTurnFailed`; the daemon synthesizes
  it in `ReconcileRootTurnSettlement` after the durable settle commits. The
  settlement previously forwarded only `turnId` and `outcome`, so the
  synthesized event had an empty detail and the visible-error projection
  classified it as `unknown` instead of (for example) `quota_or_rate_limit`.
- Fix:
  Forward `Turn.ErrorMessage` through `RootTurnSettlement` and stamp it on the
  synthesized event metadata under the `error` / `errorMessage` keys read by
  `BestEffortErrorMessage`. Keep classification text-based in
  `visibleFailureCode`; do not special-case providers at this layer.
- Validation:
  `TestReconcileRootTurnSettlementPublishesFailureDetail` settles a failed
  root turn with a quota message and asserts the live stream emits a
  `quota_or_rate_limit` visible error carrying the original detail.
- References:
  [controller_root_turn.go](../../../packages/agent/daemon/runtime/controller_root_turn.go)
  [visible_error.go](../../../packages/agent/daemon/runtime/visible_error.go)
  [agent_runtime_adapter.go](../../../services/tuttid/agent_runtime_adapter.go)

### Failed Claude Turn looks like no reply or renders raw 522 payload

- Symptom:
  Claude produces no normal assistant reply, and the eventual failed message is
  a raw `API Error: 522` payload instead of the standard timeout card.
- Quick checks:
  Confirm the canonical Turn settled as failed with `request_timed_out`, while
  its persisted assistant message is plain failed text containing the explicit
  522 signature rather than a structured visible error.
- Root cause:
  The SDK can report a gateway timeout as a failed assistant text message. The
  generic failed-message recovery recognized network socket markers but not the
  unambiguous HTTP 522 signature, so the raw provider payload reached Markdown.
- Fix:
  Classify only explicit 522 markers as `request_timed_out` in the shared failed
  message presentation. Keep generic timeout prose unclassified to avoid
  rewriting ordinary assistant content.
- Validation:
  Cover both classification and rendered output: the timeout card is visible
  and the raw payload is absent.
- References:
  [agentErrorPresentation.ts](../../../packages/agent/gui/shared/agentEnv/agentErrorPresentation.ts)
  [AgentMessageBlock.tsx](../../../packages/agent/gui/shared/agentConversation/components/AgentMessageBlock.tsx)

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

### Opening a historical Codex session starts two short provider processes

- Symptom:
  Selecting one settled Codex conversation logs two process starts, each with
  `initialize` followed by `thread/read`, even though no turn was resumed.
- Quick checks:
  Confirm neither sequence contains `thread/resume`. Enable reconcile trace
  diagnostics temporarily and count complete `state_and_messages` commands.
  Two discovery/message/final sequences indicate two reconciles; one sequence
  with two probes indicates that both detail projections resolved capabilities.
- Root cause:
  There are two independent boundaries to verify. Combined reconciliation
  intentionally reads detail twice to close races while messages load, but its
  discovery read only needs hierarchy and `messageVersion`; using the full
  Session projection there adds an accidental provider-history capability
  probe. Separately, automatic selection restoration can be replayed while the
  first reconcile is running. Treating that ordinary selection as
  `force: true` appends a second complete reconcile, whose final detail read
  launches another probe.
- Fix:
  Preserve the two-read race fence. Send the first request with the
  `messageHydration` projection and the final request with `full`; only the
  latter resolves provider-backed lifecycle capabilities. Model automatic
  selection as idempotent “ensure hydrated” work, leaving force refresh as an
  explicit intent. Do not mask either symptom with a TTL cache, single-flight
  delay, or by removing the final read.
- Validation:
  Select a historical root-only Codex Session with no child hierarchy through
  `make dev-gui`. One combined reconcile should issue two detail requests and
  one message-list request, but only the final detail request should emit the short
  `initialize`/`thread/read` capability probe. Replaying the same selection
  while that reconcile is pending must not start another combined reconcile.
  Sessions with child hierarchy or additional message pages may issue more than
  one message-list request; each request must still follow the shared executor's
  Session and cursor policy.
- References:
  [sessionReconcileExecutor.ts](../../../packages/agent/activity-core/src/sessionReconcileExecutor.ts)
  [useAgentConversationSelection.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentConversationSelection.ts)
  [service_turns.go](../../../services/tuttid/service/agent/service_turns.go)
  [codex_appserver_fork.go](../../../packages/agent/daemon/runtime/codex_appserver_fork.go)

### Codex turn stays working before any reply or tool activity

- Symptom:
  A submitted Codex turn stays working without assistant text, reasoning, or
  tool activity. Stop may return quickly, but the next prompt on the same
  conversation can stall in the same way. This also occurs when a conversation
  is left offline and its first later submit loses the app-server connection.
- Quick checks:
  Correlate `agent.submit.trace` records by `client_submit_id`, `turn_id`, and
  `agent_session_id`. A `turn.start.requested` without
  `turn.start.succeeded` means the immediate app-server acknowledgement did
  not arrive. After the bounded failure, confirm
  `agent_session.app_server.turn_start.client_invalidated` appears and the next
  submit starts a new local process with `thread/resume`. An immediate
  `turn.start.failed` with `error=EOF` is an outcome-unknown transport loss and
  must still project one visible failed assistant message.
- Root cause:
  Codex `turn/start` should acknowledge immediately and stream the actual work
  through notifications, but the adapter previously called it with no client
  deadline. A graceful Stop could acknowledge `turn/interrupt` without proving
  that the unacknowledged `turn/start` connection was healthy, so the adapter
  retained and reused the same bad process. The live-session probe also treated
  a retained client pointer as live after its `Done` channel closed. Finally, a
  pre-acceptance `turn/start` failure was buffered as provider output even
  though it had no provider Turn identity, hiding the canonical terminal from
  the controller and GUI.
- Fix:
  Bound only the `turn/start` acknowledgement to 30 seconds; do not bound the
  subsequent running turn. Treat deadline, cancellation before acknowledgement,
  or transport disconnect as an unhealthy client, remove exactly that client
  from the live-session registry, and close it. Do not automatically replay the
  prompt because delivery is unknown. The next explicit submit uses the
  existing session recovery path to start a process and resume the provider
  thread. A live-session probe must also reject terminated clients. Publish the
  exact canonical `turn.failed` directly when `turn/start` fails before provider
  acceptance, while dropping unaccepted provider-dependent output; this reuses
  the normal visible-error projection without inventing provider identity.
  Bound `turn/steer` acknowledgement separately to 10 seconds.
- Validation:
  Run
  `go test ./packages/agent/daemon/runtime -run 'Test(CodexAppServerAdapter(Turn(StartAckTimeoutInvalidatesClient|StartEOFProjectsVisibleFailureBeforeAcceptance|StartCancelBeforeAckInvalidatesClient|StartAckTimeoutDoesNotBoundRunningTurn|SteerTimesOut)|CanResumeAfterTurnStartAckTimeout|HasLiveSessionRejectsClosedClient)|StandardACPAdapterHasLiveSessionRejectsClosedClient)$'`.
  Cover timeout, EOF before acceptance, terminated-client liveness, pre-ack
  cancellation, a long post-ack turn, bounded guidance, and successful
  `thread/resume` followed by a completed turn.
- References:
  [codex_appserver_turn.go](../../../packages/agent/daemon/runtime/codex_appserver_turn.go)
  [codex_appserver_registry.go](../../../packages/agent/daemon/runtime/codex_appserver_registry.go)
  [codex_appserver_turn_timeout_test.go](../../../packages/agent/daemon/runtime/codex_appserver_turn_timeout_test.go)

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

### Goal banner shows Delete but no Restart action

- Symptom:
  A provider supports goal pause/resume and the action is initially visible,
  but a paused or blocked Goal later shows only Delete.
- Quick checks:
  Compare provider composer capabilities with the selected Session's typed
  capabilities. `capabilities: null` means no authoritative session snapshot
  is available because it is not yet reported or legacy-ambiguous; only then
  may presentation fall back to the provider composer descriptor. A non-null
  object is complete. Inspect the private persistence compatibility carrier
  for `capabilitiesReported` before treating an empty legacy list as
  authoritative.
- Root cause:
  Legacy persistence could not distinguish an unknown capability list from an
  explicitly reported empty snapshot. Partial `RuntimeContext` reports could
  also replace the full map and erase capability metadata. The API then closed
  the missing list into `false`, which overrode the provider composer value.
- Fix:
  Carry capabilities as a typed optional snapshot outside `RuntimeContext`.
  Persist explicit report presence, preserve omitted snapshots on partial
  updates, and use typed `set`/`unset` runtime-context patches. In presentation,
  fall back to composer capabilities only for a null session snapshot; preserve
  explicit session `false`. No database schema migration is required because
  the report-presence marker uses the existing metadata JSON column and legacy
  rows are normalized when decoded.
- Validation:
  Cover legacy empty and non-empty metadata, reported empty snapshots,
  partial state updates, API null/closed projections, and AgentGUI resolution.
  Verify a Codex live snapshot contains `goalPause` after goal pause, cancel,
  and session recovery.
- References:
  [provider.go](../../../packages/agent/store-sqlite/canonical/provider.go)
  [session_metadata.go](../../../packages/agent/store-sqlite/session_metadata.go)
  [capabilities.ts](../../../packages/agent/activity-core/src/capabilities.ts)

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

### Remote Agent image reaches the provider as an unsupported URL

- Symptom:
  A URL-backed PNG, JPEG, or WebP is accepted and appears in the user activity,
  but Codex rejects the turn with `remote image URLs are not supported; use an
inline data URL instead`. Claude or standard ACP may instead receive no
  usable image data.
- Quick checks:
  Confirm the durable prompt block intentionally contains an HTTPS `url`, then
  inspect the final provider payload. Codex must receive a `data:` URL; Claude
  SDK and standard ACP must receive base64 `data`. Search every provider send
  and guidance path for `materializeProviderPromptImagesAtBoundary`; the helper
  and its unit test can remain green even when a refactor removes all production
  callers. If the visible failure detail is
  `download remote prompt image: request failed`, compare the URL with a normal
  system HTTP client and inspect its DNS result. A URL that succeeds normally
  but resolves to a VPN or transparent-proxy synthetic address indicates that
  the runtime is bypassing or second-guessing the system network path.
- Root cause:
  Remote image URLs are the durable transport representation, while current
  Codex app-server, Claude SDK, and standard ACP provider wires require inline
  data. A provider-adapter refactor can preserve the materialization helper but
  omit its call sites in newly split turn files. Separately, pre-resolving and
  classifying destination IPs at this boundary is incompatible with VPN, TUN,
  split-DNS, and Fake-IP network stacks: their synthetic address is intentionally
  not the public origin address, but the system transport still knows how to
  reach the origin.
- Fix:
  Materialize only at the final provider boundary. Keep the original URL-backed
  content for activity projection, and convert the provider-only copy after
  local slash/control handling but immediately before Codex `turn/start` or
  `turn/steer`, Claude SDK `exec` or `guide`, and standard ACP
  `session/prompt`. Use the repository proxy-aware HTTP client and leave DNS,
  proxy, VPN, and connect-target selection to the system network stack; do not
  pre-resolve, pin, or reject resolved IP ranges at this provider compatibility
  boundary. Continue accepting only HTTPS URLs, require every redirect hop to
  remain HTTPS, strip redirect `Referer` headers so signed URL query parameters
  cannot cross hops, and keep timeout, response-size, and image MIME checks.
  Admit an asynchronous Codex guidance continuation before publishing its
  provisional provider turn, and settle that exact attempt when preparation
  ends without starting a real provider turn. For standard ACP, publish the
  original user activity and provider-turn start before remote materialization;
  if preparation fails, complete that same provider turn as failed so the
  message remains durable and root settlement cannot strand.
- Validation:
  Exercise URL-only content through the real adapter request paths and assert
  the captured provider payload contains inline data. Cover Codex send and
  guidance, Claude SDK exec and guide, and standard ACP exec; do not rely only
  on direct helper tests. Verify the production client can materialize through a
  system-routed reserved address, reject a redirect that downgrades to HTTP, and
  assert redirects omit signed-URL referrers. Cover failed and concurrent
  guidance continuation admission so every published provisional attempt either
  yields a real provider lifecycle or receives its matching provider-turn
  completion. Also fail standard ACP materialization and assert the original
  user message, turn start, and failed provider-turn completion are all emitted
  without sending `session/prompt`.
- References:
  [prompt_content.go](../../../packages/agent/daemon/runtime/prompt_content.go)
  [codex_appserver_turn.go](../../../packages/agent/daemon/runtime/codex_appserver_turn.go)
  [claude_sdk_execution.go](../../../packages/agent/daemon/runtime/claude_sdk_execution.go)
  [standard_acp_turn.go](../../../packages/agent/daemon/runtime/standard_acp_turn.go)

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
  queue decisions from the live `AgentSessionEngine` returned by
  `AgentGUIRuntime.getSessionEngine(...)` before falling back to
  `activeSessionState`. Ordinary composer sends while busy should
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
  cancel-then-send discards the same-Turn semantics offered by Codex and the
  Claude SDK. Native guidance semantics are provider-specific: Codex steering
  deliberately leaves the current response running, while the Claude SDK must
  interrupt its active Query before it can reliably enqueue guidance.
- Fix:
  Keep the prompt queue in the workspace `AgentSessionEngine`. Resolve send-now
  from typed runtime capabilities: use native guidance when
  `activeTurnGuidance` is true, with no canonical Turn cancel. The provider
  adapter must preserve its native semantics on the same canonical Turn.
  Claude uses its SDK interrupt before enqueueing the prompt and closes the old
  response projections. Codex/Tutti Agent sends `turn/steer` with the exact
  active provider Turn ID and does not interrupt or start a replacement Turn.
  If no provider response remains but the canonical Turn is still active for
  child work, Codex may start a provider continuation through `turn/start`.
  Otherwise use
  exact-turn cancel when `interrupt` is true, retain the prompt in the frontend
  queue, and send it normally only after validated cancellation or authoritative
  turn settlement. Route both the composer shortcut and queued-item action
  through the same atomic engine transition.
- Validation:
  Cover both entry points and both capability combinations. Native guidance must
  emit a guidance send with no cancel. ACP fallback must emit cancel with no
  prompt send, then emit one normal prompt send after cancellation settles. At
  the Claude provider boundary, assert that the old response terminal and all
  old thinking-stream terminals precede guided output. For Codex, assert that
  active-response guidance sends exactly one `turn/steer` with the expected
  provider Turn ID and sends neither `turn/interrupt` nor another `turn/start`.
- References:
  [promptQueue.reducer.ts](../../../packages/agent/activity-core/src/engine/promptQueue.reducer.ts)
  [sessionLifecycle.reducer.ts](../../../packages/agent/activity-core/src/engine/sessionLifecycle.reducer.ts)
  [controller_exec.go](../../../packages/agent/daemon/runtime/controller_exec.go)

### Queued AgentGUI prompt stalls after no-active-turn failure

- Symptom:
  A prompt submitted while an AgentGUI turn is busy appears in the local queue
  or as an optimistic user row, but does not start after the previous turn
  settles. Submit traces show the same `clientSubmitId` first failing with
  `errorReason = agent.no_active_turn`, then succeeding only after a later
  manual retry or another queue-draining trigger.
- Quick checks:
  Search desktop and daemon logs for the queued `clientSubmitId`. A local queue
  acceptance has `send_input.requested` with `queued=true` and
  `optimistic_user_message_painted`. The failure pattern is a delayed
  `renderer_adapter.send.failed` with `errorCode=invalid_request` and
  `errorReason=agent.no_active_turn`, plus daemon `runtime_adapter.exec.failed`
  with `agent session has no active turn`.
- Root cause:
  The daemon exposes the domain-specific reason as the protocol error
  `reason`, while the Agent session engine previously kept only the generic
  `errorCode`. The queue reducer therefore treated the race like a permanent
  send failure, set `failedPromptId`, and stopped automatic drain until
  send-now or another retry path cleared the failure.
- Fix:
  Preserve protocol `reason` on `EngineCommandResultIntent`. For
  `queue/sendPrompt` failures whose reason is `agent.no_active_turn`, clear the
  in-flight send, request a session reconcile, and skip same-reducer drain so
  the queued prompt retries only after canonical state refresh. Keep ordinary
  send failures blocked until explicit send-now retry.
- Validation:
  Add reducer coverage where a queued send fails with
  `errorReason = agent.no_active_turn`: it should emit one
  `session/reconcile`, leave the prompt queued without `failedPromptId`, and
  avoid an immediate second `queue/sendPrompt` until a later canonical lifecycle
  update. Keep the existing generic failure test blocked until send-now.
- References:
  [promptQueue.reducer.ts](../../../packages/agent/activity-core/src/engine/promptQueue.reducer.ts)
  [effectExecutor.ts](../../../packages/agent/activity-core/src/engine/effectExecutor.ts)
  [daemon_agent_submit_handlers.go](../../../services/tuttid/api/daemon_agent_submit_handlers.go)

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
  on a non-clickable send spinner. The transcript treats `/goal clear` as a
  user Turn followed by a new processing row even though no new user work
  started. Claude Code may instead append a native `Goal cleared: …` assistant
  message at the bottom of the transcript after the interrupted turn.
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
  goal-control API. Do not create a user Turn message, pending submit, or pseudo
  turn. A surface may project the durable session audit as a dedicated
  `goal-control` row, but that row must carry no Turn ID and must not affect
  processing ownership or Turn counts.
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
  without an engine submit dispatch. If the clear control is visible, it must
  be a `goal-control` row with no Turn ID; the original processing row must
  remain in place, and Stop must remain clickable until the active turn settles
  or is interrupted. For Claude Code, verify the native acknowledgement is
  absent both live and after reload, while identical text from an ordinary
  assistant turn remains visible.
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

### AgentGUI Batch delete sessions does nothing

- Symptom:
  The project or Chats overflow menu opens, but choosing **Batch delete
  sessions** neither opens the confirmation dialog nor sends a delete request.
- Quick checks:
  Look for
  `agent.gui.conversation_batch_delete.capability_incomplete` in the host's
  AgentGUI diagnostics. Its `missingMethods` field identifies whether the host
  omitted `listSessionSectionDeletionCandidates` or `deleteSessionsBatch`. If
  the event is absent and the action is enabled, correlate the candidate-list
  and batch-delete transport requests before investigating the view.
- Root cause:
  Batch deletion is a two-stage runtime capability: AgentGUI first resolves the
  authoritative session ids for the rail section and only then submits the
  selected ids. A host that manually assembled `AgentGUIRuntime` could
  expose the mutation but omit the candidate query. The old optional-method
  checks then returned an empty candidate list, making a valid click look like
  a no-op.
- Fix:
  Install the complete runtime cohort from
  `@tutti-os/agent-gui/conversation-rail-runtime` and keep only transport DTO
  mapping in the host adapter. Do not add view-local candidate discovery or
  infer membership from loaded rows. AgentGUI treats a partial two-method
  contract as unavailable, disables the action, and reports the missing method.
- Validation:
  Cover the host composition with both batch-deletion methods, verify the shared
  factory forwards the exact candidate and delete inputs, and cover a partial
  runtime contract as disabled with one diagnostic. Run the Agent GUI package
  tests and the host activity-runtime composition tests.
- References:
  [agentConversationRailRuntime.ts](../../../packages/agent/gui/agentConversationRailRuntime.ts)
  [useAgentGUIConversationRailQuery.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUIConversationRailQuery.ts)
  [createDesktopAgentActivityRuntime.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.ts)

### AgentGUI model switch changes defaults but not the active session

- Symptom:
  A user selects a different AgentGUI model, but the next provider call still
  uses the previous model. The target-default patch may be acknowledged while
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
  `agent_session.app_server.turn_start.params`. Also distinguish the dedicated
  defaults patch intent from the Session update. If only the defaults ack is
  present, the UI remembered a future target default but did not update the
  active Session. If
  daemon settings update completed but `turn_start.params.model` is old or
  empty, inspect the app-server adapter path. If persistence and the provider
  request both contain the selected model but the daemon session response omits
  `settings.model`, inspect the service projection before debugging the
  renderer selector.
- Root cause:
  AgentGUI has two distinct composer surfaces. The target home composer writes
  remembered defaults and a sparse local display draft. An active conversation composer must
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
  Preserve the dedicated target-default patch path, but make active-session model changes
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

### AgentGUI shows the selected settings but a new session does not inherit them

- Symptom:
  The home composer continues to show the selected model, permission,
  reasoning effort, or speed, but closing the Agent window, opening another
  window, restarting Tutti, or creating a Session restores an older value. A
  running Session may still use the selected value, which can make the problem
  look provider-specific.
- Quick checks:
  Start with the exact `agentTargetId`, not only the provider. Confirm the
  `preferences.agent.composer.defaults.patch.requested` intent receives an ack,
  then inspect
  `desktop_preferences.agent_composer_defaults_by_agent_target_json` for that
  target and field. Confirm a
  `preferences.agent.composer.defaults.changed` event carries only the same
  target id. Finally request target-scoped composer options and verify
  `effectiveSettings`, then create a Session without explicit overrides and
  inspect the daemon's resolved create settings. For an Agent Extension model,
  confirm the daemon first observed that value in a live catalog for the exact
  target; a catalog observed only for another target cannot validate the patch.
- Root cause:
  Target defaults and current Session settings are separate durable concerns.
  The renderer's home draft can display an optimistic selection even when a
  defaults write failed. Conversely, a Session settings update can succeed
  while the future-default patch fails. A stale renderer preferences snapshot
  must never be merged and written back as the defaults map; options snapshots
  must never sanitize a newly selected menu value before persistence.
- Fix:
  Keep `rememberAgentComposerDefaultsForAgentTarget` on the dedicated patch
  intent. Merge its sparse fields only in the tuttid SQLite transaction, publish
  target invalidation after success, and reread defaults through
  composer-options. Keep Create Session inheritance in `agent.Service.Create`;
  callers pass only explicit overrides. Do not repair this with debounce,
  localStorage, node/workbench overlays, or another full preferences write.
  Do not add workspace/cwd to the target-default patch. Extension model
  validation uses the daemon-observed last-known-good catalog for the exact
  target. Its evidence survives the workspace/cwd display-cache TTL and is
  cleared by explicit provider invalidation; Create performs the separate
  actual-workspace/cwd validation.
- Validation:
  Change different fields from two windows and confirm both survive. Repeat the
  same SET, then change the same field again and confirm daemon acceptance order
  determines the result. Force an options refresh with an older permission or
  model list and confirm the explicit selection remains visible and is still
  patched. Exercise A-to-B-to-A on one field and confirm only the exact latest
  generation can leave the optimistic layer. Fail the first options reload
  after a successful patch, then confirm a later successful target invalidation
  read converges the acknowledged draft. Reopen the window and restart the app;
  `effectiveSettings` and a new Session must resolve the remembered values.
  Open a historical Session and confirm its settings do not change future
  defaults.
- References:
  [service.go](../../../services/tuttid/service/preferences/service.go)
  [sqlite_preferences.go](../../../services/tuttid/data/workspace/sqlite_preferences.go)
  [composer_options.go](../../../services/tuttid/service/agent/composer_options.go)
  [desktopPreferencesService.ts](../../../apps/desktop/src/renderer/src/features/desktop-preferences/services/internal/desktopPreferencesService.ts)
  [useAgentGUIComposerSettingsActions.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUIComposerSettingsActions.ts)

### Agent interaction remains waiting after the user already responded

- Symptom:
  An approval or question remains at an ask-user stop point after the user
  submitted a response. The session may continue after Cancel or an app
  restart, while retrying by request id alone can target an older Turn or be
  rejected as ambiguous.
- Quick checks:
  Inspect the canonical Interaction identity without logging its prompt or
  response payload. Compare `workspace_id`, `agent_session_id`, `turn_id`, and
  `request_id` across the UI/CLI command, Interaction row, and durable runtime
  operation. A provider request id reused by two Turns is valid. An operation
  id whose stored tuple differs from the command tuple is an invariant failure.
- Root cause:
  Provider request ids are transport-local and are not session-wide durable
  identities. Selecting an Interaction or deduplicating a runtime operation by
  request id alone can bind a response to historical Turn state, leaving the
  live Turn waiting.
- Fix:
  Carry the typed exact tuple
  `(workspaceId, agentSessionId, turnId, requestId)` into Host and select the
  Interaction atomically by that tuple. Scope runtime-operation idempotency to
  the same tuple. Keep the provider request id unchanged. Do not scan, guess,
  auto-deduplicate, or rewrite historical rows. The V4 runtime-operation
  migration removes the lossy `subject_id`, creates partial unique indexes for
  each operation kind, verifies copied row distributions and foreign keys, and
  rolls the whole transaction back when a conflicting durable identity exists.
- Recovery:
  Existing affected sessions may be canceled and retried; restart settlement
  may also interrupt a stale Turn. This forward fix deliberately does not
  mutate historical Interaction rows.
- Validation:
  Cover the same provider request id in two Turns, exact CLI response routing,
  same-answer idempotency, different-answer supersession, operation identity
  mismatch failure, lossless V1-to-V4 migration, and V4 preflight rollback.
- References:
  [host README](../../../packages/agent/host/README.md)
  [runtime_operations.go](../../../packages/agent/host/runtime_operations.go)
  [migrations_runtime_operations_v4.go](../../../packages/agent/store-sqlite/migrations_runtime_operations_v4.go)
  [tutti-cli-contract.md](../tutti-cli-contract.md)

### Approval feedback stops the Turn or reports a failed response

- Symptom:
  Entering feedback on a denied approval aborts the provider Turn, loses the
  feedback text, or lets the provider continue while the response API reports
  `interactive request is no longer live`.
- Quick checks:
  Inspect the canonical Interaction options and response. Confirm feedback uses
  the non-terminal deny option, retains `payload.denyMessage`, and targets the
  exact child Session and Turn. For Codex, confirm the approval response is
  `decline` and the following `turn/steer` uses the child's provider thread and
  provider Turn IDs.
- Root cause:
  Treating abort as an ordinary feedback-capable deny ends the Turn before text
  can be delivered. Dropping the payload at the adapter boundary has the same
  visible result. Blocking Interaction completion on the provider's steer
  acknowledgement can also race request cleanup and falsely fail an already
  answered approval.
- Fix:
  Keep deny and abort distinct in presentation. Preserve the payload through
  the runtime adapter. Complete the approval response as answered, then deliver
  feedback through provider-native active-turn guidance without replacing it
  with a new root or child `Exec`.
- Validation:
  Cover option selection, payload preservation, exact child provider
  thread/Turn steering, a delayed steer acknowledgement, and a real
  record-audit-replay cassette whose tool is rejected and whose child reports
  the feedback.
- References:
  [interactivePromptPresentation.tsx](../../../packages/agent/gui/shared/agentConversation/components/interactivePromptPresentation.tsx)
  [codex_appserver_event_interactive.go](../../../packages/agent/daemon/runtime/codex_appserver_event_interactive.go)

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

### Agent GUI sessions appear under the wrong user project

- Symptom:
  A conversation started with the "No project" selection appears in the Agent
  GUI rail under a parent user-project group such as the user's home directory.
  Imported Codex or Claude Code conversations with `cwd` equal to `$HOME`, and
  claude.ai data-export conversations that have no cwd at all, can show the
  same symptom even though the user never selected a project. A related nested-
  project variant shows an imported conversation under a broad parent folder
  while its explicitly selected child-project section says `No chats yet`.
  Switching provider filters may briefly retain the previous scope's row before
  the exact persisted membership makes the child section empty again.
  Delegated Issue tasks, Agent CLI handoffs, Automation follow-ups, or
  AgentGUI “New conversation” / “Continue in new conversation” can show a
  related variant: the new Session appears in Chats or under a temporary
  worktree instead of the source project, and Git commands no longer operate
  on the intended checkout.
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
  For the nested-project variant, compare `cwd`, `rail_project_path`, and
  `rail_section_key` in `workspace_agent_sessions`. If the cwd is inside a
  registered child project but the persisted key names an ancestor, check
  whether that child was registered only after the original import completed.
  For a newly derived Session, compare those three fields with the source
  Session and inspect whether the create adapter supplied both `cwd` and
  `RailPlacement`. If an Issue has `source_session_id` but no Run was created,
  verify that the source Session still resolves; dispatch intentionally waits
  instead of guessing. For project Sessions with an empty cwd, verify that the
  adapter used `rail_project_path` as the runtime fallback.
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
  For project-backed import, registering user projects only after valid session
  writes creates another ordering trap: the store may see an existing parent
  project but not the selected child while assigning the session's first,
  normally immutable rail key.
  Derived-Session entry points add the inverse trap: copying only runtime cwd
  loses logical ownership when the cwd is an isolated worktree, while copying
  only rail placement can leave the Agent without the source checkout. Looking
  up the source twice during one dispatch can also mix two different snapshots,
  and silently accepting a missing source turns an invalid handoff into a
  detached allocator-backed Session.
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
  applying longest parent-project matches. Project-backed external import must
  pass its exact matched selection into the initial session report, independent
  of whether API-level project registration has completed. The store validates
  that this is an imported, project-backed session whose cwd is contained by the
  selected path. An idempotent re-import may repair only Chats or an ancestor
  assignment to that explicit descendant; it must not infer a migration from
  the current project inventory or move an ordinary runtime session. Apart from
  this evidence-backed import correction, preserve valid existing rail keys
  across later cwd and project-list changes. A successful Create
  response must synchronously read back the persisted session and its nonblank
  key rather than racing the runtime's asynchronous activity reporter. AgentGUI
  must project sessions only by exact key equality and must not retain a cwd-based
  grouping fallback.
  For handoff, Issue, Automation, and AgentGUI new-conversation flows, carry
  runtime cwd and canonical rail placement independently. Resolve project
  identity by exact section key, use the canonical project path when a
  project-backed source cwd is empty, take one source snapshot per dispatch,
  and fail closed when a required source Session cannot be resolved.
- Validation:
  Run
  `pnpm --filter @tutti-os/agent-gui test -- agent-gui/agentGuiNode/model/agentGuiConversationModel.spec.ts`,
  `cd packages/agent/daemon && go test ./runtime`,
  `cd services/tuttid && go test ./service/agent ./api -run 'ExternalImport|ParseCodex|ParseClaude'`,
  `go test ./packages/agent/store-sqlite -run 'ImportedRail|ClassifiesRail'`,
  `node --import ./test/register-asset-stub.mjs --test --experimental-strip-types ./src/renderer/src/features/workspace-user-project/services/internal/desktopWorkspaceUserProjectService.test.ts`
  from `apps/desktop`, then run `pnpm check:changed`.
  For derived-Session regressions, also run the focused AgentGUI
  new-conversation tests plus
  `go test ./service/workspace ./service/automationrule`.
- References:
  [controller_state.go](../../../packages/agent/daemon/runtime/controller_state.go)
  [controller_state_test.go](../../../packages/agent/daemon/runtime/controller_state_test.go)
  [external_import_parse.go](../../../services/tuttid/service/agent/external_import_parse.go)
  [external_import_projects.go](../../../services/tuttid/service/agent/external_import_projects.go)
  [external_import.go](../../../services/tuttid/service/agent/external_import.go)
  [rail.go](../../../packages/agent/store-sqlite/rail.go)
  [agentGuiConversationModel.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/model/agentGuiConversationModel.ts)
  [desktopWorkspaceUserProjectService.ts](../../../apps/desktop/src/renderer/src/features/workspace-user-project/services/internal/desktopWorkspaceUserProjectService.ts)
  [agentGuiConversationProjectResolver.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/model/agentGuiConversationProjectResolver.ts)
  [useAgentGuiConversationList.ts](../../../packages/agent/gui/contexts/workspace/presentation/renderer/agentGuiConversationList/useAgentGuiConversationList.ts)
  [issue_sequential_dispatch.go](../../../services/tuttid/service/workspace/issue_sequential_dispatch.go)
  [daemon_executor.go](../../../services/tuttid/service/automationrule/daemon_executor.go)

### AgentGUI new conversation does nothing after leaving a Chats session

- Symptom:
  After using an ordinary Chats Session, the toolbar new-conversation action
  opens the home composer but submitting by Enter or the send button creates no
  visible Session and produces no `session/activate` command. Enabling Tutti
  Mode before submitting can make the problem look mode-specific even though
  activation is blocked before provider or Tutti Mode execution starts.
- Quick checks:
  Inspect the active conversation projection before the new-conversation
  request. If `railSectionKey` is `conversations` while `cwd` is a generated
  runtime directory, confirm that directory is not copied into the home
  composer's selected project. A subsequent activation that resolves the path
  against user projects and returns no placement explains the missing
  `session/activate`.
- Root cause:
  Composer presentation intentionally exposes the active Session `cwd` for
  file mentions, Git operations, and missing-directory checks. Treating that
  presentation field as the user's home project selection conflates runtime
  working directory with rail placement. The generated Chats directory then
  enters project resolution and fails closed because it has no canonical
  project section.
- Fix:
  Normalize default project selection at the AgentGUI controller's
  new-conversation command. Explicit section actions remain authoritative; an
  active Chats Session replaces the home selection with no project, an active
  project Session resolves its immutable section key back to the canonical
  registered project path, and an action already on Home preserves the user's
  explicit selection. The continuation action shares this resolver before it
  moves the source mention draft to Home. Views forward the intent without
  interpreting composer presentation fields.
- Validation:
  Cover the command through final `session/activate` for three P0 scenarios:
  active Chats clears a generated cwd, active Project with a nested/worktree
  cwd preserves its canonical placement, Continue uses that same project, and
  Home preserves an explicit project selection.
- References:
  [agentGuiNewConversationRequest.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/agentGuiNewConversationRequest.ts)
  [useAgentGUIOperationActions.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUIOperationActions.ts)
  [agentGuiNewConversationRequest.spec.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/agentGuiNewConversationRequest.spec.tsx)

### Extension history becomes non-resumable after daemon restart

- Symptom:
  An Agent Extension conversation works until `tuttid` restarts. Its history
  remains visible, but AgentGUI says it cannot resume on this device and only
  offers continuing through an `@` mention. In an affected live extension
  session, the `tutti` shim can be present on `PATH` while many public commands,
  including `tutti agent list`, return `command_not_found`. After restart,
  sending to the same session can fail with
  `session runtime snapshot is unavailable: launch identity is incomplete`.
- Quick checks:
  Confirm the persisted session still has `provider_session_id` and
  `agent_target_id`. If the Target remains enabled and names a fixed extension
  installation, compare list-time `resumable` calculation with the actual
  Resume path. An empty process-local adapter registry after restart is not
  evidence that the session cannot be restored.
  For the CLI variant, first distinguish discovery from routing: look for
  `tutti cli shim ready` in Desktop logs and `path_contains_tutti_bin=true` in
  the provider process diagnostics. If both are present but the provider tool
  reports `unknown command`, compare
  `workspace_agent_sessions.provider` with
  `internal_runtime_context_json.$.sessionRuntimeSnapshot.provider`. An
  extension provider such as `acp:<name>` beside an empty snapshot provider,
  followed by `launch identity is incomplete`, identifies the durable snapshot
  path rather than a PATH or listener failure. A second historical shape keeps
  `acp:<name>` in both locations but has a provider-native fingerprint computed
  from an empty provider; it fails later with
  `provider-native fingerprint does not match`.
- Root cause:
  Dynamic Agent Extension adapters are created on demand and cached only for
  the daemon lifetime. Computing `resumable` from that cache maps restart state
  to a false domain result before Resume can re-resolve the persisted Target.
  The same false result occurs when an adapter rebuilds the runtime resume input
  but drops `agentTargetId`: the fixed Target ref then fails the controller's
  complete binding check even though persistence and Target resolution are
  correct. A separate snapshot variant occurs when provider-neutral metadata
  uses the closed built-in-provider normalizer for an open extension identity.
  The writer then persists an empty provider and fingerprints the
  provider-native configuration with that empty value. Session-scoped CLI
  capability projection validates the snapshot before returning the command
  catalog; validation failure collapses discovery to an empty catalog, so
  otherwise valid commands appear unknown. Runtime resume rejects the same
  incomplete identity after daemon restart.
- Fix:
  At the service boundary, re-derive `ProviderTargetRef` from the persisted
  session's enabled `agentTargetId`. At the runtime boundary, validate the
  provider, Target, and fixed installation binding; when a dynamic resolver is
  configured, treat that authorized binding as eligible for a Resume attempt.
  Keep installation validation and ACP `session/load` in the actual Resume
  path. Never use an open provider id or adapter-cache presence as launch
  authority.
  Every bridge from the Host resume input to the runtime resume input must
  preserve `agentTargetId` and `ProviderTargetRef` together. Cover the complete
  service-to-adapter-to-controller path instead of testing each endpoint with
  independently constructed valid inputs.
  Persist and compare snapshot provider metadata with the open provider
  normalizer; launch authority still comes exclusively from the exact enabled
  Agent Target. For already-written empty-provider extension snapshots, recover
  only when the canonical session provider is a valid unregistered open
  identity, the snapshot declares provider-native configuration, and its
  fingerprint exactly matches the historical empty-provider payload. Apply the
  same narrow compatibility check to the transitional shape that already
  retained the open provider in the snapshot: the canonical and snapshot
  providers must match exactly before accepting the historical fingerprint.
  Keep every other malformed or mismatched snapshot fail-closed, and do not
  rewrite the database merely to make discovery succeed.
- Validation:
  Start from a controller with no cached extension adapter. Assert a persisted
  Target-bound session is resumable, malformed or mismatched bindings fail
  closed, and the eligibility check does not launch the provider. Then run
  `go test ./packages/agent/daemon/runtime ./services/tuttid/service/agent`.
  Also cover new extension snapshots preserving `acp:*`, verified legacy
  empty-provider recovery, transitional open-provider/legacy-fingerprint
  recovery, registered or mismatched provider fallback rejection, CLI command
  projection for the recovered session, and runtime preparation after restart.
- References:
  [controller_session_registry.go](../../../packages/agent/daemon/runtime/controller_session_registry.go)
  [agent_runtime_adapter.go](../../../services/tuttid/agent_runtime_adapter.go)
  [service_session.go](../../../services/tuttid/service/agent/service_session.go)
  [session_runtime_snapshot.go](../../../services/tuttid/service/agent/session_runtime_snapshot.go)
  [agent-extensions.md](../../architecture/agent-extensions.md)

### An authorized observer loops unavailable while a session is resuming

- Symptom:
  A remote or local observer has a durable Agent session ID and passes
  authorization, but immediately receives `session not found` or
  `Unavailable`. Its caller reconnects rapidly even though Agent Host restores
  the provider session shortly afterward.
- Quick checks:
  Separate durable identity from the Controller registry. Confirm the session
  exists in canonical persistence while `Controller.Session` is temporarily
  absent, then correlate the observer attempt with the later Host
  `EnsureRuntimeSession`, runtime `Start`, or runtime `Resume`. If observation
  itself launches the provider, lifecycle authority is inverted.
- Root cause:
  A durable session record proves that work may be resumed; it does not prove a
  live provider or runtime registry entry exists after daemon restart. A
  one-shot `Controller.Subscribe` therefore turns a normal restore race into a
  transport failure, and caller reconnect loops cannot know when the local
  lifecycle owner has finished restoring ACP.
- Fix:
  Use `Controller.SubscribeWhenAvailable` when the consumer already has an
  authorized durable session identity and must observe the next live runtime.
  It waits on a per-session Controller notification and atomically subscribes
  with the initial state snapshot once `Start` or `Resume` registers the
  session. Keep provider launch and resume in Agent Host; the observation
  method must never call those lifecycle operations.
- Validation:
  Start the observation against a missing runtime, assert that it neither
  returns nor creates a session, then perform a real Controller `Resume` and
  verify the observer receives the initial state snapshot. Also cancel a
  missing-session wait and verify no waiter or runtime session remains, and
  cover concurrent observers under the race detector.
- References:
  [controller_stream.go](../../../packages/agent/daemon/runtime/controller_stream.go)
  [controller_stream_wait_test.go](../../../packages/agent/daemon/runtime/controller_stream_wait_test.go)

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
  but later edits changed its context. On Windows, leaving an absolute drive
  path in either a synthesized patch or an existing unified-diff header also
  violates Git's cwd-relative patch contract and can report that an untracked
  created file does not exist in the index.
- Fix:
  Canonicalize provider file-change metadata at the runtime adapter boundary
  before persistence, and canonicalize historical no-newline markers on read.
  AgentGUI must make synthesized paths and existing unified-diff headers
  relative to the patch cwd, using case-insensitive path identity for Windows.
  The daemon must preflight with `git apply --check` using the same execution
  options, return `invalid-patch` for syntax failures and
  `patch-does-not-apply` for state mismatch, and avoid mutating the worktree on
  either result.
- Validation:
  Cover leading-whitespace no-newline markers, historical activity projection,
  corrupt-patch preflight without mutation, worktree divergence, reverse
  application, cwd-relative Windows drive paths for synthesized and complete
  diffs, and the existing untracked-created-file behavior.
- References:
  [claude_sdk_activity.go](../../../packages/agent/daemon/runtime/claude_sdk_activity.go)
  [agentPatchMetadata.ts](../../../packages/agent/gui/shared/agentConversation/rules/agentPatchMetadata.ts)
  [git_patch.go](../../../services/tuttid/service/agent/git_patch.go)

### AgentGUI changed-files summary shows negative lines for a new file

- Symptom:
  The file-edit row reports additions, but the settled changed-files summary
  reports deletions, often matching the number of Markdown list items that
  begin with `-`. The worktree file itself is present and complete.
- Quick checks:
  Compare the final file's line count with the tool row, then inspect the
  canonical `turn.fileChanges.files[]` entry. A real unified diff has a hunk
  header such as `@@ -0,0 +1,13 @@`; a file body stored in `unifiedDiff` is
  malformed metadata, not a diff.
- Root cause:
  The summary projection used any non-empty `unifiedDiff` as a valid patch and
  counted every line beginning with `-` as a removal. Its content fallback also
  discarded blank lines, so the summary and tool row could use different line
  totals for the same write.
- Fix:
  Normalize `fileChanges` at the runtime and durable-payload boundaries: a
  created file's raw body becomes `newString`, while `unifiedDiff` is retained
  only when it has a real hunk. AgentGUI also requires a hunk before parsing
  historical payloads and shares the line-count helper with tool render data,
  so blank lines are counted consistently.
- Validation:
  Cover a created Markdown body containing list items and blank lines at both
  canonicalization boundaries, then run the Agent runtime and AgentGUI tests
  and typechecks.
- References:
  [tool_file_changes.go](../../../packages/agent/daemon/runtime/tool_file_changes.go)
  [tool_payload.go](../../../packages/agent/store-sqlite/canonical/tool_payload.go)
  [agentUnifiedDiff.ts](../../../packages/agent/gui/shared/agentConversation/components/tool-renderers/file-diff/agentUnifiedDiff.ts)
  [AgentTurnSummaryRow.tsx](../../../packages/agent/gui/shared/agentConversation/components/AgentTurnSummaryRow.tsx)

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

### Claude Code completes but the Turn has no Fork entry

- Symptom:
  A Claude Code Turn is settled and has assistant output, but AgentGUI does not
  offer Fork. The session capability reports `forkThroughTurn=false`, or its
  supported provider Turn list is empty even though the Claude transcript is
  readable. On a newly created Session, the same missing binding can make the
  completed reply roll back to the new-conversation screen with
  `provider turn was not durably accepted`.
- Quick checks:
  Compare the canonical Turn's `root_provider_turn_id` with the UUID of the
  matching root user message returned by the official Claude SDK
  `getSessionMessages` API. If they differ, inspect the live sidecar event
  sequence for `provider_turn_identity_resolved` and the canonical activity
  sequence for `root_provider_turn.started`. Do not infer identity from
  transcript position or substitute the canonical Tutti Turn ID.
- Root cause:
  The outbound user-message UUID is only a prompt correlation value. Claude
  Code may rewrite that UUID before persisting the transcript. Publishing the
  caller-generated value as canonical provider identity makes strict prefix
  verification correctly reject the Turn, which removes the Fork capability.
  The SDK can also omit the persisted root user echo from a successful live
  query. Activating on assistant output while waiting exclusively for that echo
  can deadlock when approval or user input occurs before result: the Provider
  waits for the user, the sidecar waits for result-time recovery, and the Host
  waits for durable acceptance.
- Fix:
  Mark the next root prompt echo as causally expected before submitting it.
  Bind provider Turn identity from that observed root user-message UUID. Route
  every root assistant, stream, tool, approval, user-input, and result path
  through the shared single-flight identity barrier. Without an echo, resolve
  exactly one root user UUID and checkpoint through the official
  `getSessionMessages` transcript read with bounded cancellable retries.
  Emit `provider_turn_identity_resolved`, synchronously persist the acceptance
  binding in the Host, then publish canonical `root_provider_turn.started`
  before any interaction or streaming event. Never substitute the outbound
  correlation UUID.
  Keep historical Turns without observed provider identity fail-closed rather
  than guessing or backfilling them.
- Validation:
  Cover a query whose root user echo rewrites the outbound UUID. Assert
  `provider_turn_identity_resolved`, checkpoint, and terminal events all carry
  the persisted UUID. Cover successful assistant/result, approval,
  `AskUserQuestion`, and `ExitPlanMode` sequences with no root user echo.
  Assert canonical `root_provider_turn.started` is durable and ordered before
  every interaction, then verify Fork accepts the same identity. Restart the
  daemon/sidecar with an accepted incomplete Turn and confirm it is recovered
  without re-dispatch. Historical affected Turns remain intentionally
  non-forkable.
- References:
  [sessionRuntime.ts](../../../packages/agent/claude-sdk-sidecar/src/sessionRuntime.ts)
  [turnLifecycle.ts](../../../packages/agent/claude-sdk-sidecar/src/turnLifecycle.ts)
  [claude_sdk_execution.go](../../../packages/agent/daemon/runtime/claude_sdk_execution.go)
  [claude_sdk_events.go](../../../packages/agent/daemon/runtime/claude_sdk_events.go)

### Claude Code Fork fails after the action is clicked

- Symptom:
  Fork is available for a completed Claude Code Turn, but clicking it produces
  a failed operation. The durable operation becomes `unknown`, no target
  canonical Session is committed, and the target provider Session is absent.
- Quick checks:
  Inspect the latest `workspace_agent_session_fork_operations` row and query the
  target UUID with the official SDK `getSessionInfo` and
  `getSessionMessages`. If both are empty, check whether the sidecar used
  `query({forkSession: true})` with an empty prompt and treated
  `initializationResult()` as provider mutation completion.
- Root cause:
  Query initialization only completes the SDK/CLI handshake. Without a prompt,
  it does not durably create the requested child transcript. Unit tests can
  hide the defect if their fake marks the child created inside
  `initializationResult()`. A catch that replaces the original exception with
  a generic Fork error also erases whether failure occurred during source
  validation, provider mutation, or child verification.
- Fix:
  Use the official `forkSession(source, {upToMessageId, title})` transcript
  mutation. Accept its provider-generated child UUID, advertise the driver as
  non-deterministic, and let Host keep only the canonical target Session ID
  deterministic. Preserve the failure stage and original SDK reason.
  After provider mutation starts, any failure is `unknown` and must never be
  replayed.
- Validation:
  Exercise the official SDK with an in-memory SessionStore, including a Turn
  whose inclusive checkpoint ends in a system message. Verify the provider
  child is independently readable, root user UUIDs are remapped, the canonical
  child resumes by the returned provider Session ID, and a second Fork from
  that child succeeds. Cover pre-mutation `not_started`, post-mutation
  `unknown`, and Host's no-replay behavior for non-deterministic drivers.
- References:
  [sessionFork.ts](../../../packages/agent/claude-sdk-sidecar/src/sessionFork.ts)
  [sessionFork.test.ts](../../../packages/agent/claude-sdk-sidecar/src/sessionFork.test.ts)
  [claude_sdk_fork.go](../../../packages/agent/daemon/runtime/claude_sdk_fork.go)
  [session_fork.go](../../../packages/agent/host/session_fork.go)

### Fork reports only `agent_session_fork_conflict`

- Symptom:
  A through-Turn Fork returns HTTP 409 before any provider `thread/fork`
  request. Desktop diagnostics contain only
  `reason=agent_session_fork_conflict` or a developer-message length, so
  provenance, attachment, descendant-lane, and provider-Turn failures are
  indistinguishable.
- Quick checks:
  Read `error.params.forkBoundaryReason` from the 409 response or the promoted
  Desktop diagnostic `reason`. For example,
  `agent_session_fork_turn_sequence_unverified` means the selected Turn has
  unverified sequence provenance, while
  `agent_session_fork_prefix_sequence_unverified` identifies an earlier Turn
  in the inclusive prefix. The developer message carries the observed phase,
  provenance, sequence, or identity condition without message content.
- Root cause:
  `CheckSessionForkThroughTurn` collapsed every fail-closed boundary branch to
  `supported=false`; Host replaced it with one generic Turn-state error, and
  the service formatted the nested error with `%v`, which discarded the error
  chain before transport classification.
- Fix:
  Preserve one stable boundary rejection reason from the Store through Host
  and Service. Keep the public 409 reason
  `agent_session_fork_conflict` for compatibility, add the exact stable code
  as `error.params.forkBoundaryReason`, and promote that code only for Desktop
  diagnostics. Do not log transcript payloads or attachment contents.
- Validation:
  Cover unverified selected/prefix sequences, duplicate provider Turn IDs,
  descendant lanes, and session-local attachments at the Store. Verify Service
  wrapping preserves both the generic conflict and typed boundary error, the
  API includes the structured parameter, and Desktop promotes it to the
  diagnostic reason.
- References:
  [session_fork.go](../../../packages/agent/store-sqlite/session_fork.go)
  [session_fork_types.go](../../../packages/agent/store-sqlite/session_fork_types.go)
  [daemon_agent_session_fork.go](../../../services/tuttid/api/daemon_agent_session_fork.go)
  [desktopAgentActivityAdapter.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.ts)

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

### Claude Code follow-up, settings, or cancel-resend becomes silent

- Symptom:
  A completed Claude Code conversation accepts a follow-up but emits no SDK
  frames. Changing model, reasoning, or speed can time out and make later sends
  appear disabled. Canceling immediately after submit can leave the next send
  rejected as `provider_session_not_established` even though the provider
  Session exists.
- Quick checks:
  Compare the sidecar request with the SDK Query generation. A follow-up on the
  same quiet post-result generation, or `apply_settings` waiting inside that
  generation, identifies the idle-query path. For cancel-resend, compare the
  canonical Turn settlement with its durable provider-Turn binding; settlement
  before the binding explains `HasSettledTurn && !Established`.
- Root cause:
  A naturally completed SDK iterator was treated as a terminal Session, while
  follow-up and live settings reused or mutated the now-quiet Query. Separately,
  cancel could settle the canonical Turn before provider acceptance crossed the
  durable identity barrier. The frontend could then race another send against
  an unsettled settings write.
- Fix:
  Keep Session lifetime separate from Query-generation lifetime. Retire an idle
  post-turn Query and resume a fresh generation for the next prompt; serialize
  settings flag application with turn dispatch and retire the idle generation
  before a live settings mutation. The workspace Engine and composer gate both
  block send while the settings operation is unsettled. For cancel, carry the
  exact Turn ID to the sidecar and dispatch the native cancel before consulting
  acceptance state. The sidecar returns `pre_accept`, `provider_active`,
  `absent`, or `mismatch`: locally remove only an undispatched queue item; after
  dispatch, publish the canceled terminal only after the bounded Query shutdown
  protocol either receives the SDK interrupt acknowledgment or closes the owned
  transport and drains its consumer. Wait for the exact Turn's durable
  provider-acceptance outcome only for `provider_active`. Treat only `absent` as
  authoritative not-found; mismatch, unknown disposition, drain failure, and
  acceptance failure stay fail-closed.
- Validation:
  Cover follow-up resume, settings timeout/retry gating, exact targeted cancel,
  same-tick Goal cancellation, cancel before dispatch, interrupt acknowledgment,
  missing acknowledgment, interrupt failure, consumer-drain timeout, durable
  acceptance success and failure, mismatched/absent targets, and cancel followed
  by a new send. Native guidance must interrupt active tool work before enqueueing
  the steering prompt.
- References:
  [sessionRuntime.ts](../../../packages/agent/claude-sdk-sidecar/src/sessionRuntime.ts)
  [claude_sdk_execution.go](../../../packages/agent/daemon/runtime/claude_sdk_execution.go)
  [controller_exec.go](../../../packages/agent/daemon/runtime/controller_exec.go)
  [promptQueue.reducer.ts](../../../packages/agent/activity-core/src/engine/promptQueue.reducer.ts)
  [agentGuiComposerGate.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/model/agentGuiComposerGate.ts)

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
  `AgentGUIRuntime`, and each live event can make AgentGuiNode rebuild
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
  the old `runtime.events_emitted`/`runtime.async_events_emitted` names must not
  appear at the default level. Successful reconcile steps, message-page reads,
  ACP transport frames, and unchanged CuaDriver polls should appear only when
  debug logging is enabled. A streaming message-version change alone must not
  emit `agent.gui.node.render_state_changed` or
  `agent.gui.runtime.snapshot_changed`.
- Root cause:
  Per-token runtime events and renderer inline reconcile commits can produce
  thousands of diagnostic writes. Those writes compete with rendering and also
  inflate trace/log exports enough to obscure the actual session-switch work.
  A later AgentGUI refactor can reintroduce this problem by replacing turn
  summaries with per-batch logs or by adding message cursors to diagnostic
  change keys.
- Fix:
  Aggregate runtime emissions once per turn. Keep successful reconcile,
  message-page, and ACP frame diagnostics at debug. Build renderer snapshot and
  render-state keys from semantic lifecycle/interaction state rather than
  streaming cursors. Log unchanged permission-poll results at debug, and keep
  desktop log writes ordered through the asynchronous file writer.
- Validation:
  Reproduce a streaming turn at the default info level. Confirm each turn has
  at most one runtime emission summary, semantic render/snapshot diagnostics do
  not advance for token-only updates, and reconcile/ACP frame diagnostics are
  absent. Repeat with debug enabled when per-frame evidence is needed. Submit,
  reconcile, and protocol failures must remain visible.
- References:
  [controller_turn_exec.go](../../../packages/agent/daemon/runtime/controller_turn_exec.go)
  [workspaceAgentActivityReconcileBridge.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityReconcileBridge.ts)
  [desktopAgentRuntimeStateDiagnostics.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentRuntimeStateDiagnostics.ts)
  [useAgentGUISessionPresentation.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUISessionPresentation.ts)

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

### Imported long Turns show one disclosure per tool call

- Symptom:
  A long imported Codex or Claude Code execution shows many adjacent
  `1 tool call` disclosures instead of one grouped Turn, especially after
  opening or paging into the middle of the conversation.
- Quick checks:
  Inspect the affected `workspace_agent_messages` rows without printing
  payload text. If the user/tool/assistant rows all have `turn_id = NULL`, then
  compare the loaded page with the source transcript. A page that starts after
  the initiating user message cannot recover the Turn boundary locally.
- Root cause:
  The external importer historically used the turnless compatibility path for
  every message. AgentGUI can make a temporary presentation group when the
  leading user row is loaded, but that grouping cannot survive a page boundary;
  assigning each orphan row from its current page position would manufacture
  lifecycle identity in the renderer.
- Fix:
  At the provider transcript boundary, start a stable historical Turn from each
  retained real user message and carry it through following assistant and tool
  messages. Persist the messages with settled backfilled Turns atomically.
  The forward-only store migration repairs existing imported rows, while a
  later re-import applies the same identity to any still-turnless rows. Content
  before the first trustworthy user boundary remains turnless.
- Validation:
  Run `go test ./packages/agent/store-sqlite -run HistoricalImport`, then
  `cd services/tuttid && go test ./service/agent -run
'ServiceImportsExternalAgentSessionsByProject|ServiceReimportRepairsLegacyTurnlessExternalMessages'`.
- References:
  [external_import.go](../../../services/tuttid/service/agent/external_import.go)
  [activity_historical_import_turns.go](../../../packages/agent/store-sqlite/activity_historical_import_turns.go)
  [agent-gui-node.md](../../architecture/agent-gui-node.md)

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
  For Agent GUI rail projection changes, run
  `pnpm --dir packages/agent/gui exec vitest run --environment jsdom contexts/workspace/presentation/renderer/agentGuiConversationList/useAgentGuiConversationList.spec.tsx agent-gui/agentGuiNode/model/agentGuiConversationModel.spec.ts`.
  For Message Center grouping changes, run
  `pnpm --dir packages/agent/gui exec vitest run --environment jsdom agent-message-center/workspaceAgentMessageCenterModel.spec.ts agent-message-center/workspaceAgentMessageCenterViewModel.spec.ts`.
- References:
  [useAgentGuiConversationList.ts](../../../packages/agent/gui/contexts/workspace/presentation/renderer/agentGuiConversationList/useAgentGuiConversationList.ts)
  [workspaceAgentMessageCenterModel.ts](../../../packages/agent/gui/agent-message-center/workspaceAgentMessageCenterModel.ts)
  [workspaceAgentMessageCenterViewModel.ts](../../../packages/agent/gui/agent-message-center/workspaceAgentMessageCenterViewModel.ts)

### Realtime agent completion does not show unread attention

- Symptom:
  A turn settles while Agent GUI is open, but its conversation row never shows
  unread-completion attention. Historical sessions may behave correctly and
  must not acquire attention merely because their snapshot was loaded.
- Quick checks:
  Trace the event path into the activity engine. A realtime `turn_update`
  should enter as one atomic Turn projection. When the Session is cached, the
  same Engine transition must update the Turn and update or clear
  `Session.activeTurnId` without rewriting Session timestamps from the event
  envelope. Attention must observe the post-lifecycle canonical Turn, not the
  raw event. A delayed settled event may clear only the matching active Turn.
  The event should also request a state-only session reconcile with realtime
  provenance. Initial, restored, and imported history should enter through
  `session/snapshotReceived` only. Also confirm the projected desktop session
  carries the shared local Agent GUI user id used by read-state actions.
- Root cause:
  Realtime and historical data lost their provenance when both were folded into
  a mutable controller snapshot and re-emitted as `session/snapshotReceived`.
  The attention reducer correctly treats snapshots as non-live, so it recorded
  the settled completion without producing unread attention; a later live
  update with the same completion key could no longer recover the transition.
- Fix:
  Keep the activity engine as the single mutable owner. Feed pull/bootstrap
  results through `session/snapshotReceived`, and feed each realtime
  `turn_update` through one intent that atomically projects the Turn and cached
  Session reference. Reject a projection whose live/settled phase disagrees
  with `activeTurnId`; reconcile instead of applying half of the wire fact.
  Fence stale Session snapshots with canonical Turn versions rather than
  event-envelope time, and let attention consume only a Turn that the lifecycle
  reducer accepted.
  Keep the realtime marker on the follow-up reconcile so an uncached Session
  can hydrate and replay the latest Turn with live attention semantics. Use
  inline message events only for message deltas and one shared local identity
  for session projection and read-state commands.
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
  session fetch preserves `live: true` on the Engine's pending reconcile
  record before a retry.
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
  emits the live turn update. Carry realtime provenance on the Engine-owned
  reconcile command, merge it into in-flight demand, and restore it to pending
  demand after fetch failure until a live session is applied or the session is
  deleted. Hosts must not keep a parallel marker set.
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

### Shared Agent composer stays disabled after the target connects

- Symptom:
  A shared Agent target reaches `connected`, and diagnostics show submission
  readiness has recovered, but the entire composer remains disabled and cannot
  receive focus or input. This differs from an empty draft disabling only the
  send button.
- Quick checks:
  Inspect one rendered Composer gate snapshot. Its runtime, editor, and
  submission branches must agree: a ready submission cannot coexist with a
  target-connection runtime block. If logs instead compare fields from separate
  Composer and readiness projections, inspect view-model memoization before
  debugging P2P transport.
- Root cause:
  Connection and submission facts were projected into independent memoized
  slices. A missing dependency could retain the old target-connection block
  while publishing the new submission-ready value, and a downstream detail
  model then recombined those two render-time generations into a torn
  `composerDisabled` decision.
- Fix:
  Derive the canonical Composer gate once at the Session-presentation boundary.
  Keep editor editability, submission readiness/queue/blocking, and
  runtime-command availability in that one object, then pass it through one
  view-model slice to the editor, send button, shortcuts, Stop control, and
  Interaction paths. Keep draft-empty and upload conditions submission-local.
- Validation:
  Drive an exact shared target from `connecting` to `connected` and assert the
  same resulting snapshot reports runtime ready, editor editable, and
  submission ready. Also cover busy queue behavior, collaborator read-only
  behavior, and the invariant that submission ready never retains a runtime
  connection block.
- References:
  [agentGuiComposerGate.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/model/agentGuiComposerGate.ts)
  [useAgentGUISessionPresentation.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUISessionPresentation.ts)
  [useAgentGUIViewModel.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/model/useAgentGUIViewModel.ts)

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

### Claude Code keeps returning ConnectionRefused after network recovery

- Symptom:
  A Claude Code Turn loses network access while sending and eventually reports
  `API Error: Unable to connect to API (ConnectionRefused)`. After the machine
  network recovers, later sends in the same Session keep failing, while a newly
  created Claude Session succeeds.
- Quick checks:
  Correlate `agent_session.claude_sdk.lifecycle_event` by Agent Session and
  provider Session id. An SDK `system/api_retry` event now records
  `sdk_connection_error`, `sdk_retry_attempt`, `sdk_max_retries`, and
  `sdk_retry_delay_ms`. A terminal result should carry
  `sdk_result_is_error=true`; a numeric `sdk_api_error_status` instead points to
  an HTTP/auth/provider response rather than a connection failure.
- Root cause:
  The Claude Agent SDK owns one long-lived Query and Claude Code subprocess for
  streaming multi-Turn input. A connection failure can terminate the Turn while
  leaving that Query unsuitable for later requests. Reusing it preserves the
  bad per-process state even though host and VM networking have recovered.
  Older sidecars also treated every `result/subtype=success` as a completed
  Turn, ignoring the SDK's independent `is_error` flag.
- Fix:
  Preserve the failed Turn and its provider error. When the SDK terminal result
  explicitly reports a connection failure, revoke and close that Query. The
  next user send creates a fresh Query with `resume` set to the same provider
  Session id. Do not automatically resend the failed prompt because delivery
  may be ambiguous. Do not recycle the Query for a transient retry that
  eventually succeeds or for a terminal HTTP/authentication error.
  This SDK-owned `api_retry` behavior is separate from AgentGUI presentation.
  AgentGUI does not expose manual activation retry for a failed or canceled
  Session. If authentication rejects the first submit, Host preserves the
  failed history and discards that startup runtime; the auth notice offers
  login, after which the user starts a new conversation.
  Runtime discard keeps cleanup cancellation-independent but re-applies the
  caller's deadline. If the Claude sidecar does not acknowledge close in time,
  the adapter forcibly unregisters and closes the connection so a rejected
  startup cannot remain live in the runtime registry.
- Validation:
  Simulate `api_retry/error_status=null` followed by
  `result/is_error=true/api_error_status=null`, then send a second Turn. Require
  two Query generations, closure of the first, and `resume` on the second.
  Also prove that retry-then-success and HTTP 401 failures retain the existing
  Query. For rejected startup cleanup, block the sidecar close response and
  require teardown at the caller deadline with no retained runtime Session.
- References:
  [messageRouter.ts](../../../packages/agent/claude-sdk-sidecar/src/messageRouter.ts)
  [sessionRuntime.ts](../../../packages/agent/claude-sdk-sidecar/src/sessionRuntime.ts)
  [sessionRuntime.recovery.test.ts](../../../packages/agent/claude-sdk-sidecar/src/sessionRuntime.recovery.test.ts)

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

### Claude `/compact` finishes without a compaction divider

- Symptom:
  After Claude Code `/compact`, AgentGUI shows only the turn duration footer
  (for example `总用时 22 秒`) and never renders the
  `Compacting context` / `Context compacted.` divider. Context usage may still
  drop correctly.
- Quick checks:
  Confirm the provider is Claude Code SDK. Inspect the Claude transcript under
  `~/.claude/projects/.../<provider-session-id>.jsonl` for `compact_boundary`
  or `<local-command-stdout>Compacted`. Check tuttíd for a
  `claude-sdk:compact:<turnId>` system notice; if tokens fell but that notice is
  missing, the sidecar never published `compact_started`.
- Root cause:
  Claude Code 2.1.x often completes manual compaction without streaming
  `status:compacting` or `compact_boundary` to the query iterator (the boundary
  may exist only on disk, or arrive as `local_command` /
  camelCase `compactMetadata`). Compaction banners were driven only by those
  signals, so a silent success left no notice for AgentGUI to project. Even when
  the sidecar emits `compact_started` immediately on `/compact`, that assistant
  system notice arrives before provider-turn acceptance; the Claude acceptance
  gate previously treated it as premature provider output and dropped it. The
  daemon already settles an active compact notice when the turn closes; it needs
  a held `compact_started` (or an adapter-emitted running notice) first. Flushing
  those held events after acceptance must not re-observe their earlier provider
  input units: that either regresses the Replay cursor or coalesces conflicting
  `compaction.status` readiness onto the durable `turn.working` checkpoint.
- Fix:
  Emit a running compact notice from the Claude adapter when `/compact` is
  selected, allow compact system notices to precede provider-turn acceptance,
  accept `local_command` / `local_command_output` and camelCase boundary
  metadata in the sidecar, and map known failure copy to `compact_failed`
  before a successful result can settle the banner as completed. When the
  acceptance barrier later flushes held events, strip their
  `ProviderInputUnit` so they publish transcript/state only.
- Validation:
  Add daemon coverage that `/compact` banners stay held until durable
  acceptance, then flush without provider-input units; add sidecar coverage for
  silent `/compact` (result only), local_command failure, and camelCase
  `compactMetadata`. Re-run L04-CLAUDE recording and confirm the progress
  divider appears, then becomes `Context compacted.` (or the interrupted
  divider with the failure detail), and that record+replay both pass.
- References:
  [compaction.ts](../../../packages/agent/claude-sdk-sidecar/src/compaction.ts)
  [claude_sdk_execution.go](../../../packages/agent/daemon/runtime/claude_sdk_execution.go)
  [claude_sdk_turn.go](../../../packages/agent/daemon/runtime/claude_sdk_turn.go)
  [AgentMessageBlock.tsx](../../../packages/agent/gui/shared/agentConversation/components/AgentMessageBlock.tsx)

### Inactive Claude resume times out then later sends stay queued

- Symptom:
  On a large inactive Claude session, `/compact` or any send shows working then
  fails after ~30s with `engine command timed out` / tuttíd `context canceled`.
  Compact never runs. A later send shows 排队中 and never reaches tuttíd
  (`api.send.received` missing).
- Quick checks:
  Confirm `activeLiveState=inactive` and `resumable=true` before send. Order
  desktop `renderer_adapter.send.http_requested` → tuttíd
  `process_start.env_diagnostics` → `api.send.failed` (~30s, no
  `runtime.exec`). Check Claude transcript size under
  `~/.claude/projects/.../<provider-session-id>.jsonl`. After the timeout,
  inspect whether a second submit stamps `queued:true` without a daemon send.
- Root cause:
  `SendInput` blocks on `ensureRuntimeSession` / Claude `Resume`→`Start` until
  the sidecar emits `session_started`. On restore, the sidecar previously
  awaited `query.getContextUsage()` before that event; the SDK call has no
  timeout and has hung for minutes. The Engine then treated the client send
  timeout as `uncertainDelivery`, which blocks all queue drain and prevents
  remove/send-now of the timed-out head, so later prompts stay visible as
  排队中 forever even after reconcile finds no delivery proof.
- Fix:
  Emit `session_started` before the restore usage snapshot, and refresh usage
  in the background (same as turn completion). Keep queue send timeout at 90s
  inside the 120s confirmation window as defense in depth. When an owned
  `queue:reconcile:*` completes without exact turn proof, drop the timed-out
  prompt (definitive non-delivery) or release uncertainty into a retryable
  failed head so later queued work can drain.
- Validation:
  Sidecar coverage that restore `start()` reaches `session_started` while
  `getContextUsage` never resolves, then still emits `usage_updated` after
  resolve. `promptQueue.reducer` coverage for owned reconcile without turn
  proof. Manually: open a large inactive Claude session, send `/compact`,
  confirm Resume completes without waiting on usage and later messages are not
  stuck behind uncertain delivery.
- References:
  [sessionRuntime.ts](../../../packages/agent/claude-sdk-sidecar/src/sessionRuntime.ts)
  [compaction.ts](../../../packages/agent/claude-sdk-sidecar/src/compaction.ts)
  [promptQueue.reducer.ts](../../../packages/agent/activity-core/src/engine/promptQueue.reducer.ts)
  [promptQueue.ownedReconcile.ts](../../../packages/agent/activity-core/src/engine/promptQueue.ownedReconcile.ts)
  [promptQueue.drainDecision.ts](../../../packages/agent/activity-core/src/engine/promptQueue.drainDecision.ts)
  [lifecycle.go](../../../packages/agent/host/lifecycle.go)
  [claude_sdk_lifecycle.go](../../../packages/agent/daemon/runtime/claude_sdk_lifecycle.go)

### AgentGUI compaction timer keeps running after compaction completed

- Symptom:
  AgentGUI continues to show an increasing `Compacting context` duration after
  the provider finished compaction. The durable compaction message and Turn are
  already terminal, but the mounted renderer still projects the earlier
  `noticeCommandStatus=running` snapshot.
- Quick checks:
  Compare the message-list requests in desktop reconcile diagnostics with the
  durable message versions. If the renderer pulled a running compaction at
  version N, missed its terminal update at N+1, then next requested
  `afterVersion` at a much higher value, the local cache advanced across a
  version hole. Confirm that the terminal row uses the same `messageId`; a new
  compaction row or a timer-specific state bug is a different failure.
- Root cause:
  The realtime bridge treated the maximum version of materialized message rows
  as a contiguous acknowledged change cursor. After an event-stream loss, it
  applied a later inline message and advanced that maximum past the missed
  terminal mutation. Every later `afterVersion` pull then started beyond the
  mutation, so the authoritative completed snapshot could never repair the
  cached running snapshot. The timer correctly kept rendering the stale running
  lifecycle.
- Fix:
  Before folding realtime messages inline, compare only their unseen versions
  with the cached high-water boundary. If the first unseen version is not the
  next cursor, do not apply any of that event's messages; retain the old cursor
  and request an authoritative incremental reconcile. After a disconnected
  event stream reconnects, also incrementally reconcile every session whose
  messages are already cached; otherwise a missed final mutation has no later
  event that can reveal its gap. Do not require the materialized cache itself to
  contain every historical cursor value, because mutable message rows replace
  older versions.
- Validation:
  Cache a user message and a running compaction, omit the next terminal
  compaction mutation, then deliver a later assistant message. Assert that the
  later message is not applied inline, reconciliation requests from the
  pre-gap cursor, and the stable compaction `messageId` becomes completed from
  the authoritative response. Also cover valid snapshot gaps already present in
  the cache plus duplicate and stale event delivery. Finally, omit the terminal
  mutation as the last event, disconnect and reconnect without another activity
  event, and verify the reconnect reconcile retrieves it from the pre-disconnect
  cursor.
- References:
  [workspaceAgentActivityReconcileBridge.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityReconcileBridge.ts)
  [sessionReconcileExecutor.ts](../../../packages/agent/activity-core/src/sessionReconcileExecutor.ts)
  [agent-gui-node.md](../../architecture/agent-gui-node.md)

### Root detail reconciliation repeatedly reloads unchanged child transcripts

- Symptom:
  Opening or reconciling one root conversation repeatedly issues message-list
  requests for every known child Session, including assistant-only and
  tool-only children whose durable messages have not changed.
- Quick checks:
  Compare each child Session's required `messageVersion` from both root-detail
  reads with the largest cached message version that also has a durable
  `sequence`. If the cache is current but the request still starts at zero,
  inspect whether child reconciliation reused the root conversation's
  user-message boundary heuristic.
- Root cause:
  The root heuristic intentionally returns zero when cached history has no user
  message, so it can repair an incomplete root conversation. Applying that
  heuristic to provider-native child Sessions makes ordinary assistant/tool
  histories look permanently unhydrated and forces the same reads forever.
- Fix:
  Keep root and child cursor policies separate. For a child, derive the cursor
  only from durable sequenced messages and skip its message request when that
  cursor has reached the Session `messageVersion`. Preserve the bounded
  newest-first initial read, but treat an existing empty child window as the
  authoritative zero cursor and drain later messages from `afterVersion=0`.
  After the first message pass, read root detail again and incrementally fetch
  newly discovered children plus existing children whose `messageVersion`
  advanced during the pass. Do not let optimistic/transient rows advance the
  durable cursor, and do not add polling; later changes arrive through the
  existing push-and-reconcile path.
- Validation:
  Cover assistant-only and tool-only child caches, a transient row with a higher
  synthetic version, an unchanged child that performs no request, initial
  newest-first hydration, an empty known child that gains more than one page,
  and a child advancing between the two detail reads. Keep a root assistant-only
  case proving its existing repair still reads from zero.
- References:
  [workspaceAgentActivityReconcileBridge.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityReconcileBridge.ts)
  [sessionReconcileExecutor.ts](../../../packages/agent/activity-core/src/sessionReconcileExecutor.ts)

### Completed agent output appears only after switching Sessions

- Symptom:
  A Turn finishes in the daemon, but the active AgentGUI timeline does not show
  the final assistant output until the user selects another Session and returns.
  This is especially visible after an edit-retry replacement Turn.
- Quick checks:
  Follow one exact `(workspaceId, agentSessionId, turnId)` through durable
  `turn_update` publication, the business-event WebSocket, and
  `WorkspaceAgentActivityReconcileBridge`. Distinguish a daemon publication
  gap from a disconnected/stale subscription and from a renderer event that
  updated Turn state without requesting authoritative messages. Compare the
  cached message cursor with `listWorkspaceAgentSessionMessages`.
- Root cause:
  A terminal Turn event can be delivered while its final message event is
  missed, reordered, or not folded into the active cache. Session navigation
  performs a detail/message hydration and therefore hides the missing
  reconcile trigger.
- Fix:
  Treat realtime events as hints. Every terminal `turn_update` requests one
  combined state-and-message reconcile through the existing workspace engine.
  An accepted edit-retry completion or recovery command remains `reconciling`
  and blocks another edit until the same authoritative detail reconciliation
  confirms its revision and recovery state. Never replace canonical
  availability with recovery actions inferred by Desktop. Do not add a second
  WebSocket, component store, or edit-retry-specific polling loop.
- Validation:
  Deliver a settled `turn_update` without the corresponding final
  `message_update`; assert that the bridge fetches messages and updates the
  mounted timeline without Session navigation. Repeat after edit retry and
  after a transient reconcile failure.
- References:
  [workspaceAgentActivityReconcileBridge.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityReconcileBridge.ts)
  [workspaceAgentEditRetry.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentEditRetry.ts)
  [agent-gui-node.md](../../architecture/agent-gui-node.md)

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

### Claude Goal completes but the UI remains active

- Symptom:
  Claude finishes the requested work and its session JSONL contains an
  `attachment.type=goal_status` row with `met=true`, but Tutti emits no
  `goal_observed`; durable desired and observed Goal state remain active.
- Quick checks:
  Correlate the Tutti Session with the Claude provider Session ID. Inspect the
  provider transcript for the final `goal_status` attachment, then check dev
  logs for a matching sidecar `goal_observed`. Do not infer Goal completion
  from a successful root result or from a successful Stop hook process.
- Root cause:
  Local Claude Agent SDK `SDKMessage` streams through `0.3.222` omit transcript
  attachments. `SDKActiveGoalMessage` is also absent from the public
  `SDKMessage` union, and local Claude Code only publishes `active_goal` on its
  remote path. A test that manually yielded `type=attachment` therefore proved
  the projection but not the real SDK boundary.
- Fix:
  Locate the provider transcript from root `system/init.session_id + cwd`
  using the pinned SDK's project-key algorithm. Start restored Sessions from
  their already known provider Session ID. Keep
  `SessionStart.transcript_path` as an exact-path auxiliary signal, not the
  required trigger. Read only newly appended complete JSONL rows, forward only
  `goal_status` attachments through the existing Goal projection, drain before
  root Turn completion, and keep following after the SDK result because the
  native evaluator can flush its terminal row slightly later. Late evidence
  retains the latest settled root Turn identity. Do not parse evaluator hook
  stdout and do not configure an alpha `SessionStore` solely for this signal;
  both change a larger and less reliable boundary.
- Validation:
  Run a query fixture whose SDK iterator emits root `system/init`, the root
  user message, and result. Reproduce the observed ordering where transcript
  `met=false` precedes `turn_completed` and `met=true` lands afterward; require
  the late completion to retain the original Turn identity. Also cover resume
  without another init, delegated init exclusion, watcher cleanup,
  historical-row skipping, partial JSONL rows, and repeated-drain
  deduplication.
- References:
  [goalTranscript.ts](../../../packages/agent/claude-sdk-sidecar/src/goalTranscript.ts)
  [messageRouter.ts](../../../packages/agent/claude-sdk-sidecar/src/messageRouter.ts)
  [Anthropic SDK issue #336](https://github.com/anthropics/claude-agent-sdk-typescript/issues/336)

### Accepted Goal clear is sent repeatedly until convergence times out

- Symptom:
  One `/goal clear` produces repeated provider control requests at the Goal
  worker interval. Each request is accepted, but the durable operation remains
  `dispatched` with provider phase `accepted`, its attempt count keeps rising,
  and it eventually fails with `accepted goal operation exceeded its
convergence deadline`.
- Quick checks:
  Correlate logs by `agent_session_id`, operation ID, and Goal revision. Verify
  there is one user control audit but multiple provider `action=clear` calls.
  Inspect `workspace_agent_goal_control_operations`: an accepted operation with
  increasing attempts and unchanged accepted evidence identifies Host replay,
  not repeated user input.
- Root cause:
  The steady-state Goal worker treated clear's provider idempotence as
  permission to resubmit an already accepted command. Acceptance had already
  crossed the delivery boundary, so every later worker claim queued another
  native clear command while the Host was supposed to wait for applied
  lifecycle evidence.
- Fix:
  For every accepted Goal mutation, make the steady-state worker defer without
  calling the provider again. Keep the convergence deadline so missing applied
  evidence still terminates. Reserve replay for startup crash recovery and
  gate it with the adapter recovery policy; query-incapable adapters may replay
  an idempotent clear once, while unsafe set replay remains rejected.
- Validation:
  Return `accepted` from a clear, advance the worker clock past its next claim,
  and step the steady-state worker. The provider call count must remain one,
  while the operation stays pending and `applying`. Existing deadline coverage
  must still fail a lost-evidence operation without another provider call.
- References:
  [goal_operation_worker.go](../../../packages/agent/host/goal_operation_worker.go)
  [goal_scenarios.go](../../../packages/agent/host/conformance/goal_scenarios.go)

### Replaced Goal banner keeps the previous objective

- Symptom:
  A second `/goal <objective>` is accepted and runs, but AgentGUI continues to
  show the first objective. The Goal state table contains the second objective
  at a newer revision while `workspace_agent_sessions.session_metadata_json`
  or a runtime Session snapshot still contains the first.
- Quick checks:
  Compare `workspace_agent_session_goals.desired_json`, `revision`, and
  `updated_at_unix_ms` with the Session metadata Goal. Confirm that the second
  Goal operation completed before attributing the mismatch to React rendering.
- Root cause:
  Durable Goal state and provider Session metadata update on different
  schedules. Session reads previously exposed the provider metadata Goal and
  attached only `goalSyncState`, so a later Session reload could overwrite the
  correct Goal Control response with an older objective.
- Fix:
  Project Host-owned durable Goal state and its update timestamp onto every
  single and batch Session read. Use `desired` while convergence is unresolved,
  use `observed` after synchronization, and honor the durable tombstone.
- Validation:
  Read a Session whose metadata contains objective A beside durable Goal
  revision N+1 containing objective B. Single and batch projections must return
  B with a Session timestamp at least as new as the Goal state. A durable
  tombstone must return no Session Goal; a synchronized terminal observation
  must remain terminal instead of reverting to active `desired` state.
- References:
  [service_turns.go](../../../services/tuttid/service/agent/service_turns.go)
  [goal_state.go](../../../packages/agent/store-sqlite/goal_state.go)

### Cleared Goal reappears as a newer provider-authored Goal

- Symptom:
  Goal clear returns success and briefly shows “目标已移除”, but the active Goal
  banner returns. The Goal table contains a completed clear followed by a new
  provider-adoption `set` revision for the same objective. In a projection-only
  variant, the table remains tombstoned with no later `set`, while the banner
  still shows the pre-clear Goal.
- Quick checks:
  Correlate `workspace_agent_session.goal_control.completed action=clear` with
  `agent_session.app_server.goal.provider_adopted`. If adoption was scheduled
  before clear but completed immediately after it, inspect the adoption's
  expected revision and the canonical revision committed by clear.
  If no later adoption exists, inspect the Goal Control response: `goal` must
  be present as `null`, and its embedded `session.goal` must also be null.
- Root cause:
  Provider Goal adoption runs off the app-server read loop. An observation
  captured before clear could wait behind the serialized Goal actor; the old
  implementation read the revision only after acquiring that actor, so the
  delayed observation was mistaken for a new provider-authored Goal and
  cleared the tombstone.
  The projection-only variant made nullable `goal` optional on the wire. Go
  therefore omitted a successful clear, the client fell back to a stale
  runtime `session.goal`, and the Engine promoted that stale field after the
  operation settled.
- Fix:
  Capture the canonical Goal revision while scheduling provider adoption and
  carry it through the runtime, Host, and store boundary. The store compares
  it with the current revision inside the same transaction that would advance
  the Goal. Mutable progress snapshots from an already owned provider Goal
  bind to that Goal's current operation identity instead of entering adoption.
  Goal Control responses require a nullable `goal`, project the Host result
  onto `session.goal`, and let the Engine normalize a synced Session from that
  same authoritative field.
- Validation:
  Block provider adoption after it captures revision N, complete clear at
  revision N+1, then release adoption. It must fail as superseded, leave the
  Goal tombstoned at N+1, create no later `set` operation, and keep the runtime
  Goal banner empty. Also return a synced clear beside a deliberately stale
  Session Goal; JSON must contain `"goal": null`, and the Engine presentation
  must remain empty.
- References:
  [goal_provider_adoption.go](../../../packages/agent/host/goal_provider_adoption.go)
  [codex_appserver_provider_goal_adoption.go](../../../packages/agent/daemon/runtime/codex_appserver_provider_goal_adoption.go)
  [daemon_agent_sessions_goal.go](../../../services/tuttid/api/daemon_agent_sessions_goal.go)
  [sessionGoalControl.validation.ts](../../../packages/agent/activity-core/src/engine/sessionGoalControl.validation.ts)

### Goal loops after pause/resume and never reaches complete

- Symptom:
  Pause and resume succeed, the Goal keeps producing continuation Turns, and the
  model may even emit the final marker text, but `thread/goal/updated` never
  reaches `status=complete`. Logs show a `continuation_nudge` after a brief
  inter-turn idle, then an unbounded stream of adopted Goal Turns.
- Quick checks:
  Compare the nudge `thread/goal/set` params with the original set. If the nudge
  re-sends `objective`, Codex may restart Goal work instead of letting the
  current generation settle. Confirm pause/resume ops completed and the durable
  generation fingerprint is still owned by the set/adoption operation.
- Root cause:
  Pause/resume intentionally keep generation ownership on the set-time
  fingerprint while advancing the live operation identity. Provider
  `status=complete` for that fingerprint was classified as superseded
  (`binding.identity != current`), so local goal state stayed `active`. The
  per-turn continuation nudge then re-sent `thread/goal/set` with
  `status=active` and revived the finished Goal.
- Fix:
  Treat provider progress for the session's current generation fingerprint as
  known-current after pause/resume (while the Goal is still present). Keep
  nudges status-only, do not re-bind generation on pause/resume/nudge, and do
  not schedule a delayed nudge from Resume itself.
- Validation:
  Record a short one-digit-per-turn Goal, pause after the first digit, resume,
  and verify the provider reaches `complete` with the final marker and no
  post-complete continuation storm.
- References:
  [codex_appserver_goal.go](../../../packages/agent/daemon/runtime/codex_appserver_goal.go)
  [codex_appserver_adapter_goal_lifecycle_test.go](../../../packages/agent/daemon/runtime/codex_appserver_adapter_goal_lifecycle_test.go)

### Goal resume fails with permanently ambiguous generation fingerprint

- Symptom:
  Pause succeeds and the banner shows Resume, but clicking Resume fails. Logs
  show `persist goal provenance: provider goal generation fingerprint is
permanently ambiguous`. Provider status may already be `active` while the
  Host operation stays failed and no continuation Turn starts.
- Quick checks:
  Correlate the pause and resume durable operation IDs with
  `workspace_agent_goal_generation_fences` for the same fingerprint. Confirm the
  set/adoption that created the Goal already owns that fingerprint. Inspect
  Codex `thread/goal/set` pause/resume responses for a returned Goal payload.
- Root cause:
  Pause and resume are status-only controls that reuse the set-time provider
  generation. Re-binding that fingerprint to the pause/resume operation id
  collides with the set binding and marks the fingerprint permanently
  ambiguous, failing closed before the local status mirror and continuation
  nudge run.
- Fix:
  Keep generation binding on durable set/adoption only. For pause/resume, mirror
  the provider or local Goal status without calling `bindGoalGeneration`.
- Validation:
  With a durable provenance sink, set → pause → resume with distinct operation
  ids and the same generation fingerprint. Resume must succeed, status must be
  `active`, and the fingerprint must remain owned by the set operation.
- References:
  [codex_appserver_goal.go](../../../packages/agent/daemon/runtime/codex_appserver_goal.go)
  [codex_appserver_goal_provenance.go](../../../packages/agent/daemon/runtime/codex_appserver_goal_provenance.go)
  [codex_appserver_adapter_goal_recovery_test.go](../../../packages/agent/daemon/runtime/codex_appserver_adapter_goal_recovery_test.go)

### Goal disappears after pause or resume

- Symptom:
  Pause or resume succeeds, but the Goal banner disappears while the durable
  Goal still exists.
- Quick checks:
  Compare the Goal Control response's top-level `goal` with `state.desired`,
  `state.observed`, and `state.tombstoned`. If `observed` is empty but
  `desired` remains populated and not tombstoned, the provider supplied no
  current observation; it did not clear the Goal.
- Root cause:
  The response projected the provider's per-action observation as the visible
  Goal. Some providers can apply pause or resume while returning no Goal
  observation, so the required nullable response serialized that absence as an
  explicit clear.
- Fix:
  Host returns the durable desired projection as `GoalControlResult.Goal` and
  keeps provider output in `GoalState.Observed`. The daemon only maps that
  Host-owned result. Empty observation may produce `diverged` state, but only a
  durable tombstone produces `goal: null`.
- Validation:
  Set a Goal, make the provider return no Goal for pause and resume, and verify
  both responses retain the objective with the expected paused/active status,
  report divergence, and carry no pending operation.
- References:
  [goal_control.go](../../../packages/agent/host/goal_control.go)
  [goal_scenarios.go](../../../packages/agent/host/conformance/goal_scenarios.go)
  [daemon_agent_sessions_goal.go](../../../services/tuttid/api/daemon_agent_sessions_goal.go)

### Revoked shared Goal starts again after handoff or desktop restart

- Symptom:
  After a shared binding is revoked, the old Goal starts or resumes provider
  work, may replace the Owner's newer Goal, or an unrelated active Turn is
  canceled.
- Quick checks:
  Resolve the original Goal operation by its stable `clientSubmitId`. Inspect
  `workspace_agent_goal_generation_fences` for the exact operation ID, revision,
  and repair epoch. `pending` or `processing` means Host still owns delivery;
  absence means the revocation was never durably accepted. For any canceled
  Turn, compare all three immutable `source_goal_*` fields with the fence.
- Root cause:
  Revocation was treated as a one-shot notification, or code guessed that the
  session's current active Turn belonged to the revoked binding. A failed
  notification was lost on restart, and recovery could replay the old prepared
  Goal before runtime learned the revocation.
- Fix:
  Persist an exact Goal-generation fence before provider delivery. Process
  fences before Goal operations during startup and each worker tick. Restore
  all durable fences when a provider session resumes, and retain the exact set
  in the runtime Controller across idle connection release so a replacement
  adapter is fenced before its first user operation. Never resume an offline
  provider solely for background fence or cancel delivery. Prepare the local
  clear with the target revision as a compare-and-swap guard, and call
  `CancelTurn` only for a live canonical Turn whose operation ID, revision,
  and repair epoch all match. Keep the fence pending after cancellation
  acceptance until the Turn is canonically terminal.
- Validation:
  Cover failed delivery followed by restart, a pending target operation and
  fence recovered together, a newer Owner Goal, repeated runtime ensure, and
  matching versus unrelated active Turns. Simulate connection replacement and
  prove fence reinstallation happens before provider dispatch. Simulate a
  disconnect immediately before cancel and prove background recovery makes
  zero provider Resume calls. Provider tests must prove that the exact
  Codex/Claude generation never becomes canonical while later generations
  remain admissible.
- References:
  [Agent Host contracts](../../../packages/agent/host/README.md)
  [Agent Goal Control Design](../../specs/2026-07-15-agent-goal-control-design.md)
  [goal_generation_fence.go](../../../packages/agent/host/goal_generation_fence.go)

### Initial Goal prompt disappears when the Agent starts responding

- Symptom:
  A new conversation opened with `/goal <objective>` first shows the submitted
  command, then removes it as soon as the durable session or the first provider
  response arrives. The response and processing state remain visible.
- Quick checks:
  Compare the optimistic activation message with the durable
  `session_audit`. Verify both carry the same `clientSubmitId` and inspect the
  transcript projection after the overlay removes the optimistic twin. If the
  durable Goal audit is filtered from all presentation output, the replacement
  leaves no visible row.
- Root cause:
  The optimistic activation was projected as an ordinary user message while
  the canonical Goal control was correctly persisted as a session-level audit.
  Overlay reconciliation removed the optimistic message by `clientSubmitId`,
  then the message projector discarded the durable audit, so two individually
  correct policies composed into a disappearing row.
- Fix:
  Mark the optimistic activation as Goal control when
  `initialGoalControl` is present. Project both optimistic and durable forms as
  a dedicated `goal-control` row outside the Turn model. Derive the row identity
  from the audit payload's client-submit message identity before falling back
  to the durable operation ID, so replacement preserves the renderer key.
- Validation:
  Project the optimistic-only state and the durable-after-overlay state. Both
  must contain one `goal-control` row with the same ID and zero Turns. Also
  verify the dedicated row renders, the first real provider Turn remains the
  sole Turn, and reload produces the same control row.
- References:
  [workspaceAgentMessageOverlay.ts](../../../packages/agent/gui/shared/workspaceAgentMessageOverlay.ts)
  [workspaceAgentMessageProjection.ts](../../../packages/agent/gui/shared/agentConversation/projection/workspaceAgentMessageProjection.ts)
  [workspaceAgentTimelineCanonical.ts](../../../packages/agent/gui/shared/workspaceAgentTimelineCanonical.ts)

### Goal clear duplicates the live Agent work section

- Symptom:
  While a Goal Turn is still streaming, clicking clear inserts `/goal clear`
  between two identical Agent work sections. Both sections continue updating
  together even though the daemon executed only one Turn.
- Quick checks:
  Inspect canonical Turns and message ownership. If Agent messages on both
  sides of the turnless Goal audit carry the same Turn ID, compare transcript
  group keys before inspecting provider retries or duplicate persistence.
- Root cause:
  Chronological insertion produced `Turn T -> goal-control -> Turn T`. A
  grouping pass treated the turnless row as a hard boundary and created two
  groups with key `T`; the work-section map retained the later model for that
  shared key, so both Turn positions rendered the same rows.
- Fix:
  Keep a turnless session row inside the current presentation group only when
  the next lifecycle-owned row proves that the surrounding Turn ID is
  unchanged. Preserve the session row's null Turn ID; presentation continuity
  must not manufacture lifecycle ownership.
- Validation:
  Cover `T -> goal-control -> T` and assert one Turn group, one processed-time
  section, one Goal control row, and one copy of each Agent row. Also cover
  `T1 -> goal-control -> T2` and verify the Goal control remains an independent
  orphan between different Turns.
- References:
  [agentTranscriptModel.ts](../../../packages/agent/gui/shared/agentConversation/components/agentTranscriptModel.ts)
  [AgentTranscriptView.tsx](../../../packages/agent/gui/shared/agentConversation/components/AgentTranscriptView.tsx)

### Recording fails when a tool message contains its runtime CWD

- Symptom:
  Recording finalization fails with `expected_state_export_failed` and reports
  an absolute path at `$.agent.sessions[*].messages[*].payload.input.cwd`.
  The provider tape may already be complete.
- Quick checks:
  Inspect the failed Recording row and the matching canonical tool message.
  Distinguish the normalized tool envelope's direct `input.cwd` from a
  tool-owned nested argument.
- Root cause:
  The provider tape tokenizes the Session CWD, but the semantic-state adapter
  previously copied the canonical tool message unchanged. The direct
  `input.cwd` is provider runtime context, not part of Tutti's portable
  semantic state.
- Fix:
  Project the Agent graph before semantic-state validation. Remove only the
  runtime `input.cwd` fields from normalized `tool_call` messages and
  Interaction envelopes, including the normalized
  `toolCall.input.cwd`. Convert an absolute executable prefix in normalized
  command/title display fields to its basename. Do not branch on tool name,
  recursively remove tool-owned arguments, mutate canonical messages, or
  weaken the absolute-path validator.
- Validation:
  Capture a tool message and matching Interaction with absolute normalized
  runtime CWDs and executable prefixes, plus a nested relative
  `arguments.cwd`. Require capture and validation to succeed, retain the
  tool-owned nested argument, and prove the source Agent graph remains
  unchanged.
- References:
  [state.go](../../../services/tuttid/biz/agentsessionreplay/state.go)
  [agent_session_replay_state.go](../../../services/tuttid/data/workspace/agent_session_replay_state.go)

### Cassette replay loses the provider session before the second stimulus

- Symptom:
  Replay reaches checkpoint 1, then a later `session.send` fails with
  `provider session was never established`. The replay error also reports that
  an outbound write arrived while a recorded stdout chunk was next.
- Quick checks:
  Inspect `provider/frames.jsonl` around the reported chunk. If a provider
  notification immediately follows a successful request response and precedes
  the next outbound request, compare the reader and writer goroutine timing.
- Root cause:
  The process cassette encoded the provider byte-stream order, but replay
  treated that order as a required Go goroutine schedule. A writer could run
  before the reader consumed an already-recorded notification, so normal
  concurrency was rejected as a transport mismatch and provider startup was
  torn down.
- Fix:
  When the next recorded chunk is inbound, block the replay write until the
  receive path consumes it. Continue strict payload validation when the next
  recorded outbound chunk becomes current.
- Validation:
  Start a replay stream with `outbound -> stdout -> outbound`. Launch the
  second send before receiving stdout; it must wait, then succeed after the
  receive. Keep mismatch, pause, fast-forward, close, and full runtime tests
  passing.
- References:
  [process_transport_replay.go](../../../packages/agent/daemon/runtime/process_transport_replay.go)
  [process_transport_cassette_test.go](../../../packages/agent/daemon/runtime/process_transport_cassette_test.go)

### Continue-session replay sends initialize before the recorded turn

- Symptom:
  A restored replay Session reaches prompt dispatch, then fails with
  `process cassette outbound mismatch`: the expected request is `turn/start`
  or `session/prompt`, while the actual request is `initialize`. A second form
  has the same expected and actual `turn/start`, but the actual request is
  missing a provider-derived field such as Codex `collaborationMode`.
- Quick checks:
  Inspect `provider/manifest.json` and the first outbound frame for the failed
  connection. If recording started on a Session that was already live, its
  `captureOrigin` must be `attached-live-connection`.
- Root cause:
  Continue-session recording attached to an initialized provider connection,
  so its tape correctly began at the next business request. Replay started a
  new virtual connection but treated every tape as `process-start`, causing the
  adapter to repeat initialization and provider-session resume traffic that
  was outside the captured boundary. If initialization is already skipped but
  a provider-derived field is missing, the semantic `initial-state.json`
  dropped the protocol checkpoint while projecting the canonical historical
  Session graph.
- Fix:
  Persist the connection capture origin in provider tape schema v3. For an
  attached live connection, restore the provider adapter's protocol checkpoint
  through the historical Session's narrow `providerResumeCheckpoint` and skip
  only the initialization and provider-session bootstrap. Do not export the
  full private runtime context and do not infer missing state from the first
  tape frame. Keep strict matching on the first captured business request.
- Validation:
  Record a Codex and Cursor Turn after arming capture on an existing live
  connection. Recreate each adapter over replay transport, resume the
  historical Session, execute the same Turn, and require complete tape
  consumption. The regression must cross semantic state JSON capture and Host
  restore; a test that copies an in-memory runtime context directly into the
  replay Session does not cover the product boundary. Also keep new-session
  cold bootstrap tests passing.
- References:
  [process_cassette.go](../../../packages/agent/daemon/runtime/process_cassette.go)
  [codex_appserver_session.go](../../../packages/agent/daemon/runtime/codex_appserver_session.go)
  [standard_acp_session.go](../../../packages/agent/daemon/runtime/standard_acp_session.go)

### Cassette replay reports a false final Session state mismatch

- Symptom:
  Every recorded stimulus succeeds, but final replay validation reports an
  exact path such as `$.agent.sessions[0].messages[0].id` or a Tutti Mode
  snapshot `turnId`.
- Quick checks:
  Inspect `expected-state.json` and capture the actual typed semantic state.
  Confirm that Turns and Messages were captured in canonical sequence rather
  than UUID order, and that every reference points to the corresponding
  structural object.
- Root cause:
  Replay legitimately regenerates Turn, assistant Message, interaction, and
  product-object IDs. Comparing those raw values, or ordering related arrays by
  random UUID, mistakes alpha-equivalent semantic graphs for drift. Message
  payload `seq` is also runtime timing metadata rather than a semantic oracle.
- Fix:
  Keep original IDs in `initial-state.json` so Host can restore resumable
  history. For final verification, alpha-normalize structural IDs and all their
  references after ordering entities by canonical sequence; omit runtime-only
  payload sequence values. Continue to compare semantic content exactly.
- Validation:
  Cover regenerated Turn and Message IDs, changed payload sequence values, and
  a real semantic content mismatch. Run both create-session and continue-session
  current-build record/replay loops.
- References:
  [run-agent-session-replay.mjs](../../../tools/scripts/run-agent-session-replay.mjs)
  [run-agent-session-replay.test.mjs](../../../tools/scripts/run-agent-session-replay.test.mjs)

### Replay aborts with `Promise was collected (-32000)`

- Symptom:
  A renderer intent has already started, but the temporary CDP runner aborts
  while awaiting its result. Provider replay then reports a partially consumed
  connection during shutdown.
- Root cause:
  Chromium may collect the remote Promise backing `Runtime.evaluate` while the
  renderer operation is still running. Retrying the renderer command directly
  can duplicate a non-idempotent intent.
- Fix:
  Register the invocation in the renderer by method and Activity Event ID
  before dispatch. On this CDP error, evaluate the same lookup again and await
  the stored result instead of invoking the command twice.
- Validation:
  Make the first CDP evaluation fail with `Promise was collected`; the second
  evaluation must reuse the identical invocation expression and complete the
  event exactly once.
- References:
  [run-agent-session-replay.mjs](../../../tools/scripts/run-agent-session-replay.mjs)
  [run-agent-session-replay.test.mjs](../../../tools/scripts/run-agent-session-replay.test.mjs)

### Cassette replay times out before a recorded queued Turn

- Symptom:
  Replay stops on `timed out waiting for renderer effect queue/sendPrompt`,
  leaves later activity events untouched, and consumes only the provider frames
  before a long-running Turn settles. The cassette itself contains the missing
  intent, effect, and final Turn.
- Quick checks:
  Compare adjacent `activity-events.jsonl` timestamps. If the effect was
  recorded more than the renderer effect timeout after its intent, check
  whether replay dispatched both events immediately instead of waiting for
  their recorded interval.
- Root cause:
  Provider frames followed the daemon playback clock, but the runner iterated
  activity events as fast as JavaScript completed them. Effect verification
  therefore began while the recorded Turn was still running and expired before
  the effect could exist.
- Fix:
  Advance activity events by relative `occurredAtUnixMs` using the daemon's
  playback state. Pause freezes the activity clock, speed scales it, and
  checkpoint fast-forward skips its remaining wait.
- Validation:
  Cover normal recorded delay, processing time between events, pause/resume,
  selected speed, and fast-forward. Then replay the failing cassette and require
  the final checkpoint, all provider frames, and every expected Turn to pass.
- References:
  [run-agent-session-replay.mjs](../../../tools/scripts/run-agent-session-replay.mjs)
  [run-agent-session-replay.test.mjs](../../../tools/scripts/run-agent-session-replay.test.mjs)

### Edited prompt remains after edit-and-retry

- Symptom:
  The replacement answer appears, but the original user prompt remains,
  reappears after reconnect, or disappears only after switching Sessions.
- Quick checks:
  Compare the daemon Session-detail Turn projection and effective message read
  with the renderer snapshot. If SQLite marks the old Turn `retracted`, verify
  Session detail uses `ListEffectiveSessionTurns`, not the complete audit
  reader. Then inspect the SessionEngine required/applied history revisions and
  any terminal optimistic message-delta row from the retracted Turn.
- Root cause:
  Incremental reconciliation can add or update rows but cannot delete a cached
  Turn missed during disconnect. A second variant replaces canonical messages
  while leaving a confirmed optimistic projection alive; a third lets a
  realtime event race a full-history read.
- Fix:
  Serialize same-Session reads, require a full authoritative replacement for a
  changed edit-retry revision, page backward from a newest-version anchor, then
  drain its live tail and apply one composite Session/Turn/Message snapshot.
  Source the detail projection from effective Turns. Reconcile pending intents,
  attention, and terminal optimistic message-delta rows from that same Turn set
  and stable `clientSubmitId` set; preserve unresolved turnless controls. Retry
  transient projection failures while connected and recheck cached Sessions on
  reconnect.
- Validation:
  Cover missed events plus reconnect, stale unknown messages, transient
  failures, revision changes during paging, optimistic initial prompts, and a
  terminal delta for a retracted Turn. The final detail and transcript must
  contain only effective Turns and messages while preserving attachments,
  non-text input, turnless controls, and real filesystem effects.
- References:
  [workspaceAgentActivityReconcileBridge.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityReconcileBridge.ts)
  [sessionReconcileExecutor.ts](../../../packages/agent/activity-core/src/sessionReconcileExecutor.ts)
  [pendingIntents.authoritativeHistory.ts](../../../packages/agent/activity-core/src/engine/pendingIntents.authoritativeHistory.ts)

### Goal-mode recording stalls waiting for a `/goal` palette option

- Symptom:
  A Session-Replay recording scenario (or any UI driver) waits forever for
  `agent-gui-composer-slash-command-goal` after typing `/goal` into the
  composer, while typing `/` shows only skill options.
- Quick checks:
  Inspect `goalDraftObjectiveFromPrompt` in `composerDraftUtils.ts` and the
  `isGoalModeActive` guard in `useComposerPaletteCatalog.ts`. Programmatic
  probes that overwrite the draft via `execCommand('insertText')` can leave the
  React palette draft stuck on a previous `/goal` prefix, which hides all
  command entries and makes the palette look broken for unrelated queries.
- Root cause:
  `/goal` is a prefix syntax, not a palette command. The moment the draft
  matches `^\s*\/goal(\s+…)?$`, `isGoalModeActive` becomes true, the slash
  query is nulled, and the command section of the palette closes. A palette
  option for the full token can never appear.
- Fix:
  Drive goal mode by typing the whole `/goal <objective>` draft, waiting for
  the goal badge (`[data-agent-goal-badge="true"]`) plus an enabled send
  button, then clicking send (`submitGoalPrompt` in the record-scenario CDP
  helpers). Never wait for a `/goal` palette option.
- Validation:
  `pnpm e2e:agent-gui -- --record … --scenario l01` proceeds past goal
  activation (goal turn starts) instead of stalling on the palette wait.
- References:
  `tutti-agent-session-replay-cases/scenario-runtime/cdp-helpers.mjs`
  [composerDraftUtils.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/composer/composerDraftUtils.ts)
  [useComposerPaletteCatalog.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/composer/useComposerPaletteCatalog.ts)

### Replay transport mismatch on `attachmentId`

- Symptom:
  Replay fails with 409 `agent_session_replay_transport_mismatch` at a state
  path like `$.agent.sessions[i].messages[j].payload.content[k].attachmentId`.
- Root cause:
  Attachment identifiers are runtime-generated. Replay re-uploads prompt
  attachments and receives fresh IDs, so byte-equality against the recorded
  state can never hold.
- Fix:
  Register message-content `attachmentId` values as alpha-equivalent
  identities in `registerReplayIDs` (`services/tuttid/biz/agentsessionreplay/state.go`),
  like session/turn/message IDs.
- Validation:
  `TestCompareTuttiReplayStateTreatsAttachmentIDsAsAlphaEquivalent` in
  `state_test.go`; a full record→replay of an image-input cassette passes.
- References:
  [state.go](../../../services/tuttid/biz/agentsessionreplay/state.go)

### Replay transport mismatch on Goal Control `operationId`

- Symptom:
  Goal cassette record and UI/provider playback succeed, but final transport
  verification fails with 409 at
  `$.agent.sessions[i].messages[j].payload.operationId` on the
  `goal-control:*` session_audit row.
- Root cause:
  Goal Control operation identities are minted per run. Replay creates a new
  durable operation while replaying the same `/goal` activation, so the audit
  payload's `operationId` cannot match byte-for-byte.
- Fix:
  Register message-payload `operationId` values as alpha-equivalent identities
  in `registerReplayIDs`, alongside session/turn/message/attachment IDs.
- Validation:
  `TestCompareTuttiReplayStateTreatsGoalControlOperationIDsAsAlphaEquivalent`;
  record→audit→replay of `l01_codex` (`l01`) passes.
- References:
  [state.go](../../../services/tuttid/biz/agentsessionreplay/state.go)
  `tutti-agent-session-replay-cases/cases/l01/scenario.mjs`

### Project-session replay never shows the restored session in the rail

- Symptom:
  Replaying a project-session cassette stalls waiting for
  `agent-gui-conversation-item-<sessionId>`; the conversation rail is empty.
- Root cause:
  Recording seeds the project into `user_projects` before driving the UI, but
  replay bootstrap did not. Sessions whose `railPlacement.kind` is `project`
  render only under a project rail section, and that section only exists when
  the project row is present.
- Fix:
  During replay preparation, detect a `railPlacement.kind === "project"`
  activity payload and seed the same project (`seedRecordingUserProject`)
  before launching the desktop; enter the project surface before replaying the
  activation intent.
- References:
  [run-agent-session-replay.mjs](../../../tools/scripts/run-agent-session-replay.mjs)
  [recording.mjs](../../../tools/scripts/agent-session-replay-runner/recording.mjs)

### Interaction replay times out at an `interaction.pending` checkpoint

- Symptom:
  Replaying a cassette with an approval/question interaction fails with
  `checkpoint_readiness_timeout` right before the
  `interaction/responseRequested` intent; provider frames stop at the chunk
  preceding the recorded decision write-back. A concurrent
  `agent_session.process_start` log with empty `room_id`/`agent_session_id`
  is the periodic provider availability probe, not a session relaunch — do
  not chase it.
- Root cause:
  Checkpoint readiness predicates compared recorded activity-layer vocabulary
  (`turn.phase == "waiting_approval"`, `call.status == "running"`) against
  the canonical store vocabulary (`waiting`, `waiting_approval`) by string
  equality, so interaction-wait checkpoints could never become ready.
- Fix:
  Fold both sides to canonical vocabulary before comparing
  (`semantic_readiness.go`), and record canonical values into new checkpoint
  plans (`checkpoint_provider_candidates.go`). Old cassettes stay compatible
  through the replay-side fold.
- Validation:
  `TestCanonicalTurnPhaseFoldsActivityVocabulary` and
  `TestDescribeProviderEventFoldsTurnPhaseToCanonicalVocabulary`; replaying
  approval, question, and child-approval cassettes passes.
- References:
  [semantic_readiness.go](../../../services/tuttid/service/agentsessionreplay/semantic_readiness.go)
  [checkpoint_provider_candidates.go](../../../services/tuttid/service/agentsessionreplay/checkpoint_provider_candidates.go)

### Replay times out waiting for idle before a busy-queue `submit/requested`

- Symptom:
  Replaying a cassette that enqueues prompts while a turn is still running
  (queue edit / remove / automatic drain) fails with
  `timed out waiting for replay Session … to become idle` on a
  `submit/requested` activity event. The session's `activeTurn.phase` stays
  `running` because the filler turn only settles after later tape actions.
- Quick checks:
  Inspect `activity-events.jsonl` around the failing sequence. Busy-queue
  submits have no `queue/sendPrompt` / `session/activate` effect with
  `causedByEventId` equal to that submit's `eventId` (they are later canceled
  or drained after the active turn settles). Older cassettes may still show
  `submitDiagnostics.queued: false` on those intents.
- Root cause:
  The temporary runner treated every `submit/requested` with
  `submitDiagnostics.queued === false` as an immediate send and waited for
  session idle first. The GUI trace starts with `queued: false`, and until the
  engine stamped real queue admission onto the intent, busy-queue submits were
  recorded with that stale false. Waiting for idle deadlocks behind the turn
  that caused the queue in the first place.
- Fix:
  Stamp `submitDiagnostics.queued` from engine queue admission before the
  intent is observed (`selectEngineSubmitWouldBeVisibleInQueue`). On replay,
  wait for idle only when the submit caused a send/activate effect (and skip
  for `queued: true`, `send_now`, and `immediate`). Re-record queue scenarios
  so new tapes carry the correct diagnostic; older tapes replay via effect
  causation.
- Validation:
  `submit idle wait skips busy-queue submits and honors send causation`;
  `semantic prompt submission reports visible queue admission for a busy Session`;
  record and replay queue-only `c04_codex`; record and replay native-guidance
  `c06_codex` separately.
- References:
  [run-agent-session-replay.mjs](../../../tools/scripts/run-agent-session-replay.mjs)
  [createAgentSessionEngine.ts](../../../packages/agent/activity-core/src/engine/createAgentSessionEngine.ts)
  [promptQueue.admission.ts](../../../packages/agent/activity-core/src/engine/promptQueue.admission.ts)

### Replay deadlocks at a `turn.canceled` checkpoint of a canceled compaction

- Symptom:
  Replay fails with `checkpoint_readiness_timeout` at the checkpoint after a
  canceled `/compact` turn, and the transport reports a deterministic
  `connection ... consumed N of M chunks` where the next unconsumed chunk is
  the inbound frame right before the recorded `turn/interrupt` outbound. The
  canceled turn settles only after Host's cancel grace timeout (~2 minutes),
  the live connection is torn down, and the retry turn fails on a provider
  relaunch that has no recorded connection.
- Root cause:
  Activity-boundary checkpoint cursors were taken from the observation lane
  (last provider unit that carried checkpoint observation events). A
  compaction turn's interrupted `turn/completed` settles canonical state
  without emitting observations, so the recorded `turn.canceled` cursor
  stopped before the interrupt round trip its own readiness
  (`turn.status == "canceled"`) requires. At replay the input barrier parks
  the reader at that cursor, the daemon's `turn/interrupt` send waits behind
  the unreleased inbound chunk, and readiness can never hold — an
  unsatisfiable plan, not a replay-transport bug.
- Fix:
  The recording transport already reports every completed provider input
  unit; fold that handled lane into the checkpoint recorder
  (`ObserveProviderInputUnit`) and record activity-boundary cursors as the
  per-connection max of the observation lane and the handled lane
  (`activityBoundaryCursor`). Provider-observation checkpoint cursors keep
  using the observation lane only. Cassettes recorded with the stale cursor
  must be re-recorded.
- Validation:
  `TestActivityBoundaryCursorCoversHandledUnitsBeyondObservationLane`;
  re-recording and replaying the compaction-cancel-retry cassette passes, and
  the cancel-and-resend cassette replay stays green.
- References:
  [checkpoint_provider_candidates.go](../../../services/tuttid/service/agentsessionreplay/checkpoint_provider_candidates.go)
  [checkpoint_activity_boundaries.go](../../../services/tuttid/service/agentsessionreplay/checkpoint_activity_boundaries.go)

### New Agent conversation rejects a model that is no longer offered

- Symptom:
  A newly submitted conversation fails with `model value is not supported by
agent target`, although the current model picker does not offer that model.
  Alternatively, the selected model appears to start but the provider actually
  continues on its own default.
- Root cause:
  A target-scoped remembered composer default outlived a changed model catalog,
  or a dependent reasoning default remained bound to the retired model after
  model fallback,
  or the ACP runtime treated a rejected startup model selection as a
  best-effort setting and silently retained the provider default. Reapplying a
  model that `session/new` already selected can also trigger an unnecessary
  provider-side reconfiguration failure.
- Fix:
  At Create, distinguish a target-scoped persisted default from a model
  explicitly supplied by the caller. For an Agent Extension, resolve an
  obsolete persisted default to the current model reported by that same
  extension; never use a different provider. Resolve non-explicit per-model
  reasoning against that effective model while keeping explicit caller values
  strict. Treat an explicit ACP model selection as identity-bearing: leave an
  already-selected model unchanged, and if a real model change is rejected,
  abort startup rather than falling back.
- Validation:
  Cover an obsolete persisted default with a multi-model catalog whose reported
  current model is not first, a stale dependent reasoning default, and an
  unsupported explicit selection separately with generic extension fixtures.
  Inject a `session/set_model` rejection into the standard ACP transport test.

### Codex rejects `turn/start` with `AbsolutePathBuf deserialized without a base path`

- Symptom:
  Codex initializes and `thread/start` succeeds, but the first `turn/start`
  fails with JSON-RPC `-32600` and `AbsolutePathBuf deserialized without a base
path`. On a managed POSIX runtime, another form accepts the Turn but every
  tool command, including `pwd`, fails with
  `Failed to create unified exec process: No such file or directory (os error 2)`
  even though provider-process CWD preflight succeeded.
- Root cause:
  Tutti sent the POSIX-only `/sandbox-tmp` writable root as though it were a
  portable absolute host path. Codex's Windows `AbsolutePathBuf` parser rejects
  it even when the request also carries `cwd`; the per-turn working-directory
  override does not make a POSIX-rooted string into a Windows absolute path.
  Tutti also once omitted the Session `cwd` from the Turn override. Supplying
  that field from the raw persisted Session value introduced the inverse POSIX
  failure: a stored `/workspace/<room-id>` mount path escaped the managed
  Agent's logical `/workspace` view even though `thread/start` and the provider
  process had already projected it. Request-shape mocks accepted these invalid
  combinations without exercising the real process or Rust parser boundary.
- Fix:
  Send the non-empty provider-visible Session `cwd` on every Codex
  `turn/start`. Apply the same room-mount-to-logical-workspace projection used
  by `thread/start` and provider launch while preserving native Windows paths.
  Omit the POSIX `/sandbox-tmp` projection on Windows, and keep it on POSIX
  hosts where it represents the logical `/tmp` write target.
- Validation:
  Cover a stored room mount root and child path, an already-logical workspace
  path, and a native Windows path in the emitted `turn/start.cwd`. Cover Windows
  and POSIX sandbox policy construction, and run the Windows contract test
  against a real pinned `codex.exe app-server`. The contract test submits the
  historical payload both without and with `cwd` as negative controls, then
  verifies that the production payload crosses the same parser without an
  `AbsolutePathBuf` error.
