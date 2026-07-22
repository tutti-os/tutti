package agenthost

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
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

func (h *Host) StepGoalOperationWorker(ctx context.Context, recovering bool) error {
	if h.goals == nil {
		return nil
	}
	if h.goalRuntime == nil {
		return ErrGoalConsumerUnavailable
	}
	operations, err := h.goals.ListClaimableGoalControlOperations(ctx, storesqlite.ListClaimableGoalControlOperationsInput{
		NowUnixMS: h.goalOperationNow().UnixMilli(), Limit: goalOperationBatchSize,
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
		opCtx, cancel := context.WithTimeout(ctx, h.goalOperationAttemptTimeout())
		err := h.withSessionMutationActor(opCtx, op.WorkspaceID, op.AgentSessionID, func(commandCtx context.Context) error {
			return h.withGoalActor(commandCtx, op.WorkspaceID, op.AgentSessionID, func(actorCtx context.Context) error {
				return h.recoverGoalOperation(actorCtx, op, recovering)
			})
		})
		cancel()
		if err != nil && !errors.Is(err, ErrRuntimeOperationInProgress) {
			logGoalOperationWorkerError(op, recovering, err)
			errs = append(errs, fmt.Errorf("recover goal operation %s: %w", op.OperationID, err))
		}
	}
	return errors.Join(errs...)
}

func (h *Host) recoverGoalOperation(ctx context.Context, operation storesqlite.GoalControlOperation, recovering bool) error {
	now := h.goalOperationNow()
	leased, claimed, err := h.goals.ClaimGoalControlOperation(ctx, storesqlite.ClaimGoalControlOperationInput{
		WorkspaceID: operation.WorkspaceID, OperationID: operation.OperationID,
		LeaseOwner: h.goalOperationOwner(), NowUnixMS: now.UnixMilli(),
		LeaseExpiresAtMS: now.Add(goalOperationLeaseDuration).UnixMilli(),
	})
	if err != nil || !claimed {
		if err != nil {
			return err
		}
		return ErrRuntimeOperationInProgress
	}
	state, found, err := h.goals.GetSessionGoalState(ctx, leased.WorkspaceID, leased.AgentSessionID)
	if err != nil {
		return h.retryRecoveredGoalOperation(ctx, leased, err)
	}
	if !found || state.Revision != leased.GoalRevision || state.PendingOperationID != leased.OperationID {
		return h.failRecoveredGoalOperation(ctx, leased, "operation no longer owns desired revision")
	}
	// Delivery budget starts only once the operation crosses prepared ->
	// dispatched. A runtime that is unavailable before dispatch may leave an
	// intent pending, but it has not created provider-side ambiguity. Once
	// dispatched, every query/apply/retry consumes one immutable generation's
	// age/attempt budget and must eventually terminate.
	if leased.FirstDispatchedAtUnixMS > 0 &&
		(h.goalOperationNow().UnixMilli()-leased.FirstDispatchedAtUnixMS >= h.goalOperationDispatchDeadline().Milliseconds() ||
			leased.Attempt-leased.DispatchedAttempt >= h.goalOperationMaxAttempts()) {
		return h.failRecoveredGoalOperation(ctx, leased, "goal operation exceeded its delivery deadline")
	}
	_, err = h.EnsureRuntimeSession(ctx, SessionRef{WorkspaceID: leased.WorkspaceID, AgentSessionID: leased.AgentSessionID})
	if err != nil {
		return h.retryRecoveredGoalOperation(ctx, leased, err)
	}
	policy, err := ResolveRuntimeGoalRecoveryPolicy(ctx, h.goalRuntime, RuntimeGoalControlInput{WorkspaceID: leased.WorkspaceID, AgentSessionID: leased.AgentSessionID})
	if err != nil {
		return h.retryRecoveredGoalOperation(ctx, leased, err)
	}
	freshDispatch := false
	if leased.Status == "prepared" {
		if _, _, err := h.goals.MarkGoalControlOperationDispatched(ctx, leased.WorkspaceID, leased.OperationID, h.goalOperationNow().UnixMilli()); err != nil {
			return h.retryRecoveredGoalOperation(ctx, leased, err)
		}
		current, found, err := h.goals.GetGoalControlOperation(ctx, leased.WorkspaceID, leased.OperationID)
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
		if reconciler, ok := h.goalRuntime.(GoalRuntimeReconciler); ok {
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
				_, reconcileErr = h.goals.ReconcileSessionGoalObservation(ctx, storesqlite.GoalObservationReconcile{
					WorkspaceID: leased.WorkspaceID, AgentSessionID: leased.AgentSessionID,
					Observed: clonePayload(result.Goal), Evidence: evidence,
					OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
					Expected: &storesqlite.GoalObservationFence{Exists: true, Revision: state.Revision,
						PendingOperationID: state.PendingOperationID, ObservedAtUnixMS: state.ObservedAtUnixMS},
				})
				if reconcileErr == nil {
					current, _, _ := h.goals.GetGoalControlOperation(ctx, leased.WorkspaceID, leased.OperationID)
					if current.Status == "completed" {
						return nil
					}
				}
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return h.retryRecoveredGoalOperation(ctx, leased, err)
	}
	if leased.ProviderPhase == storesqlite.GoalProviderPhaseApplied {
		evidence := clonePayload(leased.Evidence)
		if evidence == nil {
			evidence = map[string]any{}
		}
		evidence["phase"] = storesqlite.GoalProviderPhaseApplied
		evidence["operationId"] = leased.OperationID
		evidence["revision"] = leased.GoalRevision
		evidence["repairEpoch"] = leased.RepairEpoch
		if _, err := h.goals.ReconcileSessionGoalObservation(ctx, storesqlite.GoalObservationReconcile{
			WorkspaceID: leased.WorkspaceID, AgentSessionID: leased.AgentSessionID,
			Observed: clonePayload(state.Observed), Evidence: evidence, OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
		}); err == nil {
			current, _, _ := h.goals.GetGoalControlOperation(ctx, leased.WorkspaceID, leased.OperationID)
			if current.Status == "completed" {
				return nil
			}
		}
	}

	// Provider acceptance proves delivery, so the steady-state worker must wait
	// for applied evidence instead of submitting the same mutation again. The
	// accepted deadline above still bounds a lost lifecycle event. Startup
	// recovery is different: a query-incapable adapter may need one replay to
	// resolve the crash window, subject to its recovery policy below.
	if leased.ProviderPhase == storesqlite.GoalProviderPhaseAccepted && leased.AcceptedAtUnixMS > 0 &&
		(h.goalOperationNow().UnixMilli()-leased.AcceptedAtUnixMS >= goalAcceptedWaitDeadline.Milliseconds() ||
			leased.Attempt-leased.AcceptedAttempt >= goalAcceptedMaxAttempts) {
		return h.failRecoveredGoalOperation(ctx, leased, "accepted goal operation exceeded its convergence deadline")
	}
	if leased.ProviderPhase == storesqlite.GoalProviderPhaseAccepted && !freshDispatch && !recovering {
		return h.deferGoalOperation(ctx, leased, 5*time.Second)
	}
	// An adapter may report that replaying set after restart can create duplicate
	// long-running work. In that policy only a fresh dispatch is safe; clear is
	// idempotent and remains repairable during startup recovery.
	if !policy.ReplaySetAfterRestart && leased.Action != "clear" &&
		leased.ProviderPhase != storesqlite.GoalProviderPhasePrepared && !freshDispatch {
		if !recovering {
			return h.deferGoalOperation(ctx, leased, 5*time.Second)
		}
		return h.failRecoveredGoalOperation(ctx, leased, "provider goal mutation cannot be safely replayed after restart")
	}
	result, err := h.goalRuntime.GoalControl(ctx, RuntimeGoalControlInput{
		WorkspaceID: leased.WorkspaceID, AgentSessionID: leased.AgentSessionID,
		Action: leased.Action, Objective: leased.Objective,
		OperationID: leased.OperationID, GoalRevision: leased.GoalRevision,
		RepairEpoch: leased.RepairEpoch, SubmissionMetadata: goalControlSubmissionMetadata(leased.ClientSubmitID),
	})
	if err != nil {
		return h.retryRecoveredGoalOperation(ctx, leased, err)
	}
	if result.ProviderPhase == "accepted" {
		_, _, _, err = h.goals.AcknowledgeGoalControlOperation(ctx, storesqlite.GoalControlOperationAcknowledge{
			WorkspaceID: leased.WorkspaceID, OperationID: leased.OperationID,
			Evidence: clonePayload(result.Evidence), OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
			RepairEpoch: leased.RepairEpoch,
		})
		return err
	}
	_, _, _, err = h.goals.CompleteGoalControlOperation(ctx, storesqlite.GoalControlOperationComplete{
		WorkspaceID: leased.WorkspaceID, OperationID: leased.OperationID, Succeeded: true,
		Observed: clonePayload(result.Goal), Evidence: clonePayload(result.Evidence),
		OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
		RepairEpoch:      leased.RepairEpoch,
	})
	return err
}

func ResolveRuntimeGoalRecoveryPolicy(ctx context.Context, controller GoalRuntimeController, input RuntimeGoalControlInput) (RuntimeGoalRecoveryPolicy, error) {
	resolver, ok := controller.(GoalRuntimeRecoveryPolicyResolver)
	if !ok {
		return RuntimeGoalRecoveryPolicy{}, nil
	}
	return resolver.GoalRecoveryPolicy(ctx, input)
}

func (h *Host) deferGoalOperation(ctx context.Context, op storesqlite.GoalControlOperation, delay time.Duration) error {
	now := h.goalOperationNow()
	_, _, err := h.goals.ReleaseGoalControlOperation(ctx, storesqlite.ReleaseGoalControlOperationInput{
		WorkspaceID: op.WorkspaceID, OperationID: op.OperationID, LeaseOwner: h.goalOperationOwner(),
		ProviderPhase: op.ProviderPhase, Evidence: clonePayload(op.Evidence),
		NowUnixMS: now.UnixMilli(), NextAttemptAtMS: now.Add(delay).UnixMilli(),
		RepairEpoch: op.RepairEpoch,
	})
	return err
}

func (h *Host) retryRecoveredGoalOperation(ctx context.Context, op storesqlite.GoalControlOperation, cause error) error {
	persistCtx := ctx
	cancel := func() {}
	if ctx.Err() != nil {
		persistCtx, cancel = goalPersistenceContext()
	}
	defer cancel()
	if current, found, err := h.goals.GetGoalControlOperation(persistCtx, op.WorkspaceID, op.OperationID); err == nil && found {
		op = current
	}
	now := h.goalOperationNow()
	fail := !isRetryableRuntimeOperationError(cause)
	_, _, err := h.goals.ReleaseGoalControlOperation(persistCtx, storesqlite.ReleaseGoalControlOperationInput{
		WorkspaceID: op.WorkspaceID, OperationID: op.OperationID, LeaseOwner: h.goalOperationOwner(),
		ProviderPhase: op.ProviderPhase, Evidence: clonePayload(op.Evidence), LastError: cause.Error(), NowUnixMS: now.UnixMilli(),
		NextAttemptAtMS: runtimeOperationNextAttemptAt(now, op.Attempt, fail), Fail: fail,
		RepairEpoch: op.RepairEpoch,
	})
	return err
}

func logGoalOperationWorkerError(op storesqlite.GoalControlOperation, recovering bool, err error) {
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

func (h *Host) failRecoveredGoalOperation(ctx context.Context, op storesqlite.GoalControlOperation, reason string) error {
	now := h.goalOperationNow()
	_, _, err := h.goals.ReleaseGoalControlOperation(ctx, storesqlite.ReleaseGoalControlOperationInput{
		WorkspaceID: op.WorkspaceID, OperationID: op.OperationID, LeaseOwner: h.goalOperationOwner(),
		ProviderPhase: op.ProviderPhase, Evidence: clonePayload(op.Evidence), LastError: reason, NowUnixMS: now.UnixMilli(), Fail: true,
		RepairEpoch: op.RepairEpoch,
	})
	return err
}

func (h *Host) goalOperationAttemptTimeout() time.Duration {
	if h.goalAttemptTimeout > 0 && h.goalAttemptTimeout < goalOperationLeaseDuration {
		return h.goalAttemptTimeout
	}
	return goalOperationAttemptTimeout
}

func (h *Host) RecoverGoalOperations(ctx context.Context) error {
	if h.goals == nil {
		return nil
	}
	recoveryCtx, cancel := context.WithTimeout(ctx, h.goalOperationRecoveryBudget())
	defer cancel()
	if _, err := h.goals.RequeueLeasedGoalControlOperationsOnStartup(recoveryCtx, h.goalOperationNow().UnixMilli()); err != nil {
		return err
	}
	for {
		if recoveryCtx.Err() != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			return nil
		}
		if err := h.StepGoalOperationWorker(recoveryCtx, true); err != nil {
			if recoveryCtx.Err() != nil && ctx.Err() == nil {
				return nil
			}
			return err
		}
		remaining, err := h.goals.ListClaimableGoalControlOperations(recoveryCtx, storesqlite.ListClaimableGoalControlOperationsInput{
			NowUnixMS: h.goalOperationNow().UnixMilli(), Limit: 1,
		})
		if err != nil && recoveryCtx.Err() != nil && ctx.Err() == nil {
			return nil
		}
		if err != nil || len(remaining) == 0 {
			return err
		}
	}
}

func (h *Host) goalOperationRecoveryBudget() time.Duration {
	if h.goalRecoveryBudget > 0 {
		return h.goalRecoveryBudget
	}
	return goalOperationRecoveryBudget
}

func (h *Host) goalOperationMaxAttempts() int {
	if h.goalMaxAttempts > 0 {
		return h.goalMaxAttempts
	}
	return goalOperationMaxAttempts
}

func (h *Host) goalOperationDispatchDeadline() time.Duration {
	if h.goalDispatchDeadline > 0 {
		return h.goalDispatchDeadline
	}
	return goalOperationDispatchDeadline
}

func (h *Host) RunGoalOperationWorker(ctx context.Context) {
	_ = h.runGoalOperationWorker(ctx)
}

func (h *Host) runGoalOperationWorker(ctx context.Context) error {
	ticker := time.NewTicker(goalOperationWorkerInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := h.StepGoalOperationWorker(ctx, false); err != nil {
				slog.Error("agent goal operation worker step failed", "event", "agent_goal_operation.worker_step_failed", "error", err.Error())
			}
		}
	}
}
