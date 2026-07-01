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
  say `secondary tutti instance detected`.
- Quick checks:
  Run `DEV_GUI_SKIP_START=1 make dev-gui` to isolate prerequisite setup from
  Electron startup. If full startup exits after `start electron app...`, inspect
  `~/.tutti-dev/logs/tutti-desktop.log` and check whether `/Applications/Tutti.app`
  or another Tutti instance is already running.
- Root cause:
  Shells launched by tools can put another `pnpm` earlier on `PATH` than
  corepack's shim, so `corepack prepare` succeeds but the script still validates
  the wrong `pnpm`. Electron's single-instance lock also follows Electron
  userData; if development and production share userData, a running production
  app makes the dev app quit as a secondary instance. Agent shells launched from
  the packaged app may inherit `TUTTI_ENV=production`, so `make dev-gui` must
  force the development environment instead of preserving that inherited value.
- Fix:
  Prefer the corepack shim directory before checking or running `pnpm`, and set
  development Electron userData to an environment-specific path before
  requesting the single-instance lock. Ensure the dev-gui script exports
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
  Treat exact user-project path matches as explicit user intent, then call the
  host no-project resolver before parent project matching. The desktop resolver
  should recognize generated `$HOME/Documents/tutti/session-<uuid>` cwd values
  while allowing explicit registered projects to override them. External import
  should mark home-cwd sessions and known provider scratch cwd shapes as
  no-project in `runtimeContext`, skip them when registering user-project paths,
  and let Agent GUI preserve that no-project mode during later project
  re-resolution. Keep the project field derived in the Agent GUI view-model
  rather than writing it back into the conversation store.
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
  prompt again under Output even though the tool never returned a result. A
  related symptom is a completed `spawnAgent`, `wait`, or `closeAgent` row that
  expands to only the original task prompt, despite the Codex rollout JSONL
  containing `function_call_output` details.
- Quick checks:
  Compare `workspace_agent_sessions.provider_session_id` with app-server
  notification `threadId` values in `tuttid.log`/run traces. Inspect
  `workspace_agent_messages.payload` for the suspect tool call: if it has
  `input.prompt`/`input.task` but no `output` or `error`, the GUI must not
  synthesize an Output section from the summary or prompt. For Codex
  collaboration tools, also inspect the raw app-server `collabAgentToolCall`
  item for `receiverThreadIds`/`receiver_thread_ids` and
  `agentsStates`/`agents_states`; successful waits and closes often report
  child results through those fields rather than top-level `output`.
- Root cause:
  Codex app-server streams parent and child-thread notifications over the same
  connection. Transcript, tool, and `turn/completed` notifications must be
  scoped to the active provider thread before they update the parent turn. On
  the renderer side, task-like tools use the summary/title for compact labels,
  but missing result payloads are not tool output. App-server collaboration
  tools also use structured thread-state fields for results: `spawnAgent`
  returns child thread ids, `wait` returns per-agent states, and `closeAgent`
  returns the previous child state.
- Fix:
  Drop notifications that carry a non-empty `threadId` different from the
  session `provider_session_id`, with debug logging that records expected
  thread, event thread, turn, item id/type/status, and method. Keep notifications
  without `threadId` compatible. For Agent/task cards, render Output only from
  actual `output`/`error` payload text, not from the prompt or summary. When
  normalizing `collabAgentToolCall`, carry `receiverThreadIds` and
  `agentsStates` into `rawInput`/`rawOutput` so `wait` and `closeAgent` preserve
  completed child results and `spawnAgent` preserves the started child id.
- Validation:
  Add a Codex app-server test that injects foreign-thread `agentMessage` and
  `turn/completed` notifications during a parent turn, plus AgentGUI projection
  tests for failed Agent calls with prompt-only payloads. Add collab-agent
  normalizer tests for failed spawn output, started child ids, wait completed
  results, and close previous status. Run the focused Go and GUI specs for
  those paths.

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

### ACP adapter appears stale after external registry migration

- Symptom:
  Claude Agent provider status is not ready, or live ACP options do not match
  the package version advertised by the ACP External Agent Registry. Another
  form is Claude Code context usage briefly showing `0%` during a running
  session or around compaction, then returning to the prior nonzero value on
  the next usage update. A third form is new Claude Code sessions failing
  during startup with `Invalid value for config option fast: standard`.
- Quick checks:
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
  After downloading a desktop update on macOS, clicking **Install** closes Tutti.
  Reopening the app still shows the old version.
- Quick checks:
  Confirm the packaged build is signed (unsigned or ad-hoc builds disable in-app
  updates). Inspect desktop logs for `desktop app before quit` immediately after
  `application update install requested` without a relaunch.
- Root cause:
  `electron-updater` calls `quitAndInstall()` during Squirrel.Mac install.
  Desktop's async `before-quit` gate called `event.preventDefault()` to stop
  `tuttid` gracefully, which cancelled the updater's first quit and prevented
  the install/relaunch sequence from completing.
- Fix:
  Stop managed `tuttid` inside `installUpdate()` before calling
  `quitAndInstall()`, mark the update install as pending, and bypass the async
  `before-quit` gate while that flag is set. If stopping `tuttid` fails, abort
  the install before calling `quitAndInstall()`. If the updater reports an
  install error after the pending flag is set, clear the flag and restart
  managed `tuttid` so the desktop process does not stay open with its daemon
  stopped.
- Validation:
  Run `src/main/desktopAppLifecycle.test.ts` and
  `src/main/update/appUpdateService.test.ts`, including mock install failure
  recovery cases. Then install a downloaded update in a packaged macOS build;
  the app should relaunch on the new version.
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
