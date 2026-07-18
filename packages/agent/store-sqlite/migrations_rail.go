package storesqlite

import (
	"context"
	"fmt"
)

func (s *Store) applyWorkspaceAgentActivityRailV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityRailV1)
	if err != nil {
		return err
	}

	hasRailSectionKind, err := s.hasColumn(ctx, "workspace_agent_sessions", "rail_section_kind")
	if err != nil {
		return err
	}
	hasRailProjectPath, err := s.hasColumn(ctx, "workspace_agent_sessions", "rail_project_path")
	if err != nil {
		return err
	}
	hasRailSectionKey, err := s.hasColumn(ctx, "workspace_agent_sessions", "rail_section_key")
	if err != nil {
		return err
	}

	if !hasRailSectionKind {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE workspace_agent_sessions ADD COLUMN rail_section_kind TEXT NOT NULL DEFAULT 'conversations';`); err != nil {
			return fmt.Errorf("migrate workspace agent activity rail section kind: %w", err)
		}
	}
	if !hasRailProjectPath {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE workspace_agent_sessions ADD COLUMN rail_project_path TEXT NOT NULL DEFAULT '';`); err != nil {
			return fmt.Errorf("migrate workspace agent activity rail project path: %w", err)
		}
	}
	if !hasRailSectionKey {
		if _, err := s.db.ExecContext(ctx, `ALTER TABLE workspace_agent_sessions ADD COLUMN rail_section_key TEXT NOT NULL DEFAULT 'conversations';`); err != nil {
			return fmt.Errorf("migrate workspace agent activity rail section key: %w", err)
		}
	}

	if _, err := s.db.ExecContext(ctx, `
CREATE INDEX IF NOT EXISTS idx_workspace_agent_sessions_rail_section_page
  ON workspace_agent_sessions(workspace_id, rail_section_key, deleted_at_unix_ms, updated_at_unix_ms DESC, agent_session_id ASC);
`); err != nil {
		return fmt.Errorf("create workspace agent activity rail section index: %w", err)
	}
	if applied {
		return nil
	}

	if err := s.backfillAgentSessionRailSections(ctx); err != nil {
		return err
	}

	return s.recordMigration(ctx, schemaMigrationWorkspaceAgentActivityRailV1)
}

func (s *Store) backfillAgentSessionRailSections(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, `
SELECT workspace_id, agent_session_id, cwd, runtime_context_json
FROM workspace_agent_sessions
WHERE rail_section_key = ?
`, RailSectionKeyConversations)
	if err != nil {
		return fmt.Errorf("list workspace agent sessions for rail section backfill: %w", err)
	}
	defer rows.Close()

	type railCandidate struct {
		WorkspaceID    string
		AgentSessionID string
		CWD            string
		RuntimeContext map[string]any
	}
	candidates := make([]railCandidate, 0)
	for rows.Next() {
		var workspaceID string
		var agentSessionID string
		var cwd string
		var runtimeContextJSON string
		if err := rows.Scan(&workspaceID, &agentSessionID, &cwd, &runtimeContextJSON); err != nil {
			return fmt.Errorf("scan workspace agent session for rail section backfill: %w", err)
		}
		runtimeContext, err := unmarshalJSONMap(runtimeContextJSON)
		if err != nil {
			return fmt.Errorf("decode workspace agent session runtime context for rail section backfill: %w", err)
		}
		candidates = append(candidates, railCandidate{
			WorkspaceID:    workspaceID,
			AgentSessionID: agentSessionID,
			CWD:            cwd,
			RuntimeContext: runtimeContext,
		})
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate workspace agent sessions for rail section backfill: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close workspace agent sessions rail section backfill rows: %w", err)
	}

	type railBackfill struct {
		WorkspaceID    string
		AgentSessionID string
		Section        RailSection
	}
	projectsByWorkspace := make(map[string][]string)
	backfills := make([]railBackfill, 0, len(candidates))
	for _, candidate := range candidates {
		projects, found := projectsByWorkspace[candidate.WorkspaceID]
		if !found {
			projects, err = s.listRailProjectPaths(ctx, s.db, candidate.WorkspaceID)
			if err != nil {
				return err
			}
			projects = normalizeRailProjectPaths(projects)
			projectsByWorkspace[candidate.WorkspaceID] = projects
		}
		section := ClassifyRailSection(candidate.CWD, candidate.RuntimeContext, projects)
		if section.Kind == RailSectionKindProject {
			backfills = append(backfills, railBackfill{
				WorkspaceID:    candidate.WorkspaceID,
				AgentSessionID: candidate.AgentSessionID,
				Section:        section,
			})
		}
	}

	for _, backfill := range backfills {
		_, err := s.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET rail_section_kind = ?,
    rail_project_path = ?,
    rail_section_key = ?
WHERE workspace_id = ?
  AND agent_session_id = ?
  AND rail_section_key = ?
`, backfill.Section.Kind, backfill.Section.ProjectPath, backfill.Section.Key,
			backfill.WorkspaceID, backfill.AgentSessionID, RailSectionKeyConversations)
		if err != nil {
			return fmt.Errorf("backfill workspace agent session rail section for %s/%s: %w", backfill.WorkspaceID, backfill.AgentSessionID, err)
		}
	}
	return nil
}
