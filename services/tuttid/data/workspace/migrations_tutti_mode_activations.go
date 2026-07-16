package workspace

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

func (s *SQLiteStore) applyTuttiModeActivationsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationTuttiModeActivationsV1)
	if err != nil || applied {
		return err
	}
	_, err = s.writeDB.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS tutti_mode_activations (
  workspace_id TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  current_revision_id TEXT NOT NULL,
  current_revision INTEGER NOT NULL CHECK (current_revision > 0),
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, activation_id),
  UNIQUE (workspace_id, agent_session_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tutti_mode_activation_revisions (
  workspace_id TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'inactive')),
  source TEXT NOT NULL CHECK (source IN ('slash_command', 'badge_remove')),
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, activation_id, revision_id),
  UNIQUE (workspace_id, activation_id, revision),
  FOREIGN KEY (workspace_id, activation_id)
    REFERENCES tutti_mode_activations(workspace_id, activation_id) ON DELETE CASCADE,
  CHECK ((state = 'active' AND source = 'slash_command') OR
         (state = 'inactive' AND source = 'badge_remove'))
);

CREATE TABLE IF NOT EXISTS tutti_mode_turn_snapshots (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  activation_id TEXT NOT NULL DEFAULT '',
  revision_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'inactive')),
  source TEXT NOT NULL DEFAULT '' CHECK (source IN ('', 'slash_command', 'badge_remove')),
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id, turn_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CHECK ((activation_id = '' AND revision_id = '' AND revision = 0 AND state = 'inactive' AND source = '') OR
         (activation_id != '' AND revision_id != '' AND revision > 0 AND
          ((state = 'active' AND source = 'slash_command') OR
           (state = 'inactive' AND source = 'badge_remove'))))
);

CREATE INDEX IF NOT EXISTS idx_tutti_mode_turn_snapshots_revision
  ON tutti_mode_turn_snapshots(workspace_id, activation_id, revision);

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationTuttiModeActivationsV1, unixMs(time.Now().UTC()))
	if err != nil {
		return fmt.Errorf("migrate Tutti mode activations v1: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyTuttiModeTurnDispatchV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationTuttiModeTurnDispatchV2)
	if err != nil || applied {
		return err
	}
	// Rows written by v1 were created only after Runtime.Exec returned, so they
	// are already accepted. New rows explicitly start prepared and are accepted
	// only after runtime confirms dispatch.
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Tutti mode turn dispatch v2 migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	columns := []struct {
		name string
		sql  string
	}{
		{
			name: "dispatch_state",
			sql: `ALTER TABLE tutti_mode_turn_snapshots
  ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'accepted'
  CHECK (dispatch_state IN ('prepared', 'accepted'))`,
		},
		{
			name: "accepted_at_unix_ms",
			sql:  `ALTER TABLE tutti_mode_turn_snapshots ADD COLUMN accepted_at_unix_ms INTEGER`,
		},
	}
	for _, column := range columns {
		exists, err := tuttiModeTurnSnapshotColumnExistsTx(ctx, tx, column.name)
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		if _, err := tx.ExecContext(ctx, column.sql); err != nil {
			return fmt.Errorf("add Tutti mode turn snapshot column %s: %w", column.name, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationTuttiModeTurnDispatchV2, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record Tutti mode turn dispatch v2 migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Tutti mode turn dispatch v2 migration: %w", err)
	}
	return nil
}

func tuttiModeTurnSnapshotColumnExistsTx(ctx context.Context, tx *sql.Tx, columnName string) (bool, error) {
	var count int
	if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM pragma_table_info('tutti_mode_turn_snapshots')
WHERE name = ?
`, columnName).Scan(&count); err != nil {
		return false, fmt.Errorf("inspect Tutti mode turn snapshot column %s: %w", columnName, err)
	}
	return count > 0, nil
}
