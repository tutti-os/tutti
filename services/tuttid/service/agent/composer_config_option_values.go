package agent

import "strings"

func stringFromAny(input any) string {
	if value, ok := input.(string); ok {
		return value
	}
	return ""
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
		// Preserve descriptions in the internal runtime snapshot so a later
		// typed ModelConfig projection can retain model hover detail.
		if description := strings.TrimSpace(option.Description); description != "" {
			entry["description"] = description
		}
		if option.SupportsImageInput != nil {
			entry["supportsImageInput"] = *option.SupportsImageInput
		}
		if option.SupportsReasoningEffort != nil {
			entry["supportsReasoningEffort"] = *option.SupportsReasoningEffort
		}
		if reasoningEffort := strings.TrimSpace(option.ReasoningEffort); reasoningEffort != "" {
			entry["reasoningEffort"] = reasoningEffort
		}
		if option.ReasoningEffortsAdvertised {
			efforts := make([]map[string]any, 0, len(option.ReasoningEfforts))
			for _, effort := range option.ReasoningEfforts {
				value := strings.TrimSpace(effort.Value)
				if value == "" {
					continue
				}
				item := map[string]any{"value": value}
				if label := strings.TrimSpace(effort.Label); label != "" {
					item["label"] = label
				}
				if description := strings.TrimSpace(effort.Description); description != "" {
					item["description"] = description
				}
				if effort.Default {
					item["default"] = true
				}
				efforts = append(efforts, item)
			}
			entry["reasoningEfforts"] = efforts
		}
		// Provenance for requested-origin entries (warm-catalog append,
		// bootstrap echo): clients must not count them as catalog testimony.
		if option.Requested {
			entry["requested"] = true
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
