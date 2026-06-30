package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

func NormalizeInput(schema map[string]any, input map[string]any) (map[string]any, error) {
	normalized, _, err := NormalizeInputWithWarnings(schema, input)
	return normalized, err
}

func NormalizeInputWithWarnings(schema map[string]any, input map[string]any) (map[string]any, []InputWarning, error) {
	if len(schema) == 0 {
		return map[string]any{}, unknownInputWarnings(input, nil), nil
	}
	properties, _ := schema["properties"].(map[string]any)
	required := map[string]bool{}
	for _, name := range RequiredNames(schema) {
		required[name] = true
	}
	result := make(map[string]any, len(input))
	for key, value := range input {
		property, ok := properties[key]
		if !ok {
			continue
		}
		propertyMap, _ := property.(map[string]any)
		normalized, err := normalizeValue(schemaType(propertyMap), value)
		if err != nil {
			return nil, nil, fmt.Errorf("%w: invalid input %q", ErrInvalidInput, key)
		}
		result[key] = normalized
	}
	for name := range required {
		if _, ok := result[name]; !ok {
			return nil, nil, fmt.Errorf("%w: required input %q is missing", ErrInvalidInput, name)
		}
	}
	return result, unknownInputWarnings(input, properties), nil
}

func unknownInputWarnings(input map[string]any, properties map[string]any) []InputWarning {
	if len(input) == 0 {
		return nil
	}
	unknown := make([]string, 0)
	for key := range input {
		if _, ok := properties[key]; !ok {
			unknown = append(unknown, key)
		}
	}
	sort.Strings(unknown)
	warnings := make([]InputWarning, 0, len(unknown))
	for _, key := range unknown {
		warnings = append(warnings, InputWarning{
			Code:    "unknown_input_ignored",
			Message: fmt.Sprintf("Ignoring unknown input %q; this CLI may be newer than the app handler.", key),
		})
	}
	return warnings
}

func normalizeValue(typeName string, value any) (any, error) {
	switch typeName {
	case "string":
		text, ok := value.(string)
		if !ok {
			return nil, errors.New("not a string")
		}
		return text, nil
	case "boolean":
		switch typed := value.(type) {
		case bool:
			return typed, nil
		case string:
			parsed, err := strconv.ParseBool(strings.TrimSpace(typed))
			if err != nil {
				return nil, err
			}
			return parsed, nil
		default:
			return nil, errors.New("not a boolean")
		}
	case "integer":
		switch typed := value.(type) {
		case int:
			return typed, nil
		case int64:
			return typed, nil
		case float64:
			if typed != float64(int64(typed)) {
				return nil, errors.New("not an integer")
			}
			return int64(typed), nil
		case json.Number:
			parsed, err := typed.Int64()
			if err != nil {
				return nil, err
			}
			return parsed, nil
		case string:
			parsed, err := strconv.ParseInt(strings.TrimSpace(typed), 10, 64)
			if err != nil {
				return nil, err
			}
			return parsed, nil
		default:
			return nil, errors.New("not an integer")
		}
	default:
		return nil, errors.New("unsupported type")
	}
}
