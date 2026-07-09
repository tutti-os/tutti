package agent

import (
	"context"
	"log/slog"
	"strings"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

// TurnStore is the narrow persisted-turn read surface the service needs for
// protocol v2 turn control operations.
type TurnStore interface {
	GetTurn(context.Context, string, string, string) (agentactivitybiz.Turn, bool, error)
	GetSession(context.Context, string, string) (agentactivitybiz.Session, bool, error)
	ListSessionInteractions(context.Context, agentactivitybiz.ListSessionInteractionsInput) ([]agentactivitybiz.Interaction, error)
}

// TurnStateRecorder is the projection-side write surface for protocol v2
// turn/interaction transitions that must also publish activity events.
type TurnStateRecorder interface {
	SettleTurnCanceled(ctx context.Context, workspaceID string, agentSessionID string, turnID string)
	MarkInteractionAnswered(ctx context.Context, workspaceID string, agentSessionID string, requestID string)
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
	// StaleTurnReconciled preserves the deprecated session-cancel wire
	// vocabulary when Cancel delegates here; the v2 endpoint ignores it.
	StaleTurnReconciled bool
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

	turn, found := s.lookupPersistedTurn(ctx, workspaceID, agentSessionID, turnID)
	if !found {
		session, err := s.get(ctx, workspaceID, agentSessionID, false)
		if err != nil {
			return CancelTurnResult{}, err
		}
		return CancelTurnResult{
			Session: session,
			Reason:  CancelTurnReasonNotFound,
		}, nil
	}
	if turn.Phase == agentactivitybiz.TurnPhaseSettled {
		session, err := s.get(ctx, workspaceID, agentSessionID, false)
		if err != nil {
			return CancelTurnResult{}, err
		}
		return CancelTurnResult{
			Session: session,
			Turn:    &turn,
			Reason:  CancelTurnReasonAlreadySettled,
		}, nil
	}

	ensured, err := s.ensureRuntimeSessionResult(ctx, workspaceID, agentSessionID)
	if err != nil {
		return CancelTurnResult{}, err
	}
	staleTurnReconciled := ensured.StaleTurnReconciled
	if !staleTurnReconciled {
		cancelResult, cancelErr := s.controller().Cancel(ctx, RuntimeCancelInput{
			WorkspaceID:    workspaceID,
			AgentSessionID: agentSessionID,
			Reason:         "user requested turn cancellation",
		})
		if cancelErr != nil {
			return CancelTurnResult{}, normalizeRuntimeError(cancelErr)
		}
		slog.Info("workspace agent turn cancel runtime completed",
			"event", "workspace_agent_turn.cancel.runtime_completed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"turnId", turnID,
			"runtimeCanceled", cancelResult.Canceled,
		)
	}
	// The runtime settle report may or may not carry this turn; persist the
	// canceled outcome explicitly so the turns table is authoritative. The
	// transition is idempotent: a turn already settled by the runtime report
	// rejects the replay without a duplicate event.
	if s.TurnRecorder != nil {
		s.TurnRecorder.SettleTurnCanceled(ctx, workspaceID, agentSessionID, turnID)
	}

	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return CancelTurnResult{}, err
	}
	result := CancelTurnResult{
		Session:             session,
		Canceled:            true,
		Reason:              CancelTurnReasonTurnCanceled,
		StaleTurnReconciled: staleTurnReconciled,
	}
	if settled, ok := s.lookupPersistedTurn(ctx, workspaceID, agentSessionID, turnID); ok {
		result.Turn = &settled
	}
	return result, nil
}

func (s *Service) lookupPersistedTurn(ctx context.Context, workspaceID string, agentSessionID string, turnID string) (agentactivitybiz.Turn, bool) {
	if s == nil || s.TurnStore == nil {
		return agentactivitybiz.Turn{}, false
	}
	turn, ok, err := s.TurnStore.GetTurn(ctx, workspaceID, agentSessionID, turnID)
	if err != nil {
		slog.Warn("workspace agent turn lookup failed",
			"event", "workspace_agent_turn.lookup_failed",
			"workspaceId", workspaceID,
			"agentSessionId", agentSessionID,
			"turnId", turnID,
			"error", err,
		)
		return agentactivitybiz.Turn{}, false
	}
	return turn, ok
}

// persistedActiveTurnID reads the session's persisted active turn pointer.
// It returns "" when the pointer is unset or the v2 store is not wired.
func (s *Service) persistedActiveTurnID(ctx context.Context, workspaceID string, agentSessionID string) string {
	if s == nil || s.TurnStore == nil {
		return ""
	}
	session, ok, err := s.TurnStore.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil || !ok {
		return ""
	}
	return strings.TrimSpace(session.ActiveTurnID)
}

// withProtocolV2TurnState enriches an outgoing session projection with the
// persisted v2 turn state: activeTurnId pointer, the embedded active turn,
// and pending interactions. Sessions without an active turn stay untouched,
// so list enrichment costs nothing for settled history.
func (s *Service) withProtocolV2TurnState(ctx context.Context, workspaceID string, session Session) Session {
	activeTurnID := s.persistedActiveTurnID(ctx, workspaceID, session.ID)
	if activeTurnID == "" {
		return session
	}
	session.ActiveTurnID = activeTurnID
	if turn, ok := s.lookupPersistedTurn(ctx, workspaceID, session.ID, activeTurnID); ok {
		session.ActiveTurn = &turn
	}
	pending, err := s.TurnStore.ListSessionInteractions(ctx, agentactivitybiz.ListSessionInteractionsInput{
		WorkspaceID:    workspaceID,
		AgentSessionID: session.ID,
		Status:         agentactivitybiz.InteractionStatusPending,
	})
	if err != nil {
		slog.Warn("workspace agent pending interaction lookup failed",
			"event", "workspace_agent_interaction.lookup_failed",
			"workspaceId", workspaceID,
			"agentSessionId", session.ID,
			"error", err,
		)
		return session
	}
	session.PendingInteractions = pending
	return session
}
