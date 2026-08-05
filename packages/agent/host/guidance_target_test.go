package agenthost_test

import (
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestHostGuidanceRequiresExactTargetBeforeCreatingClaim(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
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
}

func TestHostGuidanceTargetMismatchCleansPreparedClaim(t *testing.T) {
	host, store, runtime := newHostEditRetryFixture(t)
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
}
