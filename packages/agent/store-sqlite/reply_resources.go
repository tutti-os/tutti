package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// AttachReplyResourceToActiveTurn atomically binds a resource to the session's
// canonical active turn. A concurrent settlement cannot admit a late resource:
// both the active-turn read and insert run in this transaction.
func (s *Store) AttachReplyResourceToActiveTurn(ctx context.Context, input AttachReplyResourceInput) (ReplyResource, bool, error) {
	if s == nil || s.db == nil {
		return ReplyResource{}, false, errors.New("workspace database is not initialized")
	}
	input = normalizeAttachReplyResourceInput(input)
	if input.WorkspaceID == "" || input.AgentSessionID == "" || input.TurnID == "" || input.ResourceID == "" || input.DedupeKey == "" ||
		input.SourceRef == "" || input.DisplayName == "" || input.CreatedAtUnixMS <= 0 || input.SizeBytes < 0 ||
		(input.Kind != ReplyResourceKindLocalFile && input.Kind != ReplyResourceKindExternalArtifact) {
		return ReplyResource{}, false, fmt.Errorf("invalid workspace agent reply resource")
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ReplyResource{}, false, fmt.Errorf("begin workspace agent reply resource attach: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	var turnID, phase string
	err = tx.QueryRowContext(ctx, `
SELECT session.active_turn_id, turn.phase
FROM workspace_agent_sessions AS session
JOIN workspace_agent_turns AS turn
  ON turn.workspace_id = session.workspace_id
 AND turn.agent_session_id = session.agent_session_id
 AND turn.turn_id = session.active_turn_id
WHERE session.workspace_id = ? AND session.agent_session_id = ? AND session.active_turn_id = ?
  AND session.deleted_at_unix_ms = 0 AND session.active_turn_id <> ''
`, input.WorkspaceID, input.AgentSessionID, input.TurnID).Scan(&turnID, &phase)
	if errors.Is(err, sql.ErrNoRows) || strings.TrimSpace(phase) == TurnPhaseSettled {
		return ReplyResource{}, false, ErrNoActiveTurn
	}
	if err != nil {
		return ReplyResource{}, false, fmt.Errorf("read active turn for reply resource: %w", err)
	}

	result, err := tx.ExecContext(ctx, `
INSERT OR IGNORE INTO workspace_agent_turn_reply_resources (
  workspace_id, agent_session_id, turn_id, resource_id, dedupe_key, kind,
  source_ref, content_hash, display_name, media_type, size_bytes, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`, input.WorkspaceID, input.AgentSessionID, turnID, input.ResourceID, input.DedupeKey, input.Kind,
		input.SourceRef, input.ContentHash, input.DisplayName, input.MediaType, input.SizeBytes, input.CreatedAtUnixMS)
	if err != nil {
		return ReplyResource{}, false, fmt.Errorf("attach workspace agent reply resource: %w", err)
	}
	created, err := rowsWereAffected(result, "attach workspace agent reply resource")
	if err != nil {
		return ReplyResource{}, false, err
	}
	resource, err := readReplyResource(ctx, tx.QueryRowContext(ctx, `
SELECT workspace_id, agent_session_id, turn_id, resource_id, dedupe_key, kind,
       source_ref, content_hash, display_name, media_type, size_bytes, created_at_unix_ms
FROM workspace_agent_turn_reply_resources
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ? AND dedupe_key = ?
`, input.WorkspaceID, input.AgentSessionID, turnID, input.DedupeKey))
	if err != nil {
		return ReplyResource{}, false, fmt.Errorf("read attached workspace agent reply resource: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return ReplyResource{}, false, fmt.Errorf("commit workspace agent reply resource attach: %w", err)
	}
	committed = true
	return resource, created, nil
}

func (s *Store) ListTurnReplyResources(ctx context.Context, workspaceID, agentSessionID, turnID string) ([]ReplyResource, error) {
	workspaceID, agentSessionID, turnID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID), strings.TrimSpace(turnID)
	if s == nil || s.db == nil || workspaceID == "" || agentSessionID == "" || turnID == "" {
		return nil, fmt.Errorf("invalid workspace agent reply resource query")
	}
	rows, err := s.db.QueryContext(ctx, `
SELECT workspace_id, agent_session_id, turn_id, resource_id, dedupe_key, kind,
       source_ref, content_hash, display_name, media_type, size_bytes, created_at_unix_ms
FROM workspace_agent_turn_reply_resources
WHERE workspace_id = ? AND agent_session_id = ? AND turn_id = ?
ORDER BY created_at_unix_ms, resource_id
`, workspaceID, agentSessionID, turnID)
	if err != nil {
		return nil, fmt.Errorf("list workspace agent turn reply resources: %w", err)
	}
	defer rows.Close()
	resources := make([]ReplyResource, 0)
	for rows.Next() {
		resource, err := readReplyResource(ctx, rows)
		if err != nil {
			return nil, err
		}
		resources = append(resources, resource)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspace agent turn reply resources: %w", err)
	}
	return resources, nil
}

type replyResourceScanner interface{ Scan(...any) error }

func readReplyResource(_ context.Context, scanner replyResourceScanner) (ReplyResource, error) {
	var resource ReplyResource
	if err := scanner.Scan(&resource.WorkspaceID, &resource.AgentSessionID, &resource.TurnID, &resource.ResourceID,
		&resource.DedupeKey, &resource.Kind, &resource.SourceRef, &resource.ContentHash, &resource.DisplayName,
		&resource.MediaType, &resource.SizeBytes, &resource.CreatedAtUnixMS); err != nil {
		return ReplyResource{}, err
	}
	return resource, nil
}

func normalizeAttachReplyResourceInput(input AttachReplyResourceInput) AttachReplyResourceInput {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.TurnID = strings.TrimSpace(input.TurnID)
	input.ResourceID = strings.TrimSpace(input.ResourceID)
	input.DedupeKey = strings.TrimSpace(input.DedupeKey)
	input.Kind = strings.TrimSpace(input.Kind)
	input.SourceRef = strings.TrimSpace(input.SourceRef)
	input.ContentHash = strings.TrimSpace(input.ContentHash)
	input.DisplayName = strings.TrimSpace(input.DisplayName)
	input.MediaType = strings.TrimSpace(input.MediaType)
	return input
}
