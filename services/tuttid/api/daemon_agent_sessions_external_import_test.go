package api

import (
	"context"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
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
	var input userprojectservice.UseManyInput
	api := DaemonAPI{
		UserProjectService: stubUserProjectService{
			useManyFn: func(_ context.Context, value userprojectservice.UseManyInput) []error {
				input = value
				return make([]error, len(value.Paths))
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
	if len(registered) != 2 || len(input.Paths) != 2 {
		t.Fatalf("registered = %#v input = %#v, want two projects", registered, input)
	}
	if input.Paths[0] != "/workspace/newer" || input.Paths[1] != "/workspace/older" {
		t.Fatalf("registration paths = %#v, want input order", input.Paths)
	}
}
