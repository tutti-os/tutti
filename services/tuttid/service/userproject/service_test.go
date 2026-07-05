package userproject

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
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

func TestServiceListPrunesUnavailableProjects(t *testing.T) {
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

	if len(projects) != 1 || projects[0].ID != "valid" {
		t.Fatalf("List() projects = %#v, want only valid project", projects)
	}
	if strings.Join(store.deletedIDs, ",") != "missing,file" {
		t.Fatalf("deleted IDs = %#v, want missing,file", store.deletedIDs)
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

func (s *recordingUserProjectStore) PutUserProject(_ context.Context, project userprojectbiz.Project) (userprojectbiz.Project, error) {
	s.put.Project = project
	return project, nil
}

func (*recordingUserProjectStore) TouchUserProject(context.Context, string, int64) error {
	return nil
}
