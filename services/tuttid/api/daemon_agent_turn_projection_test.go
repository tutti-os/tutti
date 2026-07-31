package api

import (
	"reflect"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

// Completeness guards keep the API-owned projection in lockstep with generated
// OpenAPI transport structs without coupling the service/event layer to them.
func TestGeneratedWorkspaceAgentTurnCoversAllFields(t *testing.T) {
	t.Parallel()

	projected := generatedWorkspaceAgentTurn(agentactivitybiz.Turn{
		WorkspaceID:            "ws-1",
		AgentSessionID:         "session-1",
		TurnID:                 "turn-1",
		RootProviderTurnID:     "provider-turn-1",
		CapabilityRefs:         []agentactivitybiz.CapabilityReference{{Capability: "tutti", Source: "slash_command"}},
		Origin:                 agentactivitybiz.TurnOriginGoalContinuation,
		SourceGoalOperationID:  "goal-operation-1",
		SourceGoalRevision:     2,
		SourceGoalRepairEpoch:  1,
		Phase:                  agentactivitybiz.TurnPhaseSettled,
		Outcome:                agentactivitybiz.TurnOutcomeFailed,
		ErrorMessage:           "provider exploded",
		ErrorCode:              "provider_error",
		FileChanges:            map[string]any{"added": 1},
		CompletedCommandKind:   "review",
		CompletedCommandStatus: "completed",
		StartedAtUnixMS:        1717200000000,
		SettledAtUnixMS:        1717200001000,
		CreatedAtUnixMS:        1717200000000,
		UpdatedAtUnixMS:        1717200001000,
	})
	assertGeneratedAgentProjectionFieldsPopulated(t, projected)
}

func TestGeneratedWorkspaceAgentTurnOmitsErrorForCanceledOutcome(t *testing.T) {
	t.Parallel()

	projected := generatedWorkspaceAgentTurn(agentactivitybiz.Turn{
		AgentSessionID: "session-1",
		TurnID:         "turn-1",
		Phase:          agentactivitybiz.TurnPhaseSettled,
		Outcome:        agentactivitybiz.TurnOutcomeCanceled,
		ErrorMessage:   "context canceled",
	})
	if projected.Error != nil {
		t.Fatalf("canceled turn error = %#v, want omitted transport-only error", projected.Error)
	}
}

func TestGeneratedWorkspaceAgentTurnProjectsProviderForkBindingState(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name          string
		turn          agentactivitybiz.Turn
		want          string
		wantAvailable bool
	}{
		{
			name: "bound",
			turn: agentactivitybiz.Turn{
				TurnID:             "turn-1",
				Phase:              agentactivitybiz.TurnPhaseSettled,
				RootProviderTurnID: "provider-turn-1",
			},
			want:          "bound",
			wantAvailable: true,
		},
		{
			name: "settled recovery required",
			turn: agentactivitybiz.Turn{
				TurnID: "turn-1",
				Phase:  agentactivitybiz.TurnPhaseSettled,
			},
			want: "recovery_required",
		},
		{
			name: "settled canonical identity echo requires recovery",
			turn: agentactivitybiz.Turn{
				TurnID:             "turn-1",
				Phase:              agentactivitybiz.TurnPhaseSettled,
				RootProviderTurnID: "turn-1",
			},
			want: "recovery_required",
		},
		{
			name: "running unavailable",
			turn: agentactivitybiz.Turn{
				TurnID: "turn-1",
				Phase:  agentactivitybiz.TurnPhaseRunning,
			},
			want: "unavailable",
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got := generatedWorkspaceAgentTurn(test.turn)
			if string(got.ProviderForkBindingState) != test.want {
				t.Fatalf("provider fork binding state = %q, want %q", got.ProviderForkBindingState, test.want)
			}
			if got.ProviderForkBindingAvailable != test.wantAvailable {
				t.Fatalf(
					"provider fork binding available = %v, want %v",
					got.ProviderForkBindingAvailable,
					test.wantAvailable,
				)
			}
		})
	}
}

func TestGeneratedWorkspaceAgentInteractionCoversAllFields(t *testing.T) {
	t.Parallel()

	projected := generatedWorkspaceAgentInteraction(agentactivitybiz.Interaction{
		WorkspaceID:     "ws-1",
		AgentSessionID:  "session-1",
		RequestID:       "request-1",
		TurnID:          "turn-1",
		Kind:            agentactivitybiz.InteractionKindApproval,
		Status:          agentactivitybiz.InteractionStatusPending,
		ToolName:        "shell",
		Input:           map[string]any{"command": "ls"},
		Output:          map[string]any{"optionId": "allow"},
		Metadata:        map[string]any{"source": "acp"},
		CreatedAtUnixMS: 1717200000000,
		UpdatedAtUnixMS: 1717200001000,
	})
	assertGeneratedAgentProjectionFieldsPopulated(t, projected)
}

func assertGeneratedAgentProjectionFieldsPopulated(t *testing.T, value any) {
	t.Helper()
	reflected := reflect.ValueOf(value)
	structType := reflected.Type()
	if structType.Kind() != reflect.Struct {
		t.Fatalf("expected struct, got %s", structType.Kind())
	}
	for i := range structType.NumField() {
		if reflected.Field(i).IsZero() {
			t.Errorf(
				"generated field %s.%s is zero: the API projection must assign every generated field explicitly",
				structType.Name(),
				structType.Field(i).Name,
			)
		}
	}
}
