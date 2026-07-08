package agentruntime

import (
	"testing"

	activityshared "github.com/tutti-os/tutti/packages/agent/daemon/activity/events"
)

// Property-style contract: every phase token either maps to an explicit
// submitAvailability or is intentionally non-lifecycle (idle/unknown).
func TestSubmitAvailabilityForPhasePropertyContract(t *testing.T) {
	t.Parallel()

	livePhases := []string{
		"submitted", "running", "working", "streaming",
		string(activityshared.TurnPhaseWaitingApproval),
		string(activityshared.TurnPhaseWaitingInput),
		"waiting", "awaiting_approval",
	}
	for _, phase := range livePhases {
		got := activityshared.SubmitAvailabilityForPhase(phase)
		if got == nil || got.State != "blocked" {
			t.Fatalf("live phase %q: got %#v, want blocked", phase, got)
		}
	}

	settled := activityshared.SubmitAvailabilityForPhase("settled")
	if settled == nil || settled.State != "available" {
		t.Fatalf("settled: got %#v, want available", settled)
	}

	for _, phase := range []string{"idle", "unknown-token", ""} {
		if got := activityshared.SubmitAvailabilityForPhase(phase); got != nil {
			t.Fatalf("non-lifecycle phase %q: got %#v, want nil", phase, got)
		}
	}
}
