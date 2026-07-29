package tuttimodeexecution

import (
	"context"
	"errors"
	"testing"
	"time"

	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

func TestWorkerKeepsScanningAfterTransientWorkspaceListFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	calls := 0
	reported := 0
	worker := Worker{
		Executions: &Service{},
		WorkspaceIDs: func(context.Context) ([]string, error) {
			calls++
			if calls == 1 {
				return nil, errors.New("transient workspace list failure")
			}
			cancel()
			return nil, nil
		},
		LeaseOwner:   "watchdog-test-owner",
		ScanInterval: time.Millisecond,
		OnError: func(error) {
			reported++
		},
	}

	if err := worker.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v, want context cancellation", err)
	}
	if calls < 2 || reported != 1 {
		t.Fatalf("worker calls/reported = %d/%d, want retry after one error", calls, reported)
	}
}

type mixedRecoveryWakeStore struct {
	WakeStore
	dispatchable executionbiz.Wake
	corrupted    executionbiz.Wake
}

type nilReviewerWakeStore struct {
	mixedRecoveryWakeStore
}

func (nilReviewerWakeStore) ListCorruptedTuttiModeMainWakes(
	context.Context, string, time.Time,
) ([]executionbiz.Wake, error) {
	return nil, nil
}

func (mixedRecoveryWakeStore) CancelSuppressedTuttiModeExecutionWakes(
	context.Context, string, time.Time,
) error {
	return nil
}

func (mixedRecoveryWakeStore) RequeueExpiredTuttiModeExecutionWakes(
	context.Context, string, time.Time,
) error {
	return nil
}

func (mixedRecoveryWakeStore) PrepareDueTuttiModeExecutionWatchdogs(
	context.Context, string, time.Time,
) error {
	return nil
}

func (mixedRecoveryWakeStore) DrainTuttiModeSourceActivityInbox(
	context.Context, string,
) error {
	return nil
}

func (store mixedRecoveryWakeStore) ListDispatchableTuttiModeMainWakes(
	context.Context, string, time.Time,
) ([]executionbiz.Wake, error) {
	return []executionbiz.Wake{store.dispatchable}, nil
}

func (mixedRecoveryWakeStore) ListDispatchedTuttiModeMainWakes(
	context.Context, string,
) ([]executionbiz.Wake, error) {
	return nil, nil
}

func (store mixedRecoveryWakeStore) ListCorruptedTuttiModeMainWakes(
	context.Context, string, time.Time,
) ([]executionbiz.Wake, error) {
	return []executionbiz.Wake{store.corrupted}, nil
}

func (mixedRecoveryWakeStore) FailTuttiModeExecutionWakeIntegrity(
	context.Context, string, string, string, time.Time,
) error {
	return nil
}

type pendingObservationWakeTarget struct{}

type inactiveReviewerActivity struct{}

func (inactiveReviewerActivity) HasActiveTuttiModeReviewer(
	context.Context, string, string,
) (bool, error) {
	return false, nil
}

func (pendingObservationWakeTarget) ObserveSourceSession(
	context.Context, string, string,
) (SourceSessionObservation, error) {
	return SourceSessionObservation{}, errors.New("transient canonical observation")
}

func (pendingObservationWakeTarget) SendMainWake(
	context.Context, string, string, string, string,
) (MainWakeDelivery, error) {
	panic("SendMainWake must not run after pending observation")
}

func (pendingObservationWakeTarget) ReadMainWakeTurn(
	context.Context, string, string, string,
) (MainWakeTurnObservation, bool, error) {
	panic("ReadMainWakeTurn must not run after pending observation")
}

func TestWorkerReportsSeriousMemberOfMixedPendingRecoveryError(t *testing.T) {
	workspaceID := "workspace-mixed-recovery"
	issueID := "issue-mixed-recovery"
	executionID, ok := executionbiz.ExecutionID(issueID)
	if !ok {
		t.Fatal("ExecutionID() rejected fixture")
	}
	checkpointID := "checkpoint-mixed-recovery"
	wakeID, ok := executionbiz.MainWakeID(checkpointID, 1)
	if !ok {
		t.Fatal("MainWakeID() rejected fixture")
	}
	clientSubmitID, ok := executionbiz.MainWakeClientSubmitID(wakeID)
	if !ok {
		t.Fatal("MainWakeClientSubmitID() rejected fixture")
	}
	valid := executionbiz.Wake{
		ID:              wakeID,
		WorkspaceID:     workspaceID,
		ExecutionID:     executionID,
		IssueID:         issueID,
		CheckpointID:    checkpointID,
		TargetKind:      executionbiz.WakeTargetMain,
		Sequence:        1,
		ClientSubmitID:  clientSubmitID,
		SourceSessionID: "session-mixed-recovery",
		TargetSessionID: "session-mixed-recovery",
		Status:          executionbiz.WakeStatusPrepared,
	}
	corrupted := valid
	corrupted.ID += ":corrupted"
	store := mixedRecoveryWakeStore{
		dispatchable: valid,
		corrupted:    corrupted,
	}
	reported := make([]error, 0, 1)
	worker := Worker{
		Executions: &Service{
			Wakes:            store,
			MainWakeTargets:  pendingObservationWakeTarget{},
			ReviewerActivity: inactiveReviewerActivity{},
		},
		WorkspaceIDs: func(context.Context) ([]string, error) {
			return []string{workspaceID}, nil
		},
		LeaseOwner: "mixed-recovery-owner",
		OnError: func(err error) {
			reported = append(reported, err)
		},
	}

	worker.reportSweepError(worker.sweep(context.Background()))

	if len(reported) != 1 || !errors.Is(reported[0], executionbiz.ErrWakeIntegrity) {
		t.Fatalf(
			"reported errors = %#v, want serious integrity member despite pending sibling",
			reported,
		)
	}
}

func TestRecoverMainWakesFailsClosedWithoutReviewerActivityReader(t *testing.T) {
	workspaceID := "workspace-nil-reviewer"
	issueID := "issue-nil-reviewer"
	executionID, ok := executionbiz.ExecutionID(issueID)
	if !ok {
		t.Fatal("ExecutionID() rejected fixture")
	}
	checkpointID := "checkpoint-nil-reviewer"
	wakeID, ok := executionbiz.MainWakeID(checkpointID, 1)
	if !ok {
		t.Fatal("MainWakeID() rejected fixture")
	}
	clientSubmitID, ok := executionbiz.MainWakeClientSubmitID(wakeID)
	if !ok {
		t.Fatal("MainWakeClientSubmitID() rejected fixture")
	}
	store := nilReviewerWakeStore{mixedRecoveryWakeStore: mixedRecoveryWakeStore{
		dispatchable: executionbiz.Wake{
			ID:              wakeID,
			WorkspaceID:     workspaceID,
			ExecutionID:     executionID,
			IssueID:         issueID,
			CheckpointID:    checkpointID,
			TargetKind:      executionbiz.WakeTargetMain,
			Sequence:        1,
			ClientSubmitID:  clientSubmitID,
			SourceSessionID: "session-nil-reviewer",
			TargetSessionID: "session-nil-reviewer",
			Status:          executionbiz.WakeStatusPrepared,
		},
	}}
	service := Service{
		Wakes:           store,
		MainWakeTargets: pendingObservationWakeTarget{},
	}

	err := service.RecoverMainWakes(
		context.Background(), workspaceID, "nil-reviewer-owner",
	)
	if !errors.Is(err, ErrMainWakeDeliveryPending) ||
		!errors.Is(err, ErrServiceUnavailable) {
		t.Fatalf(
			"RecoverMainWakes() error = %v, want pending + service unavailable",
			err,
		)
	}
}
