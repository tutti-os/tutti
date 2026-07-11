package agentprovider

import "testing"

func TestNormalizeTuttiAliasTargetsSupportedTuttiAgent(t *testing.T) {
	if got := Normalize("tutti"); got != TuttiAgent {
		t.Fatalf("Normalize(tutti) = %q, want %q", got, TuttiAgent)
	}
	if got := Normalize("nexight"); got != Nexight {
		t.Fatalf("Normalize(nexight) = %q, want %q", got, Nexight)
	}
}
