package agentsessionstore

import "testing"

func TestNormalizeSessionOriginRuntimeOnly(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		origin string
		want   string
	}{
		{name: "empty defaults to runtime", origin: "", want: WorkspaceAgentSessionOriginRuntime},
		{name: "runtime is accepted", origin: WorkspaceAgentSessionOriginRuntime, want: WorkspaceAgentSessionOriginRuntime},
		{name: "hook alias is not accepted", origin: "hook", want: ""},
		{name: "uppercase hook alias is not accepted", origin: "HOOK", want: ""},
		{name: "numeric hook alias is not accepted", origin: "1", want: ""},
		{name: "unknown explicit origin is not accepted", origin: "WORKSPACE_AGENT_SESSION_ORIGIN_UNKNOWN", want: ""},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			if got := NormalizeSessionOrigin(tt.origin); got != tt.want {
				t.Fatalf("NormalizeSessionOrigin(%q) = %q, want %q", tt.origin, got, tt.want)
			}
		})
	}
}

func TestFilterTimelineItemsDropsZeroIDRowsAfterCursor(t *testing.T) {
	t.Parallel()

	items := []WorkspaceAgentTimelineItem{
		{ID: 0, EventID: "local-provisional"},
		{ID: 2, EventID: "already-seen"},
		{ID: 3, EventID: "next"},
	}

	filtered := FilterTimelineItems(items, 2, 0)

	if len(filtered) != 1 {
		t.Fatalf("filtered items = %#v, want only durable item after cursor", filtered)
	}
	if filtered[0].EventID != "next" {
		t.Fatalf("filtered event id = %q, want next", filtered[0].EventID)
	}
}

func TestFilterTimelineItemsKeepsZeroIDRowsBeforeCursor(t *testing.T) {
	t.Parallel()

	items := []WorkspaceAgentTimelineItem{
		{ID: 0, EventID: "local-provisional"},
		{ID: 1, EventID: "durable"},
	}

	filtered := FilterTimelineItems(items, 0, 0)

	if len(filtered) != 2 {
		t.Fatalf("filtered items = %#v, want zero-id item before cursor advances", filtered)
	}
}

func TestRuntimeTimelineItemsForDisplayReplaysLocalItemsWhenCursorOutrunsLocalIDs(t *testing.T) {
	t.Parallel()

	local := []WorkspaceAgentTimelineItem{
		{
			ID:               101561,
			EventID:          "local-user",
			ItemType:         "message.user",
			Role:             "user",
			OccurredAtUnixMS: 1710000000100,
		},
		{
			ID:               101563,
			EventID:          "local-assistant",
			ItemType:         "message.assistant",
			Role:             "assistant",
			OccurredAtUnixMS: 1710000000200,
		},
	}

	filtered := RuntimeTimelineItemsForDisplay(nil, local, 104646, 20)

	if len(filtered) != 2 {
		t.Fatalf("filtered items = %#v, want local items replayed when upstream tail is empty", filtered)
	}
	if filtered[0].EventID != "local-user" || filtered[1].EventID != "local-assistant" {
		t.Fatalf("filtered event ids = %#v", filtered)
	}
}

func TestRuntimeTimelineItemsForDisplayDoesNotReplaySettledCompletedLocalTail(t *testing.T) {
	t.Parallel()

	local := []WorkspaceAgentTimelineItem{
		{
			ID:               0,
			EventID:          "local-user",
			ItemType:         "message.user",
			Role:             "user",
			Status:           "completed",
			OccurredAtUnixMS: 1710000000100,
		},
		{
			ID:               0,
			EventID:          "local-assistant",
			ItemType:         "message.assistant",
			Role:             "assistant",
			Status:           "completed",
			OccurredAtUnixMS: 1710000000200,
		},
	}

	filtered := RuntimeTimelineItemsForDisplay(nil, local, 104646, 20)

	if len(filtered) != 0 {
		t.Fatalf("filtered items = %#v, want settled completed local tail dropped after cursor", filtered)
	}
}

func TestRuntimeTimelineItemsForSummaryDisplayReturnsMinimalSettledMessageTail(t *testing.T) {
	t.Parallel()

	local := []WorkspaceAgentTimelineItem{
		{
			ID:               0,
			EventID:          "local-user-old",
			ItemType:         "message.user",
			Role:             "user",
			Status:           "completed",
			Payload:          map[string]any{"content": "older user"},
			OccurredAtUnixMS: 1710000000000,
		},
		{
			ID:               0,
			EventID:          "local-user-latest",
			ItemType:         "message.user",
			Role:             "user",
			Status:           "completed",
			Payload:          map[string]any{"content": "latest user"},
			OccurredAtUnixMS: 1710000000100,
		},
		{
			ID:               0,
			EventID:          "local-assistant-latest",
			ItemType:         "message.assistant",
			Role:             "assistant",
			Status:           "completed",
			Payload:          map[string]any{"content": "latest assistant"},
			OccurredAtUnixMS: 1710000000200,
		},
		{
			ID:               0,
			EventID:          "call-finished",
			ItemType:         "call.completed",
			Status:           "completed",
			OccurredAtUnixMS: 1710000000300,
		},
	}

	filtered := RuntimeTimelineItemsForSummaryDisplay(local, 20)

	if len(filtered) != 2 {
		t.Fatalf("filtered items = %#v, want latest user and assistant summary tail", filtered)
	}
	if filtered[0].EventID != "local-user-latest" || filtered[1].EventID != "local-assistant-latest" {
		t.Fatalf("filtered items = %#v", filtered)
	}
}

func TestRuntimeSnapshotForDisplayKeepsLocalCompletedTurnAgainstStaleWorkingSync(t *testing.T) {
	upstream := WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			ID:                42,
			AgentSessionID:    "agent-1",
			Provider:          "codex",
			ProviderSessionID: "provider-1",
			LifecycleStatus:   "active",
			TurnPhase:         "working",
			EffectiveStatus:   "working",
			StartedAtUnixMS:   1000,
			CreatedAtUnixMS:   1000,
			UpdatedAtUnixMS:   3000,
		}},
	}
	local := WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			AgentSessionID:    "agent-1",
			Provider:          "codex",
			ProviderSessionID: "provider-1",
			LifecycleStatus:   "active",
			TurnPhase:         "idle",
			EffectiveStatus:   "idle",
			StartedAtUnixMS:   1000,
			CreatedAtUnixMS:   1000,
			UpdatedAtUnixMS:   2000,
			EndedAtUnixMS:     2000,
		}},
	}

	display := RuntimeSnapshotForDisplay(upstream, local)

	if len(display.Sessions) != 1 {
		t.Fatalf("sessions = %#v, want one merged session", display.Sessions)
	}
	session := display.Sessions[0]
	if session.EffectiveStatus != "idle" || session.TurnPhase != "idle" {
		t.Fatalf("session status = %#v, want local completed turn to stay idle", session)
	}
	if session.ID != 42 || session.EndedAtUnixMS != 2000 {
		t.Fatalf("session metadata = %#v, want upstream identity and local end time", session)
	}
}

func TestRuntimeSnapshotForDisplayKeepsLocalFailedTurnAgainstStaleWorkingSync(t *testing.T) {
	upstream := WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			ID:                42,
			AgentSessionID:    "agent-1",
			Provider:          "claude-code",
			ProviderSessionID: "provider-1",
			LifecycleStatus:   "active",
			TurnPhase:         "working",
			EffectiveStatus:   "working",
			StartedAtUnixMS:   1000,
			CreatedAtUnixMS:   1000,
			UpdatedAtUnixMS:   3000,
		}},
	}
	local := WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			AgentSessionID:    "agent-1",
			Provider:          "claude-code",
			ProviderSessionID: "provider-1",
			LifecycleStatus:   "active",
			TurnPhase:         "failed",
			EffectiveStatus:   "failed",
			StartedAtUnixMS:   1000,
			CreatedAtUnixMS:   1000,
			UpdatedAtUnixMS:   2000,
			EndedAtUnixMS:     2000,
		}},
	}

	display := RuntimeSnapshotForDisplay(upstream, local)

	if len(display.Sessions) != 1 {
		t.Fatalf("sessions = %#v, want one merged session", display.Sessions)
	}
	session := display.Sessions[0]
	if session.EffectiveStatus != "failed" || session.TurnPhase != "failed" {
		t.Fatalf("session status = %#v, want local failed turn to stay failed", session)
	}
	if session.ID != 42 || session.EndedAtUnixMS != 2000 {
		t.Fatalf("session metadata = %#v, want upstream identity and local end time", session)
	}
}

func TestRuntimeSnapshotForDisplayAllowsNewWorkingTurnAfterLocalCompletedTurn(t *testing.T) {
	upstream := WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			AgentSessionID:    "agent-1",
			Provider:          "codex",
			ProviderSessionID: "provider-1",
			LifecycleStatus:   "active",
			TurnPhase:         "working",
			EffectiveStatus:   "working",
			StartedAtUnixMS:   2500,
			CreatedAtUnixMS:   1000,
			UpdatedAtUnixMS:   3000,
		}},
	}
	local := WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			AgentSessionID:    "agent-1",
			Provider:          "codex",
			ProviderSessionID: "provider-1",
			LifecycleStatus:   "active",
			TurnPhase:         "idle",
			EffectiveStatus:   "idle",
			StartedAtUnixMS:   1000,
			CreatedAtUnixMS:   1000,
			UpdatedAtUnixMS:   2000,
			EndedAtUnixMS:     2000,
		}},
	}

	display := RuntimeSnapshotForDisplay(upstream, local)

	if len(display.Sessions) != 1 {
		t.Fatalf("sessions = %#v, want one merged session", display.Sessions)
	}
	session := display.Sessions[0]
	if session.EffectiveStatus != "working" || session.TurnPhase != "working" {
		t.Fatalf("session status = %#v, want newer upstream turn to stay working", session)
	}
}

func TestRuntimeSnapshotForDisplayNormalizesUpstreamActiveIdleStatus(t *testing.T) {
	t.Parallel()

	upstream := WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			ID:                42,
			AgentSessionID:    "agent-1",
			Provider:          "nexight",
			ProviderSessionID: "provider-1",
			LifecycleStatus:   "active",
			TurnPhase:         "idle",
			EffectiveStatus:   "active",
			CreatedAtUnixMS:   1000,
			UpdatedAtUnixMS:   3000,
		}},
	}

	display := RuntimeSnapshotForDisplay(upstream, WorkspaceAgentSnapshot{})

	if len(display.Sessions) != 1 {
		t.Fatalf("sessions = %#v, want one session", display.Sessions)
	}
	session := display.Sessions[0]
	if session.EffectiveStatus != "idle" || session.TurnPhase != "idle" {
		t.Fatalf("session status = %#v, want active lifecycle with idle turn to display idle", session)
	}
	if session.ID != 42 || session.UpdatedAtUnixMS != 3000 {
		t.Fatalf("session metadata = %#v, want upstream metadata preserved", session)
	}
}

func TestRuntimeSnapshotForDisplayNormalizesNewerUpstreamActiveIdleOverLocalIdle(t *testing.T) {
	t.Parallel()

	upstream := WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			ID:                42,
			AgentSessionID:    "agent-1",
			Provider:          "nexight",
			ProviderSessionID: "provider-1",
			LifecycleStatus:   "active",
			TurnPhase:         "idle",
			EffectiveStatus:   "active",
			CreatedAtUnixMS:   1000,
			UpdatedAtUnixMS:   3000,
		}},
	}
	local := WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			AgentSessionID:    "agent-1",
			Provider:          "nexight",
			ProviderSessionID: "provider-1",
			LifecycleStatus:   "active",
			TurnPhase:         "idle",
			EffectiveStatus:   "idle",
			CreatedAtUnixMS:   1000,
			UpdatedAtUnixMS:   2000,
		}},
	}

	display := RuntimeSnapshotForDisplay(upstream, local)

	if len(display.Sessions) != 1 {
		t.Fatalf("sessions = %#v, want one merged session", display.Sessions)
	}
	session := display.Sessions[0]
	if session.EffectiveStatus != "idle" || session.TurnPhase != "idle" {
		t.Fatalf("session status = %#v, want newer active+idle upstream to display idle", session)
	}
	if session.ID != 42 || session.UpdatedAtUnixMS != 3000 {
		t.Fatalf("session metadata = %#v, want upstream metadata preserved", session)
	}
}

func TestRuntimeSnapshotForDisplayMergesRuntimeFallbackSessionByProviderSessionID(t *testing.T) {
	t.Parallel()

	upstream := WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			ID:                42,
			AgentSessionID:    "agent-session-1",
			Provider:          "codex",
			ProviderSessionID: "provider-session-1",
			SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus:   "active",
			TurnPhase:         "idle",
			EffectiveStatus:   "idle",
			CreatedAtUnixMS:   1000,
			UpdatedAtUnixMS:   2000,
		}},
	}
	local := WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			AgentSessionID:    "provider-session-1",
			Provider:          "codex",
			ProviderSessionID: "provider-session-1",
			SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus:   "active",
			TurnPhase:         "working",
			EffectiveStatus:   "working",
			CreatedAtUnixMS:   1000,
			UpdatedAtUnixMS:   3000,
		}},
	}

	display := RuntimeSnapshotForDisplay(upstream, local)

	if len(display.Sessions) != 1 {
		t.Fatalf("sessions = %#v, want one merged session", display.Sessions)
	}
	session := display.Sessions[0]
	if session.AgentSessionID != "agent-session-1" {
		t.Fatalf("agent session id = %q, want upstream control-plane session id", session.AgentSessionID)
	}
	if session.ProviderSessionID != "provider-session-1" {
		t.Fatalf("provider session id = %q, want shared provider session id", session.ProviderSessionID)
	}
	if session.SessionOrigin != WorkspaceAgentSessionOriginRuntime {
		t.Fatalf("session origin = %q, want runtime origin preserved", session.SessionOrigin)
	}
	if session.EffectiveStatus != "working" || session.TurnPhase != "working" {
		t.Fatalf("session status = %#v, want newer local working state", session)
	}
}

func TestRuntimeSnapshotForDisplayKeepsLocalBusyStateAgainstNewerUpstreamIdle(t *testing.T) {
	t.Parallel()

	upstream := WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			ID:                42,
			AgentSessionID:    "agent-session-1",
			Provider:          "codex",
			ProviderSessionID: "provider-session-1",
			SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus:   "active",
			TurnPhase:         "idle",
			EffectiveStatus:   "idle",
			CreatedAtUnixMS:   1000,
			UpdatedAtUnixMS:   4000,
		}},
	}
	local := WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			AgentSessionID:    "agent-session-1",
			Provider:          "codex",
			ProviderSessionID: "provider-session-1",
			SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus:   "active",
			TurnPhase:         "working",
			EffectiveStatus:   "working",
			CreatedAtUnixMS:   1000,
			UpdatedAtUnixMS:   3000,
			Title:             "Local runtime title",
		}},
	}

	display := RuntimeSnapshotForDisplay(upstream, local)

	if len(display.Sessions) != 1 {
		t.Fatalf("sessions = %#v, want one merged session", display.Sessions)
	}
	session := display.Sessions[0]
	if session.EffectiveStatus != "working" || session.TurnPhase != "working" {
		t.Fatalf("session status = %#v, want local busy state preserved against stale upstream idle", session)
	}
	if session.Title != "Local runtime title" {
		t.Fatalf("session title = %q, want local title preserved", session.Title)
	}
	if session.ID != 42 {
		t.Fatalf("session identity = %#v, want upstream identity preserved", session)
	}
}

func TestRuntimeSnapshotForDisplayKeepsIdleRuntimePlaceholderForHandlerLevelFiltering(t *testing.T) {
	t.Parallel()

	upstream := WorkspaceAgentSnapshot{
		Sessions: []ProviderActivitySessionProjection{{
			AgentSessionID:    "agent-session-placeholder",
			Provider:          "codex",
			ProviderSessionID: "provider-session-placeholder",
			SessionOrigin:     WorkspaceAgentSessionOriginRuntime,
			LifecycleStatus:   "active",
			TurnPhase:         "idle",
			EffectiveStatus:   "idle",
			Title:             "Codex",
			CreatedAtUnixMS:   1000,
			UpdatedAtUnixMS:   2000,
		}},
	}

	display := RuntimeSnapshotForDisplay(upstream, WorkspaceAgentSnapshot{})

	if len(display.Sessions) != 1 {
		t.Fatalf("sessions = %#v, want runtime placeholder preserved for handler filtering", display.Sessions)
	}
}
