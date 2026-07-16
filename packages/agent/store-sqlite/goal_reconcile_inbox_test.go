package storesqlite

import (
	"context"
	"errors"
	"fmt"
	"testing"
)

func TestGoalReconcileInboxIdempotencyConflictAndStartupRecovery(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	item := GoalReconcileInboxItem{RequestID: "request-1", WorkspaceID: "ws", AgentSessionID: "session", Payload: map[string]any{"providerTurnId": "turn-1"}, CreatedAtUnixMS: 10}
	if created, err := store.PutGoalReconcileInbox(ctx, item); err != nil || !created {
		t.Fatalf("put created=%v err=%v", created, err)
	}
	if created, err := store.PutGoalReconcileInbox(ctx, item); err != nil || created {
		t.Fatalf("duplicate created=%v err=%v", created, err)
	}
	conflict := item
	conflict.AgentSessionID = "other"
	if _, err := store.PutGoalReconcileInbox(ctx, conflict); !errors.Is(err, ErrGoalReconcileInboxConflict) {
		t.Fatalf("conflict err=%v", err)
	}
	claimed, ok, err := store.ClaimGoalReconcileInbox(ctx, ClaimGoalReconcileInboxInput{RequestID: item.RequestID, LeaseOwner: "dead", NowUnixMS: 10, LeaseExpiresAtMS: 1000})
	if err != nil || !ok || claimed.Attempt != 1 {
		t.Fatalf("claim=%#v ok=%v err=%v", claimed, ok, err)
	}
	if count, err := store.RequeueLeasedGoalReconcileInboxOnStartup(ctx, 20); err != nil || count != 1 {
		t.Fatalf("requeue count=%d err=%v", count, err)
	}
	claimed, ok, err = store.ClaimGoalReconcileInbox(ctx, ClaimGoalReconcileInboxInput{RequestID: item.RequestID, LeaseOwner: "new", NowUnixMS: 20, LeaseExpiresAtMS: 100})
	if err != nil || !ok || claimed.Attempt != 2 {
		t.Fatalf("reclaim=%#v ok=%v err=%v", claimed, ok, err)
	}
	if completed, err := store.CompleteGoalReconcileInbox(ctx, item.RequestID, "new", 30); err != nil || !completed {
		t.Fatalf("complete=%v err=%v", completed, err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE workspace_agent_goal_reconcile_inbox SET payload_json='{' WHERE request_id=?`, item.RequestID); err != nil {
		t.Fatal(err)
	}
	corrupt, err := store.listGoalReconcileInboxByID(ctx, item.RequestID)
	if err != nil || len(corrupt) != 1 || corrupt[0].PayloadError == "" {
		t.Fatalf("corrupt row isolation=%#v err=%v", corrupt, err)
	}
}

func TestGoalReconcileInboxPrepareFinalizeCrashWindows(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	pendingPayload := map[string]any{
		"phase": "quiesce_pending", "providerTurnId": "turn-1", "reason": "unproven",
		"fenceMode": "operation", "expectedOperationId": "goal-op", "expectedRevision": int64(3),
		"expectedRepairEpoch": int64(2), "quiesceSucceeded": false, "quiesceError": "",
	}
	pending := GoalReconcileInboxItem{RequestID: "two-phase", WorkspaceID: "ws", AgentSessionID: "session", Payload: pendingPayload, CreatedAtUnixMS: 100}
	if created, err := store.PutGoalReconcileInbox(ctx, pending); err != nil || !created {
		t.Fatalf("prepare created=%v err=%v", created, err)
	}
	if items, err := store.ListClaimableGoalReconcileInbox(ctx, 100, 10); err != nil || len(items) != 0 {
		t.Fatalf("pending became claimable before finalize deadline items=%#v err=%v", items, err)
	}
	deadline := int64(100 + goalReconcileFinalizeGrace.Milliseconds())
	if items, err := store.ListClaimableGoalReconcileInbox(ctx, deadline, 10); err != nil || len(items) != 1 || items[0].Payload["phase"] != "quiesce_pending" {
		t.Fatalf("prepare-before-interrupt crash was not recoverable items=%#v err=%v", items, err)
	}

	finalized := pending
	finalized.CreatedAtUnixMS = 200
	finalized.Payload = cloneStringAnyMap(pendingPayload)
	finalized.Payload["phase"] = "finalized"
	finalized.Payload["quiesceSucceeded"] = true
	if created, err := store.PutGoalReconcileInbox(ctx, finalized); err != nil || created {
		t.Fatalf("finalize created=%v err=%v", created, err)
	}
	if items, err := store.ListClaimableGoalReconcileInbox(ctx, 200, 10); err != nil || len(items) != 1 || items[0].Payload["phase"] != "finalized" || items[0].Payload["quiesceSucceeded"] != true {
		t.Fatalf("interrupt-before-finalize window not closed items=%#v err=%v", items, err)
	}
	// ACK loss is idempotent, and a delayed prepare can never overwrite the
	// finalized outcome for the same immutable incident identity.
	if created, err := store.PutGoalReconcileInbox(ctx, finalized); err != nil || created {
		t.Fatalf("finalize replay created=%v err=%v", created, err)
	}
	if created, err := store.PutGoalReconcileInbox(ctx, pending); err != nil || created {
		t.Fatalf("stale prepare created=%v err=%v", created, err)
	}
	rows, err := store.listGoalReconcileInboxByID(ctx, pending.RequestID)
	if err != nil || len(rows) != 1 || rows[0].Payload["phase"] != "finalized" || rows[0].Payload["quiesceSucceeded"] != true {
		t.Fatalf("stale prepare overwrote finalize rows=%#v err=%v", rows, err)
	}
	conflict := finalized
	conflict.Payload = cloneStringAnyMap(finalized.Payload)
	conflict.Payload["providerTurnId"] = "turn-other"
	if _, err := store.PutGoalReconcileInbox(ctx, conflict); !errors.Is(err, ErrGoalReconcileInboxConflict) {
		t.Fatalf("immutable identity conflict err=%v", err)
	}
}

func cloneStringAnyMap(input map[string]any) map[string]any {
	output := make(map[string]any, len(input))
	for key, value := range input {
		output[key] = value
	}
	return output
}

func TestGoalRepairIncidentBudgetPersistsAcrossSourcesAndResetsOnRevision(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{WorkspaceID: "ws-budget", AgentSessionID: "session", Provider: "codex", OccurredAtUnixMS: 1}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{OperationID: "goal-1", WorkspaceID: "ws-budget", AgentSessionID: "session", Action: "set", Objective: "one", OccurredAtUnixMS: 2}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReconcileSessionGoalObservation(ctx, GoalObservationReconcile{WorkspaceID: "ws-budget", AgentSessionID: "session", Observed: map[string]any{"objective": "one"}, Evidence: map[string]any{"confidence": "authoritative"}, OccurredAtUnixMS: 3}); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= maxGoalRepairIncidentGenerations+1; i++ {
		_, state, _, err := store.EnsureOrWakeGoalRepairOperation(ctx, EnsureGoalRepairOperationInput{WorkspaceID: "ws-budget", AgentSessionID: "session", SourceOperationID: fmt.Sprintf("source-%d", i), SourceRevision: 1, CurrentRevision: 1, OccurredAtUnixMS: int64(10 + i)})
		if err != nil {
			t.Fatalf("generation %d: %v", i, err)
		}
		if i == maxGoalRepairIncidentGenerations+1 && (state.SyncStatus != GoalSyncStatusUnknown || state.PendingOperationID != "") {
			t.Fatalf("terminal budget state=%#v", state)
		}
	}
	ordinary, err := store.ReconcileSessionGoalObservation(ctx, GoalObservationReconcile{WorkspaceID: "ws-budget", AgentSessionID: "session", Observed: map[string]any{"objective": "one"}, Evidence: map[string]any{"confidence": "authoritative"}, OccurredAtUnixMS: 25})
	if err != nil || ordinary.SyncStatus != GoalSyncStatusUnknown || ordinary.LastError == "" {
		t.Fatalf("terminal incident was unlocked by ordinary observation state=%#v err=%v", ordinary, err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{WorkspaceID: "ws-budget", AgentSessionID: "session", Provider: "codex", RuntimeContext: map[string]any{"goal": map[string]any{"objective": "one", "status": "active"}}, OccurredAtUnixMS: 26}); err != nil {
		t.Fatal(err)
	}
	snapshot, found, err := store.GetSessionGoalState(ctx, "ws-budget", "session")
	if err != nil || !found || snapshot.SyncStatus != GoalSyncStatusUnknown || snapshot.LastError == "" {
		t.Fatalf("repair terminal was unlocked by runtime session snapshot state=%#v found=%v err=%v", snapshot, found, err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{OperationID: "goal-2", WorkspaceID: "ws-budget", AgentSessionID: "session", Action: "set", Objective: "two", OccurredAtUnixMS: 30}); err != nil {
		t.Fatal(err)
	}
	_, state, created, err := store.EnsureOrWakeGoalRepairOperation(ctx, EnsureGoalRepairOperationInput{WorkspaceID: "ws-budget", AgentSessionID: "session", SourceOperationID: "revision-2-source", SourceRevision: 2, CurrentRevision: 2, OccurredAtUnixMS: 31})
	if err != nil || !created || state.Revision != 2 || state.PendingOperationID == "" {
		t.Fatalf("new revision state=%#v created=%v err=%v", state, created, err)
	}
}

func TestGoalDurableControlRowsAreExplicitlyDeletedWithForeignKeysOff(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	for _, sessionID := range []string{"delete-me", "clear-me"} {
		if _, err := store.ReportSessionState(ctx, SessionStateReport{WorkspaceID: "ws-clean", AgentSessionID: sessionID, Provider: "codex", OccurredAtUnixMS: 1}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.PutGoalReconcileInbox(ctx, GoalReconcileInboxItem{RequestID: "request-" + sessionID, WorkspaceID: "ws-clean", AgentSessionID: sessionID, Payload: map[string]any{"providerTurnId": "turn"}, CreatedAtUnixMS: 2}); err != nil {
			t.Fatal(err)
		}
		if _, err := store.db.ExecContext(ctx, `INSERT INTO workspace_agent_goal_repair_incidents(workspace_id,agent_session_id,goal_revision,generation_count,updated_at_unix_ms) VALUES(?,?,?,?,?)`, "ws-clean", sessionID, 1, 1, 2); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.DeleteSession(ctx, "ws-clean", "delete-me"); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"workspace_agent_goal_reconcile_inbox", "workspace_agent_goal_repair_incidents"} {
		var count int
		if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table+` WHERE workspace_id='ws-clean' AND agent_session_id='delete-me'`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("delete %s count=%d err=%v", table, count, err)
		}
	}
	if _, err := store.ClearSessions(ctx, "ws-clean"); err != nil {
		t.Fatal(err)
	}
	for _, table := range []string{"workspace_agent_goal_reconcile_inbox", "workspace_agent_goal_repair_incidents"} {
		var count int
		if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table+` WHERE workspace_id='ws-clean'`).Scan(&count); err != nil || count != 0 {
			t.Fatalf("clear %s count=%d err=%v", table, count, err)
		}
	}
}

func TestGoalReconcileInboxPoisonRowDoesNotStarveGoodRow(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	for _, id := range []string{"bad", "good"} {
		if _, err := store.PutGoalReconcileInbox(ctx, GoalReconcileInboxItem{RequestID: id, WorkspaceID: "ws", AgentSessionID: "session", Payload: map[string]any{"providerTurnId": id}, CreatedAtUnixMS: 10}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE workspace_agent_goal_reconcile_inbox SET payload_json='{' WHERE request_id='bad'`); err != nil {
		t.Fatal(err)
	}
	items, err := store.ListClaimableGoalReconcileInbox(ctx, 10, 10)
	if err != nil || len(items) != 2 {
		t.Fatalf("items=%#v err=%v", items, err)
	}
	seenGood, seenPoison := false, false
	for _, item := range items {
		if item.RequestID == "good" && item.PayloadError == "" && item.Payload["providerTurnId"] == "good" {
			seenGood = true
		}
		if item.RequestID == "bad" && item.PayloadError != "" {
			seenPoison = true
		}
	}
	if !seenGood || !seenPoison {
		t.Fatalf("good=%v poison=%v items=%#v", seenGood, seenPoison, items)
	}
}
