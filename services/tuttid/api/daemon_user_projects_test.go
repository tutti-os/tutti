package api

import (
	"context"
	"net/http"
	"testing"

	tuttigenerated "github.com/tutti-os/tutti/services/tuttid/api/generated"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	userprojectservice "github.com/tutti-os/tutti/services/tuttid/service/userproject"
)

type stubUserProjectService struct {
	checkPathFn func(context.Context, userprojectservice.CheckPathInput) (userprojectservice.PathCheck, error)
	deleteFn    func(context.Context, userprojectservice.DeleteInput) error
	useFn       func(context.Context, userprojectservice.UseInput) (userprojectbiz.Project, error)
	listFn      func(context.Context) ([]userprojectbiz.Project, error)
	moveFn      func(context.Context, userprojectservice.MoveInput) ([]userprojectbiz.Project, error)
	pinFn       func(context.Context, userprojectservice.PinInput) ([]userprojectbiz.Project, error)
	useManyFn   func(context.Context, userprojectservice.UseManyInput) []error
}

func (s stubUserProjectService) CheckPath(ctx context.Context, input userprojectservice.CheckPathInput) (userprojectservice.PathCheck, error) {
	if s.checkPathFn == nil {
		return userprojectservice.PathCheck{}, nil
	}
	return s.checkPathFn(ctx, input)
}

func (s stubUserProjectService) Delete(ctx context.Context, input userprojectservice.DeleteInput) error {
	if s.deleteFn == nil {
		return nil
	}
	return s.deleteFn(ctx, input)
}

func (s stubUserProjectService) Use(ctx context.Context, input userprojectservice.UseInput) (userprojectbiz.Project, error) {
	if s.useFn == nil {
		return userprojectbiz.Project{}, nil
	}
	return s.useFn(ctx, input)
}

func (s stubUserProjectService) UseMany(ctx context.Context, input userprojectservice.UseManyInput) []error {
	if s.useManyFn == nil {
		return make([]error, len(input.Paths))
	}
	return s.useManyFn(ctx, input)
}

func (s stubUserProjectService) List(ctx context.Context) ([]userprojectbiz.Project, error) {
	if s.listFn == nil {
		return nil, nil
	}
	return s.listFn(ctx)
}

func (s stubUserProjectService) Move(ctx context.Context, input userprojectservice.MoveInput) ([]userprojectbiz.Project, error) {
	if s.moveFn == nil {
		return nil, nil
	}
	return s.moveFn(ctx, input)
}

func (s stubUserProjectService) Pin(ctx context.Context, input userprojectservice.PinInput) ([]userprojectbiz.Project, error) {
	if s.pinFn == nil {
		return nil, nil
	}
	return s.pinFn(ctx, input)
}

func TestDaemonAPIRoutesCheckUserProjectPath(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		UserProjectService: stubUserProjectService{
			checkPathFn: func(_ context.Context, input userprojectservice.CheckPathInput) (userprojectservice.PathCheck, error) {
				if input.Path != "/workspace/tutti" {
					t.Fatalf("path = %q, want /workspace/tutti", input.Path)
				}
				return userprojectservice.PathCheck{
					Path:        input.Path,
					Exists:      true,
					IsDirectory: true,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/user-projects/check", map[string]any{
		"path": "/workspace/tutti",
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.UserProjectPathCheckResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if !response.Exists || !response.IsDirectory || response.Path != "/workspace/tutti" {
		t.Fatalf("response = %#v, want existing directory", response)
	}
}

func TestDaemonAPIRoutesUserProjects(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		UserProjectService: stubUserProjectService{
			listFn: func(context.Context) ([]userprojectbiz.Project, error) {
				return []userprojectbiz.Project{{
					ID:              "user_project_1",
					Path:            "/workspace/tutti",
					Label:           "tutti",
					CreatedAtUnixMS: 1,
					UpdatedAtUnixMS: 2,
					PinnedAtUnixMS:  3,
				}}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodGet, "/v1/user-projects", nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusOK, recorder.Body.String())
	}

	var response tuttigenerated.UserProjectListResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if len(response.Projects) != 1 {
		t.Fatalf("projects length = %d, want 1", len(response.Projects))
	}
	if response.Projects[0].Path != "/workspace/tutti" {
		t.Fatalf("path = %q, want /workspace/tutti", response.Projects[0].Path)
	}
	if response.Projects[0].PinnedAtUnixMs != 3 {
		t.Fatalf("pinnedAtUnixMs = %d, want 3", response.Projects[0].PinnedAtUnixMs)
	}
}

func TestDaemonAPIRoutesDeleteUserProject(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		UserProjectService: stubUserProjectService{
			deleteFn: func(_ context.Context, input userprojectservice.DeleteInput) error {
				if input.Path != "/workspace/tutti" {
					t.Fatalf("path = %q, want /workspace/tutti", input.Path)
				}
				return nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodDelete, "/v1/user-projects", map[string]any{
		"path": "/workspace/tutti",
	})
	if recorder.Code != http.StatusNoContent {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusNoContent, recorder.Body.String())
	}
}

func TestDaemonAPIRoutesUseUserProject(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		UserProjectService: stubUserProjectService{
			useFn: func(_ context.Context, input userprojectservice.UseInput) (userprojectbiz.Project, error) {
				if input.Path != "/workspace/tutti" {
					t.Fatalf("path = %q, want /workspace/tutti", input.Path)
				}
				return userprojectbiz.Project{
					ID:               "user_project_1",
					Path:             input.Path,
					Label:            "tutti",
					CreatedAtUnixMS:  1,
					UpdatedAtUnixMS:  2,
					LastUsedAtUnixMS: 3,
				}, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/user-projects", map[string]any{
		"path": "/workspace/tutti",
	})
	if recorder.Code != http.StatusCreated {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusCreated, recorder.Body.String())
	}

	var response tuttigenerated.UserProjectResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if response.Project.Path != "/workspace/tutti" {
		t.Fatalf("path = %q, want /workspace/tutti", response.Project.Path)
	}
}

func TestDaemonAPIRoutesMoveUserProject(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		UserProjectService: stubUserProjectService{
			moveFn: func(_ context.Context, input userprojectservice.MoveInput) ([]userprojectbiz.Project, error) {
				if input.ProjectID != "beta" || input.BeforeProjectID == nil || *input.BeforeProjectID != "alpha" {
					t.Fatalf("move input = %#v", input)
				}
				return []userprojectbiz.Project{
					{ID: "beta", Path: "/workspace/beta", Label: "beta"},
					{ID: "alpha", Path: "/workspace/alpha", Label: "alpha"},
				}, nil
			},
		},
	}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/user-projects/move", map[string]any{
		"projectId": "beta", "beforeProjectId": "alpha",
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", recorder.Code, recorder.Body.String())
	}
	var response tuttigenerated.UserProjectListResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if len(response.Projects) != 2 || response.Projects[0].Id != "beta" {
		t.Fatalf("response projects = %#v", response.Projects)
	}
}

func TestDaemonAPIRoutesMoveUserProjectRejectsOmittedBeforeProjectID(t *testing.T) {
	called := false
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		UserProjectService: stubUserProjectService{
			moveFn: func(context.Context, userprojectservice.MoveInput) ([]userprojectbiz.Project, error) {
				called = true
				return nil, nil
			},
		},
	}))

	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/user-projects/move", map[string]any{
		"projectId": "project-alpha",
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d; body: %s", recorder.Code, http.StatusBadRequest, recorder.Body.String())
	}
	if called {
		t.Fatal("Move called for request missing beforeProjectId")
	}
}

func TestDaemonAPIRoutesMoveUserProjectRejectsUnknownID(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		UserProjectService: stubUserProjectService{
			moveFn: func(context.Context, userprojectservice.MoveInput) ([]userprojectbiz.Project, error) {
				return nil, userprojectservice.ErrInvalidArgument
			},
		},
	}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/user-projects/move", map[string]any{
		"projectId": "unknown", "beforeProjectId": nil,
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", recorder.Code, recorder.Body.String())
	}
}

func TestDaemonAPIRoutesPinUserProject(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		UserProjectService: stubUserProjectService{
			pinFn: func(_ context.Context, input userprojectservice.PinInput) ([]userprojectbiz.Project, error) {
				if input.ProjectID != "project-alpha" || !input.Pinned {
					t.Fatalf("pin input = %#v", input)
				}
				return []userprojectbiz.Project{{
					ID: "project-alpha", Path: "/workspace/alpha", Label: "alpha", PinnedAtUnixMS: 10,
				}}, nil
			},
		},
	}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/user-projects/pin", map[string]any{
		"projectId": "project-alpha", "pinned": true,
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body: %s", recorder.Code, recorder.Body.String())
	}
	var response tuttigenerated.UserProjectListResponse
	decodeGeneratedRouteResponse(t, recorder, &response)
	if len(response.Projects) != 1 || response.Projects[0].Id != "project-alpha" || response.Projects[0].PinnedAtUnixMs != 10 {
		t.Fatalf("response projects = %#v", response.Projects)
	}
}

func TestDaemonAPIRoutesPinUserProjectRejectsUnknownID(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, NewRoutes(DaemonAPI{
		UserProjectService: stubUserProjectService{
			pinFn: func(context.Context, userprojectservice.PinInput) ([]userprojectbiz.Project, error) {
				return nil, userprojectservice.ErrInvalidArgument
			},
		},
	}))
	recorder := performGeneratedRouteRequest(t, mux, http.MethodPost, "/v1/user-projects/pin", map[string]any{
		"projectId": "unknown", "pinned": true,
	})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400; body: %s", recorder.Code, recorder.Body.String())
	}
}
