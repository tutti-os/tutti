package agent

import (
	"context"
	"errors"
	"log/slog"
	"strings"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// TurnStore is the narrow persisted-turn read surface the service needs for
// protocol v2 turn control operations.
type TurnStore interface {
	GetLatestTurn(context.Context, string, string) (agentactivitybiz.Turn, bool, error)
	GetTurn(context.Context, string, string, string) (agentactivitybiz.Turn, bool, error)
	GetSession(context.Context, string, string) (agentactivitybiz.Session, bool, error)
	ListSessionTurns(context.Context, string, string) ([]agentactivitybiz.Turn, error)
	ListEffectiveSessionTurns(context.Context, string, string) ([]agentactivitybiz.Turn, error)
	ListSessionInteractions(context.Context, agentactivitybiz.ListSessionInteractionsInput) ([]agentactivitybiz.Interaction, error)
	ListLatestTurns(context.Context, string, []string) (map[string]agentactivitybiz.Turn, error)
	ListLatestTurnInteractions(context.Context, string, []string) (map[string][]agentactivitybiz.Interaction, error)
	ListTurnsBySession(context.Context, string, map[string]string) (map[string]agentactivitybiz.Turn, error)
	ListPendingInteractionsBySession(context.Context, string, []string) (map[string][]agentactivitybiz.Interaction, error)
}

type sessionGoalStateBatchReader interface {
	ListSessionGoalStates(context.Context, string, []string) (map[string]agentactivitybiz.SessionGoalState, error)
}

// TurnCancelObserver is notified after CancelTurn actually canceled a live
// turn. The Issue manager uses it to cascade a user's stop on a planning
// conversation to every running task run that conversation orchestrates.
type TurnCancelObserver interface {
	ObserveUserTurnCanceled(ctx context.Context, workspaceID string, agentSessionID string)
}

type CancelTurnReason string

const (
	CancelTurnReasonTurnCanceled    CancelTurnReason = "turn_canceled"
	CancelTurnReasonCancelRequested CancelTurnReason = "cancel_requested"
	CancelTurnReasonAlreadySettled  CancelTurnReason = "already_settled"
	CancelTurnReasonNotFound        CancelTurnReason = "not_found"
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
// never an error. An exact cancel whose provider delivery is unconfirmed is
// accepted as cancel_requested; canonical terminal evidence determines its outcome.
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
	pending := errors.Is(err, agenthost.ErrRuntimeOperationInProgress) && hostResult.IntentAccepted
	if err != nil && !pending {
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
	if pending {
		result.Reason = CancelTurnReasonCancelRequested
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
		if s.TurnCancelObserver != nil {
			// Enter the product's durable stop boundary before returning. The
			// canonical canceled Turn and source-activity inbox marker remain
			// the crash-recovery fallback if this callback is interrupted.
			s.TurnCancelObserver.ObserveUserTurnCanceled(
				context.WithoutCancel(ctx), workspaceID, agentSessionID,
			)
		}
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
// response that contains one Session. Keep the persisted Turn projection, the
// Host-owned Goal synchronization evidence, and the Tutti-owned,
// session-associated activation read projection here so mutations cannot
// accidentally return a partial Session that clears newer client state.
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
// session-associated TuttiModeActivation and Host-owned Goal synchronization
// read projections are attached last.
func (s *Service) withProtocolV2TurnState(ctx context.Context, workspaceID string, session Session) (Session, error) {
	return s.withProtocolV2TurnStateProjectionOptions(
		ctx,
		workspaceID,
		session,
		true,
	)
}

func (s *Service) withProtocolV2TurnStateProjectionOptions(
	ctx context.Context,
	workspaceID string,
	session Session,
	resolveProviderCapabilities bool,
) (Session, error) {
	if s == nil || s.TurnStore == nil {
		if resolveProviderCapabilities {
			session = s.withSessionForkCapabilities(ctx, workspaceID, session)
		}
		var err error
		session, err = s.withSessionForkLineage(ctx, workspaceID, session)
		if err != nil {
			return Session{}, err
		}
		session, err = s.withTuttiModeActivation(ctx, workspaceID, session)
		if err != nil {
			return Session{}, err
		}
		return s.withSessionGoalState(ctx, workspaceID, session)
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
	if resolveProviderCapabilities {
		session = s.withSessionForkCapabilities(ctx, workspaceID, session)
		if session.ActiveTurn != nil {
			value := s.withProviderTurnForkability(
				ctx, workspaceID, session.ID, *session.ActiveTurn,
			)
			session.ActiveTurn = &value
		}
		if session.LatestTurn != nil {
			value := s.withProviderTurnForkability(
				ctx, workspaceID, session.ID, *session.LatestTurn,
			)
			session.LatestTurn = &value
		}
	}
	session, err = s.withSessionForkLineage(ctx, workspaceID, session)
	if err != nil {
		return Session{}, err
	}
	session, err = s.withTuttiModeActivation(ctx, workspaceID, session)
	if err != nil {
		return Session{}, err
	}
	return s.withSessionGoalState(ctx, workspaceID, session)
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
		result, err := s.withTuttiModeActivations(ctx, workspaceID, sessions)
		if err != nil {
			return nil, err
		}
		return s.withSessionGoalStates(ctx, workspaceID, result)
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
	forkabilityByTurn := make(map[string]bool)
	result := make([]Session, len(sessions))
	for i, session := range sessions {
		sessionID := strings.TrimSpace(session.ID)
		if latest, ok := latestBySessionID[sessionID]; ok {
			value := latest
			if strings.TrimSpace(session.Kind) != agentactivitybiz.SessionKindChild {
				value = s.withProviderTurnForkabilityCached(
					ctx, workspaceID, sessionID, latest, forkabilityByTurn,
				)
			} else {
				value.ProviderForkBindingAvailable = false
			}
			session.LatestTurn = &value
		}
		if active, ok := activeBySessionID[sessionID]; ok {
			value := active
			if strings.TrimSpace(session.Kind) != agentactivitybiz.SessionKindChild {
				value = s.withProviderTurnForkabilityCached(
					ctx, workspaceID, sessionID, active, forkabilityByTurn,
				)
			} else {
				value.ProviderForkBindingAvailable = false
			}
			session.ActiveTurn = &value
		}
		session.PendingInteractions = pendingBySessionID[sessionID]
		session.LatestTurnInteractions = latestInteractionsBySessionID[sessionID]
		session, err = s.withSessionForkLineage(ctx, workspaceID, session)
		if err != nil {
			return nil, err
		}
		result[i] = session
	}
	result, err = s.withTuttiModeActivations(ctx, workspaceID, result)
	if err != nil {
		return nil, err
	}
	return s.withSessionGoalStates(ctx, workspaceID, result)
}

func (s *Service) withProviderTurnForkabilityCached(
	ctx context.Context,
	workspaceID string,
	agentSessionID string,
	turn agentactivitybiz.Turn,
	forkabilityByTurn map[string]bool,
) agentactivitybiz.Turn {
	turn.ProviderForkBindingAvailable = false
	if strings.TrimSpace(turn.Phase) != agentactivitybiz.TurnPhaseSettled {
		return turn
	}
	key := strings.Join([]string{
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(agentSessionID),
		strings.TrimSpace(turn.TurnID),
		strings.TrimSpace(turn.RootProviderTurnID),
		string(turn.ProviderTurnBindingJSON),
	}, "\x00")
	if forkable, ok := forkabilityByTurn[key]; ok {
		turn.ProviderForkBindingAvailable = forkable
		return turn
	}
	projected := s.withProviderTurnForkability(
		ctx, workspaceID, agentSessionID, turn,
	)
	forkabilityByTurn[key] = projected.ProviderForkBindingAvailable
	return projected
}

func (s *Service) withSessionGoalState(
	ctx context.Context,
	workspaceID string,
	session Session,
) (Session, error) {
	session.GoalSyncState = nil
	if s == nil || s.GoalStateStore == nil {
		return session, nil
	}
	state, found, err := s.GoalStateStore.GetSessionGoalState(
		ctx,
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(session.ID),
	)
	if err != nil {
		return Session{}, err
	}
	if found {
		return projectSessionGoalState(session, state)
	}
	return session, nil
}

func (s *Service) withSessionGoalStates(
	ctx context.Context,
	workspaceID string,
	sessions []Session,
) ([]Session, error) {
	if len(sessions) == 0 {
		return sessions, nil
	}
	result := make([]Session, len(sessions))
	for i, session := range sessions {
		session.GoalSyncState = nil
		result[i] = session
	}
	if s == nil || s.GoalStateStore == nil {
		return result, nil
	}
	ids := make([]string, 0, len(sessions))
	for _, session := range result {
		ids = append(ids, strings.TrimSpace(session.ID))
	}
	states := make(map[string]agentactivitybiz.SessionGoalState)
	if reader, ok := s.GoalStateStore.(sessionGoalStateBatchReader); ok {
		var err error
		states, err = reader.ListSessionGoalStates(
			ctx,
			strings.TrimSpace(workspaceID),
			ids,
		)
		if err != nil {
			return nil, err
		}
	} else {
		for _, id := range ids {
			state, found, err := s.GoalStateStore.GetSessionGoalState(
				ctx,
				strings.TrimSpace(workspaceID),
				id,
			)
			if err != nil {
				return nil, err
			}
			if found {
				states[id] = state
			}
		}
	}
	for i, session := range result {
		if state, ok := states[strings.TrimSpace(session.ID)]; ok {
			projected, err := projectSessionGoalState(session, state)
			if err != nil {
				return nil, err
			}
			session = projected
		}
		result[i] = session
	}
	return result, nil
}

// projectSessionGoalState makes Host-owned durable Goal state the Session read
// authority. Desired state remains visible while convergence is unresolved;
// once synced (or definitively failed), observed state owns provider progress.
func projectSessionGoalState(
	session Session,
	state agentactivitybiz.SessionGoalState,
) (Session, error) {
	var rawGoal any
	if !state.Tombstoned && len(state.Desired) > 0 {
		rawGoal = state.Desired
	}
	if !state.Tombstoned &&
		(state.SyncStatus == agentactivitybiz.GoalSyncStatusSynced ||
			state.SyncStatus == agentactivitybiz.GoalSyncStatusFailed) &&
		len(state.Observed) > 0 {
		rawGoal = state.Observed
	}
	goal, err := decodeProjectedSessionGoal(rawGoal)
	if err != nil {
		return Session{}, err
	}
	session.Metadata.Goal = goal
	session.GoalSyncState = projectedSessionGoalSyncState(state)
	if state.UpdatedAtUnixMS > 0 &&
		(session.UpdatedAt == nil || state.UpdatedAtUnixMS > session.UpdatedAt.UnixMilli()) {
		updatedAt := time.UnixMilli(state.UpdatedAtUnixMS)
		session.UpdatedAt = &updatedAt
	}
	return session, nil
}

func decodeProjectedSessionGoal(rawGoal any) (*agentactivitybiz.SessionGoal, error) {
	raw, ok := rawGoal.(map[string]any)
	status, _ := raw["status"].(string)
	if !ok || strings.TrimSpace(status) != "completed" {
		return agentactivitybiz.DecodeSessionGoal(rawGoal)
	}
	normalized := make(map[string]any, len(raw))
	for key, value := range raw {
		normalized[key] = value
	}
	normalized["status"] = "complete"
	return agentactivitybiz.DecodeSessionGoal(normalized)
}

func projectedSessionGoalSyncState(state agentactivitybiz.SessionGoalState) *SessionGoalSyncState {
	return &SessionGoalSyncState{
		Revision:           state.Revision,
		SyncStatus:         strings.TrimSpace(state.SyncStatus),
		PendingOperationID: strings.TrimSpace(state.PendingOperationID),
		ExecutionPending:   state.ExecutionPending,
	}
}

func (s *Service) withSessionForkLineage(
	ctx context.Context,
	workspaceID string,
	session Session,
) (Session, error) {
	session.ForkedFrom = nil
	if s == nil || strings.TrimSpace(workspaceID) == "" ||
		strings.TrimSpace(session.ID) == "" ||
		strings.TrimSpace(session.Kind) != agentactivitybiz.SessionKindRoot {
		return session, nil
	}
	lineage, found, err := s.ApplicationHost().GetSessionForkLineage(
		ctx,
		strings.TrimSpace(workspaceID),
		strings.TrimSpace(session.ID),
	)
	if err != nil || !found {
		return session, err
	}
	session.ForkedFrom = &SessionForkLineage{
		SourceAgentSessionID: strings.TrimSpace(lineage.SourceAgentSessionID),
		SourceTurnID:         strings.TrimSpace(lineage.SourceTurnID),
		TargetTurnID:         strings.TrimSpace(lineage.TargetTurnID),
		OperationID:          strings.TrimSpace(lineage.OperationID),
		ForkedAtUnixMS:       lineage.ForkedAtUnixMS,
	}
	return session, nil
}
