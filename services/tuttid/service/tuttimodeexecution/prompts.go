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
	mutate := fmt.Sprintf(
		"tutti plan issue mutate --issue-id %s --checkpoint-id %s --expected-graph-revision %d",
		wake.IssueID, wake.CheckpointID, wake.CheckpointRevision,
	)
	stop := fmt.Sprintf(
		"tutti plan issue stop --issue-id %s --checkpoint-id %s --expected-graph-revision %d",
		wake.IssueID, wake.CheckpointID, wake.CheckpointRevision,
	)
	header := fmt.Sprintf(`A durable Tutti Mode execution checkpoint requires your review.

Issue: %s
Checkpoint: %s
Kind: %s
Graph revision: %d

Review the current Issue, task results, and evidence before choosing the next action. The daemon does not dispatch a successor automatically.

First read the source-scoped execution snapshot:
tutti plan issue get --issue-id %s --json

To schedule an exact next set, use:
%s --task-ids-json '<json-array>' --request-id '<stable-request-id>'

To change the remaining graph at this checkpoint before scheduling, use:
%s --operations-json '[{"kind":"supersede","taskId":"<task-id>"}]' --request-id '<stable-request-id>'

To replace a task while preserving its history, use:
%s --operations-json '[{"kind":"rework","taskId":"<old-task-id>","task":{"taskId":"<replacement-task-id>","title":"<title>","content":"<details>"}}]' --request-id '<stable-request-id>'

Mutation entries use the "kind" field; "op" and "replacement" are not supported. Rework and supersede preserve task and Run history. A rework replacement inherits omitted launch settings, execution directory, and dependencies from the old task; explicit replacement values override those defaults. Rework automatically redirects active, not-started dependents from the old task ID to the replacement task ID in the same mutation.

Use the Tutti CLI as the only supported execution control plane. Do not inspect or modify Tutti's backing SQLite databases to diagnose or bypass a rejected command; report the CLI error if the current Issue snapshot and documented recovery commands cannot resolve it.

If this Issue has been replaced or should not continue, stop it explicitly so no later checkpoint wake is emitted:
%s --reason '<audited-reason>' --request-id '<stable-request-id>'`,
		wake.IssueID, wake.CheckpointID, wake.CheckpointKind,
		wake.CheckpointRevision, wake.IssueID, schedule, mutate, mutate, stop,
	)
	switch wake.CheckpointKind {
	case executionbiz.CheckpointKindTaskFailed,
		executionbiz.CheckpointKindTaskCanceled:
		outcome := "failed"
		if wake.CheckpointKind == executionbiz.CheckpointKindTaskCanceled {
			outcome = "canceled"
		}
		return header + fmt.Sprintf(`

The %s task cannot be updated or scheduled directly. To retry it, rework it with a new taskId and corrected launch settings, then schedule the replacement using the graphRevision returned by the successful mutation. Keep checkpoint %s; do not guess or increment the revision before a command succeeds.

If another Run is active or a later checkpoint is pending, you may resolve this review without adding work:
tutti plan issue acknowledge --issue-id %s --checkpoint-id %s --expected-graph-revision %d --request-id '<stable-request-id>'`,
			outcome, wake.CheckpointID, wake.IssueID, wake.CheckpointID,
			wake.CheckpointRevision,
		)
	case executionbiz.CheckpointKindTaskSettled:
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
