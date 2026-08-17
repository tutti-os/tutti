package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
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

type AgentSessionResourceCleanup struct {
	WorkspaceID      string
	AgentSessionID   string
	EnqueuedAtUnixMS int64
	AttemptCount     int
	LastError        string
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

func (s *SQLiteStore) applyAgentDataMaintenanceV2(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentDataMaintenanceV2)
	if err != nil {
		return err
	}
	if applied {
		return nil
	}
	_, err = s.writeDB.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS agent_session_resource_cleanup_queue (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  enqueued_at_unix_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id)
);
CREATE INDEX IF NOT EXISTS idx_agent_session_resource_cleanup_queue_enqueued
  ON agent_session_resource_cleanup_queue(enqueued_at_unix_ms ASC, workspace_id ASC, agent_session_id ASC);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES (?, ?);
`, schemaMigrationAgentDataMaintenanceV2, unixMs(time.Now().UTC()))
	if err != nil {
		return fmt.Errorf("migrate agent session resource cleanup queue: %w", err)
	}
	return nil
}

// applyAgentDataMaintenanceV3 is the original Workspace-scoped cleanup fence.
// V4 replaces it with the global fence required by the current physical path
// layout while preserving the migration history of databases that ran V3.
func (s *SQLiteStore) applyAgentDataMaintenanceV3(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentDataMaintenanceV3)
	if err != nil || applied {
		return err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin agent session resource cleanup reuse fence migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
CREATE TRIGGER IF NOT EXISTS trg_workspace_agent_sessions_block_pending_resource_cleanup
BEFORE INSERT ON workspace_agent_sessions
WHEN EXISTS (
  SELECT 1
  FROM agent_session_resource_cleanup_queue cleanup
  WHERE cleanup.workspace_id = NEW.workspace_id
    AND cleanup.agent_session_id = NEW.agent_session_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent session resources are pending cleanup');
END;
`); err != nil {
		return fmt.Errorf("create agent session resource cleanup reuse fence: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES (?, ?)
`, schemaMigrationAgentDataMaintenanceV3, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record agent session resource cleanup reuse fence migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit agent session resource cleanup reuse fence migration: %w", err)
	}
	return nil
}

// applyAgentDataMaintenanceV4 prevents a purged Session ID from being reused
// in any Workspace while its runtime root or copied attachments are still
// queued for deletion. Those physical resources are currently keyed only by
// agent_session_id, so the database fence must be global even though canonical
// Session identity includes workspace_id.
func (s *SQLiteStore) applyAgentDataMaintenanceV4(ctx context.Context) error {
	applied, err := s.hasMigration(ctx, schemaMigrationAgentDataMaintenanceV4)
	if err != nil || applied {
		return err
	}
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin global agent session resource cleanup reuse fence migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
DROP TRIGGER IF EXISTS trg_workspace_agent_sessions_block_pending_resource_cleanup;
CREATE TRIGGER trg_workspace_agent_sessions_block_pending_resource_cleanup
BEFORE INSERT ON workspace_agent_sessions
WHEN EXISTS (
  SELECT 1
  FROM agent_session_resource_cleanup_queue cleanup
  WHERE cleanup.agent_session_id = NEW.agent_session_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent session resources are pending cleanup');
END;
`); err != nil {
		return fmt.Errorf("create global agent session resource cleanup reuse fence: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES (?, ?)
`, schemaMigrationAgentDataMaintenanceV4, unixMs(time.Now().UTC())); err != nil {
		return fmt.Errorf("record global agent session resource cleanup reuse fence migration: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit global agent session resource cleanup reuse fence migration: %w", err)
	}
	return nil
}

// AgentSessionIDExists reports whether any canonical Session, live or
// tombstoned, in any Workspace currently uses agentSessionID. Runtime roots and
// copied attachments are keyed only by this ID, so cleanup must use a global
// identity check rather than the canonical (workspace, session) key.
func (s *SQLiteStore) AgentSessionIDExists(ctx context.Context, agentSessionID string) (bool, error) {
	if s == nil || s.readDB == nil {
		return false, errors.New("workspace database is not initialized")
	}
	agentSessionID = strings.TrimSpace(agentSessionID)
	if agentSessionID == "" {
		return false, nil
	}
	var exists bool
	if err := s.readDB.QueryRowContext(ctx, `
SELECT EXISTS (
  SELECT 1
  FROM workspace_agent_sessions
  WHERE agent_session_id = ?
)
`, agentSessionID).Scan(&exists); err != nil {
		return false, fmt.Errorf("check global agent session identity: %w", err)
	}
	return exists, nil
}

// OtherWorkspaceLiveAgentSessionIDExists reports whether a live canonical
// Session outside workspaceID currently shares agentSessionID. The global
// Agent/browser resource releaser is keyed only by Session ID, so recoverable
// deletion must not release it while another Workspace still has a live owner.
func (s *SQLiteStore) OtherWorkspaceLiveAgentSessionIDExists(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) (bool, error) {
	if s == nil || s.readDB == nil {
		return false, errors.New("workspace database is not initialized")
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" {
		return false, nil
	}
	var exists bool
	if err := s.readDB.QueryRowContext(ctx, `
SELECT EXISTS (
  SELECT 1
  FROM workspace_agent_sessions
  WHERE workspace_id <> ?
    AND agent_session_id = ?
    AND deleted_at_unix_ms = 0
)
`, workspaceID, agentSessionID).Scan(&exists); err != nil {
		return false, fmt.Errorf("check other Workspace live agent session identity: %w", err)
	}
	return exists, nil
}

func enqueueAgentSessionResourceCleanupTx(
	ctx context.Context,
	tx *sql.Tx,
	items []AgentSessionResourceCleanup,
) error {
	if tx == nil {
		return errors.New("workspace database transaction is not initialized")
	}
	if len(items) == 0 {
		return nil
	}
	now := unixMs(time.Now().UTC())
	for _, item := range items {
		workspaceID := strings.TrimSpace(item.WorkspaceID)
		agentSessionID := strings.TrimSpace(item.AgentSessionID)
		if workspaceID == "" || agentSessionID == "" {
			return errors.New("agent session resource cleanup requires workspace and session")
		}
		enqueuedAt := item.EnqueuedAtUnixMS
		if enqueuedAt <= 0 {
			enqueuedAt = now
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO agent_session_resource_cleanup_queue (
  workspace_id, agent_session_id, enqueued_at_unix_ms, attempt_count, last_error, updated_at_unix_ms
) VALUES (?, ?, ?, 0, '', ?)
ON CONFLICT(workspace_id, agent_session_id) DO UPDATE SET
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, workspaceID, agentSessionID, enqueuedAt, now); err != nil {
			return fmt.Errorf("enqueue agent session resource cleanup: %w", err)
		}
	}
	return nil
}

func (s *SQLiteStore) ListAgentSessionResourceCleanup(
	ctx context.Context,
	limit int,
) ([]AgentSessionResourceCleanup, error) {
	if s == nil || s.readDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	rows, err := s.readDB.QueryContext(ctx, `
SELECT workspace_id, agent_session_id, enqueued_at_unix_ms, attempt_count, last_error
FROM agent_session_resource_cleanup_queue
ORDER BY enqueued_at_unix_ms ASC, workspace_id ASC, agent_session_id ASC
LIMIT ?
`, limit)
	if err != nil {
		return nil, fmt.Errorf("list agent session resource cleanup: %w", err)
	}
	defer rows.Close()
	items := make([]AgentSessionResourceCleanup, 0)
	for rows.Next() {
		var item AgentSessionResourceCleanup
		if err := rows.Scan(
			&item.WorkspaceID,
			&item.AgentSessionID,
			&item.EnqueuedAtUnixMS,
			&item.AttemptCount,
			&item.LastError,
		); err != nil {
			return nil, fmt.Errorf("scan agent session resource cleanup: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate agent session resource cleanup: %w", err)
	}
	return items, nil
}

func (s *SQLiteStore) CompleteAgentSessionResourceCleanup(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	_, err := s.writeDB.ExecContext(ctx, `
DELETE FROM agent_session_resource_cleanup_queue
WHERE workspace_id = ? AND agent_session_id = ?
`, strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID))
	if err != nil {
		return fmt.Errorf("complete agent session resource cleanup: %w", err)
	}
	return nil
}

func (s *SQLiteStore) FailAgentSessionResourceCleanup(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	cleanupErr string,
) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	cleanupErr = strings.TrimSpace(cleanupErr)
	if len(cleanupErr) > 2000 {
		cleanupErr = cleanupErr[:2000]
	}
	_, err := s.writeDB.ExecContext(ctx, `
UPDATE agent_session_resource_cleanup_queue
SET attempt_count = attempt_count + 1,
    last_error = ?,
    updated_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ?
`, cleanupErr, unixMs(time.Now().UTC()), strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID))
	if err != nil {
		return fmt.Errorf("record agent session resource cleanup failure: %w", err)
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
