package workspace

import (
	"context"
	"strings"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

func (s *SQLiteStore) AdmitTuttiModeGoalReviewComplete(
	ctx context.Context,
	admission executionbiz.GoalReviewCompleteAdmission,
) (executionbiz.GoalReviewCompleteResult, error) {
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return executionbiz.GoalReviewCompleteResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if replay, found, err := readGoalReviewMutationResult[executionbiz.GoalReviewCompleteResult](
		ctx, tx, admission.WorkspaceID, admission.IssueID,
		admission.SourceSessionID, "complete", admission.RequestID,
		admission.InputSHA256,
	); err != nil || found {
		return replay, err
	}
	review, execution, err := getActiveGoalReviewTx(
		ctx, tx, admission.WorkspaceID, admission.IssueID,
	)
	if err != nil {
		return executionbiz.GoalReviewCompleteResult{}, err
	}
	if execution.SourceSessionID != admission.SourceSessionID ||
		execution.ActiveCheckpointID != admission.CheckpointID ||
		execution.GraphRevision != admission.ExpectedGraphRevision ||
		execution.Status != executionbiz.StatusPendingGoalReview {
		return executionbiz.GoalReviewCompleteResult{}, executionbiz.ErrCompleteRejected
	}
	if execution.ReviewMode == executionbiz.ReviewModeIndependent {
		if review.Status != executionbiz.GoalReviewStatusSubmitted {
			return executionbiz.GoalReviewCompleteResult{}, executionbiz.ErrCompleteRejected
		}
		if review.Verdict != executionbiz.GoalReviewVerdictSatisfied &&
			strings.TrimSpace(admission.DisagreementReason) == "" {
			return executionbiz.GoalReviewCompleteResult{}, executionbiz.ErrCompleteRejected
		}
	}
	if err := callGoalReviewStep(admission.BeforeStep, "checkpoint"); err != nil {
		return executionbiz.GoalReviewCompleteResult{}, err
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_execution_checkpoints
SET status = 'resolved', resolved_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND checkpoint_id = ?
  AND status = 'active'
`, unixMs(admission.Now), unixMs(admission.Now), admission.WorkspaceID,
		execution.ID, admission.CheckpointID)
	if err != nil {
		return executionbiz.GoalReviewCompleteResult{}, err
	}
	if err := requireRowsAffected(
		result, executionbiz.ErrCompleteRejected, "resolve Goal Review checkpoint",
	); err != nil {
		return executionbiz.GoalReviewCompleteResult{}, err
	}
	if err := callGoalReviewStep(admission.BeforeStep, "wake"); err != nil {
		return executionbiz.GoalReviewCompleteResult{}, err
	}
	if err := acknowledgeTuttiModeCheckpointWakesTx(
		ctx, tx, admission.WorkspaceID, execution.ID, admission.CheckpointID,
		admission.Now,
	); err != nil {
		return executionbiz.GoalReviewCompleteResult{}, err
	}
	if err := callGoalReviewStep(admission.BeforeStep, "audit"); err != nil {
		return executionbiz.GoalReviewCompleteResult{}, err
	}
	if strings.TrimSpace(admission.DisagreementReason) != "" {
		if err := insertGoalReviewAuditTx(
			ctx, tx, review, "review_disagreement", admission.SourceSessionID,
			admission.DisagreementReason,
			review.ID+":audit:disagreement:"+admission.RequestID, admission.Now,
		); err != nil {
			return executionbiz.GoalReviewCompleteResult{}, err
		}
	}
	if err := insertGoalReviewAuditTx(
		ctx, tx, review, "goal_review_completed", admission.SourceSessionID,
		admission.Decision, review.ID+":audit:complete:"+admission.RequestID,
		admission.Now,
	); err != nil {
		return executionbiz.GoalReviewCompleteResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_executions
SET status = 'completed', completed_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND status = 'pending_goal_review'
`, unixMs(admission.Now), unixMs(admission.Now), admission.WorkspaceID,
		execution.ID); err != nil {
		return executionbiz.GoalReviewCompleteResult{}, err
	}
	response := executionbiz.GoalReviewCompleteResult{
		ExecutionID: execution.ID, CheckpointID: admission.CheckpointID,
		GraphRevision: execution.GraphRevision, Decision: admission.Decision,
	}
	if err := insertGoalReviewMutationTx(
		ctx, tx, review, admission.SourceSessionID, "complete",
		admission.RequestID, admission.InputSHA256,
		admission.ExpectedGraphRevision, response, admission.Now,
	); err != nil {
		return executionbiz.GoalReviewCompleteResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return executionbiz.GoalReviewCompleteResult{}, err
	}
	return response, nil
}

func (s *SQLiteStore) AdmitTuttiModeSwitchReviewToSelf(
	ctx context.Context,
	admission executionbiz.SwitchReviewToSelfAdmission,
) (executionbiz.SwitchReviewToSelfResult, error) {
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return executionbiz.SwitchReviewToSelfResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if replay, found, err := readGoalReviewMutationResult[executionbiz.SwitchReviewToSelfResult](
		ctx, tx, admission.WorkspaceID, admission.IssueID,
		admission.RequestedByActorID, "switch_to_self", admission.RequestID,
		admission.InputSHA256,
	); err != nil || found {
		return replay, err
	}
	review, execution, err := getActiveGoalReviewTx(
		ctx, tx, admission.WorkspaceID, admission.IssueID,
	)
	if err != nil {
		return executionbiz.SwitchReviewToSelfResult{}, err
	}
	if execution.ReviewMode != executionbiz.ReviewModeIndependent ||
		execution.Status != executionbiz.StatusPendingGoalReview ||
		execution.ActiveCheckpointID != admission.CheckpointID ||
		execution.GraphRevision != admission.ExpectedGraphRevision ||
		review.Status != executionbiz.GoalReviewStatusFailed {
		return executionbiz.SwitchReviewToSelfResult{}, executionbiz.ErrSwitchReviewToSelfRejected
	}
	if err := callGoalReviewStep(admission.BeforeStep, "mode"); err != nil {
		return executionbiz.SwitchReviewToSelfResult{}, err
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_executions
SET review_mode = 'self', review_agent_target_id = '', updated_at_unix_ms = ?
WHERE workspace_id = ? AND execution_id = ? AND review_mode = 'independent'
`, unixMs(admission.Now), admission.WorkspaceID, execution.ID)
	if err != nil {
		return executionbiz.SwitchReviewToSelfResult{}, err
	}
	if err := requireRowsAffected(
		result, executionbiz.ErrSwitchReviewToSelfRejected,
		"switch Goal Review to self",
	); err != nil {
		return executionbiz.SwitchReviewToSelfResult{}, err
	}
	if err := callGoalReviewStep(admission.BeforeStep, "audit"); err != nil {
		return executionbiz.SwitchReviewToSelfResult{}, err
	}
	if err := insertGoalReviewAuditTx(
		ctx, tx, review, "review_mode_switched_to_self",
		admission.RequestedByActorID, admission.Reason,
		review.ID+":audit:switch:"+admission.RequestID, admission.Now,
	); err != nil {
		return executionbiz.SwitchReviewToSelfResult{}, err
	}
	if err := callGoalReviewStep(admission.BeforeStep, "wake"); err != nil {
		return executionbiz.SwitchReviewToSelfResult{}, err
	}
	if err := prepareGoalReviewMainWakeTx(ctx, tx, review, admission.Now); err != nil {
		return executionbiz.SwitchReviewToSelfResult{}, err
	}
	response := executionbiz.SwitchReviewToSelfResult{
		ExecutionID: execution.ID, ReviewID: review.ID, ReviewMode: "self",
	}
	if err := insertGoalReviewMutationTx(
		ctx, tx, review, admission.RequestedByActorID, "switch_to_self",
		admission.RequestID, admission.InputSHA256,
		admission.ExpectedGraphRevision, response, admission.Now,
	); err != nil {
		return executionbiz.SwitchReviewToSelfResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return executionbiz.SwitchReviewToSelfResult{}, err
	}
	return response, nil
}
