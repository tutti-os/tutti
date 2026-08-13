package agentruntime

import (
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
	canonical "github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func TestSubmittedTurnActivityEventProjectsCapabilityReferences(t *testing.T) {
	t.Parallel()
	session := Session{Provider: ProviderCodex, AgentSessionID: "agent-1", RoomID: "room-1"}
	events := submittedTurnActivityEvents(session, "turn-1", []CapabilityReference{
		{Capability: " tutti ", Source: "slash_command"},
		{Capability: "tutti", Source: "slash_command"},
	})
	if len(events) != 1 {
		t.Fatalf("submitted events = %#v", events)
	}
	patch, ok := statePatchFromSessionEvent(
		canonical.EventSource{Provider: ProviderCodex},
		events[0],
		"agent-1",
		100,
	)
	if !ok || patch.Turn == nil || len(patch.Turn.CapabilityRefs) != 1 ||
		patch.Turn.CapabilityRefs[0] != (agentsessionstore.WorkspaceAgentCapabilityReference{Capability: "tutti", Source: "slash_command"}) {
		t.Fatalf("submitted turn patch = %#v ok=%v", patch.Turn, ok)
	}
}

func TestFailedTurnActivityEventProjectsStableErrorDetails(t *testing.T) {
	t.Parallel()

	session := Session{Provider: ProviderCodex, AgentSessionID: "agent-1", RoomID: "room-1"}
	event := newTurnActivityEvent(
		session,
		EventTurnFailed,
		"turn-1",
		SessionStatusFailed,
		"",
		"",
		map[string]any{"error": "rate limit exceeded"},
	)
	patch, ok := statePatchFromSessionEvent(
		canonical.EventSource{Provider: ProviderCodex},
		event,
		"agent-1",
		200,
	)
	if !ok || patch.Turn == nil {
		t.Fatalf("failed turn patch = %#v ok=%v", patch, ok)
	}
	if patch.Turn.ErrorCode != FailureCodeQuotaOrRateLimit || patch.Turn.ErrorMessage != "rate limit exceeded" {
		t.Fatalf("failed turn error = %q/%q", patch.Turn.ErrorCode, patch.Turn.ErrorMessage)
	}
}

func TestFailedTurnActivityEventProjectsProviderStopReason(t *testing.T) {
	t.Parallel()

	session := Session{Provider: ProviderCodex, AgentSessionID: "agent-1", RoomID: "room-1"}
	event := newTurnActivityEvent(
		session,
		EventTurnFailed,
		"turn-1",
		SessionStatusFailed,
		"",
		"",
		map[string]any{"stopReason": "max_tokens"},
	)
	patch, ok := statePatchFromSessionEvent(
		canonical.EventSource{Provider: ProviderCodex},
		event,
		"agent-1",
		200,
	)
	if !ok || patch.Turn == nil {
		t.Fatalf("failed turn patch = %#v ok=%v", patch, ok)
	}
	if patch.Turn.ErrorCode != "provider_max_tokens" || patch.Turn.ErrorMessage != "" {
		t.Fatalf("failed turn error = %q/%q", patch.Turn.ErrorCode, patch.Turn.ErrorMessage)
	}
}

func TestProviderStopFailureCodeUsesClosedVocabulary(t *testing.T) {
	t.Parallel()

	for reason, expected := range map[string]string{
		"refusal":           "provider_refusal",
		"max_tokens":        "provider_max_tokens",
		"max_turn_requests": "provider_max_turn_requests",
		"end_turn":          "",
		"future_reason":     "",
	} {
		if actual := providerStopFailureCode(reason); actual != expected {
			t.Fatalf("providerStopFailureCode(%q) = %q, want %q", reason, actual, expected)
		}
	}
}

func TestProviderRootTurnStartMakesSessionResumable(t *testing.T) {
	t.Parallel()
	controller := &Controller{}
	session := Session{Provider: ProviderCodex, AgentSessionID: "agent-1", RoomID: "room-1"}

	session = controller.foldTurnSessionEvents(session, []activityshared.Event{
		newTurnActivityEvent(session, string(activityshared.EventTurnStarted), "turn-1", SessionStatusWorking, "", "", nil),
	}, "turn-1")
	if session.Resumable {
		t.Fatal("canonical turn start made provider session resumable")
	}

	eventContext, ok := activityEventContext(session, newID(), "turn-1")
	if !ok {
		t.Fatal("provider root turn event context is invalid")
	}
	session = controller.foldTurnSessionEvents(session, []activityshared.Event{
		activityshared.NewRootProviderTurnStarted(eventContext, "turn-1", "provider-turn-1"),
	}, "turn-1")
	if !session.Resumable {
		t.Fatal("provider root turn start did not make session resumable")
	}
}

func TestGuidanceCapabilityReferencePatchDoesNotClaimTurnLifecycle(t *testing.T) {
	t.Parallel()
	activeTurnID := "turn-1"
	session := Session{
		Provider: ProviderCodex, AgentSessionID: "agent-1", RoomID: "room-1",
		TurnLifecycle: &TurnLifecycle{ActiveTurnID: &activeTurnID, Phase: string(activityshared.TurnPhaseWaitingInput)},
	}
	patch, ok := guidanceTurnCapabilityReferenceStatePatch(session, activeTurnID, []CapabilityReference{
		{Capability: " tutti ", Source: "slash_command"},
		{Capability: "tutti", Source: "slash_command"},
	})
	if !ok || patch.Turn == nil || patch.Turn.TurnID != activeTurnID || len(patch.Turn.CapabilityRefs) != 1 {
		t.Fatalf("guidance provenance patch = %#v ok=%v", patch, ok)
	}
	if patch.Turn.Phase != "" || patch.CurrentPhase != "" || patch.TurnLifecycle != nil ||
		patch.SubmitAvailability != nil || len(patch.Turn.CapabilityRefs) != 1 {
		t.Fatalf("guidance provenance patch owns lifecycle state: %#v", patch)
	}
	if got := patch.Turn.CapabilityRefs[0]; got != (agentsessionstore.WorkspaceAgentCapabilityReference{
		Capability: "tutti", Source: "slash_command",
	}) {
		t.Fatalf("guidance capability reference = %#v", got)
	}
}

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
