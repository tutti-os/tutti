package main

import (
	"context"
	"strings"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

type agentSessionCLIProjectionResolver struct {
	Sessions interface {
		AgentSessionCommandCapabilityProjection(
			context.Context,
			string,
			string,
		) (*runtimeprep.CommandCapabilityProjection, error)
	}
}

func (resolver agentSessionCLIProjectionResolver) ResolveAgentSessionCapabilityProjection(
	ctx context.Context,
	workspaceID string,
	sessionID string,
) (cliservice.AgentSessionCapabilityProjection, error) {
	projection, err := resolver.Sessions.AgentSessionCommandCapabilityProjection(
		ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(sessionID),
	)
	if err != nil {
		return cliservice.AgentSessionCapabilityProjection{}, err
	}
	if projection == nil {
		return cliservice.AgentSessionCapabilityProjection{}, nil
	}
	return cliservice.AgentSessionCapabilityProjection{
		AllowedIDs: append([]string(nil), projection.AllowedIDs...),
		IncludeIntegrationIDs: append(
			[]string(nil), projection.IncludeIntegrationIDs...,
		),
		ExcludeIDs: append([]string(nil), projection.ExcludeIDs...),
	}, nil
}

type runtimePrepCommandCatalog struct {
	Catalog interface {
		Capabilities(context.Context, cliservice.InvokeContext) []cliservice.Capability
	}
}

func (a runtimePrepCommandCatalog) Capabilities(ctx context.Context, input runtimeprep.CommandContext) []runtimeprep.CommandCapability {
	if a.Catalog == nil {
		return nil
	}
	capabilities := a.Catalog.Capabilities(ctx, cliservice.InvokeContext{
		Source:                         input.Source,
		WorkspaceID:                    input.WorkspaceID,
		SkipCapabilityFilters:          input.SkipCapabilityFilters,
		IncludeIntegrationCapabilities: input.IncludeIntegrationCapabilities,
	})
	out := make([]runtimeprep.CommandCapability, 0, len(capabilities))
	for _, capability := range capabilities {
		var table *runtimeprep.CommandTableOutput
		if capability.Output.Table != nil {
			columns := make([]runtimeprep.CommandTableColumn, 0, len(capability.Output.Table.Columns))
			for _, column := range capability.Output.Table.Columns {
				columns = append(columns, runtimeprep.CommandTableColumn{
					Key:   column.Key,
					Label: column.Label,
				})
			}
			table = &runtimeprep.CommandTableOutput{Columns: columns}
		}
		out = append(out, runtimeprep.CommandCapability{
			ID:          capability.ID,
			Path:        append([]string(nil), capability.Path...),
			Summary:     capability.Summary,
			Description: capability.Description,
			Visibility:  string(capability.Visibility),
			InputSchema: capability.InputSchema,
			Output: runtimeprep.CommandCapabilityOutput{
				DefaultMode: string(capability.Output.DefaultMode),
				JSON:        capability.Output.JSON,
				Table:       table,
			},
			ExecutionMode: commandExecutionMode(capability.Execution),
			Source: runtimeprep.CommandSource{
				Kind:    runtimeprep.CommandSourceKind(capability.Source.Kind),
				AppID:   capability.Source.AppID,
				AppName: capability.Source.AppName,
			},
		})
	}
	return out
}

func commandExecutionMode(execution *cliservice.CommandExecution) string {
	if execution == nil {
		return ""
	}
	return string(execution.Mode)
}
