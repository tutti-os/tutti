package api

import (
	"testing"

	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

// Requested-origin model entries (warm-catalog append of the requested model,
// bootstrap echo) must keep their provenance across the API projection so
// clients can exclude them from catalog testimony; catalog entries omit the
// field entirely (backward-compatible optional).
func TestGeneratedComposerConfigOptionKeepsRequestedProvenance(t *testing.T) {
	generated := generatedComposerConfigOption(agentservice.ComposerConfigOption{
		Configurable: true,
		CurrentValue: "x-ai/grok-4.5",
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
}
