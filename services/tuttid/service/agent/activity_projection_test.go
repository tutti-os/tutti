package agent

import (
	"context"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func TestActivityProjectionDerivesActivityOnlyFromActiveTurnReference(t *testing.T) {
	tests := []struct {
		name    string
		session agentactivitybiz.Session
		want    string
	}{
		{
			name:    "active turn",
			session: agentactivitybiz.Session{ActiveTurnID: "turn-1"},
			want:    "running",
		},
		{
			name:    "no active turn",
			session: agentactivitybiz.Session{},
			want:    "ready",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := agentActivitySessionStatus(tt.session); got != tt.want {
				t.Fatalf("agentActivitySessionStatus() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestActivityProjectionPublishesSessionUpdateForUnappliedStatePatch(t *testing.T) {
	repo := &activityProjectionRepoStub{
		stateResult: agentactivitybiz.StateReportResult{
			Accepted:        true,
			StateApplied:    false,
			LastEventUnixMS: 200,
			Session: agentactivitybiz.Session{
				ID:              "session-1",
				WorkspaceID:     "ws-1",
				LastEventUnixMS: 200,
			},
		},
	}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)

	reply, err := projection.ReportSessionState(context.Background(), canonical.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			LifecycleStatus:  "active",
			CurrentPhase:     "working",
			OccurredAtUnixMS: 150,
		},
	})
	if err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if !reply.Accepted || reply.StateApplied {
		t.Fatalf("reply = %#v, want accepted unapplied state", reply)
	}
	if len(publisher.events) != 1 {
		t.Fatalf("published events = %d, want 1", len(publisher.events))
	}
	event := publisher.events[0]
	if event.eventType != "session_reconcile_required" {
		t.Fatalf("published event type = %q, want session_reconcile_required", event.eventType)
	}
	if got := event.payload["eventType"]; got != "session_reconcile_required" {
		t.Fatalf("payload eventType = %#v, want session_reconcile_required", got)
	}
	if got := event.payload["lastEventUnixMs"]; got != int64(200) {
		t.Fatalf("payload lastEventUnixMs = %#v, want 200", got)
	}
	if _, ok := event.payload["lifecycleStatus"]; ok {
		t.Fatalf("payload contains stale lifecycleStatus: %#v", event.payload)
	}
}

func TestActivityProjectionUsesExplicitTitle(t *testing.T) {
	repo := &activityProjectionRepoStub{
		stateResult: agentactivitybiz.StateReportResult{
			Accepted:        true,
			StateApplied:    true,
			LastEventUnixMS: 200,
		},
	}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)

	_, err := projection.ReportSessionState(context.Background(), canonical.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			Title:            "Automation Review",
			LifecycleStatus:  "failed",
			CurrentPhase:     "failed",
			OccurredAtUnixMS: 150,
		},
	})
	if err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if got := repo.stateInput.Title; got != "Automation Review" {
		t.Fatalf("reported title = %q, want runtime context title", got)
	}
	if len(publisher.events) != 1 {
		t.Fatalf("published events = %d, want 1", len(publisher.events))
	}
	if got := publisher.events[0].eventType; got != "session_reconcile_required" {
		t.Fatalf("published event type = %q, want reconciliation invalidation", got)
	}
}

func TestActivityProjectionReportsFailedRuntimeNodeResult(t *testing.T) {
	repo := &activityProjectionRepoStub{
		stateResult: agentactivitybiz.StateReportResult{
			Accepted:        true,
			StateApplied:    true,
			LastEventUnixMS: 200,
		},
	}
	reporter := &recordingAgentAnalyticsReporter{}
	projection := NewActivityProjection(repo)
	projection.SetAnalyticsReporter(reporter)

	_, err := projection.ReportSessionState(context.Background(), canonical.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Source: canonical.EventSource{
			Provider: "codex",
		},
		State: canonical.WorkspaceAgentSessionStateUpdate{
			LifecycleStatus: "failed",
			LastError:       "network connection disconnected",
		},
	})
	if err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if len(reporter.events) != 1 {
		t.Fatalf("analytics events = %d, want 1", len(reporter.events))
	}
	event := reporter.events[0]
	if event.Name != "agent.node_result" {
		t.Fatalf("event name = %q, want agent.node_result", event.Name)
	}
	for key, want := range map[string]any{
		"agent_session_id": "session-1",
		"flow":             "runtime_activity",
		"node":             "runtime_exec",
		"error_code":       "agent_runtime_network_disconnected",
		"error_message":    "network connection disconnected",
		"node_name":        "runtime_exec",
		"provider":         "codex",
		"status":           "failure",
		"success":          false,
	} {
		if got := event.Params[key]; got != want {
			t.Fatalf("params[%q] = %#v, want %#v in %#v", key, got, want, event.Params)
		}
	}
}

func TestActivityProjectionSkipsFailedRuntimeNodeResultWhenStateNotApplied(t *testing.T) {
	repo := &activityProjectionRepoStub{
		stateResult: agentactivitybiz.StateReportResult{
			Accepted:        true,
			StateApplied:    false,
			LastEventUnixMS: 200,
		},
	}
	reporter := &recordingAgentAnalyticsReporter{}
	projection := NewActivityProjection(repo)
	projection.SetAnalyticsReporter(reporter)

	_, err := projection.ReportSessionState(context.Background(), canonical.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Source: canonical.EventSource{
			Provider: "codex",
		},
		State: canonical.WorkspaceAgentSessionStateUpdate{
			LifecycleStatus:  "failed",
			LastError:        "network connection disconnected",
			OccurredAtUnixMS: 150,
		},
	})
	if err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if len(reporter.events) != 0 {
		t.Fatalf("analytics events = %d, want 0: %#v", len(reporter.events), reporter.events)
	}
}

func TestActivityProjectionPublishesCanonicalSessionIDForMessageUpdates(t *testing.T) {
	repo := &activityProjectionRepoStub{
		messageResult: agentactivitybiz.MessageReportResult{
			AcceptedCount: 1,
			LatestVersion: 1,
			Messages: []agentactivitybiz.Message{{
				AgentSessionID: "session-1",
				MessageID:      "message-1",
				Version:        1,
				TurnID:         "turn-1",
				Role:           "assistant",
				Kind:           "text",
				Status:         "completed",
				Payload:        map[string]any{"text": "hello"},
			}},
		},
	}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)

	reply, err := projection.ReportSessionMessages(context.Background(), canonical.ReportSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "provider-session-1",
		SessionOrigin:  agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Source: canonical.EventSource{
			Provider:          "codex",
			ProviderSessionID: "provider-session-1",
		},
		Updates: []canonical.WorkspaceAgentSessionMessageUpdate{{
			MessageID: "message-1",
			Role:      "assistant",
			Kind:      "text",
			Status:    "completed",
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if reply.AcceptedCount != 1 {
		t.Fatalf("reply = %#v, want accepted message", reply)
	}
	if repo.messageInput.Provider != "codex" {
		t.Fatalf("repo message provider = %q, want codex", repo.messageInput.Provider)
	}
	if len(publisher.events) != 1 {
		t.Fatalf("published events = %d, want 1", len(publisher.events))
	}
	event := publisher.events[0]
	if event.agentSessionID != "session-1" {
		t.Fatalf("published agentSessionID = %q, want session-1", event.agentSessionID)
	}
	if event.payload["agentSessionId"] != "session-1" {
		t.Fatalf("payload agentSessionId = %#v, want session-1", event.payload["agentSessionId"])
	}
}

func TestActivityProjectionPublishesSessionAuditOutsideMessageUpdate(t *testing.T) {
	repo := &activityProjectionRepoStub{messageResult: agentactivitybiz.MessageReportResult{
		AcceptedCount: 1, LatestVersion: 4,
		Messages: []agentactivitybiz.Message{{
			AgentSessionID: "session-audit", MessageID: "goal-control:op-1", Version: 4,
			Role: "user", Kind: "session_audit", Payload: map[string]any{"text": "/goal clear"}, OccurredAtUnixMS: 123,
		}},
	}}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)
	reply, err := projection.ReportSessionMessages(context.Background(), canonical.ReportSessionMessagesInput{
		WorkspaceID: "ws-audit", AgentSessionID: "session-audit", SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Source:  canonical.EventSource{Provider: "codex"},
		Updates: []canonical.WorkspaceAgentSessionMessageUpdate{{MessageID: "goal-control:op-1", Role: "user", Kind: "session_audit", OccurredAtUnixMS: 123}},
	})
	if err != nil || reply.AcceptedCount != 1 {
		t.Fatalf("ReportSessionMessages() reply=%#v error=%v", reply, err)
	}
	if len(publisher.events) != 1 || publisher.events[0].eventType != "session_audit" {
		t.Fatalf("published events = %#v", publisher.events)
	}
	if publisher.events[0].payload["eventType"] != "session_audit" {
		t.Fatalf("audit payload = %#v", publisher.events[0].payload)
	}
}

func TestActivityProjectionPreservesMixedMessageAuditOrder(t *testing.T) {
	repo := &activityProjectionRepoStub{messageResult: agentactivitybiz.MessageReportResult{
		AcceptedCount: 3, LatestVersion: 3,
		Messages: []agentactivitybiz.Message{
			{AgentSessionID: "session-order", MessageID: "message-1", Version: 1, TurnID: "turn-1", Role: "assistant", Kind: "text", Payload: map[string]any{}, OccurredAtUnixMS: 1},
			{AgentSessionID: "session-order", MessageID: "audit-1", Version: 2, Role: "user", Kind: "session_audit", Payload: map[string]any{}, OccurredAtUnixMS: 2},
			{AgentSessionID: "session-order", MessageID: "message-2", Version: 3, TurnID: "turn-1", Role: "assistant", Kind: "text", Payload: map[string]any{}, OccurredAtUnixMS: 3},
		},
	}}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)
	_, err := projection.ReportSessionMessages(context.Background(), canonical.ReportSessionMessagesInput{
		WorkspaceID: "ws-order", AgentSessionID: "session-order", SessionOrigin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Source:  canonical.EventSource{Provider: "codex"},
		Updates: []canonical.WorkspaceAgentSessionMessageUpdate{{MessageID: "message-1", TurnID: "turn-1", Role: "assistant", Kind: "text"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(publisher.events) != 3 || publisher.events[0].eventType != "message_update" || publisher.events[1].eventType != "session_audit" || publisher.events[2].eventType != "message_update" {
		t.Fatalf("published order = %#v", publisher.events)
	}
	if publisher.events[0].payload["latestVersion"] != uint64(1) || publisher.events[2].payload["latestVersion"] != uint64(3) {
		t.Fatalf("message run cursors = %#v", publisher.events)
	}
}
