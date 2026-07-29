package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

func prepareTuttiModeGoalReviewTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	executionID string,
	checkpoint executionbiz.Checkpoint,
	now time.Time,
) error {
	if checkpoint.Status != executionbiz.CheckpointStatusActive ||
		checkpoint.Kind != executionbiz.CheckpointKindAllTasksTerminal {
		return executionbiz.ErrExecutionConflict
	}
	var mode executionbiz.ReviewMode
	var targetID string
	if err := tx.QueryRowContext(ctx, `
SELECT review_mode, review_agent_target_id
FROM workspace_tutti_executions
WHERE workspace_id = ? AND execution_id = ?
`, workspaceID, executionID).Scan(&mode, &targetID); err != nil {
		return fmt.Errorf("read Goal Review configuration: %w", err)
	}
	if mode == executionbiz.ReviewModeSelf {
		return prepareTuttiModeMainWakeTx(
			ctx, tx, workspaceID, executionID, checkpoint, now,
		)
	}
	reviewID, reviewOK := executionbiz.GoalReviewID(checkpoint.ID)
	sessionID, sessionOK := executionbiz.GoalReviewSessionID(reviewID)
	submitID, submitOK := executionbiz.GoalReviewClientSubmitID(reviewID)
	if mode != executionbiz.ReviewModeIndependent ||
		strings.TrimSpace(targetID) == "" ||
		!reviewOK || !sessionOK || !submitOK {
		return executionbiz.ErrExecutionConflict
	}
	_, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO workspace_tutti_goal_reviews (
  workspace_id, execution_id, checkpoint_id, review_id,
  review_agent_target_id, review_session_id, client_submit_id,
  status, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
`, workspaceID, executionID, checkpoint.ID, reviewID, targetID, sessionID,
		submitID, unixMs(now), unixMs(now))
	if err != nil {
		return fmt.Errorf("prepare independent Goal Review: %w", err)
	}
	return nil
}

func (s *SQLiteStore) ListTuttiModeGoalReviews(
	ctx context.Context,
	workspaceID string,
	issueID string,
) ([]executionbiz.GoalReview, error) {
	rows, err := s.readDB.QueryContext(ctx, goalReviewSelect+`
WHERE r.workspace_id = ? AND e.issue_id = ?
ORDER BY r.created_at_unix_ms, r.review_id
`, strings.TrimSpace(workspaceID), strings.TrimSpace(issueID))
	if err != nil {
		return nil, fmt.Errorf("list Tutti mode Goal Reviews: %w", err)
	}
	return scanGoalReviews(rows)
}

func (s *SQLiteStore) ListTuttiModeGoalReviewAudit(
	ctx context.Context,
	workspaceID string,
	issueID string,
) ([]executionbiz.ReviewAuditEntry, error) {
	rows, err := s.readDB.QueryContext(ctx, `
SELECT a.audit_id, a.workspace_id, a.execution_id, a.review_id,
       a.kind, a.actor_id, a.reason, a.created_at_unix_ms
FROM workspace_tutti_goal_review_audit a
JOIN workspace_tutti_executions e
  ON e.workspace_id = a.workspace_id AND e.execution_id = a.execution_id
WHERE a.workspace_id = ? AND e.issue_id = ?
ORDER BY a.created_at_unix_ms, a.audit_id
`, strings.TrimSpace(workspaceID), strings.TrimSpace(issueID))
	if err != nil {
		return nil, fmt.Errorf("list Tutti mode Goal Review audit: %w", err)
	}
	defer func() { _ = rows.Close() }()
	var entries []executionbiz.ReviewAuditEntry
	for rows.Next() {
		var entry executionbiz.ReviewAuditEntry
		var createdAt int64
		if err := rows.Scan(
			&entry.ID, &entry.WorkspaceID, &entry.ExecutionID, &entry.ReviewID,
			&entry.Kind, &entry.ActorID, &entry.Reason, &createdAt,
		); err != nil {
			return nil, fmt.Errorf("scan Goal Review audit: %w", err)
		}
		entry.CreatedAt = time.UnixMilli(createdAt).UTC()
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}

func (s *SQLiteStore) ListDispatchableTuttiModeGoalReviews(
	ctx context.Context,
	workspaceID string,
	now time.Time,
) ([]executionbiz.GoalReview, error) {
	rows, err := s.readDB.QueryContext(ctx, goalReviewSelect+`
WHERE r.workspace_id = ? AND r.status = 'prepared'
  AND (r.lease_owner = '' OR r.lease_expires_at_unix_ms <= ?)
ORDER BY r.created_at_unix_ms, r.review_id
`, strings.TrimSpace(workspaceID), unixMs(now))
	if err != nil {
		return nil, fmt.Errorf("list dispatchable Goal Reviews: %w", err)
	}
	return scanGoalReviews(rows)
}

func (s *SQLiteStore) ClaimTuttiModeGoalReview(
	ctx context.Context,
	workspaceID string,
	reviewID string,
	leaseOwner string,
	now time.Time,
	leaseExpiresAt time.Time,
) (bool, error) {
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspace_tutti_goal_reviews
SET lease_owner = ?, lease_expires_at_unix_ms = ?,
    attempt_count = attempt_count + 1, updated_at_unix_ms = ?
WHERE workspace_id = ? AND review_id = ? AND status = 'prepared'
  AND (lease_owner = '' OR lease_expires_at_unix_ms <= ?)
`, leaseOwner, unixMs(leaseExpiresAt), unixMs(now), workspaceID, reviewID, unixMs(now))
	if err != nil {
		return false, fmt.Errorf("claim Goal Review: %w", err)
	}
	affected, err := result.RowsAffected()
	return affected == 1, err
}

func (s *SQLiteStore) MarkTuttiModeGoalReviewDispatched(
	ctx context.Context,
	workspaceID string,
	reviewID string,
	leaseOwner string,
	canonicalSessionID string,
	canonicalTurnID string,
	now time.Time,
) error {
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_goal_reviews
SET status = 'dispatched', review_turn_id = ?,
    lease_owner = '', lease_expires_at_unix_ms = 0, updated_at_unix_ms = ?
WHERE workspace_id = ? AND review_id = ? AND status = 'prepared'
  AND lease_owner = ? AND review_session_id = ?
`, canonicalTurnID, unixMs(now), workspaceID, reviewID, leaseOwner, canonicalSessionID)
	if err != nil {
		return fmt.Errorf("mark Goal Review dispatched: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if affected == 1 {
		return tx.Commit()
	}
	review, err := getGoalReviewTx(ctx, tx, workspaceID, reviewID)
	if err != nil {
		return err
	}
	if review.SessionID != canonicalSessionID ||
		review.TurnID != canonicalTurnID ||
		(review.Status != executionbiz.GoalReviewStatusDispatched &&
			review.Status != executionbiz.GoalReviewStatusSubmitted &&
			review.Status != executionbiz.GoalReviewStatusFailed) {
		return executionbiz.ErrReviewerVerdictRejected
	}
	return tx.Commit()
}

func (s *SQLiteStore) FailTuttiModeGoalReview(
	ctx context.Context,
	workspaceID string,
	reviewID string,
	leaseOwner string,
	reason string,
	now time.Time,
) error {
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	review, err := getGoalReviewTx(ctx, tx, workspaceID, reviewID)
	if err != nil {
		return err
	}
	if review.Status == executionbiz.GoalReviewStatusFailed ||
		review.Status == executionbiz.GoalReviewStatusSubmitted {
		return tx.Commit()
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_goal_reviews
SET status = 'failed', failure_reason = ?, lease_owner = '',
    lease_expires_at_unix_ms = 0, updated_at_unix_ms = ?
WHERE workspace_id = ? AND review_id = ? AND status = 'prepared'
  AND lease_owner = ?
`, reason, unixMs(now), workspaceID, reviewID, leaseOwner)
	if err != nil {
		return err
	}
	if err := requireRowsAffected(
		result, executionbiz.ErrReviewerVerdictRejected, "fail Goal Review",
	); err != nil {
		return err
	}
	if err := insertGoalReviewAuditTx(
		ctx, tx, review, "review_failed", review.SessionID, reason,
		review.ID+":audit:failed", now,
	); err != nil {
		return err
	}
	if err := prepareGoalReviewMainWakeTx(ctx, tx, review, now); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *SQLiteStore) SettleTuttiModeGoalReviewWithoutVerdict(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	turnID string,
	reason string,
	now time.Time,
) error {
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	review, err := getGoalReviewByTurnTx(ctx, tx, workspaceID, sessionID, turnID)
	if err != nil {
		return err
	}
	if review.Status == executionbiz.GoalReviewStatusFailed ||
		review.Status == executionbiz.GoalReviewStatusSubmitted {
		return tx.Commit()
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_goal_reviews
SET status = 'failed', failure_reason = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND review_id = ? AND status = 'dispatched'
`, reason, unixMs(now), workspaceID, review.ID)
	if err != nil {
		return err
	}
	if err := requireRowsAffected(
		result, executionbiz.ErrReviewerVerdictRejected,
		"settle Goal Review without verdict",
	); err != nil {
		return err
	}
	if err := insertGoalReviewAuditTx(
		ctx, tx, review, "review_failed", sessionID, reason,
		review.ID+":audit:no-verdict", now,
	); err != nil {
		return err
	}
	if err := prepareGoalReviewMainWakeTx(ctx, tx, review, now); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *SQLiteStore) AdmitTuttiModeReviewerVerdict(
	ctx context.Context,
	admission executionbiz.ReviewerVerdictAdmission,
) (executionbiz.ReviewerVerdictResult, error) {
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return executionbiz.ReviewerVerdictResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if replay, found, err := readGoalReviewMutationResult[executionbiz.ReviewerVerdictResult](
		ctx, tx, admission.WorkspaceID, admission.IssueID,
		admission.ReviewSessionID, "verdict", admission.RequestID,
		admission.InputSHA256,
	); err != nil || found {
		return replay, err
	}
	review, err := getGoalReviewTx(ctx, tx, admission.WorkspaceID, admission.ReviewID)
	if err != nil {
		return executionbiz.ReviewerVerdictResult{}, err
	}
	fastPreparedVerdict := review.Status == executionbiz.GoalReviewStatusPrepared &&
		review.TurnID == "" &&
		review.LeaseOwner != "" &&
		review.LeaseExpiresAt.After(admission.Now)
	dispatchedVerdict := review.Status == executionbiz.GoalReviewStatusDispatched &&
		review.TurnID == admission.ReviewTurnID
	if review.IssueID != admission.IssueID ||
		review.SessionID != admission.ReviewSessionID ||
		review.CheckpointID != admission.CheckpointID ||
		(!fastPreparedVerdict && !dispatchedVerdict) {
		return executionbiz.ReviewerVerdictResult{}, executionbiz.ErrReviewerVerdictRejected
	}
	if err := validateGoalReviewFenceTx(
		ctx, tx, review, admission.ExpectedGraphRevision,
		executionbiz.ReviewModeIndependent,
	); err != nil {
		return executionbiz.ReviewerVerdictResult{}, err
	}
	if err := callGoalReviewStep(admission.BeforeStep, "review"); err != nil {
		return executionbiz.ReviewerVerdictResult{}, err
	}
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_tutti_goal_reviews
SET status = 'submitted', review_turn_id = ?, verdict = ?, summary = ?,
    lease_owner = '', lease_expires_at_unix_ms = 0,
    submitted_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE workspace_id = ? AND review_id = ?
  AND (
    (status = 'dispatched' AND review_turn_id = ?)
    OR
    (status = 'prepared' AND review_turn_id = '' AND lease_owner <> ''
      AND lease_expires_at_unix_ms > ?)
  )
`, admission.ReviewTurnID, string(admission.Verdict), admission.Summary,
		unixMs(admission.Now), unixMs(admission.Now),
		admission.WorkspaceID, admission.ReviewID,
		admission.ReviewTurnID, unixMs(admission.Now))
	if err != nil {
		return executionbiz.ReviewerVerdictResult{}, err
	}
	if err := requireRowsAffected(
		result, executionbiz.ErrReviewerVerdictRejected, "submit Goal Review verdict",
	); err != nil {
		return executionbiz.ReviewerVerdictResult{}, err
	}
	review.TurnID = admission.ReviewTurnID
	review.Status = executionbiz.GoalReviewStatusSubmitted
	if err := callGoalReviewStep(admission.BeforeStep, "wake"); err != nil {
		return executionbiz.ReviewerVerdictResult{}, err
	}
	if err := prepareGoalReviewMainWakeTx(ctx, tx, review, admission.Now); err != nil {
		return executionbiz.ReviewerVerdictResult{}, err
	}
	if err := callGoalReviewStep(admission.BeforeStep, "audit"); err != nil {
		return executionbiz.ReviewerVerdictResult{}, err
	}
	if err := insertGoalReviewAuditTx(
		ctx, tx, review, "review_verdict_submitted", review.SessionID,
		admission.Summary, review.ID+":audit:verdict:"+admission.RequestID,
		admission.Now,
	); err != nil {
		return executionbiz.ReviewerVerdictResult{}, err
	}
	response := executionbiz.ReviewerVerdictResult{
		ReviewID: review.ID, Verdict: admission.Verdict,
	}
	if err := insertGoalReviewMutationTx(
		ctx, tx, review, review.SessionID, "verdict", admission.RequestID,
		admission.InputSHA256, admission.ExpectedGraphRevision, response,
		admission.Now,
	); err != nil {
		return executionbiz.ReviewerVerdictResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return executionbiz.ReviewerVerdictResult{}, err
	}
	return response, nil
}

func prepareGoalReviewMainWakeTx(
	ctx context.Context,
	tx *sql.Tx,
	review executionbiz.GoalReview,
	now time.Time,
) error {
	checkpoint, found, err := getTuttiModeCheckpointTx(
		ctx, tx, review.WorkspaceID, review.ExecutionID, review.CheckpointID,
	)
	if err != nil {
		return err
	}
	if !found {
		return executionbiz.ErrExecutionConflict
	}
	return prepareTuttiModeMainWakeTx(
		ctx, tx, review.WorkspaceID, review.ExecutionID, checkpoint, now,
	)
}

func getActiveGoalReviewTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	issueID string,
) (executionbiz.GoalReview, executionbiz.Execution, error) {
	row := tx.QueryRowContext(ctx, goalReviewSelect+`
WHERE r.workspace_id = ? AND e.issue_id = ? AND c.status = 'active'
`, workspaceID, issueID)
	review, err := scanGoalReview(row)
	if errors.Is(err, sql.ErrNoRows) {
		var execution executionbiz.Execution
		err = tx.QueryRowContext(ctx, `
SELECT execution_id, source_session_id, status, graph_revision, review_mode,
       review_agent_target_id
FROM workspace_tutti_executions
WHERE workspace_id = ? AND issue_id = ?
`, workspaceID, issueID).Scan(
			&execution.ID, &execution.SourceSessionID, &execution.Status,
			&execution.GraphRevision, &execution.ReviewMode,
			&execution.ReviewAgentTargetID,
		)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return executionbiz.GoalReview{}, executionbiz.Execution{}, executionbiz.ErrExecutionNotFound
			}
			return executionbiz.GoalReview{}, executionbiz.Execution{}, err
		}
		var checkpointID string
		if err := tx.QueryRowContext(ctx, `
SELECT checkpoint_id FROM workspace_tutti_execution_checkpoints
WHERE workspace_id = ? AND execution_id = ? AND status = 'active'
`, workspaceID, execution.ID).Scan(&checkpointID); err != nil {
			return executionbiz.GoalReview{}, executionbiz.Execution{}, executionbiz.ErrCompleteRejected
		}
		execution.ActiveCheckpointID = checkpointID
		reviewID, _ := executionbiz.GoalReviewID(checkpointID)
		review = executionbiz.GoalReview{
			ID: reviewID, WorkspaceID: workspaceID, ExecutionID: execution.ID,
			IssueID: issueID, CheckpointID: checkpointID,
		}
		return review, execution, nil
	}
	if err != nil {
		return executionbiz.GoalReview{}, executionbiz.Execution{}, err
	}
	var execution executionbiz.Execution
	err = tx.QueryRowContext(ctx, `
SELECT source_session_id, status, graph_revision, review_mode,
       review_agent_target_id
FROM workspace_tutti_executions
WHERE workspace_id = ? AND execution_id = ?
`, workspaceID, review.ExecutionID).Scan(
		&execution.SourceSessionID, &execution.Status,
		&execution.GraphRevision, &execution.ReviewMode,
		&execution.ReviewAgentTargetID,
	)
	if err != nil {
		return executionbiz.GoalReview{}, executionbiz.Execution{}, err
	}
	execution.ID = review.ExecutionID
	execution.ActiveCheckpointID = review.CheckpointID
	return review, execution, nil
}

func validateGoalReviewFenceTx(
	ctx context.Context,
	tx *sql.Tx,
	review executionbiz.GoalReview,
	graphRevision int64,
	mode executionbiz.ReviewMode,
) error {
	var status executionbiz.Status
	var persistedRevision int64
	var persistedMode executionbiz.ReviewMode
	var activeCheckpointID string
	err := tx.QueryRowContext(ctx, `
SELECT e.status, e.graph_revision, e.review_mode, c.checkpoint_id
FROM workspace_tutti_executions e
JOIN workspace_tutti_execution_checkpoints c
  ON c.workspace_id = e.workspace_id AND c.execution_id = e.execution_id
 AND c.status = 'active'
WHERE e.workspace_id = ? AND e.execution_id = ?
`, review.WorkspaceID, review.ExecutionID).Scan(
		&status, &persistedRevision, &persistedMode, &activeCheckpointID,
	)
	if err != nil ||
		status != executionbiz.StatusPendingGoalReview ||
		persistedRevision != graphRevision ||
		persistedMode != mode ||
		activeCheckpointID != review.CheckpointID {
		return executionbiz.ErrReviewerVerdictRejected
	}
	return nil
}

func getGoalReviewTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	reviewID string,
) (executionbiz.GoalReview, error) {
	review, err := scanGoalReview(tx.QueryRowContext(ctx, goalReviewSelect+`
WHERE r.workspace_id = ? AND r.review_id = ?
`, workspaceID, reviewID))
	if errors.Is(err, sql.ErrNoRows) {
		return executionbiz.GoalReview{}, executionbiz.ErrExecutionNotFound
	}
	return review, err
}

func getGoalReviewByTurnTx(
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	sessionID string,
	turnID string,
) (executionbiz.GoalReview, error) {
	review, err := scanGoalReview(tx.QueryRowContext(ctx, goalReviewSelect+`
WHERE r.workspace_id = ? AND r.review_session_id = ? AND r.review_turn_id = ?
`, workspaceID, sessionID, turnID))
	if errors.Is(err, sql.ErrNoRows) {
		return executionbiz.GoalReview{}, executionbiz.ErrReviewerVerdictRejected
	}
	return review, err
}

func insertGoalReviewAuditTx(
	ctx context.Context,
	tx *sql.Tx,
	review executionbiz.GoalReview,
	kind string,
	actorID string,
	reason string,
	auditID string,
	now time.Time,
) error {
	_, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO workspace_tutti_goal_review_audit (
  workspace_id, execution_id, audit_id, review_id,
  kind, actor_id, reason, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`, review.WorkspaceID, review.ExecutionID, auditID, review.ID, kind,
		actorID, reason, unixMs(now))
	return err
}

func insertGoalReviewMutationTx(
	ctx context.Context,
	tx *sql.Tx,
	review executionbiz.GoalReview,
	actorID string,
	kind string,
	requestID string,
	digest string,
	revision int64,
	response any,
	now time.Time,
) error {
	raw, err := json.Marshal(response)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_tutti_goal_review_mutations (
  workspace_id, execution_id, issue_id, actor_id, kind, request_id,
  input_sha256, checkpoint_id, expected_graph_revision,
  result_json, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, review.WorkspaceID, review.ExecutionID, review.IssueID, actorID, kind,
		requestID, digest, review.CheckpointID, revision, string(raw), unixMs(now))
	if isSQLiteUniqueConstraintError(err) {
		switch kind {
		case "complete":
			return executionbiz.ErrCompleteMutationConflict
		case "verdict":
			return executionbiz.ErrReviewerVerdictMutationConflict
		default:
			return executionbiz.ErrSwitchReviewToSelfMutationConflict
		}
	}
	return err
}

func readGoalReviewMutationResult[T any](
	ctx context.Context,
	tx *sql.Tx,
	workspaceID string,
	issueID string,
	actorID string,
	kind string,
	requestID string,
	digest string,
) (T, bool, error) {
	var zero T
	var persistedActor, persistedDigest, raw string
	err := tx.QueryRowContext(ctx, `
SELECT actor_id, input_sha256, result_json
FROM workspace_tutti_goal_review_mutations
WHERE workspace_id = ? AND issue_id = ? AND kind = ? AND request_id = ?
`, workspaceID, issueID, kind, requestID).Scan(
		&persistedActor, &persistedDigest, &raw,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return zero, false, nil
	}
	if err != nil {
		return zero, false, err
	}
	if persistedActor != actorID || persistedDigest != digest {
		switch kind {
		case "complete":
			return zero, false, executionbiz.ErrCompleteMutationConflict
		case "verdict":
			return zero, false, executionbiz.ErrReviewerVerdictMutationConflict
		default:
			return zero, false, executionbiz.ErrSwitchReviewToSelfMutationConflict
		}
	}
	if err := json.Unmarshal([]byte(raw), &zero); err != nil {
		return zero, false, err
	}
	switch result := any(&zero).(type) {
	case *executionbiz.GoalReviewCompleteResult:
		result.Replayed = true
	case *executionbiz.ReviewerVerdictResult:
		result.Replayed = true
	case *executionbiz.SwitchReviewToSelfResult:
		result.Replayed = true
	}
	return zero, true, nil
}

func callGoalReviewStep(hook func(string) error, step string) error {
	if hook == nil {
		return nil
	}
	return hook(step)
}

const goalReviewSelect = `
SELECT r.review_id, r.workspace_id, r.execution_id, e.issue_id,
       r.checkpoint_id, c.graph_revision,
       r.review_agent_target_id, r.client_submit_id,
       r.review_session_id, r.review_turn_id, r.status, r.verdict,
       r.summary, r.failure_reason, r.attempt_count, r.lease_owner,
       r.lease_expires_at_unix_ms, r.created_at_unix_ms,
       r.updated_at_unix_ms, r.submitted_at_unix_ms
FROM workspace_tutti_goal_reviews r
JOIN workspace_tutti_executions e
  ON e.workspace_id = r.workspace_id AND e.execution_id = r.execution_id
JOIN workspace_tutti_execution_checkpoints c
  ON c.workspace_id = r.workspace_id AND c.execution_id = r.execution_id
 AND c.checkpoint_id = r.checkpoint_id
`

func scanGoalReviews(rows *sql.Rows) ([]executionbiz.GoalReview, error) {
	defer func() { _ = rows.Close() }()
	var reviews []executionbiz.GoalReview
	for rows.Next() {
		review, err := scanGoalReview(rows)
		if err != nil {
			return nil, err
		}
		reviews = append(reviews, review)
	}
	return reviews, rows.Err()
}

func scanGoalReview(scanner rowScanner) (executionbiz.GoalReview, error) {
	var review executionbiz.GoalReview
	var leaseExpiresAt, createdAt, updatedAt, submittedAt int64
	err := scanner.Scan(
		&review.ID, &review.WorkspaceID, &review.ExecutionID, &review.IssueID,
		&review.CheckpointID, &review.GraphRevision,
		&review.AgentTargetID, &review.ClientSubmitID,
		&review.SessionID, &review.TurnID, &review.Status, &review.Verdict,
		&review.Summary, &review.FailureReason, &review.AttemptCount,
		&review.LeaseOwner, &leaseExpiresAt, &createdAt, &updatedAt, &submittedAt,
	)
	if err != nil {
		return executionbiz.GoalReview{}, err
	}
	review.LeaseExpiresAt = optionalTuttiModeExecutionTime(leaseExpiresAt)
	review.CreatedAt = time.UnixMilli(createdAt).UTC()
	review.UpdatedAt = time.UnixMilli(updatedAt).UTC()
	review.SubmittedAt = optionalTuttiModeExecutionTime(submittedAt)
	return review, nil
}
