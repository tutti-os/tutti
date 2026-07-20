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
