package agentruntime

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestControllerCancelStopsBackgroundTurn(t *testing.T) {
	t.Parallel()

	transport := newScriptedACPTransport()
	transport.conn.promptPermission = true
	controller := NewDefaultControllerWithProcessTransport(nil, transport)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:   "room-1",
		Provider: ProviderCodex,
		CWD:      "/workspace",
		Title:    "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()
	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run tests"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	waitForPublishedSessionEvent(t, events, EventCallStarted, "approval", "waiting_approval")

	if _, err := controller.Cancel(context.Background(), rootCancelInput("room-1", started.Session.AgentSessionID, execResult.TurnID, "user")); err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if _, err := controller.SubmitInteractive(context.Background(), SubmitInteractiveInput{
		RoomID:             "room-1",
		RootAgentSessionID: started.Session.AgentSessionID,
		AgentSessionID:     started.Session.AgentSessionID,
		TurnID:             execResult.TurnID,
		RequestID:          "permission-1",
		OptionID:           "allow_once",
	}); !errors.Is(err, ErrInteractiveRequestNotLive) {
		t.Fatalf("SubmitInteractive after cancel error = %v, want ErrInteractiveRequestNotLive", err)
	}
}

// steeringAsyncExecAdapter mirrors CodexAppServerAdapter.steerActiveTurn: the
// prompt is steered into an already-running provider turn, so ExecAsync emits
// only the steered user message for the new turn id and no terminal event ever
// arrives for it.
// The runtime can own cancellable work the controller's turn registry does
// not know about - linked child agents outliving their parent turn, or a
// desynced turn record. Cancel must reconcile with the adapter instead of
// skipping ("cancel skipped because no active turn exists" band-aid).
func TestControllerCancelWithoutTurnRecordReconcilesWithAdapter(t *testing.T) {
	t.Parallel()

	adapter := &cancelReconcileAdapter{}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// No Exec ran: the controller holds no turn record, but the adapter still
	// has running children to stop.
	result, err := controller.Cancel(context.Background(), rootCancelInput("room-1", started.Session.AgentSessionID, "turn-1", "user requested"))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if adapter.cancelCalls.Load() != 1 {
		t.Fatalf("adapter cancel calls = %d, want 1 (reconcile must reach the adapter)", adapter.cancelCalls.Load())
	}
	if !result.Canceled {
		t.Fatalf("result = %#v, want Canceled=true when the adapter stopped work", result)
	}
}

// When neither the controller nor the adapter has anything to cancel, the
// reconciled path still answers calmly.
func TestControllerCancelWithoutAnyWorkReturnsNotCanceled(t *testing.T) {
	t.Parallel()

	adapter := &cancelReconcileAdapter{empty: true}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	result, err := controller.Cancel(context.Background(), rootCancelInput("room-1", started.Session.AgentSessionID, "turn-1", ""))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if adapter.cancelCalls.Load() != 1 {
		t.Fatalf("adapter cancel calls = %d, want 1", adapter.cancelCalls.Load())
	}
	if result.Canceled {
		t.Fatalf("result = %#v, want Canceled=false when nothing was running", result)
	}
}

func TestControllerExactCancelReportsTargetAbsentWithoutTurnRegistryRecord(t *testing.T) {
	t.Parallel()

	adapter := &cancelReconcileAdapter{empty: true}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-1", AgentSessionID: "agent-session-1", Provider: ProviderCodex, Title: "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	result, err := controller.Cancel(context.Background(), rootCancelInput("room-1", started.Session.AgentSessionID, "turn-1", ""))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if result.Canceled || !result.TargetAbsent {
		t.Fatalf("result = %#v, want exact target absent evidence", result)
	}
	if adapter.cancelCalls.Load() != 1 {
		t.Fatalf("adapter cancel calls = %d, want 1", adapter.cancelCalls.Load())
	}
}

func TestControllerCancelPreservesActiveTurnWhenProviderStateIsLost(t *testing.T) {
	t.Parallel()

	adapter := &cancelReconcileAdapter{err: ErrProviderStateLost}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID: "room-1", AgentSessionID: "agent-session-1", Provider: ProviderCodex, Title: "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	_, cancel := context.WithCancel(context.Background())
	if _, err := controller.beginTurn(started.Session, "turn-1", cancel); err != nil {
		t.Fatalf("beginTurn: %v", err)
	}

	result, err := controller.Cancel(context.Background(), rootCancelInput("room-1", started.Session.AgentSessionID, "turn-1", "user requested"))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if !result.ProviderStateLost || result.Canceled || result.TargetAbsent {
		t.Fatalf("result = %#v, want provider state loss without cancellation", result)
	}
	if _, ok := controller.activeTurn("room-1", started.Session.AgentSessionID); !ok {
		t.Fatal("active turn was cleared after provider state loss")
	}
}

type cancelReconcileAdapter struct {
	cancelCalls atomic.Int64
	empty       bool
	err         error
}

func (*cancelReconcileAdapter) Provider() string { return ProviderCodex }

func (*cancelReconcileAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (*cancelReconcileAdapter) Resume(context.Context, Session) error { return nil }

func (*cancelReconcileAdapter) Close(context.Context, Session) error { return nil }

func (*cancelReconcileAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *cancelReconcileAdapter) Cancel(_ context.Context, session Session, _ string) ([]activityshared.Event, error) {
	a.cancelCalls.Add(1)
	if a.err != nil {
		return nil, a.err
	}
	if a.empty {
		return nil, ErrSessionNoActiveTurn
	}
	// Shape produced by interruptLinkedChildThreads: a non-terminal child
	// cancellation request while provider confirmation is still pending.
	return []activityshared.Event{
		newTurnActivityEvent(session, EventTurnUpdated, "turn-1", SessionStatusWaiting, "", "", map[string]any{"cancelRequested": true}),
	}, nil
}

type noActiveTurnCancelAdapter struct {
	cancelCalls atomic.Int32
}

func (*noActiveTurnCancelAdapter) Provider() string { return ProviderCodex }

func (*noActiveTurnCancelAdapter) Start(_ context.Context, session Session) ([]activityshared.Event, error) {
	return []activityshared.Event{newSessionActivityEvent(session, EventSessionStarted, SessionStatusReady, nil)}, nil
}

func (*noActiveTurnCancelAdapter) Resume(context.Context, Session) error { return nil }

func (*noActiveTurnCancelAdapter) Close(context.Context, Session) error { return nil }

func (*noActiveTurnCancelAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *noActiveTurnCancelAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	a.cancelCalls.Add(1)
	return nil, ErrSessionNoActiveTurn
}

func TestControllerCancelTreatsNoActiveTurnAfterSettleAsIdempotent(t *testing.T) {
	t.Parallel()

	adapter := &noActiveTurnCancelAdapter{}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Codex",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	turnID := "turn-1"
	_, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := controller.beginTurn(started.Session, turnID, cancel); err != nil {
		t.Fatalf("beginTurn: %v", err)
	}
	outcome := string(activityshared.TurnOutcomeInterrupted)
	settled := started.Session
	settled.Status = SessionStatusCanceled
	settled.TurnLifecycle = &TurnLifecycle{Phase: "settled", Outcome: &outcome}
	settled.SubmitAvailability = availableSubmitAvailability()
	controller.store(settled)

	result, err := controller.Cancel(context.Background(), rootCancelInput("room-1", started.Session.AgentSessionID, turnID, "user_interrupt"))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if result.Canceled || !result.TargetAbsent {
		t.Fatalf("Cancel result = %#v, want provider target absent evidence", result)
	}
	if adapter.cancelCalls.Load() != 1 {
		t.Fatalf("adapter cancel calls = %d, want 1", adapter.cancelCalls.Load())
	}
	if _, ok := controller.activeTurn("room-1", started.Session.AgentSessionID); ok {
		t.Fatal("active turn record survived idempotent no-active-turn cancel")
	}
}

// TestControllerCancelLeavesSettledSessionUntouched guards against the
// reconciliation disturbing healthy sessions: a session that is already settled
// must not be re-settled or re-reported when stop is pressed with no active turn.
func TestControllerCancelLeavesSettledSessionUntouched(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, reporter)

	outcome := "completed"
	controller.store(Session{
		RoomID:             "room-1",
		AgentSessionID:     "agent-1",
		Provider:           ProviderCodex,
		ProviderSessionID:  "prov-1",
		Status:             SessionStatusReady,
		TurnLifecycle:      &TurnLifecycle{Phase: "settled", Outcome: &outcome},
		SubmitAvailability: availableSubmitAvailability(),
		UpdatedAtUnixMS:    1,
	})

	if _, err := controller.Cancel(context.Background(), rootCancelInput("room-1", "agent-1", "turn-1", "user")); err != nil {
		t.Fatalf("Cancel: %v", err)
	}

	if calls := reporter.snapshot(); len(calls) != 0 {
		t.Fatalf("reporter calls = %d, want 0 for an already-settled session", len(calls))
	}
}
