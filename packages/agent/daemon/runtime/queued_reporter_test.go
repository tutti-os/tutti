package agentruntime

import (
	"context"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
)

type captureActivityClient struct {
	stateInputs    []agentsessionstore.ReportSessionStateInput
	messagesInputs []agentsessionstore.ReportSessionMessagesInput
}

func (c *captureActivityClient) ReportSessionState(_ context.Context, input agentsessionstore.ReportSessionStateInput) (agentsessionstore.ReportSessionStateReply, error) {
	c.stateInputs = append(c.stateInputs, input)
	return agentsessionstore.ReportSessionStateReply{Accepted: true}, nil
}

func (c *captureActivityClient) ReportSessionMessages(_ context.Context, input agentsessionstore.ReportSessionMessagesInput) (agentsessionstore.ReportSessionMessagesReply, error) {
	c.messagesInputs = append(c.messagesInputs, input)
	return agentsessionstore.ReportSessionMessagesReply{AcceptedCount: len(input.Updates)}, nil
}

func TestQueuedReporterCallsClientWithNormalizedRuntimeInput(t *testing.T) {
	t.Parallel()

	client := &captureActivityClient{}
	reporter := QueuedReporter{
		ClientProvider: func() ActivityClient {
			return client
		},
	}

	err := reporter.Report(context.Background(), agentsessionstore.ReportActivityInput{
		WorkspaceID: "room-1",
		Source: agentsessionstore.EventSource{
			Provider: "codex",
			AgentID:  "agent-1",
		},
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: "agent-1",
			Provider:       "codex",
			Title:          "Task",
		}},
		MessageUpdates: []agentsessionstore.WorkspaceAgentMessageUpdate{{
			AgentSessionID: "agent-1",
			MessageID:      "message-1",
			TurnID:         "turn-1",
			Role:           "assistant",
			Kind:           "text",
		}},
	})
	if err != nil {
		t.Fatalf("Report: %v", err)
	}
	if len(client.stateInputs) != 1 {
		t.Fatalf("state calls = %d, want 1", len(client.stateInputs))
	}
	if len(client.messagesInputs) != 1 {
		t.Fatalf("messages calls = %d, want 1", len(client.messagesInputs))
	}
	if client.stateInputs[0].Source.SessionOrigin != agentsessionstore.WorkspaceAgentSessionOriginRuntime {
		t.Fatalf("state session origin = %q, want runtime", client.stateInputs[0].Source.SessionOrigin)
	}
	if client.messagesInputs[0].Source.SessionOrigin != agentsessionstore.WorkspaceAgentSessionOriginRuntime {
		t.Fatalf("messages session origin = %q, want runtime", client.messagesInputs[0].Source.SessionOrigin)
	}
	if client.stateInputs[0].Connector == nil || client.stateInputs[0].Connector.ID != "codex" {
		t.Fatalf("state connector = %#v, want provider-backed connector", client.stateInputs[0].Connector)
	}
	if client.messagesInputs[0].Connector == nil || client.messagesInputs[0].Connector.ID != "codex" {
		t.Fatalf("messages connector = %#v, want provider-backed connector", client.messagesInputs[0].Connector)
	}
}
