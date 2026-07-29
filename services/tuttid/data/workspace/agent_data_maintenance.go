package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

const agentDataMaintenanceRowID = "agent-conversations"

const (
	maximumManualCompactionDatabaseBytes = int64(64 << 20)
	minimumManualCompactionFreeBytes     = int64(8 << 20)
	manualCompactionTimeout              = 3 * time.Second
)

type AgentDataMaintenanceState struct {
	LastAutomaticPurgeAtUnixMS int64
}

func (s *SQLiteStore) applyAgentDataMaintenanceV1(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentDataMaintenanceV1)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	_, err = s.writeDB.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS agent_data_maintenance (
  id TEXT PRIMARY KEY,
  last_automatic_purge_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_unix_ms INTEGER NOT NULL
);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES (?, ?);
`, schemaMigrationAgentDataMaintenanceV1, unixMs(time.Now().UTC()))
	if err != nil {
		return fmt.Errorf("migrate agent data maintenance state: %w", err)
	}
	return nil
}

func (s *SQLiteStore) GetAgentDataMaintenanceState(ctx context.Context) (AgentDataMaintenanceState, error) {
	if s == nil || s.readDB == nil {
		return AgentDataMaintenanceState{}, errors.New("workspace database is not initialized")
	}
	var state AgentDataMaintenanceState
	err := s.readDB.QueryRowContext(ctx, `
SELECT last_automatic_purge_at_unix_ms
FROM agent_data_maintenance
WHERE id = ?
`, agentDataMaintenanceRowID).Scan(&state.LastAutomaticPurgeAtUnixMS)
	if errors.Is(err, sql.ErrNoRows) {
		return AgentDataMaintenanceState{}, nil
	}
	if err != nil {
		return AgentDataMaintenanceState{}, fmt.Errorf("get agent data maintenance state: %w", err)
	}
	return state, nil
}

func (s *SQLiteStore) MarkAutomaticAgentDataPurgeCompleted(ctx context.Context, atUnixMS int64) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	_, err := s.writeDB.ExecContext(ctx, `
INSERT INTO agent_data_maintenance (id, last_automatic_purge_at_unix_ms, updated_at_unix_ms)
VALUES (?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  last_automatic_purge_at_unix_ms = excluded.last_automatic_purge_at_unix_ms,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, agentDataMaintenanceRowID, atUnixMS, unixMs(time.Now().UTC()))
	if err != nil {
		return fmt.Errorf("mark automatic agent data purge completed: %w", err)
	}
	return nil
}

// CompactDeletedDataIfSafe performs a best-effort full-database compaction
// only for small databases with substantial free pages. Callers must already
// have established an explicit, idle maintenance window. The tight size and
// time bounds keep this optional manual step out of automatic maintenance.
func (s *SQLiteStore) CompactDeletedDataIfSafe(ctx context.Context) (bool, error) {
	if s == nil || s.writeDB == nil {
		return false, errors.New("workspace database is not initialized")
	}
	var pageCount, freePages, pageSize int64
	if err := s.writeDB.QueryRowContext(ctx, `PRAGMA page_count`).Scan(&pageCount); err != nil {
		return false, fmt.Errorf("read database page count before compaction: %w", err)
	}
	if err := s.writeDB.QueryRowContext(ctx, `PRAGMA freelist_count`).Scan(&freePages); err != nil {
		return false, fmt.Errorf("read database free pages before compaction: %w", err)
	}
	if err := s.writeDB.QueryRowContext(ctx, `PRAGMA page_size`).Scan(&pageSize); err != nil {
		return false, fmt.Errorf("read database page size before compaction: %w", err)
	}
	if pageCount <= 0 || pageSize <= 0 || pageCount > maximumManualCompactionDatabaseBytes/pageSize {
		return false, nil
	}
	databaseBytes := pageCount * pageSize
	freeBytes := freePages * pageSize
	if freeBytes < minimumManualCompactionFreeBytes || freeBytes*4 < databaseBytes {
		return false, nil
	}

	compactCtx, cancel := context.WithTimeout(ctx, manualCompactionTimeout)
	defer cancel()
	if _, err := s.writeDB.ExecContext(compactCtx, `VACUUM`); err != nil {
		return false, fmt.Errorf("compact deleted database pages: %w", err)
	}
	if _, err := s.writeDB.ExecContext(compactCtx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		return false, fmt.Errorf("checkpoint compacted database: %w", err)
	}
	return true, nil
}
