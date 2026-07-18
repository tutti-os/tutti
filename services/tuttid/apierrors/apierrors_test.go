package apierrors

import (
	"errors"
	"testing"

	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestClassifyRuntimeOperationReconciliationIsRetryable(t *testing.T) {
	classified := Classify(agentservice.ErrRuntimeOperationInProgress)
	if classified.Reason != ReasonAgentRuntimeOperationReconciling || !classified.Retryable {
		t.Fatalf("classified = %#v, want stable retryable reconciliation reason", classified)
	}
}

func TestClassifyWorktreeIsolationErrors(t *testing.T) {
	tests := []struct {
		err    error
		reason string
	}{
		{agentservice.ErrNotAGitRepo, ReasonNotAGitRepo},
		{agentservice.ErrGitUnavailable, ReasonGitUnavailable},
		{agentservice.ErrUnsupportedRepoLayout, ReasonUnsupportedRepoLayout},
		{&agentservice.WorktreeIsolationError{Kind: agentservice.ErrWorktreeCreateFailed, Detail: "git stderr"}, ReasonWorktreeCreateFailed},
	}
	for _, test := range tests {
		classified := Classify(test.err)
		if classified.Reason != test.reason || !errors.Is(classified, test.err) {
			t.Fatalf("Classify(%v) = %#v, want reason %q", test.err, classified, test.reason)
		}
	}
	classified := Classify(&agentservice.WorktreeIsolationError{Kind: agentservice.ErrWorktreeCreateFailed, Detail: "git stderr"})
	if classified.Params["detail"] != "git stderr" {
		t.Fatalf("worktree create detail = %#v", classified.Params)
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
