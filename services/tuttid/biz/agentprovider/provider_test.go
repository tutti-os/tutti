package agentprovider

import "testing"

func TestNormalizeAntigravity(t *testing.T) {
	for _, in := range []string{"antigravity", "antigravity-cli", "agy", "AGY", "  Antigravity  "} {
		if got := Normalize(in); got != Antigravity {
			t.Fatalf("Normalize(%q) = %q, want %q", in, got, Antigravity)
		}
	}
	found := false
	for _, p := range All() {
		if p == Antigravity {
			found = true
		}
	}
	if !found {
		t.Fatal("antigravity missing from All()")
	}
}
