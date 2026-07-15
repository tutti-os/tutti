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
       COALESCE(t.name, '')
FROM workspace_agent_sessions AS s
LEFT JOIN agent_targets AS t
  ON t.id = s.agent_target_id
WHERE s.deleted_at_unix_ms = 0
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
	}
	var candidates []sessionTitleBackfill
	for rows.Next() {
		var value sessionTitleBackfill
		if err := rows.Scan(
			&value.workspaceID,
			&value.agentSessionID,
			&value.provider,
			&value.currentTitle,
			&value.targetName,
		); err != nil {
			_ = rows.Close()
			return fmt.Errorf("scan workspace agent session for initial title backfill: %w", err)
		}
		if titletext.IsLegacyPlaceholder(value.currentTitle, value.provider, value.targetName) {
			candidates = append(candidates, value)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return fmt.Errorf("iterate workspace agent sessions for initial title backfill: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close workspace agent sessions for initial title backfill: %w", err)
	}

	updates := make([]sessionTitleBackfill, 0, len(candidates))
	for _, value := range candidates {
		var payloadJSON string
		err := tx.QueryRowContext(ctx, `
SELECT payload_json
FROM workspace_agent_messages
WHERE workspace_id = ?
  AND agent_session_id = ?
  AND deleted_at_unix_ms = 0
  AND LOWER(TRIM(role)) = 'user'
ORDER BY
  CASE
    WHEN occurred_at_unix_ms > 0 THEN occurred_at_unix_ms
    WHEN started_at_unix_ms > 0 THEN started_at_unix_ms
    WHEN completed_at_unix_ms > 0 THEN completed_at_unix_ms
    WHEN created_at_unix_ms > 0 THEN created_at_unix_ms
    ELSE updated_at_unix_ms
  END,
  version,
  id
LIMIT 1
`, value.workspaceID, value.agentSessionID).Scan(&payloadJSON)
		if err != nil && err != sql.ErrNoRows {
			return fmt.Errorf("read first workspace agent user message for initial title backfill: %w", err)
		}
		prompt := ""
		if err == nil {
			prompt = workspaceAgentMessageVisibleText(payloadJSON)
		}
		value.currentTitle = titletext.DeriveInitial("", prompt)
		updates = append(updates, value)
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
	if displayPrompt, ok := payload["displayPrompt"].(string); ok && strings.TrimSpace(displayPrompt) != "" {
		return displayPrompt
	}
	if content, present := payload["content"]; present {
		if text, ok := content.(string); ok {
			return text
		}
		blocks, _ := content.([]any)
		parts := make([]string, 0, len(blocks))
		for _, block := range blocks {
			item, _ := block.(map[string]any)
			blockType, _ := item["type"].(string)
			if strings.TrimSpace(blockType) != "text" {
				continue
			}
			value, _ := item["text"].(string)
			if value = strings.TrimSpace(value); value != "" {
				parts = append(parts, value)
			}
		}
		return strings.Join(parts, "\n")
	}
	if text, ok := payload["text"].(string); ok {
		return text
	}
	return ""
}
