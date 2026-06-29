package workbenchapps

import (
	"context"
	"sort"
	"strings"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

// CommandCatalog is the live capability catalog the lookup queries on demand.
// It is satisfied by *cliservice.Registry (the fully merged builtin + app catalog).
type CommandCatalog interface {
	Capabilities(context.Context, cliservice.InvokeContext) []cliservice.Capability
}

// NewCommandsCommand builds the `app commands` lookup. It lists the CLI commands
// a workspace app registers, on demand, so those per-app commands no longer have
// to be inlined into every agent turn's system prompt. Use --app-id <id> for one
// app, or --all for every app.
func NewCommandsCommand(workspaces cliservice.WorkspaceCatalog, catalog CommandCatalog) cliservice.Command {
	columns := []cliservice.TableColumn{
		{Key: "appId", Label: "App ID"},
		{Key: "command", Label: "Command"},
		{Key: "summary", Label: "Summary"},
		{Key: "required", Label: "Required"},
	}
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:      appID + ".app.commands",
			Path:    []string{"app", "commands"},
			Summary: "List a workspace app's CLI commands",
			Description: "List the CLI commands a workspace app registers. Pass --app-id <app id> for one app, " +
				"or --all for every app. Workspace app commands are looked up on demand here instead of being " +
				"listed in full in the always-on session policy.",
			Visibility: cliservice.CapabilityVisibilityPublic,
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"app-id": map[string]any{
						"type":        "string",
						"description": "Workspace app id to list CLI commands for. Required unless --all is set.",
					},
					"all": map[string]any{
						"type":        "boolean",
						"description": "List CLI commands for every workspace app instead of a single app.",
					},
				},
			},
			Output: cliservice.CapabilityOutput{
				DefaultMode: cliservice.OutputModeTable,
				JSON:        true,
				Table:       &cliservice.TableOutput{Columns: columns},
			},
		},
		Handler: runAppCommands(workspaces, catalog, columns),
	}
}

func runAppCommands(
	workspaces cliservice.WorkspaceCatalog,
	catalog CommandCatalog,
	columns []cliservice.TableColumn,
) cliservice.Handler {
	return func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
		workspaceID, err := cliservice.ResolveWorkspaceID(ctx, workspaces, request.Context.WorkspaceID)
		if err != nil {
			return cliservice.CommandOutput{}, err
		}
		appID, _, err := cliservice.StringInput(request.Input, "app-id")
		if err != nil {
			return cliservice.CommandOutput{}, err
		}
		all, err := boolInput(request.Input, "all")
		if err != nil {
			return cliservice.CommandOutput{}, err
		}
		if all && appID != "" {
			// --all and --app-id are mutually exclusive.
			return cliservice.CommandOutput{}, cliservice.InvalidInputKeyError("app-id")
		}
		if !all && appID == "" {
			return cliservice.CommandOutput{}, cliservice.MissingRequiredInputError("app-id")
		}

		var capabilities []cliservice.Capability
		if catalog != nil {
			capabilities = catalog.Capabilities(ctx, cliservice.InvokeContext{
				Source:                         firstNonEmptyString(request.Context.Source, "agent-runtime"),
				WorkspaceID:                    workspaceID,
				AgentSessionID:                 request.Context.AgentSessionID,
				IncludeIntegrationCapabilities: request.Context.IncludeIntegrationCapabilities,
			})
		}

		apps := groupAppCommands(capabilities, appID, all)

		rows := make([]map[string]any, 0)
		appValues := make([]map[string]any, 0, len(apps))
		totalCommands := 0
		for _, app := range apps {
			commandValues := make([]map[string]any, 0, len(app.Commands))
			for _, command := range app.Commands {
				totalCommands++
				rows = append(rows, map[string]any{
					"appId":    app.ID,
					"command":  command.Command,
					"summary":  command.Summary,
					"required": strings.Join(command.Required, ", "),
				})
				commandValues = append(commandValues, map[string]any{
					"id":          command.ID,
					"command":     command.Command,
					"summary":     command.Summary,
					"description": command.Description,
					"required":    command.Required,
					"visibility":  command.Visibility,
				})
			}
			appValues = append(appValues, map[string]any{
				"appId":          app.ID,
				"appName":        app.Name,
				"appDescription": app.Description,
				"commands":       commandValues,
			})
		}

		return cliservice.CommandOutput{
			Kind:    cliservice.OutputModeTable,
			Columns: columns,
			Rows:    rows,
			Value: map[string]any{
				"apps":          appValues,
				"totalApps":     len(appValues),
				"totalCommands": totalCommands,
			},
		}, nil
	}
}

type appCommandGroup struct {
	ID          string
	Name        string
	Description string
	Commands    []appCommandEntry
}

type appCommandEntry struct {
	ID          string
	Command     string
	Summary     string
	Description string
	Required    []string
	Visibility  string
}

// groupAppCommands filters the catalog to app-registered capabilities (optionally
// for a single app id) and groups them by app, deterministically ordered.
func groupAppCommands(capabilities []cliservice.Capability, appID string, all bool) []appCommandGroup {
	appID = strings.TrimSpace(appID)
	byApp := map[string]*appCommandGroup{}
	order := make([]string, 0)
	for _, capability := range capabilities {
		if capability.Source.Kind != cliservice.CapabilitySourceApp {
			continue
		}
		id := strings.TrimSpace(capability.Source.AppID)
		if id == "" {
			continue
		}
		if !all && id != appID {
			continue
		}
		group, ok := byApp[id]
		if !ok {
			group = &appCommandGroup{
				ID:          id,
				Name:        firstNonEmptyString(capability.Source.AppName, id),
				Description: firstNonEmptyString(capability.Source.AppDescription, capability.Source.CLIDescription),
			}
			byApp[id] = group
			order = append(order, id)
		}
		group.Commands = append(group.Commands, appCommandEntry{
			ID:          strings.TrimSpace(capability.ID),
			Command:     commandPathString(capability.Path),
			Summary:     firstNonEmptyString(capability.Summary, capability.ID),
			Description: strings.TrimSpace(capability.Description),
			Required:    requiredInputNames(capability.InputSchema),
			Visibility:  string(capability.Visibility),
		})
	}
	sort.Strings(order)
	groups := make([]appCommandGroup, 0, len(order))
	for _, id := range order {
		group := byApp[id]
		sort.SliceStable(group.Commands, func(i, j int) bool {
			return group.Commands[i].ID < group.Commands[j].ID
		})
		groups = append(groups, *group)
	}
	return groups
}

func commandPathString(path []string) string {
	parts := make([]string, 0, len(path))
	for _, part := range path {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			parts = append(parts, trimmed)
		}
	}
	return strings.Join(parts, " ")
}

// requiredInputNames extracts the "required" array from a command InputSchema,
// tolerating both []string and []any (decoded JSON) shapes.
func requiredInputNames(schema map[string]any) []string {
	if schema == nil {
		return nil
	}
	switch value := schema["required"].(type) {
	case []string:
		return append([]string(nil), value...)
	case []any:
		names := make([]string, 0, len(value))
		for _, item := range value {
			if text, ok := item.(string); ok {
				if trimmed := strings.TrimSpace(text); trimmed != "" {
					names = append(names, trimmed)
				}
			}
		}
		return names
	default:
		return nil
	}
}

// boolInput reads an optional boolean flag, tolerating bool or string values.
func boolInput(input map[string]any, key string) (bool, error) {
	value, ok := input[key]
	if !ok || value == nil {
		return false, nil
	}
	switch typed := value.(type) {
	case bool:
		return typed, nil
	case string:
		switch strings.ToLower(strings.TrimSpace(typed)) {
		case "", "1", "true", "yes", "on":
			// A bare flag (`--all`) may arrive as an empty string; treat as true.
			return true, nil
		case "0", "false", "no", "off":
			return false, nil
		default:
			return false, cliservice.InvalidInputKeyError(key)
		}
	default:
		return false, cliservice.InvalidInputKeyError(key)
	}
}
