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
		Title:             "@renderer.js",
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
	if state.Session.Title != "@renderer.js" {
		t.Fatalf("state session title = %q, want canonical title", state.Session.Title)
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

	renamed, ok, err := store.UpdateSessionTitle(ctx, "ws-1", "session-1", " final ")
	if err != nil || !ok || renamed.Title != "final" || renamed.UpdatedAtUnixMS < pinned.UpdatedAtUnixMS {
		t.Fatalf("UpdateSessionTitle() = %#v ok=%v error=%v", renamed, ok, err)
	}

	updatedSettings, ok, err := store.UpdateSessionSettings(ctx, "ws-1", "session-1", "gpt-5.4", map[string]any{
		"model":            "gpt-5.4",
		"permissionModeId": "full-access",
	})
	if err != nil || !ok || updatedSettings.Model != "gpt-5.4" ||
		updatedSettings.Settings["permissionModeId"] != "full-access" ||
		updatedSettings.UpdatedAtUnixMS < renamed.UpdatedAtUnixMS {
		t.Fatalf("UpdateSessionSettings() = %#v ok=%v error=%v", updatedSettings, ok, err)
	}

	blankRenamed, ok, err := store.UpdateSessionTitle(ctx, "ws-1", "session-1", "   ")
	if err != nil || ok {
		t.Fatalf("UpdateSessionTitle(blank) = %#v ok=%v error=%v, want no update", blankRenamed, ok, err)
	}
	sessionAfterBlankTitle, ok, err := store.GetSession(ctx, "ws-1", "session-1")
	if err != nil || !ok || sessionAfterBlankTitle.Title != "final" {
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

func TestStoreMessageVersionsAreSnapshotCursorsAndMayHaveGaps(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime",
		Provider: "codex", ProviderSessionID: "provider-1", Status: "running", OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatal(err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: TurnPhaseSubmitted, OccurredAtUnixMS: 101,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition() accepted=%v error=%v", accepted, err)
	}
	for _, report := range []SessionMessageReport{
		{WorkspaceID: "ws-1", AgentSessionID: "session-1", Messages: []MessageUpdate{{
			MessageID: "message-a", TurnID: "turn-1", Role: "user", Kind: "text", Status: "completed", Payload: map[string]any{"text": "a"},
		}}},
		{WorkspaceID: "ws-1", AgentSessionID: "session-1", Messages: []MessageUpdate{{
			MessageID: "message-b", TurnID: "turn-1", Role: "assistant", Kind: "text", Status: "running", Payload: map[string]any{"text": "b"},
		}}},
		{WorkspaceID: "ws-1", AgentSessionID: "session-1", Messages: []MessageUpdate{{
			MessageID: "message-b", Status: "completed", ContentDelta: " done",
		}}},
	} {
		if result, err := store.ReportSessionMessages(ctx, report); err != nil || result.AcceptedCount != 1 {
			t.Fatalf("ReportSessionMessages() result=%#v error=%v", result, err)
		}
	}

	page, ok, err := store.ListSessionMessages(ctx, ListSessionMessagesInput{WorkspaceID: "ws-1", AgentSessionID: "session-1", Limit: 10})
	if err != nil || !ok || page.LatestVersion != 3 || len(page.Messages) != 2 {
		t.Fatalf("ListSessionMessages() page=%#v ok=%v error=%v", page, ok, err)
	}
	if page.Messages[0].MessageID != "message-a" || page.Messages[0].Version != 1 || page.Messages[1].MessageID != "message-b" || page.Messages[1].Version != 3 {
		t.Fatalf("current message snapshot versions=%#v, want message-a@1 and message-b@3", page.Messages)
	}
	incremental, ok, err := store.ListSessionMessages(ctx, ListSessionMessagesInput{WorkspaceID: "ws-1", AgentSessionID: "session-1", AfterVersion: 1, Limit: 10})
	if err != nil || !ok || len(incremental.Messages) != 1 || incremental.Messages[0].MessageID != "message-b" || incremental.LatestVersion != 3 {
		t.Fatalf("incremental page=%#v ok=%v error=%v", incremental, ok, err)
	}

	rejected, err := store.ReportSessionMessages(ctx, SessionMessageReport{WorkspaceID: "ws-1", AgentSessionID: "session-1", Messages: []MessageUpdate{{
		MessageID: "message-a", TurnID: "turn-2", Status: "completed",
	}}})
	if err != nil || rejected.AcceptedCount != 0 {
		t.Fatalf("rejected update result=%#v error=%v", rejected, err)
	}
	session, ok, err := store.GetSession(ctx, "ws-1", "session-1")
	if err != nil || !ok || session.MessageVersion != 3 {
		t.Fatalf("session after rejected update=%#v ok=%v error=%v", session, ok, err)
	}
}

func TestSessionAuditIsTurnlessAndDoesNotChangeActiveTurn(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-audit", AgentSessionID: "session-audit", Origin: "runtime", Provider: "codex",
		Status: "running", CurrentPhase: "working", OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatal(err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{
		WorkspaceID: "ws-audit", AgentSessionID: "session-audit", TurnID: "turn-active",
		Phase: TurnPhaseRunning, Origin: TurnOriginUserPrompt, OccurredAtUnixMS: 101,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition() accepted=%v error=%v", accepted, err)
	}
	result, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID: "ws-audit", AgentSessionID: "session-audit", Origin: "runtime", Provider: "codex",
		Messages: []MessageUpdate{{MessageID: "goal-control:op-1", Role: "user", Kind: "session_audit", Status: "completed", Payload: map[string]any{"text": "/goal clear"}, OccurredAtUnixMS: 102}},
	})
	if err != nil || result.AcceptedCount != 1 || result.Messages[0].TurnID != "" {
		t.Fatalf("audit result=%#v error=%v", result, err)
	}
	turn, ok, err := store.GetTurn(ctx, "ws-audit", "session-audit", "turn-active")
	if err != nil || !ok || turn.Phase != TurnPhaseRunning {
		t.Fatalf("active turn=%#v ok=%v error=%v", turn, ok, err)
	}
	for _, invalid := range []MessageUpdate{
		{MessageID: "ordinary-empty", Role: "assistant", Kind: "text", OccurredAtUnixMS: 103},
		{MessageID: "audit-with-turn", TurnID: "turn-active", Role: "user", Kind: "session_audit", OccurredAtUnixMS: 104},
	} {
		if _, err := store.ReportSessionMessages(ctx, SessionMessageReport{WorkspaceID: "ws-audit", AgentSessionID: "session-audit", Origin: "runtime", Messages: []MessageUpdate{invalid}}); err == nil {
			t.Fatalf("ReportSessionMessages(%s) error=nil", invalid.MessageID)
		}
	}
}

func TestHistoricalImportCompatibilityCannotBeForgedByOrigin(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	input := SessionMessageReport{
		WorkspaceID: "ws-import-boundary", AgentSessionID: "session-import", Origin: "WORKSPACE_AGENT_SESSION_ORIGIN_IMPORTED",
		Messages: []MessageUpdate{{MessageID: "legacy", Role: "assistant", Kind: "text", OccurredAtUnixMS: 10}},
	}
	if _, err := store.ReportSessionMessages(ctx, input); err == nil {
		t.Fatal("import origin alone bypassed Turn invariant")
	}
	input.HistoricalImport = true
	result, err := store.ReportSessionMessages(ctx, input)
	if err != nil || result.AcceptedCount != 1 || result.Messages[0].TurnID != "" {
		t.Fatalf("historical import result=%#v error=%v", result, err)
	}
}

func TestStoreMessageSemanticsRoundTrip(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{WorkspaceID: "ws-semantics", AgentSessionID: "session-semantics", Provider: "codex", OccurredAtUnixMS: 1}); err != nil {
		t.Fatal(err)
	}
	if _, accepted, err := store.RecordTurnTransition(ctx, TurnTransition{WorkspaceID: "ws-semantics", AgentSessionID: "session-semantics", TurnID: "turn-1", Phase: TurnPhaseRunning, OccurredAtUnixMS: 2}); err != nil || !accepted {
		t.Fatalf("turn accepted=%v err=%v", accepted, err)
	}
	semantics := &MessageSemantics{UserVisibleAssistantResponse: true, TurnSettling: true, NoticeCommand: "compact", NoticeCommandStatus: "running"}
	if _, err := store.ReportSessionMessages(ctx, SessionMessageReport{WorkspaceID: "ws-semantics", AgentSessionID: "session-semantics", Messages: []MessageUpdate{{MessageID: "message-1", TurnID: "turn-1", Role: "assistant", Kind: "text", Semantics: semantics, OccurredAtUnixMS: 3}}}); err != nil {
		t.Fatal(err)
	}
	page, ok, err := store.ListSessionMessages(ctx, ListSessionMessagesInput{WorkspaceID: "ws-semantics", AgentSessionID: "session-semantics", Limit: 10})
	if err != nil || !ok || len(page.Messages) != 1 || page.Messages[0].Semantics == nil || !page.Messages[0].Semantics.UserVisibleAssistantResponse || page.Messages[0].Semantics.NoticeCommand != "compact" {
		t.Fatalf("message semantics page=%#v ok=%v err=%v", page, ok, err)
	}
}

func TestReportActivityStateRejectsTurnForDeletedSession(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{WorkspaceID: "ws-deleted-activity", AgentSessionID: "session-deleted-activity", Provider: "codex", OccurredAtUnixMS: 1}); err != nil {
		t.Fatal(err)
	}
	if removed, err := store.DeleteSession(ctx, "ws-deleted-activity", "session-deleted-activity"); err != nil || !removed {
		t.Fatalf("DeleteSession removed=%v err=%v", removed, err)
	}
	result, err := store.ReportActivityState(ctx, ActivityStateReport{
		Session: SessionStateReport{WorkspaceID: "ws-deleted-activity", AgentSessionID: "session-deleted-activity", Provider: "codex", OccurredAtUnixMS: 2},
		Turn:    &TurnTransition{WorkspaceID: "ws-deleted-activity", AgentSessionID: "session-deleted-activity", TurnID: "late-turn", Phase: TurnPhaseSettled, Outcome: TurnOutcomeCompleted, OccurredAtUnixMS: 2},
	})
	if err != nil || result.State.Accepted || result.TurnAccepted {
		t.Fatalf("late activity result=%#v err=%v", result, err)
	}
	if _, found, err := store.GetTurn(ctx, "ws-deleted-activity", "session-deleted-activity", "late-turn"); err != nil || found {
		t.Fatalf("late turn found=%v err=%v", found, err)
	}
}

func TestStoreRejectsMessageReferencingUnknownTurn(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Origin: "runtime",
		Provider: "codex", ProviderSessionID: "provider-1", Status: "running", OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatal(err)
	}

	_, err := store.ReportSessionMessages(ctx, SessionMessageReport{
		WorkspaceID: "ws-1", AgentSessionID: "session-1", Messages: []MessageUpdate{{
			MessageID: "message-1", TurnID: "missing-turn", Role: "user", Kind: "text",
			Status: "completed", Payload: map[string]any{"text": "/goal clear"}, OccurredAtUnixMS: 110,
		}},
	})
	if err == nil || !strings.Contains(err.Error(), `references unknown turn "missing-turn"`) {
		t.Fatalf("ReportSessionMessages() error=%v, want unknown-turn rejection", err)
	}
	if _, ok, err := store.GetTurn(ctx, "ws-1", "session-1", "missing-turn"); err != nil || ok {
		t.Fatalf("GetTurn(missing-turn) ok=%v error=%v, want no manufactured turn", ok, err)
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

func TestStoreClearSessionsDeletesGoalSagaWithForeignKeysDisabledAndSessionIDReuseStartsClean(t *testing.T) {
	t.Parallel()
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-clear-goal", AgentSessionID: "session-reused", Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}
	if _, state, created, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "old-goal-op", WorkspaceID: "ws-clear-goal", AgentSessionID: "session-reused",
		Action: "set", Objective: "old objective", OccurredAtUnixMS: 20,
	}); err != nil || !created || state.Revision != 1 {
		t.Fatalf("prepare old goal state=%#v created=%v error=%v", state, created, err)
	}
	if _, err := store.db.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
		t.Fatalf("disable foreign keys: %v", err)
	}
	seedRuntimeDeletionSaga(t, store, "ws-clear-goal", "session-reused")
	result, err := store.ClearSessions(ctx, "ws-clear-goal")
	if err != nil || result.RemovedSessions != 1 {
		t.Fatalf("ClearSessions() result=%#v error=%v", result, err)
	}
	for _, table := range []string{"workspace_agent_runtime_operation_events", "workspace_agent_runtime_operations", "workspace_agent_goal_control_operations", "workspace_agent_session_goals"} {
		var count int
		if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table+` WHERE workspace_id = ?`, "ws-clear-goal").Scan(&count); err != nil || count != 0 {
			t.Fatalf("%s count=%d error=%v, want empty", table, count, err)
		}
	}
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-clear-goal", AgentSessionID: "session-reused", Provider: "codex", OccurredAtUnixMS: 30,
	}); err != nil {
		t.Fatalf("recreate session: %v", err)
	}
	if state, found, err := store.GetSessionGoalState(ctx, "ws-clear-goal", "session-reused"); err != nil || found {
		t.Fatalf("recreated goal state=%#v found=%v error=%v, want absent", state, found, err)
	}
	if _, state, created, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
		OperationID: "new-goal-op", WorkspaceID: "ws-clear-goal", AgentSessionID: "session-reused",
		Action: "set", Objective: "new objective", OccurredAtUnixMS: 40,
	}); err != nil || !created || state.Revision != 1 {
		t.Fatalf("prepare recreated goal state=%#v created=%v error=%v, want revision 1", state, created, err)
	}
	seedInteractionTurn(t, store, "ws-clear-goal", "session-reused", "turn-prepared", 50)
	if _, result, err := store.UpsertInteraction(ctx, InteractionUpsert{
		WorkspaceID: "ws-clear-goal", AgentSessionID: "session-reused", TurnID: "turn-prepared",
		RequestID: "request-reused", Kind: InteractionKindQuestion, Status: InteractionStatusPending, OccurredAtUnixMS: 51,
	}); err != nil || result != InteractionTransitionApplied {
		t.Fatalf("recreate interaction result=%v error=%v", result, err)
	}
	if _, created, err := store.PrepareRuntimeOperation(ctx, RuntimeOperationPrepare{
		OperationID: "new-runtime-op", WorkspaceID: "ws-clear-goal", AgentSessionID: "session-reused",
		Kind: RuntimeOperationKindInteractiveResponse, TurnID: "turn-prepared", RequestID: "request-reused", OccurredAtMS: 52,
	}); err != nil || !created {
		t.Fatalf("prepare recreated runtime operation created=%v error=%v", created, err)
	}
	claimable, err := store.ListClaimableRuntimeOperations(ctx, ListClaimableRuntimeOperationsInput{WorkspaceID: "ws-clear-goal", NowUnixMS: 100, Limit: 10})
	if err != nil || len(claimable) != 1 || claimable[0].OperationID != "new-runtime-op" {
		t.Fatalf("claimable after recreation=%#v error=%v", claimable, err)
	}
}

func TestStoreSessionDeleteVariantsExplicitlyDeleteGoalSagaWithForeignKeysDisabled(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct {
		name   string
		remove func(context.Context, *Store) error
	}{
		{name: "single", remove: func(ctx context.Context, store *Store) error {
			_, err := store.DeleteSession(ctx, "ws-delete-goal", "session-1")
			return err
		}},
		{name: "batch", remove: func(ctx context.Context, store *Store) error {
			_, err := store.DeleteSessionsBatch(ctx, DeleteSessionsBatchInput{WorkspaceID: "ws-delete-goal", SessionIDs: []string{"session-1"}})
			return err
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := openTestStore(t, testOptions(&staticProjectPaths{}))
			ctx := context.Background()
			if _, err := store.ReportSessionState(ctx, SessionStateReport{
				WorkspaceID: "ws-delete-goal", AgentSessionID: "session-1", Provider: "codex", OccurredAtUnixMS: 10,
			}); err != nil {
				t.Fatal(err)
			}
			if _, _, _, err := store.PrepareGoalControlOperation(ctx, GoalControlOperationPrepare{
				OperationID: "goal-op-" + tc.name, WorkspaceID: "ws-delete-goal", AgentSessionID: "session-1",
				Action: "set", Objective: "objective", OccurredAtUnixMS: 20,
			}); err != nil {
				t.Fatal(err)
			}
			if _, err := store.db.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
				t.Fatal(err)
			}
			seedRuntimeDeletionSaga(t, store, "ws-delete-goal", "session-1")
			if err := tc.remove(ctx, store); err != nil {
				t.Fatal(err)
			}
			for _, table := range []string{"workspace_agent_runtime_operation_events", "workspace_agent_runtime_operations", "workspace_agent_goal_control_operations", "workspace_agent_session_goals"} {
				var count int
				if err := store.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+table+` WHERE workspace_id = ?`, "ws-delete-goal").Scan(&count); err != nil || count != 0 {
					t.Fatalf("%s count=%d error=%v", table, count, err)
				}
			}
		})
	}
}

func seedRuntimeDeletionSaga(t *testing.T, store *Store, workspaceID string, sessionID string) {
	t.Helper()
	for _, row := range []struct {
		operationID string
		status      string
		turnID      string
		result      any
		leaseOwner  any
		leaseExpiry any
		nextAttempt any
		completedAt any
	}{
		{operationID: "old-runtime-prepared", status: RuntimeOperationStatusPrepared, turnID: "turn-prepared", nextAttempt: int64(10)},
		{operationID: "old-runtime-leased", status: RuntimeOperationStatusLeased, turnID: "turn-leased", leaseOwner: "worker", leaseExpiry: int64(1000)},
		{operationID: "old-runtime-completed", status: RuntimeOperationStatusCompleted, turnID: "turn-completed", result: RuntimeOperationResultCanceled, completedAt: int64(30)},
	} {
		query := `INSERT INTO workspace_agent_runtime_operations (
operation_id, workspace_id, agent_session_id, kind, status, result, subject_id, turn_id,
payload_json, lease_owner, lease_expires_at_unix_ms, next_attempt_at_unix_ms,
created_at_unix_ms, updated_at_unix_ms, completed_at_unix_ms
) VALUES (?, ?, ?, 'cancel_turn', ?, ?, ?, ?, '{}', ?, ?, ?, 20, 20, ?)`
		if _, err := store.db.Exec(query, row.operationID, workspaceID, sessionID, row.status, row.result, row.turnID, row.turnID,
			row.leaseOwner, row.leaseExpiry, row.nextAttempt, row.completedAt); err != nil {
			t.Fatalf("seed runtime operation %s: %v", row.status, err)
		}
	}
	if _, err := store.db.Exec(`INSERT INTO workspace_agent_runtime_operation_events (
operation_id, workspace_id, agent_session_id, kind, payload_json, created_at_unix_ms
) VALUES ('old-runtime-completed', ?, ?, 'turn_canceled', '{}', 30)`, workspaceID, sessionID); err != nil {
		t.Fatalf("seed runtime operation event: %v", err)
	}
	if _, err := store.db.Exec(`INSERT INTO workspace_agent_runtime_operations (
operation_id, workspace_id, agent_session_id, kind, status, result, subject_id, turn_id,
request_id, payload_json, created_at_unix_ms, updated_at_unix_ms, completed_at_unix_ms
) VALUES ('old-runtime-interactive', ?, ?, 'interactive_response', 'completed', 'answered',
  'request-reused', 'turn-prepared', 'request-reused', '{}', 31, 31, 31)`, workspaceID, sessionID); err != nil {
		t.Fatalf("seed reused interactive runtime operation: %v", err)
	}
	if _, err := store.db.Exec(`INSERT INTO workspace_agent_runtime_operation_events (
operation_id, workspace_id, agent_session_id, kind, payload_json, created_at_unix_ms
) VALUES ('old-runtime-interactive', ?, ?, 'interactive_completed', '{}', 31)`, workspaceID, sessionID); err != nil {
		t.Fatalf("seed reused interactive runtime operation event: %v", err)
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
	if _, _, err := store.ListWorkspaceGeneratedFileTurns(ctx, ListWorkspaceGeneratedFileTurnsInput{
		WorkspaceID: "ws-unknown", SectionKey: RailSectionKeyConversations,
	}); !errors.Is(err, errTestWorkspaceNotFound) {
		t.Fatalf("ListWorkspaceGeneratedFileTurns(unknown) error = %v, want workspace not found", err)
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

	projectResult, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:      "ws-rail",
		AgentSessionID:   "session-project",
		Origin:           "runtime",
		Provider:         "codex",
		Cwd:              repoSubdir,
		Status:           "completed",
		OccurredAtUnixMS: 100,
	})
	if err != nil {
		t.Fatalf("ReportSessionState(project) error = %v", err)
	}
	wantProjectKey := RailSectionKeyForProject(repoCanonical)
	if projectResult.Session.RailSectionKey != wantProjectKey {
		t.Fatalf("ReportSessionState(project) rail key = %q, want %q", projectResult.Session.RailSectionKey, wantProjectKey)
	}
	projects.paths = []string{otherDir}
	updatedProjectResult, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:      "ws-rail",
		AgentSessionID:   "session-project",
		Origin:           "runtime",
		Provider:         "codex",
		Cwd:              otherDir,
		Status:           "completed",
		OccurredAtUnixMS: 200,
	})
	if err != nil {
		t.Fatalf("ReportSessionState(project cwd changed) error = %v", err)
	}
	if updatedProjectResult.Session.RailSectionKey != wantProjectKey {
		t.Fatalf(
			"ReportSessionState(project cwd changed) rail key = %q, want immutable %q",
			updatedProjectResult.Session.RailSectionKey,
			wantProjectKey,
		)
	}
	projects.paths = []string{repo}
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
		SectionKey:  wantProjectKey,
		Limit:       10,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSection(project) ok=%v error=%v", ok, err)
	}
	if len(projectPage.Sessions) != 1 || projectPage.Sessions[0].ID != "session-project" || projectPage.Sessions[0].RailSectionKey != wantProjectKey {
		t.Fatalf("project page = %#v, want session-project", projectPage.Sessions)
	}
	projectSession, ok, err := store.GetSession(ctx, "ws-rail", "session-project")
	if err != nil || !ok || projectSession.RailSectionKey != wantProjectKey {
		t.Fatalf("GetSession(project) = %#v ok=%v error=%v, want rail key %q", projectSession, ok, err, wantProjectKey)
	}

	conversationsPage, ok, err := store.ListSessionSection(ctx, ListSessionSectionInput{
		WorkspaceID: "ws-rail",
		SectionKey:  RailSectionKeyConversations,
		Limit:       10,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSection(conversations) ok=%v error=%v", ok, err)
	}
	if len(conversationsPage.Sessions) != 1 || conversationsPage.Sessions[0].ID != "session-other" || conversationsPage.Sessions[0].RailSectionKey != RailSectionKeyConversations {
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
SET created_at_unix_ms = 1000, updated_at_unix_ms = 1000
WHERE workspace_id = ?`, "ws-rail-visible"); err != nil {
		t.Fatalf("normalize session timestamps error = %v", err)
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
	if page.TotalCount != 2 {
		t.Fatalf("first page total count = %d, want 2 visible sessions", page.TotalCount)
	}

	next, ok, err := store.ListSessionSection(ctx, ListSessionSectionInput{
		WorkspaceID:          "ws-rail-visible",
		SectionKey:           RailSectionKeyForProject("/workspace/app"),
		CursorSortTimeUnixMS: page.Sessions[0].CreatedAtUnixMS,
		CursorSessionID:      page.Sessions[0].ID,
		Limit:                1,
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
	if next.TotalCount != 2 {
		t.Fatalf("next page total count = %d, want stable total 2", next.TotalCount)
	}
}

func TestStoreListSessionSectionOrdersAndPagesByLatestTurnStart(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{paths: []string{"/workspace/app"}}))
	ctx := context.Background()
	for _, report := range []ActivityStateReport{
		{
			Session: SessionStateReport{
				WorkspaceID:      "ws-turn-order",
				AgentSessionID:   "older-start-newer-update",
				Origin:           "runtime",
				Provider:         "codex",
				Cwd:              "/workspace/app",
				Status:           "working",
				OccurredAtUnixMS: 9_000,
			},
			Turn: &TurnTransition{
				WorkspaceID:      "ws-turn-order",
				AgentSessionID:   "older-start-newer-update",
				TurnID:           "turn-older",
				Phase:            TurnPhaseRunning,
				StartedAtUnixMS:  2_000,
				OccurredAtUnixMS: 9_000,
			},
		},
		{
			Session: SessionStateReport{
				WorkspaceID:      "ws-turn-order",
				AgentSessionID:   "newer-start-older-update",
				Origin:           "runtime",
				Provider:         "codex",
				Cwd:              "/workspace/app",
				Status:           "working",
				OccurredAtUnixMS: 4_000,
			},
			Turn: &TurnTransition{
				WorkspaceID:      "ws-turn-order",
				AgentSessionID:   "newer-start-older-update",
				TurnID:           "turn-newer",
				Phase:            TurnPhaseRunning,
				StartedAtUnixMS:  3_000,
				OccurredAtUnixMS: 4_000,
			},
		},
	} {
		if _, err := store.ReportActivityState(ctx, report); err != nil {
			t.Fatalf("ReportActivityState(%s) error = %v", report.Session.AgentSessionID, err)
		}
	}

	page, ok, err := store.ListSessionSection(ctx, ListSessionSectionInput{
		WorkspaceID: "ws-turn-order",
		SectionKey:  RailSectionKeyForProject("/workspace/app"),
		Limit:       1,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSection(first) ok=%v error=%v", ok, err)
	}
	if len(page.Sessions) != 1 || page.Sessions[0].ID != "newer-start-older-update" {
		t.Fatalf("first page sessions = %#v, want latest turn start", page.Sessions)
	}
	if !page.HasMore || page.NextCursor != "3000|newer-start-older-update" {
		t.Fatalf("first page hasMore=%v cursor=%q", page.HasMore, page.NextCursor)
	}
	if page.TotalCount != 2 {
		t.Fatalf("first page total count = %d, want 2", page.TotalCount)
	}

	next, ok, err := store.ListSessionSection(ctx, ListSessionSectionInput{
		WorkspaceID:          "ws-turn-order",
		SectionKey:           RailSectionKeyForProject("/workspace/app"),
		CursorSortTimeUnixMS: 3_000,
		CursorSessionID:      "newer-start-older-update",
		Limit:                1,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSection(next) ok=%v error=%v", ok, err)
	}
	if len(next.Sessions) != 1 || next.Sessions[0].ID != "older-start-newer-update" {
		t.Fatalf("next page sessions = %#v, want older turn start", next.Sessions)
	}
	if next.HasMore || next.NextCursor != "" {
		t.Fatalf("next page hasMore=%v cursor=%q, want exhausted", next.HasMore, next.NextCursor)
	}
	if next.TotalCount != 2 {
		t.Fatalf("next page total count = %d, want stable total 2", next.TotalCount)
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
	conversations, ok, err := store.ListSessionSection(ctx, ListSessionSectionInput{
		WorkspaceID: "ws-pinned-page",
		SectionKey:  RailSectionKeyConversations,
		Limit:       10,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSection(conversations) ok=%v error=%v", ok, err)
	}
	if len(conversations.Sessions) != 1 || conversations.Sessions[0].ID != "unpinned" {
		t.Fatalf("ordinary conversations = %#v, want only unpinned", conversations.Sessions)
	}
	if conversations.TotalCount != 1 {
		t.Fatalf("ordinary conversations total count = %d, want 1", conversations.TotalCount)
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
	if page.TotalCount != 2 {
		t.Fatalf("pinned first page total count = %d, want 2", page.TotalCount)
	}

	next, ok, err := store.ListSessionSection(ctx, ListSessionSectionInput{
		WorkspaceID:          "ws-pinned-page",
		SectionKey:           PinnedSessionPageKey,
		CursorSortTimeUnixMS: page.Sessions[0].PinnedAtUnixMS,
		CursorSessionID:      page.Sessions[0].ID,
		Limit:                2,
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
	if next.TotalCount != 2 {
		t.Fatalf("pinned next page total count = %d, want stable total 2", next.TotalCount)
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
