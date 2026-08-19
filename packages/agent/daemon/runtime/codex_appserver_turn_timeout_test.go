package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type sequentialAppServerTransport struct {
	mu          sync.Mutex
	connections []*scriptedAppServerConnection
	starts      int
}

func (t *sequentialAppServerTransport) Start(_ context.Context, _ ProcessSpec) (ProcessConnection, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.starts >= len(t.connections) {
		return nil, fmt.Errorf("unexpected process start %d", t.starts+1)
	}
	connection := t.connections[t.starts]
	t.starts++
	return connection, nil
}

func TestCodexAppServerAdapterTurnStartAckTimeoutInvalidatesClient(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	t.Cleanup(func() { _ = adapter.Close(context.Background(), session) })
	adapter.turnStartAckTimeout = 25 * time.Millisecond
	transport.server.hangTurnStart = true

	startedAt := time.Now()
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "hang before acknowledgement",
	}}, "", "turn-timeout", nil, nil)
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if elapsed := time.Since(startedAt); elapsed > time.Second {
		t.Fatalf("Exec elapsed = %s, want bounded turn/start acknowledgement", elapsed)
	}

	failed := eventsOfType(events, activityshared.EventTurnFailed)
	if len(failed) != 1 {
		t.Fatalf("turn.failed events = %d, want 1; events = %#v", len(failed), events)
	}
	message, _ := failed[0].Payload.Metadata["error"].(string)
	if !strings.Contains(message, "turn/start timed out after 25ms") {
		t.Fatalf("turn.failed metadata = %#v, want turn/start timeout", failed[0].Payload.Metadata)
	}
	if adapter.HasLiveSession(session) {
		t.Fatalf("timed-out turn/start client remained live")
	}
	transport.conn.mu.Lock()
	closeCount := transport.conn.closeCount
	transport.conn.mu.Unlock()
	if closeCount == 0 {
		t.Fatalf("timed-out turn/start client was not closed")
	}
}

func TestCodexSharedClientInvalidationExpiresEverySessionReference(t *testing.T) {
	adapter, transport, parent := startedAppServerAdapter(t)
	client := adapter.getSession(parent.AgentSessionID).client
	side := parent
	side.AgentSessionID = "side-shared"
	side.ProviderSessionID = "codex-thread-side"
	side.Scope = RuntimeSessionScopeSide
	side.SourceAgentSessionID = parent.AgentSessionID
	adapter.storeSession(side.AgentSessionID, &codexAppServerSession{
		client: client, threadID: side.ProviderSessionID, runtimeSession: side,
		acpLiveState: newACPLiveState(),
	})

	if !adapter.invalidateSessionClient(side.AgentSessionID, client) {
		t.Fatal("shared client was not invalidated")
	}
	if adapter.HasLiveSession(parent) || adapter.HasLiveSession(side) {
		t.Fatal("unhealthy shared client left a parent or Side reference live")
	}
	transport.conn.mu.Lock()
	closeCount := transport.conn.closeCount
	transport.conn.mu.Unlock()
	if closeCount != 1 {
		t.Fatalf("shared client close count = %d, want 1", closeCount)
	}
}

func TestCodexAppServerAdapterTurnStartEOFProjectsVisibleFailureBeforeAcceptance(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	t.Cleanup(func() { _ = adapter.Close(context.Background(), session) })
	transport.server.closeOnTurnStart = true

	var dispatch ProviderDispatchResult
	barrierCalled := false
	events, err := adapter.ExecWithProviderAcceptance(
		context.Background(),
		session,
		[]PromptContentBlock{{Type: "text", Text: "disconnect before acknowledgement"}},
		"disconnect before acknowledgement",
		"turn-eof",
		nil,
		nil,
		func(result ProviderDispatchResult) { dispatch = result },
		func(ProviderAcceptanceReceipt) error {
			barrierCalled = true
			return nil
		},
	)
	if err != nil {
		t.Fatalf("ExecWithProviderAcceptance: %v", err)
	}
	if barrierCalled {
		t.Fatal("provider acceptance barrier called without a turn/start response")
	}
	if dispatch.Disposition != DispatchDispositionOutcomeUnknown {
		t.Fatalf("dispatch disposition = %q, want outcome_unknown", dispatch.Disposition)
	}
	failed := eventsOfType(events, activityshared.EventTurnFailed)
	if len(failed) != 1 {
		t.Fatalf("turn.failed events = %d, want 1; events = %#v", len(failed), events)
	}
	if got := failed[0].Payload.Metadata["error"]; got != "EOF" {
		t.Fatalf("turn.failed error = %#v, want EOF", got)
	}
	report := reportActivityInput(session, events)
	visibleFailures := 0
	for _, update := range report.MessageUpdates {
		if update.Status == messageStreamStateFailed && update.Payload["kind"] == visibleErrorKind {
			visibleFailures++
		}
	}
	if visibleFailures != 1 {
		t.Fatalf("visible failure count = %d, want 1; updates = %#v", visibleFailures, report.MessageUpdates)
	}
}

func TestCodexAppServerAdapterHasLiveSessionRejectsClosedClient(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	appSession := adapter.getSession(session.AgentSessionID)
	if appSession == nil || appSession.client == nil {
		t.Fatal("started session has no client")
	}
	if err := transport.conn.Close(); err != nil {
		t.Fatal(err)
	}
	waitForCondition(t, func() bool {
		select {
		case <-appSession.client.Done():
			return true
		default:
			return false
		}
	})
	if adapter.HasLiveSession(session) {
		t.Fatal("HasLiveSession = true after app-server client terminated")
	}
}

func TestCodexAppServerAdapterTurnStartCancelBeforeAckInvalidatesClient(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	t.Cleanup(func() { _ = adapter.Close(context.Background(), session) })
	adapter.turnStartAckTimeout = time.Second
	transport.server.hangTurnStart = true
	transport.server.turnStartEntered = make(chan struct{})

	execCtx, cancelExec := context.WithCancel(context.Background())
	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(execCtx, session, []PromptContentBlock{{
			Type: "text", Text: "cancel before acknowledgement",
		}}, "", "turn-canceled", nil, nil)
		execDone <- events
	}()

	select {
	case <-transport.server.turnStartEntered:
	case <-time.After(time.Second):
		t.Fatalf("turn/start was not sent")
	}
	cancelExec()

	select {
	case events := <-execDone:
		completed := eventsOfType(events, activityshared.EventTurnCompleted)
		if len(completed) != 1 ||
			completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeInterrupted) {
			t.Fatalf("expected interrupted turn outcome, got %#v", events)
		}
	case <-time.After(time.Second):
		t.Fatalf("Exec did not finish after cancellation")
	}
	if adapter.HasLiveSession(session) {
		t.Fatalf("canceled unacknowledged turn/start client remained live")
	}
}

func TestCodexAppServerAdapterCanResumeAfterTurnStartAckTimeout(t *testing.T) {
	firstConnection, firstServer := newScriptedAppServerHarness()
	firstServer.hangTurnStart = true
	secondConnection := newScriptedAppServerConnection()
	transport := &sequentialAppServerTransport{
		connections: []*scriptedAppServerConnection{firstConnection, secondConnection},
	}
	adapter := NewCodexAppServerAdapter(transport)
	adapter.turnStartAckTimeout = 25 * time.Millisecond
	session := testAppServerSession()
	t.Cleanup(func() { _ = adapter.Close(context.Background(), session) })
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	session.ProviderSessionID = "codex-thread-1"

	if _, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "first attempt",
	}}, "", "turn-timeout", nil, nil); err != nil {
		t.Fatalf("first Exec: %v", err)
	}
	if adapter.HasLiveSession(session) {
		t.Fatalf("timed-out client remained live")
	}

	if err := adapter.Resume(context.Background(), session); err != nil {
		t.Fatalf("Resume: %v", err)
	}
	if !adapter.HasLiveSession(session) {
		t.Fatalf("resumed client is not live")
	}
	if requests := appServerRequestParamsList(t, secondConnection, appServerMethodThreadResume); len(requests) != 1 {
		t.Fatalf("thread/resume calls = %d, want 1", len(requests))
	}
	events, err := adapter.Exec(context.Background(), session, []PromptContentBlock{{
		Type: "text", Text: "second attempt",
	}}, "", "turn-recovered", nil, nil)
	if err != nil {
		t.Fatalf("second Exec: %v", err)
	}
	completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
	if len(completed) != 1 ||
		completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCompleted) {
		t.Fatalf("expected recovered provider turn to complete, got %#v", events)
	}
}

func TestCodexAppServerAdapterTurnStartAckTimeoutDoesNotBoundRunningTurn(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	t.Cleanup(func() { _ = adapter.Close(context.Background(), session) })
	adapter.turnStartAckTimeout = 25 * time.Millisecond
	transport.server.holdTurn = true

	execDone := make(chan []activityshared.Event, 1)
	go func() {
		events, _ := adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "long running turn",
		}}, "", "turn-running", nil, nil)
		execDone <- events
	}()

	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})
	time.Sleep(75 * time.Millisecond)
	if !adapter.HasLiveSession(session) {
		t.Fatalf("acknowledged running turn was closed by acknowledgement timeout")
	}
	transport.server.completePendingTurn()

	select {
	case events := <-execDone:
		completed := eventsOfType(events, activityshared.EventRootProviderTurnCompleted)
		if len(completed) != 1 ||
			completed[0].Payload.TurnOutcome != string(activityshared.TurnOutcomeCompleted) {
			t.Fatalf("expected completed provider turn outcome, got %#v", events)
		}
	case <-time.After(time.Second):
		t.Fatalf("acknowledged running turn did not complete")
	}
}

func TestCodexAppServerAdapterTurnSteerTimesOut(t *testing.T) {
	adapter, transport, session := startedAppServerAdapter(t)
	t.Cleanup(func() { _ = adapter.Close(context.Background(), session) })
	adapter.turnSteerTimeout = 25 * time.Millisecond
	transport.server.holdTurn = true

	execDone := make(chan struct{}, 1)
	go func() {
		_, _ = adapter.Exec(context.Background(), session, []PromptContentBlock{{
			Type: "text", Text: "running turn",
		}}, "", "turn-running", nil, nil)
		execDone <- struct{}{}
	}()
	waitForCondition(t, func() bool {
		return adapter.sessionActiveTurnID(session.AgentSessionID) == "turn-1"
	})
	transport.server.mu.Lock()
	transport.server.hangSteer = true
	transport.server.mu.Unlock()

	startedAt := time.Now()
	dispatches := make(chan ProviderDispatchResult, 1)
	_, err := adapter.GuideActiveTurnWithProviderDispatch(
		context.Background(),
		session,
		[]PromptContentBlock{{Type: "text", Text: "new guidance"}},
		"",
		"turn-guidance",
		nil,
		nil,
		func(result ProviderDispatchResult) { dispatches <- result },
	)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("steered Exec error = %v, want deadline exceeded", err)
	}
	if dispatch := <-dispatches; dispatch.Disposition != DispatchDispositionOutcomeUnknown {
		t.Fatalf("guidance dispatch = %#v, want outcome unknown", dispatch)
	}
	if elapsed := time.Since(startedAt); elapsed > time.Second {
		t.Fatalf("steered Exec elapsed = %s, want bounded turn/steer", elapsed)
	}

	transport.server.completePendingTurn()
	select {
	case <-execDone:
	case <-time.After(time.Second):
		t.Fatalf("running turn did not finish during cleanup")
	}
}
