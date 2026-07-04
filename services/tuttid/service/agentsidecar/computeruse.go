package agentsidecar

import (
	"os"
	"strings"

	computerservice "github.com/tutti-os/tutti/services/tuttid/service/computer"
)

// Computer use is delivered to agents through the daemon-owned `tutti computer`
// CLI (a cua-driver MCP the daemon drives), not through per-provider MCP
// injection. The sidecar's only job here is to advertise, per session, whether
// computer use is enabled — the agent runtime surfaces the `computerUse`
// capability from this marker, and the computer-use skill is injected when set.
const (
	// computerUseSwitchEnv is the operator-facing master switch read from the
	// tuttid process environment. Computer use is on by default; set to a falsy
	// value ("0"/"false"/"off"/"no") to disable it for all sessions.
	computerUseSwitchEnv = "TUTTI_COMPUTER_USE"

	// computerUseEnabledSessionEnv is the per-session marker consumed by the
	// agent runtime (packages/agent/daemon/runtime/computer_capability.go).
	computerUseEnabledSessionEnv = "TUTTI_COMPUTER_USE_ENABLED"
)

// computerUseEnv returns the per-session env advertising computer use, or nil
// when it is disabled or unavailable.
func computerUseEnv(sessionEnabled bool) []string {
	if !sessionEnabled || !ComputerUseAvailable() {
		return nil
	}
	return []string{computerUseEnabledSessionEnv + "=1"}
}

// ComputerUseDefaultEnabled reports whether computer use is on. Defaults to true;
// only an explicit falsy value disables it. This is the operator master switch,
// not the runtime availability check.
func ComputerUseDefaultEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(computerUseSwitchEnv))) {
	case "0", "false", "off", "no":
		return false
	default:
		return true
	}
}

// ComputerUseAvailable reports whether computer use should be advertised to an
// agent session. It combines the operator switch with the local cua-driver
// reachability check so agents do not see a computer-use skill they cannot run.
func ComputerUseAvailable() bool {
	return ComputerUseDefaultEnabled() && computerservice.CheckReady() == nil
}
