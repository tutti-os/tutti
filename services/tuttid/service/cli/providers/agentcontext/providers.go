package agentcontext

import (
	"context"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

var providerColumns = []cliservice.TableColumn{
	{Key: "provider", Label: "Provider"},
	{Key: "status", Label: "Status"},
	{Key: "detail", Label: "Detail"},
}

type providersInput struct {
	Provider string `cli:"provider"`
}

type providersResult struct {
	DefaultProvider string
	Availability    []agentservice.ProviderAvailability
}

func (p Provider) newProvidersCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[providersInput]{
		ID:          appID + ".agent.providers",
		Path:        []string{"agent", "providers"},
		Summary:     "List available agent providers",
		Description: "List agent providers and whether tuttid can start their local runtime command.",
		Kind:        framework.KindList,
		Workspace:   framework.WorkspaceOptional,
		Inputs:      framework.FromStruct[providersInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeTable,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			Table: &framework.TableOutputSpec{
				Columns: providerColumns,
				Rows: func(result any) []map[string]any {
					return providerAvailabilityRows(result.(providersResult).Availability)
				},
			},
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					providers := result.(providersResult)
					return map[string]any{
						"defaultProvider": providers.DefaultProvider,
						"providers":       providerAvailabilityValues(providers.Availability),
					}
				},
			},
			ListCompact: true,
		},
		Run: p.runProviders,
	})
}

func (p Provider) runProviders(ctx context.Context, _ framework.InvokeContext, input providersInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	availability, err := p.sessions.ListProviderAvailability(ctx, agentservice.ProviderAvailabilityInput{
		Provider: input.Provider,
	})
	if err != nil {
		return nil, err
	}
	defaultProvider, err := p.defaultAgentProvider(ctx)
	if err != nil {
		return nil, err
	}
	return providersResult{DefaultProvider: defaultProvider, Availability: availability}, nil
}

func (p Provider) defaultAgentProvider(ctx context.Context) (string, error) {
	if p.preferences == nil {
		return preferencesbiz.DefaultDesktopPreferences().DefaultAgentProvider, nil
	}
	preferences, err := p.preferences.Get(ctx)
	if err != nil {
		return "", err
	}
	defaultProvider := agentproviderbiz.Normalize(preferences.DefaultAgentProvider)
	if defaultProvider == "" {
		defaultProvider = preferencesbiz.DefaultDesktopPreferences().DefaultAgentProvider
	}
	return defaultProvider, nil
}

func providerAvailabilityRows(items []agentservice.ProviderAvailability) []map[string]any {
	rows := make([]map[string]any, 0, len(items))
	for _, item := range items {
		rows = append(rows, map[string]any{
			"provider": item.Provider,
			"status":   item.Status,
			"detail":   providerAvailabilityDetail(item),
		})
	}
	return rows
}

func providerAvailabilityValues(items []agentservice.ProviderAvailability) []any {
	values := make([]any, 0, len(items))
	for _, item := range items {
		value := map[string]any{
			"provider": item.Provider,
			"status":   item.Status,
			"detail":   providerAvailabilityDetail(item),
		}
		values = append(values, value)
	}
	return values
}

func providerAvailabilityDetail(item agentservice.ProviderAvailability) string {
	if item.LastError != nil && item.LastError.Message != "" {
		return item.LastError.Message
	}
	for _, check := range item.Checks {
		if check.Detail != "" {
			return check.Detail
		}
	}
	return ""
}
