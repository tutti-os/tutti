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
ORDER BY sort_order ASC, id ASC
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
	if _, err := tx.ExecContext(ctx, `UPDATE agent_quick_prompts SET sort_order = sort_order + 1`); err != nil {
		return fmt.Errorf("shift agent quick prompt order before create: %w", err)
	}
	_, err = tx.ExecContext(ctx, `
INSERT INTO agent_quick_prompts (
  id, title, content, version, created_at_unix_ms, updated_at_unix_ms, sort_order
) VALUES (?, ?, ?, ?, ?, ?, 0)
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
	var deletedSortOrder int
	if err := tx.QueryRowContext(ctx, `SELECT sort_order FROM agent_quick_prompts WHERE id = ?`, id).Scan(&deletedSortOrder); errors.Is(err, sql.ErrNoRows) {
		return agentquickpromptbiz.ErrNotFound
	} else if err != nil {
		return fmt.Errorf("read deleted agent quick prompt order: %w", err)
	}
	result, err := tx.ExecContext(ctx, `DELETE FROM agent_quick_prompts WHERE id = ? AND version = ?`, id, expectedVersion)
	if err != nil {
		return fmt.Errorf("delete agent quick prompt: %w", err)
	}
	if err := classifyAgentQuickPromptFence(ctx, tx, id, result); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE agent_quick_prompts SET sort_order = sort_order - 1 WHERE sort_order > ?`, deletedSortOrder); err != nil {
		return fmt.Errorf("compact agent quick prompt order after delete: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete agent quick prompt: %w", err)
	}
	return nil
}

func (s *SQLiteStore) MoveAgentQuickPrompt(ctx context.Context, promptID string, beforePromptID *string, expectedVersion int64, updatedAtUnixMS int64) ([]agentquickpromptbiz.Prompt, bool, error) {
	if s == nil || s.writeDB == nil {
		return nil, false, errors.New("workspace database is not initialized")
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return nil, false, fmt.Errorf("begin move agent quick prompt: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	prompts, err := listAgentQuickPromptsTx(ctx, tx)
	if err != nil {
		return nil, false, err
	}
	fromIndex := -1
	for index := range prompts {
		if prompts[index].ID == promptID {
			fromIndex = index
			break
		}
	}
	if fromIndex < 0 {
		return nil, false, agentquickpromptbiz.ErrNotFound
	}
	if prompts[fromIndex].Version != expectedVersion {
		return nil, false, agentquickpromptbiz.ErrVersionConflict
	}
	if beforePromptID != nil && *beforePromptID == promptID {
		if err := tx.Commit(); err != nil {
			return nil, false, fmt.Errorf("commit idempotent agent quick prompt move: %w", err)
		}
		return prompts, false, nil
	}

	moving := prompts[fromIndex]
	prompts = append(prompts[:fromIndex], prompts[fromIndex+1:]...)
	insertIndex := len(prompts)
	if beforePromptID != nil {
		insertIndex = -1
		for index := range prompts {
			if prompts[index].ID == *beforePromptID {
				insertIndex = index
				break
			}
		}
		if insertIndex < 0 {
			return nil, false, agentquickpromptbiz.ErrOrderConflict
		}
	}
	prompts = append(prompts, agentquickpromptbiz.Prompt{})
	copy(prompts[insertIndex+1:], prompts[insertIndex:])
	prompts[insertIndex] = moving
	if insertIndex == fromIndex {
		if err := tx.Commit(); err != nil {
			return nil, false, fmt.Errorf("commit no-op agent quick prompt move: %w", err)
		}
		return prompts, false, nil
	}
	prompts[insertIndex].Version++
	prompts[insertIndex].UpdatedAtUnixMS = updatedAtUnixMS
	for index := range prompts {
		if prompts[index].ID == promptID {
			result, err := tx.ExecContext(ctx, `UPDATE agent_quick_prompts SET sort_order = ?, version = ?, updated_at_unix_ms = ? WHERE id = ? AND version = ?`, index, prompts[index].Version, updatedAtUnixMS, prompts[index].ID, expectedVersion)
			if err != nil {
				return nil, false, fmt.Errorf("rewrite moved agent quick prompt: %w", err)
			}
			if err := classifyAgentQuickPromptFence(ctx, tx, promptID, result); err != nil {
				return nil, false, err
			}
			continue
		}
		if _, err := tx.ExecContext(ctx, `UPDATE agent_quick_prompts SET sort_order = ? WHERE id = ?`, index, prompts[index].ID); err != nil {
			return nil, false, fmt.Errorf("rewrite agent quick prompt order: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, false, fmt.Errorf("commit move agent quick prompt: %w", err)
	}
	return prompts, true, nil
}

func listAgentQuickPromptsTx(ctx context.Context, tx *sql.Tx) ([]agentquickpromptbiz.Prompt, error) {
	rows, err := tx.QueryContext(ctx, `
SELECT id, title, content, version, created_at_unix_ms, updated_at_unix_ms
FROM agent_quick_prompts
ORDER BY sort_order ASC, id ASC
`)
	if err != nil {
		return nil, fmt.Errorf("list agent quick prompts in transaction: %w", err)
	}
	defer rows.Close()
	prompts := make([]agentquickpromptbiz.Prompt, 0)
	for rows.Next() {
		var prompt agentquickpromptbiz.Prompt
		if err := rows.Scan(&prompt.ID, &prompt.Title, &prompt.Content, &prompt.Version, &prompt.CreatedAtUnixMS, &prompt.UpdatedAtUnixMS); err != nil {
			return nil, fmt.Errorf("scan agent quick prompt in transaction: %w", err)
		}
		prompts = append(prompts, prompt)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate agent quick prompts in transaction: %w", err)
	}
	return prompts, nil
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
