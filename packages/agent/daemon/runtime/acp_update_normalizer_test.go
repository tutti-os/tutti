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
	applyACPUpdateToLiveState(&state, "agent-session-1", raw)
	if state.currentMode != "auto" {
		t.Fatalf("state.currentMode = %q, want auto", state.currentMode)
	}
}
