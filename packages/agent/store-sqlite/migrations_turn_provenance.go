package storesqlite

import (
	"context"
	"fmt"
)

// applyWorkspaceAgentTurnProvenanceV1 gives every durable Turn an immutable
// business origin. Goal reconciliation uses this field to distinguish
// provider/model work from user-submitted work; turn IDs alone cannot answer
// that question and are not safe cancellation authority.
func (s *Store) applyWorkspaceAgentTurnProvenanceV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentTurnProvenanceV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent turn provenance v1: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	columns := []struct {
		name string
		sql  string
	}{
		{"turn_origin", `ALTER TABLE workspace_agent_turns ADD COLUMN turn_origin TEXT NOT NULL DEFAULT 'legacy_unknown' CHECK (turn_origin IN ('user_prompt','goal_arm','goal_continuation','provider_initiated','legacy_unknown'))`},
		{"source_goal_operation_id", `ALTER TABLE workspace_agent_turns ADD COLUMN source_goal_operation_id TEXT`},
		{"source_goal_revision", `ALTER TABLE workspace_agent_turns ADD COLUMN source_goal_revision INTEGER CHECK (source_goal_revision IS NULL OR source_goal_revision >= 0)`},
		{"source_goal_repair_epoch", `ALTER TABLE workspace_agent_turns ADD COLUMN source_goal_repair_epoch INTEGER CHECK (source_goal_repair_epoch IS NULL OR source_goal_repair_epoch >= 0)`},
	}
	for _, column := range columns {
		hasColumn, err := hasColumnTx(ctx, tx, "workspace_agent_turns", column.name)
		if err != nil {
			return err
		}
		if !hasColumn {
			if _, err := tx.ExecContext(ctx, column.sql); err != nil {
				return fmt.Errorf("add workspace agent turn %s: %w", column.name, err)
			}
		}
	}
	if _, err := tx.ExecContext(ctx, `CREATE INDEX IF NOT EXISTS idx_workspace_agent_turns_goal_origin ON workspace_agent_turns(workspace_id, agent_session_id, turn_origin, phase, updated_at_unix_ms)`); err != nil {
		return fmt.Errorf("index workspace agent turn provenance: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentTurnProvenanceV1); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent turn provenance v1: %w", err)
	}
	committed = true
	return nil
}

// applyWorkspaceAgentTurnProvenanceV2 adds the provider repair generation to
// durable Turn identity for databases that already applied provenance v1.
// A nullable column is intentional: legacy rows remain unclassified rather
// than being assigned a guessed repair generation.
func (s *Store) applyWorkspaceAgentTurnProvenanceV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentTurnProvenanceV2)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent turn provenance v2: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	hasColumn, err := hasColumnTx(ctx, tx, "workspace_agent_turns", "source_goal_repair_epoch")
	if err != nil {
		return err
	}
	if !hasColumn {
		if _, err := tx.ExecContext(ctx, `ALTER TABLE workspace_agent_turns ADD COLUMN source_goal_repair_epoch INTEGER CHECK (source_goal_repair_epoch IS NULL OR source_goal_repair_epoch >= 0)`); err != nil {
			return fmt.Errorf("add workspace agent turn source_goal_repair_epoch: %w", err)
		}
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentTurnProvenanceV2); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent turn provenance v2: %w", err)
	}
	return nil
}
