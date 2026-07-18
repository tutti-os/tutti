package agent

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestSubmitInteractiveCompletionFailureIsRecoveredFromLeasedOperation(t *testing.T) {
	now := time.UnixMilli(1000)
	want := errors.New("persist atomic interactive completion failed")
	runtime := newFakeRuntime()
	activeTurnID := "turn-1"
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "working",
		TurnLifecycle: &TurnLifecycle{ActiveTurnID: &activeTurnID, Phase: agentactivitybiz.TurnPhaseWaiting},
	}
	store := &runtimeOperationMemoryStore{completeErr: want}
	service := newIsolatedAgentService(runtime)
	service.RuntimeOperationStore = store
	service.RuntimeOperationOwner = "worker-a"
	service.RuntimeOperationClock = func() time.Time { return now }
	service.TurnStore = runtimeOperationTurnStore("turn-1", "request-1")

	_, err := service.SubmitInteractive(context.Background(), "ws-1", "session-1", "request-1", SubmitInteractiveInput{OptionID: stringRef("approve")})
	if !errors.Is(err, want) {
		t.Fatalf("SubmitInteractive() error = %v, want %v", err, want)
	}
	if store.operation.Status != agentactivitybiz.RuntimeOperationStatusLeased || len(runtime.submitInteractiveCalls) != 1 {
		t.Fatalf("after completion failure operation=%#v runtime calls=%d", store.operation, len(runtime.submitInteractiveCalls))
	}
	if runtime.submitInteractiveCalls[0].TurnID != "turn-1" {
		t.Fatalf("runtime interactive turn id = %q, want turn-1", runtime.submitInteractiveCalls[0].TurnID)
	}

	store.completeErr = nil
	runtime.submitInteractiveErr = ErrInteractiveRequestNotLive
	runtime.interactiveDisposition = RuntimeInteractiveDispositionAnswered
	delete(runtime.sessions, "ws-1:session-1")
	now = now.Add(runtimeOperationLeaseDuration)
	if err := service.ApplicationHost().StepRuntimeOperationWorker(context.Background(), false); err != nil {
		t.Fatalf("StepRuntimeOperationWorker() error = %v", err)
	}
	if store.operation.Status != agentactivitybiz.RuntimeOperationStatusCompleted || store.operation.Result != agentactivitybiz.RuntimeOperationResultAnswered {
		t.Fatalf("recovered operation = %#v", store.operation)
	}
}

func TestCancelCompletionFailureIsRecoveredFromLeasedOperation(t *testing.T) {
	now := time.UnixMilli(1000)
	want := errors.New("persist atomic cancel completion failed")
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "working"}
	store := &runtimeOperationMemoryStore{completeErr: want}
	service := newIsolatedAgentService(runtime)
	service.RuntimeOperationStore = store
	service.RuntimeOperationOwner = "worker-a"
	service.RuntimeOperationClock = func() time.Time { return now }
	service.TurnStore = runtimeOperationTurnStore("turn-1", "")

	_, err := service.CancelTurn(context.Background(), "ws-1", "session-1", "turn-1")
	if !errors.Is(err, want) {
		t.Fatalf("CancelTurn() error = %v, want %v", err, want)
	}
	if store.operation.Status != agentactivitybiz.RuntimeOperationStatusLeased || len(runtime.cancelCalls) != 1 {
		t.Fatalf("after completion failure operation=%#v runtime calls=%d", store.operation, len(runtime.cancelCalls))
	}

	store.completeErr = nil
	now = now.Add(runtimeOperationLeaseDuration)
	if err := service.ApplicationHost().StepRuntimeOperationWorker(context.Background(), true); err != nil {
		t.Fatalf("recovery worker error = %v", err)
	}
	if store.operation.Status != agentactivitybiz.RuntimeOperationStatusCompleted || store.operation.Result != agentactivitybiz.RuntimeOperationResultCanceled {
		t.Fatalf("recovered operation = %#v", store.operation)
	}
}

func TestExactCancelCompletesFromTypedRuntimeTargetAbsentEvidence(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "working"}
	runtime.cancelResultSet = true
	runtime.cancelResult = RuntimeCancelResult{AgentSessionID: "session-1", TargetAbsent: true}
	store := &runtimeOperationMemoryStore{}
	service := newIsolatedAgentService(runtime)
	service.RuntimeOperationStore = store
	service.RuntimeOperationOwner = "worker-a"
	service.RuntimeOperationClock = func() time.Time { return time.UnixMilli(1000) }
	service.TurnStore = runtimeOperationTurnStore("turn-1", "")

	result, err := service.CancelTurn(context.Background(), "ws-1", "session-1", "turn-1")
	if err != nil {
		t.Fatalf("CancelTurn() error = %v", err)
	}
	if !result.Canceled || store.operation.Status != agentactivitybiz.RuntimeOperationStatusCompleted {
		t.Fatalf("CancelTurn() result=%#v operation=%#v", result, store.operation)
	}
}

func TestRootCancelRoutesDurableChildTargetsThroughRootRuntime(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:root"] = ProviderRuntimeSession{ID: "root", WorkspaceID: "ws-1", Provider: "codex", Status: "working"}
	runtime.cancelResultSet = true
	runtime.cancelResult = RuntimeCancelResult{
		AgentSessionID: "root", Canceled: true,
		ConfirmedTargets: []RuntimeCancelTarget{{AgentSessionID: "root", TurnID: "root-turn"}},
	}
	store := &runtimeOperationMemoryStore{}
	turnStore := treeRuntimeOperationTurnStore{
		failingTurnStore: failingTurnStore{},
		sessions: map[string]agentactivitybiz.Session{
			"root":  {WorkspaceID: "ws-1", ID: "root", Kind: agentactivitybiz.SessionKindRoot, ActiveTurnID: "root-turn"},
			"child": {WorkspaceID: "ws-1", ID: "child", Kind: agentactivitybiz.SessionKindChild, RootAgentSessionID: "root", RootTurnID: "root-turn", ActiveTurnID: "child-turn"},
		},
		turns: map[string]agentactivitybiz.Turn{
			"root:root-turn":   {WorkspaceID: "ws-1", AgentSessionID: "root", TurnID: "root-turn", Phase: agentactivitybiz.TurnPhaseRunning},
			"child:child-turn": {WorkspaceID: "ws-1", AgentSessionID: "child", TurnID: "child-turn", Phase: agentactivitybiz.TurnPhaseRunning},
		},
	}
	service := newIsolatedAgentService(runtime)
	service.RuntimeOperationStore = store
	service.RuntimeOperationOwner = "worker-a"
	service.RuntimeOperationClock = func() time.Time { return time.UnixMilli(1000) }
	service.TurnStore = turnStore
	service.SessionReader = fakeSessionReader{
		sessions: map[string]PersistedSession{
			"ws-1:root": {WorkspaceID: "ws-1", ID: "root", Kind: agentactivitybiz.SessionKindRoot, Provider: "codex", ActiveTurnID: "root-turn"},
		},
		children: map[string][]PersistedSession{
			"ws-1:root": {{WorkspaceID: "ws-1", ID: "child", Kind: agentactivitybiz.SessionKindChild, Provider: "codex", RootAgentSessionID: "root", RootTurnID: "root-turn", ActiveTurnID: "child-turn"}},
		},
	}

	if _, err := service.CancelTurn(context.Background(), "ws-1", "root", "root-turn"); err != nil {
		t.Fatalf("CancelTurn() error = %v", err)
	}
	if len(runtime.cancelCalls) != 1 {
		t.Fatalf("runtime cancel calls = %d, want one aggregate call", len(runtime.cancelCalls))
	}
	call := runtime.cancelCalls[0]
	if call.RootAgentSessionID != "root" || len(call.Targets) != 2 ||
		call.Targets[0].AgentSessionID != "child" || call.Targets[0].TurnID != "child-turn" ||
		call.Targets[1].AgentSessionID != "root" || call.Targets[1].TurnID != "root-turn" {
		t.Fatalf("runtime cancel call = %#v", call)
	}
	if len(store.cancelCompletions) != 1 || len(store.cancelCompletions[0].TargetOutcomes) != 2 {
		t.Fatalf("cancel completion inputs = %#v", store.cancelCompletions)
	}
	outcomes := store.cancelCompletions[0].TargetOutcomes
	if outcomes[0].AgentSessionID != "child" || outcomes[0].Outcome != agentactivitybiz.TurnOutcomeInterrupted ||
		outcomes[1].AgentSessionID != "root" || outcomes[1].Outcome != agentactivitybiz.TurnOutcomeCanceled {
		t.Fatalf("cancel target outcomes = %#v", outcomes)
	}
}

func TestChildInteractionRoutesThroughRootRuntimeWithCanonicalChildTuple(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:root"] = ProviderRuntimeSession{ID: "root", WorkspaceID: "ws-1", Provider: "claude-code", Status: "working"}
	store := &runtimeOperationMemoryStore{}
	turnStore := treeRuntimeOperationTurnStore{
		failingTurnStore: failingTurnStore{interactions: []agentactivitybiz.Interaction{{
			WorkspaceID: "ws-1", AgentSessionID: "child", TurnID: "child-turn",
			RequestID: "child-request", Status: agentactivitybiz.InteractionStatusPending,
		}}},
		sessions: map[string]agentactivitybiz.Session{
			"child": {WorkspaceID: "ws-1", ID: "child", Kind: agentactivitybiz.SessionKindChild, RootAgentSessionID: "root", RootTurnID: "root-turn", ActiveTurnID: "child-turn"},
		},
		turns: map[string]agentactivitybiz.Turn{
			"child:child-turn": {WorkspaceID: "ws-1", AgentSessionID: "child", TurnID: "child-turn", Phase: agentactivitybiz.TurnPhaseWaiting},
		},
	}
	service := newIsolatedAgentService(runtime)
	service.RuntimeOperationStore = store
	service.RuntimeOperationOwner = "worker-a"
	service.RuntimeOperationClock = func() time.Time { return time.UnixMilli(1000) }
	service.TurnStore = turnStore
	service.SessionReader = fakeSessionReader{sessions: map[string]PersistedSession{
		"ws-1:child": {WorkspaceID: "ws-1", ID: "child", Kind: agentactivitybiz.SessionKindChild, Provider: "claude-code", RootAgentSessionID: "root", RootTurnID: "root-turn", ActiveTurnID: "child-turn"},
	}}

	if _, err := service.SubmitInteractive(context.Background(), "ws-1", "child", "child-request", SubmitInteractiveInput{
		TurnID: "child-turn", OptionID: stringRef("allow"),
	}); err != nil {
		t.Fatalf("SubmitInteractive() error = %v", err)
	}
	if len(runtime.submitInteractiveCalls) != 1 {
		t.Fatalf("runtime submit calls = %d, want one", len(runtime.submitInteractiveCalls))
	}
	call := runtime.submitInteractiveCalls[0]
	if call.RootAgentSessionID != "root" || call.AgentSessionID != "child" ||
		call.TurnID != "child-turn" || call.RequestID != "child-request" {
		t.Fatalf("runtime interaction call = %#v", call)
	}
}

type treeRuntimeOperationTurnStore struct {
	failingTurnStore
	sessions map[string]agentactivitybiz.Session
	turns    map[string]agentactivitybiz.Turn
}

func (s treeRuntimeOperationTurnStore) GetSession(_ context.Context, _ string, agentSessionID string) (agentactivitybiz.Session, bool, error) {
	session, ok := s.sessions[agentSessionID]
	return session, ok, nil
}

func (s treeRuntimeOperationTurnStore) GetTurn(_ context.Context, _ string, agentSessionID string, turnID string) (agentactivitybiz.Turn, bool, error) {
	turn, ok := s.turns[agentSessionID+":"+turnID]
	return turn, ok, nil
}

func TestCompletedInteractiveRetryUsesDeterministicOperationWithoutPendingInteraction(t *testing.T) {
	now := time.UnixMilli(1000)
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "working"}
	store := &runtimeOperationMemoryStore{}
	service := newIsolatedAgentService(runtime)
	service.RuntimeOperationStore = store
	service.RuntimeOperationOwner = "worker-a"
	service.RuntimeOperationClock = func() time.Time { return now }
	service.TurnStore = runtimeOperationTurnStore("turn-1", "request-1")
	input := SubmitInteractiveInput{OptionID: stringRef("approve")}

	if _, err := service.SubmitInteractive(context.Background(), "ws-1", "session-1", "request-1", input); err != nil {
		t.Fatalf("first SubmitInteractive() error = %v", err)
	}
	service.TurnStore = runtimeOperationTurnStore("turn-1", "")
	if _, err := service.SubmitInteractive(context.Background(), "ws-1", "session-1", "request-1", input); err != nil {
		t.Fatalf("duplicate SubmitInteractive() error = %v operation=%#v", err, store.operation)
	}
	if len(runtime.submitInteractiveCalls) != 1 {
		t.Fatalf("runtime submit calls = %d, want 1", len(runtime.submitInteractiveCalls))
	}
}

func TestInlineOutboxPublishFailureDoesNotTurnCompletedAPIIntoFailure(t *testing.T) {
	now := time.UnixMilli(1000)
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "working"}
	store := &runtimeOperationMemoryStore{}
	publisher := runtimeOperationFailingPublisher{err: errors.New("event stream unavailable")}
	service := newIsolatedAgentService(runtime)
	service.RuntimeOperationStore = store
	service.RuntimeOperationEventPublisher = publisher
	service.RuntimeOperationOwner = "worker-a"
	service.RuntimeOperationClock = func() time.Time { return now }
	service.TurnStore = runtimeOperationTurnStore("turn-1", "request-1")

	if _, err := service.SubmitInteractive(context.Background(), "ws-1", "session-1", "request-1", SubmitInteractiveInput{OptionID: stringRef("approve")}); err != nil {
		t.Fatalf("SubmitInteractive() error = %v, want completed API success", err)
	}
	if len(store.events) != 1 || store.events[0].PublishedAtUnixMS != 0 {
		t.Fatalf("outbox events = %#v, want one pending event", store.events)
	}
	if err := service.ApplicationHost().StepRuntimeOperationWorker(context.Background(), false); err == nil {
		t.Fatal("worker outbox publish error = nil")
	}
}

func TestRetryableRuntimeFailureReturnsReconciliationState(t *testing.T) {
	now := time.UnixMilli(1000)
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "working"}
	runtime.submitInteractiveErr = ErrRuntimeSessionDisconnected
	runtime.interactiveDisposition = RuntimeInteractiveDispositionPending
	store := &runtimeOperationMemoryStore{}
	service := newIsolatedAgentService(runtime)
	service.RuntimeOperationStore = store
	service.RuntimeOperationOwner = "worker-a"
	service.RuntimeOperationClock = func() time.Time { return now }
	service.TurnStore = runtimeOperationTurnStore("turn-1", "request-1")

	_, err := service.SubmitInteractive(context.Background(), "ws-1", "session-1", "request-1", SubmitInteractiveInput{OptionID: stringRef("approve")})
	if !errors.Is(err, ErrRuntimeOperationInProgress) {
		t.Fatalf("SubmitInteractive() error = %v, want ErrRuntimeOperationInProgress", err)
	}
	if store.operation.Status != agentactivitybiz.RuntimeOperationStatusPrepared {
		t.Fatalf("operation = %#v, want prepared for worker reconciliation", store.operation)
	}
	if store.operation.NextAttemptAtMS <= now.UnixMilli() {
		t.Fatalf("next attempt = %d, want backoff after %d", store.operation.NextAttemptAtMS, now.UnixMilli())
	}
}

func TestTerminalRuntimeDispositionCompletesInteractiveOperationAsSuperseded(t *testing.T) {
	for _, disposition := range []RuntimeInteractiveDisposition{
		RuntimeInteractiveDispositionSuperseded,
		RuntimeInteractiveDispositionInterrupted,
	} {
		t.Run(string(disposition), func(t *testing.T) {
			ctx := context.Background()
			store := openAgentServiceSQLiteStore(t)
			if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace"}); err != nil {
				t.Fatalf("Create workspace error = %v", err)
			}
			if _, err := store.ReportActivityState(ctx, agentactivitybiz.ActivityStateReport{
				Session: agentactivitybiz.SessionStateReport{
					WorkspaceID: "ws-1", AgentSessionID: "session-1", Kind: agentactivitybiz.SessionKindRoot,
					Origin: "runtime", Provider: "codex", Status: "active", CurrentPhase: "waiting_approval", OccurredAtUnixMS: 1,
				},
				Turn: &agentactivitybiz.TurnTransition{
					WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
					Phase: agentactivitybiz.TurnPhaseWaiting, Origin: agentactivitybiz.TurnOriginProviderInitiated, OccurredAtUnixMS: 1,
				},
				Interaction: &agentactivitybiz.InteractionUpsert{
					WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1", RequestID: "request-1",
					Kind: agentactivitybiz.InteractionKindApproval, Status: agentactivitybiz.InteractionStatusPending,
					ToolName: "shell", Input: map[string]any{"command": "git status"}, OccurredAtUnixMS: 2,
				},
			}); err != nil {
				t.Fatalf("seed interactive state error = %v", err)
			}
			runtime := newFakeRuntime()
			activeTurnID := "turn-1"
			runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
				ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "working",
				TurnLifecycle: &TurnLifecycle{ActiveTurnID: &activeTurnID, Phase: agentactivitybiz.TurnPhaseWaiting},
			}
			runtime.submitInteractiveErr = ErrInteractiveRequestNotLive
			runtime.interactiveDisposition = disposition
			service := newIsolatedAgentService(runtime)
			service.RuntimeOperationStore = store
			service.TurnStore = store
			service.RuntimeOperationOwner = "worker-a"
			service.RuntimeOperationClock = func() time.Time { return time.UnixMilli(1000) }

			result, err := service.ApplicationHost().SubmitInteractive(ctx,
				agenthost.SessionRef{WorkspaceID: "ws-1", AgentSessionID: "session-1"},
				"request-1", agenthost.SubmitInteractiveInput{TurnID: "turn-1", OptionID: stringRef("approve")},
			)
			if err != nil {
				t.Fatalf("Host.SubmitInteractive() error = %v", err)
			}
			if result.Disposition != RuntimeInteractiveDispositionSuperseded ||
				result.Operation.Status != agentactivitybiz.RuntimeOperationStatusCompleted ||
				result.Operation.Result != agentactivitybiz.RuntimeOperationResultSuperseded {
				t.Fatalf("Host result = %#v, want completed superseded", result)
			}
			operation, found, err := store.GetRuntimeOperation(ctx, "ws-1", result.Operation.OperationID)
			if err != nil || !found || operation.Result != agentactivitybiz.RuntimeOperationResultSuperseded {
				t.Fatalf("stored operation = %#v found=%v error=%v", operation, found, err)
			}
		})
	}
}

func TestUnknownRuntimeDispositionFailsInteractiveOperation(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "working"}
	runtime.submitInteractiveErr = ErrInteractiveRequestNotLive
	runtime.interactiveDisposition = RuntimeInteractiveDispositionUnknown
	store := &runtimeOperationMemoryStore{}
	service := newIsolatedAgentService(runtime)
	service.RuntimeOperationStore = store
	service.RuntimeOperationOwner = "worker-a"
	service.RuntimeOperationClock = func() time.Time { return time.UnixMilli(1000) }
	service.TurnStore = runtimeOperationTurnStore("turn-1", "request-1")

	if _, err := service.SubmitInteractive(context.Background(), "ws-1", "session-1", "request-1", SubmitInteractiveInput{OptionID: stringRef("approve")}); err == nil {
		t.Fatal("SubmitInteractive() error = nil, want unknown disposition error")
	}
	if store.operation.Status != agentactivitybiz.RuntimeOperationStatusFailed {
		t.Fatalf("operation = %#v, want failed", store.operation)
	}
}

func TestDuplicateTerminalFailedOperationReturnsTerminalFailure(t *testing.T) {
	store := &runtimeOperationMemoryStore{operation: agentactivitybiz.RuntimeOperation{
		OperationID: runtimeOperationID("ws-1", "session-1", agentactivitybiz.RuntimeOperationKindInteractiveResponse, "request-1"),
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Kind: agentactivitybiz.RuntimeOperationKindInteractiveResponse,
		Status: agentactivitybiz.RuntimeOperationStatusFailed, Result: agentactivitybiz.RuntimeOperationResultFailed,
		TurnID: "turn-1", RequestID: "request-1", LastError: "invalid provider option",
		Payload: map[string]any{
			"rootAgentSessionId": "session-1", "action": "", "optionId": "approve",
			"payload": (map[string]any)(nil), "turnId": "",
		},
	}}
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "working"}
	service := newIsolatedAgentService(runtime)
	service.RuntimeOperationStore = store
	service.TurnStore = runtimeOperationTurnStore("turn-1", "")

	_, err := service.SubmitInteractive(context.Background(), "ws-1", "session-1", "request-1", SubmitInteractiveInput{OptionID: stringRef("approve")})
	if !errors.Is(err, ErrRuntimeOperationFailed) || errors.Is(err, ErrRuntimeOperationInProgress) {
		t.Fatalf("SubmitInteractive() error = %v, want terminal ErrRuntimeOperationFailed", err)
	}
	if len(runtime.submitInteractiveCalls) != 0 {
		t.Fatalf("runtime submit calls = %d, want 0", len(runtime.submitInteractiveCalls))
	}
}

func TestStartupRecoveryRequeuesUnexpiredLeaseBeforeRecoveringCancel(t *testing.T) {
	now := time.UnixMilli(1000)
	store := &runtimeOperationMemoryStore{operation: agentactivitybiz.RuntimeOperation{
		OperationID: "operation-1", WorkspaceID: "ws-1", AgentSessionID: "session-1",
		Kind: agentactivitybiz.RuntimeOperationKindCancelTurn, Status: agentactivitybiz.RuntimeOperationStatusLeased,
		TurnID: "turn-1", Payload: map[string]any{
			"reason": "user requested turn cancellation", "rootAgentSessionId": "session-1",
			"targets": []any{map[string]any{"agentSessionId": "session-1", "turnId": "turn-1"}},
		},
		LeaseOwner: "dead-process", LeaseExpiresAtMS: now.Add(time.Hour).UnixMilli(),
	}}
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{ID: "session-1", WorkspaceID: "ws-1", Provider: "codex", Status: "working"}
	service := newIsolatedAgentService(runtime)
	service.RuntimeOperationStore = store
	service.RuntimeOperationOwner = "new-process"
	service.RuntimeOperationClock = func() time.Time { return now }
	service.TurnStore = runtimeOperationTurnStore("turn-1", "")

	if err := service.ApplicationHost().RecoverRuntimeOperations(context.Background()); err != nil {
		t.Fatalf("RecoverRuntimeOperations() error = %v", err)
	}
	if store.operation.Status != agentactivitybiz.RuntimeOperationStatusCompleted || store.operation.Result != agentactivitybiz.RuntimeOperationResultCanceled {
		t.Fatalf("startup recovered operation = %#v", store.operation)
	}
	if len(runtime.cancelCalls) != 1 {
		t.Fatalf("startup runtime cancel calls = %d, want 1 idempotent replay", len(runtime.cancelCalls))
	}
}

func runtimeOperationTurnStore(turnID string, requestID string) failingTurnStore {
	store := failingTurnStore{
		session: agentactivitybiz.Session{WorkspaceID: "ws-1", ID: "session-1", ActiveTurnID: turnID},
		turn:    agentactivitybiz.Turn{WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: turnID, Phase: agentactivitybiz.TurnPhaseWaiting},
	}
	if requestID != "" {
		store.interactions = []agentactivitybiz.Interaction{{WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: turnID, RequestID: requestID, Status: agentactivitybiz.InteractionStatusPending}}
	}
	return store
}

type runtimeOperationMemoryStore struct {
	mu                sync.Mutex
	operation         agentactivitybiz.RuntimeOperation
	completeErr       error
	events            []agentactivitybiz.RuntimeOperationEvent
	confirmedTurnID   string
	checkpointSteps   []string
	checkpointErr     error
	cancelCompletions []agentactivitybiz.CompleteCancelRuntimeOperationInput
}

func (s *runtimeOperationMemoryStore) CheckpointRuntimeOperation(_ context.Context, input agentactivitybiz.CheckpointRuntimeOperationInput) (agentactivitybiz.RuntimeOperation, bool, error) {
	if s.checkpointErr != nil {
		err := s.checkpointErr
		s.checkpointErr = nil
		return s.operation, false, err
	}
	if s.operation.Status != agentactivitybiz.RuntimeOperationStatusLeased || s.operation.LeaseOwner != input.LeaseOwner {
		return s.operation, false, agentactivitybiz.ErrRuntimeOperationLeaseLost
	}
	s.operation.Payload = input.Payload
	hasPendingEvent := false
	for _, existing := range s.events {
		hasPendingEvent = hasPendingEvent || existing.Kind == agentactivitybiz.RuntimeOperationEventPlanDecisionPending
	}
	if !hasPendingEvent && payloadText(input.Payload, "step") == "send_dispatched" {
		event := agentactivitybiz.RuntimeOperationEvent{
			ID: int64(len(s.events) + 1), OperationID: s.operation.OperationID,
			WorkspaceID: s.operation.WorkspaceID, AgentSessionID: s.operation.AgentSessionID,
			Kind:    agentactivitybiz.RuntimeOperationEventPlanDecisionPending,
			Payload: map[string]any{"noticeMessageId": "plan-decision:" + s.operation.OperationID + ":status"},
		}
		s.events = append(s.events, event)
	}
	s.checkpointSteps = append(s.checkpointSteps, payloadText(input.Payload, "step"))
	return s.operation, true, nil
}

func (s *runtimeOperationMemoryStore) FindTurnByClientSubmitID(_ context.Context, _, _, _ string) (string, bool, error) {
	return s.confirmedTurnID, s.confirmedTurnID != "", nil
}

type runtimeOperationFailingPublisher struct{ err error }

func (p runtimeOperationFailingPublisher) PublishRuntimeOperationEvent(context.Context, agentactivitybiz.RuntimeOperationEvent) error {
	return p.err
}

func (s *runtimeOperationMemoryStore) PrepareRuntimeOperation(_ context.Context, input agentactivitybiz.RuntimeOperationPrepare) (agentactivitybiz.RuntimeOperation, bool, error) {
	if s.operation.OperationID != "" {
		return s.operation, false, nil
	}
	s.operation = agentactivitybiz.RuntimeOperation{OperationID: input.OperationID, WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, Kind: input.Kind, Status: agentactivitybiz.RuntimeOperationStatusPrepared, TurnID: input.TurnID, RequestID: input.RequestID, Payload: input.Payload, CreatedAtUnixMS: input.OccurredAtMS, UpdatedAtUnixMS: input.OccurredAtMS}
	return s.operation, true, nil
}

func (s *runtimeOperationMemoryStore) PrepareInteractiveRuntimeOperation(_ context.Context, input agentactivitybiz.RuntimeOperationPrepare) (agentactivitybiz.RuntimeOperation, agentactivitybiz.Interaction, agentactivitybiz.InteractionTransitionResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	transition := agentactivitybiz.InteractionTransitionAlreadyApplied
	if s.operation.OperationID == "" {
		s.operation = agentactivitybiz.RuntimeOperation{OperationID: input.OperationID, WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID, Kind: input.Kind, Status: agentactivitybiz.RuntimeOperationStatusPrepared, TurnID: input.TurnID, RequestID: input.RequestID, Payload: input.Payload, CreatedAtUnixMS: input.OccurredAtMS, UpdatedAtUnixMS: input.OccurredAtMS}
		transition = agentactivitybiz.InteractionTransitionApplied
	}
	interaction := agentactivitybiz.Interaction{
		WorkspaceID: input.WorkspaceID, AgentSessionID: input.AgentSessionID,
		TurnID: input.TurnID, RequestID: input.RequestID,
		Status: agentactivitybiz.InteractionStatusAnswered,
		Output: map[string]any{
			"action":   payloadText(s.operation.Payload, "action"),
			"optionId": payloadText(s.operation.Payload, "optionId"),
			"payload":  s.operation.Payload["payload"],
		},
	}
	return s.operation, interaction, transition, nil
}

func (s *runtimeOperationMemoryStore) GetRuntimeOperation(_ context.Context, workspaceID string, operationID string) (agentactivitybiz.RuntimeOperation, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.operation, s.operation.WorkspaceID == workspaceID && s.operation.OperationID == operationID, nil
}

func (s *runtimeOperationMemoryStore) ListClaimableRuntimeOperations(_ context.Context, input agentactivitybiz.ListClaimableRuntimeOperationsInput) ([]agentactivitybiz.RuntimeOperation, error) {
	if (s.operation.Status == agentactivitybiz.RuntimeOperationStatusPrepared && s.operation.NextAttemptAtMS <= input.NowUnixMS) || (s.operation.Status == agentactivitybiz.RuntimeOperationStatusLeased && s.operation.LeaseExpiresAtMS <= input.NowUnixMS) {
		return []agentactivitybiz.RuntimeOperation{s.operation}, nil
	}
	return nil, nil
}

func (s *runtimeOperationMemoryStore) ClaimRuntimeOperationLease(_ context.Context, input agentactivitybiz.ClaimRuntimeOperationLeaseInput) (agentactivitybiz.RuntimeOperation, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	claimable := (s.operation.Status == agentactivitybiz.RuntimeOperationStatusPrepared && s.operation.NextAttemptAtMS <= input.NowUnixMS) || (s.operation.Status == agentactivitybiz.RuntimeOperationStatusLeased && s.operation.LeaseExpiresAtMS <= input.NowUnixMS)
	if !claimable {
		return s.operation, false, nil
	}
	s.operation.Status, s.operation.LeaseOwner, s.operation.LeaseExpiresAtMS = agentactivitybiz.RuntimeOperationStatusLeased, input.LeaseOwner, input.LeaseExpiresAtMS
	s.operation.Attempt++
	return s.operation, true, nil
}

func (s *runtimeOperationMemoryStore) ReleaseOrFailRuntimeOperation(_ context.Context, input agentactivitybiz.ReleaseOrFailRuntimeOperationInput) (agentactivitybiz.RuntimeOperation, bool, error) {
	if input.Fail {
		s.operation.Status, s.operation.Result = agentactivitybiz.RuntimeOperationStatusFailed, agentactivitybiz.RuntimeOperationResultFailed
	} else {
		s.operation.Status = agentactivitybiz.RuntimeOperationStatusPrepared
	}
	s.operation.LeaseOwner, s.operation.LeaseExpiresAtMS, s.operation.LastError = "", 0, input.LastError
	s.operation.NextAttemptAtMS = input.NextAttemptAtMS
	return s.operation, true, nil
}

func (s *runtimeOperationMemoryStore) RequeueLeasedRuntimeOperationsOnStartup(_ context.Context, now int64) (int64, error) {
	if s.operation.Status != agentactivitybiz.RuntimeOperationStatusLeased {
		return 0, nil
	}
	s.operation.Status, s.operation.LeaseOwner, s.operation.LeaseExpiresAtMS = agentactivitybiz.RuntimeOperationStatusPrepared, "", 0
	s.operation.NextAttemptAtMS = now
	return 1, nil
}

func (s *runtimeOperationMemoryStore) CompleteInteractiveRuntimeOperation(_ context.Context, input agentactivitybiz.CompleteInteractiveRuntimeOperationInput) (agentactivitybiz.RuntimeOperationCompletion, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.completeErr != nil {
		return agentactivitybiz.RuntimeOperationCompletion{}, false, s.completeErr
	}
	s.operation.Status, s.operation.Result = agentactivitybiz.RuntimeOperationStatusCompleted, input.Disposition
	s.operation.LeaseOwner, s.operation.LeaseExpiresAtMS = "", 0
	event := agentactivitybiz.RuntimeOperationEvent{ID: int64(len(s.events) + 1), OperationID: s.operation.OperationID, WorkspaceID: s.operation.WorkspaceID, AgentSessionID: s.operation.AgentSessionID, Kind: agentactivitybiz.RuntimeOperationEventInteractiveCompleted}
	s.events = append(s.events, event)
	return agentactivitybiz.RuntimeOperationCompletion{Operation: s.operation, Event: event}, true, nil
}

func (s *runtimeOperationMemoryStore) CompleteCancelRuntimeOperation(_ context.Context, input agentactivitybiz.CompleteCancelRuntimeOperationInput) (agentactivitybiz.RuntimeOperationCompletion, bool, error) {
	if s.completeErr != nil {
		return agentactivitybiz.RuntimeOperationCompletion{}, false, s.completeErr
	}
	s.cancelCompletions = append(s.cancelCompletions, input)
	s.operation.Status, s.operation.Result = agentactivitybiz.RuntimeOperationStatusCompleted, agentactivitybiz.RuntimeOperationResultCanceled
	s.operation.LeaseOwner, s.operation.LeaseExpiresAtMS = "", 0
	event := agentactivitybiz.RuntimeOperationEvent{ID: int64(len(s.events) + 1), OperationID: s.operation.OperationID, WorkspaceID: s.operation.WorkspaceID, AgentSessionID: s.operation.AgentSessionID, Kind: agentactivitybiz.RuntimeOperationEventTurnCanceled}
	s.events = append(s.events, event)
	return agentactivitybiz.RuntimeOperationCompletion{Operation: s.operation, Event: event}, true, nil
}

func (s *runtimeOperationMemoryStore) CompletePlanDecisionRuntimeOperation(_ context.Context, _ agentactivitybiz.CompletePlanDecisionRuntimeOperationInput) (agentactivitybiz.RuntimeOperationCompletion, bool, error) {
	if s.completeErr != nil {
		return agentactivitybiz.RuntimeOperationCompletion{}, false, s.completeErr
	}
	s.operation.Status, s.operation.Result = agentactivitybiz.RuntimeOperationStatusCompleted, agentactivitybiz.RuntimeOperationResultApplied
	s.operation.LeaseOwner, s.operation.LeaseExpiresAtMS = "", 0
	event := agentactivitybiz.RuntimeOperationEvent{ID: int64(len(s.events) + 1), OperationID: s.operation.OperationID, WorkspaceID: s.operation.WorkspaceID, AgentSessionID: s.operation.AgentSessionID, Kind: agentactivitybiz.RuntimeOperationEventPlanDecisionCompleted}
	s.events = append(s.events, event)
	return agentactivitybiz.RuntimeOperationCompletion{Operation: s.operation, Event: event}, true, nil
}

func (s *runtimeOperationMemoryStore) ListPendingRuntimeOperationEvents(_ context.Context, _ string, _ int) ([]agentactivitybiz.RuntimeOperationEvent, error) {
	return s.events, nil
}

func (s *runtimeOperationMemoryStore) MarkRuntimeOperationEventPublished(_ context.Context, _ string, eventID int64, publishedAt int64) (bool, error) {
	for index := range s.events {
		if s.events[index].ID == eventID {
			s.events[index].PublishedAtUnixMS = publishedAt
		}
	}
	return true, nil
}
