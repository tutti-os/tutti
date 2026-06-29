package core

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	ManifestSchemaVersion = "tutti.app.cli.v1"
	maxManifestBytes      = 256 * 1024
	DefaultTimeoutMs      = 30000
	MinTimeoutMs          = 1000
	MaxTimeoutMs          = 600000
)

const (
	CommandVisibilityPublic      CommandVisibility = "public"
	CommandVisibilityIntegration CommandVisibility = "integration"
)

var segmentPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`)

type Manifest struct {
	SchemaVersion string                 `json:"schemaVersion"`
	Scope         string                 `json:"scope"`
	Description   string                 `json:"description,omitempty"`
	Documentation *ManifestDocumentation `json:"documentation,omitempty"`
	Commands      []ManifestCommand      `json:"commands"`
}

type ManifestDocumentation struct {
	File string `json:"file"`
}

type ManifestCommand struct {
	Path        []string               `json:"path"`
	Summary     string                 `json:"summary"`
	Description string                 `json:"description,omitempty"`
	Visibility  CommandVisibility      `json:"visibility,omitempty"`
	InputSchema map[string]any         `json:"inputSchema,omitempty"`
	Output      ManifestCommandOutput  `json:"output"`
	Handler     ManifestCommandHandler `json:"handler"`
}

type ManifestCommandOutput struct {
	DefaultMode OutputMode           `json:"defaultMode"`
	JSON        bool                 `json:"json"`
	Table       *ManifestTableOutput `json:"table,omitempty"`
}

type ManifestTableOutput struct {
	Columns []TableColumn `json:"columns"`
}

type ManifestCommandHandler struct {
	Kind      string `json:"kind"`
	Method    string `json:"method"`
	Path      string `json:"path"`
	TimeoutMs int    `json:"timeoutMs,omitempty"`
}

func ReadManifest(path string) (Manifest, error) {
	file, err := os.Open(path)
	if err != nil {
		return Manifest{}, fmt.Errorf("read cli manifest: %w", err)
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return Manifest{}, fmt.Errorf("stat cli manifest: %w", err)
	}
	if info.Size() > maxManifestBytes {
		return Manifest{}, fmt.Errorf("cli manifest exceeds maximum size %d", maxManifestBytes)
	}

	decoder := json.NewDecoder(file)
	decoder.UseNumber()
	var manifest Manifest
	if err := decoder.Decode(&manifest); err != nil {
		return Manifest{}, fmt.Errorf("parse cli manifest json: %w", err)
	}
	if err := ValidateManifest(manifest); err != nil {
		return Manifest{}, err
	}
	return manifest, nil
}

func ValidateManifest(manifest Manifest) error {
	if !isSupportedManifestSchemaVersion(strings.TrimSpace(manifest.SchemaVersion)) {
		return fmt.Errorf("unsupported cli manifest schema version %q", manifest.SchemaVersion)
	}
	scope := strings.TrimSpace(manifest.Scope)
	if err := validateSegment(scope, "scope"); err != nil {
		return err
	}
	if manifest.Documentation != nil {
		if err := validatePackageRelativePath(manifest.Documentation.File, "documentation.file"); err != nil {
			return err
		}
	}
	if len(manifest.Commands) == 0 {
		return errors.New("cli manifest commands is required")
	}

	seenPaths := map[string]struct{}{}
	for index, command := range manifest.Commands {
		location := fmt.Sprintf("commands[%d]", index)
		if len(command.Path) == 0 {
			return fmt.Errorf("cli manifest %s.path is required", location)
		}
		if command.Path[0] == scope {
			return fmt.Errorf("cli manifest %s.path must not repeat scope", location)
		}
		for segmentIndex, segment := range command.Path {
			if err := validateSegment(strings.TrimSpace(segment), fmt.Sprintf("%s.path[%d]", location, segmentIndex)); err != nil {
				return err
			}
		}
		pathKey := strings.Join(command.Path, ".")
		if _, ok := seenPaths[pathKey]; ok {
			return fmt.Errorf("cli manifest command path %q is duplicated", strings.Join(command.Path, " "))
		}
		seenPaths[pathKey] = struct{}{}

		if strings.TrimSpace(command.Summary) == "" {
			return fmt.Errorf("cli manifest %s.summary is required", location)
		}
		if err := validateVisibility(command.Visibility, location+".visibility"); err != nil {
			return err
		}
		if err := validateInputSchema(command.InputSchema, location+".inputSchema"); err != nil {
			return err
		}
		if err := validateOutput(command.Output, location+".output"); err != nil {
			return err
		}
		if err := validateHandler(command.Handler, location+".handler"); err != nil {
			return err
		}
	}
	return nil
}

func NormalizeVisibility(visibility CommandVisibility) CommandVisibility {
	switch CommandVisibility(strings.TrimSpace(string(visibility))) {
	case "", CommandVisibilityPublic:
		return CommandVisibilityPublic
	case CommandVisibilityIntegration:
		return CommandVisibilityIntegration
	default:
		return visibility
	}
}

func validateVisibility(visibility CommandVisibility, location string) error {
	switch NormalizeVisibility(visibility) {
	case CommandVisibilityPublic, CommandVisibilityIntegration:
		return nil
	default:
		return fmt.Errorf("cli manifest %s must be public or integration", location)
	}
}

func isSupportedManifestSchemaVersion(schemaVersion string) bool {
	return schemaVersion == ManifestSchemaVersion
}

func validateSegment(segment string, location string) error {
	if segment == "" {
		return fmt.Errorf("cli manifest %s is required", location)
	}
	if strings.HasPrefix(segment, "--") || strings.Contains(segment, " ") || !segmentPattern.MatchString(segment) {
		return fmt.Errorf("cli manifest %s must contain lowercase letters, numbers, and hyphen only", location)
	}
	return nil
}

func validatePackageRelativePath(value string, location string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return fmt.Errorf("cli manifest %s is required", location)
	}
	if filepath.IsAbs(value) || strings.HasPrefix(value, `\`) {
		return fmt.Errorf("cli manifest %s must be a relative package path", location)
	}
	for _, part := range strings.FieldsFunc(value, func(char rune) bool {
		return char == '/' || char == '\\'
	}) {
		if part == ".." {
			return fmt.Errorf("cli manifest %s must not contain parent path segments", location)
		}
	}
	return nil
}

func validateInputSchema(schema map[string]any, location string) error {
	if len(schema) == 0 {
		return nil
	}
	if schemaType(schema) != "object" {
		return fmt.Errorf("cli manifest %s.type must be object", location)
	}
	properties, ok := schema["properties"].(map[string]any)
	if !ok {
		return fmt.Errorf("cli manifest %s.properties is required", location)
	}
	for name, property := range properties {
		if err := validateSegment(strings.TrimSpace(name), location+".properties"); err != nil {
			return err
		}
		propertyMap, ok := property.(map[string]any)
		if !ok {
			return fmt.Errorf("cli manifest %s.properties.%s must be an object", location, name)
		}
		propertyType := schemaType(propertyMap)
		switch propertyType {
		case "string", "boolean", "integer":
		default:
			return fmt.Errorf("cli manifest %s.properties.%s.type must be string, boolean, or integer", location, name)
		}
		for key := range propertyMap {
			if key != "type" && key != "description" && key != "enum" && key != "default" {
				return fmt.Errorf("cli manifest %s.properties.%s has unsupported key %q", location, name, key)
			}
		}
		if enum, ok := propertyMap["enum"]; ok {
			if err := validateInputSchemaEnum(propertyType, enum, fmt.Sprintf("%s.properties.%s.enum", location, name)); err != nil {
				return err
			}
		}
		if defaultValue, ok := propertyMap["default"]; ok {
			if err := validateInputSchemaValue(propertyType, defaultValue, fmt.Sprintf("%s.properties.%s.default", location, name)); err != nil {
				return err
			}
		}
	}
	for _, required := range RequiredNames(schema) {
		if _, ok := properties[required]; !ok {
			return fmt.Errorf("cli manifest %s.required contains unknown property %q", location, required)
		}
	}
	for key := range schema {
		if key != "type" && key != "properties" && key != "required" {
			return fmt.Errorf("cli manifest %s has unsupported key %q", location, key)
		}
	}
	return nil
}

func validateInputSchemaEnum(typeName string, value any, location string) error {
	items, ok := value.([]any)
	if !ok {
		return fmt.Errorf("cli manifest %s must be an array", location)
	}
	for index, item := range items {
		if err := validateInputSchemaValue(typeName, item, fmt.Sprintf("%s[%d]", location, index)); err != nil {
			return err
		}
	}
	return nil
}

func validateInputSchemaValue(typeName string, value any, location string) error {
	switch typeName {
	case "string":
		if _, ok := value.(string); !ok {
			return fmt.Errorf("cli manifest %s must be a string", location)
		}
	case "boolean":
		if _, ok := value.(bool); !ok {
			return fmt.Errorf("cli manifest %s must be a boolean", location)
		}
	case "integer":
		switch typed := value.(type) {
		case int, int64:
			return nil
		case float64:
			if typed == float64(int64(typed)) {
				return nil
			}
		case json.Number:
			if _, err := typed.Int64(); err == nil {
				return nil
			}
		}
		return fmt.Errorf("cli manifest %s must be an integer", location)
	}
	return nil
}

func validateOutput(output ManifestCommandOutput, location string) error {
	switch output.DefaultMode {
	case OutputModeJSON:
		if !output.JSON {
			return fmt.Errorf("cli manifest %s.json must be true when defaultMode is json", location)
		}
	case OutputModeTable:
		if output.Table == nil || len(output.Table.Columns) == 0 {
			return fmt.Errorf("cli manifest %s.table.columns is required when defaultMode is table", location)
		}
	case "":
		return fmt.Errorf("cli manifest %s.defaultMode is required", location)
	default:
		return fmt.Errorf("cli manifest %s.defaultMode must be json or table", location)
	}
	if output.Table != nil {
		seen := map[string]struct{}{}
		for _, column := range output.Table.Columns {
			key := strings.TrimSpace(column.Key)
			if err := validateSegment(key, location+".table.columns.key"); err != nil {
				return err
			}
			if strings.TrimSpace(column.Label) == "" {
				return fmt.Errorf("cli manifest %s.table.columns.label is required", location)
			}
			if _, ok := seen[key]; ok {
				return fmt.Errorf("cli manifest %s.table.columns key %q is duplicated", location, key)
			}
			seen[key] = struct{}{}
		}
	}
	return nil
}

func validateHandler(handler ManifestCommandHandler, location string) error {
	if strings.TrimSpace(handler.Kind) != "http" {
		return fmt.Errorf("cli manifest %s.kind must be http", location)
	}
	if strings.TrimSpace(handler.Method) != "POST" {
		return fmt.Errorf("cli manifest %s.method must be POST", location)
	}
	handlerPath := strings.TrimSpace(handler.Path)
	if !strings.HasPrefix(handlerPath, "/tutti/cli/") {
		return fmt.Errorf("cli manifest %s.path must start with /tutti/cli/", location)
	}
	timeoutMs := NormalizedTimeoutMs(handler.TimeoutMs)
	if timeoutMs < MinTimeoutMs || timeoutMs > MaxTimeoutMs {
		return fmt.Errorf("cli manifest %s.timeoutMs must be between %d and %d", location, MinTimeoutMs, MaxTimeoutMs)
	}
	return nil
}

func NormalizedTimeoutMs(value int) int {
	if value == 0 {
		return DefaultTimeoutMs
	}
	return value
}

func schemaType(schema map[string]any) string {
	value, _ := schema["type"].(string)
	return strings.TrimSpace(value)
}

func RequiredNames(schema map[string]any) []string {
	value, ok := schema["required"]
	if !ok {
		return nil
	}
	switch typed := value.(type) {
	case []string:
		return append([]string(nil), typed...)
	case []any:
		names := make([]string, 0, len(typed))
		for _, item := range typed {
			if name, ok := item.(string); ok {
				names = append(names, name)
			}
		}
		return names
	default:
		return nil
	}
}

func PackageRelativePath(packageDir string, manifestPath string) (string, error) {
	manifestPath = strings.TrimSpace(manifestPath)
	if manifestPath == "" {
		return "", errors.New("cli manifest path is required")
	}
	if filepath.IsAbs(manifestPath) || strings.HasPrefix(manifestPath, `\`) {
		return "", errors.New("cli manifest path must be relative")
	}
	for _, part := range strings.FieldsFunc(manifestPath, func(char rune) bool {
		return char == '/' || char == '\\'
	}) {
		if part == ".." {
			return "", errors.New("cli manifest path must not contain parent path segments")
		}
	}
	return filepath.Join(packageDir, filepath.FromSlash(manifestPath)), nil
}
