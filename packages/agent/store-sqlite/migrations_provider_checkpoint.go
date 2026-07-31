package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentProviderCheckpointV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentProviderCheckpointV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent provider checkpoint v1: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	// Compatibility ledger only. The provider_turn_binding_json migration
	// converts and removes any legacy Claude-specific checkpoint columns.
	if err := recordMigrationTx(
		ctx,
		tx,
		schemaMigrationWorkspaceAgentProviderCheckpointV1,
	); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent provider checkpoint v1: %w", err)
	}
	return nil
}
