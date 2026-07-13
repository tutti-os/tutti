package apierrors

import (
	"testing"

	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestClassifyRuntimeOperationReconciliationIsRetryable(t *testing.T) {
	classified := Classify(agentservice.ErrRuntimeOperationInProgress)
	if classified.Reason != ReasonAgentRuntimeOperationReconciling || !classified.Retryable {
		t.Fatalf("classified = %#v, want stable retryable reconciliation reason", classified)
	}
}

func TestClassifyTerminalRuntimeOperationFailureIsNotRetryable(t *testing.T) {
	classified := Classify(agentservice.ErrRuntimeOperationFailed)
	if classified.Reason != ReasonAgentRuntimeOperationFailed || classified.Retryable {
		t.Fatalf("classified = %#v, want stable terminal failure reason", classified)
	}
}
