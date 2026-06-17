package agentsidecar

import (
	"os"
	"strings"
)

// Browser use is delivered to agents through the daemon-owned `tutti browser`
// CLI (a chrome-devtools-mcp the daemon drives), not through per-provider MCP
// injection. The sidecar's only job here is to advertise, per session, whether
// browser use is enabled — the agent runtime surfaces the `browserUse`
// capability from this marker, and the browser-use skill is injected when set.
const (
	// browserUseSwitchEnv is the operator-facing master switch read from the
	// tuttid process environment. Browser use is on by default; set to a falsy
	// value ("0"/"false"/"off"/"no") to disable it for all sessions.
	browserUseSwitchEnv = "TUTTI_BROWSER_USE"

	// browserUseEnabledSessionEnv is the per-session marker consumed by the
	// agent runtime (packages/agent/daemon/runtime/browser_capability.go).
	browserUseEnabledSessionEnv = "TUTTI_BROWSER_USE_ENABLED"
)

// browserUseEnv returns the per-session env advertising browser use, or nil when
// it is disabled (by the per-session toggle or the operator master switch).
func browserUseEnv(sessionEnabled bool) []string {
	if !sessionEnabled || !BrowserUseDefaultEnabled() {
		return nil
	}
	return []string{browserUseEnabledSessionEnv + "=1"}
}

// BrowserUseDefaultEnabled reports whether browser use is on. Defaults to true;
// only an explicit falsy value disables it. Used by the composer (to advertise
// the capability) and by CLI/skill gating.
func BrowserUseDefaultEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(browserUseSwitchEnv))) {
	case "0", "false", "off", "no":
		return false
	default:
		return true
	}
}
