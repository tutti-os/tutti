package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func (s *SQLiteStore) PutAppFactoryJob(ctx context.Context, job workspacebiz.AppFactoryJob) error {
	if s == nil || s.db == nil {
		return errors.New("workspace database is not initialized")
	}

	workspaceID := strings.TrimSpace(job.WorkspaceID)
	jobID := strings.TrimSpace(job.JobID)
	status := strings.TrimSpace(string(job.Status))
	if workspaceID == "" || jobID == "" || status == "" {
		return errors.New("workspace id, app factory job id, and status are required")
	}

	now := unixMs(time.Now().UTC())
	createdAt := job.CreatedAtUnixMs
	if createdAt == 0 {
		createdAt = now
	}
	updatedAt := job.UpdatedAtUnixMs
	if updatedAt == 0 {
		updatedAt = now
	}

	_, err := s.db.ExecContext(ctx, `
INSERT INTO app_factory_jobs (
  workspace_id, job_id, status, prompt, app_id, display_name, description,
  agent_target_id, provider, model, reasoning_effort, agent_session_id, draft_dir, runtime_dir, data_dir, log_dir,
  package_dir, validation_result_json, failure_reason, published_version,
  created_at_unix_ms, updated_at_unix_ms
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, job_id) DO UPDATE SET
  status = excluded.status,
  prompt = excluded.prompt,
  app_id = excluded.app_id,
  display_name = excluded.display_name,
  description = excluded.description,
  agent_target_id = excluded.agent_target_id,
  provider = excluded.provider,
  model = excluded.model,
  reasoning_effort = excluded.reasoning_effort,
  agent_session_id = excluded.agent_session_id,
  draft_dir = excluded.draft_dir,
  runtime_dir = excluded.runtime_dir,
  data_dir = excluded.data_dir,
  log_dir = excluded.log_dir,
  package_dir = excluded.package_dir,
  validation_result_json = excluded.validation_result_json,
  failure_reason = excluded.failure_reason,
  published_version = excluded.published_version,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, workspaceID, jobID, status, strings.TrimSpace(job.Prompt), strings.TrimSpace(job.AppID),
		strings.TrimSpace(job.DisplayName), strings.TrimSpace(job.Description),
		strings.TrimSpace(job.AgentTargetID),
		strings.TrimSpace(job.Provider), strings.TrimSpace(job.Model), strings.TrimSpace(job.ReasoningEffort),
		strings.TrimSpace(job.AgentSessionID), strings.TrimSpace(job.DraftDir),
		strings.TrimSpace(job.RuntimeDir), strings.TrimSpace(job.DataDir),
		strings.TrimSpace(job.LogDir), strings.TrimSpace(job.PackageDir),
		strings.TrimSpace(job.ValidationResultJSON), strings.TrimSpace(job.FailureReason),
		strings.TrimSpace(job.PublishedVersion), createdAt, updatedAt)
	if err != nil {
		return fmt.Errorf("put workspace app factory job: %w", err)
	}
	return nil
}

func (s *SQLiteStore) GetAppFactoryJob(ctx context.Context, workspaceID string, jobID string) (workspacebiz.AppFactoryJob, error) {
	if s == nil || s.db == nil {
		return workspacebiz.AppFactoryJob{}, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	jobID = strings.TrimSpace(jobID)
	if workspaceID == "" || jobID == "" {
		return workspacebiz.AppFactoryJob{}, errors.New("workspace id and app factory job id are required")
	}

	row := s.db.QueryRowContext(ctx, `
SELECT workspace_id, job_id, status, prompt, app_id, display_name, description,
  agent_target_id, provider, model, reasoning_effort, agent_session_id, draft_dir, runtime_dir, data_dir, log_dir,
  package_dir, validation_result_json, failure_reason, published_version,
  created_at_unix_ms, updated_at_unix_ms
FROM app_factory_jobs
WHERE workspace_id = ? AND job_id = ?
`, workspaceID, jobID)
	job, err := scanAppFactoryJob(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workspacebiz.AppFactoryJob{}, ErrWorkspaceAppFactoryJobNotFound
		}
		return workspacebiz.AppFactoryJob{}, fmt.Errorf("get workspace app factory job: %w", err)
	}
	return job, nil
}

func (s *SQLiteStore) ListAppFactoryJobs(ctx context.Context, workspaceID string) ([]workspacebiz.AppFactoryJob, error) {
	if s == nil || s.db == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return nil, errors.New("workspace id is required")
	}

	rows, err := s.db.QueryContext(ctx, `
SELECT workspace_id, job_id, status, prompt, app_id, display_name, description,
  agent_target_id, provider, model, reasoning_effort, agent_session_id, draft_dir, runtime_dir, data_dir, log_dir,
  package_dir, validation_result_json, failure_reason, published_version,
  created_at_unix_ms, updated_at_unix_ms
FROM app_factory_jobs
WHERE workspace_id = ?
ORDER BY updated_at_unix_ms DESC, job_id ASC
`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list workspace app factory jobs: %w", err)
	}
	defer rows.Close()

	var jobs []workspacebiz.AppFactoryJob
	for rows.Next() {
		job, err := scanAppFactoryJob(rows)
		if err != nil {
			return nil, fmt.Errorf("scan workspace app factory job: %w", err)
		}
		jobs = append(jobs, job)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace app factory jobs: %w", err)
	}
	return jobs, nil
}

func (s *SQLiteStore) DeleteAppFactoryJob(ctx context.Context, workspaceID string, jobID string) error {
	if s == nil || s.db == nil {
		return errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	jobID = strings.TrimSpace(jobID)
	if workspaceID == "" || jobID == "" {
		return errors.New("workspace id and app factory job id are required")
	}

	result, err := s.db.ExecContext(ctx, `
DELETE FROM app_factory_jobs
WHERE workspace_id = ? AND job_id = ?
`, workspaceID, jobID)
	if err != nil {
		return fmt.Errorf("delete workspace app factory job: %w", err)
	}
	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete workspace app factory job rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrWorkspaceAppFactoryJobNotFound
	}
	return nil
}

type appFactoryJobScanner interface {
	Scan(dest ...any) error
}

func scanAppFactoryJob(scanner appFactoryJobScanner) (workspacebiz.AppFactoryJob, error) {
	var job workspacebiz.AppFactoryJob
	var status string
	if err := scanner.Scan(
		&job.WorkspaceID,
		&job.JobID,
		&status,
		&job.Prompt,
		&job.AppID,
		&job.DisplayName,
		&job.Description,
		&job.AgentTargetID,
		&job.Provider,
		&job.Model,
		&job.ReasoningEffort,
		&job.AgentSessionID,
		&job.DraftDir,
		&job.RuntimeDir,
		&job.DataDir,
		&job.LogDir,
		&job.PackageDir,
		&job.ValidationResultJSON,
		&job.FailureReason,
		&job.PublishedVersion,
		&job.CreatedAtUnixMs,
		&job.UpdatedAtUnixMs,
	); err != nil {
		return workspacebiz.AppFactoryJob{}, err
	}
	job.Status = workspacebiz.AppFactoryJobStatus(strings.TrimSpace(status))
	return job, nil
}
