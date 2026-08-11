package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	"github.com/tutti-os/tutti/services/tuttid/apierrors"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

type workspaceManagedWorktreeService interface {
	ListManagedWorktrees(context.Context, string) ([]agentservice.ManagedWorktree, error)
	DeleteManagedWorktree(context.Context, string, string) (bool, error)
}

func (api DaemonAPI) ListWorkspaceManagedWorktrees(
	ctx context.Context,
	request tuttigenerated.ListWorkspaceManagedWorktreesRequestObject,
) (tuttigenerated.ListWorkspaceManagedWorktreesResponseObject, error) {
	service, ok := api.AgentSessionService.(workspaceManagedWorktreeService)
	if !ok || service == nil {
		return tuttigenerated.ListWorkspaceManagedWorktrees503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	worktrees, err := service.ListManagedWorktrees(ctx, string(request.WorkspaceID))
	if err != nil {
		if errors.Is(err, agentservice.ErrInvalidArgument) {
			return tuttigenerated.ListWorkspaceManagedWorktrees400JSONResponse{
				InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest(
					apierrors.ReasonMalformedRequest, apierrors.WithCause(err),
				)),
			}, nil
		}
		return tuttigenerated.ListWorkspaceManagedWorktrees502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(
				apierrors.WorkspaceOperationFailed(apierrors.WithCause(err)),
			),
		}, nil
	}
	result := make([]tuttigenerated.WorkspaceManagedWorktree, 0, len(worktrees))
	for _, worktree := range worktrees {
		item := tuttigenerated.WorkspaceManagedWorktree{
			WorktreeId: worktree.WorktreeID, WorkspaceId: worktree.WorkspaceID,
			RepoRoot: worktree.RepoRoot, WorktreePath: worktree.WorktreePath,
			Branch: worktree.Branch, BaseCommit: worktree.BaseCommit,
		}
		if relative := strings.TrimSpace(worktree.RelativeCwd); relative != "" {
			item.RelativeCwd = &relative
		}
		result = append(result, item)
	}
	return tuttigenerated.ListWorkspaceManagedWorktrees200JSONResponse{
		Worktrees: result,
	}, nil
}

func (api DaemonAPI) DeleteWorkspaceManagedWorktree(
	ctx context.Context,
	request tuttigenerated.DeleteWorkspaceManagedWorktreeRequestObject,
) (tuttigenerated.DeleteWorkspaceManagedWorktreeResponseObject, error) {
	service, ok := api.AgentSessionService.(workspaceManagedWorktreeService)
	if !ok || service == nil {
		return tuttigenerated.DeleteWorkspaceManagedWorktree503JSONResponse{
			ServiceUnavailableErrorJSONResponse: agentSessionServiceUnavailableError(),
		}, nil
	}
	deleted, err := service.DeleteManagedWorktree(
		ctx, string(request.WorkspaceID), request.WorktreeID,
	)
	if err == nil {
		return tuttigenerated.DeleteWorkspaceManagedWorktree200JSONResponse{Deleted: deleted}, nil
	}
	switch {
	case errors.Is(err, agentservice.ErrInvalidArgument):
		return tuttigenerated.DeleteWorkspaceManagedWorktree400JSONResponse{
			InvalidRequestErrorJSONResponse: invalidRequestError(apierrors.InvalidRequest(
				apierrors.ReasonMalformedRequest, apierrors.WithCause(err),
			)),
		}, nil
	case errors.Is(err, agentservice.ErrManagedWorktreeNotFound):
		return tuttigenerated.DeleteWorkspaceManagedWorktree404JSONResponse(protocolErrorResponse(
			apierrors.New(http.StatusNotFound, tuttigenerated.WorkspaceOperationFailed,
				"managed_worktree_not_found", apierrors.WithDeveloperMessage(err.Error())),
		)), nil
	case errors.Is(err, agentservice.ErrManagedWorktreeDirty),
		errors.Is(err, agentservice.ErrManagedWorktreeAhead),
		errors.Is(err, agentservice.ErrManagedWorktreeChanged):
		reason := "managed_worktree_dirty"
		if errors.Is(err, agentservice.ErrManagedWorktreeAhead) {
			reason = "managed_worktree_ahead"
		} else if errors.Is(err, agentservice.ErrManagedWorktreeChanged) {
			reason = "managed_worktree_changed"
		}
		return tuttigenerated.DeleteWorkspaceManagedWorktree409JSONResponse(protocolErrorResponse(
			apierrors.New(http.StatusConflict, tuttigenerated.WorkspaceOperationFailed,
				reason, apierrors.WithDeveloperMessage(err.Error())),
		)), nil
	default:
		return tuttigenerated.DeleteWorkspaceManagedWorktree502JSONResponse{
			WorkspaceOperationErrorJSONResponse: workspaceOperationError(
				apierrors.WorkspaceOperationFailed(apierrors.WithCause(err)),
			),
		}, nil
	}
}
