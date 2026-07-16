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

func TestRecordTurnTransitionPersistsCapabilityReferencesFromFirstProjection(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")

	submitted, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseSubmitted, OccurredAtUnixMS: 100,
		CapabilityRefs: []CapabilityReference{
			{Capability: " tutti ", Source: "slash_command"},
			{Capability: "tutti", Source: "slash_command"},
		},
	})
	if err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(submitted) accepted=%v error=%v", accepted, err)
	}
	if len(submitted.CapabilityRefs) != 1 || submitted.CapabilityRefs[0] != (CapabilityReference{Capability: "tutti", Source: "slash_command"}) {
		t.Fatalf("submitted capability refs = %#v", submitted.CapabilityRefs)
	}

	running, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 110,
	})
	if err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(running) accepted=%v error=%v", accepted, err)
	}
	if len(running.CapabilityRefs) != 1 || running.CapabilityRefs[0] != (CapabilityReference{Capability: "tutti", Source: "slash_command"}) {
		t.Fatalf("running capability refs = %#v, want submitted provenance preserved", running.CapabilityRefs)
	}

	replayed, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 110,
		CapabilityRefs: []CapabilityReference{{Capability: "tutti", Source: "slash_command"}},
	})
	if err != nil || !accepted || len(replayed.CapabilityRefs) != 1 {
		t.Fatalf("replayed transition = %#v accepted=%v error=%v", replayed, accepted, err)
	}
}

func TestRecordTurnTransitionMergesGuidanceCapabilityReferencesIntoRunningTurn(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-guidance")

	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-guidance", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 100,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(initial running) accepted=%v error=%v", accepted, err)
	}
	for attempt := range 2 {
		turn, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "session-guidance", TurnID: "turn-1",
			Phase: TurnPhaseRunning, OccurredAtUnixMS: int64(110 + attempt),
			CapabilityRefs: []CapabilityReference{{
				Capability: "tutti",
				Source:     "slash_command",
			}},
		})
		if err != nil || !accepted || len(turn.CapabilityRefs) != 1 ||
			turn.CapabilityRefs[0] != (CapabilityReference{Capability: "tutti", Source: "slash_command"}) {
			t.Fatalf("guidance transition %d = %#v accepted=%v error=%v", attempt, turn, accepted, err)
		}
	}
}

func TestRecordTurnTransitionCapabilityOnlyPatchPreservesWaitingLifecycle(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-guidance-waiting")

	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-guidance-waiting", TurnID: "turn-1",
		Phase: TurnPhaseWaiting, OccurredAtUnixMS: 100,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(waiting) accepted=%v error=%v", accepted, err)
	}
	metadataOnly := TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-guidance-waiting", TurnID: "turn-1",
		OccurredAtUnixMS: 200,
		CapabilityRefs: []CapabilityReference{{
			Capability: "tutti",
			Source:     "slash_command",
		}},
	}
	turn, accepted, err := store.RecordTurnTransition(ctx, metadataOnly)
	if err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(capability only) accepted=%v error=%v", accepted, err)
	}
	if turn.Phase != TurnPhaseWaiting || turn.UpdatedAtUnixMS != 100 || len(turn.CapabilityRefs) != 1 {
		t.Fatalf("turn after capability-only merge = %#v", turn)
	}

	replayed, accepted, err := store.RecordTurnTransition(ctx, metadataOnly)
	if err != nil || accepted || replayed.Phase != TurnPhaseWaiting || replayed.UpdatedAtUnixMS != 100 {
		t.Fatalf("replayed capability-only transition = %#v accepted=%v error=%v", replayed, accepted, err)
	}
}

func TestRecordTurnTransitionCapabilityOnlyPatchRequiresExistingTurn(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-guidance-missing-turn")

	turn, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-guidance-missing-turn", TurnID: "turn-missing",
		CapabilityRefs: []CapabilityReference{{
			Capability: "tutti",
			Source:     "slash_command",
		}},
	})
	if err == nil || accepted || turn.TurnID != "" {
		t.Fatalf("missing-turn capability merge = %#v accepted=%v error=%v", turn, accepted, err)
	}
	if _, ok, getErr := store.GetTurn(ctx, "ws-1", "session-guidance-missing-turn", "turn-missing"); getErr != nil || ok {
		t.Fatalf("missing turn was created ok=%v error=%v", ok, getErr)
	}
}

func TestRecordTurnTransitionMergesLateSubmittedCapabilityReferencesWithoutRegressingRunningTurn(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-late-submitted")

	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-late-submitted", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 200,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(running) accepted=%v error=%v", accepted, err)
	}
	late := TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-late-submitted", TurnID: "turn-1",
		Phase: TurnPhaseSubmitted, OccurredAtUnixMS: 100,
		CapabilityRefs: []CapabilityReference{{Capability: "tutti", Source: "slash_command"}},
	}
	turn, accepted, err := store.RecordTurnTransition(ctx, late)
	if err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(late submitted) accepted=%v error=%v", accepted, err)
	}
	if turn.Phase != TurnPhaseRunning || turn.Outcome != "" || turn.UpdatedAtUnixMS != 200 ||
		len(turn.CapabilityRefs) != 1 {
		t.Fatalf("turn after late submitted provenance = %#v", turn)
	}

	replayed, accepted, err := store.RecordTurnTransition(ctx, late)
	if err != nil || accepted {
		t.Fatalf("RecordTurnTransition(replayed late submitted) accepted=%v error=%v", accepted, err)
	}
	if replayed.Phase != TurnPhaseRunning || replayed.UpdatedAtUnixMS != 200 || len(replayed.CapabilityRefs) != 1 {
		t.Fatalf("turn after replayed late submitted provenance = %#v", replayed)
	}
}

func TestRecordTurnTransitionMergesLateGuidanceCapabilityReferencesWithoutReopeningSettledTurn(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-late-guidance")

	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-late-guidance", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 100,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(running) accepted=%v error=%v", accepted, err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-late-guidance", TurnID: "turn-1",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeFailed,
		OccurredAtUnixMS: 200, SettledAtUnixMS: 200,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(settled) accepted=%v error=%v", accepted, err)
	}
	late := TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-late-guidance", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 210,
		CapabilityRefs: []CapabilityReference{{Capability: "tutti", Source: "slash_command"}},
	}
	turn, accepted, err := store.RecordTurnTransition(ctx, late)
	if err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(late guidance) accepted=%v error=%v", accepted, err)
	}
	if turn.Phase != TurnPhaseSettled || turn.Outcome != TurnOutcomeFailed ||
		turn.SettledAtUnixMS != 200 || turn.UpdatedAtUnixMS != 200 || len(turn.CapabilityRefs) != 1 {
		t.Fatalf("turn after late guidance provenance = %#v", turn)
	}

	replayed, accepted, err := store.RecordTurnTransition(ctx, late)
	if err != nil || accepted {
		t.Fatalf("RecordTurnTransition(replayed late guidance) accepted=%v error=%v", accepted, err)
	}
	if replayed.Phase != TurnPhaseSettled || replayed.Outcome != TurnOutcomeFailed ||
		replayed.SettledAtUnixMS != 200 || replayed.UpdatedAtUnixMS != 200 || len(replayed.CapabilityRefs) != 1 {
		t.Fatalf("turn after replayed late guidance provenance = %#v", replayed)
	}
}

func TestReportActivityStateMergesCapabilityReferencesFromStaleSessionEnvelope(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	initial, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "session-stale-envelope", Origin: "runtime",
			Provider: "codex", Status: "working", OccurredAtUnixMS: 200,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "session-stale-envelope", TurnID: "turn-1",
			Phase: TurnPhaseRunning, OccurredAtUnixMS: 200,
		},
	})
	if err != nil || !initial.State.Accepted || !initial.TurnAccepted {
		t.Fatalf("initial ReportActivityState() result=%#v error=%v", initial, err)
	}
	stale := ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "session-stale-envelope", Origin: "runtime",
			Provider: "codex", Status: "working", OccurredAtUnixMS: 100,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "session-stale-envelope", TurnID: "turn-1",
			Phase: TurnPhaseSubmitted, OccurredAtUnixMS: 100,
			CapabilityRefs: []CapabilityReference{{Capability: "tutti", Source: "slash_command"}},
		},
	}
	result, err := store.ReportActivityState(ctx, stale)
	if err != nil || !result.State.Accepted || result.State.StateApplied || result.State.LastEventUnixMS != 200 || !result.TurnAccepted {
		t.Fatalf("stale ReportActivityState() result=%#v error=%v", result, err)
	}
	if result.Turn.Phase != TurnPhaseRunning || result.Turn.UpdatedAtUnixMS != 200 || len(result.Turn.CapabilityRefs) != 1 {
		t.Fatalf("turn from stale session envelope = %#v", result.Turn)
	}

	replayed, err := store.ReportActivityState(ctx, stale)
	if err != nil || !replayed.State.Accepted || replayed.State.StateApplied || replayed.State.LastEventUnixMS != 200 || replayed.TurnAccepted {
		t.Fatalf("replayed stale ReportActivityState() result=%#v error=%v", replayed, err)
	}
	turn, ok, err := store.GetTurn(ctx, "ws-1", "session-stale-envelope", "turn-1")
	if err != nil || !ok || turn.Phase != TurnPhaseRunning || turn.UpdatedAtUnixMS != 200 || len(turn.CapabilityRefs) != 1 {
		t.Fatalf("stored turn after replay = %#v ok=%v error=%v", turn, ok, err)
	}
}

func TestReportActivityStateDoesNotMergeCapabilityReferencesIntoSoftDeletedSession(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-deleted")

	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-deleted", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 200,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(running) accepted=%v error=%v", accepted, err)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET deleted_at_unix_ms = 300, updated_at_unix_ms = 300
WHERE workspace_id = 'ws-1' AND agent_session_id = 'session-deleted'
`); err != nil {
		t.Fatalf("soft delete session: %v", err)
	}

	result, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "session-deleted", Origin: "runtime",
			Provider: "codex", Status: "working", OccurredAtUnixMS: 400,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "session-deleted", TurnID: "turn-1",
			Phase: TurnPhaseRunning, OccurredAtUnixMS: 400,
			CapabilityRefs: []CapabilityReference{{Capability: "tutti", Source: "slash_command"}},
		},
	})
	if err != nil || result.State.Accepted || result.TurnAccepted {
		t.Fatalf("deleted-session ReportActivityState() result=%#v error=%v", result, err)
	}
	turn, ok, err := store.GetTurn(ctx, "ws-1", "session-deleted", "turn-1")
	if err != nil || !ok {
		t.Fatalf("GetTurn() ok=%v error=%v", ok, err)
	}
	if turn.Phase != TurnPhaseRunning || turn.UpdatedAtUnixMS != 200 || len(turn.CapabilityRefs) != 0 {
		t.Fatalf("soft-deleted session turn was mutated = %#v", turn)
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
	}); err != nil || accepted != InteractionTransitionApplied {
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

func TestReportActivityStateRollsBackSessionAndTurnWhenMessageFails(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.db.ExecContext(ctx, `
CREATE TRIGGER fail_submit_provenance_message
BEFORE INSERT ON workspace_agent_messages
BEGIN
  SELECT RAISE(ABORT, 'forced submit provenance message failure');
END
`); err != nil {
		t.Fatalf("create message failure trigger: %v", err)
	}

	_, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime",
			Provider: "codex", OccurredAtUnixMS: 100,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
			Phase: TurnPhaseSubmitted, OccurredAtUnixMS: 100,
		},
		Messages: []MessageUpdate{{
			MessageID: "client-submit:submit-1", TurnID: "turn-1", Role: "user",
			Kind: "text", Status: "completed", Payload: map[string]any{"clientSubmitId": "submit-1"},
			OccurredAtUnixMS: 100,
		}},
	})
	if err == nil {
		t.Fatal("ReportActivityState() error = nil, want message write failure")
	}
	if _, ok, getErr := store.GetSession(ctx, "ws-1", "session-1"); getErr != nil || ok {
		t.Fatalf("GetSession() after message rollback ok=%v error=%v, want absent", ok, getErr)
	}
	if _, ok, getErr := store.GetTurn(ctx, "ws-1", "session-1", "turn-1"); getErr != nil || ok {
		t.Fatalf("GetTurn() after message rollback ok=%v error=%v, want absent", ok, getErr)
	}
}

func TestReportActivityStateCommitsSubmitProvenanceAtomically(t *testing.T) {
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
			Phase: TurnPhaseSubmitted, OccurredAtUnixMS: 100,
		},
		Messages: []MessageUpdate{{
			MessageID: "client-submit:submit-1", TurnID: "turn-1", Role: "user",
			Kind: "text", Status: "completed", Payload: map[string]any{"clientSubmitId": "submit-1"},
			OccurredAtUnixMS: 100,
		}},
	})
	if err != nil {
		t.Fatalf("ReportActivityState() error = %v", err)
	}
	if !result.State.Accepted || !result.TurnAccepted || result.Messages.AcceptedCount != 1 {
		t.Fatalf("ReportActivityState() result = %#v, want session, turn, and message accepted", result)
	}
	turnID, found, err := store.FindTurnByClientSubmitID(ctx, "ws-1", "session-1", "submit-1")
	if err != nil || !found || turnID != "turn-1" {
		t.Fatalf("FindTurnByClientSubmitID() turnID=%q found=%v error=%v", turnID, found, err)
	}
}

func TestReportActivityStateCommitsGuidanceProvenanceWithoutRegressingOrDuplicating(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: "session-guidance", Origin: "runtime",
			Provider: "codex", OccurredAtUnixMS: 100,
		},
		Turn: &TurnTransition{
			WorkspaceID: "ws-1", AgentSessionID: "session-guidance", TurnID: "turn-active",
			Phase: TurnPhaseRunning, OccurredAtUnixMS: 100,
		},
	}); err != nil {
		t.Fatalf("seed running turn: %v", err)
	}

	reports := make(map[string]ActivityStateReport)
	for index, clientSubmitID := range []string{"guidance-1", "guidance-2"} {
		report := ActivityStateReport{
			Session: SessionStateReport{
				WorkspaceID: "ws-1", AgentSessionID: "session-guidance", Origin: "runtime",
				Provider: "codex", OccurredAtUnixMS: int64(200 + index),
			},
			Messages: []MessageUpdate{{
				MessageID: "client-submit:" + clientSubmitID, TurnID: "turn-active", Role: "user",
				Kind: "text", Status: "completed",
				Payload:          map[string]any{"clientSubmitId": clientSubmitID, "content": "guide"},
				OccurredAtUnixMS: int64(200 + index),
			}},
		}
		reports[clientSubmitID] = report
		result, err := store.ReportActivityState(ctx, report)
		if err != nil || result.Messages.AcceptedCount != 1 {
			t.Fatalf("ReportActivityState(%s) result=%#v error=%v", clientSubmitID, result, err)
		}
		turnID, found, err := store.FindTurnByClientSubmitID(ctx, "ws-1", "session-guidance", clientSubmitID)
		if err != nil || !found || turnID != "turn-active" {
			t.Fatalf("FindTurnByClientSubmitID(%s) turnID=%q found=%v error=%v", clientSubmitID, turnID, found, err)
		}
	}
	turn, found, err := store.GetTurn(ctx, "ws-1", "session-guidance", "turn-active")
	if err != nil || !found || turn.Phase != TurnPhaseRunning {
		t.Fatalf("GetTurn() turn=%#v found=%v error=%v, want running", turn, found, err)
	}

	pageBefore, _, err := store.ListSessionMessages(ctx, ListSessionMessagesInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-guidance", Order: MessageOrderAsc, Limit: 10,
	})
	if err != nil || len(pageBefore.Messages) != 2 {
		t.Fatalf("ListSessionMessages(before replay) page=%#v error=%v", pageBefore, err)
	}
	replayed, err := store.ReportActivityState(ctx, reports["guidance-1"])
	if err != nil || replayed.Messages.AcceptedCount != 1 || replayed.Messages.LatestVersion != pageBefore.LatestVersion {
		t.Fatalf("replayed provenance result=%#v error=%v", replayed, err)
	}
	pageAfter, _, err := store.ListSessionMessages(ctx, ListSessionMessagesInput{
		WorkspaceID: "ws-1", AgentSessionID: "session-guidance", Order: MessageOrderAsc, Limit: 10,
	})
	if err != nil || len(pageAfter.Messages) != 2 || pageAfter.LatestVersion != pageBefore.LatestVersion {
		t.Fatalf("ListSessionMessages(after replay) page=%#v error=%v", pageAfter, err)
	}
}

func TestReportActivityStateCommitsSessionTurnAndInteractionTogether(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	report := ActivityStateReport{
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
	}
	result, err := store.ReportActivityState(ctx, report)
	if err != nil {
		t.Fatalf("ReportActivityState() error = %v", err)
	}
	if !result.State.Accepted || !result.TurnAccepted || result.InteractionResult != InteractionTransitionApplied {
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

	replayed, err := store.ReportActivityState(ctx, report)
	if err != nil || replayed.InteractionResult != InteractionTransitionAlreadyApplied {
		t.Fatalf("replayed ReportActivityState() result=%#v error=%v", replayed, err)
	}
	conflicting := report
	conflicting.Interaction = &InteractionUpsert{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", RequestID: "request-1",
		TurnID: "turn-1", Kind: InteractionKindQuestion, Status: InteractionStatusPending,
		Input: map[string]any{"question": "changed identity"}, OccurredAtUnixMS: 100,
	}
	if _, err := store.ReportActivityState(ctx, conflicting); err == nil {
		t.Fatal("conflicting ReportActivityState() error = nil")
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
		}); err != nil || accepted != InteractionTransitionApplied {
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
	}); err != nil || accepted != InteractionTransitionApplied {
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

func TestUpsertInteractionDistinguishesReplayFromConflictAndPreservesFirstTerminal(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")

	base := InteractionUpsert{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", RequestID: "request-1",
		TurnID: "turn-1", Kind: InteractionKindQuestion, Status: InteractionStatusPending,
		ToolName: "AskUserQuestion", Input: map[string]any{"question": "Scope?"},
		Metadata: map[string]any{"source": "provider"}, OccurredAtUnixMS: 100,
	}
	if _, result, err := store.UpsertInteraction(ctx, base); err != nil || result != InteractionTransitionApplied {
		t.Fatalf("first pending result=%v error=%v", result, err)
	}
	if _, result, err := store.UpsertInteraction(ctx, base); err != nil || result != InteractionTransitionAlreadyApplied {
		t.Fatalf("pending replay result=%v error=%v", result, err)
	}

	answered := base
	answered.Status = InteractionStatusAnswered
	answered.Output = map[string]any{"answer": "workspace"}
	answered.OccurredAtUnixMS = 200
	if _, result, err := store.UpsertInteraction(ctx, answered); err != nil || result != InteractionTransitionApplied {
		t.Fatalf("answered result=%v error=%v", result, err)
	}

	lateSuperseded := base
	lateSuperseded.Status = InteractionStatusSuperseded
	lateSuperseded.OccurredAtUnixMS = 300
	interaction, result, err := store.UpsertInteraction(ctx, lateSuperseded)
	if err != nil || result != InteractionTransitionAlreadyApplied {
		t.Fatalf("late superseded result=%v error=%v", result, err)
	}
	if interaction.Status != InteractionStatusAnswered || interaction.Output["answer"] != "workspace" {
		t.Fatalf("terminal interaction = %#v, want first answered terminal preserved", interaction)
	}

	conflict := base
	conflict.Input = map[string]any{"question": "Different identity?"}
	if _, result, err := store.UpsertInteraction(ctx, conflict); err != nil || result != InteractionTransitionConflict {
		t.Fatalf("identity conflict result=%v error=%v", result, err)
	}
}

func TestUpsertInteractionConflictsWhenImmutableIdentityChanges(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	seedTurnTestSession(t, store, "ws-1", "session-1")

	for _, input := range []struct {
		occurred   int64
		question   string
		wantResult InteractionTransitionResult
	}{
		{occurred: 200, question: "new", wantResult: InteractionTransitionApplied},
		{occurred: 100, question: "old", wantResult: InteractionTransitionConflict},
	} {
		_, result, err := store.UpsertInteraction(ctx, InteractionUpsert{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", RequestID: "request-1",
			TurnID: "turn-1", Kind: InteractionKindQuestion, Status: InteractionStatusPending,
			Input: map[string]any{"question": input.question}, OccurredAtUnixMS: input.occurred,
		})
		if err != nil || result != input.wantResult {
			t.Fatalf("UpsertInteraction(%d) result=%v error=%v", input.occurred, result, err)
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
		if err != nil || accepted != InteractionTransitionApplied || interaction.TurnID != turnID {
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
