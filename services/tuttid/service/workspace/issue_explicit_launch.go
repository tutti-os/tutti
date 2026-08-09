package workspace

import (
	"context"
	"errors"
	"strings"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

type issueRunLaunchIntentStore interface {
	CreateIssueRunWithLaunchIntent(context.Context, workspaceissues.PreparedRun, string, string) (workspaceissues.Run, error)
	ListPreparedIssueRunLaunches(context.Context, string) ([]workspaceissues.PreparedRunLaunch, error)
	ClaimIssueRunLaunchIntent(context.Context, string, string, string, string, time.Time, time.Time) (bool, error)
	RenewIssueRunLaunchIntent(context.Context, string, string, string, string, time.Time, time.Time) error
	ReleaseIssueRunLaunchIntent(context.Context, string, string, string, string, time.Time) error
	MarkIssueRunLaunchIntentDispatched(context.Context, string, string, string, string, time.Time) error
	SettleIssueRunLaunch(context.Context, workspaceissues.RunLaunchSettlement) (workspaceissues.Run, error)
	RequeueLeasedIssueRunLaunchIntents(context.Context, string, time.Time) error
	HasPendingIssueRunLaunch(context.Context, string, string, string) (bool, error)
}

// ErrIssueRunLaunchPending fences destructive graph mutations while an
// admitted Run may still be creating its canonical Agent session.
var ErrIssueRunLaunchPending = errors.New("issue Run launch is pending")

func (s IssueManagerService) runLaunchIntentStore() (issueRunLaunchIntentStore, error) {
	store, ok := s.Store.(issueRunLaunchIntentStore)
	if !ok {
		return nil, workspaceissues.ErrStoreNotConfigured
	}
	return store, nil
}

func (s IssueManagerService) ensureIssueRunLaunchDeletionAllowed(
	ctx context.Context,
	workspaceID, issueID, taskID string,
) error {
	store, ok := s.Store.(issueRunLaunchIntentStore)
	if !ok {
		return nil
	}
	pending, err := store.HasPendingIssueRunLaunch(ctx, workspaceID, issueID, taskID)
	if err != nil {
		return err
	}
	if pending {
		return ErrIssueRunLaunchPending
	}
	return nil
}

func (s IssueManagerService) createRunWithLaunchIntentLocked(
	ctx context.Context,
	workspaceID, issueID string,
	input CreateIssueManagerRunInput,
	payload workspacebiz.IssueRunLaunchPayload,
) (workspaceissues.Run, error) {
	prepared, err := s.domainService().PrepareRun(ctx, workspaceissues.CreateRunInput{
		RunID:              input.RunID,
		IssueID:            issueID,
		WorkspaceID:        workspaceID,
		ActorUserID:        issueManagerLocalActorUserID,
		AgentTargetID:      input.AgentTargetID,
		AgentProvider:      input.AgentProvider,
		AgentUserID:        input.AgentUserID,
		AgentSessionID:     input.AgentSessionID,
		ExecutionDirectory: input.ExecutionDirectory,
		ModelPlanID:        input.ModelPlanID,
		Model:              input.Model,
	})
	if err != nil {
		return workspaceissues.Run{}, err
	}
	payload.ExecutionDirectory = prepared.Run.ExecutionDirectory
	payload.ModelPlanID = prepared.Run.ModelPlanID
	payload.Model = prepared.Run.Model
	payload.ReasoningIntensity = prepared.Run.ReasoningIntensity
	payloadJSON, err := workspacebiz.EncodeIssueRunLaunchPayload(payload)
	if err != nil {
		return workspaceissues.Run{}, err
	}
	store, err := s.runLaunchIntentStore()
	if err != nil {
		return workspaceissues.Run{}, err
	}
	return store.CreateIssueRunWithLaunchIntent(
		ctx, prepared, workspaceissues.IssueRunClientSubmitID(prepared.Run.RunID), payloadJSON,
	)
}

// deliverExplicitIssueRun claims the durable intent before calling Agent Host.
// Delivery-unknown failures are released back to prepared and are intentionally
// not terminal: recovery redelivers with the same session and client-submit IDs.
func (s IssueManagerService) deliverExplicitIssueRun(ctx context.Context, launch IssueRunLaunch) error {
	store, err := s.runLaunchIntentStore()
	if err != nil {
		return err
	}
	now := time.Now().UTC()
	leaseOwner := "explicit:" + launch.RunID + ":" + strings.ReplaceAll(now.Format(time.RFC3339Nano), ":", "-")
	leaseDuration := s.tuttiModeRunLaunchLeaseDuration()
	claimed, err := store.ClaimIssueRunLaunchIntent(
		ctx, launch.WorkspaceID, launch.IssueID, launch.RunID, leaseOwner,
		now, now.Add(leaseDuration),
	)
	if err != nil || !claimed {
		// The Run and its prepared intent are already durable. A claim error is
		// an accepted, recoverable launch rather than permission to create a
		// second Run from the capture composer.
		s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
		return nil
	}
	renewalInterval := leaseDuration / 3
	if renewalInterval <= 0 {
		renewalInterval = time.Nanosecond
	}
	stopRenewal := s.runLaunchLeaseRenewalScheduler().Start(ctx, renewalInterval, func() error {
		renewedAt := time.Now().UTC()
		return store.RenewIssueRunLaunchIntent(
			ctx, launch.WorkspaceID, launch.IssueID, launch.RunID, leaseOwner,
			renewedAt, renewedAt.Add(leaseDuration),
		)
	})
	defer stopRenewal()

	var deliveryErr error
	release := func() {
		stopRenewal()
		releaseCtx, cancel := durableIssueRunCleanupContext(ctx)
		defer cancel()
		if err := store.ReleaseIssueRunLaunchIntent(
			releaseCtx, launch.WorkspaceID, launch.IssueID, launch.RunID,
			leaseOwner, time.Now().UTC(),
		); err != nil {
			s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
		}
		s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
	}
	s.deliverIssueRunLaunch(ctx, launch, issueRunLaunchDeliveryOutcomes{
		onGateBusy: release,
		onRejected: func(decision issueRunLaunchDecision) {
			if decision != issueRunCancelClaim {
				release()
				return
			}
			stopRenewal()
			settleCtx, cancel := durableIssueRunCleanupContext(ctx)
			defer cancel()
			settled, settleErr := store.SettleIssueRunLaunch(settleCtx, workspaceissues.RunLaunchSettlement{
				WorkspaceID: launch.WorkspaceID, IssueID: launch.IssueID,
				RunID: launch.RunID, LeaseOwner: leaseOwner,
				Status: workspaceissues.StatusCanceled, NowUnixMS: time.Now().UTC().UnixMilli(),
			})
			if settleErr != nil {
				s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
				return
			}
			s.publishExplicitRunSettled(ctx, settled)
			if err := s.removeIssueRunAttachments(settleCtx, launch.Attachments); err != nil {
				s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
			}
		},
		onFailure: func(launchErr error) {
			if !isIssueRunLaunchNotStartedError(launchErr) {
				release()
				return
			}
			stopRenewal()
			settleCtx, cancel := durableIssueRunCleanupContext(ctx)
			defer cancel()
			settled, settleErr := store.SettleIssueRunLaunch(settleCtx, workspaceissues.RunLaunchSettlement{
				WorkspaceID: launch.WorkspaceID, IssueID: launch.IssueID,
				RunID: launch.RunID, LeaseOwner: leaseOwner,
				Status: workspaceissues.StatusFailed, ErrorMessage: launchErr.Error(),
				NowUnixMS: time.Now().UTC().UnixMilli(),
			})
			if settleErr != nil {
				s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
				return
			}
			s.publishExplicitRunSettled(ctx, settled)
			if err := s.removeIssueRunAttachments(settleCtx, launch.Attachments); err != nil {
				s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
			}
			deliveryErr = launchErr
		},
		onDelivered: func() {
			stopRenewal()
			markCtx, cancel := durableIssueRunCleanupContext(ctx)
			defer cancel()
			if err := store.MarkIssueRunLaunchIntentDispatched(
				markCtx, launch.WorkspaceID, launch.IssueID, launch.RunID,
				leaseOwner, time.Now().UTC(),
			); err != nil {
				s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
				return
			}
			if err := s.removeIssueRunAttachments(markCtx, launch.Attachments); err != nil {
				s.enqueueWorkspaceRunReconcile(launch.WorkspaceID)
			}
		},
	})
	return deliveryErr
}

func (s IssueManagerService) RecoverExplicitIssueRunLaunches(ctx context.Context, workspaceID string) error {
	store, err := s.runLaunchIntentStore()
	if err != nil {
		if errors.Is(err, workspaceissues.ErrStoreNotConfigured) {
			return nil
		}
		return err
	}
	if err := store.RequeueLeasedIssueRunLaunchIntents(ctx, workspaceID, time.Now().UTC()); err != nil {
		return err
	}
	prepared, err := store.ListPreparedIssueRunLaunches(ctx, workspaceID)
	if err != nil {
		return err
	}
	for _, item := range prepared {
		payload, err := workspacebiz.DecodeIssueRunLaunchPayload(item.OpaquePayload)
		if err != nil {
			return err
		}
		launch := IssueRunLaunch{
			WorkspaceID:        item.Run.WorkspaceID,
			ClientSubmitID:     item.ClientSubmitID,
			AgentSessionID:     item.Run.AgentSessionID,
			AgentTargetID:      item.Run.AgentTargetID,
			RunID:              item.Run.RunID,
			TaskID:             item.Run.TaskID,
			IssueID:            item.Run.IssueID,
			Title:              payload.Title,
			Prompt:             payload.Prompt,
			Attachments:        issueRunAttachmentsFromPayload(payload.Attachments),
			ExecutionDirectory: payload.ExecutionDirectory,
			ModelPlanID:        payload.ModelPlanID,
			Model:              payload.Model,
			ReasoningIntensity: payload.ReasoningIntensity,
		}
		if err := s.deliverExplicitIssueRun(ctx, launch); err != nil {
			return err
		}
	}
	return nil
}

func (s IssueManagerService) publishExplicitRunSettled(ctx context.Context, run workspaceissues.Run) {
	s.publishWorkspaceIssueUpdated(ctx, eventstreamservice.WorkspaceIssueUpdate{
		WorkspaceID: run.WorkspaceID,
		IssueID:     run.IssueID,
		TaskID:      run.TaskID,
		RunID:       run.RunID,
		ChangeKind:  eventstreamservice.WorkspaceIssueChangeRunCompleted,
	})
	s.enqueueWorkspaceRunReconcile(run.WorkspaceID)
}

func issueRunAttachmentsFromPayload(items []workspacebiz.IssueRunLaunchAttachment) []IssueRunImageAttachment {
	attachments := make([]IssueRunImageAttachment, 0, len(items))
	for _, item := range items {
		attachments = append(attachments, IssueRunImageAttachment(item))
	}
	return attachments
}

func issueRunAttachmentsToPayload(items []IssueRunImageAttachment) []workspacebiz.IssueRunLaunchAttachment {
	attachments := make([]workspacebiz.IssueRunLaunchAttachment, 0, len(items))
	for _, item := range items {
		attachments = append(attachments, workspacebiz.IssueRunLaunchAttachment(item))
	}
	return attachments
}
