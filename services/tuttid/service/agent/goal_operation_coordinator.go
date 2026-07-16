package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

const (
	goalOperationWorkerInterval   = time.Second
	goalOperationBatchSize        = 64
	goalOperationLeaseDuration    = 2 * time.Minute
	goalOperationAttemptTimeout   = 20 * time.Second
	goalOperationRecoveryBudget   = 30 * time.Second
	goalAcceptedWaitDeadline      = 2 * time.Minute
	goalAcceptedMaxAttempts       = 24
	goalOperationMaxAttempts      = 24
	goalOperationDispatchDeadline = 10 * time.Minute
)

func (s *Service) StepGoalOperationWorker(ctx context.Context, recovering bool) error {
	if s.GoalStateStore == nil {
		return nil
	}
	operations, err := s.GoalStateStore.ListClaimableGoalControlOperations(ctx, agentactivitybiz.ListClaimableGoalControlOperationsInput{
		NowUnixMS: s.goalOperationNow().UnixMilli(), Limit: goalOperationBatchSize,
	})
	if err != nil {
		return err
	}
	var errs []error
	for _, operation := range operations {
		if ctx.Err() != nil {
			break
		}
		op := operation
		opCtx, cancel := context.WithTimeout(ctx, s.goalOperationAttemptTimeout())
		err := s.withGoalActor(opCtx, op.WorkspaceID, op.AgentSessionID, func(actorCtx context.Context) error {
			return s.recoverGoalOperation(actorCtx, op, recovering)
		})
		cancel()
		if err != nil && !errors.Is(err, ErrRuntimeOperationInProgress) {
			logGoalOperationWorkerError(op, recovering, err)
			errs = append(errs, fmt.Errorf("recover goal operation %s: %w", op.OperationID, err))
		}
	}
	return errors.Join(errs...)
}

func (s *Service) recoverGoalOperation(ctx context.Context, operation agentactivitybiz.GoalControlOperation, recovering bool) error {
	now := s.goalOperationNow()
	leased, claimed, err := s.GoalStateStore.ClaimGoalControlOperation(ctx, agentactivitybiz.ClaimGoalControlOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
		LeaseOwner: s.goalOperationOwner(), NowUnixMS: now.UnixMilli(),
		LeaseExpiresAtMS: now.Add(goalOperationLeaseDuration).UnixMilli(),
	})
	if err != nil || !claimed {
		if err != nil {
			return err
		}
		return ErrRuntimeOperationInProgress
	}
	state, found, err := s.GoalStateStore.GetSessionGoalState(ctx, leased.WorkspaceID, leased.AgentSessionID)
	if err != nil {
		return s.retryRecoveredGoalOperation(ctx, leased, err)
	}
	if !found || state.Revision != leased.GoalRevision || state.PendingOperationID != leased.OperationID {
		return s.failRecoveredGoalOperation(ctx, leased, "operation no longer owns desired revision")
	}
	// Delivery budget starts only once the operation crosses prepared ->
	// dispatched. A runtime that is unavailable before dispatch may leave an
	// intent pending, but it has not created provider-side ambiguity. Once
	// dispatched, every query/apply/retry consumes one immutable generation's
	// age/attempt budget and must eventually terminate.
	if leased.FirstDispatchedAtUnixMS > 0 &&
		(s.goalOperationNow().UnixMilli()-leased.FirstDispatchedAtUnixMS >= s.goalOperationDispatchDeadline().Milliseconds() ||
			leased.Attempt-leased.DispatchedAttempt >= s.goalOperationMaxAttempts()) {
		return s.failRecoveredGoalOperation(ctx, leased, "goal operation exceeded its delivery deadline")
	}
	_, err = s.ensureRuntimeSessionResult(ctx, leased.WorkspaceID, leased.AgentSessionID)
	if err != nil {
		return s.retryRecoveredGoalOperation(ctx, leased, err)
	}
	policy, err := resolveRuntimeGoalRecoveryPolicy(ctx, s.controller(), RuntimeGoalControlInput{WorkspaceID: leased.WorkspaceID, AgentSessionID: leased.AgentSessionID})
	if err != nil {
		return s.retryRecoveredGoalOperation(ctx, leased, err)
	}
	freshDispatch := false
	if leased.Status == "prepared" {
		if _, _, err := s.GoalStateStore.MarkGoalControlOperationDispatched(ctx, leased.WorkspaceID, leased.OperationID, s.goalOperationNow().UnixMilli()); err != nil {
			return s.retryRecoveredGoalOperation(ctx, leased, err)
		}
		current, found, err := s.GoalStateStore.GetGoalControlOperation(ctx, leased.WorkspaceID, leased.OperationID)
		if err != nil || !found {
			return err
		}
		leased = current
		freshDispatch = true
	}

	// Query-capable adapters can authoritatively prove that a crash-window
	// mutation already converged. This closes apply-before-complete without
	// replaying first.
	if policy.QuerySupported {
		if reconciler, ok := s.controller().(RuntimeGoalReconciler); ok {
			result, reconcileErr := reconciler.ReconcileGoal(ctx, RuntimeGoalControlInput{
				WorkspaceID: leased.WorkspaceID, AgentSessionID: leased.AgentSessionID, Action: "reconcile",
			})
			if reconcileErr == nil {
				evidence := clonePayload(result.Evidence)
				if evidence == nil {
					evidence = map[string]any{}
				}
				evidence["operationId"] = leased.OperationID
				evidence["revision"] = leased.GoalRevision
				evidence["repairEpoch"] = leased.RepairEpoch
				_, reconcileErr = s.GoalStateStore.ReconcileSessionGoalObservation(ctx, agentactivitybiz.GoalObservationReconcile{
					WorkspaceID: leased.WorkspaceID, AgentSessionID: leased.AgentSessionID,
					Observed: clonePayload(result.Goal), Evidence: evidence,
					OccurredAtUnixMS: s.goalOperationNow().UnixMilli(),
					Expected: &agentactivitybiz.GoalObservationFence{Exists: true, Revision: state.Revision,
						PendingOperationID: state.PendingOperationID, ObservedAtUnixMS: state.ObservedAtUnixMS},
				})
				if reconcileErr == nil {
					current, _, _ := s.GoalStateStore.GetGoalControlOperation(ctx, leased.WorkspaceID, leased.OperationID)
					if current.Status == "completed" {
						return nil
					}
				}
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return s.retryRecoveredGoalOperation(ctx, leased, err)
	}
	if leased.ProviderPhase == agentactivitybiz.GoalProviderPhaseApplied {
		evidence := clonePayload(leased.Evidence)
		if evidence == nil {
			evidence = map[string]any{}
		}
		evidence["phase"] = agentactivitybiz.GoalProviderPhaseApplied
		evidence["operationId"] = leased.OperationID
		evidence["revision"] = leased.GoalRevision
		evidence["repairEpoch"] = leased.RepairEpoch
		if _, err := s.GoalStateStore.ReconcileSessionGoalObservation(ctx, agentactivitybiz.GoalObservationReconcile{
			WorkspaceID: leased.WorkspaceID, AgentSessionID: leased.AgentSessionID,
			Observed: clonePayload(state.Observed), Evidence: evidence, OccurredAtUnixMS: s.goalOperationNow().UnixMilli(),
		}); err == nil {
			current, _, _ := s.GoalStateStore.GetGoalControlOperation(ctx, leased.WorkspaceID, leased.OperationID)
			if current.Status == "completed" {
				return nil
			}
		}
	}

	// An adapter may report that replaying set after restart can create duplicate
	// long-running work. In that policy only a fresh dispatch is safe; clear is
	// idempotent and remains repairable.
	if leased.ProviderPhase == agentactivitybiz.GoalProviderPhaseAccepted && leased.AcceptedAtUnixMS > 0 &&
		(s.goalOperationNow().UnixMilli()-leased.AcceptedAtUnixMS >= goalAcceptedWaitDeadline.Milliseconds() ||
			leased.Attempt-leased.AcceptedAttempt >= goalAcceptedMaxAttempts) {
		return s.failRecoveredGoalOperation(ctx, leased, "accepted goal operation exceeded its convergence deadline")
	}
	if !policy.ReplaySetAfterRestart && leased.Action != "clear" &&
		leased.ProviderPhase != agentactivitybiz.GoalProviderPhasePrepared && !freshDispatch {
		if !recovering {
			return s.deferGoalOperation(ctx, leased, 5*time.Second)
		}
		return s.failRecoveredGoalOperation(ctx, leased, "provider goal mutation cannot be safely replayed after restart")
	}
	result, err := s.controller().GoalControl(ctx, RuntimeGoalControlInput{
		WorkspaceID: leased.WorkspaceID, AgentSessionID: leased.AgentSessionID,
		Action: leased.Action, Objective: leased.Objective,
		OperationID: leased.OperationID, GoalRevision: leased.GoalRevision,
		RepairEpoch: leased.RepairEpoch, SubmissionMetadata: goalControlSubmissionMetadata(leased.ClientSubmitID),
	})
	if err != nil {
		return s.retryRecoveredGoalOperation(ctx, leased, err)
	}
	if result.ProviderPhase == "accepted" {
		_, _, _, err = s.GoalStateStore.AcknowledgeGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationAcknowledge{
			WorkspaceID: leased.WorkspaceID, OperationID: leased.OperationID,
			Evidence: clonePayload(result.Evidence), OccurredAtUnixMS: s.goalOperationNow().UnixMilli(),
			RepairEpoch: leased.RepairEpoch,
		})
		return err
	}
	_, _, _, err = s.GoalStateStore.CompleteGoalControlOperation(ctx, agentactivitybiz.GoalControlOperationComplete{
		WorkspaceID: leased.WorkspaceID, OperationID: leased.OperationID, Succeeded: true,
		Observed: clonePayload(result.Goal), Evidence: clonePayload(result.Evidence),
		OccurredAtUnixMS: s.goalOperationNow().UnixMilli(),
		RepairEpoch:      leased.RepairEpoch,
	})
	return err
}

func resolveRuntimeGoalRecoveryPolicy(ctx context.Context, controller RuntimeController, input RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error) {
	resolver, ok := controller.(RuntimeGoalRecoveryPolicyResolver)
	if !ok {
		// Unknown adapters are conservative: no authoritative query and no
		// replay of a possibly-applied set across a crash boundary.
		return RuntimeGoalRecoveryPolicy{}, nil
	}
	return resolver.GoalRecoveryPolicy(ctx, input)
}

func (s *Service) deferGoalOperation(ctx context.Context, op agentactivitybiz.GoalControlOperation, delay time.Duration) error {
	now := s.goalOperationNow()
	_, _, err := s.GoalStateStore.ReleaseGoalControlOperation(ctx, agentactivitybiz.ReleaseGoalControlOperationInput{
		WorkspaceID: op.WorkspaceID, OperationID: op.OperationID, LeaseOwner: s.goalOperationOwner(),
		ProviderPhase: op.ProviderPhase, Evidence: clonePayload(op.Evidence),
		NowUnixMS: now.UnixMilli(), NextAttemptAtMS: now.Add(delay).UnixMilli(),
		RepairEpoch: op.RepairEpoch,
	})
	return err
}

func (s *Service) retryRecoveredGoalOperation(ctx context.Context, op agentactivitybiz.GoalControlOperation, cause error) error {
	persistCtx := ctx
	cancel := func() {}
	if ctx.Err() != nil {
		persistCtx, cancel = goalPersistenceContext()
	}
	defer cancel()
	if current, found, err := s.GoalStateStore.GetGoalControlOperation(persistCtx, op.WorkspaceID, op.OperationID); err == nil && found {
		op = current
	}
	now := s.goalOperationNow()
	fail := !isRetryableRuntimeOperationError(cause)
	_, _, err := s.GoalStateStore.ReleaseGoalControlOperation(persistCtx, agentactivitybiz.ReleaseGoalControlOperationInput{
		WorkspaceID: op.WorkspaceID, OperationID: op.OperationID, LeaseOwner: s.goalOperationOwner(),
		ProviderPhase: op.ProviderPhase, Evidence: clonePayload(op.Evidence), LastError: cause.Error(), NowUnixMS: now.UnixMilli(),
		NextAttemptAtMS: runtimeOperationNextAttemptAt(now, op.Attempt, fail), Fail: fail,
		RepairEpoch: op.RepairEpoch,
	})
	return err
}

func logGoalOperationWorkerError(op agentactivitybiz.GoalControlOperation, recovering bool, err error) {
	slog.Error("agent goal operation worker failed",
		"event", "agent_goal_operation.worker_failed",
		"workspaceId", op.WorkspaceID,
		"agentSessionId", op.AgentSessionID,
		"operationId", op.OperationID,
		"goalRevision", op.GoalRevision,
		"action", op.Action,
		"status", op.Status,
		"providerPhase", op.ProviderPhase,
		"attempt", op.Attempt,
		"recovering", recovering,
		"error", err.Error(),
	)
}

func (s *Service) failRecoveredGoalOperation(ctx context.Context, op agentactivitybiz.GoalControlOperation, reason string) error {
	now := s.goalOperationNow()
	_, _, err := s.GoalStateStore.ReleaseGoalControlOperation(ctx, agentactivitybiz.ReleaseGoalControlOperationInput{
		WorkspaceID: op.WorkspaceID, OperationID: op.OperationID, LeaseOwner: s.goalOperationOwner(),
		ProviderPhase: op.ProviderPhase, Evidence: clonePayload(op.Evidence), LastError: reason, NowUnixMS: now.UnixMilli(), Fail: true,
		RepairEpoch: op.RepairEpoch,
	})
	return err
}

func (s *Service) goalOperationAttemptTimeout() time.Duration {
	if s.GoalOperationAttemptTimeout > 0 && s.GoalOperationAttemptTimeout < goalOperationLeaseDuration {
		return s.GoalOperationAttemptTimeout
	}
	return goalOperationAttemptTimeout
}

func (s *Service) RecoverGoalOperations(ctx context.Context) error {
	if s.GoalStateStore == nil {
		return nil
	}
	recoveryCtx, cancel := context.WithTimeout(ctx, s.goalOperationRecoveryBudget())
	defer cancel()
	if _, err := s.GoalStateStore.RequeueLeasedGoalControlOperationsOnStartup(recoveryCtx, s.goalOperationNow().UnixMilli()); err != nil {
		return err
	}
	for {
		if recoveryCtx.Err() != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return nil
		}
		if err := s.StepGoalOperationWorker(recoveryCtx, true); err != nil {
			if recoveryCtx.Err() != nil && ctx.Err() == nil {
				return nil
			}
			return err
		}
		remaining, err := s.GoalStateStore.ListClaimableGoalControlOperations(recoveryCtx, agentactivitybiz.ListClaimableGoalControlOperationsInput{
			NowUnixMS: s.goalOperationNow().UnixMilli(), Limit: 1,
		})
		if err != nil && recoveryCtx.Err() != nil && ctx.Err() == nil {
			return nil
		}
		if err != nil || len(remaining) == 0 {
			return err
		}
	}
}

func (s *Service) goalOperationRecoveryBudget() time.Duration {
	if s.GoalOperationRecoveryBudget > 0 {
		return s.GoalOperationRecoveryBudget
	}
	return goalOperationRecoveryBudget
}

func (s *Service) goalOperationMaxAttempts() int {
	if s.GoalOperationMaxAttempts > 0 {
		return s.GoalOperationMaxAttempts
	}
	return goalOperationMaxAttempts
}

func (s *Service) goalOperationDispatchDeadline() time.Duration {
	if s.GoalOperationDispatchDeadline > 0 {
		return s.GoalOperationDispatchDeadline
	}
	return goalOperationDispatchDeadline
}

func (s *Service) RunGoalOperationWorker(ctx context.Context) {
	ticker := time.NewTicker(goalOperationWorkerInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.StepGoalOperationWorker(ctx, false); err != nil {
				slog.Error("agent goal operation worker step failed", "event", "agent_goal_operation.worker_step_failed", "error", err.Error())
			}
		}
	}
}
