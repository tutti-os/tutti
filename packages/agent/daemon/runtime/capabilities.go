package agentruntime

import "strings"

// Canonical provider capability keys shared by all adapters and surfaced to
// the GUI through runtimeContext.capabilities. Keep in sync with the
// TypeScript side (packages/agent/activity-core/src/capabilities.ts).
const (
	CapabilityImageInput = "imageInput"
	CapabilitySkills     = "skills"
	CapabilityCompact    = "compact"
	CapabilityTokenUsage = "tokenUsage"
	CapabilityRateLimits = "rateLimits"
	CapabilityPlanMode   = "planMode"
	CapabilityInterrupt  = "interrupt"
	CapabilityBrowserUse = "browserUse"
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
	capabilities := []string{CapabilityInterrupt}
	if promptImage {
		capabilities = append(capabilities, CapabilityImageInput)
	}
	for _, command := range state.availableCommands {
		if strings.EqualFold(strings.TrimSpace(command.Name), "compact") {
			capabilities = append(capabilities, CapabilityCompact)
			break
		}
	}
	return capabilities
}
