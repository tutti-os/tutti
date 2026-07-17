# Troubleshooting: Desktop And Release

[Back to troubleshooting index](./README.md)

### Packaged Tutti starts but external shells cannot find `tutti`

- Symptom:
  The packaged desktop app starts normally and `~/.tutti/bin/tutti status`
  succeeds, but a new terminal reports `command not found: tutti`.
- Quick checks:
  Run `command -v tutti`, print the login-shell `PATH`, and inspect
  `~/.tutti/bin/tutti`. Check `~/.tutti/logs/tutti-desktop.log` for
  `tutti cli shim is not discoverable on user PATH` and check whether an
  unrelated `tutti` executable already exists earlier on `PATH`.
- Root cause:
  Creating the canonical shim under the state root does not make it shell
  discoverable unless `<state-dir>/bin` is already on `PATH`. Desktop apps
  launched from Finder may also inherit a smaller `PATH` than the user's login
  shell, so using only the Electron process environment misses user bin
  directories.
- Fix:
  Reuse the cached login-shell environment resolved for the managed daemon.
  Keep `<state-dir>/bin/tutti` canonical, and install a forwarding shim only in
  writable `~/.local/bin` or `~/bin` directories already present on the login
  shell's `PATH`. Repair Tutti-owned shims on later startups, preserve unrelated
  commands, and do not edit shell profiles or write `/usr/local/bin`. Keep this
  installation best-effort so a slow or invalid shell environment cannot delay
  desktop window creation.
- Validation:
  Start packaged Tutti, open a new login shell, and verify `command -v tutti`
  resolves to a user bin directory and `tutti status` succeeds. Cover creation,
  repair, canonical-PATH, no-supported-directory, and third-party-command
  conflict cases in desktop tests.
- References:
  [cliInstaller.ts](../../../apps/desktop/src/main/cli/cliInstaller.ts)
  [userShellEnv.ts](../../../apps/desktop/src/main/daemon/userShellEnv.ts)
  [desktop-transport.md](../../architecture/desktop-transport.md)

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

### Running a development tuttid breaks the production Agent session

- Symptom:
  Production Tutti is used to develop Tutti itself. After an Agent runs a newly
  built `tuttid` command, sending in a new conversation fails and the workspace
  returns to the previously selected conversation. Daemon logs may report an
  unsupported Agent Target launch-ref type immediately after a second daemon
  starts.
- Quick checks:
  List live `tuttid` processes and compare their command paths. Inspect
  `~/.tutti/logs/tuttid.log` for overlapping startup records, then check the
  command run by the Agent for a bare daemon binary without
  `TUTTI_ENV=development` or `TUTTI_STATE_DIR`. A historical `tuttid --help`
  invocation is significant because older binaries treated it as normal
  startup.
- Root cause:
  Bare daemon execution selects the production root. Older `tuttid` binaries
  did not parse `--help` and overwrote the shared PID file instead of claiming
  exclusive state ownership. The second process could open the production
  SQLite database and reseed system Agent Targets with a newer launch-ref
  discriminator while the packaged daemon still expected the older value.
  Session creation then failed, and renderer recovery restored the previous
  conversation.
- Immediate recovery:
  Quit Tutti completely, terminate any remaining `tuttid` processes after
  verifying their command paths, then reopen production Tutti. Do not delete
  `tuttid.db`; normal daemon startup reseeds its own system records. For further
  local daemon work, use the managed development command or explicitly set
  `TUTTI_ENV=development`/`TUTTI_STATE_DIR`.
- Fix:
  Parse help and reject unknown arguments before creating state. Acquire the
  PID sidecar as an exclusive operating-system lease before logging, lock
  recovery, database wiring, migrations, or listener publication. Keep the PID
  text check so a new daemon also refuses a state root owned by a live older
  daemon, but validate process identity so PID reuse by an unrelated process
  does not block recovery. Leave the marker for stale-owner recovery instead of
  deleting it through a read/remove race with an older lockless daemon.
- Validation:
  Run focused daemon tests. Verify `tuttid --help` exits successfully without
  creating the selected state root, invalid arguments exit nonzero without
  state, a live legacy PID is rejected, a stale PID is recovered, and a second
  lease cannot be acquired while the first is held.
- References:
  [main.go](../../../services/tuttid/main.go)
  [pid_file.go](../../../services/tuttid/pid_file.go)
  [local-state-storage.md](../local-state-storage.md)

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

### Switching agent permission mode flashes Checking for updates

- Symptom:
  In a packaged build, changing composer permission mode (or other remembered
  composer defaults) briefly shows the top-right **Checking for updates** /
  **正在检查更新** badge. Rapid switches may spam updater checks in
  `tutti-desktop.log` (`Checking for update` next to
  `agent.gui.composer_defaults.remembered`). Local unpackaged dev usually hides
  this because update checks are unsupported unless `TUTTI_APP_UPDATE_DEV` is set.
- Quick checks:
  Confirm packaged/`supportsUpdates`. Correlate
  `agent.gui.composer_defaults.remembered` with
  `checking for application updates` / `application updater static feed
configured`. Verify `updateChannel` / `updatePolicy` did not change.
- Root cause:
  Remembering composer defaults writes desktop preferences and emits
  `preferences.desktop.updated`. The main-process host preferences stream used
  to call `updateService.configure()` on every preferences event; `configure()`
  always runs a background update check and surfaces the checking status.
- Fix:
  Only call `updateService.configure()` when `updateChannel` or `updatePolicy`
  actually changed. Other preference syncs (composer defaults, locale, rail,
  theme) must not reconfigure the updater.
- Validation:
  In a packaged build, switch permission mode and confirm the update badge does
  not appear and desktop logs do not emit a new update check. Cover
  composer-default vs channel/policy changes in
  `desktopHostPreferencesEventStream` tests.
- References:
  [desktopHostPreferencesEventStream.ts](../../../apps/desktop/src/main/desktopHostPreferencesEventStream.ts)
  [appUpdateService.ts](../../../apps/desktop/src/main/update/appUpdateService.ts)

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
