package agentruntime

import (
	"context"
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
)

type recordingRuntimeStreamObserver struct {
	called       bool
	events       []StreamEvent
	observations []recordedRuntimeStreamObservation
	err          error
}

type recordedRuntimeStreamObservation struct {
	roomID         string
	agentSessionID string
	events         []StreamEvent
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
	roomID string,
	agentSessionID string,
	events []StreamEvent,
) error {
	o.called = true
	o.events = append(o.events, events...)
	o.observations = append(o.observations, recordedRuntimeStreamObservation{
		roomID:         roomID,
		agentSessionID: agentSessionID,
		events:         append([]StreamEvent(nil), events...),
	})
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

func TestPublishRoutesHighFrequencyRootAndChildDeltasByEventOwner(t *testing.T) {
	controller := NewController(nil, nil)
	observer := &recordingRuntimeStreamObserver{}
	controller.SetStreamEventObserver(observer)

	root := Session{
		RoomID:            "workspace-1",
		AgentSessionID:    "root-session",
		Provider:          ProviderCodex,
		ProviderSessionID: "root-thread",
	}
	childSessions := []Session{
		{RoomID: root.RoomID, AgentSessionID: "child-session-1", Provider: root.Provider, ProviderSessionID: "child-thread-1"},
		{RoomID: root.RoomID, AgentSessionID: "child-session-2", Provider: root.Provider, ProviderSessionID: "child-thread-2"},
		{RoomID: root.RoomID, AgentSessionID: "child-session-3", Provider: root.Provider, ProviderSessionID: "child-thread-3"},
	}
	events := newACPTurnNormalizer().AppendAssistantChunk(root, "root-turn", "root")
	for _, child := range childSessions {
		normalizer := newACPTurnNormalizer()
		for index := 0; index < 32; index++ {
			events = append(events, normalizer.AppendAssistantChunk(child, "child-turn", fmt.Sprintf("child output %d", index))...)
		}
	}

	controller.publish(root, events)

	if len(observer.observations) != 4 {
		t.Fatalf("stream observations = %#v, want root plus three child scopes", observer.observations)
	}
	for index, observation := range observer.observations {
		wantSessionID := root.AgentSessionID
		wantCount := 1
		if index > 0 {
			wantSessionID = childSessions[index-1].AgentSessionID
			wantCount = 32
		}
		if observation.roomID != root.RoomID || observation.agentSessionID != wantSessionID {
			t.Fatalf("observation[%d] = %#v, want scope %s/%s", index, observation, root.RoomID, wantSessionID)
		}
		if len(observation.events) != wantCount {
			t.Fatalf("observation[%d] event count = %d, want %d", index, len(observation.events), wantCount)
		}
		for _, streamEvent := range observation.events {
			data, ok := streamEvent.Data.(liveprotocol.Event)
			if !ok {
				t.Fatalf("observation[%d] data type = %T, want liveprotocol.Event", index, streamEvent.Data)
			}
			if data.AgentSessionID != wantSessionID {
				t.Fatalf("observation[%d] event scope = %q, want %q", index, data.AgentSessionID, wantSessionID)
			}
		}
	}
}

func TestProjectActivityEventsByOwnerSeparatesProviderSessionChanges(t *testing.T) {
	root := Session{
		RoomID:            "workspace-1",
		AgentSessionID:    "root-session",
		Provider:          ProviderCodex,
		ProviderSessionID: "root-thread",
	}
	child := Session{
		RoomID:            root.RoomID,
		AgentSessionID:    "child-session",
		Provider:          root.Provider,
		ProviderSessionID: "child-thread-a",
	}
	normalizer := newACPTurnNormalizer()
	first := normalizer.AppendAssistantChunk(child, "child-turn", "first")
	second := normalizer.AppendAssistantChunk(child, "child-turn", "second")
	for index := range first {
		first[index].ProviderSessionID = "child-thread-a"
	}
	for index := range second {
		second[index].ProviderSessionID = "child-thread-b"
	}

	batches := projectActivityEventsByOwner(root, append(first, second...))
	if len(batches) != 2 {
		t.Fatalf("projected batches = %#v, want one batch per provider session", batches)
	}
	for index, providerSessionID := range []string{"child-thread-a", "child-thread-b"} {
		if batches[index].session.AgentSessionID != child.AgentSessionID {
			t.Fatalf("batch[%d] agent session = %q, want %q", index, batches[index].session.AgentSessionID, child.AgentSessionID)
		}
		if batches[index].session.ProviderSessionID != providerSessionID {
			t.Fatalf("batch[%d] provider session = %q, want %q", index, batches[index].session.ProviderSessionID, providerSessionID)
		}
		if len(batches[index].events) != 1 {
			t.Fatalf("batch[%d] events = %#v, want one event", index, batches[index].events)
		}
	}
}
