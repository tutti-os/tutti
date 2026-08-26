# Troubleshooting

Use this index to open only the troubleshooting domain relevant to the symptom.
Entries record recurring, evidence-backed failure patterns; one-off defect journals
belong in Git history.

## Entry Format

Each entry should include the symptom, quick checks, root cause, fix, validation,
and references when useful. Add a new entry only when the pattern is likely to
recur and the repository now has implementation or debugging evidence for it.

## [Agent Runtime](./agent-runtime.md)

Use the focused runtime index or open one area directly:

- [Agent Providers And Setup](./agent-provider-setup.md): Provider discovery, installation, authentication, models, configuration, and runtime reachability.
  Includes Codex Model Plan Responses-to-Chat routing, oversized request
  metadata compatibility, and extension command/Skill palette hydration
  failures.
  Also covers uv-managed Extension installs that accidentally select an
  incompatible system Python.
  Also covers Kimi Code ACP sessions that advertise no model or hide provider
  failures behind an empty `end_turn`.
  Also covers Cursor ACP session-service startup races and tool results that
  hide aborted/TLS failures in provider-specific output fields, plus Cursor CLI
  questions that are absent from the ACP tool catalog.
  Also covers focus-driven provider CLI scans, repeated Extension Target version
  probes, Windows managed-runtime adoption sharing violations, optional Provider
  absence misclassified as an environment failure, extension release refresh
  delaying daemon startup, repeated Hermes helper downloads in isolated session
  homes, and CPU spikes.
- [Agent Sessions And Lifecycle](./agent-session-lifecycle.md): Turn state, activation, planning-mode classification, capability snapshots, Tutti workflow response contracts, loading, cancel, goal controls, restore, file-change undo, rail projection, realtime completion provenance, event updates, imports, and performance.
  Includes shared-device recovery that looks terminal while the host is still retrying.
  Also covers new or derived conversations that silently fail or lose
  project/Git ownership when a runtime worktree is mistaken for a canonical
  project (or the source Session is unavailable), and one hung provider startup
  blocking unrelated Agent sessions. Extension snapshot
  failures that erase the Agent's Tutti CLI command catalog or block restart
  resume are covered here as well. Includes cassette replay
  startup that fails when concurrent provider input and output are treated as a
  strict scheduling order, false final-state mismatches caused by replay-generated
  child identities, an orphan managed Replay Desktop that crashes with `EPIPE`
  after its owner exits, and canonical completion delayed behind a streaming
  activity-report backlog. It also covers an active existing-Session Tutti snapshot being
  misread as provider Default mode, stopped Tutti Mode conversations revived by
  legacy startup wakes, provider-completed submissions reported as delivery
  unknown after canonical message provenance conflicts, completed Claude Code
  Turns that lack a Fork entry because provider identity was not observed from
  the durable transcript, Claude failures before provider Turn identity that
  leave AgentGUI thinking, and Claude Fork operations that fail because an
  empty query never creates a durable provider child. It also covers a Claude
  Query that keeps returning connection errors after the machine network
  recovers, and forked conversations that disappear from the Rail after their
  active/running overlay settles.
  Also covers inactive Claude Resume timing out the queue send and leaving later
  prompts stuck as 排队中 behind `uncertainDelivery`, and Standard ACP process
  cleanup failures that stop a send before provider dispatch while preserving
  the composer draft. Standard ACP cancellation that returns before the active
  provider prompt drains, causing every later prompt to remain provider-queued,
  is covered here too. Historical Standard ACP sessions that reject image
  preflight before reconnect, or incorrectly choose replaying `session/load`
  over an advertised object-form `session/resume`, are covered here as well.
- [Agent Approvals And Child Sessions](./agent-approvals-subagents.md): Approval gates, plan exits, root/parent/child event attribution, child sessions, and Message Center.
  Includes provider-native work that continues invisibly after root cancellation
  and late child creation racing the durable cancel boundary.

## [Issue Execution](./issue-execution.md)

Issue dispatch, Run cancellation, Agent settlement, and stop coordination.

- [Managed task deletion is reported as a stale checkpoint](./issue-execution.md#managed-task-deletion-is-reported-as-a-stale-checkpoint)
- [Reworked task scheduling is reported as a stale checkpoint](./issue-execution.md#reworked-task-scheduling-is-reported-as-a-stale-checkpoint)
- [Final rework passes review but Tutti never reaches Goal Review](./issue-execution.md#final-rework-passes-review-but-tutti-never-reaches-goal-review)
- [Settled checkpoint keeps reopening the source Session](./issue-execution.md#settled-checkpoint-keeps-reopening-the-source-session)
- [Paused Tutti Issue keeps reopening and reports no resume command](./issue-execution.md#paused-tutti-issue-keeps-reopening-and-reports-no-resume-command)
- [Tutti composer stays busy after every task Turn settles](./issue-execution.md#tutti-composer-stays-busy-after-every-task-turn-settles)
- [Stopping a Tutti source Turn leaves automation recoverable](./issue-execution.md#stopping-a-tutti-source-turn-leaves-automation-recoverable)
- [Stop remains pending while the Agent Turn is already canceled](./issue-execution.md#stop-remains-pending-while-the-agent-turn-is-already-canceled)

## [Desktop And Release](./desktop-release.md)

Electron startup, daemon supervision, macOS packaging, updates, and performance diagnostics.

- [Packaged Tutti starts but external shells cannot find `tutti`](./desktop-release.md#packaged-tutti-starts-but-external-shells-cannot-find-tutti)
- [Desktop stable release alias disappears or is not first on Releases](./desktop-release.md#desktop-stable-release-alias-disappears-or-is-not-first-on-releases)
- [Desktop release notes exceed GitHub's body limit](./desktop-release.md#desktop-release-notes-exceed-githubs-body-limit)
- [Desktop release stalls after all packages finish building](./desktop-release.md#desktop-release-stalls-after-all-packages-finish-building)
- [Desktop dev GUI exits before opening](./desktop-release.md#desktop-dev-gui-exits-before-opening)
- [Running a development tuttid breaks the production Agent session](./desktop-release.md#running-a-development-tuttid-breaks-the-production-agent-session)
- [macOS updates fail from a mounted DMG](./desktop-release.md#macos-updates-fail-from-a-mounted-dmg)
- [macOS Gatekeeper dialogs appear during Codex provider probing](./desktop-release.md#macos-gatekeeper-dialogs-appear-during-codex-provider-probing)
- [Electron main/preload crashes on a workspace package `.ts` export](./desktop-release.md#electron-mainpreload-crashes-on-a-workspace-package-ts-export)
- [Desktop restart leaves an orphan tuttid](./desktop-release.md#desktop-restart-leaves-an-orphan-tuttid)
- [Switching agent permission mode flashes Checking for updates](./desktop-release.md#switching-agent-permission-mode-flashes-checking-for-updates)
- [App update diagnostics flood with identical download progress states](./desktop-release.md#app-update-diagnostics-flood-with-identical-download-progress-states)
- [macOS in-app update closes Tutti but does not install the new version](./desktop-release.md#macos-in-app-update-closes-tutti-but-does-not-install-the-new-version)
- [Desktop Performance trace export runs out of memory](./desktop-release.md#desktop-performance-trace-export-runs-out-of-memory)
- [macOS screenshot selector leaves the menu bar and Dock uncovered](./desktop-release.md#macos-screenshot-selector-leaves-the-menu-bar-and-dock-uncovered)

## [Workbench And Renderer](./workbench-renderer.md)

React rendering, Workbench state, external stores, input composition, and UI performance.

- [Renderer Vite cannot resolve a workspace package subpath](./workbench-renderer.md#renderer-vite-cannot-resolve-a-workspace-package-subpath)
- [Renderer body requests fail with `ERR_H2_OR_QUIC_REQUIRED`](./workbench-renderer.md#renderer-body-requests-fail-with-err_h2_or_quic_required)
- [Renderer `fetch()` rejects an Electron image protocol that `<img>` can load](./workbench-renderer.md#renderer-fetch-rejects-an-electron-image-protocol-that-img-can-load)
- [AgentGUI Mermaid flowcharts render shapes without labels](./workbench-renderer.md#agentgui-mermaid-flowcharts-render-shapes-without-labels)
- [AgentGUI carousel owner avatar stays a solid badge](./workbench-renderer.md#agentgui-carousel-owner-avatar-stays-a-solid-badge)
- [Renderer tile memory warnings from hidden autoplay animation](./workbench-renderer.md#renderer-tile-memory-warnings-from-hidden-autoplay-animation)
- [Standalone Agent dev window stays black during cold startup](./workbench-renderer.md#standalone-agent-dev-window-stays-black-during-cold-startup)
- [IME composition breaks fuzzy search or controlled search inputs](./workbench-renderer.md#ime-composition-breaks-fuzzy-search-or-controlled-search-inputs)
- [External-store snapshots churn because derived reads lose reference stability](./workbench-renderer.md#external-store-snapshots-churn-because-derived-reads-lose-reference-stability)
- [React Compiler removes a manual identity memo](./workbench-renderer.md#react-compiler-removes-a-manual-identity-memo)
- [Workbench host rebuilds when dock business status changes](./workbench-renderer.md#workbench-host-rebuilds-when-dock-business-status-changes)
- [Dock entry is open but its state indicator is missing](./workbench-renderer.md#dock-entry-is-open-but-its-state-indicator-is-missing)
- [Dense list panel stutters when mounted or resized](./workbench-renderer.md#dense-list-panel-stutters-when-mounted-or-resized)
- [Adjacent sidebar animation repeatedly reflows its content and message flow](./workbench-renderer.md#adjacent-sidebar-animation-repeatedly-reflows-its-content-and-message-flow)
- [Header divider drifts from a resizable sidebar](./workbench-renderer.md#header-divider-drifts-from-a-resizable-sidebar)
- [Effect cleanup leaves mounted refs false in React development](./workbench-renderer.md#effect-cleanup-leaves-mounted-refs-false-in-react-development)
- [AgentGUI crashes while unmounting a Monaco diff](./workbench-renderer.md#agentgui-crashes-while-unmounting-a-monaco-diff)
- [Workbench node body warns about updating WorkbenchNodeLayer during render](./workbench-renderer.md#workbench-node-body-warns-about-updating-workbenchnodelayer-during-render)
- [Renderer component repeatedly re-renders without visible changes](./workbench-renderer.md#renderer-component-repeatedly-re-renders-without-visible-changes)
- [Renderer services initialize twice and consume one event twice](./workbench-renderer.md#renderer-services-initialize-twice-and-consume-one-event-twice)
- [Inline custom-header menu is clipped to the Workbench title bar](./workbench-renderer.md#inline-custom-header-menu-is-clipped-to-the-workbench-title-bar)
- [Overflowing custom header widens the Workbench body](./workbench-renderer.md#overflowing-custom-header-widens-the-workbench-body)
- [Dialog action reacts to Enter but ignores pointer clicks](./workbench-renderer.md#dialog-action-reacts-to-enter-but-ignores-pointer-clicks)
- [Daemon validation error appears as untranslated developer text](./workbench-renderer.md#daemon-validation-error-appears-as-untranslated-developer-text)
- [Mask-backed icon renders as a solid color block](./workbench-renderer.md#mask-backed-icon-renders-as-a-solid-color-block)
- [Restored fullscreen window overflows after the host surface becomes smaller](./workbench-renderer.md#restored-fullscreen-window-overflows-after-the-host-surface-becomes-smaller)
- [Hidden workspace owner loads but its first IPC request times out](./workbench-renderer.md#hidden-workspace-owner-loads-but-its-first-ipc-request-times-out)
- [Screenshot selection appears stuck and later opens duplicate floating Composers](./workbench-renderer.md#screenshot-selection-appears-stuck-and-later-opens-duplicate-floating-composers)

## [Workspace Apps And Files](./workspace-apps-files.md)

App Center, workspace-app lifecycle, App Factory, file references, and File Manager.

- [Windows workspace reference type filters time out](./workspace-apps-files.md#windows-workspace-reference-type-filters-time-out)
- [App Factory job keeps loading after AgentGUI Stop](./workspace-apps-files.md#app-factory-job-keeps-loading-after-agentgui-stop)
- [App Center list requests repeatedly log runtime preload](./workspace-apps-files.md#app-center-list-requests-repeatedly-log-runtime-preload)
- [Workspace app commands fail inside Corepack before pnpm starts](./workspace-apps-files.md#workspace-app-commands-fail-inside-corepack-before-pnpm-starts)
- [Workspace app uninstall fails on cached manifest validation](./workspace-apps-files.md#workspace-app-uninstall-fails-on-cached-manifest-validation)
- [Workspace app update reopens the old dock window](./workspace-apps-files.md#workspace-app-update-reopens-the-old-dock-window)
- [Agent inline app opening leaks into the OS App Center](./workspace-apps-files.md#agent-inline-app-opening-leaks-into-the-os-app-center)
- [Agent file preview behavior leaks into the OS shell](./workspace-apps-files.md#agent-file-preview-behavior-leaks-into-the-os-shell)
- [Load unpacked project roots with source manifests](./workspace-apps-files.md#load-unpacked-project-roots-with-source-manifests)
- [Agent GUI app mentions show unavailable workspace apps](./workspace-apps-files.md#agent-gui-app-mentions-show-unavailable-workspace-apps)
- [Agent generated files under system temp do not open](./workspace-apps-files.md#agent-generated-files-under-system-temp-do-not-open)
- [FileManager home-relative paths break only the list pane](./workspace-apps-files.md#filemanager-home-relative-paths-break-only-the-list-pane)
- [Windows FileManager paths exist but fail validation or selection](./workspace-apps-files.md#windows-filemanager-paths-exist-but-fail-validation-or-selection)

## [Connector Market](./connector-market.md)

Connector catalog, installation, account authorization, and runtime convergence.

- [Disconnect fails immediately after authorization succeeds](./connector-market.md#disconnect-fails-immediately-after-authorization-succeeds)
- [A second authorize click starts another OAuth session](./connector-market.md#a-second-authorize-click-starts-another-oauth-session)
- [OAuth finishes in the browser but does not return to the initiating desktop build](./connector-market.md#oauth-finishes-in-the-browser-but-does-not-return-to-the-initiating-desktop-build)
- [Composer install stays spinning on an OAuth remote connector](./connector-market.md#composer-install-stays-spinning-on-an-oauth-remote-connector)
- [API-key Connect toast fails while the token is still in the form](./connector-market.md#api-key-connect-toast-fails-while-the-token-is-still-in-the-form)

## [Toolchain, Browser, And Terminal](./toolchain-browser-terminal.md)

CLI behavior, CI, package assets, skills, Browser Node, and terminal input.

- [Go-only PR skips a repository contract that later fails](./toolchain-browser-terminal.md#go-only-pr-skips-a-repository-contract-that-later-fails)
- [Goal recovery Go tests fail only in the full workspace lane](./toolchain-browser-terminal.md#goal-recovery-go-tests-fail-only-in-the-full-workspace-lane)
- [gomobile Android AAR fails after Go compilation succeeds](./toolchain-browser-terminal.md#gomobile-android-aar-fails-after-go-compilation-succeeds)
- [Dynamic CLI input rejects plausible flags](./toolchain-browser-terminal.md#dynamic-cli-input-rejects-plausible-flags)
- [GitHub Actions pnpm setup fails with ERR_PNPM_BAD_PM_VERSION](./toolchain-browser-terminal.md#github-actions-pnpm-setup-fails-with-errpnpmbadpmversion)
- [Multi-entry tsup declaration build exhausts its worker heap](./toolchain-browser-terminal.md#multi-entry-tsup-declaration-build-exhausts-its-worker-heap)
- [Browser CLI cold start timeout looks like an unreachable daemon](./toolchain-browser-terminal.md#browser-cli-cold-start-timeout-looks-like-an-unreachable-daemon)
- [Browser Agent retries plausible commands that the CLI rejects](./toolchain-browser-terminal.md#browser-agent-retries-plausible-commands-that-the-cli-rejects)
- [Malformed user skill frontmatter breaks skill discovery](./toolchain-browser-terminal.md#malformed-user-skill-frontmatter-breaks-skill-discovery)
- [Browser Node failed navigation renders a blank panel](./toolchain-browser-terminal.md#browser-node-failed-navigation-renders-a-blank-panel)
- [Standalone Agent Browser Node is blank and never attaches a guest](./toolchain-browser-terminal.md#standalone-agent-browser-node-is-blank-and-never-attaches-a-guest)
- [Agent Browser new-page fails to attach for every provider](./toolchain-browser-terminal.md#agent-browser-new-page-fails-to-attach-for-every-provider)
- [Agent reports a loaded page but no Browser window is visible](./toolchain-browser-terminal.md#agent-reports-a-loaded-page-but-no-browser-window-is-visible)
- [Browser Node action finds a webview but page injection does nothing](./toolchain-browser-terminal.md#browser-node-action-finds-a-webview-but-page-injection-does-nothing)
- [Hidden Browser Node webview covers another panel](./toolchain-browser-terminal.md#hidden-browser-node-webview-covers-another-panel)
- [IME composition leaks native input into xterm terminals](./toolchain-browser-terminal.md#ime-composition-leaks-native-input-into-xterm-terminals)
- [Chinese input renders replacement and control characters in workspace terminals](./toolchain-browser-terminal.md#chinese-input-renders-replacement-and-control-characters-in-workspace-terminals)
- [Post-composition suppression window swallows real terminal input](./toolchain-browser-terminal.md#post-composition-suppression-window-swallows-real-terminal-input)
- [Published package runtime asset 404 because the consumer bundler never saw the file](./toolchain-browser-terminal.md#published-package-runtime-asset-404-because-the-consumer-bundler-never-saw-the-file)
- [New release CDN namespace returns an S3 403](./toolchain-browser-terminal.md#new-release-cdn-namespace-returns-an-s3-403)
- [Browser Node focus pings miss iframe-hosted editors](./toolchain-browser-terminal.md#browser-node-focus-pings-miss-iframe-hosted-editors)
- [Temporary Git fixture turns a linked worktree bare](./toolchain-browser-terminal.md#temporary-git-fixture-turns-a-linked-worktree-bare)

## [Mobile](./mobile.md)

Android app login, native bridge, secure identity, and mobile transport diagnostics.

- [Android QR scan closes without advancing pairing](./mobile.md#android-qr-scan-closes-without-advancing-pairing)
- [Android stays on “Syncing the latest data” after pairing](./mobile.md#android-stays-on-syncing-the-latest-data-after-pairing)
- [Android release bundling cannot resolve the JSX transform](./mobile.md#android-release-bundling-cannot-resolve-the-jsx-transform)
- [Android update stays on MainActivity without opening the installer](./mobile.md#android-update-stays-on-mainactivity-without-opening-the-installer)
- [Mobile quick prompts are missing from the plus menu](./mobile.md#mobile-quick-prompts-are-missing-from-the-plus-menu)
- [Mobile composer model and permission controls are missing](./mobile.md#mobile-composer-model-and-permission-controls-are-missing)
- [Mobile composer option chips do not open](./mobile.md#mobile-composer-option-chips-do-not-open)
- [Browser login completes but leaves the browser in front](./mobile.md#browser-login-completes-but-leaves-the-browser-in-front)
- [Browser login returns to the App but remains signed out](./mobile.md#browser-login-returns-to-the-app-but-remains-signed-out)
- [Android DeviceLink opens a session and then repeatedly restarts](./mobile.md#android-devicelink-opens-a-session-and-then-repeatedly-restarts)
- [Mobile direct DeviceLink consistently takes about ten seconds](./mobile.md#mobile-direct-devicelink-consistently-takes-about-ten-seconds)
- [Mobile shows output from a completed Session after foreground resume](./mobile.md#mobile-shows-output-from-a-completed-session-after-foreground-resume)
- [Mobile stays connected after a long lock-screen interval but sends fail](./mobile.md#mobile-stays-connected-after-a-long-lock-screen-interval-but-sends-fail)
- [iOS App crashes after loading the JavaScript bundle](./mobile.md#ios-app-crashes-after-loading-the-javascript-bundle)
- [iOS pod install intermittently reports pathname contains null byte](./mobile.md#ios-pod-install-intermittently-reports-pathname-contains-null-byte)
- [Mobile Jest discovers tests inside iOS Pods](./mobile.md#mobile-jest-discovers-tests-inside-ios-pods)
- [React Native Pressable rows stack their children vertically](./mobile.md#react-native-pressable-rows-stack-their-children-vertically)

## [Computer Use](./computer-use.md)

cua-driver discovery, targeting, capture, input delivery, and result verification.

- [A computer click reports success but the UI does not change](./computer-use.md#a-computer-click-reports-success-but-the-ui-does-not-change)
- [Screen Recording is enabled but Tutti says it has not taken effect](./computer-use.md#screen-recording-is-enabled-but-tutti-says-it-has-not-taken-effect)
