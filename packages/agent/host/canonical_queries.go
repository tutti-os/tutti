package agenthost

import (
	"context"
	"errors"
	"fmt"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// PlanDecisionContinuation is the canonical parent-to-child relation created
// by a completed plan implementation decision. The Host owns the proof that
// the child was durably submitted; consumers only receive the already paired
// Session and Turn snapshot for projection.
type PlanDecisionContinuation struct {
	Session storesqlite.Session
	Turn    storesqlite.Turn
}

// GoalActivityTurn is one latest canonical Turn whose immutable provenance is
// backed by a durable Goal operation. Consumers use this proof to project
// turnless Goal sessions without treating an arbitrary newer Turn in the same
// Session as shared Goal activity.
type GoalActivityTurn struct {
	Session storesqlite.Session
	Turn    storesqlite.Turn
}

// GetTurn exposes canonical turn truth without requiring Host consumers to
// retain or type-assert the concrete store used by the Host adapter.
func (h *Host) GetTurn(ctx context.Context, ref SessionRef, turnID string) (storesqlite.Turn, bool, error) {
	ref.WorkspaceID = strings.TrimSpace(ref.WorkspaceID)
	ref.AgentSessionID = strings.TrimSpace(ref.AgentSessionID)
	turnID = strings.TrimSpace(turnID)
	if h == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" || turnID == "" {
		return storesqlite.Turn{}, false, ErrInvalidArgument
	}
	return h.store.GetTurn(ctx, ref.WorkspaceID, ref.AgentSessionID, turnID)
}

// GetCanonicalSessionAndTurn reads the canonical Session and Turn from one
// storage snapshot. Cross-entity live projections use this boundary so a
// terminal Turn cannot be paired with the preceding Session active-turn
// pointer (or vice versa).
func (h *Host) GetCanonicalSessionAndTurn(
	ctx context.Context,
	ref SessionRef,
	turnID string,
) (storesqlite.Session, storesqlite.Turn, bool, error) {
	ref = normalizedSessionRef(ref)
	turnID = strings.TrimSpace(turnID)
	if h == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" || turnID == "" {
		return storesqlite.Session{}, storesqlite.Turn{}, false, ErrInvalidArgument
	}
	if reader, ok := h.store.(interface {
		GetSessionAndTurn(context.Context, string, string, string) (storesqlite.Session, storesqlite.Turn, bool, error)
	}); ok {
		return reader.GetSessionAndTurn(ctx, ref.WorkspaceID, ref.AgentSessionID, turnID)
	}
	session, found, err := h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil || !found {
		return session, storesqlite.Turn{}, false, err
	}
	turn, found, err := h.store.GetTurn(ctx, ref.WorkspaceID, ref.AgentSessionID, turnID)
	return session, turn, found, err
}

// GetRuntimeOperation exposes one durable coordinator record to read-only
// projection consumers. The operation store remains the owner of lifecycle
// transitions; this boundary only lets a consumer prove an explicit
// continuation identity instead of inferring it from session recency.
func (h *Host) GetRuntimeOperation(
	ctx context.Context,
	workspaceID string,
	operationID string,
) (storesqlite.RuntimeOperation, bool, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	operationID = strings.TrimSpace(operationID)
	if h == nil || h.operations == nil || workspaceID == "" || operationID == "" {
		return storesqlite.RuntimeOperation{}, false, ErrInvalidArgument
	}
	return h.operations.GetRuntimeOperation(ctx, workspaceID, operationID)
}

// GetPlanDecisionContinuation returns the exact child Turn created by the
// plan-implementation operation for parentTurnID. The operation identity,
// checkpoint, and durable submit evidence are all validated here so callers
// do not infer ownership from message markers or session recency.
func (h *Host) GetPlanDecisionContinuation(
	ctx context.Context,
	ref SessionRef,
	parentTurnID string,
) (PlanDecisionContinuation, bool, error) {
	ref = normalizedSessionRef(ref)
	parentTurnID = strings.TrimSpace(parentTurnID)
	if h == nil || h.store == nil || h.operations == nil ||
		ref.WorkspaceID == "" || ref.AgentSessionID == "" || parentTurnID == "" {
		return PlanDecisionContinuation{}, false, ErrInvalidArgument
	}
	operationID := runtimeOperationID(
		ref.WorkspaceID,
		ref.AgentSessionID,
		storesqlite.RuntimeOperationKindPlanDecision,
		parentTurnID,
	)
	operation, found, err := h.operations.GetRuntimeOperation(
		ctx, ref.WorkspaceID, operationID,
	)
	if err != nil || !found {
		return PlanDecisionContinuation{}, found, err
	}
	if operation.WorkspaceID != ref.WorkspaceID ||
		operation.AgentSessionID != ref.AgentSessionID ||
		operation.OperationID != operationID ||
		operation.Kind != storesqlite.RuntimeOperationKindPlanDecision ||
		operation.TurnID != parentTurnID {
		return PlanDecisionContinuation{}, false, ErrRuntimeOperationIdentityMismatch
	}
	if operation.Status != storesqlite.RuntimeOperationStatusCompleted {
		return PlanDecisionContinuation{}, false, nil
	}
	if operation.Result != storesqlite.RuntimeOperationResultApplied {
		return PlanDecisionContinuation{}, false, ErrRuntimeOperationIdentityMismatch
	}
	if runtimeOperationPayloadText(operation.Payload, "step") != "send_confirmed" {
		return PlanDecisionContinuation{}, false, nil
	}
	if runtimeOperationPayloadText(operation.Payload, "promptKind") != "plan-implementation" ||
		runtimeOperationPayloadText(operation.Payload, "action") != "implement" {
		return PlanDecisionContinuation{}, false, ErrRuntimeOperationIdentityMismatch
	}
	confirmedTurnID := runtimeOperationPayloadText(operation.Payload, "confirmedTurnId")
	clientSubmitID := runtimeOperationPayloadText(operation.Payload, "clientSubmitId")
	if confirmedTurnID == "" || confirmedTurnID == parentTurnID || clientSubmitID == "" {
		return PlanDecisionContinuation{}, false, ErrRuntimeOperationIdentityMismatch
	}
	confirmedByMessage, messageFound, err := h.FindTurnByClientSubmitID(
		ctx, ref, clientSubmitID,
	)
	if err != nil {
		return PlanDecisionContinuation{}, false, err
	}
	if !messageFound || confirmedByMessage != confirmedTurnID {
		return PlanDecisionContinuation{}, false, ErrRuntimeOperationIdentityMismatch
	}
	session, turn, turnFound, err := h.GetCanonicalSessionAndTurn(
		ctx, ref, confirmedTurnID,
	)
	if err != nil {
		return PlanDecisionContinuation{}, false, err
	}
	if !turnFound || turn.TurnID != confirmedTurnID ||
		turn.AgentSessionID != ref.AgentSessionID {
		return PlanDecisionContinuation{}, false, ErrTurnNotFound
	}
	parentIdentityTurnID, err := h.resolveUltimateTurnIdentity(ctx, ref, parentTurnID)
	if err != nil {
		return PlanDecisionContinuation{}, false, err
	}
	if strings.TrimSpace(turn.IdentityAnchorTurnID) != parentIdentityTurnID {
		return PlanDecisionContinuation{}, false, ErrRuntimeOperationIdentityMismatch
	}
	latest, err := h.store.ListSessionTurnSummaries(ctx, storesqlite.ListSessionTurnSummariesInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, Limit: 1,
	})
	if err != nil {
		return PlanDecisionContinuation{}, false, err
	}
	if len(latest.Turns) != 1 || strings.TrimSpace(latest.Turns[0].TurnID) != confirmedTurnID {
		// A durable relation is not enough to project an old child after an
		// unrelated newer Turn has become canonical. The caller must observe the
		// current session frontier and only project the latest proven Turn.
		return PlanDecisionContinuation{}, false, nil
	}
	return PlanDecisionContinuation{
		Session: session,
		Turn:    turn,
	}, true, nil
}

// resolveUltimateTurnIdentity returns the one-hop canonical Turn whose
// external identity the requested Turn represents. Canonical persistence
// flattens inherited identities, so a nested or dangling anchor is corruption
// rather than another relation for callers to traverse.
func (h *Host) resolveUltimateTurnIdentity(
	ctx context.Context,
	ref SessionRef,
	turnID string,
) (string, error) {
	turn, found, err := h.store.GetTurn(ctx, ref.WorkspaceID, ref.AgentSessionID, turnID)
	if err != nil {
		return "", err
	}
	if !found || turn.TurnID != turnID || turn.AgentSessionID != ref.AgentSessionID {
		return "", ErrTurnNotFound
	}
	anchorTurnID := strings.TrimSpace(turn.IdentityAnchorTurnID)
	if anchorTurnID == "" {
		return turnID, nil
	}
	if anchorTurnID == turnID {
		return "", ErrRuntimeOperationIdentityMismatch
	}
	anchor, found, err := h.store.GetTurn(ctx, ref.WorkspaceID, ref.AgentSessionID, anchorTurnID)
	if err != nil {
		return "", err
	}
	if !found || anchor.TurnID != anchorTurnID ||
		anchor.AgentSessionID != ref.AgentSessionID ||
		strings.TrimSpace(anchor.IdentityAnchorTurnID) != "" {
		return "", ErrRuntimeOperationIdentityMismatch
	}
	return anchorTurnID, nil
}

// GetGoalActivityTurn proves that candidateTurnID is the Session's latest
// active Turn and belongs to a durable Goal generation. The Turn's provenance
// is necessary but not sufficient: Host also validates the referenced Goal
// operation and its exact revision/repair epoch so consumers never recreate
// Goal-generation ownership from canonical fields alone.
func (h *Host) GetGoalActivityTurn(
	ctx context.Context,
	ref SessionRef,
	candidateTurnID string,
) (GoalActivityTurn, bool, error) {
	ref = normalizedSessionRef(ref)
	candidateTurnID = strings.TrimSpace(candidateTurnID)
	if h == nil || h.store == nil || h.goals == nil ||
		ref.WorkspaceID == "" || ref.AgentSessionID == "" || candidateTurnID == "" {
		return GoalActivityTurn{}, false, ErrInvalidArgument
	}
	session, turn, found, err := h.GetCanonicalSessionAndTurn(ctx, ref, candidateTurnID)
	if err != nil || !found {
		return GoalActivityTurn{}, found, err
	}
	if strings.TrimSpace(session.WorkspaceID) != ref.WorkspaceID ||
		strings.TrimSpace(session.ID) != ref.AgentSessionID ||
		strings.TrimSpace(session.ActiveTurnID) != candidateTurnID ||
		strings.TrimSpace(turn.WorkspaceID) != ref.WorkspaceID ||
		strings.TrimSpace(turn.AgentSessionID) != ref.AgentSessionID ||
		strings.TrimSpace(turn.TurnID) != candidateTurnID {
		return GoalActivityTurn{}, false, nil
	}
	if turn.Origin != storesqlite.TurnOriginGoalArm &&
		turn.Origin != storesqlite.TurnOriginGoalContinuation {
		return GoalActivityTurn{}, false, nil
	}
	operationID := strings.TrimSpace(turn.SourceGoalOperationID)
	if operationID == "" || turn.SourceGoalRevision <= 0 || turn.SourceGoalRepairEpoch < 0 {
		return GoalActivityTurn{}, false, nil
	}
	operation, operationFound, err := h.goals.GetGoalControlOperation(
		ctx, ref.WorkspaceID, operationID,
	)
	if err != nil || !operationFound {
		return GoalActivityTurn{}, operationFound, err
	}
	if strings.TrimSpace(operation.OperationID) != operationID ||
		strings.TrimSpace(operation.WorkspaceID) != ref.WorkspaceID ||
		strings.TrimSpace(operation.AgentSessionID) != ref.AgentSessionID ||
		operation.GoalRevision != turn.SourceGoalRevision ||
		operation.RepairEpoch != turn.SourceGoalRepairEpoch {
		return GoalActivityTurn{}, false, storesqlite.ErrGoalOperationConflict
	}
	switch operation.Status {
	case storesqlite.GoalOperationStatusPrepared,
		storesqlite.GoalOperationStatusDispatched,
		storesqlite.GoalOperationStatusCompleted:
	default:
		return GoalActivityTurn{}, false, nil
	}
	latest, err := h.store.ListSessionTurnSummaries(ctx, storesqlite.ListSessionTurnSummariesInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID, Limit: 1,
	})
	if err != nil {
		return GoalActivityTurn{}, false, err
	}
	if len(latest.Turns) != 1 || strings.TrimSpace(latest.Turns[0].TurnID) != candidateTurnID {
		return GoalActivityTurn{}, false, nil
	}
	return GoalActivityTurn{Session: session, Turn: turn}, true, nil
}

// FindTurnByClientSubmitID exposes the canonical idempotency lookup without
// requiring callers to depend on a concrete SQLite store.
func (h *Host) FindTurnByClientSubmitID(ctx context.Context, ref SessionRef, clientSubmitID string) (string, bool, error) {
	ref.WorkspaceID = strings.TrimSpace(ref.WorkspaceID)
	ref.AgentSessionID = strings.TrimSpace(ref.AgentSessionID)
	clientSubmitID = strings.TrimSpace(clientSubmitID)
	if h == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" || clientSubmitID == "" {
		return "", false, ErrInvalidArgument
	}
	return h.store.FindTurnByClientSubmitID(ctx, ref.WorkspaceID, ref.AgentSessionID, clientSubmitID)
}

// ListSessionMessages reads one version-cursor page of canonical message
// snapshots without starting or resuming a provider runtime. Session identity
// is carried only by SessionRef; the query owns filters and pagination.
func (h *Host) ListSessionMessages(ctx context.Context, ref SessionRef, query SessionMessageQuery) (storesqlite.MessagePage, bool, error) {
	ref = normalizedSessionRef(ref)
	if h == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return storesqlite.MessagePage{}, false, ErrInvalidArgument
	}
	return h.store.ListSessionMessages(ctx, storesqlite.ListSessionMessagesInput{
		WorkspaceID:    ref.WorkspaceID,
		AgentSessionID: ref.AgentSessionID,
		MessageID:      strings.TrimSpace(query.MessageID),
		TurnID:         strings.TrimSpace(query.TurnID),
		AfterVersion:   query.AfterVersion,
		BeforeVersion:  query.BeforeVersion,
		Limit:          query.Limit,
		Order:          query.Order,
	})
}

// ListSessionTurns reads one bounded, newest-first page of canonical Turn
// metadata without loading messages or starting a provider runtime.
func (h *Host) ListSessionTurns(ctx context.Context, ref SessionRef, query SessionTurnQuery) (SessionTurnSummaryPage, error) {
	ref = normalizedSessionRef(ref)
	if h == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return SessionTurnSummaryPage{}, ErrInvalidArgument
	}
	var before *storesqlite.SessionTurnCursor
	if query.Before != nil {
		before = &storesqlite.SessionTurnCursor{
			StartedAtUnixMS: query.Before.StartedAtUnixMS,
			TurnID:          strings.TrimSpace(query.Before.TurnID),
		}
	}
	return h.store.ListSessionTurnSummaries(ctx, storesqlite.ListSessionTurnSummariesInput{
		WorkspaceID: ref.WorkspaceID, AgentSessionID: ref.AgentSessionID,
		Before: before, Limit: query.Limit,
	})
}

// GetSessionInteractionSnapshot returns every interaction from the canonical
// latest turn and derives the actionable subset from that same read. It does
// not start or resume a provider runtime.
func (h *Host) GetSessionInteractionSnapshot(ctx context.Context, ref SessionRef) (SessionInteractionSnapshot, error) {
	ref = normalizedSessionRef(ref)
	if h == nil || h.store == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" {
		return SessionInteractionSnapshot{}, ErrInvalidArgument
	}
	if deleted, err := h.store.SessionDeleted(ctx, ref.WorkspaceID, ref.AgentSessionID); err != nil {
		return SessionInteractionSnapshot{}, err
	} else if deleted {
		return SessionInteractionSnapshot{}, ErrSessionNotFound
	}
	if _, found, err := h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID); err != nil {
		return SessionInteractionSnapshot{}, err
	} else if !found {
		return SessionInteractionSnapshot{}, ErrSessionNotFound
	}

	bySession, err := h.store.ListLatestTurnInteractions(ctx, ref.WorkspaceID, []string{ref.AgentSessionID})
	if err != nil {
		return SessionInteractionSnapshot{}, err
	}
	interactions := append([]storesqlite.Interaction(nil), bySession[ref.AgentSessionID]...)
	pending := make([]storesqlite.Interaction, 0, len(interactions))
	for _, interaction := range interactions {
		if interaction.Status == storesqlite.InteractionStatusPending {
			pending = append(pending, interaction)
		}
	}
	return SessionInteractionSnapshot{Interactions: interactions, PendingInteractions: pending}, nil
}

// GetSessionInteractionTreeSnapshot returns the canonical interaction state
// for one root Turn and every descendant Session's latest Turn. It does not
// start or resume a provider runtime.
func (h *Host) GetSessionInteractionTreeSnapshot(
	ctx context.Context,
	root SessionRef,
	query SessionInteractionTreeQuery,
) (SessionInteractionTreeSnapshot, error) {
	root = normalizedSessionRef(root)
	query.RootTurnID = strings.TrimSpace(query.RootTurnID)
	if h == nil || h.interactionTrees == nil || root.WorkspaceID == "" || root.AgentSessionID == "" {
		return SessionInteractionTreeSnapshot{}, ErrInvalidArgument
	}
	snapshot, found, err := h.interactionTrees.GetSessionInteractionTreeSnapshot(ctx, storesqlite.SessionInteractionTreeQuery{
		WorkspaceID: root.WorkspaceID, RootAgentSessionID: root.AgentSessionID, RootTurnID: query.RootTurnID,
	})
	if errors.Is(err, storesqlite.ErrInteractionTreeRootRequired) {
		return SessionInteractionTreeSnapshot{}, ErrInvalidArgument
	}
	if errors.Is(err, storesqlite.ErrInteractionTreeRootTurnNotFound) {
		return SessionInteractionTreeSnapshot{}, ErrTurnNotFound
	}
	if err != nil {
		return SessionInteractionTreeSnapshot{}, err
	}
	if !found {
		return SessionInteractionTreeSnapshot{}, ErrSessionNotFound
	}
	return SessionInteractionTreeSnapshot{
		RootTurnID:          snapshot.RootTurnID,
		Interactions:        snapshot.Interactions,
		PendingInteractions: snapshot.PendingInteractions,
	}, nil
}

// GetInteraction reads one exact canonical Interaction by its complete identity.
// It does not derive actionability or mutate lifecycle.
func (h *Host) GetInteraction(
	ctx context.Context,
	ref SessionRef,
	turnID, requestID string,
) (storesqlite.Interaction, bool, error) {
	ref = normalizedSessionRef(ref)
	turnID = strings.TrimSpace(turnID)
	requestID = strings.TrimSpace(requestID)
	if h == nil || h.store == nil ||
		ref.WorkspaceID == "" || ref.AgentSessionID == "" ||
		turnID == "" || requestID == "" {
		return storesqlite.Interaction{}, false, ErrInvalidArgument
	}
	interactions, err := h.store.ListSessionInteractions(
		ctx,
		storesqlite.ListSessionInteractionsInput{
			WorkspaceID:    ref.WorkspaceID,
			AgentSessionID: ref.AgentSessionID,
			TurnID:         turnID,
			RequestID:      requestID,
		},
	)
	if err != nil {
		return storesqlite.Interaction{}, false, err
	}
	switch len(interactions) {
	case 0:
		return storesqlite.Interaction{}, false, nil
	case 1:
		return interactions[0], true, nil
	default:
		return storesqlite.Interaction{}, false, fmt.Errorf(
			"canonical interaction invariant: identity (%q, %q, %q, %q) returned %d rows",
			ref.WorkspaceID,
			ref.AgentSessionID,
			turnID,
			requestID,
			len(interactions),
		)
	}
}
