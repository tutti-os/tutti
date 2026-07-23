package workspace

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"

	workspaceagentbiz "github.com/tutti-os/tutti/services/tuttid/biz/workspaceagent"
)

func (s *SQLiteStore) applyWorkspaceAgentsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentsV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agents v1 migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS workspace_agents (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  harness_agent_target_id TEXT NOT NULL,
  model_plan_id TEXT NOT NULL DEFAULT '',
  default_model TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL DEFAULT '',
  skills_json TEXT NOT NULL DEFAULT '[]',
  tools_json TEXT NOT NULL DEFAULT '[]',
  permissions_json TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'user',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_workspace_agents_directory
  ON workspace_agents(workspace_id, enabled DESC, updated_at_unix_ms DESC, name ASC);
CREATE INDEX IF NOT EXISTS idx_workspace_agents_harness
  ON workspace_agents(workspace_id, harness_agent_target_id);
CREATE INDEX IF NOT EXISTS idx_workspace_agents_model_plan
  ON workspace_agents(workspace_id, model_plan_id);
`); err != nil {
		return fmt.Errorf("create workspace agents v1 schema: %w", err)
	}

	if err := backfillWorkspaceAgentsFromBindings(ctx, tx); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationWorkspaceAgentsV1, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace agents v1 migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agents v1 migration: %w", err)
	}
	return nil
}

// applyWorkspaceAgentsV6 reconciles bindings written after the original
// Workspace Agent backfill shipped. The legacy binding table remains readable
// for historical session snapshots, while every current binding gains the
// equivalent first-class Workspace Agent before Desktop retires the binding UI.
func (s *SQLiteStore) applyWorkspaceAgentsV6(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentsV6)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent legacy binding reconciliation: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if err := backfillWorkspaceAgentsFromBindings(ctx, tx); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationWorkspaceAgentsV6, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record workspace agent legacy binding reconciliation: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent legacy binding reconciliation: %w", err)
	}
	return nil
}

func backfillWorkspaceAgentsFromBindings(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `
SELECT b.workspace_id,
       b.agent_target_id,
       b.model_plan_id,
       COALESCE(NULLIF(b.default_model, ''), p.default_model, ''),
       b.updated_at_unix_ms,
       COALESCE(t.name, ''),
       COALESCE(t.enabled, 1),
       COALESCE(p.name, '')
FROM agent_target_model_bindings AS b
LEFT JOIN agent_targets AS t ON t.id = b.agent_target_id
LEFT JOIN model_plans AS p
  ON p.workspace_id = b.workspace_id AND p.plan_id = b.model_plan_id
ORDER BY b.workspace_id ASC, b.agent_target_id ASC
`)
	if err != nil {
		return fmt.Errorf("read legacy agent model bindings: %w", err)
	}
	defer rows.Close()

	type bindingRow struct {
		workspaceID   string
		targetID      string
		modelPlanID   string
		defaultModel  string
		updatedAtMS   int64
		targetName    string
		targetEnabled bool
		planName      string
	}
	bindings := make([]bindingRow, 0)
	for rows.Next() {
		var row bindingRow
		if err := rows.Scan(
			&row.workspaceID,
			&row.targetID,
			&row.modelPlanID,
			&row.defaultModel,
			&row.updatedAtMS,
			&row.targetName,
			&row.targetEnabled,
			&row.planName,
		); err != nil {
			return fmt.Errorf("scan legacy agent model binding: %w", err)
		}
		bindings = append(bindings, row)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate legacy agent model bindings: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close legacy agent model bindings: %w", err)
	}

	for _, row := range bindings {
		name := legacyWorkspaceAgentName(row.targetName, row.targetID, row.planName)
		_, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agents (
  workspace_id, agent_id, name, purpose, harness_agent_target_id,
  model_plan_id, default_model, instructions, skills_json, tools_json,
  permissions_json, enabled, source, revision, created_at_unix_ms,
  updated_at_unix_ms
) VALUES (?, ?, ?, '', ?, ?, ?, '', '[]', '[]', '[]', ?, ?, 1, ?, ?)
ON CONFLICT(workspace_id, agent_id) DO NOTHING
`, row.workspaceID,
			workspaceagentbiz.LegacyBindingID(row.workspaceID, row.targetID),
			name,
			row.targetID,
			row.modelPlanID,
			row.defaultModel,
			row.targetEnabled,
			workspaceagentbiz.SourceLegacyBinding,
			row.updatedAtMS,
			row.updatedAtMS,
		)
		if err != nil {
			return fmt.Errorf("backfill workspace agent from target %q: %w", row.targetID, err)
		}
	}
	return nil
}

func legacyWorkspaceAgentName(targetName string, targetID string, planName string) string {
	targetName = strings.TrimSpace(targetName)
	if targetName == "" {
		targetName = strings.TrimSpace(targetID)
	}
	planName = strings.TrimSpace(planName)
	name := targetName
	if planName != "" {
		name = targetName + " · " + planName
	}
	runes := []rune(name)
	if len(runes) > 120 {
		name = string(runes[:120])
	}
	return name
}
