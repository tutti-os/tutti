package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

// RepairImportedProjectRailSections repairs project identity after a project
// is registered. It canonicalizes already-project rows (path/key only) and
// moves imported rows that were persisted in conversations before registration.
// Ordinary conversations stay immutable; the imported marker and explicit
// project path are the reclassification boundary.
func (s *Store) RepairImportedProjectRailSections(
	ctx context.Context,
	projectPath string,
) (int, error) {
	if s == nil || s.db == nil {
		return 0, errors.New("workspace database is not initialized")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin imported project rail repair: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	repaired, err := s.RepairImportedProjectRailSectionsTx(ctx, tx, projectPath)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit imported project rail repair: %w", err)
	}
	return repaired, nil
}

// RepairImportedProjectRailSectionsTx is the transaction participant used by
// workspace user-project registration and rail migrations. The caller owns
// the transaction and commits it together with the project row.
func (s *Store) RepairImportedProjectRailSectionsTx(
	ctx context.Context,
	tx *sql.Tx,
	projectPath string,
) (int, error) {
	if s == nil || tx == nil {
		return 0, errors.New("workspace database transaction is not initialized")
	}
	projectPath = NormalizeProjectPath(projectPath)
	if projectPath == "" {
		return 0, nil
	}
	repaired, err := normalizePersistedProjectRailSectionsTx(ctx, tx)
	if err != nil {
		return 0, err
	}
	projectPaths, err := s.listRailProjectPaths(ctx, tx)
	if err != nil {
		return 0, fmt.Errorf("list registered projects for imported project rail repair: %w", err)
	}
	projectPaths = append(projectPaths, projectPath)
	projectPaths = normalizeRailProjectPaths(projectPaths)
	rows, err := tx.QueryContext(ctx, `
SELECT workspace_id, agent_session_id, cwd, session_metadata_json, internal_runtime_context_json
FROM workspace_agent_sessions
WHERE rail_section_key = ?
  AND rail_section_kind = ?
  AND (
    json_extract(session_metadata_json, '$.imported') = 1
    OR lower(CAST(json_extract(session_metadata_json, '$.imported') AS TEXT)) = 'true'
  )
`, RailSectionKeyConversations, RailSectionKindConversations)
	if err != nil {
		return 0, fmt.Errorf("list imported sessions for project rail repair: %w", err)
	}
	defer rows.Close()

	type candidate struct {
		workspaceID    string
		agentSessionID string
		section        RailSection
	}
	candidates := make([]candidate, 0)
	for rows.Next() {
		var workspaceID string
		var agentSessionID string
		var cwd string
		var metadataJSON string
		var internalRuntimeContextJSON string
		if err := rows.Scan(&workspaceID, &agentSessionID, &cwd, &metadataJSON, &internalRuntimeContextJSON); err != nil {
			return 0, fmt.Errorf("scan imported session for project rail repair: %w", err)
		}
		runtimeContext, err := unmarshalJSONMap(metadataJSON)
		if err != nil {
			return 0, fmt.Errorf("decode imported session for project rail repair: %w", err)
		}
		internalRuntimeContext, err := unmarshalJSONMap(internalRuntimeContextJSON)
		if err != nil {
			return 0, fmt.Errorf("decode imported session internal context for project rail repair: %w", err)
		}
		for key, value := range internalRuntimeContext {
			runtimeContext[key] = value
		}
		if isAgentSessionNoProjectRuntimeContext(runtimeContext) {
			continue
		}
		section := ClassifyRailSection(cwd, runtimeContext, projectPaths)
		if section.Kind != RailSectionKindProject {
			continue
		}
		candidates = append(candidates, candidate{
			workspaceID:    workspaceID,
			agentSessionID: agentSessionID,
			section:        section,
		})
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("iterate imported sessions for project rail repair: %w", err)
	}

	for _, item := range candidates {
		result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET rail_section_kind = ?,
    rail_project_path = ?,
    rail_section_key = ?
WHERE workspace_id = ?
  AND agent_session_id = ?
  AND rail_section_key = ?
  AND rail_section_kind = ?
`, item.section.Kind, item.section.ProjectPath, item.section.Key,
			item.workspaceID, item.agentSessionID,
			RailSectionKeyConversations, RailSectionKindConversations)
		if err != nil {
			return 0, fmt.Errorf("repair imported session rail %s/%s: %w", item.workspaceID, item.agentSessionID, err)
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return 0, fmt.Errorf("count imported session rail repair %s/%s: %w", item.workspaceID, item.agentSessionID, err)
		}
		repaired += int(changed)
	}
	return repaired, nil
}

func normalizePersistedProjectRailSectionsTx(ctx context.Context, tx *sql.Tx) (int, error) {
	rows, err := tx.QueryContext(ctx, `
SELECT workspace_id, agent_session_id, rail_project_path, rail_section_key
FROM workspace_agent_sessions
WHERE rail_section_kind = ?
`, RailSectionKindProject)
	if err != nil {
		return 0, fmt.Errorf("list project sessions for rail identity repair: %w", err)
	}
	defer rows.Close()
	type candidate struct {
		workspaceID    string
		agentSessionID string
		projectPath    string
		sectionKey     string
	}
	candidates := make([]candidate, 0)
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.workspaceID, &item.agentSessionID, &item.projectPath, &item.sectionKey); err != nil {
			return 0, fmt.Errorf("scan project session for rail identity repair: %w", err)
		}
		projectPath := NormalizeProjectPath(item.projectPath)
		if projectPath == "" {
			continue
		}
		key := RailSectionKeyForProject(projectPath)
		if item.projectPath == projectPath && item.sectionKey == key {
			continue
		}
		item.projectPath = projectPath
		item.sectionKey = key
		candidates = append(candidates, item)
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("iterate project sessions for rail identity repair: %w", err)
	}
	repaired := 0
	for _, item := range candidates {
		result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET rail_project_path = ?, rail_section_key = ?
WHERE workspace_id = ? AND agent_session_id = ? AND rail_section_kind = ?
`, item.projectPath, item.sectionKey, item.workspaceID, item.agentSessionID, RailSectionKindProject)
		if err != nil {
			return 0, fmt.Errorf("repair project session rail %s/%s: %w", item.workspaceID, item.agentSessionID, err)
		}
		changed, err := result.RowsAffected()
		if err != nil {
			return 0, fmt.Errorf("count project session rail repair %s/%s: %w", item.workspaceID, item.agentSessionID, err)
		}
		repaired += int(changed)
	}
	return repaired, nil
}
