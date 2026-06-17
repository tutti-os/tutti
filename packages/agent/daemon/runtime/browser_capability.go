package agentruntime

import "strings"

// browserUseEnabledEnv is the per-session marker the sidecar sets when browser
// use is enabled for a session. The adapters surface the `browserUse`
// capability based on it so the composer toggle reflects the live session.
// Browser use itself is delivered out-of-band via the `tutti browser` CLI
// (a daemon-owned chrome-devtools-mcp), not through provider MCP injection.
const browserUseEnabledEnv = "TUTTI_BROWSER_USE_ENABLED"

func appendBrowserUseCapability(capabilities []string, env []string) []string {
	if sessionEnvBool(env, browserUseEnabledEnv) {
		return append(capabilities, CapabilityBrowserUse)
	}
	return capabilities
}

// sessionEnvBool reports whether the given env key is set to a truthy value.
func sessionEnvBool(env []string, key string) bool {
	switch strings.ToLower(strings.TrimSpace(sessionEnvValue(env, key))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}
