package agent

import (
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/modelcatalog"
)

func extractModelOptionsFromRuntimeContext(runtimeContext map[string]any, optionIDs ...string) []ComposerConfigOptionValue {
	if len(runtimeContext) == 0 {
		return nil
	}
	modelOptionID := "model"
	if len(optionIDs) > 0 && strings.TrimSpace(optionIDs[0]) != "" {
		modelOptionID = strings.TrimSpace(optionIDs[0])
	}
	models, advertised, err := modelcatalog.ParseRuntimeConfigOptionModels(
		runtimeContext["configOptions"],
		modelOptionID,
	)
	if err != nil || !advertised {
		return nil
	}
	return composerModelOptionsFromCanonicalCatalog(models)
}

func composerModelOptionsFromCanonicalCatalog(models []modelcatalog.ModelOption) []ComposerConfigOptionValue {
	options := make([]ComposerConfigOptionValue, 0, len(models))
	for _, model := range models {
		value := strings.TrimSpace(model.ID)
		if value == "" {
			continue
		}
		if containsModelOption(options, value) {
			continue
		}
		label := strings.TrimSpace(model.DisplayName)
		if label == "" {
			label = value
		}
		supportsReasoningEffort := (*bool)(nil)
		if model.ReasoningEffortsAdvertised {
			supported := len(model.SupportedReasoningEfforts) > 0
			supportsReasoningEffort = &supported
		}
		options = append(options, ComposerConfigOptionValue{
			ID:                         value,
			Label:                      label,
			Value:                      value,
			Description:                strings.TrimSpace(model.Description),
			SupportsImageInput:         model.SupportsImageInput,
			SupportsReasoningEffort:    supportsReasoningEffort,
			ReasoningEffort:            strings.TrimSpace(model.DefaultReasoningEffort),
			ReasoningEfforts:           append([]AgentModelReasoningEffortOption(nil), model.SupportedReasoningEfforts...),
			ReasoningEffortsAdvertised: model.ReasoningEffortsAdvertised,
		})
	}
	return options
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
		options = append(options, ComposerConfigOptionValue{
			ID:          id,
			Label:       label,
			Value:       value,
			Description: strings.TrimSpace(stringFromAny(optionMap["description"])),
		})
	}
	return options
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
