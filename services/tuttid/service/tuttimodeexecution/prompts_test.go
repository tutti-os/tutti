package tuttimodeexecution

import (
	"strings"
	"testing"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

func TestReviewerPromptCarriesExactFencedVerdictCommand(t *testing.T) {
	review := executionbiz.GoalReview{
		ID: "review-1", IssueID: "issue-1", CheckpointID: "checkpoint-1",
		GraphRevision: 7,
	}
	prompt := ReviewerPrompt(review)
	for _, want := range []string{
		"tutti goal-review verdict",
		"--issue-id issue-1",
		"--review-id review-1",
		"--checkpoint-id checkpoint-1",
		"--expected-graph-revision 7",
		"--verdict '<goal_satisfied|more_work_required|inconclusive>'",
		"--summary '<evidence-based-summary>'",
		"--request-id '<stable-request-id>'",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("ReviewerPrompt() missing %q:\n%s", want, prompt)
		}
	}
}

func TestGoalReviewMainWakePromptCarriesExactCompleteCommand(t *testing.T) {
	prompt := MainWakePrompt(executionbiz.Wake{
		IssueID: "issue-1", CheckpointID: "checkpoint-1",
		CheckpointKind:     executionbiz.CheckpointKindAllTasksTerminal,
		CheckpointRevision: 7,
	})
	for _, want := range []string{
		"tutti plan issue complete",
		"--issue-id issue-1",
		"--checkpoint-id checkpoint-1",
		"--expected-graph-revision 7",
		"--decision goal_satisfied",
		"--request-id '<stable-request-id>'",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("MainWakePrompt() missing %q:\n%s", want, prompt)
		}
	}
}

func TestIndependentGoalReviewMainWakePromptCarriesRecommendationEvidence(
	t *testing.T,
) {
	prompt := MainWakePrompt(executionbiz.Wake{
		IssueID: "issue-1", CheckpointID: "checkpoint-1",
		CheckpointKind:     executionbiz.CheckpointKindAllTasksTerminal,
		CheckpointRevision: 7,
		ReviewMode:         executionbiz.ReviewModeIndependent,
		ReviewID:           "review-1",
		ReviewStatus:       executionbiz.GoalReviewStatusSubmitted,
		ReviewVerdict:      executionbiz.GoalReviewVerdictMoreWork,
		ReviewSummary:      "The acceptance test still fails.",
	})
	for _, want := range []string{
		"Review: review-1",
		"Verdict: more_work_required",
		"Summary: The acceptance test still fails.",
		"--disagreement-reason",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("MainWakePrompt() missing %q:\n%s", want, prompt)
		}
	}
}

func TestFailedIndependentReviewMainWakePromptFailsClosed(t *testing.T) {
	prompt := MainWakePrompt(executionbiz.Wake{
		IssueID: "issue-1", CheckpointID: "checkpoint-1",
		CheckpointKind:      executionbiz.CheckpointKindAllTasksTerminal,
		CheckpointRevision:  7,
		ReviewMode:          executionbiz.ReviewModeIndependent,
		ReviewID:            "review-1",
		ReviewStatus:        executionbiz.GoalReviewStatusFailed,
		ReviewFailureReason: "reviewer Turn settled without a verdict",
	})
	for _, want := range []string{
		"failed closed",
		"reviewer Turn settled without a verdict",
		"explicit audited user action",
		"switch this execution to self review",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("MainWakePrompt() missing %q:\n%s", want, prompt)
		}
	}
}
