package storesqlite

import (
	"context"
	"testing"
)

func TestWorkspaceAgentGeneratedFilesRecentTurnsMigrationDropsProjectionAndCreatesIndex(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.db.ExecContext(ctx, `CREATE TABLE workspace_agent_turn_files (normalized_path TEXT)`); err != nil {
		t.Fatalf("create obsolete generated file projection: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `DELETE FROM agent_store_schema_migrations WHERE id = ?`, schemaMigrationWorkspaceAgentGeneratedFilesRecentTurnsV1); err != nil {
		t.Fatalf("reset generated files migration: %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	var projectionCount int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = 'workspace_agent_turn_files'`).Scan(&projectionCount); err != nil {
		t.Fatalf("count generated file projection table: %v", err)
	}
	if projectionCount != 0 {
		t.Fatalf("workspace_agent_turn_files table count = %d, want 0", projectionCount)
	}

	var indexCount int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_workspace_agent_turns_workspace_settled_recent'`).Scan(&indexCount); err != nil {
		t.Fatalf("count recent settled turns index: %v", err)
	}
	if indexCount != 1 {
		t.Fatalf("recent settled turns index count = %d, want 1", indexCount)
	}
}
