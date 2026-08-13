//go:build darwin

package workspace

import (
	"strings"
	"testing"
)

func TestSpotlightFilterClauseExcludesKnownTypesForOther(t *testing.T) {
	clause := spotlightFilterClause([]string{"other"})

	for _, expected := range []string{
		"kMDItemFSName != '*.png'cd",
		"kMDItemFSName != '*.pdf'cd",
	} {
		if !strings.Contains(clause, expected) {
			t.Fatalf("clause %q does not contain %q", clause, expected)
		}
	}
	if strings.Contains(clause, "kMDItemFSName == '*'cd") {
		t.Fatalf("other clause must filter known types before candidate truncation: %q", clause)
	}
}

func TestSpotlightFilterClauseCombinesKnownAndOtherTypes(t *testing.T) {
	clause := spotlightFilterClause([]string{"image", "other"})

	if !strings.Contains(clause, "kMDItemFSName == '*.png'cd") ||
		!strings.Contains(clause, "kMDItemFSName != '*.pdf'cd") {
		t.Fatalf("combined clause does not preserve selected known and other types: %q", clause)
	}
}

func TestSpotlightSearchQueryExcludesDirectoriesBeforeCandidateLimit(t *testing.T) {
	query := spotlightSearchQuery(localFileSearchRequest{Filters: []string{"other"}})

	if !strings.Contains(query, "kMDItemContentTypeTree != 'public.directory'") {
		t.Fatalf("query %q does not exclude directories", query)
	}
}

func TestSpotlightSearchQueryExcludesNoiseBeforeCandidateLimit(t *testing.T) {
	query := spotlightSearchQuery(localFileSearchRequest{})

	for _, expected := range []string{
		"kMDItemPath != '*/node_modules/*'cd",
		"kMDItemPath != '*/node_modules'cd",
	} {
		if !strings.Contains(query, expected) {
			t.Fatalf("query %q does not contain %q", query, expected)
		}
	}
}

func TestSpotlightSearchQueryIncludesNoiseWhenIncludeHiddenIsEnabled(t *testing.T) {
	query := spotlightSearchQuery(localFileSearchRequest{IncludeHidden: true})

	if strings.Contains(query, "kMDItemPath != '*/node_modules/*'cd") {
		t.Fatalf("query %q excludes noise despite IncludeHidden", query)
	}
}
