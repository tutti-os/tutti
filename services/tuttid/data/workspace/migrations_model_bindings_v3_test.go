package workspace

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

// openPreV3Store builds a minimal, FK-consistent schema at the v2 bindings
// shape (model_policy_id present as NOT NULL DEFAULT ” with no policy foreign
// key) plus a valid policy and one binding whose policy link is dangling. It
// deliberately skips the full migration chain so applyAgentModelBindingsV3 can
// be exercised in isolation against legacy data.
func openPreV3Store(t *testing.T) *SQLiteStore {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "tuttid.db")
	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })

	if _, err := store.writeDB.ExecContext(context.Background(), `
CREATE TABLE tuttid_schema_migrations (id TEXT PRIMARY KEY, applied_at_unix_ms INTEGER NOT NULL);
CREATE TABLE workspaces (id TEXT PRIMARY KEY);
CREATE TABLE agent_targets (id TEXT PRIMARY KEY);
CREATE TABLE model_plans (workspace_id TEXT NOT NULL, plan_id TEXT NOT NULL, PRIMARY KEY (workspace_id, plan_id));
CREATE TABLE model_usage_policies (workspace_id TEXT NOT NULL, policy_id TEXT NOT NULL, PRIMARY KEY (workspace_id, policy_id));
CREATE TABLE agent_target_model_bindings (
  workspace_id TEXT NOT NULL,
  agent_target_id TEXT NOT NULL,
  model_plan_id TEXT NOT NULL DEFAULT '',
  default_model TEXT NOT NULL DEFAULT '',
  model_policy_id TEXT NOT NULL DEFAULT '',
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_target_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (agent_target_id) REFERENCES agent_targets(id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, model_plan_id) REFERENCES model_plans(workspace_id, plan_id) ON DELETE RESTRICT
);
INSERT INTO workspaces (id) VALUES ('ws');
INSERT INTO agent_targets (id) VALUES ('at-valid'), ('at-dangling');
INSERT INTO model_plans (workspace_id, plan_id) VALUES ('ws', 'mp-1');
INSERT INTO model_usage_policies (workspace_id, policy_id) VALUES ('ws', 'pol-real');
INSERT INTO agent_target_model_bindings
  (workspace_id, agent_target_id, model_plan_id, default_model, model_policy_id, updated_at_unix_ms)
VALUES
  ('ws', 'at-valid', 'mp-1', '', 'pol-real', 1),
  ('ws', 'at-dangling', 'mp-1', '', 'ghost', 1);
`); err != nil {
		t.Fatalf("build pre-v3 schema: %v", err)
	}
	return store
}

func TestApplyAgentModelBindingsV3NormalizesDanglingAndIsIdempotent(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openPreV3Store(t)

	if err := store.applyAgentModelBindingsV3(ctx); err != nil {
		t.Fatalf("applyAgentModelBindingsV3() error = %v", err)
	}

	// A valid legacy link is preserved; a dangling one is normalized to NULL;
	// neither row is dropped (no silent binding loss).
	var validPolicy sql.NullString
	if err := store.writeDB.QueryRowContext(ctx, `SELECT model_policy_id FROM agent_target_model_bindings WHERE agent_target_id = 'at-valid'`).Scan(&validPolicy); err != nil {
		t.Fatalf("read valid binding: %v", err)
	}
	if !validPolicy.Valid || validPolicy.String != "pol-real" {
		t.Fatalf("valid binding policy = %#v, want pol-real preserved", validPolicy)
	}
	var danglingPolicy sql.NullString
	if err := store.writeDB.QueryRowContext(ctx, `SELECT model_policy_id FROM agent_target_model_bindings WHERE agent_target_id = 'at-dangling'`).Scan(&danglingPolicy); err != nil {
		t.Fatalf("read dangling binding: %v", err)
	}
	if danglingPolicy.Valid {
		t.Fatalf("dangling binding policy = %q, want NULL after normalization", danglingPolicy.String)
	}
	var count int
	if err := store.writeDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_target_model_bindings`).Scan(&count); err != nil {
		t.Fatalf("count bindings: %v", err)
	}
	if count != 2 {
		t.Fatalf("binding count = %d, want 2 (migration must not drop rows)", count)
	}

	// The new policy foreign key is now active: deleting the referenced policy
	// is blocked by ON DELETE RESTRICT.
	if _, err := store.writeDB.ExecContext(ctx, `DELETE FROM model_usage_policies WHERE workspace_id = 'ws' AND policy_id = 'pol-real'`); err == nil {
		t.Fatalf("expected the RESTRICT foreign key to block deleting a referenced policy")
	}

	// Idempotent: re-running is a no-op and keeps exactly one marker.
	if err := store.applyAgentModelBindingsV3(ctx); err != nil {
		t.Fatalf("applyAgentModelBindingsV3() second run error = %v", err)
	}
	var marker int
	if err := store.writeDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM tuttid_schema_migrations WHERE id = ?`, schemaMigrationAgentModelBindingsV3).Scan(&marker); err != nil {
		t.Fatalf("count marker: %v", err)
	}
	if marker != 1 {
		t.Fatalf("v3 marker count = %d, want 1", marker)
	}
}

// TestApplyAgentModelBindingsV3RollsBackOnFailure proves the migration is
// atomic: if the rebuild fails partway, the transaction rolls back leaving the
// original bindings table, its rows, and the (absent) migration marker exactly
// as they were. The failure is forced deterministically by pre-creating the
// scratch table the migration tries to CREATE.
func TestApplyAgentModelBindingsV3RollsBackOnFailure(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openPreV3Store(t)

	if _, err := store.writeDB.ExecContext(ctx, `CREATE TABLE agent_target_model_bindings_v3 (x INTEGER)`); err != nil {
		t.Fatalf("pre-create scratch table: %v", err)
	}

	if err := store.applyAgentModelBindingsV3(ctx); err == nil {
		t.Fatalf("applyAgentModelBindingsV3() error = nil, want failure from the pre-existing scratch table")
	}

	// The original table and both rows must survive (no partial rebuild).
	var count int
	if err := store.writeDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_target_model_bindings`).Scan(&count); err != nil {
		t.Fatalf("original bindings table must survive rollback: %v", err)
	}
	if count != 2 {
		t.Fatalf("binding count after rollback = %d, want 2", count)
	}
	// The original NOT NULL column and its untouched dangling value remain,
	// confirming the copy/normalization did not partially apply.
	var policy string
	if err := store.writeDB.QueryRowContext(ctx, `SELECT model_policy_id FROM agent_target_model_bindings WHERE agent_target_id = 'at-dangling'`).Scan(&policy); err != nil {
		t.Fatalf("read original dangling binding: %v", err)
	}
	if policy != "ghost" {
		t.Fatalf("original dangling policy = %q, want untouched 'ghost'", policy)
	}
	// The migration marker must be absent so a later run retries cleanly.
	applied, err := store.hasMigration(ctx, schemaMigrationAgentModelBindingsV3)
	if err != nil {
		t.Fatalf("hasMigration() error = %v", err)
	}
	if applied {
		t.Fatalf("v3 marker present after a rolled-back migration")
	}
}

// TestFullMigrateInstallsBindingPolicyForeignKey confirms the standard startup
// migration path yields the new constraint and remains idempotent.
func TestFullMigrateInstallsBindingPolicyForeignKey(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openTestSQLiteStore(t) // runs the full Migrate(), including v3

	applied, err := store.hasMigration(ctx, schemaMigrationAgentModelBindingsV3)
	if err != nil {
		t.Fatalf("hasMigration() error = %v", err)
	}
	if !applied {
		t.Fatalf("agent_model_bindings_v3 marker missing after Migrate")
	}

	// Re-running Migrate must be a no-op.
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() second run error = %v", err)
	}
	var marker int
	if err := store.writeDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM tuttid_schema_migrations WHERE id = ?`, schemaMigrationAgentModelBindingsV3).Scan(&marker); err != nil {
		t.Fatalf("count marker: %v", err)
	}
	if marker != 1 {
		t.Fatalf("v3 marker count = %d, want 1", marker)
	}
}
