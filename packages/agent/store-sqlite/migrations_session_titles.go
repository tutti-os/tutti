package storesqlite

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/tutti-os/tutti/packages/agent/daemon/titletext"
)

func (s *Store) applyWorkspaceAgentSessionTitlesV1(ctx context.Context) error {
	const migrationID = schemaMigrationWorkspaceAgentSessionTitlesV1
	applied, err := s.hasMigration(ctx, migrationID)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent session title canonicalization: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	rows, err := tx.QueryContext(ctx, `
SELECT workspace_id, agent_session_id, title
FROM workspace_agent_sessions
WHERE title != ''
`)
	if err != nil {
		return fmt.Errorf("list workspace agent session titles for canonicalization: %w", err)
	}
	type sessionTitle struct {
		workspaceID    string
		agentSessionID string
		title          string
	}
	var updates []sessionTitle
	for rows.Next() {
		var value sessionTitle
		if err := rows.Scan(&value.workspaceID, &value.agentSessionID, &value.title); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan workspace agent session title for canonicalization: %w", err)
		}
		canonical := titletext.Normalize(value.title)
		if canonical != value.title {
			value.title = canonical
			updates = append(updates, value)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("iterate workspace agent session titles for canonicalization: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close workspace agent session titles for canonicalization: %w", err)
	}

	for _, update := range updates {
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET title = ?
WHERE workspace_id = ? AND agent_session_id = ?
`, update.title, update.workspaceID, update.agentSessionID); err != nil {
			return fmt.Errorf("canonicalize workspace agent session title: %w", err)
		}
	}
	if err := recordMigrationTx(ctx, tx, migrationID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent session title canonicalization: %w", err)
	}
	committed = true
	return nil
}

func (s *Store) applyWorkspaceAgentSessionTitlesV2(ctx context.Context) error {
	const migrationID = schemaMigrationWorkspaceAgentSessionTitlesV2
	applied, err := s.hasMigration(ctx, migrationID)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin workspace agent initial title backfill: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	rows, err := tx.QueryContext(ctx, `
SELECT s.workspace_id, s.agent_session_id, s.provider, s.title,
       COALESCE(t.name, ''), m.id, m.payload_json
FROM workspace_agent_sessions AS s
LEFT JOIN workspace_agent_messages AS m
  ON m.workspace_id = s.workspace_id
 AND m.agent_session_id = s.agent_session_id
 AND m.deleted_at_unix_ms = 0
 AND LOWER(TRIM(m.role)) = 'user'
LEFT JOIN agent_targets AS t
  ON t.id = s.agent_target_id
WHERE s.deleted_at_unix_ms = 0
ORDER BY s.workspace_id, s.agent_session_id,
  CASE
    WHEN m.occurred_at_unix_ms > 0 THEN m.occurred_at_unix_ms
    WHEN m.started_at_unix_ms > 0 THEN m.started_at_unix_ms
    WHEN m.completed_at_unix_ms > 0 THEN m.completed_at_unix_ms
    WHEN m.created_at_unix_ms > 0 THEN m.created_at_unix_ms
    ELSE m.updated_at_unix_ms
  END,
  m.version,
  m.id
`)
	if err != nil {
		return fmt.Errorf("list workspace agent sessions for initial title backfill: %w", err)
	}
	type sessionTitleBackfill struct {
		workspaceID    string
		agentSessionID string
		provider       string
		currentTitle   string
		targetName     string
		messageID      sql.NullInt64
		payloadJSON    sql.NullString
	}
	seen := make(map[string]struct{})
	var updates []sessionTitleBackfill
	for rows.Next() {
		var value sessionTitleBackfill
		if err := rows.Scan(
			&value.workspaceID,
			&value.agentSessionID,
			&value.provider,
			&value.currentTitle,
			&value.targetName,
			&value.messageID,
			&value.payloadJSON,
		); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan workspace agent session for initial title backfill: %w", err)
		}
		key := value.workspaceID + "\x00" + value.agentSessionID
		if _, ok := seen[key]; ok {
			continue
		}
		if !titletext.IsLegacyPlaceholder(value.currentTitle, value.provider, value.targetName) {
			seen[key] = struct{}{}
			continue
		}
		prompt := ""
		if value.messageID.Valid && value.payloadJSON.Valid {
			prompt = workspaceAgentMessageVisibleText(value.payloadJSON.String)
		}
		value.currentTitle = titletext.DeriveInitial("", prompt)
		seen[key] = struct{}{}
		updates = append(updates, value)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("iterate workspace agent sessions for initial title backfill: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close workspace agent sessions for initial title backfill: %w", err)
	}

	for _, update := range updates {
		if _, err := tx.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET title = ?
WHERE workspace_id = ? AND agent_session_id = ?
`, update.currentTitle, update.workspaceID, update.agentSessionID); err != nil {
			return fmt.Errorf("backfill workspace agent initial session title: %w", err)
		}
	}
	if err := recordMigrationTx(ctx, tx, migrationID); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit workspace agent initial title backfill: %w", err)
	}
	committed = true
	return nil
}

func workspaceAgentMessageVisibleText(payloadJSON string) string {
	var payload map[string]any
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		return ""
	}
	for _, key := range []string{"displayPrompt", "text", "content"} {
		if value, ok := payload[key].(string); ok && strings.TrimSpace(value) != "" {
			return value
		}
	}
	blocks, _ := payload["content"].([]any)
	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		item, _ := block.(map[string]any)
		value, _ := item["text"].(string)
		if value = strings.TrimSpace(value); value != "" {
			parts = append(parts, value)
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, "\n")
	}
	return ""
}
