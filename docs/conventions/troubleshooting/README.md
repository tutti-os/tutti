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
  Includes extension command/Skill palette hydration failures.
  Also covers focus-driven provider CLI scans, repeated Extension Target version
  probes, and CPU spikes.
- [Agent Sessions And Lifecycle](./agent-session-lifecycle.md): Turn state, activation, planning-mode classification, Tutti workflow response contracts, loading, cancel, goal controls, restore, file-change undo, rail projection, realtime completion provenance, event updates, imports, and performance.
  Includes shared-device recovery that looks terminal while the host is still retrying.
- [Agent Approvals And Child Sessions](./agent-approvals-subagents.md): Approval gates, plan exits, root/parent/child event attribution, child sessions, and Message Center.
  Includes provider-native work that continues invisibly after root cancellation
  and late child creation racing the durable cancel boundary.

## [Desktop And Release](./desktop-release.md)

Electron startup, daemon supervision, macOS packaging, updates, and performance diagnostics.

- [Packaged Tutti starts but external shells cannot find `tutti`](./desktop-release.md#packaged-tutti-starts-but-external-shells-cannot-find-tutti)
- [Desktop stable release alias disappears or is not first on Releases](./desktop-release.md#desktop-stable-release-alias-disappears-or-is-not-first-on-releases)
- [Desktop release notes exceed GitHub's body limit](./desktop-release.md#desktop-release-notes-exceed-githubs-body-limit)
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

## [Workbench And Renderer](./workbench-renderer.md)

React rendering, Workbench state, external stores, input composition, and UI performance.

- [Renderer body requests fail with `ERR_H2_OR_QUIC_REQUIRED`](./workbench-renderer.md#renderer-body-requests-fail-with-err_h2_or_quic_required)
- [Renderer tile memory warnings from hidden autoplay animation](./workbench-renderer.md#renderer-tile-memory-warnings-from-hidden-autoplay-animation)
- [Standalone Agent dev window stays black during cold startup](./workbench-renderer.md#standalone-agent-dev-window-stays-black-during-cold-startup)
- [IME composition breaks fuzzy search or controlled search inputs](./workbench-renderer.md#ime-composition-breaks-fuzzy-search-or-controlled-search-inputs)
- [External-store snapshots churn because derived reads lose reference stability](./workbench-renderer.md#external-store-snapshots-churn-because-derived-reads-lose-reference-stability)
- [React Compiler removes a manual identity memo](./workbench-renderer.md#react-compiler-removes-a-manual-identity-memo)
- [Workbench host rebuilds when dock business status changes](./workbench-renderer.md#workbench-host-rebuilds-when-dock-business-status-changes)
- [Dock entry is open but its state indicator is missing](./workbench-renderer.md#dock-entry-is-open-but-its-state-indicator-is-missing)
- [Dense list panel stutters when mounted or resized](./workbench-renderer.md#dense-list-panel-stutters-when-mounted-or-resized)
- [Adjacent sidebar animation repeatedly reflows its content and message flow](./workbench-renderer.md#adjacent-sidebar-animation-repeatedly-reflows-its-content-and-message-flow)
- [Effect cleanup leaves mounted refs false in React development](./workbench-renderer.md#effect-cleanup-leaves-mounted-refs-false-in-react-development)
- [Workbench node body warns about updating WorkbenchNodeLayer during render](./workbench-renderer.md#workbench-node-body-warns-about-updating-workbenchnodelayer-during-render)
- [Renderer component repeatedly re-renders without visible changes](./workbench-renderer.md#renderer-component-repeatedly-re-renders-without-visible-changes)
- [Renderer services initialize twice and consume one event twice](./workbench-renderer.md#renderer-services-initialize-twice-and-consume-one-event-twice)
- [Inline custom-header menu is clipped to the Workbench title bar](./workbench-renderer.md#inline-custom-header-menu-is-clipped-to-the-workbench-title-bar)
- [Dialog action reacts to Enter but ignores pointer clicks](./workbench-renderer.md#dialog-action-reacts-to-enter-but-ignores-pointer-clicks)
- [Daemon validation error appears as untranslated developer text](./workbench-renderer.md#daemon-validation-error-appears-as-untranslated-developer-text)
- [Mask-backed icon renders as a solid color block](./workbench-renderer.md#mask-backed-icon-renders-as-a-solid-color-block)

## [Workspace Apps And Files](./workspace-apps-files.md)

App Center, workspace-app lifecycle, App Factory, file references, and File Manager.

- [App Factory job keeps loading after AgentGUI Stop](./workspace-apps-files.md#app-factory-job-keeps-loading-after-agentgui-stop)
- [App Center list requests repeatedly log runtime preload](./workspace-apps-files.md#app-center-list-requests-repeatedly-log-runtime-preload)
- [Workspace app uninstall fails on cached manifest validation](./workspace-apps-files.md#workspace-app-uninstall-fails-on-cached-manifest-validation)
- [Workspace app update reopens the old dock window](./workspace-apps-files.md#workspace-app-update-reopens-the-old-dock-window)
- [Agent inline app opening leaks into the OS App Center](./workspace-apps-files.md#agent-inline-app-opening-leaks-into-the-os-app-center)
- [Agent file preview behavior leaks into the OS shell](./workspace-apps-files.md#agent-file-preview-behavior-leaks-into-the-os-shell)
- [Load unpacked project roots with source manifests](./workspace-apps-files.md#load-unpacked-project-roots-with-source-manifests)
- [Agent GUI app mentions show unavailable workspace apps](./workspace-apps-files.md#agent-gui-app-mentions-show-unavailable-workspace-apps)
- [Agent generated files under system temp do not open](./workspace-apps-files.md#agent-generated-files-under-system-temp-do-not-open)
- [FileManager home-relative paths break only the list pane](./workspace-apps-files.md#filemanager-home-relative-paths-break-only-the-list-pane)

## [Toolchain, Browser, And Terminal](./toolchain-browser-terminal.md)

CLI behavior, CI, package assets, skills, Browser Node, and terminal input.

- [Go-only PR skips a repository contract that later fails](./toolchain-browser-terminal.md#go-only-pr-skips-a-repository-contract-that-later-fails)
- [gomobile Android AAR fails after Go compilation succeeds](./toolchain-browser-terminal.md#gomobile-android-aar-fails-after-go-compilation-succeeds)
- [Dynamic CLI input rejects plausible flags](./toolchain-browser-terminal.md#dynamic-cli-input-rejects-plausible-flags)
- [GitHub Actions pnpm setup fails with ERR_PNPM_BAD_PM_VERSION](./toolchain-browser-terminal.md#github-actions-pnpm-setup-fails-with-errpnpmbadpmversion)
- [Multi-entry tsup declaration build exhausts its worker heap](./toolchain-browser-terminal.md#multi-entry-tsup-declaration-build-exhausts-its-worker-heap)
- [Browser CLI cold start timeout looks like an unreachable daemon](./toolchain-browser-terminal.md#browser-cli-cold-start-timeout-looks-like-an-unreachable-daemon)
- [Malformed user skill frontmatter breaks skill discovery](./toolchain-browser-terminal.md#malformed-user-skill-frontmatter-breaks-skill-discovery)
- [Browser Node failed navigation renders a blank panel](./toolchain-browser-terminal.md#browser-node-failed-navigation-renders-a-blank-panel)
- [Standalone Agent Browser Node is blank and never attaches a guest](./toolchain-browser-terminal.md#standalone-agent-browser-node-is-blank-and-never-attaches-a-guest)
- [Browser Node action finds a webview but page injection does nothing](./toolchain-browser-terminal.md#browser-node-action-finds-a-webview-but-page-injection-does-nothing)
- [Hidden Browser Node webview covers another panel](./toolchain-browser-terminal.md#hidden-browser-node-webview-covers-another-panel)
- [IME composition leaks native input into xterm terminals](./toolchain-browser-terminal.md#ime-composition-leaks-native-input-into-xterm-terminals)
- [Chinese input renders replacement and control characters in workspace terminals](./toolchain-browser-terminal.md#chinese-input-renders-replacement-and-control-characters-in-workspace-terminals)
- [Post-composition suppression window swallows real terminal input](./toolchain-browser-terminal.md#post-composition-suppression-window-swallows-real-terminal-input)
- [Published package runtime asset 404 because the consumer bundler never saw the file](./toolchain-browser-terminal.md#published-package-runtime-asset-404-because-the-consumer-bundler-never-saw-the-file)
- [New release CDN namespace returns an S3 403](./toolchain-browser-terminal.md#new-release-cdn-namespace-returns-an-s3-403)
- [Browser Node focus pings miss iframe-hosted editors](./toolchain-browser-terminal.md#browser-node-focus-pings-miss-iframe-hosted-editors)
- [Temporary Git fixture turns a linked worktree bare](./toolchain-browser-terminal.md#temporary-git-fixture-turns-a-linked-worktree-bare)

## [Computer Use](./computer-use.md)

cua-driver discovery, targeting, capture, input delivery, and result verification.

- [A computer click reports success but the UI does not change](./computer-use.md#a-computer-click-reports-success-but-the-ui-does-not-change)
