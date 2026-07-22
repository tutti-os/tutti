package modelcatalog

import (
	"slices"
	"testing"
)

func TestRuntimeConfigOptionModelRoundTripPreservesCapabilities(t *testing.T) {
	t.Parallel()

	imageInput := true
	model := ModelOption{
		ID:                         "gpt-5.6-sol",
		DisplayName:                "GPT-5.6-Sol",
		Description:                "Frontier coding model",
		DefaultReasoningEffort:     "low",
		DefaultSpeed:               "standard",
		IsDefault:                  true,
		ReasoningEffortsAdvertised: true,
		SupportedReasoningEfforts: []ReasoningEffortOption{
			{Value: "low", Label: "Low", Default: true},
			{Value: "medium", Label: "Medium"},
			{Value: "high", Label: "High"},
			{Value: "xhigh", Label: "X-High"},
			{Value: "max", Label: "Max"},
			{Value: "ultra", Label: "Ultra"},
		},
		SpeedsAdvertised: true,
		SupportedSpeeds: []SpeedOption{
			{Value: "standard", Label: "Standard"},
			{Value: "fast", Label: "Fast"},
		},
		SupportsImageInput: &imageInput,
	}

	projected := ProjectRuntimeConfigOptionModel(model)
	models, advertised, err := ParseRuntimeConfigOptionModels([]map[string]any{{
		"id":      "model",
		"options": []any{projected},
	}}, "model")
	if err != nil {
		t.Fatalf("ParseRuntimeConfigOptionModels() error = %v", err)
	}
	if !advertised || len(models) != 1 {
		t.Fatalf("ParseRuntimeConfigOptionModels() = (%#v, %t), want one advertised model", models, advertised)
	}
	got := models[0]
	if got.ID != model.ID || got.DisplayName != model.DisplayName || got.Description != model.Description || !got.IsDefault {
		t.Fatalf("round-trip identity = %#v, want %#v", got, model)
	}
	if !got.ReasoningEffortsAdvertised || got.DefaultReasoningEffort != "low" {
		t.Fatalf("round-trip reasoning metadata = %#v", got)
	}
	gotEfforts := make([]string, 0, len(got.SupportedReasoningEfforts))
	for _, option := range got.SupportedReasoningEfforts {
		gotEfforts = append(gotEfforts, option.Value)
	}
	if want := []string{"low", "medium", "high", "xhigh", "max", "ultra"}; !slices.Equal(gotEfforts, want) {
		t.Fatalf("round-trip reasoning efforts = %#v, want %#v", gotEfforts, want)
	}
	if !got.SpeedsAdvertised || got.DefaultSpeed != "standard" || len(got.SupportedSpeeds) != 2 {
		t.Fatalf("round-trip speeds = %#v", got)
	}
	if got.SupportsImageInput == nil || !*got.SupportsImageInput {
		t.Fatalf("round-trip image input = %#v, want true", got.SupportsImageInput)
	}
}

func TestParseRuntimeConfigOptionModelsPreservesAdvertisedEmptyReasoning(t *testing.T) {
	t.Parallel()

	models, advertised, err := ParseRuntimeConfigOptionModels([]any{map[string]any{
		"id": "model",
		"options": []any{map[string]any{
			"value":                   "plain-model",
			"name":                    "Plain Model",
			"supportsReasoningEffort": false,
			"reasoningEfforts":        []any{},
		}},
	}}, "model")
	if err != nil {
		t.Fatalf("ParseRuntimeConfigOptionModels() error = %v", err)
	}
	if !advertised || len(models) != 1 {
		t.Fatalf("ParseRuntimeConfigOptionModels() = (%#v, %t), want one advertised model", models, advertised)
	}
	if !models[0].ReasoningEffortsAdvertised || models[0].SupportedReasoningEfforts == nil || len(models[0].SupportedReasoningEfforts) != 0 {
		t.Fatalf("advertised empty reasoning = %#v", models[0])
	}
}

func TestParseRuntimeConfigOptionModelsPreservesDefaultAndCustomModels(t *testing.T) {
	t.Parallel()

	models, advertised, err := ParseRuntimeConfigOptionModels([]map[string]any{{
		"id": "model",
		"options": []any{
			map[string]any{
				"value":       "default",
				"name":        "Default",
				"description": "Provider default",
			},
			map[string]any{
				"value":       "mimo-v2.5-pro",
				"name":        "Mimo v2.5 Pro",
				"description": "Custom model",
			},
		},
	}}, "model")
	if err != nil {
		t.Fatalf("ParseRuntimeConfigOptionModels() error = %v", err)
	}
	if !advertised || len(models) != 2 {
		t.Fatalf("ParseRuntimeConfigOptionModels() = (%#v, %t), want default and custom models", models, advertised)
	}
	if !models[0].IsDefault {
		t.Fatalf("default model = %#v, want IsDefault", models[0])
	}
	if models[1].ID != "mimo-v2.5-pro" || models[1].Description != "Custom model" {
		t.Fatalf("custom model = %#v, want provider model preserved", models[1])
	}
}

func TestParseRuntimeConfigOptionModelsDistinguishesMissingDescriptor(t *testing.T) {
	t.Parallel()

	models, advertised, err := ParseRuntimeConfigOptionModels([]map[string]any{{"id": "mode", "options": []any{}}}, "model")
	if err != nil {
		t.Fatalf("ParseRuntimeConfigOptionModels() error = %v", err)
	}
	if advertised || models != nil {
		t.Fatalf("ParseRuntimeConfigOptionModels() = (%#v, %t), want missing descriptor", models, advertised)
	}
}
