package framework

import (
	"context"
	"fmt"
	"strings"

	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

func Register[T any](spec CommandSpec[T]) cliservice.Command {
	if err := ValidateSpec(spec); err != nil {
		panic(fmt.Sprintf("invalid cli command spec %q: %v", strings.TrimSpace(spec.ID), err))
	}
	return cliservice.Command{
		Capability: cliservice.Capability{
			ID:          strings.TrimSpace(spec.ID),
			Path:        spec.Path,
			Summary:     strings.TrimSpace(spec.Summary),
			Description: strings.TrimSpace(spec.Description),
			Visibility:  spec.Visibility,
			InputSchema: Schema(spec.Inputs),
			Output: cliservice.CapabilityOutput{
				DefaultMode: spec.Output.DefaultMode,
				JSON:        spec.Output.JSON,
				Table:       tableOutput(spec.Output.Table),
			},
			Execution: spec.Execution,
			Source:    spec.Source,
		},
		Handler: func(ctx context.Context, request cliservice.InvokeRequest) (cliservice.CommandOutput, error) {
			workspaceID, err := resolveWorkspace(ctx, spec, request)
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			input, err := BindInput[T](spec.Inputs, request.Input)
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			result, err := spec.Run(ctx, InvokeContext{Request: request, WorkspaceID: workspaceID}, input)
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			output, err := FormatOutput(spec.Output, request.OutputMode, result)
			if err != nil {
				return cliservice.CommandOutput{}, err
			}
			if spec.Output.Warnings != nil {
				output.Warnings = spec.Output.Warnings(result)
			}
			if spec.Output.Continuation != nil {
				output.Continuation = spec.Output.Continuation(result)
			}
			return output, nil
		},
	}
}

func resolveWorkspace[T any](ctx context.Context, spec CommandSpec[T], request cliservice.InvokeRequest) (string, error) {
	switch spec.Workspace {
	case "", WorkspaceStartupDefault, WorkspaceRequired:
		if spec.Workspaces == nil {
			return strings.TrimSpace(request.Context.WorkspaceID), nil
		}
		return cliservice.ResolveWorkspaceID(ctx, spec.Workspaces, request.Context.WorkspaceID)
	case WorkspaceOptional:
		if strings.TrimSpace(request.Context.WorkspaceID) == "" || spec.Workspaces == nil {
			return strings.TrimSpace(request.Context.WorkspaceID), nil
		}
		return cliservice.ResolveWorkspaceID(ctx, spec.Workspaces, request.Context.WorkspaceID)
	default:
		if spec.Workspaces == nil {
			return strings.TrimSpace(request.Context.WorkspaceID), nil
		}
		return cliservice.ResolveWorkspaceID(ctx, spec.Workspaces, request.Context.WorkspaceID)
	}
}

func tableOutput(spec *TableOutputSpec) *cliservice.TableOutput {
	if spec == nil {
		return nil
	}
	return &cliservice.TableOutput{Columns: spec.Columns}
}
