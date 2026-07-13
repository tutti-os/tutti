package agent

import (
	"context"
	"errors"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestPlanDecisionDuplicateAndDelayedConfirmationNeverResend(t *testing.T) {
	now := time.UnixMilli(1_000)
	service, runtime, store := planDecisionTestService(now)
	input := SubmitPlanDecisionInput{PromptKind: "plan-implementation", Action: "implement", IdempotencyKey: "decision-1"}

	first, err := service.SubmitPlanDecision(context.Background(), "ws-1", "session-1", "plan-turn", "plan-turn", input)
	if err != nil || first.OperationID == "" || first.Status != agentactivitybiz.RuntimeOperationStatusPrepared {
		t.Fatalf("first operation=%#v err=%v", first, err)
	}
	duplicate, err := service.SubmitPlanDecision(context.Background(), "ws-1", "session-1", "plan-turn", "plan-turn", input)
	if err != nil || duplicate.OperationID != first.OperationID {
		t.Fatalf("duplicate operation=%#v err=%v", duplicate, err)
	}
	if len(runtime.execCalls) != 1 || len(runtime.updateSettingsCalls) != 1 {
		t.Fatalf("duplicate calls exec=%d settings=%d", len(runtime.execCalls), len(runtime.updateSettingsCalls))
	}

	store.confirmedTurnID = "implementation-turn"
	now = now.Add(2 * time.Second)
	service.RuntimeOperationClock = func() time.Time { return now }
	if err := service.StepRuntimeOperationWorker(context.Background(), false); err != nil {
		t.Fatalf("worker error=%v", err)
	}
	if store.operation.Status != agentactivitybiz.RuntimeOperationStatusCompleted || len(runtime.execCalls) != 1 {
		t.Fatalf("completed operation=%#v exec=%d", store.operation, len(runtime.execCalls))
	}
}

func TestPlanDecisionSendErrorStaysUnknownAndRecoveryDoesNotResend(t *testing.T) {
	now := time.UnixMilli(1_000)
	service, runtime, store := planDecisionTestService(now)
	runtime.execErr = errors.New("connection dropped after dispatch")
	input := SubmitPlanDecisionInput{PromptKind: "plan-implementation", Action: "implement", IdempotencyKey: "decision-1"}
	operation, err := service.SubmitPlanDecision(context.Background(), "ws-1", "session-1", "plan-turn", "plan-turn", input)
	if err != nil || operation.Status != agentactivitybiz.RuntimeOperationStatusPrepared || payloadText(operation.Payload, "step") != "send_dispatched" {
		t.Fatalf("operation=%#v err=%v", operation, err)
	}
	runtime.execErr = nil
	now = now.Add(2 * time.Second)
	service.RuntimeOperationClock = func() time.Time { return now }
	if err := service.StepRuntimeOperationWorker(context.Background(), false); err != nil {
		t.Fatalf("unconfirmed worker error=%v", err)
	}
	if len(runtime.execCalls) != 1 {
		t.Fatalf("exec calls=%d, want no blind resend", len(runtime.execCalls))
	}
	store.confirmedTurnID = "implementation-turn"
	now = now.Add(3 * time.Second)
	service.RuntimeOperationClock = func() time.Time { return now }
	if err := service.StepRuntimeOperationWorker(context.Background(), false); err != nil {
		t.Fatalf("confirmed worker error=%v", err)
	}
	if store.operation.Status != agentactivitybiz.RuntimeOperationStatusCompleted || len(runtime.execCalls) != 1 {
		t.Fatalf("operation=%#v exec=%d", store.operation, len(runtime.execCalls))
	}
}

func TestPlanDecisionSettingsCheckpointCrashRepeatsOnlyIdempotentSetting(t *testing.T) {
	now := time.UnixMilli(1_000)
	service, runtime, store := planDecisionTestService(now)
	store.checkpointErr = errors.New("checkpoint unavailable")
	input := SubmitPlanDecisionInput{PromptKind: "plan-implementation", Action: "implement", IdempotencyKey: "decision-1"}
	if _, err := service.SubmitPlanDecision(context.Background(), "ws-1", "session-1", "plan-turn", "plan-turn", input); err == nil {
		t.Fatal("checkpoint error=nil")
	}
	if len(runtime.updateSettingsCalls) != 1 || len(runtime.execCalls) != 0 || store.operation.Status != agentactivitybiz.RuntimeOperationStatusLeased {
		t.Fatalf("after crash settings=%d exec=%d operation=%#v", len(runtime.updateSettingsCalls), len(runtime.execCalls), store.operation)
	}
	now = now.Add(runtimeOperationLeaseDuration)
	service.RuntimeOperationClock = func() time.Time { return now }
	if err := service.StepRuntimeOperationWorker(context.Background(), true); err != nil {
		t.Fatalf("recovery error=%v", err)
	}
	if len(runtime.updateSettingsCalls) != 2 || len(runtime.execCalls) != 1 {
		t.Fatalf("recovery settings=%d exec=%d", len(runtime.updateSettingsCalls), len(runtime.execCalls))
	}
}

func TestPlanDecisionRejectsUnsupportedProviderAndIdentityMismatch(t *testing.T) {
	if err := validatePlanDecisionStrategy("claude-code", SubmitPlanDecisionInput{
		PromptKind: "plan-implementation", Action: "implement", IdempotencyKey: "decision-1",
	}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("unsupported provider error=%v", err)
	}
	now := time.UnixMilli(1_000)
	service, _, _ := planDecisionTestService(now)
	input := SubmitPlanDecisionInput{PromptKind: "plan-implementation", Action: "implement", IdempotencyKey: "decision-1"}
	if _, err := service.SubmitPlanDecision(context.Background(), "ws-1", "session-1", "plan-turn", "plan-turn", input); err != nil {
		t.Fatal(err)
	}
	if _, err := service.SubmitPlanDecision(context.Background(), "ws-1", "session-1", "other-turn", "plan-turn", input); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("turn/request mismatch error=%v", err)
	}
	if _, err := service.SubmitPlanDecision(context.Background(), "ws-1", "session-1", "plan-turn", "request-other", input); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("request mismatch error=%v", err)
	}
	differentKey := input
	differentKey.IdempotencyKey = "decision-other"
	if _, err := service.SubmitPlanDecision(context.Background(), "ws-1", "session-1", "plan-turn", "plan-turn", differentKey); !errors.Is(err, agentactivitybiz.ErrRuntimeOperationConflict) {
		t.Fatalf("same turn different key error=%v", err)
	}
}

func TestPlanDecisionTerminalFailedRetryReturnsScopedOperation(t *testing.T) {
	now := time.UnixMilli(1_000)
	service, _, store := planDecisionTestService(now)
	input := SubmitPlanDecisionInput{PromptKind: "plan-implementation", Action: "implement", IdempotencyKey: "decision-1"}
	operationID := runtimeOperationID("ws-1", "session-1", agentactivitybiz.RuntimeOperationKindPlanDecision, "plan-turn")
	store.operation = agentactivitybiz.RuntimeOperation{
		OperationID: operationID, WorkspaceID: "ws-1", AgentSessionID: "session-1",
		TurnID: "plan-turn", RequestID: "plan-turn", Kind: agentactivitybiz.RuntimeOperationKindPlanDecision,
		Status: agentactivitybiz.RuntimeOperationStatusFailed, Result: agentactivitybiz.RuntimeOperationResultFailed,
		Payload: map[string]any{
			"promptKind": "plan-implementation", "action": "implement", "idempotencyKey": "decision-1",
			"clientSubmitId": "plan-decision:" + operationID, "step": "prepared",
		},
	}
	result, err := service.SubmitPlanDecision(context.Background(), "ws-1", "session-1", "plan-turn", "plan-turn", input)
	if err != nil || result.OperationID != operationID || result.Status != agentactivitybiz.RuntimeOperationStatusFailed {
		t.Fatalf("result=%#v err=%v", result, err)
	}
}

func TestPlanDecisionOutboxPublishFailureReplaysWithoutRollingBackCompletion(t *testing.T) {
	now := time.UnixMilli(1_000)
	service, _, store := planDecisionTestService(now)
	result, err := service.SubmitPlanDecision(context.Background(), "ws-1", "session-1", "plan-turn", "plan-turn", SubmitPlanDecisionInput{
		PromptKind: "plan-implementation", Action: "implement", IdempotencyKey: "decision-1",
	})
	if err != nil || result.Status != agentactivitybiz.RuntimeOperationStatusPrepared || len(store.events) != 1 ||
		store.events[0].Kind != agentactivitybiz.RuntimeOperationEventPlanDecisionPending {
		t.Fatalf("pending result=%#v events=%#v err=%v", result, store.events, err)
	}
	store.confirmedTurnID = "implementation-turn"
	now = now.Add(2 * time.Second)
	service.RuntimeOperationClock = func() time.Time { return now }
	service.RuntimeOperationEventPublisher = runtimeOperationFailingPublisher{err: errors.New("event unavailable")}
	if err := service.StepRuntimeOperationWorker(context.Background(), false); err == nil {
		t.Fatal("publish failure error=nil")
	}
	if store.operation.Status != agentactivitybiz.RuntimeOperationStatusCompleted || len(store.events) != 2 ||
		store.events[0].Kind != agentactivitybiz.RuntimeOperationEventPlanDecisionPending ||
		store.events[1].Kind != agentactivitybiz.RuntimeOperationEventPlanDecisionCompleted ||
		store.events[0].PublishedAtUnixMS != 0 || store.events[1].PublishedAtUnixMS != 0 {
		t.Fatalf("operation=%#v events=%#v", store.operation, store.events)
	}
	publisher := &planDecisionRecordingPublisher{}
	service.RuntimeOperationEventPublisher = publisher
	if err := service.StepRuntimeOperationWorker(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if publisher.calls != 2 || store.events[0].PublishedAtUnixMS == 0 || store.events[1].PublishedAtUnixMS == 0 {
		t.Fatalf("publisher calls=%d events=%#v", publisher.calls, store.events)
	}
}

func TestPlanDecisionRecoveryResumesDurableSessionBeforeSettings(t *testing.T) {
	now := time.UnixMilli(1_000)
	runtime := newFakeRuntime()
	operationID := runtimeOperationID("ws-1", "session-1", agentactivitybiz.RuntimeOperationKindPlanDecision, "plan-turn")
	store := &runtimeOperationMemoryStore{operation: agentactivitybiz.RuntimeOperation{
		OperationID: operationID, WorkspaceID: "ws-1", AgentSessionID: "session-1",
		TurnID: "plan-turn", RequestID: "plan-turn", Kind: agentactivitybiz.RuntimeOperationKindPlanDecision,
		Status: agentactivitybiz.RuntimeOperationStatusPrepared, NextAttemptAtMS: now.UnixMilli(),
		Payload: map[string]any{
			"promptKind": "plan-implementation", "action": "implement", "idempotencyKey": "decision-1",
			"clientSubmitId": "plan-decision:" + operationID, "step": "prepared",
		},
	}}
	service := newTestService(runtime)
	service.SessionReader = fakeSessionReader{sessions: map[string]PersistedSession{
		"ws-1:session-1": {
			ID: "session-1", WorkspaceID: "ws-1", AgentTargetID: "local:codex",
			Provider: "codex", Settings: ComposerSettings{PlanMode: true},
		},
	}}
	service.RuntimeOperationStore = store
	service.RuntimeOperationOwner = "worker-a"
	service.RuntimeOperationClock = func() time.Time { return now }
	if err := service.StepRuntimeOperationWorker(context.Background(), true); err != nil {
		t.Fatalf("recovery error=%v", err)
	}
	if len(runtime.resumeCalls) != 1 || len(runtime.updateSettingsCalls) != 1 || len(runtime.execCalls) != 1 {
		t.Fatalf("resume=%d settings=%d exec=%d", len(runtime.resumeCalls), len(runtime.updateSettingsCalls), len(runtime.execCalls))
	}
}

func TestCraftedInvalidPlanDecisionFailsBeforeProviderCalls(t *testing.T) {
	now := time.UnixMilli(1_000)
	service, runtime, store := planDecisionTestService(now)
	operationID := runtimeOperationID("ws-1", "session-1", agentactivitybiz.RuntimeOperationKindPlanDecision, "plan-turn")
	store.operation = agentactivitybiz.RuntimeOperation{
		OperationID: operationID, WorkspaceID: "ws-1", AgentSessionID: "session-1",
		TurnID: "plan-turn", RequestID: "plan-turn", Kind: agentactivitybiz.RuntimeOperationKindPlanDecision,
		Status: agentactivitybiz.RuntimeOperationStatusPrepared, NextAttemptAtMS: now.UnixMilli(),
		Payload: map[string]any{
			"promptKind": "plan-implementation", "action": "deny", "idempotencyKey": "decision-1",
			"clientSubmitId": "plan-decision:" + operationID, "step": "prepared",
		},
	}
	if err := service.StepRuntimeOperationWorker(context.Background(), false); err == nil {
		t.Fatal("invalid crafted operation error=nil")
	}
	if store.operation.Status != agentactivitybiz.RuntimeOperationStatusFailed || len(runtime.updateSettingsCalls) != 0 || len(runtime.execCalls) != 0 {
		t.Fatalf("operation=%#v settings=%d exec=%d", store.operation, len(runtime.updateSettingsCalls), len(runtime.execCalls))
	}
}

func planDecisionTestService(now time.Time) (*Service, *fakeRuntime, *runtimeOperationMemoryStore) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "ready",
		Settings: &ComposerSettings{PlanMode: true},
	}
	store := &runtimeOperationMemoryStore{}
	service := newTestService(runtime)
	service.RuntimeOperationStore = store
	service.RuntimeOperationOwner = "worker-a"
	service.RuntimeOperationClock = func() time.Time { return now }
	return service, runtime, store
}

type planDecisionRecordingPublisher struct{ calls int }

func (p *planDecisionRecordingPublisher) PublishRuntimeOperationEvent(context.Context, agentactivitybiz.RuntimeOperationEvent) error {
	p.calls++
	return nil
}
