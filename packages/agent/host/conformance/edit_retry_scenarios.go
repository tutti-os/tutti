package conformance

import (
	"context"
	"fmt"
)

type EditRetryCheckpoint string

const (
	EditRetryCheckpointPrepared          EditRetryCheckpoint = "prepared"
	EditRetryCheckpointRollbackConfirmed EditRetryCheckpoint = "rollback_confirmed"
)

type EditRetryRollbackOutcome string

const (
	EditRetryRollbackDirectReceipt       EditRetryRollbackOutcome = "direct_receipt"
	EditRetryRollbackAppliedResponseLost EditRetryRollbackOutcome = "applied_response_lost"
	EditRetryRollbackOutcomeUnknown      EditRetryRollbackOutcome = "outcome_unknown"
)

type EditRetryReplacementOutcome string

const (
	EditRetryReplacementDirectReceipt        EditRetryReplacementOutcome = "direct_receipt"
	EditRetryReplacementAcceptedResponseLost EditRetryReplacementOutcome = "accepted_response_lost"
	EditRetryReplacementOutcomeUnknown       EditRetryReplacementOutcome = "outcome_unknown"
)

type EditRetryRollbackRead string

const (
	EditRetryRollbackReadBefore EditRetryRollbackRead = "before"
	EditRetryRollbackReadAfter  EditRetryRollbackRead = "after"
)

type EditRetryReplacementRead string

const (
	EditRetryReplacementReadAccepted       EditRetryReplacementRead = "accepted"
	EditRetryReplacementReadAbsentProven   EditRetryReplacementRead = "absent_proven"
	EditRetryReplacementReadAbsentUnproven EditRetryReplacementRead = "absent_unproven"
)

type EditRetryRecoveryAction string

const (
	EditRetryRecoveryReconcile        EditRetryRecoveryAction = "reconcile"
	EditRetryRecoveryRetryReplacement EditRetryRecoveryAction = "retry_replacement"
)

type EditRetryState string

const (
	EditRetryStateCompleted        EditRetryState = "completed"
	EditRetryStateRecoveryRequired EditRetryState = "recovery_required"
)

type EditRetryFixture struct {
	InitialCheckpoint       EditRetryCheckpoint
	RollbackOutcome         EditRetryRollbackOutcome
	RollbackRead            EditRetryRollbackRead
	ReplacementOutcome      EditRetryReplacementOutcome
	ReplacementRead         EditRetryReplacementRead
	ReplacementRetryOutcome EditRetryReplacementOutcome
}

type EditRetryObservation struct {
	State            EditRetryState
	AvailableActions []EditRetryRecoveryAction
	ActionApplied    bool
}

type EditRetryMetrics struct {
	RollbackCalls       int
	ExecCalls           int
	ReconcileCalls      int
	HistoryReadCalls    int
	AcceptancePollCalls int
}

// EditRetryDriver is intentionally separate from Driver. A Host consumer may
// implement the baseline lifecycle contract without claiming support for
// authoritative provider-history mutation.
type EditRetryDriver interface {
	ResetEditRetry(context.Context, EditRetryFixture) error
	StartEditRetry(context.Context) (EditRetryObservation, error)
	RestartEditRetry(context.Context) (EditRetryObservation, error)
	RecoverEditRetry(context.Context, EditRetryRecoveryAction) (EditRetryObservation, error)
	EditRetryMetrics() EditRetryMetrics
}

type EditRetryScenario struct {
	Name string
	run  func(context.Context, EditRetryDriver) error
}

func EditRetryScenarios() []EditRetryScenario {
	return []EditRetryScenario{
		{Name: "edit retry rollback applied response loss is reconciled once", run: runEditRetryRollbackAppliedResponseLost},
		{Name: "edit retry ambiguous rollback never redispatches", run: runEditRetryAmbiguousRollback},
		{Name: "edit retry accepted replacement response loss does not duplicate", run: runEditRetryAcceptedReplacementResponseLost},
		{Name: "edit retry ambiguous replacement without absence proof does not resend", run: runEditRetryAmbiguousReplacement},
		{Name: "edit retry reconcile is read only", run: runEditRetryReconcileReadOnly},
		{Name: "edit retry replacement retry requires proven absence", run: runEditRetryReplacementRetryRequiresProof},
		{Name: "edit retry direct receipt bypasses acceptance polling", run: runEditRetryDirectReceipt},
		{Name: "edit retry rollback-confirmed restart enters replacement only", run: runEditRetryRollbackConfirmedRestart},
	}
}

func RunEditRetry(ctx context.Context, driver EditRetryDriver, scenario EditRetryScenario) error {
	if driver == nil {
		return fmt.Errorf("agent host edit retry conformance driver is required")
	}
	if scenario.run == nil {
		return fmt.Errorf("agent host edit retry conformance scenario %q has no runner", scenario.Name)
	}
	return scenario.run(ctx, driver)
}

func runEditRetryRollbackAppliedResponseLost(ctx context.Context, driver EditRetryDriver) error {
	if err := driver.ResetEditRetry(ctx, EditRetryFixture{
		RollbackOutcome:    EditRetryRollbackAppliedResponseLost,
		RollbackRead:       EditRetryRollbackReadAfter,
		ReplacementOutcome: EditRetryReplacementDirectReceipt,
	}); err != nil {
		return err
	}
	observed, err := driver.StartEditRetry(ctx)
	if err != nil {
		return err
	}
	if observed.State != EditRetryStateCompleted {
		return fmt.Errorf("applied rollback response loss state=%q, want completed", observed.State)
	}
	metrics := driver.EditRetryMetrics()
	if metrics.RollbackCalls != 1 {
		return fmt.Errorf("applied rollback response loss rollback calls=%d, want 1", metrics.RollbackCalls)
	}
	return nil
}

func runEditRetryAmbiguousRollback(ctx context.Context, driver EditRetryDriver) error {
	if err := driver.ResetEditRetry(ctx, EditRetryFixture{
		RollbackOutcome: EditRetryRollbackOutcomeUnknown,
		RollbackRead:    EditRetryRollbackReadBefore,
	}); err != nil {
		return err
	}
	if _, err := driver.StartEditRetry(ctx); err != nil {
		return err
	}
	if _, err := driver.RestartEditRetry(ctx); err != nil {
		return err
	}
	if _, err := driver.RecoverEditRetry(ctx, EditRetryRecoveryReconcile); err != nil {
		return err
	}
	metrics := driver.EditRetryMetrics()
	if metrics.RollbackCalls != 1 || metrics.ExecCalls != 0 {
		return fmt.Errorf("ambiguous rollback calls rollback=%d exec=%d, want 1/0", metrics.RollbackCalls, metrics.ExecCalls)
	}
	return nil
}

func runEditRetryAcceptedReplacementResponseLost(ctx context.Context, driver EditRetryDriver) error {
	if err := driver.ResetEditRetry(ctx, EditRetryFixture{
		RollbackRead:       EditRetryRollbackReadAfter,
		ReplacementOutcome: EditRetryReplacementAcceptedResponseLost,
		ReplacementRead:    EditRetryReplacementReadAccepted,
	}); err != nil {
		return err
	}
	observed, err := driver.StartEditRetry(ctx)
	if err != nil {
		return err
	}
	if observed.State != EditRetryStateCompleted {
		return fmt.Errorf("accepted replacement response loss state=%q, want completed", observed.State)
	}
	if _, err := driver.RestartEditRetry(ctx); err != nil {
		return err
	}
	metrics := driver.EditRetryMetrics()
	if metrics.ExecCalls != 1 {
		return fmt.Errorf("accepted replacement response loss exec calls=%d, want 1", metrics.ExecCalls)
	}
	return nil
}

func runEditRetryAmbiguousReplacement(ctx context.Context, driver EditRetryDriver) error {
	if err := driver.ResetEditRetry(ctx, EditRetryFixture{
		RollbackRead:       EditRetryRollbackReadAfter,
		ReplacementOutcome: EditRetryReplacementOutcomeUnknown,
		ReplacementRead:    EditRetryReplacementReadAbsentUnproven,
	}); err != nil {
		return err
	}
	observed, err := driver.StartEditRetry(ctx)
	if err != nil {
		return err
	}
	if observed.State != EditRetryStateRecoveryRequired ||
		hasEditRetryAction(observed.AvailableActions, EditRetryRecoveryRetryReplacement) {
		return fmt.Errorf("ambiguous replacement observation=%#v, want recovery without replacement retry", observed)
	}
	if _, err := driver.RestartEditRetry(ctx); err != nil {
		return err
	}
	if metrics := driver.EditRetryMetrics(); metrics.ExecCalls != 1 {
		return fmt.Errorf("ambiguous replacement exec calls=%d, want 1", metrics.ExecCalls)
	}
	return nil
}

func runEditRetryReconcileReadOnly(ctx context.Context, driver EditRetryDriver) error {
	if err := driver.ResetEditRetry(ctx, EditRetryFixture{
		RollbackOutcome: EditRetryRollbackOutcomeUnknown,
		RollbackRead:    EditRetryRollbackReadBefore,
	}); err != nil {
		return err
	}
	if _, err := driver.StartEditRetry(ctx); err != nil {
		return err
	}
	before := driver.EditRetryMetrics()
	if _, err := driver.RecoverEditRetry(ctx, EditRetryRecoveryReconcile); err != nil {
		return err
	}
	after := driver.EditRetryMetrics()
	if after.RollbackCalls != before.RollbackCalls || after.ExecCalls != before.ExecCalls {
		return fmt.Errorf(
			"reconcile changed provider mutation calls rollback=%d->%d exec=%d->%d",
			before.RollbackCalls,
			after.RollbackCalls,
			before.ExecCalls,
			after.ExecCalls,
		)
	}
	if after.ReconcileCalls <= before.ReconcileCalls {
		return fmt.Errorf("reconcile calls=%d, want greater than %d", after.ReconcileCalls, before.ReconcileCalls)
	}
	return nil
}

func runEditRetryReplacementRetryRequiresProof(ctx context.Context, driver EditRetryDriver) error {
	if err := driver.ResetEditRetry(ctx, EditRetryFixture{
		RollbackRead:       EditRetryRollbackReadAfter,
		ReplacementOutcome: EditRetryReplacementOutcomeUnknown,
		ReplacementRead:    EditRetryReplacementReadAbsentUnproven,
	}); err != nil {
		return err
	}
	if _, err := driver.StartEditRetry(ctx); err != nil {
		return err
	}
	blocked, err := driver.RecoverEditRetry(ctx, EditRetryRecoveryRetryReplacement)
	if err != nil {
		return err
	}
	if blocked.ActionApplied {
		return fmt.Errorf("replacement retry applied without authoritative absence proof")
	}
	if metrics := driver.EditRetryMetrics(); metrics.ExecCalls != 1 {
		return fmt.Errorf("unproven replacement retry exec calls=%d, want 1", metrics.ExecCalls)
	}

	if err := driver.ResetEditRetry(ctx, EditRetryFixture{
		RollbackRead:            EditRetryRollbackReadAfter,
		ReplacementOutcome:      EditRetryReplacementOutcomeUnknown,
		ReplacementRead:         EditRetryReplacementReadAbsentProven,
		ReplacementRetryOutcome: EditRetryReplacementDirectReceipt,
	}); err != nil {
		return err
	}
	if _, err := driver.StartEditRetry(ctx); err != nil {
		return err
	}
	reconciled, err := driver.RecoverEditRetry(ctx, EditRetryRecoveryReconcile)
	if err != nil {
		return err
	}
	if !hasEditRetryAction(reconciled.AvailableActions, EditRetryRecoveryRetryReplacement) {
		return fmt.Errorf("proven absent replacement actions=%v, want retry_replacement", reconciled.AvailableActions)
	}
	retried, err := driver.RecoverEditRetry(ctx, EditRetryRecoveryRetryReplacement)
	if err != nil {
		return err
	}
	if !retried.ActionApplied || retried.State != EditRetryStateCompleted {
		return fmt.Errorf("proven replacement retry observation=%#v, want applied completion", retried)
	}
	metrics := driver.EditRetryMetrics()
	if metrics.RollbackCalls != 1 || metrics.ExecCalls != 2 {
		return fmt.Errorf("proven replacement retry calls rollback=%d exec=%d, want 1/2", metrics.RollbackCalls, metrics.ExecCalls)
	}
	return nil
}

func runEditRetryDirectReceipt(ctx context.Context, driver EditRetryDriver) error {
	if err := driver.ResetEditRetry(ctx, EditRetryFixture{
		RollbackRead:       EditRetryRollbackReadAfter,
		ReplacementOutcome: EditRetryReplacementDirectReceipt,
	}); err != nil {
		return err
	}
	observed, err := driver.StartEditRetry(ctx)
	if err != nil {
		return err
	}
	if observed.State != EditRetryStateCompleted {
		return fmt.Errorf("direct receipt state=%q, want completed", observed.State)
	}
	metrics := driver.EditRetryMetrics()
	if metrics.ExecCalls != 1 || metrics.HistoryReadCalls != 0 ||
		metrics.AcceptancePollCalls != 0 {
		return fmt.Errorf(
			"direct receipt metrics exec=%d historyReads=%d acceptancePolls=%d, want 1/0/0",
			metrics.ExecCalls,
			metrics.HistoryReadCalls,
			metrics.AcceptancePollCalls,
		)
	}
	return nil
}

func runEditRetryRollbackConfirmedRestart(ctx context.Context, driver EditRetryDriver) error {
	if err := driver.ResetEditRetry(ctx, EditRetryFixture{
		InitialCheckpoint:  EditRetryCheckpointRollbackConfirmed,
		ReplacementOutcome: EditRetryReplacementDirectReceipt,
	}); err != nil {
		return err
	}
	observed, err := driver.RestartEditRetry(ctx)
	if err != nil {
		return err
	}
	if observed.State != EditRetryStateCompleted {
		return fmt.Errorf("rollback-confirmed restart state=%q, want completed", observed.State)
	}
	metrics := driver.EditRetryMetrics()
	if metrics.RollbackCalls != 0 || metrics.ExecCalls != 1 {
		return fmt.Errorf(
			"rollback-confirmed restart calls rollback=%d exec=%d, want 0/1",
			metrics.RollbackCalls,
			metrics.ExecCalls,
		)
	}
	return nil
}

func hasEditRetryAction(actions []EditRetryRecoveryAction, expected EditRetryRecoveryAction) bool {
	for _, action := range actions {
		if action == expected {
			return true
		}
	}
	return false
}
