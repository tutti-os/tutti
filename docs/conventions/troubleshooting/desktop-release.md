# Troubleshooting: Desktop And Release

[Back to troubleshooting index](./README.md)

### Desktop stable release alias disappears or is not first on Releases

- Symptom:
  The desktop release workflow publishes a concrete release, but the
  `Refresh stable release alias` step fails with `Committer identity unknown`,
  the GitHub Releases page no longer has a `stable` entry after a failed RC
  publish, or the GitHub Releases list still puts a newer RC above `stable`.
- Quick checks:
  Inspect the failed `Desktop Release` run's `Refresh stable release alias`
  step. If the log shows `git tag -a` or `gh release delete stable --cleanup-tag`,
  the workflow is using the unsafe annotated-tag refresh path. Also check
  `gh release view stable` and `git ls-remote --tags origin stable` to confirm
  whether the release, tag, or both are missing. For ordering failures, list
  public prereleases with `gh api 'repos/$GITHUB_REPOSITORY/releases?per_page=100'
--jq '.[] | select(.prerelease and (.draft | not)) | .tag_name'` and confirm
  the workflow ran `Archive public GitHub prereleases`.
- Root cause:
  Annotated tags require a configured Git committer identity in GitHub Actions.
  Deleting the old floating release and tag before creating the replacement
  leaves the repository in a half-refreshed state if tag creation fails.
  GitHub's public Releases list has no supported pin or explicit order field.
  Recreating the alias and assigning it a newer commit timestamp does not
  reliably place it above public prereleases.
- Fix:
  Keep RC and beta GitHub Releases as drafts and distribute them through the
  S3 preview-channel metadata instead. The workflow must archive any older
  public prereleases with `PATCH draft=true`, then refresh the floating
  `stable` release. Delete only the old stable alias (`gh release delete stable
--yes`) and never pass `--cleanup-tag`; keep the concrete stable release as
  `Latest`.
- Validation:
  Run `node --test ./tools/scripts/desktop-release-config.test.mjs` and verify
  the workflow test checks that stable is the only release promoted from draft,
  archives legacy public prereleases, checks the alias tree and parent, and
  rejects `git tag -a`, `--cleanup-tag`, and deleting `refs/tags/stable`. After
  a live release, confirm the GitHub Releases page lists `stable` first while
  `/releases/latest` still resolves to the concrete stable semver release.
- References:
  [.github/workflows/desktop-release.yml](../../../.github/workflows/desktop-release.yml)
  [desktop-release-config.test.mjs](../../../tools/scripts/desktop-release-config.test.mjs)

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
  [dev-gui.sh](../../../tools/scripts/dev-gui.sh)
  [bootstrap.ts](../../../apps/desktop/src/main/bootstrap.ts)
  [defaults.ts](../../../apps/desktop/src/main/defaults.ts)

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
  [macosApplicationInstallGuard.ts](../../../apps/desktop/src/main/macosApplicationInstallGuard.ts)
  [bootstrap.ts](../../../apps/desktop/src/main/bootstrap.ts)
  [desktop-release.md](../desktop-release.md)

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
  [resolver.go](../../../packages/agent/daemon/runtimecmd/resolver.go)

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
  [apps/desktop/electron.vite.config.ts](../../../apps/desktop/electron.vite.config.ts)
  [tools/scripts/check-electron-runtime-boundaries.mjs](../../../tools/scripts/check-electron-runtime-boundaries.mjs)

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
  [tuttidManager.ts](../../../apps/desktop/src/main/daemon/tuttidManager.ts)
  [main.go](../../../services/tuttid/main.go)

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
  [appUpdateState.ts](../../../apps/desktop/src/shared/contracts/appUpdateState.ts)
  [appUpdateService.ts](../../../apps/desktop/src/main/update/appUpdateService.ts)
  [appUpdateService.ts](../../../apps/desktop/src/renderer/src/features/app-update/services/internal/appUpdateService.ts)

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
  [appUpdateService.ts](../../../apps/desktop/src/main/update/appUpdateService.ts)
  [desktopAppLifecycle.ts](../../../apps/desktop/src/main/desktopAppLifecycle.ts)
  [desktopAppServices.ts](../../../apps/desktop/src/main/desktopAppServices.ts)

### Fusion Mode toggle is saved but the current window does not change

- Symptom:
  The Fusion Mode switch changes and remains persisted, but the current
  Workspace window stays open or the current Fusion Dock stays active. An
  unrelated preference change may repeatedly show a restart prompt. On macOS,
  the renderer and remote-debugging endpoint may instead appear frozen while
  no restart prompt is visible.
- Quick checks:
  Compare durable `lab.fusionMode` with `fusion.isActive()`. The latter is the
  startup-selected presentation mode and intentionally stays fixed for the
  lifetime of the current Electron process. Confirm the main-process desktop
  preferences event stream receives `preferences.desktop.updated` and that a
  localized native restart dialog appears when the two values differ. If main
  is sampled inside `-[NSAlert runModal]` but no alert is visible, inspect
  whether the message box was created without an owning BrowserWindow.
- Root cause:
  Changing only the persisted flag cannot safely mutate a live presentation
  mode. Reading the flag dynamically from `isActive()` creates a half-switched
  process where Fusion IPC policy changes before the Dock, Tray, workspace
  identity, and window registry are ready. Previously, a static restart hint
  also left no direct way to apply the saved mode. A parentless macOS
  `NSAlert` can additionally open behind the active Tutti window while holding
  the modal run loop, which makes a correctly delivered preference event look
  like a no-op.
- Fix:
  Keep the current process mode static. Independently subscribe the
  main-process restart coordinator to authoritative desktop preferences in
  both modes. Prompt once for each mismatching target; **Later** suppresses
  duplicates until the preference returns to the current mode. Before
  relaunching, read the durable preference again and restart only when it still
  differs, then call `app.relaunch()` before `app.quit()` so the normal daemon
  shutdown gate remains in control. Activate Tutti and attach the native
  message box to the focused BrowserWindow, or a visible fallback, so the
  restart decision cannot be hidden behind the window that changed the flag.
- Validation:
  Starting once in each mode, toggle to the other mode and verify the localized
  native dialog appears. Choose **Later**, publish unrelated preference updates,
  and confirm the prompt does not repeat. Toggle back to the current mode and
  away again to confirm suppression resets. Finally choose **Restart Now** and
  verify the next process uses the selected mode; also revert the preference
  while the dialog is open and confirm accepting the stale dialog does not
  restart Tutti. Repeat once while another app is frontmost and verify the
  alert is physically on screen and the debugging endpoint remains responsive.
- References:
  [fusionModeRestartController.ts](../../../apps/desktop/src/main/fusionModeRestartController.ts)
  [fusionModeRestartCoordinator.ts](../../../apps/desktop/src/main/fusionModeRestartCoordinator.ts)
  [bootstrap.ts](../../../apps/desktop/src/main/bootstrap.ts)
  [desktop-windows.md](../../architecture/desktop-windows.md)

### Fusion Mode starts without a Workspace window and the Dock seems missing

- Symptom:
  After enabling Fusion Mode and restarting, no Workspace window opens. The
  floating Dock is also not visible, so Tutti appears not to have started even
  though the menu-bar item and `tuttid` process remain alive.
- Quick checks:
  Confirm `lab.fusionMode` is enabled in desktop preferences. Use the Tutti
  menu-bar item to select **Show Dock**, or open the Tutti application icon's
  system Dock menu and select **Show Dock**. The ordinary system Dock icon click
  focuses the most-recent product window first, so use its menu when a product
  window exists but the floating Dock is hidden. Inspect the configured
  visibility mode and `workbenchShortcuts.toggleFusionDock`; an explicit
  `null` means the shortcut is unbound. Check Fusion state for `conflict` or
  `invalid`, and inspect `fusion-dock-bounds.json` under the desktop user-data
  directory when the Dock may have been saved on a removed display. If
  Electron prints
  `NSWindow does not support nonactivating panel styleMask 0x80`, inspect the
  Dock constructor for `type: "panel"`; `BrowserWindow.isVisible()` and a live
  renderer are not proof that WindowServer put the window on screen.
  If the menu-bar item is blank only in a packaged build, confirm
  `fusion-tray-icon.png` exists under `process.resourcesPath`; Electron Builder
  does not include the `buildResources` directory inside `app.asar` by default.
- Root cause:
  Not opening a Workspace window is expected in Fusion Mode. A shortcut-only
  visibility policy, a conflicting global accelerator, or stale multi-display
  bounds can make the persistent entry point look absent. On Electron 35,
  `type: "panel"` applies the macOS nonactivating-panel style to Electron's
  NSWindow implementation. AppKit rejects that mask while Electron's panel
  show path skips application activation, leaving an internally visible Dock
  with no physical on-screen window.
- Fix:
  Reveal the Dock from the menu-bar item or system Dock menu, choose a
  non-conflicting shortcut, or switch visibility to always visible. The
  shortcut shows the temporary expanded search surface and focuses its input;
  it is not a second persistent window/task panel. Dock bounds resolution must
  fall back to the primary display when the saved display no longer exists; do
  not create a Workspace window as a fallback for a hidden Dock. Use a normal
  frameless, transparent BrowserWindow for the Dock and omit `type: "panel"`;
  `setAlwaysOnTop(..., "floating")` and
  `setVisibleOnAllWorkspaces(..., { visibleOnFullScreen: true })` independently
  provide the required floating and cross-Space behavior. Ship the Tray template
  image through `build.extraResources` and resolve the packaged path from
  `process.resourcesPath`, while development continues to use `build/icon.png`.
- Validation:
  Hide the Dock through its close control, then repeat while it is focused by
  pressing `Command+W`; neither action should quit Tutti. Recover it
  independently from the menu-bar item and the system Dock menu. Starting from the visible narrow
  rail, press the configured shortcut and verify the Dock expands from
  `88x520` to `420x520`, the search input receives focus, and a second press
  hides it. Then disconnect the display that held the Dock and confirm it moves
  into the primary display work area. On macOS confirm both bounds are
  physically on screen, not merely marked visible by Electron, and keep a pure
  window-options test that rejects a reintroduced `type` field.
- References:
  [desktop-windows.md](../../architecture/desktop-windows.md)
  [fusionWindowCoordinator.ts](../../../apps/desktop/src/main/windows/fusionWindowCoordinator.ts)
  [fusionDockBounds.ts](../../../apps/desktop/src/main/windows/fusionDockBounds.ts)
  [fusionDockWindowOptions.ts](../../../apps/desktop/src/main/windows/fusionDockWindowOptions.ts)

### Fusion product window is absent from the Window menu or reopens off-screen

- Symptom:
  A Fusion Agent, terminal, browser, file, Workspace App, App Center, settings,
  or Issue Manager window has no native traffic lights, is absent from the
  macOS Window menu or Mission Control, or reopens on a display that is no
  longer connected. Explicit New Window requests may also stack exactly on top
  of an existing instance.
- Quick checks:
  Confirm the coordinator passes `windowChrome: "native"` for both Agent and
  Fusion tool windows. Business windows should have
  `excludedFromShownWindowsMenu=false` and
  `setHiddenInMissionControl(false)`; the floating Dock intentionally uses the
  opposite policy. Inspect the application menu for Electron's native
  `windowMenu` role rather than a hand-built minimize/close submenu. Compare the
  target's normal bounds with `fusion-business-window-bounds.json`, including
  the saved display ID and the workspace-scoped `(kind, resourceId)` key.
- Root cause:
  The legacy detached Agent and Fusion Agent share a renderer route but require
  different outer chrome, so inferring chrome only from `windowKind` can apply
  the legacy frameless shell to a Fusion window. A hand-built Window menu also
  omits macOS window discovery. Off-screen restoration occurs when Dock and
  product placement share one policy, when a removed display ID is trusted
  without clamping, or when maximized/full-screen bounds are persisted as the
  normal frame.
- Fix:
  Select native or renderer chrome explicitly at the main-process creation
  boundary. Give product windows the standard AppKit frame, system Window menu,
  distinguishable native title, and ordinary Mission Control/Spaces behavior;
  exclude only the launcher Dock. Persist `getNormalBounds()` separately from
  Dock placement, restore the exact workspace/resource identity when possible,
  cascade `forceNew` instances away from an occupied origin, and clamp normal
  windows to an available work area after display changes without
  unmaximizing or leaving full screen.
- Validation:
  Open multiple Agent, terminal, browser, and Workspace App windows. Confirm
  native traffic lights, move/resize/minimize/full-screen, Window-menu
  selection, Mission Control, App Exposé, and cross-display movement all use
  system behavior. Move an exact resource window to a secondary display,
  reopen it to confirm restoration, then disconnect that display and confirm
  the normal window returns inside an available work area. Explicit New Window
  should cascade. Finally disable Fusion Mode and verify the legacy Workspace
  window and detached Agent chrome remain unchanged.
- References:
  [desktop-windows.md](../../architecture/desktop-windows.md)
  [applicationMenu.ts](../../../apps/desktop/src/main/applicationMenu.ts)
  [fusionBusinessWindowBounds.ts](../../../apps/desktop/src/main/windows/fusionBusinessWindowBounds.ts)
  [fusionWindowCoordinator.ts](../../../apps/desktop/src/main/windows/fusionWindowCoordinator.ts)
  [workspaceWindow.ts](../../../apps/desktop/src/main/windows/workspaceWindow.ts)

### Closing a Fusion window unexpectedly stops or loses a background task

- Symptom:
  Closing an Agent, terminal, or Workspace App native window removes the item
  from the Dock or stops its process, or a closed Browser window incorrectly
  remains listed as a background task.
- Quick checks:
  Compare `FusionWindowRegistry.list()` with the daemon list endpoints for
  Agent sessions, terminals, and Workspace Apps. A closed native window must be
  absent from the registry. Its daemon resource should remain active until an
  explicit cancel, terminate, or single-app stop request. Browser, files,
  preview, and settings should have no daemon resource row. If the same
  resource ID exists in two workspaces, confirm each row is attached only to a
  window with the same workspace and kind.
- Root cause:
  Window lifecycle and task lifecycle were coupled, or background state was
  projected from BrowserWindow visibility instead of daemon truth. Keeping a
  hidden BrowserWindow after close is the same ownership error in reverse.
- Fix:
  Remove every closed descriptor and launch record from the main registry.
  Project background resources from `tuttid`, join them to windows by stable
  `(workspaceId, kind, resourceId)` identity, make native close release only the
  renderer view, and keep Stop as a separate typed domain command.
- Validation:
  Start two terminals, an Agent turn, a Workspace App, and a normal Browser.
  Close all five windows. The four daemon resources should remain reconnectable
  while the Browser disappears. Stop each resource from the Dock and confirm
  only that resource settles. Repeat with colliding test resource IDs in two
  workspaces and confirm focus, reconnect, and Stop stay in the owning
  workspace.
- References:
  [desktop-windows.md](../../architecture/desktop-windows.md)
  [workspace-terminal.md](../../architecture/workspace-terminal.md)
  [workspace-app-runtime.md](../workspace-app-runtime.md)

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
  captures instead of DevTools UI export. The repository helper uses that path:
  `pnpm trace:desktop -- --duration 15`. Record only the smallest repro window.
- Validation:
  Restart the desktop app, confirm the remote debugging endpoint responds, record
  a short trace, and verify the trace JSON is written without opening the
  Performance export path.
