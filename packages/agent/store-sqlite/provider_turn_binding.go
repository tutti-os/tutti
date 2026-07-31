package storesqlite

import (
	"encoding/json"
	"errors"
	"strings"
)

// HasPersistedProviderTurnBinding performs only provider-neutral persistence
// checks. The owning Agent's CanForkProviderTurn hook is authoritative.
func HasPersistedProviderTurnBinding(turn Turn) bool {
	turnID := strings.TrimSpace(turn.TurnID)
	providerTurnID := strings.TrimSpace(turn.RootProviderTurnID)
	if turnID == "" || providerTurnID == "" || providerTurnID == turnID {
		return false
	}
	var payload map[string]any
	return len(turn.ProviderTurnBindingJSON) > 0 &&
		json.Unmarshal(turn.ProviderTurnBindingJSON, &payload) == nil &&
		len(payload) > 0
}

func normalizeProviderTurnBindingJSON(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var payload map[string]any
	if err := json.Unmarshal(raw, &payload); err != nil || payload == nil {
		return nil, errors.New("provider turn binding must be a JSON object")
	}
	normalized, err := json.Marshal(payload)
	if err != nil {
		return nil, errors.New("encode provider turn binding")
	}
	return normalized, nil
}

func firstNonEmptyJSON(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage(`{}`)
	}
	return raw
}
