package runtimeprep

import (
	"errors"
	"fmt"
	"sort"
	"strings"
)

// CommandResolver is the immutable, agent-facing projection of one host
// command snapshot. It is shared by every Skill, policy section, and command
// guide rendered during one preparation.
type CommandResolver struct {
	cliName  string
	commands []CommandCapability
	byID     map[string]CommandCapability
	families map[string]struct{}
}

type commandArgument struct {
	name  string
	value string
}

type commandArguments struct {
	values []commandArgument
}

func newCommandResolver(cliName string, capabilities []CommandCapability) (*CommandResolver, error) {
	resolver := &CommandResolver{
		cliName:  normalizeCLICommandName(cliName),
		commands: make([]CommandCapability, 0, len(capabilities)),
		byID:     make(map[string]CommandCapability, len(capabilities)),
		families: make(map[string]struct{}),
	}
	for _, capability := range capabilities {
		if !commandVisibleToAgent(capability) {
			continue
		}
		id := strings.TrimSpace(capability.ID)
		if id == "" {
			return nil, errors.New("agent command capability requires id")
		}
		if _, exists := resolver.byID[id]; exists {
			return nil, fmt.Errorf("agent command capability id %q is duplicated", id)
		}
		capability.ID = id
		capability.Path = normalizedCommandPath(capability.Path)
		if len(capability.Path) == 0 {
			return nil, fmt.Errorf("agent command capability %q requires path", id)
		}
		capability.InputSchema = cloneSchemaMap(capability.InputSchema)
		if err := validateCommandInputSchema(id, capability.InputSchema); err != nil {
			return nil, err
		}
		capability.InputSchema = executionFacingInputSchema(capability.ExecutionMode, capability.InputSchema)
		capability.Output = cloneCommandCapabilityOutput(capability.Output)
		resolver.commands = append(resolver.commands, capability)
		resolver.byID[id] = capability
		resolver.families[capability.Path[0]] = struct{}{}
	}
	return resolver, nil
}

func normalizedCommandPath(path []string) []string {
	normalized := make([]string, 0, len(path))
	for _, segment := range path {
		if segment = strings.TrimSpace(segment); segment != "" {
			normalized = append(normalized, segment)
		}
	}
	return normalized
}

func validateCommandInputSchema(id string, schema map[string]any) error {
	if schema == nil {
		return nil
	}
	propertiesValue, hasProperties := schema["properties"]
	properties := mapSchemaValue(propertiesValue)
	if hasProperties && properties == nil {
		return fmt.Errorf("agent command capability %q has invalid properties schema", id)
	}
	for name, value := range properties {
		if strings.TrimSpace(name) == "" {
			return fmt.Errorf("agent command capability %q has an empty input name", id)
		}
		property, ok := value.(map[string]any)
		if !ok {
			return fmt.Errorf("agent command capability %q input %q has invalid schema", id, name)
		}
		if enumValue, hasEnum := property["enum"]; hasEnum {
			if _, ok := schemaStringSlice(enumValue); !ok {
				return fmt.Errorf("agent command capability %q input %q has invalid enum", id, name)
			}
		}
	}
	required, ok := schemaStringSlice(schema["required"])
	if _, exists := schema["required"]; exists && !ok {
		return fmt.Errorf("agent command capability %q has invalid required inputs", id)
	}
	seen := make(map[string]struct{}, len(required))
	for _, name := range required {
		name = strings.TrimSpace(name)
		if name == "" {
			return fmt.Errorf("agent command capability %q has an empty required input", id)
		}
		if _, exists := seen[name]; exists {
			return fmt.Errorf("agent command capability %q repeats required input %q", id, name)
		}
		seen[name] = struct{}{}
		if _, exists := properties[name]; !exists {
			return fmt.Errorf("agent command capability %q requires unknown input %q", id, name)
		}
	}
	return nil
}

func schemaStringSlice(value any) ([]string, bool) {
	if value == nil {
		return nil, true
	}
	switch typed := value.(type) {
	case []string:
		return append([]string(nil), typed...), true
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
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

func cloneCommandCapabilityOutput(output CommandCapabilityOutput) CommandCapabilityOutput {
	if output.Table == nil {
		return output
	}
	output.Table = &CommandTableOutput{
		Columns: append([]CommandTableColumn(nil), output.Table.Columns...),
	}
	return output
}

func (r *CommandResolver) Has(id string) bool {
	if r == nil {
		return false
	}
	_, ok := r.byID[strings.TrimSpace(id)]
	return ok
}

func (r *CommandResolver) HasAll(ids ...string) bool {
	if len(ids) == 0 {
		return false
	}
	for _, id := range ids {
		if !r.Has(id) {
			return false
		}
	}
	return true
}

func (r *CommandResolver) HasFamily(family string) bool {
	if r == nil {
		return false
	}
	_, ok := r.families[strings.TrimSpace(family)]
	return ok
}

func (r *CommandResolver) HasInput(id string, name string) bool {
	capability, ok := r.capability(id)
	return ok && schemaHasInput(capability.InputSchema, strings.TrimSpace(name))
}

func (r *CommandResolver) InputValues(id string, name string) []string {
	capability, ok := r.capability(id)
	if !ok {
		return nil
	}
	property := mapSchemaValue(mapSchemaValue(capability.InputSchema["properties"])[strings.TrimSpace(name)])
	return stringSliceSchemaValue(property["enum"])
}

func (r *CommandResolver) Path(id string) (string, error) {
	capability, ok := r.capability(id)
	if !ok {
		return "", fmt.Errorf("agent command %q is not advertised", strings.TrimSpace(id))
	}
	return commandPath(capability.Path), nil
}

func (r *CommandResolver) Command(id string, argumentSets ...commandArguments) (string, error) {
	capability, ok := r.capability(id)
	if !ok {
		return "", fmt.Errorf("agent command %q is not advertised", strings.TrimSpace(id))
	}
	arguments := mergeCommandArguments(argumentSets)
	properties := mapSchemaValue(capability.InputSchema["properties"])
	values := make(map[string]string, len(arguments))
	argumentOrder := make([]string, 0, len(arguments))
	for _, argument := range arguments {
		property, exists := properties[argument.name]
		if !exists {
			return "", fmt.Errorf("agent command %q does not accept --%s", capability.ID, argument.name)
		}
		if err := validateCommandArgumentValue(capability.ID, argument, mapSchemaValue(property)); err != nil {
			return "", err
		}
		if _, exists := values[argument.name]; !exists {
			argumentOrder = append(argumentOrder, argument.name)
		}
		values[argument.name] = argument.value
	}

	var command strings.Builder
	command.WriteString(r.cliName)
	command.WriteByte(' ')
	command.WriteString(commandPath(capability.Path))

	emitted := make(map[string]struct{}, len(values))
	for _, name := range stringSliceSchemaValue(capability.InputSchema["required"]) {
		name = strings.TrimSpace(name)
		value := values[name]
		if strings.TrimSpace(value) == "" {
			value = "<" + name + ">"
		}
		appendCommandFlag(&command, name, value, mapSchemaValue(properties[name]))
		emitted[name] = struct{}{}
	}
	for _, name := range argumentOrder {
		if _, exists := emitted[name]; exists {
			continue
		}
		appendCommandFlag(&command, name, values[name], mapSchemaValue(properties[name]))
	}
	if commandSupportsJSON(capability.Output) {
		command.WriteString(" --json")
	}
	return command.String(), nil
}

func validateCommandArgumentValue(id string, argument commandArgument, property map[string]any) error {
	value := strings.TrimSpace(argument.value)
	if strings.HasPrefix(value, "<") && strings.HasSuffix(value, ">") {
		return nil
	}
	if enum := stringSliceSchemaValue(property["enum"]); len(enum) > 0 {
		for _, allowed := range enum {
			if value == allowed {
				return nil
			}
		}
		return fmt.Errorf(
			"agent command %q input --%s does not accept %q",
			id,
			argument.name,
			argument.value,
		)
	}
	if schemaTypeLabel(property) == "true|false" &&
		!strings.EqualFold(value, "true") &&
		!strings.EqualFold(value, "false") {
		return fmt.Errorf("agent command %q input --%s requires true or false", id, argument.name)
	}
	return nil
}

func mergeCommandArguments(sets []commandArguments) []commandArgument {
	var result []commandArgument
	for _, set := range sets {
		result = append(result, set.values...)
	}
	return result
}

func appendCommandFlag(command *strings.Builder, name string, value string, property map[string]any) {
	command.WriteString(" --")
	command.WriteString(name)
	if schemaTypeLabel(property) == "true|false" && strings.EqualFold(strings.TrimSpace(value), "true") {
		return
	}
	command.WriteByte(' ')
	command.WriteString(shellExampleValue(value))
}

func shellExampleValue(value string) string {
	if strings.ContainsAny(value, " \t") && !strings.HasPrefix(value, "'") && !strings.HasPrefix(value, "\"") {
		return "\"" + value + "\""
	}
	return value
}

func commandSupportsJSON(output CommandCapabilityOutput) bool {
	return output.JSON || strings.TrimSpace(output.DefaultMode) == "json"
}

func commandTemplateArguments(values ...any) (commandArguments, error) {
	if len(values)%2 != 0 {
		return commandArguments{}, errors.New("args requires name/value pairs")
	}
	result := commandArguments{values: make([]commandArgument, 0, len(values)/2)}
	for index := 0; index < len(values); index += 2 {
		name := strings.TrimSpace(fmt.Sprint(values[index]))
		if name == "" {
			return commandArguments{}, errors.New("args requires a non-empty input name")
		}
		result.values = append(result.values, commandArgument{
			name:  name,
			value: fmt.Sprint(values[index+1]),
		})
	}
	return result, nil
}

func (r *CommandResolver) capability(id string) (CommandCapability, bool) {
	if r == nil {
		return CommandCapability{}, false
	}
	capability, ok := r.byID[strings.TrimSpace(id)]
	return capability, ok
}

func (r *CommandResolver) Guide() (string, error) {
	if r == nil || len(r.commands) == 0 {
		return "- No agent-facing runtime CLI commands were advertised by the current host.", nil
	}
	lines := make([]string, 0, len(r.commands))
	for _, capability := range r.commands {
		example, err := r.Command(capability.ID)
		if err != nil {
			return "", err
		}
		line := "- " + firstNonEmptyText(capability.Summary, capability.ID) + ": `" + example + "`"
		if description := commandGuideDescription(capability); description != "" {
			line += " - " + description
		}
		if details := inputDetailsForCommand(capability.ID, capability.InputSchema); details != "" {
			line += " Arguments: " + details
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n"), nil
}

func (r *CommandResolver) Families() []string {
	if r == nil {
		return nil
	}
	values := make([]string, 0, len(r.families))
	for family := range r.families {
		values = append(values, family)
	}
	sort.Strings(values)
	return values
}

func commandGuideDescription(capability CommandCapability) string {
	parts := make([]string, 0, 3)
	if description := strings.TrimSpace(capability.Description); description != "" {
		parts = append(parts, description)
	}
	if capability.Source.Kind == CommandSourceApp {
		if appName := strings.TrimSpace(capability.Source.AppName); appName != "" {
			parts = append(parts, "Provided by workspace app "+appName+".")
		}
		if appID := strings.TrimSpace(capability.Source.AppID); appID != "" {
			parts = append(parts, "App id: "+appID+".")
		}
	}
	return strings.Join(parts, " ")
}

func (r *CommandResolver) OutputModes() []string {
	modes := make(map[string]struct{})
	if r != nil {
		for _, capability := range r.commands {
			if mode := strings.TrimSpace(capability.Output.DefaultMode); mode != "" {
				modes[mode] = struct{}{}
			}
		}
	}
	values := make([]string, 0, len(modes))
	for mode := range modes {
		values = append(values, mode)
	}
	sort.Strings(values)
	return values
}
