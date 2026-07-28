package tuttimodeexecution

import (
	"context"
	"errors"
	"strings"
	"time"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

const defaultWatchdogScanInterval = 15 * time.Second

type SourceSessionActivityKind string

const (
	SourceSessionActivityUserTurn  SourceSessionActivityKind = "user_turn"
	SourceSessionActivityAgentTurn SourceSessionActivityKind = "agent_turn"
)

type SourceSessionActivity struct {
	WorkspaceID string
	SessionID   string
	Kind        SourceSessionActivityKind
	ActivityID  string
	OccurredAt  time.Time
}

// ObserveSourceSessionActivity projects exact source-session Turn activity
// into Tutti's product execution clock. It does not alter Agent Host
// session/Turn lifecycle.
func (service Service) ObserveSourceSessionActivity(
	ctx context.Context,
	activity SourceSessionActivity,
) error {
	store := service.wakeStore()
	activity.WorkspaceID = strings.TrimSpace(activity.WorkspaceID)
	activity.SessionID = strings.TrimSpace(activity.SessionID)
	if store == nil {
		return ErrServiceUnavailable
	}
	if activity.WorkspaceID == "" || activity.SessionID == "" ||
		(activity.Kind != SourceSessionActivityUserTurn &&
			activity.Kind != SourceSessionActivityAgentTurn) {
		return nil
	}
	occurredAt := activity.OccurredAt.UTC()
	if occurredAt.IsZero() {
		return nil
	}
	return store.ObserveTuttiModeSourceSessionActivity(
		ctx, activity.WorkspaceID, activity.SessionID, occurredAt,
	)
}

// RunWatchdog materializes every due durable watchdog operation before using
// the existing main-wake recovery path for bounded, idempotent delivery.
func (service Service) RunWatchdog(
	ctx context.Context,
	workspaceID string,
	leaseOwner string,
) error {
	store := service.wakeStore()
	workspaceID = strings.TrimSpace(workspaceID)
	leaseOwner = strings.TrimSpace(leaseOwner)
	if store == nil || service.MainWakeTargets == nil {
		return ErrServiceUnavailable
	}
	if workspaceID == "" || leaseOwner == "" {
		return executionbiz.ErrWakeRejected
	}
	if err := service.PrepareStartupMainWakeRecovery(ctx, workspaceID); err != nil {
		return err
	}
	reconcileErr := service.reconcileDispatchedMainWakes(
		ctx, store, workspaceID,
	)
	if err := store.PrepareDueTuttiModeExecutionWatchdogs(
		ctx, workspaceID, service.now(),
	); err != nil {
		return errors.Join(reconcileErr, err)
	}
	dispatchErr := service.recoverDispatchableMainWakes(
		ctx, store, workspaceID, leaseOwner,
	)
	return errors.Join(reconcileErr, dispatchErr)
}

type WorkspaceLister func(context.Context) ([]string, error)

// Worker is the daemon-owned product scheduler. The scan cadence is a short
// infrastructure interval; the durable per-execution due time remains exactly
// latest relevant activity plus five minutes and never backs off.
type Worker struct {
	Executions   *Service
	WorkspaceIDs WorkspaceLister
	LeaseOwner   string
	ScanInterval time.Duration
	OnError      func(error)
}

func (worker Worker) Run(ctx context.Context) error {
	if worker.Executions == nil || worker.WorkspaceIDs == nil ||
		strings.TrimSpace(worker.LeaseOwner) == "" {
		return ErrServiceUnavailable
	}
	interval := worker.ScanInterval
	if interval <= 0 {
		interval = defaultWatchdogScanInterval
	}
	worker.reportSweepError(worker.sweep(ctx))
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			worker.reportSweepError(worker.sweep(ctx))
		}
	}
}

func (worker Worker) reportSweepError(err error) {
	if err != nil && worker.OnError != nil {
		worker.OnError(err)
	}
}

func (worker Worker) sweep(ctx context.Context) error {
	workspaceIDs, err := worker.WorkspaceIDs(ctx)
	if err != nil {
		return err
	}
	var sweepErrors []error
	for _, workspaceID := range workspaceIDs {
		if err := worker.Executions.RecoverReviewers(
			ctx, workspaceID, worker.LeaseOwner,
		); err != nil && !errors.Is(err, ErrServiceUnavailable) {
			sweepErrors = append(sweepErrors, err)
		}
		if err := reportableMainWakeRecoveryError(worker.Executions.RunWatchdog(
			ctx, workspaceID, worker.LeaseOwner,
		)); err != nil {
			sweepErrors = append(sweepErrors, err)
		}
	}
	return errors.Join(sweepErrors...)
}

// reportableMainWakeRecoveryError suppresses only error trees whose leaves are
// the pending marker. A joined error can contain that marker and an independent
// integrity or persistence failure; errors.Is alone would hide the serious
// sibling and make the worker appear healthy.
func reportableMainWakeRecoveryError(err error) error {
	if hasReportableMainWakeRecoveryLeaf(err) {
		return err
	}
	return nil
}

func hasReportableMainWakeRecoveryLeaf(err error) bool {
	if err == nil || err == ErrMainWakeDeliveryPending {
		return false
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, child := range joined.Unwrap() {
			if hasReportableMainWakeRecoveryLeaf(child) {
				return true
			}
		}
		return false
	}
	if wrapped, ok := err.(interface{ Unwrap() error }); ok {
		return hasReportableMainWakeRecoveryLeaf(wrapped.Unwrap())
	}
	return true
}
