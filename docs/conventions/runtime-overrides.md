# Runtime Overrides

This document indexes supported runtime override environment variables for local state, transport, logging, diagnostics, and tests.

Use the owner documents linked below for detailed behavior. This file exists to make the supported override surface easy to scan before adding another `TUTTI_*` or `TUTTID_*` variable.

## Rules

- prefer repository-owned generated defaults when no override is required
- prefer shared root overrides such as `TUTTI_STATE_DIR` or `TUTTI_LOG_DIR` before adding per-file variables
- treat override variables as development, packaging, test, and diagnostics controls, not primary product settings
- document a new supported override here and in the narrow owner document in the same change

## Local State And Runtime Paths

| Variable                    | Owner document                                                                                             | Purpose                                                                               |
| --------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `TUTTI_ENV`                 | [Local State Storage](./local-state-storage.md)                                                            | Selects production or development default state roots.                                |
| `TUTTI_STATE_DIR`           | [Local State Storage](./local-state-storage.md)                                                            | Overrides the shared local state root.                                                |
| `TUTTI_LOG_DIR`             | [Local State Storage](./local-state-storage.md), [Logging](./logging.md)                                   | Overrides the shared log directory under the state model.                             |
| `TUTTID_DB_PATH`            | [Local State Storage](./local-state-storage.md)                                                            | Overrides the daemon SQLite database path for narrow operational needs.               |
| `TUTTID_RUN_DIR`            | [Local State Storage](./local-state-storage.md)                                                            | Overrides the daemon runtime directory for files such as listener info and pid files. |
| `TUTTID_PID_PATH`           | [Local State Storage](./local-state-storage.md)                                                            | Overrides the daemon pid file path.                                                   |
| `TUTTID_LISTENER_INFO_PATH` | [Local State Storage](./local-state-storage.md), [Desktop Transport](../architecture/desktop-transport.md) | Overrides the listener-info file path used by managed desktop-to-daemon transport.    |
| `CODEX_HOME`                | [Local State Storage](./local-state-storage.md)                                                            | Injected per Codex agent run by tuttid; points at the run-scoped `codex-home`.        |
| `TUTTI_AGENT_HOME`          | [Local State Storage](./local-state-storage.md)                                                            | Injected per Tutti Agent run by tuttid; points at the run-scoped `tutti-agent-home`.  |

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

| Variable                  | Owner document                                                                 | Purpose                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `TUTTI_ACCOUNT_BASE_URL`  | [AgentGUI Tutti Account Menu](../architecture/agent-gui-tutti-account-menu.md) | Overrides the daemon account auth/user-info API base URL.                                         |
| `TUTTI_AUTH_LOGIN_URL`    | [AgentGUI Tutti Account Menu](../architecture/agent-gui-tutti-account-menu.md) | Overrides the desktop account login URL used by the auth bridge.                                  |
| `TUTTI_COMMERCE_BASE_URL` | [AgentGUI Tutti Account Menu](../architecture/agent-gui-tutti-account-menu.md) | Overrides the Tutti commerce gateway base URL for session-cookie membership and credits fetches.  |
| `TUTTI_WEB_BASE_URL`      | [AgentGUI Tutti Account Menu](../architecture/agent-gui-tutti-account-menu.md) | Overrides the Tutti web origin used by tuttid when returning account profile links to desktop UI. |

## Analytics

| Variable                         | Owner document                                              | Purpose                                                            |
| -------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------ |
| `TUTTI_APP_VERSION`              | [Analytics Tracking](../architecture/analytics-tracking.md) | Supplies the shared desktop app version propagated to tuttid.      |
| `TUTTI_ANALYTICS_DISABLED`       | [Analytics Tracking](../architecture/analytics-tracking.md) | Disables DataFinder reporting and constructs `NoopReporter`.       |
| `TUTTI_ANALYTICS_APP_ID`         | [Analytics Tracking](../architecture/analytics-tracking.md) | Overrides the DataFinder app id for development or test backends.  |
| `TUTTI_ANALYTICS_APP_KEY`        | [Analytics Tracking](../architecture/analytics-tracking.md) | Overrides the DataFinder app key for development or test backends. |
| `TUTTI_ANALYTICS_CHANNEL_DOMAIN` | [Analytics Tracking](../architecture/analytics-tracking.md) | Overrides the DataFinder reporting endpoint.                       |
| `TUTTI_ANALYTICS_APP_VERSION`    | [Analytics Tracking](../architecture/analytics-tracking.md) | Compatibility override for the analytics app version common param. |

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

| Variable                               | Owner document                                  | Purpose                                                                                          |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `TUTTI_AGENT_CONTEXT_CONFIG`           | [Local State Storage](./local-state-storage.md) | Overrides the migrated agent context config path for tests and diagnostics.                      |
| `TUTTI_AGENT_CWD`                      | This document                                   | Mirrors the prepared agent runtime working directory for diagnostics.                            |
| `TUTTI_AGENT_SESSION_ID`               | This document                                   | Identifies the caller agent session for CLI invoke context and agent runtime logs.               |
| `TUTTI_AGENT_ROUTING`                  | This document                                   | Marks provider subprocesses launched through the migrated agent routing path.                    |
| `TUTTI_ACP_TOOL_DEBUG`                 | This document                                   | Enables verbose migrated ACP tool-call normalization diagnostics.                                |
| `TUTTI_CLAUDE_CODE_RUNTIME`            | This document                                   | Selects the Claude Code runtime adapter. Default is `sdk`; `acp` selects the legacy ACP adapter. |
| `TUTTI_CLAUDE_SDK_SIDECAR_COMMAND`     | This document                                   | Overrides the command used by tuttid to launch the experimental Claude SDK sidecar.              |
| `TUTTI_CLAUDE_SDK_SIDECAR_ENTRY_PATH`  | This document                                   | Internal packaged-desktop handoff pointing tuttid at the vendored Claude SDK sidecar entry.      |
| `TUTTI_CLAUDE_SDK_SIDECAR_TEST_DRIVER` | This document                                   | Enables the deterministic Claude SDK sidecar test driver instead of the real SDK query loop.     |
| `TUTTI_MOCK_AGENT_UNBOUND`             | This document                                   | Forces Codex unbound and Claude Code auth-required for onboarding diagnostics.                   |
| `TUTTI_WORKSPACE_ID`                   | This document                                   | Supplies a workspace id to migrated agent context readers when no input id is provided.          |

Claude Code provider availability follows `TUTTI_CLAUDE_CODE_RUNTIME`: the
default `sdk` runtime checks the `claude` CLI plus the Claude SDK sidecar entry
and Node runtime, while `acp` keeps using the legacy `claude-acp` package from
the ACP External Agent Registry.

OpenCode provider availability checks the `opencode` CLI directly and launches
sessions through the official `opencode acp` command. Do not add model,
agent, or auto-mode CLI flags to that ACP command. Session model selection must
be passed through OpenCode config; Tutti injects `OPENCODE_CONFIG_CONTENT` with
`{"model":"provider/model"}` when a session model override is present. The
custom-provider environment allowlist for OpenCode includes `OPENCODE_CONFIG`,
`OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, and `OPENCODE_PERMISSION`
so operator-supplied OpenCode config stays explicit and provider-owned.
OpenCode composer model options come from `opencode models` and are cached by
the daemon model catalog. The provider auth/config watcher invalidates that
cache when OpenCode's auth marker (`~/.local/share/opencode/auth.json`) or
configured OpenCode config files change, so local model-list updates refresh
through the same `agent.model.catalog.invalidated` event path used by Codex and
Claude Code.

## Desktop Renderer Diagnostics

| Variable                               | Owner document                          | Purpose                                                                                       |
| -------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `TUTTI_ENABLE_PERF_MONITOR`            | This document                           | Enables the development-only ReactRenderTracker injection in the desktop renderer dev server. |
| `TUTTI_ELECTRON_JS_FLAGS`              | [Troubleshooting](./troubleshooting.md) | Appends Electron `js-flags` for local diagnostics before the app is ready.                    |
| `TUTTI_ELECTRON_REMOTE_DEBUGGING_PORT` | [Troubleshooting](./troubleshooting.md) | Appends Electron `remote-debugging-port` for local CDP diagnostics before the app is ready.   |

## Browser MCP

| Variable                       | Owner document                          | Purpose                                                                                                            |
| ------------------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `TUTTI_BROWSER_MCP_COMMAND`    | [Troubleshooting](./troubleshooting.md) | Overrides the command used by tuttid to launch `chrome-devtools-mcp`.                                              |
| `TUTTI_BROWSER_MCP_ARGS`       | [Troubleshooting](./troubleshooting.md) | Overrides the full argument list for `chrome-devtools-mcp`; desktop browser-mode preferences are ignored when set. |
| `TUTTI_BROWSER_MCP_ENTRY_PATH` | [Troubleshooting](./troubleshooting.md) | Internal packaged-desktop handoff pointing tuttid at the vendored `chrome-devtools-mcp` entry script.              |

## Review Questions

When adding or changing an override, ask:

1. Can an existing generated default or shared root override express this?
2. Is the variable owned by state, transport, logging, or a narrower subsystem?
3. Is the variable for diagnostics or packaging rather than normal product configuration?
4. Which convention or architecture document must change with this registry?
