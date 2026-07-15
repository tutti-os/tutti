package apierrors

import (
	"fmt"
	"reflect"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentsidecar "github.com/tutti-os/tutti/services/tuttid/service/agentsidecar"
)

func TestClassifyAgentConfigDependencyUnavailable(t *testing.T) {
	source := &agentsidecar.ConfigDependencyUnavailableError{
		Provider:       "codex",
		ConfigKey:      "model_instructions_file",
		DependencyPath: "profiles/instructions.md",
		FailureKind:    agentsidecar.ConfigDependencyFailureMissing,
	}
	got := Classify(fmt.Errorf("prepare runtime: %w", source))
	if got.Code != tuttigenerated.WorkspaceOperationFailed || got.Reason != ReasonAgentConfigDependencyUnavailable {
		t.Fatalf("protocol error = %#v", got)
	}
	want := map[string]any{
		"provider": "codex", "configKey": "model_instructions_file",
		"dependencyPath": "profiles/instructions.md", "failureKind": agentsidecar.ConfigDependencyFailureMissing,
	}
	if !reflect.DeepEqual(got.Params, want) || got.Retryable {
		t.Fatalf("params/retryable = %#v/%v, want %#v/false", got.Params, got.Retryable, want)
	}
}
