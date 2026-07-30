package workspace

import (
	"context"
	"fmt"
	"time"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
)

func (s *SQLiteStore) applyAgentTargetsEnableTuttiAgentV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentTargetsEnableTuttiAgentV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin Tutti Agent default enablement migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	now := unixMs(time.Now().UTC())
	if _, err := tx.ExecContext(ctx, `
UPDATE agent_targets
SET enabled = 1, updated_at_ms = ?
WHERE id = ? AND source = ? AND enabled <> 1
`, now, agenttargetbiz.IDLocalTuttiAgent, agenttargetbiz.SourceSystem); err != nil {
		return fmt.Errorf("enable Tutti Agent target by default: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
VALUES (?, ?)
`, schemaMigrationAgentTargetsEnableTuttiAgentV1, now); err != nil {
		return fmt.Errorf("record Tutti Agent default enablement migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit Tutti Agent default enablement migration: %w", err)
	}
	return nil
}
