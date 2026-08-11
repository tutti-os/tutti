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

// ObserveRuntimeGoalControlApplied completes one exact durable Goal operation
// from provider lifecycle evidence. Stale and duplicate observations are
// harmless; mismatched identities never mutate the current revision.
func (h *Host) ObserveRuntimeGoalControlApplied(ctx context.Context, input RuntimeGoalControlAppliedInput) error {
	workspaceID := strings.TrimSpace(input.WorkspaceID)
	agentSessionID := strings.TrimSpace(input.AgentSessionID)
	operationID := strings.TrimSpace(input.OperationID)
	action := strings.TrimSpace(input.Action)
	if h == nil || h.goals == nil || workspaceID == "" || agentSessionID == "" ||
		operationID == "" || input.GoalRevision <= 0 || action == "" {
		return ErrInvalidArgument
	}
	return h.withGoalActor(ctx, workspaceID, agentSessionID, func(actorCtx context.Context) error {
		state, found, err := h.goals.GetSessionGoalState(actorCtx, workspaceID, agentSessionID)
		if err != nil || !found {
			return err
		}
		operation, found, err := h.goals.GetGoalControlOperation(actorCtx, workspaceID, operationID)
		if err != nil || !found {
			return err
		}
		if state.Revision != input.GoalRevision || state.PendingOperationID != operationID ||
			operation.AgentSessionID != agentSessionID || operation.GoalRevision != input.GoalRevision ||
			operation.RepairEpoch != input.RepairEpoch || operation.Action != action {
			return nil
		}
		occurredAt := input.OccurredAtUnixMS
		if occurredAt <= 0 {
			occurredAt = h.goalOperationNow().UnixMilli()
		}
		_, _, _, err = h.goals.CompleteGoalControlOperation(actorCtx, storesqlite.GoalControlOperationComplete{
			WorkspaceID: workspaceID,
			OperationID: operationID,
			Succeeded:   true,
			Observed:    clonePayload(input.Observed),
			Evidence: map[string]any{
				"source":         "runtime_goal_control_lifecycle",
				"confidence":     "provider_lifecycle",
				"phase":          storesqlite.GoalProviderPhaseApplied,
				"operationId":    operationID,
				"revision":       input.GoalRevision,
				"repairEpoch":    input.RepairEpoch,
				"action":         action,
				"providerTurnId": strings.TrimSpace(input.ProviderTurnID),
			},
			OccurredAtUnixMS: occurredAt,
			RepairEpoch:      input.RepairEpoch,
			ExecutionPending: state.ExecutionPending || input.ExecutionPending,
		})
		return err
	})
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
