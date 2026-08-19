package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	"github.com/tutti-os/tutti/packages/agent/daemon/liveprotocol"
	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

func TestAgentRuntimeSideEventBridgePublishesOnlyOnTransientTopic(t *testing.T) {
	events := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	sideSubscriber := events.OpenSession()
	defer events.CloseSession(sideSubscriber)
	activitySubscriber := events.OpenSession()
	defer events.CloseSession(activitySubscriber)
	scope := eventstreamservice.EventScope{WorkspaceID: "workspace-1"}
	if err := events.Subscribe(sideSubscriber, []string{eventstreamservice.TopicAgentSideUpdated}, scope); err != nil {
		t.Fatal(err)
	}
	if err := events.Subscribe(activitySubscriber, []string{eventstreamservice.TopicAgentActivityUpdated}, scope); err != nil {
		t.Fatal(err)
	}
	bridge := &agentRuntimeSideEventBridge{
		publisher: eventstreamservice.AgentSidePublisher{Service: events},
		session: func(workspaceID, sideID string) (agentruntime.Session, bool) {
			return agentruntime.Session{
				RoomID: workspaceID, AgentSessionID: sideID,
				Scope:                agentruntime.RuntimeSessionScopeSide,
				SourceAgentSessionID: "source-1",
			}, true
		},
	}
	if err := bridge.ObserveRuntimeStreamEvents(
		context.Background(),
		"workspace-1",
		"side-1",
		[]agentruntime.StreamEvent{{
			EventType: agentruntime.StreamEventStatePatch,
			Data:      map[string]any{"status": "running"},
		}},
	); err != nil {
		t.Fatal(err)
	}

	select {
	case published := <-events.Events(sideSubscriber):
		if published.Topic != eventstreamservice.TopicAgentSideUpdated {
			t.Fatalf("topic = %q", published.Topic)
		}
		var payload struct {
			SideAgentSessionID   string `json:"sideAgentSessionId"`
			SourceAgentSessionID string `json:"sourceAgentSessionId"`
			Sequence             int64  `json:"sequence"`
		}
		if err := json.Unmarshal(published.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.SideAgentSessionID != "side-1" ||
			payload.SourceAgentSessionID != "source-1" ||
			payload.Sequence != 1 {
			t.Fatalf("payload = %#v", payload)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for Side event")
	}
	select {
	case event := <-events.Events(activitySubscriber):
		t.Fatalf("Side event leaked into canonical activity topic: %#v", event)
	default:
	}

	if err := bridge.ObserveRuntimeStreamEvents(
		context.Background(),
		"workspace-1",
		"side-1",
		[]agentruntime.StreamEvent{{
			EventType: agentruntime.StreamEventStatePatch,
			Data: agentsessionstore.WorkspaceAgentStatePatch{
				LifecycleStatus: agentruntime.SessionStatusCompleted,
			},
		}},
	); err != nil {
		t.Fatal(err)
	}
	select {
	case <-events.Events(sideSubscriber):
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for terminal Side event")
	}

	if err := bridge.ObserveRuntimeStreamEvents(
		context.Background(),
		"workspace-1",
		"side-1",
		[]agentruntime.StreamEvent{{
			EventType: agentruntime.StreamEventStatePatch,
			Data:      map[string]any{"status": "new-identity"},
		}},
	); err != nil {
		t.Fatal(err)
	}
	select {
	case published := <-events.Events(sideSubscriber):
		var payload struct {
			Sequence int64 `json:"sequence"`
		}
		if err := json.Unmarshal(published.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Sequence != 1 {
			t.Fatalf("sequence after terminal cleanup = %d, want 1", payload.Sequence)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for restarted Side event")
	}
}

func TestAgentRuntimeSideEventBridgeDoesNotAdvanceSequenceForSkippedOrFailedEvents(t *testing.T) {
	events := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	subscriber := events.OpenSession()
	defer events.CloseSession(subscriber)
	if err := events.Subscribe(
		subscriber,
		[]string{eventstreamservice.TopicAgentSideUpdated},
		eventstreamservice.EventScope{WorkspaceID: "workspace-1"},
	); err != nil {
		t.Fatal(err)
	}
	bridge := &agentRuntimeSideEventBridge{
		publisher: eventstreamservice.AgentSidePublisher{Service: events},
		session: func(workspaceID, sideID string) (agentruntime.Session, bool) {
			return agentruntime.Session{
				RoomID: workspaceID, AgentSessionID: sideID,
				Scope:                agentruntime.RuntimeSessionScopeSide,
				SourceAgentSessionID: "source-1",
			}, true
		},
	}
	validEvent := agentruntime.StreamEvent{
		EventType: agentruntime.StreamEventStatePatch,
		Data:      map[string]any{"status": "running"},
	}
	identityMismatch := liveprotocol.Event{
		WorkspaceID:    "other-workspace",
		AgentSessionID: "other-side",
		EventType:      liveprotocol.EventTypeSessionAudit,
		Data:           json.RawMessage(`{"status":"ignored"}`),
	}
	if err := bridge.ObserveRuntimeStreamEvents(
		context.Background(), "workspace-1", "side-1", []agentruntime.StreamEvent{
			{EventType: agentruntime.StreamEventSessionAudit, Data: identityMismatch},
			validEvent,
			{EventType: agentruntime.StreamEventStatePatch, Data: make(chan int)},
			validEvent,
		},
	); err == nil {
		t.Fatal("expected rejected Side events to be reported")
	}
	for wantSequence := int64(1); wantSequence <= 2; wantSequence++ {
		select {
		case published := <-events.Events(subscriber):
			var payload struct {
				Sequence int64 `json:"sequence"`
			}
			if err := json.Unmarshal(published.Payload, &payload); err != nil {
				t.Fatal(err)
			}
			if payload.Sequence != wantSequence {
				t.Fatalf("published sequence = %d, want %d", payload.Sequence, wantSequence)
			}
		case <-time.After(time.Second):
			t.Fatalf("timed out waiting for Side event sequence %d", wantSequence)
		}
	}
	select {
	case event := <-events.Events(subscriber):
		t.Fatalf("rejected Side event was published: %#v", event)
	default:
	}
}

func TestAgentRuntimeSideEventBridgeForgetResetsSequence(t *testing.T) {
	events := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	subscriber := events.OpenSession()
	defer events.CloseSession(subscriber)
	if err := events.Subscribe(
		subscriber,
		[]string{eventstreamservice.TopicAgentSideUpdated},
		eventstreamservice.EventScope{WorkspaceID: "workspace-1"},
	); err != nil {
		t.Fatal(err)
	}
	bridge := &agentRuntimeSideEventBridge{
		publisher: eventstreamservice.AgentSidePublisher{Service: events},
		session: func(workspaceID, sideID string) (agentruntime.Session, bool) {
			return agentruntime.Session{
				RoomID: workspaceID, AgentSessionID: sideID,
				Scope:                agentruntime.RuntimeSessionScopeSide,
				SourceAgentSessionID: "source-1",
			}, true
		},
	}
	input := []agentruntime.StreamEvent{{
		EventType: agentruntime.StreamEventStatePatch,
		Data:      map[string]any{"status": "running"},
	}}
	if err := bridge.ObserveRuntimeStreamEvents(
		context.Background(), "workspace-1", "side-1", input,
	); err != nil {
		t.Fatal(err)
	}
	select {
	case <-events.Events(subscriber):
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for initial Side event")
	}

	bridge.ForgetSideConversation("workspace-1", "side-1")
	if err := bridge.ObserveRuntimeStreamEvents(
		context.Background(), "workspace-1", "side-1", input,
	); err != nil {
		t.Fatal(err)
	}
	select {
	case published := <-events.Events(subscriber):
		var payload struct {
			Sequence int64 `json:"sequence"`
		}
		if err := json.Unmarshal(published.Payload, &payload); err != nil {
			t.Fatal(err)
		}
		if payload.Sequence != 1 {
			t.Fatalf("sequence after explicit cleanup = %d, want 1", payload.Sequence)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for restarted Side event")
	}
}
