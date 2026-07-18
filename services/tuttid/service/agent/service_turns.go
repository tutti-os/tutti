package agent

import (
	"context"
	"log/slog"
	"strings"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

// TurnStore is the narrow persisted-turn read surface the service needs for
// protocol v2 turn control operations.
type TurnStore interface {
	GetLatestTurn(context.Context, string, string) (agentactivitybiz.Turn, bool, error)
	GetTurn(context.Context, string, string, string) (agentactivitybiz.Turn, bool, error)
	GetSession(context.Context, string, string) (agentactivitybiz.Session, bool, error)
	ListSessionTurns(context.Context, string, string) ([]agentactivitybiz.Turn, error)
	ListSessionInteractions(context.Context, agentactivitybiz.ListSessionInteractionsInput) ([]agentactivitybiz.Interaction, error)
	ListLatestTurns(context.Context, string, []string) (map[string]agentactivitybiz.Turn, error)
	ListLatestTurnInteractions(context.Context, string, []string) (map[string][]agentactivitybiz.Interaction, error)
	ListTurnsBySession(context.Context, string, map[string]string) (map[string]agentactivitybiz.Turn, error)
	ListPendingInteractionsBySession(context.Context, string, []string) (map[string][]agentactivitybiz.Interaction, error)
}

type CancelTurnReason string

const (
	CancelTurnReasonTurnCanceled   CancelTurnReason = "turn_canceled"
	CancelTurnReasonAlreadySettled CancelTurnReason = "already_settled"
	CancelTurnReasonNotFound       CancelTurnReason = "not_found"
)

type CancelTurnResult struct {
	Session  Session
	Turn     *agentactivitybiz.Turn
	Canceled bool
	Reason   CancelTurnReason
}

type ListTurnsInput struct {
	Before *agentactivitybiz.SessionTurnCursor
	Limit  int
}

type TurnPage struct {
	Turns   []agentactivitybiz.SessionTurnSummary
	HasMore bool
}

// GetTurn returns canonical Turn truth through Host without starting or
// resuming a provider runtime.
func (s *Service) GetTurn(ctx context.Context, workspaceID string, agentSessionID string, turnID string) (agentactivitybiz.Turn, bool, error) {
	if err := ctx.Err(); err != nil {
		return agentactivitybiz.Turn{}, false, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	turnID = strings.TrimSpace(turnID)
	if workspaceID == "" || agentSessionID == "" || turnID == "" {
		return agentactivitybiz.Turn{}, false, ErrInvalidArgument
	}
	return s.ApplicationHost().GetTurn(ctx, agenthost.SessionRef{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
	}, turnID)
}

// ListTurns returns one bounded, newest-first metadata page for an existing
// session. The adapter owns this CLI/query projection; lifecycle decisions
// remain in Host.
func (s *Service) ListTurns(ctx context.Context, workspaceID string, agentSessionID string, input ListTurnsInput) (TurnPage, error) {
	if err := ctx.Err(); err != nil {
		return TurnPage{}, err
	}
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	if workspaceID == "" || agentSessionID == "" || input.Limit < 1 {
		return TurnPage{}, ErrInvalidArgument
	}
	if s.TurnSummaryReader != nil {
		page, err := s.TurnSummaryReader.ListSessionTurnSummaries(ctx, agentactivitybiz.ListSessionTurnSummariesInput{
			WorkspaceID: workspaceID, AgentSessionID: agentSessionID, Before: input.Before, Limit: input.Limit,
		})
		if err != nil {
			return TurnPage{}, err
		}
		if len(page.Turns) > 0 {
			return TurnPage{
				Turns: append([]agentactivitybiz.SessionTurnSummary(nil), page.Turns...), HasMore: page.HasMore,
			}, nil
		}
	}
	exists, err := s.sessionExists(ctx, workspaceID, agentSessionID)
	if err != nil {
		return TurnPage{}, err
	}
	if !exists {
		return TurnPage{}, ErrSessionNotFound
	}
	return TurnPage{Turns: []agentactivitybiz.SessionTurnSummary{}}, nil
}

// CancelTurn stops one specific turn (protocol v2). It is idempotent: a
// settled or unknown turn is a no-op success (already_settled / not_found),
// never an error. An active turn goes through the runtime cancel and its
// persisted record settles with outcome=canceled.
func (s *Service) CancelTurn(ctx context.Context, workspaceID string, agentSessionID string, turnID string) (CancelTurnResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	agentSessionID = strings.TrimSpace(agentSessionID)
	turnID = strings.TrimSpace(turnID)
	if workspaceID == "" || agentSessionID == "" || turnID == "" {
		return CancelTurnResult{}, ErrInvalidArgument
	}
	slog.Info("workspace agent turn cancel requested",
		"event", "workspace_agent_turn.cancel.requested",
		"workspaceId", workspaceID,
		"agentSessionId", agentSessionID,
		"turnId", turnID,
	)

	hostResult, err := s.ApplicationHost().CancelTurn(ctx, agenthost.CancelTurnInput{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID, TurnID: turnID,
	})
	if err != nil {
		return CancelTurnResult{}, normalizeRuntimeError(err)
	}
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return CancelTurnResult{}, err
	}
	result := CancelTurnResult{
		Session:  session,
		Canceled: hostResult.Operation.Status == agentactivitybiz.RuntimeOperationStatusCompleted && hostResult.Operation.Result == agentactivitybiz.RuntimeOperationResultCanceled,
		Reason:   CancelTurnReasonAlreadySettled,
	}
	switch hostResult.State {
	case agenthost.CancelStateNotFound:
		result.Reason = CancelTurnReasonNotFound
	case agenthost.CancelStateSettled:
		if result.Canceled {
			result.Reason = CancelTurnReasonTurnCanceled
		}
	}
	if hostResult.Turn != nil {
		turn := *hostResult.Turn
		result.Turn = &turn
	}
	if result.Canceled {
		result.Reason = CancelTurnReasonTurnCanceled
	}
	return result, nil
}

func (s *Service) lookupPersistedTurn(ctx context.Context, workspaceID string, agentSessionID string, turnID string) (agentactivitybiz.Turn, bool, error) {
	if s == nil || s.TurnStore == nil {
		return agentactivitybiz.Turn{}, false, nil
	}
	turn, ok, err := s.TurnStore.GetTurn(ctx, workspaceID, agentSessionID, turnID)
	if err != nil {
		return agentactivitybiz.Turn{}, false, err
	}
	return turn, ok, nil
}

// PersistedActiveTurnID exposes the session's persisted active turn pointer
// to collaborators outside the package (e.g. CLI capabilities invoked from
// inside an agent turn that stamp durable records with their source turn).
// It returns "" when the pointer is unset or the v2 store is not wired.
func (s *Service) PersistedActiveTurnID(ctx context.Context, workspaceID string, agentSessionID string) (string, error) {
	return s.persistedActiveTurnID(ctx, workspaceID, agentSessionID)
}

// persistedActiveTurnID reads the session's persisted active turn pointer.
// It returns "" when the pointer is unset or the v2 store is not wired.
func (s *Service) persistedActiveTurnID(ctx context.Context, workspaceID string, agentSessionID string) (string, error) {
	if s == nil || s.TurnStore == nil {
		return "", nil
	}
	session, ok, err := s.TurnStore.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", nil
	}
	return strings.TrimSpace(session.ActiveTurnID), nil
}

// projectSessionForResponse is the canonical boundary for every public service
// response that contains one Session. Keep the persisted Turn projection and
// the Tutti-owned, session-associated activation read projection here so
// mutations cannot accidentally return a partial Session that clears newer
// client state.
func (s *Service) projectSessionForResponse(ctx context.Context, workspaceID string, session Session) (Session, error) {
	return s.withProtocolV2TurnState(ctx, strings.TrimSpace(workspaceID), session)
}

// projectSessionsForResponse is the batched form of
// projectSessionForResponse. List and section responses must use the same
// projection contract as single-session mutations.
func (s *Service) projectSessionsForResponse(ctx context.Context, workspaceID string, sessions []Session) ([]Session, error) {
	return s.withProtocolV2TurnStates(ctx, strings.TrimSpace(workspaceID), sessions)
}

// withProtocolV2TurnState enriches the canonical response projection with the
// persisted v2 turn state: activeTurnId pointer, embedded active/latest turns,
// and pending interactions. latestTurn remains an independent turn entity
// projection; it is never persisted on the session row. The Tutti-owned,
// session-associated TuttiModeActivation read projection is attached last.
func (s *Service) withProtocolV2TurnState(ctx context.Context, workspaceID string, session Session) (Session, error) {
	if s == nil || s.TurnStore == nil {
		return s.withTuttiModeActivation(ctx, workspaceID, session)
	}
	latestTurn, ok, err := s.TurnStore.GetLatestTurn(ctx, workspaceID, session.ID)
	if err != nil {
		return Session{}, err
	}
	latestInteractionsBySessionID, err := s.TurnStore.ListLatestTurnInteractions(ctx, workspaceID, []string{session.ID})
	if err != nil {
		return Session{}, err
	}
	if !ok {
		session, err = s.withProtocolV2TurnStateProjection(ctx, workspaceID, session, nil, latestInteractionsBySessionID[session.ID])
	} else {
		session, err = s.withProtocolV2TurnStateProjection(ctx, workspaceID, session, &latestTurn, latestInteractionsBySessionID[session.ID])
	}
	if err != nil {
		return Session{}, err
	}
	return s.withTuttiModeActivation(ctx, workspaceID, session)
}

func (s *Service) withProtocolV2TurnStateProjection(ctx context.Context, workspaceID string, session Session, latestTurn *agentactivitybiz.Turn, latestTurnInteractions []agentactivitybiz.Interaction) (Session, error) {
	activeTurnID, err := s.persistedActiveTurnID(ctx, workspaceID, session.ID)
	if err != nil {
		return Session{}, err
	}
	session.ActiveTurnID = activeTurnID
	if activeTurnID != "" {
		turn, ok, err := s.lookupPersistedTurn(ctx, workspaceID, session.ID, activeTurnID)
		if err != nil {
			return Session{}, err
		}
		if ok {
			session.ActiveTurn = &turn
		}
	}
	if latestTurn != nil {
		value := *latestTurn
		session.LatestTurn = &value
	}
	session.LatestTurnInteractions = append([]agentactivitybiz.Interaction(nil), latestTurnInteractions...)
	pending, err := s.TurnStore.ListSessionInteractions(ctx, agentactivitybiz.ListSessionInteractionsInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: session.ID,
		Status:         agentactivitybiz.InteractionStatusPending,
	})
	if err != nil {
		return Session{}, err
	}
	session.PendingInteractions = pending
	return session, nil
}

func (s *Service) withProtocolV2TurnStates(ctx context.Context, workspaceID string, sessions []Session) ([]Session, error) {
	if len(sessions) == 0 {
		return sessions, nil
	}
	if s == nil || s.TurnStore == nil {
		return s.withTuttiModeActivations(ctx, workspaceID, sessions)
	}
	ids := make([]string, 0, len(sessions))
	activeTurnIDBySessionID := make(map[string]string)
	for _, session := range sessions {
		sessionID := strings.TrimSpace(session.ID)
		ids = append(ids, sessionID)
		if activeTurnID := strings.TrimSpace(session.ActiveTurnID); activeTurnID != "" {
			activeTurnIDBySessionID[sessionID] = activeTurnID
		}
	}
	latestBySessionID, err := s.TurnStore.ListLatestTurns(ctx, workspaceID, ids)
	if err != nil {
		return nil, err
	}
	latestInteractionsBySessionID, err := s.TurnStore.ListLatestTurnInteractions(ctx, workspaceID, ids)
	if err != nil {
		return nil, err
	}
	activeBySessionID, err := s.TurnStore.ListTurnsBySession(ctx, workspaceID, activeTurnIDBySessionID)
	if err != nil {
		return nil, err
	}
	pendingBySessionID, err := s.TurnStore.ListPendingInteractionsBySession(ctx, workspaceID, ids)
	if err != nil {
		return nil, err
	}
	result := make([]Session, len(sessions))
	for i, session := range sessions {
		sessionID := strings.TrimSpace(session.ID)
		if latest, ok := latestBySessionID[sessionID]; ok {
			value := latest
			session.LatestTurn = &value
		}
		if active, ok := activeBySessionID[sessionID]; ok {
			value := active
			session.ActiveTurn = &value
		}
		session.PendingInteractions = pendingBySessionID[sessionID]
		session.LatestTurnInteractions = latestInteractionsBySessionID[sessionID]
		result[i] = session
	}
	return s.withTuttiModeActivations(ctx, workspaceID, result)
}
