package events

import (
	"encoding/json"
	"testing"
)

func TestTurnLifecycleSnapshotRoundTrip(t *testing.T) {
	t.Parallel()

	event := Event{Payload: EventPayload{}}
	StampTurnLifecycleSnapshot(&event, TurnLifecycleSnapshot{
		Origin:       TurnLifecycleOriginAdapter,
		Seq:          7,
		ActiveTurnID: "turn-1",
		Phase:        string(TurnPhaseRunning),
	})

	parsed, ok := TurnLifecycleSnapshotFromEvent(event)
	if !ok {
		t.Fatal("snapshot not found after stamping")
	}
	if parsed.Version != TurnLifecycleSnapshotVersion ||
		parsed.Origin != TurnLifecycleOriginAdapter ||
		parsed.Seq != 7 ||
		parsed.ActiveTurnID != "turn-1" ||
		parsed.Phase != string(TurnPhaseRunning) ||
		parsed.Outcome != "" ||
		parsed.Settling {
		t.Fatalf("snapshot round trip mismatch: %#v", parsed)
	}
}

func TestTurnLifecycleSnapshotSurvivesJSON(t *testing.T) {
	t.Parallel()

	event := Event{Payload: EventPayload{}}
	StampTurnLifecycleSnapshot(&event, TurnLifecycleSnapshot{
		Origin:  TurnLifecycleOriginController,
		Seq:     42,
		Phase:   string(TurnPhaseSettled),
		Outcome: string(TurnOutcomeInterrupted),
	})
	raw, err := json.Marshal(event.Payload.Metadata)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	metadata := map[string]any{}
	if err := json.Unmarshal(raw, &metadata); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	parsed, ok := TurnLifecycleSnapshotFromEvent(Event{Payload: EventPayload{Metadata: metadata}})
	if !ok {
		t.Fatal("snapshot lost across JSON round trip")
	}
	if parsed.Seq != 42 || parsed.Phase != string(TurnPhaseSettled) ||
		parsed.Outcome != string(TurnOutcomeInterrupted) {
		t.Fatalf("snapshot JSON round trip mismatch: %#v", parsed)
	}
}

func TestTurnLifecyclePhaseIsLive(t *testing.T) {
	t.Parallel()

	for _, phase := range LiveTurnLifecyclePhases {
		if !TurnLifecyclePhaseIsLive(phase) {
			t.Fatalf("canonical live phase %q not live", phase)
		}
	}
	for _, phase := range []string{"working", "streaming", "waiting", "awaiting_approval"} {
		if !TurnLifecyclePhaseIsLive(phase) {
			t.Fatalf("legacy live phase %q not live", phase)
		}
	}
	for _, phase := range []string{"", "settled", "idle", "failed", "nonsense"} {
		if TurnLifecyclePhaseIsLive(phase) {
			t.Fatalf("phase %q must not be live", phase)
		}
	}
}
