package cli

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"strings"
)

func validateCapabilityInput(schema map[string]any, input map[string]any) error {
	if len(schema) == 0 {
		return nil
	}
	if input == nil {
		input = map[string]any{}
	}
	if err := validateSchemaValue(schema, input, "input"); err != nil {
		return InvalidInputReasonError("input_schema_mismatch", err.Error(), nil)
	}
	return nil
}

// ValidateCapabilityInputSchema rejects schema constructs that the daemon's
// invocation validator cannot enforce. Connector schemas cross a trust
// boundary, so accepting a richer JSON Schema and silently ignoring keywords
// would advertise constraints that are not actually applied at invocation.
func ValidateCapabilityInputSchema(schema map[string]any) error {
	if len(schema) == 0 {
		return nil
	}
	return validateSupportedSchema(schema, "input")
}

func validateSupportedSchema(schema map[string]any, path string) error {
	supported := map[string]struct{}{
		"type": {}, "properties": {}, "required": {}, "additionalProperties": {}, "items": {},
		"enum": {}, "minimum": {}, "maximum": {}, "allOf": {}, "anyOf": {}, "oneOf": {},
		// Annotation-only keywords do not affect validation and are safe to retain.
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

func validateSchemaValue(schema map[string]any, value any, path string) error {
	if err := validateSchemaCompositions(schema, value, path); err != nil {
		return err
	}
	typeName, typeIsString := schema["type"].(string)
	if _, hasType := schema["type"]; hasType && !typeIsString {
		return fmt.Errorf("%s type schema is invalid", path)
	}
	switch strings.TrimSpace(typeName) {
	case "":
		// A schema without type only applies its independent constraints (for
		// example oneOf or enum). It must not silently coerce the value to an
		// object.
	case "object":
		object, ok := value.(map[string]any)
		if !ok {
			return fmt.Errorf("%s must be an object", path)
		}
		properties, propertiesValid := schemaObject(schema, "properties")
		if !propertiesValid {
			return fmt.Errorf("%s properties schema is invalid", path)
		}
		requiredNames, requiredValid := schemaStringList(schema, "required")
		if !requiredValid {
			return fmt.Errorf("%s required schema is invalid", path)
		}
		for _, required := range requiredNames {
			if item, exists := object[required]; !exists || item == nil {
				return fmt.Errorf("%s.%s is required", path, required)
			}
		}
		for name, item := range object {
			property, declared := properties[name]
			if !declared {
				switch additional := schema["additionalProperties"].(type) {
				case nil:
					continue
				case bool:
					if additional {
						continue
					}
					return fmt.Errorf("%s.%s is not allowed", path, name)
				case map[string]any:
					if err := validateSchemaValue(additional, item, path+"."+name); err != nil {
						return err
					}
					continue
				default:
					return fmt.Errorf("%s additionalProperties schema is invalid", path)
				}
			}
			propertySchema, ok := property.(map[string]any)
			if !ok {
				return fmt.Errorf("%s.%s schema is invalid", path, name)
			}
			if err := validateSchemaValue(propertySchema, item, path+"."+name); err != nil {
				return err
			}
		}
	case "array":
		items := reflect.ValueOf(value)
		if !items.IsValid() || (items.Kind() != reflect.Array && items.Kind() != reflect.Slice) {
			return fmt.Errorf("%s must be an array", path)
		}
		itemSchema, itemsValid := schemaObject(schema, "items")
		if !itemsValid {
			return fmt.Errorf("%s items schema is invalid", path)
		}
		for index := 0; index < items.Len(); index++ {
			if len(itemSchema) != 0 {
				if err := validateSchemaValue(itemSchema, items.Index(index).Interface(), fmt.Sprintf("%s[%d]", path, index)); err != nil {
					return err
				}
			}
		}
	case "string":
		if _, ok := value.(string); !ok {
			return fmt.Errorf("%s must be a string", path)
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("%s must be a boolean", path)
		}
	case "integer":
		if !schemaInteger(value) {
			return fmt.Errorf("%s must be an integer", path)
		}
	case "number":
		if _, ok := schemaNumber(value); !ok {
			return fmt.Errorf("%s must be a number", path)
		}
	default:
		return fmt.Errorf("%s has unsupported schema type %q", path, typeName)
	}
	if enum, present, valid := schemaValueList(schema["enum"]); present {
		if !valid {
			return fmt.Errorf("%s enum schema is invalid", path)
		}
		matched := false
		for _, candidate := range enum {
			if schemaValuesEqual(candidate, value) {
				matched = true
				break
			}
		}
		if !matched {
			return fmt.Errorf("%s is not an allowed value", path)
		}
	}
	if number, ok := schemaNumber(value); ok {
		if minimum, ok := schemaNumber(schema["minimum"]); ok && number < minimum {
			return fmt.Errorf("%s must be at least %v", path, minimum)
		}
		if maximum, ok := schemaNumber(schema["maximum"]); ok && number > maximum {
			return fmt.Errorf("%s must be at most %v", path, maximum)
		}
	}
	return nil
}

func validateSchemaCompositions(schema map[string]any, value any, path string) error {
	if branches, present, valid := schemaMapList(schema["allOf"]); present {
		if !valid || len(branches) == 0 {
			return fmt.Errorf("%s allOf schema is invalid", path)
		}
		for _, branch := range branches {
			if err := validateSchemaValue(branch, value, path); err != nil {
				return err
			}
		}
	}
	if branches, present, valid := schemaMapList(schema["anyOf"]); present {
		if !valid || len(branches) == 0 {
			return fmt.Errorf("%s anyOf schema is invalid", path)
		}
		matched := false
		for _, branch := range branches {
			if validateSchemaValue(branch, value, path) == nil {
				matched = true
				break
			}
		}
		if !matched {
			return fmt.Errorf("%s does not match any allowed schema", path)
		}
	}
	if branches, present, valid := schemaMapList(schema["oneOf"]); present {
		if !valid || len(branches) == 0 {
			return fmt.Errorf("%s oneOf schema is invalid", path)
		}
		matches := 0
		for _, branch := range branches {
			if validateSchemaValue(branch, value, path) == nil {
				matches++
			}
		}
		if matches != 1 {
			return fmt.Errorf("%s must match exactly one allowed schema", path)
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

func schemaValuesEqual(left any, right any) bool {
	if reflect.DeepEqual(left, right) {
		return true
	}
	leftNumber, leftIsNumber := schemaNumber(left)
	rightNumber, rightIsNumber := schemaNumber(right)
	return leftIsNumber && rightIsNumber && leftNumber == rightNumber
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

func schemaObject(schema map[string]any, key string) (map[string]any, bool) {
	value, exists := schema[key]
	if !exists {
		return nil, true
	}
	object, ok := value.(map[string]any)
	return object, ok
}

func schemaInteger(value any) bool {
	number, ok := schemaNumber(value)
	return ok && !math.IsNaN(number) && math.Trunc(number) == number
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
