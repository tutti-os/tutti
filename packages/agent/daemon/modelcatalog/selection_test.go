package modelcatalog

import (
	"reflect"
	"testing"
)

func TestSelectModelProjectsOnlyEffectiveModelCapabilities(t *testing.T) {
	models := []ModelOption{
		{ID: "default", IsDefault: true, ReasoningEffortsAdvertised: true, SupportedReasoningEfforts: []ReasoningEffortOption{{Value: "medium"}}, DefaultReasoningEffort: "medium"},
		{
			ID: "gpt-5.6-sol", ReasoningEffortsAdvertised: true,
			SupportedReasoningEfforts: []ReasoningEffortOption{{Value: "low"}, {Value: "medium"}, {Value: "high"}, {Value: "xhigh"}, {Value: "max"}, {Value: "ultra"}},
			DefaultReasoningEffort:    "low", SpeedsAdvertised: true,
			SupportedSpeeds: []SpeedOption{{Value: "standard"}, {Value: "fast"}}, DefaultSpeed: "standard",
		},
	}
	selection := SelectModel(models, "gpt-5.6-sol")
	if !selection.Found || selection.Model.ID != "gpt-5.6-sol" {
		t.Fatalf("selection = %#v", selection)
	}
	efforts := make([]string, 0, len(selection.ReasoningEfforts))
	for _, option := range selection.ReasoningEfforts {
		efforts = append(efforts, option.Value)
	}
	if !reflect.DeepEqual(efforts, []string{"low", "medium", "high", "xhigh", "max", "ultra"}) {
		t.Fatalf("efforts = %#v", efforts)
	}
	if selection.DefaultReasoningEffort != "low" || selection.DefaultSpeed != "standard" {
		t.Fatalf("defaults = %#v", selection)
	}
}

func TestSelectModelPreservesAdvertisedEmptyReasoning(t *testing.T) {
	selection := SelectModel([]ModelOption{{ID: "plain", IsDefault: true, ReasoningEffortsAdvertised: true}}, "")
	if !selection.Found || !selection.ReasoningEffortsAdvertised || selection.ReasoningEfforts != nil || selection.DefaultReasoningEffort != "" {
		t.Fatalf("selection = %#v", selection)
	}
}

func TestSelectModelPreservesRequestedModelMissingFromPartialCatalog(t *testing.T) {
	selection := SelectModel([]ModelOption{{ID: "default", IsDefault: true}}, "custom")
	if !selection.Found || selection.Model.ID != "custom" || selection.ReasoningEffortsAdvertised || selection.SpeedsAdvertised {
		t.Fatalf("selection = %#v", selection)
	}
}
