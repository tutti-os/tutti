package agenthost

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type canonicalQueryStore struct {
	CanonicalStore
	wantWorkspaceID      string
	wantSessionID        string
	wantTurnID           string
	wantTurnQuery        storesqlite.ListSessionTurnSummariesInput
	wantMessageQuery     storesqlite.ListSessionMessagesInput
	wantInteractionQuery storesqlite.ListSessionInteractionsInput
	turn                 storesqlite.Turn
	turnPage             storesqlite.SessionTurnSummaryPage
	messagePage          storesqlite.MessagePage
	messageFound         bool
	err                  error
	interactions         map[string][]storesqlite.Interaction
	exactInteractions    []storesqlite.Interaction
	interactionTree      storesqlite.SessionInteractionTreeSnapshot
	interactionTreeFound bool
}

type planContinuationCanonicalStore struct {
	CanonicalStore
	session       storesqlite.Session
	turn          storesqlite.Turn
	identityTurns map[string]storesqlite.Turn
	submitTurnID  string
	submitFound   bool
	turnPage      storesqlite.SessionTurnSummaryPage
}

func (s planContinuationCanonicalStore) GetSessionAndTurn(
	_ context.Context,
	workspaceID, sessionID, turnID string,
) (storesqlite.Session, storesqlite.Turn, bool, error) {
	if workspaceID != s.session.WorkspaceID || sessionID != s.session.ID || turnID != s.turn.TurnID {
		return storesqlite.Session{}, storesqlite.Turn{}, false, errors.New("unexpected continuation identity")
	}
	return s.session, s.turn, true, nil
}

func (s planContinuationCanonicalStore) GetTurn(
	_ context.Context,
	workspaceID, sessionID, turnID string,
) (storesqlite.Turn, bool, error) {
	if workspaceID != s.session.WorkspaceID || sessionID != s.session.ID {
		return storesqlite.Turn{}, false, errors.New("unexpected identity turn scope")
	}
	turn, found := s.identityTurns[turnID]
	return turn, found, nil
}

func (s planContinuationCanonicalStore) FindTurnByClientSubmitID(
	_ context.Context,
	workspaceID, sessionID, clientSubmitID string,
) (string, bool, error) {
	if workspaceID != s.session.WorkspaceID || sessionID != s.session.ID || clientSubmitID == "" {
		return "", false, errors.New("unexpected submit evidence identity")
	}
	return s.submitTurnID, s.submitFound, nil
}

func (s planContinuationCanonicalStore) ListSessionTurnSummaries(
	context.Context,
	storesqlite.ListSessionTurnSummariesInput,
) (storesqlite.SessionTurnSummaryPage, error) {
	return s.turnPage, nil
}

type planContinuationOperationStore struct {
	RuntimeOperationStore
	operation storesqlite.RuntimeOperation
	found     bool
}

func (s planContinuationOperationStore) GetRuntimeOperation(
	context.Context, string, string,
) (storesqlite.RuntimeOperation, bool, error) {
	return s.operation, s.found, nil
}

type goalActivityOperationStore struct {
	GoalStateStore
	operation storesqlite.GoalControlOperation
	found     bool
}

func (s goalActivityOperationStore) GetGoalControlOperation(
	_ context.Context,
	workspaceID, operationID string,
) (storesqlite.GoalControlOperation, bool, error) {
	if workspaceID != s.operation.WorkspaceID || operationID != s.operation.OperationID {
		return storesqlite.GoalControlOperation{}, false, errors.New("unexpected Goal operation identity")
	}
	return s.operation, s.found, nil
}

func (s canonicalQueryStore) GetSessionInteractionTreeSnapshot(
	_ context.Context,
	query storesqlite.SessionInteractionTreeQuery,
) (storesqlite.SessionInteractionTreeSnapshot, bool, error) {
	if query.WorkspaceID != s.wantWorkspaceID || query.RootAgentSessionID != s.wantSessionID || query.RootTurnID != s.wantTurnID {
		return storesqlite.SessionInteractionTreeSnapshot{}, false, errors.New("unexpected interaction tree query")
	}
	return s.interactionTree, s.interactionTreeFound, s.err
}

func (s canonicalQueryStore) GetTurn(_ context.Context, workspaceID, sessionID, turnID string) (storesqlite.Turn, bool, error) {
	if workspaceID != s.wantWorkspaceID || sessionID != s.wantSessionID || turnID != s.wantTurnID {
		return storesqlite.Turn{}, false, errors.New("unexpected canonical turn key")
	}
	return s.turn, true, s.err
}

func (s canonicalQueryStore) GetSession(_ context.Context, workspaceID, sessionID string) (storesqlite.Session, bool, error) {
	if workspaceID != s.wantWorkspaceID || sessionID != s.wantSessionID {
		return storesqlite.Session{}, false, errors.New("unexpected canonical session key")
	}
	return storesqlite.Session{WorkspaceID: workspaceID, ID: sessionID}, true, s.err
}

func (s canonicalQueryStore) SessionDeleted(_ context.Context, workspaceID, sessionID string) (bool, error) {
	if workspaceID != s.wantWorkspaceID || sessionID != s.wantSessionID {
		return false, errors.New("unexpected canonical session key")
	}
	return false, s.err
}

func (s canonicalQueryStore) ListLatestTurnInteractions(_ context.Context, workspaceID string, sessionIDs []string) (map[string][]storesqlite.Interaction, error) {
	if workspaceID != s.wantWorkspaceID || len(sessionIDs) != 1 || sessionIDs[0] != s.wantSessionID {
		return nil, errors.New("unexpected latest-turn interaction key")
	}
	return s.interactions, s.err
}

func (s canonicalQueryStore) ListSessionInteractions(
	_ context.Context,
	input storesqlite.ListSessionInteractionsInput,
) ([]storesqlite.Interaction, error) {
	if !reflect.DeepEqual(input, s.wantInteractionQuery) {
		return nil, errors.New("unexpected canonical interaction query")
	}
	return s.exactInteractions, s.err
}

func (s canonicalQueryStore) ListSessionMessages(_ context.Context, input storesqlite.ListSessionMessagesInput) (storesqlite.MessagePage, bool, error) {
	if !reflect.DeepEqual(input, s.wantMessageQuery) {
		return storesqlite.MessagePage{}, false, errors.New("unexpected canonical message query")
	}
	return s.messagePage, s.messageFound, s.err
}

func (s canonicalQueryStore) ListSessionTurnSummaries(_ context.Context, input storesqlite.ListSessionTurnSummariesInput) (storesqlite.SessionTurnSummaryPage, error) {
	if !reflect.DeepEqual(input, s.wantTurnQuery) {
		return storesqlite.SessionTurnSummaryPage{}, errors.New("unexpected canonical turn query")
	}
	return s.turnPage, s.err
}

func TestGetTurnDelegatesCanonicalQueryWithNormalizedIdentity(t *testing.T) {
	want := storesqlite.Turn{WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-1"}
	host := New(Config{CanonicalStore: canonicalQueryStore{
		wantWorkspaceID: want.WorkspaceID,
		wantSessionID:   want.AgentSessionID,
		wantTurnID:      want.TurnID,
		turn:            want,
	}})

	got, found, err := host.GetTurn(t.Context(), SessionRef{
		WorkspaceID: " workspace-1 ", AgentSessionID: " session-1 ",
	}, " turn-1 ")
	if err != nil || !found || !reflect.DeepEqual(got, want) {
		t.Fatalf("GetTurn() = (%#v, %v, %v), want (%#v, true, nil)", got, found, err, want)
	}
}

func TestGetTurnRejectsIncompleteIdentity(t *testing.T) {
	host := New(Config{CanonicalStore: canonicalQueryStore{}})
	for _, test := range []struct {
		name   string
		ref    SessionRef
		turnID string
	}{
		{name: "workspace", ref: SessionRef{AgentSessionID: "session-1"}, turnID: "turn-1"},
		{name: "session", ref: SessionRef{WorkspaceID: "workspace-1"}, turnID: "turn-1"},
		{name: "turn", ref: SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := host.GetTurn(t.Context(), test.ref, test.turnID); !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("GetTurn() error = %v, want %v", err, ErrInvalidArgument)
			}
		})
	}
}

func TestGetPlanDecisionContinuationOwnsDurableParentChildProof(t *testing.T) {
	ref := SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	parentTurnID := "parent-turn"
	childTurnID := "child-turn"
	operationID := runtimeOperationID(
		ref.WorkspaceID, ref.AgentSessionID,
		storesqlite.RuntimeOperationKindPlanDecision, parentTurnID,
	)
	operation := storesqlite.RuntimeOperation{
		OperationID: operationID, WorkspaceID: ref.WorkspaceID,
		AgentSessionID: ref.AgentSessionID, Kind: storesqlite.RuntimeOperationKindPlanDecision,
		Status: storesqlite.RuntimeOperationStatusCompleted, Result: storesqlite.RuntimeOperationResultApplied,
		TurnID: parentTurnID,
		Payload: map[string]any{
			"promptKind": "plan-implementation", "action": "implement",
			"step": "send_confirmed", "confirmedTurnId": childTurnID,
			"clientSubmitId": "plan-decision:" + operationID,
		},
	}
	child := storesqlite.Turn{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		TurnID: childTurnID, IdentityAnchorTurnID: parentTurnID,
		Phase: storesqlite.TurnPhaseRunning,
	}
	host := New(Config{
		CanonicalStore: planContinuationCanonicalStore{
			session: storesqlite.Session{
				WorkspaceID: ref.WorkspaceID, ID: ref.AgentSessionID,
				ActiveTurnID: childTurnID,
			},
			turn: child,
			identityTurns: map[string]storesqlite.Turn{
				parentTurnID: {
					WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
					TurnID: parentTurnID,
				},
			},
			submitTurnID: childTurnID, submitFound: true,
			turnPage: storesqlite.SessionTurnSummaryPage{Turns: []storesqlite.SessionTurnSummary{{TurnID: childTurnID}}},
		},
		RuntimeOperations: planContinuationOperationStore{operation: operation, found: true},
	})

	got, found, err := host.GetPlanDecisionContinuation(t.Context(), ref, parentTurnID)
	if err != nil || !found || !reflect.DeepEqual(got.Turn, child) || got.Session.ActiveTurnID != childTurnID {
		t.Fatalf("GetPlanDecisionContinuation() = (%#v, %v, %v), want authorized child", got, found, err)
	}
}

func TestGetPlanDecisionContinuationUsesParentsUltimateIdentity(t *testing.T) {
	ref := SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	rootTurnID := "root-turn"
	parentTurnID := "parent-turn"
	childTurnID := "child-turn"
	operationID := runtimeOperationID(
		ref.WorkspaceID, ref.AgentSessionID,
		storesqlite.RuntimeOperationKindPlanDecision, parentTurnID,
	)
	operation := storesqlite.RuntimeOperation{
		OperationID: operationID, WorkspaceID: ref.WorkspaceID,
		AgentSessionID: ref.AgentSessionID, Kind: storesqlite.RuntimeOperationKindPlanDecision,
		Status: storesqlite.RuntimeOperationStatusCompleted, Result: storesqlite.RuntimeOperationResultApplied,
		TurnID: parentTurnID,
		Payload: map[string]any{
			"promptKind": "plan-implementation", "action": "implement",
			"step": "send_confirmed", "confirmedTurnId": childTurnID,
			"clientSubmitId": "plan-decision:" + operationID,
		},
	}
	child := storesqlite.Turn{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		TurnID: childTurnID, IdentityAnchorTurnID: rootTurnID,
		Phase: storesqlite.TurnPhaseRunning,
	}
	host := New(Config{
		CanonicalStore: planContinuationCanonicalStore{
			session: storesqlite.Session{
				WorkspaceID: ref.WorkspaceID, ID: ref.AgentSessionID,
				ActiveTurnID: childTurnID,
			},
			turn: child,
			identityTurns: map[string]storesqlite.Turn{
				parentTurnID: {
					WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
					TurnID: parentTurnID, IdentityAnchorTurnID: rootTurnID,
				},
				rootTurnID: {
					WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
					TurnID: rootTurnID,
				},
			},
			submitTurnID: childTurnID, submitFound: true,
			turnPage: storesqlite.SessionTurnSummaryPage{Turns: []storesqlite.SessionTurnSummary{{TurnID: childTurnID}}},
		},
		RuntimeOperations: planContinuationOperationStore{operation: operation, found: true},
	})

	got, found, err := host.GetPlanDecisionContinuation(t.Context(), ref, parentTurnID)
	if err != nil || !found || !reflect.DeepEqual(got.Turn, child) {
		t.Fatalf("GetPlanDecisionContinuation() = (%#v, %v, %v), want flattened child identity", got, found, err)
	}
}

func TestGetPlanDecisionContinuationRejectsStaleChildBehindNewerTurn(t *testing.T) {
	ref := SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	parentTurnID := "parent-turn"
	childTurnID := "child-turn"
	operationID := runtimeOperationID(
		ref.WorkspaceID, ref.AgentSessionID,
		storesqlite.RuntimeOperationKindPlanDecision, parentTurnID,
	)
	operation := storesqlite.RuntimeOperation{
		OperationID: operationID, WorkspaceID: ref.WorkspaceID,
		AgentSessionID: ref.AgentSessionID, Kind: storesqlite.RuntimeOperationKindPlanDecision,
		Status: storesqlite.RuntimeOperationStatusCompleted, Result: storesqlite.RuntimeOperationResultApplied,
		TurnID: parentTurnID,
		Payload: map[string]any{
			"promptKind": "plan-implementation", "action": "implement",
			"step": "send_confirmed", "confirmedTurnId": childTurnID,
			"clientSubmitId": "plan-decision:" + operationID,
		},
	}
	store := planContinuationCanonicalStore{
		session: storesqlite.Session{WorkspaceID: ref.WorkspaceID, ID: ref.AgentSessionID, ActiveTurnID: "newer-turn"},
		turn: storesqlite.Turn{
			WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
			TurnID: childTurnID, IdentityAnchorTurnID: parentTurnID,
		},
		identityTurns: map[string]storesqlite.Turn{
			parentTurnID: {
				WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
				TurnID: parentTurnID,
			},
		},
		submitTurnID: childTurnID, submitFound: true,
		turnPage: storesqlite.SessionTurnSummaryPage{Turns: []storesqlite.SessionTurnSummary{{TurnID: "newer-turn"}}},
	}
	host := New(Config{
		CanonicalStore:    store,
		RuntimeOperations: planContinuationOperationStore{operation: operation, found: true},
	})
	if _, found, err := host.GetPlanDecisionContinuation(t.Context(), ref, parentTurnID); err != nil || found {
		t.Fatalf("GetPlanDecisionContinuation() = (found=%v, err=%v), want stale child rejected", found, err)
	}
}

func TestGetPlanDecisionContinuationDoesNotAuthorizeBeforeSubmitConfirmation(t *testing.T) {
	ref := SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	parentTurnID := "parent-turn"
	operationID := runtimeOperationID(
		ref.WorkspaceID, ref.AgentSessionID,
		storesqlite.RuntimeOperationKindPlanDecision, parentTurnID,
	)
	operation := storesqlite.RuntimeOperation{
		OperationID: operationID, WorkspaceID: ref.WorkspaceID,
		AgentSessionID: ref.AgentSessionID, Kind: storesqlite.RuntimeOperationKindPlanDecision,
		Status: storesqlite.RuntimeOperationStatusLeased, TurnID: parentTurnID,
		Payload: map[string]any{
			"promptKind": "plan-implementation", "action": "implement",
			"step": "send_dispatched", "clientSubmitId": "plan-decision:" + operationID,
		},
	}
	host := New(Config{
		CanonicalStore:    planContinuationCanonicalStore{},
		RuntimeOperations: planContinuationOperationStore{operation: operation, found: true},
	})
	_, found, err := host.GetPlanDecisionContinuation(t.Context(), ref, parentTurnID)
	if err != nil || found {
		t.Fatalf("GetPlanDecisionContinuation() = (found=%v, err=%v), want not-ready operation", found, err)
	}
}

func TestGetPlanDecisionContinuationDoesNotExposeConfirmedSubmitBeforeCompletion(t *testing.T) {
	ref := SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	parentTurnID := "parent-turn"
	childTurnID := "child-turn"
	operationID := runtimeOperationID(
		ref.WorkspaceID, ref.AgentSessionID,
		storesqlite.RuntimeOperationKindPlanDecision, parentTurnID,
	)
	operation := storesqlite.RuntimeOperation{
		OperationID: operationID, WorkspaceID: ref.WorkspaceID,
		AgentSessionID: ref.AgentSessionID, Kind: storesqlite.RuntimeOperationKindPlanDecision,
		Status: storesqlite.RuntimeOperationStatusLeased, TurnID: parentTurnID,
		Payload: map[string]any{
			"promptKind": "plan-implementation", "action": "implement",
			"step": "send_confirmed", "confirmedTurnId": childTurnID,
			"clientSubmitId": "plan-decision:" + operationID,
		},
	}
	host := New(Config{
		CanonicalStore:    planContinuationCanonicalStore{},
		RuntimeOperations: planContinuationOperationStore{operation: operation, found: true},
	})
	_, found, err := host.GetPlanDecisionContinuation(t.Context(), ref, parentTurnID)
	if err != nil || found {
		t.Fatalf("GetPlanDecisionContinuation() = (found=%v, err=%v), want completion barrier", found, err)
	}
}

func TestGetGoalActivityTurnOwnsDurableGenerationProof(t *testing.T) {
	ref := SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	turn := storesqlite.Turn{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		TurnID: "goal-turn-2", Phase: storesqlite.TurnPhaseRunning,
		Origin:                storesqlite.TurnOriginGoalContinuation,
		SourceGoalOperationID: "goal-operation-1", SourceGoalRevision: 4,
		SourceGoalRepairEpoch: 2,
	}
	operation := storesqlite.GoalControlOperation{
		OperationID: turn.SourceGoalOperationID, WorkspaceID: ref.WorkspaceID,
		AgentSessionID: ref.AgentSessionID, GoalRevision: turn.SourceGoalRevision,
		RepairEpoch: turn.SourceGoalRepairEpoch, Status: storesqlite.GoalOperationStatusCompleted,
	}
	host := New(Config{
		CanonicalStore: planContinuationCanonicalStore{
			session: storesqlite.Session{
				WorkspaceID: ref.WorkspaceID, ID: ref.AgentSessionID,
				ActiveTurnID: turn.TurnID,
			},
			turn: turn,
			turnPage: storesqlite.SessionTurnSummaryPage{
				Turns: []storesqlite.SessionTurnSummary{{TurnID: turn.TurnID}},
			},
		},
		GoalStore: goalActivityOperationStore{operation: operation, found: true},
	})

	got, found, err := host.GetGoalActivityTurn(t.Context(), ref, turn.TurnID)
	if err != nil || !found || !reflect.DeepEqual(got.Turn, turn) ||
		got.Session.ActiveTurnID != turn.TurnID {
		t.Fatalf("GetGoalActivityTurn() = (%#v, %v, %v), want authorized Goal Turn", got, found, err)
	}
}

func TestGetGoalActivityTurnRejectsUnrelatedOrMismatchedTurn(t *testing.T) {
	ref := SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	baseTurn := storesqlite.Turn{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		TurnID: "candidate-turn", Phase: storesqlite.TurnPhaseRunning,
		Origin:                storesqlite.TurnOriginGoalContinuation,
		SourceGoalOperationID: "goal-operation-1", SourceGoalRevision: 4,
		SourceGoalRepairEpoch: 2,
	}
	baseOperation := storesqlite.GoalControlOperation{
		OperationID: baseTurn.SourceGoalOperationID, WorkspaceID: ref.WorkspaceID,
		AgentSessionID: ref.AgentSessionID, GoalRevision: baseTurn.SourceGoalRevision,
		RepairEpoch: baseTurn.SourceGoalRepairEpoch, Status: storesqlite.GoalOperationStatusCompleted,
	}
	tests := []struct {
		name      string
		turn      storesqlite.Turn
		operation storesqlite.GoalControlOperation
		activeID  string
		latestID  string
		wantErr   error
	}{
		{
			name: "ordinary user Turn", turn: func() storesqlite.Turn {
				value := baseTurn
				value.Origin = storesqlite.TurnOriginUserPrompt
				return value
			}(), operation: baseOperation, activeID: baseTurn.TurnID, latestID: baseTurn.TurnID,
		},
		{
			name: "not active", turn: baseTurn, operation: baseOperation,
			activeID: "newer-turn", latestID: "newer-turn",
		},
		{
			name: "operation revision mismatch", turn: baseTurn,
			operation: func() storesqlite.GoalControlOperation {
				value := baseOperation
				value.GoalRevision++
				return value
			}(), activeID: baseTurn.TurnID, latestID: baseTurn.TurnID,
			wantErr: storesqlite.ErrGoalOperationConflict,
		},
		{
			name: "superseded operation", turn: baseTurn,
			operation: func() storesqlite.GoalControlOperation {
				value := baseOperation
				value.Status = storesqlite.GoalOperationStatusSuperseded
				return value
			}(), activeID: baseTurn.TurnID, latestID: baseTurn.TurnID,
		},
		{
			name: "unknown operation status", turn: baseTurn,
			operation: func() storesqlite.GoalControlOperation {
				value := baseOperation
				value.Status = "future_status"
				return value
			}(), activeID: baseTurn.TurnID, latestID: baseTurn.TurnID,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			host := New(Config{
				CanonicalStore: planContinuationCanonicalStore{
					session: storesqlite.Session{
						WorkspaceID: ref.WorkspaceID, ID: ref.AgentSessionID,
						ActiveTurnID: test.activeID,
					},
					turn: test.turn,
					turnPage: storesqlite.SessionTurnSummaryPage{
						Turns: []storesqlite.SessionTurnSummary{{TurnID: test.latestID}},
					},
				},
				GoalStore: goalActivityOperationStore{operation: test.operation, found: true},
			})
			_, found, err := host.GetGoalActivityTurn(t.Context(), ref, test.turn.TurnID)
			if found || !errors.Is(err, test.wantErr) {
				t.Fatalf("GetGoalActivityTurn() = (found=%v, err=%v), want (false, %v)", found, err, test.wantErr)
			}
		})
	}
}

func TestGetInteractionDelegatesExactCanonicalQueryWithNormalizedIdentity(t *testing.T) {
	want := storesqlite.Interaction{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		TurnID: "turn-1", RequestID: "request-1",
		Status: storesqlite.InteractionStatusPending,
	}
	host := New(Config{CanonicalStore: canonicalQueryStore{
		wantInteractionQuery: storesqlite.ListSessionInteractionsInput{
			WorkspaceID: "workspace-1", AgentSessionID: "session-1",
			TurnID: "turn-1", RequestID: "request-1",
		},
		exactInteractions: []storesqlite.Interaction{want},
	}})

	got, found, err := host.GetInteraction(t.Context(), SessionRef{
		WorkspaceID: " workspace-1 ", AgentSessionID: " session-1 ",
	}, " turn-1 ", " request-1 ")
	if err != nil || !found || !reflect.DeepEqual(got, want) {
		t.Fatalf(
			"GetInteraction() = (%#v, %v, %v), want (%#v, true, nil)",
			got,
			found,
			err,
			want,
		)
	}
}

func TestGetInteractionReportsNotFoundAndRejectsDuplicateIdentity(t *testing.T) {
	query := storesqlite.ListSessionInteractionsInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		TurnID: "turn-1", RequestID: "request-1",
	}
	ref := SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}
	if got, found, err := New(Config{CanonicalStore: canonicalQueryStore{
		wantInteractionQuery: query,
	}}).GetInteraction(t.Context(), ref, "turn-1", "request-1"); err != nil || found ||
		!reflect.DeepEqual(got, storesqlite.Interaction{}) {
		t.Fatalf("GetInteraction(not found) = (%#v, %v, %v)", got, found, err)
	}

	duplicate := storesqlite.Interaction{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		TurnID: "turn-1", RequestID: "request-1",
	}
	_, found, err := New(Config{CanonicalStore: canonicalQueryStore{
		wantInteractionQuery: query,
		exactInteractions:    []storesqlite.Interaction{duplicate, duplicate},
	}}).GetInteraction(t.Context(), ref, "turn-1", "request-1")
	if err == nil || found || !strings.Contains(err.Error(), "canonical interaction invariant") {
		t.Fatalf("GetInteraction(duplicate) = (found=%v, err=%v), want invariant error", found, err)
	}
}

func TestGetInteractionRejectsIncompleteIdentity(t *testing.T) {
	host := New(Config{CanonicalStore: canonicalQueryStore{}})
	for _, test := range []struct {
		name      string
		ref       SessionRef
		turnID    string
		requestID string
	}{
		{name: "workspace", ref: SessionRef{AgentSessionID: "session-1"}, turnID: "turn-1", requestID: "request-1"},
		{name: "session", ref: SessionRef{WorkspaceID: "workspace-1"}, turnID: "turn-1", requestID: "request-1"},
		{name: "turn", ref: SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}, requestID: "request-1"},
		{name: "request", ref: SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}, turnID: "turn-1"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, _, err := host.GetInteraction(
				t.Context(),
				test.ref,
				test.turnID,
				test.requestID,
			); !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("GetInteraction() error = %v, want %v", err, ErrInvalidArgument)
			}
		})
	}
}

func TestListSessionMessagesDelegatesCanonicalQueryWithNormalizedIdentity(t *testing.T) {
	wantQuery := storesqlite.ListSessionMessagesInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", MessageID: "message-1", TurnID: "turn-1",
		AfterVersion: 7, BeforeVersion: 20, Limit: 25, Order: storesqlite.MessageOrderAsc,
	}
	wantPage := storesqlite.MessagePage{
		AgentSessionID: "session-1", LatestVersion: 9,
		Messages: []storesqlite.Message{{AgentSessionID: "session-1", MessageID: "message-1", TurnID: "turn-1", Version: 9}},
	}
	host := New(Config{CanonicalStore: canonicalQueryStore{
		wantMessageQuery: wantQuery,
		messagePage:      wantPage,
		messageFound:     true,
	}})

	got, found, err := host.ListSessionMessages(t.Context(), SessionRef{
		WorkspaceID: " workspace-1 ", AgentSessionID: " session-1 ",
	}, SessionMessageQuery{
		MessageID: " message-1 ", TurnID: " turn-1 ", AfterVersion: 7, BeforeVersion: 20,
		Limit: 25, Order: storesqlite.MessageOrderAsc,
	})
	if err != nil || !found || !reflect.DeepEqual(got, wantPage) {
		t.Fatalf("ListSessionMessages() = (%#v, %v, %v), want (%#v, true, nil)", got, found, err, wantPage)
	}
}

func TestListSessionMessagesRejectsIncompleteIdentity(t *testing.T) {
	host := New(Config{CanonicalStore: canonicalQueryStore{}})
	for _, ref := range []SessionRef{{WorkspaceID: "workspace-1"}, {AgentSessionID: "session-1"}, {}} {
		if _, _, err := host.ListSessionMessages(t.Context(), ref, SessionMessageQuery{}); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("ListSessionMessages(%#v) error = %v, want %v", ref, err, ErrInvalidArgument)
		}
	}
}

func TestListSessionTurnsDelegatesCanonicalQueryWithNormalizedIdentity(t *testing.T) {
	wantQuery := storesqlite.ListSessionTurnSummariesInput{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
		Before: &storesqlite.SessionTurnCursor{StartedAtUnixMS: 20, TurnID: "turn-2"},
		Limit:  3,
	}
	wantPage := storesqlite.SessionTurnSummaryPage{
		Turns: []storesqlite.SessionTurnSummary{{TurnID: "turn-1", StartedAtUnixMS: 10}},
	}
	host := New(Config{CanonicalStore: canonicalQueryStore{wantTurnQuery: wantQuery, turnPage: wantPage}})

	got, err := host.ListSessionTurns(t.Context(), SessionRef{
		WorkspaceID: " workspace-1 ", AgentSessionID: " session-1 ",
	}, SessionTurnQuery{
		Before: &SessionTurnCursor{StartedAtUnixMS: 20, TurnID: " turn-2 "},
		Limit:  3,
	})
	if err != nil || !reflect.DeepEqual(got, wantPage) {
		t.Fatalf("ListSessionTurns() = (%#v, %v), want (%#v, nil)", got, err, wantPage)
	}
}

func TestListSessionTurnsRejectsIncompleteIdentity(t *testing.T) {
	for _, test := range []struct {
		name  string
		host  *Host
		ref   SessionRef
		query SessionTurnQuery
	}{
		{name: "workspace", host: New(Config{CanonicalStore: canonicalQueryStore{}}), ref: SessionRef{AgentSessionID: "session-1"}, query: SessionTurnQuery{Limit: 1}},
		{name: "session", host: New(Config{CanonicalStore: canonicalQueryStore{}}), ref: SessionRef{WorkspaceID: "workspace-1"}, query: SessionTurnQuery{Limit: 1}},
	} {
		t.Run(test.name, func(t *testing.T) {
			if _, err := test.host.ListSessionTurns(t.Context(), test.ref, test.query); !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("ListSessionTurns() error = %v, want %v", err, ErrInvalidArgument)
			}
		})
	}
}

func TestGetSessionInteractionSnapshotDerivesPendingFromLatestTurnRead(t *testing.T) {
	interactions := []storesqlite.Interaction{
		{WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-2", RequestID: "pending", Status: storesqlite.InteractionStatusPending},
		{WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-2", RequestID: "answered", Status: storesqlite.InteractionStatusAnswered},
		{WorkspaceID: "workspace-1", AgentSessionID: "session-1", TurnID: "turn-2", RequestID: "superseded", Status: storesqlite.InteractionStatusSuperseded},
	}
	host := New(Config{CanonicalStore: canonicalQueryStore{
		wantWorkspaceID: "workspace-1", wantSessionID: "session-1",
		interactions: map[string][]storesqlite.Interaction{"session-1": interactions},
	}})

	snapshot, err := host.GetSessionInteractionSnapshot(t.Context(), SessionRef{
		WorkspaceID: " workspace-1 ", AgentSessionID: " session-1 ",
	})
	if err != nil {
		t.Fatalf("GetSessionInteractionSnapshot() error = %v", err)
	}
	if !reflect.DeepEqual(snapshot.Interactions, interactions) {
		t.Fatalf("Interactions = %#v, want %#v", snapshot.Interactions, interactions)
	}
	if len(snapshot.PendingInteractions) != 1 || snapshot.PendingInteractions[0].RequestID != "pending" {
		t.Fatalf("PendingInteractions = %#v, want only pending", snapshot.PendingInteractions)
	}
}

func TestGetSessionInteractionSnapshotRejectsIncompleteIdentity(t *testing.T) {
	host := New(Config{CanonicalStore: canonicalQueryStore{}})
	for _, ref := range []SessionRef{{WorkspaceID: "workspace-1"}, {AgentSessionID: "session-1"}, {}} {
		if _, err := host.GetSessionInteractionSnapshot(t.Context(), ref); !errors.Is(err, ErrInvalidArgument) {
			t.Fatalf("GetSessionInteractionSnapshot(%#v) error = %v, want %v", ref, err, ErrInvalidArgument)
		}
	}
}

func TestGetSessionInteractionTreeSnapshotDelegatesCanonicalRead(t *testing.T) {
	want := storesqlite.SessionInteractionTreeSnapshot{
		RootTurnID:   "root-turn",
		Interactions: []storesqlite.Interaction{{AgentSessionID: "child", TurnID: "child-turn", RequestID: "request"}},
	}
	host := New(Config{CanonicalStore: canonicalQueryStore{
		wantWorkspaceID: "workspace-1", wantSessionID: "root", wantTurnID: "root-turn",
		interactionTree: want, interactionTreeFound: true,
	}})

	got, err := host.GetSessionInteractionTreeSnapshot(t.Context(), SessionRef{
		WorkspaceID: " workspace-1 ", AgentSessionID: " root ",
	}, SessionInteractionTreeQuery{RootTurnID: " root-turn "})
	if err != nil || !reflect.DeepEqual(got.Interactions, want.Interactions) || got.RootTurnID != want.RootTurnID {
		t.Fatalf("GetSessionInteractionTreeSnapshot() = (%#v, %v)", got, err)
	}
}
