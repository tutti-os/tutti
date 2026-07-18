package agentsessionstore

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestSessionMessageDecodesDurableSequenceAsInternalID(t *testing.T) {
	t.Parallel()

	var message WorkspaceAgentSessionMessage
	if err := json.Unmarshal([]byte(`{
		"sequence": 42,
		"agentSessionId": "session-1",
		"messageId": "message-1",
		"role": "assistant",
		"kind": "text",
		"occurredAtUnixMs": 100,
		"version": 7
	}`), &message); err != nil {
		t.Fatal(err)
	}

	if message.ID != 42 {
		t.Fatalf("ID = %d, want sequence 42", message.ID)
	}
}

func TestSessionMessageUpdateFromActivityUpdateUsesLifecycleTimeBeforeSeq(t *testing.T) {
	t.Parallel()

	update := SessionMessageUpdateFromActivityUpdate(WorkspaceAgentMessageUpdate{
		MessageID:       "message-1",
		Seq:             42,
		TurnID:          "turn-1",
		Role:            "assistant",
		Kind:            "text",
		StartedAtUnixMS: 1717200001000,
	})

	if update.OccurredAtUnixMS != 1717200001000 {
		t.Fatalf("OccurredAtUnixMS = %d, want lifecycle timestamp", update.OccurredAtUnixMS)
	}
}

func TestReportActivityAsSessionUpdatesRejectsTurnlessMessageUpdate(t *testing.T) {
	t.Parallel()

	reporter := &captureSessionReporter{}
	_, err := ReportActivityAsSessionUpdates(context.Background(), reporter, ReportActivityInput{
		WorkspaceID: "workspace-1",
		Source: EventSource{
			AgentID: "agent-session-1",
		},
		MessageUpdates: []WorkspaceAgentMessageUpdate{{
			MessageID:        "message-1",
			Seq:              42,
			Role:             "assistant",
			Kind:             "text",
			OccurredAtUnixMS: 1717200001000,
		}},
	})

	if err == nil {
		t.Fatal("ReportActivityAsSessionUpdates() error = nil, want missing turnId error")
	}
	if !strings.Contains(err.Error(), `message_update "message-1" is missing turnId`) {
		t.Fatalf("ReportActivityAsSessionUpdates() error = %v", err)
	}
	if len(reporter.inputs) != 0 {
		t.Fatalf("ReportSessionMessages calls = %d, want 0", len(reporter.inputs))
	}
}

func TestReportActivityAsSessionUpdatesEncodesSessionAuditWithoutTurn(t *testing.T) {
	t.Parallel()
	reporter := &captureSessionReporter{}
	reply, err := ReportActivityAsSessionUpdates(context.Background(), reporter, ReportActivityInput{
		WorkspaceID: "workspace-1",
		Source:      EventSource{AgentID: "agent-session-1", SessionOrigin: WorkspaceAgentSessionOriginRuntime},
		SessionAudits: []WorkspaceAgentSessionAuditUpdate{{
			AuditID: "goal-control:op-1", Role: "user", Content: "/goal clear",
			Payload: map[string]any{"goalControl": true}, OccurredAtUnixMS: 1717200001000,
		}},
	})
	if err != nil {
		t.Fatalf("ReportActivityAsSessionUpdates() error = %v", err)
	}
	if reply.AcceptedSessionAuditCount != 1 || len(reporter.inputs) != 1 || len(reporter.inputs[0].Updates) != 1 {
		t.Fatalf("reply=%#v inputs=%#v", reply, reporter.inputs)
	}
	update := reporter.inputs[0].Updates[0]
	if update.Kind != "session_audit" || update.TurnID != "" || update.MessageID != "goal-control:op-1" {
		t.Fatalf("audit compatibility update = %#v", update)
	}
}

func TestReportActivityAsSessionUpdatesPersistsFinalMessageBeforeSettledState(t *testing.T) {
	reporter := &settlementOrderingReporter{}
	_, err := ReportActivityAsSessionUpdates(context.Background(), reporter, ReportActivityInput{
		WorkspaceID: "workspace-1",
		Source:      EventSource{AgentID: "session-1", SessionOrigin: WorkspaceAgentSessionOriginRuntime},
		SessionAudits: []WorkspaceAgentSessionAuditUpdate{{
			AuditID: "audit-1", Role: "user", Content: "audit",
		}},
		MessageUpdates: []WorkspaceAgentMessageUpdate{
			{AgentSessionID: "session-1", TurnID: "turn-1", MessageID: "assistant-first", Role: "assistant", Kind: "text", Payload: map[string]any{"text": "first"}},
			{AgentSessionID: "session-1", TurnID: "turn-1", MessageID: "assistant-final", Role: "assistant", Kind: "text", Payload: map[string]any{"text": "final"}},
		},
		StatePatches: []WorkspaceAgentStatePatch{{
			AgentSessionID: "session-1",
			Turn:           &WorkspaceAgentTurnPatch{TurnID: "turn-1", Phase: "settled", Outcome: "completed"},
		}},
	})
	if err != nil {
		t.Fatalf("ReportActivityAsSessionUpdates() error = %v", err)
	}
	if got, want := strings.Join(reporter.calls, ","), "audit,messages,state"; got != want {
		t.Fatalf("commit order = %q, want %q", got, want)
	}
	if reporter.anchor != "assistant-final" {
		t.Fatalf("settlement anchor = %q, want assistant-final", reporter.anchor)
	}
	if reporter.waitText != "final" {
		t.Fatalf("wait result at settlement visibility = %q, want final", reporter.waitText)
	}
}

type settlementOrderingReporter struct {
	calls            []string
	messagePersisted bool
	anchor           string
	persistedText    map[string]string
	waitText         string
}

func (r *settlementOrderingReporter) ReportSessionMessages(_ context.Context, input ReportSessionMessagesInput) (ReportSessionMessagesReply, error) {
	kind := "messages"
	if len(input.Updates) > 0 && input.Updates[0].Kind == "session_audit" {
		kind = "audit"
	} else {
		r.messagePersisted = true
		if r.persistedText == nil {
			r.persistedText = make(map[string]string)
		}
		for _, update := range input.Updates {
			text, _ := update.Payload["text"].(string)
			r.persistedText[update.MessageID] = text
		}
	}
	r.calls = append(r.calls, kind)
	return ReportSessionMessagesReply{AcceptedCount: len(input.Updates)}, nil
}

func (r *settlementOrderingReporter) ReportSessionState(_ context.Context, input ReportSessionStateInput) (ReportSessionStateReply, error) {
	if !r.messagePersisted {
		return ReportSessionStateReply{}, context.Canceled
	}
	r.calls = append(r.calls, "state")
	if input.State.Turn != nil {
		r.anchor = input.State.Turn.FinalAssistantMessageID
		r.waitText = r.persistedText[r.anchor]
	}
	return ReportSessionStateReply{Accepted: true}, nil
}

func TestDecodeReportActivityJSONPreservesFirstClassSessionAudit(t *testing.T) {
	t.Parallel()
	input, err := DecodeReportActivityJSON([]byte(`{"sessionAudits":[{"auditId":"audit-1","role":"user","content":"/goal clear","occurredAtUnixMs":10}]}`))
	if err != nil {
		t.Fatalf("DecodeReportActivityJSON() error = %v", err)
	}
	if len(input.SessionAudits) != 1 || input.SessionAudits[0].AuditID != "audit-1" {
		t.Fatalf("session audits = %#v", input.SessionAudits)
	}
}
