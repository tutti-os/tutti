package api

import (
	"reflect"
	"testing"

	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestAgentSubmitMetadataProjectsAllDiagnosticsFields(t *testing.T) {
	submittedAtUnixMs := int64(1234)
	blockCount := 2
	hasImage := true
	promptLength := 42
	queued := false
	source := "  agent-gui  "

	got := agentSubmitMetadata(&tuttigenerated.AgentSubmitDiagnostics{
		SubmittedAtUnixMs: &submittedAtUnixMs,
		BlockCount:        &blockCount,
		HasImage:          &hasImage,
		PromptLength:      &promptLength,
		Queued:            &queued,
		Source:            &source,
	})
	want := map[string]any{
		"blockCount":              2,
		"clientSubmittedAtUnixMs": int64(1234),
		"hasImage":                true,
		"promptLength":            42,
		"queued":                  false,
		"source":                  "agent-gui",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("agentSubmitMetadata() = %#v, want %#v", got, want)
	}
}

func TestApplyEffectiveCreateSessionLaunchPinsReplayInputs(t *testing.T) {
	browserUse := false
	payload := map[string]any{
		"cwd":              (*string)(nil),
		"model":            (*string)(nil),
		"reasoningEffort":  (*string)(nil),
		"permissionModeId": (*string)(nil),
	}

	applyEffectiveCreateSessionLaunch(payload, agentservice.Session{
		Cwd: "/workspace/recorded",
		Settings: &agenthost.ComposerSettings{
			BrowserUse:       &browserUse,
			Model:            "gpt-5.6-terra",
			PermissionModeID: "auto",
			PlanMode:         false,
			ReasoningEffort:  "high",
			Speed:            "standard",
		},
	})

	assertions := map[string]any{
		"browserUse":       &browserUse,
		"cwd":              "/workspace/recorded",
		"model":            "gpt-5.6-terra",
		"permissionModeId": "auto",
		"planMode":         false,
		"reasoningEffort":  "high",
		"speed":            "standard",
	}
	for key, want := range assertions {
		if got := payload[key]; !reflect.DeepEqual(got, want) {
			t.Fatalf("payload[%q] = %#v, want %#v", key, got, want)
		}
	}
}

func TestAgentSubmitMetadataWithoutDiagnosticsIsEmpty(t *testing.T) {
	if got := agentSubmitMetadata(nil); got != nil {
		t.Fatalf("agentSubmitMetadata() = %#v, want nil", got)
	}
}

func TestDirectSessionSendRecordingExcludesActivityEngineSubmissions(t *testing.T) {
	if !shouldRecordDirectSessionSend(nil) {
		t.Fatal("transport submission without renderer diagnostics was excluded")
	}
	if shouldRecordDirectSessionSend(&tuttigenerated.AgentSubmitDiagnostics{}) {
		t.Fatal("activity engine submission would be recorded twice")
	}
}
