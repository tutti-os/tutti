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
