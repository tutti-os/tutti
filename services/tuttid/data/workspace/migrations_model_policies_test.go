package workspace

import (
	"context"
	"testing"
)

func TestApplyModelPoliciesV1CreatesTablesAtomicallyAndIsIdempotent(t *testing.T) {
	t.Parallel()

	ctx := context.Background()
	// openTestSQLiteStore already runs Migrate, so the model-policies migration
	// has applied once by construction.
	store := openTestSQLiteStore(t)

	applied, err := store.hasMigration(ctx, schemaMigrationModelPoliciesV1)
	if err != nil {
		t.Fatalf("hasMigration() error = %v", err)
	}
	if !applied {
		t.Fatalf("model_policies_v1 marker missing after Migrate")
	}

	for _, table := range []string{"model_usage_policies", "model_policy_session_overrides", "agent_session_acceptance"} {
		var name string
		if err := store.writeDB.QueryRowContext(ctx, `
SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?
`, table).Scan(&name); err != nil {
			t.Fatalf("expected table %q to exist after migration: %v", table, err)
		}
	}

	// Re-running the full migration set must be a no-op: the transactional
	// migration commits schema and marker together, so the marker stays a
	// single row and the tables remain intact.
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() second run error = %v", err)
	}
	var markerCount int
	if err := store.writeDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM tuttid_schema_migrations WHERE id = ?
`, schemaMigrationModelPoliciesV1).Scan(&markerCount); err != nil {
		t.Fatalf("count migration marker: %v", err)
	}
	if markerCount != 1 {
		t.Fatalf("model_policies_v1 marker count = %d, want 1", markerCount)
	}
}
