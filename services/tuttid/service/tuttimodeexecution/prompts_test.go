package tuttimodeexecution

import (
	"encoding/json"
	"strings"
	"testing"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

func TestMainWakePromptLeadsWithParsableCheckpointMarker(t *testing.T) {
	prompt := MainWakePrompt(executionbiz.Wake{
		IssueID: "issue-1", CheckpointID: "checkpoint-1",
		CheckpointKind:     executionbiz.CheckpointKindTaskSettled,
		CheckpointRevision: 7,
	})
	firstLine := prompt
	if idx := strings.IndexByte(prompt, '\n'); idx >= 0 {
		firstLine = prompt[:idx]
	}
	if !strings.HasPrefix(firstLine, MainWakeMarkerPrefix) ||
		!strings.HasSuffix(firstLine, mainWakeMarkerSuffix) {
		t.Fatalf("first line is not the checkpoint-wake marker: %q", firstLine)
	}
	payload := strings.TrimSuffix(
		strings.TrimPrefix(firstLine, MainWakeMarkerPrefix),
		mainWakeMarkerSuffix,
	)
	var decoded mainWakeMarker
	if err := json.Unmarshal([]byte(payload), &decoded); err != nil {
		t.Fatalf("marker payload is not valid JSON: %v (%q)", err, payload)
	}
	if decoded.Version != 1 || decoded.Kind != "task_settled" ||
		decoded.IssueID != "issue-1" || decoded.CheckpointID != "checkpoint-1" ||
		decoded.GraphRevision != 7 {
		t.Fatalf("unexpected marker payload: %+v", decoded)
	}
	// The full prompt body must remain intact after the marker so the agent
	// contract is unchanged.
	if !strings.Contains(prompt, "A durable Tutti Mode execution checkpoint requires your review.") {
		t.Fatalf("marker replaced the prompt body instead of prefixing it:\n%s", prompt)
	}
}

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

func TestTaskCanceledMainWakePromptCarriesExactMutationSchema(t *testing.T) {
	prompt := MainWakePrompt(executionbiz.Wake{
		IssueID: "issue-1", CheckpointID: "checkpoint-1",
		CheckpointKind:     executionbiz.CheckpointKindTaskCanceled,
		CheckpointRevision: 7,
	})
	for _, want := range []string{
		"tutti plan issue get --issue-id issue-1 --json",
		"tutti plan issue mutate",
		"--issue-id issue-1",
		"--checkpoint-id checkpoint-1",
		"--expected-graph-revision 7",
		`--operations-json '[{"kind":"supersede","taskId":"<task-id>"}]'`,
		`--operations-json '[{"kind":"rework","taskId":"<old-task-id>","task":{"taskId":"<replacement-task-id>"`,
		`"op" and "replacement" are not supported`,
		"preserve task and Run history",
		"inherits omitted launch settings, execution directory, and dependencies",
		"canceled task cannot be updated or scheduled directly",
		"graphRevision returned by the successful mutation",
		"only supported execution control plane",
		"Do not inspect or modify Tutti's backing SQLite databases",
		"tutti plan issue stop",
		"--reason '<audited-reason>'",
		"so no later checkpoint wake is emitted",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("MainWakePrompt() missing %q:\n%s", want, prompt)
		}
	}
}

func TestTaskFailedMainWakePromptExplainsReworkRecovery(t *testing.T) {
	prompt := MainWakePrompt(executionbiz.Wake{
		IssueID: "issue-1", CheckpointID: "checkpoint-1",
		CheckpointKind:     executionbiz.CheckpointKindTaskFailed,
		CheckpointRevision: 7,
	})
	for _, want := range []string{
		"automatically redirects active, not-started dependents",
		"failed task cannot be updated or scheduled directly",
		"rework it with a new taskId and corrected launch settings",
		"graphRevision returned by the successful mutation",
		"Keep checkpoint checkpoint-1",
		"do not guess or increment the revision",
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
