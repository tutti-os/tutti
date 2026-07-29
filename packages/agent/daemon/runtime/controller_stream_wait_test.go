package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
)

func TestSubscribeWhenAvailableWaitsForResumeAndReplaysState(t *testing.T) {
	t.Parallel()

	controller := NewController([]Adapter{&statefulInteractiveAdapter{}}, nil)
	type result struct {
		events      <-chan StreamEvent
		unsubscribe func()
		err         error
	}
	resultCh := make(chan result, 1)
	ctx, cancel := context.WithTimeout(t.Context(), time.Second)
	defer cancel()
	go func() {
		events, unsubscribe, err := controller.SubscribeWhenAvailable(ctx, "room-1", "session-1")
		resultCh <- result{events: events, unsubscribe: unsubscribe, err: err}
	}()

	select {
	case got := <-resultCh:
		got.unsubscribe()
		t.Fatalf("SubscribeWhenAvailable returned before resume: %v", got.err)
	case <-time.After(20 * time.Millisecond):
	}

	resumed, err := controller.Resume(t.Context(), ResumeInput{
		RoomID:            "room-1",
		AgentSessionID:    "session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "provider-session-1",
		CWD:               "/workspace",
		Title:             "Recovered",
	})
	if err != nil {
		t.Fatalf("Resume() error = %v", err)
	}
	if resumed.AgentSessionID != "session-1" {
		t.Fatalf("Resume() session = %#v", resumed)
	}

	got := <-resultCh
	if got.err != nil {
		t.Fatalf("SubscribeWhenAvailable() error = %v", got.err)
	}
	defer got.unsubscribe()
	event := waitForStreamEventType(t, got.events, StreamEventStatePatch)
	patch, ok := event.Data.(agentsessionstore.WorkspaceAgentStatePatch)
	if !ok {
		t.Fatalf("state patch = %#v, want WorkspaceAgentStatePatch", event.Data)
	}
	if patch.AgentSessionID != "session-1" || patch.ProviderSessionID != "provider-session-1" {
		t.Fatalf("resumed state = %#v", patch)
	}
}

func TestSubscribeWhenAvailableCancellationDoesNotLeakWaiterOrCreateSession(t *testing.T) {
	t.Parallel()

	controller := NewController([]Adapter{&statefulInteractiveAdapter{}}, nil)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() {
		_, unsubscribe, err := controller.SubscribeWhenAvailable(ctx, "room-1", "missing")
		unsubscribe()
		done <- err
	}()
	waitForCondition(t, func() bool {
		controller.mu.Lock()
		defer controller.mu.Unlock()
		return controller.sessionAvailabilityWaiters[sessionKey("room-1", "missing")] != nil
	})

	cancel()
	if err := <-done; !errors.Is(err, context.Canceled) {
		t.Fatalf("SubscribeWhenAvailable() error = %v, want context canceled", err)
	}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if len(controller.sessionAvailabilityWaiters) != 0 {
		t.Fatalf("availability waiters = %#v, want empty", controller.sessionAvailabilityWaiters)
	}
	if len(controller.sessions) != 0 {
		t.Fatalf("sessions = %#v, observation unexpectedly created runtime authority", controller.sessions)
	}
}

func TestSubscribeWhenAvailableWakesConcurrentSubscribersOnce(t *testing.T) {
	t.Parallel()

	const subscriberCount = 32
	controller := NewController([]Adapter{&statefulInteractiveAdapter{}}, nil)
	type result struct {
		events      <-chan StreamEvent
		unsubscribe func()
		err         error
	}
	results := make(chan result, subscriberCount)
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second)
	defer cancel()
	for range subscriberCount {
		go func() {
			events, unsubscribe, err := controller.SubscribeWhenAvailable(ctx, "room-1", "session-1")
			results <- result{events: events, unsubscribe: unsubscribe, err: err}
		}()
	}
	waitForCondition(t, func() bool {
		controller.mu.Lock()
		defer controller.mu.Unlock()
		waiter := controller.sessionAvailabilityWaiters[sessionKey("room-1", "session-1")]
		return waiter != nil && waiter.refs == subscriberCount
	})

	if _, err := controller.Resume(t.Context(), ResumeInput{
		RoomID:            "room-1",
		AgentSessionID:    "session-1",
		Provider:          ProviderCodex,
		ProviderSessionID: "provider-session-1",
		CWD:               "/workspace",
	}); err != nil {
		t.Fatalf("Resume() error = %v", err)
	}

	for index := range subscriberCount {
		got := <-results
		if got.err != nil {
			t.Fatalf("subscriber %d error = %v", index, got.err)
		}
		waitForStreamEventType(t, got.events, StreamEventStatePatch)
		got.unsubscribe()
	}
	controller.mu.Lock()
	defer controller.mu.Unlock()
	if len(controller.sessionAvailabilityWaiters) != 0 {
		t.Fatalf("availability waiters after resume = %s", fmt.Sprint(controller.sessionAvailabilityWaiters))
	}
}
