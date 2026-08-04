package agent

import (
	"context"
	"testing"
)

func TestFrozenAgentModelCatalogPreservesCassetteOrderAndDeduplicates(t *testing.T) {
	catalog := NewFrozenAgentModelCatalog(map[string][]string{
		"codex": {" gpt-5.3-codex-spark ", "gpt-5.3-codex-spark", "gpt-5-codex"},
	})
	result, err := catalog.ListModels(context.Background(), AgentModelCatalogInput{
		Provider: "codex",
	})
	if err != nil {
		t.Fatalf("ListModels() error = %v", err)
	}
	if result.Source != replayFrozenModelCatalogSource {
		t.Fatalf("Source = %q, want %q", result.Source, replayFrozenModelCatalogSource)
	}
	if len(result.Models) != 2 ||
		result.Models[0].ID != "gpt-5.3-codex-spark" ||
		result.Models[1].ID != "gpt-5-codex" {
		t.Fatalf("Models = %#v, want cassette order without duplicates", result.Models)
	}
	if !result.Models[0].IsDefault || result.Models[1].IsDefault {
		t.Fatalf("default flags = %#v, want only first model default", result.Models)
	}
}

func TestReplayComposerOptionsUseFrozenCatalogForLiveDiscoveryProviders(t *testing.T) {
	service := &Service{
		ReplayMode: true,
		ModelCatalog: NewFrozenAgentModelCatalog(map[string][]string{
			"claude-code": {"recorded-claude-model"},
		}),
	}
	options, err := service.GetComposerOptions(context.Background(), ComposerOptionsInput{
		Provider: "claude-code",
		Settings: ComposerSettings{Model: "recorded-claude-model"},
	})
	if err != nil {
		t.Fatalf("GetComposerOptions() error = %v", err)
	}
	if options.RuntimeContext["modelCatalogSource"] != replayFrozenModelCatalogSource {
		t.Fatalf("modelCatalogSource = %#v, want frozen source", options.RuntimeContext["modelCatalogSource"])
	}
	runtimeOptions := options.RuntimeContext["configOptions"]
	modelOption := map[string]any(nil)
	for _, candidate := range runtimeOptions.([]map[string]any) {
		if candidate["id"] == "model" {
			modelOption = candidate
			break
		}
	}
	if modelOption == nil {
		t.Fatalf("runtime config options = %#v, missing model option", runtimeOptions)
	}
	modelOptions := modelOption["options"].([]map[string]any)
	if len(modelOptions) != 1 || modelOptions[0]["value"] != "recorded-claude-model" {
		t.Fatalf("runtime model options = %#v, want only frozen model", modelOptions)
	}
}

func TestReplayModelValidationUsesFrozenCatalog(t *testing.T) {
	service := &Service{
		ReplayMode: true,
		ModelCatalog: NewFrozenAgentModelCatalog(map[string][]string{
			"codex": {"gpt-5.3-codex-spark"},
		}),
	}
	if err := service.validateComposerModelForCreate(
		context.Background(),
		"codex",
		"workspace-1",
		"",
		"gpt-5.3-codex-spark",
	); err != nil {
		t.Fatalf("frozen model validation error = %v", err)
	}
	if err := service.validateComposerModelForCreate(
		context.Background(),
		"codex",
		"workspace-1",
		"",
		"current-live-only-model",
	); err == nil {
		t.Fatal("frozen model validation accepted a model absent from the cassette")
	}
}
