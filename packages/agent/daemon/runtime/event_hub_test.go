package agentruntime

import (
	"testing"
	"time"
)

func TestEventHubScopesEventsByRoom(t *testing.T) {
	t.Parallel()

	hub := NewEventHub()
	roomAEvents, unsubscribeRoomA := hub.Subscribe("room-a", "session-1")
	defer unsubscribeRoomA()
	roomBEvents, unsubscribeRoomB := hub.Subscribe("room-b", "session-1")
	defer unsubscribeRoomB()

	hub.Publish("room-a", "session-1", []StreamEvent{{
		EventType: StreamEventMessageUpdate,
		Data:      map[string]any{"text": "room a"},
	}})

	select {
	case event := <-roomAEvents:
		data := event.Data.(map[string]any)
		if data["text"] != "room a" {
			t.Fatalf("room-a event data = %#v, want room a", event.Data)
		}
	case <-time.After(time.Second):
		t.Fatal("expected room-a subscriber to receive event")
	}

	select {
	case event := <-roomBEvents:
		t.Fatalf("room-b subscriber received cross-room event: %#v", event)
	case <-time.After(50 * time.Millisecond):
	}

	hub.Publish("room-b", "session-1", []StreamEvent{{
		EventType: StreamEventMessageUpdate,
		Data:      map[string]any{"text": "room b"},
	}})

	select {
	case event := <-roomBEvents:
		data := event.Data.(map[string]any)
		if data["text"] != "room b" {
			t.Fatalf("room-b event data = %#v, want room b", event.Data)
		}
	case <-time.After(time.Second):
		t.Fatal("expected room-b subscriber to receive event")
	}
}

func TestEventHubQueuesSubscriberBackpressureWithoutDropping(t *testing.T) {
	t.Parallel()

	hub := NewEventHub()
	events, unsubscribe := hub.Subscribe("room-a", "session-1")
	defer unsubscribe()

	const eventCount = 96
	published := make([]StreamEvent, 0, eventCount)
	for i := range eventCount {
		published = append(published, StreamEvent{
			EventType: StreamEventMessageUpdate,
			Data:      map[string]any{"index": i},
		})
	}

	hub.Publish("room-a", "session-1", published)

	for i := range eventCount {
		select {
		case event := <-events:
			data := event.Data.(map[string]any)
			if data["index"] != i {
				t.Fatalf("event index = %#v, want %d", data["index"], i)
			}
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for event %d", i)
		}
	}
}

func TestEventHubReconcilesAndClosesOverflowedSubscriber(t *testing.T) {
	t.Parallel()

	hub := NewEventHub()
	events, unsubscribe := hub.Subscribe("room-a", "session-1")
	defer unsubscribe()

	published := make([]StreamEvent, 0, eventHubSubscriberQueueLimit+128)
	for i := 0; i < eventHubSubscriberQueueLimit+128; i++ {
		published = append(published, StreamEvent{
			EventType: StreamEventMessageDelta,
			Data:      map[string]any{"index": i},
		})
	}
	hub.Publish("room-a", "session-1", published)

	for {
		select {
		case event, ok := <-events:
			if !ok {
				t.Fatal("overflowed subscriber closed before reconcile event")
			}
			if event.EventType != StreamEventSessionReconcileRequired {
				continue
			}
			data, ok := event.Data.(map[string]any)
			if !ok || data["reason"] != "event_hub_queue_overflow" {
				t.Fatalf("reconcile event data = %#v", event.Data)
			}
			if data["agentSessionId"] != "session-1" {
				t.Fatalf("reconcile event session = %#v", data["agentSessionId"])
			}
			goto reconciled
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for reconcile event")
		}
	}

reconciled:
	select {
	case _, ok := <-events:
		if ok {
			t.Fatal("overflowed subscriber emitted events after reconcile")
		}
	case <-time.After(time.Second):
		t.Fatal("overflowed subscriber did not close")
	}
}
