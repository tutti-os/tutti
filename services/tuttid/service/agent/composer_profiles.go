package agent

import (
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

// composerProfile is the service projection of the registry-owned provider
// composer descriptor. Option helpers consume this internal shape; provider
// registrations must be added to providerregistry, not to this package.
//
// The zero value is the safe default: no configurable settings, no
// capabilities, no permission modes. A provider absent from
// composerProfiles behaves like an unknown provider.
type composerProfile struct {
	// ModelSelection: the composer exposes a model selector and persists
	// model overrides for this provider. Without it, stale persisted model
	// values are cleared before they reach the runtime.
	ModelSelection bool
	// LiveModelDiscovery: model options come from the model config option a
	// live agent session advertises through its runtime; GetComposerOptions merges them
	// into the composer (reusing a running session's list when one exists).
	LiveModelDiscovery bool
	// LiveModelDiscoveryKind selects the provider-specific discovery protocol.
	// Consumers branch on this implementation kind, never on provider identity.
	LiveModelDiscoveryKind providerregistry.LiveModelDiscoveryKind
	// LiveModelProbeSession: with no running session to reuse, model
	// discovery may spawn a short-lived hidden provider session. Opt-in
	// because the probe is a real provider session.
	LiveModelProbeSession bool
	// LiveModelAccountScoped: the advertised catalog is credential-scoped,
	// not workspace/cwd-scoped. Hidden discovery and caching share one scope
	// per agent target when enabled.
	LiveModelAccountScoped bool
	// UsesModelCatalog: model options come from the daemon-side
	// AgentModelCatalog (CLI/schema-backed lists).
	UsesModelCatalog bool
	// ModelCatalog identifies the descriptor-backed catalog implementation.
	ModelCatalog providerregistry.ModelCatalogKind
	// CapabilityCatalogKind selects the dynamic capability discovery protocol.
	// CapabilityCatalogCommand is cloned from the provider runtime command so
	// the executable remains a single descriptor-owned fact.
	CapabilityCatalogKind    providerregistry.CapabilityCatalogKind
	CapabilityCatalogCommand []string
	SlashCommandPolicy       providerregistry.SlashCommandPolicyDescriptor
	// ReasoningEffort: the composer exposes a reasoning-effort selector.
	ReasoningEffort bool
	// ReasoningEffortOptions selects the descriptor-owned source of the list.
	ReasoningEffortOptions providerregistry.ReasoningEffortOptionsKind
	// DefaultReasoningEffort seeds the selector when nothing is persisted.
	DefaultReasoningEffort string
	// ReasoningEffortValues is the closed, ordered value list exposed by the
	// composer for migrated providers.
	ReasoningEffortValues []string
	// Speed: the provider exposes the orthogonal speed tier (standard/fast).
	Speed bool
	// SpeedValues and DefaultSpeed are registry-owned so all Host consumers
	// project the same ordered options and initial selection.
	SpeedValues  []string
	DefaultSpeed string
	// Capabilities is the conservative static capability list used to render
	// the composer before a session exists. Once a session is live the
	// adapter-reported typed session capabilities take precedence. Keys mirror
	// packages/agent/daemon/runtime/capabilities.go.
	Capabilities []string
	// PermissionConfigurable: the permission-mode selector is interactive.
	PermissionConfigurable bool
	// DefaultPermissionModeID seeds the permission selector; it must be one
	// of PermissionModes (or empty when the provider has none).
	DefaultPermissionModeID string
	// PermissionModes lists the provider's permission modes in display order.
	PermissionModes []PermissionModeOption
	// Config option ids are provider protocol vocabulary supplied by the
	// descriptor instead of inferred from provider identity.
	ModelConfigOptionID      string
	ReasoningConfigOptionID  string
	SpeedConfigOptionID      string
	PermissionConfigOptionID string
	// SkillKind selects the provider-local discovery implementation while
	// SkillInvocation controls how discovered skills are invoked in the GUI.
	SkillKind               string
	SkillInvocation         string
	SkillConfigDirSuffix    string
	Behavior                providerregistry.ComposerBehaviorDescriptor
	ModelCapabilityRuleKind providerregistry.ModelCapabilityRuleKind
}

func defaultComposerProfiles() map[string]composerProfile {
	profiles := make(map[string]composerProfile, len(providerregistry.Migrated()))
	for _, descriptor := range providerregistry.Migrated() {
		profiles[descriptor.Identity.ID] = composerProfileFromDescriptor(descriptor)
	}
	return profiles
}

var composerProfiles = defaultComposerProfiles()

func composerProfileFromDescriptor(provider providerregistry.ProviderDescriptor) composerProfile {
	descriptor := provider.ComposerProfile
	permissionModes := make([]PermissionModeOption, 0, len(descriptor.PermissionModes))
	for _, mode := range descriptor.PermissionModes {
		permissionModes = append(permissionModes, PermissionModeOption{
			ID:       strings.TrimSpace(mode.ID),
			Semantic: PermissionModeSemantic(strings.TrimSpace(mode.Semantic)),
		})
	}
	return composerProfile{
		ModelSelection:           descriptor.ModelSelection,
		LiveModelDiscovery:       descriptor.LiveModelDiscovery.Kind != "",
		LiveModelDiscoveryKind:   descriptor.LiveModelDiscovery.Kind,
		LiveModelProbeSession:    descriptor.LiveModelDiscovery.HiddenProbe,
		LiveModelAccountScoped:   descriptor.LiveModelDiscovery.AccountScoped,
		UsesModelCatalog:         strings.TrimSpace(string(descriptor.ModelCatalog)) != "",
		ModelCatalog:             descriptor.ModelCatalog,
		CapabilityCatalogKind:    descriptor.CapabilityCatalog.Kind,
		CapabilityCatalogCommand: append([]string(nil), provider.Runtime.Command...),
		SlashCommandPolicy: providerregistry.SlashCommandPolicyDescriptor{
			FallbackCommands:            append([]string(nil), descriptor.SlashCommandPolicy.FallbackCommands...),
			CommandEffects:              append([]providerregistry.SlashCommandEffectDescriptor(nil), descriptor.SlashCommandPolicy.CommandEffects...),
			CommandCatalogAuthoritative: descriptor.SlashCommandPolicy.CommandCatalogAuthoritative,
		},
		ReasoningEffort:          descriptor.ReasoningEffort,
		ReasoningEffortOptions:   descriptor.ReasoningEffortOptions,
		ReasoningEffortValues:    append([]string(nil), descriptor.ReasoningEffortValues...),
		DefaultReasoningEffort:   strings.TrimSpace(descriptor.DefaultReasoningEffort),
		Speed:                    descriptor.Speed,
		SpeedValues:              append([]string(nil), descriptor.SpeedValues...),
		DefaultSpeed:             strings.TrimSpace(descriptor.DefaultSpeed),
		Capabilities:             append([]string(nil), descriptor.Capabilities...),
		PermissionConfigurable:   descriptor.PermissionConfigurable,
		DefaultPermissionModeID:  strings.TrimSpace(descriptor.DefaultPermissionModeID),
		PermissionModes:          permissionModes,
		ModelConfigOptionID:      strings.TrimSpace(descriptor.ConfigOptionIDs.Model),
		ReasoningConfigOptionID:  strings.TrimSpace(descriptor.ConfigOptionIDs.Reasoning),
		SpeedConfigOptionID:      strings.TrimSpace(descriptor.ConfigOptionIDs.Speed),
		PermissionConfigOptionID: strings.TrimSpace(descriptor.ConfigOptionIDs.Permission),
		SkillKind:                strings.TrimSpace(string(descriptor.Skills.Kind)),
		SkillInvocation:          strings.TrimSpace(string(descriptor.Skills.Invocation)),
		SkillConfigDirSuffix:     strings.TrimSpace(descriptor.Skills.ConfigDirSuffix),
		Behavior:                 descriptor.Behavior,
		ModelCapabilityRuleKind:  descriptor.ModelCapabilityRuleKind,
	}
}

func isClaudeSDKLiveModelProvider(provider string) bool {
	return composerProfileFor(provider).LiveModelDiscoveryKind == providerregistry.LiveModelDiscoveryKindClaudeSDK
}

// composerProfileFor resolves the provider's composer profile. Unknown
// providers get the zero profile (nothing configurable, no capabilities).
func composerProfileFor(provider string) composerProfile {
	profile, ok := composerProfiles[agentprovider.Normalize(provider)]
	if !ok {
		return composerProfile{}
	}
	return profile
}

// composerProfileKnown reports whether the provider has a composer profile;
// unknown providers render no capability list at all (nil, not empty).
func composerProfileKnown(provider string) bool {
	_, ok := composerProfiles[agentprovider.Normalize(provider)]
	return ok
}

func composerProfileHasCapability(provider string, capability string) bool {
	for _, candidate := range composerProfileFor(provider).Capabilities {
		if candidate == capability {
			return true
		}
	}
	return false
}
