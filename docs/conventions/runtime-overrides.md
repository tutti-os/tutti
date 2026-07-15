# Runtime Overrides

This document indexes supported runtime override environment variables for local state, transport, logging, diagnostics, and tests.

Use the owner documents linked below for detailed behavior. This file exists to make the supported override surface easy to scan before adding another `TUTTI_*` or `TUTTID_*` variable.

## Rules

- prefer repository-owned generated defaults when no override is required
- prefer shared root overrides such as `TUTTI_STATE_DIR` or `TUTTI_LOG_DIR` before adding per-file variables
- treat override variables as development, packaging, test, and diagnostics controls, not primary product settings
- document a new supported override here and in the narrow owner document in the same change

## Local State And Runtime Paths

| Variable                    | Owner document                                                                                             | Purpose                                                                              |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `TUTTI_ENV`                 | [Local State Storage](./local-state-storage.md)                                                            | Selects production or development default state roots.                               |
| `TUTTI_STATE_DIR`           | [Local State Storage](./local-state-storage.md)                                                            | Overrides the shared local state root.                                               |
| `TUTTI_LOG_DIR`             | [Local State Storage](./local-state-storage.md), [Logging](./logging.md)                                   | Overrides the shared log directory under the state model.                            |
| `TUTTID_DB_PATH`            | [Local State Storage](./local-state-storage.md)                                                            | Overrides the daemon SQLite database path for narrow operational needs.              |
| `TUTTID_RUN_DIR`            | [Local State Storage](./local-state-storage.md)                                                            | Overrides listener-info and pid paths, but not the state-root ownership lock.        |
| `TUTTID_PID_PATH`           | [Local State Storage](./local-state-storage.md)                                                            | Overrides the daemon pid file, but not the state-root ownership lock.                |
| `TUTTID_LISTENER_INFO_PATH` | [Local State Storage](./local-state-storage.md), [Desktop Transport](../architecture/desktop-transport.md) | Overrides the listener-info file path used by managed desktop-to-daemon transport.   |
| `CODEX_HOME`                | [Local State Storage](./local-state-storage.md)                                                            | Injected per Codex agent run by tuttid; points at the run-scoped `codex-home`.       |
| `TUTTI_AGENT_HOME`          | [Local State Storage](./local-state-storage.md)                                                            | Injected per Tutti Agent run by tuttid; points at the run-scoped `tutti-agent-home`. |

## Workspace App Catalog

| Variable                 | Owner document                                      | Purpose                                                                                                              |
| ------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `TUTTI_APP_CATALOG_FILE` | [Workspace App Catalog](./workspace-app-catalog.md) | Loads remote built-in app catalog entries from a local JSON file for mocks.                                          |
| `TUTTI_APP_CATALOG_URL`  | [Workspace App Catalog](./workspace-app-catalog.md) | Overrides the default remote built-in app catalog URL. Set to an empty string to disable the default remote catalog. |

## Workspace App Runtime

| Variable                       | Owner document                                      | Purpose                                                                                           |
| ------------------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `TUTTI_APP_RUNTIME_CATALOG`    | [Workspace App Runtime](./workspace-app-runtime.md) | Overrides the default HTTP(S) runtime catalog for first-use runtime downloads. Empty disables it. |
| `TUTTI_APP_RUNTIME_CACHE_ROOT` | [Workspace App Runtime](./workspace-app-runtime.md) | Overrides the daemon-owned managed runtime cache root.                                            |
| `TUTTI_APP_RUNTIME_ROOT`       | [Workspace App Runtime](./workspace-app-runtime.md) | Points tuttid at one exact prepared runtime root, mainly for tests and local debugging.           |
| `TUTTI_APP_PYTHON`             | [Workspace App Runtime](./workspace-app-runtime.md) | Injected by tuttid into workspace app processes; app packages should use it to launch Python.     |
| `TUTTI_APP_NODE`               | [Workspace App Runtime](./workspace-app-runtime.md) | Injected by tuttid into workspace app processes; app packages should use it to launch Node.js.    |
| `TUTTI_APP_NPM`                | [Workspace App Runtime](./workspace-app-runtime.md) | Injected by tuttid into workspace app processes; prepare scripts should use it for npm work.      |

## Desktop Transport

| Variable                    | Owner document                                                                                             | Purpose                                                      |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `TUTTID_ACCESS_TOKEN`       | [Desktop Transport](../architecture/desktop-transport.md)                                                  | Supplies the desktop-issued bearer token required by tuttid. |
| `TUTTID_ADDR`               | [Desktop Transport](../architecture/desktop-transport.md)                                                  | Overrides the TCP listener or client address.                |
| `TUTTID_LISTENER_INFO_PATH` | [Desktop Transport](../architecture/desktop-transport.md), [Local State Storage](./local-state-storage.md) | Overrides the daemon listener-info file path.                |

## Account Remote Services

| Variable                  | Owner document                                                                        | Purpose                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `TUTTI_ACCOUNT_BASE_URL`  | [Agent Account And Commerce](../architecture/agent-account-and-commerce.md)           | Overrides the daemon account auth/user-info API base URL.                                         |
| `TUTTI_AGENT_LLM_APP_ID`  | [Tutti Agent Readiness Bootstrap](../architecture/tutti-agent-readiness-bootstrap.md) | Overrides the Tutti LLM application id used when issuing provider auth tokens.                    |
| `TUTTI_AUTH_LOGIN_URL`    | [Agent Account And Commerce](../architecture/agent-account-and-commerce.md)           | Overrides the desktop account login URL used by the auth bridge.                                  |
| `TUTTI_COMMERCE_BASE_URL` | [Agent Account And Commerce](../architecture/agent-account-and-commerce.md)           | Overrides the Tutti commerce gateway base URL for session-cookie membership and credits fetches.  |
| `TUTTI_WEB_BASE_URL`      | [Agent Account And Commerce](../architecture/agent-account-and-commerce.md)           | Overrides the Tutti web origin used by tuttid when returning account profile links to desktop UI. |

## Analytics

| Variable                         | Owner document                                                                                                   | Purpose                                                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `TUTTI_APP_VERSION`              | [Analytics Tracking](../architecture/analytics-tracking.md), [Workspace App Catalog](./workspace-app-catalog.md) | Supplies the shared desktop app version used for analytics and workspace-app compatibility selection. |
| `TUTTI_ANALYTICS_DISABLED`       | [Analytics Tracking](../architecture/analytics-tracking.md)                                                      | Disables DataFinder reporting and constructs `NoopReporter`.                                          |
| `TUTTI_ANALYTICS_APP_ID`         | [Analytics Tracking](../architecture/analytics-tracking.md)                                                      | Overrides the DataFinder app id for development or test backends.                                     |
| `TUTTI_ANALYTICS_APP_KEY`        | [Analytics Tracking](../architecture/analytics-tracking.md)                                                      | Overrides the DataFinder app key for development or test backends.                                    |
| `TUTTI_ANALYTICS_CHANNEL_DOMAIN` | [Analytics Tracking](../architecture/analytics-tracking.md)                                                      | Overrides the DataFinder reporting endpoint.                                                          |
| `TUTTI_ANALYTICS_APP_VERSION`    | [Analytics Tracking](../architecture/analytics-tracking.md)                                                      | Compatibility override for the analytics app version common param.                                    |

## Logging And Diagnostics

| Variable                   | Owner document                                                           | Purpose                                                               |
| -------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `TUTTI_LOG_DIR`            | [Logging](./logging.md), [Local State Storage](./local-state-storage.md) | Overrides the shared log directory.                                   |
| `TUTTI_LOG_MAX_SIZE_MB`    | [Logging](./logging.md)                                                  | Overrides per-file rotation size budget.                              |
| `TUTTI_LOG_MAX_BACKUPS`    | [Logging](./logging.md)                                                  | Overrides rotated file count budget.                                  |
| `TUTTI_LOG_MAX_AGE_DAYS`   | [Logging](./logging.md)                                                  | Overrides rotated file age budget.                                    |
| `TUTTI_LOG_MAX_TOTAL_MB`   | [Logging](./logging.md)                                                  | Overrides managed log directory total size budget.                    |
| `TUTTID_LOG_PATH`          | [Logging](./logging.md)                                                  | Overrides the daemon log file path.                                   |
| `TUTTID_LOG_OUTPUT`        | [Logging](./logging.md)                                                  | Selects daemon log output mode.                                       |
| `TUTTID_LOG_LEVEL`         | [Logging](./logging.md)                                                  | Selects daemon log level.                                             |
| `TUTTI_DESKTOP_LOG_PATH`   | [Logging](./logging.md)                                                  | Overrides the desktop main-process log file path.                     |
| `TUTTI_DESKTOP_LOG_OUTPUT` | [Logging](./logging.md)                                                  | Selects desktop main-process log output mode.                         |
| `TUTTI_DESKTOP_LOG_LEVEL`  | [Logging](./logging.md)                                                  | Selects desktop main-process log level.                               |
| `TUTTID_FORWARD_STDIO`     | [Logging](./logging.md)                                                  | Requests desktop forwarding of managed daemon stdout for diagnostics. |
| `TUTTI_SESSION_ID`         | [Logging](./logging.md)                                                  | Correlates desktop and daemon logs for one local run.                 |

## Agent Runtime Diagnostics

Agent Extension source feature gates use
`TUTTI_AGENT_EXTENSION_<KEY>_ENABLED`. The configured Gemini source therefore
uses `TUTTI_AGENT_EXTENSION_GEMINI_ENABLED`, and the configured CodeBuddy
source uses `TUTTI_AGENT_EXTENSION_CODEBUDDY_ENABLED`. Boolean values accepted by Go's
`strconv.ParseBool` override the generated default; invalid values leave the
generated default unchanged. A disabled source never downloads or registers
its Agent Target.

| Variable                               | Owner document                                                                        | Purpose                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `TUTTI_AGENT_CONTEXT_CONFIG`           | [Local State Storage](./local-state-storage.md)                                       | Overrides the migrated agent context config path for tests and diagnostics.                      |
| `TUTTI_AGENT_CWD`                      | This document                                                                         | Mirrors the prepared agent runtime working directory for diagnostics.                            |
| `TUTTI_AGENT_SESSION_ID`               | This document                                                                         | Identifies the caller agent session for CLI invoke context and agent runtime logs.               |
| `TUTTI_AGENT_ROUTING`                  | This document                                                                         | Marks provider subprocesses launched through the migrated agent routing path.                    |
| `TUTTI_ACP_TOOL_DEBUG`                 | This document                                                                         | Enables verbose migrated ACP tool-call normalization diagnostics.                                |
| `TUTTI_CLAUDE_SDK_SIDECAR_COMMAND`     | This document                                                                         | Overrides the command used by tuttid to launch the Claude SDK sidecar.                           |
| `TUTTI_CLAUDE_SDK_SIDECAR_ENTRY_PATH`  | This document                                                                         | Internal packaged-desktop handoff pointing tuttid at the vendored Claude SDK sidecar entry.      |
| `TUTTI_CLAUDE_SDK_SIDECAR_TEST_DRIVER` | This document                                                                         | Enables the deterministic Claude SDK sidecar test driver instead of the real SDK query loop.     |
| `TUTTI_CLAUDE_AUTH_REFRESH_DEBUG`      | This document                                                                         | Explicitly enables sanitized Claude credential-refresh diagnostics; disabled by default.         |
| `CLAUDE_CONFIG_DIR`                    | This document                                                                         | Selects Claude's native user configuration and credential directory; unset uses Claude defaults. |
| `CLAUDE_CODE_EXECUTABLE`               | This document                                                                         | Selects the Claude executable passed to the Claude Agent SDK.                                    |
| `ANTHROPIC_API_KEY`                    | This document                                                                         | Supplies Anthropic API-key authentication to Claude without modifying user config files.         |
| `ANTHROPIC_AUTH_TOKEN`                 | This document                                                                         | Supplies Anthropic bearer-token authentication to Claude.                                        |
| `ANTHROPIC_BASE_URL`                   | This document                                                                         | Selects a Claude-compatible Anthropic endpoint.                                                  |
| `ANTHROPIC_API_BASE_URL`               | This document                                                                         | Preserves the alternate Anthropic endpoint variable supported by Claude tooling.                 |
| `ANTHROPIC_MODEL`                      | This document                                                                         | Preserves Claude's native default-model override.                                                |
| `ANTHROPIC_DEFAULT_OPUS_MODEL`         | This document                                                                         | Preserves Claude's native Opus alias override.                                                   |
| `ANTHROPIC_DEFAULT_SONNET_MODEL`       | This document                                                                         | Preserves Claude's native Sonnet alias override.                                                 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL`        | This document                                                                         | Preserves Claude's native Haiku alias override.                                                  |
| `TUTTI_MOCK_AGENT_UNBOUND`             | This document                                                                         | Forces Codex unbound and Claude Code auth-required for onboarding diagnostics.                   |
| `TUTTI_WORKSPACE_ID`                   | This document                                                                         | Supplies a workspace id to migrated agent context readers when no input id is provided.          |
| `TUTTI_AGENT_NPM_REGISTRY`             | [Tutti Agent Readiness Bootstrap](../architecture/tutti-agent-readiness-bootstrap.md) | Pins managed agent npm installation to one registry with no fallback.                            |

Claude Code always uses the SDK sidecar runtime. Provider availability checks
the `claude` CLI plus the Claude SDK sidecar entry and Node runtime.
Claude-native credential and endpoint values pass through unchanged. Logs may
record only their presence, storage source, expiry metadata, and non-reversible
fingerprints; they must never record values, account names, or personal paths.

OpenCode provider availability checks the `opencode` CLI directly and launches
sessions through the official `opencode acp` command. Do not add model,
agent, or auto-mode CLI flags to that ACP command. Session model selection must
be passed through OpenCode config; Tutti injects `OPENCODE_CONFIG_CONTENT` with
`{"model":"provider/model"}` when a session model override is present. The
custom-provider environment allowlist for OpenCode includes `OPENCODE_CONFIG`,
`OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, and `OPENCODE_PERMISSION`
so operator-supplied OpenCode config stays explicit and provider-owned.
OpenCode composer model options and model-specific reasoning variants come from
`opencode models --verbose` and are cached by the daemon model catalog. An
empty `variants` object is authoritative: AgentGUI must not expose or submit an
ACP `effort` value for that model. Do not restore a provider-wide static effort
list, because OpenCode models use different variant vocabularies (for example
`max` rather than `xhigh`) and some reasoning-capable models expose no
selectable variant at all. The provider auth/config watcher invalidates that
cache when OpenCode's auth marker (`~/.local/share/opencode/auth.json`) or
configured OpenCode config files change, so local model-list updates refresh
through the same `agent.model.catalog.invalidated` event path used by Codex and
Claude Code. OpenCode composer skill options are discovered with slash triggers
from native `.opencode/skills/*/SKILL.md`, Claude-compatible `.claude/skills`,
agent-compatible `.agents/skills`, global `~/.config/opencode/skills`,
`~/.claude/skills`, `~/.agents/skills`, and the `OPENCODE_CONFIG_DIR` skills
directory. Prompt image capability for those options is resolved by the
daemon model capability service: Models.dev is fetched first as the public
model source of truth and cached in memory, then provider-specific rules fill
gaps for private composer models such as Cursor's `composer-*` ids. Speed
derived model ids such as `openai/gpt-5.5-fast` keep the exact Models.dev id
authoritative when it exists, then try the base id (`openai/gpt-5.5`) so
orthogonal speed tiers do not hide base model image support. OpenCode also
advertises the provider-level `imageInput` composer capability; AgentGUI enables
image paste only when both that provider capability and the selected model's
`supportsImageInput` are true. Unknown model image capability remains
unsupported in AgentGUI.

## Desktop Renderer Diagnostics

| Variable                               | Owner document                                                  | Purpose                                                                                       |
| -------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `TUTTI_ENABLE_PERF_MONITOR`            | This document                                                   | Enables the development-only ReactRenderTracker injection in the desktop renderer dev server. |
| `TUTTI_ELECTRON_JS_FLAGS`              | [Desktop Troubleshooting](./troubleshooting/desktop-release.md) | Appends Electron `js-flags` for local diagnostics before the app is ready.                    |
| `TUTTI_ELECTRON_REMOTE_DEBUGGING_PORT` | [Desktop Troubleshooting](./troubleshooting/desktop-release.md) | Appends Electron `remote-debugging-port` for local CDP diagnostics before the app is ready.   |

## Browser MCP

| Variable                       | Owner document                                                             | Purpose                                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `TUTTI_BROWSER_MCP_COMMAND`    | [Browser Troubleshooting](./troubleshooting/toolchain-browser-terminal.md) | Overrides the command used by tuttid to launch `chrome-devtools-mcp`.                                              |
| `TUTTI_BROWSER_MCP_ARGS`       | [Browser Troubleshooting](./troubleshooting/toolchain-browser-terminal.md) | Overrides the full argument list for `chrome-devtools-mcp`; desktop browser-mode preferences are ignored when set. |
| `TUTTI_BROWSER_MCP_ENTRY_PATH` | [Browser Troubleshooting](./troubleshooting/toolchain-browser-terminal.md) | Internal packaged-desktop handoff pointing tuttid at the vendored `chrome-devtools-mcp` entry script.              |

## Review Questions

When adding or changing an override, ask:

1. Can an existing generated default or shared root override express this?
2. Is the variable owned by state, transport, logging, or a narrower subsystem?
3. Is the variable for diagnostics or packaging rather than normal product configuration?
4. Which convention or architecture document must change with this registry?
