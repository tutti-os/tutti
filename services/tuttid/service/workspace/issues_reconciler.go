package workspace

import (
	"context"
	"strings"
	"sync"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
)

const (
	defaultIssueRunReconcileDelay    = 3 * time.Second
	defaultIssueRunReconcileInterval = 15 * time.Second
	defaultIssueRunMaxDuration       = 45 * time.Minute
	defaultIssueRunReconcileLimit    = 100
)

type IssueRunReconcileResult struct {
	CompletedCount int
	RunningCount   int
}

type WorkspaceExecutionRecoveryResult struct {
	Pending bool
}

type WorkspaceExecutionRecoveryQueue struct {
	mu        sync.Mutex
	pending   map[string]struct{}
	active    bool
	ctx       context.Context
	delay     time.Duration
	interval  time.Duration
	reconcile func(context.Context, string) (WorkspaceExecutionRecoveryResult, error)
}

type WorkspaceExecutionRecoveryQueueOptions struct {
	Context   context.Context
	Delay     time.Duration
	Interval  time.Duration
	Reconcile func(context.Context, string) (WorkspaceExecutionRecoveryResult, error)
}

func NewWorkspaceExecutionRecoveryQueue(
	options WorkspaceExecutionRecoveryQueueOptions,
) *WorkspaceExecutionRecoveryQueue {
	delay := options.Delay
	if delay <= 0 {
		delay = defaultIssueRunReconcileDelay
	}
	interval := options.Interval
	if interval <= 0 {
		interval = defaultIssueRunReconcileInterval
	}
	queueContext := options.Context
	if queueContext == nil {
		queueContext = context.Background()
	}
	return &WorkspaceExecutionRecoveryQueue{
		pending:   make(map[string]struct{}),
		ctx:       queueContext,
		delay:     delay,
		interval:  interval,
		reconcile: options.Reconcile,
	}
}

func (q *WorkspaceExecutionRecoveryQueue) Enqueue(workspaceID string) {
	workspaceID = strings.TrimSpace(workspaceID)
	if q == nil || q.reconcile == nil || workspaceID == "" {
		return
	}
	q.mu.Lock()
	q.pending[workspaceID] = struct{}{}
	if q.active {
		q.mu.Unlock()
		return
	}
	q.active = true
	delay := q.delay
	q.mu.Unlock()

	go q.loop(delay)
}

func (q *WorkspaceExecutionRecoveryQueue) loop(nextDelay time.Duration) {
	for {
		timer := time.NewTimer(nextDelay)
		select {
		case <-q.ctx.Done():
			timer.Stop()
			q.mu.Lock()
			q.active = false
			q.mu.Unlock()
			return
		case <-timer.C:
		}
		q.mu.Lock()
		workspaces := make([]string, 0, len(q.pending))
		for workspaceID := range q.pending {
			workspaces = append(workspaces, workspaceID)
			delete(q.pending, workspaceID)
		}
		if len(workspaces) == 0 {
			q.active = false
			q.mu.Unlock()
			return
		}
		q.mu.Unlock()
		requeue := make([]string, 0)
		for _, workspaceID := range workspaces {
			result, err := q.reconcile(q.ctx, workspaceID)
			if err != nil || result.Pending {
				requeue = append(requeue, workspaceID)
			}
		}
		q.mu.Lock()
		for _, workspaceID := range requeue {
			q.pending[workspaceID] = struct{}{}
		}
		if len(q.pending) == 0 {
			q.active = false
			q.mu.Unlock()
			return
		}
		nextDelay = q.interval
		q.mu.Unlock()
	}
}

func (c *IssueExecutionCoordinator) ReconcileRunningRuns(ctx context.Context, workspaceID string) (IssueRunReconcileResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" || c == nil || c.Issues == nil {
		return IssueRunReconcileResult{}, nil
	}
	runs, err := c.Issues.domainService().ListRunningRuns(ctx, workspaceID, defaultIssueRunReconcileLimit)
	if err != nil {
		return IssueRunReconcileResult{}, err
	}
	result := IssueRunReconcileResult{RunningCount: len(runs)}
	if len(runs) == 0 {
		return result, nil
	}
	now := time.Now().UnixMilli()
	if c.Clock != nil {
		now = c.Clock().UTC().UnixMilli()
	}
	for _, run := range runs {
		if c.SettlementReader != nil && strings.TrimSpace(run.AgentSessionID) != "" {
			clientSubmitID, identityErr := c.Issues.issueRunClientSubmitID(ctx, run)
			if identityErr != nil {
				return result, identityErr
			}
			settlement, found, readErr := c.SettlementReader.ReadRunSettlement(
				ctx,
				run.WorkspaceID,
				run.AgentSessionID,
				clientSubmitID,
			)
			if readErr != nil {
				return result, readErr
			}
			if found {
				if _, err := c.Issues.CompleteRun(ctx, run.WorkspaceID, run.IssueID, run.TaskID, run.RunID, CompleteIssueManagerRunInput{
					Status:                   string(settlement.Status),
					ErrorMessage:             settlement.ErrorMessage,
					Usage:                    settlement.Usage,
					RemainingQuotaPercent:    settlement.RemainingQuotaPercent,
					HasRemainingQuotaPercent: settlement.HasRemainingQuotaPercent,
				}); err != nil {
					return result, err
				}
				result.CompletedCount++
				continue
			}
		}
		status, errorMessage, ok := issueRunReconcileCompletion(run, now)
		if !ok {
			continue
		}
		c.requestTimedOutRunCancellation(ctx, run)
		if _, err := c.Issues.CompleteRun(ctx, run.WorkspaceID, run.IssueID, run.TaskID, run.RunID, CompleteIssueManagerRunInput{
			Status:       string(status),
			ErrorMessage: errorMessage,
			Outputs:      nil,
		}); err != nil {
			return result, err
		}
		result.CompletedCount++
	}
	return result, nil
}

func (c *IssueExecutionCoordinator) requestTimedOutRunCancellation(
	ctx context.Context,
	run workspaceissues.Run,
) {
	gate := c.Issues.runLaunchGate()
	if gate.requestCancel(run.WorkspaceID, run.RunID) {
		return
	}
	gate.clear(run.WorkspaceID, run.RunID)
	if c.Issues.prepareAndRecoverTuttiModeRunCancelCompensation(
		ctx,
		IssueRunLaunch{
			WorkspaceID: run.WorkspaceID, IssueID: run.IssueID,
			TaskID: run.TaskID, RunID: run.RunID,
			AgentSessionID: run.AgentSessionID,
		},
	) {
		return
	}
	canceller := c.RunSessionCanceller
	if canceller == nil {
		canceller = c.Issues.RunCancellationRequester
	}
	if canceller == nil || strings.TrimSpace(run.AgentSessionID) == "" {
		c.Issues.enqueueWorkspaceRunReconcile(run.WorkspaceID)
		return
	}
	clientSubmitID, err := c.Issues.issueRunClientSubmitID(ctx, run)
	if err != nil {
		c.Issues.enqueueWorkspaceRunReconcile(run.WorkspaceID)
		return
	}
	if _, err := canceller.RequestRunCancellation(ctx, IssueRunCancellationRequest{
		WorkspaceID:    run.WorkspaceID,
		AgentSessionID: run.AgentSessionID,
		RunID:          run.RunID,
		ClientSubmitID: clientSubmitID,
	}); err != nil {
		c.Issues.enqueueWorkspaceRunReconcile(run.WorkspaceID)
	}
}

// ReconcileIssueExecutions closes generic Issue Run delivery and settlement
// crash windows, then layers Tutti Mode settlement/launch policy into the same
// workspace recovery cadence. Active leases remain fenced and keep the
// workspace queued.
func (c *IssueExecutionCoordinator) ReconcileIssueExecutions(
	ctx context.Context,
	workspaceID string,
) (IssueRunReconcileResult, error) {
	if c == nil || c.Issues == nil {
		return IssueRunReconcileResult{}, nil
	}
	if c.Issues.TuttiModeExecutions != nil {
		if _, err := c.Issues.TuttiModeExecutions.RepairRunSettlements(ctx, workspaceID); err != nil {
			return IssueRunReconcileResult{}, err
		}
	}
	if err := c.Issues.RecoverExplicitIssueRunLaunches(ctx, workspaceID); err != nil {
		return IssueRunReconcileResult{}, err
	}
	if err := c.Issues.RecoverTuttiModeRunCancelCompensations(ctx, workspaceID); err != nil {
		return IssueRunReconcileResult{}, err
	}
	if err := c.Issues.RecoverTuttiModeRunLaunches(ctx, workspaceID); err != nil {
		return IssueRunReconcileResult{}, err
	}
	result, err := c.ReconcileRunningRuns(ctx, workspaceID)
	if err != nil {
		return result, err
	}
	if c.Issues.TuttiModeExecutions != nil {
		if _, err := c.Issues.TuttiModeExecutions.RepairRunSettlements(ctx, workspaceID); err != nil {
			return result, err
		}
	}
	if err := c.Issues.RecoverEligibleIssueDispatches(ctx, workspaceID); err != nil {
		return result, err
	}
	return result, nil
}

// issueRunReconcileCompletion applies only Issue-owned product policy. Agent
// terminal state is never inferred from an activity projection; exact Turn
// settlement arrives through IssueRunSettlement.
func issueRunReconcileCompletion(run workspaceissues.Run, nowUnixMS int64) (workspaceissues.Status, string, bool) {
	if runDurationMS(run, nowUnixMS) >= defaultIssueRunMaxDuration.Milliseconds() {
		return workspaceissues.StatusFailed, "Issue run timed out.", true
	}
	return "", "", false
}

func runDurationMS(run workspaceissues.Run, nowUnixMS int64) int64 {
	startedAt := run.StartedAtUnixMS
	if startedAt <= 0 {
		startedAt = run.CreatedAtUnixMS
	}
	if startedAt <= 0 || nowUnixMS <= startedAt {
		return 0
	}
	return nowUnixMS - startedAt
}
