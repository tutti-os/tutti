# Troubleshooting: Workspace Apps And Files

[Back to troubleshooting index](./README.md)

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
  [apps_test.go](../../../services/tuttid/service/workspace/apps_test.go)

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
