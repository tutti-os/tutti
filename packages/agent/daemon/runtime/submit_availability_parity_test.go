package agentruntime

import "testing"

// PARITY TABLE: mirrored in TypeScript at
// packages/agent/activity-core/src/selectors.test.ts
// (deriveSubmitAvailabilityParityCases) — keep the two tables identical. The
// GUI derives submit availability locally from turnLifecycle +
// runtimeContext, and this table pins both derivations to the same semantics.
// (The TS side additionally treats an activeTurnId without a phase as a live
// turn — a defensive case the daemon never emits.)
func TestSubmitAvailabilityForAuthoritySessionParity(t *testing.T) {
	t.Parallel()

	turnID := "turn-1"
	cases := []struct {
		name           string
		lifecycle      *TurnLifecycle
		runtimeContext map[string]any
		expectedState  string
		expectedReason string
	}{
		{
			name:          "no lifecycle -> available (token fallbacks live in the callers)",
			expectedState: "available",
		},
		{
			name:           "running turn -> blocked/active_turn",
			lifecycle:      &TurnLifecycle{ActiveTurnID: &turnID, Phase: "running"},
			expectedState:  "blocked",
			expectedReason: "active_turn",
		},
		{
			name:           "submitted turn -> blocked/active_turn",
			lifecycle:      &TurnLifecycle{ActiveTurnID: &turnID, Phase: "submitted"},
			expectedState:  "blocked",
			expectedReason: "active_turn",
		},
		{
			name:           "waiting_approval -> blocked/waiting",
			lifecycle:      &TurnLifecycle{ActiveTurnID: &turnID, Phase: "waiting_approval"},
			expectedState:  "blocked",
			expectedReason: "waiting",
		},
		{
			name:           "legacy awaiting_approval -> blocked/waiting",
			lifecycle:      &TurnLifecycle{ActiveTurnID: &turnID, Phase: "awaiting_approval"},
			expectedState:  "blocked",
			expectedReason: "waiting",
		},
		{
			name:          "settled -> available",
			lifecycle:     &TurnLifecycle{Phase: "settled"},
			expectedState: "available",
		},
		{
			name:      "settled with live background agents (count) -> blocked/background_agent",
			lifecycle: &TurnLifecycle{Phase: "settled"},
			runtimeContext: map[string]any{
				"backgroundAgents": map[string]any{"count": 1, "items": []any{}},
			},
			expectedState:  "blocked",
			expectedReason: "background_agent",
		},
		{
			name:      "settled with a running background item (no status) -> blocked/background_agent",
			lifecycle: &TurnLifecycle{Phase: "settled"},
			runtimeContext: map[string]any{
				"backgroundAgents": map[string]any{"count": 0, "items": []any{map[string]any{"id": "agent-1"}}},
			},
			expectedState:  "blocked",
			expectedReason: "background_agent",
		},
		{
			name:      "settled with only terminal background items -> available",
			lifecycle: &TurnLifecycle{Phase: "settled"},
			runtimeContext: map[string]any{
				"backgroundAgents": map[string]any{"count": 0, "items": []any{
					map[string]any{"status": "completed"},
					map[string]any{"status": "failed"},
					map[string]any{"status": "stopped"},
				}},
			},
			expectedState: "available",
		},
	}

	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()

			session := Session{
				TurnLifecycle:  tt.lifecycle,
				RuntimeContext: tt.runtimeContext,
			}
			availability := submitAvailabilityForAuthoritySession(session)
			if availability == nil {
				t.Fatal("submitAvailabilityForAuthoritySession returned nil")
			}
			if availability.State != tt.expectedState || availability.Reason != tt.expectedReason {
				t.Fatalf(
					"availability = %s/%s, want %s/%s",
					availability.State, availability.Reason,
					tt.expectedState, tt.expectedReason,
				)
			}
		})
	}
}
