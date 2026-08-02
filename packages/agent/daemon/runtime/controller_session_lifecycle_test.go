package agentruntime

import (
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestApplySessionEventsTracksLastError(t *testing.T) {
	t.Parallel()

	session := Session{AgentSessionID: "agent-session-1", Provider: ProviderCodex}
	failed := applySessionEvents(session, []activityshared.Event{
		newTurnActivityEvent(session, EventTurnFailed, "turn-1", SessionStatusFailed, "", "", map[string]any{
			"error": "API Error: 403 Key limit exceeded",
		}),
	})
	if failed.LastError != "API Error: 403 Key limit exceeded" {
		t.Fatalf("last error = %q, want turn failure detail", failed.LastError)
	}

	restarted := applySessionEvents(failed, []activityshared.Event{
		newTurnActivityEvent(session, EventTurnStarted, "turn-2", SessionStatusWorking, "", "", nil),
	})
	if restarted.LastError != "" {
		t.Fatalf("last error after new turn = %q, want cleared", restarted.LastError)
	}
}

func TestApplySessionEventsMergesRuntimeContextMetadata(t *testing.T) {
	t.Parallel()

	session := Session{
		AgentSessionID: "agent-session-1",
		Provider:       ProviderClaudeCode,
		RuntimeContext: map[string]any{
			"cwd": "/workspace",
		},
	}
	updated := applySessionEvents(session, []activityshared.Event{
		newSessionActivityEvent(session, EventSessionUpdated, SessionStatusReady, map[string]any{
			"runtimeContext": map[string]any{
				"providerConfig": map[string]any{
					"threadId": "thread-1",
				},
			},
		}),
	})
	if updated.RuntimeContext["cwd"] != "/workspace" {
		t.Fatalf("runtime context = %#v, want existing cwd kept", updated.RuntimeContext)
	}
	providerConfig := payloadObject(updated.RuntimeContext["providerConfig"])
	if providerConfig["threadId"] != "thread-1" {
		t.Fatalf("runtime context = %#v, want provider config", updated.RuntimeContext)
	}
}

func TestClaudeProviderRuntimeContextExcludesActorOwnedGoal(t *testing.T) {
	t.Parallel()
	input := map[string]any{
		"goal":          map[string]any{"objective": "ship", "status": "active"},
		"providerState": "ready",
	}
	got := providerPrivateRuntimeContext(ProviderClaudeCode, input)
	if _, present := got["goal"]; present {
		t.Fatalf("public Goal remained in Claude runtime context: %#v", got)
	}
	if got["providerState"] != "ready" {
		t.Fatalf("unrelated runtime state was lost: %#v", got)
	}
	if _, present := input["goal"]; !present {
		t.Fatalf("input runtime context mutated: %#v", input)
	}
}
