package workspace

import (
	"context"
	"testing"
	"time"

	preferencesbiz "github.com/tutti-os/tutti/services/tuttid/biz/preferences"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

type catalogStoreStub struct {
	getWorkspace      workspacebiz.Summary
	startupWorkspace  *workspacebiz.Summary
	startupErr        error
	listWorkspaces    []workspacebiz.Summary
	openedWorkspace   workspacebiz.Summary
	updatedWorkspace  workspacebiz.Summary
	createdWorkspace  workspacebiz.Summary
	openedWorkspaceID string
	listCalls         int
	openCalls         int
	createCalls       int
}

func (s *catalogStoreStub) Create(_ context.Context, item workspacebiz.Summary) error {
	s.createCalls += 1
	s.createdWorkspace = item
	return nil
}

func (*catalogStoreStub) Delete(context.Context, string) error {
	return nil
}

func (s *catalogStoreStub) Get(context.Context, string) (workspacebiz.Summary, error) {
	return s.getWorkspace, nil
}

func (s *catalogStoreStub) GetStartup(context.Context) (*workspacebiz.Summary, error) {
	return s.startupWorkspace, s.startupErr
}

func (s *catalogStoreStub) List(context.Context) ([]workspacebiz.Summary, error) {
	s.listCalls += 1
	return s.listWorkspaces, nil
}

func (s *catalogStoreStub) Open(_ context.Context, workspaceID string) (workspacebiz.Summary, error) {
	s.openCalls += 1
	s.openedWorkspaceID = workspaceID
	if s.openedWorkspace.ID != "" {
		return s.openedWorkspace, nil
	}
	return workspacebiz.Summary{ID: workspaceID}, nil
}

func (s *catalogStoreStub) Update(_ context.Context, item workspacebiz.Summary) error {
	s.updatedWorkspace = item
	return nil
}

type preferencesStoreStub struct {
	getResult preferencesbiz.DesktopPreferences
}

func (s preferencesStoreStub) GetDesktopPreferences(context.Context) (preferencesbiz.DesktopPreferences, error) {
	return s.getResult, nil
}

func (preferencesStoreStub) PutDesktopPreferences(context.Context, preferencesbiz.DesktopPreferences) (preferencesbiz.DesktopPreferences, error) {
	return preferencesbiz.DesktopPreferences{}, nil
}

func TestCatalogServiceStartupReturnsExistingStartupWorkspace(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	store := &catalogStoreStub{
		startupWorkspace: &workspacebiz.Summary{
			ID:           "ws-start",
			Name:         "Workspace Start",
			LastOpenedAt: &now,
		},
	}
	service := CatalogService{Store: store}

	workspace, err := service.Startup(context.Background())
	if err != nil {
		t.Fatalf("Startup() error = %v", err)
	}
	if workspace == nil {
		t.Fatal("Startup() workspace = nil")
		return
	}
	if workspace.ID != "ws-start" {
		t.Fatalf("Startup() id = %q", workspace.ID)
	}
	if workspace.LastOpenedAt == nil {
		t.Fatal("Startup() lastOpenedAt = nil")
	}
	if store.listCalls != 0 {
		t.Fatalf("listCalls = %d, want 0", store.listCalls)
	}
	if store.openCalls != 0 {
		t.Fatalf("openCalls = %d, want 0", store.openCalls)
	}
}

func TestCatalogServiceStartupOpensExistingWorkspaceWhenNoStartupWorkspaceIsSet(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	store := &catalogStoreStub{
		listWorkspaces: []workspacebiz.Summary{
			{ID: "ws-existing", Name: "Workspace Existing"},
		},
		openedWorkspace: workspacebiz.Summary{
			ID:           "ws-existing",
			Name:         "Workspace Existing",
			LastOpenedAt: &now,
		},
	}
	service := CatalogService{Store: store}

	workspace, err := service.Startup(context.Background())
	if err != nil {
		t.Fatalf("Startup() error = %v", err)
	}
	if workspace == nil {
		t.Fatal("Startup() workspace = nil")
		return
	}
	if workspace.ID != "ws-existing" {
		t.Fatalf("Startup() id = %q, want ws-existing", workspace.ID)
	}
	if store.listCalls != 1 {
		t.Fatalf("listCalls = %d, want 1", store.listCalls)
	}
	if store.openCalls != 1 {
		t.Fatalf("openCalls = %d, want 1", store.openCalls)
	}
	if store.openedWorkspaceID != "ws-existing" {
		t.Fatalf("openedWorkspaceID = %q, want ws-existing", store.openedWorkspaceID)
	}
	if store.createCalls != 0 {
		t.Fatalf("createCalls = %d, want 0", store.createCalls)
	}
}

func TestCatalogServiceStartupCreatesLocalizedDefaultWorkspaceWhenCatalogIsEmpty(t *testing.T) {
	t.Parallel()

	now := time.Now().UTC()
	store := &catalogStoreStub{
		openedWorkspace: workspacebiz.Summary{
			ID:           "ws-default",
			Name:         "默认空间",
			LastOpenedAt: &now,
		},
	}
	service := CatalogService{
		Store: store,
		PreferencesStore: preferencesStoreStub{
			getResult: preferencesbiz.DesktopPreferences{
				DockPlacement: "bottom",
				Initialized:   true,
				Locale:        "zh-CN",
				ThemeSource:   "system",
			},
		},
	}

	workspace, err := service.Startup(context.Background())
	if err != nil {
		t.Fatalf("Startup() error = %v", err)
	}
	if workspace == nil {
		t.Fatal("Startup() workspace = nil")
	}
	if store.createCalls != 1 {
		t.Fatalf("createCalls = %d, want 1", store.createCalls)
	}
	if store.createdWorkspace.ID == "" {
		t.Fatal("created workspace id is empty")
	}
	if store.createdWorkspace.Name != "默认空间" {
		t.Fatalf("created workspace name = %q, want 默认空间", store.createdWorkspace.Name)
	}
	if store.openCalls != 1 {
		t.Fatalf("openCalls = %d, want 1", store.openCalls)
	}
	if store.openedWorkspaceID != store.createdWorkspace.ID {
		t.Fatalf("openedWorkspaceID = %q, want %q", store.openedWorkspaceID, store.createdWorkspace.ID)
	}
}

func TestCatalogServiceUpdateReturnsStoredWorkspaceSummary(t *testing.T) {
	t.Parallel()

	lastOpenedAt := time.Now().UTC()
	store := &catalogStoreStub{
		getWorkspace: workspacebiz.Summary{
			ID:           "ws-1",
			Name:         "Renamed Workspace",
			LastOpenedAt: &lastOpenedAt,
		},
	}
	service := CatalogService{Store: store}

	workspace, err := service.Update(context.Background(), " ws-1 ", UpdateInput{
		Name: " Renamed Workspace ",
	})
	if err != nil {
		t.Fatalf("Update() error = %v", err)
	}

	if store.updatedWorkspace.ID != "ws-1" {
		t.Fatalf("updated workspace id = %q, want ws-1", store.updatedWorkspace.ID)
	}
	if store.updatedWorkspace.Name != "Renamed Workspace" {
		t.Fatalf("updated workspace name = %q, want Renamed Workspace", store.updatedWorkspace.Name)
	}
	if workspace.LastOpenedAt == nil || !workspace.LastOpenedAt.Equal(lastOpenedAt) {
		t.Fatalf("workspace lastOpenedAt = %#v, want %s", workspace.LastOpenedAt, lastOpenedAt.Format(time.RFC3339))
	}
}

func TestCatalogServiceCreateGeneratesWorkspaceWithoutLocalPath(t *testing.T) {
	t.Parallel()

	store := &catalogStoreStub{}
	service := CatalogService{Store: store}

	workspace, err := service.Create(context.Background(), CreateInput{
		Name: " Workspace One ",
	})
	if err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if workspace.ID == "" {
		t.Fatal("Create() id is empty")
	}
	if workspace.Name != "Workspace One" {
		t.Fatalf("Create() name = %q, want Workspace One", workspace.Name)
	}
	if store.createdWorkspace.ID != workspace.ID {
		t.Fatalf("stored workspace id = %q, want %q", store.createdWorkspace.ID, workspace.ID)
	}
	if store.createdWorkspace.Name != "Workspace One" {
		t.Fatalf("stored workspace name = %q, want Workspace One", store.createdWorkspace.Name)
	}
}
