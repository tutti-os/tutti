package agentcontext

import (
	"context"
	"strings"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

const agentCatalogSchemaVersion = 1

var agentColumns = []cliservice.TableColumn{
	{Key: "id", Label: "Agent ID"},
	{Key: "name", Label: "Name"},
	{Key: "provider", Label: "Provider"},
	{Key: "status", Label: "Status"},
	{Key: "detail", Label: "Detail"},
}

type agentsInput struct {
	AgentID string `cli:"agent-id"`
}

type agentCatalogItem struct {
	Target       agenttargetbiz.Target
	Availability agentservice.ProviderAvailability
}

type agentsResult struct {
	Items []agentCatalogItem
}

func (p Provider) newAgentsCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[agentsInput]{
		ID:          appID + ".agent.list",
		Path:        []string{"agent", "list"},
		Summary:     "List available agents",
		Description: "List every enabled agent and whether tuttid can start its runtime. Multiple agents may share one provider.",
		Kind:        framework.KindList,
		Workspace:   framework.WorkspaceOptional,
		Inputs:      framework.FromStruct[agentsInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeTable,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			Table: &framework.TableOutputSpec{
				Columns: agentColumns,
				Rows: func(result any) []map[string]any {
					return agentCatalogRows(result.(agentsResult).Items)
				},
			},
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					agents := result.(agentsResult)
					return map[string]any{
						"schemaVersion": agentCatalogSchemaVersion,
						"agents":        agentCatalogValues(agents.Items),
					}
				},
			},
			ListCompact: true,
		},
		Run: p.runAgents,
	})
}

func (p Provider) runAgents(ctx context.Context, _ framework.InvokeContext, input agentsInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	targets, err := p.enabledAgentTargets(ctx)
	if err != nil {
		return nil, err
	}
	requestedAgentID := strings.TrimSpace(input.AgentID)
	if requestedAgentID != "" {
		filtered := make([]agenttargetbiz.Target, 0, 1)
		for _, target := range targets {
			if target.ID == requestedAgentID {
				filtered = append(filtered, target)
				break
			}
		}
		if len(filtered) == 0 {
			return nil, agentservice.ErrInvalidArgument
		}
		targets = filtered
	}

	availabilityInput := agentservice.ProviderAvailabilityInput{}
	if len(targets) == 1 && requestedAgentID != "" {
		availabilityInput.Provider = targets[0].Provider
	}
	availability, err := p.sessions.ListProviderAvailability(ctx, availabilityInput)
	if err != nil {
		return nil, err
	}
	items := agentCatalogItems(targets, availability)
	return agentsResult{Items: items}, nil
}

func agentCatalogItems(targets []agenttargetbiz.Target, availability []agentservice.ProviderAvailability) []agentCatalogItem {
	byProvider := make(map[string]agentservice.ProviderAvailability, len(availability))
	for _, item := range availability {
		provider := agentproviderbiz.Normalize(item.Provider)
		if provider != "" {
			item.Provider = provider
			byProvider[provider] = item
		}
	}
	items := make([]agentCatalogItem, 0, len(targets))
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
		items = append(items, agentCatalogItem{Target: target, Availability: item})
	}
	return items
}

func agentCatalogRows(items []agentCatalogItem) []map[string]any {
	rows := make([]map[string]any, 0, len(items))
	for _, item := range items {
		rows = append(rows, map[string]any{
			"id":       item.Target.ID,
			"name":     item.Target.Name,
			"provider": item.Target.Provider,
			"status":   item.Availability.Status,
			"detail":   providerAvailabilityDetail(item.Availability),
		})
	}
	return rows
}

func agentCatalogValues(items []agentCatalogItem) []any {
	values := make([]any, 0, len(items))
	for _, item := range items {
		values = append(values, map[string]any{
			"id":       item.Target.ID,
			"name":     item.Target.Name,
			"provider": item.Target.Provider,
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
