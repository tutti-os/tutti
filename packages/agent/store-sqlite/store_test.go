package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"
)

var errTestWorkspaceNotFound = errors.New("workspace not found")

const (
	testTargetIDCodex  = "local:codex"
	testTargetIDClaude = "local:claude-code"
)

type staticProjectPaths struct {
	paths []string
}

func (s *staticProjectPaths) ProjectPaths(context.Context, Querier) ([]string, error) {
	return append([]string(nil), s.paths...), nil
}

func testSeedTargets(now int64) []Target {
	return []Target{
		{
			ID:              testTargetIDCodex,
			Provider:        "codex",
			LaunchRefJSON:   `{"type":"local_cli","provider":"codex"}`,
			Name:            "Codex",
			IconKey:         "codex",
			Enabled:         true,
			Source:          "system",
			SortOrder:       10,
			CreatedAtUnixMS: now,
			UpdatedAtUnixMS: now,
		},
		{
			ID:              testTargetIDClaude,
			Provider:        "claude-code",
			LaunchRefJSON:   `{"type":"local_cli","provider":"claude-code"}`,
			Name:            "Claude Code",
			IconKey:         "claude-code",
			Enabled:         true,
			Source:          "system",
			SortOrder:       20,
			CreatedAtUnixMS: now,
			UpdatedAtUnixMS: now,
		},
	}
}

func testOptions(projects *staticProjectPaths) Options {
	return Options{
		ProjectPaths:      projects,
		SeedSystemTargets: testSeedTargets,
		LegacySystemTargetIDRenames: map[string]string{
			"local-codex":       testTargetIDCodex,
			"local-claude-code": testTargetIDClaude,
		},
		TargetIDBackfillByProvider: map[string]string{
			"codex":       testTargetIDCodex,
			"claude-code": testTargetIDClaude,
		},
	}
}

func openTestDB(t testing.TB) *sql.DB {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "agent-store.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite database: %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})
	db.SetMaxOpenConns(1)
	for _, pragma := range []string{
		"PRAGMA busy_timeout = 5000",
		"PRAGMA foreign_keys = ON",
		"PRAGMA journal_mode = WAL",
	} {
		if _, err := db.Exec(pragma); err != nil {
			t.Fatalf("%s: %v", pragma, err)
		}
	}
	return db
}

func openTestStore(t testing.TB, opts Options) *Store {
	t.Helper()
	store := New(openTestDB(t), opts)
	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	return store
}

func TestStoreFreshMigrateCreatesSessionTurnReferenceWithoutHostForeignKey(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	rows, err := store.db.QueryContext(ctx, `PRAGMA foreign_key_list(workspace_agent_sessions)`)
	if err != nil {
		t.Fatalf("foreign_key_list error = %v", err)
	}
	defer rows.Close()
	hasTurnsFK := false
	hasHostFK := false
	for rows.Next() {
		var id, seq int
		var table, from, to, onUpdate, onDelete, match string
		if err := rows.Scan(&id, &seq, &table, &from, &to, &onUpdate, &onDelete, &match); err != nil {
			t.Fatalf("scan foreign_key_list: %v", err)
		}
		hasTurnsFK = hasTurnsFK || table == "workspace_agent_turns"
		hasHostFK = hasHostFK || table == "workspaces"
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate foreign_key_list: %v", err)
	}
	if !hasTurnsFK || hasHostFK {
		t.Fatalf("session foreign keys turns=%v host=%v, want exact turn reference without host coupling", hasTurnsFK, hasHostFK)
	}

	targets, err := store.ListAgentTargets(ctx)
	if err != nil {
		t.Fatalf("ListAgentTargets() error = %v", err)
	}
	if len(targets) != 2 || targets[0].ID != testTargetIDCodex || targets[1].ID != testTargetIDClaude {
		t.Fatalf("seeded targets = %#v, want codex and claude-code system targets", targets)
	}
}

func TestStoreMigrateRefreshesOnlySystemSeedTargets(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.db.ExecContext(ctx, `
UPDATE agent_targets
SET provider = 'stale-provider', launch_ref_json = '{}', name = 'Stale Codex',
    icon_key = 'stale', enabled = 0, sort_order = 999, created_at_ms = 7, updated_at_ms = 8
WHERE id = ?;
`, testTargetIDCodex); err != nil {
		t.Fatalf("seed stale system target: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE agent_targets
SET provider = 'custom-provider', launch_ref_json = '{"custom":true}', name = 'Custom',
    icon_key = 'custom', enabled = 0, source = 'user', sort_order = 777,
    created_at_ms = 9, updated_at_ms = 10
WHERE id = ?;
`, testTargetIDClaude); err != nil {
		t.Fatalf("seed custom target: %v", err)
	}

	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	var codex Target
	if err := store.db.QueryRowContext(ctx, `
SELECT id, provider, launch_ref_json, name, icon_key, enabled, source, sort_order, created_at_ms, updated_at_ms
FROM agent_targets WHERE id = ?
`, testTargetIDCodex).Scan(&codex.ID, &codex.Provider, &codex.LaunchRefJSON, &codex.Name, &codex.IconKey, &codex.Enabled, &codex.Source, &codex.SortOrder, &codex.CreatedAtUnixMS, &codex.UpdatedAtUnixMS); err != nil {
		t.Fatalf("query refreshed codex target: %v", err)
	}
	if codex.Provider != "codex" || codex.LaunchRefJSON != `{"type":"local_cli","provider":"codex"}` ||
		codex.Name != "Codex" || codex.IconKey != "codex" || !codex.Enabled || codex.SortOrder != 10 {
		t.Fatalf("refreshed system target = %#v", codex)
	}
	if codex.CreatedAtUnixMS != 7 || codex.Source != systemTargetSource || codex.UpdatedAtUnixMS == 8 {
		t.Fatalf("system target preserved fields/timestamp = %#v", codex)
	}
	refreshedAt := codex.UpdatedAtUnixMS
	if err := store.seedSystemAgentTargets(ctx, refreshedAt+1000); err != nil {
		t.Fatalf("seed unchanged system targets: %v", err)
	}
	if err := store.db.QueryRowContext(ctx, `SELECT updated_at_ms FROM agent_targets WHERE id = ?`, testTargetIDCodex).Scan(&codex.UpdatedAtUnixMS); err != nil {
		t.Fatalf("query unchanged codex target: %v", err)
	}
	if codex.UpdatedAtUnixMS != refreshedAt {
		t.Fatalf("unchanged system target updated_at_ms = %d, want %d", codex.UpdatedAtUnixMS, refreshedAt)
	}

	var custom Target
	if err := store.db.QueryRowContext(ctx, `
SELECT id, provider, launch_ref_json, name, icon_key, enabled, source, sort_order, created_at_ms, updated_at_ms
FROM agent_targets WHERE id = ?
`, testTargetIDClaude).Scan(&custom.ID, &custom.Provider, &custom.LaunchRefJSON, &custom.Name, &custom.IconKey, &custom.Enabled, &custom.Source, &custom.SortOrder, &custom.CreatedAtUnixMS, &custom.UpdatedAtUnixMS); err != nil {
		t.Fatalf("query custom target: %v", err)
	}
	if custom.Provider != "custom-provider" || custom.LaunchRefJSON != `{"custom":true}` || custom.Name != "Custom" ||
		custom.IconKey != "custom" || custom.Enabled || custom.Source != "user" || custom.SortOrder != 777 ||
		custom.CreatedAtUnixMS != 9 || custom.UpdatedAtUnixMS != 10 {
		t.Fatalf("custom target was overwritten = %#v", custom)
	}
}

func TestStoreReportAndListSessionLifecycle(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	state, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:       "ws-1",
		AgentSessionID:    "session-1",
		Origin:            "runtime",
		UserID:            "user-1",
		Provider:          "codex",
		ProviderSessionID: "provider-1",
		Cwd:               "/workspace",
		Title:             "hello",
		Status:            "running",
		OccurredAtUnixMS:  100,
	})
	if err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if !state.Accepted || state.LastEventUnixMS != 100 {
		t.Fatalf("state result = %#v", state)
	}
	if state.Session.UserID != "user-1" {
		t.Fatalf("state session user id = %q", state.Session.UserID)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseRunning, OccurredAtUnixMS: 105,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition accepted=%v error=%v", accepted, err)
	}

	first, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Origin:         "runtime",
		Messages: []MessageUpdate{{
			MessageID:        "message-1",
			TurnID:           "turn-1",
			Role:             "assistant",
			Kind:             "text",
			Status:           "running",
			Payload:          map[string]any{"text": "hel"},
			OccurredAtUnixMS: 110,
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages(first) error = %v", err)
	}
	if first.AcceptedCount != 1 || first.LatestVersion != 1 {
		t.Fatalf("first result = %#v", first)
	}
	second, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Origin:         "runtime",
		Messages: []MessageUpdate{{
			MessageID:         "message-1",
			Status:            "completed",
			ContentDelta:      "lo",
			CompletedAtUnixMS: 120,
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages(second) error = %v", err)
	}
	if second.AcceptedCount != 1 || second.LatestVersion != 2 {
		t.Fatalf("second result = %#v", second)
	}

	page, ok, err := store.ListSessionMessages(ctx, ListSessionMessagesInput{
		WorkspaceID:    "ws-1",
		AgentSessionID: "session-1",
		Limit:          10,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionMessages() ok=%v error=%v", ok, err)
	}
	if len(page.Messages) != 1 || page.LatestVersion != 2 || page.Messages[0].Payload["text"] != "hello" {
		t.Fatalf("page = %#v, want merged message payload", page)
	}
	session, ok, err := store.GetSession(ctx, "ws-1", "session-1")
	if err != nil || !ok || session.UserID != "user-1" {
		t.Fatalf("GetSession() = %#v ok=%v error=%v, want user id", session, ok, err)
	}

	pinned, ok, err := store.UpdateSessionPinned(ctx, "ws-1", "session-1", true)
	if err != nil || !ok || pinned.PinnedAtUnixMS <= 0 {
		t.Fatalf("UpdateSessionPinned() = %#v ok=%v error=%v", pinned, ok, err)
	}

	renamed, ok, err := store.UpdateSessionTitle(ctx, "ws-1", "session-1", "  Renamed session  ")
	if err != nil || !ok || renamed.Title != "Renamed session" || renamed.UpdatedAtUnixMS < pinned.UpdatedAtUnixMS {
		t.Fatalf("UpdateSessionTitle() = %#v ok=%v error=%v", renamed, ok, err)
	}

	blankRenamed, ok, err := store.UpdateSessionTitle(ctx, "ws-1", "session-1", "   ")
	if err != nil || ok {
		t.Fatalf("UpdateSessionTitle(blank) = %#v ok=%v error=%v, want no update", blankRenamed, ok, err)
	}
	sessionAfterBlankTitle, ok, err := store.GetSession(ctx, "ws-1", "session-1")
	if err != nil || !ok || sessionAfterBlankTitle.Title != "Renamed session" {
		t.Fatalf("GetSession() after blank title = %#v ok=%v error=%v", sessionAfterBlankTitle, ok, err)
	}

	removed, err := store.DeleteSession(ctx, "ws-1", "session-1")
	if err != nil || !removed {
		t.Fatalf("DeleteSession() removed=%v error=%v", removed, err)
	}
	if _, ok, err := store.GetSession(ctx, "ws-1", "session-1"); err != nil || ok {
		t.Fatalf("GetSession() after delete ok=%v error=%v", ok, err)
	}

	result, err := store.ClearSessions(ctx, "ws-1")
	if err != nil {
		t.Fatalf("ClearSessions() error = %v", err)
	}
	if result.RemovedSessions != 1 || result.RemovedMessages != 1 {
		t.Fatalf("ClearSessions() = %#v, want tombstoned rows hard-deleted", result)
	}
}

func TestStoreClearSessionsTxJoinsCallerTransaction(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:      "ws-tx",
		AgentSessionID:   "session-1",
		Origin:           "runtime",
		Provider:         "codex",
		Status:           "completed",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}

	// A rollback of the caller's transaction must undo the clear.
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("BeginTx() error = %v", err)
	}
	result, err := store.ClearSessionsTx(ctx, tx, "ws-tx")
	if err != nil {
		t.Fatalf("ClearSessionsTx() error = %v", err)
	}
	if result.RemovedSessions != 1 {
		t.Fatalf("ClearSessionsTx() = %#v, want one removed session", result)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("Rollback() error = %v", err)
	}
	if _, ok, err := store.GetSession(ctx, "ws-tx", "session-1"); err != nil || !ok {
		t.Fatalf("GetSession() after rollback ok=%v error=%v, want session restored", ok, err)
	}

	// A committed transaction applies it.
	tx, err = store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("BeginTx(second) error = %v", err)
	}
	if _, err := store.ClearSessionsTx(ctx, tx, "ws-tx"); err != nil {
		t.Fatalf("ClearSessionsTx(second) error = %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("Commit() error = %v", err)
	}
	if _, ok, err := store.GetSession(ctx, "ws-tx", "session-1"); err != nil || ok {
		t.Fatalf("GetSession() after commit ok=%v error=%v, want cleared", ok, err)
	}
}

func TestStoreWorkspaceExistsCallbackGatesWrites(t *testing.T) {
	t.Parallel()

	opts := testOptions(&staticProjectPaths{})
	opts.WorkspaceExists = func(_ context.Context, workspaceID string) error {
		if workspaceID != "ws-known" {
			return errTestWorkspaceNotFound
		}
		return nil
	}
	store := openTestStore(t, opts)
	ctx := context.Background()

	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:    "ws-unknown",
		AgentSessionID: "session-1",
		Status:         "running",
	}); !errors.Is(err, errTestWorkspaceNotFound) {
		t.Fatalf("ReportSessionState(unknown) error = %v, want workspace not found", err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:    "ws-known",
		AgentSessionID: "session-1",
		Status:         "running",
	}); err != nil {
		t.Fatalf("ReportSessionState(known) error = %v", err)
	}
	if _, _, err := store.ListWorkspaceGeneratedFiles(ctx, ListWorkspaceGeneratedFilesInput{
		WorkspaceID: "ws-unknown",
	}); !errors.Is(err, errTestWorkspaceNotFound) {
		t.Fatalf("ListWorkspaceGeneratedFiles(unknown) error = %v, want workspace not found", err)
	}
}

func TestStoreClassifiesRailSectionsWithInjectedProjectPaths(t *testing.T) {
	t.Parallel()

	projects := &staticProjectPaths{}
	store := openTestStore(t, testOptions(projects))
	ctx := context.Background()

	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	repoSubdir := filepath.Join(repo, "pkg")
	otherDir := filepath.Join(root, "other")
	for _, path := range []string{repoSubdir, otherDir} {
		if err := mkdirAll(path); err != nil {
			t.Fatalf("mkdir %q error = %v", path, err)
		}
	}
	projects.paths = []string{repo}
	repoCanonical := NormalizeProjectPath(repo)

	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:      "ws-rail",
		AgentSessionID:   "session-project",
		Origin:           "runtime",
		Provider:         "codex",
		Cwd:              repoSubdir,
		Status:           "completed",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState(project) error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:      "ws-rail",
		AgentSessionID:   "session-other",
		Origin:           "runtime",
		Provider:         "codex",
		Cwd:              otherDir,
		Status:           "completed",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState(other) error = %v", err)
	}

	projectPage, ok, err := store.ListSessionSection(ctx, ListSessionSectionInput{
		WorkspaceID: "ws-rail",
		SectionKey:  RailSectionKeyForProject(repoCanonical),
		Limit:       10,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSection(project) ok=%v error=%v", ok, err)
	}
	if len(projectPage.Sessions) != 1 || projectPage.Sessions[0].ID != "session-project" {
		t.Fatalf("project page = %#v, want session-project", projectPage.Sessions)
	}

	conversationsPage, ok, err := store.ListSessionSection(ctx, ListSessionSectionInput{
		WorkspaceID: "ws-rail",
		SectionKey:  RailSectionKeyConversations,
		Limit:       10,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSection(conversations) ok=%v error=%v", ok, err)
	}
	if len(conversationsPage.Sessions) != 1 || conversationsPage.Sessions[0].ID != "session-other" {
		t.Fatalf("conversations page = %#v, want session-other", conversationsPage.Sessions)
	}
}

func TestStoreListSessionSectionFiltersHiddenSessionsBeforePagination(t *testing.T) {
	t.Parallel()

	projects := &staticProjectPaths{paths: []string{"/workspace/app"}}
	store := openTestStore(t, testOptions(projects))
	ctx := context.Background()

	for _, input := range []SessionStateReport{
		{
			WorkspaceID:      "ws-rail-visible",
			AgentSessionID:   "bbb-visible-newer",
			Origin:           "runtime",
			Provider:         "codex",
			Cwd:              "/workspace/app",
			Title:            "visible newer",
			Status:           "completed",
			OccurredAtUnixMS: 100,
		},
		{
			WorkspaceID:      "ws-rail-visible",
			AgentSessionID:   "ccc-visible-older",
			Origin:           "runtime",
			Provider:         "codex",
			Cwd:              "/workspace/app",
			Title:            "visible older",
			Status:           "completed",
			RuntimeContext:   map[string]any{"visible": true},
			OccurredAtUnixMS: 100,
		},
		{
			WorkspaceID:      "ws-rail-visible",
			AgentSessionID:   "aaa-hidden",
			Origin:           "runtime",
			Provider:         "claude-code",
			Cwd:              "/workspace/app",
			Title:            "hidden",
			Status:           "completed",
			RuntimeContext:   map[string]any{"visible": false},
			OccurredAtUnixMS: 100,
		},
	} {
		if _, err := store.ReportSessionState(ctx, input); err != nil {
			t.Fatalf("ReportSessionState(%s) error = %v", input.AgentSessionID, err)
		}
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET updated_at_unix_ms = 1000
WHERE workspace_id = ?`, "ws-rail-visible"); err != nil {
		t.Fatalf("normalize updated_at_unix_ms error = %v", err)
	}

	page, ok, err := store.ListSessionSection(ctx, ListSessionSectionInput{
		WorkspaceID: "ws-rail-visible",
		SectionKey:  RailSectionKeyForProject("/workspace/app"),
		Limit:       1,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSection(first) ok=%v error=%v", ok, err)
	}
	if len(page.Sessions) != 1 || page.Sessions[0].ID != "bbb-visible-newer" {
		t.Fatalf("first page sessions = %#v, want bbb-visible-newer", page.Sessions)
	}
	if !page.HasMore || !strings.HasSuffix(page.NextCursor, "|bbb-visible-newer") {
		t.Fatalf("first page state = hasMore %v cursor %q, want visible cursor with more", page.HasMore, page.NextCursor)
	}

	next, ok, err := store.ListSessionSection(ctx, ListSessionSectionInput{
		WorkspaceID:       "ws-rail-visible",
		SectionKey:        RailSectionKeyForProject("/workspace/app"),
		CursorUpdatedAtMS: page.Sessions[0].UpdatedAtUnixMS,
		CursorSessionID:   page.Sessions[0].ID,
		Limit:             1,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSection(next) ok=%v error=%v", ok, err)
	}
	if len(next.Sessions) != 1 || next.Sessions[0].ID != "ccc-visible-older" {
		t.Fatalf("next page sessions = %#v, want ccc-visible-older", next.Sessions)
	}
	if next.HasMore || next.NextCursor != "" {
		t.Fatalf("next page state = hasMore %v cursor %q, want exhausted", next.HasMore, next.NextCursor)
	}
}

func TestStoreListPinnedSessionPageOrdersByPinnedTime(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	for _, input := range []SessionStateReport{
		{
			WorkspaceID:      "ws-pinned-page",
			AgentSessionID:   "newer-pinned",
			Origin:           "runtime",
			Provider:         "codex",
			Status:           "completed",
			OccurredAtUnixMS: 100,
		},
		{
			WorkspaceID:      "ws-pinned-page",
			AgentSessionID:   "older-pinned",
			Origin:           "runtime",
			Provider:         "codex",
			Status:           "completed",
			OccurredAtUnixMS: 100,
		},
		{
			WorkspaceID:      "ws-pinned-page",
			AgentSessionID:   "unpinned",
			Origin:           "runtime",
			Provider:         "codex",
			Status:           "completed",
			OccurredAtUnixMS: 100,
		},
	} {
		if _, err := store.ReportSessionState(ctx, input); err != nil {
			t.Fatalf("ReportSessionState(%s) error = %v", input.AgentSessionID, err)
		}
	}
	for sessionID, pinnedAt := range map[string]int64{
		"newer-pinned": 2000,
		"older-pinned": 1000,
	} {
		if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET pinned_at_unix_ms = ?
WHERE workspace_id = ? AND agent_session_id = ?`, pinnedAt, "ws-pinned-page", sessionID); err != nil {
			t.Fatalf("set pinned_at_unix_ms(%s) error = %v", sessionID, err)
		}
	}

	page, ok, err := store.ListSessionSection(ctx, ListSessionSectionInput{
		WorkspaceID: "ws-pinned-page",
		SectionKey:  PinnedSessionPageKey,
		Limit:       1,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSection(pinned first) ok=%v error=%v", ok, err)
	}
	if len(page.Sessions) != 1 || page.Sessions[0].ID != "newer-pinned" {
		t.Fatalf("pinned first sessions = %#v, want newer-pinned", page.Sessions)
	}
	if !page.HasMore || page.NextCursor != "2000|newer-pinned" {
		t.Fatalf("pinned first page state = hasMore %v cursor %q", page.HasMore, page.NextCursor)
	}

	next, ok, err := store.ListSessionSection(ctx, ListSessionSectionInput{
		WorkspaceID:       "ws-pinned-page",
		SectionKey:        PinnedSessionPageKey,
		CursorUpdatedAtMS: page.Sessions[0].PinnedAtUnixMS,
		CursorSessionID:   page.Sessions[0].ID,
		Limit:             2,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSection(pinned next) ok=%v error=%v", ok, err)
	}
	if len(next.Sessions) != 1 || next.Sessions[0].ID != "older-pinned" {
		t.Fatalf("pinned next sessions = %#v, want older-pinned", next.Sessions)
	}
	if next.HasMore || next.NextCursor != "" {
		t.Fatalf("pinned next page state = hasMore %v cursor %q, want exhausted", next.HasMore, next.NextCursor)
	}
}

func TestStoreTargetNormalizationAndSkippableRows(t *testing.T) {
	t.Parallel()

	errInvalidTestTarget := errors.New("invalid test target")
	opts := testOptions(&staticProjectPaths{})
	opts.NormalizeTarget = func(target Target) (Target, error) {
		target.Name = strings.TrimSpace(target.Name)
		if strings.Contains(target.Name, "broken") {
			return Target{}, fmt.Errorf("%w: %s", errInvalidTestTarget, target.Name)
		}
		return target, nil
	}
	opts.IsSkippableTargetError = func(err error) bool {
		return errors.Is(err, errInvalidTestTarget)
	}
	store := openTestStore(t, opts)
	ctx := context.Background()

	if _, err := store.PutAgentTarget(ctx, Target{
		ID:            "custom",
		Provider:      "codex",
		LaunchRefJSON: `{"type":"local_cli","provider":"codex"}`,
		Name:          " Custom ",
		Enabled:       true,
		Source:        "user",
	}); err != nil {
		t.Fatalf("PutAgentTarget() error = %v", err)
	}
	target, err := store.GetAgentTarget(ctx, "custom")
	if err != nil {
		t.Fatalf("GetAgentTarget() error = %v", err)
	}
	if target.Name != "Custom" {
		t.Fatalf("target name = %q, want normalized Custom", target.Name)
	}

	if _, err := store.PutAgentTarget(ctx, Target{ID: "bad", Name: "broken row"}); !errors.Is(err, errInvalidTestTarget) {
		t.Fatalf("PutAgentTarget(invalid) error = %v, want invalid test target", err)
	}
	now := int64(1700000000000)
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO agent_targets (id, provider, launch_ref_json, name, icon_key, enabled, source, sort_order, created_at_ms, updated_at_ms)
VALUES ('broken-row', 'codex', '{}', 'broken stored row', NULL, 1, 'user', 5, ?, ?)
`, now, now); err != nil {
		t.Fatalf("insert broken target fixture: %v", err)
	}
	targets, err := store.ListAgentTargets(ctx)
	if err != nil {
		t.Fatalf("ListAgentTargets() error = %v", err)
	}
	for _, listed := range targets {
		if listed.ID == "broken-row" {
			t.Fatalf("ListAgentTargets() returned skippable row: %#v", targets)
		}
	}

	if err := store.DeleteAgentTarget(ctx, "custom"); err != nil {
		t.Fatalf("DeleteAgentTarget() error = %v", err)
	}
	if _, err := store.GetAgentTarget(ctx, "custom"); !errors.Is(err, ErrAgentTargetNotFound) {
		t.Fatalf("GetAgentTarget(deleted) error = %v, want ErrAgentTargetNotFound", err)
	}
}
