package tuttimodeexecution_test

import (
	"context"
	"errors"
	"sync"

	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

type recordingRunCanceller struct {
	mu          sync.Mutex
	requests    []workspaceservice.IssueRunCancellationRequest
	failNext    bool
	unknownNext bool
}

func (canceller *recordingRunCanceller) RequestRunCancellation(
	_ context.Context,
	request workspaceservice.IssueRunCancellationRequest,
) (workspaceservice.IssueRunCancelResult, error) {
	canceller.mu.Lock()
	defer canceller.mu.Unlock()
	canceller.requests = append(canceller.requests, request)
	if canceller.failNext {
		canceller.failNext = false
		return workspaceservice.IssueRunCancelResult{}, errors.New("injected cancellation failure")
	}
	if canceller.unknownNext {
		canceller.unknownNext = false
		return workspaceservice.IssueRunCancelResult{
			State: workspaceservice.IssueRunCancelState("unknown"),
		}, nil
	}
	return workspaceservice.IssueRunCancelResult{
		State: workspaceservice.IssueRunCancelAccepted,
	}, nil
}

func (driver *sqliteConformanceDriver) FailNextCancellation() {
	driver.canceller.mu.Lock()
	defer driver.canceller.mu.Unlock()
	driver.canceller.failNext = true
}

func (driver *sqliteConformanceDriver) ReturnUnknownNextCancellation() {
	driver.canceller.mu.Lock()
	defer driver.canceller.mu.Unlock()
	driver.canceller.unknownNext = true
}

func (driver *sqliteConformanceDriver) CancellationCallCount() int {
	driver.canceller.mu.Lock()
	defer driver.canceller.mu.Unlock()
	return len(driver.canceller.requests)
}

func (driver *sqliteConformanceDriver) CancellationClientSubmitIDs() []string {
	driver.canceller.mu.Lock()
	defer driver.canceller.mu.Unlock()
	submitIDs := make([]string, 0, len(driver.canceller.requests))
	for _, request := range driver.canceller.requests {
		submitIDs = append(submitIDs, request.ClientSubmitID)
	}
	return submitIDs
}

func (driver *sqliteConformanceDriver) PreparedCancelCompensationCount(
	ctx context.Context,
	workspaceID string,
) (int, error) {
	items, err := driver.executions.ListPreparedRunCancelCompensations(
		ctx, workspaceID,
	)
	return len(items), err
}
