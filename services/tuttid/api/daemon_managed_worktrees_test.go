package api

import (
	"context"
	"net/http"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestDaemonAPIGeneratedRoutesListWorkspaceManagedWorktrees(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			listManagedWorktreesFn: func(_ context.Context, workspaceID string) ([]agentservice.ManagedWorktree, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q", workspaceID)
				}
				return []agentservice.ManagedWorktree{{
					WorktreeID: "worktree-1", WorkspaceID: "ws-1",
					RepoRoot: "/repo", WorktreePath: "/state/worktrees/worktree-1",
					Branch: "tutti/worktree/worktree-1", BaseCommit: "abc", RelativeCwd: "packages/app",
				}}, nil
			},
		},
	}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet,
		"/v1/workspaces/ws-1/managed-worktrees", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", recorder.Code, recorder.Body.String())
	}
	var response tuttigenerated.WorkspaceManagedWorktreeListResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if len(response.Worktrees) != 1 || response.Worktrees[0].WorktreeId != "worktree-1" ||
		response.Worktrees[0].RelativeCwd == nil || *response.Worktrees[0].RelativeCwd != "packages/app" {
		t.Fatalf("response = %#v", response)
	}
}

func TestDaemonAPIGeneratedRoutesDeleteWorkspaceManagedWorktree(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			deleteManagedWorktreeFn: func(_ context.Context, workspaceID string, worktreeID string) (bool, error) {
				if workspaceID != "ws-1" || worktreeID != "worktree-1" {
					t.Fatalf("workspace/worktree = %q/%q", workspaceID, worktreeID)
				}
				return true, nil
			},
		},
	}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodDelete,
		"/v1/workspaces/ws-1/managed-worktrees/worktree-1", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d; body: %s", recorder.Code, recorder.Body.String())
	}
	var response tuttigenerated.DeleteWorkspaceManagedWorktreeResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if !response.Deleted {
		t.Fatalf("response = %#v", response)
	}
}

func TestDaemonAPIGeneratedRoutesRejectDirtyManagedWorktreeDelete(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			deleteManagedWorktreeFn: func(context.Context, string, string) (bool, error) {
				return false, agentservice.ErrManagedWorktreeDirty
			},
		},
	}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodDelete,
		"/v1/workspaces/ws-1/managed-worktrees/worktree-1", nil)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body: %s", recorder.Code, recorder.Body.String())
	}
}

func TestDaemonAPIGeneratedRoutesRejectChangedManagedWorktreeDelete(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			deleteManagedWorktreeFn: func(context.Context, string, string) (bool, error) {
				return false, agentservice.ErrManagedWorktreeChanged
			},
		},
	}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodDelete,
		"/v1/workspaces/ws-1/managed-worktrees/worktree-1", nil)
	if recorder.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body: %s", recorder.Code, recorder.Body.String())
	}
}
