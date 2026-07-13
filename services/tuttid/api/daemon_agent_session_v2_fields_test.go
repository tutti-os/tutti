package api

import "testing"

func TestGeneratedAgentCapabilitiesProjectsActiveTurnGuidance(t *testing.T) {
	t.Parallel()

	capabilities := generatedAgentCapabilities([]string{"activeTurnGuidance"})
	if !capabilities.ActiveTurnGuidance {
		t.Fatal("activeTurnGuidance = false, want true")
	}
	if capabilities.Interrupt {
		t.Fatal("interrupt = true, want capability fields projected independently")
	}
}
