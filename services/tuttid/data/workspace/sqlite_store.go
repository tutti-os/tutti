package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	agentstore "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	tuttitypes "github.com/tutti-os/tutti/services/tuttid/types"
	_ "modernc.org/sqlite"
)

const defaultSQLiteBusyTimeoutMillisec = 5000
const defaultSQLiteReaderConnections = 4

type SQLiteStore struct {
	dbPath      string
	writeDB     *sql.DB
	readDB      *sql.DB
	agentWriter *agentstore.Store
	agentReader *agentstore.Store
}

func OpenSQLiteStore(dbPath string) (*SQLiteStore, error) {
	dbPath = strings.TrimSpace(dbPath)
	if dbPath == "" {
		return nil, errors.New("workspace database path is empty")
	}
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, fmt.Errorf("create tutti database directory: %w", err)
	}

	db, err := sql.Open("sqlite", sqliteWriterDSN(dbPath))
	if err != nil {
		return nil, fmt.Errorf("open tutti database: %w", err)
	}

	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	store := &SQLiteStore{dbPath: dbPath, writeDB: db}
	store.agentWriter = newAgentStore(db)

	if _, err := db.Exec("PRAGMA journal_mode = WAL"); err != nil {
		_ = store.Close()
		return nil, fmt.Errorf("enable sqlite wal mode: %w", err)
	}

	return store, nil
}

func DefaultDBPath() string {
	return tuttitypes.TuttidDBPath()
}

func (s *SQLiteStore) Close() error {
	if s == nil {
		return nil
	}
	var readErr error
	if s.readDB != nil {
		readErr = s.readDB.Close()
	}
	var writeErr error
	if s.writeDB != nil {
		writeErr = s.writeDB.Close()
	}
	return errors.Join(readErr, writeErr)
}

func sqliteWriterDSN(dbPath string) string {
	return sqliteDSN(dbPath, false)
}

func sqliteReaderDSN(dbPath string) string {
	return sqliteDSN(dbPath, true)
}

func sqliteDSN(dbPath string, readOnly bool) string {
	query := url.Values{}
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", defaultSQLiteBusyTimeoutMillisec))
	query.Add("_pragma", "foreign_keys(1)")
	if readOnly {
		query.Set("mode", "ro")
		query.Add("_pragma", "query_only(1)")
	}
	return (&url.URL{Scheme: "file", Path: dbPath, RawQuery: query.Encode()}).String()
}

func (s *SQLiteStore) openReadPool(ctx context.Context) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}
	if s.readDB != nil {
		return nil
	}

	db, err := sql.Open("sqlite", sqliteReaderDSN(s.dbPath))
	if err != nil {
		return fmt.Errorf("open tutti database read pool: %w", err)
	}
	db.SetMaxOpenConns(defaultSQLiteReaderConnections)
	db.SetMaxIdleConns(defaultSQLiteReaderConnections)
	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return fmt.Errorf("ping tutti database read pool: %w", err)
	}

	s.readDB = db
	s.agentReader = newAgentStore(db)
	return nil
}

func (s *SQLiteStore) Create(ctx context.Context, item workspacebiz.Summary) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}

	id := strings.TrimSpace(item.ID)
	name := strings.TrimSpace(item.Name)
	if id == "" || name == "" {
		return errors.New("workspace id and name are required")
	}

	now := unixMs(time.Now().UTC())
	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin create workspace: %w", err)
	}
	defer func() {
		_ = tx.Rollback()
	}()

	_, err = tx.ExecContext(ctx, `
INSERT INTO workspaces (id, name, created_at_unix_ms, updated_at_unix_ms, last_opened_at_unix_ms)
VALUES (?, ?, ?, ?, NULL)
`, id, name, now, now)
	if err != nil {
		return fmt.Errorf("create workspace: %w", err)
	}

	_, err = tx.ExecContext(ctx, `
INSERT INTO workspace_issue_topics (
  topic_id, workspace_id, title, summary, is_default, pinned_at_unix_ms,
  last_activity_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, '', 1, 0, ?, ?, ?)
`, workspaceissues.DefaultTopicID, id, workspaceissues.DefaultTopicID, now, now, now)
	if err != nil {
		return fmt.Errorf("create default workspace issue topic: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit create workspace: %w", err)
	}

	return nil
}

func (s *SQLiteStore) Delete(ctx context.Context, workspaceID string) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}

	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return errors.New("workspace id is required")
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin delete workspace: %w", err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = tx.Rollback()
		}
	}()

	result, err := tx.ExecContext(ctx, `
DELETE FROM workspaces
WHERE id = ?
`, workspaceID)
	if err != nil {
		return fmt.Errorf("delete workspace: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("delete workspace rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrWorkspaceNotFound
	}

	// Agent activity tables no longer carry a foreign key into workspaces on
	// fresh schemas; cascade the deletion explicitly through the agent store
	// inside the same transaction so a failure leaves no orphaned agent rows.
	if _, err := s.agentStore().ClearSessionsTx(ctx, tx, workspaceID); err != nil {
		return fmt.Errorf("clear agent sessions for deleted workspace: %w", err)
	}
	// Older Tutti-mode schemas predate the workspace foreign key on immutable
	// turn snapshots. Keep deletion explicit so upgraded databases cannot retain
	// orphaned reservations.
	if _, err := tx.ExecContext(ctx, `DELETE FROM tutti_mode_turn_snapshots WHERE workspace_id = ?`, workspaceID); err != nil {
		return fmt.Errorf("clear Tutti mode turn snapshots for deleted workspace: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit delete workspace: %w", err)
	}
	committed = true

	return nil
}

func (s *SQLiteStore) Get(ctx context.Context, workspaceID string) (workspacebiz.Summary, error) {
	if s == nil || s.writeDB == nil {
		return workspacebiz.Summary{}, errors.New("workspace database is not initialized")
	}

	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return workspacebiz.Summary{}, errors.New("workspace id is required")
	}

	row := s.readDB.QueryRowContext(ctx, `
SELECT id, name
     , last_opened_at_unix_ms
FROM workspaces
WHERE id = ?
`, workspaceID)

	var item workspacebiz.Summary
	var lastOpenedAt sql.NullInt64
	if err := row.Scan(&item.ID, &item.Name, &lastOpenedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workspacebiz.Summary{}, ErrWorkspaceNotFound
		}
		return workspacebiz.Summary{}, fmt.Errorf("get workspace: %w", err)
	}
	item.LastOpenedAt = nullableUnixMs(lastOpenedAt)

	return item, nil
}

func (s *SQLiteStore) List(ctx context.Context) ([]workspacebiz.Summary, error) {
	if s == nil || s.writeDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}

	rows, err := s.readDB.QueryContext(ctx, `
SELECT id, name, last_opened_at_unix_ms
FROM workspaces
ORDER BY COALESCE(last_opened_at_unix_ms, 0) DESC, updated_at_unix_ms DESC, id ASC`)
	if err != nil {
		return nil, fmt.Errorf("list workspaces: %w", err)
	}
	defer rows.Close()

	items := make([]workspacebiz.Summary, 0)
	for rows.Next() {
		var item workspacebiz.Summary
		var lastOpenedAt sql.NullInt64
		if err := rows.Scan(&item.ID, &item.Name, &lastOpenedAt); err != nil {
			return nil, fmt.Errorf("scan workspace: %w", err)
		}
		item.LastOpenedAt = nullableUnixMs(lastOpenedAt)
		items = append(items, item)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate workspaces: %w", err)
	}

	return items, nil
}

func (s *SQLiteStore) GetStartup(ctx context.Context) (*workspacebiz.Summary, error) {
	if s == nil || s.writeDB == nil {
		return nil, errors.New("workspace database is not initialized")
	}

	row := s.readDB.QueryRowContext(ctx, `
SELECT id, name, last_opened_at_unix_ms
FROM workspaces
WHERE last_opened_at_unix_ms IS NOT NULL
ORDER BY last_opened_at_unix_ms DESC, updated_at_unix_ms DESC, id ASC
LIMIT 1`)

	var item workspacebiz.Summary
	var lastOpenedAt sql.NullInt64
	if err := row.Scan(&item.ID, &item.Name, &lastOpenedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("get startup workspace: %w", err)
	}

	item.LastOpenedAt = nullableUnixMs(lastOpenedAt)
	return &item, nil
}

func (s *SQLiteStore) Update(ctx context.Context, item workspacebiz.Summary) error {
	if s == nil || s.writeDB == nil {
		return errors.New("workspace database is not initialized")
	}

	id := strings.TrimSpace(item.ID)
	name := strings.TrimSpace(item.Name)
	if id == "" || name == "" {
		return errors.New("workspace id and name are required")
	}

	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspaces
SET name = ?, updated_at_unix_ms = ?
WHERE id = ?
`, name, unixMs(time.Now().UTC()), id)
	if err != nil {
		return fmt.Errorf("update workspace: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("update workspace rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return ErrWorkspaceNotFound
	}

	return nil
}

func (s *SQLiteStore) Open(ctx context.Context, workspaceID string) (workspacebiz.Summary, error) {
	if s == nil || s.writeDB == nil {
		return workspacebiz.Summary{}, errors.New("workspace database is not initialized")
	}

	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" {
		return workspacebiz.Summary{}, errors.New("workspace id is required")
	}

	now := unixMs(time.Now().UTC())
	result, err := s.writeDB.ExecContext(ctx, `
UPDATE workspaces
SET last_opened_at_unix_ms = ?, updated_at_unix_ms = ?
WHERE id = ?
`, now, now, workspaceID)
	if err != nil {
		return workspacebiz.Summary{}, fmt.Errorf("open workspace: %w", err)
	}

	rowsAffected, err := result.RowsAffected()
	if err != nil {
		return workspacebiz.Summary{}, fmt.Errorf("open workspace rows affected: %w", err)
	}
	if rowsAffected == 0 {
		return workspacebiz.Summary{}, ErrWorkspaceNotFound
	}

	return s.Get(ctx, workspaceID)
}

func nullableUnixMs(value sql.NullInt64) *time.Time {
	if !value.Valid {
		return nil
	}

	converted := time.UnixMilli(value.Int64).UTC()
	return &converted
}

func unixMs(value time.Time) int64 {
	return value.UnixMilli()
}
