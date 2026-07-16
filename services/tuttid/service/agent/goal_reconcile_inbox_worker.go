package agent

import (
	"context"
	"errors"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

const (
	goalReconcileInboxLease       = 5 * time.Minute
	goalReconcileInboxMaxAttempts = 24
)

func (s *Service) StepGoalReconcileInboxWorker(ctx context.Context) error {
	if s.GoalReconcileInboxStore == nil {
		return nil
	}
	items, err := s.GoalReconcileInboxStore.ListClaimableGoalReconcileInbox(ctx, s.goalOperationNow().UnixMilli(), 64)
	if err != nil {
		return err
	}
	var errs []error
	for _, candidate := range items {
		claimNow := s.goalOperationNow()
		item, claimed, claimErr := s.GoalReconcileInboxStore.ClaimGoalReconcileInbox(ctx, agentactivitybiz.ClaimGoalReconcileInboxInput{
			RequestID: candidate.RequestID, LeaseOwner: s.goalOperationOwner(), NowUnixMS: claimNow.UnixMilli(), LeaseExpiresAtMS: claimNow.Add(goalReconcileInboxLease).UnixMilli(),
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
			finishNow := s.goalOperationNow()
			fail := false
			if escalateErr := s.escalateGoalReconcileInboxTerminal(ctx, item, cause); escalateErr == nil {
				fail = true
			} else {
				cause = errors.Join(cause, escalateErr)
			}
			if _, releaseErr := s.GoalReconcileInboxStore.ReleaseGoalReconcileInbox(ctx, agentactivitybiz.ReleaseGoalReconcileInboxInput{RequestID: item.RequestID, LeaseOwner: s.goalOperationOwner(), NowUnixMS: finishNow.UnixMilli(), NextAttemptAtMS: finishNow.Add(time.Second).UnixMilli(), LastError: cause.Error(), Fail: fail}); releaseErr != nil {
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
		handleErr := s.ReconcileGoalFromEvidence(ctx, input)
		finishNow := s.goalOperationNow()
		if handleErr == nil {
			if _, completeErr := s.GoalReconcileInboxStore.CompleteGoalReconcileInbox(ctx, item.RequestID, s.goalOperationOwner(), finishNow.UnixMilli()); completeErr != nil {
				errs = append(errs, completeErr)
			}
			continue
		}
		fail := false
		if item.Attempt >= goalReconcileInboxMaxAttempts {
			if escalateErr := s.escalateGoalReconcileInboxTerminal(ctx, item, handleErr); escalateErr == nil {
				fail = true
			} else {
				handleErr = errors.Join(handleErr, escalateErr)
			}
		}
		_, releaseErr := s.GoalReconcileInboxStore.ReleaseGoalReconcileInbox(ctx, agentactivitybiz.ReleaseGoalReconcileInboxInput{
			RequestID: item.RequestID, LeaseOwner: s.goalOperationOwner(), NowUnixMS: finishNow.UnixMilli(), NextAttemptAtMS: finishNow.Add(time.Second).UnixMilli(), LastError: handleErr.Error(), Fail: fail,
		})
		if releaseErr != nil {
			errs = append(errs, releaseErr)
		}
	}
	return errors.Join(errs...)
}

func (s *Service) escalateGoalReconcileInboxTerminal(ctx context.Context, item agentactivitybiz.GoalReconcileInboxItem, cause error) error {
	if s.GoalStateStore == nil {
		return errors.New("goal reconcile inbox terminal escalation store is unavailable")
	}
	return s.withGoalActor(ctx, item.WorkspaceID, item.AgentSessionID, func(actorCtx context.Context) error {
		for attempt := 0; attempt < 3; attempt++ {
			state, found, err := s.GoalStateStore.GetSessionGoalState(actorCtx, item.WorkspaceID, item.AgentSessionID)
			if err != nil {
				return err
			}
			if !found {
				return errors.New("goal reconcile inbox terminal escalation state is unavailable")
			}
			if state.Revision == 0 {
				_, err = s.GoalStateStore.ReconcileSessionGoalObservation(actorCtx, agentactivitybiz.GoalObservationReconcile{
					WorkspaceID: item.WorkspaceID, AgentSessionID: item.AgentSessionID,
					Observed:  clonePayload(state.Observed),
					Evidence:  map[string]any{"source": "goal_reconcile_inbox_terminal", "requestId": item.RequestID, "confidence": "unknown"},
					LastError: cause.Error(), OccurredAtUnixMS: s.goalOperationNow().UnixMilli(),
					Expected:         &agentactivitybiz.GoalObservationFence{Exists: true, Revision: 0, PendingOperationID: state.PendingOperationID, ObservedAtUnixMS: state.ObservedAtUnixMS},
					ForceSyncUnknown: true,
				})
			} else {
				_, err = s.GoalStateStore.MarkGoalRevisionTerminalIncident(actorCtx, agentactivitybiz.GoalTerminalIncidentInput{
					WorkspaceID: item.WorkspaceID, AgentSessionID: item.AgentSessionID, Revision: state.Revision,
					SourceID: "goal-reconcile-inbox:" + item.RequestID, LastError: cause.Error(), OccurredAtUnixMS: s.goalOperationNow().UnixMilli(),
					Expected: &agentactivitybiz.GoalObservationFence{Exists: true, Revision: state.Revision, PendingOperationID: state.PendingOperationID, ObservedAtUnixMS: state.ObservedAtUnixMS},
				})
			}
			if err == nil {
				return nil
			}
			if !errors.Is(err, agentactivitybiz.ErrGoalReconcileConflict) {
				return err
			}
		}
		return agentactivitybiz.ErrGoalReconcileConflict
	})
}

func metadataBool(metadata map[string]any, key string) bool {
	value, _ := metadata[key].(bool)
	return value
}

func (s *Service) RecoverGoalReconcileInbox(ctx context.Context) error {
	if s.GoalReconcileInboxStore == nil {
		return nil
	}
	_, err := s.GoalReconcileInboxStore.RequeueLeasedGoalReconcileInboxOnStartup(ctx, s.goalOperationNow().UnixMilli())
	return err
}

func (s *Service) RunGoalReconcileInboxWorker(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			_ = s.StepGoalReconcileInboxWorker(ctx)
		}
	}
}
