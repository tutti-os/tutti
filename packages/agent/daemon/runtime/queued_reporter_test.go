package agentruntime

import (
	"context"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

type captureActivityClient struct {
	stateInputs    []canonical.ReportSessionStateInput
	messagesInputs []canonical.ReportSessionMessagesInput
	rejectMessages bool
}

func (c *captureActivityClient) ReportSessionState(_ context.Context, input canonical.ReportSessionStateInput) (canonical.ReportSessionStateReply, error) {
	c.stateInputs = append(c.stateInputs, input)
	return canonical.ReportSessionStateReply{Accepted: true}, nil
}

func (c *captureActivityClient) ReportSessionMessages(_ context.Context, input canonical.ReportSessionMessagesInput) (canonical.ReportSessionMessagesReply, error) {
	c.messagesInputs = append(c.messagesInputs, input)
	if c.rejectMessages {
		return canonical.ReportSessionMessagesReply{}, nil
	}
	return canonical.ReportSessionMessagesReply{AcceptedCount: len(input.Updates)}, nil
}

func TestQueuedReporterRejectsUnacceptedControlActivity(t *testing.T) {
	t.Parallel()
	client := &captureActivityClient{rejectMessages: true}
	reporter := QueuedReporter{ClientProvider: func() ActivityClient { return client }}
	err := reporter.Report(context.Background(), agentsessionstore.ReportActivityInput{
		WorkspaceID:   "room-1",
		Source:        canonical.EventSource{Provider: "codex", AgentID: "agent-1"},
		SessionAudits: []agentsessionstore.WorkspaceAgentSessionAuditUpdate{{AuditID: "audit-1", Role: "user"}},
	})
	if err == nil {
		t.Fatal("Report accepted an audit rejected by the durable client")
	}
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
		Source: canonical.EventSource{
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
