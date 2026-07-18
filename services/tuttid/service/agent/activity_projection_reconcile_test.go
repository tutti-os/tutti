package agent

import (
	"context"
	"errors"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestSettleStaleTurnsOnStartupReturnsRepositoryFailure(t *testing.T) {
	want := errors.New("settle stale turns failed")
	projection := NewActivityProjection(&activityProjectionRepoStub{settleStaleErr: want})
	if err := projection.SettleStaleTurnsOnStartup(context.Background()); !errors.Is(err, want) {
		t.Fatalf("SettleStaleTurnsOnStartup() error = %v, want %v", err, want)
	}
}

func TestSettleStaleTurnsOnStartupPublishesCommittedDelta(t *testing.T) {
	repo := &activityProjectionRepoStub{
		settlements: []agentactivitybiz.StaleTurnSettlement{{
			TransactionID: "transaction-1", WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
			CommitDelta: storesqlite.TransactionDelta{TransactionID: "transaction-1", Mutations: []storesqlite.TransactionMutation{
				{
					MutationID: "transaction-1:1", WorkspaceID: "ws-1", AgentSessionID: "session-1",
					EntityKind: storesqlite.MutationEntityTurn, EntityID: "turn-1", Operation: "settle", Version: 10,
				},
				{
					MutationID: "transaction-1:2", WorkspaceID: "ws-1", AgentSessionID: "session-1",
					EntityKind: storesqlite.MutationEntitySession, EntityID: "session-1", Operation: "upsert", Version: 10,
				},
			}},
		}},
		turnResults: map[string]agentactivitybiz.Turn{"session-1\x00turn-1": {
			WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
			Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeInterrupted,
		}},
	}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)

	if err := projection.SettleStaleTurnsOnStartup(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(publisher.events) != 2 || publisher.events[0].eventType != "session_reconcile_required" ||
		publisher.events[1].eventType != "turn_update" || publisher.events[1].agentSessionID != "session-1" {
		t.Fatalf("stale settlement events=%#v", publisher.events)
	}
}
