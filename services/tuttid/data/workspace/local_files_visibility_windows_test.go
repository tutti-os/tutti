//go:build windows

package workspace

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
	"golang.org/x/sys/windows"
)

func TestLocalFilesAdapterHidesWindowsFileAttributes(t *testing.T) {
	rootDir := t.TempDir()
	for _, test := range []struct {
		name       string
		attributes uint32
	}{
		{name: "hidden.txt", attributes: windows.FILE_ATTRIBUTE_HIDDEN},
		{name: "system.txt", attributes: windows.FILE_ATTRIBUTE_SYSTEM},
		{name: "temporary.txt", attributes: windows.FILE_ATTRIBUTE_TEMPORARY},
	} {
		path := filepath.Join(rootDir, test.name)
		if err := os.WriteFile(path, []byte(test.name), 0o644); err != nil {
			t.Fatal(err)
		}
		pathPointer, err := windows.UTF16PtrFromString(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := windows.SetFileAttributes(pathPointer, windows.FILE_ATTRIBUTE_ARCHIVE|test.attributes); err != nil {
			t.Fatal(err)
		}
	}
	hiddenDirectory := filepath.Join(rootDir, "hidden-dir")
	if err := os.Mkdir(hiddenDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(hiddenDirectory, "child.txt"), []byte("child"), 0o644); err != nil {
		t.Fatal(err)
	}
	hiddenDirectoryPointer, err := windows.UTF16PtrFromString(hiddenDirectory)
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetFileAttributes(hiddenDirectoryPointer, windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_HIDDEN); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rootDir, "visible.txt"), []byte("visible"), 0o644); err != nil {
		t.Fatal(err)
	}

	listing, err := (LocalFilesAdapter{}).ListDirectory(context.Background(), localFilesRoot(rootDir), "/workspace", false)
	if err != nil {
		t.Fatal(err)
	}
	if len(listing.Entries) != 1 || listing.Entries[0].Path != "/workspace/visible.txt" {
		t.Fatalf("entries = %#v, want only visible.txt", listing.Entries)
	}

	paths := []string{
		filepath.Join(rootDir, "hidden.txt"),
		filepath.Join(rootDir, "system.txt"),
		filepath.Join(rootDir, "temporary.txt"),
		filepath.Join(rootDir, "visible.txt"),
		filepath.Join(hiddenDirectory, "child.txt"),
	}
	candidates, stats := localFileSearchCandidates(rootDir, rootDir, paths, workspacefiles.SearchInput{
		IncludeKinds: []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
	})
	if len(candidates) != 1 || candidates[0].RelativePath != "visible.txt" || stats.skippedHiddenCount != 4 {
		t.Fatalf("candidates = %#v, stats = %#v, want only visible.txt and four hidden skips", candidates, stats)
	}
	allCandidates, _ := localFileSearchCandidates(rootDir, rootDir, paths, workspacefiles.SearchInput{
		IncludeHidden: true,
		IncludeKinds:  []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
	})
	if len(allCandidates) != 5 {
		t.Fatalf("includeHidden candidates = %#v, want all five files", allCandidates)
	}
}
