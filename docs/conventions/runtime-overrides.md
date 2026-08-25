# Runtime Overrides

This document indexes supported runtime override environment variables for local state, transport, logging, diagnostics, and tests.

Use the owner documents linked below for detailed behavior. This file exists to make the supported override surface easy to scan before adding another `TUTTI_*` or `TUTTID_*` variable.

## Rules

- prefer repository-owned generated defaults when no override is required
- prefer shared root overrides such as `TUTTI_STATE_DIR` or `TUTTI_LOG_DIR` before adding per-file variables
- treat override variables as development, packaging, test, and diagnostics controls, not primary product settings
- document a new supported override here and in the narrow owner document in the same change

## Local State And Runtime Paths

| Variable                      | Owner document                                                                                             | Purpose                                                                              |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `TUTTI_ENV`                   | [Local State Storage](./local-state-storage.md)                                                            | Selects production or development default state roots.                               |
| `TUTTI_STATE_DIR`             | [Local State Storage](./local-state-storage.md)                                                            | Overrides the shared local state root.                                               |
| `TUTTI_AGENT_RUNTIME_DIR`     | [Local State Storage](./local-state-storage.md)                                                            | Overrides the managed Agent Extension runtime root for isolated diagnostics.         |
| `TUTTI_DESKTOP_USER_DATA_DIR` | [Local State Storage](./local-state-storage.md), [Scripts](../../tools/scripts/README.md)                  | Overrides Electron `userData` for isolated desktop diagnostics.                      |
| `TUTTI_MANAGED_POSIX_SHELL`   | [Workspace App Runtime](./workspace-app-runtime.md)                                                        | Overrides the absolute managed POSIX shell path used by Windows script adapters.     |
| `TUTTI_LOG_DIR`               | [Local State Storage](./local-state-storage.md), [Logging](./logging.md)                                   | Overrides the shared log directory under the state model.                            |
| `TUTTID_DB_PATH`              | [Local State Storage](./local-state-storage.md)                                                            | Overrides the daemon SQLite database path for narrow operational needs.              |
| `TUTTID_RUN_DIR`              | [Local State Storage](./local-state-storage.md)                                                            | Overrides listener-info and pid paths, but not the state-root ownership lock.        |
| `TUTTID_PID_PATH`             | [Local State Storage](./local-state-storage.md)                                                            | Overrides the daemon pid file, but not the state-root ownership lock.                |
| `TUTTID_LISTENER_INFO_PATH`   | [Local State Storage](./local-state-storage.md), [Desktop Transport](../architecture/desktop-transport.md) | Overrides the listener-info file path used by managed desktop-to-daemon transport.   |
| `CODEX_HOME`                  | [Local State Storage](./local-state-storage.md)                                                            | Injected per Codex agent run by tuttid; points at the run-scoped `codex-home`.       |
| `TUTTI_AGENT_HOME`            | [Local State Storage](./local-state-storage.md)                                                            | Injected per Tutti Agent run by tuttid; points at the run-scoped `tutti-agent-home`. |

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

| Variable                              | Owner document                                                                                     | Purpose                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `TUTTI_ACCOUNT_BASE_URL`              | [Agent Account And Commerce](../architecture/agent-account-and-commerce.md)                        | Overrides the daemon account auth/user-info API base URL.                                                                   |
| `TUTTI_AGENT_LLM_APP_ID`              | [Tutti Agent Readiness Bootstrap](../architecture/tutti-agent-readiness-bootstrap.md)              | Overrides the Tutti LLM application id used when issuing provider auth tokens.                                              |
| `TUTTI_AUTH_LOGIN_URL`                | [Agent Account And Commerce](../architecture/agent-account-and-commerce.md)                        | Overrides the desktop account login URL used by the auth bridge.                                                            |
| `TUTTI_COMMERCE_BASE_URL`             | [Agent Account And Commerce](../architecture/agent-account-and-commerce.md)                        | Overrides the Tutti commerce gateway base URL for session-cookie membership and credits fetches.                            |
| `TUTTI_CONNECTOR_MCP_BASE_URL`        | [Remote Connector MCP](../architecture/connector-remote-mcp.md)                                    | Overrides the tsh-server desktop gateway base URL used for remote Connector MCP requests.                                   |
| `TUTTI_MOBILE_CONTROL_PLANE_BASE_URL` | [Mobile AgentGUI And DeviceLink Design](../specs/2026-07-23-mobile-agentgui-device-link-design.md) | Overrides the tsh-server desktop control-plane base URL used by Personal device pairing.                                    |
| `TUTTI_MOBILE_REALTIME_URL`           | [Mobile AgentGUI And DeviceLink Design](../specs/2026-07-23-mobile-agentgui-device-link-design.md) | Overrides the device-level V2 WebSocket used to wake Personal paired-device attempt reads; unset uses `wss://ws.tutti.sh/`. |
| `TUTTI_PPE_LANE`                      | [Remote Connector MCP](../architecture/connector-remote-mcp.md)                                    | Sends the external `x-zk-ppe-lane` header on Account and Connector control-plane requests for local PPE testing.            |
| `TUTTI_WEB_BASE_URL`                  | [Agent Account And Commerce](../architecture/agent-account-and-commerce.md)                        | Overrides the Tutti web origin used by tuttid when returning account profile links to desktop UI.                           |

## Desktop Update Admission Development

`@tutti-os/desktop-update-admission` owns the shared, unpackaged-only
`DESKTOP_UPDATE_ADMISSION_*` environment contract used by Tutti Desktop and
TSH Desktop. See the package
[README](../../packages/desktop/update-admission/README.md) for scenario
variables, policy sequences, named scenarios, updater outcomes, foreground
interval overrides, and the loopback mock-server transport.

Packaged daemons ignore the entire environment family before parsing it.
Enabled invalid development scenarios terminate daemon startup with an explicit
configuration error. Electron resolves only the shared current version and
updater simulation; `tuttid` or `desktopd` owns in-process policy, feature,
timeout, sequence, and foreground-interval parsing. In loopback mode the
mock-server process exclusively owns policy, minimum-version, feature-key,
policy-sequence, and named-policy variables. A loopback client daemon rejects
server-owned policy variables instead of creating a second policy source.

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

Agent Extension source activation is not an environment override. Desktop
Developer settings persist `agent.extension.<key>` in the generic feature flag
map; `tuttid` reconciles the matching configured source after that preference
changes. `TUTTI_AGENT_EXTENSION_<KEY>_ENABLED` is not read.

Local Agent Extension package testing uses
`TUTTI_AGENT_EXTENSION_<KEY>_PACKAGE_DIR`. It is accepted only when
`TUTTI_ENV` resolves to `development` and must point at an unpacked package
directory containing
`tutti.agent.json`. The daemon snapshots validated package bytes into
development state instead of reading mutable repository files at runtime.
The override selects package bytes but does not enable its source; use the
matching Developer setting. Production ignores the variable and still requires
the configured signed HTTPS release.

An Extension account-usage profile normally runs the exact companion package
pinned by the signed profile. For a local package snapshot only,
`TUTTI_AGENT_EXTENSION_<KEY>_ACCOUNT_USAGE_EXECUTABLE` may select one explicit
local companion CommonJS script. The daemon accepts it only in development,
only for an installation with local-package provenance, and only after
verifying an absolute ordinary non-symlink file and its fingerprint. The fixed
Node interpreter is resolved and verified independently. Production ignores
the variable. Result decoding remains bounded and fail-closed, so this override
changes only where local development finds the Provider-owned Helper.

`make dev-gui` clears an inherited
`TUTTI_AGENT_EXTENSION_KIMI_CODE_PACKAGE_DIR` so a stale shell or launch-agent
environment cannot silently replace the signed Kimi Code release. Set
`DEV_GUI_KIMI_CODE_PACKAGE_DIR` to an explicit unpacked package path when that
one development run intentionally needs a local Kimi Code snapshot; the script
then canonicalizes the path and projects it to the generic daemon override. It
also discovers the account-usage Helper from the standard Kimi Extension
repository layout. Use `DEV_GUI_KIMI_CODE_ACCOUNT_USAGE_EXECUTABLE` when the
Helper lives elsewhere. A local package that declares account usage fails
before launch when the self-contained Helper build is missing. An
explicit path that does not exist or lacks `tutti.agent.json` fails before the
GUI starts. The daemon revalidates and snapshots the current directory on every
start and does not fall back to a cached local snapshot when the path becomes
missing or invalid.

Example:

```sh
DEV_GUI_KIMI_CODE_PACKAGE_DIR=/path/to/build/tutti-agent/package \
  make dev-gui
```

`make dev-gui` starts the Electron renderer dev server on Vite's default
port 5173. When another local checkout or another electron-vite project
already occupies that port, set `TUTTI_DESKTOP_DEV_PORT` to pin this run to a
different port; the server then uses `strictPort`, so a collision fails at
startup instead of silently hopping ports.

Example:

```sh
TUTTI_DESKTOP_DEV_PORT=5273 make dev-gui
```

| Variable                                               | Owner document                                                                        | Purpose                                                                                                                                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TUTTI_AGENT_CONTEXT_CONFIG`                           | [Local State Storage](./local-state-storage.md)                                       | Overrides the migrated agent context config path for tests and diagnostics.                                                                                                                 |
| `TUTTI_AGENT_CASSETTE_MODE`                            | [Testing](./testing.md#agent-session-record-and-replay-mvp)                           | Selects developer-only `record` or `replay` process transport composition. Desktop preload also reads `replay` as the synchronous replay-runtime flag that gates renderer replay machinery. |
| `TUTTI_AGENT_CASSETTE_PATH`                            | [Testing](./testing.md#agent-session-record-and-replay-mvp)                           | Points developer-only recording or lower-level diagnostics at one process Cassette directory.                                                                                               |
| `TUTTI_AGENT_SESSION_REPLAY_REGISTRATIONS`             | [Agent Session Replay](../architecture/agent-session-replay.md)                       | Internal JSON handoff binding Cassette/root Session/provider tape/artifact directory/transient Workspace identities for startup restore and verification.                                   |
| `TUTTI_AGENT_SESSION_REPLAY_SURFACE_STATUS_PATH`       | [Agent Session Replay](../architecture/agent-session-replay.md)                       | Main-created status handoff for one isolated multi-Surface Replay Desktop launch.                                                                                                           |
| `TUTTI_AGENT_SESSION_REPLAY_CONTROL_PATH`              | [Agent GUI Node](../architecture/agent-gui-node.md#25-developer-cassette-replay)      | Internal runner handoff for versioned isolated Replay playback commands.                                                                                                                    |
| `TUTTI_AGENT_SESSION_REPLAY_CWD`                       | [Agent Session Replay](../architecture/agent-session-replay.md)                       | Internal runner handoff pinning the portable `${REPLAY_CWD}` resolution anchor for restored/expected Session bindings; defaults to the daemon process cwd.                                  |
| `TUTTI_AGENT_SESSION_REPLAY_DAEMON_EXECUTABLE`         | [Agent Session Replay](../architecture/agent-session-replay.md)                       | Selects the isolated current-build tuttid executable used by the developer record/replay runner.                                                                                            |
| `TUTTI_AGENT_SESSION_REPLAY_HOST_ACCOUNT_AUTH`         | [Agent Session Replay](../architecture/agent-session-replay.md)                       | Selects the host Tutti account session copied into an isolated developer Replay runtime; unset uses the development account session.                                                        |
| `TUTTI_AGENT_SESSION_REPLAY_RUNTIME_PARENT`            | [Agent Session Replay](../architecture/agent-session-replay.md)                       | Selects the parent directory for disposable developer Replay runtime state and user data.                                                                                                   |
| `TUTTI_AGENT_SESSION_REPLAY_SKIP_HOST_ACCOUNT_AUTH`    | [Agent Session Replay](../architecture/agent-session-replay.md)                       | Disables host Tutti account-session seeding for an isolated developer Replay runtime.                                                                                                       |
| `DEV_GUI_KIMI_CODE_PACKAGE_DIR`                        | [Development scripts](../../tools/scripts/README.md)                                  | Selects an existing unpacked local Kimi package for one `make dev-gui` run; invalid paths fail before launch.                                                                               |
| `DEV_GUI_KIMI_CODE_ACCOUNT_USAGE_EXECUTABLE`           | [Development scripts](../../tools/scripts/README.md)                                  | Selects the local Kimi account-usage Helper when it cannot be derived from the standard repository layout.                                                                                  |
| `TUTTI_DESKTOP_DEV_PORT`                               | This document                                                                         | Pins the `make dev-gui` Electron renderer dev server to an explicit port with `strictPort`; unset uses the Vite default 5173.                                                               |
| `TUTTI_AGENT_EXTENSION_<KEY>_PACKAGE_DIR`              | [Agent Extensions](../architecture/agent-extensions.md)                               | Selects a validated local package snapshot in development; does not enable the source.                                                                                                      |
| `TUTTI_AGENT_EXTENSION_<KEY>_ACCOUNT_USAGE_EXECUTABLE` | [Agent Extensions](../architecture/agent-extensions.md)                               | Selects one verified local account-usage companion for a local Extension snapshot in development; production ignores it.                                                                    |
| `TUTTI_AGENT_RUNTIME_DIR`                              | [Local State Storage](./local-state-storage.md)                                       | Overrides the managed Agent Extension runtime root for isolated development and diagnostics.                                                                                                |
| `TUTTI_AGENT_CWD`                                      | [Agent Host](../../packages/agent/host/README.md)                                     | Carries the exact prepared logical working directory inherited by nested Agent CLI starts when they omit an explicit cwd.                                                                   |
| `TUTTI_AGENT_EXTRA_SKILL_ROOTS_JSON`                   | [Agent Runtime Preparation](../architecture/agent-runtime-preparation.md)             | Internal runtimeprep-to-app-server Adapter handoff for validated Tutti-managed Skill roots; stripped before provider launch and not a supported user override.                              |
| `TUTTI_AGENT_STABLE_SYSTEM_SKILLS_ROOT`                | [Agent Runtime Preparation](../architecture/agent-runtime-preparation.md)             | Internal runtimeprep-to-app-server Adapter handoff for the daemon-owned embedded-Skill cache; stripped before provider launch and not a supported user override.                            |
| `TUTTI_AGENT_SESSION_ID`                               | This document                                                                         | Identifies the caller agent session for CLI invoke context and agent runtime logs.                                                                                                          |
| `TUTTI_AGENT_RAIL_PLACEMENT`                           | [Agent Host](../../packages/agent/host/README.md)                                     | Carries the Host-normalized versioned `RailPlacement` JSON inherited together with `TUTTI_AGENT_CWD`; callers must not set or derive it manually.                                           |
| `TUTTI_AGENT_ROUTING`                                  | This document                                                                         | Marks provider subprocesses launched through the migrated agent routing path.                                                                                                               |
| `TUTTI_ACP_TOOL_DEBUG`                                 | This document                                                                         | Enables verbose migrated ACP tool-call normalization diagnostics.                                                                                                                           |
| `TUTTI_CLAUDE_SDK_SIDECAR_COMMAND`                     | This document                                                                         | Overrides the command used by tuttid to launch the Claude SDK sidecar.                                                                                                                      |
| `TUTTI_CLAUDE_SDK_SIDECAR_ENTRY_PATH`                  | This document                                                                         | Internal packaged-desktop handoff pointing tuttid at the vendored Claude SDK sidecar entry.                                                                                                 |
| `TUTTI_CLAUDE_SDK_SIDECAR_TEST_DRIVER`                 | This document                                                                         | Enables the deterministic Claude SDK sidecar test driver instead of the real SDK query loop.                                                                                                |
| `TUTTI_CLAUDE_AUTH_REFRESH_DEBUG`                      | This document                                                                         | Explicitly enables sanitized Claude credential-refresh diagnostics; disabled by default.                                                                                                    |
| `CLAUDE_CONFIG_DIR`                                    | This document                                                                         | Selects Claude's native user configuration and credential directory; unset uses Claude defaults.                                                                                            |
| `CLAUDE_CODE_EXECUTABLE`                               | This document                                                                         | Selects the Claude executable passed to the Claude Agent SDK.                                                                                                                               |
| `ANTHROPIC_API_KEY`                                    | This document                                                                         | Supplies Anthropic API-key authentication to Claude without modifying user config files.                                                                                                    |
| `ANTHROPIC_AUTH_TOKEN`                                 | This document                                                                         | Supplies Anthropic bearer-token authentication to Claude.                                                                                                                                   |
| `ANTHROPIC_BASE_URL`                                   | This document                                                                         | Selects a Claude-compatible Anthropic endpoint.                                                                                                                                             |
| `ANTHROPIC_API_BASE_URL`                               | This document                                                                         | Preserves the alternate Anthropic endpoint variable supported by Claude tooling.                                                                                                            |
| `ANTHROPIC_MODEL`                                      | This document                                                                         | Preserves Claude's native default-model override.                                                                                                                                           |
| `ANTHROPIC_DEFAULT_OPUS_MODEL`                         | This document                                                                         | Preserves Claude's native Opus alias override.                                                                                                                                              |
| `ANTHROPIC_DEFAULT_SONNET_MODEL`                       | This document                                                                         | Preserves Claude's native Sonnet alias override.                                                                                                                                            |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL`                        | This document                                                                         | Preserves Claude's native Haiku alias override.                                                                                                                                             |
| `TUTTI_MOCK_AGENT_UNBOUND`                             | This document                                                                         | Forces Codex unbound and Claude Code auth-required for onboarding diagnostics.                                                                                                              |
| `TUTTI_WORKSPACE_ID`                                   | This document                                                                         | Supplies a workspace id to migrated agent context readers when no input id is provided.                                                                                                     |
| `TUTTI_AGENT_NPM_REGISTRY`                             | [Tutti Agent Readiness Bootstrap](../architecture/tutti-agent-readiness-bootstrap.md) | Pins managed agent npm installation to one registry with no fallback.                                                                                                                       |

Claude Code always uses the SDK sidecar runtime. Provider availability checks
the `claude` CLI plus the Claude SDK sidecar entry and Node runtime.
Claude-native credential and endpoint values pass through unchanged. Logs may
record only their presence, storage source, expiry metadata, and non-reversible
fingerprints; they must never record values, account names, or personal paths.

Codex and Tutti Agent use the Codex app-server protocol for their model and
dynamic capability catalogs. Their model-list operation has a 30-second
provider-process bound and a 35-second outer catalog-fetch bound; the
capability-list operation has the same 30-second provider-process bound. These
provider-specific windows cover a cold Windows npm shim and the provider's
own model-metadata refresh without widening unrelated status or interactive
session timeouts. The persistent model catalog cache still uses its existing
five-minute success and short failed-fetch windows. A timeout from Codex's own
`codex_models_manager` or a stale runtime-selection error is provider-owned
and is not converted into success by these Tutti bounds.

OpenCode provider availability checks the `opencode` CLI directly and launches
sessions through the official `opencode acp` command. Do not add model,
agent, or auto-mode CLI flags to that ACP command. Session model selection must
be passed through OpenCode config; Tutti injects `OPENCODE_CONFIG_CONTENT` with
`{"model":"provider/model"}` when a session model override is present. The
custom-provider environment allowlist for OpenCode includes `OPENCODE_CONFIG`,
`OPENCODE_CONFIG_DIR`, `OPENCODE_CONFIG_CONTENT`, and `OPENCODE_PERMISSION`
so operator-supplied OpenCode config stays explicit and provider-owned.
AgentGUI Sessions add a final session-scoped `OPENCODE_CONFIG_DIR` overlay that
contains Tutti's managed `AGENTS.md` and native `skills/` tree. The overlay is
created for every OpenCode Session and is removed with that Session's runtime;
it does not write managed Skills into the Workspace or the user's global
OpenCode config directory. A model access plan, when present, writes its
`OPENCODE_CONFIG` file into that same isolated directory.
OpenCode composer model options and model-specific reasoning variants come from
`opencode models --verbose`. Run that command from the composer workspace cwd
because OpenCode resolves project configuration relative to the current
directory. The daemon gives this CLI fetch a 35-second outer request bound and
a 30-second provider-specific process bound to accommodate a cold Windows npm
shim without making other providers slower. Successful catalogs are cached in
memory for five minutes and failed fetches for 30 seconds, but the cache key
includes the workspace cwd and is not persisted across daemon restarts. An
empty `variants` object is authoritative: AgentGUI must not expose or submit an ACP
`effort` value for that model. Do not restore a provider-wide static effort list,
because OpenCode models use different variant vocabularies (for example `max`
rather than `xhigh`) and some reasoning-capable models expose no selectable
variant at all. The provider auth/config watcher still publishes the
`agent.model.catalog.invalidated` event when OpenCode's auth marker
(`~/.local/share/opencode/auth.json`) or configured OpenCode config files change
so an open composer refreshes immediately; it invalidates existing in-memory
OpenCode model-list cache entries so the next request refetches for its cwd.
OpenCode composer skill options are discovered with slash triggers
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
