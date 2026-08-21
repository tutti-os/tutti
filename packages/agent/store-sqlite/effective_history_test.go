package storesqlite

import (
	"context"
	"errors"
	"testing"
)

func TestEffectiveHistoryMigrationRunsAfterImportedTurnsAndBackfills(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	var importedRowID, historyRowID, metadataRowID int64
	if err := store.db.QueryRowContext(ctx, `
SELECT rowid FROM agent_store_schema_migrations WHERE id = ?
`, schemaMigrationWorkspaceAgentImportedTurnsV1).Scan(&importedRowID); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(ctx, `
SELECT rowid FROM agent_store_schema_migrations WHERE id = ?
`, schemaMigrationWorkspaceAgentEffectiveHistoryV1).Scan(&historyRowID); err != nil {
		t.Fatal(err)
	}
	if historyRowID <= importedRowID {
		t.Fatalf("effective history migration row=%d, want after imported turns row=%d", historyRowID, importedRowID)
	}
	if err := store.db.QueryRowContext(ctx, `
SELECT rowid FROM agent_store_schema_migrations WHERE id = ?
`, schemaMigrationWorkspaceAgentEffectiveHistoryV2).Scan(&metadataRowID); err != nil {
		t.Fatal(err)
	}
	if metadataRowID <= historyRowID {
		t.Fatalf("effective history metadata migration row=%d, want after history row=%d", metadataRowID, historyRowID)
	}

	seedTurnTestSession(t, store, "ws-1", "session-new")
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-new", TurnID: "turn-new",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 40,
	}); err != nil || !accepted {
		t.Fatalf("seed new turn accepted=%v error=%v", accepted, err)
	}
	assertSessionHistory(t, store, "session-new", 0, SessionHistoryRecoveryReady)
	assertTurnHistory(t, store, "session-new", "turn-new", TurnHistoryStateEffective)
}

func TestEffectiveHistorySubmissionIsLosslessIdempotentAndConflictFenced(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 20,
	}); err != nil || !accepted {
		t.Fatalf("seed turn accepted=%v error=%v", accepted, err)
	}
	input := TurnSubmission{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		ContentJSON:   `[{"type":"text","text":"hello"},{"type":"image","attachmentId":"attachment-1"}]`,
		DisplayPrompt: "hello", CapabilityRefsJSON: `[{"Capability":"browser"}]`,
		TuttiModeSnapshotJSON: `{"Revision":2}`, MetadataJSON: `{"uiMode":"agent"}`, ClientSubmitID: "submit-1",
		CreatedAtUnixMS: 21, UpdatedAtUnixMS: 21,
	}
	if _, created, err := store.RecordTurnSubmission(ctx, input); err != nil || !created {
		t.Fatalf("first submission created=%v error=%v", created, err)
	}
	if stored, created, err := store.RecordTurnSubmission(ctx, input); err != nil || created || stored.ContentJSON != input.ContentJSON || stored.MetadataJSON != input.MetadataJSON {
		t.Fatalf("replayed submission created=%v stored=%#v error=%v", created, stored, err)
	}
	conflict := input
	conflict.ContentJSON = `[{"type":"text","text":"changed"}]`
	if _, _, err := store.RecordTurnSubmission(ctx, conflict); !errors.Is(err, ErrTurnSubmissionConflict) {
		t.Fatalf("conflicting submission error=%v", err)
	}
	conflict = input
	conflict.MetadataJSON = `{"uiMode":"os"}`
	if _, _, err := store.RecordTurnSubmission(ctx, conflict); !errors.Is(err, ErrTurnSubmissionConflict) {
		t.Fatalf("conflicting submission metadata error=%v", err)
	}
}

func TestEffectiveHistoryRetractedTurnIsHiddenButAuditable(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")
	for index, turnID := range []string{"turn-1", "turn-2"} {
		occurred := int64(20 + index*20)
		if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: turnID,
			Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted,
			FileChanges:      map[string]any{"files": []any{turnID + ".txt"}},
			OccurredAtUnixMS: occurred,
		}); err != nil || !accepted {
			t.Fatalf("seed %s accepted=%v error=%v", turnID, accepted, err)
		}
		if _, created, err := store.RecordTurnSubmission(ctx, TurnSubmission{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: turnID,
			ContentJSON:   `[{"type":"text","text":"` + turnID + `"}]`,
			DisplayPrompt: turnID, CapabilityRefsJSON: `[]`,
			TuttiModeSnapshotJSON: `null`, ClientSubmitID: "submit-" + turnID,
			CreatedAtUnixMS: occurred, UpdatedAtUnixMS: occurred,
		}); err != nil || !created {
			t.Fatalf("seed %s submission created=%v error=%v", turnID, created, err)
		}
		reportTestMessage(t, store, "session-1", "message-"+turnID, turnID, occurred+1)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_turn_history
SET history_state = 'retracted', retracted_by_operation_id = 'operation-1'
WHERE workspace_id = 'ws-1' AND agent_session_id = 'session-1' AND turn_id = 'turn-2'
`); err != nil {
		t.Fatal(err)
	}
	latest, ok, err := store.GetLatestTurn(ctx, "ws-1", "session-1")
	if err != nil || !ok || latest.TurnID != "turn-1" {
		t.Fatalf("latest=%#v ok=%v error=%v", latest, ok, err)
	}
	page, err := store.ListSessionTurnSummaries(ctx, ListSessionTurnSummariesInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Limit: 10,
	})
	if err != nil || len(page.Turns) != 1 || page.Turns[0].TurnID != "turn-1" {
		t.Fatalf("turn summaries=%#v error=%v", page, err)
	}
	messages := snapshotSessionMessages(t, store, "ws-1", "session-1")
	if len(messages) != 1 || messages[0].TurnID != "turn-1" {
		t.Fatalf("effective messages=%#v", messages)
	}
	effective, err := store.ListEffectiveSessionTurns(ctx, "ws-1", "session-1")
	if err != nil || len(effective) != 1 || effective[0].TurnID != "turn-1" {
		t.Fatalf("effective turns=%#v error=%v", effective, err)
	}
	auditTurns, err := store.ListSessionTurns(ctx, "ws-1", "session-1")
	if err != nil || len(auditTurns) != 2 {
		t.Fatalf("audit turns=%#v error=%v", auditTurns, err)
	}
	if audit, found, err := store.GetTurn(ctx, "ws-1", "session-1", "turn-2"); err != nil || !found || len(audit.FileChanges) == 0 {
		t.Fatalf("audit turn=%#v found=%v error=%v", audit, found, err)
	}
	if submission, found, err := store.GetTurnSubmission(ctx, "ws-1", "session-1", "turn-2"); err != nil || !found || submission.DisplayPrompt != "turn-2" {
		t.Fatalf("audit submission=%#v found=%v error=%v", submission, found, err)
	}
}

func assertSessionHistory(t *testing.T, store *Store, sessionID string, revision uint64, state string) {
	t.Helper()
	history, ok, err := store.GetSessionHistory(context.Background(), "ws-1", sessionID)
	if err != nil || !ok || history.Revision != revision || history.RecoveryState != state {
		t.Fatalf("session history=%#v ok=%v error=%v", history, ok, err)
	}
}

func assertTurnHistory(t *testing.T, store *Store, sessionID, turnID, state string) {
	t.Helper()
	history, ok, err := store.GetTurnHistory(context.Background(), "ws-1", sessionID, turnID)
	if err != nil || !ok || history.State != state {
		t.Fatalf("turn history=%#v ok=%v error=%v", history, ok, err)
	}
}
