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

func TestAgentSubmitMetadataWithoutDiagnosticsIsEmpty(t *testing.T) {
	if got := agentSubmitMetadata(nil); got != nil {
		t.Fatalf("agentSubmitMetadata() = %#v, want nil", got)
	}
}
