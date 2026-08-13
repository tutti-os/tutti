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

func (s *SQLiteStore) applyTuttiModeOrchestrationIntensityV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationTuttiModeOrchestrationIntensityV3)
	if err != nil || applied {
		return err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Tutti mode orchestration intensity v3 migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	revisionExists, err := tuttiModeColumnExistsTx(ctx, tx, "tutti_mode_activation_revisions", "orchestration_intensity")
	if err != nil {
		return err
	}
	if !revisionExists {
		// Revisions are always configured rows, so old rows adopt the default
		// planning strength directly.
		if _, err := tx.ExecContext(ctx, `
ALTER TABLE tutti_mode_activation_revisions
  ADD COLUMN orchestration_intensity INTEGER NOT NULL DEFAULT 50
  CHECK (orchestration_intensity BETWEEN 0 AND 100)`); err != nil {
			return fmt.Errorf("add Tutti mode activation revision orchestration intensity: %w", err)
		}
	}
	snapshotExists, err := tuttiModeColumnExistsTx(ctx, tx, "tutti_mode_turn_snapshots", "orchestration_intensity")
	if err != nil {
		return err
	}
	if !snapshotExists {
		// Snapshots include the canonical unconfigured row shape, which must stay
		// all-zero; configured legacy rows are then upgraded to the default.
		if _, err := tx.ExecContext(ctx, `
ALTER TABLE tutti_mode_turn_snapshots
  ADD COLUMN orchestration_intensity INTEGER NOT NULL DEFAULT 0
  CHECK (orchestration_intensity BETWEEN 0 AND 100)`); err != nil {
			return fmt.Errorf("add Tutti mode turn snapshot orchestration intensity: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `
UPDATE tutti_mode_turn_snapshots
SET orchestration_intensity = 50
WHERE activation_id != ''`); err != nil {
			return fmt.Errorf("backfill Tutti mode turn snapshot orchestration intensity: %w", err)
		}
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationTuttiModeOrchestrationIntensityV3, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record Tutti mode orchestration intensity v3 migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Tutti mode orchestration intensity v3 migration: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyTuttiModeEffectSpeedV4(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationTuttiModeEffectSpeedV4)
	if err != nil || applied {
		return err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Tutti mode effect and speed v4 migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	// The existing orchestration_intensity column is deliberately retained as
	// effect storage so upgrades preserve the user's old preference without a
	// destructive table rebuild. Only speed needs a new column.
	for _, table := range []string{"tutti_mode_activation_revisions", "tutti_mode_turn_snapshots"} {
		exists, err := tuttiModeColumnExistsTx(ctx, tx, table, "speed")
		if err != nil {
			return err
		}
		if exists {
			continue
		}
		defaultValue := 50
		if table == "tutti_mode_turn_snapshots" {
			defaultValue = 0
		}
		if _, err := tx.ExecContext(ctx, fmt.Sprintf(`
ALTER TABLE %s
  ADD COLUMN speed INTEGER NOT NULL DEFAULT %d
  CHECK (speed BETWEEN 0 AND 100)`, table, defaultValue)); err != nil {
			return fmt.Errorf("add Tutti mode speed to %s: %w", table, err)
		}
		if table == "tutti_mode_turn_snapshots" {
			if _, err := tx.ExecContext(ctx, `
UPDATE tutti_mode_turn_snapshots
SET speed = 50
WHERE activation_id != ''`); err != nil {
				return fmt.Errorf("backfill Tutti mode turn snapshot speed: %w", err)
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationTuttiModeEffectSpeedV4, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record Tutti mode effect and speed v4 migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Tutti mode effect and speed v4 migration: %w", err)
	}
	return nil
}

// applyTuttiModeAgentCommandSourceV5 preserves the historical 'agent_command'
// source for activation revisions written while Agent self-service activation
// existed. Product mutation paths no longer emit this source, but the schema
// must continue to admit it so existing revisions and turn snapshots remain
// readable. The v1 rules live in table-level CHECK constraints that SQLite
// cannot ALTER, so both tables are rebuilt with their full post-v4 column set,
// following the applyWorkspaceWorkflowRevisionPathReuseV3 rebuild pattern.
func (s *SQLiteStore) applyTuttiModeAgentCommandSourceV5(ctx context.Context) (returnErr error) {
	applied, err := s.hasMigration(ctx, schemaMigrationTuttiModeAgentCommandSourceV5)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	conn, err := s.writeDB.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire Tutti mode agent command source migration connection: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		return fmt.Errorf("disable foreign keys for Tutti mode agent command source migration: %w", err)
	}
	foreignKeysDisabled := true
	defer func() {
		if !foreignKeysDisabled {
			return
		}
		if _, enableErr := conn.ExecContext(context.Background(), "PRAGMA foreign_keys = ON"); returnErr == nil && enableErr != nil {
			returnErr = fmt.Errorf("restore foreign keys after Tutti mode agent command source migration: %w", enableErr)
		}
	}()

	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Tutti mode agent command source migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
CREATE TABLE tutti_mode_activation_revisions_v5 (
  workspace_id TEXT NOT NULL,
  activation_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'inactive')),
  source TEXT NOT NULL CHECK (source IN ('slash_command', 'badge_remove', 'agent_command')),
  created_at_unix_ms INTEGER NOT NULL,
  orchestration_intensity INTEGER NOT NULL DEFAULT 50 CHECK (orchestration_intensity BETWEEN 0 AND 100),
  speed INTEGER NOT NULL DEFAULT 50 CHECK (speed BETWEEN 0 AND 100),
  PRIMARY KEY (workspace_id, activation_id, revision_id),
  UNIQUE (workspace_id, activation_id, revision),
  FOREIGN KEY (workspace_id, activation_id)
    REFERENCES tutti_mode_activations(workspace_id, activation_id) ON DELETE CASCADE,
  CHECK ((state = 'active' AND source IN ('slash_command', 'agent_command')) OR
         (state = 'inactive' AND source IN ('badge_remove', 'agent_command')))
);

INSERT INTO tutti_mode_activation_revisions_v5 (
  workspace_id, activation_id, revision_id, revision, state, source,
  created_at_unix_ms, orchestration_intensity, speed
)
SELECT
  workspace_id, activation_id, revision_id, revision, state, source,
  created_at_unix_ms, orchestration_intensity, speed
FROM tutti_mode_activation_revisions;

DROP TABLE tutti_mode_activation_revisions;
ALTER TABLE tutti_mode_activation_revisions_v5 RENAME TO tutti_mode_activation_revisions;

CREATE TABLE tutti_mode_turn_snapshots_v5 (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  activation_id TEXT NOT NULL DEFAULT '',
  revision_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'inactive')),
  source TEXT NOT NULL DEFAULT '' CHECK (source IN ('', 'slash_command', 'badge_remove', 'agent_command')),
  created_at_unix_ms INTEGER NOT NULL,
  dispatch_state TEXT NOT NULL DEFAULT 'accepted' CHECK (dispatch_state IN ('prepared', 'accepted')),
  accepted_at_unix_ms INTEGER,
  orchestration_intensity INTEGER NOT NULL DEFAULT 0 CHECK (orchestration_intensity BETWEEN 0 AND 100),
  speed INTEGER NOT NULL DEFAULT 0 CHECK (speed BETWEEN 0 AND 100),
  PRIMARY KEY (workspace_id, agent_session_id, turn_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  CHECK ((activation_id = '' AND revision_id = '' AND revision = 0 AND state = 'inactive' AND source = '') OR
         (activation_id != '' AND revision_id != '' AND revision > 0 AND
          ((state = 'active' AND source IN ('slash_command', 'agent_command')) OR
           (state = 'inactive' AND source IN ('badge_remove', 'agent_command')))))
);

INSERT INTO tutti_mode_turn_snapshots_v5 (
  workspace_id, agent_session_id, turn_id, activation_id, revision_id, revision,
  state, source, created_at_unix_ms, dispatch_state, accepted_at_unix_ms,
  orchestration_intensity, speed
)
SELECT
  workspace_id, agent_session_id, turn_id, activation_id, revision_id, revision,
  state, source, created_at_unix_ms, dispatch_state, accepted_at_unix_ms,
  orchestration_intensity, speed
FROM tutti_mode_turn_snapshots;

DROP TABLE tutti_mode_turn_snapshots;
ALTER TABLE tutti_mode_turn_snapshots_v5 RENAME TO tutti_mode_turn_snapshots;

CREATE INDEX idx_tutti_mode_turn_snapshots_revision
  ON tutti_mode_turn_snapshots(workspace_id, activation_id, revision);

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationTuttiModeAgentCommandSourceV5, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("rebuild Tutti mode activation tables for agent command source: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Tutti mode agent command source migration: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		return fmt.Errorf("restore foreign keys after Tutti mode agent command source migration: %w", err)
	}
	foreignKeysDisabled = false

	rows, err := conn.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return fmt.Errorf("check foreign keys after Tutti mode agent command source migration: %w", err)
	}
	defer rows.Close()
	if rows.Next() {
		var table, parent string
		var rowID sql.NullInt64
		var foreignKeyID int
		if err := rows.Scan(&table, &rowID, &parent, &foreignKeyID); err != nil {
			return fmt.Errorf("scan foreign key violation after Tutti mode agent command source migration: %w", err)
		}
		return fmt.Errorf("tutti mode agent command source migration left foreign key violation: table=%s parent=%s id=%d", table, parent, foreignKeyID)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate foreign key check after Tutti mode agent command source migration: %w", err)
	}
	return nil
}

func tuttiModeColumnExistsTx(ctx context.Context, tx *sql.Tx, tableName, columnName string) (bool, error) {
	var count int
	if err := tx.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM pragma_table_info(?)
WHERE name = ?
`, tableName, columnName).Scan(&count); err != nil {
		return false, fmt.Errorf("inspect %s column %s: %w", tableName, columnName, err)
	}
	return count > 0, nil
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
