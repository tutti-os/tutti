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

type IssueRunReconcileQueue struct {
	mu        sync.Mutex
	pending   map[string]struct{}
	active    bool
	ctx       context.Context
	delay     time.Duration
	interval  time.Duration
	reconcile func(context.Context, string) (IssueRunReconcileResult, error)
}

type IssueRunReconcileQueueOptions struct {
	Context   context.Context
	Delay     time.Duration
	Interval  time.Duration
	Reconcile func(context.Context, string) (IssueRunReconcileResult, error)
}

func NewIssueRunReconcileQueue(options IssueRunReconcileQueueOptions) *IssueRunReconcileQueue {
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
	return &IssueRunReconcileQueue{
		pending:   make(map[string]struct{}),
		ctx:       queueContext,
		delay:     delay,
		interval:  interval,
		reconcile: options.Reconcile,
	}
}

func (q *IssueRunReconcileQueue) Enqueue(workspaceID string) {
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

func (q *IssueRunReconcileQueue) loop(nextDelay time.Duration) {
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
			if err != nil || result.RunningCount > result.CompletedCount {
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
	for _, run := range runs {
		if c.SettlementReader != nil && strings.TrimSpace(run.AgentSessionID) != "" {
			settlement, found, readErr := c.SettlementReader.ReadRunSettlement(
				ctx,
				run.WorkspaceID,
				run.AgentSessionID,
				"issue-run:"+run.RunID,
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
