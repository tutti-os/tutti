package agent

import (
	"context"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
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
