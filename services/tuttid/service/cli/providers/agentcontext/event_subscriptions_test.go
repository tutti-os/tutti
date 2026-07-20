package agentcontext

import (
	"context"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	cliservice "github.com/tutti-os/tutti/services/tuttid/service/cli"
)

type fakeAgentEventSubscriptions struct {
	*fakeAgentSessions
	createInput agenthost.CreateEventSubscriptionInput
}

func (f *fakeAgentEventSubscriptions) CreateEventSubscription(_ context.Context, input agenthost.CreateEventSubscriptionInput) (agentservice.EventSubscription, error) {
	f.createInput = input
	return storesqlite.EventSubscription{
		SubscriptionID: input.SubscriptionID, WorkspaceID: input.WorkspaceID,
		SubscriberAgentSessionID: input.SubscriberAgentSessionID, EventType: input.EventType, EventVersion: 1,
		SourceKind: "agent_turn", SourceID: input.SourceAgentSessionID, SourceSubjectID: input.SourceTurnID,
		Status: storesqlite.EventSubscriptionStatusActive,
	}, nil
}

func (*fakeAgentEventSubscriptions) ListEventSubscriptions(context.Context, string, string) ([]agentservice.EventSubscription, error) {
	return nil, nil
}

func (*fakeAgentEventSubscriptions) CancelEventSubscription(context.Context, string, string, string) (agentservice.EventSubscription, error) {
	return agentservice.EventSubscription{}, nil
}

func TestEventSubscriptionCommandsPublishCatalogAndDefaultToCallingSession(t *testing.T) {
	sessions := &fakeAgentEventSubscriptions{fakeAgentSessions: &fakeAgentSessions{}}
	provider := newTestProvider(fakeWorkspaceCatalog{startup: workspacebiz.Summary{ID: "workspace-1"}}, sessions)

	eventTypes := commandByID(t, provider.Commands(), appID+".agent.event-types")
	output, err := eventTypes.Handler(context.Background(), cliservice.InvokeRequest{OutputMode: cliservice.OutputModeJSON})
	if err != nil {
		t.Fatal(err)
	}
	items, ok := output.Value["eventTypes"].([]map[string]any)
	if !ok || len(items) != len(agentservice.EventTypeCatalog()) {
		t.Fatalf("event type catalog = %#v", output.Value["eventTypes"])
	}

	create := commandByID(t, provider.Commands(), appID+".agent.subscriptions.create")
	output, err = create.Handler(context.Background(), cliservice.InvokeRequest{
		OutputMode: cliservice.OutputModeJSON,
		Context:    cliservice.InvokeContext{WorkspaceID: "workspace-1", AgentSessionID: "subscriber-1"},
		Input: map[string]any{
			"subscription-id": "subscription-1", "event-type": agenthost.EventTypeAgentTurnCompleted,
			"source-session-id": "source-1", "source-turn-id": "turn-1",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if sessions.createInput.WorkspaceID != "workspace-1" || sessions.createInput.SubscriberAgentSessionID != "subscriber-1" ||
		sessions.createInput.SourceAgentSessionID != "source-1" || sessions.createInput.SourceTurnID != "turn-1" {
		t.Fatalf("create input = %#v", sessions.createInput)
	}
	if output.Value["status"] != storesqlite.EventSubscriptionStatusActive {
		t.Fatalf("create output = %#v", output.Value)
	}
}
