package agentruntime

import (
	"strings"
	"testing"
)

func TestClaudeSDKContextRecoveryHostContextUsesTuttiCLIOnDemand(t *testing.T) {
	t.Parallel()

	hostContext := renderClaudeSDKContextRecoveryHostContext(
		Session{AgentSessionID: "tutti-session-1"},
		claudeSDKContextRecoveryState{
			Generation: 1,
			State:      claudeSDKContextRecoveryStateHandoff,
		},
	)
	for _, expected := range []string{
		`kind="claude-context-recovery"`,
		"tutti-session-1",
		`agent get --session-id "$TUTTI_AGENT_SESSION_ID" --json`,
		"Retrieve only the earlier turns needed",
		"Do not claim to remember content you have not read",
	} {
		if !strings.Contains(hostContext, expected) {
			t.Fatalf("host context missing %q: %s", expected, hostContext)
		}
	}
}

func TestClaudeSDKContextRecoveryHostContextIsSentOnlyWhileHandoffPending(t *testing.T) {
	t.Parallel()

	session := Session{AgentSessionID: "tutti-session-1"}
	for _, state := range []claudeSDKContextRecoveryState{
		{Generation: 1, State: claudeSDKContextRecoveryStatePending},
		{Generation: 1, State: claudeSDKContextRecoveryStateCompleted},
		{Generation: 1, State: claudeSDKContextRecoveryStateHandoff, HandoffSent: true},
	} {
		if got := renderClaudeSDKContextRecoveryHostContext(session, state); got != "" {
			t.Fatalf("state=%#v rendered host context %q", state, got)
		}
	}
}

func TestClaudeSDKContextRecoveryRetriesHandoffAfterPreAcceptanceFailure(t *testing.T) {
	t.Parallel()

	adapterSession := &claudeSDKAdapterSession{contextRecovery: claudeSDKContextRecoveryState{
		Generation: 1,
		State:      claudeSDKContextRecoveryStateHandoff,
	}}
	if !adapterSession.markContextRecoveryHandoffSent() {
		t.Fatal("first handoff was not marked sent")
	}
	adapterSession.resetContextRecoveryHandoffSent()
	if got := renderClaudeSDKContextRecoveryHostContext(
		Session{AgentSessionID: "tutti-session-1"},
		adapterSession.contextRecoverySnapshot(),
	); got == "" {
		t.Fatal("handoff was not made retryable")
	}
}
