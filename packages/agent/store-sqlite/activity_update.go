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
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Session{}, false, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	result, err := tx.ExecContext(ctx, `
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
		if _, err := s.commitTransaction(ctx, tx, workspaceID, nil); err != nil {
			return Session{}, false, err
		}
		committed = true
		return Session{}, false, nil
	}
	delta, err := s.commitTransaction(ctx, tx, workspaceID, []TransactionMutation{
		transactionMutation(workspaceID, agentSessionID, MutationEntitySession, agentSessionID, "upsert", now),
	})
	if err != nil {
		return Session{}, false, err
	}
	committed = true
	session, ok, err := s.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, false, err
	}
	session.CommitTransactionID = delta.TransactionID
	session.CommitDelta = delta
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
	if workspaceID == "" || agentSessionID == "" {
		return Session{}, false, nil
	}

	now := unixMs(time.Now().UTC())
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Session{}, false, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET title = ?,
    internal_runtime_context_json = json_set(
      internal_runtime_context_json,
      '$.tuttiInitialTitleEstablished',
      json('true')
    ),
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
		if _, err := s.commitTransaction(ctx, tx, workspaceID, nil); err != nil {
			return Session{}, false, err
		}
		committed = true
		return Session{}, false, nil
	}
	delta, err := s.commitTransaction(ctx, tx, workspaceID, []TransactionMutation{
		transactionMutation(workspaceID, agentSessionID, MutationEntitySession, agentSessionID, "upsert", now),
	})
	if err != nil {
		return Session{}, false, err
	}
	committed = true
	session, ok, err := s.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, false, err
	}
	session.CommitTransactionID = delta.TransactionID
	session.CommitDelta = delta
	return session, ok, nil
}

func (s *Store) UpdateSessionSettings(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	model string,
	settings map[string]any,
) (Session, bool, error) {
	if s == nil || s.db == nil {
		return Session{}, false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return Session{}, false, nil
	}
	settingsJSON, err := marshalJSONMap(settings)
	if err != nil {
		return Session{}, false, err
	}

	now := unixMs(time.Now().UTC())
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Session{}, false, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()
	result, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET model = ?,
    settings_json = ?,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ? AND deleted_at_unix_ms = 0
`, strings.TrimSpace(model), settingsJSON, now, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, false, fmt.Errorf("update workspace agent session settings: %w", err)
	}
	updated, err := rowsWereAffected(result, "update workspace agent session settings")
	if err != nil {
		return Session{}, false, err
	}
	if !updated {
		if _, err := s.commitTransaction(ctx, tx, workspaceID, nil); err != nil {
			return Session{}, false, err
		}
		committed = true
		return Session{}, false, nil
	}
	delta, err := s.commitTransaction(ctx, tx, workspaceID, []TransactionMutation{
		transactionMutation(workspaceID, agentSessionID, MutationEntitySession, agentSessionID, "upsert", now),
	})
	if err != nil {
		return Session{}, false, err
	}
	committed = true
	session, ok, err := s.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return Session{}, false, err
	}
	session.CommitTransactionID = delta.TransactionID
	session.CommitDelta = delta
	return session, ok, nil
}
