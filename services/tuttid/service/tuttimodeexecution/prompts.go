package tuttimodeexecution

import (
	"fmt"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

func MainWakePrompt(wake executionbiz.Wake) string {
	schedule := fmt.Sprintf(
		"tutti plan issue schedule --issue-id %s --checkpoint-id %s --expected-graph-revision %d",
		wake.IssueID, wake.CheckpointID, wake.CheckpointRevision,
	)
	header := fmt.Sprintf(`A durable Tutti Mode execution checkpoint requires your review.

Issue: %s
Checkpoint: %s
Kind: %s
Graph revision: %d

Review the current Issue, task results, and evidence before choosing the next action. The daemon does not dispatch a successor automatically.

To schedule an exact next set, use:
%s --task-ids-json '<json-array>' --request-id '<stable-request-id>'`,
		wake.IssueID, wake.CheckpointID, wake.CheckpointKind,
		wake.CheckpointRevision, schedule,
	)
	switch wake.CheckpointKind {
	case executionbiz.CheckpointKindTaskSettled,
		executionbiz.CheckpointKindTaskFailed,
		executionbiz.CheckpointKindTaskCanceled:
		return header + fmt.Sprintf(`

If another Run is active or a later checkpoint is pending, you may resolve this review without adding work:
tutti plan issue acknowledge --issue-id %s --checkpoint-id %s --expected-graph-revision %d --request-id '<stable-request-id>'`,
			wake.IssueID, wake.CheckpointID, wake.CheckpointRevision,
		)
	default:
		if wake.CheckpointKind == executionbiz.CheckpointKindAllTasksTerminal {
			reviewEvidence := ""
			if wake.ReviewMode == executionbiz.ReviewModeIndependent {
				switch wake.ReviewStatus {
				case executionbiz.GoalReviewStatusSubmitted:
					reviewEvidence = fmt.Sprintf(`

Independent reviewer evidence:
- Review: %s
- Verdict: %s
- Summary: %s`,
						wake.ReviewID, wake.ReviewVerdict, wake.ReviewSummary,
					)
					if wake.ReviewVerdict != executionbiz.GoalReviewVerdictSatisfied {
						reviewEvidence += `

Completing despite this non-satisfied recommendation requires a nonempty --disagreement-reason that will be audited.`
					}
				case executionbiz.GoalReviewStatusFailed:
					reviewEvidence = fmt.Sprintf(`

The independent reviewer failed closed:
- Review: %s
- Failure: %s

Do not silently weaken review. Only an explicit audited user action may switch this execution to self review.`,
						wake.ReviewID, wake.ReviewFailureReason,
					)
				}
			}
			return header + reviewEvidence + fmt.Sprintf(`

This is the final Goal Review checkpoint. If the goal is satisfied, complete it explicitly:
tutti plan issue complete --issue-id %s --checkpoint-id %s --expected-graph-revision %d --decision goal_satisfied --request-id '<stable-request-id>'

If more work is required, mutate and schedule an exact follow-up graph instead. Do not use acknowledge for Goal Review.`,
				wake.IssueID, wake.CheckpointID, wake.CheckpointRevision,
			)
		}
		return header + `

Do not use acknowledge for initial scheduling or Goal Review; choose a legal checkpoint-fenced command.`
	}
}

func ReviewerPrompt(review executionbiz.GoalReview) string {
	return fmt.Sprintf(`Review this Tutti Mode execution as an independent, read-only reviewer.

Issue: %s
Review: %s
Checkpoint: %s
Graph revision: %d

Inspect the Issue, tasks, Runs, outputs, and acceptance evidence. You cannot schedule, mutate, acknowledge, complete, or archive this execution.

Submit exactly one structured verdict with the dedicated Goal Review capability:
- goal_satisfied
- more_work_required
- inconclusive

Run:
tutti goal-review verdict --issue-id %s --review-id %s --checkpoint-id %s --expected-graph-revision %d --verdict '<goal_satisfied|more_work_required|inconclusive>' --summary '<evidence-based-summary>' --request-id '<stable-request-id>'

Do not rely on prose as the verdict; the durable structured command is required.`,
		review.IssueID, review.ID, review.CheckpointID, review.GraphRevision,
		review.IssueID, review.ID, review.CheckpointID, review.GraphRevision,
	)
}
