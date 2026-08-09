package api

import (
	"context"
	"net/http"
	"slices"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
)

func TestDaemonAPIGeneratedRoutesApplyWorkspaceGitPatch(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			applyGitPatchForPathFn: func(_ context.Context, workspaceID string, input agentservice.ApplyGitPatchInput) (agentservice.ApplyGitPatchResult, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if input.Cwd != "/workspace/project" {
					t.Fatalf("cwd = %q, want /workspace/project", input.Cwd)
				}
				if input.Diff != "diff --git a/a.txt b/a.txt\n" {
					t.Fatalf("diff = %q", input.Diff)
				}
				if !input.Revert || !input.Atomic || input.Target != agentservice.ApplyGitPatchTargetStaged || !input.AllowBinary {
					t.Fatalf("input flags = %#v", input)
				}
				return agentservice.ApplyGitPatchResult{
					Status:          agentservice.ApplyGitPatchStatusPartialSuccess,
					AppliedPaths:    []string{"a.txt"},
					SkippedPaths:    []string{"b.txt"},
					ConflictedPaths: []string{"c.txt"},
					ExecOutput: agentservice.ApplyGitPatchExecOutput{
						Command: "git apply -R patch.diff",
						Stderr:  "conflict",
					},
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/ws-1/git-patch",
		map[string]any{
			"cwd":         "/workspace/project",
			"diff":        "diff --git a/a.txt b/a.txt\n",
			"revert":      true,
			"atomic":      true,
			"target":      "staged",
			"allowBinary": true,
		},
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceGitPatchResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Status != tuttigenerated.WorkspaceGitPatchStatus(agentservice.ApplyGitPatchStatusPartialSuccess) {
		t.Fatalf("status = %q, want partial-success", response.Status)
	}
	if !slices.Equal(response.AppliedPaths, []string{"a.txt"}) ||
		!slices.Equal(response.SkippedPaths, []string{"b.txt"}) ||
		!slices.Equal(response.ConflictedPaths, []string{"c.txt"}) {
		t.Fatalf("response paths = %#v", response)
	}
	if response.ExecOutput == nil || response.ExecOutput.Command != "git apply -R patch.diff" || response.ExecOutput.Stderr != "conflict" {
		t.Fatalf("execOutput = %#v", response.ExecOutput)
	}
}

func TestDaemonAPIGeneratedRoutesResolveWorkspaceGitPatchSupport(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			resolveGitPatchSupportForPathFn: func(_ context.Context, workspaceID string, cwd string) (agentservice.GitPatchSupport, error) {
				if workspaceID != "ws-1" {
					t.Fatalf("workspaceID = %q, want ws-1", workspaceID)
				}
				if cwd != "/workspace/project" {
					t.Fatalf("cwd = %q, want /workspace/project", cwd)
				}
				return agentservice.GitPatchSupport{
					Supported: true,
					Root:      "/workspace/project",
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/git-patch-support?cwd=%2Fworkspace%2Fproject",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceGitPatchSupportResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if !response.Supported {
		t.Fatalf("supported = false, want true")
	}
	if response.Root == nil || *response.Root != "/workspace/project" {
		t.Fatalf("root = %#v, want /workspace/project", response.Root)
	}
}

func TestDaemonAPIGeneratedRoutesResolveWorkspaceAgentSessionWorktreeSupport(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		AgentSessionService: stubAgentSessionService{
			resolveWorktreeSupportFn: func(_ context.Context, workspaceID string, agentTargetID string, cwd string) (agentservice.SessionWorktreeSupport, error) {
				if workspaceID != "ws-1" || agentTargetID != "local:codex" || cwd != "/workspace/project" {
					t.Fatalf("workspace/target/cwd = %q/%q/%q", workspaceID, agentTargetID, cwd)
				}
				return agentservice.SessionWorktreeSupport{
					Supported: true,
					Root:      "/workspace/project",
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodGet,
		"/v1/workspaces/ws-1/agent-session-worktree-support?agentTargetId=local%3Acodex&cwd=%2Fworkspace%2Fproject",
		nil,
	)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.WorkspaceAgentSessionWorktreeSupportResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if !response.Supported || response.Root == nil || *response.Root != "/workspace/project" {
		t.Fatalf("response = %#v", response)
	}
}
