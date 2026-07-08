package agentruntime

import (
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// Bundle 4 regression: the live reporter path must push blocked submit
// availability for every live phase, including legacy tokens like streaming
// that fall through the explicit-lifecycle fallback when no snapshot is
// stamped. A nil SubmitAvailability in the patch lets the GUI keep a stale
// "available" and hard-send into an active turn.
func TestStatePatchFromSessionEventFallbackSubmitAvailabilityLivePhases(t *testing.T) {
	t.Parallel()

	session := Session{
		RoomID:            "room-1",
		AgentSessionID:    "agent-1",
		Provider:          ProviderClaudeCode,
		ProviderSessionID: "claude-1",
	}
	source := agentsessionstore.EventSource{Provider: ProviderClaudeCode}

	cases := []struct {
		name      string
		turnPhase string
	}{
		{"working", string(activityshared.TurnPhaseWorking)},
		{"streaming", "streaming"},
		{"waiting_approval", string(activityshared.TurnPhaseWaitingApproval)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()

			event := newTurnActivityEvent(
				session,
				EventTurnUpdated,
				"turn-live",
				SessionStatusWorking,
				tc.turnPhase,
				"",
				nil,
			)
			patch, ok := statePatchFromSessionEvent(source, event, "agent-1", 1000)
			if !ok {
				t.Fatal("turn.updated did not produce a state patch")
			}
			if patch.SubmitAvailability == nil {
				t.Fatalf("patch submit availability = nil, want blocked for phase %q", tc.turnPhase)
			}
			if patch.SubmitAvailability.State != "blocked" {
				t.Fatalf(
					"patch submit availability state = %q, want blocked for phase %q",
					patch.SubmitAvailability.State,
					tc.turnPhase,
				)
			}
		})
	}
}

// Snapshot-authority path must also block every live phase token, including
// legacy working/streaming persisted by older writers.
func TestStatePatchFromSessionEventSnapshotSubmitAvailabilityLivePhases(t *testing.T) {
	t.Parallel()

	session := Session{
		RoomID:            "room-1",
		AgentSessionID:    "agent-1",
		Provider:          ProviderClaudeCode,
		ProviderSessionID: "claude-1",
	}
	source := agentsessionstore.EventSource{Provider: ProviderClaudeCode}

	for _, phase := range []string{"working", "streaming"} {
		t.Run(phase, func(t *testing.T) {
			t.Parallel()

			event := newTurnActivityEvent(session, EventTurnUpdated, "turn-live", SessionStatusWorking, phase, "", nil)
			activityshared.StampTurnLifecycleSnapshot(&event, activityshared.TurnLifecycleSnapshot{
				Origin:       activityshared.TurnLifecycleOriginAdapter,
				Seq:          2,
				ActiveTurnID: "turn-live",
				Phase:        phase,
			})
			patch, ok := statePatchFromSessionEvent(source, event, "agent-1", 1000)
			if !ok {
				t.Fatal("stamped turn.updated did not produce a state patch")
			}
			if patch.SubmitAvailability == nil || patch.SubmitAvailability.State != "blocked" {
				t.Fatalf("patch submit availability = %#v, want blocked for phase %q", patch.SubmitAvailability, phase)
			}
		})
	}
}
