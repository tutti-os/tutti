package api_test

import (
	"testing"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

func TestGeneratedActivityVocabularyMatchesCanonicalStore(t *testing.T) {
	t.Parallel()

	assertSameVocabulary(t, "turn phase", []string{
		string(tuttigenerated.WorkspaceAgentTurnPhaseSubmitted),
		string(tuttigenerated.WorkspaceAgentTurnPhaseRunning),
		string(tuttigenerated.WorkspaceAgentTurnPhaseWaiting),
		string(tuttigenerated.WorkspaceAgentTurnPhaseSettling),
		string(tuttigenerated.WorkspaceAgentTurnPhaseSettled),
	}, []string{
		canonical.TurnPhaseSubmitted,
		canonical.TurnPhaseRunning,
		canonical.TurnPhaseWaiting,
		canonical.TurnPhaseSettling,
		canonical.TurnPhaseSettled,
	})

	assertSameVocabulary(t, "turn outcome", []string{
		string(tuttigenerated.Completed),
		string(tuttigenerated.Failed),
		string(tuttigenerated.Canceled),
		string(tuttigenerated.Interrupted),
	}, []string{
		canonical.TurnOutcomeCompleted,
		canonical.TurnOutcomeFailed,
		canonical.TurnOutcomeCanceled,
		canonical.TurnOutcomeInterrupted,
	})
}

func assertSameVocabulary(t *testing.T, name string, generated, canonicalValues []string) {
	t.Helper()
	if len(generated) != len(canonicalValues) {
		t.Fatalf("%s vocabulary size: generated=%d canonical=%d", name, len(generated), len(canonicalValues))
	}
	canonicalSet := make(map[string]struct{}, len(canonicalValues))
	for _, value := range canonicalValues {
		canonicalSet[value] = struct{}{}
	}
	for _, value := range generated {
		if _, ok := canonicalSet[value]; !ok {
			t.Errorf("generated %s value %q is absent from canonical store vocabulary", name, value)
		}
		delete(canonicalSet, value)
	}
	for value := range canonicalSet {
		t.Errorf("canonical %s value %q is absent from generated OpenAPI vocabulary", name, value)
	}
}
