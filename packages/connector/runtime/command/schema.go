package command

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

// ValidateInputSchema rejects schema constructs that the Connector command
// runtime cannot enforce. Connector schemas cross a package trust boundary,
// so unsupported JSON Schema keywords must fail closed.
func ValidateInputSchema(schema map[string]any) error {
	if len(schema) == 0 {
		return nil
	}
	return validateSupportedSchema(schema, "input")
}

func validateSupportedSchema(schema map[string]any, path string) error {
	supported := map[string]struct{}{
		"type": {}, "properties": {}, "required": {}, "additionalProperties": {}, "items": {},
		"enum": {}, "minimum": {}, "maximum": {}, "allOf": {}, "anyOf": {}, "oneOf": {},
		"title": {}, "description": {}, "default": {}, "examples": {}, "deprecated": {}, "readOnly": {}, "writeOnly": {},
	}
	for keyword := range schema {
		if _, ok := supported[keyword]; !ok {
			return fmt.Errorf("%s uses unsupported schema keyword %q", path, keyword)
		}
	}
	typeName := ""
	if rawType, exists := schema["type"]; exists {
		var ok bool
		typeName, ok = rawType.(string)
		if !ok {
			return fmt.Errorf("%s type schema is invalid", path)
		}
		switch strings.TrimSpace(typeName) {
		case "object", "array", "string", "boolean", "integer", "number":
		default:
			return fmt.Errorf("%s has unsupported schema type %q", path, typeName)
		}
	}
	if raw, exists := schema["properties"]; exists {
		properties, ok := raw.(map[string]any)
		if !ok || strings.TrimSpace(typeName) != "object" {
			return fmt.Errorf("%s properties schema is invalid", path)
		}
		for name, rawProperty := range properties {
			property, ok := rawProperty.(map[string]any)
			if !ok || strings.TrimSpace(name) == "" {
				return fmt.Errorf("%s.%s schema is invalid", path, name)
			}
			if err := validateSupportedSchema(property, path+"."+name); err != nil {
				return err
			}
		}
	}
	if _, exists := schema["required"]; exists {
		required, valid := schemaStringList(schema, "required")
		if !valid || strings.TrimSpace(typeName) != "object" {
			return fmt.Errorf("%s required schema is invalid", path)
		}
		seen := make(map[string]struct{}, len(required))
		for _, name := range required {
			if strings.TrimSpace(name) == "" {
				return fmt.Errorf("%s required schema is invalid", path)
			}
			if _, duplicate := seen[name]; duplicate {
				return fmt.Errorf("%s required schema contains duplicate %q", path, name)
			}
			seen[name] = struct{}{}
		}
	}
	if raw, exists := schema["additionalProperties"]; exists {
		if strings.TrimSpace(typeName) != "object" {
			return fmt.Errorf("%s additionalProperties schema is invalid", path)
		}
		switch additional := raw.(type) {
		case bool:
		case map[string]any:
			if err := validateSupportedSchema(additional, path+".*"); err != nil {
				return err
			}
		default:
			return fmt.Errorf("%s additionalProperties schema is invalid", path)
		}
	}
	if raw, exists := schema["items"]; exists {
		items, ok := raw.(map[string]any)
		if !ok || strings.TrimSpace(typeName) != "array" {
			return fmt.Errorf("%s items schema is invalid", path)
		}
		if err := validateSupportedSchema(items, path+"[]"); err != nil {
			return err
		}
	}
	if raw, exists := schema["enum"]; exists {
		values, present, valid := schemaValueList(raw)
		if !present || !valid || len(values) == 0 {
			return fmt.Errorf("%s enum schema is invalid", path)
		}
	}
	for _, keyword := range []string{"minimum", "maximum"} {
		if raw, exists := schema[keyword]; exists {
			if _, valid := schemaNumber(raw); !valid || (typeName != "integer" && typeName != "number") {
				return fmt.Errorf("%s %s schema is invalid", path, keyword)
			}
		}
	}
	for _, keyword := range []string{"allOf", "anyOf", "oneOf"} {
		branches, present, valid := schemaMapList(schema[keyword])
		if !present {
			continue
		}
		if !valid || len(branches) == 0 {
			return fmt.Errorf("%s %s schema is invalid", path, keyword)
		}
		for index, branch := range branches {
			if err := validateSupportedSchema(branch, fmt.Sprintf("%s.%s[%d]", path, keyword, index)); err != nil {
				return err
			}
		}
	}
	return nil
}

func schemaMapList(value any) ([]map[string]any, bool, bool) {
	if value == nil {
		return nil, false, true
	}
	switch values := value.(type) {
	case []map[string]any:
		return values, true, true
	case []any:
		result := make([]map[string]any, 0, len(values))
		for _, item := range values {
			schema, ok := item.(map[string]any)
			if !ok {
				return nil, true, false
			}
			result = append(result, schema)
		}
		return result, true, true
	default:
		return nil, true, false
	}
}

func schemaValueList(value any) ([]any, bool, bool) {
	if value == nil {
		return nil, false, true
	}
	switch values := value.(type) {
	case []any:
		return values, true, true
	case []string:
		result := make([]any, len(values))
		for index := range values {
			result[index] = values[index]
		}
		return result, true, true
	default:
		return nil, true, false
	}
}

func schemaStringList(schema map[string]any, key string) ([]string, bool) {
	value, exists := schema[key]
	if !exists {
		return nil, true
	}
	switch values := value.(type) {
	case []string:
		return values, true
	case []any:
		result := make([]string, 0, len(values))
		for _, item := range values {
			text, ok := item.(string)
			if !ok {
				return nil, false
			}
			result = append(result, text)
		}
		return result, true
	default:
		return nil, false
	}
}

func schemaNumber(value any) (float64, bool) {
	switch number := value.(type) {
	case json.Number:
		parsed, err := number.Float64()
		return parsed, err == nil && !math.IsNaN(parsed) && !math.IsInf(parsed, 0)
	case int:
		return float64(number), true
	case int8:
		return float64(number), true
	case int16:
		return float64(number), true
	case int32:
		return float64(number), true
	case int64:
		return float64(number), true
	case uint:
		return float64(number), true
	case uint8:
		return float64(number), true
	case uint16:
		return float64(number), true
	case uint32:
		return float64(number), true
	case uint64:
		return float64(number), true
	case float32:
		parsed := float64(number)
		return parsed, !math.IsNaN(parsed) && !math.IsInf(parsed, 0)
	case float64:
		return number, !math.IsNaN(number) && !math.IsInf(number, 0)
	default:
		return 0, false
	}
}
