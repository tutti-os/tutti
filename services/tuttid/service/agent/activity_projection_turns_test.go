package agent

import (
	"context"
	"reflect"
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestPublishPersistedTurnStateObservesOnlyCanonicalSettlement(t *testing.T) {
	t.Parallel()
	observer := &rootTurnObserverStub{}
	projection := &ActivityProjection{rootTurnObserver: observer}
	input := canonical.ReportSessionStateInput{
		WorkspaceID: "ws-1", AgentSessionID: "root",
	}

	if err := projection.ObserveCommitted(context.Background(), agenthost.CommittedDelta{
		ActivityState: &agenthost.ActivityStateCommitted{Input: input, Result: agentactivitybiz.ActivityStateReportResult{
			RootTurnAccepted: true,
			RootTurn: agentactivitybiz.Turn{
				AgentSessionID: "root", TurnID: "goal-turn", Phase: agentactivitybiz.TurnPhaseWaiting,
			},
		}},
	}); err != nil {
		t.Fatalf("observe waiting commit: %v", err)
	}
	if len(observer.turns) != 0 {
		t.Fatalf("waiting root turn released runtime slot: %#v", observer.turns)
	}

	settled := agentactivitybiz.Turn{
		AgentSessionID: "root", TurnID: "goal-turn", Phase: agentactivitybiz.TurnPhaseSettled,
		Outcome: agentactivitybiz.TurnOutcomeCompleted,
	}
	if err := projection.ObserveCommitted(context.Background(), agenthost.CommittedDelta{
		ActivityState: &agenthost.ActivityStateCommitted{Input: input, Result: agentactivitybiz.ActivityStateReportResult{
			RootTurnAccepted: true, RootTurn: settled,
		}},
		RootTurnsSettled: []agenthost.RootTurnSettled{{WorkspaceID: "ws-1", AgentSessionID: "root", Turn: settled}},
	}); err != nil {
		t.Fatalf("observe settled commit: %v", err)
	}
	if len(observer.turns) != 1 || observer.turns[0].TurnID != "goal-turn" || observer.turns[0].Outcome != agentactivitybiz.TurnOutcomeCompleted {
		t.Fatalf("canonical settlement observations = %#v", observer.turns)
	}
}

func TestTurnTransitionFromStateInputRequiresExplicitTurnPatch(t *testing.T) {
	t.Parallel()

	activeTurnID := "root-turn-1"
	input := canonical.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: canonical.WorkspaceAgentSessionStateUpdate{
			TurnLifecycle: &canonical.WorkspaceAgentTurnLifecycle{
				ActiveTurnID: &activeTurnID,
				Phase:        agentactivitybiz.TurnPhaseWaiting,
			},
			RootProviderTurn: &canonical.WorkspaceAgentRootProviderTurnTransition{
				RootTurnID:     "root-turn-1",
				ProviderTurnID: "provider-turn-1",
				Phase:          agentsessionstore.RootProviderTurnPhaseCompleted,
			},
		},
	}
	transition, ok := turnTransitionFromStateInput(input)

	if ok || transition.TurnID != "" {
		t.Fatalf("lifecycle-only state produced canonical turn transition: %#v", transition)
	}
	providerTransition, providerOK := rootProviderTurnTransitionFromStateInput(input)
	if !providerOK || providerTransition.RootTurnID != "root-turn-1" ||
		providerTransition.ProviderTurnID != "provider-turn-1" ||
		providerTransition.Phase != agentsessionstore.RootProviderTurnPhaseCompleted {
		t.Fatalf("root provider transition = %#v, want explicit provider terminal preserved", providerTransition)
	}
}

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
		CapabilityRefs:         []agentactivitybiz.CapabilityReference{{Capability: "tutti", Source: "slash_command"}},
		Origin:                 agentactivitybiz.TurnOriginGoalContinuation,
		SourceGoalOperationID:  "goal-op-1",
		SourceGoalRevision:     2,
		SourceGoalRepairEpoch:  3,
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

func TestGeneratedWorkspaceAgentTurnOmitsErrorForCanceledOutcome(t *testing.T) {
	t.Parallel()

	projected := GeneratedWorkspaceAgentTurn(agentactivitybiz.Turn{
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
