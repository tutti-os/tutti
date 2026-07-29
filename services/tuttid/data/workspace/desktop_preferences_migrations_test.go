package workspace

import (
	"context"
	"testing"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
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

func TestAgentCLIUpdateCheckMigrationAddsEnabledByDefaultColumn(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	ok, err := store.hasColumn(ctx, "desktop_preferences", "agent_cli_update_check_enabled")
	if err != nil || !ok {
		t.Fatalf("agent_cli_update_check_enabled column missing (err=%v)", err)
	}
	defaults := preferencesbiz.DefaultDesktopPreferences()
	_, err = store.writeDB.ExecContext(ctx, `
INSERT INTO desktop_preferences (id, locale, theme_source, dock_icon_style, updated_at_unix_ms)
VALUES ('migration-default', ?, ?, ?, 1)
`, defaults.Locale, defaults.ThemeSource, defaults.DockIconStyle)
	if err != nil {
		t.Fatalf("insert legacy-shaped desktop preferences: %v", err)
	}
	var enabled bool
	if err := store.readDB.QueryRowContext(ctx, `
SELECT agent_cli_update_check_enabled FROM desktop_preferences WHERE id = 'migration-default'
`).Scan(&enabled); err != nil {
		t.Fatalf("read migrated agent CLI update check preference: %v", err)
	}
	if !enabled {
		t.Fatal("migrated agent CLI update check preference = false, want true")
	}
}
