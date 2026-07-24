package framework

import (
	"fmt"
	"reflect"
	"strconv"
	"strings"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func FromStruct[T any]() InputSpec {
	var zero T
	typ := reflect.TypeOf(zero)
	if typ == nil {
		typ = reflect.TypeOf((*T)(nil)).Elem()
	}
	if typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	spec := InputSpec{InputType: typ.String(), AcceptsInput: false}
	if typ.Kind() != reflect.Struct {
		return spec
	}
	for i := 0; i < typ.NumField(); i++ {
		field := typ.Field(i)
		if field.PkgPath != "" {
			continue
		}
		name := strings.TrimSpace(field.Tag.Get("cli"))
		if name == "-" {
			continue
		}
		if name == "" {
			name = kebabCase(field.Name)
		}
		fieldSpec := FieldSpec{
			Name:               name,
			Type:               schemaType(field.Type),
			Description:        strings.TrimSpace(field.Tag.Get("description")),
			Hidden:             field.Tag.Get("hidden") == "true",
			AdvertisedRequired: field.Tag.Get("advertise-required") == "true",
			Hint:               strings.TrimSpace(field.Tag.Get("hint")),
			Default:            typedDefault(field.Type, field.Tag.Get("default")),
		}
		applyValidateTag(&fieldSpec, field.Tag.Get("validate"))
		fieldSpec.Enum = parseCSVTag(field.Tag.Get("enum"))
		spec.Fields = append(spec.Fields, fieldSpec)
		spec.AcceptsInput = true
	}
	return spec
}

func Schema(input InputSpec) map[string]any {
	schema := map[string]any{
		"type":       "object",
		"properties": map[string]any{},
	}
	properties := schema["properties"].(map[string]any)
	required := []string{}
	for _, field := range input.Fields {
		if field.Hidden {
			continue
		}
		propertyType := field.Type
		if propertyType == "" {
			propertyType = "string"
		}
		property := map[string]any{"type": propertyType}
		if propertyType == "array" {
			property["items"] = map[string]any{"type": "string"}
		}
		if field.Description != "" {
			property["description"] = field.Description
		}
		if field.Min != nil {
			property["minimum"] = *field.Min
		}
		if field.Max != nil {
			property["maximum"] = *field.Max
		}
		if len(field.Enum) > 0 {
			property["enum"] = field.Enum
		}
		if field.Default != nil {
			property["default"] = field.Default
		}
		properties[field.Name] = property
		if field.Required || field.AdvertisedRequired {
			required = append(required, field.Name)
		}
	}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func BindInput[T any](spec InputSpec, input map[string]any) (T, error) {
	var result T
	if input == nil {
		input = map[string]any{}
	}
	fields := map[string]FieldSpec{}
	for _, field := range spec.Fields {
		fields[field.Name] = field
	}

	value := reflect.ValueOf(&result).Elem()
	typ := value.Type()
	if typ.Kind() == reflect.Pointer {
		if value.IsNil() {
			value.Set(reflect.New(typ.Elem()))
		}
		value = value.Elem()
		typ = value.Type()
	}
	if typ.Kind() != reflect.Struct {
		return result, nil
	}

	for i := 0; i < typ.NumField(); i++ {
		structField := typ.Field(i)
		if structField.PkgPath != "" {
			continue
		}
		name := strings.TrimSpace(structField.Tag.Get("cli"))
		if name == "-" {
			continue
		}
		if name == "" {
			name = kebabCase(structField.Name)
		}
		fieldSpec, ok := fields[name]
		if !ok {
			continue
		}
		raw, exists := input[name]
		if (!exists || raw == nil) && fieldSpec.Default != nil {
			raw = fieldSpec.Default
			exists = true
		}
		if !exists || raw == nil {
			if fieldSpec.Required {
				return result, missingRequiredError(fieldSpec)
			}
			continue
		}
		if fieldSpec.Required && strings.TrimSpace(fmt.Sprint(raw)) == "" {
			return result, missingRequiredError(fieldSpec)
		}
		if err := setFieldValue(value.Field(i), fieldSpec, raw); err != nil {
			return result, err
		}
	}
	return result, nil
}

func typedDefault(fieldType reflect.Type, raw string) any {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	for fieldType.Kind() == reflect.Pointer {
		fieldType = fieldType.Elem()
	}
	switch fieldType.Kind() {
	case reflect.String:
		return raw
	case reflect.Bool:
		value, err := strconv.ParseBool(raw)
		if err == nil {
			return value
		}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		value, err := strconv.ParseInt(raw, 10, 64)
		if err == nil {
			return value
		}
	case reflect.Float32, reflect.Float64:
		value, err := strconv.ParseFloat(raw, 64)
		if err == nil {
			return value
		}
	}
	return nil
}

func setFieldValue(field reflect.Value, spec FieldSpec, raw any) error {
	if !field.CanSet() {
		return nil
	}
	if field.Kind() == reflect.Pointer {
		value := reflect.New(field.Type().Elem())
		if err := setFieldValue(value.Elem(), spec, raw); err != nil {
			return err
		}
		field.Set(value)
		return nil
	}
	switch field.Kind() {
	case reflect.String:
		text, ok := raw.(string)
		if !ok {
			return invalidInputError(spec.Name)
		}
		trimmed := strings.TrimSpace(text)
		if err := validateEnum(spec, trimmed); err != nil {
			return err
		}
		field.SetString(trimmed)
	case reflect.Slice:
		if field.Type().Elem().Kind() != reflect.String {
			return invalidInputError(spec.Name)
		}
		values, ok := stringValues(raw)
		if !ok {
			return invalidInputError(spec.Name)
		}
		slice := reflect.MakeSlice(field.Type(), 0, len(values))
		for _, value := range values {
			trimmed := strings.TrimSpace(value)
			if trimmed == "" {
				continue
			}
			slice = reflect.Append(slice, reflect.ValueOf(trimmed))
		}
		field.Set(slice)
	case reflect.Bool:
		value, err := parseBool(raw)
		if err != nil {
			return invalidInputError(spec.Name)
		}
		field.SetBool(value)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		value, err := parseInt(raw)
		if err != nil {
			return invalidInputError(spec.Name)
		}
		if spec.Min != nil && value < *spec.Min {
			return invalidInputErrorWithReason(spec.Name, fmt.Sprintf("must be >= %d", *spec.Min))
		}
		if spec.Max != nil && value > *spec.Max {
			return invalidInputErrorWithReason(spec.Name, fmt.Sprintf("must be <= %d", *spec.Max))
		}
		field.SetInt(value)
	case reflect.Float32, reflect.Float64:
		value, err := parseFloat(raw)
		if err != nil {
			return invalidInputError(spec.Name)
		}
		if spec.Min != nil && value < float64(*spec.Min) {
			return invalidInputErrorWithReason(spec.Name, fmt.Sprintf("must be >= %d", *spec.Min))
		}
		if spec.Max != nil && value > float64(*spec.Max) {
			return invalidInputErrorWithReason(spec.Name, fmt.Sprintf("must be <= %d", *spec.Max))
		}
		field.SetFloat(value)
	default:
		return invalidInputError(spec.Name)
	}
	return nil
}

func stringValues(raw any) ([]string, bool) {
	switch value := raw.(type) {
	case string:
		return []string{value}, true
	case []string:
		return value, true
	case []any:
		result := make([]string, 0, len(value))
		for _, item := range value {
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

func parseBool(raw any) (bool, error) {
	if value, ok := raw.(bool); ok {
		return value, nil
	}
	text, ok := raw.(string)
	if !ok {
		return false, fmt.Errorf("invalid bool")
	}
	switch strings.ToLower(strings.TrimSpace(text)) {
	case "1", "true", "yes", "on":
		return true, nil
	case "0", "false", "no", "off":
		return false, nil
	default:
		return false, fmt.Errorf("invalid bool")
	}
}

func parseInt(raw any) (int64, error) {
	switch value := raw.(type) {
	case int:
		return int64(value), nil
	case int64:
		return value, nil
	case float64:
		if value != float64(int64(value)) {
			return 0, fmt.Errorf("invalid integer")
		}
		return int64(value), nil
	case string:
		return strconv.ParseInt(strings.TrimSpace(value), 10, 64)
	default:
		return 0, fmt.Errorf("invalid integer")
	}
}

func parseFloat(raw any) (float64, error) {
	switch value := raw.(type) {
	case int:
		return float64(value), nil
	case int64:
		return float64(value), nil
	case float32:
		return float64(value), nil
	case float64:
		return value, nil
	case string:
		return strconv.ParseFloat(strings.TrimSpace(value), 64)
	default:
		return 0, fmt.Errorf("invalid number")
	}
}

func missingRequiredError(field FieldSpec) error {
	message := fmt.Sprintf("required input %q is missing", field.Name)
	if field.Hint != "" {
		message += ". " + field.Hint
	}
	return fmt.Errorf("%w: %s", cliservice.ErrInvalidInput, message)
}

func invalidInputError(name string) error {
	return fmt.Errorf("%w: invalid input %q", cliservice.ErrInvalidInput, name)
}

func invalidInputErrorWithReason(name string, reason string) error {
	reason = strings.TrimSpace(reason)
	if reason == "" {
		return invalidInputError(name)
	}
	return fmt.Errorf("%w: invalid input %q: %s", cliservice.ErrInvalidInput, name, reason)
}

func validateEnum(spec FieldSpec, value string) error {
	if len(spec.Enum) == 0 || strings.TrimSpace(value) == "" && !spec.Required {
		return nil
	}
	for _, allowed := range spec.Enum {
		if value == allowed {
			return nil
		}
	}
	return invalidInputErrorWithReason(spec.Name, "must be one of "+strings.Join(spec.Enum, ", "))
}

func applyValidateTag(field *FieldSpec, tag string) {
	for _, part := range strings.Split(tag, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		if part == "required" {
			field.Required = true
			continue
		}
		if raw, ok := strings.CutPrefix(part, "min="); ok {
			if value, err := strconv.ParseInt(raw, 10, 64); err == nil {
				field.Min = &value
			}
			continue
		}
		if raw, ok := strings.CutPrefix(part, "max="); ok {
			if value, err := strconv.ParseInt(raw, 10, 64); err == nil {
				field.Max = &value
			}
		}
	}
}

func parseCSVTag(tag string) []string {
	if strings.TrimSpace(tag) == "" {
		return nil
	}
	values := []string{}
	for _, part := range strings.Split(tag, ",") {
		part = strings.TrimSpace(part)
		if part != "" {
			values = append(values, part)
		}
	}
	return values
}

func schemaType(typ reflect.Type) string {
	if typ.Kind() == reflect.Pointer {
		typ = typ.Elem()
	}
	switch typ.Kind() {
	case reflect.Bool:
		return "boolean"
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		return "integer"
	case reflect.Float32, reflect.Float64:
		return "number"
	case reflect.Slice:
		return "array"
	default:
		return "string"
	}
}

func kebabCase(value string) string {
	var builder strings.Builder
	for i, char := range value {
		if i > 0 && char >= 'A' && char <= 'Z' {
			builder.WriteByte('-')
		}
		builder.WriteRune(char)
	}
	return strings.ToLower(builder.String())
}
