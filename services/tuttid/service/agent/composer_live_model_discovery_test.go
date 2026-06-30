package agent

import "testing"

func TestExtractModelOptionsFromRuntimeContext(t *testing.T) {
	options := extractModelOptionsFromRuntimeContext(map[string]any{
		"configOptions": []any{
			map[string]any{
				"id":           "model",
				"currentValue": "default",
				"options": []any{
					map[string]any{"name": "Default", "value": "default"},
					map[string]any{"name": "Sonnet", "value": "sonnet"},
				},
			},
			map[string]any{
				"id": "effort",
			},
		},
	})
	if len(options) != 2 {
		t.Fatalf("len(options) = %d, want 2", len(options))
	}
	if options[0].Value != "default" || options[1].Value != "sonnet" {
		t.Fatalf("options = %#v, want default and sonnet", options)
	}
}

func TestMergeLiveModelsIntoComposerOptionsUpdatesRuntimeContext(t *testing.T) {
	merged := mergeLiveModelsIntoComposerOptions(ComposerOptions{
		Provider: "claude-code",
		EffectiveSettings: ComposerSettings{
			Model: "default",
		},
		RuntimeContext: map[string]any{
			"configOptions": []map[string]any{
				{
					"id":           "effort",
					"currentValue": "high",
				},
			},
		},
	}, []ComposerConfigOptionValue{
		{ID: "default", Label: "Default", Value: "default"},
		{ID: "sonnet", Label: "Sonnet", Value: "sonnet"},
	})
	if !merged.ModelConfig.Configurable || len(merged.ModelConfig.Options) != 2 {
		t.Fatalf("modelConfig = %#v", merged.ModelConfig)
	}
	if merged.RuntimeContext["modelCatalogSource"] != "acp-live-discovery" {
		t.Fatalf("modelCatalogSource = %#v, want acp-live-discovery", merged.RuntimeContext["modelCatalogSource"])
	}
	configOptions, ok := merged.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) != 2 || configOptions[0]["id"] != "model" {
		t.Fatalf("configOptions = %#v, want model + effort", merged.RuntimeContext["configOptions"])
	}
}

func TestMergeLiveModelsIntoComposerOptionsKeepsModelDescriptionInRuntimeContext(t *testing.T) {
	// Regression: the desktop composer projection prefers the model list in
	// RuntimeContext["configOptions"] over ModelConfig.Options, so the per-model
	// description must survive into the runtime configOptions or the hover
	// detail disappears.
	merged := mergeLiveModelsIntoComposerOptions(ComposerOptions{
		Provider:          "claude-code",
		EffectiveSettings: ComposerSettings{Model: "default"},
		RuntimeContext:    map[string]any{},
	}, []ComposerConfigOptionValue{
		{ID: "default", Label: "Default", Value: "default", Description: "Opus 4.8 with 1M context · Best for everyday, complex tasks"},
		{ID: "sonnet", Label: "Sonnet", Value: "sonnet", Description: "Sonnet 4.6 · Efficient for routine tasks"},
	})

	configOptions, ok := merged.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 || configOptions[0]["id"] != "model" {
		t.Fatalf("configOptions = %#v, want model option", merged.RuntimeContext["configOptions"])
	}
	options, ok := configOptions[0]["options"].([]map[string]string)
	if !ok || len(options) != 2 {
		t.Fatalf("model options = %#v, want 2 entries", configOptions[0]["options"])
	}
	if got := options[0]["description"]; got != "Opus 4.8 with 1M context · Best for everyday, complex tasks" {
		t.Fatalf("default description = %q, want the Opus description", got)
	}
	if got := options[1]["description"]; got != "Sonnet 4.6 · Efficient for routine tasks" {
		t.Fatalf("sonnet description = %q, want the Sonnet description", got)
	}
}

func TestMergeLiveModelsIntoComposerOptionsDoesNotAppendUnsupportedSelectedModel(t *testing.T) {
	merged := mergeLiveModelsIntoComposerOptions(ComposerOptions{
		Provider: "claude-code",
		EffectiveSettings: ComposerSettings{
			Model: "claude-sonnet-4-20250514",
		},
		RuntimeContext: map[string]any{},
	}, []ComposerConfigOptionValue{
		{ID: "default", Label: "Default", Value: "default"},
		{ID: "sonnet", Label: "Sonnet", Value: "sonnet"},
		{ID: "opus", Label: "Opus", Value: "opus"},
		{ID: "haiku", Label: "Haiku", Value: "haiku"},
	})

	if merged.ModelConfig.CurrentValue != "default" || merged.ModelConfig.DefaultValue != "default" {
		t.Fatalf("modelConfig = %#v, want default current/default", merged.ModelConfig)
	}
	if merged.EffectiveSettings.Model != "default" {
		t.Fatalf("effectiveSettings.model = %q, want default", merged.EffectiveSettings.Model)
	}
	for _, option := range merged.ModelConfig.Options {
		if option.Value == "claude-sonnet-4-20250514" {
			t.Fatalf("modelConfig options = %#v, want no unsupported selected model", merged.ModelConfig.Options)
		}
	}
	configOptions, ok := merged.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v, want model option", merged.RuntimeContext["configOptions"])
	}
	if configOptions[0]["currentValue"] != "default" {
		t.Fatalf("model runtime option = %#v, want default currentValue", configOptions[0])
	}
	runtimeModelOptions, ok := configOptions[0]["options"].([]map[string]string)
	if !ok {
		t.Fatalf("runtime model options = %#v", configOptions[0]["options"])
	}
	for _, option := range runtimeModelOptions {
		if option["value"] == "claude-sonnet-4-20250514" {
			t.Fatalf("runtime model options = %#v, want no unsupported selected model", runtimeModelOptions)
		}
	}
	if merged.RuntimeContext["model"] != "default" {
		t.Fatalf("runtime model = %#v, want default", merged.RuntimeContext["model"])
	}
}

func TestMergeLiveModelsIntoComposerOptionsKeepsSelectedAlias(t *testing.T) {
	merged := mergeLiveModelsIntoComposerOptions(ComposerOptions{
		Provider: "claude-code",
		EffectiveSettings: ComposerSettings{
			Model: "sonnet",
		},
		RuntimeContext: map[string]any{},
	}, []ComposerConfigOptionValue{
		{ID: "default", Label: "Default", Value: "default"},
		{ID: "sonnet", Label: "Sonnet", Value: "sonnet"},
		{ID: "opus", Label: "Opus", Value: "opus"},
		{ID: "haiku", Label: "Haiku", Value: "haiku"},
	})

	if merged.ModelConfig.CurrentValue != "sonnet" || merged.ModelConfig.DefaultValue != "sonnet" {
		t.Fatalf("modelConfig = %#v, want selected alias current/default", merged.ModelConfig)
	}
	configOptions, ok := merged.RuntimeContext["configOptions"].([]map[string]any)
	if !ok || len(configOptions) == 0 {
		t.Fatalf("configOptions = %#v, want model option", merged.RuntimeContext["configOptions"])
	}
	if configOptions[0]["currentValue"] != "sonnet" {
		t.Fatalf("model runtime option = %#v, want selected alias currentValue", configOptions[0])
	}
}
