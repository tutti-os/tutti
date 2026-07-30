package workspace

import (
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func TestTuttiAgentDefaultEnablementMigrationRepairsHistoricalDisabledTarget(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := t.Context()

	if _, err := store.writeDB.ExecContext(ctx, `
DELETE FROM tuttid_schema_migrations
WHERE id = ?
`, schemaMigrationAgentTargetsEnableTuttiAgentV1); err != nil {
		t.Fatalf("reset Tutti Agent enablement migration: %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
UPDATE agent_targets
SET enabled = 0
WHERE id = ? AND source = ?
`, agenttargetbiz.IDLocalTuttiAgent, agenttargetbiz.SourceSystem); err != nil {
		t.Fatalf("seed disabled Tutti Agent target: %v", err)
	}

	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	if enabled := tuttiAgentTargetEnabled(t, store); !enabled {
		t.Fatal("Tutti Agent target enabled = false after migration, want true")
	}
	applied, err := store.hasMigration(ctx, schemaMigrationAgentTargetsEnableTuttiAgentV1)
	if err != nil {
		t.Fatalf("hasMigration() error = %v", err)
	}
	if !applied {
		t.Fatal("Tutti Agent default enablement migration was not recorded")
	}
}

func tuttiAgentTargetEnabled(t *testing.T, store *SQLiteStore) bool {
	t.Helper()

	var enabled bool
	if err := store.readDB.QueryRow(`
SELECT enabled
FROM agent_targets
WHERE id = ?
`, agenttargetbiz.IDLocalTuttiAgent).Scan(&enabled); err != nil {
		t.Fatalf("read Tutti Agent target enabled state: %v", err)
	}
	return enabled
}
