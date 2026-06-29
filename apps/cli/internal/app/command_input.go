package app

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/tutti-os/tutti/apps/cli/internal/daemon"
)

func parseCommandInput(command daemon.Capability, args []string) (map[string]any, error) {
	if input, ok, err := parsePositionalCommandInput(command, args); ok || err != nil {
		return input, err
	}
	return parseFlagCommandInput(command, args)
}

func parseFlagCommandInput(command daemon.Capability, args []string) (map[string]any, error) {
	booleanFlags := commandBooleanFlags(command.InputSchema)
	arrayFlags := commandArrayFlags(command.InputSchema)
	input := map[string]any{}
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if !strings.HasPrefix(arg, "--") {
			return nil, fmt.Errorf("unexpected argument %q", arg)
		}
		nameValue := strings.TrimPrefix(arg, "--")
		name, value, found := strings.Cut(nameValue, "=")
		if !found {
			if index+1 >= len(args) || strings.HasPrefix(args[index+1], "--") {
				if !booleanFlags[name] {
					return nil, fmt.Errorf("missing value for --%s", name)
				}
				input[name] = true
				continue
			} else {
				index++
				value = args[index]
			}
		}
		if strings.TrimSpace(name) == "" {
			return nil, fmt.Errorf("invalid flag %q", arg)
		}
		if existing, ok := input[name]; ok {
			switch typed := existing.(type) {
			case []string:
				input[name] = append(typed, value)
			case string:
				input[name] = []string{typed, value}
			default:
				input[name] = value
			}
			continue
		}
		if arrayFlags[name] {
			input[name] = []string{value}
			continue
		}
		input[name] = value
	}
	return input, nil
}

func commandBooleanFlags(schema map[string]any) map[string]bool {
	flags := map[string]bool{}
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		return flags
	}
	for name, property := range properties {
		if schemaPropertyType(property) == "boolean" {
			flags[name] = true
		}
	}
	return flags
}

func commandArrayFlags(schema map[string]any) map[string]bool {
	flags := map[string]bool{}
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		return flags
	}
	for name, property := range properties {
		if schemaPropertyType(property) == "array" {
			flags[name] = true
		}
	}
	return flags
}

func parsePositionalCommandInput(command daemon.Capability, args []string) (map[string]any, bool, error) {
	switch command.ID {
	case "agent-context.agent.open":
		if len(args) != 1 || strings.HasPrefix(args[0], "--") {
			return nil, false, nil
		}
		return map[string]any{"session-id": args[0]}, true, nil
	case "agent-context.agent.send":
		if len(args) < 2 || strings.HasPrefix(args[0], "--") {
			return nil, false, nil
		}
		if flagIndex := firstKnownFlagIndex(command.InputSchema, args[1:]); flagIndex >= 0 {
			input, err := parseFlagCommandInput(command, args[1+flagIndex:])
			if err != nil {
				return nil, true, err
			}
			if flagIndex > 0 {
				input["prompt"] = strings.Join(args[1:1+flagIndex], " ")
			}
			input["session-id"] = args[0]
			return input, true, nil
		}
		return map[string]any{
			"session-id": args[0],
			"prompt":     strings.Join(args[1:], " "),
		}, true, nil
	default:
		return nil, false, nil
	}
}

func firstKnownFlagIndex(schema map[string]any, args []string) int {
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		return -1
	}
	for index, arg := range args {
		if !strings.HasPrefix(arg, "--") {
			continue
		}
		nameValue := strings.TrimPrefix(arg, "--")
		name, _, _ := strings.Cut(nameValue, "=")
		if _, ok := properties[name]; ok {
			return index
		}
	}
	return -1
}

type commandFlag struct {
	Name        string
	Type        string
	Description string
	Required    bool
	Values      []string
	Default     string
	HasDefault  bool
}

func commandFlags(schema map[string]any) []commandFlag {
	properties, ok := schema["properties"].(map[string]any)
	if !ok || len(properties) == 0 {
		return nil
	}
	requiredNames := schemaRequiredNames(schema)
	required := map[string]bool{}
	for _, name := range requiredNames {
		required[name] = true
	}

	flags := make([]commandFlag, 0, len(properties))
	for _, name := range requiredNames {
		property, ok := properties[name]
		if !ok {
			continue
		}
		flags = append(flags, commandFlag{
			Name:        name,
			Type:        schemaPropertyType(property),
			Description: schemaPropertyDescription(property),
			Required:    true,
			Values:      schemaPropertyEnumValues(property),
			Default:     schemaPropertyDefault(property),
			HasDefault:  schemaPropertyHasDefault(property),
		})
	}

	optionalNames := make([]string, 0, len(properties))
	for name := range properties {
		if !required[name] {
			optionalNames = append(optionalNames, name)
		}
	}
	sort.Strings(optionalNames)
	for _, name := range optionalNames {
		flags = append(flags, commandFlag{
			Name:        name,
			Type:        schemaPropertyType(properties[name]),
			Description: schemaPropertyDescription(properties[name]),
			Values:      schemaPropertyEnumValues(properties[name]),
			Default:     schemaPropertyDefault(properties[name]),
			HasDefault:  schemaPropertyHasDefault(properties[name]),
		})
	}
	return flags
}

func schemaRequiredNames(schema map[string]any) []string {
	value, ok := schema["required"]
	if !ok {
		return nil
	}
	switch typed := value.(type) {
	case []string:
		return typed
	case []any:
		names := make([]string, 0, len(typed))
		for _, entry := range typed {
			name, ok := entry.(string)
			if ok {
				names = append(names, name)
			}
		}
		return names
	default:
		return nil
	}
}

func schemaPropertyType(property any) string {
	propertyMap, ok := property.(map[string]any)
	if !ok {
		return "value"
	}
	typeName, ok := propertyMap["type"].(string)
	if !ok || strings.TrimSpace(typeName) == "" {
		return "value"
	}
	return typeName
}

func schemaPropertyDescription(property any) string {
	propertyMap, ok := property.(map[string]any)
	if !ok {
		return ""
	}
	description, ok := propertyMap["description"].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(description)
}

func schemaPropertyEnumValues(property any) []string {
	propertyMap, ok := property.(map[string]any)
	if !ok {
		return nil
	}
	value, ok := propertyMap["enum"].([]any)
	if !ok {
		return nil
	}
	values := make([]string, 0, len(value))
	for _, item := range value {
		values = append(values, formatSchemaValue(item))
	}
	return values
}

func schemaPropertyDefault(property any) string {
	propertyMap, ok := property.(map[string]any)
	if !ok {
		return ""
	}
	value, ok := propertyMap["default"]
	if !ok {
		return ""
	}
	return formatSchemaValue(value)
}

func schemaPropertyHasDefault(property any) bool {
	propertyMap, ok := property.(map[string]any)
	if !ok {
		return false
	}
	_, ok = propertyMap["default"]
	return ok
}

func formatSchemaValue(value any) string {
	switch typed := value.(type) {
	case json.Number:
		return typed.String()
	case float64:
		if typed == float64(int64(typed)) {
			return fmt.Sprintf("%.0f", typed)
		}
		return fmt.Sprint(typed)
	default:
		return fmt.Sprint(value)
	}
}
