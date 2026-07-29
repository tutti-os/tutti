package agent

import (
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/modelcatalog"
	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	"github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
)

func composerModelReasoningOptionsByModel(
	provider string,
	locale string,
	profiles map[string]modelcatalog.ReasoningProfile,
) map[string]ComposerReasoningProfile {
	result := make(map[string]ComposerReasoningProfile, len(profiles))
	for model, profile := range profiles {
		model = strings.TrimSpace(model)
		if model == "" {
			continue
		}
		defaultValue := profile.DefaultValue
		options := composerAdvertisedReasoningOptionValues(
			provider,
			"",
			locale,
			profile.Options,
		)
		result[model] = ComposerReasoningProfile{
			DefaultValue: defaultValue,
			Options:      options,
		}
	}
	return result
}

func composerReasoningConfig(provider string, selected string, locale string) ComposerConfigOption {
	return composerReasoningConfigFromOptions(
		provider,
		selected,
		composerReasoningOptionValues(provider, selected, locale),
	)
}

func composerReasoningConfigFromOptions(
	provider string,
	selected string,
	options []ComposerConfigOptionValue,
) ComposerConfigOption {
	selected = strings.TrimSpace(selected)
	profile := composerProfileFor(provider)
	configurable := profile.ReasoningEffort
	if profile.ReasoningEffortOptions == providerregistry.ReasoningEffortOptionsStrictModelCatalog {
		configurable = len(options) > 0
	}
	return ComposerConfigOption{
		Configurable: configurable,
		CurrentValue: selected,
		DefaultValue: selected,
		Options:      cloneComposerConfigOptionValues(options),
	}
}

func reasoningEffortValuesForProvider(provider string) []string {
	if !composerProfileKnown(provider) {
		return nil
	}
	profile := composerProfileFor(provider)
	if profile.ReasoningEffortOptions != providerregistry.ReasoningEffortOptionsStatic {
		return nil
	}
	return append([]string(nil), profile.ReasoningEffortValues...)
}

// composerProviderUsesModelReasoningCatalog identifies providers whose model
// catalog is authoritative for reasoning values, including strict catalogs
// that intentionally expose no provider-level fallback options.
func composerProviderUsesModelReasoningCatalog(provider string) bool {
	kind := composerProfileFor(provider).ReasoningEffortOptions
	return kind == providerregistry.ReasoningEffortOptionsModelCatalog ||
		kind == providerregistry.ReasoningEffortOptionsStrictModelCatalog
}

func composerReasoningOptionValues(provider string, selected string, locale string) []ComposerConfigOptionValue {
	values := reasoningEffortValuesForProvider(provider)
	advertised := make([]AgentModelReasoningEffortOption, 0, len(values))
	for _, value := range values {
		advertised = append(advertised, AgentModelReasoningEffortOption{Value: value})
	}
	return composerAdvertisedReasoningOptionValues(provider, selected, locale, advertised)
}

func composerAdvertisedReasoningOptionValues(
	_ string,
	selected string,
	locale string,
	advertised []AgentModelReasoningEffortOption,
) []ComposerConfigOptionValue {
	selected = strings.TrimSpace(selected)
	options := make([]ComposerConfigOptionValue, 0, len(advertised)+1)
	containsSelected := false
	for _, advertisedOption := range advertised {
		value := strings.TrimSpace(advertisedOption.Value)
		if value == "" {
			continue
		}
		if value == selected {
			containsSelected = true
		}
		label, description := reasoningEffortDisplay(
			value,
			locale,
			advertisedOption.Description,
		)
		if advertisedLabel := strings.TrimSpace(advertisedOption.Label); advertisedLabel != "" {
			label = advertisedLabel
		}
		options = append(options, ComposerConfigOptionValue{
			Description: description,
			ID:          value,
			Label:       label,
			Value:       value,
		})
	}
	if selected != "" && !containsSelected {
		options = append(options, ComposerConfigOptionValue{
			ID:    selected,
			Label: reasoningEffortLabel(selected, locale),
			Value: selected,
		})
	}
	return options
}

func resolveAdvertisedReasoningEffort(
	_ string,
	selected string,
	advertisedDefault string,
	advertised []AgentModelReasoningEffortOption,
) string {
	selected = strings.TrimSpace(selected)
	advertisedDefault = strings.TrimSpace(advertisedDefault)
	firstValue := ""
	defaultSupported := false
	for _, option := range advertised {
		value := strings.TrimSpace(option.Value)
		if value == "" {
			continue
		}
		if firstValue == "" {
			firstValue = value
		}
		if value == selected {
			return selected
		}
		if value == advertisedDefault {
			defaultSupported = true
		}
	}
	if defaultSupported {
		return advertisedDefault
	}
	return firstValue
}

func composerConfigOptionValuesToRuntimeOptions(
	options []ComposerConfigOptionValue,
) []map[string]string {
	result := make([]map[string]string, 0, len(options))
	for _, option := range options {
		value := strings.TrimSpace(option.Value)
		if value == "" {
			continue
		}
		runtimeOption := map[string]string{
			"name":  strings.TrimSpace(option.Label),
			"value": value,
		}
		if description := strings.TrimSpace(option.Description); description != "" {
			runtimeOption["description"] = description
		}
		result = append(result, runtimeOption)
	}
	return result
}

func normalizeReasoningEffortForProvider(provider string, value string) string {
	provider = agentprovider.Normalize(provider)
	profile := composerProfileFor(provider)
	if !profile.ReasoningEffort {
		return ""
	}
	normalized := strings.TrimSpace(value)
	// Model-catalog values are model-specific and authoritative. A generic
	// provider-level normalizer must not rewrite values such as "minimal" or
	// "none" that the selected model explicitly advertises.
	if profile.ReasoningEffortOptions == providerregistry.ReasoningEffortOptionsModelCatalog ||
		profile.ReasoningEffortOptions == providerregistry.ReasoningEffortOptionsStrictModelCatalog {
		return normalized
	}
	if (normalized == "minimal" || normalized == "none") &&
		!reasoningEffortValueDeclared(profile, normalized) {
		return profile.DefaultReasoningEffort
	}
	return normalized
}

func reasoningEffortValueDeclared(profile composerProfile, value string) bool {
	for _, candidate := range profile.ReasoningEffortValues {
		if strings.TrimSpace(candidate) == value {
			return true
		}
	}
	return false
}
