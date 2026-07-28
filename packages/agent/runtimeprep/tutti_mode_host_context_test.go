package runtimeprep

import (
	"strings"
	"testing"
)

func TestTuttiRuntimePolicyDefinesHostContextWithoutGatingCLI(t *testing.T) {
	t.Parallel()
	policy, err := tuttiRuntimePolicy(testInputWithCommands(t, PrepareInput{
		WorkspaceID:    "workspace-1",
		AgentSessionID: "session-1",
		Provider:       "codex",
		CLICommand:     "tutti-dev",
	}))
	if err != nil {
		t.Fatal(err)
	}
	for _, expected := range []string{
		"<tutti-host-context>",
		"Tutti-owned",
		"independent of Default/Plan",
		"Tutti CLI is always available",
	} {
		if !strings.Contains(policy, expected) {
			t.Fatalf("runtime policy missing %q: %s", expected, policy)
		}
	}
}
