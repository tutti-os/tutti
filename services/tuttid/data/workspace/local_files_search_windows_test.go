//go:build windows

package workspace

import (
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
