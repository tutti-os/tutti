package agent

import (
	"context"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	eventstreamservice "github.com/tutti-os/tutti/services/tuttid/service/eventstream"
)

func TestCancelOutboxProjectsEveryRootAndChildTurn(t *testing.T) {
	repo := &activityProjectionRepoStub{turnResults: map[string]agentactivitybiz.Turn{
		"child\x00child-turn": {
			WorkspaceID: "ws-1", AgentSessionID: "child", TurnID: "child-turn",
			Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeInterrupted,
		},
		"root\x00root-turn": {
			WorkspaceID: "ws-1", AgentSessionID: "root", TurnID: "root-turn",
			Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeCanceled,
			ErrorMessage: "context canceled",
		},
	}}
	publisher := &activityUpdatePublisherStub{}
	observer := &rootTurnObserverStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)
	projection.SetRootTurnObserver(observer)
	err := projection.PublishRuntimeOperationEvent(context.Background(), agentactivitybiz.RuntimeOperationEvent{
		WorkspaceID: "ws-1", AgentSessionID: "root",
		Kind: agentactivitybiz.RuntimeOperationEventTurnCanceled,
		Payload: map[string]any{"rootAgentSessionId": "root", "targets": []any{
			map[string]any{"agentSessionId": "child", "turnId": "child-turn", "outcome": "interrupted"},
			map[string]any{"agentSessionId": "root", "turnId": "root-turn", "outcome": "canceled"},
		}},
		CreatedAtUnixMS: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(publisher.events) != 2 || publisher.events[0].agentSessionID != "child" || publisher.events[1].agentSessionID != "root" {
		t.Fatalf("events=%#v", publisher.events)
	}
	rootTurnPayload, _ := publisher.events[1].payload["turn"].(map[string]any)
	if turnError := rootTurnPayload["error"]; turnError != nil {
		t.Fatalf("canceled root payload = %#v, want nil error", rootTurnPayload)
	}
	if len(observer.turns) != 0 {
		t.Fatalf("outbox replay re-observed committed root turns=%#v", observer.turns)
	}
}

func TestCancelOutboxReplayPublishesProviderForkBindingThroughEventstream(t *testing.T) {
	t.Parallel()

	repo := &activityProjectionRepoStub{turnResults: map[string]agentactivitybiz.Turn{
		"session-1\x00turn-1": {
			WorkspaceID:        "ws-1",
			AgentSessionID:     "session-1",
			TurnID:             "turn-1",
			Origin:             agentactivitybiz.TurnOriginUserPrompt,
			Phase:              agentactivitybiz.TurnPhaseSettled,
			Outcome:            agentactivitybiz.TurnOutcomeCanceled,
			StartedAtUnixMS:    1717200000000,
			SettledAtUnixMS:    1717200001000,
			UpdatedAtUnixMS:    1717200001000,
			RootProviderTurnID: "provider-turn-1",
		},
	}}
	service := eventstreamservice.NewService(eventstreamservice.DefaultCatalog(), nil)
	projection := NewActivityProjection(repo)
	projection.SetPublisher(eventstreamservice.AgentActivityPublisher{Service: service})

	err := projection.PublishRuntimeOperationEvent(context.Background(), agentactivitybiz.RuntimeOperationEvent{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Kind:           agentactivitybiz.RuntimeOperationEventTurnCanceled,
		Payload: map[string]any{
			"targets": []any{
				map[string]any{"agentSessionId": "session-1", "turnId": "turn-1", "outcome": "canceled"},
			},
		},
		CreatedAtUnixMS: 1717200001000,
	})
	if err != nil {
		t.Fatalf("cancel outbox replay failed eventstream validation: %v", err)
	}
}

func TestCancelOutboxProjectsRootReconciledAfterChildCancel(t *testing.T) {
	repo := &activityProjectionRepoStub{turnResults: map[string]agentactivitybiz.Turn{
		"child\x00child-turn": {
			WorkspaceID: "ws-1", AgentSessionID: "child", TurnID: "child-turn",
			Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeCanceled,
		},
		"root\x00root-turn": {
			WorkspaceID: "ws-1", AgentSessionID: "root", TurnID: "root-turn",
			Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeCompleted,
		},
	}}
	publisher := &activityUpdatePublisherStub{}
	observer := &rootTurnObserverStub{}
	projection := NewActivityProjection(repo)
	projection.SetPublisher(publisher)
	projection.SetRootTurnObserver(observer)
	err := projection.PublishRuntimeOperationEvent(context.Background(), agentactivitybiz.RuntimeOperationEvent{
		WorkspaceID: "ws-1", AgentSessionID: "child",
		Kind: agentactivitybiz.RuntimeOperationEventTurnCanceled,
		Payload: map[string]any{
			"rootAgentSessionId": "root",
			"targets": []any{
				map[string]any{"agentSessionId": "child", "turnId": "child-turn", "outcome": "canceled"},
			},
			"reconciledRoot": map[string]any{"agentSessionId": "root", "turnId": "root-turn", "outcome": "completed"},
		},
		CreatedAtUnixMS: 10,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(publisher.events) != 2 || publisher.events[0].agentSessionID != "child" || publisher.events[1].agentSessionID != "root" {
		t.Fatalf("events=%#v", publisher.events)
	}
	if len(observer.turns) != 0 {
		t.Fatalf("outbox replay re-observed committed root turns=%#v", observer.turns)
	}
}

type rootTurnObserverStub struct {
	turns []agentactivitybiz.Turn
}

func (s *rootTurnObserverStub) ObserveRootTurnSettled(_ context.Context, _ string, _ string, turn agentactivitybiz.Turn) {
	s.turns = append(s.turns, turn)
}

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

func TestEditRetryOutboxProjectsSessionReconcileForEveryDurableState(t *testing.T) {
	for _, kind := range []string{
		agentactivitybiz.RuntimeOperationEventEditRetryPending,
		agentactivitybiz.RuntimeOperationEventEditRetryRollback,
		agentactivitybiz.RuntimeOperationEventEditRetryCompleted,
		agentactivitybiz.RuntimeOperationEventEditRetryRecovery,
	} {
		t.Run(kind, func(t *testing.T) {
			publisher := &activityUpdatePublisherStub{}
			projection := NewActivityProjection(&activityProjectionRepoStub{})
			projection.SetPublisher(publisher)
			err := projection.PublishRuntimeOperationEvent(t.Context(), agentactivitybiz.RuntimeOperationEvent{
				WorkspaceID: "ws-1", AgentSessionID: "session-1",
				Kind: kind, CreatedAtUnixMS: 10,
			})
			if err != nil {
				t.Fatal(err)
			}
			if len(publisher.events) != 1 ||
				publisher.events[0].eventType != "session_reconcile_required" ||
				publisher.events[0].payload["eventType"] != "session_reconcile_required" ||
				publisher.events[0].payload["lastEventUnixMs"] != int64(10) {
				t.Fatalf("events=%#v", publisher.events)
			}
		})
	}
}
