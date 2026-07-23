# Troubleshooting: Agent Providers And Setup

[Agent runtime index](./agent-runtime.md) · [All troubleshooting](./README.md)

Provider discovery, installation, authentication, models, configuration, and runtime reachability.

### Kimi Code session creation reports `requires an agent_extension target`

- Symptom:
  Selecting an installed Kimi Code Agent immediately fails session creation
  with `dynamic provider "kimi-code" requires an agent_extension target`.
- Quick checks:
  Correlate the renderer's create-session request with the daemon error. If the
  request carries `agentTargetId = local:kimi-code`, inspect `agent_targets`.
  An installed externalized Kimi runtime should instead have the canonical
  target `extension:kimi-code`, provider `acp:kimi-code`, and an
  `agent_extension` launch reference.
- Root cause:
  A released Desktop/daemon version-skew window allowed a renderer that still
  knew Kimi as a built-in local target to talk to a daemon that already required
  the externalized Extension identity. The runtime correctly rejected the
  stale local identity because a dynamic provider must launch through its
  installed Extension.
- Fix:
  Preserve daemon-provided target and provider identities throughout Desktop
  projection. At the daemon create boundary, resolve only the known released
  `local:kimi-code` alias, and only when the canonical installed Extension
  target exists. Rewrite the request to `extension:kimi-code` /
  `acp:kimi-code` before persistence and launch. Do not weaken the dynamic
  provider's `agent_extension` requirement or construct a launch reference
  from the stale request.
- Validation:
  Cover Desktop projection of the canonical Kimi Extension identity, alias
  resolution with and without the installed target, and create-session launch
  canonicalization including the trusted Extension installation ID.
- References:
  [agent-gui-node.md](../../architecture/agent-gui-node.md)
  [agent_store.go](../../../services/tuttid/data/workspace/agent_store.go)
  [service.go](../../../services/tuttid/service/agent/service.go)

### Focusing a workspace repeatedly starts provider CLIs and raises CPU usage

- Symptom:
  Focusing or reopening a workspace makes the fan ramp up even when no Agent
  turn starts. The effect grows when more managed provider CLIs are installed.
- Quick checks:
  Inspect GET requests to `/v1/agent-providers/status`. A focus-driven request
  with `refresh=true` bypasses the daemon status cache. Correlate the same time
  range with short-lived `codex`, `opencode`, `cursor`, `node`, `git`, and
  credential-helper processes. Use `pnpm perf:agent-gui -- --scenario
provider-status-focus-refresh --all-process-time-profile` on macOS when a
  Chromium trace cannot see daemon child processes.
- Root cause:
  Window lifecycle analytics requested a fresh availability snapshot by using
  the explicit-refresh path. Every pageview opportunity therefore bypassed the
  daemon cache and launched provider detection work; a focus arriving during a
  scan queued another forced scan.
- Fix:
  Let availability analytics reuse the renderer's loaded status snapshot, and
  route only stale visibility reconciliation through a non-forced tuttid read.
  Let tuttid own cache expiry, credential fingerprints, and per-provider
  single-flight. Initialize providers in parallel for first-paint latency, but
  serialize later background stale reconciliation and cap the aggregate
  auth/version/adapter subprocess count. Keep `refresh=true` only for explicit
  user refreshes and provider-scoped confirmation after state-changing actions.
  A forced read must recheck auth/readiness, but can reuse successful
  executable-scoped facts while the binary fingerprint is unchanged; never
  cache failed version or adapter probes. Prefer validated credential files for
  OpenCode and Tutti Agent and allow at most one CLI fallback for malformed
  files. Reuse fields from a provider command instead of launching duplicate
  probes: Cursor `about --format json` returns both authentication details and
  `cliVersion`, so its status detection must not also launch `cursor-agent
--version` unless the `about` output omitted the version.
- Validation:
  Dispatch two focus events and assert they start no provider-status request,
  availability pageviews are unchanged, and an explicit refresh still sends
  exactly one forced request. The all-process trace should contain no
  focus-driven provider-detection child process burst.
- References:
  [agent-gui-node.md](../../architecture/agent-gui-node.md)
  [desktopAgentProviderStatusService.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/desktopAgentProviderStatusService.ts)
  [agent-provider-status-performance-scenario.mjs](../../../tools/scripts/agent-provider-status-performance-scenario.mjs)

### Loading Agent Targets repeatedly starts Extension CLIs

- Symptom:
  Opening a workspace, standalone Agent window, or Agent settings takes longer
  as more Agent Extensions are enabled. Repeated `GET /v1/agent-targets`
  requests start the same Extension CLI `--version` commands even though the
  executables did not change.
- Quick checks:
  Time several authenticated `GET /v1/agent-targets` requests and correlate them
  with short-lived Extension CLI processes. Compare the total request duration
  with each configured discovery candidate's version command.
- Root cause:
  Extension Target availability resolved every runtime from scratch. Package
  and executable validation are required, but the stable successful version
  result was discarded after every request. Concurrent catalog consumers could
  also run the same version command independently.
- Fix:
  Cache only successful version results by resolved executable fingerprint,
  arguments, and version constraint, and coalesce concurrent probes. Keep failed
  probes uncached. Continue package authority and managed-runtime integrity
  checks on every resolution; catalog availability is not runtime launch
  authorization.
- Validation:
  Resolve the same Extension runtime twice and assert one version subprocess.
  Cover concurrent callers, a failed probe followed by recovery, and executable
  replacement invalidation. Repeated `/v1/agent-targets` requests should retain
  the same availability while no longer starting unchanged Extension CLIs.
- References:
  [agent-extensions.md](../../architecture/agent-extensions.md)
  [manager.go](../../../services/tuttid/service/agentextension/manager.go)
  [runtime_version_cache.go](../../../services/tuttid/service/agentextension/runtime_version_cache.go)

### An extension Agent is installed in the terminal but Tutti cannot detect it

- Symptom:
  Running the Agent CLI in an interactive terminal works, while the extension
  setup dialog reports that no compatible runtime is installed.
- Quick checks:
  Resolve the executable with `command -v` in the terminal and compare its
  parent directory with the desktop daemon's effective PATH. Check the signed
  extension `profiles/discovery.json` for a matching user-relative
  `searchPaths` entry and confirm that the reported CLI version satisfies its
  constraint.
- Root cause:
  The desktop daemon inherits the GUI process environment and does not source
  `.zshrc` or other interactive shell startup files. Some official installers
  place a self-contained CLI in a vendor directory under the user's home, so
  the terminal can find it only after shell initialization.
- Fix:
  Declare the vendor-owned location in the extension candidate, for example
  `{"scope":"user","path":".vendor/bin"}`. Keep the vendor path out of
  core and let the shared runtime resolver prepend the validated directory.
  Update the extension version constraint and managed package recipe to match
  the same official CLI generation.
- Validation:
  Run discovery with a daemon PATH that omits the vendor directory and an
  injected user home containing the CLI. Assert that the binding is `local`,
  uses the absolute vendor executable, passes the version constraint, and
  retains the declared ACP launch arguments. Also reject absolute paths,
  parent traversal, and unsupported scopes.
- References:
  [agent-extensions.md](../../architecture/agent-extensions.md)
  [runtime_contract.go](../../../services/tuttid/service/agentextension/runtime_contract.go)
  [manager.go](../../../services/tuttid/service/agentextension/manager.go)

### Clicking provider login repeatedly opens terminals and browser auth pages

- Symptom:
  One login click opens many terminal nodes and repeatedly launches the
  provider's browser authentication page. The repeats may continue at the
  provider-status polling interval and resume after reopening the app.
- Quick checks:
  Count `agent-provider.terminal-command.start` events for one provider and
  compare their timestamps with provider status requests. If every status
  snapshot is followed by another login command, inspect whether a React effect
  reattaches the setup workflow when a status-derived callback changes identity.
  Also check whether reattachment resets the request-sequence dedup marker and
  whether login is excluded from pending/single-flight tracking.
- Root cause:
  The panel lifecycle and the setup workflow had competing ownership. A status
  refresh replaced the status object, rebuilt the login callback, reran the
  effect, reset wizard state, and accepted the same automatic login again. Each
  command opened a new terminal; the CLI then opened another browser page. A
  single terminal-handle map entry also allowed newer launches to overwrite the
  only handle that could later be closed.
- Fix:
  Inject the panel-open host command into AgentGUI and let a window-scoped
  Agent Env service/controller own the request session, automatic-action idempotency,
  reveal/report state, and provider-status subscription. Route account and CLI
  login through the provider-status service. Its per-provider login lifecycle
  must reuse automatic requests, coalesce launches, replace an awaiting attempt
  only for an explicit retry, reject stale terminal handles, and own one poll.
  React should only subscribe and forward commands.
- Validation:
  Replay at least 60 provider-status ticks for one request and assert one
  automatic login call. Cover rapid user clicks, explicit replacement, delayed
  terminal resolution, account login without a terminal, timeout/dispose
  cleanup, and a new request sequence. Verify one terminal and one browser page
  for the original click.
- References:
  [agent-gui-node.md](../../architecture/agent-gui-node.md)
  [desktop-layering.md](../desktop-layering.md)
  [agentEnvService.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/agentEnvService.ts)
  [desktopAgentProviderLoginLifecycle.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/services/internal/desktopAgentProviderLoginLifecycle.ts)

### Codex `/status` shows a 5h limit for a weekly-only account window

- Symptom:
  Opening `/status` before starting a Codex conversation labels the only quota
  as `5h limit`, while the upstream usage response reports a seven-day window.
  An active conversation may show a different label.
- Quick checks:
  Inspect `agent.usage_probe.result` in desktop logs, then inspect the Codex
  `/wham/usage` response shape. If `primary_window.limit_window_seconds` is
  `604800` and `secondary_window` is absent, the primary slot is carrying the
  weekly window. Compare this with daemon app-server telemetry, where the same
  duration is `windowDurationMins: 10080`.
- Root cause:
  Empty-session `/status` loads account quotas through the desktop provider
  probe, while active sessions receive canonical runtime usage from the daemon.
  Both paths once inferred quota type from `primary`/`secondary` position, but
  Codex may put the weekly-only quota in `primary`.
- Fix:
  Classify known Codex windows by duration in both mappers: five hours is
  `session`, seven days is `weekly`. Use the positional type only when duration
  is missing or unknown. Keep additional named rate limits typed as `model`.
- Validation:
  Cover a desktop probe response whose primary and secondary durations are
  opposite their conventional positions, plus daemon mapper cases for a
  weekly-only primary window. Verify both empty and active `/status` views.
- References:
  [agentProviderUsageProbe.ts](../../../apps/desktop/src/main/agentProviderUsageProbe.ts)
  [codex_appserver_event_state.go](../../../packages/agent/daemon/runtime/codex_appserver_event_state.go)

### Provider setup notice flashes after switching to an already-connected agent

- Symptom:
  Opening or restarting Tutti, then switching to an existing Claude Code,
  Cursor, or other managed-provider session, briefly shows the toast-like
  "connect provider before sending" notice even though automatic readiness
  recovery succeeds and messages can be sent after the status refresh settles.
- Quick checks:
  Compare the desktop provider-status snapshot for the active provider with the
  AgentGUI view model. An active conversation must project no provider-readiness
  gate. If provider `checking`, `auth_required`, or `not_installed` disables its
  composer or renders a setup notice, catalog readiness leaked into session
  recovery ownership.
- Root cause:
  Startup or daemon restart may temporarily expose an uncaptured or stale
  provider catalog status. AgentGUI projected that target-creation readiness
  into an already-open session, creating a second owner beside canonical
  session/runtime recovery. Transient catalog reconciliation then blocked the
  active composer and rendered a misleading connect action.
- Fix:
  Keep the structured readiness gate only on the empty new-conversation surface.
  Active sessions always project a null provider gate; canonical session/runtime
  state owns recovery, submit, queue, and cancel capability. Remove active setup
  notices and all composer conditions derived from provider catalog readiness.
  Desktop may still refresh stale catalog status for future session creation.
- Validation:
  Cover active-session null gate, empty-surface gate selection, and explicit
  install/login action mapping. Also run desktop readiness-gate tests, AgentGUI
  tests, and desktop/AgentGUI typechecks.
- References:
  [agentGuiProviderReadiness.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/model/agentGuiProviderReadiness.ts)
  [useAgentGUIViewAssembly.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUIViewAssembly.ts)
  [useDesktopAgentGUIReadiness.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/ui/useDesktopAgentGUIReadiness.ts)
  [desktopAgentProviderNotReadyRecheck.ts](../../../apps/desktop/src/renderer/src/features/workspace-agent/ui/desktopAgentProviderNotReadyRecheck.ts)
  [agent-gui-node.md](../../architecture/agent-gui-node.md)

### Agent provider picker shows only Claude Code and Codex

- Symptom:
  Desktop settings, App Center, Issue Manager, or an installed workspace app
  only shows Claude Code and Codex even after Cursor/OpenCode are enabled.
- Quick checks:
  For host-owned pickers, compare `/v1/agent-targets` with
  `/v1/agent-providers/status`. The target list must include enabled
  `local:cursor`/`local:opencode`, and provider status must report them as
  `ready`. For workspace apps, inspect the app server's provider detection;
  host preferences are not injected into app-owned provider lists.
- Root cause:
  Host-owned app/workbench pickers are derived from daemon agent targets plus
  provider readiness and visibility preferences. The desktop default provider
  preference is a separate OpenAPI/event schema enum. Workspace apps own their
  runtime provider policy through `@tutti-os/agent-acp-kit`, so generated or
  packaged app UIs can still be limited to the providers the app implements.
- Fix:
  Keep the host default-provider enum, desktop settings options, daemon
  validation, and generated clients/protocol schemas in sync. For installed
  workspace apps, update the app's provider detection/runtime integration
  instead of expecting host settings to expand the app UI.
- Validation:
  Run `pnpm generate:api`, `pnpm generate:event-protocol`,
  `pnpm check:api-generated`, `pnpm check:event-protocol-generated`, desktop
  typecheck, and focused daemon preferences/API tests. If local `pnpm` resolves
  to the wrong version inside generator subprocesses, run the checks with a
  temporary `pnpm` PATH shim that delegates to `corepack pnpm@10.11.0`.
- References:
  [core.ts](../../../apps/desktop/src/shared/preferences/core.ts)
  [model.go](../../../services/tuttid/biz/preferences/model.go)
  [tuttid.v1.yaml](../../../services/tuttid/api/openapi/tuttid.v1.yaml)
  [workspace-app-runtime.md](../workspace-app-runtime.md)

### Claude composer model list stays stale after credential switch

- Symptom:
  After an external credential switcher rewrites Claude Code auth or config
  files, the AgentGUI composer still shows the previous model list even though
  `tuttid.log` contains `agent.model_catalog.invalidated` for `claude-code`.
- Quick checks:
  Search `tuttid.log` for `CLAUDE_MODEL_CATALOG_INVALIDATION_DEBUG`. If
  `live_composer_models_invalidated` is followed by
  `running_session_model_options_reused`, inspect that session's
  `createdAtUnixMs` and `updatedAtUnixMs` against the invalidation timestamp.
- Root cause:
  Claude composer model discovery reuses model options from a live Claude
  runtime session to avoid spawning overlapping credential-touching processes.
  After a credential switch, a pre-switch runtime session can still carry the
  old `runtimeContext.configOptions`; reusing it repopulates the just-cleared
  live model cache with stale models.
- Fix:
  Track provider model-catalog invalidation time in `tuttid`. When loading
  Claude composer options, skip running-session model options whose session
  timestamp is older than the provider invalidation, and allow hidden live
  discovery to query the current credentials.
- Validation:
  Add daemon service coverage where invalidation happens after a Claude session
  has advertised old model options; the next composer options request must
  start hidden discovery and return the freshly discovered model list. Run
  `cd services/tuttid && go test ./service/agent`.
- References:
  [composer_live_model_discovery.go](../../../services/tuttid/service/agent/composer_live_model_discovery.go)
  [composer_live_model_cache.go](../../../services/tuttid/service/agent/composer_live_model_cache.go)

### Claude SDK context window shows 200k for 1M models

- Symptom:
  Claude Code GUI usage shows a 200k context window for a model that should have
  1M context, such as Claude Sonnet 5. The inverse can also happen after a model
  switch: a 200k model such as Haiku keeps showing the prior 1M total.
- Quick checks:
  Inspect the session runtime context for `usage.contextWindow.totalTokens`,
  then trace the Claude SDK sidecar `usage_updated` payload and daemon
  `agent_session.claude_sdk.usage_update` log. If the payload keys include
  `modelUsage` but `raw_total_tokens` is `0`, the daemon did not parse the
  model-usage context window. If `previous_context_model` and
  `current_context_model` differ but `current_total_tokens` equals
  `previous_total_tokens`, daemon usage normalization reused a stale context
  window across models. If switching models without sending a message makes the
  usage entry disappear, inspect whether a forced session-control reload
  returned `runtimeContext` without `usage` and replaced the active control
  state.
- Root cause:
  AgentGUI only renders `runtimeContext.usage`; the total comes from the daemon
  and Claude SDK sidecar. Claude SDK result messages expose model usage as a
  map keyed by model id, for example
  `modelUsage["claude-sonnet-5"].contextWindow`. If either sidecar or daemon
  only parses array-shaped `modelUsage`, the context-window total is missing and
  daemon normalization falls back to 200k.
- Fix:
  Parse `modelUsage` recursively as both arrays and maps before using fallback
  context-window values. Track the model associated with a cached context
  window, and only reuse the previous total for the same model or when the model
  is unknown. Treat `runtimeContext.usage` as incremental telemetry in AgentGUI
  reload races: a full session-control snapshot that omits usage should not
  clear the previous usage display. Do not hard-code alias-to-model mappings in
  Tutti.
- Validation:
  Add sidecar and daemon coverage with map-shaped `modelUsage` carrying
  `contextWindow: 1_000_000`, plus daemon coverage for Haiku -> Sonnet5 -> Haiku
  usage updates where the last payload lacks `totalTokens`. Add AgentGUI
  coverage for session-control reloads that omit `runtimeContext.usage`. Then
  run the Claude SDK sidecar tests, daemon Go tests, AgentGUI tests, and
  typechecks.
- References:
  [main.ts](../../../packages/agent/claude-sdk-sidecar/src/main.ts)
  [main.test.ts](../../../packages/agent/claude-sdk-sidecar/src/main.test.ts)
  [claude_sdk_adapter.go](../../../packages/agent/daemon/runtime/claude_sdk_adapter.go)

### Codex npm install misses the platform package

- Symptom:
  The Codex environment dialog says the CLI is installed, but the adapter or
  `codex app-server` probe is still missing. Logs may show
  `Missing optional dependency @openai/codex-darwin-arm64`, a long wait on an
  npm registry, or a later repair failure such as `ENOTEMPTY` while moving an
  existing `@openai/codex` directory. Another form is an immediate launcher
  failure such as `env: node: No such file or directory` after the JavaScript
  `codex` shim has been installed.
- Quick checks:
  Inspect the npm debug log under the install cache for
  `reify failed optional dependency`, then check whether the matching platform
  package directory contains both `package.json` and the vendor `codex`
  executable. Compare the selected registry with a temporary prefix/cache
  install before changing the user's real install.
- Root cause:
  `@openai/codex` installs a JavaScript launcher plus a per-platform optional
  package such as `@openai/codex-darwin-arm64`. npm can exit successfully even
  when an optional dependency fetch failed, which leaves the launcher installed
  but unable to start. A registry can also be reachable but too slow for the
  platform tarball, so retrying the same source burns the install timeout before
  mirrors are tried. The launcher itself uses `#!/usr/bin/env node`, so
  daemon-run Codex commands (`--version`, `login status`, and `app-server`) need
  a usable Node on `PATH`. Tutti should prefer the user's Node environment, but
  fall back to the managed Node runtime when the visible `codex` shim exists and
  no user Node is resolvable.
- Fix:
  Keep Codex installs on the Tutti-managed Node/npm runtime, install with
  optional dependencies included, and rank configured npm registries with a
  lightweight package metadata probe before attempting the install. Preserve
  `TUTTI_AGENT_NPM_REGISTRY` as an explicit single-registry pin with no mirror
  fallback. Provider command resolution should leave the user's Node first when
  it is available, and only append managed Node runtime env (`TUTTI_APP_NODE`,
  `TUTTI_APP_NPM`, managed `PATH`) when user Node is missing. Ensure the Codex
  app-server adapter consumes that provider command resolution; otherwise status
  probes can pass while session startup still fails with `env: node: No such
file or directory`. If the CLI path exists but `codex app-server` cannot
  launch, treat the failed probe as a repair trigger so the install action does
  not clear immediately without running an installer.
- Validation:
  Reproduce in a temporary prefix/cache using the Tutti-managed npm. Confirm
  `codex --version`, the platform package metadata and vendor binary, and a
  short `codex app-server` probe before touching the user's real install. Include
  a case where the visible `codex` shim uses `#!/usr/bin/env node` and the normal
  user `PATH` does not contain `node`.
- References:
  [npm_registry.go](../../../services/tuttid/service/agentstatus/npm_registry.go)
  [installer_codex_cli.go](../../../services/tuttid/service/agentstatus/installer_codex_cli.go)
  [codex_platform.go](../../../services/tuttid/service/agentstatus/codex_platform.go)
  [provider_resolution.go](../../../services/tuttid/service/agentstatus/provider_resolution.go)
  [codex_appserver_adapter.go](../../../packages/agent/daemon/runtime/codex_appserver_adapter.go)

### Tutti Agent npm install misses the platform package

- Symptom:
  The Tutti Agent provider setup reaches the login screen or reports the CLI as
  installed, but `tutti-agent login` or `tutti-agent app-server` fails with
  `Missing optional dependency @tutti-os/tutti-agent-<platform>`.
- Quick checks:
  Check the selected registry for both `@tutti-os/tutti-agent` and the exact
  alias target version, such as
  `@tutti-os/tutti-agent@0.0.1-darwin-arm64`. Do not treat a successful
  aggregate package metadata fetch as proof that the platform tarball is
  available.
- Root cause:
  `@tutti-os/tutti-agent` follows the Codex npm layout: a JavaScript launcher
  plus per-platform optional dependencies expressed as npm aliases. npm can
  complete the aggregate install even when a mirror has not synced the platform
  optional dependency version.
- Fix:
  Keep the package layout aligned with Codex and use registries that carry the
  platform optional dependency versions. The daemon default chain intentionally
  excludes mirrors that only sync the aggregate package. Preserve
  `TUTTI_AGENT_NPM_REGISTRY` as an explicit single-registry pin with no fallback.
- Validation:
  Install into a temporary prefix/cache and verify the provider probe, not only
  npm's exit code. Confirm `tutti-agent app-server` can start far enough to pass
  the daemon readiness probe.
- References:
  [npm_registry.go](../../../services/tuttid/service/agentstatus/npm_registry.go)
  [runtimeprep tutti_agent.go](../../../packages/agent/runtimeprep/tutti_agent.go)
  [tuttid tuttiagent service.go](../../../services/tuttid/service/tuttiagent/service.go)

### Agent sandbox cannot reach local daemon

- Symptom:
  An AgentGUI-backed Codex turn runs a dynamic Tutti CLI command such as
  `tutti-dev automation --help` and gets `daemon is not reachable`, while
  `~/.tutti-dev/run/tuttid.listener.json` exists and the desktop daemon is
  running.
- Quick checks:
  Inspect the turn context in the provider session JSONL. If
  `network_access=false`, a plain `exec_command` cannot reach localhost/IPC.
  For Codex sessions, also confirm the command was not rerun with
  `sandbox_permissions=require_escalated`. Other providers need their own
  local-daemon-capable shell/runtime path, not Codex-specific sandbox syntax.
- Root cause:
  Dynamic CLI scopes fetch command capabilities from the local daemon before
  printing scope help. In a sandboxed provider command environment, localhost
  access can be blocked even though the daemon is reachable from the host.
- Fix:
  In agent environments, keep the CLI's transport failure message explicit
  about the sandbox but provider-neutral. Put provider-specific recovery steps
  in the injected runtime policy: Codex can use
  `sandbox_permissions=require_escalated`, while ACP providers should be told to
  use an execution environment with localhost/IPC access and not to invent Codex
  flags.
- Validation:
  Add CLI daemon-client coverage that non-agent failures keep the plain
  `daemon is not reachable` message, while agent failures include the
  localhost/IPC execution-environment hint. Add provider policy coverage so only
  Codex receives `sandbox_permissions=require_escalated`.
- References:
  [client.go](../../../apps/cli/internal/daemon/client.go)
  [run.go](../../../apps/cli/internal/app/run.go)

### Codex provider install fails with missing npm

- Symptom:
  Agent setup or the onboarding flow repeatedly reports Codex install failures,
  and `tuttid` logs show `installerKind=codex_cli_latest`, `exitCode=127`, and
  `stderr="zsh:1: command not found: npm"` for every npm registry attempt.
- Quick checks:
  Search `tuttid.log` for `agent provider install step failed` and
  `codex_cli_latest`. If each registry fails in milliseconds with exit code
  `127`, stop investigating registry reachability; the command never reached
  npm networking.
- Root cause:
  The Codex CLI installer is daemon-owned but shells out through the daemon
  environment. Packaged desktop launches may not expose a user-managed `npm` on
  `PATH`, even though Tutti already has a managed Node runtime for workspace app
  and external-agent npm work.
- Fix:
  Resolve user `npm` first for compatibility, then fall back to the Tutti
  managed Node runtime's `npm` before running
  `npm install -g --prefix <stable-user-prefix> @openai/codex --include=optional`.
  Keep the install prefix in a resolver-searched user directory such as
  `~/.local` so the installed `codex` remains discoverable after install.
- Validation:
  Add or run service coverage for a daemon environment with no user `npm` and a
  ready managed Node runtime. Then run `pnpm lint:go` and
  `cd services/tuttid && go test ./service/agentstatus`.
- References:
  [installer_codex_cli.go](../../../services/tuttid/service/agentstatus/installer_codex_cli.go)
  [runtime.go](../../../services/tuttid/service/managedruntime/runtime.go)

### Codex ACP warns about user-level config as project-local config

- Symptom:
  Codex ACP startup logs include
  `Ignored unsupported project-local config keys` for user-level Codex config
  keys such as `model_provider`, `model_providers`, or `notify`.
- Quick checks:
  Inspect the session cwd and its parents for an accidental project root, such
  as a `.git` directory under `$HOME`, plus a sibling `.codex/config.toml`.
  Inspect the generated `codex-home/config.toml`; it should be a session-scoped
  file, not a symlink to the user's global Codex config.
- Root cause:
  Codex walks upward from the session cwd to identify the project root. If it
  reaches a parent directory that also contains `.codex/config.toml`, Codex can
  read the user's global config as project-local config, where user-level keys
  are unsupported.
- Fix:
  Codex sidecar preparation must treat `CODEX_HOME` as the run-scoped
  user-level Codex home for application-wide injection, not as a project root.
  Copy the user's `config.toml` into the run-scoped `codex-home`, then merge
  `project_root_markers = []` there so ACP sessions do not read accidental
  parent `.codex/config.toml` files as project-local config. Do not symlink the
  config, because the run may need session-specific config that must not mutate
  the global Codex config. Do not create marker files or directories in the
  user's cwd.
- Validation:
  Add or update `runtimeprep` tests that verify no cwd marker is created, the
  generated Codex config preserves user-level provider settings while disabling
  project root markers, and the user's global config is not modified. Run
  `pnpm lint:go` plus
  `cd services/tuttid && go test ./... && go build ./...`.
- References:
  [codex.go](../../../packages/agent/runtimeprep/codex.go)
  [preparer_test.go](../../../packages/agent/runtimeprep/preparer_test.go)

### Cursor sessions create project `.cursor/skills` or `AGENTS.md` changes

- Symptom:
  Starting a Cursor Agent session through Tutti leaves new Tutti-managed skill
  directories under the repository, such as `.cursor/skills/tutti-cli` or
  `.cursor/skills/tutti-cli-tutti-6`, or appends a `BEGIN TUTTI-RUNTIME`
  managed block to the tracked project `AGENTS.md`. The directories may
  accumulate across runs and the managed block can appear as a tracked working
  tree change.
- Quick checks:
  Inspect the session sidecar manifest for `provider-skill` entries pointing
  inside the workspace cwd. For current sessions, `TUTTI_CURSOR_PLUGIN_DIR`
  should point under the session runtime root, for example
  `~/.tutti-dev/agent/runs/<session>/cursor-plugin/tutti-cli`, and the Cursor
  ACP command should include `--plugin-dir <that-dir>` before `acp`. The
  project `AGENTS.md` should not receive a `TUTTI-RUNTIME` managed block for
  Cursor sessions.
- Root cause:
  Cursor supports local plugins via `cursor-agent --plugin-dir`, but the
  previous sidecar path reused project-local native skill installation and wrote
  Tutti injected skills to `cwd/.cursor/skills`. Repeated runs then allocated
  suffixed names instead of overwriting the session-owned materialization. The
  same Cursor preparation path also wrote provider instructions into
  `cwd/AGENTS.md`, which dirtied tracked repositories.
- Fix:
  Materialize Tutti Cursor skills as a session-scoped Cursor plugin with
  `.cursor-plugin/plugin.json` and `skills/*/SKILL.md`; expose it through
  `TUTTI_CURSOR_PLUGIN_DIR`, and start Cursor ACP as
  `cursor-agent --plugin-dir <plugin-dir> acp`. Keep user/project
  `.cursor/skills` discoverable for composer options, but never write Tutti
  injected skills or Tutti runtime instructions into the workspace cwd for
  Cursor sessions. Cursor Agent `2026.07.01-41b2de7` does not load plugin hooks
  in ACP mode, so do not advertise the dormant background-Task guard in the
  plugin manifest and do not claim that background Task is blocked. Do not
  install the hook into user or project Cursor configuration as a workaround.
- Validation:
  Add `runtimeprep` coverage that Cursor prepare creates the runtime plugin
  while leaving project `.cursor/skills` and `AGENTS.md` untouched, runtime
  coverage that Cursor ACP includes `--plugin-dir`, and agent service coverage
  that Cursor composer skill discovery includes plugin skills. Then run
  `cd packages/agent/runtimeprep && go test ./...`,
  `cd services/tuttid && go test ./service/agent`, and
  `go test ./packages/agent/daemon/runtime`.
- References:
  [cursor.go](../../../packages/agent/runtimeprep/cursor.go)
  [acp_provider_cursor.go](../../../packages/agent/daemon/runtime/acp_provider_cursor.go)
  [skill_options.go](../../../services/tuttid/service/agent/skill_options.go)

### Cursor read-only mode still creates files without approval

- Symptom:
  AgentGUI shows Cursor as Read-only, but the transcript reports a successful
  `Switch Mode` followed by `Edit`, the file appears on disk, and no approval
  interaction is shown.
- Quick checks:
  Inspect the exported session settings and ACP startup logs together. If the
  durable `permissionModeId` is `read-only` while
  `agent_session.acp.permission_mode.start` reports `mode_id=plan`, then the
  permission tier was mapped to Cursor's planning workflow rather than its
  read-only execution mode. Confirm the turn contains no
  `session/request_permission` before investigating AgentGUI approval cards.
- Root cause:
  Cursor `plan` and `ask` are different workflow modes. Plan can transition
  into implementation, including a provider-owned `Switch Mode`, whereas Ask
  retains read/search tools without making changes. Mapping Tutti's durable
  read-only permission tier to Plan therefore delegated a security boundary to
  a workflow that could advance into editing. A provider-owned tool call is
  historical activity, not a canonical approval Interaction, so AgentGUI
  correctly had no approval request to render.
- Fix:
  Map Cursor `read-only` to ACP `ask`. Keep the independent AgentGUI plan-mode
  control mapped to ACP `plan`, and when plan mode is turned off, restore the
  runtime mode derived from the durable permission tier instead of assuming
  `agent`.
- Validation:
  Cover startup tier mapping (`read-only -> ask`) and a read-only plan-mode
  round trip (`ask -> plan -> ask`). With a real Cursor ACP binary, verify Ask
  can search and read project files, a request to create a file does not write
  one, and no provider-owned mode switch silently enables Edit.
- References:
  [providers.go](../../../packages/agent/daemon/providerregistry/providers.go)
  [acp_provider_cursor.go](../../../packages/agent/daemon/runtime/acp_provider_cursor.go)
  [standard_acp_adapter_test.go](../../../packages/agent/daemon/runtime/standard_acp_adapter_test.go)

### Codex provider shows login required when global service tier is legacy

- Symptom:
  The workspace dock popup shows Codex as needing login even though
  `~/.codex/auth.json` contains OAuth tokens.
- Quick checks:
  Run `codex login status`. If it prints
  `Error loading configuration: ... unknown variant ... expected fast or flex`,
  inspect the top-level `service_tier` in `~/.codex/config.toml`.
- Root cause:
  Newer Codex CLIs only accept `service_tier = "fast"` or `"flex"` in global
  config. Older values such as `"default"` or `"priority"` make the status
  command fail before it can report auth state, so tuttid classifies auth as
  unknown and the renderer shows login/refresh.
- Fix:
  Provider status and login commands should pass a temporary Codex config
  override such as `-c 'service_tier="fast"'` instead of mutating the user's
  global config. Session-scoped Codex homes should continue sanitizing copied
  config through `codexConfigWithSupportedServiceTier`.
- Validation:
  Add or update `agentstatus` tests for the Codex status/login command shape,
  then run `cd services/tuttid && go test ./service/agentstatus`.

### Codex provider shows login required when only an API key is configured

- Symptom:
  The environment wizard / dock marks Codex as needing login ("未登录") even
  though an API key is configured and Codex sessions can already run
  successfully. Common sources are `OPENAI_API_KEY` in the environment,
  `api_key` in `~/.codex/config.toml`, or `OPENAI_API_KEY` inside
  `~/.codex/auth.json` as written by custom-provider switchers.
- Quick checks:
  Run `codex login status` (often prints `Not logged in`). Confirm an API
  credential exists via `echo $OPENAI_API_KEY`,
  `grep -E 'api_key' ~/.codex/config.toml`, or a non-empty
  `OPENAI_API_KEY` field in `~/.codex/auth.json`.
- Root cause:
  `codex login status` only reflects a ChatGPT OAuth session. API-key billing
  from the environment, config, or `auth.json` is invisible to that command,
  so tuttid used to treat the provider as `auth_required` and block the wizard
  even though the runtime can authenticate with the key.
- Fix:
  Provider status should call `providerHasAPICredential` for Codex the same way
  it does for Claude Code, including `auth.json` `OPENAI_API_KEY`. When an API
  key is present, report auth as authenticated with method `apiKey` / label
  `API Usage Billing` instead of requiring login. A bare custom base URL
  without a credential must not trigger this override.
- Validation:
  Add or update `agentstatus` tests for environment, config.toml, and auth.json
  API-key-without-login readiness, then run
  `cd services/tuttid && go test ./service/agentstatus`.

### Codex session fails with not connected when model_catalog_json is relative

- Symptom:
  Codex is installed and `codex login status` reports logged in, but Tutti
  chat fails with `agent session is not connected`. Daemon logs show
  `thread/start` failing with
  `failed to load configuration: No such file or directory (os error 2)`.
  Tools such as CC Switch often set
  `model_catalog_json = "cc-switch-model-catalog.json"` in `~/.codex/config.toml`.
  If that catalog file is missing entirely, the same config error can also make
  provider status show login required (`auth_unknown`) even though OAuth tokens
  exist.
- Quick checks:
  `grep model_catalog_json ~/.codex/config.toml` and confirm the referenced
  file exists under `~/.codex/`. Inspect the run-scoped
  `~/.tutti-dev/agent/runs/<session>/codex-home/` (or `~/.tutti/...` in prod):
  `config.toml` is copied, but a relative catalog must also be present there.
- Root cause:
  Tutti prepares a run-scoped `CODEX_HOME` and copies only `config.toml` (plus
  auth/plugin/skill exposure). Relative `model_catalog_json` paths resolve
  against that sandbox home, so the catalog is missing unless Tutti mirrors it.
- Fix:
  After copying `config.toml`, resolve top-level `model_catalog_json`. For
  relative paths under `~/.codex`, symlink (or copy) the catalog into the
  run-scoped `CODEX_HOME` at the same relative path. Absolute catalog paths
  need no mirror. Do not mutate the user's global config.
- Validation:
  Add or update `runtimeprep` tests that set a relative catalog beside
  `config.toml` and assert the sandbox exposes it. Run
  `cd packages/agent/runtimeprep && go test ./...`.
- References:
  [codex.go](../../../packages/agent/runtimeprep/codex.go)
  [preparer_test.go](../../../packages/agent/runtimeprep/preparer_test.go)

### Codex model picker collapses to the configured model

- Symptom:
  With the default OpenAI provider, the composer model picker contains only the
  top-level `model` from `~/.codex/config.toml`, while a directly initialized
  `codex app-server` connection returns multiple models from `model/list`.
- Quick checks:
  Confirm `model_provider` is empty or `openai`. A non-default provider without
  `model_catalog_json` is intentionally limited to its configured model; use
  the custom-provider entry below when a catalog is configured. Search daemon
  logs for `composer model catalog lookup failed`, `Not initialized`, or a
  Codex `model/list` timeout, then compare the request sequence with the
  app-server initialization contract.
- Root cause:
  Model discovery sent `initialize` and `model/list` back to back without
  reading the initialize response or sending the `initialized` notification.
  An app-server that enforces the connection handshake can reject or withhold
  `model/list`. The failed catalog then falls back to the configured model,
  making the protocol failure look like a valid one-option picker.
- Fix:
  Keep one stdout scanner for the exchange: send `initialize`, read and
  validate the matching response, send `initialized`, and only then send
  `model/list`. Preserve the configured-model fallback for genuine discovery
  failures.
- Validation:
  Use a fake app-server that rejects `model/list` until it has returned the
  initialize response and received `initialized`. Run
  `cd services/tuttid && go test ./service/agent -run TestCodexCLIModelLister`
  plus `pnpm lint:go`.
- References:
  [codex_model_catalog.go](../../../services/tuttid/service/agent/codex_model_catalog.go)
  [codex_model_catalog_test.go](../../../services/tuttid/service/agent/codex_model_catalog_test.go)

### Codex custom model_provider mixes models, duplicates replies, or shows metadata warnings

- Symptom:
  With `model_provider` set to a custom endpoint and `model` set to a vendor
  model id, the composer mixes official GPT ids with the configured model, a
  turn may show the same assistant reply twice, or the transcript repeatedly
  displays `Model metadata for ... not found. Defaulting to fallback metadata`.
- Quick checks:
  Inspect top-level `model_provider`, `model`, and `model_catalog_json` in
  `~/.codex/config.toml`.
  In persisted session messages, look for two completed assistant rows with
  equivalent text but different message ids in one turn. Without a configured
  catalog, the composer model options should contain only the configured model.
  With a configured catalog, `codex app-server` should return that catalog from
  `model/list`, including the top-level configured model.
- Root cause:
  The model catalog either appended the configured custom model to Codex's
  official `model/list`, or unconditionally collapsed a valid
  `model_catalog_json` response to one configured model. Separately, Codex can
  finalize an assistant item after an early stream boundary and replay the
  answer again in `turn/completed`, sometimes with whitespace polish; treating
  each report as a new segment creates duplicate bubbles. The model-metadata
  warning is runtime diagnostic noise rather than an actionable user error.
- Fix:
  When a non-default `model_provider` and top-level `model` are configured
  without `model_catalog_json`, expose only that model in the Codex catalog.
  When `model_catalog_json` is configured and `model/list` includes the
  configured model, preserve the returned catalog and mark that model as the
  default. Continue falling back to the configured model if the returned list
  is unrelated. Preserve the assistant message id for whitespace-equivalent
  item-finalization text and ignore turn-final text after an assistant segment
  has already completed. Filter the metadata fallback warning through the same
  AgentGUI diagnostic-notice projection used for skills-context-budget
  warnings.
- Validation:
  Run
  `go test ./packages/agent/daemon/runtime -run 'TestApplyAssistantFinalText|TestApplyAssistantTurnFinalText|TestCodexAppServerAdapterExecStreamsTurn'`,
  `cd services/tuttid && go test ./service/agent -run TestAgentModelCatalog`,
  and the focused AgentGUI projection test.

### Claude SDK Grep or Glob unavailable despite Claude Code preset

- Symptom:
  Claude emits `Grep` or `Glob`, but the SDK returns `No such tool available`
  and suggests using shell `grep` or `find`.
- Root cause:
  Some Claude Code SDK native builds expose search through `Bash` by default.
  The `claude_code` tool preset may not register dedicated `Grep`/`Glob` tools
  unless the host also lists them in `allowedTools` or `tools`.
- Fix:
  Keep the `claude_code` preset as the base tool set, and explicitly include
  `Grep` and `Glob` in Claude SDK `allowedTools`. Avoid replacing `tools` with a
  short string list unless the host intentionally wants to narrow every built-in
  tool available to Claude.
- Validation:
  Assert the sidecar start payload carries `allowedTools: ["Grep", "Glob"]`,
  and typecheck against the local `@anthropic-ai/claude-agent-sdk` definitions.

### Provider process loses final stdout or a sidecar fails during startup

- Symptom:
  A short-lived provider helper exits successfully but its final stdout frame is
  absent, or a long-lived SDK sidecar intermittently appears to exit before its
  startup response is consumed.
- Root cause:
  `os/exec.Cmd.StdoutPipe` and `StderrPipe` make pipe draining and `Cmd.Wait`
  ordering the caller's responsibility. Waiting for readers before `Cmd.Wait`
  makes process reaping depend on pipe EOF, while calling `Cmd.Wait` first can
  close a short-lived process's pipes before its last bytes are delivered.
- Fix:
  Give `Cmd.Stdout` and `Cmd.Stderr` frame writers instead of managing
  `StdoutPipe`/`StderrPipe` directly. `os/exec` then owns the copy goroutines and
  `Cmd.Wait` returns only after the final writes complete, without delaying
  startup-time streaming for a live sidecar.
- Validation:
  Run the local-process transport tests together with the Claude SDK sidecar
  start, approval, and controller tests repeatedly. Keep explicit assertions
  that final stdout arrives before the exit frame and that a live process can
  exchange frames before it exits.

### Concurrent agent CLI installs corrupt shared npm global state

- Symptom:
  Two agent-provider installs started close together can leave global npm bins
  or package directories half-written. Follow-up probes may report
  `cli_not_found`, `acp_adapter_not_found`, or a binary that exists but fails
  immediately after install.
- Quick checks:
  Confirm whether more than one `tuttid` agent-provider install action or
  desktop install button fired at roughly the same time for commands shaped
  like `npm install -g ...`.
  Inspect the daemon run-state lock path under
  `TUTTI_STATE_DIR/run/locks/npm-global-install.lock` while an install is in
  progress to verify later installs are waiting instead of running in parallel.
- Root cause:
  npm global installs mutate shared package and bin locations. Without a
  daemon-owned cross-process lock, concurrent `npm install -g` commands can
  race while writing the same global state and leave a corrupted runtime.
- Fix:
  Serialize agent-provider `npm install -g` commands behind the daemon install
  lock and keep the lock path under daemon-owned state. Start the install
  timeout only after the lock is acquired so queued installs do not consume
  their npm execution budget while waiting. Do not auto-delete the lock on a
  timer. Instead, recover the lock during daemon startup only when the recorded
  owner pid is no longer running. If recovery is still needed manually, clear
  `npm-global-install.lock` only after verifying no install is still running.
- Validation:
  Run `pnpm lint:go` plus `cd services/tuttid && go test ./... && go build ./...`.
  Then trigger two install actions in quick succession and confirm the second
  waits for the first instead of starting another global npm mutation.

### Agent provider install looks idle while a non-Codex installer is running

- Symptom:
  Provider setup appears stuck or idle even though `tuttid.log` has an
  `agent provider install step started` entry and no matching completed/failed
  line yet. This is most visible for Claude Code CLI or ACP adapter installs.
- Quick checks:
  Compare the install start timestamp with the log export timestamp before
  calling it hung. Also check for a later completed install log line and the
  provider binary path in the rechecked runtime log. If `tuttid.log` shows
  `active_action.output_appended` but desktop diagnostics keep reporting
  `logLines=0`, check whether the status request copied `activeAction` before
  installer output arrived, or whether the renderer stopped refreshing while
  the install action was still pending.
- Root cause:
  The provider installer is daemon-owned and can legitimately run for minutes,
  but renderer progress must come from the generic provider `activeAction`
  status field. Do not special-case long-running install progress to Codex.
- Fix:
  Set, stream stdout into, expose, and clear `ActiveAction` for every provider
  install action. Keep provider-specific installer details inside
  `services/tuttid/service/agentstatus` and project only the transport-safe
  active action shape through the API seam. Refresh the provider's active action
  snapshot at the end of `List`, and short-poll provider status while a daemon
  install action is pending so live installer output can reach the wizard.
- Validation:
  Run `cd services/tuttid && go test ./service/agentstatus ./api` and
  `pnpm check:api-generated`. Trigger a Claude Code install and confirm status
  responses include `activeAction` while the CLI or adapter step is in flight.

### Legacy Claude ACP adapter appears stale after external registry migration

- Symptom:
  With `TUTTI_CLAUDE_CODE_RUNTIME=acp`, Claude Agent provider status is not
  ready, or live ACP options do not match the package version advertised by the
  ACP External Agent Registry. Another form is Claude Code context usage briefly
  showing `0%` during a running session or around compaction, then returning to
  the prior nonzero value on the next usage update. A third form is new Claude
  Code sessions failing during startup with
  `Invalid value for config option fast: standard`.
- Quick checks:
  First confirm the runtime is legacy ACP. The default Claude Code runtime is
  SDK; SDK provider availability checks the `claude` CLI plus the Claude SDK
  sidecar entry and must not require `claude-acp`.
  Inspect `<state-dir>/agent-providers/external-agent-registry/cache/registry.json`
  and the package manifest under
  `<state-dir>/agent-providers/external-agent-registry/packages/claude-acp/node_modules/@agentclientprotocol/claude-agent-acp/package.json`.
  `which claude-agent-acp` only describes a user/global shim and is no longer
  the Tutti-owned Claude adapter source. For usage flicker, inspect that
  package's `dist/acp-agent.js` for `sessionUpdate: "usage_update"` near
  `compact_boundary`; it must not publish `used: 0` when the SDK
  `getContextUsage()` probe fails. For speed failures, inspect the live
  `fast` config option values advertised by the managed package; supported
  native Claude ACP packages that fall back to select options use `off` and
  `on`.
- Root cause:
  Tutti resolves Claude ACP from the external agent registry and installs the
  npm adapter into a daemon-owned prefix with managed npm. A stale or missing
  prefix package, stale registry cache, or unavailable managed Node runtime can
  make the adapter unavailable even when a global `claude-agent-acp` exists.
  Usage flicker can also come from the managed bridge bundle itself publishing
  an invalid zero context usage after a failed compact-boundary usage probe;
  AgentGUI only displays the normalized runtime context it receives. Speed
  failures come from treating Tutti's internal `standard` / `fast` speed tier
  values as ACP wire values; supported Claude ACP packages advertise native
  `fast` config values as `off` / `on`.
- Fix:
  Run the provider install action so tuttid refreshes the registry, resolves the
  managed Node runtime, and installs the npm package into the per-agent prefix.
  Do not compensate by changing static model catalogs for behavior that should
  come from the live ACP package. Keep the Tutti claude-agent-acp patch script
  authoritative for bridge behavior and apply it to the managed package; do not
  mask invalid usage in AgentGUI. Keep Tutti's internal speed tiers stable, but
  translate Claude ACP `fast` config values at the adapter boundary according
  to the live advertised options, and normalize the live value back before
  projecting runtime settings.
- Validation:
  Run `go test ./services/tuttid/service/agentstatus`, then confirm a stale
  global adapter is ignored and the install action uses managed npm with
  `--prefix <state-dir>/agent-providers/external-agent-registry/packages/claude-acp`.
  For usage flicker, run
  `node services/tuttid/service/agentstatus/assets/patch-claude-agent-acp.mjs --dist <managed-acp-dist>`
  twice and confirm the second run reports no changes, then inspect the bundle
  and confirm `lastAssistantTotalUsage = usedTokens ?? 0` is absent. For speed
  compatibility, run the Claude ACP adapter tests that cover native `off` /
  `on` advertised values and confirm legacy `standard` / `fast` advertised
  values are ignored.
- References:
  [service.go](../../../services/tuttid/service/agentstatus/service.go)
  [store.go](../../../services/tuttid/service/externalagentregistry/store.go)
  [patch-claude-agent-acp.mjs](../../../services/tuttid/service/agentstatus/assets/patch-claude-agent-acp.mjs)

### Cursor ACP context ring stays empty or usage looks wrong

- Symptom:
  A Cursor AgentGUI session shows an empty context ring, `0%`, or stale context
  usage while the session is actively running. Check & Settings may show the
  Cursor subscription tier from `cursor-agent about`, but account quota still
  reads as unsupported.
- Quick checks:
  Grep tuttid logs for `event=agent_session.acp.usage_update` while reproducing
  the session. Inspect `provider`, `parsed_ok`, `context_known`, `raw_used`,
  `raw_size`, `used_tokens`, `total_tokens`, and `quota_count` on each event.
  If no events appear, Cursor is not pushing ACP `usage_update` for that
  session. If events appear with `parsed_ok=false` or missing `raw_used` /
  `raw_size`, inspect the raw ACP payload shape before changing AgentGUI.
- Root cause:
  Tutti's standard ACP adapter already normalizes `usage_update` into runtime
  context, but Cursor may omit the event or publish a different payload than
  Codex/Claude bridges. Subscription tier display comes from auth probing, not
  from `usage_update`.
- Fix:
  Use the diagnostic log fields to decide whether to fix adapter parsing or wait
  for Cursor to publish usage updates. Do not mask missing usage in AgentGUI
  when the provider never sent `usage_update`.
- Validation:
  Run `go test ./packages/agent/daemon/runtime -run UsageUpdate` and start a
  Cursor session while tailing tuttid logs for
  `agent_session.acp.usage_update`.
- References:
  [standard_acp_adapter.go](../../../packages/agent/daemon/runtime/standard_acp_adapter.go)
  [acp_live_state.go](../../../packages/agent/daemon/runtime/acp_live_state.go)
  [service_helpers.go](../../../services/tuttid/service/agentstatus/service_helpers.go)

### Claude SDK model aliases resolve to configured Anthropic defaults

- Symptom:
  A Claude Code SDK session shows a Tutti composer model alias such as `sonnet`
  or `haiku`, but the model response or error mentions a different concrete
  model such as `mimo-v2.5-pro`.
- Quick checks:
  Inspect the effective Claude Code settings env from
  `$CLAUDE_CONFIG_DIR/settings.json` or `~/.claude/settings.json`, especially
  `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL`,
  `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `ANTHROPIC_DEFAULT_OPUS_MODEL`, and
  `ANTHROPIC_BASE_URL`. Also inspect the session `runtime_context_json` for
  `providerConfig.baseUrl` and `model` before assuming the UI selected the
  concrete provider model directly.
- Root cause:
  The SDK sidecar passes Tutti's Claude Code aliases to
  `@anthropic-ai/claude-agent-sdk`, while the SDK/Claude Code runtime still
  resolves those aliases through the user's Claude settings env. A proxy such as
  MiMo may map `sonnet` to a configured concrete model, and provider access
  errors then mention that concrete model instead of the Tutti alias.
- Fix:
  Keep the sidecar inheriting the user's Claude settings so credentials and base
  URL keep working. Fix provider access by changing the user's Claude settings or
  managed provider model config, not by hard-coding Tutti's static alias list.
  When an old SDK session predates image-input support, normalize its
  `runtimeContext.capabilities` before projecting it to AgentGUI so stale
  persisted state does not disable prompt-image paste.
- Validation:
  Confirm the session runtime context shows `adapter: claude-agent-sdk`, the
  expected `providerConfig.baseUrl`, and an `imageInput` capability. Then run the
  Claude SDK adapter tests plus the agent service tests covering runtime-context
  normalization.
- References:
  [claude_sdk_adapter.go](../../../packages/agent/daemon/runtime/claude_sdk_adapter.go)
  [service_helpers.go](../../../services/tuttid/service/agent/service_helpers.go)
  [composer_live_model_discovery.go](../../../services/tuttid/service/agent/composer_live_model_discovery.go)

### Claude SDK rejects live bypassPermissions mode

- Symptom:
  A Claude Code SDK session starts in `default`, `auto`, or plan mode, then live
  switching to `bypassPermissions` fails with
  `Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions`.
  Or the session state already shows `permissionModeId=bypassPermissions`, but
  ordinary tools such as Bash still surface AgentGUI approval prompts.
- Quick checks:
  Inspect the SDK query options emitted by `packages/agent/claude-sdk-sidecar`.
  `allowDangerouslySkipPermissions` must be enabled when the query is created,
  not only when the initial permission mode is already `bypassPermissions`.
  In root/sandboxed runtimes, confirm the sidecar process receives
  `IS_SANDBOX=1`. If the query launched correctly, inspect the sidecar
  `canUseTool` callback path; bypass mode should short-circuit ordinary tools
  after preserving special handling for `AskUserQuestion` and `ExitPlanMode`.
- Root cause:
  Claude SDK treats bypass permission support as a session launch capability.
  `query.setPermissionMode("bypassPermissions")` cannot enable that capability
  after the query has already started. Tutti's sidecar also owns the
  `canUseTool` callback; if that callback always requests AgentGUI approval,
  it can reintroduce prompts even after the SDK permission mode is bypass.
- Fix:
  Gate bypass availability with the same rule as Claude Agent ACP: non-root
  processes can bypass, and root processes can bypass only when `IS_SANDBOX` is
  set. Launch the SDK query with `allowDangerouslySkipPermissions` whenever
  that gate passes, regardless of the current permission mode. In `canUseTool`,
  handle `AskUserQuestion` and `ExitPlanMode` first, then directly allow
  ordinary tools when the effective permission mode is `bypassPermissions`.
- Validation:
  Add sidecar coverage for a `default` session whose query still receives
  `allowDangerouslySkipPermissions: true`, plus daemon runtime coverage that
  Claude SDK sidecar process env includes `IS_SANDBOX=1`. Add callback coverage
  proving bypass mode allows an ordinary Bash request without
  `approval_requested`, while `AskUserQuestion` still surfaces user input.

### Extension session create rejects a semantic permission id

- Symptom:
  An extension exposes a full-access option whose id is provider-specific, such
  as `bypassPermissions`, but session creation fails after a caller sends
  `full-access`. The Tutti CLI reports
  `reasonCode=unsupported_permission_mode_id` and lists the currently accepted
  ids.
- Quick checks:
  Query Composer Options for the exact Agent target. Compare
  `permissionConfig.modes[].id` with `permissionConfig.modes[].semantic` and
  inspect the submitted `permissionModeId`. Multiple ids may legitimately have
  the same semantic.
- Root cause:
  `semantic` is provider-neutral classification metadata. It is only a launch
  id for extensions whose signed Composer profile declares semantic launch
  permission mapping. Runtime-id extensions require the exact provider-owned
  id returned by Composer Options.
- Fix:
  Refresh Composer Options and round-trip the selected `id` verbatim. Do not
  hard-code a provider permission alias or collapse modes by semantic. Extension
  implementations keep the signed Composer profile as the launch contract;
  runtime config options may enrich current state and labels but cannot rewrite
  ids. Composer Options ignores a persisted default that is no longer in the
  signed profile and falls back to live runtime state, then the profile default;
  an explicit obsolete id still fails. Exact runtime ids also take precedence
  over semantic and historical aliases in the Standard ACP lookup.
- Validation:
  Confirm Composer Options preserves every declared runtime id in profile order,
  including multiple ids with the same semantic, and that the exact selected id
  reaches the runtime start input and final Standard ACP mapping. Test an exact
  runtime id that collides with another mode's semantic alias, plus an obsolete
  persisted default. An invalid explicitly supplied semantic alias must fail
  before hidden discovery or visible session creation.
- References:
  [extension_composer_options.go](../../../services/tuttid/service/agent/extension_composer_options.go)
  [composer_runtime_context.go](../../../services/tuttid/service/agent/composer_runtime_context.go)

### Claude Code logs out after sending a message (invalid_grant, credentials wiped)

- Symptom:
  Inside the desktop app, sending a message around the OAuth token expiry window
  leaves Claude Code in a "Not logged in · Please run /login" state. The keychain
  entry (`Claude Code-credentials`) has empty `accessToken`/`refreshToken` and
  `expiresAt: 0`, while the plaintext `~/.claude/.credentials.json` may still hold
  a valid token. The Claude CLI alone does not reproduce it.
- Quick checks:
  Capture `/v1/oauth/token` traffic (mitmproxy). A failure may show `Client
disconnected` immediately before later refresh attempts return `400
invalid_grant`. Search `tuttid.log` for
  `event=agent.model_discovery.hidden_session_triggered provider=claude-code`;
  this info-level event confirms that Tutti actually triggered a hidden Claude
  live-model discovery session. The event intentionally includes only the
  provider and random discovery-session id.
- Root cause:
  Composer-options loading spawned a hidden, `visible:false` Claude live-model
  discovery session that shares the on-disk credential store with the real
  conversation session and deleted it as soon as the model list was read. When
  it performs an OAuth refresh near expiry, the server can rotate the refresh
  token even if the local client disconnects before receiving or persisting the
  response. The real session later refreshes with the now-consumed refresh
  token, gets `400 invalid_grant`, and Claude Code wipes the stored credentials.
  Because `fallbackStorage` prefers the (now empty) keychain entry over the
  still-valid plaintext file, the user is locked out.
- Fix:
  Cold composer options must always have a static Claude fallback (`default`,
  `opus`, `sonnet`, `haiku`, plus any configured custom model) so the UI never
  depends on live discovery. A cold-start live discovery may run at most once per
  provider/workspace/cwd cache key, but it must be hidden, serialized with other
  Claude startups, and deleted only after a delayed grace period rather than
  immediately after the model list appears. Successful discovery updates the
  daemon live-model cache; later composer-options calls prefer cached models or
  model options reported by a real running Claude session over the static
  fallback. Claude Create model validation should only use cached live-model
  options; it must not start discovery. If the daemon exits before the delayed
  cleanup timer fires, later persisted-session reads must delete the stale
  hidden discovery session instead of restoring it as a real conversation.
- Validation:
  Add daemon service tests for Create cache-only validation, SendInput waiting
  on the Claude startup slot before runtime exec, static Claude cold-start model
  options, reusing model options from a running Claude session, cold-start
  discovery running once, delayed hidden discovery cleanup, and stale persisted
  hidden discovery cleanup after restart. Run targeted agent service Go tests
  plus the daemon Go lint/test/build lanes.
- References:
  [composer_live_model_discovery.go](../../../services/tuttid/service/agent/composer_live_model_discovery.go)
  [model_validation.go](../../../services/tuttid/service/agent/model_validation.go)

### Claude Code `Not logged in` renders as a file link instead of sign-in guidance

- Symptom:
  A Claude Code turn renders the plain text
  `Not logged in · Please run /login`. Clicking `/login` tries to open a local
  file and may show a missing-file toast instead of the Agent login flow.
- Quick checks:
  Inspect the durable assistant message and owning Turn. If both are
  `completed` even though the body is the standalone login notice, the Claude
  SDK returned an authentication failure as successful assistant output. The
  generic failed-message recovery path will not run for that shape.
- Root cause:
  The Claude SDK can pair its standalone login notice with a successful result.
  AgentGUI previously recovered plain authentication errors only when the
  message status was `failed`, so the completed notice fell through to Markdown
  rendering, where `/login` also matched the local absolute-path link rule.
- Fix:
  Preserve provider-agnostic recovery for failed messages. Additionally, for
  completed messages, recognize the short, whole-message standalone login
  notice and recover it as `auth_required`. Match the provider-owned output
  shape rather than branching on provider identity; keep the matcher
  length-bounded and anchored so ordinary answers that discuss login text are
  not reclassified.
- Validation:
  Cover the completed Claude notice rendering the authentication card and a
  normal completed answer that quotes the notice remaining ordinary content.
- References:
  [agentErrorPresentation.ts](../../../packages/agent/gui/shared/agentEnv/agentErrorPresentation.ts)
  [AgentMessageBlock.tsx](../../../packages/agent/gui/shared/agentConversation/components/AgentMessageBlock.tsx)

### Claude Code sessions fail with `effectiveSource: "none"` when CC-Switch or similar proxy tools are used

- Symptom:
  Tutti desktop sessions for the `claude-code` provider never connect. The UI
  reports `agent session is not connected` even though the same Claude CLI
  works fine when run from a terminal session that loaded CC-Switch (or a
  similar `~/.claude/settings.json` proxy).
- Quick checks:
  In `tuttid.log` search for `CLAUDE_CODE_AUTH_REFRESH_DEBUG`. If
  `credentials.effectiveSource` is `"none"` and both `keychain.found` and
  `plaintext.found` are `false`, but `~/.claude/settings.json` contains an
  `env` block with `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`, the
  sidecar never propagated the file's `env` to the Claude SDK.
- Root cause:
  CC-Switch writes proxy credentials into `~/.claude/settings.json`'s
  `env` field. The native Claude CLI picks them up because the user shell
  exports them into `process.env`, but the Tutti
  `claude-sdk-sidecar` is launched directly without going through a shell,
  so those variables are missing. The sidecar previously only merged
  `process.env` with the ACP payload `env` and never read the file.
- Fix:
  Read the Claude settings files in the sidecar and merge their `env`
  blocks into the Claude SDK query options, between `process.env` (lower
  priority) and the ACP payload `env` (higher priority). The merge covers
  `${CLAUDE_CONFIG_DIR}/settings.json` (defaulting to `~/.claude`) plus
  project-level `.claude/settings.json` / `.claude/settings.local.json`
  walking from the filesystem root to the session `cwd`, matching the
  native CLI's layering. See `claudeSettingsEnv` and `ensureQuery` in
  [claude-sdk-sidecar main.ts](../../../packages/agent/claude-sdk-sidecar/src/main.ts).
  The agentstatus probe reads the same `$CLAUDE_CONFIG_DIR`-aware location
  (`claudeSettingsDeclares` in
  [provider_custom_config.go](../../../services/tuttid/service/agentstatus/provider_custom_config.go))
  so the environment wizard and the runtime agree on whether credentials
  exist.
- Validation:
  Run `pnpm --filter @tutti-os/claude-sdk-sidecar test` and
  `cd services/tuttid && go test ./service/agentstatus/`. Unit tests cover
  reading, non-string value skipping, missing file, malformed JSON, missing
  `env` field, user/project/local layering, and `CLAUDE_CONFIG_DIR`
  resolution.
- Note:
  `credentials.effectiveSource` only tracks OAuth material (keychain or
  `.credentials.json`). For API-key/proxy users it stays `"none"` even
  after the fix; a connected session is the success signal, not that field.

### Cursor free plan shows a red error on the next send after upgrade copy

- Symptom:
  A Cursor free / exhausted account first returns plain assistant text
  `Upgrade your plan to continue`. Sending again shows a scary red turn-failed
  card (often with an “Open setup” escape hatch) instead of the same calm
  plan-gate copy.
- Root cause:
  `cursor-agent` soft-surfaces the first plan gate as an assistant chunk +
  `end_turn`. Later attempts may fail `session/prompt` with the same fixed
  copy (`upgrade` / `payment` actions). Tutti previously treated that ACP call
  failure as a generic `turn.failed` / `provider_error` danger card, and the
  visible-error classifier did not recognize the Cursor phrases as a quota /
  plan limit.
- Invariants:
  When ACP `session/prompt` fails with Cursor plan/payment gate copy, soft-settle
  the turn: emit a warning system notice with that copy and complete the turn
  (`planLimit=true`) so the composer stays usable without a danger card. Keep
  residual visible-error classification of those phrases in the
  `quota_or_rate_limit` bucket, and render that bucket with warning tone rather
  than danger. Do not route plan gates into the env-wizard “Open setup” path.
- Validation:
  Run `go test ./packages/agent/daemon/runtime -run 'PlanLimit|VisibleFailureCodeRecognizesCursorPlanLimit'`
  and the AgentGUI visible-error / `classifyFailedAgentMessage` specs that cover
  `Upgrade your plan to continue`.
- References:
  [acp_plan_limit.go](../../../packages/agent/daemon/runtime/acp_plan_limit.go)
  [standard_acp_turn.go](../../../packages/agent/daemon/runtime/standard_acp_turn.go)
  [visible_error.go](../../../packages/agent/daemon/runtime/visible_error.go)
  [AgentMessageBlock.tsx](../../../packages/agent/gui/shared/agentConversation/components/AgentMessageBlock.tsx)

### Tutti Agent retries a 402 and shows generic provider setup

- Symptom:
  A request with insufficient Tutti credits displays `Reconnecting... 5/5`,
  then falls back to a generic provider error card whose action opens local
  setup instead of account plans.
- Root cause:
  The billing boundary collapsed every commerce pre-deduct error into HTTP 402,
  the agent protocol treated every unexpected HTTP status as retryable, and the
  daemon classifier did not distinguish the resulting payment failure from a
  generic provider failure.
- Invariants:
  Preserve machine-readable billing codes across commerce, token usage, the LLM
  gateway, and the agent runtime. Commerce exposes depleted credits as
  `ResourceExhausted/CREDITS_INSUFFICIENT`; token usage translates only that
  decision to the OpenAI-compatible `429 usage_limit_reached` envelope with code
  `insufficient_credits`, which legacy Tutti Agent releases already treat as
  terminal. The gateway adds the Tutti plans promo header so the parsed terminal
  error retains actionable account context. Dependency failures remain 5xx.
  Classify actionable account failures before generic quota/provider buckets,
  and route account actions through the host link-action boundary rather than
  opening URLs directly from transcript UI.
- Validation:
  Cover the commerce RPC error mapping, token-usage envelope, gateway promo
  header, daemon visible-error classification, and rendered plans-page action as
  separate boundary tests.

### OpenCode effort changes fail with `effort not found`

- Symptom:
  An OpenCode session starts successfully, but changing reasoning effort fails
  through `session/set_config_option` with `Invalid params: effort not found`.
  Big-Pickle is a common example.
- Quick checks:
  Run `opencode models <provider> --verbose` and inspect the selected model's
  `variants` object. Compare those keys with the model-specific reasoning
  profile returned by the composer-options endpoint. Also inspect the live ACP
  `configOptions[id="effort"]`; a UI option that is absent from both sources
  must never be submitted.
- Root cause:
  OpenCode's top-level `capabilities.reasoning` says the model can reason, but
  it does not mean the model exposes selectable reasoning variants. Models use
  different variant sets, and some models return an empty `variants` object.
  A provider-wide static `low` / `medium` / `high` / `xhigh` list therefore
  creates controls that the current model cannot honor.
- Fix:
  Parse `opencode models --verbose`, preserve an explicitly empty variants
  profile, clear remembered effort values that are unsupported by the selected
  model, and refresh composer options after model changes. Before sending a
  live effort update, require the current ACP descriptor to advertise the exact
  value.
- Validation:
  Cover a model with empty variants, a model with ordered
  `low` / `medium` / `high` / `max` variants, remembered-setting sanitization,
  and runtime rejection before any ACP call for an unadvertised value.

### OpenCode model picker has fewer models than the terminal

- Symptom:
  `opencode models --verbose` lists more models in a local terminal than the
  OpenCode model picker in Agent GUI. Custom provider ids or recently published
  model variants are commonly absent.
- Quick checks:
  Run `opencode models --verbose` from the same workspace cwd passed to the
  composer. Count exact `provider/model` lines and compare them with the
  composer-options model config. Confirm daemon logs do not contain
  `composer model catalog lookup failed`. A `models.dev` cache hit only affects
  image-input metadata and cannot remove a model option.
- Root cause:
  OpenCode resolves project configuration relative to the command cwd. The
  daemon previously ran model discovery in its own inherited cwd and stored the
  resulting provider-wide list for six hours. A smaller result from the wrong
  project context therefore remained visible even after the terminal catalog
  changed.
- Fix:
  Pass the composer workspace cwd through the daemon model-catalog request and
  set it as the `opencode models --verbose` process directory. Do not cache
  OpenCode model-list successes or failures. Keep one request-scoped catalog
  projection so a composer-options request starts the CLI only once. Preserve
  the auth/config invalidation event so an already-open composer refreshes when
  global OpenCode credentials or config files change.
- Validation:
  Cover cwd propagation, repeated uncached OpenCode lookups, all provider/model
  prefixes from verbose output, one catalog lookup per composer-options request,
  and unchanged cache policies for Codex and Tutti Agent. Run
  `cd services/tuttid && go test ./service/agent` and `pnpm check:changed`.
- References:
  [opencode_model_catalog.go](../../../services/tuttid/service/agent/opencode_model_catalog.go)
  [model_catalog.go](../../../services/tuttid/service/agent/model_catalog.go)
  [composer_options.go](../../../services/tuttid/service/agent/composer_options.go)

### Agent slash palette only shows Browser

- Symptom:
  Typing `/` in a Claude Code, Codex, or OpenCode composer shows only the
  Browser capability. Provider commands such as `compact`, `status`, `goal`,
  `review`, or `plan` are missing.
- Quick checks:
  Call the provider composer-options endpoint and inspect
  `slashCommandPolicy`. If Codex or Claude returns a policy but the UI still
  shows only Browser, trace the new-session creation guard and the
  target-scoped composer-options cache. If one provider returns no policy,
  inspect its provider registry descriptor.
- Root cause:
  Composer-options loading can be intentionally skipped while a new session is
  being created. A mount-time creation ref that never follows current engine
  state leaves loading permanently disabled after creation settles. Browser
  still appears because it is independently projected from session
  capabilities. A provider descriptor missing its slash policy produces the
  same symptom for that provider even when loading succeeds.
- Fix:
  Keep the creation guard synchronized with current engine state and reload
  composer options on the creating-to-settled transition. Keep fallback
  commands and local effects in the provider registry descriptor; do not add
  provider-name branches in Agent GUI.
- Validation:
  Cover creation settling followed by a composer-options request, provider
  descriptor policy projection, and slash palette composition alongside the
  Browser capability. Run Agent GUI, provider registry, and agent service
  tests.
- References:
  [agent-activity-packages.md](../architecture/agent-activity-packages.md)
  [useAgentGUIComposerOptionsSync.ts](../../packages/agent/gui/agent-gui/agentGuiNode/controller/useAgentGUIComposerOptionsSync.ts)
  [opencode.go](../../packages/agent/daemon/providerregistry/opencode.go)

### Local capability slash command reaches the provider as unknown

- Symptom:
  A local capability command appears in the Agent slash palette and updates its
  composer setting, but submitting text such as `/computer click Confirm`
  produces a provider response such as `Unknown command: /computer`.
- Quick checks:
  Confirm the resolved slash catalog contains a capability entry rather than a
  provider command. Then trace both palette selection and form submission; the
  latter must resolve a local capability submit effect before the generic
  provider slash-command path.
- Root cause:
  The palette selection path enabled the capability and filled the canonical
  token, but the form submission path had no matching local interceptor. The
  raw slash invocation therefore crossed the runtime boundary and was parsed as
  a provider-native command.
- Fix:
  Route every local capability entry through the shared capability submission
  parser and handoff projection. Preserve the slash invocation as
  `displayPrompt`, then dispatch one semantic submit carrying the handoff prompt
  plus a `requiredSettingsPatch`. New-session activation merges the patch into
  initial settings; existing-session delivery retains it in the activity queue
  and applies it at the host command port before sending. Do not sequence a
  settings mutation and a submit in a React hook. Keep provider-native command
  behavior descriptor authoritative; do not add provider-name branches.
- Validation:
  Cover slash and alias forms, capability-disabled rejection, visible prompt
  normalization, handoff prompt construction, new-session setting activation,
  queued-prompt patch retention, and settings-before-prompt host ordering.
- References:
  [agent-gui-node.md](../../architecture/agent-gui-node.md)
  [agentCapabilityUseSubmit.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/model/agentCapabilityUseSubmit.ts)
  [agentSlashCommandProviderPolicy.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/model/agentSlashCommandProviderPolicy.ts)
  [promptQueue.reducer.ts](../../../packages/agent/activity-core/src/engine/promptQueue.reducer.ts)

### Standard ACP tools show generic cards and no-project file links do nothing

- Symptom:
  OpenCode or another standard ACP provider completes tool calls, but Agent GUI
  renders generic raw-payload cards instead of terminal, edit, read, search, or
  todo UI. In a session without a selected project, clicking an absolute HTML
  or source-file path in an assistant message has no effect.
- Quick checks:
  Inspect persisted tool payloads. If `toolName` contains a command, absolute
  path, or result sentence while `input.kind`, `input.title`, or `rawInput`
  identifies the actual operation, canonicalization happened too late. For file
  links, compare the selected project root with the durable session cwd.
- Root cause:
  Standard ACP terminal updates may replace the display title with dynamic
  output. Persisting that title as tool identity prevents shared specialized
  renderers from matching the call. Older events may also retain protocol
  envelopes under `rawInput`, `rawOutput`, and output metadata. Separately,
  requiring a selected project root discards valid link actions for no-project
  sessions even though their cwd is authoritative.
- Fix:
  Canonicalize standard ACP tools before persistence, retain the started call's
  identity through terminal updates, and promote protocol envelopes into the
  shared tool payload. Keep a provider-neutral historical projection for rows
  already stored in the old shape. Resolve conversation files against the
  selected project root or, when absent, the session cwd.
- Validation:
  Cover dynamic ACP start/terminal titles, historical payload projection,
  specialized renderer data, direct link resolution, and a transcript click
  from a no-project session. Run the Agent GUI tests and daemon runtime tests.
- References:
  [agent-gui-node.md](../architecture/agent-gui-node.md)
  [acp_tool_normalizer.go](../../packages/agent/daemon/runtime/acp_tool_normalizer.go)
  [workspaceLinkActions.ts](../../packages/agent/gui/actions/workspaceLinkActions.ts)

### Enabled Agent Extension is missing from AgentGUI

- Symptom:
  The extension feature gate is enabled and its release is reachable, but no
  extension target appears. The daemon log may only mention a missing local
  `active.json` fallback.
- Quick checks:
  Confirm the daemon process inherited the feature-gate environment variable,
  inspect `<state>/agent/extensions/<agentKey>`, and query `agent_targets` for
  `extension:<agentKey>`. Verify the public ZIP's signature, digest, size, entry
  modes, and package structure using the same daemon installation path.
- Root cause:
  A failed remote reconciliation can be obscured when the subsequent offline
  fallback error replaces the original error. ZIP directory entries commonly
  use mode `0755`; treating their search bits as executable file content rejects
  an otherwise valid data-only package before it can be registered. Runtime
  discovery can fail similarly when the daemon's strict JSON decoder does not
  model a signed profile field such as the standard `probe` declaration.
- Fix:
  Preserve both the remote reconciliation error and the offline fallback error.
  Reject symlinks for every entry, accept safe directory entries before checking
  executable bits, and reject executable bits only on non-directory files. Keep
  the daemon discovery DTO aligned with the release profile contract, including
  optional probe metadata, even while a later migration phase owns executing
  the ACP readiness probe.
- Validation:
  Cover a release ZIP with explicit `0755` directory entries and non-executable
  data files, retain a separate executable-file rejection test, and confirm a
  failed remote request remains visible when no offline installation exists.
  Then install the published artifact in an isolated state directory and verify
  both `active.json` and `extension:<agentKey>`.
- References:
  [manager.go](../../../services/tuttid/service/agentextension/manager.go)
  [manager_test.go](../../../services/tuttid/service/agentextension/manager_test.go)

### Extension composer controls stay on Loading and environment setup says unsupported

- Symptom:
  An extension Target is `ready` and its home composer is visible, but model or
  permission controls never leave `Loading`. Opening Environment Check says the
  agent has no managed environment setup.
- Quick checks:
  Call the target-scoped composer-options endpoint with both the extension
  provider and `agentTargetId`. A `400 malformed_request` while
  `/v1/agent-targets` reports the Target as ready points to provider identity
  normalization, not runtime discovery. Also confirm the config menu is not
  offering the desktop-managed environment wizard for an extension Target. If
  the endpoint returns `200` but has no models, inspect whether the ACP agent
  reports standard `models` state rather than legacy `configOptions`, and
  confirm its hidden no-project session has a daemon-managed discovery CWD.
- Root cause:
  After the Agent Target had authoritatively resolved an open provider identity
  such as `acp:gemini`, composer-options normalized it again through the closed
  built-in provider catalog. The identity became empty and the request failed,
  while the renderer kept its loading projection. Separately, the config menu
  exposed the built-in managed-environment action for every provider even
  though extension readiness belongs to the Agent Target lifecycle. A second
  failure path used an empty CWD for no-project discovery and only understood
  `configOptions`, while Gemini reports its catalog through ACP `models`.
- Fix:
  Preserve open provider identities only after successful Agent Target launch
  resolution. Keep direct provider-only requests on the closed built-in path.
  Show the desktop environment wizard only for providers owned by the built-in
  provider catalog; extension installation and readiness remain Target-owned.
  Give hidden extension probes a daemon-owned CWD and normalize standard ACP
  `models` into the same shared composer model descriptor.
- Validation:
  Cover target-scoped composer options for an extension provider, verify the
  real endpoint returns `200`, and confirm the extension config menu omits the
  desktop environment action while retaining general Agent settings. Verify
  the response contains the runtime-advertised model IDs without a
  provider-specific catalog in Tutti.
- References:
  [composer_options.go](../../../services/tuttid/service/agent/composer_options.go)
  [AgentGUINodeView.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/AgentGUINodeView.tsx)

### Extension login returns to the login button without an error

- Symptom:
  Target setup opens the browser and waits for authentication, then silently
  returns to `auth_required`. The runtime detection row may appear to restart
  during each progress poll, and a pending `Ready` row can look like an
  incorrect success state while login is still running.
- Quick checks:
  Inspect the setup snapshot's durable `action.status`, `errorCode`, and
  `errorMessage`, then correlate its timestamp with the ACP `authenticate`
  request in the daemon log. A successful browser callback does not prove that
  the runtime accepted the account; the ACP response remains authoritative.
- Root cause:
  Setup polling reused the foreground refresh state, so every background
  request set the whole panel to loading. Explicit ACP authentication failures
  were also normalized into a successful `auth_required` probe result, losing
  the provider error before the durable action was written. AgentGUI then
  rendered errors only for top-level setup failure, not a failed authenticate
  action. The terminal `Ready` row could never become successful because the
  setup dialog closes as soon as the authoritative snapshot becomes ready.
- Fix:
  Keep background polling non-disruptive, preserve errors from explicit ACP
  `authenticate` calls, and show failed/interrupted action details in both the
  existing host toast and the setup dialog while keeping retry available. Fire
  the toast only when the current action moves from running to failed so polling
  cannot repeat it and restoring an old failure cannot replay it. Do not render
  a terminal readiness row that only exists while setup is non-ready.
- Validation:
  Cover background polling without detection loading, an ACP authenticate
  rejection retaining provider text through the durable setup action, one toast
  per current-action failure, the persistent GUI failure presentation, and
  absence of the misleading pending readiness row.
  Run Agent daemon, setup service, AgentGUI, desktop watcher, i18n, typecheck,
  and desktop build checks.
- References:
  [standard_acp_setup.go](../../../packages/agent/daemon/runtime/standard_acp_setup.go)
  [setup.go](../../../services/tuttid/service/agentextension/setup.go)
  [AgentTargetSetupGate.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/view/AgentTargetSetupGate.tsx)
  [agentTargetSetupNotificationController.ts](../../../packages/agent/gui/shared/agentEnv/agentTargetSetupNotificationController.ts)

### Extension runtime installation stays failed after restart

- Symptom:
  An Agent Extension runtime install fails once. Reopening Tutti restores the
  same failure, and checking again never offers or starts another installation.
- Quick checks:
  Inspect the setup snapshot. If it contains a failed or interrupted install
  action plus a non-null install plan, the daemon has enough information to
  retry. Confirm the visible action starts `setup/install` with a new
  `clientActionId`; a setup GET only refreshes the persisted failure.
- Root cause:
  Failed setup actions are durable by design. The setup panel rendered its
  install button only for `not_installed`, while mapping failed/interrupted
  install actions to `failed`. Its generic check-again action only fetched the
  same durable snapshot, so restart could not change the state.
- Fix:
  Keep the failed action and provider error visible. When a failed or
  interrupted install snapshot retains a plan, offer an explicit reinstall
  action that submits the plan digest with a fresh client action ID. Do not
  erase the previous failure or treat a GET refresh as a retry.
- Validation:
  Mount the setup panel from an initial persisted failed-install snapshot,
  verify the error remains visible, and assert reinstall submits the retained
  plan with a client action ID different from the failed action.
- References:
  [setup.go](../../../services/tuttid/service/agentextension/setup.go)
  [AgentTargetSetupGate.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/view/AgentTargetSetupGate.tsx)
  [agentTargetSetupController.tsx](../../../packages/agent/gui/shared/agentEnv/agentTargetSetupController.tsx)

### Vertex setup reports ready but the first prompt cannot load credentials

- Symptom:
  Selecting Gemini `vertex-ai` completes Target setup and creates a session,
  but the first prompt fails with `Could not load the default credentials` or
  reports missing `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, or an API
  key. The empty-home setup gate is gone, leaving no obvious way to change the
  login method.
- Quick checks:
  Correlate the durable authenticate action with ACP traffic. If
  `authenticate` returns an empty result and `session/new` succeeds, but the
  later formal `session/prompt` returns the credential error, setup observed a
  runtime false positive rather than losing the selected method.
- Root cause:
  Gemini can defer Vertex ADC and project/location validation until a real
  prompt. ACP exposes no credential-validation request stronger than the
  runtime's own `authenticate` plus `session/new`, so setup cannot prove request
  usability without sending user-visible work. Extension Target setup was also
  mounted only in empty-home state, unlike the persistent built-in provider
  environment entry.
- Fix:
  Classify the formal prompt's credential error as an authentication failure
  and feed it into Target setup detection. Override a later otherwise-ready ACP
  probe to `auth_required`. Expose the same Target setup dialog from the
  selected provider's config menu in both ready and non-ready states, permit
  explicit re-authentication from ready, and reuse one Target watch across the
  two UI hosts.
- Validation:
  Cover the real Vertex ADC error text, auth invalidation overriding a ready
  probe, re-authentication clearing invalidation, ready-state auth method
  selection, and one cached desktop watch per Target. Do not add a hidden
  synthetic prompt to setup.
- References:
  [agent_run_outcome_reporter.go](../../../services/tuttid/agent_run_outcome_reporter.go)
  [setup.go](../../../services/tuttid/service/agentextension/setup.go)
  [AgentGUINodeView.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/AgentGUINodeView.tsx)
  [AgentTargetSetupGate.tsx](../../../packages/agent/gui/agent-gui/agentGuiNode/view/AgentTargetSetupGate.tsx)

### Extension messages appear sent but show no running or failure state

- Symptom:
  A new extension conversation displays the user message, but the composer
  immediately looks idle and no provider response or error card appears.
- Quick checks:
  Trace one Agent Session from `runtime.submitted` through the standard ACP
  `session/prompt` call. If the adapter logs a provider error and
  `runtime.events_emitted` reports empty event types, inspect provider identity
  normalization before debugging renderer polling or streaming.
- Root cause:
  The Agent Target and runtime accepted the extension-owned provider ID, but
  the shared activity event context still resolved providers through the
  closed built-in catalog. Turn-started, user-message, and turn-failed events
  for identities such as `acp:gemini` became empty events, so neither running
  state nor the real provider error reached durable conversation state.
- Fix:
  Centralize the canonical open-provider format in the provider registry and
  reuse it for both authorized service requests and activity event identities.
  Keep launch authorization separate: accepting an identity as event metadata
  does not authorize a runtime without a fixed Agent Target reference.
- Validation:
  Cover open extension identities in provider-registry and activity-event
  tests, then project `turn.started` and `turn.failed` for an extension session
  and assert both retain the extension provider ID.
- References:
  [registry.go](../../../packages/agent/daemon/providerregistry/registry.go)
  [activity_types.go](../../../packages/agent/daemon/activity/events/activity_types.go)
  [activity_projection.go](../../../packages/agent/daemon/runtime/activity_projection.go)

### Extension sessions show an open provider ID or disappear from mentions

- Symptom:
  An extension works in AgentGUI, but message-center cards or `@session` rows
  show a raw identity such as `acp:gemini` with the generic multi-Agent icon.
  The same extension may be absent from the `@agent` Agents tab.
- Quick checks:
  Read the extension Agent Target from `/v1/agent-targets` or the local target
  store and confirm it has the expected name and signed icon URL. Then compare
  the affected session's `agentTargetId`. If both are correct, inspect whether
  the renderer projection still calls the built-in provider catalog or
  provider icon resolver instead of the Agent Directory.
- Root cause:
  Runtime `provider` and product `agentTargetId` are different identities.
  Built-in providers happened to render correctly when older consumers used
  `provider` for both, but an open extension provider has no built-in catalog
  entry and therefore degrades to raw text/generic artwork or is filtered out.
- Fix:
  Resolve session and message-center presentation by exact `agentTargetId`
  against the shared Agent Directory. Build `@agent` candidates directly from
  ready, enabled Agent Targets; use the built-in provider catalog only for
  optional built-in visibility gates, never as extension authorization or
  display metadata.
- Validation:
  Cover an enabled `extension:*` Target with an `acp:*` provider and assert the
  Agents tab, Agent Session rows, and message-center cards all use the Target
  name and icon. Also retain coverage for historical provider-only sessions.
- References:
  [desktopRichTextAtAgentContributors.ts](../../../apps/desktop/src/renderer/src/features/rich-text-at/services/internal/desktopRichTextAtAgentContributors.ts)
  [workspaceAgentMessageCenterModel.ts](../../../packages/agent/gui/agent-message-center/workspaceAgentMessageCenterModel.ts)
  [agent-gui-node.md](../../architecture/agent-gui-node.md)

### Extension failure card appears while processing never stops

- Symptom:
  A standard ACP extension displays the provider error card, but the transcript
  still shows the processing indicator and the conversation remains busy.
- Quick checks:
  Compare the terminal `turn.failed` runtime log with the streamed session
  projection. If the runtime reports `failed / settled` while the renderer
  still has the same `activeTurnId` in `running`, inspect the lifecycle data on
  the terminal activity event rather than changing the processing-row UI.
- Root cause:
  The standard ACP adapter emitted explicit turn events without authoritative
  lifecycle snapshots. Built-in providers could still settle through their
  registered event projection policy, but an extension provider was not in
  that closed catalog. Its error message persisted while the prior running
  turn reference remained active.
- Fix:
  Stamp every standard ACP turn transition with a sequenced adapter-origin
  lifecycle snapshot. The reporter then copies the provider-independent
  snapshot, so a terminal failure atomically records the error outcome, marks
  the turn settled, clears `activeTurnId`, and re-enables submission.
- Validation:
  Cover a standard ACP start/failure pair and assert adapter-origin snapshots
  progress from `running` with an active turn ID to `settled / failed` with no
  active turn ID. Run the runtime and service regression suites.
- References:
  [standard_acp_turn.go](../../../packages/agent/daemon/runtime/standard_acp_turn.go)
  [turn_lifecycle_stamp.go](../../../packages/agent/daemon/runtime/turn_lifecycle_stamp.go)
  [reporter_state.go](../../../packages/agent/daemon/runtime/reporter_state.go)

### Extension slash palette is empty even though ACP advertised commands

- Symptom:
  Typing `/` in an extension conversation opens no command or Skill list, while
  the ACP process otherwise starts successfully.
- Quick checks:
  Inspect the persisted session `internal_runtime_context_json`. If `commands`
  contains provider command names, the ACP command update was received and the
  remaining fault is command hydration. Separately inspect the installed
  `profiles/composer.json`; Skills remain empty unless it declares validated
  roots and the matching capabilities profile advertises Skill support.
- Root cause:
  Runtime command updates were available only through a transient renderer
  event. A renderer that subscribed after the startup update, or reloaded an
  existing session, had no command catalog even though the daemon retained it.
  The slash palette also discarded every provider command when no built-in
  slash-command policy existed. That condition is normal for an open extension
  provider, so a valid ACP command catalog could still render as empty after
  hydration succeeded.
  Open extension providers also have no built-in composer profile, so the
  built-in provider Skill discovery table correctly returned no roots.
- Fix:
  Persist the detailed ACP command catalog in session runtime context and let
  composer options restore it when no live engine snapshot is present. Treat
  provider-advertised commands as runtime capabilities even without a built-in
  policy, and keep their selection provider-native. Declare extension Skill
  roots, invocation, and trigger prefix in the signed composer profile; resolve
  only safe relative workspace/user paths.
- Validation:
  Cover startup command projection, legacy command-name recovery, composer
  option parsing, declared extension Skill roots, and unsafe path rejection.
- References:
  [standard_acp_settings.go](../../../packages/agent/daemon/runtime/standard_acp_settings.go)
  [composer_commands.go](../../../services/tuttid/service/agent/composer_commands.go)
  [profiles.go](../../../services/tuttid/service/agentextension/profiles.go)
  [agentSlashCommandProviderPolicy.ts](../../../packages/agent/gui/agent-gui/agentGuiNode/model/agentSlashCommandProviderPolicy.ts)
