package tuttimodeexecution

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

const (
	defaultMainWakeLeaseDuration  = time.Minute
	defaultMainWakeSendTimeout    = 30 * time.Second
	defaultMainWakeCleanupTimeout = 10 * time.Second
	minimumMainWakeSendTimeBudget = time.Nanosecond
)

var ErrMainWakeDeliveryPending = errors.New("tutti mode main wake delivery remains pending")

type SourceSessionObservation struct {
	Exists bool
	Busy   bool
}

type MainWakeDelivery struct {
	CanonicalSessionID string
	CanonicalTurnID    string
}

type MainWakeTurnObservation struct {
	CanonicalTurnID string
	SettledAt       time.Time
}

// MainWakeTarget is the daemon adapter onto Agent Host. It observes canonical
// session liveness without resuming a provider, submits through Host's
// idempotent SendInput lifecycle, and recovers canonical Turn identity.
type MainWakeTarget interface {
	ObserveSourceSession(context.Context, string, string) (SourceSessionObservation, error)
	SendMainWake(context.Context, string, string, string, string) (MainWakeDelivery, error)
	ReadMainWakeTurn(context.Context, string, string, string) (MainWakeTurnObservation, bool, error)
}

func (service Service) ListWakes(
	ctx context.Context,
	workspaceID string,
	issueID string,
) ([]executionbiz.Wake, error) {
	store := service.wakeStore()
	if store == nil {
		return nil, ErrServiceUnavailable
	}
	return store.ListTuttiModeExecutionWakes(
		ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(issueID),
	)
}

func (service Service) ClaimMainWake(
	ctx context.Context,
	workspaceID string,
	wakeID string,
	leaseOwner string,
	leaseDuration time.Duration,
) (bool, error) {
	store := service.wakeStore()
	if store == nil {
		return false, ErrServiceUnavailable
	}
	workspaceID = strings.TrimSpace(workspaceID)
	wakeID = strings.TrimSpace(wakeID)
	leaseOwner = strings.TrimSpace(leaseOwner)
	if workspaceID == "" || wakeID == "" || leaseOwner == "" || leaseDuration <= 0 {
		return false, executionbiz.ErrWakeRejected
	}
	now := service.now()
	return store.ClaimTuttiModeExecutionWake(
		ctx, workspaceID, wakeID, leaseOwner, now, now.Add(leaseDuration),
	)
}

func (service Service) RecoverMainWakes(
	ctx context.Context,
	workspaceID string,
	leaseOwner string,
) error {
	store := service.wakeStore()
	if store == nil || service.MainWakeTargets == nil {
		return ErrServiceUnavailable
	}
	workspaceID = strings.TrimSpace(workspaceID)
	leaseOwner = strings.TrimSpace(leaseOwner)
	if workspaceID == "" || leaseOwner == "" {
		return executionbiz.ErrWakeRejected
	}
	if err := store.DrainTuttiModeSourceActivityInbox(
		ctx, workspaceID,
	); err != nil {
		return err
	}
	reconcileErr := service.reconcileDispatchedMainWakes(
		ctx, store, workspaceID,
	)
	dispatchErr := service.recoverDispatchableMainWakes(
		ctx, store, workspaceID, leaseOwner,
	)
	return errors.Join(reconcileErr, dispatchErr)
}

func (service Service) recoverDispatchableMainWakes(
	ctx context.Context,
	store WakeStore,
	workspaceID string,
	leaseOwner string,
) error {
	now := service.now()
	wakes, err := store.ListDispatchableTuttiModeMainWakes(
		ctx, workspaceID, now,
	)
	if err != nil {
		return err
	}
	corruptedWakes, err := store.ListCorruptedTuttiModeMainWakes(
		ctx, workspaceID, now,
	)
	if err != nil {
		return err
	}
	wakes = append(corruptedWakes, wakes...)
	var recoveryErrors []error
	for _, wake := range wakes {
		if wakeErr := service.recoverOneMainWake(
			ctx, store, workspaceID, leaseOwner, wake,
		); wakeErr != nil {
			recoveryErrors = append(recoveryErrors, fmt.Errorf(
				"recover Tutti mode main wake %q: %w",
				wake.ID,
				wakeErr,
			))
		}
	}
	return errors.Join(recoveryErrors...)
}

func (service Service) reconcileDispatchedMainWakes(
	ctx context.Context,
	store WakeStore,
	workspaceID string,
) error {
	wakes, err := store.ListDispatchedTuttiModeMainWakes(ctx, workspaceID)
	if err != nil {
		return err
	}
	var recoveryErrors []error
	for _, wake := range wakes {
		if wakeErr := service.reconcileOneDispatchedMainWake(
			ctx, store, workspaceID, wake,
		); wakeErr != nil {
			recoveryErrors = append(recoveryErrors, fmt.Errorf(
				"reconcile dispatched Tutti mode main wake %q: %w",
				wake.ID,
				wakeErr,
			))
		}
	}
	return errors.Join(recoveryErrors...)
}

func (service Service) reconcileOneDispatchedMainWake(
	ctx context.Context,
	store WakeStore,
	workspaceID string,
	wake executionbiz.Wake,
) error {
	if integrityErr := validateMainWakeIdentity(workspaceID, wake); integrityErr != nil {
		return integrityErr
	}
	if wake.CanonicalSessionID != wake.TargetSessionID ||
		strings.TrimSpace(wake.CanonicalTurnID) == "" {
		return executionbiz.ErrWakeIntegrity
	}
	observation, found, err := service.MainWakeTargets.ReadMainWakeTurn(
		ctx, wake.WorkspaceID, wake.TargetSessionID, wake.ClientSubmitID,
	)
	if err != nil {
		return errors.Join(ErrMainWakeDeliveryPending, err)
	}
	observation.CanonicalTurnID = strings.TrimSpace(observation.CanonicalTurnID)
	if !found || observation.SettledAt.IsZero() {
		return nil
	}
	if observation.CanonicalTurnID != wake.CanonicalTurnID {
		return executionbiz.ErrWakeIntegrity
	}
	_, err = store.MarkTuttiModeExecutionWakeTurnSettled(
		ctx,
		wake.WorkspaceID,
		wake.TargetSessionID,
		wake.CanonicalTurnID,
		observation.SettledAt.UTC(),
	)
	return err
}

func (service Service) recoverOneMainWake(
	ctx context.Context,
	store WakeStore,
	workspaceID string,
	leaseOwner string,
	wake executionbiz.Wake,
) error {
	if integrityErr := validateMainWakeIdentity(workspaceID, wake); integrityErr != nil {
		cleanupCtx, cancel := service.mainWakeCleanupContext(ctx)
		failErr := store.FailTuttiModeExecutionWakeIntegrity(
			cleanupCtx, workspaceID, wake.ID, integrityErr.Error(), service.now(),
		)
		cancel()
		if failErr != nil {
			return errors.Join(integrityErr, failErr)
		}
		return integrityErr
	}
	if service.ReviewerActivity == nil {
		return errors.Join(ErrMainWakeDeliveryPending, ErrServiceUnavailable)
	}
	active, reviewerErr := service.ReviewerActivity.HasActiveTuttiModeReviewer(
		ctx, workspaceID, wake.IssueID,
	)
	if reviewerErr != nil {
		return errors.Join(ErrMainWakeDeliveryPending, reviewerErr)
	}
	if active {
		return nil
	}
	observation, observeErr := service.MainWakeTargets.ObserveSourceSession(
		ctx, workspaceID, wake.SourceSessionID,
	)
	if observeErr != nil {
		return errors.Join(ErrMainWakeDeliveryPending, observeErr)
	}
	if !observation.Exists || observation.Busy {
		return nil
	}
	claimed, claimErr := service.ClaimMainWake(
		ctx, workspaceID, wake.ID, leaseOwner, defaultMainWakeLeaseDuration,
	)
	if claimErr != nil {
		return errors.Join(ErrMainWakeDeliveryPending, claimErr)
	}
	if !claimed {
		return nil
	}
	// Liveness is re-observed after the durable claim so a Turn that became
	// busy in the check-to-claim window cannot receive overlapping input.
	observation, observeErr = service.MainWakeTargets.ObserveSourceSession(
		ctx, workspaceID, wake.SourceSessionID,
	)
	if observeErr != nil || !observation.Exists || observation.Busy {
		message := "source session became unavailable"
		if observeErr != nil {
			message = observeErr.Error()
		}
		cleanupCtx, cancel := service.mainWakeCleanupContext(ctx)
		releaseErr := store.ReleaseTuttiModeExecutionWake(
			cleanupCtx, workspaceID, wake.ID, leaseOwner, message, service.now(),
		)
		cancel()
		if releaseErr != nil {
			return errors.Join(ErrMainWakeDeliveryPending, observeErr, releaseErr)
		}
		if observeErr != nil {
			return errors.Join(ErrMainWakeDeliveryPending, observeErr)
		}
		return nil
	}
	return service.DispatchClaimedMainWake(
		ctx, workspaceID, wake.ID, leaseOwner,
	)
}

func (service Service) StartupRecoverMainWakes(
	ctx context.Context,
	workspaceID string,
	leaseOwner string,
) error {
	if err := service.PrepareStartupMainWakeRecovery(ctx, workspaceID); err != nil {
		return err
	}
	return service.RecoverMainWakes(ctx, workspaceID, leaseOwner)
}

// PrepareStartupMainWakeRecovery performs durable local repair and drains
// canonical source activity. Product wiring calls this while the daemon graph
// is still being built, then enqueues actual Agent delivery for the
// daemon-ready reconciliation seam.
func (service Service) PrepareStartupMainWakeRecovery(
	ctx context.Context,
	workspaceID string,
) error {
	store := service.wakeStore()
	if store == nil {
		return ErrServiceUnavailable
	}
	now := service.now()
	if err := store.CancelSuppressedTuttiModeExecutionWakes(
		ctx, strings.TrimSpace(workspaceID), now,
	); err != nil {
		return err
	}
	if err := store.RequeueExpiredTuttiModeExecutionWakes(
		ctx, strings.TrimSpace(workspaceID), now,
	); err != nil {
		return err
	}
	return store.DrainTuttiModeSourceActivityInbox(
		ctx, strings.TrimSpace(workspaceID),
	)
}

func (service Service) DispatchClaimedMainWake(
	ctx context.Context,
	workspaceID string,
	wakeID string,
	leaseOwner string,
) error {
	store := service.wakeStore()
	if store == nil || service.MainWakeTargets == nil {
		return ErrServiceUnavailable
	}
	workspaceID = strings.TrimSpace(workspaceID)
	if err := store.DrainTuttiModeSourceActivityInbox(
		ctx, workspaceID,
	); err != nil {
		return err
	}
	wake, found, err := store.GetTuttiModeExecutionWake(
		ctx, workspaceID, strings.TrimSpace(wakeID),
	)
	if err != nil {
		return err
	}
	if !found || wake.Status != executionbiz.WakeStatusLeased ||
		wake.LeaseOwner != strings.TrimSpace(leaseOwner) {
		return executionbiz.ErrWakeRejected
	}
	if integrityErr := validateMainWakeIdentity(workspaceID, wake); integrityErr != nil {
		cleanupCtx, cancel := service.mainWakeCleanupContext(ctx)
		failErr := store.FailTuttiModeExecutionWakeIntegrity(
			cleanupCtx, wake.WorkspaceID, wake.ID, integrityErr.Error(), service.now(),
		)
		cancel()
		if failErr != nil {
			return errors.Join(integrityErr, failErr)
		}
		return integrityErr
	}
	now := service.now()
	if wake.LeaseExpiresAt.IsZero() || !wake.LeaseExpiresAt.After(now) {
		return executionbiz.ErrWakeRejected
	}
	if wake.DueAt.After(now) {
		return service.releaseClaimedMainWake(
			ctx, store, wake,
			"source activity advanced the wake deadline after claim",
		)
	}
	prompt := MainWakePrompt(wake)
	sendTimeout := service.mainWakeSendTimeBudget(wake.LeaseExpiresAt.Sub(now))
	sendCtx, cancelSend := context.WithTimeout(ctx, sendTimeout)
	delivery, sendErr := service.MainWakeTargets.SendMainWake(
		sendCtx, wake.WorkspaceID, wake.TargetSessionID, wake.ClientSubmitID, prompt,
	)
	cancelSend()
	if sendErr != nil {
		lookupCtx, cancelLookup := service.mainWakeCleanupContext(ctx)
		observation, found, findErr := service.MainWakeTargets.ReadMainWakeTurn(
			lookupCtx, wake.WorkspaceID, wake.TargetSessionID, wake.ClientSubmitID,
		)
		cancelLookup()
		if findErr == nil && found &&
			strings.TrimSpace(observation.CanonicalTurnID) != "" {
			delivery = MainWakeDelivery{
				CanonicalSessionID: wake.TargetSessionID,
				CanonicalTurnID: strings.TrimSpace(
					observation.CanonicalTurnID,
				),
			}
		} else {
			message := sendErr.Error()
			if findErr != nil {
				message += "; canonical lookup: " + findErr.Error()
			}
			if releaseErr := service.releaseClaimedMainWake(
				ctx, store, wake, message,
			); releaseErr != nil {
				return errors.Join(sendErr, findErr, releaseErr)
			}
			return errors.Join(ErrMainWakeDeliveryPending, sendErr, findErr)
		}
	}
	delivery.CanonicalSessionID = strings.TrimSpace(delivery.CanonicalSessionID)
	delivery.CanonicalTurnID = strings.TrimSpace(delivery.CanonicalTurnID)
	if delivery.CanonicalSessionID != wake.TargetSessionID ||
		delivery.CanonicalTurnID == "" {
		message := "wake delivery returned invalid canonical identity"
		if releaseErr := service.releaseClaimedMainWake(
			ctx, store, wake, message,
		); releaseErr != nil {
			return releaseErr
		}
		return ErrMainWakeDeliveryPending
	}
	finalizeCtx, cancelFinalize := service.mainWakeCleanupContext(ctx)
	defer cancelFinalize()
	finalizedAt := service.now()
	finalizeErr := store.MarkTuttiModeExecutionWakeDispatched(
		finalizeCtx, wake.WorkspaceID, wake.ID, wake.LeaseOwner,
		delivery.CanonicalSessionID, delivery.CanonicalTurnID,
		wake.DueAt, finalizedAt,
	)
	if !errors.Is(finalizeErr, executionbiz.ErrWakeRejected) {
		return finalizeErr
	}
	if drainErr := store.DrainTuttiModeSourceActivityInbox(
		finalizeCtx, wake.WorkspaceID,
	); drainErr != nil {
		return errors.Join(finalizeErr, drainErr)
	}
	current, found, readErr := store.GetTuttiModeExecutionWake(
		finalizeCtx, wake.WorkspaceID, wake.ID,
	)
	if readErr != nil {
		return errors.Join(finalizeErr, readErr)
	}
	if !found ||
		current.Status != executionbiz.WakeStatusLeased ||
		current.LeaseOwner != wake.LeaseOwner ||
		!current.DueAt.After(finalizedAt) {
		return finalizeErr
	}
	return service.releaseClaimedMainWake(
		ctx, store, current,
		"source activity advanced the wake deadline during delivery",
	)
}

func (service Service) releaseClaimedMainWake(
	ctx context.Context,
	store WakeStore,
	wake executionbiz.Wake,
	message string,
) error {
	cleanupCtx, cancel := service.mainWakeCleanupContext(ctx)
	defer cancel()
	return store.ReleaseTuttiModeExecutionWake(
		cleanupCtx,
		wake.WorkspaceID,
		wake.ID,
		wake.LeaseOwner,
		message,
		service.now(),
	)
}

func validateMainWakeIdentity(
	workspaceID string,
	wake executionbiz.Wake,
) error {
	expectedExecutionID, executionOK := executionbiz.ExecutionID(wake.IssueID)
	expectedWakeID, wakeOK := executionbiz.MainWakeID(wake.CheckpointID, wake.Sequence)
	expectedClientSubmitID, submitOK := executionbiz.MainWakeClientSubmitID(expectedWakeID)
	if strings.TrimSpace(workspaceID) == "" ||
		wake.WorkspaceID != strings.TrimSpace(workspaceID) ||
		!executionOK || wake.ExecutionID != expectedExecutionID ||
		strings.TrimSpace(wake.CheckpointID) == "" ||
		wake.TargetKind != executionbiz.WakeTargetMain ||
		!wakeOK || wake.ID != expectedWakeID ||
		!submitOK || wake.ClientSubmitID != expectedClientSubmitID ||
		strings.TrimSpace(wake.SourceSessionID) == "" ||
		wake.TargetSessionID != wake.SourceSessionID {
		return executionbiz.ErrWakeIntegrity
	}
	return nil
}

func (service Service) mainWakeSendTimeBudget(remainingLease time.Duration) time.Duration {
	timeout := service.MainWakeSendTimeout
	if timeout <= 0 {
		timeout = defaultMainWakeSendTimeout
	}
	if remainingLease <= minimumMainWakeSendTimeBudget {
		return minimumMainWakeSendTimeBudget
	}
	if timeout >= remainingLease {
		timeout = remainingLease / 2
	}
	if timeout < minimumMainWakeSendTimeBudget {
		return minimumMainWakeSendTimeBudget
	}
	return timeout
}

func (service Service) mainWakeCleanupContext(
	ctx context.Context,
) (context.Context, context.CancelFunc) {
	timeout := service.MainWakeCleanupTimeout
	if timeout <= 0 {
		timeout = defaultMainWakeCleanupTimeout
	}
	return context.WithTimeout(context.WithoutCancel(ctx), timeout)
}

// ObserveMainWakeTurnSettled is the idempotent product observer seam used by
// canonical root-Turn settlement fan-out. Unrelated session/Turn pairs are
// successful no-ops and cannot resolve their checkpoint.
func (service Service) ObserveMainWakeTurnSettled(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	turnID string,
) error {
	return service.ObserveMainWakeTurnSettledAt(
		ctx, workspaceID, sessionID, turnID, service.now(),
	)
}

// ObserveMainWakeTurnSettledAt records the canonical Turn settlement time.
// Callback delivery can be delayed, so watchdog deadlines must not use the
// observer's wall clock.
func (service Service) ObserveMainWakeTurnSettledAt(
	ctx context.Context,
	workspaceID string,
	sessionID string,
	turnID string,
	settledAt time.Time,
) error {
	store := service.wakeStore()
	if store == nil {
		return ErrServiceUnavailable
	}
	_, err := store.MarkTuttiModeExecutionWakeTurnSettled(
		ctx, strings.TrimSpace(workspaceID), strings.TrimSpace(sessionID),
		strings.TrimSpace(turnID), settledAt.UTC(),
	)
	return err
}

func (service Service) wakeStore() WakeStore {
	if service.Wakes != nil {
		return service.Wakes
	}
	store, _ := service.Store.(WakeStore)
	return store
}
