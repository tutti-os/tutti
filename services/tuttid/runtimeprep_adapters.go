package main

import (
	"context"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

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
		Source:                input.Source,
		WorkspaceID:           input.WorkspaceID,
		SkipCapabilityFilters: input.SkipCapabilityFilters,
	})
	out := make([]runtimeprep.CommandCapability, 0, len(capabilities))
	for _, capability := range capabilities {
		out = append(out, runtimeprep.CommandCapability{
			ID:          capability.ID,
			Path:        append([]string(nil), capability.Path...),
			Summary:     capability.Summary,
			Description: capability.Description,
			InputSchema: capability.InputSchema,
			Source: runtimeprep.CommandSource{
				Kind:    runtimeprep.CommandSourceKind(capability.Source.Kind),
				AppID:   capability.Source.AppID,
				AppName: capability.Source.AppName,
			},
		})
	}
	return out
}
