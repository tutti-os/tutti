package workspace

import (
	"context"
	"strings"
	"sync"
	"time"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

const (
	defaultIssueRunReconcileDelay    = 3 * time.Second
	defaultIssueRunReconcileInterval = 15 * time.Second
	defaultIssueRunReconcileGrace    = 30 * time.Second
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
	delay     time.Duration
	interval  time.Duration
	reconcile func(context.Context, string) (IssueRunReconcileResult, error)
}

type IssueRunReconcileQueueOptions struct {
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
	return &IssueRunReconcileQueue{
		pending:   make(map[string]struct{}),
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
		time.Sleep(nextDelay)
		workspaces := q.drainPending()
		if len(workspaces) == 0 {
			q.mu.Lock()
			q.active = false
			q.mu.Unlock()
			return
		}
		requeue := make([]string, 0)
		for _, workspaceID := range workspaces {
			result, err := q.reconcile(context.Background(), workspaceID)
			if err == nil && result.RunningCount > result.CompletedCount {
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

func (q *IssueRunReconcileQueue) drainPending() []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	workspaces := make([]string, 0, len(q.pending))
	for workspaceID := range q.pending {
		workspaces = append(workspaces, workspaceID)
		delete(q.pending, workspaceID)
	}
	return workspaces
}

func (s IssueManagerService) ReconcileRunningRuns(ctx context.Context, workspaceID string) (IssueRunReconcileResult, error) {
	workspaceID = strings.TrimSpace(workspaceID)
	if workspaceID == "" || s.AgentSessionReader == nil {
		return IssueRunReconcileResult{}, nil
	}
	runs, err := s.domainService().ListRunningRuns(ctx, workspaceID, defaultIssueRunReconcileLimit)
	if err != nil {
		return IssueRunReconcileResult{}, err
	}
	result := IssueRunReconcileResult{RunningCount: len(runs)}
	if len(runs) == 0 {
		return result, nil
	}
	sessions, _ := s.AgentSessionReader.ListSessions(workspaceID)
	sessionByID := make(map[string]agentservice.PersistedSession, len(sessions))
	for _, session := range sessions {
		sessionByID[strings.TrimSpace(session.ID)] = session
	}
	now := time.Now().UnixMilli()
	for _, run := range runs {
		status, errorMessage, ok := issueRunReconcileCompletion(run, sessionByID[strings.TrimSpace(run.AgentSessionID)], now)
		if !ok {
			continue
		}
		if _, err := s.CompleteRun(ctx, run.WorkspaceID, run.IssueID, run.TaskID, run.RunID, CompleteIssueManagerRunInput{
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

func issueRunReconcileCompletion(run workspaceissues.Run, session agentservice.PersistedSession, nowUnixMS int64) (workspaceissues.Status, string, bool) {
	if runDurationMS(run, nowUnixMS) >= defaultIssueRunMaxDuration.Milliseconds() {
		return workspaceissues.StatusFailed, "Issue run timed out.", true
	}
	if strings.TrimSpace(session.ID) == "" {
		if runIdleMS(run, nowUnixMS) >= defaultIssueRunReconcileGrace.Milliseconds() {
			return workspaceissues.StatusFailed, "Agent session disappeared before run completion.", true
		}
		return "", "", false
	}
	if strings.TrimSpace(session.ActiveTurnID) != "" {
		return "", "", false
	}
	// The persisted active turn id lags the runtime (it is stamped
	// asynchronously and can stay empty for a session created with an initial
	// prompt), so an empty value is not proof of idleness. A session that
	// streamed an event within the grace window is alive — reconciling here
	// used to kill healthy runs seconds after their last stream chunk.
	if session.LastEventUnixMS > 0 &&
		nowUnixMS-session.LastEventUnixMS < defaultIssueRunReconcileGrace.Milliseconds() {
		return "", "", false
	}
	if runIdleMS(run, nowUnixMS) >= defaultIssueRunReconcileGrace.Milliseconds() {
		return workspaceissues.StatusFailed, "Agent session ended without reporting run completion.", true
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

func runIdleMS(run workspaceissues.Run, nowUnixMS int64) int64 {
	updatedAt := run.UpdatedAtUnixMS
	if updatedAt <= 0 {
		updatedAt = run.StartedAtUnixMS
	}
	if updatedAt <= 0 {
		updatedAt = run.CreatedAtUnixMS
	}
	if updatedAt <= 0 || nowUnixMS <= updatedAt {
		return 0
	}
	return nowUnixMS - updatedAt
}
