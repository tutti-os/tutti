package storesqlite

import (
	"context"
	"errors"
	"testing"
	"time"
)

func openEventSubscriptionTestStore(t *testing.T) *Store {
	t.Helper()
	opts := testOptions(&staticProjectPaths{})
	opts.TransactionParticipant = EventSubscriptionParticipant{}
	return openTestStore(t, opts)
}

func TestTerminalTurnAtomicallyMatchesOneShotEventSubscription(t *testing.T) {
	t.Parallel()
	store := openEventSubscriptionTestStore(t)
	ctx := context.Background()
	for _, sessionID := range []string{"subscriber", "source"} {
		if _, err := store.ReportSessionState(ctx, SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: sessionID, Provider: "codex", OccurredAtUnixMS: 10,
		}); err != nil {
			t.Fatalf("seed session %s: %v", sessionID, err)
		}
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "source", TurnID: "turn-1",
		Phase: TurnPhaseRunning, Origin: TurnOriginUserPrompt, OccurredAtUnixMS: 12,
	}); err != nil || !accepted {
		t.Fatalf("seed source turn accepted=%v err=%v", accepted, err)
	}
	subscription, created, err := store.CreateEventSubscription(ctx, CreateEventSubscriptionInput{
		SubscriptionID: "subscription-1", WorkspaceID: "ws-1",
		SubscriberAgentSessionID: "subscriber", EventType: "agent.turn.completed", EventVersion: 1,
		SourceKind: "agent_turn", SourceID: "source", NowUnixMS: 15,
	})
	if err != nil || !created || subscription.Status != EventSubscriptionStatusActive {
		t.Fatalf("created subscription=%#v created=%v err=%v", subscription, created, err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "source", TurnID: "turn-1",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 20,
	}); err != nil || !accepted {
		t.Fatalf("settle source turn accepted=%v err=%v", accepted, err)
	}

	matched, found, err := store.GetEventSubscription(ctx, "ws-1", "subscription-1")
	if err != nil || !found || matched.Status != EventSubscriptionStatusMatched || matched.MatchedEventID == "" {
		t.Fatalf("matched subscription=%#v found=%v err=%v", matched, found, err)
	}
	deliveries, err := store.ListClaimableEventDeliveries(ctx, 20, 10)
	if err != nil || len(deliveries) != 1 {
		t.Fatalf("claimable deliveries=%#v err=%v", deliveries, err)
	}
	delivery := deliveries[0]
	if delivery.EventType != "agent.turn.completed" || delivery.EventVersion != 1 || delivery.SourceKind != "agent_turn" || delivery.SourceID != "source" || delivery.SourceSubjectID != "turn-1" || delivery.SubscriberAgentSessionID != "subscriber" {
		t.Fatalf("delivery=%#v", delivery)
	}

	// A provider replay of the same terminal fact must not enqueue another
	// delivery; the canonical turn transition is already settled and the
	// subscription is already matched.
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "source", TurnID: "turn-1",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 20,
	}); err != nil || accepted {
		t.Fatalf("duplicate settle accepted=%v err=%v", accepted, err)
	}
	deliveries, err = store.ListClaimableEventDeliveries(ctx, 20, 10)
	if err != nil || len(deliveries) != 1 {
		t.Fatalf("deliveries after replay=%#v err=%v", deliveries, err)
	}
}

func TestEventDeliveryLeaseRecoversAfterRestart(t *testing.T) {
	t.Parallel()
	store := openEventSubscriptionTestStore(t)
	ctx := context.Background()
	for _, sessionID := range []string{"subscriber", "source"} {
		if _, err := store.ReportSessionState(ctx, SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: sessionID, Provider: "codex", OccurredAtUnixMS: 10,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "source", TurnID: "turn-1",
		Phase: TurnPhaseRunning, Origin: TurnOriginUserPrompt, OccurredAtUnixMS: 11,
	}); err != nil || !accepted {
		t.Fatalf("seed turn accepted=%v err=%v", accepted, err)
	}
	if _, _, err := store.CreateEventSubscription(ctx, CreateEventSubscriptionInput{
		SubscriptionID: "subscription-1", WorkspaceID: "ws-1", SubscriberAgentSessionID: "subscriber",
		EventType: "agent.turn.failed", EventVersion: 1, SourceKind: "agent_turn", SourceID: "source", NowUnixMS: 12,
	}); err != nil {
		t.Fatal(err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "source", TurnID: "turn-1",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeFailed, OccurredAtUnixMS: 13,
	}); err != nil || !accepted {
		t.Fatalf("settle accepted=%v err=%v", accepted, err)
	}
	deliveries, err := store.ListClaimableEventDeliveries(ctx, 13, 1)
	if err != nil || len(deliveries) != 1 {
		t.Fatalf("deliveries=%#v err=%v", deliveries, err)
	}
	leased, claimed, err := store.ClaimEventDelivery(ctx, ClaimEventDeliveryInput{
		DeliveryID: deliveries[0].DeliveryID, LeaseOwner: "worker-a", NowUnixMS: 13, LeaseExpiresAtUnixMS: 100,
	})
	if err != nil || !claimed || leased.Attempt != 1 {
		t.Fatalf("leased=%#v claimed=%v err=%v", leased, claimed, err)
	}
	if count, err := store.RequeueLeasedEventDeliveriesOnStartup(ctx, 20); err != nil || count != 1 {
		t.Fatalf("requeued=%d err=%v", count, err)
	}
	recovered, claimed, err := store.ClaimEventDelivery(ctx, ClaimEventDeliveryInput{
		DeliveryID: leased.DeliveryID, LeaseOwner: "worker-b", NowUnixMS: 20, LeaseExpiresAtUnixMS: 120,
	})
	if err != nil || !claimed || recovered.Attempt != 2 {
		t.Fatalf("recovered=%#v claimed=%v err=%v", recovered, claimed, err)
	}
}

func TestEventSubscriptionCallerIDIsIdempotentButCannotBeRebound(t *testing.T) {
	t.Parallel()
	store := openEventSubscriptionTestStore(t)
	ctx := context.Background()
	for _, sessionID := range []string{"subscriber", "source-a", "source-b"} {
		if _, err := store.ReportSessionState(ctx, SessionStateReport{
			WorkspaceID: "ws-1", AgentSessionID: sessionID, Provider: "codex", OccurredAtUnixMS: 10,
		}); err != nil {
			t.Fatal(err)
		}
	}
	input := CreateEventSubscriptionInput{
		SubscriptionID: "caller-id", WorkspaceID: "ws-1", SubscriberAgentSessionID: "subscriber",
		EventType: "agent.turn.completed", EventVersion: 1, SourceKind: "agent_turn", SourceID: "source-a", NowUnixMS: 11,
	}
	created, wasCreated, err := store.CreateEventSubscription(ctx, input)
	if err != nil || !wasCreated {
		t.Fatalf("create = %#v, %v, %v", created, wasCreated, err)
	}
	replayed, wasCreated, err := store.CreateEventSubscription(ctx, input)
	if err != nil || wasCreated || replayed.SubscriptionID != created.SubscriptionID {
		t.Fatalf("replay = %#v, %v, %v", replayed, wasCreated, err)
	}
	input.SourceID = "source-b"
	if _, _, err := store.CreateEventSubscription(ctx, input); !errors.Is(err, ErrEventSubscriptionConflict) {
		t.Fatalf("conflicting replay error = %v, want %v", err, ErrEventSubscriptionConflict)
	}
}

func TestDeletingSourceCancelsActiveSubscriptionButPreservesPreparedDelivery(t *testing.T) {
	t.Parallel()
	store := openEventSubscriptionTestStore(t)
	ctx := context.Background()
	for _, sessionID := range []string{"subscriber", "source"} {
		if _, err := store.ReportSessionState(ctx, SessionStateReport{
			WorkspaceID: "ws-delete", AgentSessionID: sessionID, Provider: "codex", OccurredAtUnixMS: 10,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-delete", AgentSessionID: "source", TurnID: "turn-1",
		Phase: TurnPhaseRunning, Origin: TurnOriginUserPrompt, OccurredAtUnixMS: 11,
	}); err != nil || !accepted {
		t.Fatalf("seed turn accepted=%v err=%v", accepted, err)
	}
	for _, input := range []CreateEventSubscriptionInput{
		{
			SubscriptionID: "matched", WorkspaceID: "ws-delete", SubscriberAgentSessionID: "subscriber",
			EventType: "agent.turn.completed", EventVersion: 1, SourceKind: "agent_turn", SourceID: "source", NowUnixMS: 12,
		},
		{
			SubscriptionID: "still-active", WorkspaceID: "ws-delete", SubscriberAgentSessionID: "subscriber",
			EventType: "agent.turn.failed", EventVersion: 1, SourceKind: "agent_turn", SourceID: "source", NowUnixMS: 12,
		},
	} {
		if _, _, err := store.CreateEventSubscription(ctx, input); err != nil {
			t.Fatal(err)
		}
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-delete", AgentSessionID: "source", TurnID: "turn-1",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 13,
	}); err != nil || !accepted {
		t.Fatalf("settle accepted=%v err=%v", accepted, err)
	}
	if removed, err := store.DeleteSession(ctx, "ws-delete", "source"); err != nil || !removed {
		t.Fatalf("delete source removed=%v err=%v", removed, err)
	}
	active, found, err := store.GetEventSubscription(ctx, "ws-delete", "still-active")
	if err != nil || !found || active.Status != EventSubscriptionStatusCanceled {
		t.Fatalf("source-deleted active subscription=%#v found=%v err=%v", active, found, err)
	}
	if _, err := store.db.ExecContext(ctx, `UPDATE workspace_agent_sessions SET deleted_at_unix_ms=100 WHERE workspace_id='ws-delete' AND agent_session_id='source'`); err != nil {
		t.Fatal(err)
	}
	if result, err := store.PurgeDeletedSessions(ctx, PurgeDeletedSessionsInput{CutoffUnixMS: 200}); err != nil || len(result.Sessions) != 1 {
		t.Fatalf("purge source result=%#v err=%v", result, err)
	}
	delivery, found, err := store.GetEventDeliveryBySubscription(ctx, "ws-delete", "matched")
	if err != nil || !found || delivery.Status != EventDeliveryStatusPrepared || delivery.SourceID != "source" {
		t.Fatalf("preserved prepared delivery=%#v found=%v err=%v", delivery, found, err)
	}
}

func TestDeletingSubscriberStopsPreparedDelivery(t *testing.T) {
	t.Parallel()
	store := openEventSubscriptionTestStore(t)
	ctx := context.Background()
	for _, sessionID := range []string{"subscriber", "source"} {
		if _, err := store.ReportSessionState(ctx, SessionStateReport{
			WorkspaceID: "ws-subscriber-delete", AgentSessionID: sessionID, Provider: "codex", OccurredAtUnixMS: 10,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-subscriber-delete", AgentSessionID: "source", TurnID: "turn-1",
		Phase: TurnPhaseRunning, Origin: TurnOriginUserPrompt, OccurredAtUnixMS: 11,
	}); err != nil || !accepted {
		t.Fatalf("seed turn accepted=%v err=%v", accepted, err)
	}
	if _, _, err := store.CreateEventSubscription(ctx, CreateEventSubscriptionInput{
		SubscriptionID: "subscription", WorkspaceID: "ws-subscriber-delete", SubscriberAgentSessionID: "subscriber",
		EventType: "agent.turn.completed", EventVersion: 1, SourceKind: "agent_turn", SourceID: "source", NowUnixMS: 12,
	}); err != nil {
		t.Fatal(err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-subscriber-delete", AgentSessionID: "source", TurnID: "turn-1",
		Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 13,
	}); err != nil || !accepted {
		t.Fatalf("settle accepted=%v err=%v", accepted, err)
	}
	if removed, err := store.DeleteSession(ctx, "ws-subscriber-delete", "subscriber"); err != nil || !removed {
		t.Fatalf("delete subscriber removed=%v err=%v", removed, err)
	}
	delivery, found, err := store.GetEventDeliveryBySubscription(ctx, "ws-subscriber-delete", "subscription")
	if err != nil || !found || delivery.Status != EventDeliveryStatusFailed || delivery.LastError != "subscriber_session_deleted" {
		t.Fatalf("stopped subscriber delivery=%#v found=%v err=%v", delivery, found, err)
	}
	if claimable, err := store.ListClaimableEventDeliveries(ctx, time.Now().UnixMilli(), 10); err != nil || len(claimable) != 0 {
		t.Fatalf("claimable after subscriber delete=%#v err=%v", claimable, err)
	}
}
