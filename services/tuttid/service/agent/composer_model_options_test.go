package agent

import (
	"context"
	"testing"
)

type staticModelCatalog struct {
	result AgentModelCatalogResult
}

func (c staticModelCatalog) ListModels(context.Context, AgentModelCatalogInput) (AgentModelCatalogResult, error) {
	return c.result, nil
}

// The warm-catalog projection keeps the requested model selectable even when
// the catalog does not contain it, but the appended entry must carry the
// requested provenance marker: create validation runs against the raw catalog
// and would reject the model, so clients must not treat the append as catalog
// testimony (P1: bare plan model leaked into a provider bucket rode this
// append into a daemon 400).
func TestComposerModelOptionsFromCatalogMarksAppendedRequestedModel(t *testing.T) {
	catalog := staticModelCatalog{result: AgentModelCatalogResult{
		Provider: "codex",
		Models: []AgentModelOption{
			{ID: "gpt-5.3-codex", DisplayName: "GPT-5.3 Codex"},
			{ID: "gpt-5.6-sol", DisplayName: "GPT-5.6 Sol"},
		},
	}}

	projection, ok := composerModelOptionsFromCatalog(context.Background(), catalog, "codex", "", "x-ai/grok-4.5")
	if !ok {
		t.Fatal("expected catalog projection")
	}
	if len(projection.ModelOptions) != 3 {
		t.Fatalf("expected catalog models plus appended requested model, got %d options", len(projection.ModelOptions))
	}
	for _, option := range projection.ModelOptions[:2] {
		if option.Requested {
			t.Fatalf("catalog entry %q must not be requested-origin", option.Value)
		}
	}
	appended := projection.ModelOptions[2]
	if appended.Value != "x-ai/grok-4.5" || !appended.Requested {
		t.Fatalf("appended entry must be the requested model with Requested=true, got %+v", appended)
	}
}

func TestComposerModelOptionsFromCatalogDoesNotMarkCatalogSelection(t *testing.T) {
	catalog := staticModelCatalog{result: AgentModelCatalogResult{
		Provider: "codex",
		Models:   []AgentModelOption{{ID: "gpt-5.6-sol"}},
	}}

	projection, ok := composerModelOptionsFromCatalog(context.Background(), catalog, "codex", "", "gpt-5.6-sol")
	if !ok {
		t.Fatal("expected catalog projection")
	}
	if len(projection.ModelOptions) != 1 {
		t.Fatalf("selection already in catalog must not append, got %d options", len(projection.ModelOptions))
	}
	if projection.ModelOptions[0].Requested {
		t.Fatal("catalog entry matching the selection must not be requested-origin")
	}
}

// The bootstrap selected-model-only list mirrors the requested settings; every
// entry is requested-origin by construction.
func TestComposerSelectedModelOptionsAreRequestedOrigin(t *testing.T) {
	options := composerSelectedModelOptions("x-ai/grok-4.5")
	if len(options) != 1 {
		t.Fatalf("expected a single echo entry, got %d", len(options))
	}
	if !options[0].Requested {
		t.Fatal("bootstrap echo entry must be requested-origin")
	}
	if len(composerSelectedModelOptions(" ")) != 0 {
		t.Fatal("blank selection must produce no options")
	}
}

func TestComposerModelConfigCarriesRequestedProvenance(t *testing.T) {
	config := composerModelConfig("codex", "x-ai/grok-4.5", []ComposerConfigOptionValue{
		{ID: "gpt-5.6-sol", Label: "GPT-5.6 Sol", Value: "gpt-5.6-sol"},
		{ID: "x-ai/grok-4.5", Label: "x-ai/grok-4.5", Value: "x-ai/grok-4.5", Requested: true},
	})
	if len(config.Options) != 2 {
		t.Fatalf("expected both options, got %d", len(config.Options))
	}
	if config.Options[0].Requested {
		t.Fatal("catalog entry must stay non-requested through composerModelConfig")
	}
	if !config.Options[1].Requested {
		t.Fatal("requested entry must keep its provenance through composerModelConfig")
	}
}

func TestComposerConfigOptionValuesToRuntimeModelOptionsEmitsRequested(t *testing.T) {
	entries := composerConfigOptionValuesToRuntimeModelOptions([]ComposerConfigOptionValue{
		{ID: "gpt-5.6-sol", Label: "GPT-5.6 Sol", Value: "gpt-5.6-sol"},
		{ID: "x-ai/grok-4.5", Label: "x-ai/grok-4.5", Value: "x-ai/grok-4.5", Requested: true},
	})
	if len(entries) != 2 {
		t.Fatalf("expected both runtime entries, got %d", len(entries))
	}
	if _, present := entries[0]["requested"]; present {
		t.Fatal("catalog entry must not carry a requested key")
	}
	if requested, _ := entries[1]["requested"].(bool); !requested {
		t.Fatal("requested entry must emit requested=true in runtime context")
	}
}
