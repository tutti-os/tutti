package modelconsult

import (
	"context"
	"errors"
	"testing"

	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
	collabrunservice "github.com/tutti-os/tutti/services/tuttid/service/collabrun"
)

type fakeWorkspaceCatalog struct {
	startup workspacebiz.Summary
}

func (f fakeWorkspaceCatalog) Startup(context.Context) (*workspacebiz.Summary, error) {
	return &f.startup, nil
}

func (fakeWorkspaceCatalog) Get(_ context.Context, workspaceID string) (workspacebiz.Summary, error) {
	return workspacebiz.Summary{ID: workspaceID}, nil
}

type fakeModelPlans struct {
	workspaceID string
	plans       []modelplanbiz.PublicPlan
}

func (f *fakeModelPlans) ListPlans(_ context.Context, workspaceID string) ([]modelplanbiz.PublicPlan, error) {
	f.workspaceID = workspaceID
	return f.plans, nil
}

type fakeCollaborationRuns struct {
	input collabrunservice.StartConsultInput
	run   collabrunbiz.Run
	err   error
}

func (f *fakeCollaborationRuns) StartConsult(_ context.Context, input collabrunservice.StartConsultInput) (collabrunbiz.Run, error) {
	f.input = input
	return f.run, f.err
}

func TestModelPlansCommandListsOnlyEnabledPlans(t *testing.T) {
	plans := &fakeModelPlans{plans: []modelplanbiz.PublicPlan{
		{ID: "plan-1", Name: "Relay", Protocol: modelplanbiz.ProtocolOpenAI, DefaultModel: "grok-4.5", Enabled: true, Models: []modelplanbiz.Model{{ID: "grok-4.5", Name: "Grok 4.5"}}},
		{ID: "plan-2", Name: "Disabled", Enabled: false},
	}}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, plans, nil).newModelPlansCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Context: cliservice.InvokeContext{Source: "cli"},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if plans.workspaceID != "workspace-1" {
		t.Fatalf("workspaceID = %q, want workspace-1", plans.workspaceID)
	}
	values := output.Value["plans"].([]map[string]any)
	if len(values) != 1 || values[0]["id"] != "plan-1" {
		t.Fatalf("plans = %#v", values)
	}
	models := values[0]["models"].([]map[string]any)
	if len(models) != 1 || models[0]["id"] != "grok-4.5" {
		t.Fatalf("models = %#v", models)
	}
}

func TestRecommendModelsCommandFiltersAndExplainsRoutes(t *testing.T) {
	plans := &fakeModelPlans{plans: []modelplanbiz.PublicPlan{
		{ID: "plan-ready", Name: "Ready", Enabled: true, Status: modelplanbiz.StatusReady, Models: []modelplanbiz.Model{{ID: "vision", Name: "Vision", Capabilities: []string{"vision"}}}},
		{ID: "plan-text", Name: "Text", Enabled: true, Status: modelplanbiz.StatusReady, Models: []modelplanbiz.Model{{ID: "text", Name: "Text"}}},
	}}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, plans, nil).newRecommendModelsCommand()

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{"required-capability": []string{"vision"}},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	values := output.Value["recommendations"].([]map[string]any)
	if len(values) != 1 || values[0]["planId"] != "plan-ready" || values[0]["rank"] != 1 {
		t.Fatalf("recommendations = %#v", values)
	}
	reasons := values[0]["reasons"].([]string)
	if !containsReason(reasons, "capability:vision") || !containsReason(reasons, "tier:standard") {
		t.Fatalf("reasons = %#v", reasons)
	}
}

func containsReason(reasons []string, expected string) bool {
	for _, reason := range reasons {
		if reason == expected {
			return true
		}
	}
	return false
}

func TestConsultCommandDefaultsSessionIDFromInvokeContextAndSetsAgentTrigger(t *testing.T) {
	runs := &fakeCollaborationRuns{run: collabrunbiz.Run{ID: "run-1", Status: collabrunbiz.StatusCompleted, ResultText: "advice"}}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, nil, runs).newConsultCommand()

	required, ok := command.Capability.InputSchema["required"].([]string)
	if !ok {
		t.Fatalf("required schema = %#v", command.Capability.InputSchema["required"])
	}
	for _, field := range required {
		if field == "agent-session-id" {
			t.Fatalf("agent-session-id should not be a declared input: %#v", required)
		}
	}

	output, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Context: cliservice.InvokeContext{AgentSessionID: "SESSION-CONTEXT"},
		Input: map[string]any{
			"model-plan-id": "plan-1",
			"question":      "1+1=?",
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if runs.input.SourceSessionID != "SESSION-CONTEXT" {
		t.Fatalf("SourceSessionID = %q, want SESSION-CONTEXT", runs.input.SourceSessionID)
	}
	if runs.input.TriggerSource != string(collabrunbiz.TriggerAgent) {
		t.Fatalf("TriggerSource = %q, want %q", runs.input.TriggerSource, collabrunbiz.TriggerAgent)
	}
	if runs.input.WorkspaceID != "workspace-1" || runs.input.ModelPlanID != "plan-1" || runs.input.Question != "1+1=?" {
		t.Fatalf("input = %#v", runs.input)
	}
	if output.Value["resultText"] != "advice" {
		t.Fatalf("output = %#v", output.Value)
	}
}

func TestConsultCommandRequiresSessionIDWhenInvokeContextIsMissing(t *testing.T) {
	runs := &fakeCollaborationRuns{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, nil, runs).newConsultCommand()

	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Input: map[string]any{
			"model-plan-id": "plan-1",
			"question":      "1+1=?",
		},
	})
	if !errors.Is(err, cliservice.ErrInvalidInput) {
		t.Fatalf("err = %v, want ErrInvalidInput", err)
	}
}

func TestConsultCommandTruncatesContext(t *testing.T) {
	runs := &fakeCollaborationRuns{}
	command := NewProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, nil, runs).newConsultCommand()

	longContext := make([]byte, consultContextMaxChars+500)
	for index := range longContext {
		longContext[index] = 'a'
	}
	_, err := command.Handler(context.Background(), cliservice.InvokeRequest{
		Context: cliservice.InvokeContext{AgentSessionID: "SESSION-1"},
		Input: map[string]any{
			"model-plan-id": "plan-1",
			"question":      "q",
			"context":       string(longContext),
		},
	})
	if err != nil {
		t.Fatalf("Handler: %v", err)
	}
	if len(runs.input.ContextText) != consultContextMaxChars {
		t.Fatalf("ContextText length = %d, want %d", len(runs.input.ContextText), consultContextMaxChars)
	}
}
