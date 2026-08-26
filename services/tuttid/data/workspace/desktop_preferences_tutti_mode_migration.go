package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

const desktopPreferencesTuttiModeFeatureFlag = "lab.tuttiMode"

func (s *SQLiteStore) applyDesktopPreferencesTuttiModeDefaultOffV1(
	ctx context.Context,
) error {
	applied, err := s.hasMigration(
		ctx,
		schemaMigrationDesktopPreferencesTuttiModeDefaultOffV1,
	)
	if err != nil || applied {
		return err
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin desktop Tutti Mode default-off migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var featureFlagsJSON sql.NullString
	err = tx.QueryRowContext(ctx, `
SELECT feature_flags_json
FROM desktop_preferences
WHERE id = ?
`, desktopPreferencesRowID).Scan(&featureFlagsJSON)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read desktop feature flags for Tutti Mode default-off migration: %w", err)
	}

	now := unixMs(time.Now().UTC())
	if err == nil {
		featureFlags, err := decodeFeatureFlags(featureFlagsJSON.String)
		if err != nil {
			return fmt.Errorf("decode desktop feature flags for Tutti Mode default-off migration: %w", err)
		}
		featureFlags[desktopPreferencesTuttiModeFeatureFlag] = false
		encodedFeatureFlags, err := encodeFeatureFlags(featureFlags)
		if err != nil {
			return fmt.Errorf("encode desktop feature flags for Tutti Mode default-off migration: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE desktop_preferences
SET feature_flags_json = ?, updated_at_unix_ms = ?
WHERE id = ?
`, encodedFeatureFlags, now, desktopPreferencesRowID); err != nil {
			return fmt.Errorf("reset desktop Tutti Mode preference: %w", err)
		}
	}

	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES (?, ?)
`, schemaMigrationDesktopPreferencesTuttiModeDefaultOffV1, now); err != nil {
		return fmt.Errorf("record desktop Tutti Mode default-off migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit desktop Tutti Mode default-off migration: %w", err)
	}
	return nil
}
