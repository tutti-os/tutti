package core

import (
	"strings"
	"time"
)

func BuildCommands(manifest Manifest, options CommandBuildOptions) []Command {
	commands := make([]Command, 0, len(manifest.Commands))
	for _, command := range manifest.Commands {
		commands = append(commands, Command{
			Capability: Capability{
				ID:          CommandID(options.AppID, manifest.Scope, command.Path),
				Path:        append([]string{manifest.Scope}, command.Path...),
				Summary:     strings.TrimSpace(command.Summary),
				Description: strings.TrimSpace(command.Description),
				Visibility:  NormalizeVisibility(command.Visibility),
				InputSchema: CloneSchema(command.InputSchema),
				Output: CapabilityOutput{
					DefaultMode: command.Output.DefaultMode,
					JSON:        command.Output.JSON,
					Table:       tableOutput(command.Output.Table),
				},
				Execution:        commandExecution(command.Execution),
				HandlerTimeoutMs: NormalizedTimeoutMs(command.Handler.TimeoutMs),
				Source: CapabilitySource{
					Kind:              CapabilitySourceApp,
					AppID:             strings.TrimSpace(options.AppID),
					AppName:           strings.TrimSpace(options.AppName),
					IconURL:           strings.TrimSpace(options.IconURL),
					CLIDescription:    strings.TrimSpace(manifest.Description),
					AppDescription:    strings.TrimSpace(options.AppDescription),
					DocumentationFile: strings.TrimSpace(options.DocumentationFile),
					DocumentationPath: strings.TrimSpace(options.DocumentationPath),
				},
			},
			Manifest: command,
			Timeout:  time.Duration(NormalizedTimeoutMs(command.Handler.TimeoutMs)) * time.Millisecond,
		})
	}
	return commands
}

func commandExecution(execution *ManifestCommandExecution) *CommandExecution {
	if execution == nil {
		return nil
	}
	return &CommandExecution{Mode: execution.Mode}
}

func CommandID(appID string, scope string, path []string) string {
	parts := []string{"app", strings.TrimSpace(appID), strings.TrimSpace(scope)}
	parts = append(parts, path...)
	return strings.Join(parts, ".")
}

func tableOutput(output *ManifestTableOutput) *TableOutput {
	if output == nil {
		return nil
	}
	return &TableOutput{Columns: append([]TableColumn(nil), output.Columns...)}
}

func CloneSchema(schema map[string]any) map[string]any {
	if len(schema) == 0 {
		return nil
	}
	cloned := make(map[string]any, len(schema))
	for key, value := range schema {
		cloned[key] = value
	}
	return cloned
}
