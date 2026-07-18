package conformance

import "testing"

func TestPublishedScenariosHaveUniqueNames(t *testing.T) {
	t.Parallel()
	seen := map[string]struct{}{}
	for _, scenario := range Scenarios() {
		if scenario.Name == "" {
			t.Fatal("conformance scenario has an empty name")
		}
		if _, ok := seen[scenario.Name]; ok {
			t.Fatalf("duplicate conformance scenario name %q", scenario.Name)
		}
		seen[scenario.Name] = struct{}{}
	}
	if len(seen) != 14 {
		t.Fatalf("scenario count=%d, want 14", len(seen))
	}
}
