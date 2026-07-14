package agentcontext

import (
	"context"

	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	"github.com/tutti-os/tutti/services/tuttid/service/cli/framework"
)

type skillBundleInput struct {
	AgentID        string `cli:"agent-id" advertise-required:"true" hint:"Use agent list --json to discover available agents."`
	AgentSessionID string `cli:"agent-session-id"`
	BrowserUse     bool   `cli:"browser-use"`
	ComputerUse    bool   `cli:"computer-use"`
	Provider       string `cli:"provider" hidden:"true"`
}

type skillBundleResult struct {
	Bundle agentservice.SkillBundle
	Legacy bool
}

func (p Provider) newSkillBundleCommand() cliservice.Command {
	return framework.Register(framework.CommandSpec[skillBundleInput]{
		ID:          appID + ".agent.tutti-cli-skill-bundle",
		Path:        []string{"agent", "tutti-cli-skill-bundle"},
		Summary:     "Get Tutti CLI skill bundle",
		Description: "Get a dynamically rendered Tutti skill bundle for an external agent runtime.",
		Kind:        framework.KindGet,
		Visibility:  cliservice.CapabilityVisibilityIntegration,
		Workspace:   framework.WorkspaceRequired,
		Workspaces:  p.workspaces,
		Inputs:      framework.FromStruct[skillBundleInput](),
		Output: framework.OutputSpec{
			DefaultMode: cliservice.OutputModeJSON,
			DefaultView: framework.ViewDetail,
			JSON:        true,
			JSONViews: map[framework.OutputView]func(any) map[string]any{
				framework.ViewDetail: func(result any) map[string]any {
					value := result.(skillBundleResult)
					return skillBundleValue(value.Bundle, value.Legacy)
				},
			},
		},
		Run: p.runSkillBundle,
	})
}

func (p Provider) runSkillBundle(ctx context.Context, invoke framework.InvokeContext, input skillBundleInput) (any, error) {
	if err := p.requireSessions(); err != nil {
		return nil, err
	}
	target, legacy, err := p.resolveAgentSelector(ctx, input.AgentID, input.Provider)
	if err != nil {
		return nil, err
	}
	bundle, err := p.sessions.GetSkillBundle(ctx, invoke.WorkspaceID, agentservice.SkillBundleInput{
		AgentTargetID:  target.ID,
		AgentSessionID: input.AgentSessionID,
		BrowserUse:     input.BrowserUse,
		ComputerUse:    input.ComputerUse,
	})
	if err != nil {
		return nil, err
	}
	return skillBundleResult{Bundle: bundle, Legacy: legacy}, nil
}

func skillBundleValue(bundle agentservice.SkillBundle, legacy bool) map[string]any {
	value := map[string]any{
		"schemaVersion": bundle.SchemaVersion,
		"agentTargetId": bundle.AgentTargetID,
		"provider":      bundle.Provider,
		"cliCommand":    bundle.CLICommand,
		"skills":        skillBundleSkillsValue(bundle.Skills),
	}
	if bundle.AgentSessionID != "" {
		value["agentSessionId"] = bundle.AgentSessionID
	}
	if bundle.RecommendedSystemPrompt != nil {
		value["recommendedSystemPrompt"] = map[string]any{
			"format":  bundle.RecommendedSystemPrompt.Format,
			"content": bundle.RecommendedSystemPrompt.Content,
		}
	}
	if legacy {
		value["schemaVersion"] = 1
		delete(value, "agentTargetId")
	}
	return value
}

func skillBundleSkillsValue(skills []agentservice.SkillMaterializationRecord) []any {
	values := make([]any, 0, len(skills))
	for _, skill := range skills {
		value := map[string]any{
			"skillId":      skill.SkillID,
			"slug":         skill.Slug,
			"deliveryMode": skill.DeliveryMode,
		}
		if skill.Content != "" {
			value["content"] = skill.Content
		}
		if len(skill.Files) > 0 {
			value["files"] = skillBundleFilesValue(skill.Files)
		}
		if skill.MaterializedPath != "" {
			value["materializedPath"] = skill.MaterializedPath
		}
		values = append(values, value)
	}
	return values
}

func skillBundleFilesValue(files []agentservice.SkillMaterializationFile) []any {
	values := make([]any, 0, len(files))
	for _, file := range files {
		values = append(values, map[string]any{
			"path":    file.Path,
			"content": file.Content,
		})
	}
	return values
}
