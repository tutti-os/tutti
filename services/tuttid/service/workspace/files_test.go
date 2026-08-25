package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
	localworkspace "github.com/tutti-os/tutti/services/tuttid/data/workspace"
)

func TestFileServiceResolveWorkspaceRootDefaultsToUserHome(t *testing.T) {
	homeDir := t.TempDir()
	setTestHome(t, homeDir)

	service := FileService{}

	root, err := service.ResolveWorkspaceRoot(context.Background(), " ws-1 ")
	if err != nil {
		t.Fatalf("ResolveWorkspaceRoot() error = %v", err)
	}

	if root.WorkspaceID != "ws-1" {
		t.Fatalf("workspace id = %q, want ws-1", root.WorkspaceID)
	}
	if root.PhysicalRoot != filepath.Clean(homeDir) {
		t.Fatalf("physical root = %q, want %q", root.PhysicalRoot, filepath.Clean(homeDir))
	}
	if root.LogicalRoot != filepath.Clean(homeDir) {
		t.Fatalf("logical root = %q, want %q", root.LogicalRoot, filepath.Clean(homeDir))
	}
}

func TestFileServiceListDirectoryAcceptsHomeAbsolutePaths(t *testing.T) {
	homeDir := t.TempDir()
	setTestHome(t, homeDir)
	adapter := &fileSearchDeadlineAdapter{}
	service := FileService{Adapter: adapter}
	targetPath := filepath.Join(homeDir, ".tutti-dev", "agent", "runs")

	_, err := service.ListDirectory(context.Background(), "ws-1", workspacefiles.DirectoryListInput{
		IncludeHidden: true,
		Path:          targetPath,
	})
	if err != nil {
		t.Fatalf("ListDirectory() error = %v", err)
	}

	wantLogicalRoot := workspacefiles.NormalizeLogicalRoot(filepath.Clean(homeDir)).String()
	if adapter.listRoot.LogicalRoot != wantLogicalRoot {
		t.Fatalf("logical root = %q, want %q", adapter.listRoot.LogicalRoot, wantLogicalRoot)
	}
	wantListPath, err := workspacefiles.NormalizeLogicalPath(targetPath)
	if err != nil {
		t.Fatalf("NormalizeLogicalPath(%q) error = %v", targetPath, err)
	}
	if adapter.listPath != wantListPath {
		t.Fatalf("list path = %q, want %q", adapter.listPath, wantListPath)
	}
	if !adapter.listIncludeHidden {
		t.Fatal("include hidden = false, want true")
	}
}

func TestFileServiceListDirectoryUsesWindowsDriveAbsolutePathWithLocalAdapter(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows drive-qualified paths are only exercised on Windows")
	}

	homeDir := t.TempDir()
	setTestHome(t, homeDir)
	targetPath := filepath.Join(homeDir, "workspace", "src")
	if err := os.MkdirAll(targetPath, 0o755); err != nil {
		t.Fatalf("MkdirAll(%q) error = %v", targetPath, err)
	}

	service := FileService{Adapter: localworkspace.LocalFilesAdapter{}}
	listing, err := service.ListDirectory(context.Background(), "ws-1", workspacefiles.DirectoryListInput{
		Path: targetPath,
	})
	if err != nil {
		t.Fatalf("ListDirectory(%q) error = %v", targetPath, err)
	}
	wantPath := filepath.ToSlash(targetPath)
	if !strings.HasPrefix(wantPath, "/") {
		wantPath = "/" + wantPath
	}
	if listing.DirectoryPath.String() != wantPath {
		t.Fatalf("directory path = %q, want %q", listing.DirectoryPath, wantPath)
	}
}

func TestFileServiceListDirectoryAcceptsWindowsLogicalDrivePathOutsideHome(t *testing.T) {
	if runtime.GOOS != "windows" {
		t.Skip("Windows logical drive paths are only exercised on Windows")
	}

	homeDir := filepath.Join(t.TempDir(), "home")
	setTestHome(t, homeDir)
	targetPath := filepath.Join(t.TempDir(), "workspace", "src")
	if err := os.MkdirAll(targetPath, 0o755); err != nil {
		t.Fatalf("MkdirAll(%q) error = %v", targetPath, err)
	}
	logicalTargetPath := "/" + filepath.ToSlash(targetPath)

	service := FileService{Adapter: localworkspace.LocalFilesAdapter{}}
	listing, err := service.ListDirectory(context.Background(), "ws-1", workspacefiles.DirectoryListInput{
		Path: logicalTargetPath,
	})
	if err != nil {
		t.Fatalf("ListDirectory(%q) error = %v", logicalTargetPath, err)
	}
	if listing.DirectoryPath.String() != logicalTargetPath {
		t.Fatalf("directory path = %q, want %q", listing.DirectoryPath, logicalTargetPath)
	}
}

func TestFileServiceListDirectoryAcceptsExternalAbsolutePaths(t *testing.T) {
	homeDir := t.TempDir()
	setTestHome(t, homeDir)
	adapter := &fileSearchDeadlineAdapter{}
	service := FileService{Adapter: adapter}
	targetPath := filepath.Join(t.TempDir(), "codex-presentations")

	_, err := service.ListDirectory(context.Background(), "ws-1", workspacefiles.DirectoryListInput{
		IncludeHidden: true,
		Path:          targetPath,
	})
	if err != nil {
		t.Fatalf("ListDirectory() error = %v", err)
	}

	wantRoot := filesystemRootForPath(targetPath)
	wantLogicalRoot := workspacefiles.NormalizeLogicalRoot(wantRoot).String()
	if adapter.listRoot.LogicalRoot != wantLogicalRoot {
		t.Fatalf("logical root = %q, want %q", adapter.listRoot.LogicalRoot, wantLogicalRoot)
	}
	if adapter.listRoot.PhysicalRoot != wantRoot {
		t.Fatalf("physical root = %q, want %q", adapter.listRoot.PhysicalRoot, wantRoot)
	}
	wantListPath, err := workspacefiles.NormalizeLogicalPath(filepath.Clean(targetPath))
	if err != nil {
		t.Fatalf("NormalizeLogicalPath(%q) error = %v", targetPath, err)
	}
	if adapter.listPath != wantListPath {
		t.Fatalf("list path = %q, want %q", adapter.listPath, wantListPath)
	}
	if !adapter.listIncludeHidden {
		t.Fatal("include hidden = false, want true")
	}
}

func TestFileServiceResolveWorkspaceRootForPathRejectsUnsupportedSpecialPaths(t *testing.T) {
	homeDir := t.TempDir()
	setTestHome(t, homeDir)
	service := FileService{}

	for _, path := range []string{
		"/dev/null",
		"/dev/./null",
		"/dev//null",
		"NUL",
		"NUL.txt",
		"C:\\tmp\\NUL",
	} {
		_, err := service.ResolveWorkspaceRootForPath(context.Background(), "ws-1", path)
		if !errors.Is(err, workspacefiles.ErrInvalidPath) {
			t.Fatalf("ResolveWorkspaceRootForPath(%q) error = %v, want ErrInvalidPath", path, err)
		}
	}
}

func TestFileServiceRenameEntryAcceptsExternalAbsolutePaths(t *testing.T) {
	homeDir := t.TempDir()
	setTestHome(t, homeDir)
	adapter := &fileSearchDeadlineAdapter{}
	service := FileService{Adapter: adapter}
	targetPath := filepath.Join(t.TempDir(), "report.txt")

	_, err := service.RenameEntry(context.Background(), "ws-1", targetPath, "renamed.txt")
	if err != nil {
		t.Fatalf("RenameEntry() error = %v", err)
	}

	wantRoot := filesystemRootForPath(targetPath)
	if adapter.renameRoot.PhysicalRoot != wantRoot {
		t.Fatalf("rename physical root = %q, want %q", adapter.renameRoot.PhysicalRoot, wantRoot)
	}
	wantRenamePath := normalizeTestLogicalPath(targetPath)
	if adapter.renamePath.String() != wantRenamePath {
		t.Fatalf("rename path = %q, want %q", adapter.renamePath, wantRenamePath)
	}
	if adapter.renameName != "renamed.txt" {
		t.Fatalf("rename name = %q", adapter.renameName)
	}
}

func TestFileServiceMoveEntryUsesExternalRootWhenTargetIsExternal(t *testing.T) {
	homeDir := t.TempDir()
	setTestHome(t, homeDir)
	adapter := &fileSearchDeadlineAdapter{}
	service := FileService{Adapter: adapter}
	sourcePath := filepath.Join(homeDir, "project", "report.txt")
	targetDirectoryPath := filepath.Join(t.TempDir(), "output")

	_, err := service.MoveEntry(context.Background(), "ws-1", sourcePath, targetDirectoryPath)
	if err != nil {
		t.Fatalf("MoveEntry() error = %v", err)
	}

	wantRoot := filesystemRootForPath(targetDirectoryPath)
	if adapter.moveRoot.PhysicalRoot != wantRoot {
		t.Fatalf("move physical root = %q, want %q", adapter.moveRoot.PhysicalRoot, wantRoot)
	}
	wantMovePath := normalizeTestLogicalPath(sourcePath)
	if adapter.movePath.String() != wantMovePath {
		t.Fatalf("move path = %q, want %q", adapter.movePath, wantMovePath)
	}
	wantMoveTargetDirectory := normalizeTestLogicalPath(targetDirectoryPath)
	if adapter.moveTargetDirectory.String() != wantMoveTargetDirectory {
		t.Fatalf("move target = %q, want %q", adapter.moveTargetDirectory, wantMoveTargetDirectory)
	}
}

func TestFileServiceSearchSetsDefaultDeadline(t *testing.T) {
	homeDir := t.TempDir()
	setTestHome(t, homeDir)
	adapter := &fileSearchDeadlineAdapter{}
	service := FileService{Adapter: adapter}

	before := time.Now()
	_, err := service.Search(context.Background(), "ws-1", workspacefiles.SearchInput{
		Query: "readme",
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}

	if adapter.input.Deadline.IsZero() {
		t.Fatalf("deadline was not set")
	}
	if adapter.input.Deadline.Before(before) {
		t.Fatalf("deadline = %s, want after %s", adapter.input.Deadline, before)
	}
	maxDeadline := before.Add(defaultWorkspaceFileSearchBudget + 100*time.Millisecond)
	if adapter.input.Deadline.After(maxDeadline) {
		t.Fatalf("deadline = %s, want before %s", adapter.input.Deadline, maxDeadline)
	}
}

func TestFileServiceSearchPreservesExplicitDeadline(t *testing.T) {
	homeDir := t.TempDir()
	setTestHome(t, homeDir)
	adapter := &fileSearchDeadlineAdapter{}
	service := FileService{Adapter: adapter}
	deadline := time.Now().Add(42 * time.Second)

	_, err := service.Search(context.Background(), "ws-1", workspacefiles.SearchInput{
		Deadline: deadline,
		Query:    "readme",
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if !adapter.input.Deadline.Equal(deadline) {
		t.Fatalf("deadline = %s, want %s", adapter.input.Deadline, deadline)
	}
}

func setTestHome(t *testing.T, homeDir string) {
	t.Helper()
	t.Setenv("HOME", homeDir)
	t.Setenv("USERPROFILE", homeDir)
}

func normalizeTestLogicalPath(value string) string {
	normalized, err := workspacefiles.NormalizeLogicalPath(filepath.Clean(value))
	if err != nil {
		panic(err)
	}
	return normalized.String()
}

type fileSearchDeadlineAdapter struct {
	input               workspacefiles.SearchInput
	listIncludeHidden   bool
	listPath            workspacefiles.LogicalPath
	listRoot            workspacefiles.WorkspaceRoot
	moveRoot            workspacefiles.WorkspaceRoot
	movePath            workspacefiles.LogicalPath
	moveTargetDirectory workspacefiles.LogicalPath
	renameRoot          workspacefiles.WorkspaceRoot
	renamePath          workspacefiles.LogicalPath
	renameName          string
}

func (a *fileSearchDeadlineAdapter) Search(
	_ context.Context,
	root workspacefiles.WorkspaceRoot,
	input workspacefiles.SearchInput,
) (workspacefiles.SearchResult, error) {
	a.input = input
	return workspacefiles.SearchResult{
		WorkspaceID: root.WorkspaceID,
		Root:        workspacefiles.LogicalPath(root.LogicalRoot),
		Entries:     []workspacefiles.SearchEntry{},
	}, nil
}

func (a *fileSearchDeadlineAdapter) ListDirectory(
	_ context.Context,
	root workspacefiles.WorkspaceRoot,
	logicalPath workspacefiles.LogicalPath,
	includeHidden bool,
) (workspacefiles.DirectoryListing, error) {
	a.listRoot = root
	a.listPath = logicalPath
	a.listIncludeHidden = includeHidden
	return workspacefiles.DirectoryListing{
		WorkspaceID:   root.WorkspaceID,
		Root:          workspacefiles.LogicalPath(root.LogicalRoot),
		DirectoryPath: logicalPath,
		Entries:       []workspacefiles.FileEntry{},
	}, nil
}

func (*fileSearchDeadlineAdapter) CreateFile(
	context.Context,
	workspacefiles.WorkspaceRoot,
	workspacefiles.LogicalPath,
) (workspacefiles.FileEntry, error) {
	return workspacefiles.FileEntry{}, nil
}

func (*fileSearchDeadlineAdapter) CreateDirectory(
	context.Context,
	workspacefiles.WorkspaceRoot,
	workspacefiles.LogicalPath,
) (workspacefiles.FileEntry, error) {
	return workspacefiles.FileEntry{}, nil
}

func (*fileSearchDeadlineAdapter) DeleteEntry(
	context.Context,
	workspacefiles.WorkspaceRoot,
	workspacefiles.LogicalPath,
	workspacefiles.EntryKind,
) error {
	return nil
}

func (a *fileSearchDeadlineAdapter) MoveEntry(
	_ context.Context,
	workspaceRoot workspacefiles.WorkspaceRoot,
	logicalPath workspacefiles.LogicalPath,
	targetDirectoryPath workspacefiles.LogicalPath,
) (workspacefiles.FileEntry, error) {
	a.moveRoot = workspaceRoot
	a.movePath = logicalPath
	a.moveTargetDirectory = targetDirectoryPath
	return workspacefiles.FileEntry{Path: targetDirectoryPath, Kind: workspacefiles.EntryKindFile}, nil
}

func (a *fileSearchDeadlineAdapter) RenameEntry(
	_ context.Context,
	workspaceRoot workspacefiles.WorkspaceRoot,
	logicalPath workspacefiles.LogicalPath,
	newName string,
) (workspacefiles.FileEntry, error) {
	a.renameRoot = workspaceRoot
	a.renamePath = logicalPath
	a.renameName = newName
	return workspacefiles.FileEntry{Path: logicalPath, Kind: workspacefiles.EntryKindFile}, nil
}

func (*fileSearchDeadlineAdapter) CopyEntry(
	context.Context,
	workspacefiles.WorkspaceRoot,
	workspacefiles.LogicalPath,
) (workspacefiles.FileEntry, error) {
	return workspacefiles.FileEntry{}, nil
}

func (*fileSearchDeadlineAdapter) PreflightUploadFiles(
	context.Context,
	workspacefiles.WorkspaceRoot,
	workspacefiles.LogicalPath,
	[]string,
) ([]workspacefiles.UploadConflict, error) {
	return nil, nil
}

func (*fileSearchDeadlineAdapter) ReadFile(
	context.Context,
	workspacefiles.WorkspaceRoot,
	workspacefiles.LogicalPath,
	int64,
) (workspacefiles.FileContent, error) {
	return workspacefiles.FileContent{}, nil
}

func (*fileSearchDeadlineAdapter) UploadFiles(
	context.Context,
	workspacefiles.WorkspaceRoot,
	workspacefiles.LogicalPath,
	[]string,
	bool,
) ([]workspacefiles.FileEntry, error) {
	return nil, nil
}

func (*fileSearchDeadlineAdapter) WriteTextFile(
	context.Context,
	workspacefiles.WorkspaceRoot,
	workspacefiles.LogicalPath,
	string,
) (workspacefiles.FileEntry, error) {
	return workspacefiles.FileEntry{}, nil
}
