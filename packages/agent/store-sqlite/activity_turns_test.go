package storesqlite

import (
	"context"
	"testing"
)

func TestLatestTurnsUseCompositeSessionScopeAndDurableOrdering(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")
	seedTurnTestSession(t, store, "ws-1", "session-2")
	for _, row := range []struct {
		sessionID string
		turnID    string
		createdAt int64
		outcome   string
	}{
		{sessionID: "session-1", turnID: "same-turn", createdAt: 10, outcome: TurnOutcomeFailed},
		{sessionID: "session-1", turnID: "newer-created", createdAt: 20, outcome: TurnOutcomeCompleted},
		{sessionID: "session-2", turnID: "same-turn", createdAt: 30, outcome: TurnOutcomeCanceled},
	} {
		_, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase, outcome,
  started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, 'settled', ?, 100, 100, ?, 100)
`, "ws-1", row.sessionID, row.turnID, row.outcome, row.createdAt)
		if err != nil {
			t.Fatalf("insert turn %s/%s: %v", row.sessionID, row.turnID, err)
		}
	}

	latest, err := store.ListLatestTurns(ctx, "ws-1", []string{"session-1", "session-2"})
	if err != nil {
		t.Fatalf("ListLatestTurns() error = %v", err)
	}
	if latest["session-1"].TurnID != "newer-created" || latest["session-1"].Outcome != TurnOutcomeCompleted {
		t.Fatalf("session-1 latest turn = %#v", latest["session-1"])
	}
	if latest["session-2"].TurnID != "same-turn" || latest["session-2"].Outcome != TurnOutcomeCanceled {
		t.Fatalf("session-2 latest turn = %#v", latest["session-2"])
	}
}

func TestLatestTurnInteractionsBulkReadIncludesTerminalStates(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	for _, sessionID := range []string{"session-1", "session-2"} {
		seedTurnTestSession(t, store, "ws-1", sessionID)
	}
	for _, row := range []struct {
		sessionID string
		turnID    string
		updatedAt int64
	}{
		{sessionID: "session-1", turnID: "turn-old", updatedAt: 10},
		{sessionID: "session-1", turnID: "turn-latest", updatedAt: 20},
		{sessionID: "session-2", turnID: "turn-latest", updatedAt: 30},
	} {
		if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_turns (
  workspace_id, agent_session_id, turn_id, phase, outcome,
  started_at_unix_ms, settled_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-1', ?, ?, 'settled', 'completed', ?, ?, ?, ?)
`, row.sessionID, row.turnID, row.updatedAt, row.updatedAt, row.updatedAt, row.updatedAt); err != nil {
			t.Fatalf("insert turn %s/%s: %v", row.sessionID, row.turnID, err)
		}
	}
	for _, row := range []struct {
		sessionID string
		turnID    string
		requestID string
		status    string
	}{
		{sessionID: "session-1", turnID: "turn-old", requestID: "old", status: InteractionStatusAnswered},
		{sessionID: "session-1", turnID: "turn-latest", requestID: "same", status: InteractionStatusAnswered},
		{sessionID: "session-1", turnID: "turn-latest", requestID: "superseded", status: InteractionStatusSuperseded},
		{sessionID: "session-2", turnID: "turn-latest", requestID: "same", status: InteractionStatusPending},
	} {
		if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_interactions (
  workspace_id, agent_session_id, request_id, turn_id, kind, status,
  created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-1', ?, ?, ?, 'question', ?, 1, 2)
`, row.sessionID, row.requestID, row.turnID, row.status); err != nil {
			t.Fatalf("insert interaction %s/%s: %v", row.sessionID, row.requestID, err)
		}
	}

	got, err := store.ListLatestTurnInteractions(ctx, "ws-1", []string{"session-1", "session-2", "session-1"})
	if err != nil {
		t.Fatalf("ListLatestTurnInteractions() error = %v", err)
	}
	if len(got["session-1"]) != 2 || got["session-1"][0].RequestID != "same" || got["session-1"][1].Status != InteractionStatusSuperseded {
		t.Fatalf("session-1 interactions = %#v", got["session-1"])
	}
	if len(got["session-2"]) != 1 || got["session-2"][0].Status != InteractionStatusPending {
		t.Fatalf("session-2 interactions = %#v", got["session-2"])
	}
}

func TestSettleStaleTurnsClosesSplitRuntimeSuccessStateOnRestart(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseWaiting, OccurredAtUnixMS: 100,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition() accepted=%v error=%v", accepted, err)
	}
	if _, accepted, err := store.UpsertInteraction(ctx, InteractionUpsert{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		RequestID: "request-1", Kind: "approval", Status: InteractionStatusPending,
		OccurredAtUnixMS: 110,
	}); err != nil || !accepted {
		t.Fatalf("UpsertInteraction() accepted=%v error=%v", accepted, err)
	}

	settlements, err := store.SettleStaleTurns(ctx)
	if err != nil {
		t.Fatalf("SettleStaleTurns() error = %v", err)
	}
	if len(settlements) != 1 {
		t.Fatalf("settlements = %#v, want one", settlements)
	}
	turn, ok, err := store.GetTurn(ctx, "ws-1", "session-1", "turn-1")
	if err != nil || !ok || turn.Phase != TurnPhaseSettled || turn.Outcome != TurnOutcomeInterrupted {
		t.Fatalf("turn after restart settlement ok=%v error=%v turn=%#v", ok, err, turn)
	}
	session, ok, err := store.GetSession(ctx, "ws-1", "session-1")
	if err != nil || !ok || session.ActiveTurnID != "" {
		t.Fatalf("session after restart settlement ok=%v error=%v session=%#v", ok, err, session)
	}
	pending, err := store.ListSessionInteractions(ctx, ListSessionInteractionsInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Status: InteractionStatusPending,
	})
	if err != nil || len(pending) != 0 {
		t.Fatalf("pending interactions after restart = %#v error=%v", pending, err)
	}
	page, ok, err := store.ListSessionMessages(ctx, ListSessionMessagesInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Limit: 10,
	})
	if err != nil || !ok || len(page.Messages) != 1 {
		t.Fatalf("startup system messages = %#v ok=%v error=%v", page.Messages, ok, err)
	}
	message := page.Messages[0]
	if message.MessageID != "system-stale-turn-turn-1" || message.TurnID != "" || message.Payload["noticeKind"] != "stale_turn_reconciled" {
		t.Fatalf("startup system message = %#v", message)
	}
}

func TestSettleStaleTurnsPreservesTurnProtectedByDeferredRuntimeOperation(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedRuntimeInteractiveSubject(t, store, "session-1", "turn-1", "request-1")
	prepareRuntimeInteractive(t, store, "operation-1", "session-1", "turn-1", "request-1")
	claimRuntimeOperation(t, store, "operation-1", "worker-a")
	if _, changed, err := store.ReleaseOrFailRuntimeOperation(context.Background(), ReleaseOrFailRuntimeOperationInput{
		WorkspaceID: "ws-1", OperationID: "operation-1", LeaseOwner: "worker-a",
		LastError: "agent session is not connected", NowUnixMS: 30, NextAttemptAtMS: 1000,
	}); err != nil || !changed {
		t.Fatalf("ReleaseOrFailRuntimeOperation() changed=%v error=%v", changed, err)
	}

	settlements, err := store.SettleStaleTurns(context.Background())
	if err != nil {
		t.Fatalf("SettleStaleTurns() error = %v", err)
	}
	if len(settlements) != 0 {
		t.Fatalf("settlements = %#v, want protected turn excluded", settlements)
	}
	turn, ok, err := store.GetTurn(context.Background(), "ws-1", "session-1", "turn-1")
	if err != nil || !ok || turn.Phase == TurnPhaseSettled {
		t.Fatalf("protected turn = %#v ok=%v error=%v", turn, ok, err)
	}
	interactions, err := store.ListSessionInteractions(context.Background(), ListSessionInteractionsInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Status: InteractionStatusPending,
	})
	if err != nil || len(interactions) != 1 {
		t.Fatalf("protected interactions = %#v error=%v", interactions, err)
	}
}

func TestSettleStaleTurnsRollsBackWhenSystemMessagePersistenceFails(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedTurnTestSession(t, store, "ws-1", "session-1")
	if _, accepted, err := store.RecordTurnTransition(context.Background(), TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1", Phase: TurnPhaseRunning, OccurredAtUnixMS: 100,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition() accepted=%v error=%v", accepted, err)
	}
	if _, err := store.db.Exec(`CREATE TRIGGER fail_stale_system_message BEFORE INSERT ON workspace_agent_messages BEGIN SELECT RAISE(ABORT, 'message failure'); END;`); err != nil {
		t.Fatalf("create message failure trigger: %v", err)
	}
	if _, err := store.SettleStaleTurns(context.Background()); err == nil {
		t.Fatal("SettleStaleTurns() error = nil, want atomic message failure")
	}
	turn, ok, err := store.GetTurn(context.Background(), "ws-1", "session-1", "turn-1")
	if err != nil || !ok || turn.Phase != TurnPhaseRunning {
		t.Fatalf("turn after rollback = %#v ok=%v error=%v", turn, ok, err)
	}
	session, ok, err := store.GetSession(context.Background(), "ws-1", "session-1")
	if err != nil || !ok || session.ActiveTurnID != "turn-1" {
		t.Fatalf("session after rollback = %#v ok=%v error=%v", session, ok, err)
	}
}

func TestRecordTurnTransitionRejectsLatePhaseRegression(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")

	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseWaiting, OccurredAtUnixMS: 200,
	}); err != nil || !accepted {
		t.Fatalf("record waiting transition accepted=%v error=%v", accepted, err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 100,
	}); err != nil || accepted {
		t.Fatalf("record late running transition accepted=%v error=%v, want rejected", accepted, err)
	}

	turn, ok, err := store.GetTurn(ctx, "ws-1", "session-1", "turn-1")
	if err != nil || !ok {
		t.Fatalf("GetTurn() ok=%v error=%v", ok, err)
	}
	if turn.Phase != TurnPhaseWaiting || turn.UpdatedAtUnixMS != 200 {
		t.Fatalf("turn after late transition = %#v, want waiting at version 200", turn)
	}
}

func TestRecordTurnTransitionRejectsDifferentLiveTurn(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")

	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-old",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 100,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(turn-old) accepted=%v error=%v", accepted, err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-new",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 300,
	}); err == nil || accepted {
		t.Fatalf("RecordTurnTransition(turn-new) accepted=%v error=%v, want live-turn conflict", accepted, err)
	}

	session, ok, err := store.GetSession(ctx, "ws-1", "session-1")
	if err != nil || !ok {
		t.Fatalf("GetSession() ok=%v error=%v", ok, err)
	}
	if session.ActiveTurnID != "turn-old" {
		t.Fatalf("active turn = %q, want turn-old", session.ActiveTurnID)
	}
	if _, ok, err := store.GetTurn(ctx, "ws-1", "session-1", "turn-new"); err != nil || ok {
		t.Fatalf("conflicting turn persisted ok=%v error=%v", ok, err)
	}
}

func TestReportActivityStateRollsBackSessionOnLiveTurnConflict(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-old",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 100,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(turn-old) accepted=%v error=%v", accepted, err)
	}

	_, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime",
			Provider: "codex", Status: "failed", OccurredAtUnixMS: 300,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-new",
			Phase: TurnPhaseRunning, OccurredAtUnixMS: 300,
		},
	})
	if err == nil {
		t.Fatal("ReportActivityState() error = nil, want live-turn conflict")
	}
	session, ok, getErr := store.GetSession(ctx, "ws-1", "session-1")
	if getErr != nil || !ok {
		t.Fatalf("GetSession() ok=%v error=%v", ok, getErr)
	}
	if session.ActiveTurnID != "turn-old" {
		t.Fatalf("session after rolled back conflict = %#v", session)
	}
	if _, ok, getErr := store.GetTurn(ctx, "ws-1", "session-1", "turn-new"); getErr != nil || ok {
		t.Fatalf("conflicting turn persisted ok=%v error=%v", ok, getErr)
	}
}

func TestRecordTurnTransitionAllowsWaitingToResumeRunning(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")

	for _, transition := range []TurnTransition{
		{WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1", Phase: TurnPhaseWaiting, OccurredAtUnixMS: 100},
		{WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1", Phase: TurnPhaseRunning, OccurredAtUnixMS: 101},
	} {
		if _, accepted, err := store.RecordTurnTransition(ctx, transition); err != nil || !accepted {
			t.Fatalf("RecordTurnTransition(%s) accepted=%v error=%v", transition.Phase, accepted, err)
		}
	}
	turn, ok, err := store.GetTurn(ctx, "ws-1", "session-1", "turn-1")
	if err != nil || !ok || turn.Phase != TurnPhaseRunning {
		t.Fatalf("GetTurn() turn=%#v ok=%v error=%v, want running", turn, ok, err)
	}
}

func TestRecordTurnTransitionRejectsSettlingRegression(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")

	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseSettling, OccurredAtUnixMS: 100,
	}); err != nil || !accepted {
		t.Fatalf("record settling accepted=%v error=%v", accepted, err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 200,
	}); err != nil || accepted {
		t.Fatalf("record running regression accepted=%v error=%v, want rejected", accepted, err)
	}
}

func TestReportActivityStateRollsBackSessionAndTurnWhenInteractionFails(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	_, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime",
			Provider: "codex", OccurredAtUnixMS: 100,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
			Phase: TurnPhaseRunning, OccurredAtUnixMS: 100,
		},
		Interaction: &InteractionUpsert{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", RequestID: "request-1",
			TurnID: "turn-1", Kind: "invalid", Status: InteractionStatusPending,
			OccurredAtUnixMS: 100,
		},
	})
	if err == nil {
		t.Fatal("ReportActivityState() error = nil, want invalid interaction kind")
	}
	if _, ok, getErr := store.GetSession(ctx, "ws-1", "session-1"); getErr != nil || ok {
		t.Fatalf("GetSession() after rollback ok=%v error=%v, want absent", ok, getErr)
	}
	if _, ok, getErr := store.GetTurn(ctx, "ws-1", "session-1", "turn-1"); getErr != nil || ok {
		t.Fatalf("GetTurn() after rollback ok=%v error=%v, want absent", ok, getErr)
	}
}

func TestReportActivityStateCommitsSessionTurnAndInteractionTogether(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	result, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime",
			Provider: "codex", OccurredAtUnixMS: 100,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
			Phase: TurnPhaseWaiting, OccurredAtUnixMS: 100,
		},
		Interaction: &InteractionUpsert{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", RequestID: "request-1",
			TurnID: "turn-1", Kind: InteractionKindQuestion, Status: InteractionStatusPending,
			OccurredAtUnixMS: 100,
		},
	})
	if err != nil {
		t.Fatalf("ReportActivityState() error = %v", err)
	}
	if !result.State.Accepted || !result.TurnAccepted || !result.InteractionAccepted {
		t.Fatalf("ReportActivityState() result = %#v, want all entities accepted", result)
	}
	session, ok, err := store.GetSession(ctx, "ws-1", "session-1")
	if err != nil || !ok || session.ActiveTurnID != "turn-1" {
		t.Fatalf("GetSession() session=%#v ok=%v error=%v", session, ok, err)
	}
	turn, ok, err := store.GetTurn(ctx, "ws-1", "session-1", "turn-1")
	if err != nil || !ok || turn.Phase != TurnPhaseWaiting {
		t.Fatalf("GetTurn() turn=%#v ok=%v error=%v", turn, ok, err)
	}
	interactions, err := store.ListSessionInteractions(ctx, ListSessionInteractionsInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Status: InteractionStatusPending,
	})
	if err != nil || len(interactions) != 1 || interactions[0].RequestID != "request-1" {
		t.Fatalf("ListSessionInteractions() interactions=%#v error=%v", interactions, err)
	}
}

func TestUpsertInteractionKeepsIndependentPendingRequests(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")

	for index, requestID := range []string{"request-1", "request-2"} {
		if _, accepted, err := store.UpsertInteraction(ctx, InteractionUpsert{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", RequestID: requestID,
			TurnID: "turn-1", Kind: InteractionKindQuestion, Status: InteractionStatusPending,
			OccurredAtUnixMS: int64(100 + index),
		}); err != nil || !accepted {
			t.Fatalf("UpsertInteraction(%s) accepted=%v error=%v", requestID, accepted, err)
		}
	}

	pending, err := store.ListSessionInteractions(ctx, ListSessionInteractionsInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Status: InteractionStatusPending,
	})
	if err != nil {
		t.Fatalf("ListSessionInteractions() error = %v", err)
	}
	if len(pending) != 2 {
		t.Fatalf("pending interaction count = %d, want 2: %#v", len(pending), pending)
	}
}

func TestUpsertInteractionCreatesCanonicalWaitingTurnAndActivePointer(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")

	if _, accepted, err := store.UpsertInteraction(ctx, InteractionUpsert{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", RequestID: "request-1",
		TurnID: "turn-1", Kind: InteractionKindQuestion, Status: InteractionStatusPending,
		OccurredAtUnixMS: 100,
	}); err != nil || !accepted {
		t.Fatalf("UpsertInteraction() accepted=%v error=%v", accepted, err)
	}
	turn, ok, err := store.GetTurn(ctx, "ws-1", "session-1", "turn-1")
	if err != nil || !ok || turn.Phase != TurnPhaseWaiting {
		t.Fatalf("GetTurn() turn=%#v ok=%v error=%v", turn, ok, err)
	}
	session, ok, err := store.GetSession(ctx, "ws-1", "session-1")
	if err != nil || !ok || session.ActiveTurnID != "turn-1" {
		t.Fatalf("GetSession() session=%#v ok=%v error=%v", session, ok, err)
	}
}

func TestUpsertInteractionRejectsOlderPayload(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")

	for _, input := range []struct {
		occurred     int64
		question     string
		wantAccepted bool
	}{
		{occurred: 200, question: "new", wantAccepted: true},
		{occurred: 100, question: "old", wantAccepted: false},
	} {
		_, accepted, err := store.UpsertInteraction(ctx, InteractionUpsert{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", RequestID: "request-1",
			TurnID: "turn-1", Kind: InteractionKindQuestion, Status: InteractionStatusPending,
			Input: map[string]any{"question": input.question}, OccurredAtUnixMS: input.occurred,
		})
		if err != nil || accepted != input.wantAccepted {
			t.Fatalf("UpsertInteraction(%d) accepted=%v error=%v", input.occurred, accepted, err)
		}
	}
	pending, err := store.ListSessionInteractions(ctx, ListSessionInteractionsInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Status: InteractionStatusPending,
	})
	if err != nil || len(pending) != 1 || pending[0].Input["question"] != "new" {
		t.Fatalf("pending interactions = %#v error=%v", pending, err)
	}
}

func TestReportActivityStateRollsBackSessionOnIllegalTurnRegression(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseSettling, OccurredAtUnixMS: 100,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(settling) accepted=%v error=%v", accepted, err)
	}

	_, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime",
			Provider: "codex", Status: "failed", OccurredAtUnixMS: 200,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
			Phase: TurnPhaseRunning, OccurredAtUnixMS: 200,
		},
	})
	if err == nil {
		t.Fatal("ReportActivityState() error = nil, want illegal transition")
	}
	session, ok, getErr := store.GetSession(ctx, "ws-1", "session-1")
	if getErr != nil || !ok {
		t.Fatalf("session after rollback = %#v ok=%v error=%v", session, ok, getErr)
	}
}

func seedTurnTestSession(t *testing.T, store *Store, workspaceID string, agentSessionID string) {
	t.Helper()
	if _, err := store.ReportSessionState(context.Background(), SessionStateReport{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID, Origin: "runtime",
		Provider: "codex", OccurredAtUnixMS: 1,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
}

func TestInteractionsAllowSameRequestIDInDifferentTurns(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")
	for index, turnID := range []string{"turn-1", "turn-2"} {
		interaction, accepted, err := store.UpsertInteraction(ctx, InteractionUpsert{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: turnID,
			RequestID: "same-request", Kind: InteractionKindApproval,
			Status: InteractionStatusPending, OccurredAtUnixMS: int64(10 + index),
		})
		if err != nil || !accepted || interaction.TurnID != turnID {
			t.Fatalf("UpsertInteraction(%s) interaction=%#v accepted=%v error=%v", turnID, interaction, accepted, err)
		}
		if index == 0 {
			if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
				WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: turnID,
				Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 20,
			}); err != nil || !accepted {
				t.Fatalf("settle first turn accepted=%v error=%v", accepted, err)
			}
		}
	}
	interactions, err := store.ListSessionInteractions(ctx, ListSessionInteractionsInput{WorkspaceID: "ws-1", AgentSessionID: "session-1"})
	if err != nil || len(interactions) != 2 || interactions[0].TurnID == interactions[1].TurnID {
		t.Fatalf("interactions=%#v error=%v, want independently owned rows", interactions, err)
	}
}

func TestSessionActiveTurnReferenceRejectsOrphanAndCrossSessionTurns(t *testing.T) {
	for _, turnID := range []string{"missing-turn", "turn-2"} {
		store := openTestStore(t, testOptions(&staticProjectPaths{}))
		ctx := context.Background()
		seedTurnTestSession(t, store, "ws-1", "session-1")
		seedTurnTestSession(t, store, "ws-1", "session-2")
		if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "session-2", TurnID: "turn-2",
			Phase: TurnPhaseRunning, OccurredAtUnixMS: 10,
		}); err != nil || !accepted {
			t.Fatalf("seed turn accepted=%v error=%v", accepted, err)
		}
		tx, err := store.db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE workspace_agent_sessions SET active_turn_id = ? WHERE workspace_id = 'ws-1' AND agent_session_id = 'session-1'`, turnID); err != nil {
			_ = tx.Rollback()
			continue
		}
		if err := tx.Commit(); err == nil {
			t.Fatalf("active_turn_id %q commit error = nil, want FK rejection", turnID)
		} else {
			_ = tx.Rollback()
		}
	}
}

func TestMessageTurnReferenceAllowsNullAndRejectsOrphans(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	seedTurnTestSession(t, store, "ws-1", "session-1")
	if _, err := store.db.Exec(`
INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, turn_id,
  role, kind, payload_json, created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-1', 'session-1', 'session-notice', 1, NULL, 'system', 'notice', '{}', 1, 1)
`); err != nil {
		t.Fatalf("insert session-level message: %v", err)
	}
	if _, err := store.db.Exec(`
INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, turn_id,
  role, kind, payload_json, created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-1', 'session-1', 'orphan-message', 2, 'missing-turn', 'assistant', 'text', '{}', 2, 2)
`); err == nil {
		t.Fatal("insert orphan turn message error = nil, want FK rejection")
	}
}
