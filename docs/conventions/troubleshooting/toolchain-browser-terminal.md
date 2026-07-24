# Troubleshooting: Toolchain, Browser, And Terminal

[Back to troubleshooting index](./README.md)

### Go-only PR skips a repository contract that later fails

- Symptom:
  A Go-only PR is green, but a later TypeScript PR fails an unrelated
  repository-wide check or tool test against the Go change.
- Quick checks:
  Inspect whether the failing command scans repository-wide files, generated
  artifacts, workflows, hooks, or architecture boundaries. Then check whether
  CI attached it to `run_ts` only because the checker is implemented in
  JavaScript or TypeScript.
- Root cause:
  Check ownership was classified by implementation language instead of checked
  responsibility. Generated-source paths and non-code package assets could also
  be absent from inline workflow path predicates.
- Fix:
  Register repository policy, tool contract, generated contract, or boundary
  checks in `repository-checks.mjs`. Keep TypeScript and Go jobs limited to
  language-owned lint and tests. Reuse `change-classification.mjs` in local and
  PR validation.
- Validation:
  Add selector fixtures for every source-of-truth path and a narrow workflow
  contract test that verifies repository groups stay outside language jobs.
  Confirm a Go-only fixture does not select TypeScript validation.
- References:
  [repository-checks.mjs](../../../tools/scripts/repository-checks.mjs)
  [change-classification.mjs](../../../tools/scripts/change-classification.mjs)
  [testing.md](../testing.md)

### gomobile Android AAR fails after Go compilation succeeds

- Symptom:
  `GOOS=android GOARCH=arm64 CGO_ENABLED=0 go build ./...` succeeds, but
  `gomobile bind` either reports `gobind was not found` after `gomobile init`,
  or fails while linking `libgojni.so` with
  `github.com/wlynxg/anet: invalid reference to net.zoneCache`.
- Quick checks:
  Confirm the module pins `golang.org/x/mobile` at a version compatible with the
  repository Go baseline. Run `go mod why -m github.com/wlynxg/anet`; Pion ICE
  reaches it through the Android network enumeration path. Check whether
  `gobind` is actually present on `PATH` during the bind subprocess rather than
  assuming `gomobile init` installed it globally.
- Root cause:
  `go tool gomobile` runs the pinned tool without installing its sibling
  `gobind` executable. Separately, `anet` uses `go:linkname` for the Go network
  zone cache, and Go 1.23 or newer rejects that internal reference unless the
  linker compatibility flag is explicit. A no-CGO package compile does not
  exercise the same shared-library link step as an AAR build.
- Fix:
  Build the module-selected `golang.org/x/mobile/cmd/gobind` into an isolated
  temporary `GOBIN`, prepend that directory to `PATH` only for `gomobile bind`,
  and pass `-ldflags=-checklinkname=0` only to that gomobile build. Pin the NDK
  version through `ANDROID_NDK_HOME`; do not add a local `anet` fork or disable
  linker checks for ordinary host builds.
- Validation:
  Run `make android-crosscompile`, `make android-bindings-check`, and
  `make android-aar`. The final check must validate the Java binding and
  `armeabi-v7a`, `arm64-v8a`, `x86`, and `x86_64` `libgojni.so` entries. A real
  Android device or emulator is still required to execute the loopback probe.
- References:
  [DeviceLink Makefile](../../../packages/device-link/Makefile)
  [DeviceLink README](../../../packages/device-link/README.md)

### Android ICE probe gathers no candidates

- Symptom:
  A gomobile DeviceLink probe loads its JNI library and enters Go successfully,
  but `LocalParams` reports that the ICE agent gathered no candidates even
  when loopback candidates are enabled.
- Quick checks:
  Confirm the test or host app declares
  `android.permission.INTERNET` in its manifest before changing ICE filters or
  Android interface-enumeration code.
- Root cause:
  Android applies the `INTERNET` manifest permission to network sockets. A
  minimal hand-built probe APK can omit it even though normal application
  templates usually include it, leaving Pion unable to bind a UDP candidate.
- Fix:
  Add the `INTERNET` permission to the probe or product manifest. Do not add an
  Android-only candidate fallback to the shared transport core for this case.
- Validation:
  Run the signed probe on an Android device or emulator and require a
  `TuttiDeviceLinkProbe` log entry containing `PASS epoch=1` and the expected
  echoed payload.
- References:
  [Probe manifest](../../../packages/device-link/mobile/androidprobe/AndroidManifest.xml)
  [DeviceLink README](../../../packages/device-link/README.md)

### Temporary Git fixture turns a linked worktree bare

- Symptom:
  A test run leaves the shared repository config with `core.bare=true`, writes
  fixture author identity into `.git/config`, or creates an `init` commit that
  deletes most tracked files from a linked-worktree branch.
- Quick checks:
  Run `git config --show-origin --get core.bare`, inspect local `user.name` and
  `user.email`, then inspect the affected branch reflog for a fixture-authored
  commit. Search the responsible test for temporary-repository Git commands
  whose child environment inherits `GIT_DIR` or `GIT_WORK_TREE`.
- Root cause:
  `mkdtemp` isolates files, not Git repository selection. An inherited
  linked-worktree `GIT_DIR` overrides the fixture cwd, so `git init` reinitializes
  the caller's private worktree metadata and updates its shared common config.
  Later fixture `add` and `commit` commands can then stage the fixture tree
  against the real branch.
- Fix:
  Remove repository-local Git environment variables for every fixture Git
  command using case-insensitive name matching, set `GIT_CEILING_DIRECTORIES` to
  the fixture root, stop on any command failure, verify `--absolute-git-dir`
  after initialization, and pass fixture author identity through commit-local
  `-c` arguments instead of `git config`.
- Validation:
  Run `git-environment.test.mjs`, which launches the temporary-repository test
  suites with a poisoned linked-worktree `GIT_DIR` that points only at a
  disposable repository. Confirm each fixture initializes its own `.git`, then
  verify the caller's config and branch remain unchanged. Keep the lower-level
  environment test coverage for `GIT_WORK_TREE` and `GIT_CONFIG_*` inputs.
- References:
  [git-environment.mjs](../../../tools/scripts/git-environment.mjs)
  [check-agent-gui-degradation.test.mjs](../../../tools/scripts/check-agent-gui-degradation.test.mjs)
  [push-checked.test.mjs](../../../tools/scripts/push-checked.test.mjs)
  [run-check-changed.test.mjs](../../../tools/scripts/run-check-changed.test.mjs)
  [static-analysis.md](../static-analysis.md)

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
  [input.go](../../../services/tuttid/service/cli/framework/input.go)
  [issues.go](../../../services/tuttid/service/cli/providers/issuemanager/issues.go)

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

### Multi-entry tsup declaration build exhausts its worker heap

- Symptom:
  A package build finishes its ESM phase, then fails during `DTS Build start`
  with `ERR_WORKER_OUT_OF_MEMORY`. The failure is more frequent when
  `check:changed --push-ready` runs package builds beside tests and other
  builds, while an isolated retry may pass.
- Quick checks:
  Confirm the error comes from tsup's declaration worker after the JavaScript
  output reports success. Measure an isolated build with `/usr/bin/time -l`
  and compare the package's declaration entry count; raising the parent Node
  heap does not prove the worker's declaration graph is bounded.
- Root cause:
  tsup sends every configured declaration entry through one worker. A package
  with many overlapping public entrypoints can keep repeated TypeScript and
  Rollup declaration graphs in that worker until it approaches the V8 heap
  limit. Concurrent validation makes the near-limit build unreliable.
- Fix:
  Keep the runtime bundle as one build, then partition declaration entrypoints
  into complete, non-overlapping groups and build those groups concurrently in
  separate workers. Keep the group manifest separate from tsup itself so a
  normal unit test can prove every runtime entry appears exactly once. Do not
  make a global `NODE_OPTIONS` increase the default fix; it preserves the
  oversized declaration graph and moves the failure threshold.
- Validation:
  Measure the isolated package build before and after, run the entry-coverage
  test, typecheck imports from both the root and a subpath declaration, run the
  package pack check, and reproduce the original changed-aware concurrent
  build without a heap override.
- References:
  [agentGuiBuildEntries.ts](../../../packages/agent/gui/build/agentGuiBuildEntries.ts)
  [tsup.dts.config.ts](../../../packages/agent/gui/tsup.dts.config.ts)
  [tsup.dts.config.test.ts](../../../packages/agent/gui/tsup.dts.config.test.ts)

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
  [client.go](../../../apps/cli/internal/daemon/client.go)
  [session.go](../../../services/tuttid/service/browser/session.go)
  [command.go](../../../services/tuttid/service/browser/command.go)

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
  [codex.go](../../../packages/agent/runtimeprep/codex.go)
  [skill_options.go](../../../services/tuttid/service/agent/skill_options.go)

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
  [guestManager.ts](../../../packages/browser/workbench-node/src/electron-main/guestManager.ts)
  [runtimeStore.ts](../../../packages/browser/workbench-node/src/core/runtimeStore.ts)
  [workspaceBrowserService.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceBrowserService.ts)
  [BrowserNode.tsx](../../../packages/browser/workbench-node/src/react/BrowserNode.tsx)

### Standalone Agent Browser Node is blank and never attaches a guest

- Symptom:
  The standalone Agent window opens its Browser sidebar with the expected
  title and panel background, but no page, error card, or Browser Node guest
  appears. Desktop logs contain no `Browser Node webview will attach` entry for
  the standalone browser node.
- Quick checks:
  Inspect `window.tutti.browser` in the `view=agent` renderer before debugging
  BrowserNode lifecycle or network access. Compare the preload route gate for
  `view=agent` with `view=workspace`. An absent browser API explains a panel
  that renders only host chrome and never reaches Electron guest attachment.
- Root cause:
  The desktop preload exposed browser and workspace-app bridges only when the
  renderer query used `view=workspace`. Standalone Agent windows use
  `view=agent`, so their renderer received no `DesktopBrowserApi`; the sidebar
  correctly reserved panel space but had no host API with which to activate or
  register a `<webview>` guest.
- Fix:
  Treat both `workspace` and `agent` as workspace surfaces in the preload route
  gate. Keep dashboard and unrelated window routes excluded. Because preload
  code is loaded when the Electron renderer is created, restart the Electron
  process after changing this gate; renderer HMR is insufficient.
- Validation:
  Unit-test the route predicate for `workspace`, `agent`, `dashboard`, and an
  absent view. Run the desktop typecheck, Electron runtime-boundary check, and
  desktop build. Confirm the preload remains a self-contained `index.cjs`, then
  open the Agent Browser panel and verify desktop logs record the shared
  Browser Node partition attaching with the browser guest preload.
- References:
  [main.ts](../../../apps/desktop/src/preload/entries/main.ts)
  [workspaceSurfacePreload.ts](../../../apps/desktop/src/preload/entries/workspaceSurfacePreload.ts)
  [StandaloneAgentToolSidebar.tsx](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/StandaloneAgentToolSidebar.tsx)

### Browser Node action finds a webview but page injection does nothing

- Symptom:
  A Browser Node toolbar action is visible and clickable, but moving the pointer
  over the loaded page produces no expected guest-page behavior. Desktop logs
  may report `The WebView must be attached to the DOM and the dom-ready event
emitted before this method can be called`, especially after HMR, navigation,
  or panel remount.
- Quick checks:
  Do not treat a matching `<webview>` DOM element or a visibly rendered page as
  proof that Electron methods are callable. Call `getWebContentsId()` inside a
  `try` block and confirm it returns a finite id. Check whether the action found
  a detached element, ran before `dom-ready`, or retained a stale element while
  React cleanup and BrowserNode guest teardown raced.
- Root cause:
  Electron exposes the webview element before its guest method bridge is ready,
  and detaches that bridge before React passive cleanup necessarily runs. Direct
  DOM lookup followed immediately by `executeJavaScript()` therefore races the
  BrowserNode lifecycle. The method can also throw synchronously before it
  returns a Promise, so appending `.catch()` alone does not protect cleanup.
- Fix:
  Reuse BrowserNode's guest lifecycle rather than creating a second owner. Before
  guest script execution, require a connected webview with a readable finite
  web contents id; otherwise wait for its `dom-ready` event with a bounded
  timeout. Treat cancellation during navigation or unmount as best-effort and
  guard the full method call with `try`/`catch`, including synchronous throws.
  For the element selector specifically, keep the selection session independent
  from one guest: consume BrowserNode's active-webview context, move the
  selector to the newly active webview, and re-arm it after navigation
  `dom-ready`. Increment an attempt token whenever the target changes so a late
  result from the previous page cannot finish the new page's selection.
- Validation:
  Test delayed `dom-ready`, detached webviews, unmount cancellation, switching
  tabs while selecting, and navigating the active tab while selecting. Run the
  desktop typecheck, changed-aware checks, and production build. Confirm the
  guest action is bundled with the standalone Agent browser adapter, then reload
  the standalone Agent window before a manual page-selection smoke test.
- References:
  [browserElementWebview.ts](../../../packages/agent/gui/workbench/browser-element-context/browserElementWebview.ts)
  [BrowserElementContextAction.tsx](../../../packages/agent/gui/workbench/browser-element-context/BrowserElementContextAction.tsx)
  [webviewController.ts](../../../packages/browser/workbench-node/src/core/webviewController.ts)

### Hidden Browser Node webview covers another panel

- Symptom:
  After switching from Browser Node to another panel in the same layout region,
  the new panel title or sidebar appears but the previous web page still covers
  part of its content. The panel selection state correctly identifies only the
  new panel as active. The same root cause can make a Browser Node header menu
  or dialog appear unresponsive: its trigger changes state, but the open Portal
  is visually covered by the guest page.
- Quick checks:
  Inspect the mounted `BrowserNode` and its `<webview>` in DevTools. If the
  parent panel has `visibility: hidden`, `display: none`, or an inactive class
  but `BrowserNode` still receives `hidden={false}`, treat the guest surface as
  the likely overlay before changing the panel reducer.
- Root cause:
  Electron webviews are guest surfaces with compositing behavior that cannot be
  treated as ordinary descendant DOM for visibility coordination. Keeping a
  Browser Node mounted preserves its local session, but hiding only an ancestor
  panel can leave the guest surface visible above the newly active sibling.
- Fix:
  Keep one active panel id for tools that share the same region. Pass that
  active state into every mounted Browser Node through its `hidden` prop, while
  retaining the mounted component when session preservation is required. Keep
  the App Center catalog and every workspace app listed in the persisted
  `openAppIds` tab state as mounted sibling layers: selecting the permanent
  catalog tab clears `openAppId` but must not remove an app's Browser Node, and
  selecting another app tab must not replace the previous app's keyed Browser
  Node. Closing a tab removes its id from `openAppIds` and intentionally releases
  that guest. Give each inline app a stable app-specific node id so Browser Node
  controllers and Electron guests cannot be rebound to a different app. A ready
  catalog snapshot may also close tabs for apps confirmed unavailable; loading
  or reconnecting snapshots are not proof that an app disappeared. Inactive app
  layers need both non-interactive DOM
  visibility and `hidden={true}` on `BrowserNode`, because ancestor visibility
  alone is insufficient for Electron guest compositing. Do not add an explicit
  `visibility: visible` utility to the active child layer: CSS descendants can
  override an inactive parent panel's inherited `visibility: hidden` and leak
  the retained app or catalog over a newly selected sibling panel. Let active
  layers inherit visibility from their parent, and apply `invisible` only to
  inactive layers. Keep
  tools in separate layout regions, such as a bottom terminal tray, on an
  independent visibility state. For Browser Node-owned dialogs, track open
  overlays by node id and mark the registered webview invisible until all modal
  overlay owners close; do not unmount the webview or discard its session.
  Render header menus inline through one `MenuSurface` positioned from the
  browser header, and do not hide the webview for that inline menu. Keep nested
  action views inside the same surface instead of opening Radix or
  viewport-menu Portals above the guest. Portaled controls opened from a dialog,
  such as `SelectContent`, must use the `--z-dialog-popover` semantic layer. The
  ordinary `--z-popover` layer renders behind dialog content and makes the
  control appear unresponsive even though its open state changed correctly.
- Validation:
  Cover every switch among panels in the shared region, verify the inactive
  Browser Node receives `hidden={true}`, and verify an independently placed
  terminal remains open throughout the same switches. For App Center, open two
  apps, switch through their tabs and the permanent catalog tab, and reopen both;
  page state and any running in-page Agent must continue while inactive Browser
  Nodes stay hidden. Close the active and inactive app tabs in turn and verify
  the adjacent/catalog fallback plus guest release. Also open the Browser Node
  overflow menu, its submenus, settings
  dialog, and clear-data confirmation above a loaded guest page; verify the
  webview returns after each overlay closes. Renderer-only visibility changes
  can use HMR; preload or Electron-main changes still require a process restart.
- References:
  [BrowserNode.tsx](../../../packages/browser/workbench-node/src/react/BrowserNode.tsx)
  [browserNodeHostOverlayStore.ts](../../../packages/browser/workbench-node/src/react/browserNodeHostOverlayStore.ts)
  [dropdown-menu.tsx](../../../packages/ui/system/src/components/dropdown-menu/dropdown-menu.tsx)
  [StandaloneAgentToolSidebar.tsx](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/StandaloneAgentToolSidebar.tsx)

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
  [terminalImeInputGuard.ts](../../../packages/workspace/terminal/src/react/terminalImeInputGuard.ts)
  [terminalSurfaceRuntime.ts](../../../packages/workspace/terminal/src/react/terminalSurfaceRuntime.ts)

### Chinese input renders replacement and control characters in workspace terminals

- Symptom:
  Chinese input reaches a local workspace terminal, but the shell prompt shows
  replacement glyphs or control-byte markers such as `<0095>`. ASCII input and
  commands continue to work, which can make the failure look like an xterm IME
  composition bug.
- Quick checks:
  Run `locale` or `locale charmap` inside a newly created terminal. If
  `LC_CTYPE` resolves to `C` and the character map is not UTF-8, inspect the
  desktop and `tuttid` process environments for `LC_ALL`, `LC_CTYPE`, and
  `LANG` before changing xterm key handlers or terminal transport encoding.
- Root cause:
  Finder-launched macOS applications commonly start without locale variables.
  The daemon inherited that environment and spawned the interactive shell
  without a character-type locale, so zsh interpreted UTF-8 IME bytes under the
  single-byte `C` locale and rendered invalid or control characters.
- Fix:
  When all locale variables are absent or effectively empty on macOS, append
  `LC_CTYPE=UTF-8` to the terminal child environment. Preserve any explicit
  `LC_ALL`, `LC_CTYPE`, or `LANG` value. Restrict the fallback to the character
  type so message language, sorting, dates, and other locale categories do not
  change.
- Validation:
  Unit-cover missing, empty, explicit, and non-macOS environment cases. Start a
  real macOS zsh PTY with empty locale variables and assert `locale charmap`
  reports `UTF-8`, then manually enter Chinese text in a newly created terminal.
  Existing terminal processes retain their original environment and must be
  replaced for the fix to take effect.
- References:
  [terminal_helpers.go](../../../services/tuttid/service/workspace/terminal_helpers.go)
  [terminal_helpers_test.go](../../../services/tuttid/service/workspace/terminal_helpers_test.go)
  [terminal_test.go](../../../services/tuttid/service/workspace/terminal_test.go)

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
  [terminalImeInputGuard.ts](../../../packages/workspace/terminal/src/react/terminalImeInputGuard.ts)

### Published package runtime asset 404 because the consumer bundler never saw the file

- Symptom:
  An external consumer installs a public `@tutti-os/*` package, uses the
  package, and gets a browser or renderer 404 for an icon or image such as
  `dist/assets/...`. The same feature often works inside this monorepo because
  workspace source resolution or local build layout hides the packaging
  problem.
  In Vite development mode the failing URL may instead point at
  `node_modules/.vite/deps/assets/...`: dependency prebundling moved the
  JavaScript module, then a preserved `new URL("./assets/...", import.meta.url)`
  resolved relative to the optimizer cache.
  A browser-only correction can surface as `Unknown file extension ".png"` in
  Vitest when the test runner externalizes the published dependency and Node
  evaluates its asset import directly.
- Quick checks:
  If the failing package entrypoint renders a package-local image or icon,
  inspect whether the main runtime entrypoint still imports that asset directly
  instead of leaving it to an explicit asset subpath such as
  `./assets/workspace-dock-website.png`.
  Run `pnpm release:pack:check` and confirm the packed tarball includes the
  exported asset file under `dist/assets/...`.
  Inspect the built `dist` entrypoint and confirm the main runtime code no
  longer uses a module-relative asset URL. If the runtime intentionally imports
  the asset, verify the public export has both a browser asset target and a
  Node-executable target.
- Root cause:
  The public runtime entrypoint owned a default asset dependency instead of
  exposing that asset as an explicit public subpath. The packed npm artifact
  either did not ship the matching file layout or forced every consumer to pay
  the asset cost even when the feature was unused.
  A related failure occurs when a published bundle preserves a module-relative
  `new URL(...)`: consumer dependency optimization can relocate that bundle
  independently from its adjacent asset.
- Fix:
  Move the image or icon out of the main runtime entrypoint and export it
  through an explicit package asset subpath such as
  `./assets/workspace-dock-website.png`.
  Let the business consumer import that asset only when it needs the default
  visual, and keep the package build rule that copies the asset into the packed
  `dist/assets` directory.
  When the package runtime owns an always-available default icon, prefer a
  code-owned UI-system SVG component so the runtime does not import an image at
  all. Conditional asset exports are not sufficient for this case: a
  browser-conditioned test environment can select the image target and then
  externalize the package for Node execution, which still fails on `.png`.
  Keep explicit public asset subpaths only for browser consumers that knowingly
  opt into the artwork. Do not require every consumer to add a test alias for
  the published package.
  Apply the same rule to every public runtime subpath in the package, not just
  the first failing icon.
- Validation:
  Build the affected package, inspect the built runtime entrypoint for the
  absence of the old asset dependency, and rerun `pnpm release:pack:check`.
  Import any intentionally supported packed asset subpath with Node and run a
  real Vite dependency-prebundle fixture. The optimized root runtime must
  contain the code-owned fallback icon and no fallback image dependency.
  If the package is consumed by desktop renderer code in this repo, also run
  the relevant desktop build to confirm the consumer bundler copies or emits
  the asset only when the business import is present.
- References:
  [docs/conventions/npm-package-release.md](../npm-package-release.md)
  [packages/browser/workbench-node/package.json](../../../packages/browser/workbench-node/package.json)
  [packages/browser/workbench-node/src/workbench/index.ts](../../../packages/browser/workbench-node/src/workbench/index.ts)
  [packages/workspace/issue-manager/package.json](../../../packages/workspace/issue-manager/package.json)
  [packages/workspace/issue-manager/src/workbench/index.ts](../../../packages/workspace/issue-manager/src/workbench/index.ts)

### New release CDN namespace returns an S3 403

- Symptom:
  Release artifacts upload successfully and `s3api head-object` finds them,
  but the corresponding CloudFront URL returns HTTP 403 with
  `server: AmazonS3` and `x-cache: Error from cloudfront`.
- Quick checks:
  Compare the requested path with the distribution's ordered cache behaviors,
  identify the selected origin, and inspect the origin bucket policy for a
  matching `s3:GetObject` resource prefix. Do not treat a successful S3 upload
  or invalidation as proof that the CDN route exists.
- Root cause:
  The new release namespace was uploaded before its CloudFront path behavior
  and S3 read policy were provisioned. The request fell through to an unrelated
  default origin, which correctly returned AccessDenied.
- Fix:
  Add a read-only cache behavior for the namespace that targets the intended S3
  origin, append the narrow bucket-policy resource prefix, wait for the
  distribution deployment, and invalidate the new namespace. Preserve every
  unrelated distribution behavior and use the current distribution ETag when
  updating it.
- Validation:
  Download mutable index metadata, immutable release metadata, and the artifact
  from the public CDN. Require HTTP 200 and rerun signature, SHA-256, and byte
  size verification against those downloaded files.
- References:
  [Agent Extensions](../../architecture/agent-extensions.md) and the concrete
  Agent repository's release workflow.

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
  [webviewSecurity.ts](../../../packages/browser/workbench-node/src/electron-main/webviewSecurity.ts)
  [workspaceApp.ts](../../../apps/desktop/src/preload/entries/workspaceApp.ts)
  [workspaceAppInteractionForwarding.ts](../../../apps/desktop/src/preload/entries/workspaceAppInteractionForwarding.ts)
