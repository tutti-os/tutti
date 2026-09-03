package agentcontext

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"

	agentproviderbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentprovider"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	agentextensionservice "github.com/tutti-os/tutti/services/tuttid/service/agentextension"
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
	Refresh bool   `cli:"refresh"`
}

type agentCatalogItem struct {
	Target           agenttargetbiz.Target
	IdentityID       string
	IdentityName     string
	IdentityProvider string
	Availability     agentservice.ProviderAvailability
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
		Workspaces:  p.workspaces,
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

func (p Provider) runAgents(ctx context.Context, invoke framework.InvokeContext, input agentsInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	targets, err := p.enabledAgentTargets(ctx)
	if err != nil {
		return nil, err
	}
	requestedAgentID := strings.TrimSpace(input.AgentID)
	workspaceID := strings.TrimSpace(invoke.WorkspaceID)
	preferredProvider := p.preferredAgentProvider(ctx)
	defaultAgentTargetID := preferredAgentTargetID(targets, preferredProvider)

	if requestedAgentID != "" {
		if strings.HasPrefix(requestedAgentID, workspaceagentbiz.IDPrefix) {
			if workspaceID == "" {
				return nil, fmt.Errorf("%w: workspace id is required for WorkspaceAgent selection", cliservice.ErrInvalidInput)
			}
			view, err := p.getWorkspaceAgentView(ctx, workspaceID, requestedAgentID)
			if err != nil {
				return nil, err
			}
			item, err := p.workspaceAgentCatalogItemForSelection(ctx, workspaceID, view, targets, input.Refresh)
			if err != nil {
				return nil, err
			}
			if defaultAgentTargetID == "" {
				defaultAgentTargetID = fallbackDefaultAgentTargetID(agentCatalogItems(targets, nil), preferredProvider)
			}
			return agentsResult{DefaultAgentTargetID: defaultAgentTargetID, Items: []agentCatalogItem{item}}, nil
		}

		var selectedTarget *agenttargetbiz.Target
		for index := range targets {
			if targets[index].ID == requestedAgentID {
				selectedTarget = &targets[index]
				break
			}
		}
		if selectedTarget == nil {
			return nil, fmt.Errorf("%w: enabled agent %q was not found; run agent list --json", cliservice.ErrInvalidInput, requestedAgentID)
		}
		availability := []agentservice.ProviderAvailability{}
		if !isExtensionAgentTarget(*selectedTarget) {
			availability, err = p.sessions.ListProviderAvailability(ctx, agentservice.ProviderAvailabilityInput{
				Provider: selectedTarget.Provider,
			})
			if err != nil {
				return nil, err
			}
		}
		item := agentCatalogItems([]agenttargetbiz.Target{*selectedTarget}, availability)
		if isExtensionAgentTarget(*selectedTarget) {
			p.applyExtensionSetupAvailability(ctx, workspaceID, item, input.Refresh)
		}
		if defaultAgentTargetID == "" {
			defaultAgentTargetID = fallbackDefaultAgentTargetID(agentCatalogItems(targets, availability), preferredProvider)
		}
		return agentsResult{DefaultAgentTargetID: defaultAgentTargetID, Items: item}, nil
	}

	extensionTargets := extensionAgentTargets(targets)
	extensionItems := agentCatalogItems(extensionTargets, nil)
	probeCtx, cancelProbes := context.WithCancel(ctx)
	defer cancelProbes()
	extensionAvailabilityDone := make(chan struct{})
	if len(extensionItems) == 0 {
		close(extensionAvailabilityDone)
	} else {
		go func() {
			defer close(extensionAvailabilityDone)
			p.applyExtensionSetupAvailability(probeCtx, workspaceID, extensionItems, input.Refresh)
		}()
	}

	availability := []agentservice.ProviderAvailability{}
	builtinTargets := builtinAgentTargets(targets)
	needsAvailability := len(builtinTargets) > 0
	if needsAvailability {
		availability, err = p.sessions.ListProviderAvailability(ctx, agentservice.ProviderAvailabilityInput{})
		if err != nil {
			cancelProbes()
			<-extensionAvailabilityDone
			return nil, err
		}
	}
	<-extensionAvailabilityDone
	items := agentCatalogItems(targets, availability)
	extensionAvailabilityByTargetID := make(map[string]agentservice.ProviderAvailability, len(extensionItems))
	for _, item := range extensionItems {
		extensionAvailabilityByTargetID[item.Target.ID] = item.Availability
	}
	for index := range items {
		if extensionAvailability, ok := extensionAvailabilityByTargetID[items[index].Target.ID]; ok {
			items[index].Availability = extensionAvailability
		}
	}
	if defaultAgentTargetID == "" {
		defaultAgentTargetID = fallbackDefaultAgentTargetID(items, preferredProvider)
	}
	if workspaceID != "" && p.workspaceAgents != nil {
		workspaceAgents, listErr := p.workspaceAgents.List(ctx, workspaceID)
		if listErr != nil {
			return nil, listErr
		}
		items = append(items, workspaceAgentCatalogItems(workspaceAgents, items)...)
	}
	return agentsResult{DefaultAgentTargetID: defaultAgentTargetID, Items: items}, nil
}

func (p Provider) getWorkspaceAgentView(ctx context.Context, workspaceID string, agentID string) (workspaceagentbiz.View, error) {
	if p.workspaceAgents == nil {
		return workspaceagentbiz.View{}, errors.New("workspace agent directory is not configured")
	}
	view, err := p.workspaceAgents.Get(ctx, workspaceID, agentID)
	if errors.Is(err, workspacedata.ErrWorkspaceAgentNotFound) {
		return workspaceagentbiz.View{}, fmt.Errorf("%w: enabled agent %q was not found; run agent list --json", cliservice.ErrInvalidInput, agentID)
	}
	return view, err
}

func (p Provider) workspaceAgentCatalogItemForSelection(
	ctx context.Context,
	workspaceID string,
	view workspaceagentbiz.View,
	targets []agenttargetbiz.Target,
	refresh bool,
) (agentCatalogItem, error) {
	if !view.Harness.Available || !view.Harness.Enabled {
		return workspaceAgentCatalogItem(view, nil, nil), nil
	}
	for _, target := range targets {
		if target.ID != view.Harness.AgentTargetID {
			continue
		}
		if isExtensionAgentTarget(target) {
			items := agentCatalogItems([]agenttargetbiz.Target{target}, nil)
			p.applyExtensionSetupAvailability(ctx, workspaceID, items, refresh)
			return workspaceAgentCatalogItem(view, &target, items), nil
		}
		availability, err := p.sessions.ListProviderAvailability(ctx, agentservice.ProviderAvailabilityInput{
			Provider: target.Provider,
		})
		if err != nil {
			return agentCatalogItem{}, err
		}
		return workspaceAgentCatalogItem(view, &target, agentCatalogItems([]agenttargetbiz.Target{target}, availability)), nil
	}
	return workspaceAgentCatalogItem(view, nil, nil), nil
}

func workspaceAgentCatalogItems(
	views []workspaceagentbiz.View,
	harnessItems []agentCatalogItem,
) []agentCatalogItem {
	availabilityByHarnessID := make(map[string]agentservice.ProviderAvailability, len(harnessItems))
	for _, item := range harnessItems {
		availabilityByHarnessID[item.Target.ID] = item.Availability
	}
	items := make([]agentCatalogItem, 0, len(views))
	for _, view := range views {
		items = append(items, agentCatalogItemForWorkspaceAgent(view, nil, availabilityByHarnessID))
	}
	return items
}

func workspaceAgentCatalogItem(
	view workspaceagentbiz.View,
	harnessTarget *agenttargetbiz.Target,
	harnessItems []agentCatalogItem,
) agentCatalogItem {
	availabilityByHarnessID := make(map[string]agentservice.ProviderAvailability, len(harnessItems))
	for _, item := range harnessItems {
		availabilityByHarnessID[item.Target.ID] = item.Availability
	}
	return agentCatalogItemForWorkspaceAgent(view, harnessTarget, availabilityByHarnessID)
}

func agentCatalogItemForWorkspaceAgent(
	view workspaceagentbiz.View,
	harnessTarget *agenttargetbiz.Target,
	availabilityByHarnessID map[string]agentservice.ProviderAvailability,
) agentCatalogItem {
	provider := strings.TrimSpace(view.Harness.Provider)
	item := agentCatalogItem{
		IdentityID:       view.Agent.ID,
		IdentityName:     view.Agent.Name,
		IdentityProvider: provider,
		Availability:     unavailableWorkspaceAgentAvailability(provider),
	}
	if !view.Harness.Available || !view.Harness.Enabled {
		return item
	}
	if harnessTarget != nil {
		item.Target = *harnessTarget
		item.IdentityProvider = harnessTarget.Provider
		if availability, ok := availabilityByHarnessID[harnessTarget.ID]; ok {
			item.Availability = availability
		} else {
			item.Availability = unknownWorkspaceAgentAvailability(harnessTarget.Provider)
		}
		return item
	}
	if availability, ok := availabilityByHarnessID[view.Harness.AgentTargetID]; ok {
		item.Availability = availability
	} else {
		item.Availability = unknownWorkspaceAgentAvailability(provider)
	}
	return item
}

func unavailableWorkspaceAgentAvailability(provider string) agentservice.ProviderAvailability {
	return agentservice.ProviderAvailability{
		Provider: provider,
		Status:   agentservice.ProviderAvailabilityUnavailable,
		LastError: &agentservice.ProviderAvailabilityError{
			Code: "workspace_agent_configuration_unavailable", Message: "workspace agent configuration is unavailable",
		},
	}
}

func unknownWorkspaceAgentAvailability(provider string) agentservice.ProviderAvailability {
	return agentservice.ProviderAvailability{
		Provider: provider,
		Status:   agentservice.ProviderAvailabilityUnknown,
		LastError: &agentservice.ProviderAvailabilityError{
			Code: "agent_provider_status_unknown", Message: "provider runtime status is unavailable",
		},
	}
}

func (p Provider) applyExtensionSetupAvailability(
	ctx context.Context,
	requestedWorkspaceID string,
	items []agentCatalogItem,
	refresh bool,
) {
	if p.extensionAvailabilityCache == nil {
		return
	}
	workspaceID, err := cliservice.ResolveWorkspaceID(ctx, p.workspaces, requestedWorkspaceID)
	if err != nil {
		for index := range items {
			if isExtensionAgentTarget(items[index].Target) {
				items[index].Availability = unknownExtensionSetupAvailability(items[index].Target.Provider, err)
			}
		}
		return
	}

	var probes sync.WaitGroup
	for index := range items {
		if !isExtensionAgentTarget(items[index].Target) || items[index].Availability.Status != agentservice.ProviderAvailabilityAvailable {
			continue
		}
		probes.Add(1)
		go func(index int) {
			defer probes.Done()
			target := items[index].Target
			executablePath := items[index].Availability.ExecutablePath
			snapshot, setupErr := p.extensionAvailabilityCache.load(ctx, agentextensionservice.InstallPlanInput{
				WorkspaceID: workspaceID, AgentTargetID: target.ID,
			}, refresh)
			if setupErr != nil {
				items[index].Availability = unknownExtensionSetupAvailability(target.Provider, setupErr)
				items[index].Availability.ExecutablePath = executablePath
				return
			}
			items[index].Availability = extensionSetupAvailability(target.Provider, snapshot)
			items[index].Availability.ExecutablePath = executablePath
		}(index)
	}
	probes.Wait()
}

func extensionSetupAvailability(provider string, snapshot agentextensionservice.SetupSnapshot) agentservice.ProviderAvailability {
	status := agentservice.ProviderAvailabilityUnknown
	reasonCode := strings.TrimSpace(snapshot.Reason)
	detail := reasonCode
	switch snapshot.Status {
	case agentextensionservice.SetupReady:
		status = agentservice.ProviderAvailabilityAvailable
		reasonCode = ""
		detail = ""
	case agentextensionservice.SetupAuthRequired:
		status = agentservice.ProviderAvailabilityUnavailable
		reasonCode = string(agentextensionservice.SetupAuthRequired)
		if detail == "" {
			detail = "authentication required"
		}
	case agentextensionservice.SetupNotInstalled, agentextensionservice.SetupFailed:
		status = agentservice.ProviderAvailabilityUnavailable
		if reasonCode == "" {
			reasonCode = string(snapshot.Status)
			detail = reasonCode
		}
	case agentextensionservice.SetupInstalling, agentextensionservice.SetupAuthenticating:
		if reasonCode == "" {
			reasonCode = string(snapshot.Status)
			detail = reasonCode
		}
	default:
		if reasonCode == "" {
			reasonCode = "agent_target_setup_status_unknown"
			detail = reasonCode
		}
	}
	result := agentservice.ProviderAvailability{Provider: provider, Status: status}
	if reasonCode != "" {
		result.LastError = &agentservice.ProviderAvailabilityError{Code: reasonCode, Message: detail}
	}
	return result
}

func unknownExtensionSetupAvailability(provider string, _ error) agentservice.ProviderAvailability {
	return agentservice.ProviderAvailability{
		Provider: provider,
		Status:   agentservice.ProviderAvailabilityUnknown,
		LastError: &agentservice.ProviderAvailabilityError{
			Code: "agent_target_setup_status_unknown", Message: "agent target setup status is unavailable",
		},
	}
}

func (p Provider) preferredAgentProvider(ctx context.Context) string {
	preferredProvider := preferencesbiz.DefaultDesktopPreferences().DefaultAgentProvider
	if p.preferences != nil {
		preferences, err := p.preferences.Get(ctx)
		if err == nil {
			if normalized := agentproviderbiz.Normalize(preferences.DefaultAgentProvider); normalized != "" {
				preferredProvider = normalized
			}
		}
	}
	return preferredProvider
}

func preferredAgentTargetID(targets []agenttargetbiz.Target, preferredProvider string) string {
	preferredTargetID := preferencesbiz.LocalAgentTargetIDForProvider(preferredProvider)
	for _, target := range targets {
		if target.ID == preferredTargetID {
			return target.ID
		}
	}
	return ""
}

func fallbackDefaultAgentTargetID(items []agentCatalogItem, preferredProvider string) string {
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
			items = append(items, agentCatalogItem{Target: target, IdentityID: target.ID, IdentityName: target.Name, IdentityProvider: target.Provider, Availability: extensionTargetAvailability(target)})
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
		items = append(items, agentCatalogItem{Target: target, IdentityID: target.ID, IdentityName: target.Name, IdentityProvider: target.Provider, Availability: item})
	}
	return items
}

func catalogItemID(item agentCatalogItem) string {
	if item.IdentityID != "" {
		return item.IdentityID
	}
	return item.Target.ID
}

func catalogItemName(item agentCatalogItem) string {
	if item.IdentityName != "" {
		return item.IdentityName
	}
	return item.Target.Name
}

func catalogItemProvider(item agentCatalogItem) string {
	if item.IdentityProvider != "" {
		return item.IdentityProvider
	}
	return item.Target.Provider
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

func extensionAgentTargets(targets []agenttargetbiz.Target) []agenttargetbiz.Target {
	result := make([]agenttargetbiz.Target, 0, len(targets))
	for _, target := range targets {
		if isExtensionAgentTarget(target) {
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
	result := agentservice.ProviderAvailability{
		Provider:       target.Provider,
		Status:         status,
		ExecutablePath: strings.TrimSpace(target.ExecutablePath),
	}
	if reason := strings.TrimSpace(target.AvailabilityReason); reason != "" {
		result.LastError = &agentservice.ProviderAvailabilityError{Code: reason, Message: reason}
	}
	return result
}

func agentCatalogRows(items []agentCatalogItem) []map[string]any {
	rows := make([]map[string]any, 0, len(items))
	for _, item := range items {
		rows = append(rows, map[string]any{
			"id":       catalogItemID(item),
			"name":     catalogItemName(item),
			"provider": catalogItemProvider(item),
			"status":   item.Availability.Status,
			"detail":   providerAvailabilityDetail(item.Availability),
		})
	}
	return rows
}

func agentCatalogValues(items []agentCatalogItem) []any {
	values := make([]any, 0, len(items))
	for _, item := range items {
		value := map[string]any{
			"id":       catalogItemID(item),
			"name":     catalogItemName(item),
			"provider": catalogItemProvider(item),
			"availability": map[string]any{
				"status":     item.Availability.Status,
				"reasonCode": providerAvailabilityReasonCode(item.Availability),
				"detail":     providerAvailabilityDetail(item.Availability),
			},
		}
		if executablePath := strings.TrimSpace(item.Availability.ExecutablePath); executablePath != "" {
			value["executablePath"] = executablePath
		}
		values = append(values, value)
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
