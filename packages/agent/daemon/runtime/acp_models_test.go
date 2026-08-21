package agentruntime

import (
	"encoding/json"
	"testing"
)

func TestApplyACPModelsResultProjectsModelConfigOption(t *testing.T) {
	state := newACPLiveState()
	applyACPModelsResult(&state, json.RawMessage(`{
		"models": {
			"availableModels": [
				{"modelId":"auto-gemini-3","name":"Auto (Gemini 3)","description":"Routes automatically\nwithout rewriting"},
				{"modelId":"gemini-3-pro-preview","name":"Gemini 3 Pro","description":"Frontier model · x0.71 credits"},
				{"modelId":"hy3","name":"Hy3","description":"0.00x Credits"}
			],
			"currentModelId":"auto-gemini-3"
		}
	}`), StandardACPModelDescriptionMetadataFormatCreditConsumptionMultiplierV1)

	if !state.modelsAPI {
		t.Fatal("modelsAPI = false, want true")
	}
	options := extractModelOptionsFromRuntimeDescriptorsForTest(state.configOptionDescriptors)
	if len(options) != 3 {
		t.Fatalf("model options = %#v, want three", options)
	}
	if options[0]["value"] != "auto-gemini-3" || options[0]["label"] != "Auto (Gemini 3)" {
		t.Fatalf("first model option = %#v", options[0])
	}
	if options[0]["description"] != "Routes automatically\nwithout rewriting" {
		t.Fatalf("ordinary model description = %#v, want verbatim text", options[0]["description"])
	}
	if options[1]["description"] != "Frontier model" || options[1]["consumptionMultiplier"] != "0.71" {
		t.Fatalf("model consumption metadata = %#v", options[1])
	}
	if _, present := options[2]["description"]; present || options[2]["consumptionMultiplier"] != "0.00" {
		t.Fatalf("credit-only model metadata = %#v", options[2])
	}
	if state.configOptions["model"] != "auto-gemini-3" {
		t.Fatalf("current model = %#v, want auto-gemini-3", state.configOptions["model"])
	}
}

func TestApplyACPModelsResultPreservesDescriptionWithoutDeclaredMetadataFormat(t *testing.T) {
	state := newACPLiveState()
	applyACPModelsResult(&state, json.RawMessage(`{
		"models": {
			"availableModels": [
				{"modelId":"ordinary-provider","name":"Ordinary Provider","description":"Frontier model · x0.71 credits"}
			],
			"currentModelId":"ordinary-provider"
		}
	}`), "")

	options := extractModelOptionsFromRuntimeDescriptorsForTest(state.configOptionDescriptors)
	if len(options) != 1 || options[0]["description"] != "Frontier model · x0.71 credits" {
		t.Fatalf("model options = %#v, want provider description preserved", options)
	}
	if _, present := options[0]["consumptionMultiplier"]; present {
		t.Fatalf("undeclared consumption metadata should not be inferred: %#v", options[0])
	}
}

func TestApplyACPConfigOptionsResultProjectsDeclaredModelConsumptionMetadata(t *testing.T) {
	state := newACPLiveState()
	applyACPConfigOptionsResult(&state, json.RawMessage(`{
		"configOptions": [
			{
				"type":"select",
				"id":"model",
				"currentValue":"hy3",
				"options":[
					{"value":"hy3","name":"Hy3","description":"x0.00 credits"},
					{"value":"glm-5.3","name":"GLM-5.3","description":"Frontier model · x0.79 credits"}
				]
			}
		]
	}`), "model", StandardACPModelDescriptionMetadataFormatCreditConsumptionMultiplierV1)

	options := extractModelOptionsFromRuntimeDescriptorsForTest(state.configOptionDescriptors)
	if len(options) != 2 {
		t.Fatalf("model options = %#v, want two", options)
	}
	if _, present := options[0]["description"]; present || options[0]["consumptionMultiplier"] != "0.00" {
		t.Fatalf("credit-only config option metadata = %#v", options[0])
	}
	if options[1]["description"] != "Frontier model" || options[1]["consumptionMultiplier"] != "0.79" {
		t.Fatalf("mixed config option metadata = %#v", options[1])
	}
}

func TestApplyACPConfigOptionsResultPreservesDescriptionWithoutDeclaredMetadataFormat(t *testing.T) {
	state := newACPLiveState()
	applyACPConfigOptionsResult(&state, json.RawMessage(`{
		"configOptions": [{
			"id":"model",
			"currentValue":"ordinary-provider",
			"options":[{
				"value":"ordinary-provider",
				"name":"Ordinary Provider",
				"description":"Frontier model · x0.71 credits",
				"consumptionMultiplier":"9.99"
			}]
		}]
	}`), "model", "")

	options := extractModelOptionsFromRuntimeDescriptorsForTest(state.configOptionDescriptors)
	if len(options) != 1 || options[0]["description"] != "Frontier model · x0.71 credits" {
		t.Fatalf("model options = %#v, want provider description preserved", options)
	}
	if _, present := options[0]["consumptionMultiplier"]; present {
		t.Fatalf("undeclared config option consumption metadata should not be inferred: %#v", options[0])
	}
}

func TestNewStandardACPAdapterRejectsUnknownModelDescriptionMetadataFormat(t *testing.T) {
	_, err := NewStandardACPAdapter(StandardACPAdapterConfig{
		Provider:               "acp:example",
		Command:                []string{"example", "--acp"},
		ModelDescriptionFormat: "extension-supplied-parser",
	}, nil, LegacyHostMetadata())
	if err == nil {
		t.Fatal("NewStandardACPAdapter() error = nil, want unsupported metadata format rejection")
	}
}

func TestApplyACPModelsResultPreservesDynamicModelMetadata(t *testing.T) {
	state := newACPLiveState()
	applyACPModelsResult(&state, json.RawMessage(`{
		"models": {
			"availableModels": [
				{
					"modelId":"reasoning-model",
					"name":"Reasoning Model",
					"supportsReasoningEffort":true,
					"reasoningEffort":"deep",
					"reasoningEfforts":[
						{"value":"brief","label":"Brief","description":"Fast"},
						{"value":"deep","label":"Deep","default":true}
					],
					"supportsImageInput":true
				},
				{
					"modelId":"plain-model",
					"name":"Plain Model",
					"_meta":{
						"supportsReasoningEffort":false,
						"reasoningEfforts":[],
						"supportsImageInput":false
					}
				}
			],
			"currentModelId":"reasoning-model"
		}
	}`), "")

	options := extractModelOptionsFromRuntimeDescriptorsForTest(state.configOptionDescriptors)
	if len(options) != 2 {
		t.Fatalf("model options = %#v, want two", options)
	}
	if options[0]["supportsReasoningEffort"] != true || options[0]["reasoningEffort"] != "deep" || options[0]["supportsImageInput"] != true {
		t.Fatalf("reasoning model metadata = %#v", options[0])
	}
	efforts, ok := options[0]["reasoningEfforts"].([]any)
	if !ok || len(efforts) != 2 {
		t.Fatalf("reasoning efforts = %#v, want two", options[0]["reasoningEfforts"])
	}
	brief, _ := efforts[0].(map[string]any)
	if brief["value"] != "brief" || brief["label"] != "Brief" || brief["description"] != "Fast" {
		t.Fatalf("brief effort = %#v", brief)
	}
	if options[1]["supportsReasoningEffort"] != false || options[1]["supportsImageInput"] != false {
		t.Fatalf("plain model metadata = %#v", options[1])
	}
	if efforts, ok := options[1]["reasoningEfforts"].([]any); !ok || len(efforts) != 0 {
		t.Fatalf("plain reasoning efforts = %#v, want advertised empty list", options[1]["reasoningEfforts"])
	}
}

func TestApplyACPModelsResultToleratesAlternateMetadataShapes(t *testing.T) {
	state := newACPLiveState()
	applyACPModelsResult(&state, json.RawMessage(`{
		"models": {
			"availableModels": [
				{
					"modelId":"string-efforts",
					"name":"String Efforts",
					"supportsReasoningEffort":{"unexpected":true},
					"reasoningEffort":42,
					"reasoningEfforts":["low",{"id":"high","name":"High","default":true}],
					"supportsImageInput":"yes",
					"_meta":{
						"supportsReasoningEffort":true,
						"reasoningEffort":"high",
						"supportsImageInput":true
					}
				},
				{
					"modelId":"unknown-metadata",
					"name":"Unknown Metadata",
					"reasoningEfforts":{"unexpected":true},
					"_meta":"unexpected"
				}
			],
			"currentModelId":"string-efforts"
		}
	}`), "")

	if !state.modelsAPI {
		t.Fatal("modelsAPI = false, want true")
	}
	options := extractModelOptionsFromRuntimeDescriptorsForTest(state.configOptionDescriptors)
	if len(options) != 2 {
		t.Fatalf("model options = %#v, want both models preserved", options)
	}
	if options[0]["supportsReasoningEffort"] != true || options[0]["reasoningEffort"] != "high" || options[0]["supportsImageInput"] != true {
		t.Fatalf("fallback metadata = %#v", options[0])
	}
	efforts, ok := options[0]["reasoningEfforts"].([]any)
	if !ok || len(efforts) != 2 {
		t.Fatalf("reasoning efforts = %#v, want string and object entries", options[0]["reasoningEfforts"])
	}
	low, _ := efforts[0].(map[string]any)
	high, _ := efforts[1].(map[string]any)
	if low["value"] != "low" || high["value"] != "high" || high["label"] != "High" || high["default"] != true {
		t.Fatalf("normalized efforts = %#v", efforts)
	}
	if options[1]["value"] != "unknown-metadata" {
		t.Fatalf("unknown metadata model = %#v", options[1])
	}
	if _, advertised := options[1]["reasoningEfforts"]; advertised {
		t.Fatalf("invalid reasoning efforts should be ignored: %#v", options[1])
	}
}

func extractModelOptionsFromRuntimeDescriptorsForTest(descriptors []map[string]any) []map[string]any {
	for _, descriptor := range descriptors {
		if descriptor["id"] != "model" {
			continue
		}
		raw, _ := descriptor["options"].([]any)
		result := make([]map[string]any, 0, len(raw))
		for _, item := range raw {
			if option, ok := item.(map[string]any); ok {
				result = append(result, option)
			}
		}
		return result
	}
	return nil
}
