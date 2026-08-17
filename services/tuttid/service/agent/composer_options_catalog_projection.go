package agent

import "strings"

func composerOptionsProviderUsesModelCatalog(provider string) bool {
	return composerProfileFor(provider).UsesModelCatalog
}

func composerModelConfig(provider string, selected string, options []ComposerConfigOptionValue) ComposerConfigOption {
	if composerProfileFor(provider).Behavior.ModelOptionsAuthoritative {
		return ComposerConfigOption{}
	}
	values := make([]ComposerConfigOptionValue, 0, len(options))
	for _, option := range options {
		value := strings.TrimSpace(option.Value)
		if value == "" {
			continue
		}
		label := strings.TrimSpace(option.Label)
		if label == "" {
			label = value
		}
		values = append(values, ComposerConfigOptionValue{
			ID:                 value,
			Label:              label,
			Value:              value,
			Description:        strings.TrimSpace(option.Description),
			SupportsImageInput: option.SupportsImageInput,
			Requested:          option.Requested,
		})
	}
	selected = strings.TrimSpace(selected)
	return ComposerConfigOption{
		Configurable: composerProfileFor(provider).ModelSelection,
		CurrentValue: selected,
		DefaultValue: selected,
		Options:      values,
	}
}

func composerSelectedModelOptions(model string) []ComposerConfigOptionValue {
	model = strings.TrimSpace(model)
	if model == "" {
		return []ComposerConfigOptionValue{}
	}
	// Bootstrap echo: the sole entry mirrors the requested/effective settings,
	// so it carries the requested provenance marker.
	return []ComposerConfigOptionValue{{ID: model, Label: model, Value: model, Requested: true}}
}

func reasoningConfigOptionID(provider string) string {
	return strings.TrimSpace(composerProfileFor(provider).ReasoningConfigOptionID)
}

// speedProviderSupportsSpeed reports whether the provider exposes the speed
// dimension. Speed combines orthogonally with model and reasoning effort.
//
//   - Codex: the codex app-server honours `service_tier` (fast → priority).
//   - Claude Code: the SDK sidecar maps the `standard` / `fast` tiers onto
//     `Settings.fastMode`.
func speedProviderSupportsSpeed(provider string) bool {
	return composerProfileFor(provider).Speed
}

// speedConfigOptionID is the live config-option id the adapter sets. Codex maps
// the tier onto the app-server `service_tier` config; Claude Code sets a `fast`
// ACP config option when the agent advertises it.
func speedConfigOptionID(provider string) string {
	return strings.TrimSpace(composerProfileFor(provider).SpeedConfigOptionID)
}

func speedTierValuesForProvider(provider string) []string {
	return append([]string(nil), composerProfileFor(provider).SpeedValues...)
}

func normalizeSpeedForProvider(provider string, value string) string {
	if !speedProviderSupportsSpeed(provider) {
		return ""
	}
	normalized := strings.TrimSpace(value)
	for _, candidate := range speedTierValuesForProvider(provider) {
		if candidate == normalized {
			return normalized
		}
	}
	return strings.TrimSpace(composerProfileFor(provider).DefaultSpeed)
}

func composerSpeedOptionValues(provider string, locale string) []ComposerConfigOptionValue {
	values := speedTierValuesForProvider(provider)
	options := make([]ComposerConfigOptionValue, 0, len(values))
	for _, value := range values {
		label, description := speedDisplay(value, locale)
		options = append(options, ComposerConfigOptionValue{
			ID:          value,
			Label:       label,
			Value:       value,
			Description: description,
		})
	}
	return options
}

func composerSpeedConfigFromOptions(provider string, selected string, options []ComposerConfigOptionValue) ComposerConfigOption {
	selected = strings.TrimSpace(selected)
	return ComposerConfigOption{
		Configurable: speedProviderSupportsSpeed(provider) && len(options) > 0,
		CurrentValue: selected,
		DefaultValue: selected,
		Options:      cloneComposerConfigOptionValues(options),
	}
}

func composerAdvertisedSpeedOptionValues(locale string, advertised []AgentModelSpeedOption) []ComposerConfigOptionValue {
	options := make([]ComposerConfigOptionValue, 0, len(advertised))
	for _, advertisedOption := range advertised {
		value := strings.TrimSpace(advertisedOption.Value)
		if value == "" {
			continue
		}
		label, description := speedDisplay(value, locale)
		if advertisedLabel := strings.TrimSpace(advertisedOption.Label); advertisedLabel != "" {
			label = advertisedLabel
		}
		if advertisedDescription := strings.TrimSpace(advertisedOption.Description); advertisedDescription != "" {
			description = advertisedDescription
		}
		options = append(options, ComposerConfigOptionValue{
			ID: value, Label: label, Value: value, Description: description,
		})
	}
	return options
}

func resolveAdvertisedSpeed(selected string, advertisedDefault string, advertised []AgentModelSpeedOption) string {
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
