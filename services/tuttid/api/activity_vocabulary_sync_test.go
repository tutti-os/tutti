package api_test

import (
	"os"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"gopkg.in/yaml.v3"
)

func TestGeneratedActivityVocabularyMatchesCanonicalStore(t *testing.T) {
	t.Parallel()

	vocabulary := loadOpenAPIActivityVocabulary(t)
	assertSameVocabulary(t, "turn phase", vocabulary["WorkspaceAgentTurnPhase"], canonical.TurnPhases())
	assertSameVocabulary(t, "turn outcome", vocabulary["WorkspaceAgentTurnOutcome"], canonical.TurnOutcomes())
	for _, value := range vocabulary["WorkspaceAgentTurnPhase"] {
		if !tuttigenerated.WorkspaceAgentTurnPhase(value).Valid() {
			t.Errorf("generated turn phase rejected OpenAPI value %q", value)
		}
	}
	for _, value := range vocabulary["WorkspaceAgentTurnOutcome"] {
		if !tuttigenerated.WorkspaceAgentTurnOutcome(value).Valid() {
			t.Errorf("generated turn outcome rejected OpenAPI value %q", value)
		}
	}
}

func loadOpenAPIActivityVocabulary(t *testing.T) map[string][]string {
	t.Helper()
	raw, err := os.ReadFile("openapi/tuttid.v1.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		Components struct {
			Schemas map[string]struct {
				Enum []string `yaml:"enum"`
			} `yaml:"schemas"`
		} `yaml:"components"`
	}
	if err := yaml.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	return map[string][]string{
		"WorkspaceAgentTurnPhase":   document.Components.Schemas["WorkspaceAgentTurnPhase"].Enum,
		"WorkspaceAgentTurnOutcome": document.Components.Schemas["WorkspaceAgentTurnOutcome"].Enum,
	}
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
