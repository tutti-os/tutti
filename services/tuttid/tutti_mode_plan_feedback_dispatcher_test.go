package main

import (
	"strings"
	"testing"

	tuttimodeplanservice "github.com/tutti-os/tutti/services/tuttid/service/tuttimodeplan"
)

func TestTuttiModePlanFeedbackPromptCarriesReviseInstructions(t *testing.T) {
	t.Parallel()
	prompt := tuttiModePlanFeedbackPrompt(tuttimodeplanservice.PlanRevisionFeedbackInput{
		WorkspaceID:     "workspace-1",
		WorkflowID:      "workflow-9",
		CheckpointID:    "checkpoint-3",
		RevisionID:      "revision-2",
		SourceSessionID: "session-1",
		Feedback:        "  Split task two into smaller steps  ",
	})
	for _, expected := range []string{
		"requested changes",
		"Workflow ID: workflow-9",
		"Rejected checkpoint ID: checkpoint-3",
		"Split task two into smaller steps",
		"tutti plan revise --workflow-id workflow-9",
		"tutti plan wait --workflow-id workflow-9",
		"tutti-mode-plan/v1",
	} {
		if !strings.Contains(prompt, expected) {
			t.Fatalf("prompt = %q, want %q", prompt, expected)
		}
	}
	if strings.Contains(prompt, "  Split task two") {
		t.Fatalf("prompt did not trim feedback: %q", prompt)
	}
}

func TestTuttiModePlanFeedbackDispatcherFailsClosedWithoutAgents(t *testing.T) {
	t.Parallel()
	dispatcher := &tuttiModePlanFeedbackDispatcher{}
	if err := dispatcher.DispatchPlanRevisionFeedback(t.Context(), tuttimodeplanservice.PlanRevisionFeedbackInput{}); err == nil {
		t.Fatal("DispatchPlanRevisionFeedback() error = nil, want unavailable")
	}
}
