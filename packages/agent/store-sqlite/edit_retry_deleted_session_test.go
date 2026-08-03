package storesqlite

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"
)

// TestDeleteSessionClearsEditRetryFencesFromDurableHealth proves deletion owns
// the fence cleanup transaction. A deleted session must neither remain an
// active edit-retry degradation nor leave an executable operation after a DB
// reopen; the analogous cleanup never applies to a live session.
func TestDeleteSessionClearsEditRetryFencesFromDurableHealth(t *testing.T) {
	for _, mode := range []string{"prepared", "blocked", "orphan"} {
		t.Run(mode, func(t *testing.T) {
			store := openTestStore(t, testOptions(&staticProjectPaths{}))
			ctx := context.Background()
			const workspaceID, sessionID = "ws-deleted-edit-retry", "session-deleted-edit-retry"
			var operationID string
			switch mode {
			case "prepared", "blocked":
				seedClaimableEditRetry(t, store, workspaceID, sessionID, "provider", mode, 10)
				operationID = "edit-retry-" + mode
				if mode == "blocked" {
					if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_runtime_operations
SET status='blocked', next_attempt_at_unix_ms=NULL, last_error='recovery_required'
WHERE workspace_id=? AND operation_id=?;
UPDATE workspace_agent_session_history
SET recovery_state='recovery_required', operation_id=?
WHERE workspace_id=? AND agent_session_id=?`, workspaceID, operationID, operationID, workspaceID, sessionID); err != nil {
						t.Fatal(err)
					}
				}
			case "orphan":
				seedTurnTestSession(t, store, workspaceID, sessionID)
				operationID = "orphan-deleted-edit-retry"
				if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_session_history
SET recovery_state='recovery_required', operation_id=?
WHERE workspace_id=? AND agent_session_id=?`, operationID, workspaceID, sessionID); err != nil {
					t.Fatal(err)
				}
			}
			if items, count, _, err := store.ListActiveEditRetryDegradations(ctx, 10); err != nil || count != 1 || items[0].Operation.AgentSessionID != sessionID {
				t.Fatalf("active before delete=%#v count=%d error=%v", items, count, err)
			}
			if removed, err := store.DeleteSession(ctx, workspaceID, sessionID); err != nil || !removed {
				t.Fatalf("DeleteSession() removed=%v error=%v", removed, err)
			}
			assertDeletedEditRetryHealthGone(t, store, workspaceID, sessionID)

			// Close all Store memory and derive health again from the file. This is
			// deliberately not an in-memory projection replay.
			path := sqliteTestDatabasePath(t, store.db)
			if err := store.db.Close(); err != nil {
				t.Fatal(err)
			}
			reopenedDB, err := sql.Open("sqlite", path)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = reopenedDB.Close() })
			reopenedDB.SetMaxOpenConns(1)
			for _, pragma := range []string{"PRAGMA busy_timeout = 5000", "PRAGMA foreign_keys = ON", "PRAGMA journal_mode = WAL"} {
				if _, err := reopenedDB.ExecContext(ctx, pragma); err != nil {
					t.Fatal(err)
				}
			}
			reopened := New(reopenedDB, testOptions(&staticProjectPaths{}))
			if err := reopened.Migrate(ctx); err != nil {
				t.Fatal(err)
			}
			assertDeletedEditRetryHealthGone(t, reopened, workspaceID, sessionID)
		})
	}
}

func assertDeletedEditRetryHealthGone(t *testing.T, store *Store, workspaceID, sessionID string) {
	t.Helper()
	items, count, _, err := store.ListActiveEditRetryDegradations(t.Context(), 10)
	if err != nil || count != 0 || len(items) != 0 {
		t.Fatalf("active health after delete=%#v count=%d error=%v", items, count, err)
	}
	history, found, err := store.GetSessionHistory(t.Context(), workspaceID, sessionID)
	if err != nil || !found || history.RecoveryState != SessionHistoryRecoveryReady || history.OperationID != "" {
		t.Fatalf("deleted session history=%#v found=%v error=%v", history, found, err)
	}
	var operationCount int
	if err := store.db.QueryRowContext(t.Context(), `
SELECT COUNT(*) FROM workspace_agent_runtime_operations
WHERE workspace_id=? AND agent_session_id=? AND kind='edit_retry'`, workspaceID, sessionID).Scan(&operationCount); err != nil || operationCount != 0 {
		t.Fatalf("deleted session edit retry operations=%d error=%v, want none", operationCount, err)
	}
}

func sqliteTestDatabasePath(t *testing.T, db *sql.DB) string {
	t.Helper()
	var sequence int
	var name, path string
	if err := db.QueryRowContext(t.Context(), `PRAGMA database_list`).Scan(&sequence, &name, &path); err != nil || path == "" {
		t.Fatalf("database path sequence=%d name=%q path=%q error=%v", sequence, name, path, err)
	}
	if name != "main" {
		t.Fatalf("database name=%q, want main", name)
	}
	return path
}
