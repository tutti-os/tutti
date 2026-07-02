package agentstatus

import (
	"context"
	"os"
	"strings"
)

const (
	// claudeACPExternalRegistryID is the ACP external agent registry id for the
	// Claude Code bridge (see DefaultRegistry()).
	claudeACPExternalRegistryID = "claude-acp"

	// claudeACPPackageName and claudeACPPinnedVersion identify the
	// @agentclientprotocol/claude-agent-acp bridge that the desktop app vendors
	// and ships with the package. Keep claudeACPPinnedVersion in sync with
	// CLAUDE_ACP_VERSION in apps/desktop/scripts/vendor-claude-acp.mjs and
	// PINNED_VERSION in tools/scripts/verify-claude-acp-patch.sh.
	claudeACPPackageName   = "@agentclientprotocol/claude-agent-acp"
	claudeACPPinnedVersion = "0.53.0"

	// claudeACPEntryPathEnv is set by the packaged desktop app to the vendored,
	// pre-patched bridge run entry (the package's `claude-agent-acp` bin, i.e.
	// dist/index.js) so the daemon can run Claude Code offline without a runtime
	// npm install. Mirrors TUTTI_BROWSER_MCP_ENTRY_PATH.
	claudeACPEntryPathEnv = "TUTTI_CLAUDE_ACP_ENTRY_PATH"

	// claudeCodeExecutableEnv is the Claude Agent SDK's override for the Claude
	// Code CLI path. The vendored bridge has the SDK's bundled ~200MB native CLI
	// pruned (see vendor-claude-acp.mjs), so the daemon points it at Tutti's
	// system-managed `claude` binary via this env var. The bridge's
	// claudeCliPath() honors it before falling back to the (now absent) native
	// package.
	claudeCodeExecutableEnv = "CLAUDE_CODE_EXECUTABLE"
)

// bundledClaudeACPEntryPath returns the vendored claude-agent-acp run entry when
// the packaged desktop app has staged it and the file exists. An empty string
// means "not bundled" and callers fall back to the external registry / npm
// install path.
func (s Service) bundledClaudeACPEntryPath() string {
	entry := strings.TrimSpace(s.getenv(claudeACPEntryPathEnv))
	if entry == "" {
		return ""
	}
	if !s.fileExists(entry) {
		return ""
	}
	return entry
}

// resolveBundledClaudeACPSpec wires the provider spec to run the vendored,
// pre-patched bridge directly with the managed Node runtime.
//
// Once the bridge is shipped it is authoritative: this never returns a spec that
// can fall back to the remote registry / npm install. It always clears
// AdapterInstall (so the installer loop, seeing ExternalRegistryID set, treats
// the adapter as not-installable and never runs npm) and always pins
// AdapterPackage to the bundled version. If the managed Node runtime is not yet
// available (e.g. node-static still materializing at startup), it leaves the run
// command empty and marks the adapter transiently unavailable — the next resolve
// fills it in. This avoids a race where an in-flight runtime made the short
// circuit fall through to the registry, ran an npm install, and then mismatched
// the registry's required version against the bundled one ("provider adapter is
// still unavailable after install").
func (s Service) resolveBundledClaudeACPSpec(
	ctx context.Context,
	spec ProviderSpec,
	entry string,
	requireManagedRuntime bool,
) ProviderSpec {
	spec.AdapterInstall = InstallerSpec{}
	spec.AdapterPackage = AdapterPackageRequirement{
		Name:    claudeACPPackageName,
		Version: claudeACPPinnedVersion,
	}
	appRuntime, ok := s.resolveManagedRuntimeForProvider(ctx, requireManagedRuntime)
	if !ok {
		spec.AdapterCommand = nil
		spec.AdapterEnv = nil
		spec.AdapterUnavailableReasonCode = ReasonManagedRuntimeUnavailable
		return spec
	}
	env := cloneStrings(appRuntime.EnvOverrides)
	// The vendored bridge has the SDK's bundled Claude Code CLI pruned (see
	// vendor-claude-acp.mjs), so point it at the system-managed claude binary.
	// The bridge's claudeCliPath() honors CLAUDE_CODE_EXECUTABLE before falling
	// back to the (now absent) bundled native package.
	if claudePath := resolveBinaryWithResolver(s.commandResolver(), spec.BinaryNames, nil); strings.TrimSpace(claudePath) != "" {
		env = append(env, claudeCodeExecutableEnv+"="+claudePath)
	}
	spec.AdapterCommand = []string{appRuntime.Node, entry}
	spec.AdapterEnv = env
	spec.AdapterUnavailableReasonCode = ""
	return spec
}

// getenv reads a single environment variable, honoring an injected Environ for
// testability and falling back to the process environment otherwise.
func (s Service) getenv(key string) string {
	if s.Environ == nil {
		return os.Getenv(key)
	}
	prefix := key + "="
	for _, kv := range s.Environ() {
		if strings.HasPrefix(kv, prefix) {
			return kv[len(prefix):]
		}
	}
	return ""
}
