package workspace

import (
	"context"
	"errors"
	"testing"
	"time"

	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func createModelPlanTestWorkspace(t *testing.T, store *SQLiteStore, workspaceID string) {
	t.Helper()
	if err := store.Create(context.Background(), workspacebiz.Summary{
		ID:   workspaceID,
		Name: "Model Plan Workspace",
	}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
}

func TestSQLiteStoreModelPlanRoundTrip(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createModelPlanTestWorkspace(t, store, "ws-plans")

	now := time.UnixMilli(1700000000000).UTC()
	plan := modelplanbiz.Plan{
		ID:           "mp-test",
		WorkspaceID:  "ws-plans",
		Name:         "Volc Coding Plan",
		TemplateKind: modelplanbiz.TemplateCodingPlan,
		Protocol:     modelplanbiz.ProtocolAnthropic,
		APIKey:       "sk-secret-value",
		BaseURL:      "https://open.volcengineapi.example/v1",
		Models: []modelplanbiz.Model{
			{ID: "doubao-seed-code", Name: "Doubao Seed Code"},
		},
		DefaultModel: "doubao-seed-code",
		Enabled:      true,
		Detection: modelplanbiz.DetectionSnapshot{
			CheckedAt: now,
			Model:     "doubao-seed-code",
			Stages: []modelplanbiz.StageResult{
				{Stage: modelplanbiz.StageNetwork, Status: modelplanbiz.StagePassed, CheckedAt: now},
			},
		},
		FirstUse:  modelplanbiz.FirstUse{Status: modelplanbiz.FirstUsePending},
		CreatedAt: now,
		UpdatedAt: now,
	}
	if err := store.PutModelPlan(ctx, plan); err != nil {
		t.Fatalf("PutModelPlan() error = %v", err)
	}

	loaded, err := store.GetModelPlan(ctx, "ws-plans", "mp-test")
	if err != nil {
		t.Fatalf("GetModelPlan() error = %v", err)
	}
	if loaded.APIKey != "sk-secret-value" {
		t.Fatalf("GetModelPlan() api key = %q, want decrypted secret", loaded.APIKey)
	}
	if loaded.Protocol != modelplanbiz.ProtocolAnthropic || loaded.TemplateKind != modelplanbiz.TemplateCodingPlan {
		t.Fatalf("GetModelPlan() protocol/template = %q/%q", loaded.Protocol, loaded.TemplateKind)
	}
	if len(loaded.Models) != 1 || loaded.Models[0].ID != "doubao-seed-code" {
		t.Fatalf("GetModelPlan() models = %#v", loaded.Models)
	}
	if outcome, ok := loaded.Detection.StageOutcome(modelplanbiz.StageNetwork); !ok || outcome.Status != modelplanbiz.StagePassed {
		t.Fatalf("GetModelPlan() detection = %#v", loaded.Detection)
	}

	// The ciphertext column must never contain the raw key.
	var ciphertext string
	if err := store.writeDB.QueryRowContext(ctx, `SELECT api_key_ciphertext FROM model_plans WHERE plan_id = 'mp-test'`).Scan(&ciphertext); err != nil {
		t.Fatalf("read ciphertext error = %v", err)
	}
	if ciphertext == "" || ciphertext == "sk-secret-value" {
		t.Fatalf("api_key_ciphertext = %q, want encrypted value", ciphertext)
	}

	plans, err := store.ListModelPlans(ctx, "ws-plans")
	if err != nil {
		t.Fatalf("ListModelPlans() error = %v", err)
	}
	if len(plans) != 1 {
		t.Fatalf("ListModelPlans() len = %d, want 1", len(plans))
	}

	if err := store.DeleteModelPlan(ctx, "ws-plans", "mp-test"); err != nil {
		t.Fatalf("DeleteModelPlan() error = %v", err)
	}
	if _, err := store.GetModelPlan(ctx, "ws-plans", "mp-test"); !errors.Is(err, ErrModelPlanNotFound) {
		t.Fatalf("GetModelPlan() after delete error = %v, want ErrModelPlanNotFound", err)
	}
	if err := store.DeleteModelPlan(ctx, "ws-plans", "mp-test"); !errors.Is(err, ErrModelPlanNotFound) {
		t.Fatalf("DeleteModelPlan() second delete error = %v, want ErrModelPlanNotFound", err)
	}
}

func TestModelPlansMigrationBackfillsLegacyManagedCredentials(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createModelPlanTestWorkspace(t, store, "ws-legacy")

	ciphertext, err := encryptManagedCredential("legacy-key")
	if err != nil {
		t.Fatalf("encryptManagedCredential() error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
INSERT INTO managed_model_provider_credentials (
  workspace_id, provider_id, enabled, api_key_ciphertext, base_url, models_json, updated_at_unix_ms
) VALUES ('ws-legacy', 'anthropic', 1, ?, 'https://relay.example/api/anthropic', '[{"id":"claude-x","name":"Claude X","provider":"anthropic"}]', 1700000000000)
`, ciphertext); err != nil {
		t.Fatalf("insert legacy credential error = %v", err)
	}

	// Simulate the upgrade path: reset the migration marker and re-apply.
	if _, err := store.writeDB.ExecContext(ctx, `DELETE FROM tuttid_schema_migrations WHERE id = ?`, schemaMigrationModelPlansV1); err != nil {
		t.Fatalf("reset migration marker error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `DROP TABLE model_plans`); err != nil {
		t.Fatalf("drop model_plans error = %v", err)
	}
	if err := store.applyModelPlansV1(ctx); err != nil {
		t.Fatalf("applyModelPlansV1() error = %v", err)
	}

	plan, err := store.GetModelPlan(ctx, "ws-legacy", "mp-migrated-anthropic")
	if err != nil {
		t.Fatalf("GetModelPlan(migrated) error = %v", err)
	}
	if plan.APIKey != "legacy-key" {
		t.Fatalf("migrated plan api key = %q, want legacy-key", plan.APIKey)
	}
	if plan.Protocol != modelplanbiz.ProtocolAnthropic {
		t.Fatalf("migrated plan protocol = %q, want anthropic", plan.Protocol)
	}
	if !plan.Enabled {
		t.Fatalf("migrated plan enabled = false, want true")
	}
	if plan.BaseURL != "https://relay.example/api/anthropic" {
		t.Fatalf("migrated plan base url = %q", plan.BaseURL)
	}
	if len(plan.Models) != 1 || plan.Models[0].ID != "claude-x" || plan.Models[0].Name != "Claude X" {
		t.Fatalf("migrated plan models = %#v", plan.Models)
	}
	if plan.FirstUse.Status != modelplanbiz.FirstUsePending {
		t.Fatalf("migrated plan first use = %q, want pending", plan.FirstUse.Status)
	}
	if plan.Status() != modelplanbiz.StatusUndetected {
		t.Fatalf("migrated plan status = %q, want undetected", plan.Status())
	}
}
