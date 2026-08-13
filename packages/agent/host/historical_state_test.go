package agenthost

import (
	"errors"
	"testing"
)

func TestValidateHistoricalSessionGraphAcceptsUltimateTurnIdentityAnchor(t *testing.T) {
	graph := historicalIdentityAnchorGraph()
	if err := ValidateHistoricalSessionGraph(graph); err != nil {
		t.Fatalf("ValidateHistoricalSessionGraph() error = %v", err)
	}
}

func TestValidateHistoricalSessionGraphRejectsInvalidTurnIdentityAnchors(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*HistoricalSessionGraph)
	}{
		{
			name: "self",
			mutate: func(graph *HistoricalSessionGraph) {
				graph.Sessions[0].Turns[1].IdentityAnchorTurnID = "implementation-turn"
			},
		},
		{
			name: "missing",
			mutate: func(graph *HistoricalSessionGraph) {
				graph.Sessions[0].Turns[1].IdentityAnchorTurnID = "missing-turn"
			},
		},
		{
			name: "nested",
			mutate: func(graph *HistoricalSessionGraph) {
				graph.Sessions[0].Turns = append(graph.Sessions[0].Turns, HistoricalTurn{
					ID: "nested-turn", IdentityAnchorTurnID: "implementation-turn",
					Phase: "settled", Origin: "user_prompt",
				})
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			graph := historicalIdentityAnchorGraph()
			test.mutate(&graph)
			if err := ValidateHistoricalSessionGraph(graph); !errors.Is(err, ErrHistoricalStateConflict) {
				t.Fatalf("ValidateHistoricalSessionGraph() error = %v, want conflict", err)
			}
		})
	}
}

func historicalIdentityAnchorGraph() HistoricalSessionGraph {
	return HistoricalSessionGraph{
		RootSessionID: "session-root",
		Sessions: []HistoricalSession{{
			ID: "session-root", Kind: "root", AgentTargetID: "local:codex",
			Provider: "codex", ProviderSessionID: "provider-session-root",
			Turns: []HistoricalTurn{
				{ID: "plan-turn", Phase: "settled", Origin: "user_prompt"},
				{
					ID: "implementation-turn", IdentityAnchorTurnID: "plan-turn",
					Phase: "settled", Origin: "user_prompt",
				},
			},
		}},
	}
}
