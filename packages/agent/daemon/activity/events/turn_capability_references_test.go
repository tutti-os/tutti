package events

import (
	"encoding/json"
	"testing"
)

func TestTurnCapabilityReferencesSurviveJSONRoundTrip(t *testing.T) {
	event := Event{Payload: EventPayload{}}
	StampTurnCapabilityReferences(&event, []CapabilityReference{
		{Capability: " tutti ", Source: "slash_command"},
		{Capability: "tutti", Source: "slash_command"},
		{Capability: "", Source: "slash_command"},
	})

	encoded, err := json.Marshal(event.Payload.Metadata)
	if err != nil {
		t.Fatalf("marshal metadata: %v", err)
	}
	var metadata map[string]any
	if err := json.Unmarshal(encoded, &metadata); err != nil {
		t.Fatalf("unmarshal metadata: %v", err)
	}
	got := TurnCapabilityReferencesFromEvent(Event{Payload: EventPayload{Metadata: metadata}})
	if len(got) != 1 || got[0] != (CapabilityReference{Capability: "tutti", Source: "slash_command"}) {
		t.Fatalf("capability refs = %#v", got)
	}
}
