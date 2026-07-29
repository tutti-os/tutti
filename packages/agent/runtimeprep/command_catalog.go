package runtimeprep

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
)

type CommandSourceKind string

const (
	CommandSourceBuiltin CommandSourceKind = "builtin"
	CommandSourceApp     CommandSourceKind = "app"
)

type CommandSource struct {
	Kind    CommandSourceKind
	AppID   string
	AppName string
}

type CommandTableColumn struct {
	Key   string
	Label string
}

type CommandTableOutput struct {
	Columns []CommandTableColumn
}

type CommandCapabilityOutput struct {
	DefaultMode string
	JSON        bool
	Table       *CommandTableOutput
}

type CommandCapability struct {
	ID            string
	Path          []string
	Summary       string
	Description   string
	Visibility    string
	InputSchema   map[string]any
	Output        CommandCapabilityOutput
	ExecutionMode string
	Source        CommandSource
}

type CommandContext struct {
	Source                         string
	WorkspaceID                    string
	SkipCapabilityFilters          bool
	IncludeIntegrationCapabilities bool
}

type CommandCatalog interface {
	Capabilities(context.Context, CommandContext) []CommandCapability
}

type CommandCapabilityProjection struct {
	// AllowedIDs switches the projection to an exact capability allowlist when
	// non-empty. It includes both public and promoted integration capabilities.
	// Empty preserves the legacy public-by-default projection.
	AllowedIDs            []string
	IncludeIntegrationIDs []string
	ExcludeIDs            []string
}

func resolveCommandCapabilities(
	ctx context.Context,
	catalog CommandCatalog,
	workspaceID string,
	cliName string,
	projections ...*CommandCapabilityProjection,
) (*CommandResolver, error) {
	if catalog == nil {
		return nil, errors.New("agent runtime preparation requires a command catalog")
	}
	capabilities := catalog.Capabilities(ctx, CommandContext{
		Source:                "agent-runtime",
		WorkspaceID:           strings.TrimSpace(workspaceID),
		SkipCapabilityFilters: true,
		IncludeIntegrationCapabilities: projectionRequestsIntegration(
			projections,
		),
	})
	var projection *CommandCapabilityProjection
	if len(projections) > 0 {
		projection = projections[0]
	}
	projected, err := projectCommandCapabilities(capabilities, projection)
	if err != nil {
		return nil, err
	}
	return newCommandResolver(cliName, projected)
}

func projectionRequestsIntegration(
	projections []*CommandCapabilityProjection,
) bool {
	return len(projections) > 0 &&
		projections[0] != nil &&
		len(normalizedCommandCapabilityIDs(
			projections[0].IncludeIntegrationIDs,
		)) > 0
}

func commandVisibleToAgent(capability CommandCapability) bool {
	visibility := strings.TrimSpace(capability.Visibility)
	return visibility == "" || visibility == "public"
}

func projectCommandCapabilities(
	capabilities []CommandCapability,
	projection *CommandCapabilityProjection,
) ([]CommandCapability, error) {
	if projection == nil {
		return capabilities, nil
	}
	included := normalizedCommandCapabilityIDs(projection.IncludeIntegrationIDs)
	excluded := normalizedCommandCapabilityIDs(projection.ExcludeIDs)
	allowed := normalizedCommandCapabilityIDs(projection.AllowedIDs)
	foundIncluded := make(map[string]struct{}, len(included))
	foundAllowed := make(map[string]struct{}, len(allowed))
	projected := make([]CommandCapability, 0, len(capabilities))
	for _, capability := range capabilities {
		id := strings.TrimSpace(capability.ID)
		if len(allowed) > 0 {
			if _, accepted := allowed[id]; !accepted {
				continue
			}
		}
		if _, denied := excluded[id]; denied {
			continue
		}
		if _, requested := included[id]; requested {
			capability.Visibility = "public"
			foundIncluded[id] = struct{}{}
		}
		projected = append(projected, capability)
		if _, required := allowed[id]; required {
			foundAllowed[id] = struct{}{}
		}
	}
	for id := range allowed {
		if _, found := foundAllowed[id]; !found {
			return nil, fmt.Errorf(
				"agent command capability projection requires unavailable allowed command %q",
				id,
			)
		}
	}
	for id := range included {
		if _, found := foundIncluded[id]; !found {
			return nil, fmt.Errorf(
				"agent command capability projection requires unavailable command %q",
				id,
			)
		}
	}
	return projected, nil
}

func normalizedCommandCapabilityIDs(values []string) map[string]struct{} {
	normalized := make(map[string]struct{}, len(values))
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			normalized[value] = struct{}{}
		}
	}
	return normalized
}

// Wait execution adds a wrapper-owned timeout input. It is part of the
// invocation contract even though app handlers do not receive it.
func executionFacingInputSchema(mode string, schema map[string]any) map[string]any {
	if strings.TrimSpace(mode) != "wait" {
		return schema
	}
	projected := cloneSchemaMap(schema)
	projected["type"] = "object"
	properties := cloneSchemaMap(mapSchemaValue(schema["properties"]))
	if _, exists := properties["timeout-ms"]; !exists {
		properties["timeout-ms"] = map[string]any{
			"type":        "integer",
			"description": "Maximum total wait in milliseconds; omit to wait until the command reaches a stop point.",
		}
	}
	projected["properties"] = properties
	return projected
}

func cloneSchemaMap(source map[string]any) map[string]any {
	if source == nil {
		return nil
	}
	clone := make(map[string]any, len(source))
	for key, value := range source {
		clone[key] = cloneSchemaValue(value)
	}
	return clone
}

func cloneSchemaValue(value any) any {
	switch typed := value.(type) {
	case map[string]any:
		return cloneSchemaMap(typed)
	case []any:
		clone := make([]any, len(typed))
		for index, item := range typed {
			clone[index] = cloneSchemaValue(item)
		}
		return clone
	case []map[string]any:
		clone := make([]map[string]any, len(typed))
		for index, item := range typed {
			clone[index] = cloneSchemaMap(item)
		}
		return clone
	case []string:
		return append([]string(nil), typed...)
	default:
		return value
	}
}

func commandPath(path []string) string {
	return strings.Join(normalizedCommandPath(path), " ")
}

func inputDetailsForCommand(_ string, schema map[string]any) string {
	properties := mapSchemaValue(schema["properties"])
	if len(properties) == 0 {
		return ""
	}
	required := make(map[string]bool)
	for _, name := range stringSliceSchemaValue(schema["required"]) {
		required[strings.TrimSpace(name)] = true
	}
	names := make([]string, 0, len(properties))
	for name := range properties {
		if name = strings.TrimSpace(name); name != "" {
			names = append(names, name)
		}
	}
	sortCommandInputs(names, required)
	parts := make([]string, 0, len(names))
	for _, name := range names {
		property := mapSchemaValue(properties[name])
		detail := "--" + name
		if typ := schemaTypeLabel(property); typ != "" {
			detail += " <" + typ + ">"
		}
		qualifiers := []string{"optional"}
		if required[name] {
			qualifiers[0] = "required"
		}
		if enum := stringSliceSchemaValue(property["enum"]); len(enum) > 0 {
			qualifiers = append(qualifiers, "values: "+strings.Join(enum, "|"))
		}
		if defaultValue, ok := property["default"]; ok {
			if text := strings.TrimSpace(fmt.Sprint(defaultValue)); text != "" {
				qualifiers = append(qualifiers, "default: "+text)
			}
		}
		detail += " (" + strings.Join(qualifiers, "; ") + ")"
		if description := strings.TrimSpace(asSchemaString(property["description"])); description != "" {
			detail += " - " + description
		}
		parts = append(parts, detail)
	}
	return strings.Join(parts, "; ")
}

func sortCommandInputs(names []string, required map[string]bool) {
	sort.SliceStable(names, func(left int, right int) bool {
		if required[names[left]] != required[names[right]] {
			return required[names[left]]
		}
		return names[left] < names[right]
	})
}

func schemaTypeLabel(property map[string]any) string {
	switch strings.TrimSpace(asSchemaString(property["type"])) {
	case "integer", "number":
		return "number"
	case "boolean":
		return "true|false"
	case "array", "object":
		return "json"
	default:
		return strings.TrimSpace(asSchemaString(property["type"]))
	}
}

func mapSchemaValue(value any) map[string]any {
	if typed, ok := value.(map[string]any); ok {
		return typed
	}
	return nil
}

func asSchemaString(value any) string {
	text, _ := value.(string)
	return text
}

func schemaHasInput(schema map[string]any, name string) bool {
	_, ok := mapSchemaValue(schema["properties"])[strings.TrimSpace(name)]
	return ok
}

func stringSliceSchemaValue(value any) []string {
	switch typed := value.(type) {
	case []string:
		return append([]string(nil), typed...)
	case []any:
		result := make([]string, 0, len(typed))
		for _, item := range typed {
			if text, ok := item.(string); ok {
				result = append(result, text)
			}
		}
		return result
	default:
		return nil
	}
}

func normalizeCLICommandName(cliName string) string {
	if cliName = strings.TrimSpace(cliName); cliName != "" {
		return cliName
	}
	return "tutti"
}

func firstNonEmptyText(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
