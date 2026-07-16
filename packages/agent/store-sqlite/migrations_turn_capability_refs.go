package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentTurnCapabilityRefsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentTurnCapabilityRefsV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent turn capability refs v1: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	hasColumn, err := hasColumnTx(ctx, tx, "workspace_agent_turns", "capability_refs_json")
	if err != nil {
		return err
	}
	if !hasColumn {
		if _, err := tx.ExecContext(ctx, `ALTER TABLE workspace_agent_turns ADD COLUMN capability_refs_json TEXT NOT NULL DEFAULT '[]'`); err != nil {
			return fmt.Errorf("add workspace agent turn capability refs: %w", err)
		}
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentTurnCapabilityRefsV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent turn capability refs v1: %w", err)
	}
	return nil
}
