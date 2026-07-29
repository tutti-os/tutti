package storesqlite

import (
	"context"
	"slices"
	"strings"
	"testing"
)

func TestStoreListSessionsPageOwnsSearchCursorAndIncludedSessionFiltering(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	for _, report := range []ActivityStateReport{
		sectionBatchActivityReport("ws-session-page", "alpha-new", testTargetIDCodex, "/workspace/scratch", 3_000),
		sectionBatchActivityReport("ws-session-page", "alpha-old", testTargetIDCodex, "/workspace/scratch", 2_000),
		sectionBatchActivityReport("ws-session-page", "alpha-foreign", testTargetIDCodex, "/workspace/scratch", 4_000),
		sectionBatchActivityReport("ws-session-page", "beta", testTargetIDCodex, "/workspace/scratch", 5_000),
	} {
		if _, err := store.ReportActivityState(ctx, report); err != nil {
			t.Fatalf("ReportActivityState(%s) error = %v", report.Session.AgentSessionID, err)
		}
	}
	for sessionID, title := range map[string]string{
		"alpha-new":     "Alpha build plan",
		"alpha-old":     "Review alpha build",
		"alpha-foreign": "Alpha foreign",
		"beta":          "Beta build",
	} {
		if _, ok, err := store.UpdateSessionTitle(ctx, "ws-session-page", sessionID, title); err != nil || !ok {
			t.Fatalf("UpdateSessionTitle(%s) ok=%v error=%v", sessionID, ok, err)
		}
	}

	first, ok, err := store.ListSessionsPage(ctx, ListSessionsPageInput{
		WorkspaceID:        "ws-session-page",
		SearchQuery:        " alpha   build ",
		IncludedSessionIDs: []string{"alpha-new", "alpha-old", "beta"},
		Limit:              1,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionsPage(first) ok=%v error=%v", ok, err)
	}
	if got := sessionIDsFromSessions(first.Sessions); strings.Join(got, ",") != "alpha-new" {
		t.Fatalf("first session ids = %#v, want alpha-new", got)
	}
	if !first.HasMore || first.NextCursor != "3000|alpha-new" {
		t.Fatalf("first page = %#v, want stable next cursor", first)
	}

	second, ok, err := store.ListSessionsPage(ctx, ListSessionsPageInput{
		WorkspaceID:          "ws-session-page",
		SearchQuery:          "alpha build",
		IncludedSessionIDs:   []string{"alpha-new", "alpha-old", "beta"},
		CursorSortTimeUnixMS: 3_000,
		CursorSessionID:      "alpha-new",
		Limit:                1,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionsPage(second) ok=%v error=%v", ok, err)
	}
	if got := sessionIDsFromSessions(second.Sessions); strings.Join(got, ",") != "alpha-old" {
		t.Fatalf("second session ids = %#v, want alpha-old", got)
	}
	if second.HasMore || second.NextCursor != "" {
		t.Fatalf("second page = %#v, want terminal page", second)
	}
}

func TestStoreListSessionsPageAppliesTargetVisibilityAndLiteralSearchTokens(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	reports := []ActivityStateReport{
		sectionBatchActivityReport("ws-session-page-filters", "literal", testTargetIDCodex, "/workspace/scratch", 4_000),
		sectionBatchActivityReport("ws-session-page-filters", "wildcard-match", testTargetIDCodex, "/workspace/scratch", 3_000),
		sectionBatchActivityReport("ws-session-page-filters", "other-target", testTargetIDClaude, "/workspace/scratch", 2_000),
		sectionBatchActivityReport("ws-session-page-filters", "hidden", testTargetIDCodex, "/workspace/scratch", 1_000),
	}
	reports[3].Session.RuntimeContext = map[string]any{"visible": false}
	for _, report := range reports {
		if _, err := store.ReportActivityState(ctx, report); err != nil {
			t.Fatalf("ReportActivityState(%s) error = %v", report.Session.AgentSessionID, err)
		}
	}
	for sessionID, title := range map[string]string{
		"literal":        "Literal 100% _ build",
		"wildcard-match": "Literal 100X Y build",
		"other-target":   "Literal 100% _ build",
		"hidden":         "Literal 100% _ build",
	} {
		if _, ok, err := store.UpdateSessionTitle(ctx, "ws-session-page-filters", sessionID, title); err != nil || !ok {
			t.Fatalf("UpdateSessionTitle(%s) ok=%v error=%v", sessionID, ok, err)
		}
	}

	page, ok, err := store.ListSessionsPage(ctx, ListSessionsPageInput{
		WorkspaceID:   "ws-session-page-filters",
		AgentTargetID: testTargetIDCodex,
		SearchQuery:   "100% _",
		Limit:         10,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionsPage() ok=%v error=%v", ok, err)
	}
	if got := sessionIDsFromSessions(page.Sessions); !slices.Equal(got, []string{"literal"}) {
		t.Fatalf("session ids = %#v, want only visible exact-target literal match", got)
	}
}

func TestStoreSessionPagesUseSessionStartBeforePersistenceTimeWithoutTurns(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{paths: []string{"/workspace/app"}}))
	ctx := context.Background()
	reports := []ActivityStateReport{
		sectionBatchActivityReport("ws-session-start-order", "started-older", testTargetIDCodex, "/workspace/app", 2_000),
		sectionBatchActivityReport("ws-session-start-order", "started-newer", testTargetIDCodex, "/workspace/app", 3_000),
	}
	reports[0].Turn = nil
	reports[0].Session.StartedAtUnixMS = 2_000
	reports[0].Session.CreatedAtUnixMS = 5_000
	reports[1].Turn = nil
	reports[1].Session.StartedAtUnixMS = 3_000
	reports[1].Session.CreatedAtUnixMS = 4_000
	for _, report := range reports {
		if _, err := store.ReportActivityState(ctx, report); err != nil {
			t.Fatalf("ReportActivityState(%s) error = %v", report.Session.AgentSessionID, err)
		}
	}

	page, ok, err := store.ListSessionsPage(ctx, ListSessionsPageInput{
		WorkspaceID: "ws-session-start-order",
		Limit:       10,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionsPage() ok=%v error=%v", ok, err)
	}
	if got := sessionIDsFromSessions(page.Sessions); !slices.Equal(got, []string{"started-newer", "started-older"}) {
		t.Fatalf("session page ids = %#v, want session start order", got)
	}

	section, ok, err := store.ListSessionSection(ctx, ListSessionSectionInput{
		WorkspaceID: "ws-session-start-order",
		SectionKey:  RailSectionKeyForProject("/workspace/app"),
		Limit:       10,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSection() ok=%v error=%v", ok, err)
	}
	if got := sessionIDsFromSessions(section.Sessions); !slices.Equal(got, []string{"started-newer", "started-older"}) {
		t.Fatalf("section page ids = %#v, want session start order", got)
	}
}

func TestStoreRailQueriesApplyIncludedSessionIDsBeforePagingAndCounting(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{paths: []string{"/workspace/app"}}))
	ctx := context.Background()
	for _, report := range []ActivityStateReport{
		sectionBatchActivityReport("ws-included-rail", "owned-new", testTargetIDCodex, "/workspace/app", 3_000),
		sectionBatchActivityReport("ws-included-rail", "owned-old", testTargetIDCodex, "/workspace/app", 2_000),
		sectionBatchActivityReport("ws-included-rail", "foreign", testTargetIDCodex, "/workspace/app", 4_000),
		sectionBatchActivityReport("ws-included-rail", "owned-pinned", testTargetIDCodex, "/workspace/app", 5_000),
	} {
		if _, err := store.ReportActivityState(ctx, report); err != nil {
			t.Fatalf("ReportActivityState(%s) error = %v", report.Session.AgentSessionID, err)
		}
	}
	if _, ok, err := store.UpdateSessionPinned(ctx, "ws-included-rail", "owned-pinned", true); err != nil || !ok {
		t.Fatalf("UpdateSessionPinned() ok=%v error=%v", ok, err)
	}
	included := []string{"owned-new", "owned-old", "owned-pinned"}
	projectKey := RailSectionKeyForProject("/workspace/app")
	sections, ok, err := store.ListSessionSections(ctx, ListSessionSectionsInput{
		WorkspaceID:        "ws-included-rail",
		SectionKeys:        []string{PinnedSessionPageKey, projectKey},
		IncludedSessionIDs: included,
		LimitPerSection:    1,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSections() ok=%v error=%v", ok, err)
	}
	pages := map[string]SessionSectionPage{}
	for _, page := range sections.Sections {
		pages[page.SectionKey] = page
	}
	assertSectionBatchPage(t, pages[PinnedSessionPageKey], []string{"owned-pinned"}, 1, false)
	assertSectionBatchPage(t, pages[projectKey], []string{"owned-new"}, 2, true)

	candidates, ok, err := store.ListSessionSectionDeletionCandidates(ctx, ListSessionSectionDeletionCandidatesInput{
		WorkspaceID:        "ws-included-rail",
		SectionKey:         projectKey,
		IncludedSessionIDs: included,
		ExcludePinned:      true,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSectionDeletionCandidates() ok=%v error=%v", ok, err)
	}
	slices.Sort(candidates.SessionIDs)
	if got := strings.Join(candidates.SessionIDs, ","); got != "owned-new,owned-old" {
		t.Fatalf("candidate session ids = %q, want owned-new,owned-old", got)
	}
}

func sessionIDsFromSessions(sessions []Session) []string {
	result := make([]string, 0, len(sessions))
	for _, session := range sessions {
		result = append(result, session.ID)
	}
	return result
}
