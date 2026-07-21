package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

var ErrModelPlanFirstUseCandidateNotFound = errors.New("model plan first use candidate not found")

func (s *SQLiteStore) PutModelPlanFirstUseCandidate(ctx context.Context, candidate modelplanbiz.FirstUseCandidate) error {
	_, err := s.writeDB.ExecContext(ctx, `
INSERT INTO model_plan_first_use_candidates (
  workspace_id, agent_session_id, model_plan_id, agent_target_id, model,
  plan_updated_at_unix_ms, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id) DO UPDATE SET
  model_plan_id = excluded.model_plan_id,
  agent_target_id = excluded.agent_target_id,
  model = excluded.model,
  plan_updated_at_unix_ms = excluded.plan_updated_at_unix_ms,
  created_at_unix_ms = excluded.created_at_unix_ms
`, candidate.WorkspaceID, candidate.AgentSessionID, candidate.PlanID, candidate.AgentTargetID, candidate.Model, unixMs(candidate.PlanUpdatedAt), unixMs(candidate.CreatedAt))
	if err != nil {
		return fmt.Errorf("put model plan first use candidate: %w", err)
	}
	return nil
}

func (s *SQLiteStore) GetModelPlanFirstUseCandidate(ctx context.Context, workspaceID string, agentSessionID string) (modelplanbiz.FirstUseCandidate, error) {
	row := s.readDB.QueryRowContext(ctx, `
SELECT workspace_id, agent_session_id, model_plan_id, agent_target_id, model,
  plan_updated_at_unix_ms, created_at_unix_ms
FROM model_plan_first_use_candidates
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, agentSessionID)
	return scanModelPlanFirstUseCandidate(row)
}

func (s *SQLiteStore) ListModelPlanFirstUseCandidates(ctx context.Context) ([]modelplanbiz.FirstUseCandidate, error) {
	rows, err := s.readDB.QueryContext(ctx, `
SELECT workspace_id, agent_session_id, model_plan_id, agent_target_id, model,
  plan_updated_at_unix_ms, created_at_unix_ms
FROM model_plan_first_use_candidates
ORDER BY created_at_unix_ms ASC, workspace_id ASC, agent_session_id ASC
`)
	if err != nil {
		return nil, fmt.Errorf("list model plan first use candidates: %w", err)
	}
	defer rows.Close()
	candidates := []modelplanbiz.FirstUseCandidate{}
	for rows.Next() {
		candidate, err := scanModelPlanFirstUseCandidate(rows)
		if err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list model plan first use candidate rows: %w", err)
	}
	return candidates, nil
}

func (s *SQLiteStore) DeleteModelPlanFirstUseCandidate(ctx context.Context, workspaceID string, agentSessionID string) error {
	_, err := s.writeDB.ExecContext(ctx, `
DELETE FROM model_plan_first_use_candidates
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, agentSessionID)
	if err != nil {
		return fmt.Errorf("delete model plan first use candidate: %w", err)
	}
	return nil
}

type firstUseCandidateScanner interface {
	Scan(dest ...any) error
}

func scanModelPlanFirstUseCandidate(row firstUseCandidateScanner) (modelplanbiz.FirstUseCandidate, error) {
	var candidate modelplanbiz.FirstUseCandidate
	var planUpdatedAtUnixMS int64
	var createdAtUnixMS int64
	if err := row.Scan(&candidate.WorkspaceID, &candidate.AgentSessionID, &candidate.PlanID, &candidate.AgentTargetID, &candidate.Model, &planUpdatedAtUnixMS, &createdAtUnixMS); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return modelplanbiz.FirstUseCandidate{}, ErrModelPlanFirstUseCandidateNotFound
		}
		return modelplanbiz.FirstUseCandidate{}, fmt.Errorf("scan model plan first use candidate: %w", err)
	}
	candidate.PlanUpdatedAt = time.UnixMilli(planUpdatedAtUnixMS).UTC()
	candidate.CreatedAt = time.UnixMilli(createdAtUnixMS).UTC()
	return candidate, nil
}
