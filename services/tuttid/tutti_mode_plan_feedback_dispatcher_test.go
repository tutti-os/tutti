package main

import (
	"strings"
	"testing"

	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
)

func TestTuttiModePlanFeedbackPromptCarriesReviseInstructions(t *testing.T) {
	t.Parallel()
	prompt := tuttiModePlanFeedbackPromptForCLI(tuttimodeplanservice.PlanRevisionFeedbackInput{
		WorkspaceID:     "workspace-1",
		WorkflowID:      "workflow-9",
		CheckpointID:    "checkpoint-3",
		RevisionID:      "revision-2",
		SourceSessionID: "session-1",
		Feedback:        "  Split task two into smaller steps  ",
	}, "tutti")
	for _, expected := range []string{
		"requested changes",
		"Workflow ID: workflow-9",
		"Rejected checkpoint ID: checkpoint-3",
		"Split task two into smaller steps",
		"shell command, not a built-in tool",
		"launch configuration complete: agentTargetId, model, and permissionModeId",
		"execution.reasoningIntensity set",
		"tutti plan revise --workflow-id workflow-9",
		"End the turn as soon as revise succeeds",
		"arrives as a new user message",
		"tutti-mode-plan/v1",
	} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("prompt = %q, want %q", prompt, expected)
		}
	}
	if strings.Contains(prompt, "plan wait") {
		t.Fatalf("prompt = %q, must not instruct a wait command", prompt)
	}
	if strings.Contains(prompt, "  Split task two") {
		t.Fatalf("prompt did not trim feedback: %q", prompt)
	}
}

func TestTuttiModePlanFeedbackPromptUsesResolvedCLICommandName(t *testing.T) {
	t.Parallel()
	prompt := tuttiModePlanFeedbackPromptForCLI(tuttimodeplanservice.PlanRevisionFeedbackInput{
		WorkflowID:   "workflow-9",
		CheckpointID: "checkpoint-3",
		Feedback:     "tighten task one",
	}, "tutti-dev")
	for _, expected := range []string{
		"tutti-dev plan revise --workflow-id workflow-9",
	} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("prompt = %q, want %q", prompt, expected)
		}
	}
	if strings.Contains(prompt, "tutti plan revise") {
		t.Fatalf("prompt = %q, must not fall back to the production CLI name", prompt)
	}
}

func TestTuttiModePlanFeedbackDispatcherFailsClosedWithoutAgents(t *testing.T) {
	t.Parallel()
	dispatcher := &tuttiModePlanFeedbackDispatcher{}
	if err := dispatcher.DispatchPlanRevisionFeedback(t.Context(), tuttimodeplanservice.PlanRevisionFeedbackInput{}); err == nil {
		t.Fatal("DispatchPlanRevisionFeedback() error = nil, want unavailable")
	}
}
