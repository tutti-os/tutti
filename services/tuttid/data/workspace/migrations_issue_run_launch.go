package workspace

import (
	"context"
	"fmt"
	"time"
)

func (s *SQLiteStore) applyWorkspaceIssueRunLaunchPayloadV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceIssueRunLaunchPayloadV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace Issue Run launch payload migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_issue_run_launch_intents
ADD COLUMN payload_json TEXT NOT NULL DEFAULT '{}';

INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationWorkspaceIssueRunLaunchPayloadV1, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("migrate workspace Issue Run launch payload: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace Issue Run launch payload migration: %w", err)
	}
	return nil
}
