package api

import (
	"context"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	agentservice "github.com/tutti-os/tutti/services/tuttid/service/agent"
	userprojectservice "github.com/tutti-os/tutti/services/tuttid/service/userproject"
)

func TestScanExternalImportForwardsArchivePath(t *testing.T) {
	archivePath := "/tmp/claude-export.zip"
	var captured agentservice.ExternalImportScanInput
	api := DaemonAPI{AgentSessionService: stubAgentSessionService{
		scanExternalFn: func(_ context.Context, input agentservice.ExternalImportScanInput) (agentservice.ExternalImportScanResult, error) {
			captured = input
			return agentservice.ExternalImportScanResult{}, nil
		},
	}}

	response, err := api.ScanWorkspaceExternalAgentSessionImports(context.Background(), tuttigenerated.ScanWorkspaceExternalAgentSessionImportsRequestObject{
		WorkspaceID: "ws-1",
		Body: &tuttigenerated.ExternalAgentImportScanRequest{
			ArchivePath: &archivePath,
		},
	})
	if err != nil {
		t.Fatalf("ScanWorkspaceExternalAgentSessionImports error = %v", err)
	}
	if _, ok := response.(tuttigenerated.ScanWorkspaceExternalAgentSessionImports200JSONResponse); !ok {
		t.Fatalf("response = %T, want 200", response)
	}
	if captured.ArchivePath != archivePath {
		t.Fatalf("archive path = %q, want %q", captured.ArchivePath, archivePath)
	}
}

func TestImportExternalSessionsForwardsArchivePath(t *testing.T) {
	archivePath := "/tmp/claude-export.zip"
	var captured agentservice.ExternalImportInput
	api := DaemonAPI{AgentSessionService: stubAgentSessionService{
		importExternalFn: func(_ context.Context, workspaceID string, input agentservice.ExternalImportInput) (agentservice.ExternalImportResult, error) {
			if workspaceID != "ws-1" {
				t.Fatalf("workspace id = %q", workspaceID)
			}
			captured = input
			return agentservice.ExternalImportResult{}, nil
		},
	}}

	response, err := api.ImportWorkspaceExternalAgentSessions(context.Background(), tuttigenerated.ImportWorkspaceExternalAgentSessionsRequestObject{
		WorkspaceID: "ws-1",
		Body: &tuttigenerated.ImportExternalAgentSessionsRequest{
			ArchivePath: &archivePath,
			Projects: []tuttigenerated.ExternalAgentImportProjectSelection{{
				Path:       "/Users/demo",
				SessionIds: &[]string{"session-1"},
			}},
		},
	})
	if err != nil {
		t.Fatalf("ImportWorkspaceExternalAgentSessions error = %v", err)
	}
	if _, ok := response.(tuttigenerated.ImportWorkspaceExternalAgentSessions200JSONResponse); !ok {
		t.Fatalf("response = %T, want 200", response)
	}
	if captured.ArchivePath != archivePath || len(captured.Projects) != 1 {
		t.Fatalf("captured input = %#v", captured)
	}
}

func TestRegisterExternalImportUserProjectsPreservesInputOrderInLastUsedTimes(t *testing.T) {
	var inputs []userprojectservice.UseInput
	api := DaemonAPI{
		UserProjectService: stubUserProjectService{
			useFn: func(_ context.Context, input userprojectservice.UseInput) (userprojectbiz.Project, error) {
				inputs = append(inputs, input)
				return userprojectbiz.Project{Path: input.Path}, nil
			},
		},
	}

	registered, errors := api.registerExternalImportUserProjects(context.Background(), []agentservice.ExternalImportProjectSelection{
		{Path: "/workspace/newer"},
		{Path: "/workspace/older"},
	}, true)
	if len(errors) != 0 {
		t.Fatalf("registration errors = %#v, want none", errors)
	}
	if len(registered) != 2 || len(inputs) != 2 {
		t.Fatalf("registered = %#v inputs = %#v, want two projects", registered, inputs)
	}
	if inputs[0].LastUsedAtUnixMS <= inputs[1].LastUsedAtUnixMS {
		t.Fatalf("last used times = [%d, %d], want first input newer", inputs[0].LastUsedAtUnixMS, inputs[1].LastUsedAtUnixMS)
	}
}
