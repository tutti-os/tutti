package modelcatalog

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// ParseCodexModelListLine parses one JSON-RPC stdout line. handled is false
// for notifications, logs, and responses to other request ids.
func ParseCodexModelListLine(line []byte, requestID string) ([]ModelOption, bool, error) {
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(line, &payload); err != nil {
		return nil, false, nil
	}
	if !codexRPCIDMatches(payload["id"], requestID) {
		return nil, false, nil
	}
	if rawError, ok := payload["error"]; ok && string(rawError) != "null" {
		return nil, true, errors.New(extractCodexRPCError(rawError))
	}
	var result struct {
		Data []json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(payload["result"], &result); err != nil {
		return nil, true, fmt.Errorf("parse codex model/list result: %w", err)
	}
	models := make([]ModelOption, 0, len(result.Data))
	for _, rawModel := range result.Data {
		if model, ok := NormalizeCodexModel(rawModel); ok {
			models = append(models, model)
		}
	}
	return models, true, nil
}

func NormalizeCodexModel(raw json.RawMessage) (ModelOption, bool) {
	var object map[string]any
	if err := json.Unmarshal(raw, &object); err != nil {
		return ModelOption{}, false
	}
	id := firstNonBlank(stringMapValue(object, "model"), stringMapValue(object, "id"))
	if id == "" {
		return ModelOption{}, false
	}
	displayName := firstNonBlank(stringMapValue(object, "displayName"), stringMapValue(object, "display_name"), id)
	reasoningValue, reasoningAdvertised := advertisedValue(object, "supportedReasoningEfforts", "supported_reasoning_efforts")
	speedValue, speedAdvertised := advertisedValue(object, "serviceTiers", "service_tiers")
	legacySpeedValue, legacySpeedAdvertised := advertisedValue(object, "additionalSpeedTiers", "additional_speed_tiers")
	speeds := normalizeCodexSpeeds(speedValue, legacySpeedValue)
	defaultSpeed := canonicalCodexSpeed(firstNonBlank(stringMapValue(object, "defaultServiceTier"), stringMapValue(object, "default_service_tier")))
	defaultSpeed = validSpeedDefault(speeds, defaultSpeed)
	return ModelOption{
		ID:                         id,
		DisplayName:                displayName,
		Description:                stringMapValue(object, "description"),
		DefaultReasoningEffort:     firstNonBlank(stringMapValue(object, "defaultReasoningEffort"), stringMapValue(object, "default_reasoning_effort")),
		DefaultSpeed:               defaultSpeed,
		IsDefault:                  boolMapValue(object, "isDefault") || boolMapValue(object, "is_default"),
		ReasoningEffortsAdvertised: reasoningAdvertised,
		SupportedReasoningEfforts:  normalizeCodexReasoningEfforts(reasoningValue),
		SpeedsAdvertised:           speedAdvertised || legacySpeedAdvertised,
		SupportedSpeeds:            speeds,
		SupportsImageInput:         codexImageInputSupport(object),
	}, true
}

func normalizeCodexReasoningEfforts(value any) []ReasoningEffortOption {
	rawOptions, ok := value.([]any)
	if !ok {
		return nil
	}
	options := make([]ReasoningEffortOption, 0, len(rawOptions))
	seen := make(map[string]struct{}, len(rawOptions))
	for _, rawOption := range rawOptions {
		var option ReasoningEffortOption
		switch typed := rawOption.(type) {
		case string:
			option.Value = strings.TrimSpace(typed)
		case map[string]any:
			option.Value = firstNonBlank(stringMapValue(typed, "reasoningEffort"), stringMapValue(typed, "effort"), stringMapValue(typed, "value"))
			option.Label = firstNonBlank(stringMapValue(typed, "label"), stringMapValue(typed, "name"))
			option.Description = stringMapValue(typed, "description")
			option.Default = boolMapValue(typed, "default") || boolMapValue(typed, "isDefault")
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

func normalizeCodexSpeeds(values ...any) []SpeedOption {
	options := []SpeedOption{{Value: "standard", Label: "Standard"}}
	seen := map[string]struct{}{"standard": {}}
	for _, rawValue := range values {
		rawOptions, ok := rawValue.([]any)
		if !ok {
			continue
		}
		for _, rawOption := range rawOptions {
			var option SpeedOption
			switch typed := rawOption.(type) {
			case string:
				option.Value = canonicalCodexSpeed(typed)
			case map[string]any:
				option.Value = canonicalCodexSpeed(stringMapValue(typed, "id"))
				option.Label = stringMapValue(typed, "name")
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
	}
	return options
}

func canonicalCodexSpeed(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "default", "standard":
		return "standard"
	case "priority", "fast":
		return "fast"
	default:
		return strings.TrimSpace(value)
	}
}

func codexImageInputSupport(object map[string]any) *bool {
	raw, advertised := object["inputModalities"]
	if !advertised {
		raw, advertised = object["input_modalities"]
	}
	if !advertised {
		return nil
	}
	modalities, ok := raw.([]any)
	if !ok {
		return nil
	}
	supported := false
	for _, modality := range modalities {
		if value, ok := modality.(string); ok && strings.EqualFold(strings.TrimSpace(value), "image") {
			supported = true
			break
		}
	}
	return &supported
}

func advertisedValue(object map[string]any, keys ...string) (any, bool) {
	for _, key := range keys {
		if value, ok := object[key]; ok {
			return value, true
		}
	}
	return nil, false
}

func codexRPCIDMatches(raw json.RawMessage, want string) bool {
	var stringID string
	if err := json.Unmarshal(raw, &stringID); err == nil {
		return stringID == want
	}
	var numberID int
	if err := json.Unmarshal(raw, &numberID); err == nil {
		return fmt.Sprintf("%d", numberID) == want
	}
	return false
}

func extractCodexRPCError(raw json.RawMessage) string {
	var message string
	if err := json.Unmarshal(raw, &message); err == nil && strings.TrimSpace(message) != "" {
		return strings.TrimSpace(message)
	}
	var object struct {
		Message string `json:"message"`
	}
	if err := json.Unmarshal(raw, &object); err == nil && strings.TrimSpace(object.Message) != "" {
		return strings.TrimSpace(object.Message)
	}
	return "unknown codex app-server RPC error"
}

func stringMapValue(object map[string]any, key string) string {
	value, _ := object[key].(string)
	return strings.TrimSpace(value)
}

func boolMapValue(object map[string]any, key string) bool {
	value, ok := object[key].(bool)
	return ok && value
}

func firstNonBlank(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
