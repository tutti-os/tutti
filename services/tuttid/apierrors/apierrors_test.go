package apierrors

import (
	"fmt"
	"reflect"
	"testing"

	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
)

func TestClassifyAgentConfigDependencyUnavailable(t *testing.T) {
	source := &runtimeprep.ConfigDependencyUnavailableError{
		Provider:       "codex",
		ConfigKey:      "model_instructions_file",
		DependencyPath: "profiles/instructions.md",
		FailureKind:    runtimeprep.ConfigDependencyFailureMissing,
	}
	got := Classify(fmt.Errorf("prepare runtime: %w", source))

	if got.Code != tuttigenerated.WorkspaceOperationFailed {
		t.Fatalf("code = %q, want workspace_operation_failed", got.Code)
	}
	if got.Reason != ReasonAgentConfigDependencyUnavailable {
		t.Fatalf("reason = %q, want %q", got.Reason, ReasonAgentConfigDependencyUnavailable)
	}
	wantParams := map[string]any{
		"provider":       "codex",
		"configKey":      "model_instructions_file",
		"dependencyPath": "profiles/instructions.md",
		"failureKind":    runtimeprep.ConfigDependencyFailureMissing,
	}
	if !reflect.DeepEqual(got.Params, wantParams) {
		t.Fatalf("params = %#v, want %#v", got.Params, wantParams)
	}
	if got.Retryable {
		t.Fatal("retryable = true, want false")
	}
}
