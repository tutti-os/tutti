package storesqlite

import (
	"encoding/json"
	"testing"
)

func TestHasPersistedProviderTurnBindingRequiresOpaqueJSON(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name string
		turn Turn
		want bool
	}{
		{
			name: "agent binding",
			turn: Turn{
				TurnID: "turn-1", RootProviderTurnID: "provider-turn-1",
				ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
			},
			want: true,
		},
		{
			name: "historical identity only",
			turn: Turn{
				TurnID: "turn-1", RootProviderTurnID: "synthetic-provider-turn",
				ProviderTurnBindingJSON: json.RawMessage(`{}`),
			},
		},
		{
			name: "canonical identity echo",
			turn: Turn{
				TurnID: "turn-1", RootProviderTurnID: "turn-1",
				ProviderTurnBindingJSON: json.RawMessage(`{"schemaVersion":1}`),
			},
		},
		{
			name: "invalid json",
			turn: Turn{
				TurnID: "turn-1", RootProviderTurnID: "provider-turn-1",
				ProviderTurnBindingJSON: json.RawMessage(`[]`),
			},
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := HasPersistedProviderTurnBinding(test.turn); got != test.want {
				t.Fatalf("HasPersistedProviderTurnBinding() = %v, want %v", got, test.want)
			}
		})
	}
}
