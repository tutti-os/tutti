package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentMessageSemanticsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentMessageSemanticsV1)
	if err != nil {
		return err
	}
	if err := s.ensureWorkspaceAgentMessageSemanticsColumn(ctx); err != nil {
		return err
	}
	if applied {
		return nil
	}
	return s.recordMigration(ctx, schemaMigrationWorkspaceAgentMessageSemanticsV1)
}

func (s *Store) ensureWorkspaceAgentMessageSemanticsColumn(ctx context.Context) error {
	hasSemantics, err := s.hasColumn(ctx, "workspace_agent_messages", "semantics_json")
	if err != nil {
		return err
	}
	if hasSemantics {
		return nil
	}
	if _, err := s.db.ExecContext(ctx, `ALTER TABLE workspace_agent_messages ADD COLUMN semantics_json TEXT NOT NULL DEFAULT 'null' CHECK (json_valid(semantics_json));`); err != nil {
		return fmt.Errorf("migrate workspace agent message semantics: %w", err)
	}
	return nil
}
