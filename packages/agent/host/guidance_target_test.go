package agenthost_test

import (
	"context"
	"errors"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

type recordingGuidanceTerminalFailureObserver struct {
	failures []agenthost.TerminalFailure
}

func (o *recordingGuidanceTerminalFailureObserver) ObserveTerminalFailure(_ context.Context, failure agenthost.TerminalFailure) {
	o.failures = append(o.failures, failure)
}

func TestHostGuidanceRequiresExactTargetBeforeCreatingClaim(t *testing.T) {
	observer := &recordingGuidanceTerminalFailureObserver{}
	_, store, runtime := newHostEditRetryFixture(t)
	host := agenthost.New(agenthost.Config{
		CanonicalStore:          sqliteCanonicalStore{Store: store},
		TurnSubmissions:         store,
		EffectiveHistory:        store,
		RuntimeOperations:       store,
		Runtime:                 runtime,
		HistoryRuntime:          runtime,
		GoalRuntime:             runtime,
		OperationOwner:          "worker-1",
		TerminalFailureObserver: observer,
	})
	_, err := host.SendInput(t.Context(), agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}, agenthost.SendInput{
		Content: []agenthost.PromptContentBlock{{Type: "text", Text: "missing target"}}, Guidance: true,
		ClientSubmitID: "guidance-required",
	})
	if err != agenthost.ErrActiveTurnTargetRequired {
		t.Fatalf("SendInput() error = %v, want ErrActiveTurnTargetRequired", err)
	}
	if _, found, claimErr := store.GetSubmitClaim(t.Context(), "workspace-1", "session-1", "guidance-required"); claimErr != nil || found {
		t.Fatalf("guidance claim found=%v error=%v, want no claim", found, claimErr)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != 0 {
		t.Fatalf("runtime exec calls = %d, want 0", runtime.execCalls)
	}
	if len(observer.failures) != 1 {
		t.Fatalf("terminal failures = %#v, want 1", observer.failures)
	}
	got := observer.failures[0]
	if got.Flow != "guidance" || got.FailureStage != "guidance_target" || got.ErrorCode != "active_turn_target_required" {
		t.Fatalf("guidance terminal failure = %#v", got)
	}
}

func TestHostGuidanceTargetMismatchCleansPreparedClaim(t *testing.T) {
	observer := &recordingGuidanceTerminalFailureObserver{}
	_, store, runtime := newHostEditRetryFixture(t)
	host := agenthost.New(agenthost.Config{
		CanonicalStore:          sqliteCanonicalStore{Store: store},
		TurnSubmissions:         store,
		EffectiveHistory:        store,
		RuntimeOperations:       store,
		Runtime:                 runtime,
		HistoryRuntime:          runtime,
		GoalRuntime:             runtime,
		OperationOwner:          "worker-1",
		TerminalFailureObserver: observer,
	})
	runtime.mu.Lock()
	runtime.guidanceMismatch = true
	runtime.mu.Unlock()
	_, err := host.SendInput(t.Context(), agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}, agenthost.SendInput{
		Content: []agenthost.PromptContentBlock{{Type: "text", Text: "stale guidance"}}, Guidance: true,
		TurnID: "turn-original", ClientSubmitID: "guidance-mismatch",
	})
	if err == nil {
		t.Fatal("SendInput() error = nil, want target mismatch")
	}
	if _, found, claimErr := store.GetSubmitClaim(t.Context(), "workspace-1", "session-1", "guidance-mismatch"); claimErr != nil || found {
		t.Fatalf("prepared claim found=%v error=%v, want cleanup", found, claimErr)
	}
	claim, created, claimErr := store.PrepareSubmitClaim(t.Context(), storesqlite.SubmitClaimPrepare{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", ClientSubmitID: "guidance-mismatch",
		CanonicalTurnID: "turn-retry", NowUnixMS: 2,
	})
	if claimErr != nil || !created || claim.CanonicalTurnID != "turn-retry" {
		t.Fatalf("retry claim=%#v created=%v error=%v, want a fresh claim", claim, created, claimErr)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != 1 {
		t.Fatalf("runtime exec calls = %d, want 1", runtime.execCalls)
	}
	if len(observer.failures) != 1 {
		t.Fatalf("terminal failures = %#v, want 1", observer.failures)
	}
	got := observer.failures[0]
	if got.Flow != "guidance" || got.FailureStage != "guidance_target" || got.TurnID != "turn-original" {
		t.Fatalf("guidance terminal failure = %#v", got)
	}
}

func TestHostGuidanceSettledAfterCallerPrecheckIsDefinitivelyNotDispatched(t *testing.T) {
	_, store, runtime := newHostEditRetryFixture(t)
	host := agenthost.New(agenthost.Config{
		CanonicalStore:    sqliteCanonicalStore{Store: store},
		TurnSubmissions:   store,
		EffectiveHistory:  store,
		RuntimeOperations: store,
		Runtime:           runtime,
		HistoryRuntime:    runtime,
		GoalRuntime:       runtime,
		OperationOwner:    "worker-1",
	})
	runtime.mu.Lock()
	runtime.guidanceTargetInactive = true
	runtime.mu.Unlock()

	_, err := host.SendInput(t.Context(), agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
	}, agenthost.SendInput{
		Content:        []agenthost.PromptContentBlock{{Type: "text", Text: "guidance after settle"}},
		Guidance:       true,
		TurnID:         "turn-original",
		ClientSubmitID: "guidance-settle-race",
	})
	if !errors.Is(err, agenthost.ErrActiveTurnTargetMismatch) {
		t.Fatalf("SendInput() error = %v, want ErrActiveTurnTargetMismatch", err)
	}
	if _, found, claimErr := store.GetSubmitClaim(t.Context(), "workspace-1", "session-1", "guidance-settle-race"); claimErr != nil || found {
		t.Fatalf("prepared claim found=%v error=%v, want cleanup", found, claimErr)
	}
	claim, created, claimErr := store.PrepareSubmitClaim(t.Context(), storesqlite.SubmitClaimPrepare{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1", ClientSubmitID: "guidance-settle-race",
		CanonicalTurnID: "turn-retry", NowUnixMS: 2,
	})
	if claimErr != nil || !created || claim.CanonicalTurnID != "turn-retry" {
		t.Fatalf("retry claim=%#v created=%v error=%v, want a fresh claim", claim, created, claimErr)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != 1 {
		t.Fatalf("runtime exec calls = %d, want 1", runtime.execCalls)
	}
	if runtime.guidanceProviderCalls != 0 {
		t.Fatalf("provider guidance calls = %d, want 0", runtime.guidanceProviderCalls)
	}
}

func TestHostGuidanceAdapterPreflightFailureCleansClaimAndCanRetry(t *testing.T) {
	_, store, runtime := newHostEditRetryFixture(t)
	host := agenthost.New(agenthost.Config{
		CanonicalStore:    sqliteCanonicalStore{Store: store},
		TurnSubmissions:   store,
		EffectiveHistory:  store,
		RuntimeOperations: store,
		Runtime:           runtime,
		HistoryRuntime:    runtime,
		GoalRuntime:       runtime,
		OperationOwner:    "worker-1",
	})
	runtime.mu.Lock()
	runtime.guidancePreflightFailure = true
	runtime.mu.Unlock()
	input := agenthost.SendInput{
		Content:        []agenthost.PromptContentBlock{{Type: "text", Text: "retryable guidance"}},
		Guidance:       true,
		TurnID:         "turn-original",
		ClientSubmitID: "guidance-preflight",
	}

	_, err := host.SendInput(t.Context(), agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
	}, input)
	if err == nil || errors.Is(err, agenthost.ErrSubmitDeliveryUnknown) {
		t.Fatalf("first SendInput() error = %v, want known preflight failure", err)
	}
	if _, found, claimErr := store.GetSubmitClaim(t.Context(), "workspace-1", "session-1", "guidance-preflight"); claimErr != nil || found {
		t.Fatalf("prepared claim found=%v error=%v, want cleanup", found, claimErr)
	}

	if _, err := host.SendInput(t.Context(), agenthost.SessionRef{
		WorkspaceID: "workspace-1", AgentSessionID: "session-1",
	}, input); err != nil {
		t.Fatalf("retry SendInput(): %v", err)
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if runtime.execCalls != 2 || runtime.guidanceProviderCalls != 1 {
		t.Fatalf("exec calls=%d provider calls=%d, want 2/1", runtime.execCalls, runtime.guidanceProviderCalls)
	}
}

func TestHostGuidanceTransportFailureReportsMessageSendFailure(t *testing.T) {
	observer := &recordingGuidanceTerminalFailureObserver{}
	_, store, runtime := newHostEditRetryFixture(t)
	host := agenthost.New(agenthost.Config{
		CanonicalStore:          sqliteCanonicalStore{Store: store},
		TurnSubmissions:         store,
		EffectiveHistory:        store,
		RuntimeOperations:       store,
		Runtime:                 runtime,
		HistoryRuntime:          runtime,
		GoalRuntime:             runtime,
		OperationOwner:          "worker-1",
		TerminalFailureObserver: observer,
	})
	runtime.mu.Lock()
	runtime.guidanceTransportFailure = true
	runtime.mu.Unlock()
	_, err := host.SendInput(t.Context(), agenthost.SessionRef{WorkspaceID: "workspace-1", AgentSessionID: "session-1"}, agenthost.SendInput{
		Content: []agenthost.PromptContentBlock{{Type: "text", Text: "guidance"}}, Guidance: true,
		TurnID: "turn-original", ClientSubmitID: "guidance-transport",
	})
	if err == nil {
		t.Fatal("SendInput() error = nil, want transport failure")
	}
	if !errors.Is(err, agenthost.ErrSubmitDeliveryUnknown) {
		t.Fatalf("SendInput() error = %v, want ErrSubmitDeliveryUnknown", err)
	}
	if _, found, claimErr := store.GetSubmitClaim(t.Context(), "workspace-1", "session-1", "guidance-transport"); claimErr != nil || !found {
		t.Fatalf("prepared claim found=%v error=%v, want retained delivery fence", found, claimErr)
	}
	if len(observer.failures) != 1 {
		t.Fatalf("terminal failures = %#v, want 1", observer.failures)
	}
	got := observer.failures[0]
	if got.Flow != "message_send" || got.FailureStage != "runtime_exec" {
		t.Fatalf("guidance transport failure = %#v, want message_send/runtime_exec", got)
	}
}
