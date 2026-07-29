package userproject

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	workspacedata "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

func TestServiceUseNormalizesDirectoryAndPersistsRecentProject(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	projectDir := filepath.Join(root, "tutti")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	expectedPath, err := filepath.EvalSymlinks(projectDir)
	if err != nil {
		t.Fatalf("EvalSymlinks() error = %v", err)
	}
	store := &recordingUserProjectStore{}
	service := Service{Store: store}

	project, err := service.Use(ctx, UseInput{Path: filepath.Join(projectDir, ".")})
	if err != nil {
		t.Fatalf("Use() error = %v", err)
	}

	if project.Path != expectedPath {
		t.Fatalf("Use() path = %q, want %q", project.Path, expectedPath)
	}
	if project.Label != "tutti" {
		t.Fatalf("Use() label = %q, want tutti", project.Label)
	}
	if !strings.HasPrefix(project.ID, "user_project_") {
		t.Fatalf("Use() id = %q, want user_project_ prefix", project.ID)
	}
	if store.put.Project.Path != expectedPath {
		t.Fatalf("PutUserProject() path = %q, want %q", store.put.Project.Path, expectedPath)
	}
}

func TestServiceUseDoesNotRollBackWhenPublishFails(t *testing.T) {
	projectDir := filepath.Join(t.TempDir(), "tutti")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	store := &recordingUserProjectStore{
		projects: []userprojectbiz.Project{{ID: "stored"}},
	}
	publisher := &recordingUserProjectPublisher{err: errors.New("event unavailable")}
	service := Service{Store: store, Publisher: publisher}

	project, err := service.Use(context.Background(), UseInput{Path: projectDir})
	if err != nil {
		t.Fatalf("Use() error = %v", err)
	}
	if store.put.Project.ID != project.ID || len(publisher.snapshots) != 1 {
		t.Fatalf("project = %#v put = %#v snapshots = %#v", project, store.put.Project, publisher.snapshots)
	}
}

func TestServiceUseRejectsInvalidPath(t *testing.T) {
	service := Service{Store: &recordingUserProjectStore{}}

	_, err := service.Use(context.Background(), UseInput{Path: "   "})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("Use() error = %v, want ErrInvalidArgument", err)
	}
}

func TestServiceUseRejectsMissingOrFilePath(t *testing.T) {
	ctx := context.Background()
	service := Service{Store: &recordingUserProjectStore{}}

	_, missingErr := service.Use(ctx, UseInput{Path: filepath.Join(t.TempDir(), "missing")})
	if !errors.Is(missingErr, ErrNotDirectory) {
		t.Fatalf("Use() missing path error = %v, want ErrNotDirectory", missingErr)
	}

	filePath := filepath.Join(t.TempDir(), "file.txt")
	if err := os.WriteFile(filePath, []byte("content"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	_, fileErr := service.Use(ctx, UseInput{Path: filePath})
	if !errors.Is(fileErr, ErrNotDirectory) {
		t.Fatalf("Use() file path error = %v, want ErrNotDirectory", fileErr)
	}
}

func TestServiceUseManyPreservesInputOrderForFrontInsertion(t *testing.T) {
	root := t.TempDir()
	first := filepath.Join(root, "first")
	second := filepath.Join(root, "second")
	if err := os.MkdirAll(first, 0o755); err != nil {
		t.Fatalf("MkdirAll(first) error = %v", err)
	}
	if err := os.MkdirAll(second, 0o755); err != nil {
		t.Fatalf("MkdirAll(second) error = %v", err)
	}
	store := &recordingUserProjectStore{}
	service := Service{Store: store}

	errorsByIndex := service.UseMany(context.Background(), UseManyInput{Paths: []string{first, second}})
	if len(errorsByIndex) != 2 || errorsByIndex[0] != nil || errorsByIndex[1] != nil {
		t.Fatalf("UseMany() errors = %#v, want two nil entries", errorsByIndex)
	}
	if len(store.putProjects) != 2 || store.putProjects[0].Label != "second" || store.putProjects[1].Label != "first" {
		t.Fatalf("put projects = %#v, want reverse writes for stable front insertion", store.putProjects)
	}
	if store.putProjects[1].LastUsedAtUnixMS <= store.putProjects[0].LastUsedAtUnixMS {
		t.Fatalf("last used times = [%d, %d], want original first input newer", store.putProjects[0].LastUsedAtUnixMS, store.putProjects[1].LastUsedAtUnixMS)
	}
}

func TestServiceDeleteNormalizesPathAndRemovesRecentProject(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	projectDir := filepath.Join(root, "tutti")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	expectedPath, err := filepath.EvalSymlinks(projectDir)
	if err != nil {
		t.Fatalf("EvalSymlinks() error = %v", err)
	}
	store := &recordingUserProjectStore{}
	service := Service{Store: store}

	if err := service.Delete(ctx, DeleteInput{Path: filepath.Join(projectDir, ".")}); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}

	if strings.Join(store.deletedPaths, ",") != expectedPath {
		t.Fatalf("deleted paths = %#v, want %q", store.deletedPaths, expectedPath)
	}
}

func TestServiceDeleteDoesNotRollBackWhenPublishFails(t *testing.T) {
	projectDir := filepath.Join(t.TempDir(), "tutti")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	store := &recordingUserProjectStore{
		projects: []userprojectbiz.Project{{ID: "remaining"}},
	}
	publisher := &recordingUserProjectPublisher{err: errors.New("event unavailable")}
	service := Service{Store: store, Publisher: publisher}

	if err := service.Delete(context.Background(), DeleteInput{Path: projectDir}); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	if len(store.deletedPaths) != 1 || len(publisher.snapshots) != 1 {
		t.Fatalf("deleted paths = %#v snapshots = %#v", store.deletedPaths, publisher.snapshots)
	}
}

// TestServiceDeleteDoesNotDependOnRecomputedID guards against a regression
// where Delete looked a project up by re-deriving projectID(path) instead of
// using the table's actual UNIQUE path key. If a stored row's id ever ends up
// out of sync with a freshly recomputed hash of its path (for example because
// id derivation changed, or drifted for any other reason), deleting by that
// recomputed id silently affects zero rows and the "removed" project never
// goes away. Deleting by path sidesteps that entire class of mismatch.
func TestServiceDeleteDoesNotDependOnRecomputedID(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	projectDir := filepath.Join(root, "tutti")
	if err := os.MkdirAll(projectDir, 0o755); err != nil {
		t.Fatalf("MkdirAll() error = %v", err)
	}
	expectedPath, err := filepath.EvalSymlinks(projectDir)
	if err != nil {
		t.Fatalf("EvalSymlinks() error = %v", err)
	}
	store := &recordingUserProjectStore{
		projects: []userprojectbiz.Project{
			{ID: "user_project_stale-mismatched-id", Path: expectedPath, Label: "tutti"},
		},
	}
	service := Service{Store: store}

	if err := service.Delete(ctx, DeleteInput{Path: projectDir}); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}

	if len(store.deletedIDs) != 0 {
		t.Fatalf("deleted IDs = %#v, want none (delete must key off path)", store.deletedIDs)
	}
	if strings.Join(store.deletedPaths, ",") != expectedPath {
		t.Fatalf("deleted paths = %#v, want %q", store.deletedPaths, expectedPath)
	}
}

func TestServiceDeleteRejectsInvalidPath(t *testing.T) {
	service := Service{Store: &recordingUserProjectStore{}}

	err := service.Delete(context.Background(), DeleteInput{Path: "   "})
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("Delete() error = %v, want ErrInvalidArgument", err)
	}
}

func TestServiceMovePublishesOrderedSnapshotAndIgnoresPublishFailure(t *testing.T) {
	before := "alpha"
	projects := []userprojectbiz.Project{{ID: "beta"}, {ID: "alpha"}}
	store := &recordingUserProjectStore{projects: projects}
	publisher := &recordingUserProjectPublisher{err: errors.New("event unavailable")}
	service := Service{Store: store, Publisher: publisher}

	moved, err := service.Move(context.Background(), MoveInput{
		ProjectID:       "beta",
		BeforeProjectID: &before,
	})
	if err != nil {
		t.Fatalf("Move() error = %v", err)
	}
	if len(moved) != 2 || len(publisher.snapshots) != 1 || publisher.snapshots[0][0].ID != "beta" {
		t.Fatalf("moved = %#v snapshots = %#v", moved, publisher.snapshots)
	}
}

func TestServiceMoveRejectsUnknownProject(t *testing.T) {
	store := &recordingUserProjectStore{moveErr: workspacedata.ErrUserProjectNotFound}
	service := Service{Store: store}
	if _, err := service.Move(context.Background(), MoveInput{ProjectID: "unknown"}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("Move() error = %v, want ErrInvalidArgument", err)
	}
}

func TestServicePinPublishesOnlyChangedOrderedSnapshot(t *testing.T) {
	projects := []userprojectbiz.Project{{ID: "pinned", PinnedAtUnixMS: 10}, {ID: "normal"}}
	store := &recordingUserProjectStore{projects: projects, pinChanged: true}
	publisher := &recordingUserProjectPublisher{err: errors.New("event unavailable")}
	service := Service{Store: store, Publisher: publisher}

	pinned, err := service.Pin(context.Background(), PinInput{ProjectID: "pinned", Pinned: true})
	if err != nil {
		t.Fatalf("Pin() error = %v", err)
	}
	if len(pinned) != 2 || store.pinInput.ProjectID != "pinned" || !store.pinInput.Pinned || len(publisher.snapshots) != 1 {
		t.Fatalf("pinned=%#v input=%#v snapshots=%#v", pinned, store.pinInput, publisher.snapshots)
	}

	store.pinChanged = false
	if _, err := service.Pin(context.Background(), PinInput{ProjectID: "pinned", Pinned: true}); err != nil {
		t.Fatalf("Pin(idempotent) error = %v", err)
	}
	if len(publisher.snapshots) != 1 {
		t.Fatalf("idempotent Pin published %d snapshots, want 1 total", len(publisher.snapshots))
	}
}

func TestServicePinRejectsUnknownProject(t *testing.T) {
	store := &recordingUserProjectStore{pinErr: workspacedata.ErrUserProjectNotFound}
	service := Service{Store: store}
	if _, err := service.Pin(context.Background(), PinInput{ProjectID: "unknown", Pinned: true}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("Pin() error = %v, want ErrInvalidArgument", err)
	}
}

func TestServiceMoveRejectsCrossPartition(t *testing.T) {
	store := &recordingUserProjectStore{moveErr: workspacedata.ErrUserProjectPartitionMismatch}
	service := Service{Store: store}
	before := "pinned"
	if _, err := service.Move(context.Background(), MoveInput{ProjectID: "normal", BeforeProjectID: &before}); !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("Move() error = %v, want ErrInvalidArgument", err)
	}
}

func TestServiceListReturnsRegisteredProjectsWithoutFilesystemPruning(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	validDir := filepath.Join(root, "valid")
	if err := os.MkdirAll(validDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(valid) error = %v", err)
	}
	filePath := filepath.Join(root, "file.txt")
	if err := os.WriteFile(filePath, []byte("content"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	missingPath := filepath.Join(root, "missing")
	store := &recordingUserProjectStore{
		projects: []userprojectbiz.Project{
			{ID: "valid", Path: validDir, Label: "valid"},
			{ID: "missing", Path: missingPath, Label: "missing"},
			{ID: "file", Path: filePath, Label: "file"},
		},
	}
	service := Service{Store: store}

	projects, err := service.List(ctx)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}

	if len(projects) != 3 || projects[0].ID != "valid" || projects[1].ID != "missing" || projects[2].ID != "file" {
		t.Fatalf("List() projects = %#v, want every registered project", projects)
	}
	if len(store.deletedIDs) != 0 {
		t.Fatalf("deleted IDs = %#v, want none", store.deletedIDs)
	}
}

func TestServiceCheckPathReportsDirectoryStatusWithoutStore(t *testing.T) {
	ctx := context.Background()
	root := t.TempDir()
	validDir := filepath.Join(root, "valid")
	if err := os.MkdirAll(validDir, 0o755); err != nil {
		t.Fatalf("MkdirAll(valid) error = %v", err)
	}
	filePath := filepath.Join(root, "file.txt")
	if err := os.WriteFile(filePath, []byte("content"), 0o644); err != nil {
		t.Fatalf("WriteFile() error = %v", err)
	}
	missingPath := filepath.Join(root, "missing")
	service := Service{}

	directory, err := service.CheckPath(ctx, CheckPathInput{Path: validDir})
	if err != nil {
		t.Fatalf("CheckPath(validDir) error = %v", err)
	}
	if !directory.Exists || !directory.IsDirectory || directory.Path != validDir {
		t.Fatalf("CheckPath(validDir) = %#v, want existing directory", directory)
	}

	file, err := service.CheckPath(ctx, CheckPathInput{Path: filePath})
	if err != nil {
		t.Fatalf("CheckPath(filePath) error = %v", err)
	}
	if !file.Exists || file.IsDirectory {
		t.Fatalf("CheckPath(filePath) = %#v, want existing non-directory", file)
	}

	missing, err := service.CheckPath(ctx, CheckPathInput{Path: missingPath})
	if err != nil {
		t.Fatalf("CheckPath(missingPath) error = %v", err)
	}
	if missing.Exists || missing.IsDirectory || missing.Path != missingPath {
		t.Fatalf("CheckPath(missingPath) = %#v, want missing path", missing)
	}
}

type recordingUserProjectStore struct {
	projects     []userprojectbiz.Project
	deletedIDs   []string
	deletedPaths []string
	put          struct {
		Project userprojectbiz.Project
	}
	moveErr     error
	pinErr      error
	pinChanged  bool
	pinInput    PinInput
	putProjects []userprojectbiz.Project
}

func (s *recordingUserProjectStore) DeleteUserProject(_ context.Context, id string) error {
	s.deletedIDs = append(s.deletedIDs, id)
	return nil
}

func (s *recordingUserProjectStore) DeleteUserProjectByPath(_ context.Context, path string) error {
	s.deletedPaths = append(s.deletedPaths, path)
	return nil
}

func (s *recordingUserProjectStore) ListUserProjects(context.Context) ([]userprojectbiz.Project, error) {
	return s.projects, nil
}

func (s *recordingUserProjectStore) MoveUserProject(_ context.Context, _ string, _ *string) ([]userprojectbiz.Project, error) {
	return s.projects, s.moveErr
}

func (s *recordingUserProjectStore) PinUserProject(_ context.Context, projectID string, pinned bool) ([]userprojectbiz.Project, bool, error) {
	s.pinInput = PinInput{ProjectID: projectID, Pinned: pinned}
	return s.projects, s.pinChanged, s.pinErr
}

type recordingUserProjectPublisher struct {
	err       error
	snapshots [][]userprojectbiz.Project
}

func (p *recordingUserProjectPublisher) PublishUserProjectUpdated(_ context.Context, projects []userprojectbiz.Project) error {
	p.snapshots = append(p.snapshots, append([]userprojectbiz.Project(nil), projects...))
	return p.err
}

func (s *recordingUserProjectStore) PutUserProject(_ context.Context, project userprojectbiz.Project) (userprojectbiz.Project, error) {
	s.put.Project = project
	s.putProjects = append(s.putProjects, project)
	return project, nil
}

func (*recordingUserProjectStore) TouchUserProject(context.Context, string, int64) error {
	return nil
}
