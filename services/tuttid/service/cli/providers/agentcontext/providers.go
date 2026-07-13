package agentcontext

import (
	"context"
	"strings"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

const agentProviderCatalogSchemaVersion = 2

var providerColumns = []cliservice.TableColumn{
	{Key: "provider", Label: "Provider"},
	{Key: "status", Label: "Status"},
	{Key: "detail", Label: "Detail"},
}

type providersInput struct {
	Provider string `cli:"provider"`
}

type providerCatalogItem struct {
	Target       agenttargetbiz.Target
	Availability agentservice.ProviderAvailability
}

type providersResult struct {
	DefaultProviderID string
	Items             []providerCatalogItem
}

func (p Provider) newProvidersCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[providersInput]{
		ID:          appID + ".agent.providers",
		Path:        []string{"agent", "providers"},
		Summary:     "List available agent providers",
		Description: "List enabled Agent Targets and whether tuttid can start their local runtime command.",
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
					return providerCatalogRows(result.(providersResult).Items)
				},
			},
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					providers := result.(providersResult)
					return map[string]any{
						"schemaVersion":     agentProviderCatalogSchemaVersion,
						"defaultProviderId": providers.DefaultProviderID,
						"providers":         providerCatalogValues(providers.Items),
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
	targets, err := p.enabledAgentTargets(ctx)
	if err != nil {
		return nil, err
	}
	requestedProvider := agentproviderbiz.Normalize(input.Provider)
	if strings.TrimSpace(input.Provider) != "" && requestedProvider == "" {
		return nil, agentservice.ErrInvalidArgument
	}
	if requestedProvider != "" {
		filtered := make([]agenttargetbiz.Target, 0, 1)
		for _, target := range targets {
			if target.Provider == requestedProvider {
				filtered = append(filtered, target)
				break
			}
		}
		targets = filtered
	}

	availabilityInput := agentservice.ProviderAvailabilityInput{}
	if len(targets) == 1 && requestedProvider != "" {
		availabilityInput.Provider = requestedProvider
	}
	availability, err := p.sessions.ListProviderAvailability(ctx, availabilityInput)
	if err != nil {
		return nil, err
	}
	items := providerCatalogItems(targets, availability)
	defaultProvider, err := p.defaultAgentProvider(ctx, targets)
	if err != nil {
		return nil, err
	}
	return providersResult{DefaultProviderID: defaultProvider, Items: items}, nil
}

func (p Provider) defaultAgentProvider(ctx context.Context, targets []agenttargetbiz.Target) (string, error) {
	defaultProvider := preferencesbiz.DefaultDesktopPreferences().DefaultAgentProvider
	if p.preferences != nil {
		preferences, err := p.preferences.Get(ctx)
		if err != nil {
			return "", err
		}
		if normalized := agentproviderbiz.Normalize(preferences.DefaultAgentProvider); normalized != "" {
			defaultProvider = normalized
		}
	}
	for _, target := range targets {
		if target.Provider == defaultProvider {
			return defaultProvider, nil
		}
	}
	if len(targets) > 0 {
		return targets[0].Provider, nil
	}
	return "", nil
}

func providerCatalogItems(targets []agenttargetbiz.Target, availability []agentservice.ProviderAvailability) []providerCatalogItem {
	byProvider := make(map[string]agentservice.ProviderAvailability, len(availability))
	for _, item := range availability {
		provider := agentproviderbiz.Normalize(item.Provider)
		if provider != "" {
			item.Provider = provider
			byProvider[provider] = item
		}
	}
	items := make([]providerCatalogItem, 0, len(targets))
	for _, target := range targets {
		item, ok := byProvider[target.Provider]
		if !ok {
			item = agentservice.ProviderAvailability{
				Provider: target.Provider,
				Status:   agentservice.ProviderAvailabilityUnknown,
				LastError: &agentservice.ProviderAvailabilityError{
					Code:    "agent_provider_status_unknown",
					Message: "provider runtime status is unavailable",
				},
			}
		}
		items = append(items, providerCatalogItem{Target: target, Availability: item})
	}
	return items
}

func providerCatalogRows(items []providerCatalogItem) []map[string]any {
	rows := make([]map[string]any, 0, len(items))
	for _, item := range items {
		rows = append(rows, map[string]any{
			"provider": item.Target.Provider,
			"status":   item.Availability.Status,
			"detail":   providerAvailabilityDetail(item.Availability),
		})
	}
	return rows
}

func providerCatalogValues(items []providerCatalogItem) []any {
	values := make([]any, 0, len(items))
	for _, item := range items {
		values = append(values, map[string]any{
			"providerId":    item.Target.Provider,
			"displayName":   item.Target.Name,
			"agentTargetId": item.Target.ID,
			"availability": map[string]any{
				"status":     item.Availability.Status,
				"reasonCode": providerAvailabilityReasonCode(item.Availability),
				"detail":     providerAvailabilityDetail(item.Availability),
			},
		})
	}
	return values
}

func providerAvailabilityReasonCode(item agentservice.ProviderAvailability) string {
	if item.LastError != nil {
		return strings.TrimSpace(item.LastError.Code)
	}
	return ""
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
