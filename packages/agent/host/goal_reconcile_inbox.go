package agenthost

import (
	"context"
	"errors"
	"time"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

const (
	goalReconcileInboxLease       = 5 * time.Minute
	goalReconcileInboxMaxAttempts = 24
)

func (h *Host) StepGoalReconcileInboxWorker(ctx context.Context) error {
	if h.goalInbox == nil {
		if h != nil && h.goals != nil {
			return ErrGoalConsumerUnavailable
		}
		return nil
	}
	if h.goals == nil || h.goalRuntime == nil {
		return ErrGoalConsumerUnavailable
	}
	items, err := h.goalInbox.ListClaimableGoalReconcileInbox(ctx, h.goalOperationNow().UnixMilli(), 64)
	if err != nil {
		return err
	}
	var errs []error
	for _, candidate := range items {
		claimNow := h.goalOperationNow()
		item, claimed, claimErr := h.goalInbox.ClaimGoalReconcileInbox(ctx, storesqlite.ClaimGoalReconcileInboxInput{
			RequestID: candidate.RequestID, LeaseOwner: h.goalOperationOwner(), NowUnixMS: claimNow.UnixMilli(), LeaseExpiresAtMS: claimNow.Add(goalReconcileInboxLease).UnixMilli(),
		})
		if claimErr != nil {
			errs = append(errs, claimErr)
			continue
		}
		if !claimed {
			continue
		}
		if item.PayloadError != "" {
			cause := errors.New(item.PayloadError)
			finishNow := h.goalOperationNow()
			fail := false
			if escalateErr := h.escalateGoalReconcileInboxTerminal(ctx, item, cause); escalateErr == nil {
				fail = true
			} else {
				cause = errors.Join(cause, escalateErr)
			}
			if _, releaseErr := h.goalInbox.ReleaseGoalReconcileInbox(ctx, storesqlite.ReleaseGoalReconcileInboxInput{RequestID: item.RequestID, LeaseOwner: h.goalOperationOwner(), NowUnixMS: finishNow.UnixMilli(), NextAttemptAtMS: finishNow.Add(time.Second).UnixMilli(), LastError: cause.Error(), Fail: fail}); releaseErr != nil {
				errs = append(errs, releaseErr)
			}
			continue
		}
		input := GoalReconcileRequiredInput{
			WorkspaceID: item.WorkspaceID, AgentSessionID: item.AgentSessionID, RequestID: item.RequestID,
			ProviderTurnID: metadataString(item.Payload, "providerTurnId"), Reason: metadataString(item.Payload, "reason"),
			FenceMode: metadataString(item.Payload, "fenceMode"), ExpectedOperationID: metadataString(item.Payload, "expectedOperationId"),
			ExpectedRevision: metadataInt64(item.Payload, "expectedRevision"), ExpectedRepairEpoch: metadataInt64(item.Payload, "expectedRepairEpoch"),
			QuiesceSucceeded: metadataBool(item.Payload, "quiesceSucceeded"), QuiesceError: metadataString(item.Payload, "quiesceError"),
		}
		if metadataString(item.Payload, "phase") == "quiesce_pending" {
			// The prepare record outlived its finalize grace. We cannot know
			// whether the process died before or after exact interrupt, so the
			// only safe durable conclusion is failed/unknown quiescence.
			input.QuiesceSucceeded = false
			input.QuiesceError = "goal reconcile quiesce finalize deadline exceeded"
		}
		handleErr := h.ReconcileGoalFromEvidence(ctx, input)
		finishNow := h.goalOperationNow()
		if handleErr == nil {
			if _, completeErr := h.goalInbox.CompleteGoalReconcileInbox(ctx, item.RequestID, h.goalOperationOwner(), finishNow.UnixMilli()); completeErr != nil {
				errs = append(errs, completeErr)
			}
			continue
		}
		fail := false
		if item.Attempt >= goalReconcileInboxMaxAttempts {
			if escalateErr := h.escalateGoalReconcileInboxTerminal(ctx, item, handleErr); escalateErr == nil {
				fail = true
			} else {
				handleErr = errors.Join(handleErr, escalateErr)
			}
		}
		_, releaseErr := h.goalInbox.ReleaseGoalReconcileInbox(ctx, storesqlite.ReleaseGoalReconcileInboxInput{
			RequestID: item.RequestID, LeaseOwner: h.goalOperationOwner(), NowUnixMS: finishNow.UnixMilli(), NextAttemptAtMS: finishNow.Add(time.Second).UnixMilli(), LastError: handleErr.Error(), Fail: fail,
		})
		if releaseErr != nil {
			errs = append(errs, releaseErr)
		}
	}
	return errors.Join(errs...)
}

func (h *Host) escalateGoalReconcileInboxTerminal(ctx context.Context, item storesqlite.GoalReconcileInboxItem, cause error) error {
	if h.goals == nil {
		return errors.New("goal reconcile inbox terminal escalation store is unavailable")
	}
	return h.withSessionMutationActor(ctx, item.WorkspaceID, item.AgentSessionID, func(actorCtx context.Context) error {
		return h.escalateGoalReconcileInboxTerminalSerialized(actorCtx, item, cause)
	})
}

func (h *Host) escalateGoalReconcileInboxTerminalSerialized(ctx context.Context, item storesqlite.GoalReconcileInboxItem, cause error) error {
	return h.withGoalActor(ctx, item.WorkspaceID, item.AgentSessionID, func(actorCtx context.Context) error {
		for attempt := 0; attempt < 3; attempt++ {
			state, found, err := h.goals.GetSessionGoalState(actorCtx, item.WorkspaceID, item.AgentSessionID)
			if err != nil {
				return err
			}
			if !found {
				return errors.New("goal reconcile inbox terminal escalation state is unavailable")
			}
			if state.Revision == 0 {
				_, err = h.goals.ReconcileSessionGoalObservation(actorCtx, storesqlite.GoalObservationReconcile{
					WorkspaceID: item.WorkspaceID, AgentSessionID: item.AgentSessionID,
					Observed:  clonePayload(state.Observed),
					Evidence:  map[string]any{"source": "goal_reconcile_inbox_terminal", "requestId": item.RequestID, "confidence": "unknown"},
					LastError: cause.Error(), OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
					Expected:         &storesqlite.GoalObservationFence{Exists: true, Revision: 0, PendingOperationID: state.PendingOperationID, ObservedAtUnixMS: state.ObservedAtUnixMS},
					ForceSyncUnknown: true,
				})
			} else {
				_, err = h.goals.MarkGoalRevisionTerminalIncident(actorCtx, storesqlite.GoalTerminalIncidentInput{
					WorkspaceID: item.WorkspaceID, AgentSessionID: item.AgentSessionID, Revision: state.Revision,
					SourceID: "goal-reconcile-inbox:" + item.RequestID, LastError: cause.Error(), OccurredAtUnixMS: h.goalOperationNow().UnixMilli(),
					Expected: &storesqlite.GoalObservationFence{Exists: true, Revision: state.Revision, PendingOperationID: state.PendingOperationID, ObservedAtUnixMS: state.ObservedAtUnixMS},
				})
			}
			if err == nil {
				return nil
			}
			if !errors.Is(err, storesqlite.ErrGoalReconcileConflict) {
				return err
			}
		}
		return storesqlite.ErrGoalReconcileConflict
	})
}

func metadataBool(metadata map[string]any, key string) bool {
	value, _ := metadata[key].(bool)
	return value
}

func (h *Host) RecoverGoalReconcileInbox(ctx context.Context) error {
	if h.goalInbox == nil {
		if h != nil && h.goals != nil {
			return ErrGoalConsumerUnavailable
		}
		return nil
	}
	if h.goals == nil || h.goalRuntime == nil {
		return ErrGoalConsumerUnavailable
	}
	_, err := h.goalInbox.RequeueLeasedGoalReconcileInboxOnStartup(ctx, h.goalOperationNow().UnixMilli())
	return err
}

func (h *Host) RunGoalReconcileInboxWorker(ctx context.Context) {
	_ = h.runGoalReconcileInboxWorker(ctx)
}

func (h *Host) runGoalReconcileInboxWorker(ctx context.Context) error {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			_ = h.StepGoalReconcileInboxWorker(ctx)
		}
	}
}
