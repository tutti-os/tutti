package agentruntime

import (
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

func TestRetainTurnCallLifecycleEventsKeepsFailedThinkingSnapshots(t *testing.T) {
	t.Parallel()

	session := Session{Provider: ProviderClaudeCode, AgentSessionID: "agent-1", RoomID: "room-1"}
	normalizer := newACPTurnNormalizer()
	events := append([]activityshared.Event{}, normalizer.ApplyStreamingThinkingSnapshot(
		session,
		"turn-1",
		"Still thinking.",
		"claude-sdk:thinking:msg:live:0",
	)...)
	events = append(events, normalizer.FinishInterrupted(session, "turn-1", "user_interrupt")...)
	events = append(events, newTurnActivityEvent(session, EventTurnStarted, "turn-other", SessionStatusWorking, "", "", nil))

	retained := retainTurnCallLifecycleEvents(events, "turn-1")
	if len(retained) != 1 {
		t.Fatalf("retained = %#v, want one failed thinking snapshot", retained)
	}
	if retained[0].EventID != "claude-sdk:thinking:msg:live:0" ||
		retained[0].Payload.Role != activityshared.MessageRoleAssistantThinking ||
		retained[0].Payload.Metadata["streamState"] != messageStreamStateFailed {
		t.Fatalf("retained thinking = %#v, want failed stream settlement", retained[0])
	}
}

func TestRetainTurnCallLifecycleEventsKeepsCallFailedAndDropsStreaming(t *testing.T) {
	t.Parallel()

	session := Session{Provider: ProviderClaudeCode, AgentSessionID: "agent-1", RoomID: "room-1"}
	streaming := newTurnActivityEventWithID(
		session,
		"claude-sdk:thinking:msg:live:0",
		EventMessage,
		"turn-1",
		messageStreamStateStreaming,
		RoleAssistantThinking,
		"partial",
		map[string]any{"streamState": messageStreamStateStreaming},
	)
	failedCall := newTurnActivityEventWithID(
		session,
		"claude-sdk:tool:toolu-1",
		EventCallFailed,
		"turn-1",
		SessionStatusCanceled,
		"",
		"Write",
		map[string]any{"status": SessionStatusCanceled, "callId": "toolu-1"},
	)
	retained := retainTurnCallLifecycleEvents([]activityshared.Event{streaming, failedCall}, "turn-1")
	if len(retained) != 1 || retained[0].EventID != "claude-sdk:tool:toolu-1" {
		t.Fatalf("retained = %#v, want only call.failed", retained)
	}
}
