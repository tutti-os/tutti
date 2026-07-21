package workspace

import (
	"context"
	"path/filepath"
	"testing"
)

func openRawStore(t *testing.T) *SQLiteStore {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "tuttid.db")
	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

// TestApplyAgentModelBindingsV2ConvergesFromDivergentState exercises the retry
// path: a database whose column was added by a prior crashed run but never got
// the marker. The hasColumn precheck skips the ALTER and records the marker,
// and a second run is a no-op.
func TestApplyAgentModelBindingsV2ConvergesFromDivergentState(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openRawStore(t)
	if _, err := store.writeDB.ExecContext(ctx, `
CREATE TABLE tuttid_schema_migrations (id TEXT PRIMARY KEY, applied_at_unix_ms INTEGER NOT NULL);
CREATE TABLE agent_target_model_bindings (
  workspace_id TEXT NOT NULL,
  agent_target_id TEXT NOT NULL,
  model_policy_id TEXT NOT NULL DEFAULT ''
);
`); err != nil {
		t.Fatalf("build divergent state: %v", err)
	}

	if err := store.applyAgentModelBindingsV2(ctx); err != nil {
		t.Fatalf("applyAgentModelBindingsV2() error = %v", err)
	}

	applied, err := store.hasMigration(ctx, schemaMigrationAgentModelBindingsV2)
	if err != nil {
		t.Fatalf("hasMigration() error = %v", err)
	}
	if !applied {
		t.Fatalf("v2 marker missing after convergence run")
	}
	present, err := store.hasColumn(ctx, "agent_target_model_bindings", "model_policy_id")
	if err != nil {
		t.Fatalf("hasColumn() error = %v", err)
	}
	if !present {
		t.Fatalf("model_policy_id column missing after convergence run")
	}

	// Idempotent: the second run is a no-op and keeps a single marker.
	if err := store.applyAgentModelBindingsV2(ctx); err != nil {
		t.Fatalf("applyAgentModelBindingsV2() second run error = %v", err)
	}
	var count int
	if err := store.writeDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM tuttid_schema_migrations WHERE id = ?`, schemaMigrationAgentModelBindingsV2).Scan(&count); err != nil {
		t.Fatalf("count marker: %v", err)
	}
	if count != 1 {
		t.Fatalf("v2 marker count = %d, want 1", count)
	}
}

// TestApplyAgentModelBindingsV2RollsBackOnMarkerFailure proves ALTER and marker
// are atomic: an extra NOT NULL column on the migrations table forces the marker
// INSERT to fail, so the transaction rolls back and the ALTER'd column does not
// survive. A later retry can then apply cleanly.
func TestApplyAgentModelBindingsV2RollsBackOnMarkerFailure(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	store := openRawStore(t)
	if _, err := store.writeDB.ExecContext(ctx, `
CREATE TABLE tuttid_schema_migrations (id TEXT PRIMARY KEY, applied_at_unix_ms INTEGER NOT NULL, guard TEXT NOT NULL);
CREATE TABLE agent_target_model_bindings (workspace_id TEXT NOT NULL, agent_target_id TEXT NOT NULL);
`); err != nil {
		t.Fatalf("build failing-marker state: %v", err)
	}

	if err := store.applyAgentModelBindingsV2(ctx); err == nil {
		t.Fatalf("applyAgentModelBindingsV2() error = nil, want a marker-insert failure")
	}

	// The ALTER must have rolled back with the failed marker insert.
	present, err := store.hasColumn(ctx, "agent_target_model_bindings", "model_policy_id")
	if err != nil {
		t.Fatalf("hasColumn() error = %v", err)
	}
	if present {
		t.Fatalf("model_policy_id column present after a rolled-back migration")
	}
	applied, err := store.hasMigration(ctx, schemaMigrationAgentModelBindingsV2)
	if err != nil {
		t.Fatalf("hasMigration() error = %v", err)
	}
	if applied {
		t.Fatalf("v2 marker present after a rolled-back migration")
	}
}
