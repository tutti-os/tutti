package workspace

import (
	"context"
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
