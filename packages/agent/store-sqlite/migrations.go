package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// schemaMigrationsTable is this package's own migration ledger, independent
// of any host ledger.
const schemaMigrationsTable = "agent_store_schema_migrations"

// legacySchemaMigrationsTable is the tuttid ledger these migrations lived in
// before the store was extracted. On first Migrate against a database that
// has it, already-applied agent migrations are claimed (copied) into the
// package ledger so they are not replayed.
const legacySchemaMigrationsTable = "tuttid_schema_migrations"

const schemaMigrationLegacyClaimV1 = "agent_store_legacy_claim_v1"

const schemaMigrationWorkspaceAgentActivityV1 = "workspace_agent_activity_v1"
const schemaMigrationWorkspaceAgentActivityV2 = "workspace_agent_activity_v2"
const schemaMigrationWorkspaceAgentActivityV3 = "workspace_agent_activity_v3"
const schemaMigrationWorkspaceAgentActivityV4 = "workspace_agent_activity_v4"
const schemaMigrationWorkspaceAgentActivityV5 = "workspace_agent_activity_v5"
const schemaMigrationWorkspaceAgentActivityV6 = "workspace_agent_activity_v6"
const schemaMigrationWorkspaceAgentActivityV7 = "workspace_agent_activity_v7"
const schemaMigrationWorkspaceAgentActivityV8 = "workspace_agent_activity_v8"
const schemaMigrationWorkspaceAgentActivityV9 = "workspace_agent_activity_v9"
const schemaMigrationWorkspaceAgentActivityV10 = "workspace_agent_activity_v10"
const schemaMigrationWorkspaceAgentActivityRailV1 = "workspace_agent_activity_rail_v1"
const schemaMigrationWorkspaceAgentActivityTurnsV1 = "workspace_agent_activity_turns_v1"
const schemaMigrationWorkspaceAgentActivityInteractionsV2 = "workspace_agent_activity_interactions_v2"
const schemaMigrationWorkspaceAgentActivityMessagesV2 = "workspace_agent_activity_messages_v2"
const schemaMigrationWorkspaceAgentActivityTurnIntegrityV1 = "workspace_agent_activity_turn_integrity_v1"
const schemaMigrationWorkspaceAgentGeneratedFilesRecentTurnsV1 = "workspace_agent_generated_files_recent_turns_v1"
const schemaMigrationWorkspaceAgentSessionMetadataV1 = "workspace_agent_session_metadata_v1"
const schemaMigrationWorkspaceAgentSessionMetadataV2 = "workspace_agent_session_metadata_v2"
const schemaMigrationWorkspaceAgentSessionEntitiesV3 = "workspace_agent_session_entities_v3"
const schemaMigrationWorkspaceAgentEntityInvariantsV1 = "workspace_agent_entity_invariants_v1"
const schemaMigrationWorkspaceAgentRuntimeOperationsV1 = "workspace_agent_runtime_operations_v1"
const schemaMigrationWorkspaceAgentRuntimeOperationsV2 = "workspace_agent_runtime_operations_v2"
const schemaMigrationWorkspaceAgentRuntimeOperationsV3 = "workspace_agent_runtime_operations_v3"
const schemaMigrationWorkspaceAgentSubmitClaimsV1 = "workspace_agent_submit_claims_v1"
const schemaMigrationAgentTargetsV1 = "agent_targets_v1"
const schemaMigrationAgentTargetsV2 = "agent_targets_v2"
const schemaMigrationAgentTargetsV3 = "agent_targets_v3"
const schemaMigrationAgentTargetsV4 = "agent_targets_v4"
const schemaMigrationAgentTargetsV5 = "agent_targets_v5"
const schemaMigrationWorkspaceAgentSessionTitlesV1 = "workspace_agent_session_titles_v1"
const schemaMigrationWorkspaceAgentSessionTitlesV2 = "workspace_agent_session_titles_v2"
const schemaMigrationWorkspaceAgentChildSessionsV1 = "workspace_agent_child_sessions_v1"
const schemaMigrationWorkspaceAgentRootTurnCompletionV1 = "workspace_agent_root_turn_completion_v1"
const schemaMigrationWorkspaceAgentTurnProvenanceV1 = "workspace_agent_turn_provenance_v1"
const schemaMigrationWorkspaceAgentTurnProvenanceV2 = "workspace_agent_turn_provenance_v2"
const schemaMigrationWorkspaceAgentGoalStateV1 = "workspace_agent_goal_state_v1"
const schemaMigrationWorkspaceAgentGoalStateV2 = "workspace_agent_goal_state_v2"
const schemaMigrationWorkspaceAgentGoalStateV3 = "workspace_agent_goal_state_v3"
const schemaMigrationWorkspaceAgentGoalStateV4 = "workspace_agent_goal_state_v4"
const schemaMigrationWorkspaceAgentGoalStateV5 = "workspace_agent_goal_state_v5"
const schemaMigrationWorkspaceAgentGoalStateV6 = "workspace_agent_goal_state_v6"
const schemaMigrationWorkspaceAgentGoalStateV7 = "workspace_agent_goal_state_v7"
const schemaMigrationWorkspaceAgentGoalProvenanceLedgerV1 = "workspace_agent_goal_provenance_ledger_v1"
const schemaMigrationWorkspaceAgentMessageSemanticsV1 = "workspace_agent_message_semantics_v1"
const schemaMigrationWorkspaceAgentDeletedPurgeIndexV1 = "workspace_agent_deleted_purge_index_v1"

// claimableMigrationIDs are the migration IDs that may already be recorded
// in the legacy tuttid ledger; the claim copies exactly these.
var claimableMigrationIDs = []string{
	schemaMigrationWorkspaceAgentActivityV1,
	schemaMigrationWorkspaceAgentActivityV2,
	schemaMigrationWorkspaceAgentActivityV3,
	schemaMigrationWorkspaceAgentActivityV4,
	schemaMigrationWorkspaceAgentActivityV5,
	schemaMigrationWorkspaceAgentActivityV6,
	schemaMigrationWorkspaceAgentActivityRailV1,
	schemaMigrationAgentTargetsV1,
}

// Migrate creates or upgrades the store's tables. It is idempotent and must
// run before any other method. System target seeding and legacy target ID
// reconciliation (per Options) run on every call.
func (s *Store) Migrate(ctx context.Context) error {
	if s == nil || s.db == nil {
		return errors.New("workspace database is not initialized")
	}

	if _, err := s.db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS `+schemaMigrationsTable+` (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);
`); err != nil {
		return fmt.Errorf("create agent store schema migrations table: %w", err)
	}

	if err := s.claimLegacyMigrations(ctx); err != nil {
		return err
	}

	if err := s.applyWorkspaceAgentActivityV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentActivityV2(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentActivityV3(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentActivityV4(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentActivityV5(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentActivityV6(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentActivityV7(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentActivityV8(ctx); err != nil {
		return err
	}
	if err := s.applyAgentTargetsV1(ctx); err != nil {
		return err
	}
	if err := s.applyAgentTargetsV2(ctx); err != nil {
		return err
	}
	if err := s.applyAgentTargetsV3(ctx); err != nil {
		return err
	}
	if err := s.applyAgentTargetsV4(ctx); err != nil {
		return err
	}
	if err := s.applyAgentTargetsV5(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentActivityRailV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentActivityTurnsV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentActivityInteractionsV2(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentActivityMessagesV2(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentActivityTurnIntegrityV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentGeneratedFilesRecentTurnsV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentSessionMetadataV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentSessionMetadataV2(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentSessionEntitiesV3(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentActivityV9(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentActivityV10(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentEntityInvariantsV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentRuntimeOperationsV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentRuntimeOperationsV2(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentRuntimeOperationsV3(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentSubmitClaimsV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentSessionTitlesV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentSessionTitlesV2(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentChildSessionsV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentRootTurnCompletionV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentTurnProvenanceV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentTurnProvenanceV2(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentGoalStateV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentGoalStateV2(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentGoalStateV3(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentGoalStateV4(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentGoalStateV5(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentGoalStateV6(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentGoalStateV7(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentGoalProvenanceLedgerV1(ctx); err != nil {
		return err
	}
	if err := s.applyWorkspaceAgentMessageSemanticsV1(ctx); err != nil {
		return err
	}
	return s.applyWorkspaceAgentDeletedPurgeIndexV1(ctx)
}

// claimLegacyMigrations copies agent-store migration records that were
// applied under the legacy tuttid ledger into the package ledger, exactly
// once, so already-applied migrations are not replayed against upgraded
// databases.
//
// Deliberate compatibility trade-off: because v1 is claimed instead of
// replayed, an upgraded legacy database keeps its original
// workspace_agent_sessions table including the FOREIGN KEY into the host's
// workspaces table. That FK is harmless there (the tuttid host always has
// the workspaces table, and its cascade is redundant with the host's
// explicit ClearSessionsTx call); only databases created fresh by this
// package get the FK-free schema. Rebuilding existing tables just to drop
// the FK is not worth the migration risk.
func (s *Store) claimLegacyMigrations(ctx context.Context) error {
	claimed, err := s.hasMigration(ctx, schemaMigrationLegacyClaimV1)
	if err != nil {
		return err
	}
	if claimed {
		return nil
	}

	legacyExists, err := s.hasTable(ctx, legacySchemaMigrationsTable)
	if err != nil {
		return err
	}
	if legacyExists {
		placeholders := ""
		args := make([]any, 0, len(claimableMigrationIDs))
		for index, id := range claimableMigrationIDs {
			if index > 0 {
				placeholders += ", "
			}
			placeholders += "?"
			args = append(args, id)
		}
		if _, err := s.db.ExecContext(ctx, `
INSERT OR IGNORE INTO `+schemaMigrationsTable+` (id, applied_at_unix_ms)
SELECT id, applied_at_unix_ms
FROM `+legacySchemaMigrationsTable+`
WHERE id IN (`+placeholders+`)
`, args...); err != nil {
			return fmt.Errorf("claim legacy agent store migrations: %w", err)
		}
	}

	return s.recordMigration(ctx, schemaMigrationLegacyClaimV1)
}

func (s *Store) recordMigration(ctx context.Context, migrationID string) error {
	if _, err := s.db.ExecContext(ctx, `
INSERT INTO `+schemaMigrationsTable+` (id, applied_at_unix_ms)
  VALUES (?, ?);
`, migrationID, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record agent store migration %s: %w", migrationID, err)
	}
	return nil
}

func recordMigrationTx(ctx context.Context, tx *sql.Tx, migrationID string) error {
	if _, err := tx.ExecContext(ctx, `
INSERT INTO `+schemaMigrationsTable+` (id, applied_at_unix_ms) VALUES (?, ?)
`, migrationID, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record agent store migration %s: %w", migrationID, err)
	}
	return nil
}

func (s *Store) hasMigration(ctx context.Context, migrationID string) (bool, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT 1
FROM `+schemaMigrationsTable+`
WHERE id = ?
`, migrationID)

	var exists int
	if err := row.Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("check agent store migration %s: %w", migrationID, err)
	}

	return exists == 1, nil
}

func (s *Store) hasTable(ctx context.Context, tableName string) (bool, error) {
	row := s.db.QueryRowContext(ctx, `
SELECT 1
FROM sqlite_master
WHERE type = 'table' AND name = ?
`, tableName)

	var exists int
	if err := row.Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, nil
		}
		return false, fmt.Errorf("check table %s: %w", tableName, err)
	}

	return exists == 1, nil
}

func (s *Store) hasColumn(ctx context.Context, tableName string, columnName string) (bool, error) {
	rows, err := s.db.QueryContext(ctx, fmt.Sprintf("PRAGMA table_info(%s)", tableName))
	if err != nil {
		return false, fmt.Errorf("inspect agent store table %s: %w", tableName, err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			columnID   int
			name       string
			columnType string
			notNull    int
			defaultSQL sql.NullString
			pk         int
		)
		if err := rows.Scan(&columnID, &name, &columnType, &notNull, &defaultSQL, &pk); err != nil {
			return false, fmt.Errorf("scan agent store table info %s: %w", tableName, err)
		}
		if name == columnName {
			return true, nil
		}
	}

	if err := rows.Err(); err != nil {
		return false, fmt.Errorf("iterate agent store table info %s: %w", tableName, err)
	}

	return false, nil
}
