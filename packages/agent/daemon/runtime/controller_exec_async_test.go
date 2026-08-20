package agentruntime

import (
	"context"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type emittingErrorAdapter struct{}

func (emittingErrorAdapter) Provider() string { return ProviderCodex }

func (emittingErrorAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (emittingErrorAdapter) Resume(context.Context, Session) error {
	return nil
}

func (emittingErrorAdapter) Close(context.Context, Session) error {
	return nil
}

func (emittingErrorAdapter) Exec(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	emit([]activityshared.Event{newTurnActivityEvent(session, EventTurnStarted, turnID, SessionStatusWorking, "", "", nil)})
	return nil, context.Canceled
}

func (emittingErrorAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

type workingOnlyAdapter struct{}

func (workingOnlyAdapter) Provider() string { return ProviderCodex }

func (workingOnlyAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (workingOnlyAdapter) Resume(context.Context, Session) error {
	return nil
}

func (workingOnlyAdapter) Close(context.Context, Session) error {
	return nil
}

func (workingOnlyAdapter) Exec(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) ([]activityshared.Event, error) {
	emit([]activityshared.Event{
		newTurnActivityEventWithID(session, "turn-start-working-only", EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
	})
	return nil, nil
}

func (workingOnlyAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

type asyncExecTestAdapter struct {
	mu          sync.Mutex
	execCalled  bool
	asyncCalled bool
	started     chan struct{}
	release     chan struct{}
}

func newAsyncExecTestAdapter() *asyncExecTestAdapter {
	return &asyncExecTestAdapter{
		started: make(chan struct{}, 1),
		release: make(chan struct{}),
	}
}

func (*asyncExecTestAdapter) Provider() string { return ProviderCodex }

func (*asyncExecTestAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (*asyncExecTestAdapter) Resume(context.Context, Session) error { return nil }

func (*asyncExecTestAdapter) Close(context.Context, Session) error { return nil }

func (a *asyncExecTestAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	a.mu.Lock()
	a.execCalled = true
	a.mu.Unlock()
	return nil, nil
}

func (a *asyncExecTestAdapter) ExecAsync(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) error {
	a.mu.Lock()
	a.asyncCalled = true
	a.mu.Unlock()
	if emit != nil {
		emit([]activityshared.Event{
			newTurnActivityEventWithID(session, "turn-start-async", EventTurnStarted, turnID, SessionStatusWorking, "", "", nil),
		})
	}
	a.started <- struct{}{}
	go func() {
		<-a.release
		if emit != nil {
			emit([]activityshared.Event{
				newTurnActivityEventWithID(session, "turn-complete-async", EventTurnCompleted, turnID, SessionStatusReady, "", "", nil),
			})
		}
	}()
	return nil
}

func (*asyncExecTestAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *asyncExecTestAdapter) calls() (bool, bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.execCalled, a.asyncCalled
}

type lifecycleSnapshotAsyncExecAdapter struct {
	execDone chan struct{}
}

func (*lifecycleSnapshotAsyncExecAdapter) Provider() string { return ProviderCodex }

func (*lifecycleSnapshotAsyncExecAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (*lifecycleSnapshotAsyncExecAdapter) Resume(context.Context, Session) error { return nil }

func (*lifecycleSnapshotAsyncExecAdapter) Close(context.Context, Session) error { return nil }

func (*lifecycleSnapshotAsyncExecAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *lifecycleSnapshotAsyncExecAdapter) ExecAsync(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) error {
	if emit != nil {
		event := newTurnActivityEventWithID(session, "turn-settled-snapshot-async", EventTurnUpdated, turnID, SessionStatusReady, "", "", map[string]any{
			"phase": string(activityshared.TurnPhaseIdle),
		})
		activityshared.StampTurnLifecycleSnapshot(&event, activityshared.TurnLifecycleSnapshot{
			Origin:       activityshared.TurnLifecycleOriginAdapter,
			Seq:          1,
			ActiveTurnID: turnID,
			Phase:        string(activityshared.TurnPhaseSettled),
			Outcome:      string(activityshared.TurnOutcomeCompleted),
		})
		emit([]activityshared.Event{event})
	}
	a.execDone <- struct{}{}
	return nil
}

func (*lifecycleSnapshotAsyncExecAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

type terminalBeforeCallCompleteAsyncAdapter struct {
	callStarted      chan struct{}
	terminalReturned chan struct{}
	releaseCall      chan struct{}
}

func (*terminalBeforeCallCompleteAsyncAdapter) Provider() string { return ProviderCodex }

func (*terminalBeforeCallCompleteAsyncAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (*terminalBeforeCallCompleteAsyncAdapter) Resume(context.Context, Session) error { return nil }

func (*terminalBeforeCallCompleteAsyncAdapter) Close(context.Context, Session) error { return nil }

func (*terminalBeforeCallCompleteAsyncAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *terminalBeforeCallCompleteAsyncAdapter) ExecAsync(_ context.Context, session Session, _ []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) error {
	if emit != nil {
		emit([]activityshared.Event{
			newTurnActivityEventWithID(session, "call-1-start", EventCallStarted, turnID, messageStreamStateStreaming, "", "Run command", map[string]any{
				"callId": "call-1",
			}),
		})
	}
	a.callStarted <- struct{}{}
	if emit != nil {
		event := newTurnActivityEventWithID(session, "turn-1-settled", EventTurnUpdated, turnID, SessionStatusReady, "", "", map[string]any{
			"phase": string(activityshared.TurnPhaseIdle),
		})
		activityshared.StampTurnLifecycleSnapshot(&event, activityshared.TurnLifecycleSnapshot{
			Origin:       activityshared.TurnLifecycleOriginAdapter,
			Seq:          1,
			ActiveTurnID: turnID,
			Phase:        string(activityshared.TurnPhaseSettled),
			Outcome:      string(activityshared.TurnOutcomeCompleted),
		})
		emit([]activityshared.Event{event})
	}
	a.terminalReturned <- struct{}{}
	go func() {
		<-a.releaseCall
		if emit != nil {
			emit([]activityshared.Event{
				newTurnActivityEventWithID(session, "call-1-complete", EventCallCompleted, turnID, messageStreamStateCompleted, "", "Run command", map[string]any{
					"callId": "call-1",
				}),
			})
		}
	}()
	return nil
}

func (*terminalBeforeCallCompleteAsyncAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

type steeringAsyncExecAdapter struct {
	execDone chan struct{}
}

func (*steeringAsyncExecAdapter) Provider() string { return ProviderCodex }

func (*steeringAsyncExecAdapter) Start(context.Context, Session) ([]activityshared.Event, error) {
	return nil, nil
}

func (*steeringAsyncExecAdapter) Resume(context.Context, Session) error { return nil }

func (*steeringAsyncExecAdapter) Close(context.Context, Session) error { return nil }

func (*steeringAsyncExecAdapter) Exec(context.Context, Session, []PromptContentBlock, string, string, EventSink, CommandSnapshotSink) ([]activityshared.Event, error) {
	return nil, nil
}

func (a *steeringAsyncExecAdapter) ExecAsync(_ context.Context, session Session, content []PromptContentBlock, _ string, turnID string, emit EventSink, _ CommandSnapshotSink) error {
	if emit != nil {
		// Exact event shape produced by steerActiveTurn.
		emit([]activityshared.Event{
			newTurnActivityEvent(session, EventMessage, turnID, "", RoleUser, "steered prompt", userPromptActivityPayload(content, "", map[string]any{
				"steered": true,
			})),
		})
	}
	a.execDone <- struct{}{}
	return nil
}

func (*steeringAsyncExecAdapter) Cancel(context.Context, Session, string) ([]activityshared.Event, error) {
	return nil, nil
}

func TestControllerExecPublishesTerminalEventAfterPartialEmitError(t *testing.T) {
	t.Parallel()

	controller := NewController([]Adapter{emittingErrorAdapter{}}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	events, unsubscribe, ok := controller.Subscribe("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	waitForPublishedSessionEvent(t, events, EventTurnStarted, "", SessionStatusWorking)
	waitForPublishedSessionEvent(t, events, EventTurnCompleted, "", SessionStatusCanceled)
	waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusCanceled)
}

func TestControllerExecReconcilesWorkingStatusAfterTurnFinishesWithoutTerminalEvent(t *testing.T) {
	t.Parallel()

	controller := NewController([]Adapter{workingOnlyAdapter{}}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}

	session := waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
	if controller.HasActiveTurn("room-1", started.Session.AgentSessionID) {
		t.Fatal("HasActiveTurn = true, want false after exec completes")
	}

	state, err := controller.State("room-1", started.Session.AgentSessionID)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.Status != SessionStatusReady {
		t.Fatalf("state status = %q, want %q", state.Status, SessionStatusReady)
	}
	if session.Status != SessionStatusReady {
		t.Fatalf("session status = %q, want %q", session.Status, SessionStatusReady)
	}
}

func TestControllerExecReportsTerminalTurnAsSettledAndAvailable(t *testing.T) {
	t.Parallel()

	adapter := newBlockingExecAdapter()
	adapter.provider = ProviderClaudeCode
	reporter := &recordingReporter{}
	controller := NewController([]Adapter{adapter}, reporter)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		Title:          "Test",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	adapter.waitForPrompt(t, "run")
	adapter.releaseNext()
	session := waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
	if session.SubmitAvailability == nil || session.SubmitAvailability.State != "available" {
		t.Fatalf("session submit availability = %#v, want available", session.SubmitAvailability)
	}

	reports := reporter.waitForCalls(t, 3)
	var terminalPatch *agentsessionstore.WorkspaceAgentStatePatch
	for _, call := range reports {
		for index := range call.report.StatePatches {
			patch := &call.report.StatePatches[index]
			if patch.Turn != nil && patch.Turn.CompletedAtUnixMS > 0 {
				terminalPatch = patch
			}
		}
	}
	if terminalPatch == nil {
		t.Fatalf("reports = %#v, missing terminal turn patch", reports)
		return
	}
	if terminalPatch.CurrentPhase != string(activityshared.TurnPhaseIdle) {
		t.Fatalf("terminal patch current phase = %q, want idle", terminalPatch.CurrentPhase)
	}
	if terminalPatch.Turn == nil ||
		terminalPatch.Turn.ActiveTurnID != nil ||
		terminalPatch.Turn.Phase != "settled" ||
		terminalPatch.Turn.Outcome != "completed" ||
		terminalPatch.Turn.SubmitAvailability == nil ||
		terminalPatch.Turn.SubmitAvailability.State != "available" {
		t.Fatalf("terminal turn patch = %#v, want settled available with nil active turn", terminalPatch.Turn)
	}
	if terminalPatch.TurnLifecycle == nil ||
		terminalPatch.TurnLifecycle.ActiveTurnID != nil ||
		terminalPatch.TurnLifecycle.Phase != "settled" ||
		terminalPatch.TurnLifecycle.Outcome == nil ||
		*terminalPatch.TurnLifecycle.Outcome != "completed" {
		t.Fatalf("terminal turn lifecycle = %#v, want completed settled with nil active turn", terminalPatch.TurnLifecycle)
	}
	if terminalPatch.SubmitAvailability == nil || terminalPatch.SubmitAvailability.State != "available" {
		t.Fatalf("terminal submit availability = %#v, want available", terminalPatch.SubmitAvailability)
	}
}

func TestControllerExecUsesAsyncAdapterAndFinalizesFromTerminalEvent(t *testing.T) {
	t.Parallel()

	adapter := newAsyncExecTestAdapter()
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
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	select {
	case <-adapter.started:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for async Exec")
	}
	execCalled, asyncCalled := adapter.calls()
	if execCalled {
		t.Fatal("blocking Exec was called for async adapter")
	}
	if !asyncCalled {
		t.Fatal("ExecAsync was not called")
	}
	if !controller.HasActiveTurn("room-1", started.Session.AgentSessionID) {
		t.Fatal("HasActiveTurn = false before async terminal event")
	}

	close(adapter.release)
	session := waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
	if controller.HasActiveTurn("room-1", started.Session.AgentSessionID) {
		t.Fatal("HasActiveTurn = true after async terminal event")
	}
	if session.TurnLifecycle == nil || session.TurnLifecycle.Phase != "settled" {
		t.Fatalf("turn lifecycle = %#v, want settled", session.TurnLifecycle)
	}
}

func TestControllerExecDefersAsyncTerminalEventUntilOpenCallCompletes(t *testing.T) {
	t.Parallel()

	adapter := &terminalBeforeCallCompleteAsyncAdapter{
		callStarted:      make(chan struct{}, 1),
		terminalReturned: make(chan struct{}, 1),
		releaseCall:      make(chan struct{}),
	}
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
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	select {
	case <-adapter.callStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for call start")
	}
	select {
	case <-adapter.terminalReturned:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for terminal event")
	}
	session, ok := controller.get("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("session missing")
	}
	if session.Status != SessionStatusWorking {
		t.Fatalf("session status = %q, want working while call is open", session.Status)
	}
	if session.SubmitAvailability == nil ||
		session.SubmitAvailability.State != "blocked" ||
		session.SubmitAvailability.Reason != "active_turn" {
		t.Fatalf("submit availability = %#v, want blocked active_turn", session.SubmitAvailability)
	}
	if !controller.HasActiveTurn("room-1", started.Session.AgentSessionID) {
		t.Fatal("HasActiveTurn = false before open call completes")
	}

	close(adapter.releaseCall)
	session = waitForSessionStatus(t, controller, "room-1", started.Session.AgentSessionID, SessionStatusReady)
	if controller.HasActiveTurn("room-1", started.Session.AgentSessionID) {
		t.Fatal("HasActiveTurn = true after open call completes")
	}
	if session.TurnLifecycle == nil || session.TurnLifecycle.Phase != "settled" {
		t.Fatalf("turn lifecycle = %#v, want settled", session.TurnLifecycle)
	}
}

func TestControllerExecSteerSettlesTurnRecordWithoutTerminalEvent(t *testing.T) {
	t.Parallel()

	adapter := &steeringAsyncExecAdapter{execDone: make(chan struct{}, 2)}
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
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("also update the docs"),
	}); err != nil {
		t.Fatalf("steer Exec: %v", err)
	}
	select {
	case <-adapter.execDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for steer ExecAsync")
	}
	// The steer submission does not own a provider turn: no terminal event
	// will ever arrive for its turn id, so the controller turn record must
	// settle immediately or the session blocks every future Exec with
	// ErrSessionActiveTurn until daemon restart.
	waitForCondition(t, func() bool {
		return !controller.HasActiveTurn("room-1", started.Session.AgentSessionID)
	})
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("follow-up prompt"),
	}); err != nil {
		t.Fatalf("Exec after steer: %v", err)
	}
}

func TestControllerExecSettledLifecycleSnapshotClearsAsyncTurnRecord(t *testing.T) {
	t.Parallel()

	adapter := &lifecycleSnapshotAsyncExecAdapter{execDone: make(chan struct{}, 1)}
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
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("run"),
	}); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	select {
	case <-adapter.execDone:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for snapshot ExecAsync")
	}
	waitForCondition(t, func() bool {
		return !controller.HasActiveTurn("room-1", started.Session.AgentSessionID)
	})
	if _, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("follow-up prompt"),
	}); err != nil {
		t.Fatalf("Exec after settled snapshot: %v", err)
	}
}

func TestControllerStateReconcilesStoredWorkingStatusWithoutActiveTurn(t *testing.T) {
	t.Parallel()

	controller := NewController([]Adapter{&statefulInteractiveAdapter{}}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "Codex",
		CWD:            "/workspace",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	controller.mu.Lock()
	session := controller.sessions[sessionKey("room-1", started.Session.AgentSessionID)]
	session.Status = SessionStatusWorking
	session.UpdatedAtUnixMS = 123
	controller.sessions[sessionKey("room-1", started.Session.AgentSessionID)] = session
	controller.mu.Unlock()

	state, err := controller.State("room-1", started.Session.AgentSessionID)
	if err != nil {
		t.Fatalf("State: %v", err)
	}
	if state.Status != SessionStatusReady {
		t.Fatalf("state status = %q, want %q", state.Status, SessionStatusReady)
	}

	reconciled, ok := controller.get("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("get returned ok=false")
	}
	if reconciled.Status != SessionStatusReady {
		t.Fatalf("stored session status = %q, want %q", reconciled.Status, SessionStatusReady)
	}
	if controller.HasActiveTurn("room-1", started.Session.AgentSessionID) {
		t.Fatal("HasActiveTurn = true, want false")
	}
}

func TestControllerExecIgnoresMetadataOnlyEmitForSessionUpdatedAt(t *testing.T) {
	t.Parallel()

	adapter := newBlockingSessionUpdateAdapter()
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

	controller.mu.Lock()
	session := controller.sessions[sessionKey("room-1", started.Session.AgentSessionID)]
	session.UpdatedAtUnixMS = 321
	controller.sessions[sessionKey("room-1", started.Session.AgentSessionID)] = session
	controller.mu.Unlock()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, execErr := controller.Exec(ctx, ExecInput{
			RoomID:         "room-1",
			AgentSessionID: started.Session.AgentSessionID,
			Content:        textPrompt("hello"),
		})
		done <- execErr
	}()

	waitForCondition(t, func() bool {
		current, ok := controller.Session("room-1", started.Session.AgentSessionID)
		return ok && current.UpdatedAtUnixMS > 321
	})
	current, ok := controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false after beginTurn")
	}
	baselineUpdatedAtUnixMS := current.UpdatedAtUnixMS

	close(adapter.readyToEmit)
	select {
	case <-adapter.emitted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for metadata event emit")
	}

	current, ok = controller.Session("room-1", started.Session.AgentSessionID)
	if !ok {
		t.Fatal("Session returned ok=false after metadata emit")
	}
	if current.UpdatedAtUnixMS != baselineUpdatedAtUnixMS {
		t.Fatalf(
			"UpdatedAtUnixMS after metadata emit = %d, want preserved beginTurn value %d",
			current.UpdatedAtUnixMS,
			baselineUpdatedAtUnixMS,
		)
	}

	cancel()
	<-done
}
