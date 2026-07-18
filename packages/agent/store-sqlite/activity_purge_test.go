package storesqlite

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"
)

func TestPurgeDeletedSessionsHonorsCutoffAndLeavesActiveRows(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	seedPurgeSession(t, store, "ws-a", "eligible", "/managed/eligible", "eligible payload", 100)
	seedPurgeSession(t, store, "ws-a", "too-new", "/managed/too-new", "new payload", 200)
	seedPurgeSession(t, store, "ws-b", "active", "/managed/active", "active payload", 0)

	result, err := store.PurgeDeletedSessions(ctx, PurgeDeletedSessionsInput{CutoffUnixMS: 150})
	if err != nil {
		t.Fatalf("PurgeDeletedSessions() error = %v", err)
	}
	if len(result.Sessions) != 1 || result.Sessions[0].AgentSessionID != "eligible" || result.RemovedMessages != 1 || result.PayloadBytes <= 0 {
		t.Fatalf("PurgeDeletedSessions() = %#v", result)
	}
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "eligible", 0)
	assertPurgeRowCount(t, store.db, "workspace_agent_messages", "eligible", 0)
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "too-new", 1)
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "active", 1)

	repeat, err := store.PurgeDeletedSessions(ctx, PurgeDeletedSessionsInput{CutoffUnixMS: 150})
	if err != nil || len(repeat.Sessions) != 0 || repeat.RemovedMessages != 0 {
		t.Fatalf("PurgeDeletedSessions(repeat) = %#v, error = %v", repeat, err)
	}
}

func TestDeletedSessionPurgeIndexIsInstalled(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	var indexSQL string
	if err := store.db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_workspace_agent_sessions_deleted_purge'`).Scan(&indexSQL); err != nil {
		t.Fatalf("read purge index: %v", err)
	}
	if !strings.Contains(indexSQL, "deleted_at_unix_ms") || !strings.Contains(indexSQL, "WHERE deleted_at_unix_ms > 0") {
		t.Fatalf("purge index SQL = %q", indexSQL)
	}
	if err := store.db.QueryRow(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_workspace_agent_runtime_operation_events_session'`).Scan(&indexSQL); err != nil {
		t.Fatalf("read runtime operation event session index: %v", err)
	}
	if !strings.Contains(indexSQL, "workspace_id, agent_session_id") {
		t.Fatalf("runtime operation event session index SQL = %q", indexSQL)
	}
}

func TestDeletedSessionPurgeIndexIsRepairedWhenMarkerExists(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	if _, err := store.db.Exec(`DROP INDEX idx_workspace_agent_sessions_deleted_purge`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(`DROP INDEX idx_workspace_agent_runtime_operation_events_session`); err != nil {
		t.Fatal(err)
	}
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() repair error = %v", err)
	}
	var count int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_workspace_agent_sessions_deleted_purge'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("purge index count = %d, want 1", count)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_workspace_agent_runtime_operation_events_session'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("runtime operation event session index count = %d, want 1", count)
	}
}

func TestPurgeDeletedSessionsBoundsBatchByPayloadAndReportsMore(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedPurgeSession(t, store, "ws", "first", "/managed/first", strings.Repeat("a", 128), 100)
	seedPurgeSession(t, store, "ws", "second", "/managed/second", strings.Repeat("b", 128), 101)

	result, err := store.PurgeDeletedSessions(context.Background(), PurgeDeletedSessionsInput{
		CutoffUnixMS: 200, MaxSessions: 10, MaxPayloadBytes: 64,
	})
	if err != nil {
		t.Fatalf("PurgeDeletedSessions() error = %v", err)
	}
	if len(result.Sessions) != 1 || result.Sessions[0].AgentSessionID != "first" || !result.HasMore {
		t.Fatalf("PurgeDeletedSessions() = %#v, want first oversized candidate and more", result)
	}
}

func TestPurgeDeletedSessionsMeasuresUTF8PayloadBytes(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	payload := strings.Repeat("界", 128)
	seedPurgeSession(t, store, "ws", "utf8", "/managed/utf8", payload, 100)

	result, err := store.PurgeDeletedSessions(context.Background(), PurgeDeletedSessionsInput{CutoffUnixMS: 200})
	if err != nil {
		t.Fatalf("PurgeDeletedSessions() error = %v", err)
	}
	if result.PayloadBytes < int64(len(payload)) {
		t.Fatalf("payload bytes = %d, want at least UTF-8 content bytes %d", result.PayloadBytes, len(payload))
	}
}

func TestPurgeDeletedSessionExactTombstoneFencePreservesRows(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedPurgeSession(t, store, "ws", "raced", "/managed/raced", "payload", 100)

	tx, err := store.db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	removedMessages, removed, err := purgeDeletedSessionTx(context.Background(), tx, PurgedSession{
		WorkspaceID: "ws", AgentSessionID: "raced", DeletedAtUnixMS: 99,
	})
	if err != nil || removed || removedMessages != 0 {
		t.Fatalf("purgeDeletedSessionTx() removed=%v messages=%d error=%v", removed, removedMessages, err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "raced", 1)
	assertPurgeRowCount(t, store.db, "workspace_agent_messages", "raced", 1)
}

func TestPurgeDeletedSessionsPreservesAncestorsOfRestoredDescendants(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedChildSessionTree(t, store)
	ctx := context.Background()
	if _, err := store.DeleteSession(ctx, "ws-1", "root"); err != nil {
		t.Fatalf("DeleteSession(root) error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE workspace_agent_sessions SET deleted_at_unix_ms = 100 WHERE workspace_id = 'ws-1'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE workspace_agent_sessions SET deleted_at_unix_ms = 0 WHERE workspace_id = 'ws-1' AND agent_session_id = 'child-2'`); err != nil {
		t.Fatal(err)
	}

	result, err := store.PurgeDeletedSessions(ctx, PurgeDeletedSessionsInput{CutoffUnixMS: 200})
	if err != nil {
		t.Fatalf("PurgeDeletedSessions() error = %v", err)
	}
	if len(result.Sessions) != 0 {
		t.Fatalf("PurgeDeletedSessions() = %#v, want restored descendant tree preserved", result)
	}
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "root", 1)
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "child-1", 1)
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "child-2", 1)
}

func TestPurgeDeletedSessionsRemovesTombstonedTreesFromLeavesToRoot(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedChildSessionTree(t, store)
	ctx := context.Background()
	if _, err := store.DeleteSession(ctx, "ws-1", "root"); err != nil {
		t.Fatalf("DeleteSession(root) error = %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE workspace_agent_sessions SET deleted_at_unix_ms = 100 WHERE workspace_id = 'ws-1'`); err != nil {
		t.Fatal(err)
	}

	removed := 0
	for batch := 0; batch < 4; batch++ {
		result, err := store.PurgeDeletedSessions(ctx, PurgeDeletedSessionsInput{CutoffUnixMS: 200})
		if err != nil {
			t.Fatalf("PurgeDeletedSessions(batch %d) error = %v", batch, err)
		}
		removed += len(result.Sessions)
		if !result.HasMore {
			break
		}
	}
	if removed != 3 {
		t.Fatalf("removed sessions = %d, want 3", removed)
	}
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "root", 0)
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "child-1", 0)
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "child-2", 0)
}

func TestPurgeDeletedSessionsDoesNotStarveDeepTombstonedTrees(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	const sessionCount = 31
	for index := 0; index < sessionCount; index++ {
		sessionID := fmt.Sprintf("session-%02d", index)
		report := SessionStateReport{
			WorkspaceID: "ws-deep", AgentSessionID: sessionID, Provider: "codex",
			Kind: SessionKindRoot, OccurredAtUnixMS: int64(index + 1),
		}
		if index > 0 {
			report.Kind = SessionKindChild
			report.RootAgentSessionID = "session-00"
			report.RootTurnID = "turn-00"
			report.ParentAgentSessionID = fmt.Sprintf("session-%02d", index-1)
			report.ParentTurnID = fmt.Sprintf("turn-%02d", index-1)
			report.ParentToolCallID = fmt.Sprintf("call-%02d", index)
		}
		reportSessionWithTurn(t, store, report, fmt.Sprintf("turn-%02d", index), int64(index+1))
	}
	if _, err := store.db.Exec(`UPDATE workspace_agent_sessions SET deleted_at_unix_ms = 100 WHERE workspace_id = 'ws-deep'`); err != nil {
		t.Fatal(err)
	}

	removed := 0
	for batch := 0; batch < sessionCount+1; batch++ {
		result, err := store.PurgeDeletedSessions(context.Background(), PurgeDeletedSessionsInput{CutoffUnixMS: 200})
		if err != nil {
			t.Fatalf("PurgeDeletedSessions(batch %d) error = %v", batch, err)
		}
		removed += len(result.Sessions)
		if !result.HasMore {
			break
		}
	}
	if removed != sessionCount {
		t.Fatalf("removed sessions = %d, want %d", removed, sessionCount)
	}
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "session-00", 0)
}

func TestPurgeDeletedSessionsDoesNotLetBlockedAncestorsStarveIndependentRows(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	for index := 0; index < 30; index++ {
		rootID := fmt.Sprintf("blocked-root-%02d", index)
		rootTurnID := fmt.Sprintf("blocked-root-turn-%02d", index)
		reportSessionWithTurn(t, store, SessionStateReport{
			WorkspaceID: "ws-blocked", AgentSessionID: rootID, Kind: SessionKindRoot,
			Provider: "codex", OccurredAtUnixMS: int64(index + 1),
		}, rootTurnID, int64(index+1))
		reportSessionWithTurn(t, store, SessionStateReport{
			WorkspaceID: "ws-blocked", AgentSessionID: fmt.Sprintf("live-child-%02d", index), Kind: SessionKindChild,
			RootAgentSessionID: rootID, RootTurnID: rootTurnID,
			ParentAgentSessionID: rootID, ParentTurnID: rootTurnID, ParentToolCallID: fmt.Sprintf("call-%02d", index),
			Provider: "codex", OccurredAtUnixMS: int64(index + 100),
		}, fmt.Sprintf("live-child-turn-%02d", index), int64(index+100))
	}
	if _, err := store.db.Exec(`UPDATE workspace_agent_sessions SET deleted_at_unix_ms = 100 WHERE workspace_id = 'ws-blocked' AND agent_session_id LIKE 'blocked-root-%'`); err != nil {
		t.Fatal(err)
	}
	seedPurgeSession(t, store, "ws-independent", "independent", "/managed/independent", "payload", 100)

	result, err := store.PurgeDeletedSessions(context.Background(), PurgeDeletedSessionsInput{CutoffUnixMS: 200})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Sessions) != 1 || result.Sessions[0].AgentSessionID != "independent" {
		t.Fatalf("PurgeDeletedSessions() = %#v, want independent row", result)
	}
	assertPurgeRowCount(t, store.db, "workspace_agent_sessions", "independent", 0)
}

func seedPurgeSession(t *testing.T, store *Store, workspaceID, sessionID, cwd, payload string, deletedAt int64) {
	t.Helper()
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: workspaceID, AgentSessionID: sessionID, Provider: "codex", Cwd: cwd, OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatalf("ReportSessionState(%s) error = %v", sessionID, err)
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, turn_id, role, kind,
  status, semantics_json, payload_json, deleted_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, 1, NULL, 'assistant', 'text', 'completed', 'null', json_object('text', ?), ?, 1, 1)
`, workspaceID, sessionID, "message-"+sessionID, payload, deletedAt); err != nil {
		t.Fatalf("insert message for %s: %v", sessionID, err)
	}
	if deletedAt > 0 {
		if _, err := store.db.ExecContext(ctx, `UPDATE workspace_agent_sessions SET deleted_at_unix_ms = ? WHERE workspace_id = ? AND agent_session_id = ?`, deletedAt, workspaceID, sessionID); err != nil {
			t.Fatalf("tombstone %s: %v", sessionID, err)
		}
	}
}

func assertPurgeRowCount(t *testing.T, db *sql.DB, table, sessionID string, want int) {
	t.Helper()
	var got int
	query := `SELECT COUNT(*) FROM ` + table + ` WHERE agent_session_id = ?`
	if err := db.QueryRow(query, sessionID).Scan(&got); err != nil {
		t.Fatalf("count %s/%s: %v", table, sessionID, err)
	}
	if got != want {
		t.Fatalf("%s/%s count = %d, want %d", table, sessionID, got, want)
	}
}
