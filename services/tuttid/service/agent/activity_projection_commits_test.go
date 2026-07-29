package agent

import (
	"context"
	"reflect"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestActivityProjectionConsumesCanonicalViewInvalidation(t *testing.T) {
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(&activityProjectionRepoStub{})
	projection.SetPublisher(publisher)
	delta := agenthost.CanonicalDelta(storesqlite.TransactionDelta{
		TransactionID: "transaction-1",
		Mutations: []storesqlite.TransactionMutation{{
			MutationID: "transaction-1:1", WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			EntityKind: storesqlite.MutationEntitySession, EntityID: "session-1", Operation: "upsert", Version: 42,
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
