package agenthost_test

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type cancelReconciliationClock struct{ at time.Time }

func (c *cancelReconciliationClock) Now() time.Time { return c.at }

type unconfirmedCancelRuntime struct {
	agenthost.RuntimeController

	mu        sync.Mutex
	session   agenthost.ProviderRuntimeSession
	responses []cancelRuntimeResponse
	calls     int
}

type cancelRuntimeResponse struct {
	result agenthost.RuntimeCancelResult
	err    error
}

func (r *unconfirmedCancelRuntime) Session(workspaceID, agentSessionID string) (agenthost.ProviderRuntimeSession, bool) {
	return r.session, workspaceID == r.session.WorkspaceID && agentSessionID == r.session.ID
}

func (r *unconfirmedCancelRuntime) Cancel(context.Context, agenthost.RuntimeCancelInput) (agenthost.RuntimeCancelResult, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	responseIndex := r.calls
	r.calls++
	if responseIndex >= len(r.responses) {
		responseIndex = len(r.responses) - 1
	}
	return r.responses[responseIndex].result, r.responses[responseIndex].err
}

func (r *unconfirmedCancelRuntime) cancelCalls() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.calls
}

func cancelDeliveryUnconfirmed(payload map[string]any) bool {
	value, _ := payload[storesqlite.CancelRuntimeOperationDeliveryUnconfirmedPayloadKey].(bool)
	return value
}

func TestCancelDeliveryUnconfirmedPreservesEarlierCanonicalSuccess(t *testing.T) {
	store := openGoalFenceHostStore(t)
	if _, accepted, err := store.RecordTurnTransition(t.Context(), storesqlite.TurnTransition{
		WorkspaceID: "workspace", AgentSessionID: "session", TurnID: "turn-1",
		Phase: storesqlite.TurnPhaseRunning, OccurredAtUnixMS: 2,
	}); err != nil || !accepted {
		t.Fatalf("seed running turn: accepted=%v err=%v", accepted, err)
	}

	clock := &cancelReconciliationClock{at: time.UnixMilli(1_000)}
	runtime := &unconfirmedCancelRuntime{session: agenthost.ProviderRuntimeSession{
		ID: "session", WorkspaceID: "workspace", Provider: "claude-code",
		ProviderSessionID: "provider-session-1",
	}, responses: []cancelRuntimeResponse{{err: agenthost.ErrRuntimeCancelDeliveryUnconfirmed}}}
	host := agenthost.New(agenthost.Config{
		CanonicalStore: sqliteCanonicalStore{Store: store}, Runtime: runtime,
		RuntimeOperations: store, OperationOwner: "cancel-reconciliation-test", Clock: clock,
	})

	result, err := host.CancelTurn(t.Context(), agenthost.CancelTurnInput{
		WorkspaceID: "workspace", AgentSessionID: "session", TurnID: "turn-1", Reason: "user_requested",
	})
	if !errors.Is(err, agenthost.ErrRuntimeOperationInProgress) || !result.IntentAccepted ||
		result.Operation.Status != storesqlite.RuntimeOperationStatusPrepared || runtime.cancelCalls() != 1 {
		t.Fatalf("initial cancel result=%#v error=%v calls=%d", result, err, runtime.cancelCalls())
	}
	if !cancelDeliveryUnconfirmed(result.Operation.Payload) {
		t.Fatalf("initial cancel payload=%#v, want delivery-unconfirmed marker", result.Operation.Payload)
	}

	if _, accepted, err := store.RecordTurnTransition(t.Context(), storesqlite.TurnTransition{
		WorkspaceID: "workspace", AgentSessionID: "session", TurnID: "turn-1",
		Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 3,
	}); err != nil || !accepted {
		t.Fatalf("record canonical success: accepted=%v err=%v", accepted, err)
	}
	clock.at = time.UnixMilli(2_000)
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatalf("reconcile cancel operation: %v", err)
	}

	operation, found, err := store.GetRuntimeOperation(t.Context(), "workspace", result.Operation.OperationID)
	if err != nil || !found || operation.Status != storesqlite.RuntimeOperationStatusCompleted ||
		operation.Result != storesqlite.RuntimeOperationResultAlreadySettled {
		t.Fatalf("cancel operation=%#v found=%v err=%v", operation, found, err)
	}
	turn, found, err := store.GetTurn(t.Context(), "workspace", "session", "turn-1")
	if err != nil || !found || turn.Phase != storesqlite.TurnPhaseSettled || turn.Outcome != storesqlite.TurnOutcomeCompleted {
		t.Fatalf("canonical turn=%#v found=%v err=%v", turn, found, err)
	}
	if runtime.cancelCalls() != 1 {
		t.Fatalf("runtime cancel calls=%d, want no retry after canonical success", runtime.cancelCalls())
	}
}

func TestCancelDeliveryUnconfirmedDoesNotTreatLaterTargetAbsentAsCanceled(t *testing.T) {
	store := openGoalFenceHostStore(t)
	if _, accepted, err := store.RecordTurnTransition(t.Context(), storesqlite.TurnTransition{
		WorkspaceID: "workspace", AgentSessionID: "session", TurnID: "turn-1",
		Phase: storesqlite.TurnPhaseRunning, OccurredAtUnixMS: 2,
	}); err != nil || !accepted {
		t.Fatalf("seed running turn: accepted=%v err=%v", accepted, err)
	}

	clock := &cancelReconciliationClock{at: time.UnixMilli(1_000)}
	runtime := &unconfirmedCancelRuntime{session: agenthost.ProviderRuntimeSession{
		ID: "session", WorkspaceID: "workspace", Provider: "claude-code",
		ProviderSessionID: "provider-session-1",
	}, responses: []cancelRuntimeResponse{
		{err: agenthost.ErrRuntimeCancelDeliveryUnconfirmed},
		{result: agenthost.RuntimeCancelResult{AgentSessionID: "session", TargetAbsent: true}},
	}}
	host := agenthost.New(agenthost.Config{
		CanonicalStore: sqliteCanonicalStore{Store: store}, Runtime: runtime,
		RuntimeOperations: store, OperationOwner: "cancel-reconciliation-test", Clock: clock,
	})

	result, err := host.CancelTurn(t.Context(), agenthost.CancelTurnInput{
		WorkspaceID: "workspace", AgentSessionID: "session", TurnID: "turn-1", Reason: "user_requested",
	})
	if !errors.Is(err, agenthost.ErrRuntimeOperationInProgress) || !result.IntentAccepted || runtime.cancelCalls() != 1 {
		t.Fatalf("initial cancel result=%#v error=%v calls=%d", result, err, runtime.cancelCalls())
	}

	clock.at = time.UnixMilli(2_000)
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatalf("retry target-absent cancel operation: %v", err)
	}
	operation, found, err := store.GetRuntimeOperation(t.Context(), "workspace", result.Operation.OperationID)
	if err != nil || !found || operation.Status != storesqlite.RuntimeOperationStatusPrepared ||
		!cancelDeliveryUnconfirmed(operation.Payload) {
		t.Fatalf("target-absent operation=%#v found=%v err=%v", operation, found, err)
	}
	turn, found, err := store.GetTurn(t.Context(), "workspace", "session", "turn-1")
	if err != nil || !found || turn.Phase != storesqlite.TurnPhaseRunning {
		t.Fatalf("target-absent turn=%#v found=%v err=%v", turn, found, err)
	}
	if runtime.cancelCalls() != 2 {
		t.Fatalf("runtime cancel calls=%d, want 2", runtime.cancelCalls())
	}

	if _, accepted, err := store.RecordTurnTransition(t.Context(), storesqlite.TurnTransition{
		WorkspaceID: "workspace", AgentSessionID: "session", TurnID: "turn-1",
		Phase: storesqlite.TurnPhaseSettled, Outcome: storesqlite.TurnOutcomeCompleted, OccurredAtUnixMS: 3,
	}); err != nil || !accepted {
		t.Fatalf("record canonical success: accepted=%v err=%v", accepted, err)
	}
	clock.at = time.UnixMilli(4_000)
	if err := host.StepRuntimeOperationWorker(t.Context(), false); err != nil {
		t.Fatalf("finish cancel operation from canonical success: %v", err)
	}
	operation, found, err = store.GetRuntimeOperation(t.Context(), "workspace", result.Operation.OperationID)
	if err != nil || !found || operation.Status != storesqlite.RuntimeOperationStatusCompleted ||
		operation.Result != storesqlite.RuntimeOperationResultAlreadySettled {
		t.Fatalf("completed operation=%#v found=%v err=%v", operation, found, err)
	}
	turn, found, err = store.GetTurn(t.Context(), "workspace", "session", "turn-1")
	if err != nil || !found || turn.Phase != storesqlite.TurnPhaseSettled || turn.Outcome != storesqlite.TurnOutcomeCompleted {
		t.Fatalf("canonical turn=%#v found=%v err=%v", turn, found, err)
	}
	if runtime.cancelCalls() != 2 {
		t.Fatalf("runtime cancel calls=%d, want no third cancellation", runtime.cancelCalls())
	}
}

func TestCancelProviderStateLostFailsClosedWithUnknownExecutionStatus(t *testing.T) {
	store := openGoalFenceHostStore(t)
	if _, accepted, err := store.RecordTurnTransition(t.Context(), storesqlite.TurnTransition{
		WorkspaceID: "workspace", AgentSessionID: "session", TurnID: "turn-1",
		Phase: storesqlite.TurnPhaseRunning, OccurredAtUnixMS: 2,
	}); err != nil || !accepted {
		t.Fatalf("seed running turn: accepted=%v err=%v", accepted, err)
	}

	runtime := &unconfirmedCancelRuntime{
		session: storesqliteProviderRuntimeSession("workspace", "session"),
		responses: []cancelRuntimeResponse{{result: agenthost.RuntimeCancelResult{
			AgentSessionID: "session", ProviderStateLost: true,
		}}},
	}
	host := agenthost.New(agenthost.Config{
		CanonicalStore: sqliteCanonicalStore{Store: store}, Runtime: runtime,
		RuntimeOperations: store, OperationOwner: "cancel-provider-state-lost-test",
	})

	result, err := host.CancelTurn(t.Context(), agenthost.CancelTurnInput{
		WorkspaceID: "workspace", AgentSessionID: "session", TurnID: "turn-1", Reason: "user_requested",
	})
	if err != nil || !result.Settled || result.Outcome != storesqlite.TurnOutcomeFailed {
		t.Fatalf("cancel result=%#v err=%v, want settled failed turn", result, err)
	}
	turn, found, err := store.GetTurn(t.Context(), "workspace", "session", "turn-1")
	if err != nil || !found || turn.Phase != storesqlite.TurnPhaseSettled ||
		turn.Outcome != storesqlite.TurnOutcomeFailed || turn.ErrorCode != "execution_status_unknown" {
		t.Fatalf("canonical turn=%#v found=%v err=%v", turn, found, err)
	}
}

func storesqliteProviderRuntimeSession(workspaceID, sessionID string) agenthost.ProviderRuntimeSession {
	return agenthost.ProviderRuntimeSession{
		ID: sessionID, WorkspaceID: workspaceID, Provider: "claude-code",
		ProviderSessionID: "provider-session-1",
	}
}
