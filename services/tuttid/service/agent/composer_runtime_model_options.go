package agent

import "strings"

func extractModelOptionsFromRuntimeContext(runtimeContext map[string]any, optionIDs ...string) []ComposerConfigOptionValue {
	if len(runtimeContext) == 0 {
		return nil
	}
	configOptions := runtimeConfigOptionsAsMapSlice(runtimeContext["configOptions"])
	if len(configOptions) == 0 {
		return nil
	}
	modelOptionID := "model"
	if len(optionIDs) > 0 && strings.TrimSpace(optionIDs[0]) != "" {
		modelOptionID = strings.TrimSpace(optionIDs[0])
	}
	for _, optionMap := range configOptions {
		if runtimeConfigOptionMatchesID(optionMap, modelOptionID) {
			return composerConfigOptionValuesFromAny(optionMap["options"])
		}
	}
	return nil
}

func composerConfigOptionValuesFromAny(input any) []ComposerConfigOptionValue {
	rawOptions := anySlice(input)
	if len(rawOptions) == 0 {
		return nil
	}
	options := make([]ComposerConfigOptionValue, 0, len(rawOptions))
	for _, raw := range rawOptions {
		optionMap := anyMap(raw)
		value := strings.TrimSpace(stringFromAny(optionMap["value"]))
		if value == "" {
			continue
		}
		label := strings.TrimSpace(stringFromAny(optionMap["label"]))
		if label == "" {
			label = strings.TrimSpace(stringFromAny(optionMap["name"]))
		}
		if label == "" {
			label = value
		}
		id := strings.TrimSpace(stringFromAny(optionMap["id"]))
		if id == "" {
			id = value
		}
		var supportsImageInput *bool
		if supported, ok := boolFromAny(optionMap["supportsImageInput"]); ok {
			supportsImageInput = &supported
		}
		var supportsReasoningEffort *bool
		if supported, ok := boolFromAny(optionMap["supportsReasoningEffort"]); ok {
			supportsReasoningEffort = &supported
		}
		reasoningEfforts, advertised := reasoningEffortOptionsFromAny(optionMap["reasoningEfforts"])
		options = append(options, ComposerConfigOptionValue{
			ID:                         id,
			Label:                      label,
			Value:                      value,
			Description:                strings.TrimSpace(stringFromAny(optionMap["description"])),
			SupportsImageInput:         supportsImageInput,
			SupportsReasoningEffort:    supportsReasoningEffort,
			ReasoningEffort:            strings.TrimSpace(stringFromAny(optionMap["reasoningEffort"])),
			ReasoningEfforts:           reasoningEfforts,
			ReasoningEffortsAdvertised: advertised,
		})
	}
	return options
}

func reasoningEffortOptionsFromAny(input any) ([]AgentModelReasoningEffortOption, bool) {
	if input == nil {
		return nil, false
	}
	items := anySlice(input)
	result := make([]AgentModelReasoningEffortOption, 0, len(items))
	seen := map[string]struct{}{}
	for _, item := range items {
		record := anyMap(item)
		value := strings.TrimSpace(firstNonEmptyString(stringFromAny(record["value"]), stringFromAny(record["id"])))
		if value == "" {
			if text, ok := item.(string); ok {
				value = strings.TrimSpace(text)
			}
		}
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, AgentModelReasoningEffortOption{
			Default:     record["default"] == true,
			Value:       value,
			Label:       strings.TrimSpace(firstNonEmptyString(stringFromAny(record["label"]), stringFromAny(record["name"]))),
			Description: strings.TrimSpace(stringFromAny(record["description"])),
		})
	}
	return result, true
}

func anySlice(input any) []any {
	switch typed := input.(type) {
	case []any:
		return typed
	case []map[string]any:
		result := make([]any, len(typed))
		for index := range typed {
			result[index] = typed[index]
		}
		return result
	case []map[string]string:
		result := make([]any, len(typed))
		for index := range typed {
			record := make(map[string]any, len(typed[index]))
			for key, value := range typed[index] {
				record[key] = value
			}
			result[index] = record
		}
		return result
	default:
		return nil
	}
}

func anyMap(input any) map[string]any {
	switch typed := input.(type) {
	case map[string]any:
		return typed
	case map[string]string:
		result := make(map[string]any, len(typed))
		for key, value := range typed {
			result[key] = value
		}
		return result
	default:
		return nil
	}
}
