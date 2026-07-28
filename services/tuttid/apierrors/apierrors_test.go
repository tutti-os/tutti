package apierrors

import (
	"errors"
	"testing"

	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
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

func TestClassifyManagedIssueMutationCarriesRecoveryTarget(t *testing.T) {
	classified := Classify(&workspaceissues.ManagedIssueMutationError{
		IssueID: "issue-managed", SourceSessionID: "source-session",
	})
	if classified.StatusCode != StatusWorkspaceIssueExists ||
		classified.Code != tuttigenerated.WorkspaceIssueResourceExists ||
		classified.Reason != "tutti_issue_managed" {
		t.Fatalf("classified = %#v, want managed Issue conflict", classified)
	}
	if classified.Params["issueId"] != "issue-managed" ||
		classified.Params["sourceSessionId"] != "source-session" ||
		classified.Params["recommendedAction"] != "open_source_session" {
		t.Fatalf("params = %#v, want exact source-conversation recovery target", classified.Params)
	}
}

func TestClassifyUnsupportedPermissionModeHasStableReasonAndOptions(t *testing.T) {
	err := &agentservice.UnsupportedPermissionModeIDError{
		AgentTargetID:              "extension:codebuddy",
		PermissionModeID:           "full-access",
		AvailablePermissionModeIDs: []string{"default", "bypassPermissions", "fullAccess"},
	}
	classified := Classify(err)
	if classified.Reason != ReasonUnsupportedPermissionModeID || !errors.Is(classified, agentservice.ErrInvalidArgument) {
		t.Fatalf("classified = %#v, want stable unsupported permission reason", classified)
	}
	if classified.Params["agentTargetId"] != "extension:codebuddy" ||
		classified.Params["permissionModeId"] != "full-access" {
		t.Fatalf("params = %#v, want target and rejected id", classified.Params)
	}
	available, ok := classified.Params["availablePermissionModeIds"].([]string)
	if !ok || len(available) != 3 || available[1] != "bypassPermissions" {
		t.Fatalf("availablePermissionModeIds = %#v", classified.Params["availablePermissionModeIds"])
	}
}
