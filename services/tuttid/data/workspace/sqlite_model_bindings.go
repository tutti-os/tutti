package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
)

// ErrAgentModelBindingNotFound reports a missing binding row.
var ErrAgentModelBindingNotFound = errors.New("agent model binding not found")

// ErrAgentModelBindingReferenceInvalid reports a binding whose target, plan, or
// model usage policy does not exist (enforced by foreign keys at write time).
var ErrAgentModelBindingReferenceInvalid = errors.New("agent model binding reference is invalid")

func (s *SQLiteStore) ListAgentModelBindings(ctx context.Context, workspaceID string) ([]modelbindingbiz.Binding, error) {
	if s == nil || s.readDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	rows, err := s.readDB.QueryContext(ctx, `
SELECT workspace_id, agent_target_id, model_plan_id, default_model, model_policy_id, updated_at_unix_ms
FROM agent_target_model_bindings
WHERE workspace_id = ?
ORDER BY agent_target_id ASC
`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list agent model bindings: %w", err)
	}
	defer rows.Close()

	var bindings []modelbindingbiz.Binding
	for rows.Next() {
		binding, err := scanAgentModelBinding(rows)
		if err != nil {
			return nil, err
		}
		bindings = append(bindings, binding)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list agent model binding rows: %w", err)
	}
	return bindings, nil
}

func (s *SQLiteStore) GetAgentModelBinding(ctx context.Context, workspaceID string, agentTargetID string) (modelbindingbiz.Binding, error) {
	if s == nil || s.readDB == nil {
		return modelbindingbiz.Binding{}, errors.New("workspace database is not initialized")
	}
	row := s.readDB.QueryRowContext(ctx, `
SELECT workspace_id, agent_target_id, model_plan_id, default_model, model_policy_id, updated_at_unix_ms
FROM agent_target_model_bindings
WHERE workspace_id = ? AND agent_target_id = ?
`, workspaceID, agentTargetID)
	binding, err := scanAgentModelBinding(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return modelbindingbiz.Binding{}, ErrAgentModelBindingNotFound
		}
		return modelbindingbiz.Binding{}, err
	}
	return binding, nil
}

func (s *SQLiteStore) PutAgentModelBinding(ctx context.Context, binding modelbindingbiz.Binding) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	_, err := s.writeDB.ExecContext(ctx, `
INSERT INTO agent_target_model_bindings (
  workspace_id, agent_target_id, model_plan_id, default_model, model_policy_id, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, agent_target_id) DO UPDATE SET
  model_plan_id = excluded.model_plan_id,
  default_model = excluded.default_model,
  model_policy_id = excluded.model_policy_id,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, binding.WorkspaceID, binding.AgentTargetID, nullableText(binding.ModelPlanID), binding.DefaultModel, nullableText(binding.ModelPolicyID), unixMs(binding.UpdatedAt))
	if err != nil {
		if isSQLiteForeignKeyConstraintError(err) {
			return ErrAgentModelBindingReferenceInvalid
		}
		return fmt.Errorf("put agent model binding: %w", err)
	}
	return nil
}

// nullableText stores an empty optional link as SQL NULL so it is exempt from
// the composite foreign key while non-empty links are constrained.
func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func (s *SQLiteStore) DeleteAgentModelBinding(ctx context.Context, workspaceID string, agentTargetID string) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	_, err := s.writeDB.ExecContext(ctx, `
DELETE FROM agent_target_model_bindings
WHERE workspace_id = ? AND agent_target_id = ?
`, workspaceID, agentTargetID)
	if err != nil {
		return fmt.Errorf("delete agent model binding: %w", err)
	}
	return nil
}

// ListAgentModelBindingsByPlan reports every binding referencing one plan so
// plan deletion can be blocked while consumers remain.
func (s *SQLiteStore) ListAgentModelBindingsByPlan(ctx context.Context, workspaceID string, planID string) ([]modelbindingbiz.Binding, error) {
	if s == nil || s.readDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	rows, err := s.readDB.QueryContext(ctx, `
SELECT workspace_id, agent_target_id, model_plan_id, default_model, model_policy_id, updated_at_unix_ms
FROM agent_target_model_bindings
WHERE workspace_id = ? AND model_plan_id = ?
ORDER BY agent_target_id ASC
`, workspaceID, planID)
	if err != nil {
		return nil, fmt.Errorf("list agent model bindings by plan: %w", err)
	}
	defer rows.Close()

	var bindings []modelbindingbiz.Binding
	for rows.Next() {
		binding, err := scanAgentModelBinding(rows)
		if err != nil {
			return nil, err
		}
		bindings = append(bindings, binding)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list agent model bindings by plan rows: %w", err)
	}
	return bindings, nil
}

// ListAgentModelBindingsByModelPolicy reports every binding referencing one
// model usage policy so policy deletion can be blocked while consumers remain.
func (s *SQLiteStore) ListAgentModelBindingsByModelPolicy(ctx context.Context, workspaceID string, policyID string) ([]modelbindingbiz.Binding, error) {
	if s == nil || s.readDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	rows, err := s.readDB.QueryContext(ctx, `
SELECT workspace_id, agent_target_id, model_plan_id, default_model, model_policy_id, updated_at_unix_ms
FROM agent_target_model_bindings
WHERE workspace_id = ? AND model_policy_id = ?
ORDER BY agent_target_id ASC
`, workspaceID, policyID)
	if err != nil {
		return nil, fmt.Errorf("list agent model bindings by model policy: %w", err)
	}
	defer rows.Close()

	var bindings []modelbindingbiz.Binding
	for rows.Next() {
		binding, err := scanAgentModelBinding(rows)
		if err != nil {
			return nil, err
		}
		bindings = append(bindings, binding)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list agent model bindings by model policy rows: %w", err)
	}
	return bindings, nil
}

func scanAgentModelBinding(row managedProviderScanner) (modelbindingbiz.Binding, error) {
	var binding modelbindingbiz.Binding
	var modelPlanID sql.NullString
	var modelPolicyID sql.NullString
	var updatedAtUnixMS int64
	if err := row.Scan(&binding.WorkspaceID, &binding.AgentTargetID, &modelPlanID, &binding.DefaultModel, &modelPolicyID, &updatedAtUnixMS); err != nil {
		return modelbindingbiz.Binding{}, err
	}
	binding.ModelPlanID = modelPlanID.String
	binding.ModelPolicyID = modelPolicyID.String
	binding.UpdatedAt = time.UnixMilli(updatedAtUnixMS).UTC()
	return binding, nil
}
