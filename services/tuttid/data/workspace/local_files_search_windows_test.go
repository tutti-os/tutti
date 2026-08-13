//go:build windows

package workspace

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
		`NOT CONTAINS(System.ItemFolderPathDisplay, '"node_modules"')`,
	} {
		if !strings.Contains(query, expected) {
			t.Fatalf("query %q does not contain %q", query, expected)
		}
	}
}

func TestWindowsSearchSQLIncludesNoiseWhenIncludeHiddenIsEnabled(t *testing.T) {
	query := windowsSearchSQL(localFileSearchRequest{
		IncludeHidden:  true,
		SearchRootPath: `C:\Users\local`,
	})

	if strings.Contains(query, "NOT CONTAINS(System.ItemFolderPathDisplay") {
		t.Fatalf("query %q excludes noise despite IncludeHidden", query)
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

func TestWindowsSearchProviderIntegration(t *testing.T) {
	if os.Getenv("TUTTI_TEST_WINDOWS_SEARCH") != "1" {
		t.Skip("set TUTTI_TEST_WINDOWS_SEARCH=1 to query the local Windows Search index")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		t.Fatal(err)
	}
	paths, err := (windowsSearchProvider{}).Search(context.Background(), localFileSearchRequest{
		CandidateLimit: 20,
		Query:          "package.go",
		SearchRootPath: home,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) == 0 {
		t.Fatal("Windows Search returned no indexed package.go candidates")
	}
	for _, candidate := range paths {
		if _, ok := relativePathWithin(home, candidate); !ok {
			t.Fatalf("candidate %q is outside home %q", candidate, home)
		}
	}

	filteredPaths, err := (windowsSearchProvider{}).Search(context.Background(), localFileSearchRequest{
		CandidateLimit: 20,
		Filters:        []string{"other"},
		Query:          "package.go",
		SearchRootPath: home,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(filteredPaths) == 0 {
		t.Fatal("Windows Search returned no package.go candidates for the other filter")
	}
}
