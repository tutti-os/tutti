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

func TestClassifySessionTitleTooLongHasStableReasonAndLimit(t *testing.T) {
	classified := Classify(agentservice.ErrSessionTitleTooLong)
	if classified.Reason != ReasonWorkspaceAgentSessionTitleTooLong {
		t.Fatalf("reason = %q, want %q", classified.Reason, ReasonWorkspaceAgentSessionTitleTooLong)
	}
	if classified.Params["maxCharacters"] != agentservice.MaxSessionTitleRunes {
		t.Fatalf("params = %#v, want maxCharacters = %d", classified.Params, agentservice.MaxSessionTitleRunes)
	}
}
