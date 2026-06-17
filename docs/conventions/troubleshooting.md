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
  desktop's internal `TUTTI_BROWSER_MCP_ENTRY_PATH` handoff.
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
- References:
  [service.go](../../services/tuttid/service/agentstatus/service.go)
  [install_lock.go](../../services/tuttid/service/agentstatus/install_lock.go)

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
