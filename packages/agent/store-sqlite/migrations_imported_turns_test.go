package storesqlite

import (
	"context"
	"testing"
)

func TestImportedTurnsMigrationRepairsOnlyImportedTranscriptRows(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-import-migration", AgentSessionID: "imported-session",
		Origin: "WORKSPACE_AGENT_SESSION_ORIGIN_IMPORTED", Provider: "codex",
		RuntimeContext: map[string]any{"imported": true}, OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatalf("ReportSessionState(imported) error = %v", err)
	}
	if _, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID: "ws-import-migration", AgentSessionID: "imported-session",
		Origin: "WORKSPACE_AGENT_SESSION_ORIGIN_IMPORTED", Provider: "codex",
		HistoricalImport: true,
		Messages: []MessageUpdate{
			{MessageID: "imported-orphan", Role: "assistant", Kind: "text", Status: "completed", OccurredAtUnixMS: 11},
			{MessageID: "imported-user-1", Role: "user", Kind: "text", Status: "completed", OccurredAtUnixMS: 20},
			{MessageID: "imported-tool-1", Role: "assistant", Kind: "tool_call", Status: "completed", OccurredAtUnixMS: 30},
			{MessageID: "imported-assistant-1", Role: "assistant", Kind: "text", Status: "completed", OccurredAtUnixMS: 40},
			{MessageID: "imported-user-2", Role: "user", Kind: "text", Status: "completed", OccurredAtUnixMS: 50},
			{MessageID: "imported-assistant-2", Role: "assistant", Kind: "text", Status: "completed", OccurredAtUnixMS: 60},
		},
	}); err != nil {
		t.Fatalf("ReportSessionMessages(imported) error = %v", err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-import-migration", AgentSessionID: "imported-session",
		TurnID: "live-turn", Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 70,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(live continuation) accepted=%v error=%v", accepted, err)
	}
	if _, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID: "ws-import-migration", AgentSessionID: "imported-session",
		Origin: "runtime", Provider: "codex",
		Messages: []MessageUpdate{
			{MessageID: "live-assistant", TurnID: "live-turn", Role: "assistant", Kind: "text", Status: "completed", OccurredAtUnixMS: 71},
			{MessageID: "goal-control:audit", Role: "user", Kind: "session_audit", Status: "completed", OccurredAtUnixMS: 72},
		},
	}); err != nil {
		t.Fatalf("ReportSessionMessages(live continuation) error = %v", err)
	}

	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-import-migration", AgentSessionID: "ordinary-session",
		Origin: "runtime", Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatalf("ReportSessionState(ordinary) error = %v", err)
	}
	if _, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID: "ws-import-migration", AgentSessionID: "ordinary-session",
		Origin: "runtime", Provider: "codex", HistoricalImport: true,
		Messages: []MessageUpdate{
			{MessageID: "imported-ordinary-user", Role: "user", Kind: "text", Status: "completed", OccurredAtUnixMS: 20},
			{MessageID: "imported-ordinary-assistant", Role: "assistant", Kind: "text", Status: "completed", OccurredAtUnixMS: 30},
		},
	}); err != nil {
		t.Fatalf("ReportSessionMessages(ordinary fixture) error = %v", err)
	}

	if _, err := store.db.ExecContext(ctx,
		`DELETE FROM `+schemaMigrationsTable+` WHERE id = ?`,
		schemaMigrationWorkspaceAgentImportedTurnsV1,
	); err != nil {
		t.Fatalf("delete imported-turn migration ledger error = %v", err)
	}
	if err := store.applyWorkspaceAgentImportedTurnsV1(ctx); err != nil {
		t.Fatalf("applyWorkspaceAgentImportedTurnsV1() error = %v", err)
	}

	importedPage, ok, err := store.ListSessionMessages(ctx, ListSessionMessagesInput{
		WorkspaceID: "ws-import-migration", AgentSessionID: "imported-session", Limit: 20,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionMessages(imported) ok=%v error=%v", ok, err)
	}
	wantTurnIDs := map[string]string{
		"imported-orphan":      "",
		"imported-user-1":      "imported-turn-user-1",
		"imported-tool-1":      "imported-turn-user-1",
		"imported-assistant-1": "imported-turn-user-1",
		"imported-user-2":      "imported-turn-user-2",
		"imported-assistant-2": "imported-turn-user-2",
		"live-assistant":       "live-turn",
		"goal-control:audit":   "",
	}
	for _, message := range importedPage.Messages {
		if message.TurnID != wantTurnIDs[message.MessageID] {
			t.Fatalf("message %q turn = %q, want %q", message.MessageID, message.TurnID, wantTurnIDs[message.MessageID])
		}
	}
	for turnID, finalMessageID := range map[string]string{
		"imported-turn-user-1": "imported-assistant-1",
		"imported-turn-user-2": "imported-assistant-2",
	} {
		turn, ok, err := store.GetTurn(ctx, "ws-import-migration", "imported-session", turnID)
		if err != nil || !ok {
			t.Fatalf("GetTurn(%s) ok=%v error=%v", turnID, ok, err)
		}
		if !turn.Backfilled || turn.Origin != TurnOriginUserPrompt ||
			turn.FinalAssistantMessageID != finalMessageID {
			t.Fatalf("migrated turn %s = %#v", turnID, turn)
		}
	}

	ordinaryPage, ok, err := store.ListSessionMessages(ctx, ListSessionMessagesInput{
		WorkspaceID: "ws-import-migration", AgentSessionID: "ordinary-session", Limit: 10,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionMessages(ordinary) ok=%v error=%v", ok, err)
	}
	for _, message := range ordinaryPage.Messages {
		if message.TurnID != "" {
			t.Fatalf("ordinary message %q gained turn %q", message.MessageID, message.TurnID)
		}
	}
	if err := store.applyWorkspaceAgentImportedTurnsV1(ctx); err != nil {
		t.Fatalf("idempotent applyWorkspaceAgentImportedTurnsV1() error = %v", err)
	}
}
