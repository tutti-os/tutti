package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestCancelTurnPropagatesPersistedTurnReadFailure(t *testing.T) {
	t.Parallel()
	want := errors.New("turn store unavailable")
	service := &Service{TurnStore: failingTurnStore{getTurnErr: want}}
	configureTestApplicationHost(service)

	_, err := service.CancelTurn(context.Background(), "workspace-1", "session-1", "turn-1")
	if !errors.Is(err, want) {
		t.Fatalf("CancelTurn() error = %v, want %v", err, want)
	}
}

func TestListTurnsReturnsPersistedHistory(t *testing.T) {
	t.Parallel()
	want := []agentactivitybiz.SessionTurnSummary{{TurnID: "turn-1"}, {TurnID: "turn-2"}}
	service := &Service{TurnSummaryReader: turnSummaryReaderStub{page: agentactivitybiz.SessionTurnSummaryPage{Turns: want}}}

	got, err := service.ListTurns(context.Background(), "workspace-1", "session-1", ListTurnsInput{Limit: 10})
	if err != nil || len(got.Turns) != 2 || got.Turns[0].TurnID != "turn-1" || got.Turns[1].TurnID != "turn-2" {
		t.Fatalf("ListTurns() = %#v, error = %v", got, err)
	}
}

func TestListTurnsPropagatesPersistedReadFailure(t *testing.T) {
	t.Parallel()
	want := errors.New("turn store unavailable")
	service := &Service{TurnSummaryReader: turnSummaryReaderStub{err: want}}

	_, err := service.ListTurns(context.Background(), "workspace-1", "session-1", ListTurnsInput{Limit: 10})
	if !errors.Is(err, want) {
		t.Fatalf("ListTurns() error = %v, want %v", err, want)
	}
}

func TestListTurnsForwardsStableCursorAndLimit(t *testing.T) {
	t.Parallel()
	inputs := []agentactivitybiz.ListSessionTurnSummariesInput{}
	service := &Service{TurnSummaryReader: turnSummaryReaderStub{
		inputs: &inputs,
		page: agentactivitybiz.SessionTurnSummaryPage{
			Turns: []agentactivitybiz.SessionTurnSummary{{TurnID: "turn-older"}}, HasMore: true,
		},
	}}
	cursor := &agentactivitybiz.SessionTurnCursor{StartedAtUnixMS: 20, TurnID: "turn-anchor"}

	page, err := service.ListTurns(context.Background(), " workspace-1 ", " session-1 ", ListTurnsInput{Before: cursor, Limit: 7})
	if err != nil {
		t.Fatalf("ListTurns(): %v", err)
	}
	if len(inputs) != 1 || inputs[0].WorkspaceID != "workspace-1" || inputs[0].AgentSessionID != "session-1" ||
		inputs[0].Limit != 7 || inputs[0].Before != cursor {
		t.Fatalf("summary inputs = %#v", inputs)
	}
	if len(page.Turns) != 1 || page.Turns[0].TurnID != "turn-older" || !page.HasMore {
		t.Fatalf("page = %#v", page)
	}
}

func TestListTurnsDistinguishesEmptyExistingSessionFromMissingSession(t *testing.T) {
	t.Parallel()
	service := &Service{
		Runtime:           &fakeRuntime{sessions: map[string]ProviderRuntimeSession{}},
		SessionReader:     fakeSessionReader{sessions: map[string]PersistedSession{"workspace-1:session-1": {ID: "session-1", WorkspaceID: "workspace-1"}}},
		TurnSummaryReader: turnSummaryReaderStub{page: agentactivitybiz.SessionTurnSummaryPage{Turns: []agentactivitybiz.SessionTurnSummary{}}},
	}

	page, err := service.ListTurns(context.Background(), "workspace-1", "session-1", ListTurnsInput{Limit: 3})
	if err != nil || page.Turns == nil || len(page.Turns) != 0 || page.HasMore {
		t.Fatalf("existing empty session page = %#v, error = %v", page, err)
	}

	_, err = service.ListTurns(context.Background(), "workspace-1", "missing", ListTurnsInput{Limit: 3})
	if !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("missing session error = %v, want %v", err, ErrSessionNotFound)
	}
}

func TestListTurnsRejectsInvalidInputBeforeReadingPersistence(t *testing.T) {
	t.Parallel()
	inputs := []agentactivitybiz.ListSessionTurnSummariesInput{}
	service := &Service{TurnSummaryReader: turnSummaryReaderStub{inputs: &inputs}}

	for _, input := range []struct {
		workspaceID string
		sessionID   string
		limit       int
	}{
		{workspaceID: "", sessionID: "session-1", limit: 1},
		{workspaceID: "workspace-1", sessionID: "", limit: 1},
		{workspaceID: "workspace-1", sessionID: "session-1", limit: 0},
	} {
		if _, err := service.ListTurns(context.Background(), input.workspaceID, input.sessionID, ListTurnsInput{Limit: input.limit}); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("ListTurns(%#v) error = %v, want %v", input, err, ErrInvalidArgument)
		}
	}
	if len(inputs) != 0 {
		t.Fatalf("persistence inputs = %#v, want none", inputs)
	}
}

func TestGetTurnReadsCanonicalTurnThroughHost(t *testing.T) {
	t.Parallel()
	want := agentactivitybiz.Turn{WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-1"}
	service := &Service{TurnStore: failingTurnStore{turn: want}}
	configureTestApplicationHost(service)

	got, found, err := service.GetTurn(context.Background(), "workspace-1", "session-1", "turn-1")
	if err != nil || !found || got.TurnID != want.TurnID {
		t.Fatalf("GetTurn() = (%#v, %v, %v)", got, found, err)
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

func TestGetDetailReturnsAllDurableSessionTurns(t *testing.T) {
	t.Parallel()
	runtime := newFakeRuntime()
	runtime.sessions["workspace-1:session-1"] = ProviderRuntimeSession{
		ID:              "session-1",
		WorkspaceID:     "workspace-1",
		Provider:        "cursor",
		CreatedAtUnixMS: time.UnixMilli(1).UnixMilli(),
		UpdatedAtUnixMS: time.UnixMilli(3).UnixMilli(),
	}
	turns := []agentactivitybiz.Turn{
		{WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-1", Phase: agentactivitybiz.TurnPhaseSettled, StartedAtUnixMS: 1},
		{WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-2", Phase: agentactivitybiz.TurnPhaseSettled, StartedAtUnixMS: 2, FileChanges: map[string]any{"files": []any{map[string]any{"path": "removed.txt", "change": "deleted"}}}},
	}
	service := newIsolatedAgentService(runtime)
	service.TurnStore = failingTurnStore{
		latestTurn:   turns[1],
		sessionTurns: turns,
	}

	detail, err := service.GetDetail(context.Background(), "workspace-1", "session-1")
	if err != nil {
		t.Fatalf("GetDetail() error = %v", err)
	}
	if len(detail.Turns) != 2 || detail.Turns[0].TurnID != "turn-1" || detail.Turns[1].TurnID != "turn-2" {
		t.Fatalf("detail turns = %#v", detail.Turns)
	}
	if got := detail.Turns[1].FileChanges["files"]; got == nil {
		t.Fatalf("second turn file changes = %#v", detail.Turns[1].FileChanges)
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
	sessionMissing             bool
	turn                       agentactivitybiz.Turn
	latestListCalls            *int
	activeListCalls            *int
	interactionListCalls       *int
	latestInteractionListCalls *int
	latestTurnInteractions     map[string][]agentactivitybiz.Interaction
	interactions               []agentactivitybiz.Interaction
	sessionTurns               []agentactivitybiz.Turn
	sessionTurnsErr            error
}

func (s failingTurnStore) GetLatestTurn(context.Context, string, string) (agentactivitybiz.Turn, bool, error) {
	return s.latestTurn, s.latestTurn.TurnID != "", s.latestTurnErr
}

func (s failingTurnStore) ListSessionTurns(context.Context, string, string) ([]agentactivitybiz.Turn, error) {
	if s.sessionTurns != nil || s.sessionTurnsErr != nil {
		return s.sessionTurns, s.sessionTurnsErr
	}
	if s.latestTurn.TurnID == "" {
		return []agentactivitybiz.Turn{}, nil
	}
	return []agentactivitybiz.Turn{s.latestTurn}, nil
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

type turnSummaryReaderStub struct {
	inputs *[]agentactivitybiz.ListSessionTurnSummariesInput
	page   agentactivitybiz.SessionTurnSummaryPage
	err    error
}

func (s turnSummaryReaderStub) ListSessionTurnSummaries(_ context.Context, input agentactivitybiz.ListSessionTurnSummariesInput) (agentactivitybiz.SessionTurnSummaryPage, error) {
	if s.inputs != nil {
		*s.inputs = append(*s.inputs, input)
	}
	return s.page, s.err
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
	if s.sessionMissing {
		return agentactivitybiz.Session{}, false, nil
	}
	return s.session, true, nil
}

func (s failingTurnStore) ListSessionInteractions(_ context.Context, input agentactivitybiz.ListSessionInteractionsInput) ([]agentactivitybiz.Interaction, error) {
	if s.listInteractionsErr != nil {
		return nil, s.listInteractionsErr
	}
	result := make([]agentactivitybiz.Interaction, 0, len(s.interactions))
	for _, interaction := range s.interactions {
		if input.TurnID != "" && interaction.TurnID != input.TurnID {
			continue
		}
		if input.RequestID != "" && interaction.RequestID != input.RequestID {
			continue
		}
		result = append(result, interaction)
	}
	return result, nil
}
