package apierrors

import (
	"errors"
	"testing"

	agentruntime "github.com/tutti-os/tutti/packages/agent/daemon/runtime"
	agenthost "github.com/tutti-os/tutti/packages/agent/host"
	runtimeprep "github.com/tutti-os/tutti/packages/agent/runtimeprep"
	workspaceissues "github.com/tutti-os/tutti/packages/workspace/issues"
	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

func TestClassifyPendingAgentProcessCleanupPreservesRetryableReason(t *testing.T) {
	runtimeErr := &agentruntime.AppError{
		Code:         agentruntime.AppErrorProcessCleanupPending,
		Message:      "agent process cleanup is still pending",
		DebugMessage: "injected transport close failure",
	}
	classified := Classify(agenthost.NewProviderError(
		runtimeErr.Code,
		runtimeErr.Message,
		runtimeErr.DebugMessage,
		runtimeErr,
	))
	if classified.Code != tuttigenerated.WorkspaceOperationFailed ||
		classified.Reason != agentruntime.AppErrorProcessCleanupPending ||
		!classified.Retryable {
		t.Fatalf("classified = %#v, want retryable process cleanup reason", classified)
	}
}

func TestClassifyConfigDependencyUnavailable(t *testing.T) {
	classified := Classify(&runtimeprep.ConfigDependencyUnavailableError{
		Provider:       "codex",
		ConfigKey:      "model_instructions_file",
		DependencyPath: "instructions.md",
		FailureKind:    runtimeprep.ConfigDependencyFailureMissing,
	})
	if classified.Reason != ReasonAgentConfigDependencyUnavailable {
		t.Fatalf("reason = %q", classified.Reason)
	}
	if classified.Params["dependencyPath"] != "instructions.md" {
		t.Fatalf("params = %#v", classified.Params)
	}
}

func TestClassifyRuntimeOperationReconciliationIsRetryable(t *testing.T) {
	classified := Classify(agentservice.ErrRuntimeOperationInProgress)
	if classified.Reason != ReasonAgentRuntimeOperationReconciling || !classified.Retryable {
		t.Fatalf("classified = %#v, want stable retryable reconciliation reason", classified)
	}
}

func TestClassifyAgentInteractiveResponseStaleErrorsAsConflict(t *testing.T) {
	for _, err := range []error{
		agentservice.ErrInteractionRequestNotFound,
		agentservice.ErrInteractiveRequestNotLive,
		agentservice.ErrInteractiveAlreadyAnswered,
	} {
		classified := ClassifyAgentInteractiveResponse(err)
		if classified.StatusCode != StatusConflict ||
			classified.Code != tuttigenerated.WorkspaceOperationFailed ||
			classified.Reason != ReasonAgentInteractiveRequestStale {
			t.Fatalf("ClassifyAgentInteractiveResponse(%v) = %#v, want stale interactive conflict", err, classified)
		}
		if !errors.Is(classified, err) {
			t.Fatalf("ClassifyAgentInteractiveResponse(%v) did not preserve cause", err)
		}
	}
}

func TestClassifyAgentInteractiveResponseIdentityMismatchAsRuntimeFailure(t *testing.T) {
	classified := ClassifyAgentInteractiveResponse(agentservice.ErrRuntimeOperationIdentityMismatch)
	if classified.StatusCode != StatusWorkspaceOperationFailed ||
		classified.Code != tuttigenerated.WorkspaceOperationFailed ||
		classified.Reason != ReasonWorkspaceOperationFailed {
		t.Fatalf("ClassifyAgentInteractiveResponse(identity mismatch) = %#v, want runtime failure", classified)
	}
	if !errors.Is(classified, agentservice.ErrRuntimeOperationIdentityMismatch) {
		t.Fatal("ClassifyAgentInteractiveResponse(identity mismatch) did not preserve cause")
	}
}

func TestClassifyGuidanceTargetErrorsAsInvalidRequest(t *testing.T) {
	for _, test := range []struct {
		err    error
		reason string
	}{
		{agentservice.ErrActiveTurnTargetRequired, ReasonAgentActiveTurnTargetRequired},
		{agentservice.ErrActiveTurnTargetMismatch, ReasonAgentActiveTurnTargetMismatch},
	} {
		classified := Classify(test.err)
		if classified.StatusCode != StatusInvalidRequest || classified.Code != tuttigenerated.InvalidRequest || classified.Reason != test.reason {
			t.Fatalf("Classify(%v) = %#v, want invalid request reason %q", test.err, classified, test.reason)
		}
		if !errors.Is(classified, test.err) {
			t.Fatalf("Classify(%v) did not preserve cause", test.err)
		}
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

func TestClassifyPendingIssueRunLaunchAsConflict(t *testing.T) {
	classified := Classify(workspaceservice.ErrIssueRunLaunchPending)
	if classified.StatusCode != StatusWorkspaceIssueExists ||
		classified.Code != tuttigenerated.WorkspaceIssueResourceExists ||
		classified.Reason != ReasonWorkspaceIssueRunLaunchPending {
		t.Fatalf("classified = %#v, want pending Issue Run launch conflict", classified)
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
