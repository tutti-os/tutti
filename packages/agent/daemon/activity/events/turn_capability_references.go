package events

import "strings"

// CapabilityReference records structured provenance for a capability that
// influenced one canonical turn, whether introduced by its initial submission
// or later native guidance. It is activity metadata, never provider prompt
// text.
type CapabilityReference struct {
	Capability string `json:"capability"`
	Source     string `json:"source"`
}

// TurnCapabilityReferencesMetadataKey is the stable activity-event metadata
// key used to carry provenance from controller-owned submission events into
// the durable turn projection. Native guidance uses a lifecycle-neutral turn
// state patch instead of this event metadata carrier.
const TurnCapabilityReferencesMetadataKey = "turnCapabilityRefs"

// StampTurnCapabilityReferences attaches normalized, de-duplicated references
// to a turn event. Empty references intentionally leave the event unchanged.
func StampTurnCapabilityReferences(event *Event, references []CapabilityReference) {
	if event == nil {
		return
	}
	normalized := NormalizeCapabilityReferences(references)
	if len(normalized) == 0 {
		return
	}
	if event.Payload.Metadata == nil {
		event.Payload.Metadata = map[string]any{}
	}
	encoded := make([]map[string]any, 0, len(normalized))
	for _, reference := range normalized {
		encoded = append(encoded, map[string]any{
			"capability": reference.Capability,
			"source":     reference.Source,
		})
	}
	event.Payload.Metadata[TurnCapabilityReferencesMetadataKey] = encoded
}

// TurnCapabilityReferencesFromEvent extracts references after either an
// in-process handoff or a JSON round trip through the report worker.
func TurnCapabilityReferencesFromEvent(event Event) []CapabilityReference {
	raw, ok := event.Payload.Metadata[TurnCapabilityReferencesMetadataKey]
	if !ok {
		return nil
	}
	decoded := make([]CapabilityReference, 0)
	switch values := raw.(type) {
	case []map[string]any:
		for _, value := range values {
			decoded = append(decoded, capabilityReferenceFromMap(value))
		}
	case []any:
		for _, value := range values {
			if mapped, ok := value.(map[string]any); ok {
				decoded = append(decoded, capabilityReferenceFromMap(mapped))
			}
		}
	case []CapabilityReference:
		decoded = append(decoded, values...)
	}
	return NormalizeCapabilityReferences(decoded)
}

func NormalizeCapabilityReferences(references []CapabilityReference) []CapabilityReference {
	seen := make(map[string]struct{}, len(references))
	normalized := make([]CapabilityReference, 0, len(references))
	for _, reference := range references {
		reference.Capability = strings.TrimSpace(reference.Capability)
		reference.Source = strings.TrimSpace(reference.Source)
		if reference.Capability == "" || reference.Source == "" {
			continue
		}
		key := reference.Source + "\x00" + reference.Capability
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		normalized = append(normalized, reference)
	}
	return normalized
}

func capabilityReferenceFromMap(value map[string]any) CapabilityReference {
	capability, _ := value["capability"].(string)
	source, _ := value["source"].(string)
	return CapabilityReference{Capability: capability, Source: source}
}
