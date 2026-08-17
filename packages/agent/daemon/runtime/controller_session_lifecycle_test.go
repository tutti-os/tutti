package agentruntime

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type blockingInitializationStreamObserver struct {
	mu           sync.Mutex
	calls        [][]StreamEvent
	firstEntered chan struct{}
	releaseFirst chan struct{}
	once         sync.Once
}

func (o *blockingInitializationStreamObserver) ObserveRuntimeStreamEvents(
	_ context.Context,
	_, _ string,
	events []StreamEvent,
) error {
	o.mu.Lock()
	o.calls = append(o.calls, append([]StreamEvent(nil), events...))
	call := len(o.calls)
	o.mu.Unlock()
	if call == 1 {
		o.once.Do(func() { close(o.firstEntered) })
		<-o.releaseFirst
	}
	return nil
}

func (o *blockingInitializationStreamObserver) callCount() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.calls)
}

func TestPublishSessionInitializationDrainsEventsArrivingDuringRelease(t *testing.T) {
	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, nil)
	observer := &blockingInitializationStreamObserver{
		firstEntered: make(chan struct{}),
		releaseFirst: make(chan struct{}),
	}
	controller.SetStreamEventObserver(observer)

	started, err := controller.Start(t.Context(), StartInput{
		RoomID: "room-1", AgentSessionID: "session-1", Provider: ProviderCodex,
		CanonicalInitPending: true,
	})
	if err != nil || !started.Created {
		t.Fatalf("Start() = %#v, %v", started, err)
	}
	beforeRelease := newSessionActivityEvent(started.Session, EventSessionUpdated, SessionStatusReady, map[string]any{"title": "before release"})
	controller.applySessionEventsByAgentSessionID("session-1", []activityshared.Event{beforeRelease})
	if observer.callCount() != 0 {
		t.Fatal("event escaped before canonical initialization release")
	}

	publishCtx, cancelPublish := context.WithCancel(t.Context())
	publishDone := make(chan error, 1)
	go func() {
		_, publishErr := controller.PublishSessionInitialization(publishCtx, "room-1", "session-1")
		publishDone <- publishErr
	}()
	select {
	case <-observer.firstEntered:
	case <-time.After(2 * time.Second):
		t.Fatal("initial publication did not reach stream observer")
	}

	duringRelease := newSessionActivityEvent(started.Session, EventSessionUpdated, SessionStatusReady, map[string]any{"title": "during release"})
	controller.applySessionEventsByAgentSessionID("session-1", []activityshared.Event{duringRelease})
	controller.mu.Lock()
	pending := controller.sessionInitializations[sessionKey("room-1", "session-1")]
	pendingEvents := 0
	if pending != nil {
		pendingEvents = len(pending.events)
	}
	controller.mu.Unlock()
	if pendingEvents != 1 {
		t.Fatalf("events queued during release = %d, want 1", pendingEvents)
	}
	// Once the first batch is externally visible, cancellation must not leave a
	// half-released marker that Host would treat as a failed canonical publish.
	// Finish draining with detached report contexts and return success.
	cancelPublish()
	close(observer.releaseFirst)
	select {
	case err := <-publishDone:
		if err != nil {
			t.Fatalf("PublishSessionInitialization() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("publication did not finish")
	}
	if observer.callCount() != 2 {
		t.Fatalf("publication observer calls = %d, want initial and drained batches", observer.callCount())
	}
	controller.mu.Lock()
	_, stillPending := controller.sessionInitializations[sessionKey("room-1", "session-1")]
	controller.mu.Unlock()
	if stillPending {
		t.Fatal("initialization marker remained after queue drained")
	}

	afterRelease := newSessionActivityEvent(started.Session, EventSessionUpdated, SessionStatusReady, map[string]any{"title": "after release"})
	controller.applySessionEventsByAgentSessionID("session-1", []activityshared.Event{afterRelease})
	if observer.callCount() != 3 {
		t.Fatalf("post-release event was not published directly: calls=%d", observer.callCount())
	}
}

func TestCloseStopsAtCanceledLifecycleLockWithoutCallingProvider(t *testing.T) {
	adapter := &recordingStartAdapter{provider: ProviderCodex}
	controller := NewController([]Adapter{adapter}, nil)
	if _, err := controller.Start(t.Context(), StartInput{
		RoomID: "room-1", AgentSessionID: "session-1", Provider: ProviderCodex,
	}); err != nil {
		t.Fatal(err)
	}
	release := controller.acquireLifecycleLock("room-1", "session-1")
	defer release()

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		_, closeErr := controller.Close(ctx, CloseInput{RoomID: "room-1", AgentSessionID: "session-1"})
		done <- closeErr
	}()
	waitForCondition(t, func() bool {
		controller.mu.Lock()
		defer controller.mu.Unlock()
		lock := controller.lifecycleLocks[sessionKey("room-1", "session-1")]
		return lock != nil && lock.refs == 2
	})
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("Close() error = %v, want canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Close() ignored canceled lifecycle-lock wait")
	}
	if adapter.closeCalls != 0 {
		t.Fatalf("provider close calls = %d, want zero", adapter.closeCalls)
	}
}

func TestApplySessionEventsTracksLastError(t *testing.T) {
	t.Parallel()

	session := Session{AgentSessionID: "agent-session-1", Provider: ProviderCodex}
	failed := applySessionEvents(session, []activityshared.Event{
		newTurnActivityEvent(session, EventTurnFailed, "turn-1", SessionStatusFailed, "", "", map[string]any{
			"error": "API Error: 403 Key limit exceeded",
		}),
	})
	if failed.LastError != "API Error: 403 Key limit exceeded" {
		t.Fatalf("last error = %q, want turn failure detail", failed.LastError)
	}

	restarted := applySessionEvents(failed, []activityshared.Event{
		newTurnActivityEvent(session, EventTurnStarted, "turn-2", SessionStatusWorking, "", "", nil),
	})
	if restarted.LastError != "" {
		t.Fatalf("last error after new turn = %q, want cleared", restarted.LastError)
	}
}

func TestApplySessionEventsMergesRuntimeContextMetadata(t *testing.T) {
	t.Parallel()

	session := Session{
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		RuntimeContext: map[string]any{
			"cwd": "/workspace",
		},
	}
	updated := applySessionEvents(session, []activityshared.Event{
		newSessionActivityEvent(session, EventSessionUpdated, SessionStatusReady, map[string]any{
			"runtimeContext": map[string]any{
				"providerConfig": map[string]any{
					"threadId": "thread-1",
				},
			},
		}),
	})
	if updated.RuntimeContext["cwd"] != "/workspace" {
		t.Fatalf("runtime context = %#v, want existing cwd kept", updated.RuntimeContext)
	}
	providerConfig := payloadObject(updated.RuntimeContext["providerConfig"])
	if providerConfig["threadId"] != "thread-1" {
		t.Fatalf("runtime context = %#v, want provider config", updated.RuntimeContext)
	}
}
