package agent

import (
	"context"
	"strings"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
)

type SkillBundleInput struct {
	AgentTargetID  string
	AgentSessionID string
	BrowserUse     bool
	ComputerUse    bool
}

type SkillBundle = runtimeprep.SkillBundle
type SkillMaterializationFile = runtimeprep.SkillMaterializationFile
type SkillMaterializationRecord = runtimeprep.SkillMaterializationRecord
type RecommendedSystemPrompt = runtimeprep.RecommendedSystemPrompt

func (s *Service) GetSkillBundle(ctx context.Context, workspaceID string, input SkillBundleInput) (SkillBundle, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentTargetID := strings.TrimSpace(input.AgentTargetID)
	if workspaceID == "" || agentTargetID == "" {
		return SkillBundle{}, ErrInvalidArgument
	}
	renderer, ok := s.RuntimePreparer.(runtimeprep.SkillBundleRenderer)
	if s.RuntimePreparer == nil || !ok {
		return SkillBundle{}, ErrSkillBundleUnavailable
	}
	launchInput := CreateSessionInput{
		AgentTargetID: agentTargetID,
	}
	launch, err := s.resolveCreateSessionLaunch(ctx, workspaceID, &launchInput)
	if err != nil {
		return SkillBundle{}, err
	}
	provider := launch.Provider
	var connector *runtimeprep.ConnectorAgentContext
	if sessionID := strings.TrimSpace(input.AgentSessionID); sessionID != "" {
		if session, ok := s.controller().Session(workspaceID, sessionID); ok && sessionHasConnectorBinding(session) {
			connector = &runtimeprep.ConnectorAgentContext{RoutingHints: s.activeConnectorRoutingHints()}
		}
	}
	return renderer.RenderSkillBundle(ctx, runtimeprep.PrepareInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: strings.TrimSpace(input.AgentSessionID),
		AgentTargetID:  agentTargetID,
		Provider:       provider,
		BrowserUse:     input.BrowserUse,
		ComputerUse:    input.ComputerUse,
		Connector:      connector,
	})
}

func sessionHasConnectorBinding(session ProviderRuntimeSession) bool {
	for _, binding := range session.MCPServers {
		if strings.TrimSpace(binding.Name) == "connector" && strings.TrimSpace(binding.Type) == "http" {
			return true
		}
	}
	return false
}

func (s *Service) activeConnectorRoutingHints() []runtimeprep.ConnectorRoutingHint {
	if s == nil || s.ConnectorRuntime == nil {
		return nil
	}
	hints := s.ConnectorRuntime.RoutingHints()
	result := make([]runtimeprep.ConnectorRoutingHint, 0, len(hints))
	for _, hint := range hints {
		hint.Aliases = append([]string(nil), hint.Aliases...)
		result = append(result, hint)
	}
	return result
}
