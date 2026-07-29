package workspace

import (
	"context"
	"fmt"
	"time"
)

func (s *SQLiteStore) applyAgentQuickPromptsV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentQuickPromptsV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	_, err = s.writeDB.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS agent_quick_prompts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version >= 1),
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_quick_prompts_updated
  ON agent_quick_prompts(updated_at_unix_ms DESC, id ASC);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms)
  VALUES (?, ?);
`, schemaMigrationAgentQuickPromptsV1, unixMs(time.Now().UTC()))
	if err != nil {
		return fmt.Errorf("migrate workspace database for agent quick prompts: %w", err)
	}
	return nil
}

func (s *SQLiteStore) applyAgentQuickPromptsV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentQuickPromptsV2)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin agent quick prompt order migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `ALTER TABLE agent_quick_prompts ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`); err != nil {
		return fmt.Errorf("add agent quick prompt sort order: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
UPDATE agent_quick_prompts AS target
SET sort_order = (
  SELECT COUNT(*)
  FROM agent_quick_prompts AS candidate
  WHERE candidate.updated_at_unix_ms > target.updated_at_unix_ms
     OR (
       candidate.updated_at_unix_ms = target.updated_at_unix_ms
       AND candidate.id < target.id
     )
)
`); err != nil {
		return fmt.Errorf("backfill agent quick prompt sort order: %w", err)
	}
	// Keep the v1 updated-time index during the rollout so an older reader can
	// still use its original query plan. Daemon migrations are forward-only;
	// rolling back the database to an older schema is intentionally unsupported.
	if _, err := tx.ExecContext(ctx, `
CREATE INDEX IF NOT EXISTS idx_agent_quick_prompts_order
  ON agent_quick_prompts(sort_order ASC, id ASC)
`); err != nil {
		return fmt.Errorf("index agent quick prompt sort order: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES (?, ?)
`, schemaMigrationAgentQuickPromptsV2, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record agent quick prompt order migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit agent quick prompt order migration: %w", err)
	}
	return nil
}
