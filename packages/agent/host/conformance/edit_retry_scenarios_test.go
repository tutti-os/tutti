package conformance

import (
	"context"
	"fmt"
	"testing"
)

func TestScriptedEditRetryDriverRunsAllScenarios(t *testing.T) {
	for _, scenario := range EditRetryScenarios() {
		scenario := scenario
		t.Run(scenario.Name, func(t *testing.T) {
			driver := &scriptedEditRetryDriver{}
			if err := RunEditRetry(t.Context(), driver, scenario); err != nil {
				t.Fatal(err)
			}
		})
	}
}

type scriptedEditRetryStage string

const (
	scriptedEditRetryStagePrepared             scriptedEditRetryStage = "prepared"
	scriptedEditRetryStageRollbackUncertain    scriptedEditRetryStage = "rollback_uncertain"
	scriptedEditRetryStageRollbackConfirmed    scriptedEditRetryStage = "rollback_confirmed"
	scriptedEditRetryStageReplacementUncertain scriptedEditRetryStage = "replacement_uncertain"
	scriptedEditRetryStageCompleted            scriptedEditRetryStage = "completed"
)

type scriptedEditRetryDriver struct {
	fixture EditRetryFixture
	metrics EditRetryMetrics
	stage   scriptedEditRetryStage
}

func (driver *scriptedEditRetryDriver) ResetEditRetry(_ context.Context, fixture EditRetryFixture) error {
	driver.fixture = fixture
	driver.metrics = EditRetryMetrics{}
	switch fixture.InitialCheckpoint {
	case "", EditRetryCheckpointPrepared:
		driver.stage = scriptedEditRetryStagePrepared
	case EditRetryCheckpointRollbackConfirmed:
		driver.stage = scriptedEditRetryStageRollbackConfirmed
	default:
		return fmt.Errorf("unsupported initial edit retry checkpoint %q", fixture.InitialCheckpoint)
	}
	return nil
}

func (driver *scriptedEditRetryDriver) StartEditRetry(context.Context) (EditRetryObservation, error) {
	if driver.stage != scriptedEditRetryStagePrepared {
		return EditRetryObservation{}, fmt.Errorf("start edit retry from stage %q", driver.stage)
	}
	driver.metrics.RollbackCalls++
	switch driver.fixture.RollbackOutcome {
	case "", EditRetryRollbackDirectReceipt:
		driver.stage = scriptedEditRetryStageRollbackConfirmed
	case EditRetryRollbackAppliedResponseLost, EditRetryRollbackOutcomeUnknown:
		driver.stage = scriptedEditRetryStageRollbackUncertain
		driver.metrics.ReconcileCalls++
		if driver.fixture.RollbackRead == EditRetryRollbackReadAfter {
			driver.stage = scriptedEditRetryStageRollbackConfirmed
		}
	default:
		return EditRetryObservation{}, fmt.Errorf(
			"unsupported rollback outcome %q",
			driver.fixture.RollbackOutcome,
		)
	}
	if driver.stage != scriptedEditRetryStageRollbackConfirmed {
		return driver.observe(false), nil
	}
	return driver.dispatchReplacement(driver.fixture.ReplacementOutcome, false)
}

func (driver *scriptedEditRetryDriver) RestartEditRetry(context.Context) (EditRetryObservation, error) {
	switch driver.stage {
	case scriptedEditRetryStagePrepared:
		return EditRetryObservation{}, fmt.Errorf("restart requires a durable edit retry checkpoint")
	case scriptedEditRetryStageRollbackUncertain:
		driver.metrics.ReconcileCalls++
		driver.metrics.HistoryReadCalls++
		if driver.fixture.RollbackRead == EditRetryRollbackReadAfter {
			driver.stage = scriptedEditRetryStageRollbackConfirmed
		}
		return driver.observe(false), nil
	case scriptedEditRetryStageRollbackConfirmed:
		return driver.dispatchReplacement(driver.fixture.ReplacementOutcome, false)
	case scriptedEditRetryStageReplacementUncertain:
		driver.readReplacementHistory()
		return driver.observe(false), nil
	case scriptedEditRetryStageCompleted:
		return driver.observe(false), nil
	default:
		return EditRetryObservation{}, fmt.Errorf("restart edit retry from stage %q", driver.stage)
	}
}

func (driver *scriptedEditRetryDriver) RecoverEditRetry(
	_ context.Context,
	action EditRetryRecoveryAction,
) (EditRetryObservation, error) {
	switch action {
	case EditRetryRecoveryReconcile:
		driver.metrics.ReconcileCalls++
		driver.metrics.HistoryReadCalls++
		switch driver.stage {
		case scriptedEditRetryStageRollbackUncertain:
			if driver.fixture.RollbackRead == EditRetryRollbackReadAfter {
				driver.stage = scriptedEditRetryStageRollbackConfirmed
			}
		case scriptedEditRetryStageReplacementUncertain:
			driver.observeReplacementRead()
		}
		return driver.observe(false), nil
	case EditRetryRecoveryRetryReplacement:
		if driver.stage != scriptedEditRetryStageReplacementUncertain ||
			driver.fixture.ReplacementRead != EditRetryReplacementReadAbsentProven {
			return driver.observe(false), nil
		}
		return driver.dispatchReplacement(driver.fixture.ReplacementRetryOutcome, true)
	default:
		return EditRetryObservation{}, fmt.Errorf("unsupported edit retry recovery action %q", action)
	}
}

func (driver *scriptedEditRetryDriver) EditRetryMetrics() EditRetryMetrics {
	return driver.metrics
}

func (driver *scriptedEditRetryDriver) dispatchReplacement(
	outcome EditRetryReplacementOutcome,
	actionApplied bool,
) (EditRetryObservation, error) {
	driver.metrics.ExecCalls++
	switch outcome {
	case "", EditRetryReplacementDirectReceipt:
		driver.stage = scriptedEditRetryStageCompleted
	case EditRetryReplacementAcceptedResponseLost, EditRetryReplacementOutcomeUnknown:
		driver.stage = scriptedEditRetryStageReplacementUncertain
		driver.readReplacementHistory()
	default:
		return EditRetryObservation{}, fmt.Errorf("unsupported replacement outcome %q", outcome)
	}
	return driver.observe(actionApplied), nil
}

func (driver *scriptedEditRetryDriver) readReplacementHistory() {
	driver.metrics.HistoryReadCalls++
	driver.observeReplacementRead()
}

func (driver *scriptedEditRetryDriver) observeReplacementRead() {
	if driver.fixture.ReplacementRead == EditRetryReplacementReadAccepted {
		driver.stage = scriptedEditRetryStageCompleted
	}
}

func (driver *scriptedEditRetryDriver) observe(actionApplied bool) EditRetryObservation {
	observation := EditRetryObservation{ActionApplied: actionApplied}
	switch driver.stage {
	case scriptedEditRetryStageCompleted:
		observation.State = EditRetryStateCompleted
	case scriptedEditRetryStageRollbackUncertain,
		scriptedEditRetryStageRollbackConfirmed,
		scriptedEditRetryStageReplacementUncertain:
		observation.State = EditRetryStateRecoveryRequired
		observation.AvailableActions = []EditRetryRecoveryAction{EditRetryRecoveryReconcile}
		if driver.stage == scriptedEditRetryStageReplacementUncertain &&
			driver.fixture.ReplacementRead == EditRetryReplacementReadAbsentProven {
			observation.AvailableActions = append(
				observation.AvailableActions,
				EditRetryRecoveryRetryReplacement,
			)
		}
	}
	return observation
}
