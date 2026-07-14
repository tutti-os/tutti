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

const legacyProviderCatalogSchemaVersion = 2

var legacyProviderColumns = []cliservice.TableColumn{
	{Key: "provider", Label: "Provider"},
	{Key: "status", Label: "Status"},
	{Key: "detail", Label: "Detail"},
}

type legacyProvidersInput struct {
	Provider string `cli:"provider"`
}

type legacyProviderItem struct {
	ProviderID    string
	DisplayName   string
	AgentTargetID string
	Availability  agentservice.ProviderAvailability
}

type legacyProvidersResult struct {
	DefaultProviderID string
	Items             []legacyProviderItem
}

func (p Provider) newLegacyProvidersCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[legacyProvidersInput]{
		ID:          appID + ".agent.providers",
		Path:        []string{"agent", "providers"},
		Summary:     "List legacy agent providers (deprecated)",
		Description: "Deprecated compatibility catalog. New integrations must use agent list and persist exact agent ids.",
		Kind:        framework.KindList,
		Visibility:  cliservice.CapabilityVisibilityIntegration,
		Workspace:   framework.WorkspaceOptional,
		Inputs:      framework.FromStruct[legacyProvidersInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeTable,
			DefaultView: framework.ViewSummary,
			JSON:        true,
			Table: &framework.TableOutputSpec{
				Columns: legacyProviderColumns,
				Rows: func(result any) []map[string]any {
					return legacyProviderRows(result.(legacyProvidersResult).Items)
				},
			},
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewSummary: func(result any) map[string]any {
					value := result.(legacyProvidersResult)
					return map[string]any{
						"schemaVersion":     legacyProviderCatalogSchemaVersion,
						"defaultProviderId": value.DefaultProviderID,
						"providers":         legacyProviderValues(value.Items),
					}
				},
			},
			ListCompact: true,
		},
		Run: p.runLegacyProviders,
	})
}

func legacyProviderRows(items []legacyProviderItem) []map[string]any {
	rows := make([]map[string]any, 0, len(items))
	for _, item := range items {
		rows = append(rows, map[string]any{
			"provider": item.ProviderID,
			"status":   item.Availability.Status,
			"detail":   providerAvailabilityDetail(item.Availability),
		})
	}
	return rows
}

func (p Provider) runLegacyProviders(ctx context.Context, _ framework.InvokeContext, input legacyProvidersInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	targets, err := p.enabledAgentTargets(ctx)
	if err != nil {
		return nil, err
	}
	requested := normalizeLegacyProvider(input.Provider)
	if strings.TrimSpace(input.Provider) != "" && requested == "" {
		return nil, fmt.Errorf("%w: unsupported legacy provider %q; run agent list --json", cliservice.ErrInvalidInput, input.Provider)
	}
	if requested != "" {
		filtered := targets[:0]
		for _, target := range targets {
			if target.Provider == requested {
				filtered = append(filtered, target)
			}
		}
		targets = filtered
	}

	availability := []agentservice.ProviderAvailability{}
	if builtin := builtinAgentTargets(targets); len(builtin) > 0 {
		availabilityInput := agentservice.ProviderAvailabilityInput{}
		if requested != "" {
			availabilityInput.Provider = requested
		}
		availability, err = p.sessions.ListProviderAvailability(ctx, availabilityInput)
		if err != nil {
			return nil, err
		}
	}
	items := legacyProviderCatalogItems(agentCatalogItems(targets, availability))
	defaultProviderID, err := p.defaultLegacyProvider(ctx, items)
	if err != nil {
		return nil, err
	}
	return legacyProvidersResult{DefaultProviderID: defaultProviderID, Items: items}, nil
}

func legacyProviderCatalogItems(items []agentCatalogItem) []legacyProviderItem {
	grouped := map[string][]agentCatalogItem{}
	order := []string{}
	for _, item := range items {
		provider := item.Target.Provider
		if _, ok := grouped[provider]; !ok {
			order = append(order, provider)
		}
		grouped[provider] = append(grouped[provider], item)
	}
	result := make([]legacyProviderItem, 0, len(order))
	for _, provider := range order {
		matches := grouped[provider]
		item := legacyProviderItem{ProviderID: provider, DisplayName: matches[0].Target.Name}
		if len(matches) == 1 {
			item.AgentTargetID = matches[0].Target.ID
			item.Availability = matches[0].Availability
		} else {
			item.Availability = agentservice.ProviderAvailability{
				Provider: provider,
				Status:   agentservice.ProviderAvailabilityUnavailable,
				LastError: &agentservice.ProviderAvailabilityError{
					Code:    "agent_provider_ambiguous",
					Message: "multiple agents use this provider; run agent list --json and select an exact agent id",
				},
			}
		}
		result = append(result, item)
	}
	return result
}

func legacyProviderValues(items []legacyProviderItem) []any {
	values := make([]any, 0, len(items))
	for _, item := range items {
		value := map[string]any{
			"providerId":  item.ProviderID,
			"displayName": item.DisplayName,
			"availability": map[string]any{
				"status":     item.Availability.Status,
				"reasonCode": providerAvailabilityReasonCode(item.Availability),
				"detail":     providerAvailabilityDetail(item.Availability),
			},
		}
		if item.AgentTargetID != "" {
			value["agentTargetId"] = item.AgentTargetID
		}
		values = append(values, value)
	}
	return values
}

func (p Provider) defaultLegacyProvider(ctx context.Context, items []legacyProviderItem) (string, error) {
	preferred := preferencesbiz.DefaultDesktopPreferences().DefaultAgentProvider
	if p.preferences != nil {
		preferences, err := p.preferences.Get(ctx)
		if err != nil {
			return "", err
		}
		if normalized := normalizeLegacyProvider(preferences.DefaultAgentProvider); normalized != "" {
			preferred = normalized
		}
	}
	for _, item := range items {
		if item.ProviderID == preferred && item.AgentTargetID != "" {
			return preferred, nil
		}
	}
	for _, item := range items {
		if item.AgentTargetID != "" && item.Availability.Status == agentservice.ProviderAvailabilityAvailable {
			return item.ProviderID, nil
		}
	}
	for _, item := range items {
		if item.AgentTargetID != "" {
			return item.ProviderID, nil
		}
	}
	if len(items) > 0 {
		return items[0].ProviderID, nil
	}
	return "", nil
}

func normalizeLegacyProvider(provider string) string {
	if normalized := agentproviderbiz.Normalize(provider); normalized != "" {
		return normalized
	}
	return agentproviderbiz.NormalizeOpen(provider)
}

func (p Provider) resolveAgentSelector(ctx context.Context, agentID string, provider string) (agenttargetbiz.Target, bool, error) {
	agentID = strings.TrimSpace(agentID)
	provider = strings.TrimSpace(provider)
	if (agentID == "") == (provider == "") {
		return agenttargetbiz.Target{}, false, fmt.Errorf("%w: provide exactly one of --agent-id or deprecated --provider; run agent list --json", cliservice.ErrInvalidInput)
	}
	if agentID != "" {
		target, err := p.resolveEnabledAgentTarget(ctx, agentID)
		return target, false, err
	}
	target, err := p.resolveLegacyProviderTarget(ctx, provider)
	return target, true, err
}

func (p Provider) resolveLegacyProviderTarget(ctx context.Context, provider string) (agenttargetbiz.Target, error) {
	canonical := normalizeLegacyProvider(provider)
	if canonical == "" {
		return agenttargetbiz.Target{}, fmt.Errorf("%w: unsupported legacy provider %q; run agent list --json", cliservice.ErrInvalidInput, provider)
	}
	targets, err := p.enabledAgentTargets(ctx)
	if err != nil {
		return agenttargetbiz.Target{}, err
	}
	matches := make([]agenttargetbiz.Target, 0, 2)
	for _, target := range targets {
		if target.Provider == canonical {
			matches = append(matches, target)
		}
	}
	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) == 0 {
		return agenttargetbiz.Target{}, fmt.Errorf("%w: no enabled agent uses legacy provider %q; run agent list --json", cliservice.ErrInvalidInput, canonical)
	}
	ids := make([]string, 0, len(matches))
	for _, target := range matches {
		ids = append(ids, target.ID)
	}
	return agenttargetbiz.Target{}, fmt.Errorf("%w: legacy provider %q is ambiguous across agents %s; use --agent-id", cliservice.ErrInvalidInput, canonical, strings.Join(ids, ", "))
}

type legacyStartInput struct {
	Cwd             string   `cli:"cwd"`
	DisplayPrompt   string   `cli:"display-prompt"`
	Hidden          bool     `cli:"hidden"`
	Images          []string `cli:"image" description:"Image file to attach to the initial prompt. May be passed multiple times."`
	Model           string   `cli:"model"`
	PermissionMode  string   `cli:"permission-mode"`
	Prompt          string   `cli:"prompt" validate:"required"`
	ReasoningEffort string   `cli:"reasoning-effort"`
	Show            bool     `cli:"show"`
	Speed           string   `cli:"speed"`
	Title           string   `cli:"title"`
}

func (p Provider) newLegacyCodexStartCommand() cliservice.Command {
	return p.newLegacyStartCommand("codex", agenttargetbiz.IDLocalCodex)
}

func (p Provider) newLegacyClaudeStartCommand() cliservice.Command {
	return p.newLegacyStartCommand("claude", agenttargetbiz.IDLocalClaudeCode)
}

func (p Provider) newLegacyStartCommand(name string, targetID string) cliservice.Command {
	return framework.Register(framework.CommandSpec[legacyStartInput]{
		ID:          appID + "." + name + ".start",
		Path:        []string{name, "start"},
		Summary:     "Start " + name + " (deprecated)",
		Description: "Deprecated compatibility alias. New integrations must use agent start --agent-id.",
		Kind:        framework.KindAction,
		Visibility:  cliservice.CapabilityVisibilityIntegration,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[legacyStartInput](),
		Output:      sessionActionOutputSpec(),
		Run: func(ctx context.Context, invoke framework.InvokeContext, input legacyStartInput) (any, error) {
			target, err := p.resolveEnabledAgentTarget(ctx, targetID)
			if err != nil {
				return nil, err
			}
			return p.runStart(ctx, invoke, target, startFields(input))
		},
	})
}
