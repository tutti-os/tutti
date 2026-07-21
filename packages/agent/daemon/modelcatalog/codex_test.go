package modelcatalog

import (
	"reflect"
	"testing"
)

func TestParseCodexModelListLinePreservesPerModelCapabilities(t *testing.T) {
	models, handled, err := ParseCodexModelListLine([]byte(`{
  "id":"2",
  "result":{"data":[{
    "id":"gpt-5.6-sol",
    "model":"gpt-5.6-sol",
    "displayName":"GPT-5.6-Sol",
    "description":"Latest frontier agentic coding model.",
    "supportedReasoningEfforts":[
      {"reasoningEffort":"low","description":"Fast responses"},
      {"reasoningEffort":"medium","description":"Balanced"},
      {"reasoningEffort":"high","description":"Greater depth"},
      {"reasoningEffort":"xhigh","description":"Extra high"},
      {"reasoningEffort":"max","description":"Maximum"},
      {"reasoningEffort":"ultra","description":"Automatic delegation"}
    ],
    "defaultReasoningEffort":"low",
    "additionalSpeedTiers":["fast"],
    "defaultServiceTier":null,
    "inputModalities":["text","image"],
    "isDefault":true
  }]}
}`), "2")
	if err != nil || !handled || len(models) != 1 {
		t.Fatalf("ParseCodexModelListLine() = (%#v, %v, %v)", models, handled, err)
	}
	model := models[0]
	efforts := make([]string, 0, len(model.SupportedReasoningEfforts))
	for _, option := range model.SupportedReasoningEfforts {
		efforts = append(efforts, option.Value)
	}
	if !reflect.DeepEqual(efforts, []string{"low", "medium", "high", "xhigh", "max", "ultra"}) {
		t.Fatalf("reasoning efforts = %#v", efforts)
	}
	if model.DefaultReasoningEffort != "low" || !model.ReasoningEffortsAdvertised {
		t.Fatalf("reasoning defaults = %#v", model)
	}
	speeds := make([]string, 0, len(model.SupportedSpeeds))
	for _, option := range model.SupportedSpeeds {
		speeds = append(speeds, option.Value)
	}
	if !reflect.DeepEqual(speeds, []string{"standard", "fast"}) || model.DefaultSpeed != "standard" {
		t.Fatalf("speed profile = %#v", model)
	}
	if model.SupportsImageInput == nil || !*model.SupportsImageInput {
		t.Fatalf("image input support = %#v", model.SupportsImageInput)
	}
}

func TestNormalizeCodexModelDistinguishesMissingAndEmptyReasoningCatalog(t *testing.T) {
	missing, ok := NormalizeCodexModel([]byte(`{"id":"missing"}`))
	if !ok || missing.ReasoningEffortsAdvertised {
		t.Fatalf("missing reasoning catalog = %#v, %v", missing, ok)
	}
	empty, ok := NormalizeCodexModel([]byte(`{"id":"empty","supportedReasoningEfforts":[]}`))
	if !ok || !empty.ReasoningEffortsAdvertised || len(empty.SupportedReasoningEfforts) != 0 {
		t.Fatalf("empty reasoning catalog = %#v, %v", empty, ok)
	}
}

func TestNormalizeCodexModelUsesServiceTierCatalog(t *testing.T) {
	model, ok := NormalizeCodexModel([]byte(`{
  "id":"gpt-5.6-sol",
  "serviceTiers":[{"id":"priority","name":"Fast","description":"Lower latency"}],
  "defaultServiceTier":"priority"
}`))
	if !ok || !model.SpeedsAdvertised || model.DefaultSpeed != "fast" {
		t.Fatalf("model = %#v, ok = %v", model, ok)
	}
	speeds := make([]string, 0, len(model.SupportedSpeeds))
	for _, option := range model.SupportedSpeeds {
		speeds = append(speeds, option.Value)
	}
	if !reflect.DeepEqual(speeds, []string{"standard", "fast"}) {
		t.Fatalf("speeds = %#v", speeds)
	}
}

func TestParseCodexModelListLineIgnoresOtherResponses(t *testing.T) {
	models, handled, err := ParseCodexModelListLine([]byte(`{"id":"1","result":{}}`), "2")
	if err != nil || handled || models != nil {
		t.Fatalf("other response = (%#v, %v, %v)", models, handled, err)
	}
}
