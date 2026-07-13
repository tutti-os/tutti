package api

import (
	"reflect"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

func TestAgentSubmitMetadataProjectsAllDiagnosticsFields(t *testing.T) {
	submittedAtUnixMs := int64(1234)
	blockCount := 2
	hasImage := true
	promptLength := 42
	queued := false
	source := "  agent-gui  "

	got := agentSubmitMetadata("  submit-1  ", &tuttigenerated.AgentSubmitDiagnostics{
		SubmittedAtUnixMs: &submittedAtUnixMs,
		BlockCount:        &blockCount,
		HasImage:          &hasImage,
		PromptLength:      &promptLength,
		Queued:            &queued,
		Source:            &source,
	})
	want := map[string]any{
		"blockCount":              2,
		"clientSubmitId":          "submit-1",
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

func TestAgentSubmitMetadataWithoutDiagnosticsKeepsCorrelationOnly(t *testing.T) {
	got := agentSubmitMetadata(" submit-2 ", nil)
	want := map[string]any{"clientSubmitId": "submit-2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("agentSubmitMetadata() = %#v, want %#v", got, want)
	}
}
