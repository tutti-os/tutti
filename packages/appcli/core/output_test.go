package core

import (
	"errors"
	"testing"
)

func TestValidateCommandOutputFillsDeclaredTableColumns(t *testing.T) {
	output, err := ValidateCommandOutput(CapabilityOutput{
		DefaultMode: OutputModeTable,
		JSON:        true,
		Table:       &TableOutput{Columns: []TableColumn{{Key: "id", Label: "ID"}}},
	}, CommandOutput{
		Kind: OutputModeTable,
		Rows: []map[string]any{{"id": "job-1"}},
	})
	if err != nil {
		t.Fatalf("ValidateCommandOutput() error = %v", err)
	}
	if len(output.Columns) != 1 || output.Columns[0].Key != "id" {
		t.Fatalf("output = %#v", output)
	}
}

func TestValidateCommandOutputRejectsUndeclaredJSON(t *testing.T) {
	_, err := ValidateCommandOutput(CapabilityOutput{
		DefaultMode: OutputModeTable,
		Table:       &TableOutput{Columns: []TableColumn{{Key: "id", Label: "ID"}}},
	}, CommandOutput{Kind: OutputModeJSON, Value: map[string]any{"ok": true}})
	if !errors.Is(err, ErrHandlerBadResponse) {
		t.Fatalf("ValidateCommandOutput() error = %v, want ErrHandlerBadResponse", err)
	}
}

func TestDecodeAndValidateWaitContinuation(t *testing.T) {
	output, err := DecodeCommandOutput([]byte(`{
    "kind":"json",
    "value":{"status":"running"},
    "continuation":{"state":"pending","retryAfterMs":500}
  }`))
	if err != nil {
		t.Fatalf("DecodeCommandOutput() error = %v", err)
	}
	if err := ValidateCommandContinuation(&CommandExecution{Mode: CommandExecutionModeWait}, output); err != nil {
		t.Fatalf("ValidateCommandContinuation() error = %v", err)
	}
	if output.Continuation == nil || output.Continuation.RetryAfterMs != 500 {
		t.Fatalf("output = %#v", output)
	}
}

func TestValidateCommandContinuationRejectsHotLoopAndNonWaitCommands(t *testing.T) {
	output := CommandOutput{
		Kind: OutputModeJSON,
		Continuation: &CommandContinuation{
			State: CommandContinuationStatePending, RetryAfterMs: MinContinuationRetryAfterMs - 1,
		},
	}
	if err := ValidateCommandContinuation(&CommandExecution{Mode: CommandExecutionModeWait}, output); !errors.Is(err, ErrHandlerBadResponse) {
		t.Fatalf("hot-loop error = %v", err)
	}
	output.Continuation.RetryAfterMs = MinContinuationRetryAfterMs
	if err := ValidateCommandContinuation(nil, output); !errors.Is(err, ErrHandlerBadResponse) {
		t.Fatalf("non-wait error = %v", err)
	}
}
