package agentruntime

import (
	"context"
	"fmt"
	"testing"
)

func TestReportRequestQueueCoalescesStreamingSnapshotsBeforeTheyBecomeBacklog(t *testing.T) {
	t.Parallel()

	queue := newReportRequestQueue()
	const updateCount = 2048
	for seq := 1; seq <= updateCount; seq++ {
		depth := queue.enqueue(streamingRequestForSession("session-1", uint64(seq)))
		if depth != 1 {
			t.Fatalf("queue depth after streaming update %d = %d, want 1", seq, depth)
		}
	}

	depth := queue.enqueue(terminalRequestForSession("session-1", updateCount+1))
	if depth != 2 {
		t.Fatalf("queue depth after terminal = %d, want 2", depth)
	}

	streaming, ok := queue.dequeue()
	if !ok {
		t.Fatal("streaming report was not queued")
	}
	update := streaming.report.MessageUpdates[0]
	if update.Seq != updateCount || update.Payload["content"] != fmt.Sprintf("content-%d", updateCount) {
		t.Fatalf("streaming update = %#v, want latest snapshot", update)
	}

	terminal, ok := queue.dequeue()
	if !ok {
		t.Fatal("terminal report was not queued")
	}
	if status := terminal.report.MessageUpdates[0].Status; status != messageStreamStateCompleted {
		t.Fatalf("second report status = %q, want completed", status)
	}
}

func TestReportRequestQueueKeepsStreamingAfterSameSessionTerminalBehindTerminal(t *testing.T) {
	t.Parallel()

	queue := newReportRequestQueue()
	queue.enqueue(streamingRequestForSession("session-1", 1))
	queue.enqueue(terminalRequestForSession("session-1", 2))
	depth := queue.enqueue(streamingRequestForSession("session-1", 3))
	if depth != 3 {
		t.Fatalf("queue depth = %d, want 3 reports separated by the terminal barrier", depth)
	}

	wantStatuses := []string{
		messageStreamStateStreaming,
		messageStreamStateCompleted,
		messageStreamStateStreaming,
	}
	for index, wantStatus := range wantStatuses {
		request, ok := queue.dequeue()
		if !ok {
			t.Fatalf("report %d was not queued", index)
		}
		if status := request.report.MessageUpdates[0].Status; status != wantStatus {
			t.Fatalf("report %d status = %q, want %q", index, status, wantStatus)
		}
	}
}

func TestReportRequestQueueKeepsSubmitProvenanceAsSameSessionBarrier(t *testing.T) {
	t.Parallel()

	queue := newReportRequestQueue()
	queue.enqueue(streamingRequestForSession("session-1", 1))
	provenance := streamingRequestForSession("session-1", 2)
	provenance.submitProvenance = true
	provenance.done = make(chan error, 1)
	queue.enqueue(provenance)
	depth := queue.enqueue(streamingRequestForSession("session-1", 3))
	if depth != 3 {
		t.Fatalf("queue depth = %d, want streaming, provenance barrier, streaming", depth)
	}

	queue.dequeue()
	barrier, ok := queue.dequeue()
	if !ok || !barrier.submitProvenance || barrier.done == nil {
		t.Fatalf("second report = %#v, want submit provenance barrier", barrier)
	}
}

func TestReportRequestQueuePrioritizesCrossSessionBarrierWithoutReorderingSession(t *testing.T) {
	t.Parallel()

	queue := newReportRequestQueue()
	queue.enqueue(streamingRequestForSession("session-1", 1))
	barrier := terminalRequestForSession("session-2", 2)
	barrier.done = make(chan error, 1)
	queue.enqueue(barrier)

	first, ok := queue.dequeue()
	if !ok || first.report.Source.AgentID != "session-2" {
		t.Fatalf("first report = %#v, want session-2 barrier", first)
	}
	second, ok := queue.dequeue()
	if !ok || second.report.Source.AgentID != "session-1" {
		t.Fatalf("second report = %#v, want session-1 streaming report", second)
	}
}

func TestReportRequestQueueDoesNotLeapfrogEarlierSameSessionReport(t *testing.T) {
	t.Parallel()

	queue := newReportRequestQueue()
	queue.enqueue(streamingRequestForSession("session-1", 1))
	barrier := terminalRequestForSession("session-1", 2)
	barrier.done = make(chan error, 1)
	queue.enqueue(barrier)

	first, ok := queue.dequeue()
	if !ok || first.report.Source.AgentID != "session-1" || first.report.MessageUpdates[0].Status != messageStreamStateStreaming {
		t.Fatalf("first report = %#v, want earlier same-session stream", first)
	}
	second, ok := queue.dequeue()
	if !ok || second.report.MessageUpdates[0].Status != messageStreamStateCompleted {
		t.Fatalf("second report = %#v, want same-session barrier", second)
	}
}

func TestReportRequestQueueCoalescesToolOutputSnapshotsBeforeTheyBecomeBacklog(t *testing.T) {
	t.Parallel()

	queue := newReportRequestQueue()
	first := toolCallStreamingReport(1, map[string]any{
		"input": map[string]any{"command": "pnpm test"},
	})
	queue.enqueue(reportRequest{ctx: context.Background(), report: first})

	const updateCount = 2048
	for seq := 2; seq <= updateCount; seq++ {
		latest := toolCallStreamingReport(uint64(seq), map[string]any{
			"output": map[string]any{"text": fmt.Sprintf("chunk-%d", seq)},
		})
		depth := queue.enqueue(reportRequest{ctx: context.Background(), report: latest})
		if depth != 1 {
			t.Fatalf("queue depth after tool output %d = %d, want 1", seq, depth)
		}
	}

	request, ok := queue.dequeue()
	if !ok {
		t.Fatal("tool report was not queued")
	}
	update := request.report.MessageUpdates[0]
	input, _ := update.Payload["input"].(map[string]any)
	output, _ := update.Payload["output"].(map[string]any)
	if update.Seq != updateCount || input["command"] != "pnpm test" || output["text"] != "chunk-2048" {
		t.Fatalf("tool update = %#v, want latest output with original input", update)
	}
}

func TestReportRequestQueueCoalescesInterleavedSessionsIndependently(t *testing.T) {
	t.Parallel()

	queue := newReportRequestQueue()
	const updateCount = 1024
	for seq := 1; seq <= updateCount; seq++ {
		sessionID := "session-1"
		if seq%2 == 0 {
			sessionID = "session-2"
		}
		queue.enqueue(streamingRequestForSession(sessionID, uint64(seq)))
	}

	depth := queue.enqueue(terminalRequestForSession("session-1", updateCount+1))
	if depth != 3 {
		t.Fatalf("queue depth = %d, want two coalesced sessions plus terminal", depth)
	}
}

func BenchmarkReportRequestQueueInterleavedSessionBarriers(b *testing.B) {
	const sessionCount = 1024
	for iteration := 0; iteration < b.N; iteration++ {
		queue := newReportRequestQueue()
		for session := 0; session < sessionCount; session++ {
			sessionID := fmt.Sprintf("session-%d", session)
			queue.enqueue(streamingRequestForSession(sessionID, 1))
			barrier := terminalRequestForSession(sessionID, 2)
			barrier.done = make(chan error, 1)
			queue.enqueue(barrier)
		}
		for {
			if _, ok := queue.dequeue(); !ok {
				break
			}
		}
	}
}

func streamingRequestForSession(sessionID string, seq uint64) reportRequest {
	report := streamingReport("assistant-"+sessionID, seq, fmt.Sprintf("content-%d", seq))
	report.Source.AgentID = sessionID
	report.MessageUpdates[0].AgentSessionID = sessionID
	return reportRequest{ctx: context.Background(), report: report}
}

func terminalRequestForSession(sessionID string, seq int) reportRequest {
	report := terminalReport("assistant-"+sessionID, uint64(seq), fmt.Sprintf("content-%d", seq))
	report.Source.AgentID = sessionID
	report.MessageUpdates[0].AgentSessionID = sessionID
	return reportRequest{ctx: context.Background(), report: report}
}
