package workspace

import (
	"context"
	"database/sql"
	"fmt"
	"time"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

const legacyTuttiModeRepairReason = "legacy_execution_startup_repair"

type legacyTuttiModeExecutionCandidate struct {
	workspaceID     string
	issueID         string
	workflowID      string
	sourceSessionID string
	issueStatus     string
	sourceExists    bool
	hasRunningRun   bool
	createdAt       time.Time
	activityAt      time.Time
}

func (s *SQLiteStore) applyWorkspaceTuttiModeLegacyRepairV5(
	ctx context.Context,
) error {
	applied, err := s.hasMigration(
		ctx, schemaMigrationWorkspaceTuttiModeLegacyRepairV5,
	)
	if err != nil || applied {
		return err
	}
	candidates, err := s.listLegacyTuttiModeExecutionCandidates(ctx)
	if err != nil {
		return err
	}
	for index := range candidates {
		_, candidates[index].sourceExists, err = s.GetSession(
			ctx,
			candidates[index].workspaceID,
			candidates[index].sourceSessionID,
		)
		if err != nil {
			return fmt.Errorf("read legacy Tutti mode source Session: %w", err)
		}
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Tutti mode legacy execution migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, candidate := range candidates {
		if err := backfillLegacyTuttiModeExecution(ctx, tx, candidate); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationWorkspaceTuttiModeLegacyRepairV5,
		unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record Tutti mode legacy execution migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Tutti mode legacy execution migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) listLegacyTuttiModeExecutionCandidates(
	ctx context.Context,
) ([]legacyTuttiModeExecutionCandidate, error) {
	rows, err := s.writeDB.QueryContext(ctx, `
SELECT i.workspace_id, i.issue_id, w.workflow_id, i.source_session_id,
       i.status,
       EXISTS (
         SELECT 1
         FROM workspace_issue_runs run
         WHERE run.workspace_id = i.workspace_id
           AND run.issue_id = i.issue_id
           AND run.status = 'running'
       ),
       min(i.created_at_unix_ms, w.created_at_unix_ms),
       max(
         i.updated_at_unix_ms,
         w.updated_at_unix_ms,
         COALESCE((
           SELECT max(run.updated_at_unix_ms)
           FROM workspace_issue_runs run
           WHERE run.workspace_id = i.workspace_id
             AND run.issue_id = i.issue_id
         ), 0)
       )
FROM workspace_issues i
JOIN workspace_workflows w
  ON w.workspace_id = i.workspace_id
 AND i.issue_id = 'tutti-mode-plan-' || w.workflow_id
 AND w.source_session_id = i.source_session_id
LEFT JOIN workspace_tutti_executions execution
  ON execution.workspace_id = i.workspace_id
 AND execution.issue_id = i.issue_id
WHERE i.planning_source = 'tutti_mode_plan'
  AND execution.execution_id IS NULL
ORDER BY i.workspace_id ASC, i.issue_id ASC
`)
	if err != nil {
		return nil, fmt.Errorf("list legacy Tutti mode executions: %w", err)
	}
	defer rows.Close()
	candidates := make([]legacyTuttiModeExecutionCandidate, 0)
	for rows.Next() {
		var candidate legacyTuttiModeExecutionCandidate
		var hasRunningRun int
		var createdAt, activityAt int64
		if err := rows.Scan(
			&candidate.workspaceID,
			&candidate.issueID,
			&candidate.workflowID,
			&candidate.sourceSessionID,
			&candidate.issueStatus,
			&hasRunningRun,
			&createdAt,
			&activityAt,
		); err != nil {
			return nil, fmt.Errorf("scan legacy Tutti mode execution: %w", err)
		}
		candidate.hasRunningRun = hasRunningRun != 0
		candidate.createdAt = time.UnixMilli(createdAt).UTC()
		candidate.activityAt = time.UnixMilli(activityAt).UTC()
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate legacy Tutti mode executions: %w", err)
	}
	return candidates, nil
}

func backfillLegacyTuttiModeExecution(
	ctx context.Context,
	tx *sql.Tx,
	candidate legacyTuttiModeExecutionCandidate,
) error {
	executionID, executionOK := executionbiz.ExecutionID(candidate.issueID)
	checkpointID, checkpointOK := executionbiz.MigrationCheckpointID(executionID)
	if !executionOK || !checkpointOK {
		return fmt.Errorf("derive legacy Tutti mode execution identity for %q", candidate.issueID)
	}
	status := executionbiz.StatusAwaitingMain
	checkpointStatus := executionbiz.CheckpointStatusActive
	watchdogDue := candidate.activityAt.Add(executionbiz.WatchdogInterval)
	resolvedAt := time.Time{}
	switch {
	case !candidate.sourceExists:
		status = executionbiz.StatusOrphanedSource
		checkpointStatus = executionbiz.CheckpointStatusCanceled
		watchdogDue = time.Time{}
		resolvedAt = candidate.activityAt
	case candidate.hasRunningRun:
		status = executionbiz.StatusRunning
	case candidate.issueStatus == "completed" ||
		candidate.issueStatus == "failed" ||
		candidate.issueStatus == "canceled":
		status = executionbiz.StatusCompleted
		checkpointStatus = executionbiz.CheckpointStatusResolved
		watchdogDue = time.Time{}
		resolvedAt = candidate.activityAt
	}
	execution := executionbiz.Execution{
		ID: executionID, WorkspaceID: candidate.workspaceID,
		IssueID: candidate.issueID, WorkflowID: candidate.workflowID,
		SourceSessionID: candidate.sourceSessionID, Status: status,
		GraphRevision: 1, LastOrchestratorActivityAt: candidate.activityAt,
		WatchdogDueAt: watchdogDue, ReviewMode: executionbiz.ReviewModeSelf,
		CreatedAt: candidate.createdAt, UpdatedAt: candidate.activityAt,
	}
	if status == executionbiz.StatusCompleted {
		execution.CompletedAt = candidate.activityAt
	}
	if err := insertTuttiModeExecution(ctx, tx, execution); err != nil {
		return fmt.Errorf("backfill legacy Tutti mode execution: %w", err)
	}
	checkpoint := executionbiz.Checkpoint{
		ID: checkpointID, ExecutionID: executionID,
		Kind: executionbiz.CheckpointKindMigration, Status: checkpointStatus,
		Sequence: 1, GraphRevision: 1,
		CreationReason: legacyTuttiModeRepairReason,
		CreatedAt:      candidate.activityAt,
		UpdatedAt:      candidate.activityAt,
		ResolvedAt:     resolvedAt,
	}
	if err := insertTuttiModeExecutionCheckpoint(
		ctx, tx, candidate.workspaceID, checkpoint,
	); err != nil {
		return fmt.Errorf("backfill legacy Tutti mode migration checkpoint: %w", err)
	}
	if checkpoint.Status == executionbiz.CheckpointStatusActive {
		if err := prepareTuttiModeMainWakeTx(
			ctx, tx, candidate.workspaceID, executionID,
			checkpoint, candidate.activityAt,
		); err != nil {
			return fmt.Errorf("backfill legacy Tutti mode migration wake: %w", err)
		}
	}
	return nil
}
