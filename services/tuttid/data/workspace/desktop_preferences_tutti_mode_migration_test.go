package workspace

import (
	"context"
	"testing"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
)

func TestDesktopPreferencesTuttiModeDefaultOffMigrationResetsExistingPreferenceOnce(t *testing.T) {
	for _, testCase := range []struct {
		name              string
		preferencePresent bool
		previouslyEnabled bool
	}{
		{name: "previously enabled", preferencePresent: true, previouslyEnabled: true},
		{name: "previously disabled", preferencePresent: true, previouslyEnabled: false},
		{name: "previously absent"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			t.Parallel()

			store := openTestSQLiteStore(t)
			ctx := context.Background()
			preferences := preferencesbiz.DefaultDesktopPreferences()
			if testCase.preferencePresent {
				preferences.FeatureFlags[desktopPreferencesTuttiModeFeatureFlag] =
					testCase.previouslyEnabled
			}
			preferences.FeatureFlags["lab.connectors"] = true
			if _, err := store.PutDesktopPreferences(ctx, preferences); err != nil {
				t.Fatalf("persist legacy desktop preferences: %v", err)
			}
			if _, err := store.writeDB.ExecContext(ctx, `
DELETE FROM tuttid_schema_migrations WHERE id = ?
`, schemaMigrationDesktopPreferencesTuttiModeDefaultOffV1); err != nil {
				t.Fatalf("reset Tutti Mode default-off migration marker: %v", err)
			}

			if err := store.Migrate(ctx); err != nil {
				t.Fatalf("Migrate() error = %v", err)
			}
			migrated, err := store.GetDesktopPreferences(ctx)
			if err != nil {
				t.Fatalf("GetDesktopPreferences() error = %v", err)
			}
			if tuttiModeEnabled, present := migrated.FeatureFlags[desktopPreferencesTuttiModeFeatureFlag]; !present || tuttiModeEnabled {
				t.Fatalf("Tutti Mode flag = %t/%t after migration, want present false", tuttiModeEnabled, present)
			}
			if !migrated.FeatureFlags["lab.connectors"] {
				t.Fatalf("unrelated feature flags = %#v, want connectors preserved", migrated.FeatureFlags)
			}

			migrated.FeatureFlags[desktopPreferencesTuttiModeFeatureFlag] = true
			if _, err := store.PutDesktopPreferences(ctx, migrated); err != nil {
				t.Fatalf("persist post-migration Tutti Mode opt-in: %v", err)
			}
			if err := store.Migrate(ctx); err != nil {
				t.Fatalf("second Migrate() error = %v", err)
			}
			reloaded, err := store.GetDesktopPreferences(ctx)
			if err != nil {
				t.Fatalf("GetDesktopPreferences() after opt-in error = %v", err)
			}
			if !reloaded.FeatureFlags[desktopPreferencesTuttiModeFeatureFlag] {
				t.Fatal("post-migration Tutti Mode opt-in was reset")
			}

			var markerCount int
			if err := store.readDB.QueryRowContext(ctx, `
SELECT COUNT(*) FROM tuttid_schema_migrations WHERE id = ?
`, schemaMigrationDesktopPreferencesTuttiModeDefaultOffV1).Scan(&markerCount); err != nil {
				t.Fatalf("read Tutti Mode migration marker: %v", err)
			}
			if markerCount != 1 {
				t.Fatalf("Tutti Mode migration markers = %d, want 1", markerCount)
			}
		})
	}
}
