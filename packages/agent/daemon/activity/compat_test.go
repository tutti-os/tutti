package agentsessionstore

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestSessionMessageDecodesDurableSequenceAsInternalID(t *testing.T) {
	t.Parallel()

	var message WorkspaceAgentSessionMessage
	if err := json.Unmarshal([]byte(`{
		"sequence": 42,
		"agentSessionId": "session-1",
		"messageId": "message-1",
		"role": "assistant",
		"kind": "text",
		"occurredAtUnixMs": 100,
		"version": 7
	}`), &message); err != nil {
		t.Fatal(err)
	}

	if message.ID != 42 {
		t.Fatalf("ID = %d, want sequence 42", message.ID)
	}
}

func TestSessionMessageUpdateFromActivityUpdateUsesLifecycleTimeBeforeSeq(t *testing.T) {
	t.Parallel()

	update := SessionMessageUpdateFromActivityUpdate(WorkspaceAgentMessageUpdate{
		MessageID:       "message-1",
		Seq:             42,
		TurnID:          "turn-1",
		Role:            "assistant",
		Kind:            "text",
		StartedAtUnixMS: 1717200001000,
	})

	if update.OccurredAtUnixMS != 1717200001000 {
		t.Fatalf("OccurredAtUnixMS = %d, want lifecycle timestamp", update.OccurredAtUnixMS)
	}
}

func TestReportActivityAsSessionUpdatesRejectsTurnlessMessageUpdate(t *testing.T) {
	t.Parallel()

	reporter := &captureSessionReporter{}
	_, err := ReportActivityAsSessionUpdates(context.Background(), reporter, ReportActivityInput{
		WorkspaceID: "workspace-1",
		Source: EventSource{
			AgentID: "agent-session-1",
		},
		MessageUpdates: []WorkspaceAgentMessageUpdate{{
			MessageID:        "message-1",
			Seq:              42,
			Role:             "assistant",
			Kind:             "text",
			OccurredAtUnixMS: 1717200001000,
		}},
	})

	if err == nil {
		t.Fatal("ReportActivityAsSessionUpdates() error = nil, want missing turnId error")
	}
	if !strings.Contains(err.Error(), `message_update "message-1" is missing turnId`) {
		t.Fatalf("ReportActivityAsSessionUpdates() error = %v", err)
	}
	if len(reporter.inputs) != 0 {
		t.Fatalf("ReportSessionMessages calls = %d, want 0", len(reporter.inputs))
	}
}
