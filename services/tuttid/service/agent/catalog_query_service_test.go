package agent

import (
	"context"
	"testing"
)

func TestCatalogQueryReusesRunningClaudeSession(t *testing.T) {
	runtime := newFakeRuntime()
	runtime.sessions["ws-1:session-1"] = ProviderRuntimeSession{
		ID: "session-1", WorkspaceID: "ws-1", Provider: "claude-code", Status: "ready",
		RuntimeContext: map[string]any{"configOptions": []any{map[string]any{
			"id": "model", "options": []any{map[string]any{"name": "Sonnet", "value": "sonnet"}},
		}}},
	}
	service := newIsolatedAgentService(runtime)
	input := ComposerOptionsInput{Provider: "claude-code", WorkspaceID: "ws-1", Cwd: "/repo"}
	if profile := composerProfileFor(input.Provider); !profile.ModelDiscovery.Enabled {
		t.Fatalf("model discovery profile is disabled: %#v", profile)
	}
	result, err := service.resolveModelsFromCatalog(context.Background(), input, ComposerSettings{}, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Value.Models) != 1 || result.Value.Models[0].Value != "sonnet" {
		t.Fatalf("catalog result = %#v", result)
	}
	projection, ok := catalogSnapshotProjection(result, "")
	if !ok || len(projection.ModelOptions) != 1 {
		t.Fatalf("catalog projection = %#v, ok=%v", projection, ok)
	}
	options, err := service.GetComposerOptions(context.Background(), input)
	if err != nil || len(options.ModelConfig.Options) != 1 {
		t.Fatalf("composer options = %#v, err=%v", options.ModelConfig, err)
	}
}
