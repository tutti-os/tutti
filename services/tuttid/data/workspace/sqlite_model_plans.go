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

var (
	// ErrModelPlanNotFound reports a missing current model plan row.
	ErrModelPlanNotFound = errors.New("model plan not found")
	// ErrModelPlanRevisionNotFound reports a missing immutable plan revision.
	ErrModelPlanRevisionNotFound = errors.New("model plan revision not found")
	// ErrModelPlanRevisionConflict reports a non-monotonic plan write.
	ErrModelPlanRevisionConflict = errors.New("model plan revision conflict")
)

// ErrModelPlanReferenced reports a plan delete blocked by a durable binding.
var ErrModelPlanReferenced = errors.New("model plan is referenced")

func (s *SQLiteStore) ListModelPlans(ctx context.Context, workspaceID string) ([]modelplanbiz.Plan, error) {
	if s == nil || s.readDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	rows, err := s.readDB.QueryContext(ctx, `
SELECT workspace_id, plan_id, revision, name, template_kind, protocol, api_key_ciphertext,
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
SELECT workspace_id, plan_id, revision, name, template_kind, protocol, api_key_ciphertext,
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

// GetModelPlanRevision returns one immutable secret-bearing plan revision.
// Callers must keep the returned credential inside the daemon runtime
// boundary; only its id/revision/fingerprint belongs in session context.
func (s *SQLiteStore) GetModelPlanRevision(ctx context.Context, workspaceID string, planID string, revision uint64) (modelplanbiz.Plan, error) {
	if s == nil || s.readDB == nil {
		return modelplanbiz.Plan{}, errors.New("workspace database is not initialized")
	}
	if revision == 0 {
		return modelplanbiz.Plan{}, ErrModelPlanRevisionNotFound
	}
	row := s.readDB.QueryRowContext(ctx, `
SELECT workspace_id, plan_id, revision, name, template_kind, protocol, api_key_ciphertext,
  base_url, models_json, default_model, enabled, detection_json, first_use_json,
  created_at_unix_ms, updated_at_unix_ms
FROM model_plan_revisions
WHERE workspace_id = ? AND plan_id = ? AND revision = ?
`, workspaceID, planID, revision)
	plan, err := scanModelPlan(row)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return modelplanbiz.Plan{}, ErrModelPlanRevisionNotFound
		}
		return modelplanbiz.Plan{}, err
	}
	return plan, nil
}

func (s *SQLiteStore) PutModelPlan(ctx context.Context, plan modelplanbiz.Plan) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin put model plan: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var currentRevision uint64
	err = tx.QueryRowContext(ctx, `
SELECT revision
FROM model_plans
WHERE workspace_id = ? AND plan_id = ?
`, plan.WorkspaceID, plan.ID).Scan(&currentRevision)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		if plan.Revision == 0 {
			plan.Revision = 1
		}
		if plan.Revision != 1 {
			return fmt.Errorf("%w: first revision is %d, want 1", ErrModelPlanRevisionConflict, plan.Revision)
		}
	case err != nil:
		return fmt.Errorf("read current model plan revision: %w", err)
	default:
		// Existing callers historically wrote back the revision they read. Treat
		// that as the next revision while still rejecting stale concurrent writes.
		if plan.Revision == 0 || plan.Revision == currentRevision {
			plan.Revision = currentRevision + 1
		}
		if plan.Revision != currentRevision+1 {
			return fmt.Errorf("%w: got %d after %d", ErrModelPlanRevisionConflict, plan.Revision, currentRevision)
		}
	}

	modelsJSON, err := json.Marshal(modelplanbiz.CloneModels(plan.Models))
	if err != nil {
		return fmt.Errorf("marshal model plan models: %w", err)
	}
	detectionJSON, err := json.Marshal(plan.Detection)
	if err != nil {
		return fmt.Errorf("marshal model plan detection: %w", err)
	}
	// Keep the retired column populated for database downgrade compatibility.
	// Current model-plan readiness ends at successful connection detection.
	const retiredFirstUseJSON = `{"status":"completed"}`
	ciphertext, err := encryptManagedCredential(plan.APIKey)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO model_plans (
  workspace_id, plan_id, revision, name, template_kind, protocol, api_key_ciphertext,
  base_url, models_json, default_model, enabled, detection_json, first_use_json,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(workspace_id, plan_id) DO UPDATE SET
  revision = excluded.revision,
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
`, plan.WorkspaceID, plan.ID, plan.Revision, plan.Name, string(plan.TemplateKind), string(plan.Protocol), ciphertext,
		plan.BaseURL, string(modelsJSON), plan.DefaultModel, boolInt(plan.Enabled), string(detectionJSON), retiredFirstUseJSON,
		unixMs(plan.CreatedAt), unixMs(plan.UpdatedAt))
	if err != nil {
		return fmt.Errorf("put model plan: %w", err)
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO model_plan_revisions (
  workspace_id, plan_id, revision, name, template_kind, protocol,
  api_key_ciphertext, base_url, models_json, default_model, enabled,
  detection_json, first_use_json, created_at_unix_ms, updated_at_unix_ms,
  recorded_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, plan.WorkspaceID, plan.ID, plan.Revision, plan.Name, string(plan.TemplateKind), string(plan.Protocol), ciphertext,
		plan.BaseURL, string(modelsJSON), plan.DefaultModel, boolInt(plan.Enabled), string(detectionJSON), retiredFirstUseJSON,
		unixMs(plan.CreatedAt), unixMs(plan.UpdatedAt), unixMs(time.Now().UTC()))
	if err != nil {
		return fmt.Errorf("put immutable model plan revision: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit model plan revision: %w", err)
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
	var revision int64
	var templateKind string
	var protocol string
	var ciphertext string
	var modelsJSON string
	var enabled int
	var detectionJSON string
	var retiredFirstUseJSON string
	var createdAtUnixMS int64
	var updatedAtUnixMS int64
	if err := row.Scan(&plan.WorkspaceID, &plan.ID, &revision, &plan.Name, &templateKind, &protocol, &ciphertext,
		&plan.BaseURL, &modelsJSON, &plan.DefaultModel, &enabled, &detectionJSON, &retiredFirstUseJSON,
		&createdAtUnixMS, &updatedAtUnixMS); err != nil {
		return modelplanbiz.Plan{}, err
	}
	if revision <= 0 {
		revision = 1
	}
	plan.Revision = uint64(revision)
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
	plan.CreatedAt = time.UnixMilli(createdAtUnixMS).UTC()
	plan.UpdatedAt = time.UnixMilli(updatedAtUnixMS).UTC()
	return plan, nil
}
