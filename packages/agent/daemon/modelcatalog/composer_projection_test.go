package modelcatalog

import (
	"reflect"
	"testing"
)

func TestProjectComposerCatalogPreservesSelectedModelCapabilities(t *testing.T) {
	models := []ModelOption{
		{
			ID:                         "gpt-5.6",
			IsDefault:                  true,
			ReasoningEffortsAdvertised: true,
			DefaultReasoningEffort:     "high",
			SupportedReasoningEfforts: []ReasoningEffortOption{
				{Value: "low"}, {Value: "medium"}, {Value: "high"},
				{Value: "xhigh"}, {Value: "max"}, {Value: "ultra"},
			},
			SpeedsAdvertised: true,
			DefaultSpeed:     "standard",
			SupportedSpeeds:  []SpeedOption{{Value: "standard"}, {Value: "fast"}},
		},
	}

	projection := ProjectComposerCatalog(models, "")
	if !projection.Selection.Found || projection.Selection.Model.ID != "gpt-5.6" {
		t.Fatalf("selection = %#v", projection.Selection)
	}
	if projection.Selection.DefaultSpeed != "standard" {
		t.Fatalf("default speed = %q, want standard", projection.Selection.DefaultSpeed)
	}
	wantReasoning := []string{"low", "medium", "high", "xhigh", "max", "ultra"}
	gotReasoning := make([]string, 0, len(projection.Selection.ReasoningEfforts))
	for _, option := range projection.Selection.ReasoningEfforts {
		gotReasoning = append(gotReasoning, option.Value)
	}
	if !reflect.DeepEqual(gotReasoning, wantReasoning) {
		t.Fatalf("reasoning = %#v, want %#v", gotReasoning, wantReasoning)
	}
	profile := projection.ReasoningOptionsByModel["gpt-5.6"]
	if profile.DefaultValue != "high" || len(profile.Options) != len(wantReasoning) {
		t.Fatalf("reasoning profile = %#v", profile)
	}
}

func TestProjectComposerCatalogPreservesAdvertisedEmptyCapabilities(t *testing.T) {
	projection := ProjectComposerCatalog([]ModelOption{{
		ID:                         "catalog-owned",
		ReasoningEffortsAdvertised: true,
	}}, "catalog-owned")

	profile, found := projection.ReasoningOptionsByModel["catalog-owned"]
	if !found || len(profile.Options) != 0 || profile.DefaultValue != "" {
		t.Fatalf("profile = %#v, found=%v", profile, found)
	}
	if !projection.Selection.ReasoningEffortsAdvertised || len(projection.Selection.ReasoningEfforts) != 0 {
		t.Fatalf("selection = %#v", projection.Selection)
	}
}
