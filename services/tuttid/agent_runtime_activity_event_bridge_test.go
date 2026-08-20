package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

func TestAgentRuntimeActivityEventBridgePublishesMessageDeltaToBusinessWebSocket(t *testing.T) {
	events := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	session := events.OpenSession()
	defer events.CloseSession(session)
	if err := events.Subscribe(
		session,
		[]string{eventstreamservice.TopicAgentActivityUpdated},
		eventstreamservice.EventScope{WorkspaceID: "workspace-1"},
	); err != nil {
		t.Fatal(err)
	}
	content, err := json.Marshal("Hel")
	if err != nil {
		t.Fatal(err)
	}
	delta, err := liveprotocol.NewMessageDeltaEvent(liveprotocol.MessageDeltaData{
		WorkspaceID:      "workspace-1",
		AgentSessionID:   "session-1",
		MessageID:        "message-1",
		TurnID:           "turn-1",
		Role:             "assistant",
		Kind:             "text",
		OccurredAtUnixMS: 100,
		Content: &liveprotocol.MessageContentOperation{
			Operation: "set",
			Value:     content,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	bridge := agentRuntimeActivityEventBridge{
		publisher: eventstreamservice.AgentActivityPublisher{Service: events},
	}
	if err := bridge.ObserveRuntimeStreamEvents(
		context.Background(),
		"workspace-1",
		"session-1",
		[]agentruntime.StreamEvent{{
			EventType: agentruntime.StreamEventMessageDelta,
			Data:      delta,
		}},
	); err != nil {
		t.Fatal(err)
	}

	select {
	case published := <-events.Events(session):
		var payload struct {
			WorkspaceID    string          `json:"workspaceId"`
			AgentSessionID string          `json:"agentSessionId"`
			EventType      string          `json:"eventType"`
			Data           json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(published.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.WorkspaceID != "workspace-1" ||
			payload.AgentSessionID != "session-1" ||
			payload.EventType != "message_delta" {
			t.Fatalf("payload = %#v", payload)
		}
		var got liveprotocol.MessageDeltaData
		if err := json.Unmarshal(payload.Data, &got); err != nil {
			t.Fatal(err)
		}
		if got.MessageID != "message-1" || got.Content == nil || string(got.Content.Value) != `"Hel"` {
			t.Fatalf("delta data = %#v", got)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for message_delta")
	}
}

func TestAgentRuntimeActivityEventBridgeReconcilesMismatchedMessageDelta(t *testing.T) {
	events := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	session := events.OpenSession()
	defer events.CloseSession(session)
	if err := events.Subscribe(
		session,
		[]string{eventstreamservice.TopicAgentActivityUpdated},
		eventstreamservice.EventScope{WorkspaceID: "workspace-1"},
	); err != nil {
		t.Fatal(err)
	}
	content, err := json.Marshal("Hel")
	if err != nil {
		t.Fatal(err)
	}
	delta, err := liveprotocol.NewMessageDeltaEvent(liveprotocol.MessageDeltaData{
		WorkspaceID:      "workspace-2",
		AgentSessionID:   "session-2",
		MessageID:        "message-1",
		TurnID:           "turn-1",
		Role:             "assistant",
		Kind:             "text",
		OccurredAtUnixMS: 100,
		Content: &liveprotocol.MessageContentOperation{
			Operation: "set",
			Value:     content,
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	bridge := agentRuntimeActivityEventBridge{
		publisher: eventstreamservice.AgentActivityPublisher{Service: events},
	}
	if filtered := bridge.FilterRuntimeStreamEvents("workspace-1", "session-1", []agentruntime.StreamEvent{{
		EventType: agentruntime.StreamEventMessageDelta,
		Data:      delta,
	}}); len(filtered) != 0 {
		t.Fatalf("filtered events = %#v, want mismatched delta withheld", filtered)
	}
	if filtered := bridge.FilterRuntimeStreamEvents("workspace-1", "session-1", []agentruntime.StreamEvent{{
		EventType: agentruntime.StreamEventStatePatch,
		Data:      delta,
	}}); len(filtered) != 0 {
		t.Fatalf("filtered relabeled delta = %#v, want malformed delta withheld", filtered)
	}
	if err := bridge.ObserveRuntimeStreamEvents(
		context.Background(),
		"workspace-1",
		"session-1",
		[]agentruntime.StreamEvent{{
			EventType: agentruntime.StreamEventStatePatch,
			Data:      delta,
		}},
	); err == nil {
		t.Fatal("ObserveRuntimeStreamEvents() error = nil for relabeled delta, want identity mismatch")
	}
	if err := bridge.ObserveRuntimeStreamEvents(
		context.Background(),
		"workspace-1",
		"session-1",
		[]agentruntime.StreamEvent{{
			EventType: agentruntime.StreamEventMessageDelta,
			Data:      delta,
		}},
	); err == nil {
		t.Fatal("ObserveRuntimeStreamEvents() error = nil, want identity mismatch")
	}

	select {
	case published := <-events.Events(session):
		var payload struct {
			WorkspaceID    string          `json:"workspaceId"`
			AgentSessionID string          `json:"agentSessionId"`
			EventType      string          `json:"eventType"`
			Data           json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(published.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.WorkspaceID != "workspace-1" ||
			payload.AgentSessionID != "session-1" ||
			payload.EventType != "session_reconcile_required" {
			t.Fatalf("payload = %#v, want expected session reconcile event", payload)
		}
		var data struct {
			WorkspaceID    string `json:"workspaceId"`
			AgentSessionID string `json:"agentSessionId"`
			EventType      string `json:"eventType"`
			LastEvent      int64  `json:"lastEventUnixMs"`
		}
		if err := json.Unmarshal(payload.Data, &data); err != nil {
			t.Fatal(err)
		}
		if data.WorkspaceID != "workspace-1" || data.AgentSessionID != "session-1" ||
			data.EventType != "session_reconcile_required" || data.LastEvent <= 0 {
			t.Fatalf("reconcile data = %#v", data)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for session_reconcile_required")
	}
}
