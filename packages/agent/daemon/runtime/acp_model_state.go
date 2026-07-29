package agentruntime

import (
	"encoding/json"
	"strings"
)

type acpModelInfo struct {
	Description             string          `json:"description"`
	ModelID                 string          `json:"modelId"`
	Name                    string          `json:"name"`
	SupportsReasoningEffort json.RawMessage `json:"supportsReasoningEffort"`
	ReasoningEffort         json.RawMessage `json:"reasoningEffort"`
	ReasoningEfforts        json.RawMessage `json:"reasoningEfforts"`
	SupportsImageInput      json.RawMessage `json:"supportsImageInput"`
	Meta                    json.RawMessage `json:"_meta"`
}

func applyACPModelsResult(state *acpLiveState, raw json.RawMessage) {
	if state == nil || len(raw) == 0 {
		return
	}
	var payload struct {
		Models *struct {
			AvailableModels []acpModelInfo `json:"availableModels"`
			CurrentModelID  string         `json:"currentModelId"`
		} `json:"models"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil || payload.Models == nil {
		return
	}
	state.modelsAPI = true
	options := make([]any, 0, len(payload.Models.AvailableModels))
	for _, model := range payload.Models.AvailableModels {
		modelID := strings.TrimSpace(model.ModelID)
		if modelID == "" {
			continue
		}
		label := strings.TrimSpace(model.Name)
		if label == "" {
			label = modelID
		}
		option := map[string]any{"value": modelID, "label": label}
		if description := strings.TrimSpace(model.Description); description != "" {
			option["description"] = description
		}
		applyACPModelMetadata(option, model)
		options = append(options, option)
	}
	if len(options) == 0 {
		return
	}
	descriptor := map[string]any{
		"id":           "model",
		"name":         "Model",
		"currentValue": strings.TrimSpace(payload.Models.CurrentModelID),
		"options":      options,
	}
	descriptors := cloneConfigOptionDescriptors(state.configOptionDescriptors)
	replaced := false
	for index := range descriptors {
		if strings.TrimSpace(asString(descriptors[index]["id"])) == "model" {
			descriptors[index] = descriptor
			replaced = true
			break
		}
	}
	if !replaced {
		descriptors = append(descriptors, descriptor)
	}
	applyACPConfigOptionDescriptors(state, descriptors)
}

func applyACPModelMetadata(option map[string]any, model acpModelInfo) {
	metadata := rawJSONObject(model.Meta)
	supportsReasoning := rawJSONBool(model.SupportsReasoningEffort)
	if supportsReasoning == nil {
		supportsReasoning = rawJSONBool(metadata["supportsReasoningEffort"])
	}
	if supportsReasoning != nil {
		option["supportsReasoningEffort"] = *supportsReasoning
	}
	reasoningEffort := rawJSONString(model.ReasoningEffort)
	if reasoningEffort == "" {
		reasoningEffort = rawJSONString(metadata["reasoningEffort"])
	}
	if reasoningEffort != "" {
		option["reasoningEffort"] = reasoningEffort
	}
	reasoningEfforts, advertised := normalizeACPReasoningEfforts(model.ReasoningEfforts)
	if !advertised {
		reasoningEfforts, advertised = normalizeACPReasoningEfforts(metadata["reasoningEfforts"])
	}
	if advertised {
		option["reasoningEfforts"] = reasoningEfforts
	}
	supportsImage := rawJSONBool(model.SupportsImageInput)
	if supportsImage == nil {
		supportsImage = rawJSONBool(metadata["supportsImageInput"])
	}
	if supportsImage != nil {
		option["supportsImageInput"] = *supportsImage
	}
}

func normalizeACPReasoningEfforts(raw json.RawMessage) ([]any, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return nil, false
	}
	var values []any
	if json.Unmarshal(raw, &values) != nil {
		return nil, false
	}
	result := make([]any, 0, len(values))
	seen := map[string]struct{}{}
	for _, item := range values {
		entry := map[string]any{}
		value := ""
		switch valueOrObject := item.(type) {
		case string:
			value = strings.TrimSpace(valueOrObject)
		case map[string]any:
			value = strings.TrimSpace(firstNonEmptyString(asString(valueOrObject["value"]), asString(valueOrObject["id"])))
			if label := strings.TrimSpace(firstNonEmptyString(asString(valueOrObject["label"]), asString(valueOrObject["name"]))); label != "" {
				entry["label"] = label
			}
			if description := strings.TrimSpace(asString(valueOrObject["description"])); description != "" {
				entry["description"] = description
			}
			if isDefault, ok := valueOrObject["default"].(bool); ok {
				entry["default"] = isDefault
			}
		}
		if value == "" {
			continue
		}
		if _, exists := seen[value]; exists {
			continue
		}
		seen[value] = struct{}{}
		entry["value"] = value
		result = append(result, entry)
	}
	return result, true
}

func rawJSONObject(raw json.RawMessage) map[string]json.RawMessage {
	if len(raw) == 0 {
		return nil
	}
	var value map[string]json.RawMessage
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return value
}

func rawJSONBool(raw json.RawMessage) *bool {
	if len(raw) == 0 {
		return nil
	}
	var value bool
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	return &value
}

func rawJSONString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value string
	if json.Unmarshal(raw, &value) != nil {
		return ""
	}
	return strings.TrimSpace(value)
}

func acpModelReasoningEffort(state acpLiveState, modelID string, requested string) (string, bool) {
	modelID = strings.TrimSpace(modelID)
	requested = strings.TrimSpace(requested)
	for _, descriptor := range state.configOptionDescriptors {
		if strings.TrimSpace(asString(descriptor["id"])) != "model" {
			continue
		}
		for _, model := range configOptionEntries(descriptor["options"]) {
			if strings.TrimSpace(asString(model["value"])) != modelID {
				continue
			}
			supported, supportKnown := model["supportsReasoningEffort"].(bool)
			_, effortsAdvertised := model["reasoningEfforts"]
			defaultEffort := strings.TrimSpace(asString(model["reasoningEffort"]))
			if supportKnown && !supported {
				return "", true
			}
			if !supportKnown && !effortsAdvertised && defaultEffort == "" {
				return "", false
			}
			first := ""
			defaultSupported := false
			for _, effort := range configOptionEntries(model["reasoningEfforts"]) {
				value := strings.TrimSpace(firstNonEmptyString(asString(effort["value"]), asString(effort["id"])))
				if value == "" {
					continue
				}
				if first == "" {
					first = value
				}
				if value == requested {
					return requested, true
				}
				if defaultEffort == "" && effort["default"] == true {
					defaultEffort = value
				}
				if value == defaultEffort {
					defaultSupported = true
				}
			}
			if defaultSupported {
				return defaultEffort, true
			}
			return first, true
		}
	}
	return "", false
}

func (a *standardACPAdapter) sessionModelReasoningEffort(
	agentSessionID string,
	modelID string,
	requested string,
) (string, bool) {
	if a == nil {
		return "", false
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil {
		return "", false
	}
	return acpModelReasoningEffort(session.acpLiveState, modelID, requested)
}

func (a *standardACPAdapter) sessionCurrentModelID(agentSessionID string) string {
	if a == nil {
		return ""
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	session := a.sessions[strings.TrimSpace(agentSessionID)]
	if session == nil {
		return ""
	}
	return strings.TrimSpace(asString(session.configOptions["model"]))
}
