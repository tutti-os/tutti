package agenthost_test

import (
	"context"
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
	if len(observer.failures) != 1 {
		t.Fatalf("terminal failures = %#v, want 1", observer.failures)
	}
	got := observer.failures[0]
	if got.Flow != "message_send" || got.FailureStage != "runtime_exec" {
		t.Fatalf("guidance transport failure = %#v, want message_send/runtime_exec", got)
	}
}
