package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func (s *SQLiteStore) GetWorkbenchSnapshot(ctx context.Context, workspaceID string) (workspacebiz.WorkbenchSnapshot, error) {
	if s == nil || s.writeDB == nil {
		return workspacebiz.WorkbenchSnapshot{}, errors.New("workspace database is not initialized")
	}

	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return workspacebiz.WorkbenchSnapshot{}, errors.New("workspace id is required")
	}

	if err := ensureWorkspaceExistsOn(ctx, s.readDB, workspaceID); err != nil {
		return workspacebiz.WorkbenchSnapshot{}, err
	}

	row := s.readDB.QueryRowContext(ctx, `
SELECT workspace_id, schema_version, snapshot_json
FROM workspace_workbench_snapshots
WHERE workspace_id = ?
`, workspaceID)

	var snapshot workspacebiz.WorkbenchSnapshot
	var snapshotJSON string
	if err := row.Scan(&snapshot.WorkspaceID, &snapshot.SchemaVersion, &snapshotJSON); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workspacebiz.WorkbenchSnapshot{}, ErrWorkbenchSnapshotNotFound
		}
		return workspacebiz.WorkbenchSnapshot{}, fmt.Errorf("get workspace workbench snapshot: %w", err)
	}

	snapshot.JSON = []byte(snapshotJSON)
	return snapshot, nil
}

func (s *SQLiteStore) PutWorkbenchSnapshot(ctx context.Context, snapshot workspacebiz.WorkbenchSnapshot) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}

	workspaceID := strings.TrimSpace(snapshot.WorkspaceID)
	if workspaceID == "" {
		return errors.New("workspace id is required")
	}
	if snapshot.SchemaVersion <= 0 {
		return errors.New("workbench snapshot schema version is required")
	}
	if len(snapshot.JSON) == 0 {
		return errors.New("workbench snapshot json is required")
	}

	if err := ensureWorkspaceExistsOn(ctx, s.writeDB, workspaceID); err != nil {
		return err
	}

	now := unixMs(time.Now().UTC())
	_, err := s.writeDB.ExecContext(ctx, `
INSERT INTO workspace_workbench_snapshots (
  workspace_id,
  schema_version,
  snapshot_json,
  created_at_unix_ms,
  updated_at_unix_ms
)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(workspace_id) DO UPDATE SET
  schema_version = excluded.schema_version,
  snapshot_json = excluded.snapshot_json,
  updated_at_unix_ms = excluded.updated_at_unix_ms
`, workspaceID, snapshot.SchemaVersion, string(snapshot.JSON), now, now)
	if err != nil {
		return fmt.Errorf("put workspace workbench snapshot: %w", err)
	}

	return nil
}

func ensureWorkspaceExistsOn(ctx context.Context, db *sql.DB, workspaceID string) error {
	row := db.QueryRowContext(ctx, `
SELECT 1
FROM workspaces
WHERE id = ?
`, workspaceID)

	var exists int
	if err := row.Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrWorkspaceNotFound
		}
		return fmt.Errorf("check workspace exists: %w", err)
	}

	return nil
}
