package storesqlite

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
)

func (s *Store) UpdateSessionPinned(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	pinned bool,
) (Session, bool, error) {
	if s == nil || s.db == nil {
		return Session{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return Session{}, false, nil
	}

	now := unixMs(time.Now().UTC())
	pinnedAtUnixMS := int64(0)
	if pinned {
		pinnedAtUnixMS = now
	}
	result, err := s.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET pinned_at_unix_ms = ?,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, pinnedAtUnixMS, now, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, false, fmt.Errorf("update workspace agent session pinned state: %w", err)
	}
	updated, err := rowsWereAffected(result, "update workspace agent session pinned state")
	if err != nil {
		return Session{}, false, err
	}
	if !updated {
		return Session{}, false, nil
	}
	session, ok, err := s.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, false, err
	}
	return session, ok, nil
}

func (s *Store) UpdateSessionTitle(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	title string,
) (Session, bool, error) {
	if s == nil || s.db == nil {
		return Session{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	title = strings.TrimSpace(title)
	if workspaceID == "" || agentSessionID == "" || title == "" {
		return Session{}, false, nil
	}

	now := unixMs(time.Now().UTC())
	result, err := s.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET title = ?,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, title, now, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, false, fmt.Errorf("update workspace agent session title: %w", err)
	}
	updated, err := rowsWereAffected(result, "update workspace agent session title")
	if err != nil {
		return Session{}, false, err
	}
	if !updated {
		return Session{}, false, nil
	}
	session, ok, err := s.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, false, err
	}
	return session, ok, nil
}
