package agent

import (
	"context"
	"fmt"
	"strings"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
)

const workspaceAgentIDPrefix = workspaceagentbiz.IDPrefix

func (s *Service) resolveWorkspaceAgentLaunch(
	ctx context.Context,
	workspaceID string,
	input *CreateSessionInput,
	requestProvider string,
) (resolvedCreateSessionLaunch, error) {
	if workspaceID == "" {
		return resolvedCreateSessionLaunch{}, fmt.Errorf("%w: workspace id is required for workspace agent launch", ErrInvalidArgument)
	}
	if s.WorkspaceAgentResolver == nil {
		return resolvedCreateSessionLaunch{}, fmt.Errorf("%w: workspace agent resolver is unavailable", ErrInvalidArgument)
	}
	resolved, err := s.WorkspaceAgentResolver.Resolve(ctx, workspaceID, strings.TrimSpace(input.AgentTargetID))
	if err != nil {
		return resolvedCreateSessionLaunch{}, fmt.Errorf("%w: resolve workspace agent: %v", ErrInvalidArgument, err)
	}
	target, err := agenttargetbiz.NormalizeTarget(resolved.HarnessTarget)
	if err != nil {
		return resolvedCreateSessionLaunch{}, fmt.Errorf("%w: invalid workspace agent harness: %v", ErrInvalidArgument, err)
	}
	derivedRef, err := agenttargetbiz.RuntimeProviderTargetRef(target)
	if err != nil {
		return resolvedCreateSessionLaunch{}, fmt.Errorf("%w: invalid workspace agent harness launch ref", ErrInvalidArgument)
	}
	provider, _ := derivedRef["provider"].(string)
	provider = strings.TrimSpace(provider)
	if requestProvider != "" && requestProvider != provider {
		return resolvedCreateSessionLaunch{}, fmt.Errorf("%w: provider does not match workspace agent harness", ErrInvalidArgument)
	}

	input.WorkspaceAgentRevision = resolved.Agent.Revision
	input.HarnessAgentTargetID = target.ID
	input.AgentName = resolved.Agent.Name
	input.AgentDescription = resolved.Agent.Description
	input.AgentDefaultModel = resolved.Agent.DefaultModel
	input.AgentInstructions = resolved.Agent.Instructions
	input.AgentCallConditions = append([]string(nil), resolved.Agent.CallConditions...)
	input.AgentCapabilitiesExplicit = resolved.Agent.CapabilitiesExplicit
	input.AgentSkills = append([]string(nil), resolved.Agent.Skills...)
	input.AgentTools, input.AgentCapabilitiesExplicit = constrainWorkspaceAgentTools(
		resolved.Agent.Tools,
		input.AgentTools,
		input.AgentCapabilitiesExplicit,
	)
	applyWorkspaceAgentCapabilityDefaults(input)
	if resolved.ModelPlan != nil {
		plan := *resolved.ModelPlan
		input.ResolvedModelPlan = &plan
	}
	if strings.TrimSpace(value(input.Model)) == "" && strings.TrimSpace(resolved.EffectiveModel) != "" {
		model := strings.TrimSpace(resolved.EffectiveModel)
		input.Model = &model
	}

	return resolvedCreateSessionLaunch{
		Provider:          provider,
		ProviderTargetRef: derivedRef,
	}, nil
}

// constrainWorkspaceAgentTools treats a daemon-internal pre-filled AgentTools
// list (currently AutomationRule allowedTools) as a restriction, never as
// authority to add tools that the target Agent did not configure.
func constrainWorkspaceAgentTools(configured []string, restriction []string, capabilitiesExplicit bool) ([]string, bool) {
	configured = workspaceagentbiz.NormalizeStringList(configured)
	restriction = workspaceagentbiz.NormalizeStringList(restriction)
	if len(restriction) == 0 {
		return append([]string(nil), configured...), capabilitiesExplicit
	}
	if !capabilitiesExplicit && len(configured) == 0 {
		// Automatic compatible capabilities represent the full set. A rule-level
		// allowlist therefore becomes the exact effective selection rather than
		// disappearing into another automatic-all value.
		return append([]string(nil), restriction...), true
	}
	allowed := make(map[string]struct{}, len(restriction))
	for _, value := range restriction {
		allowed[strings.ToLower(value)] = struct{}{}
	}
	result := make([]string, 0, len(configured))
	for _, value := range configured {
		if _, ok := allowed[strings.ToLower(value)]; ok {
			result = append(result, value)
		}
	}
	return result, true
}

func applyWorkspaceAgentCapabilityDefaults(input *CreateSessionInput) {
	if input == nil {
		return
	}
	// A non-empty tools list is an explicit WorkspaceAgent capability set. It
	// therefore controls optional daemon tools unless the caller supplied a
	// narrower explicit setting. Empty retains existing provider defaults.
	if workspaceAgentToolsControlDaemonCapabilities(input.AgentTools) {
		if input.BrowserUse == nil {
			value := workspaceAgentHasTool(input.AgentTools, "browser", "browser-use", "computer.browser")
			input.BrowserUse = &value
		}
		if input.ComputerUse == nil {
			value := workspaceAgentHasTool(input.AgentTools, "computer", "computer-use", "desktop")
			input.ComputerUse = &value
		}
	}
}

func workspaceAgentToolsControlDaemonCapabilities(values []string) bool {
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !strings.Contains(value, ":") {
			return true
		}
	}
	return false
}

func workspaceAgentHasTool(values []string, candidates ...string) bool {
	wanted := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		wanted[strings.ToLower(strings.TrimSpace(candidate))] = struct{}{}
	}
	for _, value := range values {
		if _, ok := wanted[strings.ToLower(strings.TrimSpace(value))]; ok {
			return true
		}
	}
	return false
}
