package agenthost

import (
	"context"
	"errors"
	"strings"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func (h *Host) GetGoalState(ctx context.Context, ref SessionRef) (GoalStateResult, error) {
	workspaceID, agentSessionID := strings.TrimSpace(ref.WorkspaceID), strings.TrimSpace(ref.AgentSessionID)
	if h == nil || h.store == nil || workspaceID == "" || agentSessionID == "" {
		return GoalStateResult{}, ErrInvalidArgument
	}
	canonical, found, err := h.store.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return GoalStateResult{}, err
	}
	if !found {
		return GoalStateResult{}, ErrSessionNotFound
	}
	if h.goals == nil {
		return GoalStateResult{Canonical: canonical}, nil
	}
	state, found, err := h.goals.GetSessionGoalState(ctx, workspaceID, agentSessionID)
	if err != nil {
		return GoalStateResult{}, err
	}
	if !found {
		return GoalStateResult{Canonical: canonical}, nil
	}
	return GoalStateResult{Canonical: canonical, State: state}, nil
}

func (h *Host) ReconcileGoal(ctx context.Context, ref SessionRef) (GoalStateResult, error) {
	workspaceID, agentSessionID := strings.TrimSpace(ref.WorkspaceID), strings.TrimSpace(ref.AgentSessionID)
	if h == nil || h.store == nil || h.runtime == nil || h.goalRuntime == nil || workspaceID == "" || agentSessionID == "" {
		return GoalStateResult{}, ErrInvalidArgument
	}
	var result GoalStateResult
	err := h.withSessionMutationActor(ctx, workspaceID, agentSessionID, func(commandCtx context.Context) error {
		return h.withGoalActor(commandCtx, workspaceID, agentSessionID, func(actorCtx context.Context) error {
			var reconcileErr error
			result, reconcileErr = h.reconcileGoalLocked(actorCtx, workspaceID, agentSessionID)
			return reconcileErr
		})
	})
	return result, err
}

func (h *Host) reconcileGoalLocked(ctx context.Context, workspaceID, agentSessionID string) (GoalStateResult, error) {
	if _, err := h.EnsureRuntimeSession(ctx, SessionRef{WorkspaceID: workspaceID, AgentSessionID: agentSessionID}); err != nil {
		return GoalStateResult{}, err
	}
	reconciler, ok := h.goalRuntime.(GoalRuntimeReconciler)
	if !ok {
		return GoalStateResult{}, errors.New("agent runtime goal reconciliation is unavailable")
	}
	if h.goals == nil {
		rpcCtx, cancel := context.WithTimeout(ctx, h.goalOperationAttemptTimeout())
		_, err := reconciler.ReconcileGoal(rpcCtx, RuntimeGoalControlInput{
			WorkspaceID: workspaceID, AgentSessionID: agentSessionID, Action: "reconcile",
		})
		cancel()
		if err != nil {
			return GoalStateResult{}, err
		}
		canonical, found, getErr := h.store.GetSession(ctx, workspaceID, agentSessionID)
		if getErr == nil && !found {
			getErr = ErrSessionNotFound
		}
		return GoalStateResult{Canonical: canonical}, getErr
	}
	var state storesqlite.SessionGoalState
	for attempt := 0; attempt < 3; attempt++ {
		before, found, err := h.goals.GetSessionGoalState(ctx, workspaceID, agentSessionID)
		if err != nil {
			return GoalStateResult{}, err
		}
		expected := &storesqlite.GoalObservationFence{Exists: found}
		if found {
			*expected = storesqlite.GoalObservationFence{
				Exists:   true,
				Revision: before.Revision, PendingOperationID: before.PendingOperationID,
				ObservedAtUnixMS: before.ObservedAtUnixMS,
			}
		}
		rpcCtx, cancel := context.WithTimeout(ctx, h.goalOperationAttemptTimeout())
		providerResult, err := reconciler.ReconcileGoal(rpcCtx, RuntimeGoalControlInput{
			WorkspaceID: workspaceID, AgentSessionID: agentSessionID, Action: "reconcile",
		})
		cancel()
		if err != nil {
			return GoalStateResult{}, err
		}
		state, err = h.goals.ReconcileSessionGoalObservation(ctx, storesqlite.GoalObservationReconcile{
			WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
			Observed: clonePayload(providerResult.Goal), Evidence: clonePayload(providerResult.Evidence),
			OccurredAtUnixMS: h.goalOperationNow().UnixMilli(), Expected: expected,
		})
		if err == nil {
			break
		}
		if !errors.Is(err, storesqlite.ErrGoalReconcileConflict) || attempt == 2 {
			return GoalStateResult{}, err
		}
	}
	canonical, found, err := h.store.GetSession(ctx, workspaceID, agentSessionID)
	if err != nil {
		return GoalStateResult{}, err
	}
	if !found {
		return GoalStateResult{}, ErrSessionNotFound
	}
	return GoalStateResult{Canonical: canonical, State: state}, nil
}
