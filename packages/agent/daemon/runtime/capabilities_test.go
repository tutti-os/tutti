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

	// 其他 ACP provider：保守派生——interrupt 恆有；imageInput 跟隨 promptImage；
	// compact 僅在 availableCommands 出現 compact 時亮起；無 skills/planMode。
	hermes := standardACPCapabilities(ProviderHermes, false, acpLiveStateSnapshot{})
	if containsString(hermes, CapabilityImageInput) ||
		containsString(hermes, CapabilityCompact) ||
		containsString(hermes, CapabilitySkills) ||
		containsString(hermes, CapabilityPlanMode) {
		t.Fatalf("hermes capabilities too permissive: %v", hermes)
	}
	if !containsString(hermes, CapabilityInterrupt) {
		t.Fatalf("hermes capabilities missing interrupt: %v", hermes)
	}

	withCompact := standardACPCapabilities(ProviderHermes, true, acpLiveStateSnapshot{
		availableCommands: []AgentSessionCommand{{Name: "compact"}},
	})
	if !containsString(withCompact, CapabilityCompact) || !containsString(withCompact, CapabilityImageInput) {
		t.Fatalf("derived capabilities = %v, want compact+imageInput", withCompact)
	}
}
