package modelcatalog

import (
	"encoding/json"
	"fmt"
	"strings"
)

// ParseRuntimeConfigOptionModels reads the canonical model select descriptor
// published by provider runtimes. The returned advertised bit distinguishes a
// missing descriptor from an explicitly advertised empty model catalog.
func ParseRuntimeConfigOptionModels(value any, modelOptionID string) ([]ModelOption, bool, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, false, fmt.Errorf("marshal runtime config options: %w", err)
	}
	var descriptors []struct {
		ID      string            `json:"id"`
		Options []json.RawMessage `json:"options"`
	}
	if err := json.Unmarshal(raw, &descriptors); err != nil {
		return nil, false, fmt.Errorf("parse runtime config options: %w", err)
	}
	modelOptionID = strings.TrimSpace(modelOptionID)
	if modelOptionID == "" {
		modelOptionID = "model"
	}
	for _, descriptor := range descriptors {
		if strings.TrimSpace(descriptor.ID) != modelOptionID {
			continue
		}
		models := make([]ModelOption, 0, len(descriptor.Options))
		for _, rawOption := range descriptor.Options {
			if model, ok := NormalizeRuntimeConfigOptionModel(rawOption); ok {
				models = append(models, model)
			}
		}
		return models, true, nil
	}
	return nil, false, nil
}

// NormalizeRuntimeConfigOptionModel converts one provider-neutral model option
// descriptor into the same canonical catalog type used by CLI model/list
// discovery. Field presence remains authoritative for empty capability sets.
func NormalizeRuntimeConfigOptionModel(raw json.RawMessage) (ModelOption, bool) {
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		return ModelOption{}, false
	}
	id := firstNonBlank(stringMapValue(object, "value"), stringMapValue(object, "model"), stringMapValue(object, "id"))
	if id == "" {
		return ModelOption{}, false
	}
	displayName := firstNonBlank(
		stringMapValue(object, "label"),
		stringMapValue(object, "name"),
		stringMapValue(object, "displayName"),
		stringMapValue(object, "display_name"),
		id,
	)
	reasoningValue, reasoningAdvertised := advertisedValue(object, "reasoningEfforts", "supportedReasoningEfforts", "supported_reasoning_efforts")
	supportsReasoning, supportsReasoningAdvertised := object["supportsReasoningEffort"].(bool)
	reasoningOptions := normalizeCodexReasoningEfforts(reasoningValue)
	if supportsReasoningAdvertised && !supportsReasoning {
		reasoningOptions = []ReasoningEffortOption{}
	}
	defaultReasoning := firstNonBlank(
		stringMapValue(object, "reasoningEffort"),
		stringMapValue(object, "defaultReasoningEffort"),
		stringMapValue(object, "default_reasoning_effort"),
	)
	reasoningAdvertised = reasoningAdvertised || supportsReasoningAdvertised || defaultReasoning != ""

	speedValue, speedsAdvertised := advertisedValue(object, "speeds", "serviceTiers", "service_tiers")
	speeds := normalizeRuntimeSpeedOptions(speedValue)
	defaultSpeed := firstNonBlank(stringMapValue(object, "speed"), stringMapValue(object, "defaultSpeed"), stringMapValue(object, "defaultServiceTier"))

	return ModelOption{
		ID:                         id,
		DisplayName:                displayName,
		Description:                stringMapValue(object, "description"),
		DefaultReasoningEffort:     validReasoningDefault(reasoningOptions, defaultReasoning),
		DefaultSpeed:               validSpeedDefault(speeds, canonicalCodexSpeed(defaultSpeed)),
		IsDefault:                  id == "default" || boolMapValue(object, "default") || boolMapValue(object, "isDefault") || boolMapValue(object, "is_default"),
		ReasoningEffortsAdvertised: reasoningAdvertised,
		SupportedReasoningEfforts:  reasoningOptions,
		SpeedsAdvertised:           speedsAdvertised,
		SupportedSpeeds:            speeds,
		SupportsImageInput:         runtimeConfigImageInputSupport(object),
	}, true
}

// ProjectRuntimeConfigOptionModel publishes one canonical catalog model using
// the provider-neutral descriptor vocabulary consumed by every Agent host.
func ProjectRuntimeConfigOptionModel(model ModelOption) map[string]any {
	option := map[string]any{
		"value":       strings.TrimSpace(model.ID),
		"name":        firstNonBlank(model.DisplayName, model.ID),
		"description": strings.TrimSpace(model.Description),
		"default":     model.IsDefault,
	}
	if model.SupportsImageInput != nil {
		option["supportsImageInput"] = *model.SupportsImageInput
	}
	if model.ReasoningEffortsAdvertised {
		reasoningOptions := make([]map[string]any, 0, len(model.SupportedReasoningEfforts))
		for _, reasoning := range model.SupportedReasoningEfforts {
			value := strings.TrimSpace(reasoning.Value)
			if value == "" {
				continue
			}
			reasoningOptions = append(reasoningOptions, map[string]any{
				"value":       value,
				"name":        firstNonBlank(reasoning.Label, value),
				"description": strings.TrimSpace(reasoning.Description),
				"default":     reasoning.Default || value == strings.TrimSpace(model.DefaultReasoningEffort),
			})
		}
		option["supportsReasoningEffort"] = len(reasoningOptions) > 0
		option["reasoningEffort"] = validReasoningDefault(model.SupportedReasoningEfforts, model.DefaultReasoningEffort)
		option["reasoningEfforts"] = reasoningOptions
	}
	if model.SpeedsAdvertised {
		speedOptions := make([]map[string]any, 0, len(model.SupportedSpeeds))
		for _, speed := range model.SupportedSpeeds {
			value := strings.TrimSpace(speed.Value)
			if value == "" {
				continue
			}
			speedOptions = append(speedOptions, map[string]any{
				"value":       value,
				"name":        firstNonBlank(speed.Label, value),
				"description": strings.TrimSpace(speed.Description),
			})
		}
		option["speed"] = validSpeedDefault(model.SupportedSpeeds, model.DefaultSpeed)
		option["speeds"] = speedOptions
	}
	return option
}

func normalizeRuntimeSpeedOptions(value any) []SpeedOption {
	rawOptions, ok := value.([]any)
	if !ok {
		return nil
	}
	options := make([]SpeedOption, 0, len(rawOptions))
	seen := make(map[string]struct{}, len(rawOptions))
	for _, rawOption := range rawOptions {
		var option SpeedOption
		switch typed := rawOption.(type) {
		case string:
			option.Value = canonicalCodexSpeed(typed)
		case map[string]any:
			option.Value = canonicalCodexSpeed(firstNonBlank(stringMapValue(typed, "value"), stringMapValue(typed, "id")))
			option.Label = firstNonBlank(stringMapValue(typed, "label"), stringMapValue(typed, "name"))
			option.Description = stringMapValue(typed, "description")
		}
		if option.Value == "" {
			continue
		}
		if _, exists := seen[option.Value]; exists {
			continue
		}
		seen[option.Value] = struct{}{}
		options = append(options, option)
	}
	return options
}

func runtimeConfigImageInputSupport(object map[string]any) *bool {
	if supported, advertised := object["supportsImageInput"].(bool); advertised {
		return &supported
	}
	return codexImageInputSupport(object)
}
