package agentprovider

import "testing"

func TestAllReturnsUniqueProviders(t *testing.T) {
	seen := make(map[string]struct{})
	for _, provider := range All() {
		if _, ok := seen[provider]; ok {
			t.Fatalf("All() contains duplicate provider %q", provider)
		}
		seen[provider] = struct{}{}
	}
	for _, provider := range []string{Codex, OpenCode} {
		if _, ok := seen[provider]; !ok {
			t.Fatalf("All() does not contain migrated provider %q", provider)
		}
	}
}

func TestNormalizeUsesMigratedProviderIdentity(t *testing.T) {
	tests := map[string]string{
		" CODEX ":       Codex,
		" opencode-ai ": OpenCode,
	}
	for input, want := range tests {
		if got := Normalize(input); got != want {
			t.Fatalf("Normalize(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestModelPlanProtocol(t *testing.T) {
	if protocol, ok := ModelPlanProtocol("claude"); !ok || protocol != "anthropic" {
		t.Fatalf("ModelPlanProtocol(claude) = %q, %v", protocol, ok)
	}
	if protocol, ok := ModelPlanProtocol("cursor"); ok || protocol != "" {
		t.Fatalf("ModelPlanProtocol(cursor) = %q, %v", protocol, ok)
	}
}
