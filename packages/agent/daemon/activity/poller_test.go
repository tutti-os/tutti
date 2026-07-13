package agentsessionstore

import (
	"context"
	"testing"
)

func TestPollerListsAgentsAndFetchesIncrementalMessagesWithNextCursors(t *testing.T) {
	t.Parallel()

	client := &fakePollClient{
		snapshot: &WorkspaceAgentSnapshot{
			Sessions: []ProviderActivitySessionProjection{
				{AgentSessionID: "session-1", SessionOrigin: WorkspaceAgentSessionOriginRuntime},
				{AgentSessionID: "session-2", SessionOrigin: WorkspaceAgentSessionOriginRuntime},
			},
		},
		messages: map[string]ListSessionMessagesReply{
			"session-1": {
				Messages:      []WorkspaceAgentSessionMessage{{Version: 4}, {Version: 7}},
				LatestVersion: 7,
			},
			"session-2": {
				Messages:      []WorkspaceAgentSessionMessage{{Version: 1}},
				LatestVersion: 1,
			},
		},
	}
	poller := NewPoller(client, PollerOptions{Limit: 20})

	result, err := poller.Poll(context.Background(), "ws-1", map[string]SessionCursor{
		"session-1": {AfterVersion: 3},
	})
	if err != nil {
		t.Fatalf("Poll() error = %v", err)
	}
	if len(client.inputs) != 2 {
		t.Fatalf("inputs = %#v", client.inputs)
	}
	if client.inputs[0].WorkspaceID != "ws-1" || client.inputs[0].AgentSessionID != "session-1" {
		t.Fatalf("first input = %#v", client.inputs[0])
	}
	if client.inputs[0].AfterVersion != 3 || client.inputs[0].Limit != 20 {
		t.Fatalf("first cursor input = %#v", client.inputs[0])
	}
	if client.inputs[0].SessionOrigin != WorkspaceAgentSessionOriginRuntime {
		t.Fatalf("first origin = %q, want runtime", client.inputs[0].SessionOrigin)
	}
	if result.Cursors["session-1"].AfterVersion != 7 {
		t.Fatalf("session-1 next cursor = %#v", result.Cursors["session-1"])
	}
	if result.Cursors["session-2"].AfterVersion != 1 {
		t.Fatalf("session-2 next cursor = %#v", result.Cursors["session-2"])
	}
}

type fakePollClient struct {
	snapshot *WorkspaceAgentSnapshot
	messages map[string]ListSessionMessagesReply
	inputs   []ListSessionMessagesInput
}

func (f *fakePollClient) ListAgents(context.Context, string) (*WorkspaceAgentSnapshot, error) {
	return f.snapshot, nil
}

func (f *fakePollClient) ListSessionMessages(_ context.Context, input ListSessionMessagesInput) (*ListSessionMessagesReply, error) {
	f.inputs = append(f.inputs, input)
	messages := f.messages[input.AgentSessionID]
	return &messages, nil
}
