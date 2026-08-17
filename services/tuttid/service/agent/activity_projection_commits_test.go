package agent

import (
	"context"
	"reflect"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

func TestActivityProjectionConsumesCanonicalViewInvalidation(t *testing.T) {
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(&activityProjectionRepoStub{})
	projection.SetPublisher(publisher)
	delta := agenthost.CanonicalDelta(agentactivitybiz.TransactionDelta{
		TransactionID: "transaction-1",
		Mutations: []agentactivitybiz.TransactionMutation{{
			MutationID: "transaction-1:1", WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			EntityKind: agentactivitybiz.MutationEntitySession, EntityID: "session-1", Operation: "upsert", Version: 42,
		}},
	})

	if err := projection.ObserveCommitted(context.Background(), delta); err != nil {
		t.Fatal(err)
	}
	if len(publisher.events) != 1 || publisher.events[0].eventType != "session_reconcile_required" ||
		publisher.events[0].payload["lastEventUnixMs"] != int64(42) {
		t.Fatalf("canonical invalidation events=%#v", publisher.events)
	}
}

func TestActivityProjectionPublishesCanonicalSessionRestore(t *testing.T) {
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(&activityProjectionRepoStub{})
	projection.SetPublisher(publisher)
	delta := agenthost.CanonicalDelta(agentactivitybiz.TransactionDelta{
		TransactionID: "transaction-restore",
		Mutations: []agentactivitybiz.TransactionMutation{{
			MutationID: "transaction-restore:1", WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			EntityKind: agentactivitybiz.MutationEntitySession, EntityID: "session-1", Operation: "restore", Version: 42,
		}},
	})

	if err := projection.ObserveCommitted(context.Background(), delta); err != nil {
		t.Fatal(err)
	}
	if len(publisher.events) != 1 || publisher.events[0].eventType != "session_restored" ||
		publisher.events[0].payload["workspaceId"] != "workspace-1" ||
		publisher.events[0].payload["agentSessionId"] != "session-1" {
		t.Fatalf("canonical restore events=%#v", publisher.events)
	}
	if restoredAt, ok := publisher.events[0].payload["restoredAtUnixMs"].(int64); !ok || restoredAt <= 0 {
		t.Fatalf("canonical restore timestamp=%#v", publisher.events[0].payload["restoredAtUnixMs"])
	}
}

func TestActivityProjectionPublishesRuntimeActivityObservation(t *testing.T) {
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(&activityProjectionRepoStub{})
	projection.SetPublisher(publisher)
	err := projection.ObserveCommitted(context.Background(), agenthost.CommittedDelta{
		ActivityState: &agenthost.ActivityStateCommitted{
			Input: canonical.ReportSessionStateInput{
				WorkspaceID:    "workspace-1",
				AgentSessionID: "session-1",
				State: canonical.WorkspaceAgentSessionStateUpdate{
					OccurredAtUnixMS: 42,
					RuntimeActivity: &canonical.WorkspaceAgentRuntimeActivityObservation{
						State: "running", OccurredAtUnixMS: 42,
					},
				},
			},
			Result: agentactivitybiz.ActivityStateReportResult{
				State: agentactivitybiz.StateReportResult{
					Accepted:        true,
					StateApplied:    true,
					LastEventUnixMS: 42,
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}

	if len(publisher.events) != 2 {
		t.Fatalf("published events=%#v, want runtime activity and reconcile", publisher.events)
	}
	event := publisher.events[0]
	if event.eventType != "runtime_activity_update" || event.payload["state"] != "running" ||
		event.payload["occurredAtUnixMs"] != int64(42) {
		t.Fatalf("runtime activity event=%#v", event)
	}
}

func TestActivityProjectionDoesNotPublishStaleRuntimeActivityObservation(t *testing.T) {
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(&activityProjectionRepoStub{})
	projection.SetPublisher(publisher)
	err := projection.ObserveCommitted(context.Background(), agenthost.CommittedDelta{
		ActivityState: &agenthost.ActivityStateCommitted{
			Input: canonical.ReportSessionStateInput{
				WorkspaceID:    "workspace-1",
				AgentSessionID: "session-1",
				State: canonical.WorkspaceAgentSessionStateUpdate{
					RuntimeActivity: &canonical.WorkspaceAgentRuntimeActivityObservation{
						State: "running", OccurredAtUnixMS: 41,
					},
				},
			},
			Result: agentactivitybiz.ActivityStateReportResult{
				State: agentactivitybiz.StateReportResult{
					Accepted: true, StateApplied: false, LastEventUnixMS: 42,
				},
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, event := range publisher.events {
		if event.eventType == "runtime_activity_update" {
			t.Fatalf("stale runtime activity was published: %#v", publisher.events)
		}
	}
}

func TestRuntimeActivityPayloadPassesEventstreamCatalog(t *testing.T) {
	service := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	publisher := eventstreamservice.AgentActivityPublisher{Service: service}
	err := publisher.PublishAgentActivityUpdated(
		context.Background(),
		"workspace-1",
		"session-1",
		"runtime_activity_update",
		map[string]any{
			"workspaceId":      "workspace-1",
			"agentSessionId":   "session-1",
			"eventType":        "runtime_activity_update",
			"state":            "running",
			"occurredAtUnixMs": int64(42),
		},
	)
	if err != nil {
		t.Fatalf("runtime activity payload failed eventstream validation: %v", err)
	}
}

func TestSessionRestoredPayloadPassesEventstreamCatalog(t *testing.T) {
	service := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	publisher := eventstreamservice.AgentActivityPublisher{Service: service}
	err := publisher.PublishAgentActivityUpdated(
		context.Background(),
		"workspace-1",
		"session-1",
		"session_restored",
		map[string]any{
			"workspaceId":      "workspace-1",
			"agentSessionId":   "session-1",
			"eventType":        "session_restored",
			"restoredAtUnixMs": int64(42),
		},
	)
	if err != nil {
		t.Fatalf("session restored payload failed eventstream validation: %v", err)
	}
}

func TestProjectedMessageSemanticsPassesEventstreamCatalog(t *testing.T) {
	t.Parallel()

	service := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	publisher := eventstreamservice.AgentActivityPublisher{Service: service}
	payload := map[string]any{
		"latestVersion": uint64(1),
		"acceptedCount": 1,
		"messages": activityMessagesEventPayload([]agentactivitybiz.Message{{
			ID:               1,
			AgentSessionID:   "session-1",
			MessageID:        "message-1",
			TurnID:           "turn-1",
			Role:             "assistant",
			Kind:             "text",
			Version:          1,
			OccurredAtUnixMS: 42,
			Payload:          map[string]any{"text": "hello"},
			Semantics: &agentactivitybiz.MessageSemantics{
				UserVisibleAssistantResponse: true,
				TurnSettling:                 true,
				NoticeCommand:                "compact",
				NoticeCommandStatus:          "running",
			},
		}}),
	}
	if err := publisher.PublishAgentActivityUpdated(
		context.Background(),
		"workspace-1",
		"session-1",
		"message_update",
		payload,
	); err != nil {
		t.Fatalf("projected message semantics failed eventstream validation: %v", err)
	}
}

func TestCanonicalMessagesForRealtimePublishSuppressesOnlyProjectedRuntimeDeltas(t *testing.T) {
	streamingText := agentactivitybiz.Message{
		MessageID: "streaming-text",
		TurnID:    "turn-1",
		Kind:      "text",
		Status:    "streaming",
		Payload:   map[string]any{"contentMode": "snapshot"},
	}
	streamingReasoning := agentactivitybiz.Message{
		MessageID: "streaming-reasoning",
		TurnID:    "turn-1",
		Kind:      "reasoning",
		Status:    "streaming",
		Payload:   map[string]any{"contentMode": "snapshot"},
	}
	terminalText := agentactivitybiz.Message{
		MessageID: "terminal-text",
		TurnID:    "turn-1",
		Kind:      "text",
		Status:    "completed",
		Payload:   map[string]any{"contentMode": "snapshot"},
	}
	runningTool := agentactivitybiz.Message{
		MessageID: "running-tool",
		TurnID:    "turn-1",
		Kind:      "tool_call",
		Status:    "running",
		Payload:   map[string]any{"source": "runtime"},
	}
	runningToolOutput := agentactivitybiz.Message{
		MessageID: "running-tool-output",
		TurnID:    "turn-1",
		Kind:      "tool_call",
		Status:    "running",
		Payload: map[string]any{
			"source": "runtime",
			"output": map[string]any{"text": "partial stdout"},
		},
	}
	completedToolOutput := agentactivitybiz.Message{
		MessageID: "completed-tool-output",
		TurnID:    "turn-1",
		Kind:      "tool_call",
		Status:    "completed",
		Payload: map[string]any{
			"source": "runtime",
			"output": map[string]any{"text": "final stdout"},
		},
	}
	unprojectedText := agentactivitybiz.Message{
		MessageID: "unprojected-text",
		TurnID:    "turn-1",
		Kind:      "text",
		Status:    "streaming",
		Payload:   map[string]any{"contentMode": "replacement"},
	}
	messages := []agentactivitybiz.Message{
		streamingText,
		streamingReasoning,
		terminalText,
		runningTool,
		runningToolOutput,
		completedToolOutput,
		unprojectedText,
	}

	got := canonicalMessagesForRealtimePublish(
		canonical.ReportSessionMessagesInput{
			SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		},
		messages,
	)
	want := []agentactivitybiz.Message{terminalText, runningTool, completedToolOutput, unprojectedText}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("filtered messages = %#v, want %#v", got, want)
	}

	imported := canonicalMessagesForRealtimePublish(
		canonical.ReportSessionMessagesInput{SessionOrigin: "external_import"},
		messages,
	)
	if !reflect.DeepEqual(imported, messages) {
		t.Fatalf("non-runtime messages changed: %#v", imported)
	}
}
