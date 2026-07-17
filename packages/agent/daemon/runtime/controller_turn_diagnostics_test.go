package agentruntime

import (
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestAgentSubmitRuntimeEventSummaryAggregatesEmissionBatches(t *testing.T) {
	var summary agentSubmitRuntimeEventSummary
	summary.observe([]activityshared.Event{
		{Type: activityshared.EventMessageAppended},
		{Type: activityshared.EventMessageAppended},
	}, Session{Status: SessionStatusWorking})
	summary.observe([]activityshared.Event{
		{Type: activityshared.EventTurnCompleted},
	}, Session{Status: SessionStatusReady})

	if summary.batchCount != 2 {
		t.Fatalf("batch count = %d, want 2", summary.batchCount)
	}
	if summary.activityEventCount != 3 {
		t.Fatalf("activity event count = %d, want 3", summary.activityEventCount)
	}
	if got := summary.eventTypeCounts[string(activityshared.EventMessageAppended)]; got != 2 {
		t.Fatalf("message update count = %d, want 2", got)
	}
	if got := summary.eventTypeCounts[string(activityshared.EventTurnCompleted)]; got != 1 {
		t.Fatalf("turn completed count = %d, want 1", got)
	}
	if summary.lastSessionStatus != string(SessionStatusReady) {
		t.Fatalf("last session status = %q, want %q", summary.lastSessionStatus, SessionStatusReady)
	}
}
