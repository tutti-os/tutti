package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
)

// ErrModelPlanNotFound reports a missing model plan row.
var ErrModelPlanNotFound = errors.New("model plan not found")

// ErrModelPlanReferenced reports a plan delete blocked by a durable binding.
var ErrModelPlanReferenced = errors.New("model plan is referenced")

func (s *SQLiteStore) ListModelPlans(ctx context.Context, workspaceID string) ([]modelplanbiz.Plan, error) {
	if s == nil || s.readDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	rows, err := s.readDB.QueryContext(ctx, `
SELECT workspace_id, plan_id, name, template_kind, protocol, api_key_ciphertext,
  base_url, models_json, default_model, enabled, detection_json, first_use_json,
  created_at_unix_ms, updated_at_unix_ms
FROM model_plans
WHERE workspace_id = ?
ORDER BY created_at_unix_ms ASC, plan_id ASC
`, workspaceID)
	if err != nil {
		return nil, fmt.Errorf("list model plans: %w", err)
	}
	defer rows.Close()

	var plans []modelplanbiz.Plan
	for rows.Next() {
		plan, err := scanModelPlan(rows)
		if err != nil {
			return nil, err
		}
		plans = append(plans, plan)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list model plan rows: %w", err)
	}
	return plans, nil
}

func (s *SQLiteStore) GetModelPlan(ctx context.Context, workspaceID string, planID string) (modelplanbiz.Plan, error) {
	if s == nil || s.readDB == nil {
		return modelplanbiz.Plan{}, errors.New("workspace database is not initialized")
	}
	row := s.readDB.QueryRowContext(ctx, `
SELECT workspace_id, plan_id, name, template_kind, protocol, api_key_ciphertext,
  base_url, models_json, default_model, enabled, detection_json, first_use_json,
  created_at_unix_ms, updated_at_unix_ms
FROM model_plans
WHERE workspace_id = ? AND plan_id = ?
`, workspaceID, planID)
	plan, err := scanModelPlan(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return modelplanbiz.Plan{}, ErrModelPlanNotFound
		}
		return modelplanbiz.Plan{}, err
	}
	return plan, nil
}

func (s *SQLiteStore) PutModelPlan(ctx context.Context, plan modelplanbiz.Plan) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	modelsJSON, err := json.Marshal(modelplanbiz.CloneModels(plan.Models))
	if err != nil {
		return fmt.Errorf("marshal model plan models: %w", err)
	}
	detectionJSON, err := json.Marshal(plan.Detection)
	if err != nil {
		return fmt.Errorf("marshal model plan detection: %w", err)
	}
	firstUseJSON, err := json.Marshal(plan.FirstUse)
	if err != nil {
		return fmt.Errorf("marshal model plan first use: %w", err)
	}
	ciphertext, err := encryptManagedCredential(plan.APIKey)
	if err != nil {
		return err
	}
	_, err = s.writeDB.ExecContext(ctx, `
INSERT INTO model_plans (
  workspace_id, plan_id, name, template_kind, protocol, api_key_ciphertext,
  base_url, models_json, default_model, enabled, detection_json, first_use_json,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, plan_id) DO UPDATE SET
  name = excluded.name,
  template_kind = excluded.template_kind,
  protocol = excluded.protocol,
  api_key_ciphertext = excluded.api_key_ciphertext,
  base_url = excluded.base_url,
  models_json = excluded.models_json,
  default_model = excluded.default_model,
  enabled = excluded.enabled,
  detection_json = excluded.detection_json,
  first_use_json = excluded.first_use_json,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, plan.WorkspaceID, plan.ID, plan.Name, string(plan.TemplateKind), string(plan.Protocol), ciphertext,
		plan.BaseURL, string(modelsJSON), plan.DefaultModel, boolInt(plan.Enabled), string(detectionJSON), string(firstUseJSON),
		unixMs(plan.CreatedAt), unixMs(plan.UpdatedAt))
	if err != nil {
		return fmt.Errorf("put model plan: %w", err)
	}
	return nil
}

func (s *SQLiteStore) DeleteModelPlan(ctx context.Context, workspaceID string, planID string) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	result, err := s.writeDB.ExecContext(ctx, `
DELETE FROM model_plans
WHERE workspace_id = ? AND plan_id = ?
`, workspaceID, planID)
	if err != nil {
		if isSQLiteForeignKeyConstraintError(err) {
			return ErrModelPlanReferenced
		}
		return fmt.Errorf("delete model plan: %w", err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete model plan result: %w", err)
	}
	if affected == 0 {
		return ErrModelPlanNotFound
	}
	return nil
}

func scanModelPlan(row managedProviderScanner) (modelplanbiz.Plan, error) {
	var plan modelplanbiz.Plan
	var templateKind string
	var protocol string
	var ciphertext string
	var modelsJSON string
	var enabled int
	var detectionJSON string
	var firstUseJSON string
	var createdAtUnixMS int64
	var updatedAtUnixMS int64
	if err := row.Scan(&plan.WorkspaceID, &plan.ID, &plan.Name, &templateKind, &protocol, &ciphertext,
		&plan.BaseURL, &modelsJSON, &plan.DefaultModel, &enabled, &detectionJSON, &firstUseJSON,
		&createdAtUnixMS, &updatedAtUnixMS); err != nil {
		return modelplanbiz.Plan{}, err
	}
	apiKey, err := decryptManagedCredential(ciphertext)
	if err != nil {
		return modelplanbiz.Plan{}, err
	}
	plan.TemplateKind = modelplanbiz.TemplateKind(templateKind)
	plan.Protocol = modelplanbiz.Protocol(protocol)
	plan.APIKey = apiKey
	plan.Enabled = enabled != 0
	if err := json.Unmarshal([]byte(modelsJSON), &plan.Models); err != nil {
		return modelplanbiz.Plan{}, fmt.Errorf("decode model plan models: %w", err)
	}
	if detectionJSON != "" && detectionJSON != "{}" {
		if err := json.Unmarshal([]byte(detectionJSON), &plan.Detection); err != nil {
			return modelplanbiz.Plan{}, fmt.Errorf("decode model plan detection: %w", err)
		}
	}
	if firstUseJSON != "" && firstUseJSON != "{}" {
		if err := json.Unmarshal([]byte(firstUseJSON), &plan.FirstUse); err != nil {
			return modelplanbiz.Plan{}, fmt.Errorf("decode model plan first use: %w", err)
		}
	}
	if plan.FirstUse.Status == "" {
		plan.FirstUse.Status = modelplanbiz.FirstUsePending
	}
	plan.CreatedAt = time.UnixMilli(createdAtUnixMS).UTC()
	plan.UpdatedAt = time.UnixMilli(updatedAtUnixMS).UTC()
	return plan, nil
}
