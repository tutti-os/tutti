package api

import (
	"context"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func (api DaemonAPI) ResolveWorkspaceGitPatchSupport(ctx context.Context, request tuttigenerated.ResolveWorkspaceGitPatchSupportRequestObject) (tuttigenerated.ResolveWorkspaceGitPatchSupportResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ResolveWorkspaceGitPatchSupport503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	result, err := api.AgentSessionService.ResolveGitPatchSupportForPath(ctx, string(request.WorkspaceID), request.Params.Cwd)
	if err != nil {
		return writeResolveWorkspaceGitPatchSupportError(err), nil
	}
	return tuttigenerated.ResolveWorkspaceGitPatchSupport200JSONResponse(workspaceGitPatchSupportResponse(result)), nil
}

func (api DaemonAPI) ApplyWorkspaceGitPatch(ctx context.Context, request tuttigenerated.ApplyWorkspaceGitPatchRequestObject) (tuttigenerated.ApplyWorkspaceGitPatchResponseObject, error) {
	if api.AgentSessionService == nil {
		return tuttigenerated.ApplyWorkspaceGitPatch503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	body := request.Body
	if body == nil {
		return writeApplyWorkspaceGitPatchError(agentservice.ErrInvalidArgument), nil
	}
	target := agentservice.ApplyGitPatchTarget("")
	if body.Target != nil {
		target = agentservice.ApplyGitPatchTarget(*body.Target)
	}
	result, err := api.AgentSessionService.ApplyGitPatchForPath(ctx, string(request.WorkspaceID), agentservice.ApplyGitPatchInput{
		Cwd:         body.Cwd,
		Diff:        body.Diff,
		Revert:      boolValue(body.Revert),
		Atomic:      boolValue(body.Atomic),
		Target:      target,
		AllowBinary: boolValue(body.AllowBinary),
	})
	if err != nil {
		return writeApplyWorkspaceGitPatchError(err), nil
	}
	return tuttigenerated.ApplyWorkspaceGitPatch200JSONResponse(workspaceGitPatchResponse(result)), nil
}

func workspaceGitPatchSupportResponse(result agentservice.GitPatchSupport) tuttigenerated.WorkspaceGitPatchSupportResponse {
	response := tuttigenerated.WorkspaceGitPatchSupportResponse{
		Supported: result.Supported,
	}
	if result.Root != "" {
		root := result.Root
		response.Root = &root
	}
	if result.ErrorCode != agentservice.ApplyGitPatchErrorNone {
		errorCode := tuttigenerated.WorkspaceGitPatchErrorCode(result.ErrorCode)
		response.ErrorCode = &errorCode
	}
	return response
}

func workspaceGitPatchResponse(result agentservice.ApplyGitPatchResult) tuttigenerated.WorkspaceGitPatchResponse {
	response := tuttigenerated.WorkspaceGitPatchResponse{
		Status:          tuttigenerated.WorkspaceGitPatchStatus(result.Status),
		AppliedPaths:    result.AppliedPaths,
		SkippedPaths:    result.SkippedPaths,
		ConflictedPaths: result.ConflictedPaths,
	}
	if response.AppliedPaths == nil {
		response.AppliedPaths = []string{}
	}
	if response.SkippedPaths == nil {
		response.SkippedPaths = []string{}
	}
	if response.ConflictedPaths == nil {
		response.ConflictedPaths = []string{}
	}
	if result.ErrorCode != agentservice.ApplyGitPatchErrorNone {
		errorCode := tuttigenerated.WorkspaceGitPatchErrorCode(result.ErrorCode)
		response.ErrorCode = &errorCode
	}
	if result.ExecOutput.Command != "" || result.ExecOutput.Stdout != "" || result.ExecOutput.Stderr != "" {
		response.ExecOutput = &tuttigenerated.WorkspaceGitPatchExecOutput{
			Command: result.ExecOutput.Command,
			Stdout:  result.ExecOutput.Stdout,
			Stderr:  result.ExecOutput.Stderr,
		}
	}
	return response
}

func boolValue(value *bool) bool {
	return value != nil && *value
}
