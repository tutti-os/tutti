package workspace

import (
	"context"
	"fmt"
	"time"
)

const schemaMigrationModelPoliciesV1 = "model_policies_v1"

func (s *SQLiteStore) applyModelPoliciesV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationModelPoliciesV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	_, err = s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS model_usage_policies (
  workspace_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  name TEXT NOT NULL,
  execution_plan_id TEXT NOT NULL DEFAULT '',
  execution_model TEXT NOT NULL DEFAULT '',
  planning_plan_id TEXT NOT NULL DEFAULT '',
  planning_model TEXT NOT NULL DEFAULT '',
  review_plan_id TEXT NOT NULL DEFAULT '',
  review_model TEXT NOT NULL DEFAULT '',
  review_rule_enabled INTEGER NOT NULL DEFAULT 0,
  review_rule_trigger TEXT NOT NULL DEFAULT 'on_task_complete',
  review_rule_max_runs INTEGER NOT NULL DEFAULT 0,
  review_rule_max_total_tokens INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, policy_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS model_policy_session_overrides (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  model_policy_id TEXT NOT NULL DEFAULT '',
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_session_acceptance (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  review_run_id TEXT NOT NULL DEFAULT '',
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationModelPoliciesV1, now)
	if err != nil {
		return fmt.Errorf("migrate model policies v1: %w", err)
	}
	return nil
}
