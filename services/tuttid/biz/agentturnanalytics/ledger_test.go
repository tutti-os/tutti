package agentturnanalytics

import "testing"

func TestStableEventIDIsTurnScopedAndDeterministic(t *testing.T) {
	first := StableEventID("workspace-1", "session-1", "turn-1")
	if first == "" || first != StableEventID("workspace-1", "session-1", "turn-1") {
		t.Fatalf("stable event id = %q", first)
	}
	if first == StableEventID("workspace-1", "session-1", "turn-2") {
		t.Fatal("different Turns received the same event id")
	}
}
