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
- [Agent Sessions And Lifecycle](./agent-session-lifecycle.md): Turn state, activation, loading, cancel, restore, rail projection, realtime completion provenance, event updates, imports, and performance.
- [Agent Approvals And Sub-Agents](./agent-approvals-subagents.md): Approval gates, plan exits, parent/child event attribution, background agents, and Message Center.

## [Desktop And Release](./desktop-release.md)

Electron startup, daemon supervision, macOS packaging, updates, and performance diagnostics.

- [Desktop stable release alias disappears or is not first on Releases](./desktop-release.md#desktop-stable-release-alias-disappears-or-is-not-first-on-releases)
- [Desktop dev GUI exits before opening](./desktop-release.md#desktop-dev-gui-exits-before-opening)
- [macOS updates fail from a mounted DMG](./desktop-release.md#macos-updates-fail-from-a-mounted-dmg)
- [macOS Gatekeeper dialogs appear during Codex provider probing](./desktop-release.md#macos-gatekeeper-dialogs-appear-during-codex-provider-probing)
- [Electron main/preload crashes on a workspace package `.ts` export](./desktop-release.md#electron-mainpreload-crashes-on-a-workspace-package-ts-export)
- [Desktop restart leaves an orphan tuttid](./desktop-release.md#desktop-restart-leaves-an-orphan-tuttid)
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
- [Workbench host rebuilds when dock business status changes](./workbench-renderer.md#workbench-host-rebuilds-when-dock-business-status-changes)
- [Dense list panel stutters when mounted or resized](./workbench-renderer.md#dense-list-panel-stutters-when-mounted-or-resized)
- [Adjacent sidebar animation repeatedly reflows its content and message flow](./workbench-renderer.md#adjacent-sidebar-animation-repeatedly-reflows-its-content-and-message-flow)
- [Effect cleanup leaves mounted refs false in React development](./workbench-renderer.md#effect-cleanup-leaves-mounted-refs-false-in-react-development)
- [Workbench node body warns about updating WorkbenchNodeLayer during render](./workbench-renderer.md#workbench-node-body-warns-about-updating-workbenchnodelayer-during-render)
- [Renderer component repeatedly re-renders without visible changes](./workbench-renderer.md#renderer-component-repeatedly-re-renders-without-visible-changes)
- [Inline custom-header menu is clipped to the Workbench title bar](./workbench-renderer.md#inline-custom-header-menu-is-clipped-to-the-workbench-title-bar)

## [Workspace Apps And Files](./workspace-apps-files.md)

App Center, workspace-app lifecycle, App Factory, file references, and File Manager.

- [App Factory job keeps loading after AgentGUI Stop](./workspace-apps-files.md#app-factory-job-keeps-loading-after-agentgui-stop)
- [App Center list requests repeatedly log runtime preload](./workspace-apps-files.md#app-center-list-requests-repeatedly-log-runtime-preload)
- [Workspace app uninstall fails on cached manifest validation](./workspace-apps-files.md#workspace-app-uninstall-fails-on-cached-manifest-validation)
- [Workspace app update reopens the old dock window](./workspace-apps-files.md#workspace-app-update-reopens-the-old-dock-window)
- [Load unpacked project roots with source manifests](./workspace-apps-files.md#load-unpacked-project-roots-with-source-manifests)
- [Agent GUI app mentions show unavailable workspace apps](./workspace-apps-files.md#agent-gui-app-mentions-show-unavailable-workspace-apps)
- [Agent generated files under system temp do not open](./workspace-apps-files.md#agent-generated-files-under-system-temp-do-not-open)
- [FileManager home-relative paths break only the list pane](./workspace-apps-files.md#filemanager-home-relative-paths-break-only-the-list-pane)

## [Toolchain, Browser, And Terminal](./toolchain-browser-terminal.md)

CLI behavior, CI, package assets, skills, Browser Node, and terminal input.

- [Dynamic CLI input rejects plausible flags](./toolchain-browser-terminal.md#dynamic-cli-input-rejects-plausible-flags)
- [GitHub Actions pnpm setup fails with ERR_PNPM_BAD_PM_VERSION](./toolchain-browser-terminal.md#github-actions-pnpm-setup-fails-with-errpnpmbadpmversion)
- [Browser CLI cold start timeout looks like an unreachable daemon](./toolchain-browser-terminal.md#browser-cli-cold-start-timeout-looks-like-an-unreachable-daemon)
- [Malformed user skill frontmatter breaks skill discovery](./toolchain-browser-terminal.md#malformed-user-skill-frontmatter-breaks-skill-discovery)
- [Browser Node failed navigation renders a blank panel](./toolchain-browser-terminal.md#browser-node-failed-navigation-renders-a-blank-panel)
- [Standalone Agent Browser Node is blank and never attaches a guest](./toolchain-browser-terminal.md#standalone-agent-browser-node-is-blank-and-never-attaches-a-guest)
- [Hidden Browser Node webview covers another panel](./toolchain-browser-terminal.md#hidden-browser-node-webview-covers-another-panel)
- [IME composition leaks native input into xterm terminals](./toolchain-browser-terminal.md#ime-composition-leaks-native-input-into-xterm-terminals)
- [Post-composition suppression window swallows real terminal input](./toolchain-browser-terminal.md#post-composition-suppression-window-swallows-real-terminal-input)
- [Published package runtime asset 404 because the consumer bundler never saw the file](./toolchain-browser-terminal.md#published-package-runtime-asset-404-because-the-consumer-bundler-never-saw-the-file)
- [Browser Node focus pings miss iframe-hosted editors](./toolchain-browser-terminal.md#browser-node-focus-pings-miss-iframe-hosted-editors)
