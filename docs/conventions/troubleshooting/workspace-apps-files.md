# Troubleshooting: Workspace Apps And Files

[Back to troubleshooting index](./README.md)

### Windows workspace reference type filters time out

- Symptom:
  On Windows, opening the Agent reference picker and selecting a file type with
  an empty search term fails with `workspace_operation_failed`. Structured
  `workspace local file search failed` logs show
  `provider=windows-system-index`, `query_length=0`, a non-empty `filters`
  value, and `context deadline exceeded` near the search deadline.
- Quick checks:
  Reproduce with
  `GET /v1/workspaces/{workspaceID}/files/search?query=&limit=30&includeKinds=file&filters=document`.
  Compare the requested result limit with the Windows Search SQL candidate
  limit, and time PowerShell startup separately from the OleDb query. Lowering
  only `SELECT TOP` is not sufficient evidence that a recursive `SCOPE` query
  will meet the deadline.
- Root cause:
  The filter-only path sent one recursive `SCOPE` query with every selected
  category extension and asked Windows Search for 5000 candidates even though
  the UI needed 30. More fundamentally, it launched PowerShell and initialized
  OleDb on every request; measured process startup alone could exceed the
  1.5-second search budget. On affected machines the provider was canceled
  before it could return any result.
- Fix:
  Keep keyword searches on the recursive indexed query. For empty-query type
  filters, use an in-process breadth-first traversal with separate directory,
  entry, and matching-result limits; read large directories in batches, avoid
  hidden/noise and reparse-point directories, and stop before the existing
  hard deadline. Keep the common Go filtering pass as the final semantic guard.
- Validation:
  Cover filter-only script generation, result/candidate bounds, `other`
  category semantics, hidden and reparse-point handling, the unchanged keyword
  path, and the same daemon HTTP request on Windows. A successful live response
  must avoid the provider timeout and contain only the requested category.
- References:
  [files.go](../../../services/tuttid/service/workspace/files.go)
  [local_files_search.go](../../../services/tuttid/data/workspace/local_files_search.go)
  [local_files_search_windows.go](../../../services/tuttid/data/workspace/local_files_search_windows.go)

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
  projection. Host-owned root-provider completion, failure, and cancellation
  settle the canonical root Turn without sending the legacy live Turn state
  patch. A consumer registered only on that legacy notification path therefore
  misses all three terminal outcomes. Plain `interrupted` remains ambiguous
  because approval rejections and transient turn-level interruptions can use
  the same vocabulary.
- Fix:
  Register App Factory explicitly for synthesized canonical root-Turn
  settlement states. Route `completed` into validation, `failed` into job
  failure, and `canceled` into job cancellation. Serialize terminal handling
  per linked agent session so at-least-once or concurrent delivery cannot start
  validation twice. Keep plain active-session `interrupted` non-terminal; only
  the explicit canceled state or the runtime's canceled interrupted
  non-approval tool-call shape cancels the job.
- Validation:
  Add App Factory service tests for plain `interrupted` staying non-terminal,
  explicit `canceled` outcome canceling the job, canceled interrupted
  non-approval tool calls canceling the job, canceled approval updates being
  ignored, all three canonical root-Turn terminal outcomes updating the job,
  and duplicate completed settlements starting only one validation pass.
- References:
  [app_factory_agent_state.go](../../../services/tuttid/service/workspace/app_factory_agent_state.go)
  [app_factory_test.go](../../../services/tuttid/service/workspace/app_factory_test.go)

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
  [apps.go](../../../services/tuttid/service/workspace/apps.go)
  [apps_catalog_test.go](../../../services/tuttid/service/workspace/apps_catalog_test.go)

### Workspace app commands fail inside Corepack before pnpm starts

- Symptom:
  A workspace app launches successfully, but a repository check or Git hook
  fails immediately with `Cannot find module './lib/corepack.cjs'`. The require
  stack points at the managed runtime's `node/bin/corepack`, and several
  unrelated check lanes fail before executing their own logic.
- Quick checks:
  Inspect `node/bin/corepack` below the injected `TUTTI_APP_RUNTIME_ROOT`. A
  broken artifact contains the same JavaScript as Corepack's
  `dist/corepack.js` as a regular file. A valid artifact contains a standalone
  wrapper that invokes the packaged Node binary and
  `../lib/node_modules/corepack/dist/corepack.js`.
- Root cause:
  Node publishes `bin/corepack` as a relative symlink. Dereferencing that
  symlink while staging a zip copies the target JavaScript into `node/bin`;
  its relative `./lib/corepack.cjs` import then resolves from the wrong
  directory. Rewriting only the npm and npx shims leaves Corepack broken and
  shadows any usable Corepack later on `PATH`.
- Fix:
  Replace `node/bin/corepack` during runtime artifact assembly with a standalone
  wrapper, validate it with `corepack --version`, and bump the immutable runtime
  version before publishing. Treat cached Node components without that wrapper
  contract as unavailable so the resolver replaces an already-broken cache.
- Validation:
  Run
  `node --test tools/scripts/build-tutti-app-runtime-catalog.test.mjs` and
  `cd services/tuttid && go test ./service/managedruntime ./service/workspace`.
  Inspect the assembled archive and confirm `node/bin/corepack --version`
  succeeds with only the packaged runtime directory first on `PATH`.
- References:
  [publish-tutti-app-runtime.yml](../../../.github/workflows/publish-tutti-app-runtime.yml)
  [runtime.go](../../../services/tuttid/service/managedruntime/runtime.go)
  [workspace-app-runtime.md](../workspace-app-runtime.md)

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
  [sqlite_apps.go](../../../services/tuttid/data/workspace/sqlite_apps.go)
  [app_packages.go](../../../services/tuttid/service/workspace/app_packages.go)

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
  [workspaceAppCenterContribution.tsx](../../../apps/desktop/src/renderer/src/features/workspace-app-center/services/internal/workspaceAppCenterContribution.tsx)
  [workspaceAppCenterLaunchRequest.ts](../../../apps/desktop/src/renderer/src/features/workspace-app-center/services/internal/workspaceAppCenterLaunchRequest.ts)
  [dockEntries.ts](../../../packages/workbench/surface/src/host/dockEntries.ts)

### Agent inline app opening leaks into the OS App Center

- Symptom:
  Opening an app from the OS App Center replaces the catalog inline instead of
  creating or focusing the app-specific Workbench Node and Dock entry. The same
  inline behavior is expected in the standalone Agent Apps sidebar.
- Quick checks:
  Confirm `WorkspaceAppCenterPane` calls the shell-aware App Center service
  command. Then confirm the renderer window registered exactly one workspace
  App surface presenter: Workbench for the OS shell or standalone Agent for the
  Agent shell.
- Root cause:
  App placement is Shell presentation policy. Calling an inline helper directly
  from the shared App Center pane bypasses the OS presenter and writes the Agent
  `openAppId` selection into state consumed by both shells.
- Fix:
  Keep runtime preparation in `WorkspaceAppCenterService`, route presentation
  through the feature-owned workspace App surface host, and implement separate
  Workbench and standalone Agent presenters. Bind Workbench presenter
  registration only to the actual host and workspace lifecycle, never App
  Center snapshots. Presenter replacement and disposal must roll back their
  pending attempts and use identity-checked cleanup so stale Shell cleanup
  cannot unregister a newer presenter.
- Validation:
  Run the App surface host, Workbench presenter, standalone Agent presenter, App
  Center service, and App Center pane tests. Verify OS presentation calls
  `host.launchNode` while Agent presentation selects the inline app before
  runtime preparation and rolls it back on failure. Cover an App Center revision
  update during OS preparation and presenter disposal during Agent preparation.
- References:
  [workspaceAppSurfaceHost.interface.ts](../../../apps/desktop/src/renderer/src/features/workspace-app-center/services/workspaceAppSurfaceHost.interface.ts)
  [workbenchWorkspaceAppSurfacePresenter.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/workbenchWorkspaceAppSurfacePresenter.ts)
  [standaloneAgentWorkspaceAppSurfacePresenter.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/standaloneAgentWorkspaceAppSurfacePresenter.ts)

### Agent file preview behavior leaks into the OS shell

- Symptom:
  Opening a previewable file in the OS shell uses the system default app instead
  of creating or focusing a Workbench preview Node, or unsupported-preview
  notifications remain suppressed after leaving the standalone Agent shell.
- Quick checks:
  Confirm the renderer window registered one file preview presenter for the
  workspace: Workbench in the OS shell or standalone Agent in the Agent shell.
  Search shared File Manager code for callback setters or direct Workbench and
  system-host presentation calls.
- Root cause:
  File activation is feature behavior, but preview placement and unsupported
  fallback notification policy are Shell behavior. Storing either as mutable
  File Manager mode state lets one Shell overwrite behavior used by another;
  asymmetric effect cleanup can leave the policy behind after unmount.
- Fix:
  Keep activation and fallback orchestration in File Manager, route preview
  placement through the feature-owned workspace file preview surface host, and
  register separate Workbench and standalone Agent presenters. Store fallback
  notification policy on the presenter registration and use identity-checked
  disposal so removing an old registration cannot affect a replacement.
- Validation:
  Run the file preview surface host and both presenter tests. Verify the OS
  presenter calls `host.launchNode`, the Agent presenter calls the desktop file
  host, absent presenters preserve system fallback, workspace registrations stay
  isolated, and disposing the Agent presenter restores fallback notifications.
- References:
  [workspaceFilePreviewSurfaceHost.interface.ts](../../../apps/desktop/src/renderer/src/features/workspace-file-manager/services/workspaceFilePreviewSurfaceHost.interface.ts)
  [workbenchWorkspaceFilePreviewPresenter.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/workbenchWorkspaceFilePreviewPresenter.ts)
  [standaloneAgentWorkspaceFilePreviewPresenter.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/standaloneAgentWorkspaceFilePreviewPresenter.ts)

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
  [app_local.go](../../../services/tuttid/service/workspace/app_local.go)
  [check_local_dev_app.py](../../../services/tuttid/service/workspace/app_factory_reference/scripts/check_local_dev_app.py)

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
  [daemon_app_mentions.go](../../../services/tuttid/api/daemon_app_mentions.go)
  [desktopRichTextAtService.ts](../../../apps/desktop/src/renderer/src/features/rich-text-at/services/internal/desktopRichTextAtService.ts)
  [desktopAgentProviderStatusService.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/desktopAgentProviderStatusService.ts)

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
  [desktopAgentGUILinkActions.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentGUILinkActions.ts)

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

### Windows FileManager paths exist but fail validation or selection

- Symptom:
  A Windows path opens through direct preview, but FileManager reports it as
  missing, fails to select the revealed entry, loses the matching sidebar
  location, or adds a duplicate back-navigation entry.
- Quick checks:
  Compare the AgentGUI or desktop launch path with `tuttid`'s directory
  response. Native input commonly arrives as `C:\\Users\\...` or
  `C:/Users/...`; Git Bash-shaped input may arrive as `/c/Users/...`; the
  workspace API intentionally transports all of these as `/C:/Users/...`.
- Root cause:
  Workspace file paths are logical API paths. Multiple local normalizers can
  preserve different drive casing or omit the logical leading slash, leaving
  native Windows input unequal to daemon roots, directory paths, and entry
  paths.
- Fix:
  Reuse the shared FileManager path model and canonicalize drive-qualified
  paths to `/C:/...` at the AgentGUI and daemon boundaries. Treat `/c/...` as
  a Windows drive alias only when the active workspace root is Windows-shaped.
  Keep `/C:/...` for API and state values. Convert it to `C:\\Users\\...`
  only at native Electron/operating-system adapters or Windows user-facing
  display boundaries; POSIX and daemon-facing values keep their logical
  separators.
- Validation:
  Cover native and Git Bash-shaped Windows inputs against daemon-shaped
  `/C:/...` responses in projection, existence, directory navigation, and
  reveal-selection tests. Keep POSIX `/c/...` paths unchanged on a POSIX root.
  Then run `pnpm check:changed`.
