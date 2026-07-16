package agentruntime

import (
	"context"
	"fmt"
	"sync"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
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
		Source:      agentsessionstore.EventSource{AgentID: "session-1"},
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
