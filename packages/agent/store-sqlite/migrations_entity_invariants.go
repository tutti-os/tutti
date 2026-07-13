package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentEntityInvariantsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentEntityInvariantsV1)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent entity invariants v1: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `
CREATE TRIGGER workspace_agent_sessions_validate_insert
BEFORE INSERT ON workspace_agent_sessions BEGIN
  SELECT CASE WHEN length(trim(NEW.workspace_id)) = 0 OR length(trim(NEW.agent_session_id)) = 0
    OR NOT json_valid(NEW.settings_json) OR json_type(NEW.settings_json) != 'object'
    OR NEW.message_version < 0 OR NEW.last_event_at_unix_ms < 0 OR NEW.started_at_unix_ms < 0
    OR NEW.ended_at_unix_ms < 0 OR NEW.pinned_at_unix_ms < 0 OR NEW.deleted_at_unix_ms < 0
    OR NEW.created_at_unix_ms < 0 OR NEW.updated_at_unix_ms < 0
  THEN RAISE(ABORT, 'invalid workspace agent session entity') END;
END;
CREATE TRIGGER workspace_agent_sessions_validate_update
BEFORE UPDATE ON workspace_agent_sessions BEGIN
  SELECT CASE WHEN length(trim(NEW.workspace_id)) = 0 OR length(trim(NEW.agent_session_id)) = 0
    OR NOT json_valid(NEW.settings_json) OR json_type(NEW.settings_json) != 'object'
    OR NEW.message_version < 0 OR NEW.last_event_at_unix_ms < 0 OR NEW.started_at_unix_ms < 0
    OR NEW.ended_at_unix_ms < 0 OR NEW.pinned_at_unix_ms < 0 OR NEW.deleted_at_unix_ms < 0
    OR NEW.created_at_unix_ms < 0 OR NEW.updated_at_unix_ms < 0
  THEN RAISE(ABORT, 'invalid workspace agent session entity') END;
END;
CREATE TRIGGER workspace_agent_turns_validate_insert
BEFORE INSERT ON workspace_agent_turns BEGIN
  SELECT CASE WHEN length(trim(NEW.workspace_id)) = 0 OR length(trim(NEW.agent_session_id)) = 0 OR length(trim(NEW.turn_id)) = 0
    OR NEW.started_at_unix_ms < 0 OR NEW.created_at_unix_ms < 0 OR NEW.updated_at_unix_ms < 0
    OR (NEW.settled_at_unix_ms IS NOT NULL AND NEW.settled_at_unix_ms < 0)
    OR (NEW.error_json IS NOT NULL AND NOT json_valid(NEW.error_json))
    OR (NEW.file_changes_json IS NOT NULL AND NOT json_valid(NEW.file_changes_json))
    OR (NEW.completed_command_json IS NOT NULL AND NOT json_valid(NEW.completed_command_json))
    OR (NEW.phase = 'settled' AND (NEW.outcome IS NULL OR NEW.settled_at_unix_ms IS NULL))
    OR (NEW.phase != 'settled' AND (NEW.outcome IS NOT NULL OR NEW.settled_at_unix_ms IS NOT NULL))
  THEN RAISE(ABORT, 'invalid workspace agent turn entity') END;
END;
CREATE TRIGGER workspace_agent_turns_validate_update
BEFORE UPDATE ON workspace_agent_turns BEGIN
  SELECT CASE WHEN NEW.started_at_unix_ms < 0 OR NEW.created_at_unix_ms < 0 OR NEW.updated_at_unix_ms < 0
    OR (NEW.settled_at_unix_ms IS NOT NULL AND NEW.settled_at_unix_ms < 0)
    OR (NEW.error_json IS NOT NULL AND NOT json_valid(NEW.error_json))
    OR (NEW.file_changes_json IS NOT NULL AND NOT json_valid(NEW.file_changes_json))
    OR (NEW.completed_command_json IS NOT NULL AND NOT json_valid(NEW.completed_command_json))
    OR (NEW.phase = 'settled' AND (NEW.outcome IS NULL OR NEW.settled_at_unix_ms IS NULL))
    OR (NEW.phase != 'settled' AND (NEW.outcome IS NOT NULL OR NEW.settled_at_unix_ms IS NOT NULL))
  THEN RAISE(ABORT, 'invalid workspace agent turn entity') END;
END;
CREATE TRIGGER workspace_agent_interactions_validate_insert
BEFORE INSERT ON workspace_agent_interactions BEGIN
  SELECT CASE WHEN NOT json_valid(NEW.input_json) OR json_type(NEW.input_json) != 'object'
    OR NOT json_valid(NEW.output_json) OR json_type(NEW.output_json) != 'object'
    OR NOT json_valid(NEW.metadata_json) OR json_type(NEW.metadata_json) != 'object'
    OR NEW.created_at_unix_ms < 0 OR NEW.updated_at_unix_ms < NEW.created_at_unix_ms
  THEN RAISE(ABORT, 'invalid workspace agent interaction entity') END;
END;
CREATE TRIGGER workspace_agent_interactions_validate_update
BEFORE UPDATE ON workspace_agent_interactions BEGIN
  SELECT CASE WHEN NOT json_valid(NEW.input_json) OR json_type(NEW.input_json) != 'object'
    OR NOT json_valid(NEW.output_json) OR json_type(NEW.output_json) != 'object'
    OR NOT json_valid(NEW.metadata_json) OR json_type(NEW.metadata_json) != 'object'
    OR NEW.created_at_unix_ms < 0 OR NEW.updated_at_unix_ms < NEW.created_at_unix_ms
  THEN RAISE(ABORT, 'invalid workspace agent interaction entity') END;
END;
`); err != nil {
		return fmt.Errorf("migrate workspace agent entity invariants v1: %w", err)
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentEntityInvariantsV1); err != nil {
		return err
	}
	return tx.Commit()
}
