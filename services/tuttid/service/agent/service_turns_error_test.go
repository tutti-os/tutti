package agent

import (
	"context"
	"errors"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestCancelTurnPropagatesPersistedTurnReadFailure(t *testing.T) {
	t.Parallel()
	want := errors.New("turn store unavailable")
	service := &Service{TurnStore: failingTurnStore{getTurnErr: want}}

	_, err := service.CancelTurn(context.Background(), "workspace-1", "session-1", "turn-1")
	if !errors.Is(err, want) {
		t.Fatalf("CancelTurn() error = %v, want %v", err, want)
	}
}

func TestProtocolV2ProjectionPropagatesPendingInteractionReadFailure(t *testing.T) {
	t.Parallel()
	want := errors.New("interaction store unavailable")
	service := &Service{TurnStore: failingTurnStore{
		session: agentactivitybiz.Session{ActiveTurnID: "turn-1"},
		turn: agentactivitybiz.Turn{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-1",
		},
		listInteractionsErr: want,
	}}

	_, err := service.withProtocolV2TurnState(context.Background(), "workspace-1", Session{ID: "session-1"})
	if !errors.Is(err, want) {
		t.Fatalf("withProtocolV2TurnState() error = %v, want %v", err, want)
	}
}

func TestProtocolV2ProjectionRestoresSettledLatestTurnWithoutActiveTurn(t *testing.T) {
	t.Parallel()
	latest := agentactivitybiz.Turn{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-settled",
		Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeFailed,
	}
	terminal := agentactivitybiz.Interaction{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-settled",
		RequestID: "request-1", Kind: agentactivitybiz.InteractionKindQuestion,
		Status: agentactivitybiz.InteractionStatusAnswered,
	}
	service := &Service{TurnStore: failingTurnStore{
		latestTurn: latest,
		latestTurnInteractions: map[string][]agentactivitybiz.Interaction{
			"session-1": {terminal},
		},
	}}

	got, err := service.withProtocolV2TurnState(context.Background(), "workspace-1", Session{ID: "session-1"})
	if err != nil {
		t.Fatalf("withProtocolV2TurnState() error = %v", err)
	}
	if got.ActiveTurn != nil || got.ActiveTurnID != "" {
		t.Fatalf("active turn = %#v id=%q, want none", got.ActiveTurn, got.ActiveTurnID)
	}
	if got.LatestTurn == nil || got.LatestTurn.TurnID != "turn-settled" || got.LatestTurn.Outcome != agentactivitybiz.TurnOutcomeFailed {
		t.Fatalf("latest turn = %#v", got.LatestTurn)
	}
	if len(got.LatestTurnInteractions) != 1 || got.LatestTurnInteractions[0].Status != agentactivitybiz.InteractionStatusAnswered {
		t.Fatalf("latest turn interactions = %#v", got.LatestTurnInteractions)
	}
}

func TestProtocolV2BatchProjectionPropagatesLatestTurnReadFailure(t *testing.T) {
	t.Parallel()
	want := errors.New("latest turn store unavailable")
	service := &Service{TurnStore: failingTurnStore{latestTurnErr: want}}
	_, err := service.withProtocolV2TurnStates(context.Background(), "workspace-1", []Session{{ID: "session-1"}})
	if !errors.Is(err, want) {
		t.Fatalf("withProtocolV2TurnStates() error = %v, want %v", err, want)
	}
}

func TestProtocolV2BatchProjectionPropagatesLatestTurnInteractionReadFailure(t *testing.T) {
	t.Parallel()
	want := errors.New("latest turn interaction store unavailable")
	service := &Service{TurnStore: failingTurnStore{latestInteractionErr: want}}
	_, err := service.withProtocolV2TurnStates(context.Background(), "workspace-1", []Session{{ID: "session-1"}})
	if !errors.Is(err, want) {
		t.Fatalf("withProtocolV2TurnStates() error = %v, want %v", err, want)
	}
}

func TestProtocolV2BatchProjectionUsesFourBulkReadsWithoutPerSessionQueries(t *testing.T) {
	t.Parallel()
	latestCalls, activeCalls, interactionCalls, latestInteractionCalls := 0, 0, 0, 0
	service := &Service{TurnStore: failingTurnStore{
		latestListCalls:            &latestCalls,
		activeListCalls:            &activeCalls,
		interactionListCalls:       &interactionCalls,
		latestInteractionListCalls: &latestInteractionCalls,
	}}
	sessions := []Session{
		{ID: "session-1", ActiveTurnID: "turn-1"},
		{ID: "session-2"},
	}
	if _, err := service.withProtocolV2TurnStates(context.Background(), "workspace-1", sessions); err != nil {
		t.Fatalf("withProtocolV2TurnStates() error = %v", err)
	}
	if latestCalls != 1 || activeCalls != 1 || interactionCalls != 1 || latestInteractionCalls != 1 {
		t.Fatalf("bulk calls latest=%d active=%d interactions=%d latestInteractions=%d, want 1/1/1/1", latestCalls, activeCalls, interactionCalls, latestInteractionCalls)
	}
}

type failingTurnStore struct {
	getTurnErr                 error
	latestTurnErr              error
	latestInteractionErr       error
	latestTurn                 agentactivitybiz.Turn
	listInteractionsErr        error
	session                    agentactivitybiz.Session
	turn                       agentactivitybiz.Turn
	latestListCalls            *int
	activeListCalls            *int
	interactionListCalls       *int
	latestInteractionListCalls *int
	latestTurnInteractions     map[string][]agentactivitybiz.Interaction
	interactions               []agentactivitybiz.Interaction
}

func (s failingTurnStore) GetLatestTurn(context.Context, string, string) (agentactivitybiz.Turn, bool, error) {
	return s.latestTurn, s.latestTurn.TurnID != "", s.latestTurnErr
}

func (s failingTurnStore) ListLatestTurns(context.Context, string, []string) (map[string]agentactivitybiz.Turn, error) {
	if s.latestListCalls != nil {
		*s.latestListCalls++
	}
	if s.latestTurn.TurnID == "" {
		return map[string]agentactivitybiz.Turn{}, s.latestTurnErr
	}
	return map[string]agentactivitybiz.Turn{s.latestTurn.AgentSessionID: s.latestTurn}, s.latestTurnErr
}

func (s failingTurnStore) ListTurnsBySession(context.Context, string, map[string]string) (map[string]agentactivitybiz.Turn, error) {
	if s.activeListCalls != nil {
		*s.activeListCalls++
	}
	if s.turn.TurnID == "" {
		return map[string]agentactivitybiz.Turn{}, s.getTurnErr
	}
	return map[string]agentactivitybiz.Turn{s.turn.AgentSessionID: s.turn}, s.getTurnErr
}

func (s failingTurnStore) ListPendingInteractionsBySession(context.Context, string, []string) (map[string][]agentactivitybiz.Interaction, error) {
	if s.interactionListCalls != nil {
		*s.interactionListCalls++
	}
	return map[string][]agentactivitybiz.Interaction{}, s.listInteractionsErr
}

func (s failingTurnStore) ListLatestTurnInteractions(context.Context, string, []string) (map[string][]agentactivitybiz.Interaction, error) {
	if s.latestInteractionListCalls != nil {
		*s.latestInteractionListCalls++
	}
	return s.latestTurnInteractions, s.latestInteractionErr
}

func (s failingTurnStore) GetTurn(context.Context, string, string, string) (agentactivitybiz.Turn, bool, error) {
	if s.getTurnErr != nil {
		return agentactivitybiz.Turn{}, false, s.getTurnErr
	}
	return s.turn, s.turn.TurnID != "", nil
}

func (s failingTurnStore) GetSession(context.Context, string, string) (agentactivitybiz.Session, bool, error) {
	return s.session, true, nil
}

func (s failingTurnStore) ListSessionInteractions(context.Context, agentactivitybiz.ListSessionInteractionsInput) ([]agentactivitybiz.Interaction, error) {
	return s.interactions, s.listInteractionsErr
}
