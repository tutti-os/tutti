package api

import (
	"context"
	"net/http"
	"strings"
	"testing"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
	workspaceservice "github.com/tutti-os/tutti/services/tuttid/service/workspace"
)

func TestDaemonAPIGeneratedRoutesListWorkspaceAppReferences(t *testing.T) {
	mux := http.NewServeMux()
	var gotWorkspaceID string
	var gotAppID string
	var gotInput workspacebiz.AppReferenceListInput
	listCalls := 0
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			AppCenterService: stubWorkspaceAppCenterService{
				listReferencesFn: func(_ context.Context, workspaceID string, appID string, input workspacebiz.AppReferenceListInput) (workspacebiz.AppReferenceListResult, error) {
					listCalls++
					gotWorkspaceID = workspaceID
					gotAppID = appID
					gotInput = input
					return workspacebiz.AppReferenceListResult{}, nil
				},
			},
		}),
	)

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/workspace-1/apps/docs/references/list",
		map[string]any{
			"parentGroupId": " group-1 ",
			"filterText":    " guide ",
			"limit":         5,
			"cursor":        " cursor ",
			"kinds":         []string{"file"},
			"timeRange": map[string]any{
				"fromMs": 1000,
				"toMs":   2000,
			},
		},
	)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if listCalls != 1 {
		t.Fatalf("expected one list call, got %d", listCalls)
	}
	if gotWorkspaceID != "workspace-1" {
		t.Fatalf("expected workspace id workspace-1, got %q", gotWorkspaceID)
	}
	if gotAppID != "docs" {
		t.Fatalf("expected app id docs, got %q", gotAppID)
	}
	if gotInput.ParentGroupID != "group-1" {
		t.Fatalf("expected trimmed parentGroupId, got %q", gotInput.ParentGroupID)
	}
	if gotInput.FilterText != "guide" {
		t.Fatalf("expected trimmed filterText, got %q", gotInput.FilterText)
	}
	if gotInput.Limit != 5 {
		t.Fatalf("expected limit 5, got %d", gotInput.Limit)
	}
	if gotInput.Cursor != "cursor" {
		t.Fatalf("expected trimmed cursor, got %q", gotInput.Cursor)
	}
	if len(gotInput.Kinds) != 1 || gotInput.Kinds[0] != workspacebiz.AppReferenceKindFile {
		t.Fatalf("expected file kind filter, got %#v", gotInput.Kinds)
	}
	if gotInput.TimeRange == nil || gotInput.TimeRange.FromMs == nil || *gotInput.TimeRange.FromMs != 1000 || gotInput.TimeRange.ToMs == nil || *gotInput.TimeRange.ToMs != 2000 {
		t.Fatalf("expected forwarded time range, got %#v", gotInput.TimeRange)
	}
}

func TestDaemonAPIGeneratedRoutesListWorkspaceAppReferencesRejectsInvalidRequest(t *testing.T) {
	tests := []struct {
		name string
		body map[string]any
	}{
		{
			name: "blank parent group id",
			body: map[string]any{"parentGroupId": " "},
		},
		{
			name: "parent group id too long",
			body: map[string]any{"parentGroupId": strings.Repeat("g", 2049)},
		},
		{
			name: "filterText too long",
			body: map[string]any{"filterText": strings.Repeat("x", 201)},
		},
		{
			name: "limit below minimum",
			body: map[string]any{"limit": 0},
		},
		{
			name: "limit above maximum",
			body: map[string]any{"limit": 51},
		},
		{
			name: "cursor too long",
			body: map[string]any{"cursor": strings.Repeat("c", 2049)},
		},
		{
			name: "unknown kind",
			body: map[string]any{"kinds": []string{"url"}},
		},
		{
			name: "negative from",
			body: map[string]any{"timeRange": map[string]any{"fromMs": -1}},
		},
		{
			name: "negative to",
			body: map[string]any{"timeRange": map[string]any{"toMs": -1}},
		},
		{
			name: "from after to",
			body: map[string]any{"timeRange": map[string]any{"fromMs": 2, "toMs": 1}},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mux := http.NewServeMux()
			listCalls := 0
			RegisterRoutes(
				mux,
				NewRoutes(DaemonAPI{
					AppCenterService: stubWorkspaceAppCenterService{
						listReferencesFn: func(context.Context, string, string, workspacebiz.AppReferenceListInput) (workspacebiz.AppReferenceListResult, error) {
							listCalls++
							return workspacebiz.AppReferenceListResult{}, nil
						},
					},
				}),
			)

			recorder := performGeneratedRouteRequest(
				t,
				mux,
				http.MethodPost,
				"/v1/workspaces/workspace-1/apps/docs/references/list",
				tt.body,
			)

			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("expected status 400, got %d: %s", recorder.Code, recorder.Body.String())
			}
			if listCalls != 0 {
				t.Fatalf("expected list not to be called, got %d calls", listCalls)
			}
		})
	}
}

func TestDaemonAPIGeneratedRoutesInstallWorkspaceAppPassesRestartOption(t *testing.T) {
	mux := http.NewServeMux()
	var gotWorkspaceID string
	var gotAppID string
	var gotOptions workspaceservice.InstallOptions
	installCalls := 0
	RegisterRoutes(
		mux,
		NewRoutes(DaemonAPI{
			AppCenterService: stubWorkspaceAppCenterService{
				installWithOptionsFn: func(_ context.Context, workspaceID string, appID string, options workspaceservice.InstallOptions) (workspacebiz.WorkspaceApp, error) {
					installCalls++
					gotWorkspaceID = workspaceID
					gotAppID = appID
					gotOptions = options
					return workspacebiz.WorkspaceApp{
						Package: workspacebiz.AppPackage{
							AppID:      appID,
							Version:    "1.0.0",
							PackageDir: "/tmp/app",
							Manifest: workspacebiz.AppManifest{
								AppID:       appID,
								Version:     "1.0.0",
								Name:        "App",
								Description: "",
							},
							Source: workspacebiz.AppPackageSourceBuiltin,
						},
						Runtime: workspacebiz.AppRuntimeState{Status: workspacebiz.AppRuntimeStatusIdle},
					}, nil
				},
			},
		}),
	)

	recorder := performGeneratedRouteRequest(
		t,
		mux,
		http.MethodPost,
		"/v1/workspaces/workspace-1/apps/docs/install",
		map[string]any{"restartRunning": true},
	)

	if recorder.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if installCalls != 1 {
		t.Fatalf("expected one install call, got %d", installCalls)
	}
	if gotWorkspaceID != "workspace-1" || gotAppID != "docs" {
		t.Fatalf("install target = %q/%q, want workspace-1/docs", gotWorkspaceID, gotAppID)
	}
	if !gotOptions.RestartRunning {
		t.Fatal("RestartRunning = false, want true")
	}
}

type stubWorkspaceAppCenterService struct {
	installWithOptionsFn func(context.Context, string, string, workspaceservice.InstallOptions) (workspacebiz.WorkspaceApp, error)
	listReferencesFn     func(context.Context, string, string, workspacebiz.AppReferenceListInput) (workspacebiz.AppReferenceListResult, error)
}

func (stubWorkspaceAppCenterService) Add(context.Context, string, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (stubWorkspaceAppCenterService) DeletePackage(context.Context, string, string) error {
	return nil
}

func (stubWorkspaceAppCenterService) ExportPackage(context.Context, string, string, string) (workspaceservice.AppPackageArchiveResult, error) {
	return workspaceservice.AppPackageArchiveResult{}, nil
}

func (stubWorkspaceAppCenterService) ImportPackage(context.Context, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (stubWorkspaceAppCenterService) Install(context.Context, string, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (s stubWorkspaceAppCenterService) InstallWithOptions(ctx context.Context, workspaceID string, appID string, options workspaceservice.InstallOptions) (workspacebiz.WorkspaceApp, error) {
	if s.installWithOptionsFn == nil {
		return workspacebiz.WorkspaceApp{}, nil
	}
	return s.installWithOptionsFn(ctx, workspaceID, appID, options)
}

func (stubWorkspaceAppCenterService) Launch(context.Context, string, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (s stubWorkspaceAppCenterService) ListReferences(ctx context.Context, workspaceID string, appID string, input workspacebiz.AppReferenceListInput) (workspacebiz.AppReferenceListResult, error) {
	if s.listReferencesFn == nil {
		return workspacebiz.AppReferenceListResult{}, nil
	}
	return s.listReferencesFn(ctx, workspaceID, appID, input)
}

func (stubWorkspaceAppCenterService) List(context.Context, string) ([]workspacebiz.WorkspaceApp, error) {
	return nil, nil
}

func (stubWorkspaceAppCenterService) CatalogLoadState() workspacebiz.AppCatalogLoadState {
	return workspacebiz.AppCatalogLoadState{}
}

func (stubWorkspaceAppCenterService) RefreshCatalog(context.Context, string) ([]workspacebiz.WorkspaceApp, error) {
	return nil, nil
}

func (stubWorkspaceAppCenterService) Remove(context.Context, string, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (stubWorkspaceAppCenterService) ReplaceIcon(context.Context, string, string, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (stubWorkspaceAppCenterService) Retry(context.Context, string, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (stubWorkspaceAppCenterService) Rollback(context.Context, string, string, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}

func (stubWorkspaceAppCenterService) StartEnabled(context.Context, string) ([]workspacebiz.WorkspaceApp, error) {
	return nil, nil
}

func (stubWorkspaceAppCenterService) StopAll(context.Context, string) ([]workspacebiz.WorkspaceApp, error) {
	return nil, nil
}

func (stubWorkspaceAppCenterService) Uninstall(context.Context, string, string) (workspacebiz.WorkspaceApp, error) {
	return workspacebiz.WorkspaceApp{}, nil
}
