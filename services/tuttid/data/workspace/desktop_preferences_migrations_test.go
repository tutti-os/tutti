package workspace

import (
	"context"
	"database/sql"
	"testing"
)

func TestFeatureFlagsMigrationAddsColumns(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	for _, col := range []string{"feature_flags_json", "workbench_shortcuts_json"} {
		ok, err := store.hasColumn(ctx, "desktop_preferences", col)
		if err != nil || !ok {
			t.Fatalf("column %s missing (err=%v)", col, err)
		}
	}
}

func TestAgentEnablementMigrationsDefaultToEnabled(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	for _, column := range []string{"enable_cursor_agent", "enable_opencode_agent"} {
		var defaultValue sql.NullString
		rows, err := store.readDB.Query(`PRAGMA table_info(desktop_preferences)`)
		if err != nil {
			t.Fatalf("inspect desktop_preferences: %v", err)
		}

		found := false
		for rows.Next() {
			var cid int
			var name string
			var columnType string
			var notNull int
			var primaryKey int
			if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &primaryKey); err != nil {
				rows.Close()
				t.Fatalf("scan desktop_preferences column: %v", err)
			}
			if name == column {
				found = true
				break
			}
		}
		if err := rows.Close(); err != nil {
			t.Fatalf("close desktop_preferences columns: %v", err)
		}
		if !found {
			t.Fatalf("column %s missing", column)
		}
		if !defaultValue.Valid || defaultValue.String != "1" {
			t.Fatalf("column %s default = %q, want 1", column, defaultValue.String)
		}
	}
}
