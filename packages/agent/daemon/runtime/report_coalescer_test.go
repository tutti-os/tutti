package agentruntime

import (
	"context"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	replay "github.com/tutti-os/tutti/packages/agent/session-replay"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
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

func TestStreamingReportCoalescerKeepsLatestToolOutputWithoutDroppingStartMetadata(t *testing.T) {
	t.Parallel()

	coalescer := newStreamingReportCoalescer(time.Hour)
	defer coalescer.stop()

	first := toolCallStreamingReport(1, map[string]any{
		"input": map[string]any{"command": "pnpm test"},
	})
	first.MessageUpdates[0].StartedAtUnixMS = 10
	if flushed := coalescer.add(reportRequest{ctx: context.Background(), report: first}); len(flushed) != 0 {
		t.Fatalf("first tool snapshot flushed %#v, want pending", flushed)
	}

	latest := toolCallStreamingReport(2, map[string]any{
		"output": map[string]any{"text": "tests passed"},
	})
	latest.MessageUpdates[0].StartedAtUnixMS = 20
	if flushed := coalescer.add(reportRequest{ctx: context.Background(), report: latest}); len(flushed) != 0 {
		t.Fatalf("latest tool snapshot flushed %#v, want pending", flushed)
	}

	flushed := coalescer.flushAll()
	if len(flushed) != 1 || len(flushed[0].report.MessageUpdates) != 1 {
		t.Fatalf("flushed reports = %#v, want one coalesced tool update", flushed)
	}
	update := flushed[0].report.MessageUpdates[0]
	input, _ := update.Payload["input"].(map[string]any)
	output, _ := update.Payload["output"].(map[string]any)
	if update.Seq != 2 || input["command"] != "pnpm test" || output["text"] != "tests passed" {
		t.Fatalf("tool update = %#v, want latest output with original input", update)
	}
	if update.StartedAtUnixMS != 10 {
		t.Fatalf("tool startedAtUnixMs = %d, want earliest 10", update.StartedAtUnixMS)
	}
}

func TestStreamingReportCoalescerNeverCoalescesSessionAudit(t *testing.T) {
	t.Parallel()
	coalescer := newStreamingReportCoalescer(time.Second)
	defer coalescer.stop()
	request := reportRequest{report: agentsessionstore.ReportActivityInput{
		WorkspaceID: "workspace-1", Source: canonical.EventSource{AgentID: "session-1"},
		SessionAudits: []agentsessionstore.WorkspaceAgentSessionAuditUpdate{{AuditID: "audit-1", Role: "user", OccurredAtUnixMS: 1}},
	}}
	flushed := coalescer.add(request)
	if len(flushed) != 1 || len(flushed[0].report.SessionAudits) != 1 {
		t.Fatalf("flushed = %#v", flushed)
	}
}

func TestStreamingReportCoalescerFlushesBeforeProviderObservationReport(t *testing.T) {
	t.Parallel()

	coalescer := newStreamingReportCoalescer(time.Hour)
	defer coalescer.stop()

	if flushed := coalescer.add(reportRequest{
		ctx:    context.Background(),
		report: streamingReport("assistant-message-1", 1, "hello"),
	}); len(flushed) != 0 {
		t.Fatalf("streaming add flushed %#v, want pending", flushed)
	}

	observed := toolCallStreamingReport(2, map[string]any{
		"input": map[string]any{"command": "touch /tmp/marker"},
	})
	observed.ProviderObservations = []agentsessionstore.ProviderObservationBatch{{
		RecordingID:  "recording-1",
		ConnectionID: "connection-1",
		ChunkSeq:     317,
		UnitIndex:    1,
		UnitKind:     "protocol-message",
		Events: []replay.ProviderObservationEvent{{
			EventIndex: 1,
			Type:       "call.started",
			TurnID:     "turn-1",
			CallID:     "call-1",
			Status:     "streaming",
		}},
	}}

	flushed := coalescer.add(reportRequest{
		ctx:    context.Background(),
		report: observed,
	})
	if len(flushed) != 2 {
		t.Fatalf("flushed reports = %d, want pending streaming plus observation report", len(flushed))
	}
	if flushed[0].report.MessageUpdates[0].Status != messageStreamStateStreaming {
		t.Fatalf("first flushed report = %#v, want streaming", flushed[0].report)
	}
	if len(flushed[1].report.ProviderObservations) != 1 ||
		flushed[1].report.ProviderObservations[0].ChunkSeq != 317 ||
		len(flushed[1].report.ProviderObservations[0].Events) != 1 ||
		flushed[1].report.ProviderObservations[0].Events[0].Type != "call.started" {
		t.Fatalf(
			"observation report = %#v, want preserved ProviderObservations",
			flushed[1].report.ProviderObservations,
		)
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

func toolCallStreamingReport(seq uint64, payload map[string]any) agentsessionstore.ReportActivityInput {
	return agentsessionstore.ReportActivityInput{
		WorkspaceID: "workspace-1",
		Source: canonical.EventSource{
			AgentID:       "agent-session-1",
			SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		},
		MessageUpdates: []agentsessionstore.WorkspaceAgentMessageUpdate{{
			AgentSessionID:   "agent-session-1",
			MessageID:        "tool-call-1",
			Seq:              seq,
			TurnID:           "turn-1",
			Role:             "assistant",
			Kind:             "tool_call",
			Status:           "running",
			CallID:           "call-1",
			Title:            "Bash",
			Payload:          payload,
			OccurredAtUnixMS: int64(seq),
		}},
	}
}

func messageReport(messageID string, seq uint64, status string, content string) agentsessionstore.ReportActivityInput {
	return agentsessionstore.ReportActivityInput{
		WorkspaceID: "workspace-1",
		Source: canonical.EventSource{
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
