package agent

import (
	"context"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestPlanDecisionOutboxProjectsConfirmedTurn(t *testing.T) {
	repo := &activityProjectionRepoStub{
		turnFound: true,
		turnResult: agentactivitybiz.Turn{
			WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "implementation-turn",
			Phase: agentactivitybiz.TurnPhaseSubmitted,
		},
		messagePageOK: true,
		messagePage: agentactivitybiz.MessagePage{
			AgentSessionID: "session-1",
			LatestVersion:  8,
			Messages: []agentactivitybiz.Message{{
				AgentSessionID: "session-1", MessageID: "notice-1", Version: 8,
				Role: "system", Kind: "system", Status: "completed",
				Payload: map[string]any{
					"kind": "agent_system_notice", "noticeKind": "plan_implementation_completed",
					"severity": "info", "retryable": false,
				},
			}},
		},
	}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)
	err := projection.PublishRuntimeOperationEvent(context.Background(), agentactivitybiz.RuntimeOperationEvent{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
		Kind:            agentactivitybiz.RuntimeOperationEventPlanDecisionCompleted,
		Payload:         map[string]any{"confirmedTurnId": "implementation-turn", "noticeMessageId": "notice-1"},
		CreatedAtUnixMS: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(publisher.events) != 2 || publisher.events[0].eventType != "turn_update" ||
		publisher.events[0].workspaceID != "ws-1" || publisher.events[0].agentSessionID != "session-1" {
		t.Fatalf("events=%#v", publisher.events)
	}
	if publisher.events[1].eventType != "message_update" || publisher.events[1].payload["latestVersion"] != uint64(8) {
		t.Fatalf("message event=%#v", publisher.events[1])
	}
	messages, ok := publisher.events[1].payload["messages"].([]map[string]any)
	if !ok || len(messages) != 1 || messages[0]["messageId"] != "notice-1" || messages[0]["status"] != "completed" {
		t.Fatalf("message payload=%#v", publisher.events[1].payload)
	}
}

func TestPlanDecisionPendingOutboxProjectsDurableNoticeBeforeCompletion(t *testing.T) {
	repo := &activityProjectionRepoStub{
		messagePageOK: true,
		messagePage: agentactivitybiz.MessagePage{
			AgentSessionID: "session-1", LatestVersion: 7,
			Messages: []agentactivitybiz.Message{{
				AgentSessionID: "session-1", MessageID: "notice-1", Version: 7,
				Role: "system", Kind: "system", Status: "running",
				Payload: map[string]any{
					"kind": "agent_system_notice", "noticeKind": "plan_implementation_pending_confirmation",
					"severity": "warning", "retryable": false,
				},
			}},
		},
	}
	publisher := &activityUpdatePublisherStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)
	err := projection.PublishRuntimeOperationEvent(context.Background(), agentactivitybiz.RuntimeOperationEvent{
		WorkspaceID: "ws-1", AgentSessionID: "session-1",
		Kind:    agentactivitybiz.RuntimeOperationEventPlanDecisionPending,
		Payload: map[string]any{"noticeMessageId": "notice-1"}, CreatedAtUnixMS: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(publisher.events) != 1 || publisher.events[0].eventType != "message_update" ||
		publisher.events[0].payload["latestVersion"] != uint64(7) {
		t.Fatalf("events=%#v", publisher.events)
	}
}
