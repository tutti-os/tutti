package workspace

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
)

func TestLocalFilesAdapterListsLogicalChildren(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(rootDir, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "src", "main.go"), []byte("package main\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "README.md"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	listing, err := adapter.ListDirectory(context.Background(), localFilesRoot(rootDir), "/workspace", false)
	if err != nil {
		t.Fatalf("ListDirectory() error = %v", err)
	}

	if listing.WorkspaceID != "ws-1" || listing.DirectoryPath != "/workspace" {
		t.Fatalf("listing = %#v", listing)
	}
	if len(listing.Entries) != 2 {
		t.Fatalf("entries = %#v, want 2 entries", listing.Entries)
	}
	if listing.Entries[0].Path != "/workspace/src" || listing.Entries[0].Kind != workspacefiles.EntryKindDirectory {
		t.Fatalf("first entry = %#v, want src directory", listing.Entries[0])
	}
	if listing.Entries[0].SizeBytes != nil || !listing.Entries[0].HasChildren {
		t.Fatalf("directory metadata = %#v", listing.Entries[0])
	}
	if listing.Entries[1].Path != "/workspace/README.md" || listing.Entries[1].SizeBytes == nil {
		t.Fatalf("second entry = %#v, want readme file with size", listing.Entries[1])
	}
}

func TestLocalFilesAdapterReadsExternalAbsolutePathsFromFilesystemRoot(t *testing.T) {
	t.Parallel()

	targetDir := t.TempDir()
	targetPath := filepath.Join(targetDir, "test-note.md")
	if err := os.WriteFile(targetPath, []byte("# Test note\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	root := workspacefiles.WorkspaceRoot{
		WorkspaceID:  "ws-1",
		LogicalRoot:  filepath.ToSlash(string(filepath.Separator)),
		PhysicalRoot: string(filepath.Separator),
	}
	adapter := LocalFilesAdapter{}
	listing, err := adapter.ListDirectory(
		context.Background(),
		root,
		workspacefiles.LogicalPath(filepath.ToSlash(targetDir)),
		false,
	)
	if err != nil {
		t.Fatalf("ListDirectory() error = %v", err)
	}

	if listing.DirectoryPath.String() != filepath.ToSlash(targetDir) {
		t.Fatalf("directoryPath = %q, want %q", listing.DirectoryPath, filepath.ToSlash(targetDir))
	}
	if len(listing.Entries) != 1 || listing.Entries[0].Path.String() != filepath.ToSlash(targetPath) {
		t.Fatalf("entries = %#v, want test note", listing.Entries)
	}

	content, err := adapter.ReadFile(
		context.Background(),
		root,
		workspacefiles.LogicalPath(filepath.ToSlash(targetPath)),
		workspacefiles.DefaultReadFileMaxBytes,
	)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(content.Bytes) != "# Test note\n" {
		t.Fatalf("content = %q", string(content.Bytes))
	}
}

func TestLocalFilesAdapterRejectsSymlinkEscape(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	outsideDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(outsideDir, "secret.txt"), []byte("nope"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outsideDir, filepath.Join(rootDir, "outside")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	adapter := LocalFilesAdapter{}
	listing, err := adapter.ListDirectory(context.Background(), localFilesRoot(rootDir), "/workspace", false)
	if err != nil {
		t.Fatalf("ListDirectory() error = %v", err)
	}
	if len(listing.Entries) != 0 {
		t.Fatalf("entries = %#v, want symlink escape filtered", listing.Entries)
	}
}

func TestLocalFilesAdapterListDirectorySkipsHiddenEntriesByDefault(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(rootDir, ".agents"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, ".env"), []byte("SECRET=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(rootDir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	listing, err := adapter.ListDirectory(context.Background(), localFilesRoot(rootDir), "/workspace", false)
	if err != nil {
		t.Fatalf("ListDirectory() error = %v", err)
	}
	if len(listing.Entries) != 1 || listing.Entries[0].Path != "/workspace/docs" {
		t.Fatalf("entries = %#v, want only visible docs directory", listing.Entries)
	}
}

func TestLocalFilesAdapterListDirectoryKeepsNonHiddenSystemDirectories(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	for _, name := range []string{
		"Applications",
		"Library",
		"System",
		"Volumes",
		"Desktop",
		"Documents",
		"Downloads",
		"demo",
	} {
		if err := os.Mkdir(filepath.Join(rootDir, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	adapter := LocalFilesAdapter{}
	listing, err := adapter.ListDirectory(context.Background(), localFilesRoot(rootDir), "/workspace", false)
	if err != nil {
		t.Fatalf("ListDirectory() error = %v", err)
	}

	paths := make([]workspacefiles.LogicalPath, 0, len(listing.Entries))
	for _, entry := range listing.Entries {
		paths = append(paths, entry.Path)
	}
	want := []workspacefiles.LogicalPath{
		"/workspace/Applications",
		"/workspace/demo",
		"/workspace/Desktop",
		"/workspace/Documents",
		"/workspace/Downloads",
		"/workspace/Library",
		"/workspace/System",
		"/workspace/Volumes",
	}
	if !slices.Equal(paths, want) {
		t.Fatalf("entries = %#v, want %v", listing.Entries, want)
	}
}

func TestLocalFilesAdapterUsesPhysicalPathForMacOSRootProtectedDirectoryPolicy(t *testing.T) {
	withLocalFilesRuntimeGOOS(t, "darwin")
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)

	if (LocalFilesAdapter{}).ShouldPrefetchDirectory(workspacefiles.WorkspaceRoot{
		WorkspaceID:  "ws-1",
		LogicalRoot:  "/",
		PhysicalRoot: string(filepath.Separator),
	}, "/System") {
		t.Fatal("physical /System was not treated as protected")
	}

	if !(LocalFilesAdapter{}).ShouldPrefetchDirectory(workspacefiles.WorkspaceRoot{
		WorkspaceID:  "ws-1",
		LogicalRoot:  "/",
		PhysicalRoot: t.TempDir(),
	}, "/System") {
		t.Fatal("logical /System inside an ordinary physical root was treated as protected")
	}

	if (LocalFilesAdapter{}).ShouldPrefetchDirectory(workspacefiles.WorkspaceRoot{
		WorkspaceID:  "ws-1",
		LogicalRoot:  "/workspace",
		PhysicalRoot: homeDir,
	}, "/workspace/Desktop") {
		t.Fatal("logical /workspace/Desktop mapped to physical home Desktop was not treated as protected")
	}
}

func TestLocalFilesAdapterMarksMacOSHomeTCCDirectoriesExpandableWithoutReadingChildren(t *testing.T) {
	withLocalFilesRuntimeGOOS(t, "darwin")
	homeDir := t.TempDir()
	t.Setenv("HOME", homeDir)
	desktopDir := filepath.Join(homeDir, "Desktop")
	if err := os.Mkdir(desktopDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(desktopDir, 0o000); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = os.Chmod(desktopDir, 0o755)
	})

	root := workspacefiles.WorkspaceRoot{
		WorkspaceID:  "ws-1",
		LogicalRoot:  filepath.ToSlash(homeDir),
		PhysicalRoot: homeDir,
	}
	listing, err := (LocalFilesAdapter{}).ListDirectory(
		context.Background(),
		root,
		workspacefiles.NormalizeLogicalRoot(homeDir),
		false,
	)
	if err != nil {
		t.Fatalf("ListDirectory() error = %v", err)
	}

	if len(listing.Entries) != 1 {
		t.Fatalf("entries = %#v, want one Desktop directory", listing.Entries)
	}
	entry := listing.Entries[0]
	if entry.Path.String() != filepath.ToSlash(filepath.Join(homeDir, "Desktop")) ||
		entry.Kind != workspacefiles.EntryKindDirectory {
		t.Fatalf("entry = %#v, want Desktop directory", entry)
	}
	if !entry.HasChildren {
		t.Fatalf("entry hasChildren = false, want true without reading children")
	}
	if (LocalFilesAdapter{}).ShouldPrefetchDirectory(root, entry.Path) {
		t.Fatal("ShouldPrefetchDirectory(Desktop) = true, want false")
	}
}

func TestLocalFilesAdapterListDirectoryIncludesHiddenEntriesWhenRequested(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(rootDir, ".agents"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, ".env"), []byte("SECRET=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	listing, err := adapter.ListDirectory(context.Background(), localFilesRoot(rootDir), "/workspace", true)
	if err != nil {
		t.Fatalf("ListDirectory() error = %v", err)
	}
	if len(listing.Entries) != 2 {
		t.Fatalf("entries = %#v, want hidden file and directory", listing.Entries)
	}
}

func TestLocalFilesAdapterCreatesAndDeletesEntries(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	adapter := LocalFilesAdapter{}
	root := localFilesRoot(rootDir)

	dirEntry, err := adapter.CreateDirectory(context.Background(), root, "/workspace/docs")
	if err != nil {
		t.Fatalf("CreateDirectory() error = %v", err)
	}
	if dirEntry.Kind != workspacefiles.EntryKindDirectory {
		t.Fatalf("dir entry = %#v", dirEntry)
	}

	fileEntry, err := adapter.CreateFile(context.Background(), root, "/workspace/docs/readme.md")
	if err != nil {
		t.Fatalf("CreateFile() error = %v", err)
	}
	if fileEntry.Kind != workspacefiles.EntryKindFile || fileEntry.SizeBytes == nil {
		t.Fatalf("file entry = %#v", fileEntry)
	}

	if err := adapter.DeleteEntry(context.Background(), root, "/workspace/docs", workspacefiles.EntryKindDirectory); err != nil {
		t.Fatalf("DeleteEntry() error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(rootDir, "docs")); !os.IsNotExist(err) {
		t.Fatalf("deleted directory stat error = %v, want not exist", err)
	}
}

func TestLocalFilesAdapterWritesTextFiles(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(rootDir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	targetPath := filepath.Join(rootDir, "docs", "readme.md")
	if err := os.WriteFile(targetPath, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	entry, err := adapter.WriteTextFile(
		context.Background(),
		localFilesRoot(rootDir),
		"/workspace/docs/readme.md",
		"updated",
	)
	if err != nil {
		t.Fatalf("WriteTextFile() error = %v", err)
	}

	content, err := os.ReadFile(targetPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != "updated" {
		t.Fatalf("file content = %q", content)
	}
	if entry.Path != "/workspace/docs/readme.md" {
		t.Fatalf("entry path = %q", entry.Path)
	}
}

func TestLocalFilesAdapterReadsFilesWithinBudget(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(rootDir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "docs", "readme.md"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	content, err := adapter.ReadFile(
		context.Background(),
		localFilesRoot(rootDir),
		"/workspace/docs/readme.md",
		10,
	)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(content.Bytes) != "hello" {
		t.Fatalf("content = %q", content.Bytes)
	}
	if content.Path != "/workspace/docs/readme.md" {
		t.Fatalf("content path = %q", content.Path)
	}
}

func TestLocalFilesAdapterRejectsReadFilesAboveBudget(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(rootDir, "large.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	_, err := adapter.ReadFile(
		context.Background(),
		localFilesRoot(rootDir),
		"/workspace/large.txt",
		4,
	)
	if !errors.Is(err, workspacefiles.ErrFileTooLarge) {
		t.Fatalf("ReadFile() error = %v, want %v", err, workspacefiles.ErrFileTooLarge)
	}
}

func TestLocalFilesAdapterMovesEntries(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(rootDir, "src"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(rootDir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "src", "readme.md"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	entry, err := adapter.MoveEntry(
		context.Background(),
		localFilesRoot(rootDir),
		"/workspace/src/readme.md",
		"/workspace/docs",
	)
	if err != nil {
		t.Fatalf("MoveEntry() error = %v", err)
	}
	if entry.Path != "/workspace/docs/readme.md" || entry.Kind != workspacefiles.EntryKindFile {
		t.Fatalf("moved entry = %#v", entry)
	}
	if _, err := os.Stat(filepath.Join(rootDir, "src", "readme.md")); !os.IsNotExist(err) {
		t.Fatalf("source stat error = %v, want not exist", err)
	}
	if _, err := os.Stat(filepath.Join(rootDir, "docs", "readme.md")); err != nil {
		t.Fatalf("target stat error = %v", err)
	}
}

func TestLocalFilesAdapterRenamesEntries(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(rootDir, "notes.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	entry, err := adapter.RenameEntry(
		context.Background(),
		localFilesRoot(rootDir),
		"/workspace/notes.txt",
		"renamed.txt",
	)
	if err != nil {
		t.Fatalf("RenameEntry() error = %v", err)
	}
	if entry.Path != "/workspace/renamed.txt" || entry.Name != "renamed.txt" {
		t.Fatalf("renamed entry = %#v", entry)
	}
	if _, err := os.Stat(filepath.Join(rootDir, "notes.txt")); !os.IsNotExist(err) {
		t.Fatalf("source stat error = %v, want not exist", err)
	}
	if content, err := os.ReadFile(filepath.Join(rootDir, "renamed.txt")); err != nil || string(content) != "hello" {
		t.Fatalf("renamed content = %q, err = %v", content, err)
	}
}

func TestLocalFilesAdapterCopiesEntries(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(rootDir, "notes.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	entry, err := adapter.CopyEntry(
		context.Background(),
		localFilesRoot(rootDir),
		"/workspace/notes.txt",
	)
	if err != nil {
		t.Fatalf("CopyEntry() error = %v", err)
	}
	if entry.Path != "/workspace/notes copy.txt" || entry.Name != "notes copy.txt" {
		t.Fatalf("copied entry = %#v", entry)
	}
	if content, err := os.ReadFile(filepath.Join(rootDir, "notes copy.txt")); err != nil || string(content) != "hello" {
		t.Fatalf("copied content = %q, err = %v", content, err)
	}
	if content, err := os.ReadFile(filepath.Join(rootDir, "notes.txt")); err != nil || string(content) != "hello" {
		t.Fatalf("source content = %q, err = %v", content, err)
	}
}

func TestLocalFilesAdapterUploadsFilesIntoDirectory(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	sourceDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(rootDir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	sourcePath := filepath.Join(sourceDir, "notes.txt")
	if err := os.WriteFile(sourcePath, []byte("hello upload"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	entries, err := adapter.UploadFiles(
		context.Background(),
		localFilesRoot(rootDir),
		"/workspace/docs",
		[]string{sourcePath},
		false,
	)
	if err != nil {
		t.Fatalf("UploadFiles() error = %v", err)
	}
	if len(entries) != 1 || entries[0].Path != "/workspace/docs/notes.txt" {
		t.Fatalf("entries = %#v", entries)
	}

	uploadedContent, err := os.ReadFile(filepath.Join(rootDir, "docs", "notes.txt"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(uploadedContent) != "hello upload" {
		t.Fatalf("uploaded content = %q", uploadedContent)
	}
}

func TestLocalFilesAdapterUploadsDirectorySourcesRecursively(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	sourceParentDir := t.TempDir()
	sourceDir := filepath.Join(sourceParentDir, "nested")
	if err := os.Mkdir(filepath.Join(rootDir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(sourceDir, "deeper"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, "deeper", "notes.txt"), []byte("nested upload"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	entries, err := adapter.UploadFiles(
		context.Background(),
		localFilesRoot(rootDir),
		"/workspace/docs",
		[]string{sourceDir},
		false,
	)
	if err != nil {
		t.Fatalf("UploadFiles() error = %v", err)
	}
	if len(entries) != 1 || entries[0].Path != "/workspace/docs/nested" || entries[0].Kind != workspacefiles.EntryKindDirectory {
		t.Fatalf("entries = %#v", entries)
	}

	uploadedContent, err := os.ReadFile(filepath.Join(rootDir, "docs", "nested", "deeper", "notes.txt"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(uploadedContent) != "nested upload" {
		t.Fatalf("uploaded content = %q", uploadedContent)
	}
}

func TestLocalFilesAdapterPreflightUploadFilesDetectsRecursiveConflicts(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	sourceParentDir := t.TempDir()
	sourceDir := filepath.Join(sourceParentDir, "nested")
	if err := os.MkdirAll(filepath.Join(rootDir, "docs", "nested", "deeper"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(sourceDir, "deeper"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "docs", "nested", "deeper", "notes.txt"), []byte("existing"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, "deeper", "notes.txt"), []byte("incoming"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	conflicts, err := adapter.PreflightUploadFiles(
		context.Background(),
		localFilesRoot(rootDir),
		"/workspace/docs",
		[]string{sourceDir},
	)
	if err != nil {
		t.Fatalf("PreflightUploadFiles() error = %v", err)
	}
	if len(conflicts) != 1 {
		t.Fatalf("conflicts = %#v, want 1 conflict", conflicts)
	}
	if conflicts[0].DestinationPath != "/workspace/docs/nested/deeper/notes.txt" {
		t.Fatalf("destinationPath = %q, want /workspace/docs/nested/deeper/notes.txt", conflicts[0].DestinationPath)
	}
	if conflicts[0].Kind != workspacefiles.UploadConflictKindReplaceable {
		t.Fatalf("kind = %q, want %q", conflicts[0].Kind, workspacefiles.UploadConflictKindReplaceable)
	}
}

func TestLocalFilesAdapterOverwritesExistingUploadedFiles(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	sourceDir := t.TempDir()
	if err := os.Mkdir(filepath.Join(rootDir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "docs", "notes.txt"), []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}

	sourcePath := filepath.Join(sourceDir, "notes.txt")
	if err := os.WriteFile(sourcePath, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	_, err := adapter.UploadFiles(
		context.Background(),
		localFilesRoot(rootDir),
		"/workspace/docs",
		[]string{sourcePath},
		true,
	)
	if err != nil {
		t.Fatalf("UploadFiles() error = %v", err)
	}

	uploadedContent, err := os.ReadFile(filepath.Join(rootDir, "docs", "notes.txt"))
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(uploadedContent) != "new" {
		t.Fatalf("uploaded content = %q", uploadedContent)
	}
}

func TestLocalFilesAdapterPreflightUploadFilesDetectsTypeMismatchConflicts(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	sourceParentDir := t.TempDir()
	sourceDir := filepath.Join(sourceParentDir, "nested")
	if err := os.Mkdir(filepath.Join(rootDir, "docs"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "docs", "nested"), []byte("existing file"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(sourceDir, "deeper"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sourceDir, "deeper", "notes.txt"), []byte("incoming"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	conflicts, err := adapter.PreflightUploadFiles(
		context.Background(),
		localFilesRoot(rootDir),
		"/workspace/docs",
		[]string{sourceDir},
	)
	if err != nil {
		t.Fatalf("PreflightUploadFiles() error = %v", err)
	}
	if len(conflicts) != 1 {
		t.Fatalf("conflicts = %#v, want 1 conflict", conflicts)
	}
	if conflicts[0].DestinationPath != "/workspace/docs/nested" {
		t.Fatalf("destinationPath = %q, want /workspace/docs/nested", conflicts[0].DestinationPath)
	}
	if conflicts[0].Kind != workspacefiles.UploadConflictKindTypeMismatch {
		t.Fatalf("kind = %q, want %q", conflicts[0].Kind, workspacefiles.UploadConflictKindTypeMismatch)
	}
}

func TestLocalFilesAdapterSearchSkipsHiddenNoiseDirectoriesForNormalQueries(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	hiddenMatchPath := filepath.Join(
		rootDir,
		".cache",
		"codex-runtimes",
		"codex-primary-runtime",
		"dependencies",
		"python",
		"lib",
		"python3.12",
		"site-packages",
		"artifact_tool_v2-2.8.0.dist-info",
		"direct_url.json",
	)
	if err := os.MkdirAll(filepath.Dir(hiddenMatchPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hiddenMatchPath, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}

	applicationsMatchPath := filepath.Join(rootDir, "Applications", "Nexight.app", "package.json")
	if err := os.MkdirAll(filepath.Dir(applicationsMatchPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(applicationsMatchPath, []byte(`{"name":"app"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	systemMatchPath := filepath.Join(rootDir, "System", "Library", "package.json")
	if err := os.MkdirAll(filepath.Dir(systemMatchPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(systemMatchPath, []byte(`{"name":"system"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	projectPackagePath := filepath.Join(rootDir, "project", "package.json")
	if err := os.MkdirAll(filepath.Dir(projectPackagePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(projectPackagePath, []byte(`{"name":"project"}`), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{MaxSearchCandidates: 1}
	result, err := adapter.Search(context.Background(), localFilesRoot(rootDir), workspacefiles.SearchInput{
		Query:        "package.json",
		Limit:        5,
		IncludeKinds: []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(result.Entries) != 1 {
		t.Fatalf("entries = %#v, want 1 result", result.Entries)
	}
	if result.Entries[0].Path != "/workspace/project/package.json" {
		t.Fatalf("first result = %#v, want /workspace/project/package.json", result.Entries[0])
	}
}

func TestLocalFilesAdapterSearchKeepsShallowMatchesBeforeDeepCandidateCap(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	deepDir := filepath.Join(rootDir, "a-deep-project")
	if err := os.MkdirAll(deepDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"filler-a.txt", "filler-b.txt", "filler-c.txt"} {
		if err := os.WriteFile(
			filepath.Join(deepDir, name),
			[]byte("filler"),
			0o644,
		); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(rootDir, "郑伟斌.csv"), []byte("a,b\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{MaxSearchCandidates: 2}
	result, err := adapter.Search(context.Background(), localFilesRoot(rootDir), workspacefiles.SearchInput{
		Query:        "郑伟斌",
		Limit:        5,
		IncludeKinds: []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(result.Entries) != 1 {
		t.Fatalf("entries = %#v, want shallow csv result", result.Entries)
	}
	if result.Entries[0].Path != "/workspace/郑伟斌.csv" {
		t.Fatalf("first result = %#v, want /workspace/郑伟斌.csv", result.Entries[0])
	}
}

func TestLocalFilesAdapterSearchTypeFilterExcludesDirectoriesButKeepsMatchingFiles(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	// 一个目录名含 "22" 的文档文件:开启「document」筛选后仍只按文件名匹配关键词。
	docInFolder := filepath.Join(rootDir, "reports22", "q3.csv")
	if err := os.MkdirAll(filepath.Dir(docInFolder), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(docInFolder, []byte("a,b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 含 "22" 的文档文件(csv 归入 document):类型与关键词都命中,应保留。
	docMatch := filepath.Join(rootDir, "data22.csv")
	if err := os.WriteFile(docMatch, []byte("a,b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	// 含 "22" 但非文档的文件(图片):关键词命中、类型不命中,应被筛选掉。
	imageMatch := filepath.Join(rootDir, "shot22.png")
	if err := os.WriteFile(imageMatch, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	result, err := adapter.Search(context.Background(), localFilesRoot(rootDir), workspacefiles.SearchInput{
		Query:   "22",
		Limit:   20,
		Filters: []string{"document"},
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}

	gotPaths := make(map[string]bool, len(result.Entries))
	for _, entry := range result.Entries {
		gotPaths[entry.Path.String()] = true
		if entry.Kind == workspacefiles.EntryKindDirectory {
			t.Fatalf("entry = %#v, directories must be excluded when a type filter is active", entry)
		}
	}
	// 交集:文件名关键词 "22" ∩ 类型 document。
	wantPaths := []string{"/workspace/data22.csv"}
	for _, want := range wantPaths {
		if !gotPaths[want] {
			t.Fatalf("entries = %#v, want to include %s", result.Entries, want)
		}
	}
	if gotPaths["/workspace/shot22.png"] {
		t.Fatalf("entries = %#v, must exclude non-document shot22.png", result.Entries)
	}
	if len(result.Entries) != len(wantPaths) {
		t.Fatalf("entries = %#v, want exactly %d results", result.Entries, len(wantPaths))
	}
}

func TestLocalFilesAdapterSearchScopesToWithinSubdirectory(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	// 工作区根下两处同名匹配:仅「文稿」范围内的应被返回,根下另一处不应出现。
	inDocuments := filepath.Join(rootDir, "Documents", "report-notes.md")
	if err := os.MkdirAll(filepath.Dir(inDocuments), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(inDocuments, []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	outsideDocuments := filepath.Join(rootDir, "Downloads", "report-notes.md")
	if err := os.MkdirAll(filepath.Dir(outsideDocuments), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outsideDocuments, []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	result, err := adapter.Search(context.Background(), localFilesRoot(rootDir), workspacefiles.SearchInput{
		Query:  "report",
		Limit:  20,
		Within: "Documents",
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(result.Entries) != 1 {
		t.Fatalf("entries = %#v, want exactly 1 scoped result", result.Entries)
	}
	// 结果逻辑路径仍以工作区根为基准(含 /Documents 前缀),保持可定位。
	if got := result.Entries[0].Path.String(); got != "/workspace/Documents/report-notes.md" {
		t.Fatalf("result path = %q, want /workspace/Documents/report-notes.md", got)
	}
}

func TestLocalFilesAdapterSearchWithoutWithinSpansWholeRoot(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	for _, rel := range []string{
		filepath.Join("Documents", "report-notes.md"),
		filepath.Join("Downloads", "report-notes.md"),
	} {
		full := filepath.Join(rootDir, rel)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte("hi"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	adapter := LocalFilesAdapter{}
	result, err := adapter.Search(context.Background(), localFilesRoot(rootDir), workspacefiles.SearchInput{
		Query: "report",
		Limit: 20,
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(result.Entries) != 2 {
		t.Fatalf("entries = %#v, want both matches across the whole root", result.Entries)
	}
}

func TestLocalFilesAdapterSearchReturnsPartialResultsWhenDeadlineExpires(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	readmePath := filepath.Join(rootDir, "project", "README.md")
	if err := os.MkdirAll(filepath.Dir(readmePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(readmePath, []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	result, err := adapter.Search(context.Background(), localFilesRoot(rootDir), workspacefiles.SearchInput{
		Deadline: time.Now().Add(-time.Second),
		Query:    "README",
		Limit:    5,
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if result.Entries == nil {
		t.Fatalf("entries = nil, want empty slice")
	}
}

func TestLocalFilesAdapterSearchDoesNotMatchExplicitHiddenPathWhenFilenameDiffers(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	hiddenConfigPath := filepath.Join(rootDir, ".git", "config")
	if err := os.MkdirAll(filepath.Dir(hiddenConfigPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hiddenConfigPath, []byte("[core]\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	projectConfigPath := filepath.Join(rootDir, "project", "config")
	if err := os.MkdirAll(filepath.Dir(projectConfigPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(projectConfigPath, []byte("project"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{MaxSearchCandidates: 1}
	result, err := adapter.Search(context.Background(), localFilesRoot(rootDir), workspacefiles.SearchInput{
		Query:        ".git/config",
		Limit:        5,
		IncludeKinds: []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(result.Entries) != 0 {
		t.Fatalf("entries = %#v, want no path-only matches", result.Entries)
	}
}

func TestLocalFilesAdapterSearchSkipsHiddenFilesForNormalQueries(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	hiddenEnvPath := filepath.Join(rootDir, ".env")
	if err := os.WriteFile(hiddenEnvPath, []byte("SECRET=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	visibleEnvPath := filepath.Join(rootDir, "docs", "env.md")
	if err := os.MkdirAll(filepath.Dir(visibleEnvPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(visibleEnvPath, []byte("env docs"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	result, err := adapter.Search(context.Background(), localFilesRoot(rootDir), workspacefiles.SearchInput{
		Query:        "env",
		Limit:        5,
		IncludeKinds: []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	for _, entry := range result.Entries {
		if entry.Path == "/workspace/.env" {
			t.Fatalf("unexpected hidden file result %#v", entry)
		}
	}
	if len(result.Entries) == 0 || result.Entries[0].Path != "/workspace/docs/env.md" {
		t.Fatalf("entries = %#v, want visible env.md result first", result.Entries)
	}
}

func TestLocalFilesAdapterSearchSkipsHiddenFilesWhenQueryExplicitlyTargetsThemWithoutOptIn(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	hiddenEnvPath := filepath.Join(rootDir, ".env")
	if err := os.WriteFile(hiddenEnvPath, []byte("SECRET=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	visibleEnvPath := filepath.Join(rootDir, "docs", "runtime.env")
	if err := os.MkdirAll(filepath.Dir(visibleEnvPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(visibleEnvPath, []byte("VISIBLE=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	result, err := adapter.Search(context.Background(), localFilesRoot(rootDir), workspacefiles.SearchInput{
		Query:        ".env",
		Limit:        5,
		IncludeKinds: []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	for _, entry := range result.Entries {
		if entry.Path == "/workspace/.env" {
			t.Fatalf("unexpected hidden file result %#v", entry)
		}
	}
	if len(result.Entries) != 1 || result.Entries[0].Path != "/workspace/docs/runtime.env" {
		t.Fatalf("entries = %#v, want visible runtime.env only", result.Entries)
	}
}

func TestLocalFilesAdapterSearchDoesNotDescendHiddenDirsForDotLiteralQuery(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	hiddenDmgPath := filepath.Join(rootDir, ".cache", "downloads", "googlechrome.dmg")
	if err := os.MkdirAll(filepath.Dir(hiddenDmgPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hiddenDmgPath, []byte("hidden dmg"), 0o644); err != nil {
		t.Fatal(err)
	}

	visibleDmgPath := filepath.Join(rootDir, "Downloads", "googlechrome.dmg")
	if err := os.MkdirAll(filepath.Dir(visibleDmgPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(visibleDmgPath, []byte("visible dmg"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	result, err := adapter.Search(context.Background(), localFilesRoot(rootDir), workspacefiles.SearchInput{
		Query:        ".dmg",
		Limit:        5,
		IncludeKinds: []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(result.Entries) != 1 {
		t.Fatalf("entries = %#v, want one visible dmg result", result.Entries)
	}
	if result.Entries[0].Path != "/workspace/Downloads/googlechrome.dmg" {
		t.Fatalf("first result = %#v, want visible dmg", result.Entries[0])
	}
}

func TestLocalFilesAdapterSearchDoesNotDescendHiddenDirsForMultiTokenDotLiteralQuery(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	hiddenMatchPath := filepath.Join(rootDir, ".agents", "skills", "baoyu-slide-deck", "scripts", "merge-to-pdf.ts")
	if err := os.MkdirAll(filepath.Dir(hiddenMatchPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hiddenMatchPath, []byte("merge"), 0o644); err != nil {
		t.Fatal(err)
	}

	visibleDmgPath := filepath.Join(rootDir, "Downloads", "googlechrome.dmg")
	if err := os.MkdirAll(filepath.Dir(visibleDmgPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(visibleDmgPath, []byte("visible dmg"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{MaxSearchCandidates: 1}
	result, err := adapter.Search(context.Background(), localFilesRoot(rootDir), workspacefiles.SearchInput{
		Query:        "chrome .dmg",
		Limit:        5,
		IncludeKinds: []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(result.Entries) != 1 {
		t.Fatalf("entries = %#v, want one visible dmg result", result.Entries)
	}
	if result.Entries[0].Path != "/workspace/Downloads/googlechrome.dmg" {
		t.Fatalf("first result = %#v, want visible dmg", result.Entries[0])
	}
}

func TestLocalFilesAdapterSearchDoesNotDescendHiddenDirsForPathExtensionQuery(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	hiddenDmgPath := filepath.Join(rootDir, ".cache", "Downloads", "googlechrome.dmg")
	if err := os.MkdirAll(filepath.Dir(hiddenDmgPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hiddenDmgPath, []byte("hidden dmg"), 0o644); err != nil {
		t.Fatal(err)
	}

	visibleDmgPath := filepath.Join(rootDir, "Downloads", "googlechrome.dmg")
	if err := os.MkdirAll(filepath.Dir(visibleDmgPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(visibleDmgPath, []byte("visible dmg"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{MaxSearchCandidates: 1}
	result, err := adapter.Search(context.Background(), localFilesRoot(rootDir), workspacefiles.SearchInput{
		Query:        ".dmg",
		Limit:        5,
		IncludeKinds: []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(result.Entries) != 1 {
		t.Fatalf("entries = %#v, want one visible dmg result", result.Entries)
	}
	if result.Entries[0].Path != "/workspace/Downloads/googlechrome.dmg" {
		t.Fatalf("first result = %#v, want visible dmg", result.Entries[0])
	}
}

func TestLocalFilesAdapterSearchIncludesHiddenFilesWhenIncludeHiddenIsTrue(t *testing.T) {
	t.Parallel()

	rootDir := t.TempDir()
	hiddenEnvPath := filepath.Join(rootDir, ".env")
	if err := os.WriteFile(hiddenEnvPath, []byte("SECRET=1\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	visibleEnvPath := filepath.Join(rootDir, "docs", "env.md")
	if err := os.MkdirAll(filepath.Dir(visibleEnvPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(visibleEnvPath, []byte("env docs"), 0o644); err != nil {
		t.Fatal(err)
	}

	adapter := LocalFilesAdapter{}
	result, err := adapter.Search(context.Background(), localFilesRoot(rootDir), workspacefiles.SearchInput{
		Query:         "env",
		Limit:         5,
		IncludeKinds:  []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
		IncludeHidden: true,
	})
	if err != nil {
		t.Fatalf("Search() error = %v", err)
	}
	if len(result.Entries) == 0 {
		t.Fatal("expected search results when includeHidden is enabled")
	}
	paths := make([]workspacefiles.LogicalPath, 0, len(result.Entries))
	for _, entry := range result.Entries {
		paths = append(paths, entry.Path)
	}
	foundHidden := false
	for _, resultPath := range paths {
		if resultPath == "/workspace/.env" {
			foundHidden = true
			break
		}
	}
	if !foundHidden {
		t.Fatalf("paths = %#v, want hidden /workspace/.env result", paths)
	}
}

func localFilesRoot(rootDir string) workspacefiles.WorkspaceRoot {
	return workspacefiles.WorkspaceRoot{
		WorkspaceID:  "ws-1",
		LogicalRoot:  "/workspace",
		PhysicalRoot: rootDir,
	}
}

func withLocalFilesRuntimeGOOS(t *testing.T, goos string) {
	t.Helper()
	previous := localFilesRuntimeGOOS
	localFilesRuntimeGOOS = goos
	t.Cleanup(func() {
		localFilesRuntimeGOOS = previous
	})
}
