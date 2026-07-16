package computer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
	computersvc "github.com/tutti-os/tutti/services/tuttid/service/computer"
)

type toolNameInput struct {
	Name string `cli:"name" validate:"required" description:"Native cua-driver tool name from computer tool list."`
}

type toolCallInput struct {
	Name          string `cli:"name" validate:"required" description:"Native cua-driver tool name from computer tool list."`
	ArgumentsJSON string `cli:"arguments-json" description:"Tool arguments as one JSON object. Defaults to {}."`
}

type toolListResult struct {
	Catalog computersvc.ToolCatalog
	Tools   []computersvc.ToolDefinition
}

func (p Provider) newToolListCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[struct{}]{
		ID:          "computer.tool.list",
		Path:        []string{"computer", "tool", "list"},
		Summary:     "List native computer tools",
		Description: "List the live cua-driver catalog with Tutti's authorization decision for every tool.",
		Kind:        framework.KindList,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[struct{}](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeTable,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			Table: &framework.TableOutputSpec{
				Columns: []cliservice.TableColumn{
					{Key: "name", Label: "NAME"},
					{Key: "allowed", Label: "ALLOWED"},
					{Key: "capabilities", Label: "CAPABILITIES"},
					{Key: "effects", Label: "EFFECTS"},
					{Key: "denialReason", Label: "DENIAL REASON"},
				},
				Rows: func(result any) []map[string]any {
					return toolListRows(result.(toolListResult).Tools)
				},
			},
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					listed := result.(toolListResult)
					return map[string]any{
						"schemaVersion":     listed.Catalog.SchemaVersion,
						"capabilityVersion": listed.Catalog.CapabilityVersion,
						"tools":             toolDetails(listed.Tools),
					}
				},
			},
			ListCompact: true,
		},
		Run: func(ctx context.Context, invoke framework.InvokeContext, _ struct{}) (any, error) {
			catalog, err := p.listNativeTools(ctx, invoke.WorkspaceID)
			if err != nil {
				return nil, err
			}
			return toolListResult{Catalog: catalog, Tools: catalog.Tools}, nil
		},
	})
}

func (p Provider) newToolDescribeCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[toolNameInput]{
		ID:          "computer.tool.describe",
		Path:        []string{"computer", "tool", "describe"},
		Summary:     "Describe a native computer tool",
		Description: "Return one live cua-driver tool definition and Tutti's authorization decision.",
		Kind:        framework.KindGet,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[toolNameInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewDetail,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewDetail: func(result any) map[string]any {
					return toolDetail(result.(computersvc.ToolDefinition))
				},
			},
		},
		Run: func(ctx context.Context, invoke framework.InvokeContext, input toolNameInput) (any, error) {
			catalog, err := p.listNativeTools(ctx, invoke.WorkspaceID)
			if err != nil {
				return nil, err
			}
			return catalogTool(catalog.Tools, input.Name)
		},
	})
}

func (p Provider) newToolCallCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[toolCallInput]{
		ID:          "computer.tool.call",
		Path:        []string{"computer", "tool", "call"},
		Summary:     "Call a native computer tool",
		Description: "Ask the computer service to authorize and call one live cua-driver tool using its native JSON arguments.",
		Kind:        framework.KindAction,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[toolCallInput](),
		Output:      nativeToolOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input toolCallInput) (any, error) {
			catalog, err := p.listNativeTools(ctx, invoke.WorkspaceID)
			if err != nil {
				return nil, err
			}
			tool, err := catalogTool(catalog.Tools, input.Name)
			if err != nil {
				return nil, err
			}
			arguments, err := parseToolArguments(input.ArgumentsJSON)
			if err != nil {
				return nil, err
			}
			return p.computer.CallNativeTool(ctx, invoke.WorkspaceID, "", tool.Name, arguments)
		},
	})
}

func nativeToolOutputSpec() framework.OutputSpec {
	return framework.OutputSpec{
		DefaultMode: cliservice.OutputModePlain,
		DefaultView: framework.ViewSummary,
		JSON:        true,
		RawJSON:     true,
		RawJSONReason: "native computer tool results preserve the complete MCP result envelope, " +
			"including future content variants",
		PlainText: func(result any) string {
			return result.(computersvc.ToolResult).Text
		},
		JSONViews: map[framework.OutputView]func(any) map[string]any{
			framework.ViewSummary: func(result any) map[string]any {
				toolResult := result.(computersvc.ToolResult)
				if len(toolResult.Raw) > 0 {
					var native map[string]any
					decoder := json.NewDecoder(bytes.NewReader(toolResult.Raw))
					decoder.UseNumber()
					if err := decoder.Decode(&native); err == nil && native != nil {
						return native
					}
				}
				return plainToolResultJSON(toolResult)
			},
		},
	}
}

func (p Provider) listNativeTools(ctx context.Context, workspaceID string) (computersvc.ToolCatalog, error) {
	if p.computer == nil {
		return computersvc.ToolCatalog{}, errComputerUnavailable
	}
	return p.computer.ListTools(ctx, workspaceID, "")
}

func parseToolArguments(value string) (map[string]any, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		value = "{}"
	}
	decoder := json.NewDecoder(strings.NewReader(value))
	decoder.UseNumber()
	var arguments map[string]any
	if err := decoder.Decode(&arguments); err != nil {
		return nil, fmt.Errorf("%w: arguments-json must be a JSON object: %v", cliservice.ErrInvalidInput, err)
	}
	if arguments == nil {
		return nil, fmt.Errorf("%w: arguments-json must be a JSON object", cliservice.ErrInvalidInput)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("%w: arguments-json must contain one JSON object", cliservice.ErrInvalidInput)
	}
	return arguments, nil
}

func catalogTool(tools []computersvc.ToolDefinition, name string) (computersvc.ToolDefinition, error) {
	name = strings.TrimSpace(name)
	for _, tool := range tools {
		if tool.Name != name {
			continue
		}
		return tool, nil
	}
	return computersvc.ToolDefinition{}, fmt.Errorf("%w: computer tool %q is not in the live cua-driver catalog", cliservice.ErrInvalidInput, name)
}

func toolListRows(tools []computersvc.ToolDefinition) []map[string]any {
	rows := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		rows = append(rows, map[string]any{
			"name":         tool.Name,
			"allowed":      tool.Allowed,
			"capabilities": strings.Join(tool.Capabilities, ","),
			"effects":      toolEffects(tool.Annotations),
			"denialReason": tool.DenialReason,
		})
	}
	return rows
}

func toolDetails(tools []computersvc.ToolDefinition) []map[string]any {
	details := make([]map[string]any, 0, len(tools))
	for _, tool := range tools {
		details = append(details, toolDetail(tool))
	}
	return details
}

func toolDetail(tool computersvc.ToolDefinition) map[string]any {
	return map[string]any{
		"name":         tool.Name,
		"description":  tool.Description,
		"inputSchema":  tool.InputSchema,
		"capabilities": tool.Capabilities,
		"allowed":      tool.Allowed,
		"denialReason": tool.DenialReason,
		"annotations": map[string]any{
			"readOnlyHint":    tool.Annotations.ReadOnly,
			"destructiveHint": tool.Annotations.Destructive,
			"idempotentHint":  tool.Annotations.Idempotent,
			"openWorldHint":   tool.Annotations.OpenWorld,
		},
	}
}

func toolEffects(annotations computersvc.ToolAnnotations) string {
	effects := make([]string, 0, 3)
	if annotations.ReadOnly {
		effects = append(effects, "read-only")
	}
	if annotations.Destructive {
		effects = append(effects, "destructive")
	}
	if annotations.OpenWorld {
		effects = append(effects, "open-world")
	}
	if len(effects) == 0 {
		return "local mutation"
	}
	return strings.Join(effects, ",")
}
