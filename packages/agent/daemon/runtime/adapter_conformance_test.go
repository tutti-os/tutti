package agentruntime

import (
	"context"
	"strings"
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

type cancelConformanceCase struct {
	name string
	run  func(t *testing.T)
}

// Adapter cancel contract shared by production adapters. Keep this table
// provider-agnostic: it pins semantics, not transport details.
func TestAdapterCancelConformance(t *testing.T) {
	t.Parallel()

	cases := []cancelConformanceCase{
		{
			name: "claude sdk cancel ignores reason string as turn id",
			run:  testClaudeSDKCancelIgnoresReasonAsTurnID,
		},
		{
			name: "codex cancel without active turn returns ErrSessionNoActiveTurn",
			run:  testCodexCancelWithoutActiveTurn,
		},
		{
			name: "standard acp cancel is idempotent",
			run:  testStandardACPCancelIdempotent,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			tc.run(t)
		})
	}
}

func testClaudeSDKCancelIgnoresReasonAsTurnID(t *testing.T) {
	t.Helper()
	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &recordingClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.registerClaudeSDKTurn(adapterSession, "turn-live", nil)

	events, err := adapter.Cancel(context.Background(), session, CancelRequest{Reason: "user"})
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	for _, event := range events {
		if strings.TrimSpace(event.Payload.TurnID) == "user" {
			t.Fatalf("cancel reason was stamped as turn id: %#v", event)
		}
	}
}

func testCodexCancelWithoutActiveTurn(t *testing.T) {
	t.Helper()
	adapter, _, session := startedAppServerAdapter(t)
	_, err := adapter.Cancel(context.Background(), session, CancelRequest{Reason: "user"})
	if err == nil {
		t.Fatal("Cancel without active turn returned nil error")
	}
	if !strings.Contains(err.Error(), ErrSessionNoActiveTurn.Error()) {
		t.Fatalf("Cancel error = %v, want ErrSessionNoActiveTurn", err)
	}
}

func testStandardACPCancelIdempotent(t *testing.T) {
	t.Helper()
	transport := newScriptedACPTransport()
	adapter := NewClaudeCodeAdapter(transport)
	session := Session{
		AgentSessionID:    "agent-acp-1",
		Provider:          ProviderClaudeCode,
		ProviderSessionID: "acp-1",
	}
	if _, err := adapter.Start(context.Background(), session); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if _, err := adapter.Cancel(context.Background(), session, CancelRequest{Reason: "user"}); err != nil {
		t.Fatalf("first Cancel: %v", err)
	}
	if _, err := adapter.Cancel(context.Background(), session, CancelRequest{Reason: "user"}); err != nil {
		t.Fatalf("second Cancel: %v", err)
	}
}

func TestClaudeSDKDispatchRoutingContract(t *testing.T) {
	t.Parallel()

	waiter := &claudeSDKTurnWaiter{turnID: "turn-1"}
	if got := decideClaudeSDKDispatch(waiter, true); got != ClaudeSDKDispatchCompleteWaiter {
		t.Fatalf("tracked terminal = %q, want complete_waiter", got)
	}
	if got := decideClaudeSDKDispatch(nil, true); got != ClaudeSDKDispatchDropTerminal {
		t.Fatalf("untracked terminal = %q, want drop_terminal", got)
	}
	if got := decideClaudeSDKDispatch(nil, false); got != ClaudeSDKDispatchPublish {
		t.Fatalf("non-terminal = %q, want publish", got)
	}
}

func TestClaudeSDKCancelNeverStampsReasonTurnID(t *testing.T) {
	t.Parallel()

	adapter := NewClaudeCodeSDKAdapter(nil)
	conn := &recordingClaudeSDKConnection{}
	session, adapterSession := newClaudeSDKLifecycleTestSession(t, adapter, conn)
	adapter.registerClaudeSDKTurn(adapterSession, "turn-live", nil)

	events, err := adapter.Cancel(context.Background(), session, CancelRequest{Reason: "user"})
	if err != nil {
		t.Fatalf("Cancel: %v", err)
	}
	for _, event := range events {
		if event.Type == activityshared.EventTurnCompleted {
			if event.Payload.TurnID == "user" {
				t.Fatalf("reason stamped as turn id: %#v", event)
			}
		}
	}
}
