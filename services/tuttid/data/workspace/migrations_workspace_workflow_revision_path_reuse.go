package workspace

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// applyWorkspaceWorkflowRevisionPathReuseV3 removes the original document
// path uniqueness rule. Immutable revision identity is revision_id plus its
// per-workflow sequence; multiple intentional revisions may reference the same
// content-addressed Markdown file.
func (s *SQLiteStore) applyWorkspaceWorkflowRevisionPathReuseV3(ctx context.Context) (returnErr error) {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceWorkflowRevisionPathReuseV3)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	conn, err := s.writeDB.Conn(ctx)
	if err != nil {
		return fmt.Errorf("acquire workspace workflow revision migration connection: %w", err)
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "PRAGMA foreign_keys = OFF"); err != nil {
		return fmt.Errorf("disable foreign keys for workspace workflow revision migration: %w", err)
	}
	foreignKeysDisabled := true
	defer func() {
		if !foreignKeysDisabled {
			return
		}
		if _, enableErr := conn.ExecContext(context.Background(), "PRAGMA foreign_keys = ON"); returnErr == nil && enableErr != nil {
			returnErr = fmt.Errorf("restore foreign keys after workspace workflow revision migration: %w", enableErr)
		}
	}()

	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace workflow revision path migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
CREATE TABLE workspace_workflow_plan_revisions_v3 (
  workspace_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  revision_sequence INTEGER NOT NULL CHECK (revision_sequence > 0),
  schema_version TEXT NOT NULL,
  document_path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  produced_by_turn_id TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, workflow_id, revision_id),
  UNIQUE (workspace_id, workflow_id, revision_sequence),
  FOREIGN KEY (workspace_id, workflow_id)
    REFERENCES tutti_mode_plans(workspace_id, workflow_id) ON DELETE CASCADE
);

INSERT INTO workspace_workflow_plan_revisions_v3 (
  workspace_id, workflow_id, revision_id, revision_sequence, schema_version,
  document_path, sha256, produced_by_turn_id, created_at_unix_ms
)
SELECT
  workspace_id, workflow_id, revision_id, revision_sequence, schema_version,
  document_path, sha256, produced_by_turn_id, created_at_unix_ms
FROM workspace_workflow_plan_revisions;

DROP TABLE workspace_workflow_plan_revisions;
ALTER TABLE workspace_workflow_plan_revisions_v3 RENAME TO workspace_workflow_plan_revisions;

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationWorkspaceWorkflowRevisionPathReuseV3, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("rebuild workspace workflow plan revisions for path reuse: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace workflow revision path migration: %w", err)
	}
	if _, err := conn.ExecContext(ctx, "PRAGMA foreign_keys = ON"); err != nil {
		return fmt.Errorf("restore foreign keys after workspace workflow revision migration: %w", err)
	}
	foreignKeysDisabled = false

	rows, err := conn.QueryContext(ctx, "PRAGMA foreign_key_check")
	if err != nil {
		return fmt.Errorf("check foreign keys after workspace workflow revision migration: %w", err)
	}
	defer rows.Close()
	if rows.Next() {
		var table, parent string
		var rowID sql.NullInt64
		var foreignKeyID int
		if err := rows.Scan(&table, &rowID, &parent, &foreignKeyID); err != nil {
			return fmt.Errorf("scan foreign key violation after workspace workflow revision migration: %w", err)
		}
		return fmt.Errorf("workspace workflow revision migration left foreign key violation: table=%s parent=%s id=%d", table, parent, foreignKeyID)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate foreign key check after workspace workflow revision migration: %w", err)
	}
	return nil
}
