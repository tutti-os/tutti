package agent

import "strings"

func stringFromAny(input any) string {
	if value, ok := input.(string); ok {
		return value
	}
	return ""
}

func boolFromAny(input any) (bool, bool) {
	value, ok := input.(bool)
	return value, ok
}

func composerConfigOptionValuesToRuntimeModelOptions(options []ComposerConfigOptionValue) []map[string]any {
	if len(options) == 0 {
		return []map[string]any{}
	}
	result := make([]map[string]any, 0, len(options))
	for _, option := range options {
		value := strings.TrimSpace(option.Value)
		if value == "" {
			continue
		}
		label := strings.TrimSpace(option.Label)
		if label == "" {
			label = value
		}
		entry := map[string]any{
			"name":  label,
			"value": value,
		}
		// Carry the per-model description through to RuntimeContext. The desktop
		// composer projection prefers this live model list over ModelConfig.Options,
		// so dropping the description here removes the model hover detail.
		if description := strings.TrimSpace(option.Description); description != "" {
			entry["description"] = description
		}
		if option.SupportsImageInput != nil {
			entry["supportsImageInput"] = *option.SupportsImageInput
		}
		result = append(result, entry)
	}
	return result
}

func runtimeConfigOptionsAsMapSlice(input any) []map[string]any {
	switch typed := input.(type) {
	case []map[string]any:
		return append([]map[string]any(nil), typed...)
	case []any:
		result := make([]map[string]any, 0, len(typed))
		for _, item := range typed {
			entry, ok := item.(map[string]any)
			if !ok {
				continue
			}
			result = append(result, entry)
		}
		return result
	default:
		return nil
	}
}
