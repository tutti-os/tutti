package preferences

import "testing"

func TestLabFlagRegistryKeysAndDefaults(t *testing.T) {
	keys := []string{
		LabFlagTuttiMode,
		LabFlagModelPlans,
		LabFlagWorkspaceAgents,
		LabFlagAutomationRules,
	}
	if len(labFlagDefaults) != len(keys) {
		t.Fatalf("registry has %d entries, want %d", len(labFlagDefaults), len(keys))
	}
	for _, key := range keys {
		if !IsLabFlag(key) {
			t.Fatalf("IsLabFlag(%q) = false, want true", key)
		}
		defaultValue, ok := LabFlagDefault(key)
		if !ok || defaultValue {
			t.Fatalf("LabFlagDefault(%q) = (%v, %v), want (false, true)", key, defaultValue, ok)
		}
	}
}

func TestIsLabFlagRejectsUnregisteredKeys(t *testing.T) {
	for _, key := range []string{"", "lab.unknown", "agent.extension.gemini"} {
		if IsLabFlag(key) {
			t.Fatalf("IsLabFlag(%q) = true, want false", key)
		}
		if _, ok := LabFlagDefault(key); ok {
			t.Fatalf("LabFlagDefault(%q) ok = true, want false", key)
		}
	}
}

func TestIsLabFlagEnabledFailsClosed(t *testing.T) {
	for _, key := range []string{
		LabFlagTuttiMode,
		LabFlagModelPlans,
		LabFlagWorkspaceAgents,
		LabFlagAutomationRules,
	} {
		if IsLabFlagEnabled(nil, key) {
			t.Fatalf("IsLabFlagEnabled(nil, %q) = true, want false", key)
		}
		if IsLabFlagEnabled(map[string]bool{}, key) {
			t.Fatalf("IsLabFlagEnabled({}, %q) = true, want false", key)
		}
		if !IsLabFlagEnabled(map[string]bool{key: true}, key) {
			t.Fatalf("IsLabFlagEnabled({%q: true}, %q) = false, want true", key, key)
		}
	}
}

func TestIsLabFlagEnabledStoredValueWins(t *testing.T) {
	if IsLabFlagEnabled(map[string]bool{LabFlagTuttiMode: false}, LabFlagTuttiMode) {
		t.Fatalf("stored false must win over registry default")
	}
	// Matches the renderer catalog resolution: a stored value wins even for
	// unregistered keys; absent unregistered keys resolve to false.
	if !IsLabFlagEnabled(map[string]bool{"lab.unknown": true}, "lab.unknown") {
		t.Fatalf("stored value must win for unregistered keys")
	}
	if IsLabFlagEnabled(map[string]bool{}, "lab.unknown") {
		t.Fatalf("absent unregistered key must resolve to false")
	}
}
