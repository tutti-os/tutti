package agentruntime

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

type reentrantQueueReporter struct {
	mu          sync.Mutex
	controller  *Controller
	titles      []string
	reenterOnce sync.Once
	doneOnce    sync.Once
	done        chan struct{}
	expected    int
}

type retryingGoalObservationReporter struct {
	mu           sync.Mutex
	attempts     int
	firstFailed  chan struct{}
	allowSuccess chan struct{}
	succeeded    chan struct{}
}

type isolatingGoalObservationReporter struct {
	blockedStarted   chan struct{}
	releaseBlocked   chan struct{}
	blockedSucceeded chan struct{}
	otherSucceeded   chan struct{}
	blockedOnce      sync.Once
	blockedDoneOnce  sync.Once
	otherOnce        sync.Once
}

func (r *retryingGoalObservationReporter) Report(
	_ context.Context,
	report agentsessionstore.ReportActivityInput,
) error {
	if len(report.GoalReconcileRequests) != 1 || report.GoalReconcileRequests[0].Phase != "provider_observed" {
		return nil
	}
	r.mu.Lock()
	r.attempts++
	attempt := r.attempts
	r.mu.Unlock()
	if attempt == 1 {
		close(r.firstFailed)
		return fmt.Errorf("temporary Goal inbox failure")
	}
	<-r.allowSuccess
	select {
	case <-r.succeeded:
	default:
		close(r.succeeded)
	}
	return nil
}

func (r *retryingGoalObservationReporter) ReportSubmitProvenance(
	ctx context.Context,
	report agentsessionstore.ReportActivityInput,
) error {
	return r.Report(ctx, report)
}

func (r *isolatingGoalObservationReporter) Report(
	_ context.Context,
	report agentsessionstore.ReportActivityInput,
) error {
	if len(report.GoalReconcileRequests) != 1 || report.GoalReconcileRequests[0].Phase != "provider_observed" {
		return nil
	}
	switch report.GoalReconcileRequests[0].AgentSessionID {
	case "session-blocked":
		r.blockedOnce.Do(func() { close(r.blockedStarted) })
		select {
		case <-r.releaseBlocked:
			r.blockedDoneOnce.Do(func() { close(r.blockedSucceeded) })
			return nil
		default:
			return fmt.Errorf("blocked Session Goal inbox failure")
		}
	case "session-independent":
		r.otherOnce.Do(func() { close(r.otherSucceeded) })
	}
	return nil
}

func (r *isolatingGoalObservationReporter) ReportSubmitProvenance(
	ctx context.Context,
	report agentsessionstore.ReportActivityInput,
) error {
	return r.Report(ctx, report)
}

func (r *reentrantQueueReporter) Report(_ context.Context, report agentsessionstore.ReportActivityInput) error {
	title := report.StatePatches[0].Title
	r.mu.Lock()
	r.titles = append(r.titles, title)
	count := len(r.titles)
	r.mu.Unlock()
	r.reenterOnce.Do(func() {
		r.controller.enqueueReport(context.Background(), queuedReport("reentrant"))
	})
	if count == r.expected {
		r.doneOnce.Do(func() { close(r.done) })
	}
	return nil
}

func (r *reentrantQueueReporter) ReportSubmitProvenance(ctx context.Context, report agentsessionstore.ReportActivityInput) error {
	return r.Report(ctx, report)
}

func (r *reentrantQueueReporter) snapshot() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.titles...)
}

func queuedReport(title string) agentsessionstore.ReportActivityInput {
	return agentsessionstore.ReportActivityInput{
		WorkspaceID: "ws-1",
		Source:      canonical.EventSource{AgentID: "session-1"},
		StatePatches: []agentsessionstore.WorkspaceAgentStatePatch{{
			AgentSessionID: "session-1",
			Title:          title,
		}},
	}
}

func TestReportWorkerPreservesFIFOWhenReporterReentersBeyondFormerQueueCapacity(t *testing.T) {
	const formerQueueCapacity = 1024
	reporter := &reentrantQueueReporter{
		done:     make(chan struct{}),
		expected: formerQueueCapacity + 2,
	}
	controller := &Controller{
		reporter:    reporter,
		reportQueue: newReportRequestQueue(),
	}
	reporter.controller = controller
	for index := 0; index <= formerQueueCapacity; index++ {
		controller.enqueueReport(context.Background(), queuedReport(fmt.Sprintf("queued-%04d", index)))
	}
	go controller.runReportWorker()

	select {
	case <-reporter.done:
	case <-time.After(5 * time.Second):
		t.Fatal("report worker deadlocked after reporter re-entered a saturated queue")
	}
	titles := reporter.snapshot()
	if len(titles) != formerQueueCapacity+2 {
		t.Fatalf("report count = %d, want %d", len(titles), formerQueueCapacity+2)
	}
	for index := 0; index <= formerQueueCapacity; index++ {
		want := fmt.Sprintf("queued-%04d", index)
		if titles[index] != want {
			t.Fatalf("report %d = %q, want %q", index, titles[index], want)
		}
	}
	if titles[len(titles)-1] != "reentrant" {
		t.Fatalf("last report = %q, want reentrant report after the existing FIFO", titles[len(titles)-1])
	}
}

func TestGoalObservationWorkerRetriesUntilDurableBeforeClearingResumeGeneration(t *testing.T) {
	reporter := &retryingGoalObservationReporter{
		firstFailed: make(chan struct{}), allowSuccess: make(chan struct{}), succeeded: make(chan struct{}),
	}
	controller := NewController(nil, reporter)
	session := Session{
		RoomID: "room-goal-observation", AgentSessionID: "session-goal-observation",
		Provider: ProviderClaudeCode, ProviderSessionID: "provider-session",
		GoalGeneration: &GoalRuntimeGeneration{
			OperationID: "goal-op-1", Revision: 3, RepairEpoch: 1, ActivatedAtUnixMS: 10,
			Goal: map[string]any{"objective": "ship it", "status": "active"},
		},
	}
	controller.store(session)
	eventContext, ok := activityEventContext(session, "goal-complete", "")
	if !ok {
		t.Fatal("Goal event context unavailable")
	}
	controller.enqueueSessionReport(context.Background(), session, []activityshared.Event{
		activityshared.NewGoalProviderObserved(eventContext, map[string]any{
			"operationId": "goal-op-1", "revision": int64(3), "repairEpoch": int64(1),
			"source": "transcript_mirror", "updateType": "thread_goal_completed",
			"goal": map[string]any{"objective": "ship it", "status": "complete"},
		}),
	})

	select {
	case <-reporter.firstFailed:
	case <-time.After(2 * time.Second):
		t.Fatal("Goal observation was not attempted")
	}
	if current, ok := controller.Session(session.RoomID, session.AgentSessionID); !ok || current.GoalGeneration == nil {
		t.Fatalf("Goal generation cleared before durable admission: %#v", current.GoalGeneration)
	}
	close(reporter.allowSuccess)
	select {
	case <-reporter.succeeded:
	case <-time.After(3 * time.Second):
		t.Fatal("Goal observation was not retried")
	}
	deadline := time.Now().Add(time.Second)
	for {
		current, ok := controller.Session(session.RoomID, session.AgentSessionID)
		if ok && current.GoalGeneration == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("Goal generation remained after durable admission: %#v", current.GoalGeneration)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestGoalObservationRetryIsIsolatedPerSession(t *testing.T) {
	reporter := &isolatingGoalObservationReporter{
		blockedStarted: make(chan struct{}), releaseBlocked: make(chan struct{}),
		blockedSucceeded: make(chan struct{}), otherSucceeded: make(chan struct{}),
	}
	controller := NewController(nil, reporter)
	enqueueCompletedGoal := func(sessionID string) {
		session := Session{
			RoomID: "room-goal-isolation", AgentSessionID: sessionID,
			Provider: ProviderClaudeCode, ProviderSessionID: "provider-" + sessionID,
			GoalGeneration: &GoalRuntimeGeneration{
				OperationID: "goal-op-" + sessionID, Revision: 3, RepairEpoch: 1, ActivatedAtUnixMS: 10,
				Goal: map[string]any{"objective": "ship it", "status": "active"},
			},
		}
		controller.store(session)
		eventContext, ok := activityEventContext(session, "goal-complete-"+sessionID, "")
		if !ok {
			t.Fatalf("Goal event context unavailable for %s", sessionID)
		}
		controller.enqueueSessionReport(context.Background(), session, []activityshared.Event{
			activityshared.NewGoalProviderObserved(eventContext, map[string]any{
				"operationId": "goal-op-" + sessionID, "revision": int64(3), "repairEpoch": int64(1),
				"source": "transcript_mirror", "updateType": "thread_goal_completed",
				"goal": map[string]any{"objective": "ship it", "status": "complete"},
			}),
		})
	}

	enqueueCompletedGoal("session-blocked")
	select {
	case <-reporter.blockedStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("blocked Session observation was not attempted")
	}
	enqueueCompletedGoal("session-independent")
	select {
	case <-reporter.otherSucceeded:
	case <-time.After(2 * time.Second):
		t.Fatal("one Session retry blocked an independent Session observation")
	}
	close(reporter.releaseBlocked)
	select {
	case <-reporter.blockedSucceeded:
	case <-time.After(2 * time.Second):
		t.Fatal("blocked Session observation did not resume")
	}
}
