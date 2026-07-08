package events

import (
	"reflect"
	"testing"
)

// Every live turn-lifecycle phase must map to blocked(active_turn), not nil.
// Returning nil for a live phase drops SubmitAvailability from the pushed state
// patch, so the GUI keeps a stale "available" and lets the user submit into an
// active turn (which the daemon then rejects with "already has an active turn").
func TestSubmitAvailabilityForPhaseCoversLivePhases(t *testing.T) {
	t.Parallel()

	blockedActive := &SubmitAvailability{State: "blocked", Reason: "active_turn"}
	blockedWaiting := &SubmitAvailability{State: "blocked", Reason: "waiting"}
	available := &SubmitAvailability{State: "available"}

	cases := []struct {
		phase string
		want  *SubmitAvailability
	}{
		{"settled", available},
		{"submitted", blockedActive},
		{"running", blockedActive},
		{"working", blockedActive},
		{"streaming", blockedActive},
		{string(TurnPhaseWaitingApproval), blockedWaiting},
		{string(TurnPhaseWaitingInput), blockedWaiting},
		{"idle", nil},
		{"", nil},
	}
	for _, tc := range cases {
		got := SubmitAvailabilityForPhase(tc.phase)
		if !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("phase %q: got %#v, want %#v", tc.phase, got, tc.want)
		}
	}
}
