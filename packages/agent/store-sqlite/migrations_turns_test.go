package storesqlite

import (
	"context"
	"reflect"
	"testing"
)

// snapshotSessionMessages captures the full rendered message sequence of a
// session, the acceptance signal for the turns backfill: migration reruns
// must leave it byte-for-byte identical.
func snapshotSessionMessages(t *testing.T, store *Store, workspaceID string, agentSessionID string) []Message {
	t.Helper()
	page, ok, err := store.ListSessionMessages(context.Background(), ListSessionMessagesInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: agentSessionID,
		Limit:          100,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionMessages(%s) ok=%v error=%v", agentSessionID, ok, err)
	}
	return page.Messages
}

func reportTestMessage(t *testing.T, store *Store, agentSessionID string, messageID string, turnID string, occurred int64) {
	t.Helper()
	_, err := store.ReportSessionMessages(context.Background(), SessionMessageReport{
		WorkspaceID:    "ws-1",
		AgentSessionID: agentSessionID,
		Origin:         "runtime",
		Messages: []MessageUpdate{{
			MessageID:        messageID,
			TurnID:           turnID,
			Role:             "assistant",
			Kind:             "text",
			Status:           "completed",
			Payload:          map[string]any{"text": messageID},
			OccurredAtUnixMS: occurred,
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages(%s/%s) error = %v", agentSessionID, messageID, err)
	}
}

func TestWorkspaceAgentTurnsBackfillPreservesMessagesAndIsRerunSafe(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	for _, seed := range []struct {
		sessionID string
		status    string
	}{
		{sessionID: "session-done", status: "completed"},
		{sessionID: "session-failed", status: "failed"},
	} {
		if _, err := store.ReportSessionState(ctx, SessionStateReport{
			WorkspaceID:      "ws-1",
			AgentSessionID:   seed.sessionID,
			Origin:           "runtime",
			Provider:         "codex",
			Status:           seed.status,
			OccurredAtUnixMS: 100,
		}); err != nil {
			t.Fatalf("ReportSessionState(%s) error = %v", seed.sessionID, err)
		}
	}

	reportTestMessage(t, store, "session-done", "msg-1", "turn-1", 110)
	reportTestMessage(t, store, "session-done", "msg-2", "turn-2", 120)
	// Turnless message: stays session-level (turn_id NULL) and must never
	// gain a fabricated turn from the backfill.
	reportTestMessage(t, store, "session-done", "msg-3", "", 130)
	reportTestMessage(t, store, "session-failed", "msg-1", "turn-b1", 110)
	reportTestMessage(t, store, "session-failed", "msg-2", "turn-b2", 120)

	messagesDoneBefore := snapshotSessionMessages(t, store, "ws-1", "session-done")
	messagesFailedBefore := snapshotSessionMessages(t, store, "ws-1", "session-failed")

	// Simulate a legacy database that has messages but predates the turns
	// migration, then re-run Migrate so the backfill executes against them.
	if _, err := store.db.ExecContext(ctx, `DELETE FROM `+schemaMigrationsTable+` WHERE id = ?`, schemaMigrationWorkspaceAgentActivityTurnsV1); err != nil {
		t.Fatalf("reset turns migration ledger: %v", err)
	}
	for _, drop := range []string{
		`DROP TABLE workspace_agent_interactions`,
		`DROP TABLE workspace_agent_turns`,
	} {
		if _, err := store.db.ExecContext(ctx, drop); err != nil {
			t.Fatalf("%s: %v", drop, err)
		}
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(backfill) error = %v", err)
	}

	doneTurns, err := store.ListSessionTurns(ctx, "ws-1", "session-done")
	if err != nil {
		t.Fatalf("ListSessionTurns(session-done) error = %v", err)
	}
	if len(doneTurns) != 2 {
		t.Fatalf("session-done turns = %d, want 2 (turnless message must not create a turn)", len(doneTurns))
	}
	for _, turn := range doneTurns {
		if turn.Phase != TurnPhaseSettled || turn.Outcome != TurnOutcomeCompleted || !turn.Backfilled {
			t.Fatalf("backfilled turn = %#v, want settled/completed/backfilled", turn)
		}
	}

	failedTurns, err := store.ListSessionTurns(ctx, "ws-1", "session-failed")
	if err != nil {
		t.Fatalf("ListSessionTurns(session-failed) error = %v", err)
	}
	outcomes := map[string]string{}
	for _, turn := range failedTurns {
		outcomes[turn.TurnID] = turn.Outcome
	}
	if outcomes["turn-b2"] != TurnOutcomeFailed {
		t.Fatalf("newest turn of failed session outcome = %q, want failed (all = %#v)", outcomes["turn-b2"], outcomes)
	}
	if outcomes["turn-b1"] != TurnOutcomeCompleted {
		t.Fatalf("older turn of failed session outcome = %q, want completed", outcomes["turn-b1"])
	}

	messagesDoneAfter := snapshotSessionMessages(t, store, "ws-1", "session-done")
	messagesFailedAfter := snapshotSessionMessages(t, store, "ws-1", "session-failed")
	if !reflect.DeepEqual(messagesDoneBefore, messagesDoneAfter) {
		t.Fatalf("session-done messages changed after backfill:\nbefore = %#v\nafter  = %#v", messagesDoneBefore, messagesDoneAfter)
	}
	if !reflect.DeepEqual(messagesFailedBefore, messagesFailedAfter) {
		t.Fatalf("session-failed messages changed after backfill:\nbefore = %#v\nafter  = %#v", messagesFailedBefore, messagesFailedAfter)
	}

	// Live (non-backfilled) turn written after the migration must survive a
	// backfill rerun untouched.
	liveTurn, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID:      "ws-1",
		AgentSessionID:   "session-done",
		TurnID:           "turn-live",
		Phase:            TurnPhaseRunning,
		OccurredAtUnixMS: 200,
	})
	if err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(live) accepted=%v error=%v", accepted, err)
	}

	if _, err := store.db.ExecContext(ctx, `DELETE FROM `+schemaMigrationsTable+` WHERE id = ?`, schemaMigrationWorkspaceAgentActivityTurnsV1); err != nil {
		t.Fatalf("reset turns migration ledger for rerun: %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(rerun) error = %v", err)
	}

	rerunTurns, err := store.ListSessionTurns(ctx, "ws-1", "session-done")
	if err != nil {
		t.Fatalf("ListSessionTurns(rerun) error = %v", err)
	}
	if len(rerunTurns) != 3 {
		t.Fatalf("session-done turns after rerun = %d, want 3 (no duplicates)", len(rerunTurns))
	}
	liveAfter, ok, err := store.GetTurn(ctx, "ws-1", "session-done", "turn-live")
	if err != nil || !ok {
		t.Fatalf("GetTurn(turn-live) ok=%v error=%v", ok, err)
	}
	if !reflect.DeepEqual(liveTurn, liveAfter) {
		t.Fatalf("live turn mutated by backfill rerun:\nbefore = %#v\nafter  = %#v", liveTurn, liveAfter)
	}

	messagesDoneRerun := snapshotSessionMessages(t, store, "ws-1", "session-done")
	if !reflect.DeepEqual(messagesDoneBefore, messagesDoneRerun) {
		t.Fatalf("session-done messages changed after rerun:\nbefore = %#v\nafter  = %#v", messagesDoneBefore, messagesDoneRerun)
	}
}
