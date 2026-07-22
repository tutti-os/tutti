package canonical

import "strings"

const (
	CodexProviderID      = "codex"
	ClaudeCodeProviderID = "claude-code"
	CursorProviderID     = "cursor"
	TuttiAgentProviderID = "tutti-agent"
	OpenCodeProviderID   = "opencode"
	NexightProviderID    = "nexight"
	HermesProviderID     = "hermes"
	OpenClawProviderID   = "openclaw"
)

// ProviderIdentity is the provider-neutral identity projection shared by the
// canonical store and runtime registries. Runtime commands and installation
// details deliberately remain outside this contract.
type ProviderIdentity struct {
	ID          string
	DisplayName string
	IconKey     string
	LocaleKey   string
	Aliases     []string
}

type PlanDecisionStrategy string

const (
	PlanDecisionStrategyNone            PlanDecisionStrategy = ""
	PlanDecisionStrategyImplementPrompt PlanDecisionStrategy = "implement_prompt"
)

type providerContract struct {
	identity             ProviderIdentity
	planDecisionStrategy PlanDecisionStrategy
}

var providerContracts = []providerContract{
	{identity: ProviderIdentity{ID: CodexProviderID, DisplayName: "Codex", IconKey: "codex", LocaleKey: "agentHost.agentGui.conversationFilterCodex"}, planDecisionStrategy: PlanDecisionStrategyImplementPrompt},
	{identity: ProviderIdentity{ID: ClaudeCodeProviderID, DisplayName: "Claude Code", IconKey: "claude-code", LocaleKey: "agentHost.agentGui.conversationFilterClaudeCode", Aliases: []string{"claude", "claude code"}}},
	{identity: ProviderIdentity{ID: CursorProviderID, DisplayName: "Cursor", IconKey: "cursor", LocaleKey: "agentHost.agentGui.conversationFilterCursor", Aliases: []string{"cursor-agent", "cursor agent", "cursor-cli"}}},
	{identity: ProviderIdentity{ID: TuttiAgentProviderID, DisplayName: "Tutti Agent", IconKey: "tutti", LocaleKey: "agentHost.agentGui.conversationFilterTutti", Aliases: []string{"tutti agent"}}},
	{identity: ProviderIdentity{ID: OpenCodeProviderID, DisplayName: "OpenCode", IconKey: "opencode", LocaleKey: "agentHost.agentGui.conversationFilterOpenCode", Aliases: []string{"open-code", "open code", "opencode-ai", "opencode_ai"}}},
	{identity: ProviderIdentity{ID: NexightProviderID, DisplayName: "Nexight", IconKey: "tutti", LocaleKey: "agentHost.agentGui.conversationFilterNexight", Aliases: []string{"tutti"}}},
	{identity: ProviderIdentity{ID: HermesProviderID, DisplayName: "Hermes Agent", IconKey: "hermes", LocaleKey: "agentHost.agentGui.conversationFilterHermes", Aliases: []string{"hermes-agent", "hermes agent"}}},
	{identity: ProviderIdentity{ID: OpenClawProviderID, DisplayName: "OpenClaw", IconKey: "openclaw", LocaleKey: "agentHost.agentGui.conversationFilterOpenClaw", Aliases: []string{"open-claw"}}},
}

// FindProviderIdentity resolves canonical IDs and aliases without importing
// the runtime registry. The returned identity owns its alias slice.
func FindProviderIdentity(value string) (ProviderIdentity, bool) {
	value = normalizeProviderIdentity(value)
	for _, contract := range providerContracts {
		identity := contract.identity
		if value == normalizeProviderIdentity(identity.ID) {
			return cloneProviderIdentity(identity), true
		}
		for _, alias := range identity.Aliases {
			if value == normalizeProviderIdentity(alias) {
				return cloneProviderIdentity(identity), true
			}
		}
	}
	return ProviderIdentity{}, false
}

func ProviderPlanDecisionStrategy(value string) (PlanDecisionStrategy, bool) {
	identity, found := FindProviderIdentity(value)
	if !found {
		return PlanDecisionStrategyNone, false
	}
	for _, contract := range providerContracts {
		if contract.identity.ID == identity.ID {
			return contract.planDecisionStrategy, true
		}
	}
	return PlanDecisionStrategyNone, false
}

func cloneProviderIdentity(identity ProviderIdentity) ProviderIdentity {
	identity.Aliases = append([]string(nil), identity.Aliases...)
	return identity
}

func normalizeProviderIdentity(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

// Canonical capability vocabulary shared by provider descriptors, canonical
// persistence, runtime projections, and generated clients.
const (
	CapabilityImageInput                     = "imageInput"
	CapabilityModelImageInputRequired        = "modelImageInputRequired"
	CapabilityModelSwitch                    = "modelSwitch"
	CapabilityModelPlanBinding               = "modelPlanBinding"
	CapabilitySkills                         = "skills"
	CapabilityCompact                        = "compact"
	CapabilityTokenUsage                     = "tokenUsage"
	CapabilityRateLimits                     = "rateLimits"
	CapabilityPlanMode                       = "planMode"
	CapabilityInterrupt                      = "interrupt"
	CapabilityActiveTurnGuidance             = "activeTurnGuidance"
	CapabilityBrowserUse                     = "browserUse"
	CapabilityComputerUse                    = "computerUse"
	CapabilityGoalPause                      = "goalPause"
	CapabilityPlanImplementation             = "planImplementation"
	CapabilityPermissionModeChangeDuringTurn = "permissionModeChangeDuringTurn"
	CapabilityPermissionModeChangeDeferred   = "permissionModeChangeDeferred"
	CapabilityReview                         = "review"
	CapabilityResumeRunningTurn              = "resumeRunningTurn"
)

var knownCapabilities = [...]string{
	CapabilityImageInput,
	CapabilityModelImageInputRequired,
	CapabilityModelSwitch,
	CapabilityModelPlanBinding,
	CapabilitySkills,
	CapabilityCompact,
	CapabilityTokenUsage,
	CapabilityRateLimits,
	CapabilityPlanMode,
	CapabilityInterrupt,
	CapabilityActiveTurnGuidance,
	CapabilityBrowserUse,
	CapabilityComputerUse,
	CapabilityGoalPause,
	CapabilityPlanImplementation,
	CapabilityPermissionModeChangeDuringTurn,
	CapabilityPermissionModeChangeDeferred,
	CapabilityReview,
	CapabilityResumeRunningTurn,
}

func KnownCapabilities() []string {
	return append([]string(nil), knownCapabilities[:]...)
}

func IsKnownCapability(value string) bool {
	value = strings.TrimSpace(value)
	for _, capability := range knownCapabilities {
		if value == capability {
			return true
		}
	}
	return false
}
