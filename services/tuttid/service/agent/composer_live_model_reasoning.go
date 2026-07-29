package agent

import "strings"

func applyLiveModelReasoningOptions(
	options ComposerOptions,
	selectedModel string,
	models []ComposerConfigOptionValue,
) ComposerOptions {
	profiles := make(map[string]ComposerReasoningProfile)
	for _, model := range models {
		if !modelReasoningMetadataAdvertised(model) {
			continue
		}
		modelID := strings.TrimSpace(model.Value)
		if modelID == "" {
			continue
		}
		reasoningOptions := make([]ComposerConfigOptionValue, 0, len(model.ReasoningEfforts))
		if model.SupportsReasoningEffort == nil || *model.SupportsReasoningEffort {
			for _, effort := range model.ReasoningEfforts {
				value := strings.TrimSpace(effort.Value)
				if value == "" {
					continue
				}
				label := strings.TrimSpace(effort.Label)
				if label == "" {
					label = value
				}
				reasoningOptions = append(reasoningOptions, ComposerConfigOptionValue{
					ID:          value,
					Value:       value,
					Label:       label,
					Description: strings.TrimSpace(effort.Description),
				})
			}
		}
		defaultValue := supportedReasoningValue(
			strings.TrimSpace(model.ReasoningEffort),
			reasoningOptions,
		)
		if defaultValue == "" {
			for _, effort := range model.ReasoningEfforts {
				if effort.Default {
					defaultValue = supportedReasoningValue(effort.Value, reasoningOptions)
					break
				}
			}
		}
		if defaultValue == "" && len(reasoningOptions) > 0 {
			defaultValue = reasoningOptions[0].Value
		}
		profiles[modelID] = ComposerReasoningProfile{
			DefaultValue: defaultValue,
			Options:      reasoningOptions,
		}
	}
	if len(profiles) == 0 {
		return options
	}
	options.ReasoningOptionsByModel = profiles
	profile, ok := profiles[strings.TrimSpace(selectedModel)]
	if !ok {
		return options
	}
	current := supportedReasoningValue(options.EffectiveSettings.ReasoningEffort, profile.Options)
	if current == "" {
		current = profile.DefaultValue
	}
	options.EffectiveSettings.ReasoningEffort = current
	options.ReasoningConfig = ComposerConfigOption{
		Configurable: len(profile.Options) > 0,
		CurrentValue: current,
		DefaultValue: profile.DefaultValue,
		Options:      cloneComposerConfigOptionValues(profile.Options),
	}
	return options
}

func modelReasoningMetadataAdvertised(model ComposerConfigOptionValue) bool {
	return model.SupportsReasoningEffort != nil ||
		model.ReasoningEffortsAdvertised ||
		strings.TrimSpace(model.ReasoningEffort) != ""
}

func supportedReasoningValue(value string, options []ComposerConfigOptionValue) string {
	value = strings.TrimSpace(value)
	for _, option := range options {
		if strings.TrimSpace(option.Value) == value {
			return value
		}
	}
	return ""
}
