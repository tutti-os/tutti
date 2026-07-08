# Troubleshooting

Use this document for recurring bug patterns, debugging traps, and fixes that
engineers are likely to hit again in normal repository work.

This is not an incident log or a scratchpad for one-off investigations. Keep
entries durable, narrow, and reusable.

## When To Add An Entry

Add or update an entry when all of the following are true:

- the same bug pattern has already happened more than once, or is very likely
  to recur
- the root cause is not obvious from the owning API, type, or file layout
- there is a stable fix, guardrail, or validation step worth repeating

Prefer recording:

- hidden contract requirements
- renderer or store subscription traps
- state-shape or snapshot-identity pitfalls
- package-specific debugging checklists that are likely to save future time

Do not record:

- temporary branch-specific debugging notes
- one-off local environment mishaps
- issues that are already fully explained by a nearby durable convention

## Entry Format

Use this shape for new entries:

### Short issue name

- Symptom:
- Quick checks:
- Root cause:
- Fix:
- Validation:
- References:

## Current Entries

### App Factory job keeps loading after AgentGUI Stop

- Symptom:
  An App Center create-app job stays `generating` after the user stops the
  linked AgentGUI turn. The AgentGUI transcript looks settled/canceled, but App
  Center keeps showing the loading spinner.
- Quick checks:
  Inspect the App Factory job row and linked agent session. A common shape is
  `app_factory_jobs.status = generating`,
  `workspace_agent_sessions.status = active`, `current_phase = idle`, with the
  latest assistant `tool_call` message `status = failed` and payload/error
  fields such as `status: canceled`, `reason: interrupted`, or
  `message: interrupted`.
- Root cause:
  AgentGUI sessions are resumable, so stopping one turn does not necessarily
  make the durable session terminal. App Factory job lifecycle is a separate
  projection: it must treat explicit canceled session/turn outcomes as job
  cancellation, but it must not collapse every raw `interrupted` turn into a
  canceled job because approval rejections and transient turn-level
  interruptions can use the same vocabulary.
- Fix:
  Keep plain active-session `interrupted` turn outcomes non-terminal. Cancel an
  active App Factory job only when the state carries an explicit canceled
  outcome, or when accepted message updates contain the runtime's canceled
  interrupted non-approval tool-call shape.
- Validation:
  Add App Factory service tests for plain `interrupted` staying non-terminal,
  explicit `canceled` outcome canceling the job, canceled interrupted
  non-approval tool calls canceling the job, and canceled approval updates being
  ignored.
- References:
  [app_factory_agent_state.go](../../services/tuttid/service/workspace/app_factory_agent_state.go)
  [app_factory_test.go](../../services/tuttid/service/workspace/app_factory_test.go)

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
  [controller.go](../../packages/agent/daemon/runtime/controller.go)
  [controller_test.go](../../packages/agent/daemon/runtime/controller_test.go)

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
  [service_session.go](../../services/tuttid/service/agent/service_session.go)
  [service.go](../../services/tuttid/service/agent/service.go)
  [service_session_list.go](../../services/tuttid/service/agent/service_session_list.go)

### Claude composer model list stays stale after credential switch

- Symptom:
  After an external credential switcher rewrites Claude Code auth or config
  files, the AgentGUI composer still shows the previous model list even though
  `tuttid.log` contains `agent.model_catalog.invalidated` for `claude-code`.
- Quick checks:
  Search `tuttid.log` for `CLAUDE_MODEL_CATALOG_INVALIDATION_DEBUG`. If
  `live_composer_models_invalidated` is followed by
  `running_session_model_options_reused`, inspect that session's
  `createdAtUnixMs` and `updatedAtUnixMs` against the invalidation timestamp.
- Root cause:
  Claude composer model discovery reuses model options from a live Claude
  runtime session to avoid spawning overlapping credential-touching processes.
  After a credential switch, a pre-switch runtime session can still carry the
  old `runtimeContext.configOptions`; reusing it repopulates the just-cleared
  live model cache with stale models.
- Fix:
  Track provider model-catalog invalidation time in `tuttid`. When loading
  Claude composer options, skip running-session model options whose session
  timestamp is older than the provider invalidation, and allow hidden live
  discovery to query the current credentials.
- Validation:
  Add daemon service coverage where invalidation happens after a Claude session
  has advertised old model options; the next composer options request must
  start hidden discovery and return the freshly discovered model list. Run
  `cd services/tuttid && go test ./service/agent`.
- References:
  [composer_live_model_discovery.go](../../services/tuttid/service/agent/composer_live_model_discovery.go)
  [composer_live_model_cache.go](../../services/tuttid/service/agent/composer_live_model_cache.go)

### Claude SDK context window shows 200k for 1M models

- Symptom:
  Claude Code GUI usage shows a 200k context window for a model that should have
  1M context, such as Claude Sonnet 5. The inverse can also happen after a model
  switch: a 200k model such as Haiku keeps showing the prior 1M total.
- Quick checks:
  Inspect the session runtime context for `usage.contextWindow.totalTokens`,
  then trace the Claude SDK sidecar `usage_updated` payload and daemon
  `agent_session.claude_sdk.usage_update` log. If the payload keys include
  `modelUsage` but `raw_total_tokens` is `0`, the daemon did not parse the
  model-usage context window. If `previous_context_model` and
  `current_context_model` differ but `current_total_tokens` equals
  `previous_total_tokens`, daemon usage normalization reused a stale context
  window across models. If switching models without sending a message makes the
  usage entry disappear, inspect whether a forced session-control reload
  returned `runtimeContext` without `usage` and replaced the active control
  state.
- Root cause:
  AgentGUI only renders `runtimeContext.usage`; the total comes from the daemon
  and Claude SDK sidecar. Claude SDK result messages expose model usage as a
  map keyed by model id, for example
  `modelUsage["claude-sonnet-5"].contextWindow`. If either sidecar or daemon
  only parses array-shaped `modelUsage`, the context-window total is missing and
  daemon normalization falls back to 200k.
- Fix:
  Parse `modelUsage` recursively as both arrays and maps before using fallback
  context-window values. Track the model associated with a cached context
  window, and only reuse the previous total for the same model or when the model
  is unknown. Treat `runtimeContext.usage` as incremental telemetry in AgentGUI
  reload races: a full session-control snapshot that omits usage should not
  clear the previous usage display. Do not hard-code alias-to-model mappings in
  Tutti.
- Validation:
  Add sidecar and daemon coverage with map-shaped `modelUsage` carrying
  `contextWindow: 1_000_000`, plus daemon coverage for Haiku -> Sonnet5 -> Haiku
  usage updates where the last payload lacks `totalTokens`. Add AgentGUI
  coverage for session-control reloads that omit `runtimeContext.usage`. Then
  run the Claude SDK sidecar tests, daemon Go tests, AgentGUI tests, and
  typechecks.
- References:
  [main.ts](../../packages/agent/claude-sdk-sidecar/src/main.ts)
  [main.test.ts](../../packages/agent/claude-sdk-sidecar/src/main.test.ts)
  [claude_sdk_adapter.go](../../packages/agent/daemon/runtime/claude_sdk_adapter.go)

### Codex npm install misses the platform package

- Symptom:
  The Codex environment dialog says the CLI is installed, but the adapter or
  `codex app-server` probe is still missing. Logs may show
  `Missing optional dependency @openai/codex-darwin-arm64`, a long wait on an
  npm registry, or a later repair failure such as `ENOTEMPTY` while moving an
  existing `@openai/codex` directory. Another form is an immediate launcher
  failure such as `env: node: No such file or directory` after the JavaScript
  `codex` shim has been installed.
- Quick checks:
  Inspect the npm debug log under the install cache for
  `reify failed optional dependency`, then check whether the matching platform
  package directory contains both `package.json` and the vendor `codex`
  executable. Compare the selected registry with a temporary prefix/cache
  install before changing the user's real install.
- Root cause:
  `@openai/codex` installs a JavaScript launcher plus a per-platform optional
  package such as `@openai/codex-darwin-arm64`. npm can exit successfully even
  when an optional dependency fetch failed, which leaves the launcher installed
  but unable to start. A registry can also be reachable but too slow for the
  platform tarball, so retrying the same source burns the install timeout before
  mirrors are tried. The launcher itself uses `#!/usr/bin/env node`, so every
  daemon-run Codex command (`--version`, `login status`, and `app-server`) must
  run with the Tutti-managed Node bin directory on `PATH`; fixing only the npm
  install command leaves post-install probes broken on machines without system
  Node.
- Fix:
  Keep Codex installs on the Tutti-managed Node/npm runtime, install with
  optional dependencies included, and rank configured npm registries with a
  lightweight package metadata probe before attempting the install. Preserve
  `TUTTI_AGENT_NPM_REGISTRY` as an explicit single-registry pin with no mirror
  fallback. Also pass the same managed Node `PATH` through provider command
  resolution, version checks, auth-status checks, and adapter probes. If the
  CLI path exists but `codex app-server` cannot launch, treat the failed probe
  as a repair trigger so the install action does not clear immediately without
  running an installer.
- Validation:
  Reproduce in a temporary prefix/cache using the Tutti-managed npm. Confirm
  `codex --version`, the platform package metadata and vendor binary, and a
  short `codex app-server` probe before touching the user's real install. Include
  a case where the visible `codex` shim uses `#!/usr/bin/env node` and the normal
  user `PATH` does not contain `node`.
- References:
  [npm_registry.go](../../services/tuttid/service/agentstatus/npm_registry.go)
  [installer_codex_cli.go](../../services/tuttid/service/agentstatus/installer_codex_cli.go)
  [codex_platform.go](../../services/tuttid/service/agentstatus/codex_platform.go)

### Tutti Agent npm install misses the platform package

- Symptom:
  The Tutti Agent provider setup reaches the login screen or reports the CLI as
  installed, but `tutti-agent login` or `tutti-agent app-server` fails with
  `Missing optional dependency @tutti-os/tutti-agent-<platform>`.
- Quick checks:
  Check the selected registry for both `@tutti-os/tutti-agent` and the exact
  alias target version, such as
  `@tutti-os/tutti-agent@0.0.1-darwin-arm64`. Do not treat a successful
  aggregate package metadata fetch as proof that the platform tarball is
  available.
- Root cause:
  `@tutti-os/tutti-agent` follows the Codex npm layout: a JavaScript launcher
  plus per-platform optional dependencies expressed as npm aliases. npm can
  complete the aggregate install even when a mirror has not synced the platform
  optional dependency version.
- Fix:
  Keep the package layout aligned with Codex and use registries that carry the
  platform optional dependency versions. The daemon default chain intentionally
  excludes mirrors that only sync the aggregate package. Preserve
  `TUTTI_AGENT_NPM_REGISTRY` as an explicit single-registry pin with no fallback.
- Validation:
  Install into a temporary prefix/cache and verify the provider probe, not only
  npm's exit code. Confirm `tutti-agent app-server` can start far enough to pass
  the daemon readiness probe.
- References:
  [npm_registry.go](../../services/tuttid/service/agentstatus/npm_registry.go)
  [tutti_agent.go](../../services/tuttid/service/agentsidecar/tutti_agent.go)

### Dynamic CLI input rejects plausible flags

- Symptom:
  A dynamic `tutti-dev` command prints normal-looking help, but invocation fails
  with `invalid input "<flag>"` or an app-level invalid-argument error even
  though the flag name and shell syntax are correct.
- Quick checks:
  Inspect the command input struct tags under `services/tuttid/service/cli/providers`.
  Confirm `validate:"min=...,max=..."` bounds and any finite string values such
  as status, priority, or source are represented in the framework input schema.
- Root cause:
  Dynamic CLI help and agent command guides are generated from daemon capability
  schema, while actual invocation is bound and validated later by the daemon.
  If the schema omits enum/range metadata, agents may guess plausible but
  invalid values such as `--status open` or an out-of-range page size.
- Fix:
  Keep finite string sets in `enum:"..."` tags and numeric bounds in
  `validate:"min=...,max=..."`. The framework should reject invalid enum/range
  input with a reason before provider code sees the request.
- Validation:
  Add provider tests that assert both advertised schema metadata and invalid
  input errors for the affected command.
- References:
  [input.go](../../services/tuttid/service/cli/framework/input.go)
  [issues.go](../../services/tuttid/service/cli/providers/issuemanager/issues.go)

### Desktop dev GUI exits before opening

- Symptom:
  `make dev-gui` exits during startup before the desktop window is usable. The
  early form reports `pnpm <version> installation did not succeed`; the later
  form reaches `start electron app...` and then `make` exits while desktop logs
  say `secondary tutti instance detected`. Another early form exits while
  checking prerequisites because a stale `pnpm` shim reports that its bundled
  `../node/bin/node` no longer exists.
- Quick checks:
  Run `DEV_GUI_SKIP_START=1 make dev-gui` to isolate prerequisite setup from
  Electron startup. If full startup exits after `start electron app...`, inspect
  `~/.tutti-dev/logs/tutti-desktop.log` and check whether `/Applications/Tutti.app`
  or another Tutti instance is already running.
- Root cause:
  Shells launched by tools can put another `pnpm` earlier on `PATH` than
  corepack's shim, so `corepack prepare` succeeds but the script still validates
  the wrong `pnpm`. That earlier shim can also be a symlink into a relocated
  runtime cache, so invoking `pnpm --version` fails before the script has a
  chance to run Corepack. Electron's single-instance lock also follows Electron
  userData; if development and production share userData, a running production
  app makes the dev app quit as a secondary instance. Agent shells launched from
  the packaged app may inherit `TUTTI_ENV=production`, so `make dev-gui` must
  force the development environment instead of preserving that inherited value.
- Fix:
  Probe `pnpm --version` without letting a broken shim abort startup, discover
  Corepack from the active or locally installed Node runtime, prefer that
  Corepack shim directory before checking or running `pnpm`, and set development
  Electron userData to an environment-specific path before requesting the
  single-instance lock. Ensure the dev-gui script exports
  `TUTTI_ENV=development` before resolving pid files, installing the dev CLI, or
  launching Electron.
- Validation:
  Run `DEV_GUI_SKIP_START=1 make dev-gui`, then run full `make dev-gui` while
  the packaged app is open and confirm the renderer dev server and development
  `tuttid` start. Also run `pnpm --filter @tutti-os/desktop test`,
  `pnpm --filter @tutti-os/desktop typecheck`, and
  `pnpm check:electron-runtime-boundaries`.
- References:
  [dev-gui.sh](../../tools/scripts/dev-gui.sh)
  [bootstrap.ts](../../apps/desktop/src/main/bootstrap.ts)
  [defaults.ts](../../apps/desktop/src/main/defaults.ts)

### GitHub Actions pnpm setup fails with ERR_PNPM_BAD_PM_VERSION

- Symptom:
  GitHub Actions jobs fail in the `pnpm/action-setup` step with
  `ERR_PNPM_BAD_PM_VERSION` or "Multiple versions of pnpm specified" after
  `package.json` gains an integrity-pinned `packageManager` value such as
  `pnpm@10.11.0+sha512...`.
- Quick checks:
  Inspect every workflow that uses `pnpm/action-setup`. If the workflow passes
  `with.version` while the root `package.json` also declares `packageManager`,
  the action sees two pnpm targets.
- Root cause:
  `pnpm/action-setup` reads `packageManager` from `package.json` by default.
  Passing a separate `version` input duplicates the same version source, and an
  integrity-pinned `packageManager` string makes the mismatch explicit.
- Fix:
  Keep `package.json` as the single pnpm version source. Remove the
  `with.version` input from `pnpm/action-setup` steps instead of weakening the
  root `packageManager` integrity pin.
- Validation:
  Search workflows for `pnpm/action-setup` and confirm no step still passes a
  `version` input. Push a new commit to rerun the PR checks.

### macOS updates fail from a mounted DMG

- Symptom:
  A packaged macOS build can check for and download an update, but clicking
  install appears to do nothing or logs an updater error such as
  `Cannot update while running on a read-only volume`. The desktop log shows
  the app executable under `/Volumes/.../Tutti.app`, and the daemon may stop
  briefly because the update install flow began before the updater rejected the
  read-only volume.
- Quick checks:
  Inspect `tutti-desktop.log` for `process.execPath`, updater errors, or
  managed daemon start lines that point under `/Volumes`. Confirm whether the
  user launched Tutti directly from a mounted `.dmg` instead of the copy in
  `/Applications`.
- Root cause:
  macOS mounts compressed DMG installers as read-only volumes. Electron's macOS
  updater cannot replace an app bundle that is running from that volume, so the
  failure is an install-location problem rather than a dead `tuttid` process.
- Fix:
  In packaged macOS builds, detect `/Volumes` startup before desktop services
  and managed `tuttid` are created. Prompt the user to move Tutti to
  `/Applications`, call Electron's application-folder move when accepted, and
  quit rather than continuing from the mounted image. Development builds must
  skip this guard so local Electron runs keep working.
- Validation:
  Cover the guard with tests for development mode, non-macOS platforms,
  `/Applications`, `/Volumes`, declined installation, successful automatic
  move, and failed automatic move. Run the desktop tests, desktop typecheck, and
  i18n check because the guard uses Electron dialog copy.
- References:
  [macosApplicationInstallGuard.ts](../../apps/desktop/src/main/macosApplicationInstallGuard.ts)
  [bootstrap.ts](../../apps/desktop/src/main/bootstrap.ts)
  [desktop-release.md](./desktop-release.md)

### App Center list requests repeatedly log runtime preload

- Symptom:
  `tuttid` logs repeated `workspace app runtime preload started` and
  `workspace app runtime preload completed` lines while App Center is merely
  open or refreshing, even when the user is not installing an app.
- Quick checks:
  Trace the call path from `ListWorkspaceApps` to
  `AppCenterService.List`. A list or catalog refresh request should not call
  `AppRunner.PreloadRuntimeForProfile` or the managed runtime resolver.
- Root cause:
  Treating App Center list/read requests as an opportunity to prepare runtimes
  gives a pure read operation hidden background side effects. Frequent renderer
  refreshes then turn a fast idempotent runtime check into noisy repeated logs.
- Fix:
  Keep passive runtime preloading in daemon startup or another explicit
  runtime-preparation workflow. Install, launch, retry, and enabled-app start
  paths may still resolve runtimes because they actually need executable app
  runtimes.
- Validation:
  Add or run service coverage that `AppCenterService.List` returns visible
  uninstalled apps without invoking the runtime resolver.
- References:
  [apps.go](../../services/tuttid/service/workspace/apps.go)
  [apps_test.go](../../services/tuttid/service/workspace/apps_test.go)

### Workspace app uninstall fails on cached manifest validation

- Symptom:
  App Center uninstall fails with a renderer `TuttidProtocolError` such as
  `scan workspace app package version: app manifest references.listEndpoint is required when references is provided`.
- Quick checks:
  Inspect `tuttid.db` `app_packages.manifest_json` for the target app. A legacy
  row may have `references` without `references.listEndpoint`, even when the
  currently published catalog manifest is valid.
- Root cause:
  The unused remote built-in uninstall cleanup path needs durable file metadata
  such as `package_dir`, but a full package-version read parses and validates
  `manifest_json`. If an old cached package was valid under an older manifest
  contract but invalid under the current one, cleanup can be blocked before it
  deletes the installation.
- Fix:
  Keep normal package reads strict, but use a manifest-free file-record query
  for the unused remote built-in uninstall cleanup path that only needs package
  directories. Do not treat historical manifest validation failures as a reason
  to prevent uninstall.
- Validation:
  Add SQLite coverage that file records can be listed for an invalid manifest
  while full package-version reads still fail, plus App Center service coverage
  for uninstalling an unused remote built-in app with an invalid cached package
  version.
- References:
  [sqlite_apps.go](../../services/tuttid/data/workspace/sqlite_apps.go)
  [app_packages.go](../../services/tuttid/service/workspace/app_packages.go)

### Workspace app update reopens the old dock window

- Symptom:
  After updating a running workspace app, clicking the app from the dock still
  shows the old UI or old port until Tutti itself is restarted.
- Quick checks:
  Inspect the App Center snapshot for `installed_pending_restart` while a
  matching `workspace-app-webview` node still exists. Dock debug logs showing
  `clickResolution.kind = "focus-node"` for that app mean the launch resolver
  is being bypassed.
- Root cause:
  Workbench dock single-instance entries focus a matching node before launching.
  If a workspace app is waiting for restart and the dock entry still uses the
  default click behavior, clicking the dock can restore the stale webview
  instead of entering `resolveWorkspaceAppCenterLaunchRequest` and
  `restartAndOpenApp`.
- Fix:
  Route `installed_pending_restart` workspace app dock clicks through the
  launch request path even when a stale webview node still matches the dock
  entry. Keep normal `running` apps on the default focus path so existing app
  state is preserved.
- Validation:
  Run the workspace app-center contribution tests and the workspace workbench
  surface dock click-resolution tests that cover pending-restart launch
  routing.
- References:
  [workspaceAppCenterContribution.tsx](../../apps/desktop/src/renderer/src/features/workspace-app-center/services/internal/workspaceAppCenterContribution.tsx)
  [workspaceAppCenterLaunchRequest.ts](../../apps/desktop/src/renderer/src/features/workspace-app-center/services/internal/workspaceAppCenterLaunchRequest.ts)
  [dockEntries.ts](../../packages/workbench/surface/src/host/dockEntries.ts)

### Load unpacked project roots with source manifests

- Symptom:
  App Center's Load unpacked action rejects an app repository even though
  `.tutti/dev-app/tutti.app.json` and `.tutti/dev-app/bootstrap.sh` are valid.
- Quick checks:
  Run `services/tuttid/service/workspace/app_factory_reference/scripts/check_local_dev_app.py <project-root>`.
  If the project root also contains a publishable source `tutti.app.json`, make
  sure the daemon and checker resolve `.tutti/dev-app` before the root manifest.
- Root cause:
  App repositories can keep a release source manifest at the project root while
  using `.tutti/dev-app` as the Chrome-style local debug wrapper. If local app
  loading treats the root manifest as authoritative first, it may validate the
  source manifest as a package and fail on package-local files such as
  `bootstrap.sh`, `icon.png`, or `tutti.cli.json`.
- Fix:
  Prefer `.tutti/dev-app/tutti.app.json` when a selected project root contains
  both a nested dev app and a root source manifest. Directly selected app
  package directories still load from their own `tutti.app.json`.
- Validation:
  Add or run service coverage for a project root with both manifests, then run
  the local debug checker on that project root.
- References:
  [app_local.go](../../services/tuttid/service/workspace/app_local.go)
  [check_local_dev_app.py](../../services/tuttid/service/workspace/app_factory_reference/scripts/check_local_dev_app.py)

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
  [.github/workflows/external-pr-review-gate.yml](../../.github/workflows/external-pr-review-gate.yml)
  [.github/workflows/external-pr-review-gate-review-signal.yml](../../.github/workflows/external-pr-review-gate-review-signal.yml)
  [.github/workflows/external-pr-review-gate-review-refresh.yml](../../.github/workflows/external-pr-review-gate-review-refresh.yml)

### Browser CLI cold start timeout looks like an unreachable daemon

- Symptom:
  An agent runs a command such as `tutti-dev browser list-pages` and gets
  `daemon is not reachable`, but desktop and daemon logs show `tuttid` is
  running and a Chrome or browser-use process may still appear.
- Quick checks:
  Confirm the listener file under the active `TUTTI_STATE_DIR` has a live
  address and token, then run `tutti-dev status --json`. If status succeeds
  but the browser command fails after roughly the CLI client timeout, inspect
  whether the first browser command is lazily starting `chrome-devtools-mcp` or
  another browser backend. For browser backend overrides, inspect
  `TUTTI_BROWSER_MCP_COMMAND`, `TUTTI_BROWSER_MCP_ARGS`, and the packaged
  desktop's internal `TUTTI_BROWSER_MCP_ENTRY_PATH` handoff. Packaged desktop
  handoffs should launch that vendored entry with the daemon's managed
  `node-static` runtime, not a bare `node` from the user's `PATH`.
- Root cause:
  Browser commands can do a cold start on first use. The daemon may launch the
  browser backend while the CLI HTTP request is still waiting for the daemon to
  finish the tool call. If the CLI client times out first and collapses every
  transport error into `daemon is not reachable`, the message describes the
  timeout incorrectly instead of the daemon's actual reachability.
- Fix:
  Keep the CLI daemon client timeout long enough for browser backend cold
  starts, and report request timeouts separately from connection failures.
  Avoid treating a visible browser window as proof that the browser tool call
  has completed.
- Validation:
  Add CLI client tests for the default timeout and timeout-specific error
  message. For a live smoke test, verify `tutti-dev status --json` succeeds and
  then run the browser command again after the first cold start settles.
- References:
  [client.go](../../apps/cli/internal/daemon/client.go)
  [session.go](../../services/tuttid/service/browser/session.go)
  [command.go](../../services/tuttid/service/browser/command.go)

### Agent sandbox cannot reach local daemon

- Symptom:
  An AgentGUI-backed Codex turn runs a dynamic Tutti CLI command such as
  `tutti-dev automation --help` and gets `daemon is not reachable`, while
  `~/.tutti-dev/run/tuttid.listener.json` exists and the desktop daemon is
  running.
- Quick checks:
  Inspect the turn context in the provider session JSONL. If
  `network_access=false`, a plain `exec_command` cannot reach localhost/IPC.
  For Codex sessions, also confirm the command was not rerun with
  `sandbox_permissions=require_escalated`. Other providers need their own
  local-daemon-capable shell/runtime path, not Codex-specific sandbox syntax.
- Root cause:
  Dynamic CLI scopes fetch command capabilities from the local daemon before
  printing scope help. In a sandboxed provider command environment, localhost
  access can be blocked even though the daemon is reachable from the host.
- Fix:
  In agent environments, keep the CLI's transport failure message explicit
  about the sandbox but provider-neutral. Put provider-specific recovery steps
  in the injected runtime policy: Codex can use
  `sandbox_permissions=require_escalated`, while ACP providers should be told to
  use an execution environment with localhost/IPC access and not to invent Codex
  flags.
- Validation:
  Add CLI daemon-client coverage that non-agent failures keep the plain
  `daemon is not reachable` message, while agent failures include the
  localhost/IPC execution-environment hint. Add provider policy coverage so only
  Codex receives `sandbox_permissions=require_escalated`.
- References:
  [client.go](../../apps/cli/internal/daemon/client.go)
  [run.go](../../apps/cli/internal/app/run.go)

### macOS Gatekeeper dialogs appear during Codex provider probing

- Symptom:
  Opening an app or surface that reads agent composer options, provider status,
  or capability catalog triggers repeated macOS warnings that `codex` may harm
  the computer.
- Quick checks:
  Resolve the active Codex binary from `tuttid` logs or by running with the
  same daemon environment. Then inspect the native binary behind the npm shim
  with `spctl --assess --type execute -vv <native-codex-path>`. If it reports
  `CSSMERR_TP_CERT_REVOKED`, remove or reinstall that specific Codex package.
- Root cause:
  Provider status and composer capability discovery intentionally start Codex
  commands such as `codex login status` and `codex app-server`. If the daemon
  resolves an older nvm global Codex package whose Developer ID certificate has
  been revoked, each otherwise harmless background probe can become a
  Gatekeeper dialog. This can happen even when `which codex` in the user's shell
  points at a newer working Codex if the daemon command resolver places scanned
  nvm fallback directories before the real PATH.
- Fix:
  Respect the daemon PATH before scanned nvm fallback directories, and sort nvm
  fallback directories by Node version so fallback resolution does not pick the
  oldest installed Node first. Do not automatically remove attributes or delete
  arbitrary user-managed Codex binaries from Tutti; user repair scripts should
  only move Codex packages that `spctl` explicitly reports as certificate
  revoked, and should keep a backup.
- Validation:
  Run `go test ./runtimecmd` and `go test ./runtime` from
  `packages/agent/daemon`, plus `go test ./service/agentstatus` from
  `services/tuttid`. Verify provider status logs resolve `codex` to the same
  npm shim the user expects from PATH, unless PATH lacks Codex and the resolver
  intentionally falls back to a scanned nvm install.
- References:
  [resolver.go](../../packages/agent/daemon/runtimecmd/resolver.go)

### Codex provider install fails with missing npm

- Symptom:
  Agent setup or the onboarding flow repeatedly reports Codex install failures,
  and `tuttid` logs show `installerKind=codex_cli_latest`, `exitCode=127`, and
  `stderr="zsh:1: command not found: npm"` for every npm registry attempt.
- Quick checks:
  Search `tuttid.log` for `agent provider install step failed` and
  `codex_cli_latest`. If each registry fails in milliseconds with exit code
  `127`, stop investigating registry reachability; the command never reached
  npm networking.
- Root cause:
  The Codex CLI installer is daemon-owned but shells out through the daemon
  environment. Packaged desktop launches may not expose a user-managed `npm` on
  `PATH`, even though Tutti already has a managed Node runtime for workspace app
  and external-agent npm work.
- Fix:
  Resolve user `npm` first for compatibility, then fall back to the Tutti
  managed Node runtime's `npm` before running
  `npm install -g --prefix <stable-user-prefix> @openai/codex --include=optional`.
  Keep the install prefix in a resolver-searched user directory such as
  `~/.local` so the installed `codex` remains discoverable after install.
- Validation:
  Add or run service coverage for a daemon environment with no user `npm` and a
  ready managed Node runtime. Then run `pnpm lint:go` and
  `cd services/tuttid && go test ./service/agentstatus`.
- References:
  [installer_codex_cli.go](../../services/tuttid/service/agentstatus/installer_codex_cli.go)
  [runtime.go](../../services/tuttid/service/managedruntime/runtime.go)

### Malformed user skill frontmatter breaks skill discovery

- Symptom:
  Agent logs include `failed to load skill ... missing YAML frontmatter
delimited by ---`, and the composer skill picker may show partial or
  confusing skill results.
- Quick checks:
  Search daemon logs for `skill_frontmatter_invalid`, then inspect the logged
  `skillPath`. User-owned `~/.codex/skills/*/SKILL.md` and
  `~/.agents/skills/*/SKILL.md` files must start with a `---` line and include
  a closing `---` line before the body.
- Root cause:
  Provider-native skill loaders expect delimited YAML frontmatter. If Tuttid
  exposes a malformed user skill into provider runtime state, or includes it in
  composer skill options, one bad local skill can pollute diagnostics around
  otherwise valid skills.
- Fix:
  Skip user Codex skill folders with malformed frontmatter before exposing them
  under the session `CODEX_HOME/skills`, and skip malformed provider skills
  during composer skill option discovery so valid sibling skills continue to be
  recognized. Emit a structured warning with
  `error_code=skill_frontmatter_invalid` whenever a malformed skill is skipped.
- Validation:
  Add tests with malformed personal `.codex` and `.agents` skills beside valid
  skills, then run `pnpm lint:go` and
  `cd services/tuttid && go test ./... && go build ./...`.
- References:
  [codex.go](../../services/tuttid/service/agentsidecar/codex.go)
  [skill_options.go](../../services/tuttid/service/agent/skill_options.go)

### Browser Node failed navigation renders a blank panel

- Symptom:
  Opening an unreachable URL or an HTTP error page in Browser Node shows an
  empty panel or `about:blank`/Chromium error state instead of the package error
  card.
- Quick checks:
  Inspect desktop logs for `Browser Node guest navigation failed` or
  `Browser Node guest navigation returned HTTP error`, then confirm the
  renderer runtime keeps `error` after later `state` events. In DevTools, do
  not stop at the `<webview src="about:blank">`; verify whether the React error
  card is present in the DOM and whether a later state event removed it.
- Root cause:
  Electron emits several events for the same failed navigation. If
  `did-fail-load` or an HTTP status error emits an error before a later
  `publishState`, a runtime reducer that clears errors from ordinary state
  updates can erase the error card and leave only the blank webview. Browser
  event subscriptions tied only to mounted node components can also miss events
  while the workbench node body is not mounted.
- Fix:
  Treat `did-fail-load` and HTTP `did-navigate` status codes as Browser Node
  navigation failures, publish any immediate state first, and emit the final
  error after it. Keep runtime errors through non-loading state updates and
  ignore Chromium internal error URLs such as `chrome-error://chromewebdata/`
  when preserving the user-facing URL. Keep a workspace-level browser service
  connected to the Browser Node feature so host events are not owned only by
  React component mount effects.
- Validation:
  Add package tests that HTTP `>=400` emits `navigation-failed`, that failed
  navigations leave the error as the final event, that `did-fail-load` and
  `loadURL` rejection are not double-counted, and that runtime errors survive
  Chromium error-page state. For desktop integration, add coverage that browser
  events update runtime state without mounting the Browser Node component.
- References:
  [guestManager.ts](../../packages/browser/workbench-node/src/electron-main/guestManager.ts)
  [runtimeStore.ts](../../packages/browser/workbench-node/src/core/runtimeStore.ts)
  [workspaceBrowserService.ts](../../apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceBrowserService.ts)
  [BrowserNode.tsx](../../packages/browser/workbench-node/src/react/BrowserNode.tsx)

### IME composition breaks fuzzy search or controlled search inputs

- Symptom:
  Chinese, Japanese, or Korean input cannot be committed in a fuzzy search or
  mention picker. Pressing Enter to accept an IME candidate may select a
  highlighted result, submit a search, or clear/replace the partially composed
  text.
- Quick checks:
  Inspect any `keydown` handler that consumes `Enter` or `Tab` while a menu is
  open. Also inspect controlled `input[type="search"]` fields whose `value`
  comes from async search/controller state.
- Root cause:
  IME candidate confirmation is delivered through composition-aware keyboard
  events. If menu shortcuts do not check `isComposing` or the `keyCode/which`
  `229` fallback, the app treats candidate confirmation as a command. If a
  controlled search input pushes every composition update through async search
  state, stale parent values can overwrite the local composing buffer.
- Fix:
  In fuzzy/menu key handlers, return before command handling when
  `event.isComposing`, `event.nativeEvent.isComposing`, `keyCode === 229`, or
  `which === 229`. For controlled search inputs, keep a local value during
  `compositionstart`/`compositionend`, commit to the controller on
  `compositionend`, and ignore stale parent values until the parent catches up.
- Validation:
  Add a unit test for the IME guard or input sync state, then manually type a
  Chinese query and confirm Enter accepts the candidate instead of selecting a
  result or submitting the field.
- References:
  [richTextIme.ts](../../packages/ui/rich-text/src/editor/richTextIme.ts)
  [useComposedInputValue.ts](../../packages/ui/react-hooks/src/useComposedInputValue.ts)
  [WorkspaceFileReferencePickerTree.tsx](../../packages/workspace/file-reference/src/ui/internal/reference/WorkspaceFileReferencePickerTree.tsx:131)
  [IssueManagerSidebarSections.tsx](../../packages/workspace/issue-manager/src/ui/internal/shell/IssueManagerSidebarSections.tsx:190)

### IME composition leaks native input into xterm terminals

- Symptom:
  Chinese, Japanese, or Korean text appears in a workspace terminal, but using
  Space or Enter to commit the candidate sends extra or strange input into the
  PTY, leaving the shell prompt or terminal display in an unexpected state.
- Quick checks:
  Inspect custom `attachCustomKeyEventHandler` logic before suspecting the PTY
  or websocket encoding. In xterm 6, the custom key handler runs before
  `CompositionHelper.keydown`; returning `false` skips that xterm path but does
  not automatically prevent the browser's hidden textarea from receiving native
  input.
- Root cause:
  A guard that suppresses a post-composition commit key by only returning
  `false` can still allow the browser default action to mutate xterm's textarea.
  The later xterm `input` or delayed composition send can then forward polluted
  textarea content as terminal input.
- Fix:
  During active composition, do not call `preventDefault`; the browser and IME
  need native composition behavior. For post-composition commit-key suppression,
  call `preventDefault` and `stopPropagation` before returning `false`, and keep
  the short suppression window open for repeated native key events.
- Validation:
  Add unit coverage that active composition is not prevented, post-composition
  commit keys are prevented, and repeated native key events within the window
  stay suppressed. Manually verify Chinese IME candidate commit with Space and
  Enter in the workspace terminal.
- References:
  [terminalImeInputGuard.ts](../../packages/workspace/terminal/src/react/terminalImeInputGuard.ts)
  [terminalSurfaceRuntime.ts](../../packages/workspace/terminal/src/react/terminalSurfaceRuntime.ts)

### Post-composition suppression window swallows real terminal input

- Symptom:
  After committing Chinese IME text in a workspace terminal, the next quick
  keystroke is intermittently lost: Enter pressed right after the candidate
  commits does not execute the command (it must be pressed twice), fast typing
  drops the first letter of the next word, or a full-width punctuation mark
  typed immediately after a commit never reaches the PTY.
- Quick checks:
  Reproduce with fast input — commit a candidate with Space, then press Enter
  or type the next character within ~80ms. Losses that disappear when typing
  slowly point at the IME guard's post-composition window, not the PTY.
- Root cause:
  The guard suppressed every unmodified key for a fixed window after
  `compositionend` to swallow ghost commit-key events. Only keys that can
  commit a candidate (Enter, Escape, Space, digit selection keys) can replay
  after `compositionend`; blanket suppression also swallowed genuine next
  keystrokes, and blocking keyCode 229 keydowns kept xterm's
  `CompositionHelper._handleAnyTextareaChanges` from forwarding IME
  punctuation entered right after a commit.
- Fix:
  Inside the window, suppress only commit-capable keys (Enter, Escape, Space,
  digits); let all other keys through so xterm's own keyCode 229 handling
  still runs. Ghost events replay before the physical key is released, so
  close the window as soon as a keyup arrives outside composition — any later
  keydown is genuine user input, including genuine digits.
- Validation:
  Unit-cover letters and `Process` keys passing through the window, keyup
  closing the window so a repeated Enter or digit is processed, and commit
  keys (including digits) staying suppressed. Manually commit with Space then
  immediately press Enter, select a candidate with a digit key, and type
  full-width punctuation right after a commit.
- References:
  [terminalImeInputGuard.ts](../../packages/workspace/terminal/src/react/terminalImeInputGuard.ts)

### Agent GUI app mentions show unavailable workspace apps

- Symptom:
  Agent GUI or rich-text `@` app search shows App Center apps that are not
  installed or are disabled. A related slow path is the picker waiting on agent
  provider auth/status checks before showing app candidates.
- Quick checks:
  Confirm the renderer calls the daemon-owned
  `listWorkspaceAppMentionCandidates` client method instead of
  `listCliCapabilities(..., { includeHidden: true })`. In the daemon, confirm
  the mention endpoint calls App Center `List` for app visibility and calls
  CLI capabilities only with `SkipCapabilityFilters: true` for metadata.
- Root cause:
  CLI capability listing is a command-routing surface, not an app picker
  visibility contract. Using the filtered CLI path can trigger provider
  availability/auth checks; using the hidden CLI path avoids the slow checks but
  exposes uninstalled or disabled app capabilities unless App Center visibility
  is applied by the daemon.
- Fix:
  Keep Agent GUI app mention candidates behind
  `/v1/workspaces/{workspaceID}/agent-context/workspace-app-mentions`. The
  daemon should include real App Center apps only when installed and enabled,
  merge cheap CLI command/search metadata without provider filters, and expose
  CLI pseudo apps only when they do not correspond to a known App Center app.
- Validation:
  Add route-level daemon tests for installed, disabled, uninstalled, and CLI
  pseudo apps. Add renderer tests that the `workspace-app` provider consumes
  mention candidates and only reads the cached agent-provider status snapshot
  when hiding unavailable agent pseudo apps.
- References:
  [daemon_app_mentions.go](../../services/tuttid/api/daemon_app_mentions.go)
  [desktopRichTextAtService.ts](../../apps/desktop/src/renderer/src/features/rich-text-at/services/internal/desktopRichTextAtService.ts)
  [desktopAgentProviderStatusService.ts](../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/desktopAgentProviderStatusService.ts)

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
  [agentGuiConversationFilter.ts](../../packages/agent/gui/agent-gui/agentGuiNode/model/agentGuiConversationFilter.ts)
  [agentGuiConversationListStore.ts](../../packages/agent/gui/contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore.ts)
  [useAgentGUINodeController.ts](../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts)
  [AgentGUINodeView.tsx](../../packages/agent/gui/agent-gui/agentGuiNode/AgentGUINodeView.tsx)
  [agent_store.go](../../services/tuttid/data/workspace/agent_store.go)

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
  [external_import_parse.go](../../services/tuttid/service/agent/external_import_parse.go)
  [external_import_projects.go](../../services/tuttid/service/agent/external_import_projects.go)
  [agentGuiConversationModel.ts](../../packages/agent/gui/agent-gui/agentGuiNode/model/agentGuiConversationModel.ts)
  [desktopWorkspaceUserProjectService.ts](../../apps/desktop/src/renderer/src/features/workspace-user-project/services/internal/desktopWorkspaceUserProjectService.ts)
  [agentGuiConversationProjectResolver.ts](../../packages/agent/gui/agent-gui/agentGuiNode/model/agentGuiConversationProjectResolver.ts)
  [agentGuiConversationListStore.ts](../../packages/agent/gui/contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore.ts)

### Electron main/preload crashes on a workspace package `.ts` export

- Symptom:
  Desktop development starts the renderer, then Electron throws
  `TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts"` for a
  path under `packages/.../src`.
- Quick checks:
  Inspect the package named in the stack trace and any bundled workspace package
  that imports it.
  Run `pnpm check:electron-runtime-boundaries` to confirm whether the package is
  being externalized in Electron main/preload instead of bundled.
- Root cause:
  Local workspace packages intentionally export source files for monorepo
  development. Electron main/preload can only execute those packages when
  `electron-vite` bundles them. If a bundled workspace package imports another
  workspace package that is not also listed in the `externalizeDepsPlugin`
  `exclude` list, Node may try to load the transitive package's raw `.ts`
  export at runtime.
- Fix:
  Add the source-exporting workspace package, including transitive workspace
  dependencies reached by bundled main/preload code, to
  `apps/desktop/electron.vite.config.ts` `externalizeDepsPlugin({ exclude })`.
  Prefer narrow non-UI package subpaths for Electron runtime imports so the
  bundle does not pull React-facing barrels into main/preload.
- Validation:
  Run `pnpm check:electron-runtime-boundaries` and
  `pnpm --filter @tutti-os/desktop build`.
- References:
  [apps/desktop/electron.vite.config.ts](../../apps/desktop/electron.vite.config.ts)
  [tools/scripts/check-electron-runtime-boundaries.mjs](../../tools/scripts/check-electron-runtime-boundaries.mjs)

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
  [service.go](../../services/tuttid/service/agent/service.go)
  [wiring.go](../../services/tuttid/wiring.go)

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
  [catalog.go](../../services/tuttid/service/eventstream/catalog.go)
  [activity.updated.event.json](../../packages/events/protocol/definitions/agent/activity.updated.event.json)

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
  [service.go](../../services/tuttid/service/agent/service.go)
  [activity_projection.go](../../services/tuttid/service/agent/activity_projection.go)
  [WorkspaceChrome.tsx](../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/WorkspaceChrome.tsx)

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

### Codex ACP warns about user-level config as project-local config

- Symptom:
  Codex ACP startup logs include
  `Ignored unsupported project-local config keys` for user-level Codex config
  keys such as `model_provider`, `model_providers`, or `notify`.
- Quick checks:
  Inspect the session cwd and its parents for an accidental project root, such
  as a `.git` directory under `$HOME`, plus a sibling `.codex/config.toml`.
  Inspect the generated `codex-home/config.toml`; it should be a session-scoped
  file, not a symlink to the user's global Codex config.
- Root cause:
  Codex walks upward from the session cwd to identify the project root. If it
  reaches a parent directory that also contains `.codex/config.toml`, Codex can
  read the user's global config as project-local config, where user-level keys
  are unsupported.
- Fix:
  Codex sidecar preparation must treat `CODEX_HOME` as the run-scoped
  user-level Codex home for application-wide injection, not as a project root.
  Copy the user's `config.toml` into the run-scoped `codex-home`, then merge
  `project_root_markers = []` there so ACP sessions do not read accidental
  parent `.codex/config.toml` files as project-local config. Do not symlink the
  config, because the run may need session-specific config that must not mutate
  the global Codex config. Do not create marker files or directories in the
  user's cwd.
- Validation:
  Add or update `agentsidecar` tests that verify no cwd marker is created, the
  generated Codex config preserves user-level provider settings while disabling
  project root markers, and the user's global config is not modified. Run
  `pnpm lint:go` plus
  `cd services/tuttid && go test ./... && go build ./...`.
- References:
  [codex.go](../../services/tuttid/service/agentsidecar/codex.go)
  [preparer_test.go](../../services/tuttid/service/agentsidecar/preparer_test.go)

### Cursor sessions create project `.cursor/skills` or `AGENTS.md` changes

- Symptom:
  Starting a Cursor Agent session through Tutti leaves new Tutti-managed skill
  directories under the repository, such as `.cursor/skills/tutti-cli` or
  `.cursor/skills/tutti-cli-tutti-6`, or appends a `BEGIN TUTTI-RUNTIME`
  managed block to the tracked project `AGENTS.md`. The directories may
  accumulate across runs and the managed block can appear as a tracked working
  tree change.
- Quick checks:
  Inspect the session sidecar manifest for `provider-skill` entries pointing
  inside the workspace cwd. For current sessions, `TUTTI_CURSOR_PLUGIN_DIR`
  should point under the session runtime root, for example
  `~/.tutti-dev/agent/runs/<session>/cursor-plugin/tutti-cli`, and the Cursor
  ACP command should include `--plugin-dir <that-dir>` before `acp`. The
  project `AGENTS.md` should not receive a `TUTTI-RUNTIME` managed block for
  Cursor sessions.
- Root cause:
  Cursor supports local plugins via `cursor-agent --plugin-dir`, but the
  previous sidecar path reused project-local native skill installation and wrote
  Tutti injected skills to `cwd/.cursor/skills`. Repeated runs then allocated
  suffixed names instead of overwriting the session-owned materialization. The
  same Cursor preparation path also wrote provider instructions into
  `cwd/AGENTS.md`, which dirtied tracked repositories.
- Fix:
  Materialize Tutti Cursor skills as a session-scoped Cursor plugin with
  `.cursor-plugin/plugin.json` and `skills/*/SKILL.md`, expose it through
  `TUTTI_CURSOR_PLUGIN_DIR`, and start Cursor ACP as
  `cursor-agent --plugin-dir <plugin-dir> acp`. Keep user/project
  `.cursor/skills` discoverable for composer options, but never write Tutti
  injected skills or Tutti runtime instructions into the workspace cwd for
  Cursor sessions.
- Validation:
  Add `agentsidecar` coverage that Cursor prepare creates the runtime plugin
  while leaving project `.cursor/skills` and `AGENTS.md` untouched, runtime
  coverage that Cursor ACP includes `--plugin-dir`, and agent service coverage
  that Cursor composer skill discovery includes plugin skills. Then run
  `cd services/tuttid && go test ./service/agentsidecar ./service/agent` and
  `go test ./packages/agent/daemon/runtime`.
- References:
  [cursor.go](../../services/tuttid/service/agentsidecar/cursor.go)
  [acp_provider_cursor.go](../../packages/agent/daemon/runtime/acp_provider_cursor.go)
  [skill_options.go](../../services/tuttid/service/agent/skill_options.go)

### Codex provider shows login required when global service tier is legacy

- Symptom:
  The workspace dock popup shows Codex as needing login even though
  `~/.codex/auth.json` contains OAuth tokens.
- Quick checks:
  Run `codex login status`. If it prints
  `Error loading configuration: ... unknown variant ... expected fast or flex`,
  inspect the top-level `service_tier` in `~/.codex/config.toml`.
- Root cause:
  Newer Codex CLIs only accept `service_tier = "fast"` or `"flex"` in global
  config. Older values such as `"default"` or `"priority"` make the status
  command fail before it can report auth state, so tuttid classifies auth as
  unknown and the renderer shows login/refresh.
- Fix:
  Provider status and login commands should pass a temporary Codex config
  override such as `-c 'service_tier="fast"'` instead of mutating the user's
  global config. Session-scoped Codex homes should continue sanitizing copied
  config through `codexConfigWithSupportedServiceTier`.
- Validation:
  Add or update `agentstatus` tests for the Codex status/login command shape,
  then run `cd services/tuttid && go test ./service/agentstatus`.

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
  this turn lifecycle. Top-level assistant text and thinking must be keyed by
  SDK message/content-block segments rather than by turn id. Treat the live
  `content_block.index` as a stream locator only, not as durable message
  identity. Consolidated assistant messages are fallback/tail compensation only,
  because their content array indexes can differ from live `stream_event` block
  indexes when thinking or tools are present. Projection code that merges
  repeated tool-message updates should remove stale `error` data when the
  canonical status becomes completed.
- Validation:
  Add sidecar normalizer coverage for `parentToolUseId`/task steps and adapter
  coverage that terminal-after events still reach DB/UI through the session
  event sink. SDK task lifecycle events should also update
  `runtimeContext.backgroundAgents` from running to completed so composer wait
  copy clears when the background agent finishes. Add service coverage that
  runtime `backgroundAgents.count > 0` suppresses stale resume reconciliation
  even when there is no active parent turn. Add sidecar/adapter coverage for
  synthetic continuation `turn_started`, plus projection coverage that a
  completed tool update drops an earlier failed `error` payload. For alias
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

### Claude SDK Grep or Glob unavailable despite Claude Code preset

- Symptom:
  Claude emits `Grep` or `Glob`, but the SDK returns `No such tool available`
  and suggests using shell `grep` or `find`.
- Root cause:
  Some Claude Code SDK native builds expose search through `Bash` by default.
  The `claude_code` tool preset may not register dedicated `Grep`/`Glob` tools
  unless the host also lists them in `allowedTools` or `tools`.
- Fix:
  Keep the `claude_code` preset as the base tool set, and explicitly include
  `Grep` and `Glob` in Claude SDK `allowedTools`. Avoid replacing `tools` with a
  short string list unless the host intentionally wants to narrow every built-in
  tool available to Claude.
- Validation:
  Assert the sidecar start payload carries `allowedTools: ["Grep", "Glob"]`,
  and typecheck against the local `@anthropic-ai/claude-agent-sdk` definitions.

### Concurrent agent CLI installs corrupt shared npm global state

- Symptom:
  Two agent-provider installs started close together can leave global npm bins
  or package directories half-written. Follow-up probes may report
  `cli_not_found`, `acp_adapter_not_found`, or a binary that exists but fails
  immediately after install.
- Quick checks:
  Confirm whether more than one `tuttid` agent-provider install action or
  desktop install button fired at roughly the same time for commands shaped
  like `npm install -g ...`.
  Inspect the daemon run-state lock path under
  `TUTTI_STATE_DIR/run/locks/npm-global-install.lock` while an install is in
  progress to verify later installs are waiting instead of running in parallel.
- Root cause:
  npm global installs mutate shared package and bin locations. Without a
  daemon-owned cross-process lock, concurrent `npm install -g` commands can
  race while writing the same global state and leave a corrupted runtime.
- Fix:
  Serialize agent-provider `npm install -g` commands behind the daemon install
  lock and keep the lock path under daemon-owned state. Start the install
  timeout only after the lock is acquired so queued installs do not consume
  their npm execution budget while waiting. Do not auto-delete the lock on a
  timer. Instead, recover the lock during daemon startup only when the recorded
  owner pid is no longer running. If recovery is still needed manually, clear
  `npm-global-install.lock` only after verifying no install is still running.
- Validation:
  Run `pnpm lint:go` plus `cd services/tuttid && go test ./... && go build ./...`.
  Then trigger two install actions in quick succession and confirm the second
  waits for the first instead of starting another global npm mutation.

### Agent provider install looks idle while a non-Codex installer is running

- Symptom:
  Provider setup appears stuck or idle even though `tuttid.log` has an
  `agent provider install step started` entry and no matching completed/failed
  line yet. This is most visible for Claude Code CLI or ACP adapter installs.
- Quick checks:
  Compare the install start timestamp with the log export timestamp before
  calling it hung. Also check for a later completed install log line and the
  provider binary path in the rechecked runtime log. If `tuttid.log` shows
  `active_action.output_appended` but desktop diagnostics keep reporting
  `logLines=0`, check whether the status request copied `activeAction` before
  installer output arrived, or whether the renderer stopped refreshing while
  the install action was still pending.
- Root cause:
  The provider installer is daemon-owned and can legitimately run for minutes,
  but renderer progress must come from the generic provider `activeAction`
  status field. Do not special-case long-running install progress to Codex.
- Fix:
  Set, stream stdout into, expose, and clear `ActiveAction` for every provider
  install action. Keep provider-specific installer details inside
  `services/tuttid/service/agentstatus` and project only the transport-safe
  active action shape through the API seam. Refresh the provider's active action
  snapshot at the end of `List`, and short-poll provider status while a daemon
  install action is pending so live installer output can reach the wizard.
- Validation:
  Run `cd services/tuttid && go test ./service/agentstatus ./api` and
  `pnpm check:api-generated`. Trigger a Claude Code install and confirm status
  responses include `activeAction` while the CLI or adapter step is in flight.

### Legacy Claude ACP adapter appears stale after external registry migration

- Symptom:
  With `TUTTI_CLAUDE_CODE_RUNTIME=acp`, Claude Agent provider status is not
  ready, or live ACP options do not match the package version advertised by the
  ACP External Agent Registry. Another form is Claude Code context usage briefly
  showing `0%` during a running session or around compaction, then returning to
  the prior nonzero value on the next usage update. A third form is new Claude
  Code sessions failing during startup with
  `Invalid value for config option fast: standard`.
- Quick checks:
  First confirm the runtime is legacy ACP. The default Claude Code runtime is
  SDK; SDK provider availability checks the `claude` CLI plus the Claude SDK
  sidecar entry and must not require `claude-acp`.
  Inspect `<state-dir>/agent-providers/external-agent-registry/cache/registry.json`
  and the package manifest under
  `<state-dir>/agent-providers/external-agent-registry/packages/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/package.json`.
  `which claude-agent-acp` only describes a user/global shim and is no longer
  the Tutti-owned Claude adapter source. For usage flicker, inspect that
  package's `dist/acp-agent.js` for `sessionUpdate: "usage_update"` near
  `compact_boundary`; it must not publish `used: 0` when the SDK
  `getContextUsage()` probe fails. For speed failures, inspect the live
  `fast` config option values advertised by the managed package; supported
  native Claude ACP packages that fall back to select options use `off` and
  `on`.
- Root cause:
  Tutti resolves Claude ACP from the external agent registry and installs the
  npm adapter into a daemon-owned prefix with managed npm. A stale or missing
  prefix package, stale registry cache, or unavailable managed Node runtime can
  make the adapter unavailable even when a global `claude-agent-acp` exists.
  Usage flicker can also come from the managed bridge bundle itself publishing
  an invalid zero context usage after a failed compact-boundary usage probe;
  AgentGUI only displays the normalized runtime context it receives. Speed
  failures come from treating Tutti's internal `standard` / `fast` speed tier
  values as ACP wire values; supported Claude ACP packages advertise native
  `fast` config values as `off` / `on`.
- Fix:
  Run the provider install action so tuttid refreshes the registry, resolves the
  managed Node runtime, and installs the npm package into the per-agent prefix.
  Do not compensate by changing static model catalogs for behavior that should
  come from the live ACP package. Keep the Tutti claude-agent-acp patch script
  authoritative for bridge behavior and apply it to the managed package; do not
  mask invalid usage in AgentGUI. Keep Tutti's internal speed tiers stable, but
  translate Claude ACP `fast` config values at the adapter boundary according
  to the live advertised options, and normalize the live value back before
  projecting runtime settings.
- Validation:
  Run `go test ./services/tuttid/service/agentstatus`, then confirm a stale
  global adapter is ignored and the install action uses managed npm with
  `--prefix <state-dir>/agent-providers/external-agent-registry/packages/claude-acp`.
  For usage flicker, run
  `node services/tuttid/service/agentstatus/assets/patch-claude-agent-acp.mjs --dist <managed-acp-dist>`
  twice and confirm the second run reports no changes, then inspect the bundle
  and confirm `lastAssistantTotalUsage = usedTokens ?? 0` is absent. For speed
  compatibility, run the Claude ACP adapter tests that cover native `off` /
  `on` advertised values and confirm legacy `standard` / `fast` advertised
  values are ignored.
- References:
  [service.go](../../services/tuttid/service/agentstatus/service.go)
  [store.go](../../services/tuttid/service/externalagentregistry/store.go)
  [patch-claude-agent-acp.mjs](../../services/tuttid/service/agentstatus/assets/patch-claude-agent-acp.mjs)

### Cursor ACP context ring stays empty or usage looks wrong

- Symptom:
  A Cursor AgentGUI session shows an empty context ring, `0%`, or stale context
  usage while the session is actively running. Check & Settings may show the
  Cursor subscription tier from `cursor-agent about`, but account quota still
  reads as unsupported.
- Quick checks:
  Grep tuttid logs for `event=agent_session.acp.usage_update` while reproducing
  the session. Inspect `provider`, `parsed_ok`, `context_known`, `raw_used`,
  `raw_size`, `used_tokens`, `total_tokens`, and `quota_count` on each event.
  If no events appear, Cursor is not pushing ACP `usage_update` for that
  session. If events appear with `parsed_ok=false` or missing `raw_used` /
  `raw_size`, inspect the raw ACP payload shape before changing AgentGUI.
- Root cause:
  Tutti's standard ACP adapter already normalizes `usage_update` into runtime
  context, but Cursor may omit the event or publish a different payload than
  Codex/Claude bridges. Subscription tier display comes from auth probing, not
  from `usage_update`.
- Fix:
  Use the diagnostic log fields to decide whether to fix adapter parsing or wait
  for Cursor to publish usage updates. Do not mask missing usage in AgentGUI
  when the provider never sent `usage_update`.
- Validation:
  Run `go test ./packages/agent/daemon/runtime -run UsageUpdate` and start a
  Cursor session while tailing tuttid logs for
  `agent_session.acp.usage_update`.
- References:
  [standard_acp_adapter.go](../../packages/agent/daemon/runtime/standard_acp_adapter.go)
  [acp_live_state.go](../../packages/agent/daemon/runtime/acp_live_state.go)
  [service_helpers.go](../../services/tuttid/service/agentstatus/service_helpers.go)

### Claude SDK model aliases resolve to configured Anthropic defaults

- Symptom:
  A Claude Code SDK session shows a Tutti composer model alias such as `sonnet`
  or `haiku`, but the model response or error mentions a different concrete
  model such as `mimo-v2.5-pro`.
- Quick checks:
  Inspect the effective Claude Code settings env from
  `$CLAUDE_CONFIG_DIR/settings.json` or `~/.claude/settings.json`, especially
  `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
  `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, and
  `ANTHROPIC_BASE_URL`. Also inspect the session `runtime_context_json` for
  `providerConfig.baseUrl` and `model` before assuming the UI selected the
  concrete provider model directly.
- Root cause:
  The SDK sidecar passes Tutti's Claude Code aliases to
  `@anthropic-ai/claude-agent-sdk`, while the SDK/Claude Code runtime still
  resolves those aliases through the user's Claude settings env. A proxy such as
  MiMo may map `sonnet` to a configured concrete model, and provider access
  errors then mention that concrete model instead of the Tutti alias.
- Fix:
  Keep the sidecar inheriting the user's Claude settings so credentials and base
  URL keep working. Fix provider access by changing the user's Claude settings or
  managed provider model config, not by hard-coding Tutti's static alias list.
  When an old SDK session predates image-input support, normalize its
  `runtimeContext.capabilities` before projecting it to AgentGUI so stale
  persisted state does not disable prompt-image paste.
- Validation:
  Confirm the session runtime context shows `adapter: claude-agent-sdk`, the
  expected `providerConfig.baseUrl`, and an `imageInput` capability. Then run the
  Claude SDK adapter tests plus the agent service tests covering runtime-context
  normalization.
- References:
  [claude_sdk_adapter.go](../../packages/agent/daemon/runtime/claude_sdk_adapter.go)
  [service_helpers.go](../../services/tuttid/service/agent/service_helpers.go)
  [composer_live_model_discovery.go](../../services/tuttid/service/agent/composer_live_model_discovery.go)

### Published package runtime asset 404 because the consumer bundler never saw the file

- Symptom:
  An external consumer installs a public `@tutti-os/*` package, uses the
  package, and gets a browser or renderer 404 for an icon or image such as
  `dist/assets/...`. The same feature often works inside this monorepo because
  workspace source resolution or local build layout hides the packaging
  problem.
- Quick checks:
  If the failing package entrypoint renders a package-local image or icon,
  inspect whether the main runtime entrypoint still imports that asset directly
  instead of leaving it to an explicit asset subpath such as
  `./assets/workspace-dock-website.png`.
  Run `pnpm release:pack:check` and confirm the packed tarball includes the
  exported asset file under `dist/assets/...`.
  Inspect the built `dist` entrypoint and confirm the main runtime code no
  longer hard-depends on the asset unless the consumer imported it explicitly.
- Root cause:
  The public runtime entrypoint owned a default asset dependency instead of
  exposing that asset as an explicit public subpath. The packed npm artifact
  either did not ship the matching file layout or forced every consumer to pay
  the asset cost even when the feature was unused.
- Fix:
  Move the image or icon out of the main runtime entrypoint and export it
  through an explicit package asset subpath such as
  `./assets/workspace-dock-website.png`.
  Let the business consumer import that asset only when it needs the default
  visual, and keep the package build rule that copies the asset into the packed
  `dist/assets` directory.
  Apply the same rule to every public runtime subpath in the package, not just
  the first failing icon.
- Validation:
  Build the affected package, inspect the built runtime entrypoint for the
  absence of the old asset dependency, and rerun `pnpm release:pack:check`.
  If the package is consumed by desktop renderer code in this repo, also run
  the relevant desktop build to confirm the consumer bundler copies or emits
  the asset only when the business import is present.
- References:
  [docs/conventions/npm-package-release.md](./npm-package-release.md)
  [packages/browser/workbench-node/package.json](../../packages/browser/workbench-node/package.json:7)
  [packages/browser/workbench-node/src/workbench/index.ts](../../packages/browser/workbench-node/src/workbench/index.ts:111)
  [packages/workspace/issue-manager/package.json](../../packages/workspace/issue-manager/package.json:7)
  [packages/workspace/issue-manager/src/workbench/index.ts](../../packages/workspace/issue-manager/src/workbench/index.ts:217)

### External-store snapshots churn because derived reads lose reference stability

- Symptom:
  `useSyncExternalStore` consumers re-render continuously, lose memoization
  wins, or behave as if external state changed even when the underlying store
  snapshot did not.
- Quick checks:
  If the issue starts in a React component or shared React hook, look for a
  direct `useSyncExternalStore` call or an ad hoc subscription wrapper and
  route it through `@tutti-os/ui-react-hooks`.
  If the issue starts in a non-React adapter that exposes `getSnapshot()`,
  check whether it rebuilds objects or arrays on every read instead of reusing
  a derived snapshot while the source snapshot is unchanged.
- Root cause:
  A subscription boundary reads from a source that returns a fresh derived
  object or array on each `getSnapshot()` call. This can happen either in a
  React subscription wrapper or in the adapter that owns the derived snapshot.
  The type signature allows this, but the runtime contract requires
  referential stability while the source snapshot is unchanged.
- Fix:
  In React consumers and shared frontend packages, prefer
  `@tutti-os/ui-react-hooks` and use `useExternalStoreSnapshot` or
  `useExternalStoreSelector` instead of handwritten `useSyncExternalStore`
  wrappers.
  In adapter-level or non-React derived stores, reuse the derived snapshot
  until the source snapshot reference changes. In
  `@tutti-os/workbench-surface`, prefer
  `packages/workbench/surface/src/store/createDerivedSnapshotGetter.ts` for
  that boundary instead of rebuilding a fresh object inline.
- Validation:
  Add or update a regression test that asserts repeated `getSnapshot()` calls
  return the same reference before a real state change. Then run the affected
  package tests, `pnpm typecheck`, and the relevant renderer build checks when
  the subscriber is consumed by desktop UI.
- References:
  [packages/ui/react-hooks/src/useExternalStoreSnapshot.ts](../../packages/ui/react-hooks/src/useExternalStoreSnapshot.ts)
  [packages/ui/react-hooks/src/useExternalStoreSelector.ts](../../packages/ui/react-hooks/src/useExternalStoreSelector.ts)
  [packages/workbench/surface/src/store/createDerivedSnapshotGetter.ts](../../packages/workbench/surface/src/store/createDerivedSnapshotGetter.ts)
  [packages/workbench/surface/src/host/missionControlAdapter.ts](../../packages/workbench/surface/src/host/missionControlAdapter.ts)
  [packages/workbench/surface/src/host/missionControlAdapter.test.ts](../../packages/workbench/surface/src/host/missionControlAdapter.test.ts)

### Workbench host rebuilds when dock business status changes

- Symptom:
  Clicking a dock action such as local agent login opens a browser or starts a
  backend command, but the expected terminal or agent node disappears, is not
  created, or loses context. The UI can look like the action ran in the
  background while the Workbench session was rebuilt underneath it.
- Quick checks:
  Search the workspace shell for `useSyncExternalStore` subscriptions,
  revision values, or React state that feed `createHostInput(...)`.
  If provider status, quota, sync, installation, or authentication state is in
  that dependency list, inspect whether status changes are recreating
  `WorkbenchHost` props, node definitions, or contribution objects.
  Also check whether `dockEntries` include live business fields that change on
  every status refresh.
- Root cause:
  High-churn business status was modeled as host input state instead of dock
  presentation state. Each status revision rebuilt the Workbench host input and
  could tear down or replace the active host/session while an action still
  needed the old host handle.
- Fix:
  Keep `dockEntries` and Workbench host input stable for static workspace
  wiring. Route live dock presentation through
  `WorkbenchHostDockEntryStateSource` or an equivalent service-backed getter
  plus subscription. The dynamic source may expose disabled/loading state,
  badges, hover actions, attention tokens, and temporary visibility, but it
  should not own node definitions or launch wiring. Dock action callbacks
  should receive the current `WorkbenchHostHandle` from the dock interaction
  instead of reading a host from stale outer React state.
- Validation:
  Add a regression test for the dynamic state source that proves one source
  object reads updated service snapshots without recreating host input.
  Then run desktop typecheck and relevant tests. For runtime verification,
  start the desktop or web renderer, trigger a login/install dock action, and
  confirm the terminal or agent node remains stable while dock status updates.
- References:
  [docs/architecture/workbench-dock-model.md](../architecture/workbench-dock-model.md)
  [packages/workbench/surface/src/host/types.ts](../../packages/workbench/surface/src/host/types.ts)
  [packages/workbench/surface/src/host/WorkbenchHostDock.tsx](../../packages/workbench/surface/src/host/WorkbenchHostDock.tsx)
  [workspaceAgentProviderDockStateSource.ts](../../apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceAgentProviderDockStateSource.ts)
  [useWorkspaceWorkbenchShellRuntime.tsx](../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/useWorkspaceWorkbenchShellRuntime.tsx)

### Effect cleanup leaves mounted refs false in React development

- Symptom:
  A React component works far enough to start async work, but later promise
  continuations silently skip state updates behind an `isMountedRef.current`
  guard. In development, the UI can remain permanently stuck in a loading
  state even though the backend request succeeded.
- Quick checks:
  Search the component for an effect cleanup that sets an `isMountedRef` or
  similar lifecycle ref to `false`. If the effect body returns the cleanup
  directly, verify the setup path also sets the ref back to `true`.
- Root cause:
  React development and StrictMode can run an effect cleanup followed by setup
  while the component continues to be used for validation. If setup does not
  restore the mounted ref, later async callbacks treat the live component as
  unmounted and drop state updates.
- Fix:
  Use an effect body that sets the mounted ref to `true` before returning the
  cleanup that sets it to `false`.
- Validation:
  Run the affected React package tests and cold-start the consuming desktop UI,
  because hot reload can preserve the stale ref value from before the fix.
- References:
  [useAgentGUINodeController.ts](../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUINodeController.ts)

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
  [controller.go](../../packages/agent/daemon/runtime/controller.go)
  [controller_test.go](../../packages/agent/daemon/runtime/controller_test.go)

### Desktop restart leaves an orphan tuttid

- Symptom:
  The desktop logs `Timed out waiting for tuttid listener info: daemon runtime
information is not available yet`, but `ps` or `lsof` still shows an older
  `tuttid` process holding the development database or a loopback listener.
- Quick checks:
  Inspect `~/.tutti-dev/run/tuttid.pid`, run `lsof` on
  `~/.tutti-dev/tuttid.db`, and check whether the daemon process
  has parent PID `1`. That combination means the Electron parent no longer owns
  the process even though the daemon survived.
- Root cause:
  In development, launching through `go run` can create a wrapper process and a
  compiled daemon child. Killing only the direct child can leave the compiled
  daemon alive. If the desktop also removes the listener info file before the
  next launch, the orphan can keep local state busy while the new managed daemon
  never publishes runtime info within the startup timeout.
- Fix:
  Prefer a prebuilt `apps/desktop/build/tuttid/tuttid` binary in development
  when present, kill managed daemon process groups during desktop shutdown,
  write and clear `tuttid.pid`, and inject `TUTTI_DESKTOP_PARENT_PID` so
  `tuttid` can self-shutdown when its desktop parent disappears.
- Validation:
  Repeatedly quit and restart the desktop, then confirm there is at most one
  `tuttid` process and that `~/.tutti-dev/run/tuttid.pid`
  matches it. Also run the desktop daemon-manager tests and
  `cd services/tuttid && go test .`.
- References:
  [tuttidManager.ts](../../apps/desktop/src/main/daemon/tuttidManager.ts)
  [main.go](../../services/tuttid/main.go)

### Workbench node body warns about updating WorkbenchNodeLayer during render

- Symptom:
  Opening a workbench node shows React's warning that
  `WorkbenchNodeLayer` is updated while rendering a different node body
  component. The node may stay on a loading surface even though the backing
  request succeeds.
- Quick checks:
  Inspect controller construction paths called from React render or `useMemo`.
  If the constructor calls `setActiveFile`, subscribes with an immediate
  callback, publishes node runtime state, or calls any host setter, it can
  synchronously update the workbench layer during render. Also inspect effect
  cleanups that call `controller.dispose()`: React StrictMode can run an
  immediate cleanup/setup cycle in development, so disposing the same retained
  controller during that validation pass can make later async responses look
  stale forever.
- Root cause:
  Workbench node bodies can create controllers while rendering. Any synchronous
  controller side effect that calls `context.setNodeRuntimeState`,
  `context.setSnapshotNodeState`, or a React state setter escapes into the
  parent layer before React has finished rendering the body.
- Fix:
  Keep controller construction side-effect free. Start active-file work,
  subscribe snapshots, and perform the initial snapshot sync from `useEffect`.
  If a subscriber must receive the current snapshot immediately, subscribe and
  then invoke the listener from the effect body. Dispose retained controllers
  with a StrictMode-safe delayed cleanup that can be canceled if the same
  controller is set up again immediately.
- Validation:
  Verify construction does not call host state publishers, then run the
  affected desktop tests and open the node in development with DevTools visible.
- References:
  [workspaceFilePreviewNodeController.ts](../../apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceFilePreviewNodeController.ts)
  [WorkspaceFilePreviewNodeBody.tsx](../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/WorkspaceFilePreviewNodeBody.tsx)

### App update diagnostics flood with identical download progress states

- Symptom:
  Renderer diagnostics show hundreds of
  `app_update.state_applied` events per minute during update downloads, often
  with identical payloads. `AppUpdateStatus` may re-render without visible UI
  changes.
- Quick checks:
  Compare consecutive diagnostic payloads for `status`, `downloadPercent`, and
  `downloadedBytes`. Inspect whether main-process `applyState` and renderer
  `applyUpdateState` both commit every IPC event.
- Root cause:
  `electron-updater` can emit high-frequency download progress callbacks. Without
  a shared `AppUpdateState` equality guard at the commit boundary, identical
  states still emit IPC, write the valtio store, and log diagnostics.
- Fix:
  Compare incoming state with the current snapshot via
  `isSameAppUpdateState()` before committing in both main `applyState` and
  renderer `applyUpdateState`. Keep diagnostics on successful commits only.
- Validation:
  Run desktop app-update tests and confirm repeated identical progress events
  produce a single state change.
- References:
  [appUpdateState.ts](../../apps/desktop/src/shared/contracts/appUpdateState.ts)
  [appUpdateService.ts](../../apps/desktop/src/main/update/appUpdateService.ts)
  [appUpdateService.ts](../../apps/desktop/src/renderer/src/features/app-update/services/internal/appUpdateService.ts)

### macOS in-app update closes Tutti but does not install the new version

- Symptom:
  After downloading a desktop update on macOS, clicking **Install** closes or
  relaunches Tutti, but reopening the app still shows the old version. ShipIt
  logs may contain `SQRLInstallerErrorDomain Code=-9` or
  `App Still Running Error`.
- Quick checks:
  Confirm the packaged build is signed (unsigned or ad-hoc builds disable in-app
  updates). Inspect `~/Library/Caches/sh.tutti.desktop.ShipIt/ShipIt_stderr.log`
  for `Aborting update attempt because there are 1 running instances of the
target app`. Compare `/Applications/Tutti.app/Contents/Info.plist` with the
  cached update under `~/Library/Caches/@tutti-osdesktop-updater/pending`.
- Root cause:
  Squirrel.Mac refuses to replace `/Applications/Tutti.app` while any target
  app instance is still running. Stopping `tuttid` before `quitAndInstall()` is
  not sufficient because the Electron main process and helper windows still need
  to complete the app quit path.
- Fix:
  Keep daemon shutdown in the desktop lifecycle instead of the update service.
  `installUpdate()` should mark the install pending and call
  `quitAndInstall()`. The `before-quit` gate should still run for pending update
  installs: prevent the first quit, stop managed `tuttid`, destroy all windows,
  then call `app.quit()` again so the app process exits and ShipIt can replace
  the bundle.
- Validation:
  Run `src/main/desktopAppLifecycle.test.ts` and
  `src/main/update/appUpdateService.test.ts`, including updater error and
  synchronous `quitAndInstall()` failure cases. Then install a downloaded update
  in a packaged macOS build; the app should relaunch on the new version and
  ShipIt should not log `App Still Running Error`.
- References:
  [appUpdateService.ts](../../apps/desktop/src/main/update/appUpdateService.ts)
  [desktopAppLifecycle.ts](../../apps/desktop/src/main/desktopAppLifecycle.ts)
  [desktopAppServices.ts](../../apps/desktop/src/main/desktopAppServices.ts)

### Desktop Performance trace export runs out of memory

- Symptom:
  Chrome DevTools Performance export or trace parsing fails with
  `Maximum call stack size exceeded` or V8 `CALL_AND_RETRY_LAST` OOM while the
  desktop app is running through `make dev-gui`.
- Quick checks:
  Keep the trace short and disable renderer diagnostics that inflate tracks:
  `VITE_TUTTI_WHY_DID_YOU_RENDER=0 make dev-gui`. For CDP-based trace capture,
  launch with
  `TUTTI_ELECTRON_REMOTE_DEBUGGING_PORT=9223 TUTTI_ELECTRON_JS_FLAGS=--max-old-space-size=8192`.
  Confirm the port with `curl http://127.0.0.1:9223/json/version`.
- Root cause:
  DevTools can run out of stack or old-space memory while processing large trace
  payloads. Passing extra CLI args through `electron-vite` is not reliable enough
  for these diagnostics, so the desktop main process owns the Electron command
  line switches.
- Fix:
  Prefer CDP `Tracing.start` with `transferMode: "ReturnAsStream"` for large
  captures instead of DevTools UI export. Record only the smallest repro window.
- Validation:
  Restart the desktop app, confirm the remote debugging endpoint responds, record
  a short trace, and verify the trace JSON is written without opening the
  Performance export path.

### Renderer component repeatedly re-renders without visible changes

- Symptom:
  The desktop renderer feels stuck, text flickers, or React reports
  `Maximum update depth exceeded`, but the current stack only points at the
  component that called `setState`.
- Quick checks:
  First inspect state-sync diagnostics. Enable the renderer-wide React Profiler
  only when its render-storm diagnostics are needed by launching with
  `VITE_TUTTI_REACT_PROFILER=1`; leave it off for Chrome Performance captures
  on large workspaces because React dev component tracks can make trace
  initialization stall. For prop identity churn, why-did-you-render is enabled
  by default when launching with `make dev-gui`. Disable that default with
  `VITE_TUTTI_WHY_DID_YOU_RENDER=0 make dev-gui`, or set
  `localStorage.tuttiWhyDidYouRender = "0"` in DevTools and reload the renderer.
  For other development entrypoints, enable it by setting
  `localStorage.tuttiWhyDidYouRender = "1"` and reloading the renderer.
- Root cause:
  React StrictMode can intentionally replay setup/cleanup in development, but a
  continuously increasing render count usually means a parent is passing a new
  object/function every render or an effect writes state from a dependency that
  changes on every render.
- Fix:
  Stabilize the value at the ownership boundary, or remove derived presentation
  values from bidirectional state. For external/workbench state, only sync
  canonical identifiers and derive display text from the owning service.
- Validation:
  With why-did-you-render enabled, reproduce once and confirm the noisy
  component lists the expected prop or hook difference. Then disable the tool
  and run the affected renderer tests plus desktop typecheck.
- References:
  [main.tsx](../../apps/desktop/src/renderer/src/main.tsx)
  [whyDidYouRender.ts](../../apps/desktop/src/renderer/src/lib/whyDidYouRender.ts)

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
  [desktopAgentActivityAdapter.ts](../../apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.ts)
  [createDesktopAgentActivityRuntime.ts](../../apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.ts)
  [agent-gui-node.md](../architecture/agent-gui-node.md)

### Browser Node focus pings miss iframe-hosted editors

- Symptom:
  Clicking or typing inside a workspace app selects text or edits content, but
  the owning Browser Node does not become the active node. This commonly shows
  up in rich document editors that render the editable surface inside a
  same-origin `iframe` or `srcdoc` frame.
- Quick checks:
  Inspect whether the app portals or mounts its editor into an iframe document.
  If the top-level workspace app preload listens on `window.document` only, the
  host will not receive pointer, focus, or keyboard pings from that child frame.
- Root cause:
  DOM events do not bubble from iframe documents to the parent document. Electron
  webview preloads also do not run in subframes unless the host enables
  `nodeIntegrationInSubFrames`, so iframe-hosted editors can interact normally
  while the Browser Node focus bridge stays silent.
- Fix:
  Enable subframe preload execution only for host-controlled Browser Node or
  workspace app guest preloads. Keep privileged workspace app bridges, such as
  `tuttiExternal`, and behavior-changing guest logic, such as `_blank` link
  interception, main-frame-only via `process.isMainFrame`. Install only passive
  interaction forwarding in subframes.
- Validation:
  Run Browser Node and desktop preload tests, desktop typecheck, and the desktop
  build. For workspace app preloads, inspect the built preload output so the
  guest files remain self-contained.
- References:
  [webviewSecurity.ts](../../packages/browser/workbench-node/src/electron-main/webviewSecurity.ts)
  [workspaceApp.ts](../../apps/desktop/src/preload/entries/workspaceApp.ts)
  [workspaceAppInteractionForwarding.ts](../../apps/desktop/src/preload/entries/workspaceAppInteractionForwarding.ts)

### Agent generated files under system temp do not open

- Symptom:
  Agent GUI shows a generated or changed file under a path such as
  `/var/folders/.../T/codex-presentations/...`, but clicking the file from
  Agent GUI or Message Center does not reveal it in FileManager.
- Quick checks:
  Confirm the desktop workspace files launch coordinator accepts the path, then
  confirm `tuttid` resolves the workspace file root for the requested absolute
  path instead of forcing the user home root. For Message Center clicks, confirm
  `open-local-asset-preview` link actions route into the same workspace files
  launch path as `open-file-manager`.
- Root cause:
  Some agent tools write durable-looking outputs to system temporary
  directories. FileManager can reveal a precise local path, but both the
  renderer launch filter and daemon workspace root resolution must allow that
  external absolute path. Message Center shares Agent GUI link actions, so a
  preview-only action that returns `false` can block the file panel even when
  the lower-level FileManager support is correct.
- Fix:
  Treat explicitly launched local absolute paths like direct hidden-file reveal:
  do not add them as projects or default locations, but allow FileManager to
  load the parent directory and apply normal local-file operations. Route
  `open-local-asset-preview` through `launchWorkspaceFiles` until a dedicated
  preview surface exists.
- Validation:
  Run the desktop Agent GUI link action test, the workspace files launch
  coordinator test, and `pnpm check:changed` for mixed desktop/Agent GUI
  changes.
- References:
  [desktopAgentGUILinkActions.ts](../../apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentGUILinkActions.ts)

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
  [agentGuiConversationListStore.ts](../../packages/agent/gui/contexts/workspace/presentation/renderer/agentGuiConversationList/agentGuiConversationListStore.ts)
  [workspaceAgentMessageCenterModel.ts](../../packages/agent/gui/agent-message-center/workspaceAgentMessageCenterModel.ts)
  [workspaceAgentMessageCenterViewModel.ts](../../packages/agent/gui/agent-message-center/workspaceAgentMessageCenterViewModel.ts)

### FileManager home-relative paths break only the list pane

- Symptom:
  Launching FileManager for a path such as `~/docs/spec.md` leaves the left
  file list, selection, or reveal state wrong while a separate file preview can
  still open the file.
- Quick checks:
  Trace whether the path reaches `requestWorkspaceFilesLaunch` as `~/...` or
  was already rewritten by AgentGUI link resolution. Then compare the
  FileManager list request with the preview-node read path.
- Root cause:
  FileManager list/reveal goes through workspace logical path normalization and
  `tuttid` directory listing. Those layers treat `~/...` as a relative segment,
  not as the user home. Preview nodes can bypass that chain by reading an
  already absolute local file path directly.
- Fix:
  Expand `~` and `~/...` at the desktop launch boundary using the platform
  home directory, and keep AgentGUI link actions from resolving home-relative
  paths against the project root before desktop launch.
- Validation:
  Run the workspace files launch coordinator test and the AgentGUI workspace
  link action test, then `pnpm check:changed` for mixed desktop and AgentGUI
  changes.

### Claude SDK rejects live bypassPermissions mode

- Symptom:
  A Claude Code SDK session starts in `default`, `auto`, or plan mode, then live
  switching to `bypassPermissions` fails with
  `Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions`.
  Or the session state already shows `permissionModeId=bypassPermissions`, but
  ordinary tools such as Bash still surface AgentGUI approval prompts.
- Quick checks:
  Inspect the SDK query options emitted by `packages/agent/claude-sdk-sidecar`.
  `allowDangerouslySkipPermissions` must be enabled when the query is created,
  not only when the initial permission mode is already `bypassPermissions`.
  In root/sandboxed runtimes, confirm the sidecar process receives
  `IS_SANDBOX=1`. If the query launched correctly, inspect the sidecar
  `canUseTool` callback path; bypass mode should short-circuit ordinary tools
  after preserving special handling for `AskUserQuestion` and `ExitPlanMode`.
- Root cause:
  Claude SDK treats bypass permission support as a session launch capability.
  `query.setPermissionMode("bypassPermissions")` cannot enable that capability
  after the query has already started. Tutti's sidecar also owns the
  `canUseTool` callback; if that callback always requests AgentGUI approval,
  it can reintroduce prompts even after the SDK permission mode is bypass.
- Fix:
  Gate bypass availability with the same rule as Claude Agent ACP: non-root
  processes can bypass, and root processes can bypass only when `IS_SANDBOX` is
  set. Launch the SDK query with `allowDangerouslySkipPermissions` whenever
  that gate passes, regardless of the current permission mode. In `canUseTool`,
  handle `AskUserQuestion` and `ExitPlanMode` first, then directly allow
  ordinary tools when the effective permission mode is `bypassPermissions`.
- Validation:
  Add sidecar coverage for a `default` session whose query still receives
  `allowDangerouslySkipPermissions: true`, plus daemon runtime coverage that
  Claude SDK sidecar process env includes `IS_SANDBOX=1`. Add callback coverage
  proving bypass mode allows an ordinary Bash request without
  `approval_requested`, while `AskUserQuestion` still surfaces user input.

### Claude Code logs out after sending a message (invalid_grant, credentials wiped)

- Symptom:
  Inside the desktop app, sending a message around the OAuth token expiry window
  leaves Claude Code in a "Not logged in · Please run /login" state. The keychain
  entry (`Claude Code-credentials`) has empty `accessToken`/`refreshToken` and
  `expiresAt: 0`, while the plaintext `~/.claude/.credentials.json` may still hold
  a valid token. The Claude CLI alone does not reproduce it.
- Quick checks:
  Capture `/v1/oauth/token` traffic (mitmproxy). A failure may show `Client
disconnected` immediately before later refresh attempts return `400
invalid_grant`. Daemon logs may also show an extra `claude-code` process start
  with `cwd=/`, `hasModel=false`, and a different `agent_session_id` from the
  real conversation session; that shape is the hidden live-model discovery
  session.
- Root cause:
  Composer-options loading spawned a hidden, `visible:false` Claude live-model
  discovery session that shares the on-disk credential store with the real
  conversation session and deleted it as soon as the model list was read. When
  it performs an OAuth refresh near expiry, the server can rotate the refresh
  token even if the local client disconnects before receiving or persisting the
  response. The real session later refreshes with the now-consumed refresh
  token, gets `400 invalid_grant`, and Claude Code wipes the stored credentials.
  Because `fallbackStorage` prefers the (now empty) keychain entry over the
  still-valid plaintext file, the user is locked out.
- Fix:
  Cold composer options must always have a static Claude fallback (`default`,
  `opus`, `sonnet`, `haiku`, plus any configured custom model) so the UI never
  depends on live discovery. A cold-start live discovery may run at most once per
  provider/workspace/cwd cache key, but it must be hidden, serialized with other
  Claude startups, and deleted only after a delayed grace period rather than
  immediately after the model list appears. Successful discovery updates the
  daemon live-model cache; later composer-options calls prefer cached models or
  model options reported by a real running Claude session over the static
  fallback. Claude Create model validation should only use cached live-model
  options; it must not start discovery. If the daemon exits before the delayed
  cleanup timer fires, later persisted-session reads must delete the stale
  hidden discovery session instead of restoring it as a real conversation.
- Validation:
  Add daemon service tests for Create cache-only validation, SendInput waiting
  on the Claude startup slot before runtime exec, static Claude cold-start model
  options, reusing model options from a running Claude session, cold-start
  discovery running once, delayed hidden discovery cleanup, and stale persisted
  hidden discovery cleanup after restart. Run targeted agent service Go tests
  plus the daemon Go lint/test/build lanes.
- References:
  [composer_live_model_discovery.go](../../services/tuttid/service/agent/composer_live_model_discovery.go)
  [model_validation.go](../../services/tuttid/service/agent/model_validation.go)
