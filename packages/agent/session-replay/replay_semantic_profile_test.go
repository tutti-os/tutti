package sessionreplay

import (
	"errors"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
)

func TestAgentSemanticProfileRejectsUnsupportedProductDomains(t *testing.T) {
	state := agentOnlyReplayState()
	if err := ValidateTuttiReplayStateForProfile(state, AgentSemanticProfile()); err != nil {
		t.Fatalf("Agent-only state error = %v", err)
	}

	withInactiveTuttiMode := state
	withInactiveTuttiMode.TuttiMode.TurnSnapshots = []TuttiReplayTurnSnapshot{{
		SessionID: "session-root", TurnID: "turn-1", State: "inactive",
		DispatchState: "accepted",
	}}
	if err := ValidateTuttiReplayStateForProfile(
		withInactiveTuttiMode,
		AgentSemanticProfile(),
	); err != nil {
		t.Fatalf("inactive Tutti Mode snapshot error = %v", err)
	}

	withConfiguredTuttiMode := state
	withConfiguredTuttiMode.TuttiMode.TurnSnapshots = []TuttiReplayTurnSnapshot{{
		SessionID: "session-root", TurnID: "turn-1",
		ActivationID: "activation-1", RevisionID: "revision-1", Revision: 1,
		State: "inactive", Source: "badge_remove", PreferenceVersion: 1,
		DispatchState: "accepted",
	}}
	if err := ValidateTuttiReplayStateForProfile(
		withConfiguredTuttiMode,
		AgentSemanticProfile(),
	); !errors.Is(err, ErrUnsupportedReplaySemanticDomain) {
		t.Fatalf("configured Tutti Mode dependency error = %v", err)
	}

	withWorkflow := state
	withWorkflow.Workflows = []TuttiReplayWorkflow{{
		ID: "workflow-1", IssueIDs: []string{},
	}}
	if err := ValidateTuttiReplayStateForProfile(
		withWorkflow,
		AgentSemanticProfile(),
	); !errors.Is(err, ErrUnsupportedReplaySemanticDomain) {
		t.Fatalf("Workflow dependency error = %v", err)
	}
	if err := ValidateTuttiReplayStateForProfile(
		withWorkflow,
		TuttiSemanticProfile(),
	); err != nil {
		t.Fatalf("Tutti profile rejected Workflow state: %v", err)
	}
}

func TestAgentSemanticProfileIgnoresInactiveTuttiModeSnapshots(t *testing.T) {
	withInactiveSnapshot := agentOnlyReplayState()
	withInactiveSnapshot.TuttiMode.TurnSnapshots = []TuttiReplayTurnSnapshot{{
		SessionID: "session-root", TurnID: "turn-1", State: "inactive",
		DispatchState: "accepted",
	}}

	merged, err := MergeTuttiReplayStatesForProfile(
		[]TuttiReplayState{withInactiveSnapshot},
		AgentSemanticProfile(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(merged.TuttiMode.TurnSnapshots) != 0 {
		t.Fatalf("merged inactive Tutti Mode snapshots = %#v", merged.TuttiMode.TurnSnapshots)
	}

	if err := CompareTuttiReplayStateForProfile(
		withInactiveSnapshot,
		agentOnlyReplayState(),
		AgentSemanticProfile(),
	); err != nil {
		t.Fatalf("compare inactive Tutti Mode snapshot error = %v", err)
	}

	tuttiMerged, err := MergeTuttiReplayStatesForProfile(
		[]TuttiReplayState{withInactiveSnapshot},
		TuttiSemanticProfile(),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(tuttiMerged.TuttiMode.TurnSnapshots) != 1 {
		t.Fatalf("Tutti profile snapshots = %#v", tuttiMerged.TuttiMode.TurnSnapshots)
	}
	if err := CompareTuttiReplayStateForProfile(
		withInactiveSnapshot,
		agentOnlyReplayState(),
		TuttiSemanticProfile(),
	); !errors.Is(err, ErrTuttiReplayStateConflict) {
		t.Fatalf("Tutti profile snapshot mismatch error = %v", err)
	}
}

func TestSemanticProfileFailsFastOnIndirectIssueDependency(t *testing.T) {
	state := agentOnlyReplayState()
	state.Workflows = []TuttiReplayWorkflow{{
		ID: "workflow-1", IssueIDs: []string{"issue-1"},
	}}
	profile := SemanticProfile{Agent: true, Workflows: true}
	err := ValidateTuttiReplayStateForProfile(state, profile)
	if !errors.Is(err, ErrUnsupportedReplaySemanticDomain) {
		t.Fatalf("indirect Issue dependency error = %v", err)
	}
	var unsupported *UnsupportedReplaySemanticDomainError
	if !errors.As(err, &unsupported) || unsupported.Domain != "issues" {
		t.Fatalf("unsupported domain error = %#v", err)
	}
}

func agentOnlyReplayState() TuttiReplayState {
	return TuttiReplayState{
		SchemaVersion: SchemaVersion,
		Agent: agenthost.HistoricalSessionGraph{
			RootSessionID: "session-root",
			Sessions: []agenthost.HistoricalSession{{
				ID: "session-root", Kind: "root",
				AgentTargetID: "local:codex", Provider: "codex",
				ProviderSessionID: "provider-session-root",
				Settings:          map[string]any{},
				Turns:             []agenthost.HistoricalTurn{},
				Messages:          []agenthost.HistoricalMessage{},
				Interactions:      []agenthost.HistoricalInteraction{},
			}},
		},
		TuttiMode: TuttiReplayTuttiMode{
			Activations:   []TuttiReplayActivation{},
			TurnSnapshots: []TuttiReplayTurnSnapshot{},
		},
		Workflows: []TuttiReplayWorkflow{},
		Issues:    []TuttiReplayIssue{},
	}
}
