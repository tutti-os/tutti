package storesqlite

import (
	"context"
	"strings"
	"testing"
)

func TestListSessionTurnSummariesPagesStableMetadataOnlyHistory(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	for _, session := range []struct{ workspaceID, sessionID string }{
		{workspaceID: "ws-1", sessionID: "session-1"},
		{workspaceID: "ws-1", sessionID: "session-2"},
		{workspaceID: "ws-2", sessionID: "session-1"},
	} {
		seedTurnTestSession(t, store, session.workspaceID, session.sessionID)
	}

	insertSummaryTestTurn := func(workspaceID, sessionID, turnID string, startedAt, updatedAt int64) {
		t.Helper()
		_, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase, outcome,
  error_json, file_changes_json, completed_command_json,
  started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms,
  turn_origin
) VALUES (?, ?, ?, 'settled', 'completed', '{"message":"not part of the summary"}', '{"files":["not part of the summary"]}', ?, ?, ?, ?, ?, 'user_prompt')
`, workspaceID, sessionID, turnID, "{\"finalAssistantMessageId\":\"final-"+turnID+"\"}", startedAt, startedAt+1, startedAt, updatedAt)
		if err != nil {
			t.Fatalf("insert turn %s/%s/%s: %v", workspaceID, sessionID, turnID, err)
		}
	}

	insertSummaryTestTurn("ws-1", "session-1", "turn-c", 30, 30)
	insertSummaryTestTurn("ws-1", "session-1", "turn-z", 20, 20)
	insertSummaryTestTurn("ws-1", "session-1", "turn-a", 20, 20)
	// A late update must not move an older Turn into the recent-start order.
	insertSummaryTestTurn("ws-1", "session-1", "turn-old", 10, 999)
	insertSummaryTestTurn("ws-1", "session-2", "turn-other-session", 100, 100)
	insertSummaryTestTurn("ws-2", "session-1", "turn-other-workspace", 100, 100)

	first, err := store.ListSessionTurnSummaries(ctx, ListSessionTurnSummariesInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Limit: 2,
	})
	if err != nil {
		t.Fatalf("first page: %v", err)
	}
	assertSummaryTurnIDs(t, first.Turns, "turn-c", "turn-z")
	if !first.HasMore || first.Turns[0].FinalAssistantMessageID != "final-turn-c" || first.Turns[0].Origin != "user_prompt" {
		t.Fatalf("first page = %#v", first)
	}

	second, err := store.ListSessionTurnSummaries(ctx, ListSessionTurnSummariesInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Limit: 2,
		Before: &SessionTurnCursor{StartedAtUnixMS: first.Turns[1].StartedAtUnixMS, TurnID: first.Turns[1].TurnID},
	})
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	assertSummaryTurnIDs(t, second.Turns, "turn-a", "turn-old")
	if second.HasMore {
		t.Fatalf("second page hasMore = true, want false: %#v", second)
	}
}

func TestListSessionTurnSummariesValidatesBoundsAndUsesPagingIndex(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	for _, input := range []ListSessionTurnSummariesInput{
		{WorkspaceID: "ws-1", AgentSessionID: "session-1", Limit: 0},
		{WorkspaceID: "ws-1", AgentSessionID: "session-1", Limit: maxSessionTurnSummaryPageSize + 1},
		{WorkspaceID: "ws-1", AgentSessionID: "session-1", Limit: 1, Before: &SessionTurnCursor{}},
	} {
		if _, err := store.ListSessionTurnSummaries(ctx, input); err == nil {
			t.Fatalf("ListSessionTurnSummaries(%#v) error = nil", input)
		}
	}

	rows, err := store.db.QueryContext(ctx, `EXPLAIN QUERY PLAN`+sessionTurnSummarySelectSQL+`
WHERE workspace_id = ? AND agent_session_id = ?
ORDER BY started_at_unix_ms DESC, turn_id DESC
LIMIT ?
`, "ws-1", "session-1", 4)
	if err != nil {
		t.Fatalf("explain session Turn page: %v", err)
	}
	defer rows.Close()
	var plan strings.Builder
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatalf("scan query plan: %v", err)
		}
		plan.WriteString(detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate query plan: %v", err)
	}
	if !strings.Contains(plan.String(), "idx_workspace_agent_turns_session_started_desc") || strings.Contains(plan.String(), "USE TEMP B-TREE") {
		t.Fatalf("query plan = %q, want paging index without temporary sort", plan.String())
	}
}

func TestSessionTurnPageIndexMigrationRepairsMissingIndex(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.db.ExecContext(ctx, `DROP INDEX idx_workspace_agent_turns_session_started_desc`); err != nil {
		t.Fatalf("drop session Turn page index: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `DELETE FROM agent_store_schema_migrations WHERE id = ?`, schemaMigrationWorkspaceAgentSessionTurnPageIndexV1); err != nil {
		t.Fatalf("reset session Turn page migration: %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(): %v", err)
	}
	var count int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_workspace_agent_turns_session_started_desc'`).Scan(&count); err != nil {
		t.Fatalf("count session Turn page index: %v", err)
	}
	if count != 1 {
		t.Fatalf("session Turn page index count = %d, want 1", count)
	}
}

func assertSummaryTurnIDs(t *testing.T, turns []SessionTurnSummary, want ...string) {
	t.Helper()
	if len(turns) != len(want) {
		t.Fatalf("turns = %#v, want ids %#v", turns, want)
	}
	for index, turn := range turns {
		if turn.TurnID != want[index] {
			t.Fatalf("turn %d = %#v, want id %q", index, turn, want[index])
		}
	}
}
