package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

func TestMobileAgentLiveEventSourceSubscribesBeforeReady(t *testing.T) {
	t.Parallel()

	events := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	source := mobileAgentLiveEventSource{events: events}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	readyEntered := make(chan struct{})
	releaseReady := make(chan struct{})
	emitted := make(chan []byte, 1)
	done := make(chan error, 1)
	go func() {
		done <- source.StreamAgentActivity(
			ctx,
			"workspace-1",
			func() error {
				close(readyEntered)
				<-releaseReady
				return nil
			},
			func(payload []byte) error {
				emitted <- payload
				cancel()
				return nil
			},
		)
	}()

	select {
	case <-readyEntered:
	case <-time.After(time.Second):
		t.Fatal("event source did not report ready")
	}

	publisher := eventstreamservice.AgentActivityPublisher{Service: events}
	if err := publisher.PublishAgentActivityUpdatedJSON(
		context.Background(),
		"workspace-1",
		"session-1",
		"message_delta",
		json.RawMessage(`{
			"workspaceId":"workspace-1",
			"agentSessionId":"session-1",
			"messageId":"message-1",
			"turnId":"turn-1",
			"role":"assistant",
			"kind":"text",
			"occurredAtUnixMs":10,
			"content":{"operation":"set","value":"hello"}
		}`),
	); err != nil {
		t.Fatal(err)
	}
	close(releaseReady)

	select {
	case payload := <-emitted:
		if len(payload) == 0 {
			t.Fatal("event source emitted an empty payload")
		}
	case <-time.After(time.Second):
		t.Fatal("event published after subscribe but before ready was lost")
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("event source did not stop after cancellation")
	}
}
