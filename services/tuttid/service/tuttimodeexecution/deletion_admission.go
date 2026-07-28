package tuttimodeexecution

import (
	"context"
	"slices"
	"strings"
	"sync"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	executionbiz "github.com/tutti-os/tutti/services/tuttid/biz/tuttimodeexecution"
)

type SourceDeletionAdmissionStore interface {
	AdmitSourceSessionDeletion(
		context.Context,
		executionbiz.SourceSessionDeletionAdmission,
	) (executionbiz.SourceSessionDeletionAdmission, error)
	ReportSourceSessionDeletion(
		context.Context,
		executionbiz.SourceSessionDeletionAdmission,
		bool,
		time.Time,
	) error
	ReconcileSourceSessionDeletionAdmissions(context.Context, time.Time) error
}

type SourceDeletionGuard struct {
	Store         SourceDeletionAdmissionStore
	Clock         func() time.Time
	Context       context.Context
	ReportTimeout time.Duration
	RetryInterval time.Duration

	lockMu       sync.Mutex
	closureLocks map[string]*sourceDeletionClosureLock
}

const (
	defaultSourceDeletionReportTimeout = 5 * time.Second
	defaultSourceDeletionRetryInterval = 25 * time.Millisecond
)

type sourceDeletionClosureLock struct {
	mu   sync.Mutex
	refs int
}

func (guard *SourceDeletionGuard) AdmitDeleteSessions(
	ctx context.Context, plan agenthost.DeleteSessionsPlan,
) error {
	if guard == nil || guard.Store == nil {
		return ErrServiceUnavailable
	}
	workspaceID, sessionIDs, closureKey := normalizedSourceDeletionPlan(plan)
	if len(sessionIDs) == 0 {
		return nil
	}
	guard.acquireClosure(closureKey)
	_, err := guard.Store.AdmitSourceSessionDeletion(ctx, executionbiz.SourceSessionDeletionAdmission{
		WorkspaceID: workspaceID,
		SessionIDs:  sessionIDs,
		Now:         guard.now(),
	})
	if err != nil {
		guard.releaseClosure(closureKey)
	}
	return err
}

func (guard *SourceDeletionGuard) ReportDeleteSessions(
	ctx context.Context, report agenthost.DeleteSessionsReport,
) {
	workspaceID, sessionIDs, closureKey := normalizedSourceDeletionPlan(report.Plan)
	if len(sessionIDs) == 0 {
		return
	}
	if guard == nil || guard.Store == nil {
		guard.releaseClosure(closureKey)
		return
	}
	admission := executionbiz.SourceSessionDeletionAdmission{
		WorkspaceID: workspaceID,
		SessionIDs:  sessionIDs,
		Now:         guard.now(),
	}
	succeeded := report.Err == nil
	if guard.reportSourceSessionDeletion(ctx, admission, succeeded) == nil {
		guard.releaseClosure(closureKey)
		return
	}
	go guard.retrySourceSessionDeletionReport(closureKey, admission, succeeded)
}

func (guard *SourceDeletionGuard) Recover(ctx context.Context) error {
	if guard == nil || guard.Store == nil {
		return ErrServiceUnavailable
	}
	return guard.Store.ReconcileSourceSessionDeletionAdmissions(ctx, guard.now())
}

func (guard *SourceDeletionGuard) now() time.Time {
	if guard.Clock != nil {
		return guard.Clock().UTC()
	}
	return time.Now().UTC()
}

func (guard *SourceDeletionGuard) reportSourceSessionDeletion(
	ctx context.Context,
	admission executionbiz.SourceSessionDeletionAdmission,
	succeeded bool,
) error {
	if ctx == nil {
		ctx = context.Background()
	}
	timeout := guard.ReportTimeout
	if timeout <= 0 {
		timeout = defaultSourceDeletionReportTimeout
	}
	reportCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout)
	defer cancel()
	return guard.Store.ReportSourceSessionDeletion(
		reportCtx, admission, succeeded, guard.now(),
	)
}

func (guard *SourceDeletionGuard) retrySourceSessionDeletionReport(
	closureKey string,
	admission executionbiz.SourceSessionDeletionAdmission,
	succeeded bool,
) {
	retryCtx := guard.Context
	if retryCtx == nil {
		retryCtx = context.Background()
	}
	interval := guard.RetryInterval
	if interval <= 0 {
		interval = defaultSourceDeletionRetryInterval
	}
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-retryCtx.Done():
			guard.releaseClosure(closureKey)
			return
		case <-timer.C:
		}
		if guard.reportSourceSessionDeletion(
			retryCtx, admission, succeeded,
		) == nil {
			guard.releaseClosure(closureKey)
			return
		}
		timer.Reset(interval)
	}
}

func (guard *SourceDeletionGuard) acquireClosure(key string) {
	guard.lockMu.Lock()
	if guard.closureLocks == nil {
		guard.closureLocks = make(map[string]*sourceDeletionClosureLock)
	}
	lock := guard.closureLocks[key]
	if lock == nil {
		lock = &sourceDeletionClosureLock{}
		guard.closureLocks[key] = lock
	}
	lock.refs++
	guard.lockMu.Unlock()
	lock.mu.Lock()
}

func (guard *SourceDeletionGuard) releaseClosure(key string) {
	if guard == nil {
		return
	}
	guard.lockMu.Lock()
	lock := guard.closureLocks[key]
	guard.lockMu.Unlock()
	if lock == nil {
		return
	}
	lock.mu.Unlock()
	guard.lockMu.Lock()
	lock.refs--
	if lock.refs == 0 && guard.closureLocks[key] == lock {
		delete(guard.closureLocks, key)
	}
	guard.lockMu.Unlock()
}

func normalizedSourceDeletionPlan(
	plan agenthost.DeleteSessionsPlan,
) (string, []string, string) {
	workspaceID := strings.TrimSpace(plan.WorkspaceID)
	sessionIDs := make([]string, 0, len(plan.SessionIDs))
	seen := make(map[string]struct{}, len(plan.SessionIDs))
	for _, sessionID := range plan.SessionIDs {
		sessionID = strings.TrimSpace(sessionID)
		if sessionID == "" {
			continue
		}
		if _, duplicate := seen[sessionID]; duplicate {
			continue
		}
		seen[sessionID] = struct{}{}
		sessionIDs = append(sessionIDs, sessionID)
	}
	slices.Sort(sessionIDs)
	return workspaceID, sessionIDs, workspaceID + "\x00" + strings.Join(sessionIDs, "\x00")
}

var _ agenthost.SessionDeletionGuard = (*SourceDeletionGuard)(nil)
