# Troubleshooting: Toolchain, Browser, And Terminal

[Back to troubleshooting index](./README.md)

### Standalone Agent provider login reports an internal error

- Symptom:
  A provider login request fails in a standalone Agent window even though a
  Workbench host appears to be bound, or an HTTP/file action unexpectedly opens
  an OS application.
- Quick checks:
  Distinguish the AgentGUI `surface.host` from the standalone right-side tool
  host. Verify that the renderer registered the workspace-scoped Terminal,
  Browser, and Files presenters before announcing tool-host readiness.
- Root cause:
  The AgentGUI surface host owns the Agent node, not Desktop tool nodes. Reusing
  it as a Workspace Workbench host makes Terminal launch return no node, while
  standalone-specific link/file shortcuts can bypass the in-app tools.
- Fix:
  Keep semantic launch coordinators shared and register Desktop presentation
  adapters per mode. The standalone adapter creates/selects sidebar tabs and
  reserves OS navigation for explicit external or reveal actions.
- Validation:
  Verify provider login opens a new Terminal tab, ordinary HTTP and file
  preview stay in right-side tools, explicit Open in Finder remains external,
  and Browser automation follows the canonical Turn's validated renderer claim
  (with Workspace fallback only for an unclaimed legacy Turn).

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

### Goal recovery Go tests fail only in the full workspace lane

- Symptom:
  `services/tuttid/service/agent` goal recovery tests pass alone but fail in the
  pull-request Go workspace job with `recover goal operation ...: context
deadline exceeded`. The failing test can take several seconds even though its
  fake provider timeout is configured for 20–25 milliseconds.
- Quick checks:
  Inspect whether the test uses a small real
  `GoalOperationAttemptTimeout` around the entire worker step. Compare the CI
  duration with the configured timeout and check whether the fake provider hook
  was reached before changing Host retry or lease semantics.
- Root cause:
  The attempt context also covers actor acquisition and SQLite work before the
  fake provider call. Under concurrent Go workspace load, the runner may not
  schedule that work within a 20–25 millisecond test window. The context then
  expires before the intended fake deadline path, so the worker reports an
  infrastructure timeout instead of exercising retry persistence.
- Fix:
  For deadline classification and retry-budget tests, return
  `context.DeadlineExceeded` directly from the fake provider. Use a
  test-controlled deadline context when cancellation propagation and detached
  lease persistence are the behavior under test. Reserve real wall-clock
  deadlines for end-to-end budget tests and give those assertions enough
  scheduling margin for the full workspace lane. Do not add retries or change
  production lifecycle timeouts to mask the test race.
- Validation:
  Run the affected goal tests repeatedly with shuffled order, then run the full
  agent-service package and changed-aware validation.
- References:
  [service_test.go](../../../services/tuttid/service/agent/service_test.go)
  [Testing](../testing.md)

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
  Remove repository-local Git environment variables at the validation-lane
  spawn boundary and for every fixture Git command using case-insensitive name
  matching. Let normal lanes rediscover the repository from their cwd. For
  fixtures, also set `GIT_CEILING_DIRECTORIES` to the fixture root, stop on any
  command failure, verify `--absolute-git-dir` after initialization, and pass
  fixture author identity through commit-local `-c` arguments instead of
  `git config`.
- Validation:
  Run `run-validation-lanes.test.mjs` to confirm spawned lanes remove poisoned
  Git selectors while preserving unrelated environment, then run
  `git-environment.test.mjs`, which launches the temporary-repository test suites
  with a poisoned linked-worktree `GIT_DIR` that points only at a disposable
  repository. Confirm each fixture initializes its own `.git`, then verify the
  caller's config and branch remain unchanged. Keep the lower-level environment
  test coverage for `GIT_WORK_TREE` and `GIT_CONFIG_*` inputs.
- References:
  [git-environment.mjs](../../../tools/scripts/git-environment.mjs)
  [run-validation-lanes.mjs](../../../tools/scripts/run-validation-lanes.mjs)
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

### Multi-entry declaration build exhausts its worker heap or dominates release time

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
  tsup asks its declaration worker to typecheck and roll up every configured
  entry together. A package with many overlapping public entrypoints can keep
  repeated TypeScript and Rollup declaration graphs until it approaches the V8
  heap limit. Splitting entries across workers bounds each heap, but every
  worker still repeats much of the same TypeScript analysis and can make the
  declaration phase dominate release time.
- Fix:
  Keep the runtime bundle as one build. Pre-emit unbundled declarations once
  with the repository-pinned native TypeScript compiler and a declaration-only
  tsconfig whose root files exactly match the runtime entries. Then let a
  bounded set of tsup workers roll up the emitted declarations and remove the
  intermediate tree. Keep workspace source path mappings out of the
  declaration-only config so dependency sources do not leak into the package
  emit. Test that the runtime entries, declaration roots, rollup groups, and
  published type paths stay aligned. Do not make a global `NODE_OPTIONS`
  increase the default fix; it preserves the oversized declaration graph and
  moves the failure threshold.
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

### Browser Agent retries plausible commands that the CLI rejects

- Symptom:
  An Agent eventually opens the requested page but its transcript contains
  repeated failures such as `browser open` returning `command_not_found`,
  `json output is not supported`, or a cold `navigate` returning
  `target closed while handling command`.
- Quick checks:
  Inspect the session's exact tool calls rather than relying on the final Agent
  message. Compare the Browser command-group help with each leaf command's
  advertised output modes, and check whether the first operation tried to
  navigate a selected page before any workspace Browser page existed.
- Root cause:
  `open` was an intuitive but missing command, command-group help advertised a
  generic `--json` flag even when leaf commands rejected JSON, and the Browser
  skill led with page-scoped `navigate` instead of page-creating `new_page`.
  Providers therefore converged on different retry sequences and surfaced
  avoidable failures before finding a working command.
- Fix:
  Provide `browser open --url <url>` as the direct page-creation path, keep
  `new-page` for explicit tab management, support JSON consistently across the
  Browser command family, and advertise `--json` only on leaf commands that
  support it. Lead the Browser skill with `open`; reserve `navigate` for an
  already selected page.
- Validation:
  Test that `browser.open` maps to `new_page` with the exact workspace and Agent
  session, that every Browser command accepts JSON output, and that CLI help
  does not promise JSON for unsupported commands. In a live Agent session,
  send `/browser` with a public URL and confirm the first Browser command
  succeeds without retries.
- References:
  [commands.go](../../../services/tuttid/service/cli/providers/browser/commands.go)
  [run.go](../../../apps/cli/internal/app/run.go)
  [browser-use skill template](../../../packages/agent/runtimeprep/skill_templates/browser-use.md)

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

### Browser Node same-origin target-blank link does nothing

- Symptom:
  Clicking a `target="_blank"` link in the full workspace Browser leaves the
  current page unchanged and opens no tab. Desktop logs show the guest preload
  reporting `action=open-url` with `defaultPrevented=true`, followed by both
  `Browser Node guest open-url IPC received` and the guest `open-url` emission,
  but no navigation to the requested URL. Cross-origin popup links may still
  appear to work. A partial host fix can instead create a new tab whose first
  guest URL is the product home page, such as Google, for every requested link.
- Quick checks:
  Compare the current and requested origins. Confirm the event's
  `sourceNodeId` names an existing `:tab:*` child and that the workspace Browser
  route is registered with source `browser`.
- Root cause:
  The guest preload correctly suppresses Chromium's native popup and delegates
  the URL to the host. Reusing the Browser surface through Workbench activation
  then changed only the active tab's `defaultUrl`. Browser Node's passive host
  synchronization intentionally ignores same-origin differences to avoid
  fighting in-page and authentication redirects, so the explicit popup URL was
  never loaded. After routing the popup into a real tab, there is a second
  materialization boundary: the active child has no runtime state until its
  guest mounts. Falling straight back to the static product home page at that
  point synchronizes the home page over the new tab's requested URL.
- Fix:
  Keep the same-origin synchronization guard. Route Browser-owned `open-url`
  events by their exact source child ID, create and select a new tab on that
  Browser surface, and retain the existing Workbench launch fallback for URLs
  emitted by Workspace Apps or unavailable Browser surfaces. Treat the route
  registration as a Workbench-session resource: replace an earlier route for
  the same workspace/source generation and dispose all workspace routes when
  its session closes. In the package Workbench adapter, resolve the active tab's
  stored URL before the static product home while runtime state is absent;
  explicit activation and restored runtime state must keep higher priority.
- Validation:
  Cover a same-origin popup from an existing Browser child and assert that a
  second selected tab owns the requested URL while no Workbench launch occurs.
  Also resolve the new tab before it has runtime state and assert its requested
  URL wins over the product home page.
  Rebuild the Browser contribution and assert only the latest feature receives
  the popup, then dispose the workspace and assert its feature no longer
  receives events. Also retain coverage that Workspace App URLs still launch
  through the workspace Browser coordinator.
- References:
  [workspaceBrowserService.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceBrowserService.ts)
  [tabsStore.ts](../../../packages/browser/workbench-node/src/core/tabsStore.ts)
  [nodeController.ts](../../../packages/browser/workbench-node/src/core/nodeController.ts)

### Workspace App authorization opens two Browser windows

- Symptom:
  One Workspace App connection action opens two internal Browser windows for
  the same authorization URL.
- Quick checks:
  Starting from one user action, count Electron window-open producer callbacks,
  `workspace app emitted open-url` events, Workbench launch requests, and
  materialized Browser surfaces. Popup events should report
  `producer=window-open-handler`. Equal URLs do not prove duplicate delivery,
  and different OAuth query parameters do not prove separate user intent.
- Root cause:
  Intercepting one cross-origin blank-link in preload while also installing
  Electron's window-open handler creates two popup transports. A downstream
  workspace, source node, local UUID, or URL cannot prove that independently
  produced events represent one user action. Renderer deduplication therefore
  masks the producer boundary and can merge intentional popup requests.
- Fix:
  Leave blank links, `window.open`, and popup forms to Electron's
  `setWindowOpenHandler`; preload must not globally intercept clicks or patch
  page APIs. Install one delegate while attaching the guest and give its
  host-provided Workspace App route priority. Browser Node `registerGuest` may
  update only the delegate's ordinary Browser route; it must not install a
  second handler. Main compares accepted HTTP(S) targets with the current guest
  origin: internal URLs navigate the current guest after the handler returns
  `deny`, while external URLs emit one Browser event. Reject POST and
  empty/`about:blank` deferred popups with localized feedback instead of losing
  the request body or later navigation. Keep the renderer as a stateless
  one-event/one-launch adapter.
- Validation:
  Start from one real internal popup and assert one producer callback, current
  guest navigation, and zero Browser events, launches, surfaces, and native
  child windows. Then start from one real external popup and assert producer
  callback count one, Browser event count one, Workbench launch count one, and
  surface count one.
  Two events indicate duplicate production; one event with two launches
  indicates duplicate routing or subscription; one launch with two surfaces
  indicates a Workbench materialization race. Two real `window.open` requests
  must remain two independent launches even when their URLs are equal.
  The Electron integration fixture covers `did-attach-webview` followed by
  `registerGuest`, installs the real Workspace App preload, and uses different
  loopback origins for the guest and popup target. It then covers blank links,
  internal blank links, `window.open` return semantics, external blank links,
  external `window.open`, GET forms, deferred-popup rejection, and POST
  rejection. Its owner renderer runs the real
  workspace Browser event service, launch coordinator, presenter, and public
  Workbench host with the production Browser multi-instance launch handler, so
  one process asserts callback, Browser event, launch, materialized surface,
  rejection notification, and denied native-child counts. The package boundary
  test separately asserts that guest attachment installs one stable Electron
  handler.
- References:
  [workspaceAppWindowOpen.ts](../../../apps/desktop/src/main/ipc/workspaceAppWindowOpen.ts)
  [workspaceBrowserService.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceBrowserService.ts)
  [workbenchWorkspaceBrowserPresenter.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/workbenchWorkspaceBrowserPresenter.ts)

### Agent opening several pages repeatedly steals workspace focus

- Symptom:
  One Agent Turn asks to open several URLs. Every page is created successfully,
  but each `new_page` result reveals and focuses the workspace again, producing
  repeated foreground jumps during the same response.
- Quick checks:
  Confirm the calls carry the same Agent session and persisted active Turn ID.
  Separately count `Browser automation host activated` logs and workspace
  Browser surface-focus requests. One host-activation log with several visible
  Browser switches means the renderer reveal path is repeating even though
  Main's window activation is already deduplicated.
- Root cause:
  There are two foreground effects: Desktop Main activates the owning Electron
  window, while the renderer focuses or opens the Browser surface before
  creating a tab. Deduplicating only Main's post-create activation still lets
  every renderer create request switch the workspace or standalone Agent panel
  back to Browser.
- Fix:
  Resolve the existing persisted active Turn in the daemon Browser CLI adapter,
  carry it opaquely through BrowserNode automation, and keep the reveal policy
  in Desktop Main. Mark only the first create request for each workspace, Agent
  session, and Turn as revealable. The renderer must still create and select
  every requested tab, but it focuses the workspace Browser surface or opens the
  standalone Browser panel only when that flag is set. Bound the remembered
  reveal keys and preserve the previous behavior when no exact Turn identity is
  available.
- Validation:
  Issue three concurrent create requests for one Turn and assert that all three
  pages are requested with reveal flags `true`, `false`, `false` while the host
  activates once. Assert the workspace and standalone renderer handlers do not
  focus/open their Browser surface for `reveal=false`. Then issue a create for a
  different Turn and assert it reveals again. Also cover turnless/manual
  requests, BrowserNode transport parsing, and daemon active-Turn propagation.
- References:
  [browserAutomationCoordinator.ts](../../../apps/desktop/src/main/ipc/browserAutomationCoordinator.ts)
  [provider.go](../../../services/tuttid/service/cli/providers/browser/provider.go)
  [automationRegistry.ts](../../../packages/browser/workbench-node/src/electron-main/automationRegistry.ts)

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

### `/browser` with adjacent CJK text reaches the provider as an unknown ACP command

- Symptom:
  Typing `/browser打开百度` or `/computer点击确认` returns a provider error such
  as `Unknown ACP command`, while the equivalent command with a space works.
  The behavior can appear intermittent because selecting the Composer palette
  entry inserts a canonical command token with a trailing space, whereas
  directly typed text may not contain that boundary.
- Quick checks:
  Compare the submitted user prompt with the provider's `session/prompt` input.
  If the raw slash text reaches ACP unchanged and its byte length matches the
  exact no-space draft, the local capability rewrite did not run. This is
  distinct from Browser Node launch, attachment, and authorization failures.
- Root cause:
  The local browser/computer capability parser previously treated the complete
  non-whitespace token as the command name. Adjacent CJK arguments therefore
  changed `browser` into the unknown name `browser打开百度`, bypassing the
  browser-use handoff and exposing the raw text to providers with native slash
  command parsing.
- Fix:
  Recognize an adjacent suffix as capability arguments when it begins outside
  the ASCII command-name character set. Preserve exact matching for ASCII
  command continuations so strings such as `/browsering` and `/computer2` do
  not become local capability commands. Keep this logic provider-neutral and
  normalize the visible prompt to include the canonical separating space.
- Validation:
  Cover English and localized browser/computer aliases with both spaced and
  adjacent CJK arguments, plus negative ASCII-prefix cases. At the Composer
  policy boundary, verify the draft is rewritten to the injected skill prompt
  and carries the required capability settings patch instead of reaching ACP
  as a raw slash command.
- References:
  [agentCapabilityUseSubmit.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/model/agentCapabilityUseSubmit.ts)
  [agentSlashCommandProviderPolicy.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/model/agentSlashCommandProviderPolicy.ts)

### In-app Browser new-page fails to attach for every provider

- Symptom:
  `/browser` fails for Tutti Agent, Codex, Kimi Code, Claude Code, or another
  Agent provider. `tutti browser new-page` returns `In-app Browser page did not
attach: browser:...:tab:1`, while `list-pages` remains empty. Desktop logs
  show the automation server listening and the workspace renderer returning a
  stable node id, but never show that node registering as a Browser automation
  target.
- Quick checks:
  Confirm the session advertises browser use and the slash command was rewritten
  to the browser-use skill before debugging command discovery. If `new_page`
  reaches the desktop host and returns a node id, inspect that node's initial
  lifecycle and URL. Browser automation intentionally starts at `cold` and
  `about:blank`; the creation path must carry an explicit cold-materialization
  intent so the guest exists before the registry can attach request interception
  and navigate.
- Root cause:
  All Agent providers use the same BrowserNode automation authority.
  `new_page` deliberately creates an `about:blank` tab in the full workspace
  Browser before enabling its CDP request guard. Treating every cold blank page
  as a home surface suppresses the `<webview>` guest, so the automation registry
  can never observe the node id returned by the renderer. The request then
  times out identically for every provider.
- Fix:
  Materialize a cold Browser Node guest only when the automation creation path
  marks that tab with the explicit materialization intent. Keep ordinary cold
  tabs guest-free even though workspace Browser tabs also carry automation
  target identity. Do not bypass the guarded `about:blank` sequence or navigate
  before request interception is enabled.
- Validation:
  Assert that an explicitly materialized cold Browser Node renders a webview
  while an ordinary automatable cold tab remains guest-free. Run the Browser
  Node package tests and the
  changed-aware repository checks. In a running desktop, execute
  `tutti browser new-page --url https://example.com` from sessions belonging to
  multiple providers, verify the full workspace Browser appears with each page
  in `list-pages`, and close the temporary pages.
- References:
  [automationRegistry.ts](../../../packages/browser/workbench-node/src/electron-main/automationRegistry.ts)
  [webviewController.ts](../../../packages/browser/workbench-node/src/core/webviewController.ts)
  [workspaceBrowserService.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceBrowserService.ts)

### Agent reports a loaded page but the full workspace Browser is not visible

- Symptom:
  An Agent reports that a page opened successfully, and `snapshot` or
  `list-pages` returns the expected title and URL, but the full workspace
  Browser does not come forward. Desktop logs show a Browser Node guest loading
  the requested URL; they may even show `Browser automation host activated`
  while the user still sees only the Agent conversation.
- Quick checks:
  Treat a successful snapshot as proof that the guest exists, not that its
  owner window is visible. Confirm `new_page` requested `surfaceRole=user`, the
  workspace renderer focused or launched the preferred Browser node, and Main
  activated the exact workspace window that returned the created tab id.
- Root cause:
  Visibility has three independent gates. Page creation must route to the User
  Browser rather than the embedded Agent Browser, the workspace renderer must
  restore and focus the Browser node, and Main must reveal the exact owning
  workspace window. Missing any gate lets an Agent inspect a real loaded page
  while the user sees no full Browser surface.
- Fix:
  Keep Agent session identity as the automation lease owner, but create the tab
  on `surfaceRole=user`. Focus or launch the exact full Browser node before
  responding, then reveal and focus its workspace window after creation
  succeeds. Do not activate windows for metadata reads, screenshots, select,
  close, or performance-headless runs.
- Validation:
  Test that Agent-owned creation is sent to a User Browser host, the workspace
  renderer focuses the preferred Browser node or launches the first one, and
  Main activates the responding workspace window. In a running Desktop, create
  a page through the CLI, verify a large Browser page comes forward with the
  loaded URL, and confirm the log records `Browser automation host activated`.
- References:
  [browserAutomationCoordinator.ts](../../../apps/desktop/src/main/ipc/browserAutomationCoordinator.ts)
  [browser.ts](../../../apps/desktop/src/main/ipc/browser.ts)
  [workspaceBrowserService.ts](../../../apps/desktop/src/renderer/src/features/workspace-workbench/services/internal/workspaceBrowserService.ts)
  [WorkspaceWorkbench.tsx](../../../apps/desktop/src/renderer/src/features/workspace-workbench/ui/WorkspaceWorkbench.tsx)

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
