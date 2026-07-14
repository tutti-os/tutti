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
	launch, err := s.resolveCreateSessionLaunch(ctx, CreateSessionInput{
		AgentTargetID: agentTargetID,
	})
	if err != nil {
		return SkillBundle{}, err
	}
	provider := launch.Provider
	return renderer.RenderSkillBundle(ctx, runtimeprep.PrepareInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: strings.TrimSpace(input.AgentSessionID),
		AgentTargetID:  agentTargetID,
		Provider:       provider,
		BrowserUse:     input.BrowserUse,
		ComputerUse:    input.ComputerUse,
	})
}
