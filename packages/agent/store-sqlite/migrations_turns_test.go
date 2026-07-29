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
	if turnID != "" {
		if _, ok, err := store.GetTurn(context.Background(), "ws-1", agentSessionID, turnID); err != nil {
			t.Fatalf("GetTurn(%s/%s) error = %v", agentSessionID, turnID, err)
		} else if !ok {
			if _, accepted, err := store.RecordTurnTransition(context.Background(), TurnTransition{
				WorkspaceID: "ws-1", AgentSessionID: agentSessionID, TurnID: turnID,
				Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: occurred - 1,
			}); err != nil || !accepted {
				t.Fatalf("RecordTurnTransition(%s/%s) accepted=%v error=%v", agentSessionID, turnID, accepted, err)
			}
		}
	}
	kind := "text"
	if turnID == "" {
		kind = "session_audit"
	}
	_, err := store.ReportSessionMessages(context.Background(), SessionMessageReport{
		WorkspaceID:    "ws-1",
		AgentSessionID: agentSessionID,
		Origin:         "runtime",
		Messages: []MessageUpdate{{
			MessageID:        messageID,
			TurnID:           turnID,
			Role:             "assistant",
			Kind:             kind,
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
	reportTestMessage(t, store, "session-done", "msg-1b", "turn-1", 115)
	reportTestMessage(t, store, "session-done", "msg-2", "turn-2", 120)
	// Turnless message: stays session-level (turn_id NULL) and must never
	// gain a fabricated turn from the backfill.
	reportTestMessage(t, store, "session-done", "msg-3", "", 130)
	reportTestMessage(t, store, "session-failed", "msg-1", "turn-b1", 110)
	reportTestMessage(t, store, "session-failed", "msg-2", "turn-b2", 120)
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:      "ws-1",
		AgentSessionID:   "session-deleted",
		Origin:           "runtime",
		Provider:         "codex",
		Status:           "completed",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState(session-deleted) error = %v", err)
	}
	reportTestMessage(t, store, "session-deleted", "msg-deleted", "turn-deleted", 125)
	// Preserve the historical turn id while marking both legacy rows deleted.
	// This is the pre-turn-schema shape that the migration must ignore.
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions SET deleted_at_unix_ms = 130 WHERE workspace_id = 'ws-1' AND agent_session_id = 'session-deleted';
UPDATE workspace_agent_messages SET deleted_at_unix_ms = 130 WHERE workspace_id = 'ws-1' AND agent_session_id = 'session-deleted';
`); err != nil {
		t.Fatalf("mark legacy session deleted: %v", err)
	}

	messagesDoneBefore := snapshotSessionMessages(t, store, "ws-1", "session-done")
	messagesFailedBefore := snapshotSessionMessages(t, store, "ws-1", "session-failed")

	// Simulate a legacy database that has messages but predates the turns
	// migration, then re-run Migrate so the backfill executes against them.
	if _, err := store.db.ExecContext(ctx, `DELETE FROM `+schemaMigrationsTable+` WHERE id IN (?, ?, ?)`, schemaMigrationWorkspaceAgentActivityTurnsV1, schemaMigrationWorkspaceAgentActivityTurnIntegrityV1, schemaMigrationWorkspaceAgentTurnCapabilityRefsV1); err != nil {
		t.Fatalf("reset turns migration ledger: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		t.Fatalf("disable foreign keys for legacy fixture: %v", err)
	}
	for _, drop := range []string{
		`DROP TABLE workspace_agent_interactions`,
		`DROP TABLE workspace_agent_turns`,
	} {
		if _, err := store.db.ExecContext(ctx, drop); err != nil {
			t.Fatalf("%s: %v", drop, err)
		}
	}
	if _, err := store.db.ExecContext(ctx, `PRAGMA foreign_keys = ON`); err != nil {
		t.Fatalf("enable foreign keys after legacy fixture: %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate(backfill) error = %v", err)
	}
	if deleted, err := store.SessionDeleted(ctx, "ws-1", "session-deleted"); err != nil || !deleted {
		t.Fatalf("SessionDeleted(session-deleted) deleted=%v error=%v", deleted, err)
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
	turnOne, ok, err := store.GetTurn(ctx, "ws-1", "session-done", "turn-1")
	if err != nil || !ok {
		t.Fatalf("GetTurn(session-done/turn-1) ok=%v error=%v", ok, err)
	}
	if turnOne.StartedAtUnixMS != 110 || turnOne.SettledAtUnixMS != 115 ||
		turnOne.CreatedAtUnixMS != 110 || turnOne.UpdatedAtUnixMS != 115 {
		t.Fatalf("backfilled turn timestamps = %#v, want message-derived 110..115", turnOne)
	}
	deletedTurns, err := store.ListSessionTurns(ctx, "ws-1", "session-deleted")
	if err != nil {
		t.Fatalf("ListSessionTurns(session-deleted) error = %v", err)
	}
	if len(deletedTurns) != 0 {
		t.Fatalf("deleted session turns = %#v, want none", deletedTurns)
	}
	var deletedMessageTurnID *string
	if err := store.db.QueryRowContext(ctx, `
SELECT turn_id
FROM workspace_agent_messages
WHERE workspace_id = 'ws-1' AND agent_session_id = 'session-deleted' AND message_id = 'msg-deleted'
`).Scan(&deletedMessageTurnID); err != nil {
		t.Fatalf("read deleted message turn id: %v", err)
	}
	if deletedMessageTurnID != nil {
		t.Fatalf("deleted message turn id = %q, want NULL", *deletedMessageTurnID)
	}
	var foreignKeyViolationCount int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM pragma_foreign_key_check`).Scan(&foreignKeyViolationCount); err != nil {
		t.Fatalf("check foreign keys: %v", err)
	}
	if foreignKeyViolationCount != 0 {
		t.Fatalf("foreign key violations = %d, want 0", foreignKeyViolationCount)
	}
	var latestTurnIndexCount int
	if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'idx_workspace_agent_turns_session_latest'`).Scan(&latestTurnIndexCount); err != nil || latestTurnIndexCount != 1 {
		t.Fatalf("latest-turn index count = %d, error = %v", latestTurnIndexCount, err)
	}

	failedTurns, err := store.ListSessionTurns(ctx, "ws-1", "session-failed")
	if err != nil {
		t.Fatalf("ListSessionTurns(session-failed) error = %v", err)
	}
	outcomes := map[string]string{}
	for _, turn := range failedTurns {
		outcomes[turn.TurnID] = turn.Outcome
	}
	// Once the legacy session status column has been removed, a deliberately
	// destroyed-and-rebuilt turn table can only recover message-backed turns
	// as completed. Real upgrades run the turn migration before dropping that
	// legacy column and are covered by the legacy upgrade fixture.
	if outcomes["turn-b2"] != TurnOutcomeCompleted {
		t.Fatalf("newest rebuilt turn outcome = %q, want completed (all = %#v)", outcomes["turn-b2"], outcomes)
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

func TestWorkspaceAgentTurnsMigrationRollsBackSchemaBackfillAndLedger(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{WorkspaceID: "ws-1", AgentSessionID: "session-rollback", Provider: "codex", OccurredAtUnixMS: 90}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	reportTestMessage(t, store, "session-rollback", "message-1", "turn-1", 100)

	for _, statement := range []string{
		`DELETE FROM ` + schemaMigrationsTable + ` WHERE id = '` + schemaMigrationWorkspaceAgentActivityTurnsV1 + `'`,
		`DELETE FROM ` + schemaMigrationsTable + ` WHERE id = '` + schemaMigrationWorkspaceAgentTurnCapabilityRefsV1 + `'`,
		`PRAGMA foreign_keys = OFF`,
		`DROP TABLE workspace_agent_interactions`,
		`DROP TABLE workspace_agent_turns`,
		`PRAGMA foreign_keys = ON`,
		`CREATE TRIGGER fail_turns_migration_ledger BEFORE INSERT ON ` + schemaMigrationsTable + `
		 WHEN NEW.id = '` + schemaMigrationWorkspaceAgentActivityTurnsV1 + `'
		 BEGIN SELECT RAISE(ABORT, 'forced turns migration ledger failure'); END`,
	} {
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("prepare rollback fixture %q: %v", statement, err)
		}
	}

	if err := store.applyWorkspaceAgentActivityTurnsV1(ctx); err == nil {
		t.Fatal("turns migration error = nil, want forced ledger failure")
	}
	if exists, err := store.hasTable(ctx, "workspace_agent_turns"); err != nil || exists {
		t.Fatalf("turns table exists=%v error=%v, want rolled back", exists, err)
	}
	if exists, err := store.hasTable(ctx, "workspace_agent_interactions"); err != nil || exists {
		t.Fatalf("interactions table exists=%v error=%v, want rolled back", exists, err)
	}
	if applied, err := store.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityTurnsV1); err != nil || applied {
		t.Fatalf("migration applied=%v error=%v, want false", applied, err)
	}

	if _, err := store.db.ExecContext(ctx, `DROP TRIGGER fail_turns_migration_ledger`); err != nil {
		t.Fatalf("drop failure trigger: %v", err)
	}
	if err := store.applyWorkspaceAgentActivityTurnsV1(ctx); err != nil {
		t.Fatalf("retry turns migration: %v", err)
	}
	if err := store.applyWorkspaceAgentTurnCapabilityRefsV1(ctx); err != nil {
		t.Fatalf("retry turn capability refs migration: %v", err)
	}
	if turn, ok, err := store.GetTurn(ctx, "ws-1", "session-rollback", "turn-1"); err != nil || !ok || !turn.Backfilled {
		t.Fatalf("retried backfill turn=%#v ok=%v error=%v", turn, ok, err)
	}
}

func TestWorkspaceAgentMessagesV2MigrationRollsBackRebuildAndLedger(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{WorkspaceID: "ws-1", AgentSessionID: "session-rollback", Provider: "codex", OccurredAtUnixMS: 90}); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{WorkspaceID: "ws-1", AgentSessionID: "session-rollback", TurnID: "turn-1", Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 95}); err != nil || !accepted {
		t.Fatalf("seed turn accepted=%v error=%v", accepted, err)
	}
	reportTestMessage(t, store, "session-rollback", "message-1", "turn-1", 100)
	if messages := snapshotSessionMessages(t, store, "ws-1", "session-rollback"); len(messages) != 1 {
		t.Fatalf("seed messages = %#v, want one row", messages)
	}

	for _, statement := range []string{
		`DELETE FROM ` + schemaMigrationsTable + ` WHERE id = '` + schemaMigrationWorkspaceAgentActivityMessagesV2 + `'`,
		`CREATE TRIGGER fail_messages_v2_migration_ledger BEFORE INSERT ON ` + schemaMigrationsTable + `
		 WHEN NEW.id = '` + schemaMigrationWorkspaceAgentActivityMessagesV2 + `'
		 BEGIN SELECT RAISE(ABORT, 'forced messages v2 migration ledger failure'); END`,
	} {
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("prepare messages rollback fixture %q: %v", statement, err)
		}
	}

	if err := store.applyWorkspaceAgentActivityMessagesV2(ctx); err == nil {
		t.Fatal("messages v2 migration error = nil, want forced ledger failure")
	}
	if messages := snapshotSessionMessages(t, store, "ws-1", "session-rollback"); len(messages) != 1 || messages[0].MessageID != "message-1" {
		t.Fatalf("messages after rollback = %#v, want original row", messages)
	}
	if applied, err := store.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityMessagesV2); err != nil || applied {
		t.Fatalf("migration applied=%v error=%v, want false", applied, err)
	}
	if exists, err := store.hasTable(ctx, "workspace_agent_messages_v2"); err != nil || exists {
		t.Fatalf("temporary table exists=%v error=%v, want rolled back", exists, err)
	}

	if _, err := store.db.ExecContext(ctx, `DROP TRIGGER fail_messages_v2_migration_ledger`); err != nil {
		t.Fatalf("drop failure trigger: %v", err)
	}
	if err := store.applyWorkspaceAgentActivityMessagesV2(ctx); err != nil {
		t.Fatalf("retry messages v2 migration: %v", err)
	}
	if messages := snapshotSessionMessages(t, store, "ws-1", "session-rollback"); len(messages) != 1 || messages[0].MessageID != "message-1" {
		t.Fatalf("messages after retry = %#v, want original row", messages)
	}
}
