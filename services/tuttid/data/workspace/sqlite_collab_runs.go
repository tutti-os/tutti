package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	collabrunbiz "github.com/tutti-os/tutti/services/tuttid/biz/collabrun"
)

// ErrCollaborationRunNotFound reports a missing collaboration run row.
var ErrCollaborationRunNotFound = errors.New("collaboration run not found")

const collaborationRunColumns = `workspace_id, run_id, mode, trigger_source, trigger_reason,
  source_session_id, target_session_id, target_agent_target_id, model_plan_id, model,
  context_scope, prompt, request_text, context_text, retry_of_run_id, attempt, result_text,
  failure_reason, failure_stage, status, adoption,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  started_at_unix_ms, completed_at_unix_ms, duration_ms,
  cost_currency, estimated_cost_micros, created_at_unix_ms, updated_at_unix_ms`

// ListCollaborationRuns returns workspace runs newest first. A non-empty
// sourceSessionID narrows to one source session; limit <= 0 means no limit.
func (s *SQLiteStore) ListCollaborationRuns(ctx context.Context, workspaceID string, sourceSessionID string, limit int) ([]collabrunbiz.Run, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	query := `
SELECT ` + collaborationRunColumns + `
FROM collaboration_runs
WHERE workspace_id = ?`
	args := []any{workspaceID}
	if sourceSessionID != "" {
		query += ` AND source_session_id = ?`
		args = append(args, sourceSessionID)
	}
	query += `
ORDER BY created_at_unix_ms DESC, run_id DESC`
	if limit > 0 {
		query += `
LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("list collaboration runs: %w", err)
	}
	defer rows.Close()

	var runs []collabrunbiz.Run
	for rows.Next() {
		run, err := scanCollaborationRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list collaboration run rows: %w", err)
	}
	return runs, nil
}

func (s *SQLiteStore) GetCollaborationRun(ctx context.Context, workspaceID string, runID string) (collabrunbiz.Run, error) {
	if s == nil || s.db == nil {
		return collabrunbiz.Run{}, errors.New("workspace database is not initialized")
	}
	row := s.db.QueryRowContext(ctx, `
SELECT `+collaborationRunColumns+`
FROM collaboration_runs
WHERE workspace_id = ? AND run_id = ?
`, workspaceID, runID)
	run, err := scanCollaborationRun(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return collabrunbiz.Run{}, ErrCollaborationRunNotFound
		}
		return collabrunbiz.Run{}, err
	}
	return run, nil
}

func (s *SQLiteStore) PutCollaborationRun(ctx context.Context, run collabrunbiz.Run) error {
	if s == nil || s.db == nil {
		return errors.New("workspace database is not initialized")
	}
	_, err := s.db.ExecContext(ctx, `
INSERT INTO collaboration_runs (
  `+collaborationRunColumns+`
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, run_id) DO UPDATE SET
  mode = excluded.mode,
  trigger_source = excluded.trigger_source,
  trigger_reason = excluded.trigger_reason,
  source_session_id = excluded.source_session_id,
  target_session_id = excluded.target_session_id,
  target_agent_target_id = excluded.target_agent_target_id,
  model_plan_id = excluded.model_plan_id,
  model = excluded.model,
  context_scope = excluded.context_scope,
  prompt = excluded.prompt,
  request_text = excluded.request_text,
  context_text = excluded.context_text,
  retry_of_run_id = excluded.retry_of_run_id,
  attempt = excluded.attempt,
  result_text = excluded.result_text,
  failure_reason = excluded.failure_reason,
  failure_stage = excluded.failure_stage,
  status = excluded.status,
  adoption = excluded.adoption,
  input_tokens = excluded.input_tokens,
  output_tokens = excluded.output_tokens,
  cache_read_tokens = excluded.cache_read_tokens,
  cache_write_tokens = excluded.cache_write_tokens,
  started_at_unix_ms = excluded.started_at_unix_ms,
  completed_at_unix_ms = excluded.completed_at_unix_ms,
  duration_ms = excluded.duration_ms,
  cost_currency = excluded.cost_currency,
  estimated_cost_micros = excluded.estimated_cost_micros,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, run.WorkspaceID, run.ID, string(run.Mode), string(run.TriggerSource), run.TriggerReason,
		run.SourceSessionID, run.TargetSessionID, run.TargetAgentTargetID, run.ModelPlanID, run.Model,
		run.ContextScope, run.Prompt, run.RequestText, run.ContextText, run.RetryOfRunID, run.Attempt, run.ResultText,
		run.FailureReason, run.FailureStage, string(run.Status), string(run.Adoption),
		run.Usage.InputTokens, run.Usage.OutputTokens, run.Usage.CacheReadTokens, run.Usage.CacheWriteTokens,
		unixMsOrZero(run.StartedAt), unixMsOrZero(run.CompletedAt), run.DurationMs,
		run.Cost.Currency, run.Cost.EstimatedMicros,
		unixMs(run.CreatedAt), unixMs(run.UpdatedAt))
	if err != nil {
		return fmt.Errorf("put collaboration run: %w", err)
	}
	return nil
}

func scanCollaborationRun(row managedProviderScanner) (collabrunbiz.Run, error) {
	var run collabrunbiz.Run
	var mode string
	var triggerSource string
	var status string
	var adoption string
	var startedAtUnixMS int64
	var completedAtUnixMS int64
	var createdAtUnixMS int64
	var updatedAtUnixMS int64
	if err := row.Scan(&run.WorkspaceID, &run.ID, &mode, &triggerSource, &run.TriggerReason,
		&run.SourceSessionID, &run.TargetSessionID, &run.TargetAgentTargetID, &run.ModelPlanID, &run.Model,
		&run.ContextScope, &run.Prompt, &run.RequestText, &run.ContextText, &run.RetryOfRunID, &run.Attempt, &run.ResultText,
		&run.FailureReason, &run.FailureStage, &status, &adoption,
		&run.Usage.InputTokens, &run.Usage.OutputTokens, &run.Usage.CacheReadTokens, &run.Usage.CacheWriteTokens,
		&startedAtUnixMS, &completedAtUnixMS, &run.DurationMs,
		&run.Cost.Currency, &run.Cost.EstimatedMicros,
		&createdAtUnixMS, &updatedAtUnixMS); err != nil {
		return collabrunbiz.Run{}, err
	}
	run.Mode = collabrunbiz.Mode(mode)
	run.TriggerSource = collabrunbiz.TriggerSource(triggerSource)
	run.Status = collabrunbiz.Status(status)
	run.Adoption = collabrunbiz.Adoption(adoption)
	if startedAtUnixMS > 0 {
		run.StartedAt = time.UnixMilli(startedAtUnixMS).UTC()
	}
	if completedAtUnixMS > 0 {
		run.CompletedAt = time.UnixMilli(completedAtUnixMS).UTC()
	}
	run.CreatedAt = time.UnixMilli(createdAtUnixMS).UTC()
	run.UpdatedAt = time.UnixMilli(updatedAtUnixMS).UTC()
	return run, nil
}

func unixMsOrZero(value time.Time) int64 {
	if value.IsZero() {
		return 0
	}
	return unixMs(value)
}
