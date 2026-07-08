package agentruntime

import "strings"

// Canonical provider capability keys shared by all adapters and surfaced to
// the GUI through runtimeContext.capabilities. Keep in sync with the
// TypeScript side (packages/agent/activity-core/src/capabilities.ts).
const (
	CapabilityImageInput  = "imageInput"
	CapabilitySkills      = "skills"
	CapabilityCompact     = "compact"
	CapabilityTokenUsage  = "tokenUsage"
	CapabilityRateLimits  = "rateLimits"
	CapabilityPlanMode    = "planMode"
	CapabilityInterrupt   = "interrupt"
	CapabilityBrowserUse  = "browserUse"
	CapabilityComputerUse = "computerUse"
	// CapabilityGoalPause marks providers whose goal is a controllable
	// entity with a real paused state (codex thread goals). Providers
	// without it (Claude Code: /goal command in, goal_status attachments
	// out, no pause) render the goal banner without pause/resume controls.
	CapabilityGoalPause = "goalPause"
)

// standardACPCapabilities derives the canonical capability list for ACP
// family providers. claude-code has a known full surface; other providers
// are derived conservatively from the live session state.
func standardACPCapabilities(provider string, promptImage bool, state acpLiveStateSnapshot) []string {
	if provider == ProviderClaudeCode {
		capabilities := []string{
			CapabilitySkills,
			CapabilityCompact,
			CapabilityTokenUsage,
			CapabilityRateLimits,
			CapabilityPlanMode,
			CapabilityInterrupt,
			"review",
		}
		if promptImage {
			capabilities = append([]string{CapabilityImageInput}, capabilities...)
		}
		return capabilities
	}
	if provider == ProviderOpenCode {
		capabilities := []string{CapabilityPlanMode, CapabilityInterrupt}
		if promptImage {
			capabilities = append([]string{CapabilityImageInput}, capabilities...)
		}
		return capabilities
	}
	capabilities := []string{CapabilityInterrupt}
	if promptImage {
		capabilities = append(capabilities, CapabilityImageInput)
	}
	// Cursor exposes plan mode through ACP session/set_mode ("plan"); advertise
	// it so the composer plan badge survives the authoritative session snapshots
	// emitted during/after a turn (otherwise supportsPlanMode flips to false and
	// the badge vanishes once the reply settles).
	if provider == ProviderCursor {
		capabilities = append(capabilities, CapabilityPlanMode)
	}
	for _, command := range state.availableCommands {
		if strings.EqualFold(strings.TrimSpace(command.Name), "compact") {
			capabilities = append(capabilities, CapabilityCompact)
			break
		}
	}
	return capabilities
}
