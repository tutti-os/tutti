package agentruntime

import (
	"encoding/json"
	"testing"
)

func TestACPModeValueReadsCurrentModeID(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name   string
		update map[string]any
		want   string
	}{
		{name: "acp canonical currentModeId", update: map[string]any{"currentModeId": "acceptEdits"}, want: "acceptEdits"},
		{name: "snake current_mode_id", update: map[string]any{"current_mode_id": "plan"}, want: "plan"},
		{name: "legacy modeId fallback", update: map[string]any{"modeId": "default"}, want: "default"},
		{name: "empty", update: map[string]any{}, want: ""},
	}
	for _, tc := range cases {
		if got := acpModeValue(tc.update); got != tc.want {
			t.Fatalf("%s: acpModeValue = %q, want %q", tc.name, got, tc.want)
		}
	}
}

func TestApplyACPUpdateToLiveStateCapturesCurrentModeID(t *testing.T) {
	t.Parallel()

	state := newACPLiveState()
	raw, err := json.Marshal(map[string]any{
		"update": map[string]any{
			"sessionUpdate": "current_mode_update",
			"currentModeId": "auto",
		},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	applyACPUpdateToLiveState(&state, "agent-session-1", raw, "", "")
	if state.currentMode != "auto" {
		t.Fatalf("state.currentMode = %q, want auto", state.currentMode)
	}
}

func TestApplyACPUpdateToLiveStateProjectsDeclaredModelConsumptionMetadata(t *testing.T) {
	t.Parallel()

	state := newACPLiveState()
	raw, err := json.Marshal(map[string]any{
		"update": map[string]any{
			"sessionUpdate": "config_option_update",
			"configOptions": []any{
				map[string]any{
					"id":           "model",
					"currentValue": "glm-5.3",
					"options": []any{
						map[string]any{
							"value":       "glm-5.3",
							"name":        "GLM-5.3",
							"description": "x0.79 credits",
						},
					},
				},
			},
		},
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	applyACPUpdateToLiveState(
		&state,
		"agent-session-1",
		raw,
		"model",
		StandardACPModelDescriptionMetadataFormatCreditConsumptionMultiplierV1,
	)

	options := extractModelOptionsFromRuntimeDescriptorsForTest(state.configOptionDescriptors)
	if len(options) != 1 || options[0]["consumptionMultiplier"] != "0.79" {
		t.Fatalf("model options = %#v, want typed multiplier", options)
	}
	if _, present := options[0]["description"]; present {
		t.Fatalf("credit-only description should be consumed: %#v", options[0])
	}
}
