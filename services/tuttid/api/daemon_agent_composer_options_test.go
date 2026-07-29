package api

import (
	"testing"

	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestGeneratedAgentProviderCapabilityOptionsPreservesNativeSemantic(t *testing.T) {
	options := generatedAgentProviderCapabilityOptions([]agentservice.ComposerCapabilityOption{{
		ID:         "plugin:browser@openai-bundled",
		Kind:       "plugin",
		Name:       "browser",
		Label:      "Browser",
		Status:     "available",
		Invocation: "promptItem",
		Semantic:   "browserUse",
	}})
	if len(options) != 1 || options[0].Semantic == nil || string(*options[0].Semantic) != "browserUse" {
		t.Fatalf("capability semantic = %#v", options)
	}
}

// Requested-origin model entries (warm-catalog append of the requested model,
// bootstrap echo) must keep their provenance across the API projection so
// clients can exclude them from catalog testimony; catalog entries omit the
// field entirely (backward-compatible optional).
func TestGeneratedComposerConfigOptionKeepsRequestedProvenance(t *testing.T) {
	generated := generatedComposerConfigOption(agentservice.ComposerConfigOption{
		Configurable:   true,
		CurrentValue:   "default",
		EffectiveValue: "claude-haiku-4-5-20251001",
		Options: []agentservice.ComposerConfigOptionValue{
			{ID: "gpt-5.6-sol", Label: "GPT-5.6 Sol", Value: "gpt-5.6-sol"},
			{ID: "x-ai/grok-4.5", Label: "x-ai/grok-4.5", Value: "x-ai/grok-4.5", Requested: true},
		},
	})
	if len(generated.Options) != 2 {
		t.Fatalf("expected both options, got %d", len(generated.Options))
	}
	if generated.Options[0].Requested != nil {
		t.Fatal("catalog entry must omit the requested field")
	}
	if generated.Options[1].Requested == nil || !*generated.Options[1].Requested {
		t.Fatal("requested-origin entry must project requested=true")
	}
	if generated.CurrentValue == nil || *generated.CurrentValue != "default" {
		t.Fatalf("current value = %#v, want default", generated.CurrentValue)
	}
	if generated.EffectiveValue == nil ||
		*generated.EffectiveValue != "claude-haiku-4-5-20251001" {
		t.Fatalf("effective value = %#v, want resolved Haiku model", generated.EffectiveValue)
	}
}
