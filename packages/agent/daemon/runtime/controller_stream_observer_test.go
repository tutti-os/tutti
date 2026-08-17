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

type filteringRuntimeStreamObserver struct {
	recordingRuntimeStreamObserver
}

func (*filteringRuntimeStreamObserver) FilterRuntimeStreamEvents(
	_ string,
	_ string,
	events []StreamEvent,
) []StreamEvent {
	if len(events) < 2 {
		return events
	}
	return events[:1]
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

func TestPublishStreamEventsUsesObserverFilterForLocalFanout(t *testing.T) {
	controller := NewController(nil, nil)
	observer := &filteringRuntimeStreamObserver{}
	controller.SetStreamEventObserver(observer)
	events, unsubscribe := controller.hub.Subscribe("workspace-1", "session-1")
	defer unsubscribe()

	controller.publishStreamEvents("workspace-1", "session-1", []StreamEvent{
		{EventType: StreamEventMessageDelta, Data: "delta-1"},
		{EventType: StreamEventMessageDelta, Data: "delta-2"},
	})

	select {
	case event := <-events:
		if event.Data != "delta-1" {
			t.Fatalf("session event = %#v, want filtered first event", event)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for filtered session fanout")
	}
	select {
	case event := <-events:
		t.Fatalf("unexpected second session event = %#v", event)
	case <-time.After(25 * time.Millisecond):
	}
	if !observer.called || len(observer.events) != 2 {
		t.Fatalf("observer events = %#v, want both events", observer.events)
	}
}
