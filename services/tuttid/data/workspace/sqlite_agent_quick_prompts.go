package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	agentquickpromptbiz "github.com/tutti-os/tutti/services/tuttid/biz/agentquickprompt"
)

func (s *SQLiteStore) ListAgentQuickPrompts(ctx context.Context) ([]agentquickpromptbiz.Prompt, error) {
	if s == nil || s.readDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	rows, err := s.readDB.QueryContext(ctx, `
SELECT id, title, content, version, created_at_unix_ms, updated_at_unix_ms
FROM agent_quick_prompts
ORDER BY updated_at_unix_ms DESC, id ASC
`)
	if err != nil {
		return nil, fmt.Errorf("list agent quick prompts: %w", err)
	}
	defer rows.Close()

	prompts := make([]agentquickpromptbiz.Prompt, 0)
	for rows.Next() {
		var prompt agentquickpromptbiz.Prompt
		if err := rows.Scan(&prompt.ID, &prompt.Title, &prompt.Content, &prompt.Version, &prompt.CreatedAtUnixMS, &prompt.UpdatedAtUnixMS); err != nil {
			return nil, fmt.Errorf("scan agent quick prompt: %w", err)
		}
		prompts = append(prompts, prompt)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate agent quick prompts: %w", err)
	}
	return prompts, nil
}

func (s *SQLiteStore) CountAgentQuickPrompts(ctx context.Context) (int, error) {
	if s == nil || s.readDB == nil {
		return 0, errors.New("workspace database is not initialized")
	}
	var count int
	if err := s.readDB.QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_quick_prompts`).Scan(&count); err != nil {
		return 0, fmt.Errorf("count agent quick prompts: %w", err)
	}
	return count, nil
}

func (s *SQLiteStore) CreateAgentQuickPrompt(ctx context.Context, prompt agentquickpromptbiz.Prompt) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin create agent quick prompt: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var count int
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM agent_quick_prompts`).Scan(&count); err != nil {
		return fmt.Errorf("count agent quick prompts before create: %w", err)
	}
	if count >= agentquickpromptbiz.MaxPrompts {
		return agentquickpromptbiz.ErrLimitExceeded
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO agent_quick_prompts (
  id, title, content, version, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?)
`, prompt.ID, prompt.Title, prompt.Content, prompt.Version, prompt.CreatedAtUnixMS, prompt.UpdatedAtUnixMS)
	if err != nil {
		return fmt.Errorf("create agent quick prompt: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit create agent quick prompt: %w", err)
	}
	return nil
}

func (s *SQLiteStore) UpdateAgentQuickPrompt(ctx context.Context, prompt agentquickpromptbiz.Prompt, expectedVersion int64) (agentquickpromptbiz.Prompt, error) {
	if s == nil || s.writeDB == nil {
		return agentquickpromptbiz.Prompt{}, errors.New("workspace database is not initialized")
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return agentquickpromptbiz.Prompt{}, fmt.Errorf("begin update agent quick prompt: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `
UPDATE agent_quick_prompts
SET title = ?, content = ?, version = ?, updated_at_unix_ms = ?
WHERE id = ? AND version = ?
`, prompt.Title, prompt.Content, prompt.Version, prompt.UpdatedAtUnixMS, prompt.ID, expectedVersion)
	if err != nil {
		return agentquickpromptbiz.Prompt{}, fmt.Errorf("update agent quick prompt: %w", err)
	}
	if err := classifyAgentQuickPromptFence(ctx, tx, prompt.ID, result); err != nil {
		return agentquickpromptbiz.Prompt{}, err
	}
	var stored agentquickpromptbiz.Prompt
	if err := tx.QueryRowContext(ctx, `
SELECT id, title, content, version, created_at_unix_ms, updated_at_unix_ms
FROM agent_quick_prompts WHERE id = ?
`, prompt.ID).Scan(&stored.ID, &stored.Title, &stored.Content, &stored.Version, &stored.CreatedAtUnixMS, &stored.UpdatedAtUnixMS); err != nil {
		return agentquickpromptbiz.Prompt{}, fmt.Errorf("read updated agent quick prompt: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return agentquickpromptbiz.Prompt{}, fmt.Errorf("commit update agent quick prompt: %w", err)
	}
	return stored, nil
}

func (s *SQLiteStore) DeleteAgentQuickPrompt(ctx context.Context, id string, expectedVersion int64) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin delete agent quick prompt: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.ExecContext(ctx, `DELETE FROM agent_quick_prompts WHERE id = ? AND version = ?`, id, expectedVersion)
	if err != nil {
		return fmt.Errorf("delete agent quick prompt: %w", err)
	}
	if err := classifyAgentQuickPromptFence(ctx, tx, id, result); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete agent quick prompt: %w", err)
	}
	return nil
}

func classifyAgentQuickPromptFence(ctx context.Context, tx *sql.Tx, id string, result sql.Result) error {
	affected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("read agent quick prompt mutation result: %w", err)
	}
	if affected > 0 {
		return nil
	}
	var version int64
	err = tx.QueryRowContext(ctx, `SELECT version FROM agent_quick_prompts WHERE id = ?`, id).Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		return agentquickpromptbiz.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("check agent quick prompt mutation fence: %w", err)
	}
	return agentquickpromptbiz.ErrVersionConflict
}
