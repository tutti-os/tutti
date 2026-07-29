package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

func (s *SQLiteStore) applyUserProjectsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationUserProjectsV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	now := unixMs(time.Now().UTC())
	_, err = s.writeDB.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS user_projects (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  last_used_at_unix_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_user_projects_last_used
  ON user_projects(last_used_at_unix_ms DESC, updated_at_unix_ms DESC);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationUserProjectsV1, now)
	if err != nil {
		return fmt.Errorf("migrate workspace database for user projects: %w", err)
	}

	return nil
}

func (s *SQLiteStore) applyUserProjectsV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationUserProjectsV2)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin user project order migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `ALTER TABLE user_projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`); err != nil {
		return fmt.Errorf("add user project sort order: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (
    ORDER BY last_used_at_unix_ms DESC, updated_at_unix_ms DESC, label ASC, id ASC
  ) - 1 AS next_sort_order
  FROM user_projects
)
UPDATE user_projects
SET sort_order = (SELECT next_sort_order FROM ordered WHERE ordered.id = user_projects.id)
`); err != nil {
		return fmt.Errorf("backfill user project sort order: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES (?, ?)
`, schemaMigrationUserProjectsV2, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record user project order migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit user project order migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyUserProjectsV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationUserProjectsV3)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin user project pin migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `ALTER TABLE user_projects ADD COLUMN pinned_at_unix_ms INTEGER NOT NULL DEFAULT 0`); err != nil {
		return fmt.Errorf("add user project pinned timestamp: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES (?, ?)
`, schemaMigrationUserProjectsV3, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record user project pin migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit user project pin migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) hasMigration(ctx context.Context, migrationID string) (bool, error) {
	row := s.writeDB.QueryRowContext(ctx, `
SELECT 1
FROM tuttid_schema_migrations
WHERE id = ?
`, migrationID)

	var exists int
	if err := row.Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("check workspace migration %s: %w", migrationID, err)
	}

	return exists == 1, nil
}

func (s *SQLiteStore) hasColumn(ctx context.Context, tableName string, columnName string) (bool, error) {
	rows, err := s.writeDB.QueryContext(ctx, fmt.Sprintf("PRAGMA table_info(%s)", tableName))
	if err != nil {
		return false, fmt.Errorf("inspect workspace table %s: %w", tableName, err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			columnID   int
			name       string
			columnType string
			notNull    int
			defaultSQL sql.NullString
			pk         int
		)
		if err := rows.Scan(&columnID, &name, &columnType, &notNull, &defaultSQL, &pk); err != nil {
			return false, fmt.Errorf("scan workspace table info %s: %w", tableName, err)
		}
		if name == columnName {
			return true, nil
		}
	}

	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("iterate workspace table info %s: %w", tableName, err)
	}

	return false, nil
}
