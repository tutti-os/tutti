package agenthost

import (
	"reflect"
	"testing"

	storesqlite "github.com/tutti-os/tutti/packages/agent/store-sqlite"
)

func TestEditRetryProviderHistoryBoundaryTrustsProviderPrefixShape(t *testing.T) {
	turns := []storesqlite.Turn{
		{TurnID: "turn-historical", RootProviderTurnID: "canonical-historical"},
		{TurnID: "turn-latest", RootProviderTurnID: "provider-latest"},
	}
	tests := []struct {
		name string
		ids  []string
	}{
		{name: "shorter prefix", ids: []string{"provider-latest"}},
		{
			name: "different prefix",
			ids:  []string{"provider-historical", "provider-latest"},
		},
		{
			name: "longer prefix",
			ids:  []string{"provider-older", "provider-historical", "provider-latest"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			providerTurns := make([]RuntimeHistoryTurn, 0, len(test.ids))
			for _, id := range test.ids {
				providerTurns = append(providerTurns, RuntimeHistoryTurn{ID: id})
			}
			got, err := editRetryProviderHistoryBoundary(
				turns,
				"turn-latest",
				RuntimeHistorySnapshot{Turns: providerTurns},
			)
			if err != nil {
				t.Fatalf("editRetryProviderHistoryBoundary() error = %v", err)
			}
			if !reflect.DeepEqual(got, test.ids) {
				t.Fatalf("editRetryProviderHistoryBoundary() = %#v, want %#v", got, test.ids)
			}
		})
	}
}

func TestEditRetryProviderHistoryBoundaryRejectsWrongBoundary(t *testing.T) {
	turns := []storesqlite.Turn{
		{TurnID: "turn-historical"},
		{TurnID: "turn-latest", RootProviderTurnID: "provider-latest"},
	}
	tests := []struct {
		name     string
		targetID string
		snapshot RuntimeHistorySnapshot
	}{
		{
			name:     "target is not latest",
			targetID: "turn-historical",
			snapshot: RuntimeHistorySnapshot{Turns: []RuntimeHistoryTurn{
				{ID: "provider-historical"},
				{ID: "provider-latest"},
			}},
		},
		{
			name:     "provider history is empty",
			targetID: "turn-latest",
			snapshot: RuntimeHistorySnapshot{},
		},
		{
			name:     "provider boundary differs",
			targetID: "turn-latest",
			snapshot: RuntimeHistorySnapshot{Turns: []RuntimeHistoryTurn{
				{ID: "provider-historical"},
				{ID: "provider-other"},
			}},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := editRetryProviderHistoryBoundary(turns, test.targetID, test.snapshot); err == nil {
				t.Fatal("editRetryProviderHistoryBoundary() error = nil")
			}
		})
	}
}

func TestEditRetryHasTargetDescendantOnlyMatchesEditedTurn(t *testing.T) {
	children := []storesqlite.Session{
		{ID: "child-historical", RootTurnID: "turn-historical"},
	}
	if editRetryHasTargetDescendant(children, "turn-latest") {
		t.Fatal("historical descendant blocked editing the latest turn")
	}

	children = append(children, storesqlite.Session{
		ID: "child-latest", RootTurnID: "turn-latest",
	})
	if !editRetryHasTargetDescendant(children, "turn-latest") {
		t.Fatal("descendant of the edited turn was not detected")
	}
}
