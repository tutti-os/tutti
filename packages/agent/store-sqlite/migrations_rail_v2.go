package storesqlite

import (
	"context"
	"fmt"
)

// Rail V2 repairs imported sessions that were written while the project list
// was still empty. V1 can only backfill ordinary conversation rows during
// startup; this version uses the durable imported marker so it does not move
// unrelated conversations and remains safe to replay once.
func (s *Store) applyWorkspaceAgentActivityRailV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityRailV2)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	projects, err := s.listRailProjectPaths(ctx, s.db)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent activity rail v2: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	for _, projectPath := range projects {
		if _, err := s.RepairImportedProjectRailSectionsTx(ctx, tx, projectPath); err != nil {
			return err
		}
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentActivityRailV2); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent activity rail v2: %w", err)
	}
	return nil
}
