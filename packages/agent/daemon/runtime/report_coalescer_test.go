package agentruntime

import (
	"context"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
)

func TestStreamingReportCoalescerKeepsLatestMessageSnapshot(t *testing.T) {
	t.Parallel()

	coalescer := newStreamingReportCoalescer(time.Hour)
	defer coalescer.stop()

	if flushed := coalescer.add(reportRequest{
		ctx:    context.Background(),
		report: streamingReport("assistant-message-1", 1, "hello"),
	}); len(flushed) != 0 {
		t.Fatalf("first add flushed %#v, want pending", flushed)
	}
	if flushed := coalescer.add(reportRequest{
		ctx:    context.Background(),
		report: streamingReport("assistant-message-1", 2, "hello world"),
	}); len(flushed) != 0 {
		t.Fatalf("second add flushed %#v, want pending", flushed)
	}

	flushed := coalescer.flushAll()
	if len(flushed) != 1 {
		t.Fatalf("flushed reports = %d, want 1", len(flushed))
	}
	updates := flushed[0].report.MessageUpdates
	if len(updates) != 1 {
		t.Fatalf("message updates = %#v, want one coalesced update", updates)
	}
	if updates[0].Seq != 2 || updates[0].Payload["content"] != "hello world" {
		t.Fatalf("message update = %#v, want latest snapshot", updates[0])
	}
}

func TestStreamingReportCoalescerFlushesBeforeTerminalReport(t *testing.T) {
	t.Parallel()

	coalescer := newStreamingReportCoalescer(time.Hour)
	defer coalescer.stop()

	if flushed := coalescer.add(reportRequest{
		ctx:    context.Background(),
		report: streamingReport("assistant-message-1", 1, "hello"),
	}); len(flushed) != 0 {
		t.Fatalf("streaming add flushed %#v, want pending", flushed)
	}

	flushed := coalescer.add(reportRequest{
		ctx:    context.Background(),
		report: terminalReport("assistant-message-1", 2, "hello"),
	})
	if len(flushed) != 2 {
		t.Fatalf("flushed reports = %d, want pending streaming plus terminal", len(flushed))
	}
	if flushed[0].report.MessageUpdates[0].Status != messageStreamStateStreaming {
		t.Fatalf("first flushed report = %#v, want streaming", flushed[0].report)
	}
	if flushed[1].report.MessageUpdates[0].Status != messageStreamStateCompleted {
		t.Fatalf("second flushed report = %#v, want completed", flushed[1].report)
	}
	if pending := coalescer.flushAll(); len(pending) != 0 {
		t.Fatalf("remaining pending reports = %#v, want none", pending)
	}
}

func streamingReport(messageID string, seq uint64, content string) agentsessionstore.ReportActivityInput {
	return messageReport(messageID, seq, messageStreamStateStreaming, content)
}

func terminalReport(messageID string, seq uint64, content string) agentsessionstore.ReportActivityInput {
	return messageReport(messageID, seq, messageStreamStateCompleted, content)
}

func messageReport(messageID string, seq uint64, status string, content string) agentsessionstore.ReportActivityInput {
	return agentsessionstore.ReportActivityInput{
		WorkspaceID: "workspace-1",
		Source: agentsessionstore.EventSource{
			AgentID:       "agent-session-1",
			SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		},
		MessageUpdates: []agentsessionstore.WorkspaceAgentMessageUpdate{{
			AgentSessionID: "agent-session-1",
			MessageID:      messageID,
			Seq:            seq,
			TurnID:         "turn-1",
			Role:           "assistant",
			Kind:           "text",
			Status:         status,
			Payload: map[string]any{
				"content": content,
				"source":  "runtime",
			},
			OccurredAtUnixMS: int64(seq),
		}},
	}
}
