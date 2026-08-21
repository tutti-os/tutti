package agentruntime

import (
	"context"
	"errors"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestControllerSessionUpdateDuringActiveTurnDoesNotExposeReady(t *testing.T) {
	t.Parallel()

	adapter := newBlockingSessionUpdateAdapter()
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
	execResult, err := controller.Exec(context.Background(), ExecInput{
		RoomID:         "room-1",
		AgentSessionID: started.Session.AgentSessionID,
		Content:        textPrompt("hello"),
	})
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}

	close(adapter.readyToEmit)
	select {
	case <-adapter.emitted:
	case <-time.After(2 * time.Second):
		t.Fatal("session update was not emitted")
	}
	waitForCondition(t, func() bool {
		updated, ok := controller.get("room-1", started.Session.AgentSessionID)
		return ok && updated.Title == "Provider title" && updated.Status == SessionStatusWorking
	})

	cancelResult, err := controller.Cancel(context.Background(), rootCancelInput("room-1", started.Session.AgentSessionID, execResult.TurnID, "user"))
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	if !cancelResult.Canceled {
		t.Fatalf("Cancel result = %#v, want active turn cancel", cancelResult)
	}
}

func TestControllerSessionEventSinkTracksSyntheticTurnLifecycle(t *testing.T) {
	t.Parallel()

	reporter := &recordingReporter{}
	controller := NewController(nil, reporter)
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		Status:         SessionStatusReady,
	}
	controller.store(session)

	controller.applySessionEventsByAgentSessionID("agent-session-1", []activityshared.Event{
		newTurnActivityEvent(session, EventTurnStarted, "synthetic-turn-1", SessionStatusWorking, "", "", map[string]any{
			"synthetic": true,
		}),
	})

	stored, ok := controller.get("room-1", "agent-session-1")
	if !ok {
		t.Fatal("stored session missing")
	}
	if stored.Status != SessionStatusWorking {
		t.Fatalf("session status = %q, want working", stored.Status)
	}
	if stored.TurnLifecycle == nil ||
		stored.TurnLifecycle.ActiveTurnID == nil ||
		*stored.TurnLifecycle.ActiveTurnID != "synthetic-turn-1" ||
		stored.TurnLifecycle.Phase != "running" {
		t.Fatalf("turn lifecycle = %#v, want synthetic running", stored.TurnLifecycle)
	}
	if stored.SubmitAvailability == nil ||
		stored.SubmitAvailability.State != "blocked" ||
		stored.SubmitAvailability.Reason != "active_turn" {
		t.Fatalf("submit availability = %#v, want active_turn blocked", stored.SubmitAvailability)
	}

	reports := reporter.waitForCalls(t, 1)
	patches := reports[len(reports)-1].report.StatePatches
	if len(patches) == 0 ||
		patches[0].TurnLifecycle == nil ||
		patches[0].TurnLifecycle.ActiveTurnID == nil ||
		*patches[0].TurnLifecycle.ActiveTurnID != "synthetic-turn-1" {
		t.Fatalf("reported state patches = %#v, want synthetic turn lifecycle", patches)
	}
}

func TestControllerSessionEventSinkCommitsChildTerminalBeforePublish(t *testing.T) {
	reporter := newSessionEventTerminalBarrierReporter()
	controller := NewController(nil, reporter)
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "root-session-1",
		Provider:       ProviderCodex,
		Status:         SessionStatusReady,
	}
	controller.store(session)
	childSession := Session{
		RoomID:         session.RoomID,
		AgentSessionID: "child-session-1",
		Provider:       session.Provider,
		Status:         SessionStatusReady,
	}
	controller.store(childSession)
	stream, unsubscribe, ok := controller.Subscribe(session.RoomID, session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()
	select {
	case <-stream:
	case <-time.After(2 * time.Second):
		t.Fatal("initial session snapshot was not published")
	}
	childStream, childUnsubscribe, ok := controller.Subscribe(childSession.RoomID, childSession.AgentSessionID)
	if !ok {
		t.Fatal("child Subscribe returned ok=false")
	}
	defer childUnsubscribe()
	select {
	case <-childStream:
	case <-time.After(2 * time.Second):
		t.Fatal("initial child session snapshot was not published")
	}

	done := make(chan struct{})
	go func() {
		controller.applySessionEventsByAgentSessionID(
			session.AgentSessionID,
			[]activityshared.Event{lateChildCompletionEvent(session)},
		)
		close(done)
	}()

	var report agentsessionstore.ReportActivityInput
	select {
	case report = <-reporter.started:
	case <-time.After(2 * time.Second):
		t.Fatal("terminal report did not reach the durable barrier")
	}
	if !reportContainsAgentSessionStatePatch(report, "child-session-1") {
		t.Fatalf("terminal report = %#v, want child state patch", report)
	}
	expectNoStreamEventType(t, stream, StreamEventStatePatch)

	reporter.release <- nil
	waitForPublishedSessionEvent(t, childStream, EventTurnCompleted, "", "")
	expectNoStreamEventType(t, stream, StreamEventStatePatch)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("session event sink did not return after durable commit")
	}
}

func TestControllerSessionEventSinkWithholdsChildTerminalWhenCommitFails(t *testing.T) {
	reporter := newSessionEventTerminalBarrierReporter()
	controller := NewController(nil, reporter)
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "root-session-1",
		Provider:       ProviderCodex,
		Status:         SessionStatusReady,
	}
	controller.store(session)
	stream, unsubscribe, ok := controller.Subscribe(session.RoomID, session.AgentSessionID)
	if !ok {
		t.Fatal("Subscribe returned ok=false")
	}
	defer unsubscribe()
	select {
	case <-stream:
	case <-time.After(2 * time.Second):
		t.Fatal("initial session snapshot was not published")
	}

	reporter.release <- errors.New("durable report failed")
	controller.applySessionEventsByAgentSessionID(
		session.AgentSessionID,
		[]activityshared.Event{lateChildCompletionEvent(session)},
	)
	select {
	case <-reporter.started:
	case <-time.After(2 * time.Second):
		t.Fatal("terminal report did not reach the durable barrier")
	}
	expectNoStreamEventType(t, stream, StreamEventStatePatch)
}

type sessionEventTerminalBarrierReporter struct {
	started chan agentsessionstore.ReportActivityInput
	release chan error
}

func newSessionEventTerminalBarrierReporter() *sessionEventTerminalBarrierReporter {
	return &sessionEventTerminalBarrierReporter{
		started: make(chan agentsessionstore.ReportActivityInput, 1),
		release: make(chan error, 1),
	}
}

func (r *sessionEventTerminalBarrierReporter) Report(
	ctx context.Context,
	report agentsessionstore.ReportActivityInput,
) error {
	select {
	case r.started <- report:
	case <-ctx.Done():
		return ctx.Err()
	}
	select {
	case err := <-r.release:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (r *sessionEventTerminalBarrierReporter) ReportSubmitProvenance(
	ctx context.Context,
	report agentsessionstore.ReportActivityInput,
) error {
	return r.Report(ctx, report)
}

func lateChildCompletionEvent(root Session) activityshared.Event {
	event := newTurnActivityEvent(
		root,
		EventTurnCompleted,
		"child-turn-1",
		SessionStatusReady,
		"",
		"",
		nil,
	)
	event.AgentSessionID = "child-session-1"
	event.SessionKind = "child"
	event.RootAgentSessionID = root.AgentSessionID
	event.RootTurnID = "root-turn-1"
	return event
}

func reportContainsAgentSessionStatePatch(
	report agentsessionstore.ReportActivityInput,
	agentSessionID string,
) bool {
	for _, patch := range report.StatePatches {
		if patch.AgentSessionID == agentSessionID {
			return true
		}
	}
	return false
}

func TestControllerFinishParentTurnDoesNotOverwriteSyntheticLifecycle(t *testing.T) {
	t.Parallel()

	controller := NewController(nil, nil)
	parentTurnID := "parent-turn-1"
	syntheticTurnID := "synthetic-turn-1"
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		Status:         SessionStatusWorking,
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &syntheticTurnID,
			Phase:        "running",
		},
		SubmitAvailability: blockedSubmitAvailability("active_turn"),
	}
	controller.store(session)
	controller.mu.Lock()
	controller.turns[sessionKey("room-1", "agent-session-1")] = activeTurn{turnID: parentTurnID}
	controller.mu.Unlock()

	outcome := "completed"
	controller.finishTurn(Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		Status:         SessionStatusReady,
		TurnLifecycle: &TurnLifecycle{
			Phase:   "settled",
			Outcome: &outcome,
		},
		SubmitAvailability: availableSubmitAvailability(),
	}, parentTurnID)

	stored, ok := controller.get("room-1", "agent-session-1")
	if !ok {
		t.Fatal("stored session missing")
	}
	if stored.TurnLifecycle == nil ||
		stored.TurnLifecycle.ActiveTurnID == nil ||
		*stored.TurnLifecycle.ActiveTurnID != syntheticTurnID ||
		stored.TurnLifecycle.Phase != "running" {
		t.Fatalf("turn lifecycle = %#v, want synthetic running preserved", stored.TurnLifecycle)
	}
	if stored.Status != SessionStatusWorking {
		t.Fatalf("session status = %q, want working", stored.Status)
	}
	if _, ok := controller.activeTurn("room-1", "agent-session-1"); ok {
		t.Fatal("parent active turn map entry still exists")
	}
}

func TestControllerStoreTurnSessionRejectsOlderAdapterLifecycle(t *testing.T) {
	t.Parallel()

	controller := NewController(nil, nil)
	turnID := "parent-turn-1"
	current := Session{
		RoomID:             "room-1",
		AgentSessionID:     "agent-session-1",
		Provider:           ProviderClaudeCode,
		Status:             SessionStatusWorking,
		LifecycleAuthority: true,
		LifecycleSeq:       3,
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &turnID,
			Phase:        "running",
		},
		SubmitAvailability: blockedSubmitAvailability("active_turn"),
	}
	controller.store(current)
	controller.mu.Lock()
	controller.turns[sessionKey("room-1", "agent-session-1")] = activeTurn{turnID: turnID}
	controller.mu.Unlock()

	outcome := "completed"
	stale := current
	stale.Status = SessionStatusReady
	stale.LifecycleSeq = 2
	stale.TurnLifecycle = &TurnLifecycle{
		Phase:   "settled",
		Outcome: &outcome,
	}
	stale.SubmitAvailability = availableSubmitAvailability()

	if _, ok := controller.storeTurnSession(stale, turnID); ok {
		t.Fatal("older adapter lifecycle overwrote current session")
	}
	stored, ok := controller.get("room-1", "agent-session-1")
	if !ok {
		t.Fatal("stored session missing")
	}
	if stored.LifecycleSeq != current.LifecycleSeq ||
		stored.Status != SessionStatusWorking ||
		stored.TurnLifecycle == nil ||
		stored.TurnLifecycle.ActiveTurnID == nil ||
		*stored.TurnLifecycle.ActiveTurnID != turnID ||
		stored.TurnLifecycle.Phase != "running" {
		t.Fatalf("stored session = %#v, want newer running lifecycle preserved", stored)
	}
}

func TestControllerFinishTurnDoesNotRestoreClosedSession(t *testing.T) {
	t.Parallel()

	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	turnID := "turn-1"
	staleTurnSession := started.Session
	staleTurnSession.Status = SessionStatusCanceled
	staleTurnSession.TurnLifecycle = &TurnLifecycle{
		ActiveTurnID: &turnID,
		Phase:        "running",
	}
	controller.store(staleTurnSession)
	controller.mu.Lock()
	controller.turns[sessionKey(staleTurnSession.RoomID, staleTurnSession.AgentSessionID)] = activeTurn{turnID: turnID}
	controller.mu.Unlock()

	if _, err := controller.Close(context.Background(), CloseInput{
		RoomID:         staleTurnSession.RoomID,
		AgentSessionID: staleTurnSession.AgentSessionID,
	}); err != nil {
		t.Fatalf("Close: %v", err)
	}

	// A turn goroutine can finish after Close has removed its session. Its stale
	// snapshot must not recreate the closed session and shadow the next Start.
	controller.finishTurn(staleTurnSession, turnID)
	if restored, ok := controller.Session(staleTurnSession.RoomID, staleTurnSession.AgentSessionID); ok {
		t.Fatalf("late turn finish restored closed session: %#v", restored)
	}
}

func TestControllerFinishTurnDoesNotOverwriteRestartedSession(t *testing.T) {
	t.Parallel()

	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, nil)
	started, err := controller.Start(context.Background(), StartInput{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderCodex,
		Title:          "old session",
	})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	turnID := "turn-1"
	staleTurnSession := started.Session
	staleTurnSession.Status = SessionStatusCanceled
	staleTurnSession.TurnLifecycle = &TurnLifecycle{
		ActiveTurnID: &turnID,
		Phase:        "running",
	}
	controller.store(staleTurnSession)
	controller.mu.Lock()
	controller.turns[sessionKey(staleTurnSession.RoomID, staleTurnSession.AgentSessionID)] = activeTurn{turnID: turnID}
	controller.mu.Unlock()

	if _, err := controller.Close(context.Background(), CloseInput{
		RoomID:         staleTurnSession.RoomID,
		AgentSessionID: staleTurnSession.AgentSessionID,
	}); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := controller.Start(context.Background(), StartInput{
		RoomID:         staleTurnSession.RoomID,
		AgentSessionID: staleTurnSession.AgentSessionID,
		Provider:       ProviderCodex,
		Title:          "fresh session",
	}); err != nil {
		t.Fatalf("restart: %v", err)
	}

	// The canceled turn can unwind after a same-ID session has restarted. Its
	// stale snapshot must not replace the fresh controller session.
	if _, ok := controller.storeTurnSession(staleTurnSession, turnID); ok {
		t.Fatal("late turn event stored stale session after restart")
	}
	controller.finishTurn(staleTurnSession, turnID)
	restarted, ok := controller.Session(staleTurnSession.RoomID, staleTurnSession.AgentSessionID)
	if !ok {
		t.Fatal("restarted session missing")
	}
	if restarted.Title != "fresh session" || restarted.Status != SessionStatusReady {
		t.Fatalf("restarted session overwritten by stale turn: %#v", restarted)
	}
}

func TestControllerFinishTurnReconcilesCreatedStatusToReady(t *testing.T) {
	t.Parallel()

	controller := NewController(nil, nil)
	turnID := "turn-1"
	session := Session{
		RoomID:         "room-1",
		AgentSessionID: "agent-session-1",
		Provider:       ProviderTuttiAgent,
		Status:         "created",
		TurnLifecycle: &TurnLifecycle{
			ActiveTurnID: &turnID,
			Phase:        "running",
		},
		SubmitAvailability: blockedSubmitAvailability("active_turn"),
	}
	controller.store(session)
	controller.mu.Lock()
	controller.turns[sessionKey(session.RoomID, session.AgentSessionID)] = activeTurn{turnID: turnID}
	controller.mu.Unlock()

	outcome := "completed"
	session.TurnLifecycle = &TurnLifecycle{Phase: "settled", Outcome: &outcome}
	session.SubmitAvailability = availableSubmitAvailability()
	controller.finishTurn(session, turnID)

	stored, ok := controller.get(session.RoomID, session.AgentSessionID)
	if !ok {
		t.Fatal("stored session missing")
	}
	if stored.Status != SessionStatusReady {
		t.Fatalf("session status = %q, want ready", stored.Status)
	}
	if stored.SubmitAvailability == nil || stored.SubmitAvailability.State != "available" {
		t.Fatalf("submit availability = %#v, want available", stored.SubmitAvailability)
	}
}
