package events

import "testing"

func TestNormalizeProviderMapsSupportedAgentsToServerValues(t *testing.T) {
	t.Parallel()

	tests := map[string]Provider{
		"codex":       ProviderCodex,
		"tutti-agent": ProviderTuttiAgent,
		"tutti_agent": ProviderTuttiAgent,
		"nexight":     ProviderNexight,
		" claude ":    ProviderClaudeCode,
		"claude-code": ProviderClaudeCode,
		"claude_code": ProviderClaudeCode,
	}

	for input, want := range tests {
		t.Run(input, func(t *testing.T) {
			t.Parallel()

			got, ok := NormalizeProvider(input)
			if !ok {
				t.Fatalf("NormalizeProvider(%q) ok = false", input)
			}
			if got != want {
				t.Fatalf("NormalizeProvider(%q) = %q, want %q", input, got, want)
			}
		})
	}
}

func TestNormalizeProviderUsesMigratedProviderIdentities(t *testing.T) {
	t.Parallel()

	tests := map[string]Provider{
		" CODEX ":       ProviderCodex,
		" opencode-ai ": ProviderOpenCode,
	}
	for input, want := range tests {
		provider, ok := NormalizeProvider(input)
		if !ok || provider != want {
			t.Fatalf("NormalizeProvider(%q) = %q, %v; want %q, true", input, provider, ok, want)
		}
	}
}

func TestNormalizeProviderRejectsTuttiAsNexightAlias(t *testing.T) {
	t.Parallel()

	if provider, ok := NormalizeProvider("tutti"); ok {
		t.Fatalf("NormalizeProvider(tutti) = %q, true; want unsupported", provider)
	}
}

func TestNormalizeProviderHermes(t *testing.T) {
	tests := map[string]Provider{
		"hermes":       ProviderHermes,
		"Hermes":       ProviderHermes,
		"hermes-agent": ProviderHermes,
		"hermes_agent": ProviderHermes,
	}
	for input, want := range tests {
		got, ok := NormalizeProvider(input)
		if !ok || got != want {
			t.Fatalf("NormalizeProvider(%q) = %q, %v; want %q, true", input, got, ok, want)
		}
	}
}

func TestEventBuildersTrimRawSessionAndStampMilliseconds(t *testing.T) {
	t.Parallel()

	event := NewSessionStarted(EventContext{
		Provider:          ProviderCodex,
		ProviderSessionID: " raw-session ",
		CWD:               "/workspace/ws-1",
		OccurredAtUnixMS:  1710000000123,
	})

	if event.Type != EventSessionStarted {
		t.Fatalf("event type = %q, want %q", event.Type, EventSessionStarted)
	}
	if event.ProviderSessionID != "raw-session" {
		t.Fatalf("provider session id = %q", event.ProviderSessionID)
	}
	if event.Payload.CWD != "/workspace/ws-1" {
		t.Fatalf("cwd = %q", event.Payload.CWD)
	}
	if event.Payload.LifecycleStatus != string(SessionLifecycleStatusActive) {
		t.Fatalf("lifecycle status = %q, want %q", event.Payload.LifecycleStatus, SessionLifecycleStatusActive)
	}
	if event.Payload.EffectiveStatus != string(SessionStatusIdle) {
		t.Fatalf("effective status = %q, want %q", event.Payload.EffectiveStatus, SessionStatusIdle)
	}
	if event.Payload.TurnPhase != "" {
		t.Fatalf("turn phase = %q, want empty for session-level event", event.Payload.TurnPhase)
	}
	if event.Payload.TurnID != "" {
		t.Fatalf("turn id = %q, want empty for session-level event", event.Payload.TurnID)
	}
	if event.OccurredAtUnixMS != 1710000000123 {
		t.Fatalf("occurred at = %d", event.OccurredAtUnixMS)
	}
}

func TestSessionUpdatedWritesOnlySessionEffectiveStatus(t *testing.T) {
	t.Parallel()

	event := NewSessionUpdated(EventContext{
		Provider:         ProviderCodex,
		AgentSessionID:   "agent-session-1",
		OccurredAtUnixMS: 1710000000456,
	}, SessionStatusWorking)

	if event.Type != EventSessionUpdated {
		t.Fatalf("event type = %q, want %q", event.Type, EventSessionUpdated)
	}
	if event.Payload.EffectiveStatus != string(SessionStatusWorking) {
		t.Fatalf("effective status = %q, want %q", event.Payload.EffectiveStatus, SessionStatusWorking)
	}
	if event.Payload.LifecycleStatus != "" {
		t.Fatalf("lifecycle status = %q, want empty", event.Payload.LifecycleStatus)
	}
	if event.Payload.TurnPhase != "" {
		t.Fatalf("turn phase = %q, want empty", event.Payload.TurnPhase)
	}
	if event.Payload.TurnID != "" {
		t.Fatalf("turn id = %q, want empty", event.Payload.TurnID)
	}
}

func TestMessageEventRequiresStableEventIDAndRole(t *testing.T) {
	t.Parallel()

	event := NewMessageAppended(EventContext{
		EventID:           " event-1 ",
		Provider:          ProviderClaudeCode,
		ProviderSessionID: "claude-session",
		OccurredAtUnixMS:  1710000000456,
	}, MessageRoleAssistant, "done")

	if event.EventID != "event-1" {
		t.Fatalf("event id = %q", event.EventID)
	}
	if event.Type != EventMessageAppended {
		t.Fatalf("event type = %q", event.Type)
	}
	if event.Payload.Role != MessageRoleAssistant {
		t.Fatalf("role = %q", event.Payload.Role)
	}
	if event.Payload.Content != "done" {
		t.Fatalf("content = %q", event.Payload.Content)
	}
}

func TestContextEventBuildersCreateMessagesAndCompactCalls(t *testing.T) {
	t.Parallel()

	ctx := EventContext{
		EventID:           " event-1 ",
		Provider:          ProviderCodex,
		ProviderSessionID: " session-1 ",
		AgentSessionID:    "agent-session-1",
		TurnID:            "turn-1",
		CWD:               "/workspace/ws-1",
		OccurredAtUnixMS:  1710000000123,
	}

	message := NewContextMessage(ctx, MessageRoleAssistant, "done")
	if message.Type != EventMessageCreated || message.EventID != "event-1" {
		t.Fatalf("message event = %#v", message)
	}
	if message.Payload.Role != MessageRoleAssistant || message.Payload.Content != "done" || message.Payload.TurnID != "turn-1" {
		t.Fatalf("message payload = %#v", message.Payload)
	}

	started := NewCallStarted(ctx, " call-1 ", "tool", "Read", map[string]any{"path": "README.md"})
	if started.Type != EventCallStarted {
		t.Fatalf("started type = %q", started.Type)
	}
	if started.Payload.CallID != "call-1" || started.Payload.CallType != "tool" || started.Payload.Name != "Read" {
		t.Fatalf("started payload = %#v", started.Payload)
	}
	if started.Payload.Status != string(ActivityStatusRunning) || started.Payload.Input["path"] != "README.md" {
		t.Fatalf("started payload = %#v", started.Payload)
	}
	if started.Payload.CWD != "/workspace/ws-1" {
		t.Fatalf("started cwd = %q, want context cwd", started.Payload.CWD)
	}

	completed := NewCallCompleted(ctx, "call-1", "tool", "Read", map[string]any{"summary": "ok"})
	if completed.Type != EventCallCompleted || completed.Payload.Status != string(ActivityStatusCompleted) {
		t.Fatalf("completed event = %#v", completed)
	}
	if completed.Payload.Output["summary"] != "ok" {
		t.Fatalf("completed output = %#v", completed.Payload.Output)
	}

	failed := NewCallFailed(ctx, "call-1", "tool", "Read", map[string]any{"message": "boom"})
	if failed.Type != EventCallFailed || failed.Payload.Status != string(ActivityStatusFailed) {
		t.Fatalf("failed event = %#v", failed)
	}
	if failed.Payload.Error["message"] != "boom" {
		t.Fatalf("failed error = %#v", failed.Payload.Error)
	}
}
