package agentruntime

import (
	"context"
	"errors"
	"testing"
	"time"
)

type recordingRuntimeStreamObserver struct {
	called bool
	events []StreamEvent
	err    error
}

type recordingSideStreamCleanupObserver struct {
	recordingRuntimeStreamObserver
	forgotten []string
}

func (o *recordingSideStreamCleanupObserver) ForgetSideConversation(
	workspaceID string,
	agentSessionID string,
) {
	o.forgotten = append(o.forgotten, workspaceID+"/"+agentSessionID)
}

func (o *recordingRuntimeStreamObserver) ObserveRuntimeStreamEvents(
	_ context.Context,
	_ string,
	_ string,
	events []StreamEvent,
) error {
	o.called = true
	o.events = append(o.events, events...)
	return o.err
}

func TestPublishStreamEventsKeepsSessionFanoutWhenObserverFails(t *testing.T) {
	controller := NewController(nil, nil)
	controller.SetStreamEventObserver(&recordingRuntimeStreamObserver{
		err: errors.New("publish unavailable"),
	})
	events, unsubscribe := controller.hub.Subscribe("workspace-1", "session-1")
	defer unsubscribe()

	controller.publishStreamEvents("workspace-1", "session-1", []StreamEvent{{
		EventType: StreamEventMessageDelta,
		Data:      "delta-1",
	}})

	select {
	case event := <-events:
		if event.EventType != StreamEventMessageDelta || event.Data != "delta-1" {
			t.Fatalf("session event = %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("observer failure suppressed the existing session fanout")
	}
}

func TestPublishStreamEventsObservesBeforeSessionFanout(t *testing.T) {
	controller := NewController(nil, nil)
	observer := &recordingRuntimeStreamObserver{}
	controller.SetStreamEventObserver(observer)
	events, unsubscribe := controller.hub.Subscribe("workspace-1", "session-1")
	defer unsubscribe()

	controller.publishStreamEvents("workspace-1", "session-1", []StreamEvent{{
		EventType: StreamEventMessageDelta,
		Data:      "delta-1",
	}})

	if !observer.called || len(observer.events) != 1 {
		t.Fatalf("observer events = %#v, want one synchronous observation", observer.events)
	}
	select {
	case event := <-events:
		if !observer.called {
			t.Fatal("session fanout overtook the ordered stream observer")
		}
		if event.EventType != StreamEventMessageDelta || event.Data != "delta-1" {
			t.Fatalf("session event = %#v", event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for session fanout")
	}
}

func TestControllerSideStreamCleanupObserverIsNotifiedOnSessionRemoval(t *testing.T) {
	controller := NewController(nil, nil)
	observer := &recordingSideStreamCleanupObserver{}
	controller.SetSideStreamEventObserver(observer)
	session := Session{
		RoomID: "workspace-1", AgentSessionID: "side-1",
		Scope: RuntimeSessionScopeSide,
	}
	controller.store(session)

	controller.removeRuntimeSession(session)

	if len(observer.forgotten) != 1 || observer.forgotten[0] != "workspace-1/side-1" {
		t.Fatalf("forgotten sessions = %#v, want [workspace-1/side-1]", observer.forgotten)
	}
}
