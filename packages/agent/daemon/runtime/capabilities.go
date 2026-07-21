package agentruntime

import (
	"slices"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
)

// Canonical provider capability keys shared by all adapters and surfaced to
// the GUI through runtimeContext.capabilities. Keep in sync with the
// TypeScript side (packages/agent/activity-core/src/capabilities.ts).
const (
	CapabilityImageInput                     = providerregistry.CapabilityImageInput
	CapabilityModelImageInputRequired        = providerregistry.CapabilityModelImageInputRequired
	CapabilitySkills                         = providerregistry.CapabilitySkills
	CapabilityCompact                        = providerregistry.CapabilityCompact
	CapabilityTokenUsage                     = providerregistry.CapabilityTokenUsage
	CapabilityRateLimits                     = providerregistry.CapabilityRateLimits
	CapabilityPlanMode                       = providerregistry.CapabilityPlanMode
	CapabilityInterrupt                      = providerregistry.CapabilityInterrupt
	CapabilityActiveTurnGuidance             = providerregistry.CapabilityActiveTurnGuidance
	CapabilityBrowserUse                     = providerregistry.CapabilityBrowserUse
	CapabilityComputerUse                    = providerregistry.CapabilityComputerUse
	CapabilityPlanImplementation             = providerregistry.CapabilityPlanImplementation
	CapabilityPermissionModeChangeDuringTurn = providerregistry.CapabilityPermissionModeChangeDuringTurn
	CapabilityPermissionModeChangeDeferred   = providerregistry.CapabilityPermissionModeChangeDeferred
	CapabilityReview                         = providerregistry.CapabilityReview
	CapabilityModelSwitch                    = providerregistry.CapabilityModelSwitch
	CapabilityModelPlanBinding               = providerregistry.CapabilityModelPlanBinding
	// CapabilityGoalPause marks providers whose goal is a controllable
	// entity with a real paused state (codex thread goals). Providers
	// without it (Claude Code: /goal command in, goal_status attachments
	// out, no pause) render the goal banner without pause/resume controls.
	CapabilityGoalPause = providerregistry.CapabilityGoalPause
)

// standardACPCapabilities derives the canonical capability list for ACP
// family providers from the live session state.
func standardACPCapabilities(provider string, promptImage bool, state acpLiveStateSnapshot) []string {
	return standardACPCapabilitiesWithDeclared(provider, promptImage, state, nil, false)
}

func standardACPCapabilitiesWithDeclared(
	provider string,
	promptImage bool,
	state acpLiveStateSnapshot,
	declared []string,
	declaredPlanWorkflow bool,
) []string {
	descriptor, ok := providerregistry.Find(provider)
	if !ok {
		return effectiveOpenStandardACPCapabilities(promptImage, state, declared, declaredPlanWorkflow)
	}
	profile := descriptor.ComposerProfile
	capabilities := make([]string, 0, len(profile.Capabilities)+2)
	for _, capability := range profile.Capabilities {
		if capability == CapabilityImageInput && !promptImage {
			continue
		}
		capabilities = append(capabilities, capability)
	}
	standardACP := descriptor.Runtime.StandardACP
	if promptImage && standardACP.DeriveImageInputFromPrompt && !slices.Contains(capabilities, CapabilityImageInput) {
		capabilities = append(capabilities, CapabilityImageInput)
	}
	for _, capability := range standardACP.DeriveCapabilitiesFromCommands {
		if slices.Contains(capabilities, capability) {
			continue
		}
		for _, command := range state.availableCommands {
			if strings.EqualFold(strings.TrimSpace(command.Name), capability) {
				capabilities = append(capabilities, capability)
				break
			}
		}
	}
	return dedupeCapabilities(capabilities)
}

func effectiveOpenStandardACPCapabilities(
	promptImage bool,
	state acpLiveStateSnapshot,
	declared []string,
	declaredPlanWorkflow bool,
) []string {
	if len(declared) == 0 {
		return nil
	}
	runtimeFacts := map[string]bool{
		CapabilityImageInput: promptImage,
		CapabilityInterrupt:  true,
		CapabilityTokenUsage: state.usage.contextKnown,
		CapabilityRateLimits: len(state.usage.quotas) > 0,
		CapabilityPlanMode:   declaredPlanWorkflow,
	}
	for _, command := range state.availableCommands {
		switch normalizeCapabilityEvidenceID(command.Name) {
		case "compact":
			runtimeFacts[CapabilityCompact] = true
		case "plan":
			runtimeFacts[CapabilityPlanMode] = true
		case "review":
			runtimeFacts[CapabilityReview] = true
		}
	}
	for _, descriptor := range state.configOptionDescriptors {
		if strings.TrimSpace(asString(descriptor["id"])) != "mode" {
			continue
		}
		if len(configOptionEntries(descriptor["options"])) > 0 {
			runtimeFacts[CapabilityPermissionModeChangeDuringTurn] = true
		}
		for _, option := range configOptionEntries(descriptor["options"]) {
			if normalizeCapabilityEvidenceID(asString(option["value"])) == "plan" {
				runtimeFacts[CapabilityPlanMode] = true
			}
		}
	}
	result := make([]string, 0, len(declared))
	for _, capability := range dedupeCapabilities(declared) {
		if runtimeFacts[capability] {
			result = append(result, capability)
		}
	}
	return result
}

func normalizeCapabilityEvidenceID(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.TrimPrefix(value, "/")
	value = strings.ReplaceAll(value, "_", "")
	value = strings.ReplaceAll(value, "-", "")
	return value
}

func filterDeclaredCapabilities(values []string, declared []string) []string {
	if len(values) == 0 || len(declared) == 0 {
		return nil
	}
	allowed := make(map[string]struct{}, len(declared))
	for _, capability := range declared {
		if providerregistry.IsKnownCapability(capability) {
			allowed[capability] = struct{}{}
		}
	}
	result := make([]string, 0, len(values))
	for _, capability := range dedupeCapabilities(values) {
		if _, ok := allowed[capability]; ok {
			result = append(result, capability)
		}
	}
	return result
}

func dedupeCapabilities(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	result := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		capability := strings.TrimSpace(value)
		if capability == "" {
			continue
		}
		if _, ok := seen[capability]; ok {
			continue
		}
		seen[capability] = struct{}{}
		result = append(result, capability)
	}
	return result
}

func migratedProviderHasCapability(provider string, capability string) bool {
	profile, ok := migratedProviderComposerProfile(provider)
	if !ok {
		return false
	}
	for _, candidate := range profile.Capabilities {
		if candidate == capability {
			return true
		}
	}
	return false
}
