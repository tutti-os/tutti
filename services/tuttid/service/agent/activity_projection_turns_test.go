package agent

import (
	"reflect"
	"testing"

	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

// Completeness-guard tests (agent-gui refactor plan rule six): the projection
// from stored domain records to generated transport types must assign every
// generated field explicitly. These tests project a fully populated stored
// record and fail on any zero-valued generated field, so regenerating the
// OpenAPI types with a new field turns the build red until the projection
// handles it.

func TestGeneratedWorkspaceAgentTurnCoversAllFields(t *testing.T) {
	t.Parallel()

	projected := GeneratedWorkspaceAgentTurn(agentactivitybiz.Turn{
		WorkspaceID:            "ws-1",
		AgentSessionID:         "session-1",
		TurnID:                 "turn-1",
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
	assertGeneratedFieldsPopulated(t, projected)
}

func TestGeneratedWorkspaceAgentInteractionCoversAllFields(t *testing.T) {
	t.Parallel()

	projected := GeneratedWorkspaceAgentInteraction(agentactivitybiz.Interaction{
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
	assertGeneratedFieldsPopulated(t, projected)
}

// assertGeneratedFieldsPopulated reflects over a generated transport struct
// and fails for any zero-valued field. Inputs above are constructed so every
// generated field must be populated; a zero value therefore means the
// projection dropped (or never learned about) that field.
func assertGeneratedFieldsPopulated(t *testing.T, value any) {
	t.Helper()
	reflected := reflect.ValueOf(value)
	structType := reflected.Type()
	if structType.Kind() != reflect.Struct {
		t.Fatalf("expected struct, got %s", structType.Kind())
	}
	for i := range structType.NumField() {
		if reflected.Field(i).IsZero() {
			t.Errorf(
				"generated field %s.%s is zero: the projection must assign every generated field explicitly (refactor plan rule six)",
				structType.Name(),
				structType.Field(i).Name,
			)
		}
	}
}
