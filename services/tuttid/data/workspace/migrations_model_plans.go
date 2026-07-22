package workspace

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

func (s *SQLiteStore) applyModelPlansV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationModelPlansV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin model plans v1 migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err = tx.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS model_plans (
  workspace_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  name TEXT NOT NULL,
  template_kind TEXT NOT NULL DEFAULT 'custom',
  protocol TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  models_json TEXT NOT NULL DEFAULT '[]',
  default_model TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  detection_json TEXT NOT NULL DEFAULT '{}',
  first_use_json TEXT NOT NULL DEFAULT '{}',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, plan_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_model_plans_workspace_updated
  ON model_plans(workspace_id, updated_at_unix_ms DESC);

CREATE TABLE IF NOT EXISTS model_plan_first_use_candidates (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  model_plan_id TEXT NOT NULL,
  agent_target_id TEXT NOT NULL,
  model TEXT NOT NULL DEFAULT '',
  plan_updated_at_unix_ms INTEGER NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, model_plan_id)
    REFERENCES model_plans(workspace_id, plan_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_model_plan_first_use_candidates_plan
  ON model_plan_first_use_candidates(workspace_id, model_plan_id);

`); err != nil {
		return fmt.Errorf("migrate model plans v1: %w", err)
	}
	if err := backfillModelPlansFromManagedCredentials(ctx, tx); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationModelPlansV1, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record model plans v1 migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit model plans v1 migration: %w", err)
	}
	return nil
}

// applyModelPlanRevisionsV1 adds immutable, secret-bearing plan revisions.
// Session runtime context stores only the plan id/revision/fingerprint; the
// encrypted endpoint credential remains in this daemon-owned table.
//
// Historical rows intentionally do not reference model_plans: deleting a
// plan from the current catalog must not make existing sessions impossible to
// resume. Workspace deletion still cascades every revision.
func (s *SQLiteStore) applyModelPlanRevisionsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationModelPlanRevisionsV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	hasRevision, err := s.hasColumn(ctx, "model_plans", "revision")
	if err != nil {
		return err
	}
	if !hasRevision {
		if _, err := s.writeDB.ExecContext(ctx, `ALTER TABLE model_plans ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;`); err != nil {
			return fmt.Errorf("add model plan revision: %w", err)
		}
	}

	now := unixMs(time.Now().UTC())
	_, err = s.writeDB.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS model_plan_revisions (
  workspace_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  name TEXT NOT NULL,
  template_kind TEXT NOT NULL DEFAULT 'custom',
  protocol TEXT NOT NULL,
  api_key_ciphertext TEXT NOT NULL DEFAULT '',
  base_url TEXT NOT NULL DEFAULT '',
  models_json TEXT NOT NULL DEFAULT '[]',
  default_model TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 0,
  detection_json TEXT NOT NULL DEFAULT '{}',
  first_use_json TEXT NOT NULL DEFAULT '{}',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  recorded_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, plan_id, revision),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_model_plan_revisions_lookup
  ON model_plan_revisions(workspace_id, plan_id, revision DESC);

INSERT OR IGNORE INTO model_plan_revisions (
  workspace_id, plan_id, revision, name, template_kind, protocol,
  api_key_ciphertext, base_url, models_json, default_model, enabled,
  detection_json, first_use_json, created_at_unix_ms, updated_at_unix_ms,
  recorded_at_unix_ms
)
SELECT workspace_id, plan_id, revision, name, template_kind, protocol,
  api_key_ciphertext, base_url, models_json, default_model, enabled,
  detection_json, first_use_json, created_at_unix_ms, updated_at_unix_ms, ?
FROM model_plans;

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, now, schemaMigrationModelPlanRevisionsV1, now)
	if err != nil {
		return fmt.Errorf("migrate model plan revisions v1: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyAgentModelBindingsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentModelBindingsV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin agent model bindings v1 migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	_, err = tx.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS agent_target_model_bindings (
  workspace_id TEXT NOT NULL,
  agent_target_id TEXT NOT NULL,
  model_plan_id TEXT NOT NULL DEFAULT '',
  default_model TEXT NOT NULL DEFAULT '',
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_target_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_target_id) REFERENCES agent_targets(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, model_plan_id)
    REFERENCES model_plans(workspace_id, plan_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_agent_target_model_bindings_plan
  ON agent_target_model_bindings(workspace_id, model_plan_id);

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationAgentModelBindingsV1, unixMs(time.Now().UTC()))
	if err != nil {
		return fmt.Errorf("migrate agent model bindings v1: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit agent model bindings v1 migration: %w", err)
	}
	return nil
}

// applyAgentModelBindingsV2 adds the model usage policy reference to the
// bindings table created by v1. Kept additive so databases already migrated
// by the model-plans release only gain the new column.
func (s *SQLiteStore) applyAgentModelBindingsV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentModelBindingsV2)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	present, err := s.hasColumn(ctx, "agent_target_model_bindings", "model_policy_id")
	if err != nil {
		return err
	}

	// Wrap the ALTER and the migration marker in one transaction so a crash or
	// failure between them cannot leave the column added without the marker (or
	// vice versa). The hasColumn precheck keeps the migration idempotent and
	// convergent for databases left in a legacy divergent state.
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin agent model bindings v2 migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if !present {
		if _, err := tx.ExecContext(ctx, `ALTER TABLE agent_target_model_bindings ADD COLUMN model_policy_id TEXT NOT NULL DEFAULT ''`); err != nil {
			return fmt.Errorf("migrate agent model bindings v2: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationAgentModelBindingsV2, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record agent model bindings v2 migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit agent model bindings v2 migration: %w", err)
	}
	return nil
}

// applyAgentModelBindingsV3 rebuilds the bindings table to add a RESTRICT
// foreign key from the model usage policy link to model_usage_policies, so
// referential integrity between bindings and policies is enforced atomically by
// the database in both directions (a binding cannot reference a missing policy;
// a referenced policy cannot be deleted). SQLite cannot add a foreign key via
// ALTER, so this uses the standard table rebuild. Both the plan link and the
// policy link become nullable (” -> NULL) so bindings without a plan or
// without a policy are exempt from their respective foreign key while non-empty
// links stay constrained with RESTRICT. Any pre-existing empty or dangling
// policy link is normalized to NULL during the copy so the new constraint can
// never reject valid rows.
func (s *SQLiteStore) applyAgentModelBindingsV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentModelBindingsV3)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin agent model bindings v3 migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err = tx.ExecContext(ctx, `
CREATE TABLE agent_target_model_bindings_v3 (
  workspace_id TEXT NOT NULL,
  agent_target_id TEXT NOT NULL,
  model_plan_id TEXT,
  default_model TEXT NOT NULL DEFAULT '',
  model_policy_id TEXT,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_target_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_target_id) REFERENCES agent_targets(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, model_plan_id)
    REFERENCES model_plans(workspace_id, plan_id) ON DELETE RESTRICT,
  FOREIGN KEY (workspace_id, model_policy_id)
    REFERENCES model_usage_policies(workspace_id, policy_id) ON DELETE RESTRICT
);

INSERT INTO agent_target_model_bindings_v3 (
  workspace_id, agent_target_id, model_plan_id, default_model, model_policy_id, updated_at_unix_ms
)
SELECT b.workspace_id, b.agent_target_id,
  NULLIF(b.model_plan_id, ''),
  b.default_model,
  CASE
    WHEN b.model_policy_id IS NOT NULL AND b.model_policy_id <> '' AND EXISTS (
      SELECT 1 FROM model_usage_policies p
      WHERE p.workspace_id = b.workspace_id AND p.policy_id = b.model_policy_id
    ) THEN b.model_policy_id
    ELSE NULL
  END,
  b.updated_at_unix_ms
FROM agent_target_model_bindings b;

DROP TABLE agent_target_model_bindings;

ALTER TABLE agent_target_model_bindings_v3 RENAME TO agent_target_model_bindings;

CREATE INDEX IF NOT EXISTS idx_agent_target_model_bindings_plan
  ON agent_target_model_bindings(workspace_id, model_plan_id);

CREATE INDEX IF NOT EXISTS idx_agent_target_model_bindings_policy
  ON agent_target_model_bindings(workspace_id, model_policy_id);
`); err != nil {
		return fmt.Errorf("migrate agent model bindings v3: %w", err)
	}
	if _, err = tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationAgentModelBindingsV3, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record agent model bindings v3 migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit agent model bindings v3 migration: %w", err)
	}
	return nil
}

// backfillModelPlansFromManagedCredentials copies every legacy managed model
// provider credential row into a named model plan so existing configurations
// keep working after the upgrade. The legacy tables stay in place for the
// workspace-app grant broker.
func backfillModelPlansFromManagedCredentials(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `
SELECT workspace_id, provider_id, enabled, api_key_ciphertext, base_url, models_json, updated_at_unix_ms
FROM managed_model_provider_credentials
`)
	if err != nil {
		return fmt.Errorf("read legacy managed credentials for model plan backfill: %w", err)
	}
	defer rows.Close()

	type legacyRow struct {
		workspaceID     string
		providerID      string
		enabled         int
		ciphertext      string
		baseURL         string
		modelsJSON      string
		updatedAtUnixMS int64
	}
	var legacy []legacyRow
	for rows.Next() {
		var row legacyRow
		if err := rows.Scan(&row.workspaceID, &row.providerID, &row.enabled, &row.ciphertext, &row.baseURL, &row.modelsJSON, &row.updatedAtUnixMS); err != nil {
			return fmt.Errorf("scan legacy managed credential row: %w", err)
		}
		legacy = append(legacy, row)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate legacy managed credential rows: %w", err)
	}

	for _, row := range legacy {
		planID := "mp-migrated-" + row.providerID
		name, protocol := legacyManagedProviderPlanIdentity(row.providerID)
		models, err := legacyManagedModelsToPlanModels(row.modelsJSON)
		if err != nil {
			return err
		}
		firstUseJSON := `{"status":"pending"}`
		_, err = tx.ExecContext(ctx, `
INSERT INTO model_plans (
  workspace_id, plan_id, name, template_kind, protocol, api_key_ciphertext,
  base_url, models_json, default_model, enabled, detection_json, first_use_json,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, 'custom', ?, ?, ?, ?, '', ?, '{}', ?, ?, ?)
ON CONFLICT(workspace_id, plan_id) DO NOTHING
`, row.workspaceID, planID, name, protocol, row.ciphertext, row.baseURL, models, row.enabled, firstUseJSON, row.updatedAtUnixMS, row.updatedAtUnixMS)
		if err != nil {
			return fmt.Errorf("backfill model plan from managed credential %s: %w", row.providerID, err)
		}
	}
	return nil
}

func legacyManagedProviderPlanIdentity(providerID string) (name string, protocol string) {
	switch strings.TrimSpace(providerID) {
	case "anthropic":
		return "Anthropic", "anthropic"
	case "agnes":
		return "Agnes", "openai"
	default:
		return "OpenAI", "openai"
	}
}

func legacyManagedModelsToPlanModels(modelsJSON string) (string, error) {
	var legacyModels []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	if strings.TrimSpace(modelsJSON) != "" {
		if err := json.Unmarshal([]byte(modelsJSON), &legacyModels); err != nil {
			return "", fmt.Errorf("decode legacy managed credential models: %w", err)
		}
	}
	type planModel struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}
	planModels := make([]planModel, 0, len(legacyModels))
	for _, model := range legacyModels {
		id := strings.TrimSpace(model.ID)
		if id == "" {
			continue
		}
		name := strings.TrimSpace(model.Name)
		if name == "" {
			name = id
		}
		planModels = append(planModels, planModel{ID: id, Name: name})
	}
	encoded, err := json.Marshal(planModels)
	if err != nil {
		return "", fmt.Errorf("encode backfilled plan models: %w", err)
	}
	return string(encoded), nil
}
