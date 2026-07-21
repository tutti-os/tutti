package workspaceagent

import (
	"context"
	"errors"
	"testing"
	"time"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	modelplanservice "github.com/tutti-os/tutti/services/tuttid/service/modelplan"
)

type generationTargetResolver struct {
	target agenttargetbiz.Target
}

func (r generationTargetResolver) GetAgentTarget(context.Context, string) (agenttargetbiz.Target, error) {
	return r.target, nil
}

type generationPlanResolver struct {
	plan modelplanbiz.Plan
}

func (r generationPlanResolver) GetModelPlan(context.Context, string, string) (modelplanbiz.Plan, error) {
	return r.plan, nil
}

type generationCompleter struct {
	request modelplanservice.CompletionRequest
	result  modelplanservice.CompletionResult
}

func (c *generationCompleter) Complete(_ context.Context, request modelplanservice.CompletionRequest) (modelplanservice.CompletionResult, error) {
	c.request = request
	return c.result, nil
}

func TestGenerateConfigurationUsesSelectedPlanAndReturnsReviewableDraft(t *testing.T) {
	completer := &generationCompleter{result: modelplanservice.CompletionResult{
		Text: `{
  "name": "Release Reviewer",
  "purpose": "Review release readiness",
  "instructions": "Inspect changes, tests, and rollout risks before reporting evidence.",
  "callConditions": ["Use before a release candidate is approved."],
  "skills": ["code-review", "release-readiness"],
  "automationRules": [{
    "name": "Completion review",
    "trigger": "on_task_complete",
    "prompt": "Review the completed work and end the final non-empty line with exactly VERDICT: PASS or VERDICT: FAIL.",
    "maxRunsPerSession": 1,
    "maxTotalTokensPerSession": 50000
  }]
}`,
		Usage: modelplanservice.CompletionUsage{InputTokens: 120, OutputTokens: 80},
	}}
	service := Service{
		Completer: completer,
		Plans:     generationPlanResolver{plan: generationTestPlan()},
		Targets:   generationTargetResolver{target: generationTestTarget()},
	}

	generated, err := service.GenerateConfiguration(context.Background(), GenerateInput{
		WorkspaceID:          "ws",
		HarnessAgentTargetID: agenttargetbiz.IDLocalCodex,
		ModelPlanID:          "plan-1",
		Model:                "gpt-5",
		Requirements:         "Focus on releases",
	})
	if err != nil {
		t.Fatalf("GenerateConfiguration() error = %v", err)
	}
	if generated.Name != "Release Reviewer" || generated.UsedModelPlanID != "plan-1" || generated.UsedModel != "gpt-5" {
		t.Fatalf("generated = %#v", generated)
	}
	if len(generated.AutomationRules) != 1 || generated.AutomationRules[0].Action != "consult" {
		t.Fatalf("automation rules = %#v", generated.AutomationRules)
	}
	if generated.Usage.InputTokens != 120 || generated.Usage.OutputTokens != 80 {
		t.Fatalf("usage = %#v", generated.Usage)
	}
	if completer.request.APIKey != "secret" || completer.request.Model != "gpt-5" || completer.request.MaxTokens != configurationGenerationMaxTokens {
		t.Fatalf("completion request = %#v", completer.request)
	}
}

func TestGenerateConfigurationRejectsCompletionReviewWithoutVerdictProtocol(t *testing.T) {
	completer := &generationCompleter{result: modelplanservice.CompletionResult{Text: `{
  "name": "Reviewer",
  "purpose": "Review work",
  "instructions": "Review carefully.",
  "callConditions": ["After implementation"],
  "skills": ["code-review"],
  "automationRules": [{
    "name": "Unsafe review",
    "trigger": "on_task_complete",
    "prompt": "Say whether it looks good.",
    "maxRunsPerSession": 1,
    "maxTotalTokensPerSession": 50000
  }]
}`}}
	service := Service{
		Completer: completer,
		Plans:     generationPlanResolver{plan: generationTestPlan()},
		Targets:   generationTargetResolver{target: generationTestTarget()},
	}

	_, err := service.GenerateConfiguration(context.Background(), GenerateInput{
		WorkspaceID:          "ws",
		HarnessAgentTargetID: agenttargetbiz.IDLocalCodex,
		ModelPlanID:          "plan-1",
	})
	if !errors.Is(err, ErrGenerationInvalidOutput) {
		t.Fatalf("GenerateConfiguration() error = %v, want ErrGenerationInvalidOutput", err)
	}
}

func generationTestTarget() agenttargetbiz.Target {
	return agenttargetbiz.Target{
		ID:              agenttargetbiz.IDLocalCodex,
		Provider:        "codex",
		LaunchRefJSON:   agenttargetbiz.MustLocalCLILaunchRefJSON("codex"),
		Name:            "Codex",
		Enabled:         true,
		Source:          agenttargetbiz.SourceSystem,
		CreatedAtUnixMS: 1,
		UpdatedAtUnixMS: 1,
	}
}

func generationTestPlan() modelplanbiz.Plan {
	now := time.Unix(1, 0).UTC()
	return modelplanbiz.Plan{
		ID:           "plan-1",
		WorkspaceID:  "ws",
		Name:         "OpenAI",
		Protocol:     modelplanbiz.ProtocolOpenAI,
		APIKey:       "secret",
		BaseURL:      "https://api.example.com/v1",
		Models:       []modelplanbiz.Model{{ID: "gpt-5", Name: "GPT-5"}},
		DefaultModel: "gpt-5",
		Enabled:      true,
		Detection: modelplanbiz.DetectionSnapshot{
			CheckedAt: now,
			Stages: []modelplanbiz.StageResult{
				{Stage: modelplanbiz.StageNetwork, Status: modelplanbiz.StagePassed},
				{Stage: modelplanbiz.StageAuth, Status: modelplanbiz.StagePassed},
				{Stage: modelplanbiz.StageModelDiscovery, Status: modelplanbiz.StagePassed},
				{Stage: modelplanbiz.StageInference, Status: modelplanbiz.StagePassed},
			},
		},
	}
}
