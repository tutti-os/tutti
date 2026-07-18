package agenthost

import (
	"context"
	"sort"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type runtimeControlRoute struct {
	RootAgentSessionID string
	TargetSession      storesqlite.Session
}

func (h *Host) CancelTurn(ctx context.Context, input CancelTurnInput) (CancelTurnResult, error) {
	input.WorkspaceID = strings.TrimSpace(input.WorkspaceID)
	input.AgentSessionID = strings.TrimSpace(input.AgentSessionID)
	input.TurnID = strings.TrimSpace(input.TurnID)
	if h == nil || h.store == nil || h.runtime == nil || input.WorkspaceID == "" || input.AgentSessionID == "" || input.TurnID == "" {
		return CancelTurnResult{}, ErrInvalidArgument
	}
	turn, found, err := h.store.GetTurn(ctx, input.WorkspaceID, input.AgentSessionID, input.TurnID)
	if err != nil {
		return CancelTurnResult{}, err
	}
	canonical, sessionFound, readErr := h.store.GetSession(ctx, input.WorkspaceID, input.AgentSessionID)
	if readErr != nil {
		return CancelTurnResult{}, readErr
	}
	if !sessionFound {
		return CancelTurnResult{}, ErrSessionNotFound
	}
	if !found {
		return CancelTurnResult{Canonical: canonical, State: CancelStateNotFound}, nil
	}
	if turn.Phase == storesqlite.TurnPhaseSettled {
		return CancelTurnResult{Canonical: canonical, Turn: &turn, State: CancelStateAlreadySettled, Settled: true, Outcome: turn.Outcome}, nil
	}
	route, err := h.resolveRuntimeControlRoute(ctx, input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return CancelTurnResult{}, err
	}
	targets, err := h.cancelTargetsForTurn(ctx, input.WorkspaceID, route, input.TurnID)
	if err != nil {
		return CancelTurnResult{}, err
	}
	operation, err := h.prepareCancelRuntimeOperation(ctx, input, route.RootAgentSessionID, targets)
	if err != nil {
		return CancelTurnResult{}, err
	}
	result := CancelTurnResult{Canonical: canonical, Turn: &turn, Operation: operation, State: CancelStateRequested, IntentAccepted: true}
	completed, err := h.processRuntimeOperation(ctx, operation, false)
	result.Operation = completed
	if confirmed, _ := completed.Payload["providerConfirmed"].(bool); confirmed {
		result.ProviderConfirmed = true
	}
	if err != nil {
		return result, err
	}
	canonical, sessionFound, err = h.store.GetSession(ctx, input.WorkspaceID, input.AgentSessionID)
	if err != nil {
		return result, err
	}
	if !sessionFound {
		return result, ErrSessionNotFound
	}
	result.Canonical = canonical
	if settled, ok, readErr := h.store.GetTurn(ctx, input.WorkspaceID, input.AgentSessionID, input.TurnID); readErr != nil {
		return result, readErr
	} else if ok {
		result.Turn = &settled
		result.Settled = settled.Phase == storesqlite.TurnPhaseSettled
		result.Outcome = settled.Outcome
		if result.Settled {
			result.State = CancelStateSettled
		}
	}
	return result, nil
}

func (h *Host) SubmitInteractive(ctx context.Context, ref SessionRef, requestID string, input SubmitInteractiveInput) (SubmitInteractiveResult, error) {
	ref.WorkspaceID = strings.TrimSpace(ref.WorkspaceID)
	ref.AgentSessionID = strings.TrimSpace(ref.AgentSessionID)
	requestID = strings.TrimSpace(requestID)
	if h == nil || h.store == nil || h.runtime == nil || ref.WorkspaceID == "" || ref.AgentSessionID == "" || requestID == "" {
		return SubmitInteractiveResult{}, ErrInvalidArgument
	}
	route, err := h.resolveRuntimeControlRoute(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return SubmitInteractiveResult{}, err
	}
	operation, claimDisposition, claimed, err := h.prepareInteractiveRuntimeOperation(ctx, ref, requestID, input, route.RootAgentSessionID)
	if err != nil {
		return SubmitInteractiveResult{}, err
	}
	if !claimed {
		canonical, sessionFound, readErr := h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
		if readErr != nil {
			return SubmitInteractiveResult{}, readErr
		}
		if !sessionFound {
			return SubmitInteractiveResult{}, ErrSessionNotFound
		}
		return SubmitInteractiveResult{Canonical: canonical, Operation: operation, Disposition: claimDisposition}, nil
	}
	processed, err := h.processRuntimeOperation(ctx, operation, false)
	result := SubmitInteractiveResult{Operation: processed, Disposition: claimDisposition}
	switch processed.Result {
	case storesqlite.RuntimeOperationResultAnswered:
		result.Disposition = RuntimeInteractiveDispositionAnswered
	case storesqlite.RuntimeOperationResultSuperseded:
		result.Disposition = RuntimeInteractiveDispositionSuperseded
	}
	if err != nil {
		return result, err
	}
	canonical, sessionFound, err := h.store.GetSession(ctx, ref.WorkspaceID, ref.AgentSessionID)
	if err != nil {
		return result, err
	}
	if !sessionFound {
		return result, ErrSessionNotFound
	}
	result.Canonical = canonical
	return result, nil
}

func (h *Host) resolveRuntimeControlRoute(ctx context.Context, workspaceID, agentSessionID string) (runtimeControlRoute, error) {
	target, found, err := h.store.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return runtimeControlRoute{}, err
	}
	if !found {
		return runtimeControlRoute{}, ErrSessionNotFound
	}
	rootAgentSessionID := strings.TrimSpace(target.RootAgentSessionID)
	if strings.TrimSpace(target.Kind) != storesqlite.SessionKindChild {
		rootAgentSessionID = strings.TrimSpace(target.ID)
	}
	if rootAgentSessionID == "" {
		return runtimeControlRoute{}, ErrSessionNotFound
	}
	if _, err := h.EnsureRuntimeSession(ctx, SessionRef{WorkspaceID: workspaceID, AgentSessionID: rootAgentSessionID}); err != nil {
		return runtimeControlRoute{}, err
	}
	return runtimeControlRoute{RootAgentSessionID: rootAgentSessionID, TargetSession: target}, nil
}

func (h *Host) cancelTargetsForTurn(ctx context.Context, workspaceID string, route runtimeControlRoute, turnID string) ([]RuntimeCancelTarget, error) {
	targetSessionID := strings.TrimSpace(route.TargetSession.ID)
	targets := []RuntimeCancelTarget{{AgentSessionID: targetSessionID, TurnID: strings.TrimSpace(turnID)}}
	if strings.TrimSpace(route.TargetSession.Kind) == storesqlite.SessionKindChild {
		return targets, nil
	}
	children, err := h.store.ListChildSessions(ctx, workspaceID, targetSessionID)
	if err != nil {
		return nil, err
	}
	childTargets := make([]RuntimeCancelTarget, 0, len(children))
	for _, child := range children {
		if strings.TrimSpace(child.RootTurnID) != strings.TrimSpace(turnID) || strings.TrimSpace(child.ActiveTurnID) == "" {
			continue
		}
		childTargets = append(childTargets, RuntimeCancelTarget{AgentSessionID: strings.TrimSpace(child.ID), TurnID: strings.TrimSpace(child.ActiveTurnID)})
	}
	sort.Slice(childTargets, func(left, right int) bool {
		if childTargets[left].AgentSessionID == childTargets[right].AgentSessionID {
			return childTargets[left].TurnID < childTargets[right].TurnID
		}
		return childTargets[left].AgentSessionID < childTargets[right].AgentSessionID
	})
	return append(childTargets, targets...), nil
}
