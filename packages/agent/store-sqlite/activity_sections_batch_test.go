package storesqlite

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
)

func TestStoreListSessionSectionsBatchesFilteredFirstPages(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{paths: []string{
		"/workspace/app",
		"/workspace/empty",
	}}))
	ctx := context.Background()
	for _, report := range []ActivityStateReport{
		sectionBatchActivityReport("ws-sections-batch", "project-newer", testTargetIDCodex, "/workspace/app", 3_000),
		sectionBatchActivityReport("ws-sections-batch", "project-older", testTargetIDCodex, "/workspace/app", 2_000),
		sectionBatchActivityReport("ws-sections-batch", "project-other-target", testTargetIDClaude, "/workspace/app", 4_000),
		sectionBatchActivityReport("ws-sections-batch", "pinned-project", testTargetIDCodex, "/workspace/app", 5_000),
		sectionBatchActivityReport("ws-sections-batch", "chat", testTargetIDCodex, "/workspace/scratch", 1_000),
	} {
		if _, err := store.ReportActivityState(ctx, report); err != nil {
			t.Fatalf("ReportActivityState(%s) error = %v", report.Session.AgentSessionID, err)
		}
	}
	if _, ok, err := store.UpdateSessionPinned(ctx, "ws-sections-batch", "pinned-project", true); err != nil || !ok {
		t.Fatalf("UpdateSessionPinned() ok=%v error=%v", ok, err)
	}

	projectKey := RailSectionKeyForProject("/workspace/app")
	emptyProjectKey := RailSectionKeyForProject("/workspace/empty")
	result, ok, err := store.ListSessionSections(ctx, ListSessionSectionsInput{
		WorkspaceID: "ws-sections-batch",
		SectionKeys: []string{
			PinnedSessionPageKey,
			projectKey,
			emptyProjectKey,
			RailSectionKeyConversations,
		},
		AgentTargetID:   testTargetIDCodex,
		LimitPerSection: 1,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSections() ok=%v error=%v", ok, err)
	}
	if len(result.Sections) != 4 {
		t.Fatalf("sections = %d, want 4", len(result.Sections))
	}
	pages := make(map[string]SessionSectionPage, len(result.Sections))
	for _, page := range result.Sections {
		pages[page.SectionKey] = page
	}
	assertSectionBatchPage(t, pages[PinnedSessionPageKey], []string{"pinned-project"}, 1, false)
	assertSectionBatchPage(t, pages[projectKey], []string{"project-newer"}, 2, true)
	if pages[projectKey].NextCursor != "3000|project-newer" {
		t.Fatalf("project cursor = %q, want latest-turn cursor", pages[projectKey].NextCursor)
	}
	assertSectionBatchPage(t, pages[emptyProjectKey], nil, 0, false)
	assertSectionBatchPage(t, pages[RailSectionKeyConversations], []string{"chat"}, 1, false)
}

func TestStoreListSessionSectionsUsesRequestedSectionIndexes(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	sectionKeys := []string{
		PinnedSessionPageKey,
		RailSectionKeyForProject("/workspace/app"),
		RailSectionKeyForProject("/workspace/other"),
		RailSectionKeyConversations,
	}
	query, args, err := buildListSessionSectionsQuery(ListSessionSectionsInput{
		WorkspaceID:     "ws-section-plan",
		SectionKeys:     sectionKeys,
		AgentTargetID:   testTargetIDCodex,
		LimitPerSection: 5,
	})
	if err != nil {
		t.Fatalf("buildListSessionSectionsQuery() error = %v", err)
	}
	if strings.Contains(query, "SELECT sessions.*") {
		t.Fatal("batch query must rank narrow session ids before loading full session rows")
	}
	if strings.Contains(query, "UNION ALL") {
		t.Fatal("batch query must not grow compound SELECT arms with section count")
	}
	if got := strings.Count(query, "SELECT latest.started_at_unix_ms"); got != 1 {
		t.Fatalf("latest-turn expressions = %d, want one ordinary-section expression", got)
	}

	rows, err := store.db.QueryContext(context.Background(), "EXPLAIN QUERY PLAN "+query, args...)
	if err != nil {
		t.Fatalf("EXPLAIN QUERY PLAN error = %v", err)
	}
	defer rows.Close()
	planDetails := make([]string, 0)
	for rows.Next() {
		var id, parent, unused int
		var detail string
		if err := rows.Scan(&id, &parent, &unused, &detail); err != nil {
			t.Fatalf("scan query plan error = %v", err)
		}
		planDetails = append(planDetails, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate query plan error = %v", err)
	}
	plan := strings.Join(planDetails, "\n")
	if !strings.Contains(plan, "idx_workspace_agent_sessions_pinned_target_page") {
		t.Fatalf("query plan does not use target-scoped pinned index:\n%s", plan)
	}
	if got := strings.Count(plan, "idx_workspace_agent_sessions_rail_section_target_page"); got != 2 {
		t.Fatalf("target-scoped rail-section index uses = %d, want indexed count and page reads:\n%s", got, plan)
	}
	if got := strings.Count(plan, "idx_workspace_agent_sessions_pinned_target_page"); got != 2 {
		t.Fatalf("target-scoped pinned index uses = %d, want indexed count and page reads:\n%s", got, plan)
	}
	if got := strings.Count(plan, "idx_workspace_agent_turns_session_latest"); got < 1 || got > 2 {
		t.Fatalf("latest-turn index uses = %d, want one page sort expression:\n%s", got, plan)
	}
	if strings.Contains(plan, "SCAN sessions") {
		t.Fatalf("query plan scans workspace sessions instead of requested indexes:\n%s", plan)
	}
	if !strings.Contains(plan, "sqlite_autoindex_workspace_agent_sessions_1") {
		t.Fatalf("query plan does not load page rows by session primary key:\n%s", plan)
	}
}

func TestStoreListSessionSectionsDoesNotDependOnCompoundSelectLimit(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	sectionKeys := []string{PinnedSessionPageKey}
	for index := range 600 {
		sectionKeys = append(sectionKeys, RailSectionKeyForProject(fmt.Sprintf("/workspace/project-%03d", index)))
	}
	sectionKeys = append(sectionKeys, RailSectionKeyConversations)
	page, ok, err := store.ListSessionSections(context.Background(), ListSessionSectionsInput{
		WorkspaceID:     "ws-many-sections",
		SectionKeys:     sectionKeys,
		LimitPerSection: 5,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSections(%d sections) ok=%v error=%v", len(sectionKeys), ok, err)
	}
	if len(page.Sections) != len(sectionKeys) {
		t.Fatalf("sections = %d, want %d", len(page.Sections), len(sectionKeys))
	}
	for _, section := range page.Sections {
		if len(section.Sessions) != 0 || section.TotalCount != 0 || section.HasMore || section.NextCursor != "" {
			t.Fatalf("empty section %q = %#v", section.SectionKey, section)
		}
	}
}

func TestStoreListSessionSectionsPropagatesCanceledContext(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, ok, err := store.ListSessionSections(ctx, ListSessionSectionsInput{
		WorkspaceID:     "ws-sections-canceled",
		SectionKeys:     []string{PinnedSessionPageKey, RailSectionKeyConversations},
		LimitPerSection: 5,
	})
	if ok || !errors.Is(err, context.Canceled) {
		t.Fatalf("ListSessionSections() ok=%v error=%v, want context.Canceled", ok, err)
	}
}

func TestStoreMigrationRepairsMissingPinnedPageIndexWithAppliedMarker(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if applied, err := store.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityV9); err != nil || !applied {
		t.Fatalf("pinned index migration marker applied = %v, error = %v", applied, err)
	}
	if _, err := store.db.ExecContext(ctx, `
DROP INDEX idx_workspace_agent_sessions_pinned_page;
`); err != nil {
		t.Fatalf("prepare missing pinned index error = %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	var count int
	if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(1)
FROM sqlite_master
WHERE type = 'index' AND name = 'idx_workspace_agent_sessions_pinned_page'
`).Scan(&count); err != nil {
		t.Fatalf("inspect pinned index error = %v", err)
	}
	if count != 1 {
		t.Fatalf("pinned page index count = %d, want 1", count)
	}
}

func TestStoreMigrationRepairsMissingTargetRailIndexesWithAppliedMarker(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if applied, err := store.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityV10); err != nil || !applied {
		t.Fatalf("target index migration marker applied = %v, error = %v", applied, err)
	}
	if _, err := store.db.ExecContext(ctx, `
DROP INDEX idx_workspace_agent_sessions_rail_section_target_page;
DROP INDEX idx_workspace_agent_sessions_pinned_target_page;
`); err != nil {
		t.Fatalf("prepare missing target-scoped indexes error = %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	var count int
	if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(1)
FROM sqlite_master
WHERE type = 'index' AND name IN (
  'idx_workspace_agent_sessions_rail_section_target_page',
  'idx_workspace_agent_sessions_pinned_target_page'
)
`).Scan(&count); err != nil {
		t.Fatalf("inspect target-scoped indexes error = %v", err)
	}
	if count != 2 {
		t.Fatalf("target-scoped rail index count = %d, want 2", count)
	}
}

func sectionBatchActivityReport(
	workspaceID string,
	sessionID string,
	agentTargetID string,
	cwd string,
	turnStartedAtUnixMS int64,
) ActivityStateReport {
	provider := "codex"
	if agentTargetID == testTargetIDClaude {
		provider = "claude-code"
	}
	return ActivityStateReport{
		Session: SessionStateReport{
			WorkspaceID:      workspaceID,
			AgentSessionID:   sessionID,
			Origin:           "runtime",
			AgentTargetID:    agentTargetID,
			Provider:         provider,
			Cwd:              cwd,
			Status:           "working",
			OccurredAtUnixMS: turnStartedAtUnixMS,
		},
		Turn: &TurnTransition{
			WorkspaceID:      workspaceID,
			AgentSessionID:   sessionID,
			TurnID:           "turn-" + sessionID,
			Phase:            TurnPhaseRunning,
			StartedAtUnixMS:  turnStartedAtUnixMS,
			OccurredAtUnixMS: turnStartedAtUnixMS,
		},
	}
}

func assertSectionBatchPage(
	t *testing.T,
	page SessionSectionPage,
	wantSessionIDs []string,
	wantTotal int,
	wantHasMore bool,
) {
	t.Helper()
	gotSessionIDs := make([]string, 0, len(page.Sessions))
	for _, session := range page.Sessions {
		gotSessionIDs = append(gotSessionIDs, session.ID)
	}
	if len(gotSessionIDs) != len(wantSessionIDs) {
		t.Fatalf("section %q session ids = %#v, want %#v", page.SectionKey, gotSessionIDs, wantSessionIDs)
	}
	for i := range wantSessionIDs {
		if gotSessionIDs[i] != wantSessionIDs[i] {
			t.Fatalf("section %q session ids = %#v, want %#v", page.SectionKey, gotSessionIDs, wantSessionIDs)
		}
	}
	if page.TotalCount != wantTotal || page.HasMore != wantHasMore {
		t.Fatalf(
			"section %q total=%d hasMore=%v, want total=%d hasMore=%v",
			page.SectionKey,
			page.TotalCount,
			page.HasMore,
			wantTotal,
			wantHasMore,
		)
	}
}
