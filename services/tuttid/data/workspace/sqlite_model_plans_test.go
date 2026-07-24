package workspace

import (
	"context"
	"errors"
	"testing"
	"time"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	modelbindingbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelbinding"
	modelplanbiz "github.com/tutti-os/tutti/services/tuttid/biz/modelplan"
	modelpolicybiz "github.com/tutti-os/tutti/services/tuttid/biz/modelpolicy"
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
			{
				ID:   "doubao-seed-code",
				Name: "Doubao Seed Code",
				Pricing: &modelplanbiz.ModelPricing{
					Currency:                   "USD",
					InputMicrosPerMillion:      100,
					OutputMicrosPerMillion:     200,
					CacheReadMicrosPerMillion:  30,
					CacheWriteMicrosPerMillion: 40,
				},
			},
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
	if loaded.Revision != 1 {
		t.Fatalf("GetModelPlan() revision = %d, want 1", loaded.Revision)
	}
	if loaded.Protocol != modelplanbiz.ProtocolAnthropic || loaded.TemplateKind != modelplanbiz.TemplateCodingPlan {
		t.Fatalf("GetModelPlan() protocol/template = %q/%q", loaded.Protocol, loaded.TemplateKind)
	}
	if len(loaded.Models) != 1 || loaded.Models[0].ID != "doubao-seed-code" {
		t.Fatalf("GetModelPlan() models = %#v", loaded.Models)
	}
	if loaded.Models[0].Pricing == nil || loaded.Models[0].Pricing.OutputMicrosPerMillion != 200 {
		t.Fatalf("GetModelPlan() pricing = %#v, want persisted pricing", loaded.Models[0].Pricing)
	}
	if outcome, ok := loaded.Detection.StageOutcome(modelplanbiz.StageNetwork); !ok || outcome.Status != modelplanbiz.StagePassed {
		t.Fatalf("GetModelPlan() detection = %#v", loaded.Detection)
	}

	// The ciphertext column must never contain the raw key.
	var ciphertext string
	if err := store.readDB.QueryRowContext(ctx, `SELECT api_key_ciphertext FROM model_plans WHERE plan_id = 'mp-test'`).Scan(&ciphertext); err != nil {
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

	loaded.Revision = 2
	loaded.APIKey = "sk-rotated-value"
	loaded.BaseURL = "https://rotated.example/v1"
	loaded.UpdatedAt = now.Add(time.Minute)
	if err := store.PutModelPlan(ctx, loaded); err != nil {
		t.Fatalf("PutModelPlan(revision 2) error = %v", err)
	}
	current, err := store.GetModelPlan(ctx, "ws-plans", "mp-test")
	if err != nil {
		t.Fatalf("GetModelPlan(revision 2) error = %v", err)
	}
	if current.Revision != 2 || current.APIKey != "sk-rotated-value" || current.BaseURL != "https://rotated.example/v1" {
		t.Fatalf("current plan = revision %d key %q url %q", current.Revision, current.APIKey, current.BaseURL)
	}
	historical, err := store.GetModelPlanRevision(ctx, "ws-plans", "mp-test", 1)
	if err != nil {
		t.Fatalf("GetModelPlanRevision(1) error = %v", err)
	}
	if historical.Revision != 1 || historical.APIKey != "sk-secret-value" || historical.BaseURL != "https://open.volcengineapi.example/v1" {
		t.Fatalf("historical plan = revision %d key %q url %q", historical.Revision, historical.APIKey, historical.BaseURL)
	}
	var historicalCiphertext string
	if err := store.readDB.QueryRowContext(ctx, `SELECT api_key_ciphertext FROM model_plan_revisions WHERE plan_id = 'mp-test' AND revision = 1`).Scan(&historicalCiphertext); err != nil {
		t.Fatalf("read historical ciphertext error = %v", err)
	}
	if historicalCiphertext == "" || historicalCiphertext == "sk-secret-value" {
		t.Fatalf("historical ciphertext = %q, want encrypted value", historicalCiphertext)
	}

	if err := store.DeleteModelPlan(ctx, "ws-plans", "mp-test"); err != nil {
		t.Fatalf("DeleteModelPlan() error = %v", err)
	}
	if _, err := store.GetModelPlan(ctx, "ws-plans", "mp-test"); !errors.Is(err, ErrModelPlanNotFound) {
		t.Fatalf("GetModelPlan() after delete error = %v, want ErrModelPlanNotFound", err)
	}
	if preserved, err := store.GetModelPlanRevision(ctx, "ws-plans", "mp-test", 1); err != nil || preserved.APIKey != "sk-secret-value" {
		t.Fatalf("GetModelPlanRevision() after current delete = %#v, %v", preserved, err)
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

	resetModelPlanMigrations(t, store)
	if err := store.applyModelPlansV1(ctx); err != nil {
		t.Fatalf("applyModelPlansV1() error = %v", err)
	}
	if err := store.applyAgentModelBindingsV1(ctx); err != nil {
		t.Fatalf("applyAgentModelBindingsV1() error = %v", err)
	}
	if err := store.applyModelPlanRevisionsV1(ctx); err != nil {
		t.Fatalf("applyModelPlanRevisionsV1() error = %v", err)
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
	if plan.Revision != 1 {
		t.Fatalf("migrated plan revision = %d, want 1", plan.Revision)
	}
	historical, err := store.GetModelPlanRevision(ctx, "ws-legacy", "mp-migrated-anthropic", 1)
	if err != nil || historical.APIKey != "legacy-key" {
		t.Fatalf("migrated plan revision = %#v, %v", historical, err)
	}
	if plan.Status() != modelplanbiz.StatusUndetected {
		t.Fatalf("migrated plan status = %q, want undetected", plan.Status())
	}
}

func TestModelPlansMigrationRollsBackFailedBackfillAndRetries(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createModelPlanTestWorkspace(t, store, "ws-retry")
	ciphertext, err := encryptManagedCredential("legacy-key")
	if err != nil {
		t.Fatalf("encryptManagedCredential() error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
INSERT INTO managed_model_provider_credentials (
  workspace_id, provider_id, enabled, api_key_ciphertext, base_url, models_json, updated_at_unix_ms
) VALUES ('ws-retry', 'openai', 1, ?, 'https://relay.example/v1', '{invalid', 1700000000000)
`, ciphertext); err != nil {
		t.Fatalf("insert invalid legacy credential error = %v", err)
	}

	resetModelPlanMigrations(t, store)
	if err := store.applyModelPlansV1(ctx); err == nil {
		t.Fatal("applyModelPlansV1() error = nil, want invalid legacy models failure")
	}
	applied, err := store.hasMigration(ctx, schemaMigrationModelPlansV1)
	if err != nil {
		t.Fatalf("hasMigration() error = %v", err)
	}
	if applied {
		t.Fatal("failed model plan migration recorded its marker")
	}
	var tableCount int
	if err := store.writeDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'model_plans'`).Scan(&tableCount); err != nil {
		t.Fatalf("inspect rolled back model_plans table error = %v", err)
	}
	if tableCount != 0 {
		t.Fatalf("model_plans table count after rollback = %d, want 0", tableCount)
	}

	if _, err := store.writeDB.ExecContext(ctx, `
UPDATE managed_model_provider_credentials
SET models_json = '[{"id":"gpt-retry","name":"GPT Retry"}]'
WHERE workspace_id = 'ws-retry' AND provider_id = 'openai'
`); err != nil {
		t.Fatalf("repair legacy credential error = %v", err)
	}
	if err := store.applyModelPlansV1(ctx); err != nil {
		t.Fatalf("retry applyModelPlansV1() error = %v", err)
	}
	if err := store.applyAgentModelBindingsV1(ctx); err != nil {
		t.Fatalf("retry applyAgentModelBindingsV1() error = %v", err)
	}
	if err := store.applyModelPlanRevisionsV1(ctx); err != nil {
		t.Fatalf("retry applyModelPlanRevisionsV1() error = %v", err)
	}
	if _, err := store.GetModelPlan(ctx, "ws-retry", "mp-migrated-openai"); err != nil {
		t.Fatalf("GetModelPlan(retried migration) error = %v", err)
	}
}

func TestModelPlanFirstUseCandidatesMigrationRepairsLegacyModelPlansV1Schema(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	if _, err := store.writeDB.ExecContext(ctx, `
DROP TABLE model_plan_first_use_candidates;
DELETE FROM tuttid_schema_migrations WHERE id = ?;
`, schemaMigrationModelPlanFirstUseCandidatesV1); err != nil {
		t.Fatalf("simulate legacy model plans v1 schema: %v", err)
	}

	legacyMarkerApplied, err := store.hasMigration(ctx, schemaMigrationModelPlansV1)
	if err != nil {
		t.Fatalf("inspect legacy model plans marker: %v", err)
	}
	if !legacyMarkerApplied {
		t.Fatal("legacy model_plans_v1 marker missing")
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() legacy model plans schema error = %v", err)
	}

	for kind, name := range map[string]string{
		"table": "model_plan_first_use_candidates",
		"index": "idx_model_plan_first_use_candidates_plan",
	} {
		var count int
		if err := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM sqlite_master WHERE type = ? AND name = ?
`, kind, name).Scan(&count); err != nil {
			t.Fatalf("inspect repaired %s %q: %v", kind, name, err)
		}
		if count != 1 {
			t.Fatalf("repaired %s %q count = %d, want 1", kind, name, count)
		}
	}

	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() idempotent retry error = %v", err)
	}
	var markerCount int
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM tuttid_schema_migrations WHERE id = ?
`, schemaMigrationModelPlanFirstUseCandidatesV1).Scan(&markerCount); err != nil {
		t.Fatalf("count first-use candidate migration marker: %v", err)
	}
	if markerCount != 1 {
		t.Fatalf("first-use candidate migration marker count = %d, want 1", markerCount)
	}
}

func TestListAgentModelBindingsByModelPolicy(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createModelPlanTestWorkspace(t, store, "ws-pol")
	now := time.UnixMilli(1700000000000).UTC()
	plan := modelplanbiz.Plan{
		ID: "mp-1", WorkspaceID: "ws-pol", Name: "Plan", TemplateKind: modelplanbiz.TemplateCustom,
		Protocol: modelplanbiz.ProtocolOpenAI, Models: []modelplanbiz.Model{{ID: "m", Name: "M"}},
		CreatedAt: now, UpdatedAt: now,
	}
	if err := store.PutModelPlan(ctx, plan); err != nil {
		t.Fatalf("PutModelPlan() error = %v", err)
	}
	if err := store.PutModelPolicy(ctx, modelpolicybiz.Policy{
		ID: "pol-1", WorkspaceID: "ws-pol", Name: "Careful", CreatedAt: now, UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutModelPolicy() error = %v", err)
	}
	if err := store.PutAgentModelBinding(ctx, modelbindingbiz.Binding{
		WorkspaceID: "ws-pol", AgentTargetID: agenttargetbiz.IDLocalCodex,
		ModelPlanID: "mp-1", ModelPolicyID: "pol-1", UpdatedAt: now,
	}); err != nil {
		t.Fatalf("PutAgentModelBinding() error = %v", err)
	}

	refs, err := store.ListAgentModelBindingsByModelPolicy(ctx, "ws-pol", "pol-1")
	if err != nil {
		t.Fatalf("ListAgentModelBindingsByModelPolicy() error = %v", err)
	}
	if len(refs) != 1 || refs[0].AgentTargetID != agenttargetbiz.IDLocalCodex || refs[0].ModelPolicyID != "pol-1" {
		t.Fatalf("refs = %#v, want the codex binding referencing pol-1", refs)
	}

	other, err := store.ListAgentModelBindingsByModelPolicy(ctx, "ws-pol", "pol-none")
	if err != nil {
		t.Fatalf("ListAgentModelBindingsByModelPolicy(unreferenced) error = %v", err)
	}
	if len(other) != 0 {
		t.Fatalf("refs for unreferenced policy = %#v, want none", other)
	}
}

func TestModelPlanBindingForeignKeys(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t)
	createModelPlanTestWorkspace(t, store, "ws-bindings")
	now := time.UnixMilli(1700000000000).UTC()
	plan := modelplanbiz.Plan{
		ID: "mp-bound", WorkspaceID: "ws-bindings", Name: "Bound", TemplateKind: modelplanbiz.TemplateCustom,
		Protocol: modelplanbiz.ProtocolOpenAI, Models: []modelplanbiz.Model{{ID: "gpt-test", Name: "GPT Test"}},
		Enabled: true, CreatedAt: now, UpdatedAt: now,
	}
	if err := store.PutModelPlan(ctx, plan); err != nil {
		t.Fatalf("PutModelPlan() error = %v", err)
	}
	binding := modelbindingbiz.Binding{
		WorkspaceID: "ws-bindings", AgentTargetID: agenttargetbiz.IDLocalCodex,
		ModelPlanID: "mp-bound", DefaultModel: "gpt-test", UpdatedAt: now,
	}
	if err := store.PutAgentModelBinding(ctx, binding); err != nil {
		t.Fatalf("PutAgentModelBinding() error = %v", err)
	}
	if err := store.DeleteModelPlan(ctx, "ws-bindings", "mp-bound"); !errors.Is(err, ErrModelPlanReferenced) {
		t.Fatalf("DeleteModelPlan(referenced) error = %v, want ErrModelPlanReferenced", err)
	}

	if err := store.DeleteAgentTarget(ctx, agenttargetbiz.IDLocalCodex); err != nil {
		t.Fatalf("DeleteAgentTarget() error = %v", err)
	}
	if _, err := store.GetAgentModelBinding(ctx, "ws-bindings", agenttargetbiz.IDLocalCodex); !errors.Is(err, ErrAgentModelBindingNotFound) {
		t.Fatalf("GetAgentModelBinding() after target delete error = %v, want ErrAgentModelBindingNotFound", err)
	}
	if err := store.DeleteModelPlan(ctx, "ws-bindings", "mp-bound"); err != nil {
		t.Fatalf("DeleteModelPlan(after target cascade) error = %v", err)
	}
}

func resetModelPlanMigrations(t *testing.T, store *SQLiteStore) {
	t.Helper()
	ctx := context.Background()
	for _, statement := range []string{
		`DROP TABLE agent_target_model_bindings`,
		`DROP TABLE model_plan_first_use_candidates`,
		`DROP TABLE model_plan_revisions`,
		`DROP TABLE model_plans`,
	} {
		if _, err := store.writeDB.ExecContext(ctx, statement); err != nil {
			t.Fatalf("reset model plan migration with %q error = %v", statement, err)
		}
	}
	if _, err := store.writeDB.ExecContext(ctx, `
DELETE FROM tuttid_schema_migrations
WHERE id IN (?, ?, ?, ?)
`, schemaMigrationModelPlansV1, schemaMigrationModelPlanFirstUseCandidatesV1, schemaMigrationAgentModelBindingsV1, schemaMigrationModelPlanRevisionsV1); err != nil {
		t.Fatalf("reset model plan migration markers error = %v", err)
	}
}
