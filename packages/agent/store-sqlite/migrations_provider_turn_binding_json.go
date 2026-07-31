package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentProviderTurnBindingJSONV1(
	ctx context.Context,
) error {
	const migrationID = schemaMigrationWorkspaceAgentProviderTurnBindingJSONV1
	applied, err := s.hasMigration(ctx, migrationID)
	if err != nil || applied {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent provider turn binding json v1: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	exists, err := hasColumnTx(
		ctx,
		tx,
		"workspace_agent_turns",
		"provider_turn_binding_json",
	)
	if err != nil {
		return err
	}
	if !exists {
		if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_turns
ADD COLUMN provider_turn_binding_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(provider_turn_binding_json) AND json_type(provider_turn_binding_json) = 'object')
`); err != nil {
			return fmt.Errorf(
				"add workspace_agent_turns.provider_turn_binding_json: %w",
				err,
			)
		}
	}
	exists, err = hasColumnTx(
		ctx,
		tx,
		"workspace_agent_session_fork_operations",
		"source_provider_turn_binding_json",
	)
	if err != nil {
		return err
	}
	if !exists {
		if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_session_fork_operations
ADD COLUMN source_provider_turn_binding_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(source_provider_turn_binding_json) AND json_type(source_provider_turn_binding_json) = 'object')
`); err != nil {
			return fmt.Errorf(
				"add workspace_agent_session_fork_operations.source_provider_turn_binding_json: %w",
				err,
			)
		}
	}
	hasLegacyTurnCheckpoint, err := hasColumnTx(
		ctx,
		tx,
		"workspace_agent_turns",
		"provider_checkpoint_message_id",
	)
	if err != nil {
		return err
	}
	if hasLegacyTurnCheckpoint {
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_turns
SET provider_turn_binding_json = json_object(
  'schemaVersion', 1,
  'checkpointMessageId', provider_checkpoint_message_id
)
WHERE provider_turn_binding_json = '{}'
  AND TRIM(COALESCE(root_provider_turn_id, '')) <> ''
  AND TRIM(COALESCE(provider_checkpoint_message_id, '')) <> '';
`); err != nil {
			return fmt.Errorf(
				"migrate legacy Turn provider checkpoint into binding json: %w",
				err,
			)
		}
	}
	hasLegacySourceCheckpoint, err := hasColumnTx(
		ctx,
		tx,
		"workspace_agent_session_fork_operations",
		"source_provider_checkpoint_message_id",
	)
	if err != nil {
		return err
	}
	if hasLegacySourceCheckpoint {
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_fork_operations
SET source_provider_turn_binding_json = json_object(
  'schemaVersion', 1,
  'checkpointMessageId', source_provider_checkpoint_message_id
)
WHERE source_provider_turn_binding_json = '{}'
  AND TRIM(COALESCE(source_provider_turn_id, '')) <> ''
  AND TRIM(COALESCE(source_provider_checkpoint_message_id, '')) <> '';
`); err != nil {
			return fmt.Errorf(
				"migrate legacy Fork source checkpoint into binding json: %w",
				err,
			)
		}
	}
	hasLegacyTargetCheckpoint, err := hasColumnTx(
		ctx,
		tx,
		"workspace_agent_session_fork_operations",
		"target_provider_checkpoint_message_id",
	)
	if err != nil {
		return err
	}
	hasTargetBindingsJSON, err := hasColumnTx(
		ctx,
		tx,
		"workspace_agent_session_fork_operations",
		"target_provider_turn_bindings_json",
	)
	if err != nil {
		return err
	}
	hasTargetTurnIDsJSON, err := hasColumnTx(
		ctx,
		tx,
		"workspace_agent_session_fork_operations",
		"target_provider_turn_ids_json",
	)
	if err != nil {
		return err
	}
	if hasLegacyTargetCheckpoint &&
		hasTargetBindingsJSON &&
		hasTargetTurnIDsJSON {
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_session_fork_operations
SET target_provider_turn_bindings_json = json_array(
  json_object(
    'providerTurnId',
    json_extract(target_provider_turn_ids_json, '$[#-1]'),
    'providerTurnBindingJson',
    json_object(
      'schemaVersion', 1,
      'checkpointMessageId', target_provider_checkpoint_message_id
    )
  )
)
WHERE json_array_length(target_provider_turn_ids_json) > 0
  AND json_type(
    target_provider_turn_bindings_json,
    '$[0].providerTurnBindingJson'
  ) IS NULL
  AND TRIM(COALESCE(target_provider_checkpoint_message_id, '')) <> '';
`); err != nil {
			return fmt.Errorf(
				"migrate legacy Fork target checkpoint into binding json: %w",
				err,
			)
		}
	}
	if hasLegacyTurnCheckpoint {
		if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_turns
DROP COLUMN provider_checkpoint_message_id;
`); err != nil {
			return fmt.Errorf(
				"drop legacy Turn provider checkpoint column: %w",
				err,
			)
		}
	}
	if hasLegacySourceCheckpoint {
		if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_session_fork_operations
DROP COLUMN source_provider_checkpoint_message_id;
`); err != nil {
			return fmt.Errorf(
				"drop legacy Fork source checkpoint column: %w",
				err,
			)
		}
	}
	if hasLegacyTargetCheckpoint {
		if _, err := tx.ExecContext(ctx, `
ALTER TABLE workspace_agent_session_fork_operations
DROP COLUMN target_provider_checkpoint_message_id;
`); err != nil {
			return fmt.Errorf(
				"drop legacy Fork target checkpoint column: %w",
				err,
			)
		}
	}
	if err := recordMigrationTx(ctx, tx, migrationID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf(
			"commit workspace agent provider turn binding json v1: %w",
			err,
		)
	}
	return nil
}
