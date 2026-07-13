# Troubleshooting: Agent Runtime

[Back to troubleshooting index](./README.md)

Open only the area that matches the symptom:

## [Agent Providers And Setup](./agent-provider-setup.md)

Provider discovery, installation, authentication, models, configuration, and runtime reachability.

- [Agent provider picker shows only Claude Code and Codex](./agent-provider-setup.md#agent-provider-picker-shows-only-claude-code-and-codex)
- [Claude composer model list stays stale after credential switch](./agent-provider-setup.md#claude-composer-model-list-stays-stale-after-credential-switch)
- [Claude SDK context window shows 200k for 1M models](./agent-provider-setup.md#claude-sdk-context-window-shows-200k-for-1m-models)
- [Codex npm install misses the platform package](./agent-provider-setup.md#codex-npm-install-misses-the-platform-package)
- [Tutti Agent npm install misses the platform package](./agent-provider-setup.md#tutti-agent-npm-install-misses-the-platform-package)
- [Agent sandbox cannot reach local daemon](./agent-provider-setup.md#agent-sandbox-cannot-reach-local-daemon)
- [Codex provider install fails with missing npm](./agent-provider-setup.md#codex-provider-install-fails-with-missing-npm)
- [Codex ACP warns about user-level config as project-local config](./agent-provider-setup.md#codex-acp-warns-about-user-level-config-as-project-local-config)
- [Cursor sessions create project `.cursor/skills` or `AGENTS.md` changes](./agent-provider-setup.md#cursor-sessions-create-project-cursorskills-or-agentsmd-changes)
- [Codex provider shows login required when global service tier is legacy](./agent-provider-setup.md#codex-provider-shows-login-required-when-global-service-tier-is-legacy)
- [Codex provider shows login required when only an API key is configured](./agent-provider-setup.md#codex-provider-shows-login-required-when-only-an-api-key-is-configured)
- [Codex session fails with not connected when model_catalog_json is relative](./agent-provider-setup.md#codex-session-fails-with-not-connected-when-modelcatalogjson-is-relative)
- [Codex custom model_provider mixes models, duplicates replies, or shows metadata warnings](./agent-provider-setup.md#codex-custom-modelprovider-mixes-models-duplicates-replies-or-shows-metadata-warnings)
- [Claude SDK Grep or Glob unavailable despite Claude Code preset](./agent-provider-setup.md#claude-sdk-grep-or-glob-unavailable-despite-claude-code-preset)
- [Concurrent agent CLI installs corrupt shared npm global state](./agent-provider-setup.md#concurrent-agent-cli-installs-corrupt-shared-npm-global-state)
- [Agent provider install looks idle while a non-Codex installer is running](./agent-provider-setup.md#agent-provider-install-looks-idle-while-a-non-codex-installer-is-running)
- [Legacy Claude ACP adapter appears stale after external registry migration](./agent-provider-setup.md#legacy-claude-acp-adapter-appears-stale-after-external-registry-migration)
- [Cursor ACP context ring stays empty or usage looks wrong](./agent-provider-setup.md#cursor-acp-context-ring-stays-empty-or-usage-looks-wrong)
- [Claude SDK model aliases resolve to configured Anthropic defaults](./agent-provider-setup.md#claude-sdk-model-aliases-resolve-to-configured-anthropic-defaults)
- [Claude SDK rejects live bypassPermissions mode](./agent-provider-setup.md#claude-sdk-rejects-live-bypasspermissions-mode)
- [Claude Code logs out after sending a message (invalid_grant, credentials wiped)](./agent-provider-setup.md#claude-code-logs-out-after-sending-a-message-invalidgrant-credentials-wiped)
- [Claude Code sessions fail with `effectiveSource: "none"` when CC-Switch or similar proxy tools are used](./agent-provider-setup.md#claude-code-sessions-fail-with-effectivesource-none-when-cc-switch-or-similar-proxy-tools-are-used)

## [Agent Sessions And Lifecycle](./agent-session-lifecycle.md)

Turn state, loading, cancel, restore, rail projection, event updates, imports, and performance.

- [AgentGUI Stop reports no active turn after cancel succeeds](./agent-session-lifecycle.md#agentgui-stop-reports-no-active-turn-after-cancel-succeeds)
- [AgentGUI send blocked by active_turn after settled snapshot](./agent-session-lifecycle.md#agentgui-send-blocked-by-activeturn-after-settled-snapshot)
- [AgentGUI rejects a pasted image as unsupported before send](./agent-session-lifecycle.md#agentgui-rejects-a-pasted-image-as-unsupported-before-send)
- [AgentGUI loading disappears before active turn settles](./agent-session-lifecycle.md#agentgui-loading-disappears-before-active-turn-settles)
- [Agent session stays loading after a completed turn](./agent-session-lifecycle.md#agent-session-stays-loading-after-a-completed-turn)
- [AgentGUI model switch changes defaults but not the active session](./agent-session-lifecycle.md#agentgui-model-switch-changes-defaults-but-not-the-active-session)
- [Agent GUI provider tab shows fused or stale conversations](./agent-session-lifecycle.md#agent-gui-provider-tab-shows-fused-or-stale-conversations)
- [Agent GUI no-project sessions appear under a user project](./agent-session-lifecycle.md#agent-gui-no-project-sessions-appear-under-a-user-project)
- [Agent session restore breaks when durable snapshot ownership is split](./agent-session-lifecycle.md#agent-session-restore-breaks-when-durable-snapshot-ownership-is-split)
- [Agent activity live updates fail after event schema changes](./agent-session-lifecycle.md#agent-activity-live-updates-fail-after-event-schema-changes)
- [Remote agent cancel does not stop the local turn](./agent-session-lifecycle.md#remote-agent-cancel-does-not-stop-the-local-turn)
- [AgentGUI freezes when session history is large](./agent-session-lifecycle.md#agentgui-freezes-when-session-history-is-large)
- [Agent diagnostics flood while a turn is streaming](./agent-session-lifecycle.md#agent-diagnostics-flood-while-a-turn-is-streaming)
- [Imported sessions trigger fresh-completion indicators](./agent-session-lifecycle.md#imported-sessions-trigger-fresh-completion-indicators)

## [Agent Approvals And Sub-Agents](./agent-approvals-subagents.md)

Approval gates, plan exits, parent/child event attribution, background agents, and Message Center.

- [External PR review approvals do not refresh gate status](./agent-approvals-subagents.md#external-pr-review-approvals-do-not-refresh-gate-status)
- [Agent approval controls submit stale permission requests after restart](./agent-approvals-subagents.md#agent-approval-controls-submit-stale-permission-requests-after-restart)
- [Claude SDK ExitPlanMode fails as interrupted after plan is ready](./agent-approvals-subagents.md#claude-sdk-exitplanmode-fails-as-interrupted-after-plan-is-ready)
- [Codex app-server subagent output appears as the parent reply](./agent-approvals-subagents.md#codex-app-server-subagent-output-appears-as-the-parent-reply)
- [Claude SDK subagent events overwrite or complete the parent turn](./agent-approvals-subagents.md#claude-sdk-subagent-events-overwrite-or-complete-the-parent-turn)
- [Claude SDK subagent approval stuck in Message Center](./agent-approvals-subagents.md#claude-sdk-subagent-approval-stuck-in-message-center)
- [Claude SDK parent waits forever for background agents that already finished](./agent-approvals-subagents.md#claude-sdk-parent-waits-forever-for-background-agents-that-already-finished)
