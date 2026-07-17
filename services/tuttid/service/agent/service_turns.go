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

	hostResult, err := s.applicationHost(serviceHostPreparation{service: s}).CancelTurn(ctx, agenthost.CancelTurnInput{
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

// withProtocolV2TurnState enriches an outgoing session projection with the
// persisted v2 turn state: activeTurnId pointer, embedded active/latest turns,
// and pending interactions. latestTurn remains an independent turn entity
// projection; it is never persisted on the session row.
func (s *Service) withProtocolV2TurnState(ctx context.Context, workspaceID string, session Session) (Session, error) {
	if s == nil || s.TurnStore == nil {
		return session, nil
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
		return s.withProtocolV2TurnStateProjection(ctx, workspaceID, session, nil, latestInteractionsBySessionID[session.ID])
	}
	return s.withProtocolV2TurnStateProjection(ctx, workspaceID, session, &latestTurn, latestInteractionsBySessionID[session.ID])
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
	if s == nil || s.TurnStore == nil || len(sessions) == 0 {
		return sessions, nil
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
	return result, nil
}
