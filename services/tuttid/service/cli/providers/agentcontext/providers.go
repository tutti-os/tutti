package agentcontext

import (
	"context"
	"fmt"
	"strings"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
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
	DefaultAgentTargetID string
	Items                []agentCatalogItem
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
						"schemaVersion":        agentCatalogSchemaVersion,
						"defaultAgentTargetId": agents.DefaultAgentTargetID,
						"agents":               agentCatalogValues(agents.Items),
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
		found := false
		for _, target := range targets {
			if target.ID == requestedAgentID {
				found = true
				break
			}
		}
		if !found {
			return nil, fmt.Errorf("%w: enabled agent %q was not found; run agent list --json", cliservice.ErrInvalidInput, requestedAgentID)
		}
	}

	availability := []agentservice.ProviderAvailability{}
	builtinTargets := builtinAgentTargets(targets)
	if len(builtinTargets) > 0 {
		availability, err = p.sessions.ListProviderAvailability(ctx, agentservice.ProviderAvailabilityInput{})
		if err != nil {
			return nil, err
		}
	}
	items := agentCatalogItems(targets, availability)
	defaultAgentTargetID := p.defaultAgentTargetID(ctx, items)
	if requestedAgentID != "" {
		filtered := make([]agentCatalogItem, 0, 1)
		for _, item := range items {
			if item.Target.ID == requestedAgentID {
				filtered = append(filtered, item)
				break
			}
		}
		items = filtered
	}
	return agentsResult{DefaultAgentTargetID: defaultAgentTargetID, Items: items}, nil
}

func (p Provider) defaultAgentTargetID(ctx context.Context, items []agentCatalogItem) string {
	preferredProvider := preferencesbiz.DefaultDesktopPreferences().DefaultAgentProvider
	if p.preferences != nil {
		preferences, err := p.preferences.Get(ctx)
		if err == nil {
			if normalized := agentproviderbiz.Normalize(preferences.DefaultAgentProvider); normalized != "" {
				preferredProvider = normalized
			}
		}
	}
	preferredTargetID := preferencesbiz.LocalAgentTargetIDForProvider(preferredProvider)
	for _, item := range items {
		if item.Target.ID == preferredTargetID {
			return item.Target.ID
		}
	}
	for _, item := range items {
		if item.Target.Provider == preferredProvider && item.Availability.Status == agentservice.ProviderAvailabilityAvailable {
			return item.Target.ID
		}
	}
	for _, item := range items {
		if item.Target.Provider == preferredProvider {
			return item.Target.ID
		}
	}
	for _, item := range items {
		if item.Availability.Status == agentservice.ProviderAvailabilityAvailable {
			return item.Target.ID
		}
	}
	if len(items) > 0 {
		return items[0].Target.ID
	}
	return ""
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
		if isExtensionAgentTarget(target) {
			items = append(items, agentCatalogItem{Target: target, Availability: extensionTargetAvailability(target)})
			continue
		}
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

func builtinAgentTargets(targets []agenttargetbiz.Target) []agenttargetbiz.Target {
	result := make([]agenttargetbiz.Target, 0, len(targets))
	for _, target := range targets {
		if !isExtensionAgentTarget(target) {
			result = append(result, target)
		}
	}
	return result
}

func isExtensionAgentTarget(target agenttargetbiz.Target) bool {
	ref, err := agenttargetbiz.RuntimeProviderTargetRef(target)
	return err == nil && ref["kind"] == agenttargetbiz.LaunchRefTypeAgentExtension
}

func extensionTargetAvailability(target agenttargetbiz.Target) agentservice.ProviderAvailability {
	status := agentservice.ProviderAvailabilityUnknown
	switch strings.TrimSpace(target.AvailabilityStatus) {
	case "ready":
		status = agentservice.ProviderAvailabilityAvailable
	case "not_installed", "auth_required", "unsupported":
		status = agentservice.ProviderAvailabilityUnavailable
	}
	result := agentservice.ProviderAvailability{Provider: target.Provider, Status: status}
	if reason := strings.TrimSpace(target.AvailabilityReason); reason != "" {
		result.LastError = &agentservice.ProviderAvailabilityError{Code: reason, Message: reason}
	}
	return result
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
