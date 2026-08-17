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
	uiMode := tuttigenerated.AgentSubmitDiagnosticsUiModeAgent

	got := agentSubmitMetadata(&tuttigenerated.AgentSubmitDiagnostics{
		SubmittedAtUnixMs: &submittedAtUnixMs,
		BlockCount:        &blockCount,
		HasImage:          &hasImage,
		PromptLength:      &promptLength,
		Queued:            &queued,
		Source:            &source,
		UiMode:            &uiMode,
	})
	want := map[string]any{
		"blockCount":              2,
		"clientSubmittedAtUnixMs": int64(1234),
		"hasImage":                true,
		"promptLength":            42,
		"queued":                  false,
		"source":                  "agent-gui",
		"uiMode":                  "agent",
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
		"isolation":        (*string)(nil),
	}

	applyEffectiveCreateSessionLaunch(payload, agentservice.Session{
		Cwd: "/workspace/recorded",
		Isolation: &agentservice.SessionIsolation{
			Mode: agentservice.WorktreeIsolationMode,
		},
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
		"isolation":        agentservice.WorktreeIsolationMode,
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

func TestValidateAgentSubmitDiagnosticsRejectsUnknownUiMode(t *testing.T) {
	invalid := tuttigenerated.AgentSubmitDiagnosticsUiMode("unknown")
	if err := validateAgentSubmitDiagnostics(&tuttigenerated.AgentSubmitDiagnostics{UiMode: &invalid}); err == nil {
		t.Fatal("unknown uiMode accepted")
	}
	for _, mode := range []tuttigenerated.AgentSubmitDiagnosticsUiMode{
		tuttigenerated.AgentSubmitDiagnosticsUiModeOs,
		tuttigenerated.AgentSubmitDiagnosticsUiModeAgent,
	} {
		if err := validateAgentSubmitDiagnostics(&tuttigenerated.AgentSubmitDiagnostics{UiMode: &mode}); err != nil {
			t.Fatalf("valid uiMode %q rejected: %v", mode, err)
		}
	}
}

func TestDirectSessionSendRecordingExcludesActivityEngineSubmissions(t *testing.T) {
	if !shouldRecordDirectSessionSend(nil, nil) {
		t.Fatal("transport submission without renderer diagnostics was excluded")
	}
	if shouldRecordDirectSessionSend(
		&tuttigenerated.AgentSubmitDiagnostics{},
		nil,
	) {
		t.Fatal("activity engine submission would be recorded twice")
	}
	origin := tuttigenerated.SendWorkspaceAgentSessionInputParamsXTuttiAgentCommandOriginRendererEngine
	if shouldRecordDirectSessionSend(nil, &origin) {
		t.Fatal("renderer Engine provenance would be recorded twice")
	}
}

func TestRendererEngineCommandOriginIsExplicit(t *testing.T) {
	origin := tuttigenerated.CancelWorkspaceAgentTurnParamsXTuttiAgentCommandOriginRendererEngine
	if !isRendererEngineCommandOrigin(&origin) {
		t.Fatal("renderer Engine origin was not recognized")
	}
	if isRendererEngineCommandOrigin[tuttigenerated.CancelWorkspaceAgentTurnParamsXTuttiAgentCommandOrigin](nil) {
		t.Fatal("absent origin was treated as renderer Engine")
	}
}
