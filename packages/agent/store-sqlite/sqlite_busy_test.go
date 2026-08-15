package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	_ "modernc.org/sqlite"
)

func TestRetrySQLiteBusyReplaysOperationAfterTransientBusy(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "busy.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)"); err != nil {
		t.Fatalf("create table: %v", err)
	}

	holder, err := db.Conn(context.Background())
	if err != nil {
		t.Fatalf("db.Conn() error = %v", err)
	}
	t.Cleanup(func() { _ = holder.Close() })
	if _, err := holder.ExecContext(context.Background(), "PRAGMA busy_timeout = 0"); err != nil {
		t.Fatalf("disable busy timeout: %v", err)
	}
	if _, err := holder.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatalf("begin holder transaction: %v", err)
	}
	t.Cleanup(func() { _, _ = holder.ExecContext(context.Background(), "ROLLBACK") })

	writer, err := db.Conn(context.Background())
	if err != nil {
		t.Fatalf("writer connection: %v", err)
	}
	t.Cleanup(func() { _ = writer.Close() })
	if _, err := writer.ExecContext(context.Background(), "PRAGMA busy_timeout = 0"); err != nil {
		t.Fatalf("disable writer busy timeout: %v", err)
	}

	attempts := 0
	released := false
	err = retrySQLiteBusy(context.Background(), func(attemptCtx context.Context) error {
		attempts++
		_, err := writer.ExecContext(attemptCtx, "INSERT INTO items(id, value) VALUES (?, ?)", attempts, "ok")
		if err == nil {
			return nil
		}
		if !isSQLiteBusyError(err) {
			return err
		}
		if !released {
			if _, releaseErr := holder.ExecContext(context.Background(), "ROLLBACK"); releaseErr != nil {
				return releaseErr
			}
			released = true
		}
		return err
	})
	if err != nil {
		t.Fatalf("retrySQLiteBusy() error = %v", err)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}

	var count int
	if err := db.QueryRow("SELECT COUNT(*) FROM items").Scan(&count); err != nil {
		t.Fatalf("count rows: %v", err)
	}
	if count != 1 {
		t.Fatalf("row count = %d, want 1", count)
	}
}

func TestReportSessionStateRetriesSQLiteBusyTransaction(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "agent-store.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("store sql.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA busy_timeout = 0"); err != nil {
		t.Fatalf("store busy timeout: %v", err)
	}
	store := New(db, Options{})
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	holderDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("holder sql.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = holderDB.Close() })
	holderDB.SetMaxOpenConns(1)
	holder, err := holderDB.Conn(context.Background())
	if err != nil {
		t.Fatalf("holder Conn() error = %v", err)
	}
	t.Cleanup(func() { _ = holder.Close() })
	if _, err := holder.ExecContext(context.Background(), "PRAGMA busy_timeout = 0"); err != nil {
		t.Fatalf("holder busy timeout: %v", err)
	}
	if _, err := holder.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatalf("holder transaction: %v", err)
	}
	t.Cleanup(func() { _, _ = holder.ExecContext(context.Background(), "ROLLBACK") })

	release := time.AfterFunc(25*time.Millisecond, func() {
		_, _ = holder.ExecContext(context.Background(), "ROLLBACK")
	})
	t.Cleanup(func() { release.Stop() })

	result, err := store.ReportSessionState(context.Background(), SessionStateReport{
		WorkspaceID:      "workspace-1",
		AgentSessionID:   "session-1",
		Provider:         "codex",
		OccurredAtUnixMS: 1,
	})
	if err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if !result.Accepted || result.Session.ID != "session-1" {
		t.Fatalf("ReportSessionState() result = %#v, want accepted session-1", result)
	}
}

func TestReportActivityStateRetriesSQLiteBusyTransaction(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "agent-activity-store.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("store sql.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA busy_timeout = 0"); err != nil {
		t.Fatalf("store busy timeout: %v", err)
	}
	store := New(db, Options{})
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	holderDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("holder sql.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = holderDB.Close() })
	holder, err := holderDB.Conn(context.Background())
	if err != nil {
		t.Fatalf("holder Conn() error = %v", err)
	}
	t.Cleanup(func() { _, _ = holder.ExecContext(context.Background(), "ROLLBACK"); _ = holder.Close() })
	if _, err := holder.ExecContext(context.Background(), "PRAGMA busy_timeout = 0"); err != nil {
		t.Fatalf("holder busy timeout: %v", err)
	}
	if _, err := holder.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatalf("holder transaction: %v", err)
	}

	release := time.AfterFunc(25*time.Millisecond, func() {
		_, _ = holder.ExecContext(context.Background(), "ROLLBACK")
	})
	t.Cleanup(func() { release.Stop() })

	result, err := store.ReportActivityState(context.Background(), ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID:      "workspace-1",
			AgentSessionID:   "session-1",
			Provider:         "codex",
			OccurredAtUnixMS: 1,
		},
	})
	if err != nil {
		t.Fatalf("ReportActivityState() error = %v", err)
	}
	if !result.State.Accepted || result.State.Session.ID != "session-1" {
		t.Fatalf("ReportActivityState() result = %#v, want accepted session-1", result)
	}
}

func TestReportSessionMessagesRetriesSQLiteBusyTransaction(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "agent-message-store.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("store sql.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA busy_timeout = 0"); err != nil {
		t.Fatalf("store busy timeout: %v", err)
	}
	store := New(db, Options{})
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	if _, err := store.ReportSessionState(context.Background(), SessionStateReport{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", Provider: "codex",
		OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	if _, accepted, err := store.RecordTurnTransition(context.Background(), TurnTransition{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 2,
	}); err != nil || !accepted {
		t.Fatalf("seed turn accepted=%v error=%v", accepted, err)
	}

	holderDB, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("holder sql.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = holderDB.Close() })
	holderDB.SetMaxOpenConns(1)
	holder, err := holderDB.Conn(context.Background())
	if err != nil {
		t.Fatalf("holder Conn() error = %v", err)
	}
	t.Cleanup(func() { _, _ = holder.ExecContext(context.Background(), "ROLLBACK"); _ = holder.Close() })
	if _, err := holder.ExecContext(context.Background(), "PRAGMA busy_timeout = 0"); err != nil {
		t.Fatalf("holder busy timeout: %v", err)
	}
	if _, err := holder.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatalf("holder transaction: %v", err)
	}

	release := time.AfterFunc(25*time.Millisecond, func() {
		_, _ = holder.ExecContext(context.Background(), "ROLLBACK")
	})
	t.Cleanup(func() { release.Stop() })

	result, err := store.ReportSessionMessages(context.Background(), SessionMessageReport{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", Provider: "codex",
		Messages: []MessageUpdate{{
			MessageID: "message-1", TurnID: "turn-1", Role: "assistant", Kind: "text",
			Status: "completed", ContentDelta: "done", OccurredAtUnixMS: 3,
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if result.AcceptedCount != 1 {
		t.Fatalf("ReportSessionMessages() result = %#v, want one accepted message", result)
	}
}

func TestRetrySQLiteBusyRespectsContextCancellation(t *testing.T) {
	t.Parallel()

	_, _, writer := openSQLiteBusyRetryFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	attempts := 0
	err := retrySQLiteBusy(ctx, func(attemptCtx context.Context) error {
		attempts++
		_, err := writer.ExecContext(attemptCtx, "INSERT INTO items(id, value) VALUES (?, ?)", attempts, "blocked")
		cancel()
		return err
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("retrySQLiteBusy() error = %v, want context canceled", err)
	}
	if attempts != 1 {
		t.Fatalf("attempts = %d, want 1", attempts)
	}
}

func TestRetrySQLiteBusyReturnsErrorAfterFinalAttempt(t *testing.T) {
	t.Parallel()

	_, _, writer := openSQLiteBusyRetryFixture(t)
	attempts := 0
	err := retrySQLiteBusy(context.Background(), func(attemptCtx context.Context) error {
		attempts++
		_, err := writer.ExecContext(attemptCtx, "INSERT INTO items(id, value) VALUES (?, ?)", attempts, "blocked")
		return err
	})
	if !isSQLiteBusyError(err) {
		t.Fatalf("retrySQLiteBusy() error = %v, want SQLite busy error", err)
	}
	if attempts != sqliteBusyRetryAttempts {
		t.Fatalf("attempts = %d, want %d", attempts, sqliteBusyRetryAttempts)
	}
}

func openSQLiteBusyRetryFixture(t *testing.T) (*sql.DB, *sql.Conn, *sql.Conn) {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "busy-fixture.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("sql.Open() error = %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value TEXT)"); err != nil {
		t.Fatalf("create table: %v", err)
	}

	holder, err := db.Conn(context.Background())
	if err != nil {
		t.Fatalf("holder db.Conn() error = %v", err)
	}
	t.Cleanup(func() { _, _ = holder.ExecContext(context.Background(), "ROLLBACK"); _ = holder.Close() })
	if _, err := holder.ExecContext(context.Background(), "PRAGMA busy_timeout = 0"); err != nil {
		t.Fatalf("holder busy timeout: %v", err)
	}
	if _, err := holder.ExecContext(context.Background(), "BEGIN IMMEDIATE"); err != nil {
		t.Fatalf("holder transaction: %v", err)
	}

	writer, err := db.Conn(context.Background())
	if err != nil {
		t.Fatalf("writer db.Conn() error = %v", err)
	}
	t.Cleanup(func() { _ = writer.Close() })
	if _, err := writer.ExecContext(context.Background(), "PRAGMA busy_timeout = 0"); err != nil {
		t.Fatalf("writer busy timeout: %v", err)
	}
	return db, holder, writer
}

func TestRetrySQLiteBusyPreservesNonBusyErrors(t *testing.T) {
	t.Parallel()

	want := errors.New("not retryable")
	attempts := 0
	if err := retrySQLiteBusy(context.Background(), func(_ context.Context) error {
		attempts++
		return want
	}); !errors.Is(err, want) {
		t.Fatalf("error = %v, want %v", err, want)
	}
	if attempts != 1 {
		t.Fatalf("attempts = %d, want 1", attempts)
	}
}
