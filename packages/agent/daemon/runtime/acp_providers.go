package agentruntime

// ACP provider family
//
// Every provider that speaks the Agent Client Protocol (JSON-RPC 2.0 over the
// child process's stdio) is a thin declarative config on top of the shared
// engine in standard_acp_adapter.go. One provider lives in one file:
//
//	acp_provider_claude.go    claude-agent-acp bridge (non-default runtime)
//	acp_provider_cursor.go    cursor-agent acp
//	acp_provider_hermes.go    hermes acp
//	acp_provider_nexight.go   nexight-acp (codex-acp derived)
//	acp_provider_openclaw.go  openclaw acp -v
//
// Codex is the only non-ACP adapter (codex_appserver_adapter.go talks to the
// codex binary's own app-server protocol) and is not a template for new
// providers.
//
// # Adding an ACP provider (e.g. OpenCode)
//
// Runtime (this package):
//
//  1. Add the Provider<Name> constant in types.go.
//  2. Create acp_provider_<name>.go with a New<Name>AdapterWithHostMetadata
//     constructor returning a *standardACPAdapter. The standardACPConfig
//     fields cover the common integration seams:
//     - command: argv to spawn (a bare binary name is resolved via
//     runtimecmd at spawn; use commandResolver for multi-name binaries).
//     - permissionModeID: maps Tutti permission-mode ids onto the agent's
//     session/set_mode ids. Return "" for modes the agent lacks (set_mode
//     is skipped) or always-"" when set_mode is not a permission channel.
//     - commandWithSettings / requiresNewSessionForSettings: spawn-time-only
//     settings (model flags etc.); live settings ride config options the
//     agent advertises after session/new.
//     - beforeNewSession: pre-session calls such as `authenticate`.
//     - env / initializeParams: provider env vars and initialize
//     capabilities beyond the conservative defaults.
//  3. Register the constructor in NewDefaultControllerWithOptions
//     (controller.go) and extend defaultPermissionModeIDForProvider and
//     permissionModeIDAllowedForProvider there.
//  4. Add the provider to activity/events NormalizeProvider — without it
//     every activity event for the provider is silently dropped.
//  5. Mirror the Hermes/Cursor tests in standard_acp_adapter_test.go
//     using the scripted transport (newStandardACPTransport) so the adapter
//     is exercised without a real binary.
//
// tuttid (services/tuttid):
//
//  6. biz/agentprovider/provider.go: constant, allProviders, Normalize.
//  7. service/agentstatus/registry.go: ProviderSpec (binary names, adapter
//     command, install/login, auth markers) plus an auth-status parser in
//     service_helpers.go when the CLI reports login state.
//  8. service/agent/composer_profiles.go: one composerProfile entry declares
//     model/reasoning/speed support, capabilities, and permission modes.
//  9. biz/agenttarget/model.go: a local:<provider> system target and the
//     provider in normalizeFirstIterationProvider — without these the GUI
//     tile exists but launching a session fails.
//  10. Model options: a lister in service/agent/model_catalog.go when the
//     profile sets UsesModelCatalog.
//  11. api/openapi/tuttid.v1.yaml: WorkspaceAgentProvider and
//     AgentTargetProvider enums plus the two ByProvider preference maps;
//     regenerate with `pnpm generate:api`. Event protocol:
//     packages/events/protocol/schemas/.../desktop-preferences.schema.json,
//     regenerate with `pnpm generate:event-protocol`.
//
// GUI (packages/agent/gui, apps/desktop): provider unions and Record maps
// are flushed out by `pnpm typecheck`; the string-keyed icon maps in
// gui/shared/managedAgentIcons.ts are NOT type-checked and fall back to the
// Tutti icon when an entry is missing. Locale strings live in the gui and
// desktop en/zh-CN locale files and services/tuttid/service/agent/locales.
//
// `pnpm check:changed` runs every affected lane.
