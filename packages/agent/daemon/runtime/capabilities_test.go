package agentruntime

import (
	"testing"
)

func TestCodexAppServerCapabilitiesUseSharedVocabulary(t *testing.T) {
	t.Parallel()
	capabilities := codexAppServerCapabilities(false)
	for _, want := range []string{
		CapabilityImageInput,
		CapabilitySkills,
		CapabilityCompact,
		CapabilityTokenUsage,
		CapabilityRateLimits,
		CapabilityInterrupt,
		CapabilityActiveTurnGuidance,
	} {
		if !containsString(capabilities, want) {
			t.Fatalf("codex capabilities = %v, missing %q", capabilities, want)
		}
	}
	if containsString(capabilities, CapabilityPlanMode) {
		t.Fatalf("codex must not advertise planMode without negotiated collaboration modes")
	}
	if !containsString(codexAppServerCapabilities(true), CapabilityPlanMode) {
		t.Fatalf("codex must advertise planMode when collaboration modes are negotiated")
	}
}

func TestStandardACPCapabilitiesByProvider(t *testing.T) {
	t.Parallel()
	opencode := standardACPCapabilities(ProviderOpenCode, true, acpLiveStateSnapshot{})
	for _, want := range []string{
		CapabilityImageInput, CapabilityPlanMode, CapabilityInterrupt,
	} {
		if !containsString(opencode, want) {
			t.Fatalf("opencode capabilities = %v, missing %q", opencode, want)
		}
	}
	if containsString(opencode, CapabilityCompact) || containsString(opencode, "review") {
		t.Fatalf("opencode capabilities = %v, must not advertise command capabilities without provider commands", opencode)
	}
	if containsString(opencode, CapabilityActiveTurnGuidance) {
		t.Fatalf("opencode capabilities = %v, must use cancel-then-send instead of native guidance", opencode)
	}
	opencodeWithReview := standardACPCapabilities(ProviderOpenCode, false, acpLiveStateSnapshot{
		availableCommands: []AgentSessionCommand{{Name: "compact"}, {Name: "review"}},
	})
	if !containsString(opencodeWithReview, CapabilityCompact) || !containsString(opencodeWithReview, "review") {
		t.Fatalf("opencode capabilities = %v, want compact+review from provider commands", opencodeWithReview)
	}

	cursor := standardACPCapabilities(ProviderCursor, true, acpLiveStateSnapshot{})
	if !containsString(cursor, CapabilityImageInput) || !containsString(cursor, CapabilityInterrupt) {
		t.Fatalf("cursor capabilities = %v, want imageInput+interrupt", cursor)
	}
	if !containsString(cursor, CapabilityPlanMode) {
		t.Fatalf("cursor capabilities missing planMode: %v", cursor)
	}
	if containsString(cursor, CapabilitySkills) {
		t.Fatalf("cursor capabilities too permissive: %v", cursor)
	}
	if containsString(cursor, CapabilityActiveTurnGuidance) {
		t.Fatalf("cursor capabilities = %v, must use cancel-then-send instead of native guidance", cursor)
	}

}

func TestOpenStandardACPCapabilitiesAcceptSignedPlanWorkflowEvidence(t *testing.T) {
	t.Parallel()
	capabilities := standardACPCapabilitiesWithDeclared(
		"acp:example",
		false,
		acpLiveStateSnapshot{},
		[]string{CapabilityPlanMode},
		true,
	)
	if !containsString(capabilities, CapabilityPlanMode) {
		t.Fatalf("capabilities = %#v, want signed Plan workflow capability", capabilities)
	}
}
