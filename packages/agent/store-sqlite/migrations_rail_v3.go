package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
)

// Rail V3 makes imported sessions with an unregistered project visible in the
// shared conversations section. Without this repair, the exact project rail
// key survives while its section disappears from the current project list.
func (s *Store) applyWorkspaceAgentActivityRailV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityRailV3)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent activity rail v3: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.repairOrphanedImportedProjectRailSectionsTx(ctx, tx); err != nil {
		return err
	}
	if err := recordMigrationTx(ctx, tx, schemaMigrationWorkspaceAgentActivityRailV3); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent activity rail v3: %w", err)
	}
	return nil
}

func (s *Store) repairOrphanedImportedProjectRailSectionsTx(ctx context.Context, tx *sql.Tx) error {
	projectPaths, err := s.listRailProjectPaths(ctx, tx)
	if err != nil {
		return fmt.Errorf("list registered projects for orphaned imported rail repair: %w", err)
	}
	projectPaths = normalizeRailProjectPaths(projectPaths)
	rows, err := tx.QueryContext(ctx, `
SELECT workspace_id, agent_session_id, rail_project_path,
       session_metadata_json, internal_runtime_context_json
FROM workspace_agent_sessions
WHERE rail_section_kind = ?
  AND rail_section_key <> ?
`, RailSectionKindProject, RailSectionKeyConversations)
	if err != nil {
		return fmt.Errorf("list orphaned imported project rails: %w", err)
	}
	defer rows.Close()

	type orphanedSession struct {
		workspaceID    string
		agentSessionID string
	}
	orphaned := make([]orphanedSession, 0)
	for rows.Next() {
		var workspaceID string
		var agentSessionID string
		var projectPath string
		var metadataJSON string
		var internalRuntimeContextJSON string
		if err := rows.Scan(&workspaceID, &agentSessionID, &projectPath, &metadataJSON, &internalRuntimeContextJSON); err != nil {
			return fmt.Errorf("scan orphaned imported project rail: %w", err)
		}
		runtimeContext, err := unmarshalJSONMap(metadataJSON)
		if err != nil {
			return fmt.Errorf("decode orphaned imported project rail: %w", err)
		}
		internalRuntimeContext, err := unmarshalJSONMap(internalRuntimeContextJSON)
		if err != nil {
			return fmt.Errorf("decode orphaned imported project rail context: %w", err)
		}
		for key, value := range internalRuntimeContext {
			runtimeContext[key] = value
		}
		if !runtimeContextBool(runtimeContext["imported"]) || isAgentSessionNoProjectRuntimeContext(runtimeContext) {
			continue
		}
		registered := false
		for _, registeredPath := range projectPaths {
			if AreProjectPathsEqual(registeredPath, projectPath) {
				registered = true
				break
			}
		}
		if !registered {
			orphaned = append(orphaned, orphanedSession{workspaceID: workspaceID, agentSessionID: agentSessionID})
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate orphaned imported project rails: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close orphaned imported project rails: %w", err)
	}

	for _, session := range orphaned {
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET rail_section_kind = ?, rail_project_path = '', rail_section_key = ?
WHERE workspace_id = ?
  AND agent_session_id = ?
  AND rail_section_kind = ?
`, RailSectionKindConversations, RailSectionKeyConversations,
			session.workspaceID, session.agentSessionID, RailSectionKindProject); err != nil {
			return fmt.Errorf("move orphaned imported session %s/%s to conversations: %w", session.workspaceID, session.agentSessionID, err)
		}
	}
	return nil
}
