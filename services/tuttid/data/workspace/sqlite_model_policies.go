package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	modelpolicybiz "github.com/tutti-os/tutti/services/tuttid/biz/modelpolicy"
)

// ErrModelPolicyNotFound reports a missing model usage policy row.
var ErrModelPolicyNotFound = errors.New("model usage policy not found")

// ErrModelPolicyReferenced reports that a policy could not be deleted because an
// agent binding still references it (enforced by the bindings foreign key).
var ErrModelPolicyReferenced = errors.New("model usage policy is still referenced")

func (s *SQLiteStore) ListModelPolicies(ctx context.Context, workspaceID string) ([]modelpolicybiz.Policy, error) {
	if s == nil || s.readDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	rows, err := s.readDB.QueryContext(ctx, `
SELECT workspace_id, policy_id, name, execution_plan_id, execution_model,
  planning_plan_id, planning_model, review_plan_id, review_model,
  review_rule_enabled, review_rule_trigger, review_rule_max_runs, review_rule_max_total_tokens,
  created_at_unix_ms, updated_at_unix_ms
FROM model_usage_policies
WHERE workspace_id = ?
ORDER BY created_at_unix_ms ASC, policy_id ASC
`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list model policies: %w", err)
	}
	defer rows.Close()

	var policies []modelpolicybiz.Policy
	for rows.Next() {
		policy, err := scanModelPolicy(rows)
		if err != nil {
			return nil, err
		}
		policies = append(policies, policy)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list model policy rows: %w", err)
	}
	return policies, nil
}

func (s *SQLiteStore) GetModelPolicy(ctx context.Context, workspaceID string, policyID string) (modelpolicybiz.Policy, error) {
	if s == nil || s.readDB == nil {
		return modelpolicybiz.Policy{}, errors.New("workspace database is not initialized")
	}
	row := s.readDB.QueryRowContext(ctx, `
SELECT workspace_id, policy_id, name, execution_plan_id, execution_model,
  planning_plan_id, planning_model, review_plan_id, review_model,
  review_rule_enabled, review_rule_trigger, review_rule_max_runs, review_rule_max_total_tokens,
  created_at_unix_ms, updated_at_unix_ms
FROM model_usage_policies
WHERE workspace_id = ? AND policy_id = ?
`, workspaceID, policyID)
	policy, err := scanModelPolicy(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return modelpolicybiz.Policy{}, ErrModelPolicyNotFound
		}
		return modelpolicybiz.Policy{}, err
	}
	return policy, nil
}

func (s *SQLiteStore) PutModelPolicy(ctx context.Context, policy modelpolicybiz.Policy) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	_, err := s.writeDB.ExecContext(ctx, `
INSERT INTO model_usage_policies (
  workspace_id, policy_id, name, execution_plan_id, execution_model,
  planning_plan_id, planning_model, review_plan_id, review_model,
  review_rule_enabled, review_rule_trigger, review_rule_max_runs, review_rule_max_total_tokens,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, policy_id) DO UPDATE SET
  name = excluded.name,
  execution_plan_id = excluded.execution_plan_id,
  execution_model = excluded.execution_model,
  planning_plan_id = excluded.planning_plan_id,
  planning_model = excluded.planning_model,
  review_plan_id = excluded.review_plan_id,
  review_model = excluded.review_model,
  review_rule_enabled = excluded.review_rule_enabled,
  review_rule_trigger = excluded.review_rule_trigger,
  review_rule_max_runs = excluded.review_rule_max_runs,
  review_rule_max_total_tokens = excluded.review_rule_max_total_tokens,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, policy.WorkspaceID, policy.ID, policy.Name,
		policy.Execution.ModelPlanID, policy.Execution.Model,
		policy.Planning.ModelPlanID, policy.Planning.Model,
		policy.Review.ModelPlanID, policy.Review.Model,
		boolInt(policy.ReviewRule.Enabled), string(policy.ReviewRule.Trigger),
		policy.ReviewRule.MaxRunsPerSession, policy.ReviewRule.MaxTotalTokensPerSession,
		unixMs(policy.CreatedAt), unixMs(policy.UpdatedAt))
	if err != nil {
		return fmt.Errorf("put model policy: %w", err)
	}
	return nil
}

func (s *SQLiteStore) DeleteModelPolicy(ctx context.Context, workspaceID string, policyID string) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	result, err := s.writeDB.ExecContext(ctx, `
DELETE FROM model_usage_policies
WHERE workspace_id = ? AND policy_id = ?
`, workspaceID, policyID)
	if err != nil {
		// A binding foreign key (ON DELETE RESTRICT) atomically blocks deletion
		// while any agent binding still references the policy.
		if isSQLiteForeignKeyConstraintError(err) {
			return ErrModelPolicyReferenced
		}
		return fmt.Errorf("delete model policy: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete model policy result: %w", err)
	}
	if affected == 0 {
		return ErrModelPolicyNotFound
	}
	return nil
}

// ListModelPoliciesByPlan reports policies referencing one plan through any
// role so plan deletion can be blocked while consumers remain.
func (s *SQLiteStore) ListModelPoliciesByPlan(ctx context.Context, workspaceID string, planID string) ([]modelpolicybiz.Policy, error) {
	if s == nil || s.readDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	rows, err := s.readDB.QueryContext(ctx, `
SELECT workspace_id, policy_id, name, execution_plan_id, execution_model,
  planning_plan_id, planning_model, review_plan_id, review_model,
  review_rule_enabled, review_rule_trigger, review_rule_max_runs, review_rule_max_total_tokens,
  created_at_unix_ms, updated_at_unix_ms
FROM model_usage_policies
WHERE workspace_id = ?
  AND (execution_plan_id = ? OR planning_plan_id = ? OR review_plan_id = ?)
ORDER BY policy_id ASC
`, workspaceID, planID, planID, planID)
	if err != nil {
		return nil, fmt.Errorf("list model policies by plan: %w", err)
	}
	defer rows.Close()

	var policies []modelpolicybiz.Policy
	for rows.Next() {
		policy, err := scanModelPolicy(rows)
		if err != nil {
			return nil, err
		}
		policies = append(policies, policy)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list model policies by plan rows: %w", err)
	}
	return policies, nil
}

func (s *SQLiteStore) GetModelPolicySessionOverride(ctx context.Context, workspaceID string, agentSessionID string) (modelpolicybiz.SessionOverride, error) {
	if s == nil || s.readDB == nil {
		return modelpolicybiz.SessionOverride{}, errors.New("workspace database is not initialized")
	}
	row := s.readDB.QueryRowContext(ctx, `
SELECT workspace_id, agent_session_id, disabled, model_policy_id, updated_at_unix_ms
FROM model_policy_session_overrides
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, agentSessionID)
	var override modelpolicybiz.SessionOverride
	var disabled int
	var updatedAtUnixMS int64
	if err := row.Scan(&override.WorkspaceID, &override.AgentSessionID, &disabled, &override.ModelPolicyID, &updatedAtUnixMS); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return modelpolicybiz.SessionOverride{}, sql.ErrNoRows
		}
		return modelpolicybiz.SessionOverride{}, fmt.Errorf("get model policy session override: %w", err)
	}
	override.Disabled = disabled != 0
	override.UpdatedAt = time.UnixMilli(updatedAtUnixMS).UTC()
	return override, nil
}

func (s *SQLiteStore) PutModelPolicySessionOverride(ctx context.Context, override modelpolicybiz.SessionOverride) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	_, err := s.writeDB.ExecContext(ctx, `
INSERT INTO model_policy_session_overrides (
  workspace_id, agent_session_id, disabled, model_policy_id, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id) DO UPDATE SET
  disabled = excluded.disabled,
  model_policy_id = excluded.model_policy_id,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, override.WorkspaceID, override.AgentSessionID, boolInt(override.Disabled), override.ModelPolicyID, unixMs(override.UpdatedAt))
	if err != nil {
		return fmt.Errorf("put model policy session override: %w", err)
	}
	return nil
}

func (s *SQLiteStore) GetAgentSessionAcceptance(ctx context.Context, workspaceID string, agentSessionID string) (modelpolicybiz.Acceptance, error) {
	if s == nil || s.readDB == nil {
		return modelpolicybiz.Acceptance{}, errors.New("workspace database is not initialized")
	}
	row := s.readDB.QueryRowContext(ctx, `
SELECT workspace_id, agent_session_id, state, review_run_id, updated_at_unix_ms
FROM agent_session_acceptance
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, agentSessionID)
	var acceptance modelpolicybiz.Acceptance
	var state string
	var updatedAtUnixMS int64
	if err := row.Scan(&acceptance.WorkspaceID, &acceptance.AgentSessionID, &state, &acceptance.ReviewRunID, &updatedAtUnixMS); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return modelpolicybiz.Acceptance{}, sql.ErrNoRows
		}
		return modelpolicybiz.Acceptance{}, fmt.Errorf("get agent session acceptance: %w", err)
	}
	acceptance.State = modelpolicybiz.AcceptanceState(state)
	acceptance.UpdatedAt = time.UnixMilli(updatedAtUnixMS).UTC()
	return acceptance, nil
}

func (s *SQLiteStore) PutAgentSessionAcceptance(ctx context.Context, acceptance modelpolicybiz.Acceptance) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	// user_accepted is terminal: once a user has accepted the work, concurrent
	// automation (agent_claimed / auto_checked writes) must never downgrade it.
	// The stickiness is enforced here at the write boundary — not by a racy
	// read-then-write in the service — so it holds under concurrency. The
	// literal mirrors modelpolicybiz.AcceptanceUserAccepted.
	_, err := s.writeDB.ExecContext(ctx, `
INSERT INTO agent_session_acceptance (
  workspace_id, agent_session_id, state, review_run_id, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_session_id) DO UPDATE SET
  state = excluded.state,
  review_run_id = excluded.review_run_id,
  updated_at_unix_ms = excluded.updated_at_unix_ms
WHERE agent_session_acceptance.state <> 'user_accepted'
`, acceptance.WorkspaceID, acceptance.AgentSessionID, string(acceptance.State), acceptance.ReviewRunID, unixMs(acceptance.UpdatedAt))
	if err != nil {
		return fmt.Errorf("put agent session acceptance: %w", err)
	}
	return nil
}

func scanModelPolicy(row managedProviderScanner) (modelpolicybiz.Policy, error) {
	var policy modelpolicybiz.Policy
	var reviewEnabled int
	var reviewTrigger string
	var createdAtUnixMS int64
	var updatedAtUnixMS int64
	if err := row.Scan(&policy.WorkspaceID, &policy.ID, &policy.Name,
		&policy.Execution.ModelPlanID, &policy.Execution.Model,
		&policy.Planning.ModelPlanID, &policy.Planning.Model,
		&policy.Review.ModelPlanID, &policy.Review.Model,
		&reviewEnabled, &reviewTrigger, &policy.ReviewRule.MaxRunsPerSession, &policy.ReviewRule.MaxTotalTokensPerSession,
		&createdAtUnixMS, &updatedAtUnixMS); err != nil {
		return modelpolicybiz.Policy{}, err
	}
	policy.ReviewRule.Enabled = reviewEnabled != 0
	policy.ReviewRule.Trigger = modelpolicybiz.ReviewTrigger(reviewTrigger)
	policy.CreatedAt = time.UnixMilli(createdAtUnixMS).UTC()
	policy.UpdatedAt = time.UnixMilli(updatedAtUnixMS).UTC()
	return policy, nil
}
