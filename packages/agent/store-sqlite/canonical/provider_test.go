package canonical

import "testing"

func TestProviderIdentityResolvesCanonicalIDAndAliases(t *testing.T) {
	tests := map[string]string{
		"codex":       CodexProviderID,
		"Claude Code": ClaudeCodeProviderID,
		"cursor-cli":  CursorProviderID,
		"open_code":   "",
		"open-code":   OpenCodeProviderID,
	}
	for input, want := range tests {
		identity, found := FindProviderIdentity(input)
		if want == "" {
			if found {
				t.Fatalf("FindProviderIdentity(%q) unexpectedly found %#v", input, identity)
			}
			continue
		}
		if !found || identity.ID != want {
			t.Fatalf("FindProviderIdentity(%q) = %#v, %v; want %q", input, identity, found, want)
		}
	}
}

func TestProviderIdentityReturnsAliasCopy(t *testing.T) {
	identity, found := FindProviderIdentity("claude-code")
	if !found || len(identity.Aliases) == 0 {
		t.Fatal("missing Claude Code identity aliases")
	}
	identity.Aliases[0] = "mutated"
	again, _ := FindProviderIdentity("claude-code")
	if again.Aliases[0] == "mutated" {
		t.Fatal("FindProviderIdentity exposed mutable canonical aliases")
	}
}

func TestProviderPlanDecisionStrategy(t *testing.T) {
	strategy, found := ProviderPlanDecisionStrategy("codex")
	if !found || strategy != PlanDecisionStrategyImplementPrompt {
		t.Fatalf("Codex strategy = %q, %v", strategy, found)
	}
	strategy, found = ProviderPlanDecisionStrategy("claude")
	if !found || strategy != PlanDecisionStrategyNone {
		t.Fatalf("Claude strategy = %q, %v", strategy, found)
	}
}

func TestKnownCapabilitiesReturnsCopy(t *testing.T) {
	capabilities := KnownCapabilities()
	if len(capabilities) == 0 || !IsKnownCapability(CapabilityPlanImplementation) {
		t.Fatal("canonical capabilities are incomplete")
	}
	capabilities[0] = "mutated"
	if KnownCapabilities()[0] == "mutated" {
		t.Fatal("KnownCapabilities exposed mutable canonical storage")
	}
}
