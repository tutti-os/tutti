package agent

import (
	"context"
	"errors"
	"strings"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

type GoalStateSessionResult struct {
	Session Session
	State   agentactivitybiz.SessionGoalState
}

func (s *Service) GetGoalState(ctx context.Context, workspaceID, agentSessionID string) (GoalStateSessionResult, error) {
	workspaceID, agentSessionID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID)
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return GoalStateSessionResult{}, err
	}
	if s.GoalStateStore == nil {
		return GoalStateSessionResult{Session: session}, nil
	}
	state, found, err := s.GoalStateStore.GetSessionGoalState(ctx, workspaceID, agentSessionID)
	if err != nil {
		return GoalStateSessionResult{}, err
	}
	if !found {
		// Observation reconciliation bootstraps the projection without changing
		// desired revision. An absent provider observation remains unknown.
		state, err = s.GoalStateStore.ReconcileSessionGoalObservation(ctx, agentactivitybiz.GoalObservationReconcile{
			WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
			Evidence:         map[string]any{"source": "upper_read_bootstrap", "confidence": "unknown"},
			OccurredAtUnixMS: time.Now().UTC().UnixMilli(),
			Expected:         &agentactivitybiz.GoalObservationFence{Exists: false},
			ForceSyncUnknown: true,
		})
		if errors.Is(err, agentactivitybiz.ErrGoalReconcileConflict) {
			state, found, err = s.GoalStateStore.GetSessionGoalState(ctx, workspaceID, agentSessionID)
			if err == nil && !found {
				err = agentactivitybiz.ErrGoalReconcileConflict
			}
		}
		if err != nil {
			return GoalStateSessionResult{}, err
		}
	}
	return GoalStateSessionResult{Session: session, State: state}, nil
}

func (s *Service) ReconcileGoal(ctx context.Context, workspaceID, agentSessionID string) (GoalStateSessionResult, error) {
	workspaceID, agentSessionID = strings.TrimSpace(workspaceID), strings.TrimSpace(agentSessionID)
	var result GoalStateSessionResult
	err := s.withGoalActor(ctx, workspaceID, agentSessionID, func(actorCtx context.Context) error {
		var reconcileErr error
		result, reconcileErr = s.reconcileGoalLocked(actorCtx, workspaceID, agentSessionID)
		return reconcileErr
	})
	return result, err
}

func (s *Service) reconcileGoalLocked(ctx context.Context, workspaceID, agentSessionID string) (GoalStateSessionResult, error) {
	if _, err := s.ensureRuntimeSessionResult(ctx, workspaceID, agentSessionID); err != nil {
		return GoalStateSessionResult{}, err
	}
	reconciler, ok := s.controller().(RuntimeGoalReconciler)
	if !ok {
		return GoalStateSessionResult{}, errors.New("agent runtime goal reconciliation is unavailable")
	}
	if s.GoalStateStore == nil {
		rpcCtx, cancel := context.WithTimeout(ctx, s.goalOperationAttemptTimeout())
		_, err := reconciler.ReconcileGoal(rpcCtx, RuntimeGoalControlInput{
			WorkspaceID: workspaceID, AgentSessionID: agentSessionID, Action: "reconcile",
		})
		cancel()
		if err != nil {
			return GoalStateSessionResult{}, normalizeRuntimeError(err)
		}
		session, getErr := s.Get(ctx, workspaceID, agentSessionID)
		return GoalStateSessionResult{Session: session}, getErr
	}
	var state agentactivitybiz.SessionGoalState
	for attempt := 0; attempt < 3; attempt++ {
		before, found, err := s.GoalStateStore.GetSessionGoalState(ctx, workspaceID, agentSessionID)
		if err != nil {
			return GoalStateSessionResult{}, err
		}
		expected := &agentactivitybiz.GoalObservationFence{Exists: found}
		if found {
			*expected = agentactivitybiz.GoalObservationFence{
				Exists:   true,
				Revision: before.Revision, PendingOperationID: before.PendingOperationID,
				ObservedAtUnixMS: before.ObservedAtUnixMS,
			}
		}
		rpcCtx, cancel := context.WithTimeout(ctx, s.goalOperationAttemptTimeout())
		providerResult, err := reconciler.ReconcileGoal(rpcCtx, RuntimeGoalControlInput{
			WorkspaceID: workspaceID, AgentSessionID: agentSessionID, Action: "reconcile",
		})
		cancel()
		if err != nil {
			return GoalStateSessionResult{}, normalizeRuntimeError(err)
		}
		state, err = s.GoalStateStore.ReconcileSessionGoalObservation(ctx, agentactivitybiz.GoalObservationReconcile{
			WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
			Observed: clonePayload(providerResult.Goal), Evidence: clonePayload(providerResult.Evidence),
			OccurredAtUnixMS: s.goalOperationNow().UnixMilli(), Expected: expected,
		})
		if err == nil {
			break
		}
		if !errors.Is(err, agentactivitybiz.ErrGoalReconcileConflict) || attempt == 2 {
			return GoalStateSessionResult{}, err
		}
	}
	session, err := s.Get(ctx, workspaceID, agentSessionID)
	if err != nil {
		return GoalStateSessionResult{}, err
	}
	return GoalStateSessionResult{Session: session, State: state}, nil
}
