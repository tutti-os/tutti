package agenttarget

import "testing"

func TestDefaultSystemTargetsDisableTuttiAgent(t *testing.T) {
	targets := DefaultSystemTargets(1)
	for _, target := range targets {
		if target.ID != IDLocalTuttiAgent {
			continue
		}
		if target.Enabled {
			t.Fatal("Tutti Agent target is enabled by default, want disabled")
		}
		return
	}
	t.Fatalf("Tutti Agent target %q was not seeded", IDLocalTuttiAgent)
}

func TestEnabledTargetsByProviderPreservesOrderAndCanonicalizes(t *testing.T) {
	targets := DefaultSystemTargets(1)
	var codex Target
	var tuttiAgent Target
	for index := range targets {
		switch targets[index].Provider {
		case "codex":
			targets[index].Provider = "CODEX"
			codex = targets[index]
		case "claude-code":
			targets[index].Enabled = false
		case "tutti-agent":
			targets[index].Enabled = true
			tuttiAgent = targets[index]
		}
	}
	duplicate := codex
	duplicate.ID = "user:codex"
	duplicate.Name = "Other Codex"
	duplicate.Source = SourceUser
	targets = append([]Target{tuttiAgent, codex, duplicate}, targets...)

	enabled := EnabledTargetsByProvider(targets)
	if len(enabled) != 4 {
		t.Fatalf("len(enabled) = %d, want 4: %#v", len(enabled), enabled)
	}
	if enabled[0].Provider != "tutti-agent" || enabled[1].Provider != "codex" {
		t.Fatalf("enabled order = %#v", enabled)
	}
	if enabled[1].ID != IDLocalCodex {
		t.Fatalf("first codex target = %q, want %q", enabled[1].ID, IDLocalCodex)
	}
	for _, target := range enabled {
		if target.Provider == "claude-code" {
			t.Fatalf("disabled claude target was returned: %#v", target)
		}
	}
}

func TestEnabledTargetForProviderAcceptsLegacyInputAndReturnsCanonical(t *testing.T) {
	target, ok := EnabledTargetForProvider(DefaultSystemTargets(1), "claude")
	if !ok {
		t.Fatal("EnabledTargetForProvider() = not found")
	}
	if target.Provider != "claude-code" {
		t.Fatalf("provider = %q, want claude-code", target.Provider)
	}
}
