//go:build windows

package workspace

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	workspacefiles "github.com/tutti-os/tutti/packages/workspace/files"
	"golang.org/x/sys/windows"
)

func TestWindowsFilterOnlySearchUsesBoundedDirectoryTraversal(t *testing.T) {
	root := t.TempDir()
	documents := filepath.Join(root, "Documents")
	hidden := filepath.Join(root, ".hidden")
	if err := os.MkdirAll(documents, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(hidden, 0o755); err != nil {
		t.Fatal(err)
	}
	documentPath := filepath.Join(documents, "report.pdf")
	for _, path := range []string{documentPath, filepath.Join(documents, "photo.png"), filepath.Join(hidden, "secret.pdf")} {
		if err := os.WriteFile(path, []byte("fixture"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	paths, err := (windowsSearchProvider{}).Search(context.Background(), localFileSearchRequest{
		CandidateLimit: 5000,
		Filters:        []string{"document"},
		IncludeKinds:   []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
		Query:          "",
		ResultLimit:    30,
		SearchRootPath: root,
	})
	if err != nil {
		t.Fatalf("windowsFilterOnlySearch() error = %v", err)
	}
	if len(paths) != 1 || paths[0] != documentPath {
		t.Fatalf("paths = %#v, want only %q", paths, documentPath)
	}
}

func TestWindowsFilterOnlySearchPreservesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := windowsFilterOnlySearch(ctx, localFileSearchRequest{
		CandidateLimit: 5000,
		Filters:        []string{"document"},
		IncludeKinds:   []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
		ResultLimit:    30,
		SearchRootPath: t.TempDir(),
	})
	if err != context.Canceled {
		t.Fatalf("windowsFilterOnlySearch() error = %v, want context.Canceled", err)
	}
}

func TestWindowsFilterOnlySearchDoesNotCountHiddenFilesTowardCandidates(t *testing.T) {
	root := t.TempDir()
	for index := range 60 {
		path := filepath.Join(root, fmt.Sprintf("%03d-hidden.pdf", index))
		if err := os.WriteFile(path, []byte("fixture"), 0o644); err != nil {
			t.Fatal(err)
		}
		pathPointer, err := windows.UTF16PtrFromString(path)
		if err != nil {
			t.Fatal(err)
		}
		if err := windows.SetFileAttributes(pathPointer, windows.FILE_ATTRIBUTE_HIDDEN); err != nil {
			t.Fatal(err)
		}
	}
	visiblePath := filepath.Join(root, "zzz-visible.pdf")
	if err := os.WriteFile(visiblePath, []byte("fixture"), 0o644); err != nil {
		t.Fatal(err)
	}

	paths, err := windowsFilterOnlySearch(context.Background(), localFileSearchRequest{
		CandidateLimit: 60,
		Filters:        []string{"document"},
		IncludeKinds:   []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
		ResultLimit:    30,
		SearchRootPath: root,
	})
	if err != nil {
		t.Fatalf("windowsFilterOnlySearch() error = %v", err)
	}
	if len(paths) != 1 || paths[0] != visiblePath {
		t.Fatalf("paths = %#v, want only %q", paths, visiblePath)
	}
}

func TestSettleWindowsFilterOnlySearchPreservesSoftDeadlineSemantics(t *testing.T) {
	paths, err := settleWindowsFilterOnlySearch(nil, "soft_budget", 1, 128)
	if err != context.DeadlineExceeded || paths != nil {
		t.Fatalf("zero-result settlement = (%#v, %v), want deadline exceeded", paths, err)
	}

	want := []string{`C:\Users\local\report.pdf`}
	paths, err = settleWindowsFilterOnlySearch(want, "soft_budget", 1, 128)
	if err != nil || len(paths) != 1 || paths[0] != want[0] {
		t.Fatalf("partial settlement = (%#v, %v), want (%#v, nil)", paths, err, want)
	}
}

func TestWindowsFilterOnlyCandidateLimitIsBoundedByResultAndProviderLimits(t *testing.T) {
	tests := []struct {
		name    string
		request localFileSearchRequest
		want    int
	}{
		{
			name: "default result limit",
			request: localFileSearchRequest{
				CandidateLimit: 5000,
			},
			want: 60,
		},
		{
			name: "large result limit",
			request: localFileSearchRequest{
				CandidateLimit: 5000,
				ResultLimit:    200,
			},
			want: 400,
		},
		{
			name: "provider cap",
			request: localFileSearchRequest{
				CandidateLimit: 40,
				ResultLimit:    30,
			},
			want: 40,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := windowsFilterOnlyCandidateLimit(test.request); got != test.want {
				t.Fatalf("candidate limit = %d, want %d", got, test.want)
			}
		})
	}
}

func TestWindowsFilterOnlySearchPreservesOtherCategorySemantics(t *testing.T) {
	root := t.TempDir()
	otherPath := filepath.Join(root, "archive.custom")
	for _, path := range []string{otherPath, filepath.Join(root, "notes.txt")} {
		if err := os.WriteFile(path, []byte("fixture"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	paths, err := windowsFilterOnlySearch(context.Background(), localFileSearchRequest{
		CandidateLimit: 5000,
		Filters:        []string{"other"},
		IncludeKinds:   []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
		ResultLimit:    30,
		SearchRootPath: root,
	})
	if err != nil {
		t.Fatalf("windowsFilterOnlySearch() error = %v", err)
	}
	if len(paths) != 1 || paths[0] != otherPath {
		t.Fatalf("paths = %#v, want only %q", paths, otherPath)
	}
}

func TestWindowsKeywordSearchKeepsRecursiveScopeQuery(t *testing.T) {
	script := windowsSearchPowerShellScript(localFileSearchRequest{
		CandidateLimit: 5000,
		Filters:        []string{"document"},
		IncludeKinds:   []workspacefiles.EntryKind{workspacefiles.EntryKindFile},
		Query:          "report",
		ResultLimit:    30,
		SearchRootPath: `C:\Users\local`,
	})

	if !strings.Contains(script, "SCOPE=") || strings.Contains(script, "DIRECTORY=") {
		t.Fatalf("keyword script did not preserve recursive SCOPE query:\n%s", script)
	}
}

func TestWindowsSearchSQLScopesAndEscapesNativeQuery(t *testing.T) {
	query := windowsSearchSQL(localFileSearchRequest{
		CandidateLimit: 25,
		Filters:        []string{"image"},
		Query:          "100% user's_file",
		SearchRootPath: `C:\Users\local`,
	})

	for _, expected := range []string{
		"SELECT TOP 25 System.ItemUrl",
		"SCOPE='file:C:/Users/local'",
		"100[%]",
		"user''s[_]file",
		"System.FileExtension = '.png'",
		"System.ItemType <> 'Directory'",
	} {
		if !strings.Contains(query, expected) {
			t.Fatalf("query %q does not contain %q", query, expected)
		}
	}
	if strings.Contains(query, "CONTAINS(System.ItemFolderPathDisplay") {
		t.Fatalf("query %q applies slow full-text directory filtering", query)
	}
}

func TestWindowsSearchSQLNormalizesAbsolutePathTokensForItemURLs(t *testing.T) {
	query := windowsSearchSQL(localFileSearchRequest{
		Query:          `C:\Users\local\repo\100%#\user`,
		SearchRootPath: `C:\Users\local\repo`,
	})

	if !strings.Contains(query, `System.ItemUrl LIKE '%C:/Users/local/repo/100[%]25[%]23/user%'`) {
		t.Fatalf("query %q does not encode the physical path for ItemUrl", query)
	}
}

func TestParseWindowsSearchOutputUsesCanonicalItemURL(t *testing.T) {
	paths, err := parseWindowsSearchOutput([]byte(
		`["file:C:/Users/local/report%20one.md","file:C:/Users/local/spec.md"]`,
	))
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 2 {
		t.Fatalf("expected 2 paths, got %d", len(paths))
	}
	if got, want := paths[0], filepath.Clean(`C:\Users\local\report one.md`); got != want {
		t.Fatalf("first path = %q, want %q", got, want)
	}
}
