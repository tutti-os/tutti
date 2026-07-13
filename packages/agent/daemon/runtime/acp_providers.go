package agentruntime

// ACP provider family
//
// Every provider that speaks the Agent Client Protocol (JSON-RPC 2.0 over the
// child process's stdio) is a thin declarative config on top of the shared
// engine in standard_acp_adapter.go. One provider lives in one file:
//
//	acp_provider_cursor.go    cursor-agent acp
//	acp_provider_hermes.go    hermes acp
//	acp_provider_nexight.go   nexight-acp (codex-acp derived)
//	acp_provider_openclaw.go  openclaw acp -v
//
// Codex is a non-ACP adapter (codex_appserver_adapter.go talks to the codex
// binary's own app-server protocol), while Claude Code talks to its Agent SDK
// sidecar. Neither is a template for new ACP providers.
//
// All supported providers are registered through
// providerregistry.ProviderDescriptor. Provider-specific files in this package
// may implement a narrow runtime strategy, but they must not repeat identity,
// command, status, composer, target, or event registration values. New ACP
// providers start with a descriptor and use the shared standard ACP adapter;
// add a named strategy only when the protocol has behavior that the generic
// descriptor cannot express.
