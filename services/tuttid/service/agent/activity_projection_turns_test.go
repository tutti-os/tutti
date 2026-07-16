package agent

import (
	"testing"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
)

func TestTurnTransitionFromStateInputRequiresExplicitTurnPatch(t *testing.T) {
	t.Parallel()

	activeTurnID := "root-turn-1"
	input := agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			TurnLifecycle: &agentsessionstore.WorkspaceAgentTurnLifecycle{
				ActiveTurnID: &activeTurnID,
				Phase:        agentactivitybiz.TurnPhaseWaiting,
			},
			RootProviderTurn: &agentsessionstore.WorkspaceAgentRootProviderTurnTransition{
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

func TestTurnTransitionFromStateInputCarriesCapabilityReferences(t *testing.T) {
	t.Parallel()
	input := agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			OccurredAtUnixMS: 100,
			Turn: &agentsessionstore.WorkspaceAgentTurnStateUpdate{
				TurnID: "turn-1",
				Phase:  agentactivitybiz.TurnPhaseSubmitted,
				CapabilityRefs: []agentsessionstore.WorkspaceAgentCapabilityReference{{
					Capability: "tutti",
					Source:     "slash_command",
				}},
			},
		},
	}

	transition, ok := turnTransitionFromStateInput(input)
	if !ok || len(transition.CapabilityRefs) != 1 ||
		transition.CapabilityRefs[0] != (agentactivitybiz.CapabilityReference{Capability: "tutti", Source: "slash_command"}) {
		t.Fatalf("turn transition = %#v", transition)
	}
}

func TestTurnTransitionFromStateInputAllowsCapabilityOnlyPatch(t *testing.T) {
	t.Parallel()
	input := agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			OccurredAtUnixMS: 100,
			Turn: &agentsessionstore.WorkspaceAgentTurnStateUpdate{
				TurnID: "turn-1",
				CapabilityRefs: []agentsessionstore.WorkspaceAgentCapabilityReference{{
					Capability: "tutti",
					Source:     "slash_command",
				}},
			},
		},
	}

	transition, ok := turnTransitionFromStateInput(input)
	if !ok || transition.Phase != "" || len(transition.CapabilityRefs) != 1 {
		t.Fatalf("capability-only turn transition = %#v ok=%v", transition, ok)
	}
}

func TestTurnTransitionFromStateInputIgnoresEmptyPhaseWithoutCapabilityReferences(t *testing.T) {
	t.Parallel()
	input := agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			Turn: &agentsessionstore.WorkspaceAgentTurnStateUpdate{TurnID: "turn-1"},
		},
	}

	transition, ok := turnTransitionFromStateInput(input)
	if ok || transition.TurnID != "" {
		t.Fatalf("empty turn patch produced transition = %#v ok=%v", transition, ok)
	}
}

func TestTurnTransitionFromStateInputIgnoresUnknownPhaseWithCapabilityReferences(t *testing.T) {
	t.Parallel()
	input := agentsessionstore.ReportSessionStateInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		State: agentsessionstore.WorkspaceAgentSessionStateUpdate{
			Turn: &agentsessionstore.WorkspaceAgentTurnStateUpdate{
				TurnID: "turn-1",
				Phase:  "unknown_phase",
				CapabilityRefs: []agentsessionstore.WorkspaceAgentCapabilityReference{{
					Capability: "tutti",
					Source:     "slash_command",
				}},
			},
		},
	}

	transition, ok := turnTransitionFromStateInput(input)
	if ok || transition.TurnID != "" {
		t.Fatalf("unknown phase produced metadata transition = %#v ok=%v", transition, ok)
	}
}

func TestActivityTurnUpdateEventPayloadOmitsTuttiPlanningMode(t *testing.T) {
	t.Parallel()

	payload := activityTurnUpdateEventPayload("ws-1", "session-1", agentactivitybiz.Turn{
		AgentSessionID: "session-1",
		TurnID:         "turn-1",
		Phase:          agentactivitybiz.TurnPhaseRunning,
	}, 1717200000000)
	turn, ok := payload["turn"].(map[string]any)
	if !ok {
		t.Fatalf("turn payload = %#v, want object", payload["turn"])
	}
	if _, exists := turn["planningMode"]; exists {
		t.Fatalf("turn payload = %#v, want provider turn state without Tutti workflow metadata", turn)
	}
}
