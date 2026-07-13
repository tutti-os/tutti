package agent

import (
	"context"
	"strings"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
)

type SkillBundleInput struct {
	AgentSessionID string
	Provider       string
	BrowserUse     bool
	ComputerUse    bool
}

type SkillBundle = runtimeprep.SkillBundle
type SkillMaterializationFile = runtimeprep.SkillMaterializationFile
type SkillMaterializationRecord = runtimeprep.SkillMaterializationRecord
type RecommendedSystemPrompt = runtimeprep.RecommendedSystemPrompt

func (s *Service) GetSkillBundle(ctx context.Context, workspaceID string, input SkillBundleInput) (SkillBundle, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	provider := strings.TrimSpace(input.Provider)
	if workspaceID == "" || provider == "" {
		return SkillBundle{}, ErrInvalidArgument
	}
	renderer, ok := s.RuntimePreparer.(runtimeprep.SkillBundleRenderer)
	if s.RuntimePreparer == nil || !ok {
		return SkillBundle{}, ErrSkillBundleUnavailable
	}
	return renderer.RenderSkillBundle(ctx, runtimeprep.PrepareInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: strings.TrimSpace(input.AgentSessionID),
		Provider:       provider,
		BrowserUse:     input.BrowserUse,
		ComputerUse:    input.ComputerUse,
	})
}
