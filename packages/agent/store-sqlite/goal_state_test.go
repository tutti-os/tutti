package storesqlite

import (
	"context"
	"errors"
	"sync"
	"testing"
)

func TestListSessionGoalStatesReturnsRequestedRowsInOneRead(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	for index, sessionID := range []string{"session-1", "session-2"} {
		if _, err := store.ReportSessionState(ctx, SessionStateReport{
			AgentSessionID:   sessionID,
			OccurredAtUnixMS: int64(index + 1),
			Provider:         "codex",
			WorkspaceID:      "workspace-goal-list",
		}); err != nil {
			t.Fatal(err)
		}
		if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
			Action:           "set",
			AgentSessionID:   sessionID,
			Objective:        "ship " + sessionID,
			OccurredAtUnixMS: int64(index + 10),
			OperationID:      "goal-" + sessionID,
			WorkspaceID:      "workspace-goal-list",
		}); err != nil {
			t.Fatal(err)
		}
	}

	states, err := store.ListSessionGoalStates(ctx, " workspace-goal-list ", []string{
		" session-2 ", "session-missing", "session-1", "session-2", "",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(states) != 2 ||
		states["session-1"].PendingOperationID != "goal-session-1" ||
		states["session-2"].PendingOperationID != "goal-session-2" {
		t.Fatalf("states = %#v", states)
	}
}

func TestProviderGoalAdoptionCompletesWithoutProviderRedispatch(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-provider", AgentSessionID: "session-provider",
		Provider: "codex", ProviderSessionID: "thread-provider", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	input := ProviderGoalAdoption{
		OperationID: "goal-provider-1", WorkspaceID: "ws-provider", AgentSessionID: "session-provider",
		ClientSubmitID: "provider-goal:thread-provider:fingerprint-1",
		Goal: map[string]any{
			"threadId": "thread-provider", "objective": "continue autonomously",
			"status": "active", "createdAt": int64(10), "updatedAt": int64(20),
		},
		Evidence: map[string]any{
			"source": "provider_goal_adoption", "fingerprint": "fingerprint-1",
		},
		OccurredAtUnixMS: 20,
	}
	op, state, changed, err := store.AdoptProviderGoalOperation(ctx, input)
	if err != nil || !changed {
		t.Fatalf("adopt operation=%#v state=%#v changed=%v error=%v", op, state, changed, err)
	}
	if op.Status != GoalOperationStatusCompleted || op.ProviderPhase != GoalProviderPhaseApplied ||
		op.GoalRevision != 1 || state.Revision != 1 ||
		state.SyncStatus != GoalSyncStatusSynced || state.PendingOperationID != "" ||
		state.Desired["objective"] != "continue autonomously" ||
		state.Observed["objective"] != "continue autonomously" ||
		jsonMapInt64(state.Observed, "startedAtUnixMs") != 20 {
		t.Fatalf("adopted operation=%#v state=%#v", op, state)
	}
	claimable, err := store.ListClaimableGoalControlOperations(ctx, ListClaimableGoalControlOperationsInput{
		NowUnixMS: 30,
	})
	if err != nil || len(claimable) != 0 {
		t.Fatalf("adopted operation scheduled provider work: claimable=%#v error=%v", claimable, err)
	}

	replayed, replayedState, changed, err := store.AdoptProviderGoalOperation(ctx, input)
	if err != nil || changed || replayed.OperationID != op.OperationID ||
		replayedState.Revision != state.Revision {
		t.Fatalf("replay operation=%#v state=%#v changed=%v error=%v", replayed, replayedState, changed, err)
	}
}

func TestProviderGoalAdoptionRejectsConflictingActiveGeneration(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-provider-conflict", AgentSessionID: "session-provider-conflict",
		Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.AdoptProviderGoalOperation(ctx, ProviderGoalAdoption{
		OperationID: "goal-provider-first", WorkspaceID: "ws-provider-conflict",
		AgentSessionID: "session-provider-conflict", ClientSubmitID: "provider-first",
		Goal:             map[string]any{"objective": "first", "status": "active"},
		OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	_, _, _, err := store.AdoptProviderGoalOperation(ctx, ProviderGoalAdoption{
		OperationID: "goal-provider-same-objective", WorkspaceID: "ws-provider-conflict",
		AgentSessionID: "session-provider-conflict", ClientSubmitID: "provider-same-objective",
		ExpectedRevision: 1,
		Goal:             map[string]any{"objective": "first", "status": "active"},
		OccurredAtUnixMS: 25,
	})
	if !errors.Is(err, ErrGoalOperationConflict) {
		t.Fatalf("same-objective generation replacement error = %v", err)
	}
	_, _, _, err = store.AdoptProviderGoalOperation(ctx, ProviderGoalAdoption{
		OperationID: "goal-provider-second", WorkspaceID: "ws-provider-conflict",
		AgentSessionID: "session-provider-conflict", ClientSubmitID: "provider-second",
		ExpectedRevision: 1,
		Goal:             map[string]any{"objective": "second", "status": "active"},
		OccurredAtUnixMS: 30,
	})
	if !errors.Is(err, ErrGoalOperationConflict) {
		t.Fatalf("conflicting adoption error = %v", err)
	}
	if _, err := store.ReconcileSessionGoalObservation(ctx, GoalObservationReconcile{
		WorkspaceID: "ws-provider-conflict", AgentSessionID: "session-provider-conflict",
		Observed: map[string]any{"objective": "first", "status": "completed"},
		Evidence: map[string]any{
			"source": "provider_notification", "operationId": "goal-provider-first", "revision": int64(1),
		},
		OccurredAtUnixMS: 31,
	}); err != nil {
		t.Fatal(err)
	}
	second, secondState, changed, err := store.AdoptProviderGoalOperation(ctx, ProviderGoalAdoption{
		OperationID: "goal-provider-second", WorkspaceID: "ws-provider-conflict",
		AgentSessionID: "session-provider-conflict", ClientSubmitID: "provider-second",
		ExpectedRevision: 1,
		Goal:             map[string]any{"objective": "second", "status": "active"},
		OccurredAtUnixMS: 40,
	})
	if err != nil || !changed || second.GoalRevision != 2 || secondState.Revision != 2 {
		t.Fatalf("terminal advancement operation=%#v state=%#v changed=%v error=%v", second, secondState, changed, err)
	}
	_, _, _, err = store.AdoptProviderGoalOperation(ctx, ProviderGoalAdoption{
		OperationID: "goal-provider-first", WorkspaceID: "ws-provider-conflict",
		AgentSessionID: "session-provider-conflict", ClientSubmitID: "provider-first",
		Goal:             map[string]any{"objective": "first", "status": "active"},
		OccurredAtUnixMS: 50,
	})
	if !errors.Is(err, ErrGoalOperationConflict) {
		t.Fatalf("stale adoption replay error = %v", err)
	}
}

func TestProviderGoalAdoptionAdvancesAfterClearedGeneration(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-provider-cleared", AgentSessionID: "session-provider-cleared",
		Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.AdoptProviderGoalOperation(ctx, ProviderGoalAdoption{
		OperationID: "goal-provider-before-clear", WorkspaceID: "ws-provider-cleared",
		AgentSessionID: "session-provider-cleared", ClientSubmitID: "provider-before-clear",
		Goal:             map[string]any{"objective": "first", "status": "active"},
		OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-provider-clear", WorkspaceID: "ws-provider-cleared",
		AgentSessionID: "session-provider-cleared", ClientSubmitID: "provider-clear",
		Action: "clear", OccurredAtUnixMS: 30,
	}); err != nil {
		t.Fatal(err)
	}
	if _, cleared, changed, err := store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-provider-cleared", OperationID: "goal-provider-clear",
		Succeeded: true, OccurredAtUnixMS: 40,
		Evidence: map[string]any{"source": "provider_ack", "confidence": "authoritative"},
	}); err != nil || !changed || !cleared.Tombstoned || cleared.PendingOperationID != "" {
		t.Fatalf("clear state=%#v changed=%v error=%v", cleared, changed, err)
	}
	next, state, changed, err := store.AdoptProviderGoalOperation(ctx, ProviderGoalAdoption{
		OperationID: "goal-provider-after-clear", WorkspaceID: "ws-provider-cleared",
		AgentSessionID: "session-provider-cleared", ClientSubmitID: "provider-after-clear",
		ExpectedRevision: 2,
		Goal:             map[string]any{"objective": "second", "status": "active"},
		OccurredAtUnixMS: 50,
	})
	if err != nil || !changed || next.GoalRevision != 3 || state.Revision != 3 ||
		state.Tombstoned || state.SyncStatus != GoalSyncStatusSynced {
		t.Fatalf("post-clear adoption operation=%#v state=%#v changed=%v error=%v", next, state, changed, err)
	}
}

func TestProviderGoalAdoptionRejectsObservationQueuedBeforeClear(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-provider-stale", AgentSessionID: "session-provider-stale",
		Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.AdoptProviderGoalOperation(ctx, ProviderGoalAdoption{
		OperationID: "goal-provider-stale-first", WorkspaceID: "ws-provider-stale",
		AgentSessionID: "session-provider-stale", ClientSubmitID: "provider-stale-first",
		Goal:             map[string]any{"objective": "first", "status": "active"},
		OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-provider-stale-clear", WorkspaceID: "ws-provider-stale",
		AgentSessionID: "session-provider-stale", ClientSubmitID: "provider-stale-clear",
		Action: "clear", OccurredAtUnixMS: 30,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-provider-stale", OperationID: "goal-provider-stale-clear",
		Succeeded: true, OccurredAtUnixMS: 40,
		Evidence: map[string]any{"source": "provider_ack", "confidence": "authoritative"},
	}); err != nil {
		t.Fatal(err)
	}
	_, staleState, _, err := store.AdoptProviderGoalOperation(ctx, ProviderGoalAdoption{
		OperationID: "goal-provider-stale-late", WorkspaceID: "ws-provider-stale",
		AgentSessionID: "session-provider-stale", ClientSubmitID: "provider-stale-late",
		ExpectedRevision: 1,
		Goal:             map[string]any{"objective": "first", "status": "active"},
		OccurredAtUnixMS: 50,
	})
	if !errors.Is(err, ErrGoalGenerationSuperseded) {
		t.Fatalf("stale provider adoption error = %v", err)
	}
	if staleState.Revision != 2 || !staleState.Tombstoned || staleState.Desired != nil {
		t.Fatalf("stale provider adoption changed cleared state: %#v", staleState)
	}
}

func TestGoalControlOperationPersistsWithoutTurn(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Provider: "codex",
		RuntimeContext:   map[string]any{"goal": map[string]any{"objective": "old", "status": "active"}},
		OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}

	op, state, created, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-op-1", WorkspaceID: "ws-1", AgentSessionID: "session-1",
		Action: "set", Objective: "ship it", ClientSubmitID: "submit-goal-1", OccurredAtUnixMS: 20,
	})
	if err != nil || !created || op.GoalRevision != 1 || state.Revision != 1 || state.SyncStatus != GoalSyncStatusPending {
		t.Fatalf("prepare op=%#v state=%#v created=%v error=%v", op, state, created, err)
	}
	if state.Desired["objective"] != "ship it" || jsonMapInt64(state.Desired, "startedAtUnixMs") != 20 || state.PendingOperationID != "goal-op-1" {
		t.Fatalf("desired state=%#v", state)
	}
	if op.ClientSubmitID != "submit-goal-1" {
		t.Fatalf("client submit id=%q", op.ClientSubmitID)
	}
	audit, found, err := store.GetGoalControlAudit(ctx, "ws-1", "session-1", "goal-op-1")
	if err != nil || !found {
		t.Fatalf("goal audit found=%v error=%v", found, err)
	}
	if audit.TurnID != "" || audit.Kind != "session_audit" || audit.Role != "user" || audit.OccurredAtUnixMS != 20 {
		t.Fatalf("goal audit=%#v", audit)
	}
	if audit.Payload["text"] != "/goal ship it" || audit.Payload["clientSubmitId"] != "submit-goal-1" ||
		audit.Payload["messageId"] != "client-submit:user:submit-goal-1" || audit.Payload["goalRevision"] != float64(1) {
		t.Fatalf("goal audit payload=%#v", audit.Payload)
	}
	turns, err := store.ListSessionTurns(ctx, "ws-1", "session-1")
	if err != nil || len(turns) != 0 {
		t.Fatalf("goal operation manufactured turns=%#v error=%v", turns, err)
	}

	if _, dispatched, err := store.MarkGoalControlOperationDispatched(ctx, "ws-1", "goal-op-1", 25); err != nil || !dispatched {
		t.Fatalf("dispatch changed=%v error=%v", dispatched, err)
	}
	if applying, found, err := store.GetSessionGoalState(ctx, "ws-1", "session-1"); err != nil || !found || applying.SyncStatus != GoalSyncStatusApplying {
		t.Fatalf("dispatched goal state=%#v found=%v error=%v", applying, found, err)
	}
	changed := false
	op, state, changed, err = store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-1", OperationID: "goal-op-1", Succeeded: true,
		Observed:         map[string]any{"objective": "ship it", "status": "active"},
		Evidence:         map[string]any{"source": "provider_ack", "confidence": "authoritative"},
		ExecutionPending: true,
		OccurredAtUnixMS: 30,
	})
	if err != nil || !changed || op.Status != GoalOperationStatusCompleted || state.SyncStatus != GoalSyncStatusSynced || state.PendingOperationID != "" || !state.ExecutionPending {
		t.Fatalf("complete op=%#v state=%#v changed=%v error=%v", op, state, changed, err)
	}
	if jsonMapInt64(state.Observed, "startedAtUnixMs") != 20 {
		t.Fatalf("completed Goal lost canonical start: %#v", state.Observed)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "invocation-turn-1",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, Origin: TurnOriginUserPrompt,
		SourceGoalOperationID: "goal-op-1", SourceGoalRevision: 1,
		SourceGoalRepairEpoch: 0, OccurredAtUnixMS: 34,
	}); err != nil || !accepted {
		t.Fatalf("record non-Goal Turn accepted=%v error=%v", accepted, err)
	}
	state, found, err = store.GetSessionGoalState(ctx, "ws-1", "session-1")
	if err != nil || !found || !state.ExecutionPending {
		t.Fatalf("non-Goal Turn cleared execution pending: %#v found=%v error=%v", state, found, err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "goal-turn-1",
		Phase: TurnPhaseRunning, Origin: TurnOriginGoalArm,
		SourceGoalOperationID: "goal-op-1", SourceGoalRevision: 1,
		SourceGoalRepairEpoch: 0, OccurredAtUnixMS: 35,
	}); err != nil || !accepted {
		t.Fatalf("record exact Goal Turn accepted=%v error=%v", accepted, err)
	}
	state, found, err = store.GetSessionGoalState(ctx, "ws-1", "session-1")
	if err != nil || !found || state.ExecutionPending {
		t.Fatalf("Goal Turn did not clear execution pending: %#v found=%v error=%v", state, found, err)
	}

	_, cleared, created, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-op-2", WorkspaceID: "ws-1", AgentSessionID: "session-1",
		Action: "clear", OccurredAtUnixMS: 40,
	})
	if err != nil || !created || cleared.Revision != 2 || !cleared.Tombstoned || len(cleared.Desired) != 0 {
		t.Fatalf("clear state=%#v created=%v error=%v", cleared, created, err)
	}
	_, cleared, changed, err = store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-1", OperationID: "goal-op-2", Succeeded: true, OccurredAtUnixMS: 50,
		Evidence: map[string]any{"source": "provider_ack"},
	})
	if err != nil || !changed || cleared.SyncStatus != GoalSyncStatusSynced || len(cleared.Observed) != 0 {
		t.Fatalf("clear completion state=%#v changed=%v error=%v", cleared, changed, err)
	}
}

func TestGoalExecutionPendingAfterObservationRequiresExecutingState(t *testing.T) {
	t.Parallel()
	active := map[string]any{"status": "active"}
	for _, tc := range []struct {
		name       string
		current    bool
		observed   map[string]any
		syncStatus string
		want       bool
	}{
		{name: "applying active", current: true, observed: active, syncStatus: GoalSyncStatusApplying, want: true},
		{name: "synced active", current: true, observed: active, syncStatus: GoalSyncStatusSynced, want: true},
		{name: "unknown active", current: true, observed: active, syncStatus: GoalSyncStatusUnknown},
		{name: "failed active", current: true, observed: active, syncStatus: GoalSyncStatusFailed},
		{name: "diverged active", current: true, observed: active, syncStatus: GoalSyncStatusDiverged},
		{name: "synced complete", current: true, observed: map[string]any{"status": "complete"}, syncStatus: GoalSyncStatusSynced},
		{name: "not previously pending", observed: active, syncStatus: GoalSyncStatusSynced},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := goalExecutionPendingAfterObservation(tc.current, tc.observed, tc.syncStatus); got != tc.want {
				t.Fatalf("goalExecutionPendingAfterObservation() = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestGoalControlLocalStopCompletesClearWithoutClaimingProviderApplication(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-local-stop", AgentSessionID: "session-local-stop", Provider: "codex",
		OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-set", WorkspaceID: "ws-local-stop", AgentSessionID: "session-local-stop",
		Action: "set", Objective: "must remain stopped", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-local-stop", OperationID: "goal-set", Succeeded: true,
		Observed: map[string]any{"objective": "must remain stopped", "status": "active"}, OccurredAtUnixMS: 30,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-clear", WorkspaceID: "ws-local-stop", AgentSessionID: "session-local-stop",
		Action: "clear", ExpectedRevision: 1, OccurredAtUnixMS: 40,
	}); err != nil {
		t.Fatal(err)
	}
	op, state, changed, err := store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-local-stop", OperationID: "goal-clear", Succeeded: true,
		Mode:     GoalControlCompletionModeLocalStop,
		Evidence: map[string]any{"source": "goal_generation_fence_recovery"}, OccurredAtUnixMS: 50,
	})
	if err != nil || !changed {
		t.Fatalf("local stop operation=%#v state=%#v changed=%v error=%v", op, state, changed, err)
	}
	if op.Status != GoalOperationStatusCompleted || op.ProviderPhase != GoalProviderPhaseUnknown ||
		state.Revision != 2 || !state.Tombstoned || state.Desired != nil ||
		state.PendingOperationID != "" || state.SyncStatus != GoalSyncStatusUnknown {
		t.Fatalf("local stop operation=%#v state=%#v", op, state)
	}
	if state.Observed["objective"] != "must remain stopped" || state.ObservedAtUnixMS != 30 {
		t.Fatalf("local stop overwrote provider observation: %#v", state)
	}
}

func TestGoalControlLocalStopConvergesPreviouslyFailedClear(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-local-stop-failed", AgentSessionID: "session-local-stop-failed", Provider: "codex",
		OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-clear-failed", WorkspaceID: "ws-local-stop-failed",
		AgentSessionID: "session-local-stop-failed", Action: "clear", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, failed, changed, err := store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-local-stop-failed", OperationID: "goal-clear-failed",
		LastError: "provider unavailable", OccurredAtUnixMS: 30,
	}); err != nil || !changed || failed.SyncStatus != GoalSyncStatusFailed {
		t.Fatalf("failed clear state=%#v changed=%v error=%v", failed, changed, err)
	}
	op, state, changed, err := store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-local-stop-failed", OperationID: "goal-clear-failed", Succeeded: true,
		Mode: GoalControlCompletionModeLocalStop, OccurredAtUnixMS: 40,
	})
	if err != nil || !changed || op.Status != GoalOperationStatusCompleted ||
		op.ProviderPhase != GoalProviderPhaseUnknown || state.SyncStatus != GoalSyncStatusUnknown ||
		state.PendingOperationID != "" || !state.Tombstoned {
		t.Fatalf("local stop operation=%#v state=%#v changed=%v error=%v", op, state, changed, err)
	}
}

func TestGoalControlLocalStopSupersedesFailedClearAfterNewerGoal(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-local-stop-newer", AgentSessionID: "session-local-stop-newer", Provider: "codex",
		OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "old-clear", WorkspaceID: "ws-local-stop-newer",
		AgentSessionID: "session-local-stop-newer", Action: "clear", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-local-stop-newer", OperationID: "old-clear",
		LastError: "provider unavailable", OccurredAtUnixMS: 30,
	}); err != nil {
		t.Fatal(err)
	}
	newGoal, expectedState, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "new-goal", WorkspaceID: "ws-local-stop-newer",
		AgentSessionID: "session-local-stop-newer", Action: "set", Objective: "new generation",
		OccurredAtUnixMS: 40,
	})
	if err != nil {
		t.Fatal(err)
	}
	op, state, changed, err := store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-local-stop-newer", OperationID: "old-clear", Succeeded: true,
		Mode: GoalControlCompletionModeLocalStop, OccurredAtUnixMS: 50,
	})
	if err != nil || !changed || op.Status != GoalOperationStatusSuperseded ||
		op.ProviderPhase != GoalProviderPhaseUnknown {
		t.Fatalf("superseded local stop operation=%#v changed=%v error=%v", op, changed, err)
	}
	if state.Revision != expectedState.Revision || state.PendingOperationID != newGoal.OperationID ||
		state.Tombstoned || state.SyncStatus != GoalSyncStatusPending ||
		state.Desired["objective"] != "new generation" {
		t.Fatalf("newer Goal was changed by old local stop: %#v", state)
	}
}

func TestGoalAcceptedIgnoresSessionMetadataUntilHostCompletesOperation(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-accepted", AgentSessionID: "session-accepted", Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-op-accepted", WorkspaceID: "ws-accepted", AgentSessionID: "session-accepted",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, changed, err := store.MarkGoalControlOperationDispatched(ctx, "ws-accepted", "goal-op-accepted", 21); err != nil || !changed {
		t.Fatalf("dispatch changed=%v error=%v", changed, err)
	}
	_, state, changed, err := store.AcknowledgeGoalControlOperation(ctx, GoalControlOperationAcknowledge{
		WorkspaceID: "ws-accepted", OperationID: "goal-op-accepted",
		Evidence: map[string]any{"phase": "accepted"}, OccurredAtUnixMS: 22,
		ExecutionPending: true,
	})
	if err != nil || !changed || state.SyncStatus != GoalSyncStatusApplying || state.PendingOperationID != "goal-op-accepted" || !state.ExecutionPending {
		t.Fatalf("ack state=%#v changed=%v error=%v", state, changed, err)
	}
	appliedReport, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-accepted", AgentSessionID: "session-accepted", Provider: "claude-code", OccurredAtUnixMS: 30,
		RuntimeContext: map[string]any{
			"goal": map[string]any{"objective": "ship it", "status": "active"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	assertParticipantMutationKinds(t, appliedReport.CommitDelta,
		MutationEntitySession, MutationEntityGoalState)
	state, found, err := store.GetSessionGoalState(ctx, "ws-accepted", "session-accepted")
	if err != nil || !found || state.SyncStatus != GoalSyncStatusApplying || state.PendingOperationID != "goal-op-accepted" || !state.ExecutionPending {
		t.Fatalf("reported state=%#v found=%v error=%v", state, found, err)
	}
	if jsonMapInt64(state.Observed, "startedAtUnixMs") != 20 {
		t.Fatalf("runtime observation reset Goal start: %#v", state.Observed)
	}
	op, found, err := getGoalControlOperation(ctx, store.db, "ws-accepted", "goal-op-accepted")
	if err != nil || !found || op.Status != GoalOperationStatusDispatched {
		t.Fatalf("reported operation=%#v found=%v error=%v", op, found, err)
	}
	if _, state, changed, err = store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-accepted", OperationID: "goal-op-accepted", Succeeded: true,
		Observed: map[string]any{"objective": "ship it", "status": "active"},
		Evidence: map[string]any{"source": "runtime_goal_control_lifecycle"}, OccurredAtUnixMS: 31,
		ExecutionPending: state.ExecutionPending,
	}); err != nil || !changed || state.SyncStatus != GoalSyncStatusSynced || state.PendingOperationID != "" || !state.ExecutionPending {
		t.Fatalf("completed state=%#v changed=%v error=%v", state, changed, err)
	}
	repair, _, created, err := store.EnsureOrWakeGoalRepairOperation(ctx, EnsureGoalRepairOperationInput{WorkspaceID: "ws-accepted", AgentSessionID: "session-accepted", SourceOperationID: "stale-provider-op", SourceRevision: 0, CurrentRevision: 1, OccurredAtUnixMS: 40})
	if err != nil || !created || repair.RepairEpoch != 1 {
		t.Fatalf("repair=%#v created=%v err=%v", repair, created, err)
	}
	if _, claimed, err := store.ClaimGoalControlOperation(ctx, ClaimGoalControlOperationInput{WorkspaceID: "ws-accepted", OperationID: repair.OperationID, LeaseOwner: "repair-worker", NowUnixMS: 40, LeaseExpiresAtMS: 100}); err != nil || !claimed {
		t.Fatalf("claim=%v err=%v", claimed, err)
	}
	if _, _, err := store.MarkGoalControlOperationDispatched(ctx, "ws-accepted", repair.OperationID, 41); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.AcknowledgeGoalControlOperation(ctx, GoalControlOperationAcknowledge{WorkspaceID: "ws-accepted", OperationID: repair.OperationID, RepairEpoch: 1, OccurredAtUnixMS: 42}); err != nil {
		t.Fatal(err)
	}
	if _, state, changed, err = store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-accepted", OperationID: repair.OperationID, RepairEpoch: 1, Succeeded: true,
		Observed: map[string]any{"objective": "ship it", "status": "active"},
		Evidence: map[string]any{"source": "runtime_goal_control_lifecycle"}, OccurredAtUnixMS: 50,
	}); err != nil || !changed || state.PendingOperationID != "" {
		t.Fatalf("repair completion state=%#v changed=%v error=%v", state, changed, err)
	}
	repair, found, err = store.GetGoalControlOperation(ctx, "ws-accepted", repair.OperationID)
	if err != nil || !found || repair.Status != GoalOperationStatusCompleted {
		t.Fatalf("repair lifecycle=%#v found=%v err=%v", repair, found, err)
	}
}

func TestGoalObservationReconcileDetectsDivergence(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-op-1", WorkspaceID: "ws-1", AgentSessionID: "session-1",
		Action: "set", Objective: "desired", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	state, err := store.ReconcileSessionGoalObservation(ctx, GoalObservationReconcile{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
		Observed: map[string]any{"objective": "different", "status": "active"},
		Evidence: map[string]any{"source": "goal_get"}, OccurredAtUnixMS: 30,
	})
	if err != nil || state.SyncStatus != GoalSyncStatusApplying || state.PendingOperationID != "goal-op-1" {
		t.Fatalf("reconciled state=%#v error=%v", state, err)
	}
	_, state, _, err = store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-1", OperationID: "goal-op-1", Succeeded: true,
		Observed: map[string]any{"objective": "different", "status": "active"},
		Evidence: map[string]any{"source": "goal_get", "confidence": "authoritative"}, OccurredAtUnixMS: 40,
	})
	if err != nil || state.SyncStatus != GoalSyncStatusDiverged || state.PendingOperationID != "" {
		t.Fatalf("completed divergent state=%#v error=%v", state, err)
	}
}

func TestGoalOperationOutboxRecoversPrepareDispatchAcceptAndApplyCrashWindows(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-crash", AgentSessionID: "session-crash", Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-crash", WorkspaceID: "ws-crash", AgentSessionID: "session-crash",
		Action: "clear", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	claimable, err := store.ListClaimableGoalControlOperations(ctx, ListClaimableGoalControlOperationsInput{NowUnixMS: 20})
	if err != nil || len(claimable) != 1 || claimable[0].ProviderPhase != GoalProviderPhasePrepared {
		t.Fatalf("after prepare claimable=%#v error=%v", claimable, err)
	}
	leased, claimed, err := store.ClaimGoalControlOperation(ctx, ClaimGoalControlOperationInput{
		WorkspaceID: "ws-crash", OperationID: "goal-crash", LeaseOwner: "worker-a", NowUnixMS: 20, LeaseExpiresAtMS: 30,
	})
	if err != nil || !claimed || leased.Attempt != 1 {
		t.Fatalf("claim leased=%#v claimed=%v error=%v", leased, claimed, err)
	}
	if _, changed, err := store.MarkGoalControlOperationDispatched(ctx, "ws-crash", "goal-crash", 21); err != nil || !changed {
		t.Fatalf("dispatch changed=%v error=%v", changed, err)
	}
	// An expired in-process lease and an unexpired lease left by a crashed
	// process are both recoverable.
	claimable, err = store.ListClaimableGoalControlOperations(ctx, ListClaimableGoalControlOperationsInput{NowUnixMS: 31})
	if err != nil || len(claimable) != 1 {
		t.Fatalf("expired dispatch claimable=%#v error=%v", claimable, err)
	}
	if _, err := store.RequeueLeasedGoalControlOperationsOnStartup(ctx, 32); err != nil {
		t.Fatal(err)
	}
	if _, claimed, err = store.ClaimGoalControlOperation(ctx, ClaimGoalControlOperationInput{
		WorkspaceID: "ws-crash", OperationID: "goal-crash", LeaseOwner: "worker-b", NowUnixMS: 32, LeaseExpiresAtMS: 50,
	}); err != nil || !claimed {
		t.Fatalf("startup claim claimed=%v error=%v", claimed, err)
	}
	if _, state, changed, err := store.AcknowledgeGoalControlOperation(ctx, GoalControlOperationAcknowledge{
		WorkspaceID: "ws-crash", OperationID: "goal-crash", Evidence: map[string]any{"phase": "accepted"}, OccurredAtUnixMS: 33,
	}); err != nil || !changed || state.SyncStatus != GoalSyncStatusApplying {
		t.Fatalf("accept state=%#v changed=%v error=%v", state, changed, err)
	}
	firstAccepted, _, err := store.GetGoalControlOperation(ctx, "ws-crash", "goal-crash")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.AcknowledgeGoalControlOperation(ctx, GoalControlOperationAcknowledge{WorkspaceID: "ws-crash", OperationID: "goal-crash", OccurredAtUnixMS: 34}); err != nil {
		t.Fatal(err)
	}
	secondAccepted, _, err := store.GetGoalControlOperation(ctx, "ws-crash", "goal-crash")
	if err != nil {
		t.Fatal(err)
	}
	if firstAccepted.AcceptedAtUnixMS != 33 || secondAccepted.AcceptedAtUnixMS != firstAccepted.AcceptedAtUnixMS || secondAccepted.AcceptedAttempt != firstAccepted.AcceptedAttempt {
		t.Fatalf("accepted baseline reset: first=%#v second=%#v", firstAccepted, secondAccepted)
	}
	claimable, err = store.ListClaimableGoalControlOperations(ctx, ListClaimableGoalControlOperationsInput{NowUnixMS: 5034})
	if err != nil || len(claimable) != 1 || claimable[0].ProviderPhase != GoalProviderPhaseAccepted {
		t.Fatalf("accepted recovery claimable=%#v error=%v", claimable, err)
	}
	state, err := store.ReconcileSessionGoalObservation(ctx, GoalObservationReconcile{
		WorkspaceID: "ws-crash", AgentSessionID: "session-crash", Observed: nil,
		Evidence:         map[string]any{"phase": "applied", "operationId": "goal-crash", "revision": int64(1)},
		OccurredAtUnixMS: 5040,
	})
	if err != nil || state.SyncStatus != GoalSyncStatusSynced || state.PendingOperationID != "" {
		t.Fatalf("apply-before-complete recovery state=%#v error=%v", state, err)
	}
	op, found, err := store.GetGoalControlOperation(ctx, "ws-crash", "goal-crash")
	if err != nil || !found || op.Status != GoalOperationStatusCompleted || op.ProviderPhase != GoalProviderPhaseApplied {
		t.Fatalf("recovered op=%#v found=%v error=%v", op, found, err)
	}
}

func TestGoalOperationReleasePreservesPreparedAndDispatchedStatus(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{WorkspaceID: "ws-release-phase", AgentSessionID: "s", Provider: "claude-code", OccurredAtUnixMS: 10}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{OperationID: "op", WorkspaceID: "ws-release-phase", AgentSessionID: "s", Action: "clear", OccurredAtUnixMS: 20}); err != nil {
		t.Fatal(err)
	}
	if _, claimed, err := store.ClaimGoalControlOperation(ctx, ClaimGoalControlOperationInput{WorkspaceID: "ws-release-phase", OperationID: "op", LeaseOwner: "w", NowUnixMS: 20, LeaseExpiresAtMS: 30}); err != nil || !claimed {
		t.Fatal(err)
	}
	op, changed, err := store.ReleaseGoalControlOperation(ctx, ReleaseGoalControlOperationInput{WorkspaceID: "ws-release-phase", OperationID: "op", LeaseOwner: "w", ProviderPhase: GoalProviderPhasePrepared, NowUnixMS: 21, NextAttemptAtMS: 22})
	if err != nil || !changed || op.Status != GoalOperationStatusPrepared {
		t.Fatalf("prepared release=%#v changed=%v err=%v", op, changed, err)
	}
	if _, claimed, err := store.ClaimGoalControlOperation(ctx, ClaimGoalControlOperationInput{WorkspaceID: "ws-release-phase", OperationID: "op", LeaseOwner: "w", NowUnixMS: 22, LeaseExpiresAtMS: 32}); err != nil || !claimed {
		t.Fatal(err)
	}
	if _, _, err := store.MarkGoalControlOperationDispatched(ctx, "ws-release-phase", "op", 23); err != nil {
		t.Fatal(err)
	}
	op, changed, err = store.ReleaseGoalControlOperation(ctx, ReleaseGoalControlOperationInput{WorkspaceID: "ws-release-phase", OperationID: "op", LeaseOwner: "w", ProviderPhase: GoalProviderPhaseDispatched, NowUnixMS: 24, NextAttemptAtMS: 25})
	if err != nil || !changed || op.Status != GoalOperationStatusDispatched {
		t.Fatalf("dispatched release=%#v changed=%v err=%v", op, changed, err)
	}
}

func TestWakeGoalOperationFencesInflightCompletionUntilRepairEpoch(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-repair-fence", AgentSessionID: "session-repair-fence", Provider: "claude-code", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "source-rev-1", WorkspaceID: "ws-repair-fence", AgentSessionID: "session-repair-fence",
		Action: "set", Objective: "old", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "current-rev-2", WorkspaceID: "ws-repair-fence", AgentSessionID: "session-repair-fence",
		Action: "clear", OccurredAtUnixMS: 30,
	}); err != nil {
		t.Fatal(err)
	}
	leased, claimed, err := store.ClaimGoalControlOperation(ctx, ClaimGoalControlOperationInput{
		WorkspaceID: "ws-repair-fence", OperationID: "current-rev-2", LeaseOwner: "worker-old",
		NowUnixMS: 30, LeaseExpiresAtMS: 100,
	})
	if err != nil || !claimed || leased.RepairEpoch != 0 {
		t.Fatalf("claim=%#v claimed=%v err=%v", leased, claimed, err)
	}
	if _, _, err := store.MarkGoalControlOperationDispatched(ctx, "ws-repair-fence", "current-rev-2", 31); err != nil {
		t.Fatal(err)
	}
	woken, changed, err := store.WakeGoalControlOperation(ctx, WakeGoalControlOperationInput{
		WorkspaceID: "ws-repair-fence", OperationID: "current-rev-2", GoalRevision: 2,
		SourceRevision: 1, SourceOperationID: "source-rev-1", OccurredAtUnixMS: 40,
	})
	if err != nil || !changed || !woken.RepairRequired || woken.RepairEpoch != 1 || woken.ProviderPhase != GoalProviderPhasePrepared {
		t.Fatalf("woken=%#v changed=%v err=%v", woken, changed, err)
	}
	if woken.LeaseOwner != "" {
		t.Fatalf("wake retained stale lease: %#v", woken)
	}
	if _, claimed, err := store.ClaimGoalControlOperation(ctx, ClaimGoalControlOperationInput{
		WorkspaceID: "ws-repair-fence", OperationID: "current-rev-2", LeaseOwner: "worker-repair",
		NowUnixMS: 40, LeaseExpiresAtMS: 140,
	}); err != nil || !claimed {
		t.Fatalf("repair was not immediately claimable: claimed=%v err=%v", claimed, err)
	}
	duplicateWake, changed, err := store.WakeGoalControlOperation(ctx, WakeGoalControlOperationInput{
		WorkspaceID: "ws-repair-fence", OperationID: "current-rev-2", GoalRevision: 2,
		SourceRevision: 1, SourceOperationID: "source-rev-1", OccurredAtUnixMS: 41,
	})
	if err != nil || !changed || duplicateWake.RepairEpoch != 1 || duplicateWake.LeaseOwner != "worker-repair" {
		t.Fatalf("duplicate wake changed epoch or lease: op=%#v changed=%v err=%v", duplicateWake, changed, err)
	}
	_, state, changed, err := store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-repair-fence", OperationID: "current-rev-2", Succeeded: true,
		Observed: nil, OccurredAtUnixMS: 42, RepairEpoch: 0,
	})
	if err != nil || changed || state.PendingOperationID != "current-rev-2" || state.SyncStatus != GoalSyncStatusApplying {
		t.Fatalf("old completion state=%#v changed=%v err=%v", state, changed, err)
	}
	_, _, changed, err = store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-repair-fence", OperationID: "current-rev-2", Succeeded: true,
		Observed: nil, OccurredAtUnixMS: 43, RepairEpoch: 1,
	})
	if err != nil || !changed {
		t.Fatalf("repair completion changed=%v err=%v", changed, err)
	}
	state, found, err := store.GetSessionGoalState(ctx, "ws-repair-fence", "session-repair-fence")
	if err != nil || !found || state.PendingOperationID != "" || state.SyncStatus != GoalSyncStatusSynced {
		t.Fatalf("final state=%#v found=%v err=%v", state, found, err)
	}
}

func TestEnsureGoalRepairOperationIsDurableSameRevisionAndIdempotent(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-repair-create", AgentSessionID: "session-repair-create", Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "stale-source", WorkspaceID: "ws-repair-create", AgentSessionID: "session-repair-create",
		Action: "set", Objective: "old", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "clear-rev-2", WorkspaceID: "ws-repair-create", AgentSessionID: "session-repair-create",
		Action: "clear", OccurredAtUnixMS: 30,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-repair-create", OperationID: "clear-rev-2", Succeeded: true,
		Observed: nil, OccurredAtUnixMS: 31,
	}); err != nil {
		t.Fatal(err)
	}
	input := EnsureGoalRepairOperationInput{
		WorkspaceID: "ws-repair-create", AgentSessionID: "session-repair-create",
		SourceOperationID: "stale-source", SourceRevision: 1, CurrentRevision: 2, OccurredAtUnixMS: 40,
	}
	repair, created, err := store.EnsureGoalRepairOperation(ctx, input)
	if err != nil || !created || repair.GoalRevision != 2 || repair.Action != "clear" || !repair.RepairRequired || repair.RepairEpoch != 1 {
		t.Fatalf("repair=%#v created=%v err=%v", repair, created, err)
	}
	duplicate, created, err := store.EnsureGoalRepairOperation(ctx, input)
	if err != nil || created || duplicate.OperationID != repair.OperationID {
		t.Fatalf("duplicate=%#v created=%v err=%v", duplicate, created, err)
	}
	state, found, err := store.GetSessionGoalState(ctx, "ws-repair-create", "session-repair-create")
	if err != nil || !found || state.Revision != 2 || state.PendingOperationID != repair.OperationID || state.SyncStatus != GoalSyncStatusPending {
		t.Fatalf("repair state=%#v found=%v err=%v", state, found, err)
	}
	if _, _, changed, err := store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{
		WorkspaceID: "ws-repair-create", OperationID: repair.OperationID, Succeeded: true,
		Observed: nil, OccurredAtUnixMS: 50, RepairEpoch: repair.RepairEpoch,
	}); err != nil || !changed {
		t.Fatalf("complete repair changed=%v err=%v", changed, err)
	}
	duplicate, created, err = store.EnsureGoalRepairOperation(ctx, input)
	if err != nil || created || duplicate.Status != GoalOperationStatusCompleted {
		t.Fatalf("completed duplicate=%#v created=%v err=%v", duplicate, created, err)
	}
	state, _, _ = store.GetSessionGoalState(ctx, "ws-repair-create", "session-repair-create")
	if state.PendingOperationID != "" || state.SyncStatus != GoalSyncStatusSynced {
		t.Fatalf("completed duplicate reattached repair: %#v", state)
	}
}

func TestEnsureOrWakeRepairAttachesAfterBottomUpCompletionRacesSnapshot(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{WorkspaceID: "ws-repair-race", AgentSessionID: "session-repair-race", Provider: "claude-code", OccurredAtUnixMS: 10}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{OperationID: "current-clear", WorkspaceID: "ws-repair-race", AgentSessionID: "session-repair-race", Action: "clear", OccurredAtUnixMS: 20}); err != nil {
		t.Fatal(err)
	}
	snapshot, _, err := store.GetSessionGoalState(ctx, "ws-repair-race", "session-repair-race")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReconcileSessionGoalObservation(ctx, GoalObservationReconcile{WorkspaceID: "ws-repair-race", AgentSessionID: "session-repair-race", Observed: nil, Evidence: map[string]any{"confidence": "authoritative"}, OccurredAtUnixMS: 30}); err != nil {
		t.Fatal(err)
	}
	repair, state, created, err := store.EnsureOrWakeGoalRepairOperation(ctx, EnsureGoalRepairOperationInput{
		WorkspaceID: snapshot.WorkspaceID, AgentSessionID: snapshot.AgentSessionID,
		SourceOperationID: "stale-source", SourceRevision: 0, CurrentRevision: snapshot.Revision,
		Evidence: map[string]any{"source": "codex_goal_turn_provenance", "missingSource": true}, OccurredAtUnixMS: 40,
	})
	if err != nil || !created || repair.GoalRevision != snapshot.Revision || state.PendingOperationID != repair.OperationID || state.SyncStatus != GoalSyncStatusPending {
		t.Fatalf("repair=%#v state=%#v created=%v err=%v", repair, state, created, err)
	}
	if repair.Evidence["source"] != "codex_goal_turn_provenance" || repair.Evidence["missingSource"] != true {
		t.Fatalf("repair evidence=%#v", repair.Evidence)
	}
}

func TestGoalStateV3MigratesExistingV2OperationsAndRemovesRevisionUniqueness(t *testing.T) {
	t.Parallel()
	db := openTestDB(t)
	store := New(db, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `
CREATE TABLE agent_store_schema_migrations (id TEXT PRIMARY KEY, applied_at_unix_ms INTEGER NOT NULL);
CREATE TABLE workspace_agent_sessions (
  workspace_id TEXT NOT NULL, agent_session_id TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id)
);
INSERT INTO workspace_agent_sessions VALUES ('ws-v2', 'session-v2');
CREATE TABLE workspace_agent_goal_control_operations (
  operation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  goal_revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  objective TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  last_error TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  completed_at_unix_ms INTEGER,
  provider_phase TEXT NOT NULL DEFAULT 'prepared',
  lease_owner TEXT,
  lease_expires_at_unix_ms INTEGER,
  next_attempt_at_unix_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  UNIQUE (workspace_id, agent_session_id, goal_revision),
  FOREIGN KEY (workspace_id, agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id) ON DELETE CASCADE
);
INSERT INTO workspace_agent_goal_control_operations (
  operation_id, workspace_id, agent_session_id, goal_revision, action, status,
  evidence_json, created_at_unix_ms, updated_at_unix_ms, provider_phase,
  attempt
) VALUES ('v2-original', 'ws-v2', 'session-v2', 1, 'clear', 'completed',
          '{"source":"v2"}', 10, 11, 'applied', 2);
`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentGoalStateV3(ctx); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentGoalStateV4(ctx); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentGoalStateV5(ctx); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentGoalStateV7(ctx); err != nil {
		t.Fatal(err)
	}
	op, found, err := store.GetGoalControlOperation(ctx, "ws-v2", "v2-original")
	if err != nil || !found || op.Attempt != 2 || op.RepairRequired || op.RepairEpoch != 0 || op.Evidence["source"] != "v2" {
		t.Fatalf("migrated operation=%#v found=%v err=%v", op, found, err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO workspace_agent_goal_control_operations (
  operation_id, workspace_id, agent_session_id, goal_revision, action, status,
  created_at_unix_ms, updated_at_unix_ms
) VALUES ('v3-repair', 'ws-v2', 'session-v2', 1, 'clear', 'prepared', 20, 20)`); err != nil {
		t.Fatalf("same-revision repair insert after V3: %v", err)
	}
	if err := store.applyWorkspaceAgentGoalStateV3(ctx); err != nil {
		t.Fatalf("idempotent V3 migration: %v", err)
	}
}

func TestGoalStateV7PersistsClientSubmitIdentityAcrossRecoveryReads(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db := openTestDB(t)
	store := New(db, testOptions(&staticProjectPaths{}))
	if _, err := db.ExecContext(ctx, `
CREATE TABLE agent_store_schema_migrations(id TEXT PRIMARY KEY,applied_at_unix_ms INTEGER NOT NULL);
CREATE TABLE workspace_agent_goal_control_operations(operation_id TEXT PRIMARY KEY);
INSERT INTO workspace_agent_goal_control_operations VALUES('legacy');
`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentGoalStateV7(ctx); err != nil {
		t.Fatal(err)
	}
	var clientSubmitID string
	if err := db.QueryRowContext(ctx, `SELECT client_submit_id FROM workspace_agent_goal_control_operations WHERE operation_id='legacy'`).Scan(&clientSubmitID); err != nil || clientSubmitID != "" {
		t.Fatalf("legacy client submit id=%q err=%v", clientSubmitID, err)
	}
	if err := store.applyWorkspaceAgentGoalStateV7(ctx); err != nil {
		t.Fatalf("idempotent V7: %v", err)
	}
}

func TestGoalStateV4UpgradesExistingV3AcceptedBaseline(t *testing.T) {
	t.Parallel()
	db := openTestDB(t)
	store := New(db, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE TABLE agent_store_schema_migrations (id TEXT PRIMARY KEY, applied_at_unix_ms INTEGER NOT NULL);
CREATE TABLE workspace_agent_goal_control_operations (
 operation_id TEXT PRIMARY KEY, provider_phase TEXT NOT NULL,
 updated_at_unix_ms INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 0
);
INSERT INTO workspace_agent_goal_control_operations VALUES ('accepted-v3','accepted',1234,7);
INSERT INTO workspace_agent_goal_control_operations VALUES ('dispatched-v3','dispatched',2345,9);
INSERT INTO agent_store_schema_migrations VALUES ('workspace_agent_goal_state_v3',1);`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentGoalStateV4(ctx); err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"accepted_at_unix_ms", "accepted_attempt"} {
		exists, err := store.hasColumn(ctx, "workspace_agent_goal_control_operations", column)
		if err != nil || !exists {
			t.Fatalf("column=%s exists=%v err=%v", column, exists, err)
		}
	}
	var acceptedAt int64
	var acceptedAttempt int
	if err := db.QueryRowContext(ctx, `SELECT accepted_at_unix_ms, accepted_attempt FROM workspace_agent_goal_control_operations WHERE operation_id='accepted-v3'`).Scan(&acceptedAt, &acceptedAttempt); err != nil || acceptedAt != 1234 || acceptedAttempt != 7 {
		t.Fatalf("accepted backfill at=%d attempt=%d err=%v", acceptedAt, acceptedAttempt, err)
	}
	var dispatchedAt any
	if err := db.QueryRowContext(ctx, `SELECT accepted_at_unix_ms FROM workspace_agent_goal_control_operations WHERE operation_id='dispatched-v3'`).Scan(&dispatchedAt); err != nil || dispatchedAt != nil {
		t.Fatalf("non-accepted row backfilled: value=%#v err=%v", dispatchedAt, err)
	}
	if err := store.applyWorkspaceAgentGoalStateV4(ctx); err != nil {
		t.Fatalf("idempotent V4: %v", err)
	}
}

func TestGoalStateV5BackfillsDispatchBaselineAndFirstDispatchStartsFresh(t *testing.T) {
	t.Parallel()
	ctx := context.Background()
	db := openTestDB(t)
	store := New(db, testOptions(&staticProjectPaths{}))
	if _, err := db.ExecContext(ctx, `CREATE TABLE agent_store_schema_migrations(id TEXT PRIMARY KEY,applied_at_unix_ms INTEGER NOT NULL);CREATE TABLE workspace_agent_goal_control_operations(operation_id TEXT PRIMARY KEY,status TEXT NOT NULL,provider_phase TEXT NOT NULL,updated_at_unix_ms INTEGER NOT NULL,attempt INTEGER NOT NULL);INSERT INTO workspace_agent_goal_control_operations VALUES('old','dispatched','accepted',123,7);`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentGoalStateV5(ctx); err != nil {
		t.Fatal(err)
	}
	var at int64
	var attempt int
	if err := db.QueryRowContext(ctx, `SELECT first_dispatched_at_unix_ms,dispatched_attempt FROM workspace_agent_goal_control_operations WHERE operation_id='old'`).Scan(&at, &attempt); err != nil || at != 123 || attempt != 7 {
		t.Fatalf("at=%d attempt=%d err=%v", at, attempt, err)
	}
	full := openTestStore(t, testOptions(&staticProjectPaths{}))
	if _, err := full.ReportSessionState(ctx, SessionStateReport{WorkspaceID: "ws-long-prepared", AgentSessionID: "s", Provider: "claude-code", OccurredAtUnixMS: 10}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := full.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{OperationID: "long", WorkspaceID: "ws-long-prepared", AgentSessionID: "s", Action: "clear", OccurredAtUnixMS: 20}); err != nil {
		t.Fatal(err)
	}
	if _, claimed, err := full.ClaimGoalControlOperation(ctx, ClaimGoalControlOperationInput{WorkspaceID: "ws-long-prepared", OperationID: "long", LeaseOwner: "w", NowUnixMS: 1_000_000, LeaseExpiresAtMS: 1_000_100}); err != nil || !claimed {
		t.Fatal(err)
	}
	op, _, err := full.MarkGoalControlOperationDispatched(ctx, "ws-long-prepared", "long", 1_000_000)
	if err != nil || op.FirstDispatchedAtUnixMS != 1_000_000 || op.DispatchedAttempt != 1 {
		t.Fatalf("op=%#v err=%v", op, err)
	}
}

func TestGoalReconcileCASCompletesAuthoritativeTerminalLifecycleAndIgnoresOldObservation(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-cas", AgentSessionID: "session-cas", Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-cas", WorkspaceID: "ws-cas", AgentSessionID: "session-cas",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	state, err := store.ReconcileSessionGoalObservation(ctx, GoalObservationReconcile{
		WorkspaceID: "ws-cas", AgentSessionID: "session-cas",
		Observed: map[string]any{"objective": "ship it", "status": "limited"},
		Evidence: map[string]any{"source": "goal_get", "confidence": "authoritative"}, OccurredAtUnixMS: 40,
	})
	if err != nil || state.SyncStatus != GoalSyncStatusSynced || state.PendingOperationID != "" {
		t.Fatalf("terminal lifecycle convergence state=%#v error=%v", state, err)
	}
	if jsonMapInt64(state.Observed, "startedAtUnixMs") != 20 || jsonMapInt64(state.Observed, "durationMs") != 20 {
		t.Fatalf("terminal Goal timing=%#v", state.Observed)
	}
	stale, err := store.ReconcileSessionGoalObservation(ctx, GoalObservationReconcile{
		WorkspaceID: "ws-cas", AgentSessionID: "session-cas",
		Observed: map[string]any{"objective": "stale", "status": "active"},
		Evidence: map[string]any{"confidence": "authoritative"}, OccurredAtUnixMS: 30,
	})
	if err != nil || stale.Observed["objective"] != "ship it" || stale.SyncStatus != GoalSyncStatusSynced {
		t.Fatalf("stale observation overwrote state=%#v error=%v", stale, err)
	}
}

func TestGoalReconcileForceUnknownDoesNotClaimConvergence(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-force-unknown", AgentSessionID: "session-force-unknown", Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-force-unknown", WorkspaceID: "ws-force-unknown", AgentSessionID: "session-force-unknown",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	state, err := store.ReconcileSessionGoalObservation(ctx, GoalObservationReconcile{
		WorkspaceID: "ws-force-unknown", AgentSessionID: "session-force-unknown",
		Observed: map[string]any{"objective": "ship it", "status": "active"},
		Evidence: map[string]any{"source": "goal_get", "confidence": "authoritative"}, OccurredAtUnixMS: 30,
	})
	if err != nil || state.SyncStatus != GoalSyncStatusSynced || state.PendingOperationID != "" {
		t.Fatalf("initial convergence state=%#v error=%v", state, err)
	}
	unknown, err := store.ReconcileSessionGoalObservation(ctx, GoalObservationReconcile{
		WorkspaceID: "ws-force-unknown", AgentSessionID: "session-force-unknown",
		Observed:         cloneJSONMap(state.Observed),
		Evidence:         map[string]any{"source": "codex_goal_turn_provenance", "confidence": "unknown"},
		OccurredAtUnixMS: 40,
		Expected: &GoalObservationFence{
			Exists: true, Revision: state.Revision, PendingOperationID: state.PendingOperationID,
			ObservedAtUnixMS: state.ObservedAtUnixMS,
		},
		ForceSyncUnknown: true,
	})
	if err != nil || unknown.SyncStatus != GoalSyncStatusUnknown || unknown.PendingOperationID != "" {
		t.Fatalf("forced unknown state=%#v error=%v", unknown, err)
	}
}

func TestGoalRevisionTerminalFenceCoversAppliedEvidenceCompletionAndNewRevision(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{WorkspaceID: "ws-terminal-fence", AgentSessionID: "session", Provider: "codex", OccurredAtUnixMS: 10}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{OperationID: "goal-1", WorkspaceID: "ws-terminal-fence", AgentSessionID: "session", Action: "set", Objective: "ship", OccurredAtUnixMS: 20}); err != nil {
		t.Fatal(err)
	}
	if _, changed, err := store.MarkGoalControlOperationDispatched(ctx, "ws-terminal-fence", "goal-1", 21); err != nil || !changed {
		t.Fatalf("dispatch changed=%v err=%v", changed, err)
	}
	before, _, _ := store.GetSessionGoalState(ctx, "ws-terminal-fence", "session")
	terminal, err := store.MarkGoalRevisionTerminalIncident(ctx, GoalTerminalIncidentInput{
		WorkspaceID: "ws-terminal-fence", AgentSessionID: "session", Revision: 1, SourceID: "inbox:request-1",
		LastError: "reconcile inbox exhausted", OccurredAtUnixMS: 30,
		Expected: &GoalObservationFence{Exists: true, Revision: 1, PendingOperationID: before.PendingOperationID, ObservedAtUnixMS: before.ObservedAtUnixMS},
	})
	if err != nil || terminal.SyncStatus != GoalSyncStatusUnknown || terminal.PendingOperationID != "" || terminal.LastError == "" {
		t.Fatalf("terminal=%#v err=%v", terminal, err)
	}
	ordinary, err := store.ReconcileSessionGoalObservation(ctx, GoalObservationReconcile{WorkspaceID: "ws-terminal-fence", AgentSessionID: "session", Observed: map[string]any{"objective": "ship", "status": "active"}, Evidence: map[string]any{"confidence": "authoritative"}, OccurredAtUnixMS: 40})
	if err != nil || ordinary.SyncStatus != GoalSyncStatusUnknown || ordinary.LastError == "" {
		t.Fatalf("manual reconcile unlocked terminal=%#v err=%v", ordinary, err)
	}
	// Simulate a stale dispatched owner racing with the terminal transition.
	// Session observation and operation completion must both preserve the
	// terminal revision fence rather than independently claiming synced.
	if _, err := store.db.ExecContext(ctx, `UPDATE workspace_agent_session_goals SET pending_operation_id='goal-1',sync_status='applying' WHERE workspace_id='ws-terminal-fence' AND agent_session_id='session'`); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{WorkspaceID: "ws-terminal-fence", AgentSessionID: "session", Provider: "codex", OccurredAtUnixMS: 50, RuntimeContext: map[string]any{
		"goal": map[string]any{"objective": "ship", "status": "active"},
	}}); err != nil {
		t.Fatal(err)
	}
	afterEvidence, _, _ := store.GetSessionGoalState(ctx, "ws-terminal-fence", "session")
	if afterEvidence.SyncStatus != GoalSyncStatusUnknown || afterEvidence.LastError == "" {
		t.Fatalf("session observation unlocked terminal=%#v", afterEvidence)
	}
	_, completed, changed, err := store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{WorkspaceID: "ws-terminal-fence", OperationID: "goal-1", Succeeded: true, Observed: map[string]any{"objective": "ship", "status": "active"}, OccurredAtUnixMS: 60})
	if err != nil || !changed || completed.SyncStatus != GoalSyncStatusUnknown || completed.LastError == "" {
		t.Fatalf("operation completion unlocked terminal state=%#v changed=%v err=%v", completed, changed, err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{OperationID: "goal-2", WorkspaceID: "ws-terminal-fence", AgentSessionID: "session", Action: "set", Objective: "next", OccurredAtUnixMS: 70}); err != nil {
		t.Fatal(err)
	}
	_, next, changed, err := store.CompleteGoalControlOperation(ctx, GoalControlOperationComplete{WorkspaceID: "ws-terminal-fence", OperationID: "goal-2", Succeeded: true, Observed: map[string]any{"objective": "next", "status": "active"}, OccurredAtUnixMS: 80})
	if err != nil || !changed || next.Revision != 2 || next.SyncStatus != GoalSyncStatusSynced || next.LastError != "" {
		t.Fatalf("new revision did not unlock state=%#v changed=%v err=%v", next, changed, err)
	}
}

func TestGoalReconcileAndClearConcurrentTransitionsKeepNewestRevision(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-concurrent", AgentSessionID: "session-concurrent", Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "goal-set", WorkspaceID: "ws-concurrent", AgentSessionID: "session-concurrent",
		Action: "set", Objective: "ship it", OccurredAtUnixMS: 20,
	}); err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	var wg sync.WaitGroup
	var reconcileErr, clearErr error
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_, reconcileErr = store.ReconcileSessionGoalObservation(ctx, GoalObservationReconcile{
			WorkspaceID: "ws-concurrent", AgentSessionID: "session-concurrent",
			Observed: map[string]any{"objective": "ship it", "status": "active"},
			Evidence: map[string]any{"confidence": "authoritative"}, OccurredAtUnixMS: 30,
		})
	}()
	go func() {
		defer wg.Done()
		<-start
		_, _, _, clearErr = store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
			OperationID: "goal-clear", WorkspaceID: "ws-concurrent", AgentSessionID: "session-concurrent",
			Action: "clear", OccurredAtUnixMS: 31,
		})
	}()
	close(start)
	wg.Wait()
	if reconcileErr != nil || clearErr != nil {
		t.Fatalf("reconcile error=%v clear error=%v", reconcileErr, clearErr)
	}
	state, found, err := store.GetSessionGoalState(ctx, "ws-concurrent", "session-concurrent")
	if err != nil || !found || state.Revision != 2 || !state.Tombstoned || state.PendingOperationID != "goal-clear" ||
		(state.SyncStatus != GoalSyncStatusPending && state.SyncStatus != GoalSyncStatusApplying) {
		t.Fatalf("final state=%#v found=%v error=%v", state, found, err)
	}
}
