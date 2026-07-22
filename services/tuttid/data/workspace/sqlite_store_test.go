package workspace

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agent/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	userprojectbiz "github.com/tutti-os/tutti/services/tuttid/biz/userproject"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestSQLiteStoreListEmptyDatabase(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)

	items, err := store.List(context.Background())
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(items) != 0 {
		t.Fatalf("List() len = %d, want 0", len(items))
	}
}

func TestSQLiteStoreConfiguresSeparateReadAndWritePools(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	if got := store.writeDB.Stats().MaxOpenConnections; got != 1 {
		t.Fatalf("write pool max open connections = %d, want 1", got)
	}
	if got := store.readDB.Stats().MaxOpenConnections; got != defaultSQLiteReaderConnections {
		t.Fatalf("read pool max open connections = %d, want %d", got, defaultSQLiteReaderConnections)
	}

	ctx := context.Background()
	connections := make([]*sql.Conn, 0, defaultSQLiteReaderConnections)
	defer func() {
		for _, connection := range connections {
			_ = connection.Close()
		}
	}()
	for index := 0; index < defaultSQLiteReaderConnections; index++ {
		connection, err := store.readDB.Conn(ctx)
		if err != nil {
			t.Fatalf("read pool connection %d: %v", index, err)
		}
		connections = append(connections, connection)

		var queryOnly int
		if err := connection.QueryRowContext(ctx, "PRAGMA query_only").Scan(&queryOnly); err != nil {
			t.Fatalf("read pool connection %d query_only: %v", index, err)
		}
		if queryOnly != 1 {
			t.Fatalf("read pool connection %d query_only = %d, want 1", index, queryOnly)
		}

		var busyTimeout int
		if err := connection.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&busyTimeout); err != nil {
			t.Fatalf("read pool connection %d busy_timeout: %v", index, err)
		}
		if busyTimeout != defaultSQLiteBusyTimeoutMillisec {
			t.Fatalf("read pool connection %d busy_timeout = %d, want %d", index, busyTimeout, defaultSQLiteBusyTimeoutMillisec)
		}
	}

	if _, err := connections[0].ExecContext(ctx, "CREATE TABLE read_pool_must_not_write (id INTEGER)"); err == nil {
		t.Fatal("read pool write succeeded, want read-only error")
	}
}

func TestSQLiteStoreReadsCommittedDataWhileWriterConnectionIsBusy(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "ws-read-write-pools"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Committed"}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      workspaceID,
		AgentSessionID:   "session-visible-to-reader",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Status:           "running",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}

	tx, err := store.writeDB.BeginTx(ctx, nil)
	if err != nil {
		t.Fatalf("BeginTx() error = %v", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "UPDATE workspaces SET name = ? WHERE id = ?", "Uncommitted", workspaceID); err != nil {
		t.Fatalf("hold writer transaction: %v", err)
	}

	readCtx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	sessions, ok, err := store.ListSessions(readCtx, workspaceID)
	if err != nil {
		t.Fatalf("ListSessions() while writer is busy error = %v", err)
	}
	if !ok || len(sessions) != 1 || sessions[0].ID != "session-visible-to-reader" {
		t.Fatalf("ListSessions() while writer is busy = %#v, ok=%v", sessions, ok)
	}
}

func TestSQLiteStoreMigrationDropsLegacyLocalPathColumn(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)

	hasLocalPath, err := store.hasColumn(context.Background(), "workspaces", "local_path")
	if err != nil {
		t.Fatalf("hasColumn() error = %v", err)
	}
	if hasLocalPath {
		t.Fatal("expected local_path column to be removed")
	}
}

func TestSQLiteStoreMigrationRepairsAgentTargetIDColumnWhenMarkerExists(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "tuttid.db")
	createLegacyAgentActivityV4MarkedDatabaseWithoutAgentTargetID(t, dbPath)

	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})

	ctx := context.Background()
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	hasAgentTargetID, err := store.hasColumn(ctx, "workspace_agent_sessions", "agent_target_id")
	if err != nil {
		t.Fatalf("hasColumn() error = %v", err)
	}
	if !hasAgentTargetID {
		t.Fatal("agent_target_id column was not repaired")
	}

	sessions, ok, err := store.ListSessions(ctx, "ws-legacy-agent-target-id")
	if err != nil {
		t.Fatalf("ListSessions() error = %v", err)
	}
	if !ok {
		t.Fatal("ListSessions() ok = false, want true")
	}
	if len(sessions) != 2 {
		t.Fatalf("ListSessions() len = %d, want 2", len(sessions))
	}
	targetBySessionID := map[string]string{}
	for _, session := range sessions {
		targetBySessionID[session.ID] = session.AgentTargetID
	}
	if targetBySessionID["session-legacy"] != agenttargetbiz.IDLocalCodex {
		t.Fatalf("codex AgentTargetID = %q, want %s", targetBySessionID["session-legacy"], agenttargetbiz.IDLocalCodex)
	}
	if targetBySessionID["session-legacy-claude"] != agenttargetbiz.IDLocalClaudeCode {
		t.Fatalf("claude AgentTargetID = %q, want %s", targetBySessionID["session-legacy-claude"], agenttargetbiz.IDLocalClaudeCode)
	}
}

func TestSQLiteStoreCreateUpdateAndList(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-1",
		Name: "Workspace One",
	}); err != nil {
		t.Fatalf("Create() first error = %v", err)
	}
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-2",
		Name: "Workspace Two",
	}); err != nil {
		t.Fatalf("Create() second error = %v", err)
	}
	if err := store.Update(ctx, workspacebiz.Summary{
		ID:   "ws-1",
		Name: "Workspace One Updated",
	}); err != nil {
		t.Fatalf("Update() error = %v", err)
	}

	items, err := store.List(ctx)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(items) != 2 {
		t.Fatalf("List() len = %d, want 2", len(items))
	}

	found := map[string]string{}
	for _, item := range items {
		found[item.ID] = item.Name
	}

	if found["ws-1"] != "Workspace One Updated" {
		t.Fatalf("workspace ws-1 name = %q", found["ws-1"])
	}
	if found["ws-2"] != "Workspace Two" {
		t.Fatalf("workspace ws-2 name = %q", found["ws-2"])
	}
}

func TestSQLiteStoreCreateAndList(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-10",
		Name: "Workspace Ten",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	items, err := store.List(ctx)
	if err != nil {
		t.Fatalf("List() error = %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("List() len = %d, want 1", len(items))
	}
	if items[0].ID != "ws-10" || items[0].Name != "Workspace Ten" {
		t.Fatalf("item = %#v", items[0])
	}
}

func TestSQLiteStoreGetUpdateDelete(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-20",
		Name: "Workspace Twenty",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	item, err := store.Get(ctx, "ws-20")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if item.Name != "Workspace Twenty" {
		t.Fatalf("Get() name = %q", item.Name)
	}

	if err := store.Update(ctx, workspacebiz.Summary{
		ID:   "ws-20",
		Name: "Workspace Twenty Updated",
	}); err != nil {
		t.Fatalf("Update() error = %v", err)
	}

	item, err = store.Get(ctx, "ws-20")
	if err != nil {
		t.Fatalf("Get() after update error = %v", err)
	}
	if item.Name != "Workspace Twenty Updated" {
		t.Fatalf("Get() updated name = %q", item.Name)
	}

	if err := store.Delete(ctx, "ws-20"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}

	if _, err := store.Get(ctx, "ws-20"); !errors.Is(err, ErrWorkspaceNotFound) {
		t.Fatalf("Get() after delete error = %v", err)
	}
}

func TestSQLiteStoreOpenTracksLastOpenedAt(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-open-1",
		Name: "Workspace Open",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	opened, err := store.Open(ctx, "ws-open-1")
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if opened.LastOpenedAt == nil {
		t.Fatal("Open() lastOpenedAt = nil")
	}
	if time.Since(*opened.LastOpenedAt) > 5*time.Second {
		t.Fatalf("Open() lastOpenedAt too old = %v", opened.LastOpenedAt)
	}
}

func TestSQLiteStoreGetStartup(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	startup, err := store.GetStartup(ctx)
	if err != nil {
		t.Fatalf("GetStartup() empty error = %v", err)
	}
	if startup != nil {
		t.Fatalf("GetStartup() empty = %#v, want nil", startup)
	}

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-start-1",
		Name: "Workspace Start One",
	}); err != nil {
		t.Fatalf("Create() first error = %v", err)
	}
	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-start-2",
		Name: "Workspace Start Two",
	}); err != nil {
		t.Fatalf("Create() second error = %v", err)
	}

	if _, err := store.Open(ctx, "ws-start-1"); err != nil {
		t.Fatalf("Open() first error = %v", err)
	}

	time.Sleep(2 * time.Millisecond)

	if _, err := store.Open(ctx, "ws-start-2"); err != nil {
		t.Fatalf("Open() second error = %v", err)
	}

	startup, err = store.GetStartup(ctx)
	if err != nil {
		t.Fatalf("GetStartup() populated error = %v", err)
	}
	if startup == nil {
		t.Fatal("GetStartup() populated = nil")
	}
	if startup.ID != "ws-start-2" {
		t.Fatalf("GetStartup() id = %q, want %q", startup.ID, "ws-start-2")
	}
}

func TestSQLiteStoreReportAndListAgentActivityMessages(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-activity",
		Name: "Workspace Agent Activity",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	state, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:       "ws-agent-activity",
		AgentSessionID:    "session-1",
		Origin:            agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:          "codex",
		ProviderSessionID: "provider-session-1",
		Cwd:               "/workspace",
		Title:             "hello",
		Status:            "running",
		OccurredAtUnixMS:  100,
		StartedAtUnixMS:   90,
	})
	if err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if !state.Accepted || state.LastEventUnixMS != 100 {
		t.Fatalf("state result = %#v", state)
	}
	seedTestAgentTurn(t, store, ctx, "ws-agent-activity", "session-1", "turn-1", "codex", 105)

	first, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-activity",
		AgentSessionID: "session-1",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{{
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

	second, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-activity",
		AgentSessionID: "session-1",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{{
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

	page, ok, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    "ws-agent-activity",
		AgentSessionID: "session-1",
		Limit:          10,
	})
	if err != nil {
		t.Fatalf("ListSessionMessages() error = %v", err)
	}
	if !ok {
		t.Fatal("ListSessionMessages() ok = false, want true")
	}
	if page.LatestVersion != 2 || page.HasMore || len(page.Messages) != 1 {
		t.Fatalf("page = %#v", page)
	}
	message := page.Messages[0]
	if message.Version != 2 || message.Role != "assistant" || message.Kind != "text" || message.Status != "completed" {
		t.Fatalf("message metadata = %#v", message)
	}
	if message.Payload["text"] != "hello" {
		t.Fatalf("message payload = %#v, want text hello", message.Payload)
	}

	next, ok, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    "ws-agent-activity",
		AgentSessionID: "session-1",
		AfterVersion:   1,
		Limit:          10,
	})
	if err != nil {
		t.Fatalf("ListSessionMessages(after) error = %v", err)
	}
	if !ok || len(next.Messages) != 1 || next.Messages[0].Version != 2 {
		t.Fatalf("next page = %#v ok=%v", next, ok)
	}
	if _, accepted, err := store.agentStore().RecordTurnTransition(ctx, agentactivitybiz.TurnTransition{
		WorkspaceID: "ws-agent-activity", AgentSessionID: "session-1", TurnID: "turn-1",
		Phase: agentactivitybiz.TurnPhaseSettled, Outcome: agentactivitybiz.TurnOutcomeCompleted, OccurredAtUnixMS: 125,
	}); err != nil || !accepted {
		t.Fatalf("settle first turn accepted=%v error=%v", accepted, err)
	}
	seedTestAgentTurn(t, store, ctx, "ws-agent-activity", "session-1", "turn-2", "codex", 126)

	third, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-activity",
		AgentSessionID: "session-1",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID:        "message-2",
			TurnID:           "turn-2",
			Role:             "assistant",
			Kind:             "text",
			Status:           "completed",
			Payload:          map[string]any{"text": "newest"},
			OccurredAtUnixMS: 130,
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages(third) error = %v", err)
	}
	if third.AcceptedCount != 1 || third.LatestVersion != 3 {
		t.Fatalf("third result = %#v", third)
	}

	turnPage, ok, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    "ws-agent-activity",
		AgentSessionID: "session-1",
		TurnID:         "turn-2",
		Limit:          10,
	})
	if err != nil {
		t.Fatalf("ListSessionMessages(turn) error = %v", err)
	}
	if !ok || len(turnPage.Messages) != 1 || turnPage.Messages[0].MessageID != "message-2" {
		t.Fatalf("turn page = %#v ok=%v", turnPage, ok)
	}

	latest, ok, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    "ws-agent-activity",
		AgentSessionID: "session-1",
		Limit:          1,
		Order:          agentactivitybiz.MessageOrderDesc,
	})
	if err != nil {
		t.Fatalf("ListSessionMessages(desc) error = %v", err)
	}
	if !ok || !latest.HasMore || len(latest.Messages) != 1 || latest.Messages[0].Version != 3 {
		t.Fatalf("latest page = %#v ok=%v", latest, ok)
	}

	older, ok, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    "ws-agent-activity",
		AgentSessionID: "session-1",
		BeforeVersion:  3,
		Limit:          1,
		Order:          agentactivitybiz.MessageOrderDesc,
	})
	if err != nil {
		t.Fatalf("ListSessionMessages(desc before) error = %v", err)
	}
	if !ok || len(older.Messages) != 1 || older.Messages[0].Version != 2 {
		t.Fatalf("older page = %#v ok=%v", older, ok)
	}
}

func TestSQLiteStoreClassifiesAgentSessionRailSections(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-rail",
		Name: "Workspace Agent Rail",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	repoSubdir := filepath.Join(repo, "packages", "api")
	repoSimilarPrefix := filepath.Join(root, "repo-a")
	nestedRepo := filepath.Join(repo, "packages", "web")
	nestedRepoSubdir := filepath.Join(nestedRepo, "src")
	for _, path := range []string{repoSubdir, repoSimilarPrefix, nestedRepoSubdir} {
		if err := mkdirAll(path); err != nil {
			t.Fatalf("mkdir %q error = %v", path, err)
		}
	}
	repoCanonical := normalizeAgentSessionRailPath(repo)
	nestedRepoCanonical := normalizeAgentSessionRailPath(nestedRepo)
	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "project-repo",
		Path:  repo,
		Label: "repo",
	}); err != nil {
		t.Fatalf("PutUserProject(repo) error = %v", err)
	}
	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "project-nested",
		Path:  nestedRepo,
		Label: "web",
	}); err != nil {
		t.Fatalf("PutUserProject(nested) error = %v", err)
	}

	for _, tc := range []struct {
		sessionID       string
		cwd             string
		wantKind        string
		wantProjectPath string
		wantKey         string
	}{
		{
			sessionID:       "session-root",
			cwd:             repo,
			wantKind:        agentSessionRailSectionKindProject,
			wantProjectPath: repoCanonical,
			wantKey:         agentSessionRailSectionKeyForProject(repo),
		},
		{
			sessionID:       "session-subdir",
			cwd:             repoSubdir,
			wantKind:        agentSessionRailSectionKindProject,
			wantProjectPath: repoCanonical,
			wantKey:         agentSessionRailSectionKeyForProject(repo),
		},
		{
			sessionID:       "session-similar-prefix",
			cwd:             repoSimilarPrefix,
			wantKind:        agentSessionRailSectionKindConversations,
			wantProjectPath: "",
			wantKey:         agentSessionRailSectionKeyConversations,
		},
		{
			sessionID:       "session-nested",
			cwd:             nestedRepoSubdir,
			wantKind:        agentSessionRailSectionKindProject,
			wantProjectPath: nestedRepoCanonical,
			wantKey:         agentSessionRailSectionKeyForProject(nestedRepo),
		},
	} {
		if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
			WorkspaceID:      "ws-agent-rail",
			AgentSessionID:   tc.sessionID,
			Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:         "codex",
			Cwd:              tc.cwd,
			Status:           "completed",
			OccurredAtUnixMS: 100,
		}); err != nil {
			t.Fatalf("ReportSessionState(%s) error = %v", tc.sessionID, err)
		}
		rail := getTestAgentSessionRailSection(t, store, "ws-agent-rail", tc.sessionID)
		if rail.Kind != tc.wantKind || rail.ProjectPath != tc.wantProjectPath || rail.Key != tc.wantKey {
			t.Fatalf("rail(%s) = %#v, want kind=%q projectPath=%q key=%q", tc.sessionID, rail, tc.wantKind, tc.wantProjectPath, tc.wantKey)
		}
	}
}

func TestSQLiteStoreAgentSessionRailProjectDeletionDoesNotRewriteHistory(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-rail-delete",
		Name: "Workspace Agent Rail Delete",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	repo := filepath.Join(t.TempDir(), "repo")
	repoSubdir := filepath.Join(repo, "pkg")
	if err := mkdirAll(repoSubdir); err != nil {
		t.Fatalf("mkdir repo error = %v", err)
	}
	repoCanonical := normalizeAgentSessionRailPath(repo)
	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "project-repo",
		Path:  repo,
		Label: "repo",
	}); err != nil {
		t.Fatalf("PutUserProject(repo) error = %v", err)
	}

	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-rail-delete",
		AgentSessionID:   "session-before-delete",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Cwd:              repoSubdir,
		Status:           "completed",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState(before delete) error = %v", err)
	}
	beforeDelete := getTestAgentSessionRailSection(t, store, "ws-agent-rail-delete", "session-before-delete")
	if beforeDelete.Key != agentSessionRailSectionKeyForProject(repoCanonical) {
		t.Fatalf("before delete rail = %#v, want project key", beforeDelete)
	}

	if err := store.DeleteUserProject(ctx, "project-repo"); err != nil {
		t.Fatalf("DeleteUserProject() error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-rail-delete",
		AgentSessionID:   "session-before-delete",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Cwd:              repoSubdir,
		Status:           "completed",
		OccurredAtUnixMS: 150,
	}); err != nil {
		t.Fatalf("ReportSessionState(after delete same cwd) error = %v", err)
	}
	afterDeleteUpsert := getTestAgentSessionRailSection(t, store, "ws-agent-rail-delete", "session-before-delete")
	if afterDeleteUpsert != beforeDelete {
		t.Fatalf("rail changed after same-cwd upsert with deleted user project: got %#v want %#v", afterDeleteUpsert, beforeDelete)
	}

	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "project-repo-readded",
		Path:  repo,
		Label: "repo",
	}); err != nil {
		t.Fatalf("PutUserProject(repo readded) error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-rail-delete",
		AgentSessionID:   "session-after-readd",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Cwd:              repoSubdir,
		Status:           "completed",
		OccurredAtUnixMS: 200,
	}); err != nil {
		t.Fatalf("ReportSessionState(after readd) error = %v", err)
	}
	afterReadd := getTestAgentSessionRailSection(t, store, "ws-agent-rail-delete", "session-after-readd")
	if afterReadd.Key != beforeDelete.Key {
		t.Fatalf("rail key after readd = %q, want %q", afterReadd.Key, beforeDelete.Key)
	}
}

func TestSQLiteStoreAgentSessionRailPreservesKeyAcrossCwdChangesAndRepairsMissingRail(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-rail-reclassify",
		Name: "Workspace Agent Rail Reclassify",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	root := t.TempDir()
	repo := filepath.Join(root, "repo")
	repoSubdir := filepath.Join(repo, "pkg")
	otherDir := filepath.Join(root, "other")
	for _, path := range []string{repoSubdir, otherDir} {
		if err := mkdirAll(path); err != nil {
			t.Fatalf("mkdir %q error = %v", path, err)
		}
	}
	repoCanonical := normalizeAgentSessionRailPath(repo)
	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "project-repo",
		Path:  repo,
		Label: "repo",
	}); err != nil {
		t.Fatalf("PutUserProject(repo) error = %v", err)
	}

	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-rail-reclassify",
		AgentSessionID:   "session-cwd-change",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Cwd:              repoSubdir,
		Status:           "running",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState(project cwd) error = %v", err)
	}
	initial := getTestAgentSessionRailSection(t, store, "ws-agent-rail-reclassify", "session-cwd-change")
	if initial.Kind != agentSessionRailSectionKindProject ||
		initial.ProjectPath != repoCanonical ||
		initial.Key != agentSessionRailSectionKeyForProject(repoCanonical) {
		t.Fatalf("initial rail = %#v, want project %q", initial, repoCanonical)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-rail-reclassify",
		AgentSessionID:   "session-cwd-change",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Cwd:              otherDir,
		Status:           "completed",
		OccurredAtUnixMS: 200,
	}); err != nil {
		t.Fatalf("ReportSessionState(other cwd) error = %v", err)
	}
	changed := getTestAgentSessionRailSection(t, store, "ws-agent-rail-reclassify", "session-cwd-change")
	if changed != initial {
		t.Fatalf("changed cwd rail = %#v, want immutable %#v", changed, initial)
	}

	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-rail-reclassify",
		AgentSessionID:   "session-empty-rail",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Cwd:              repoSubdir,
		Status:           "running",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState(empty rail initial) error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET rail_section_kind = '',
    rail_project_path = '',
    rail_section_key = ''
WHERE workspace_id = ? AND agent_session_id = ?;
`, "ws-agent-rail-reclassify", "session-empty-rail"); err != nil {
		t.Fatalf("clear rail fields error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-rail-reclassify",
		AgentSessionID:   "session-empty-rail",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Cwd:              repoSubdir,
		Status:           "completed",
		OccurredAtUnixMS: 200,
	}); err != nil {
		t.Fatalf("ReportSessionState(empty rail repair) error = %v", err)
	}
	repaired := getTestAgentSessionRailSection(t, store, "ws-agent-rail-reclassify", "session-empty-rail")
	if repaired.Key != agentSessionRailSectionKeyForProject(repoCanonical) {
		t.Fatalf("repaired rail = %#v, want project key", repaired)
	}
}

func TestSQLiteStoreAgentSessionRailMessageOnlySessionUsesConversations(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-rail-message-only",
		Name: "Workspace Agent Rail Message Only",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "ws-agent-rail-message-only", AgentSessionID: "session-message-only",
		Origin: agentsessionstore.WorkspaceAgentSessionOriginRuntime, Provider: "codex", OccurredAtUnixMS: 90,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	seedTestAgentTurn(t, store, ctx, "ws-agent-rail-message-only", "session-message-only", "turn-1", "codex", 95)

	if _, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-rail-message-only",
		AgentSessionID: "session-message-only",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:       "codex",
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID:        "message-1",
			TurnID:           "turn-1",
			Role:             "user",
			Kind:             "text",
			Status:           "completed",
			Payload:          map[string]any{"text": "hello"},
			OccurredAtUnixMS: 100,
		}},
	}); err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	rail := getTestAgentSessionRailSection(t, store, "ws-agent-rail-message-only", "session-message-only")
	if rail.Kind != agentSessionRailSectionKindConversations ||
		rail.ProjectPath != "" ||
		rail.Key != agentSessionRailSectionKeyConversations {
		t.Fatalf("message-only rail = %#v, want conversations", rail)
	}
}

func TestAgentSessionRailScratchDateDirectoriesUseConversations(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	for _, cwd := range []string{
		filepath.Join(home, "Documents", "Codex", "2026-07-03", "codex-session"),
		filepath.Join(home, "Documents", "Tutti", "2026-07-03", "tutti-session"),
	} {
		if err := mkdirAll(cwd); err != nil {
			t.Fatalf("mkdir %q error = %v", cwd, err)
		}
		rail := classifyAgentSessionRailSection(cwd, nil, nil)
		if rail.Kind != agentSessionRailSectionKindConversations ||
			rail.ProjectPath != "" ||
			rail.Key != agentSessionRailSectionKeyConversations {
			t.Fatalf("scratch cwd %q rail = %#v, want conversations", cwd, rail)
		}
	}
}

func TestSQLiteStoreAgentSessionRailNoProjectPrecedesParentProject(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-rail-no-project",
		Name: "Workspace Agent Rail No Project",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	scratchCwd := filepath.Join(home, "Documents", "Codex", "2026-07-03", "codex-session")
	importedNoProjectCwd := filepath.Join(home, "external-import")
	for _, path := range []string{scratchCwd, importedNoProjectCwd} {
		if err := mkdirAll(path); err != nil {
			t.Fatalf("mkdir %q error = %v", path, err)
		}
	}
	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "project-home",
		Path:  home,
		Label: "home",
	}); err != nil {
		t.Fatalf("PutUserProject(home) error = %v", err)
	}

	for _, tc := range []struct {
		sessionID      string
		cwd            string
		runtimeContext map[string]any
	}{
		{
			sessionID: "session-scratch-under-home",
			cwd:       scratchCwd,
		},
		{
			sessionID:      "session-import-marker-under-home",
			cwd:            importedNoProjectCwd,
			runtimeContext: map[string]any{"externalImportNoProject": true},
		},
		{
			sessionID:      "session-no-project-marker-under-home",
			cwd:            importedNoProjectCwd,
			runtimeContext: map[string]any{"noProject": true},
		},
	} {
		if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
			WorkspaceID:      "ws-agent-rail-no-project",
			AgentSessionID:   tc.sessionID,
			Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:         "codex",
			RuntimeContext:   tc.runtimeContext,
			Cwd:              tc.cwd,
			Status:           "completed",
			OccurredAtUnixMS: 100,
		}); err != nil {
			t.Fatalf("ReportSessionState(%s) error = %v", tc.sessionID, err)
		}
		rail := getTestAgentSessionRailSection(t, store, "ws-agent-rail-no-project", tc.sessionID)
		if rail.Kind != agentSessionRailSectionKindConversations ||
			rail.ProjectPath != "" ||
			rail.Key != agentSessionRailSectionKeyConversations {
			t.Fatalf("rail(%s) = %#v, want conversations", tc.sessionID, rail)
		}
	}
}

func TestSQLiteStoreAgentSessionRailExactProjectPrecedesNoProject(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-rail-exact-project",
		Name: "Workspace Agent Rail Exact Project",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	scratchCwd := filepath.Join(home, "Documents", "Codex", "2026-07-03", "codex-session")
	if err := mkdirAll(scratchCwd); err != nil {
		t.Fatalf("mkdir scratch cwd error = %v", err)
	}
	scratchCanonical := normalizeAgentSessionRailPath(scratchCwd)
	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "project-scratch",
		Path:  scratchCwd,
		Label: "scratch",
	}); err != nil {
		t.Fatalf("PutUserProject(scratch) error = %v", err)
	}

	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-rail-exact-project",
		AgentSessionID:   "session-exact-scratch",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		RuntimeContext:   map[string]any{"externalImportNoProject": true},
		Cwd:              scratchCwd,
		Status:           "completed",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	rail := getTestAgentSessionRailSection(t, store, "ws-agent-rail-exact-project", "session-exact-scratch")
	if rail.Kind != agentSessionRailSectionKindProject ||
		rail.ProjectPath != scratchCanonical ||
		rail.Key != agentSessionRailSectionKeyForProject(scratchCanonical) {
		t.Fatalf("rail = %#v, want exact scratch project %q", rail, scratchCanonical)
	}
}

func TestSQLiteStoreMigrationBackfillsAgentSessionRailSectionsFromUserProjects(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "tuttid.db")
	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})

	repo := filepath.Join(t.TempDir(), "repo")
	repoSubdir := filepath.Join(repo, "pkg")
	importedNoProjectDir := filepath.Join(repo, "imported-no-project")
	otherDir := filepath.Join(t.TempDir(), "other")
	for _, path := range []string{repoSubdir, importedNoProjectDir, otherDir} {
		if err := mkdirAll(path); err != nil {
			t.Fatalf("mkdir %q error = %v", path, err)
		}
	}
	repoCanonical := normalizeAgentSessionRailPath(repo)

	ctx := context.Background()
	if _, err := store.writeDB.ExecContext(ctx, `
CREATE TABLE tuttid_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);
CREATE TABLE user_projects (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  last_used_at_unix_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE workspace_agent_sessions (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  runtime_context_json TEXT NOT NULL DEFAULT '{}',
  cwd TEXT NOT NULL DEFAULT '',
  deleted_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id)
);
`); err != nil {
		t.Fatalf("create legacy rail schema error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
INSERT INTO user_projects (id, path, label, created_at_unix_ms, updated_at_unix_ms, last_used_at_unix_ms)
VALUES ('project-repo', ?, 'repo', 1, 1, 1);
`, repo); err != nil {
		t.Fatalf("insert legacy user project error = %v", err)
	}
	if _, err := store.writeDB.ExecContext(ctx, `
INSERT INTO workspace_agent_sessions (workspace_id, agent_session_id, runtime_context_json, cwd, deleted_at_unix_ms, updated_at_unix_ms)
VALUES
  ('ws-agent-rail-migration', 'session-project', '{}', ?, 0, 1),
  ('ws-agent-rail-migration', 'session-import-no-project', '{"externalImportNoProject":true}', ?, 0, 1),
  ('ws-agent-rail-migration', 'session-conversations', '{}', ?, 0, 1);
`, repoSubdir, importedNoProjectDir, otherDir); err != nil {
		t.Fatalf("insert legacy agent sessions error = %v", err)
	}

	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	projectRail := getTestAgentSessionRailSection(t, store, "ws-agent-rail-migration", "session-project")
	if projectRail.Kind != agentSessionRailSectionKindProject ||
		projectRail.ProjectPath != repoCanonical ||
		projectRail.Key != agentSessionRailSectionKeyForProject(repoCanonical) {
		t.Fatalf("project rail = %#v, want project %q", projectRail, repoCanonical)
	}
	importNoProjectRail := getTestAgentSessionRailSection(t, store, "ws-agent-rail-migration", "session-import-no-project")
	if importNoProjectRail.Kind != agentSessionRailSectionKindConversations ||
		importNoProjectRail.ProjectPath != "" ||
		importNoProjectRail.Key != agentSessionRailSectionKeyConversations {
		t.Fatalf("import no-project rail = %#v, want conversations", importNoProjectRail)
	}
	conversationRail := getTestAgentSessionRailSection(t, store, "ws-agent-rail-migration", "session-conversations")
	if conversationRail.Kind != agentSessionRailSectionKindConversations ||
		conversationRail.ProjectPath != "" ||
		conversationRail.Key != agentSessionRailSectionKeyConversations {
		t.Fatalf("conversation rail = %#v, want conversations", conversationRail)
	}
}

func TestSQLiteStorePreservesAgentTargetIDAcrossStateReports(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-target-activity",
		Name: "Workspace Agent Target Activity",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:       "ws-agent-target-activity",
		AgentSessionID:    "session-1",
		AgentTargetID:     "local:codex",
		Origin:            agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:          "codex",
		ProviderSessionID: "provider-session-1",
		Cwd:               "/workspace",
		Title:             "target session",
		Status:            "running",
		OccurredAtUnixMS:  100,
		StartedAtUnixMS:   90,
	}); err != nil {
		t.Fatalf("ReportSessionState(with target) error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-target-activity",
		AgentSessionID:   "session-1",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Cwd:              "/workspace",
		Title:            "target session",
		Status:           "ready",
		OccurredAtUnixMS: 200,
		StartedAtUnixMS:  90,
	}); err != nil {
		t.Fatalf("ReportSessionState(without target) error = %v", err)
	}

	session, ok, err := store.GetSession(ctx, "ws-agent-target-activity", "session-1")
	if err != nil {
		t.Fatalf("GetSession() error = %v", err)
	}
	if !ok {
		t.Fatal("GetSession() ok = false, want true")
	}
	if session.AgentTargetID != "local:codex" {
		t.Fatalf("GetSession() agent target id = %q, want local:codex", session.AgentTargetID)
	}
	sessions, ok, err := store.ListSessions(ctx, "ws-agent-target-activity")
	if err != nil {
		t.Fatalf("ListSessions() error = %v", err)
	}
	if !ok || len(sessions) != 1 {
		t.Fatalf("ListSessions() ok=%v len=%d, want one session", ok, len(sessions))
	}
	if sessions[0].AgentTargetID != "local:codex" {
		t.Fatalf("ListSessions() agent target id = %q, want local:codex", sessions[0].AgentTargetID)
	}
}

func TestSQLiteStoreGeneratedFilesDoNotFallbackToMessages(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-generated-files",
		Name: "Workspace Agent Generated Files",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	for _, session := range []struct {
		id  string
		cwd string
	}{
		{id: "session-1", cwd: "/workspace"},
		{id: "session-2", cwd: "/workspace/other"},
	} {
		if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
			WorkspaceID:      "ws-agent-generated-files",
			AgentSessionID:   session.id,
			Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:         "codex",
			Cwd:              session.cwd,
			Status:           "completed",
			OccurredAtUnixMS: 100,
		}); err != nil {
			t.Fatalf("ReportSessionState(%s) error = %v", session.id, err)
		}
	}
	seedTestAgentTurn(t, store, ctx, "ws-agent-generated-files", "session-1", "turn-1", "codex", 105)
	seedTestAgentTurn(t, store, ctx, "ws-agent-generated-files", "session-2", "turn-2", "codex", 105)
	if _, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-generated-files",
		AgentSessionID: "session-1",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{
			{
				MessageID: "message-1",
				TurnID:    "turn-1",
				Role:      "assistant",
				Kind:      "tool_call",
				Status:    "completed",
				Payload: map[string]any{
					"toolName": "Write",
					"fileChanges": map[string]any{
						"files": []any{
							map[string]any{"path": "report.md"},
						},
					},
				},
				OccurredAtUnixMS: 110,
			},
			{
				MessageID: "message-1b",
				TurnID:    "turn-1",
				Role:      "assistant",
				Kind:      "tool_call",
				Status:    "completed",
				Payload: map[string]any{
					"toolName": "Edit",
					"input": map[string]any{
						"file_path": "assets/styles.css",
						"changes": []any{
							map[string]any{
								"path": "slides/02-why-now.html",
								"kind": map[string]any{"type": "add"},
								"diff": "<section>Why now</section>\n",
							},
							map[string]any{
								"path": "slides/01-cover.html",
								"kind": map[string]any{"type": "update"},
								"diff": "@@ -1 +1 @@\n-Old\n+New\n",
							},
						},
					},
				},
				OccurredAtUnixMS: 115,
			},
		},
	}); err != nil {
		t.Fatalf("ReportSessionMessages(session-1) error = %v", err)
	}
	if _, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-generated-files",
		AgentSessionID: "session-2",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID: "message-2",
			TurnID:    "turn-2",
			Role:      "assistant",
			Kind:      "tool_call",
			Status:    "completed",
			Payload: map[string]any{
				"output": map[string]any{
					"path": "/workspace/other/notes.txt",
				},
			},
			OccurredAtUnixMS: 120,
		}},
	}); err != nil {
		t.Fatalf("ReportSessionMessages(session-2) error = %v", err)
	}

	result, ok, err := store.ListWorkspaceGeneratedFileTurns(ctx, agentactivitybiz.ListWorkspaceGeneratedFileTurnsInput{
		WorkspaceID: "ws-agent-generated-files",
		SectionKey:  "conversations",
	})
	if err != nil {
		t.Fatalf("ListWorkspaceGeneratedFileTurns() error = %v", err)
	}
	if !ok {
		t.Fatal("ListWorkspaceGeneratedFileTurns() ok = false, want true")
	}
	if len(result.Turns) != 0 {
		t.Fatalf("turns = %#v, want no legacy message fallback", result.Turns)
	}

	arrayResult, ok, err := store.ListWorkspaceGeneratedFileTurns(ctx, agentactivitybiz.ListWorkspaceGeneratedFileTurnsInput{
		WorkspaceID: "ws-agent-generated-files",
		SectionKey:  "conversations",
	})
	if err != nil {
		t.Fatalf("ListWorkspaceGeneratedFileTurns(array changes) error = %v", err)
	}
	if !ok {
		t.Fatal("ListWorkspaceGeneratedFileTurns(array changes) ok = false, want true")
	}
	if len(arrayResult.Turns) != 0 {
		t.Fatalf("array turns = %#v, want no legacy message fallback", arrayResult.Turns)
	}
}

func TestSQLiteStoreGeneratedFilesIgnoreAllMessageToolPayloads(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-generated-files-failed",
		Name: "Workspace Agent Generated Files Failed",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-generated-files-failed",
		AgentSessionID:   "session-1",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Cwd:              "/workspace",
		Status:           "completed",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	seedTestAgentTurn(t, store, ctx, "ws-agent-generated-files-failed", "session-1", "turn-1", "codex", 105)
	if _, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-generated-files-failed",
		AgentSessionID: "session-1",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{
			{
				MessageID: "failed-status",
				TurnID:    "turn-1",
				Role:      "assistant",
				Kind:      "tool_call",
				Status:    "failed",
				Payload: map[string]any{
					"toolName": "Write",
					"fileChanges": map[string]any{
						"files": []any{
							map[string]any{"path": "failed-status.md"},
						},
					},
				},
				OccurredAtUnixMS: 110,
			},
			{
				MessageID: "failed-output",
				TurnID:    "turn-1",
				Role:      "assistant",
				Kind:      "tool_call",
				Status:    "completed",
				Payload: map[string]any{
					"toolName": "Write",
					"output": map[string]any{
						"path":    "failed-output.md",
						"status":  "failed",
						"success": false,
					},
				},
				OccurredAtUnixMS: 120,
			},
			{
				MessageID: "read-tool",
				TurnID:    "turn-1",
				Role:      "assistant",
				Kind:      "tool_call",
				Status:    "completed",
				Payload: map[string]any{
					"toolName": "Bash",
					"fileChanges": map[string]any{
						"files": []any{
							map[string]any{"path": "read-filechanges.md"},
						},
					},
					"input": map[string]any{
						"command":   "nl -ba readme.md",
						"changes":   map[string]any{"read-input-changes.md": "read"},
						"file_path": "readme.md",
					},
					"output": map[string]any{
						"status":  "completed",
						"success": true,
					},
				},
				OccurredAtUnixMS: 130,
			},
			{
				MessageID: "successful-write",
				TurnID:    "turn-1",
				Role:      "assistant",
				Kind:      "tool_call",
				Status:    "completed",
				Payload: map[string]any{
					"toolName": "Write",
					"output": map[string]any{
						"filePath": "ok.md",
						"status":   "completed",
						"success":  true,
					},
				},
				OccurredAtUnixMS: 140,
			},
		},
	}); err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}

	result, ok, err := store.ListWorkspaceGeneratedFileTurns(ctx, agentactivitybiz.ListWorkspaceGeneratedFileTurnsInput{
		WorkspaceID: "ws-agent-generated-files-failed",
		SectionKey:  "conversations",
	})
	if err != nil {
		t.Fatalf("ListWorkspaceGeneratedFileTurns() error = %v", err)
	}
	if !ok {
		t.Fatal("ListWorkspaceGeneratedFileTurns() ok = false, want true")
	}
	if len(result.Turns) != 0 {
		t.Fatalf("turns = %#v, want no message-derived turns", result.Turns)
	}
}

func TestSQLiteStoreReportsProviderSessionMessagesToCanonicalAgentSession(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-provider-message",
		Name: "Workspace Agent Provider Message",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:       "ws-agent-provider-message",
		AgentSessionID:    "session-1",
		Origin:            agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:          "codex",
		ProviderSessionID: "provider-session-1",
		Status:            "running",
		OccurredAtUnixMS:  100,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	seedTestAgentTurn(t, store, ctx, "ws-agent-provider-message", "session-1", "turn-approval-1", "codex", 105)

	result, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-provider-message",
		AgentSessionID: "provider-session-1",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID:        "approval-1",
			TurnID:           "turn-approval-1",
			Role:             "assistant",
			Kind:             "tool_call",
			Status:           "waiting",
			Payload:          map[string]any{"toolName": "Bash"},
			OccurredAtUnixMS: 110,
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if result.AcceptedCount != 1 || result.LatestVersion != 1 {
		t.Fatalf("result = %#v, want one canonical message", result)
	}
	if result.Messages[0].AgentSessionID != "session-1" {
		t.Fatalf("accepted message session id = %q, want session-1", result.Messages[0].AgentSessionID)
	}

	page, ok, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    "ws-agent-provider-message",
		AgentSessionID: "session-1",
		Limit:          10,
	})
	if err != nil {
		t.Fatalf("ListSessionMessages(canonical) error = %v", err)
	}
	if !ok || len(page.Messages) != 1 || page.Messages[0].AgentSessionID != "session-1" {
		t.Fatalf("canonical page = %#v ok=%v, want message under session-1", page, ok)
	}
	if _, ok, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    "ws-agent-provider-message",
		AgentSessionID: "provider-session-1",
		Limit:          10,
	}); err != nil || ok {
		t.Fatalf("ListSessionMessages(provider) ok=%v error=%v, want no alias session", ok, err)
	}
}

func TestSQLiteStoreReportsProviderSessionMessagesToSameOriginSession(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-provider-origin-message",
		Name: "Workspace Agent Provider Origin Message",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:       "ws-agent-provider-origin-message",
		AgentSessionID:    "runtime-1",
		Origin:            agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:          "codex",
		ProviderSessionID: "shared-provider-session",
		Status:            "running",
		OccurredAtUnixMS:  100,
	}); err != nil {
		t.Fatalf("ReportSessionState(runtime) error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:       "ws-agent-provider-origin-message",
		AgentSessionID:    "runtime-2",
		Origin:            agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:          "codex",
		ProviderSessionID: "shared-provider-session",
		Status:            "running",
		OccurredAtUnixMS:  100,
	}); err != nil {
		t.Fatalf("ReportSessionState(runtime-2) error = %v", err)
	}
	seedTestAgentTurn(t, store, ctx, "ws-agent-provider-origin-message", "shared-provider-session", "turn-runtime-1", "codex", 105)

	result, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-provider-origin-message",
		AgentSessionID: "shared-provider-session",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID:        "runtime-message-1",
			TurnID:           "turn-runtime-1",
			Role:             "assistant",
			Kind:             "text",
			Status:           "completed",
			Payload:          map[string]any{"text": "runtime"},
			OccurredAtUnixMS: 110,
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if result.AcceptedCount != 1 || result.Messages[0].AgentSessionID != "shared-provider-session" {
		t.Fatalf("result = %#v, want ambiguous message under provider session", result)
	}

	providerPage, ok, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    "ws-agent-provider-origin-message",
		AgentSessionID: "shared-provider-session",
		Limit:          10,
	})
	if err != nil {
		t.Fatalf("ListSessionMessages(provider) error = %v", err)
	}
	if !ok || len(providerPage.Messages) != 1 || providerPage.Messages[0].AgentSessionID != "shared-provider-session" {
		t.Fatalf("provider page = %#v ok=%v, want ambiguous provider message", providerPage, ok)
	}
	runtimePage, ok, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    "ws-agent-provider-origin-message",
		AgentSessionID: "runtime-1",
		Limit:          10,
	})
	if err != nil {
		t.Fatalf("ListSessionMessages(runtime) error = %v", err)
	}
	if !ok || len(runtimePage.Messages) != 0 {
		t.Fatalf("runtime page = %#v ok=%v, want no misrouted message", runtimePage, ok)
	}
}

func TestSQLiteStoreDoesNotResolveProviderSessionMessagesAcrossProviders(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-provider-collision-message",
		Name: "Workspace Agent Provider Collision Message",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:       "ws-agent-provider-collision-message",
		AgentSessionID:    "codex-session-1",
		Origin:            agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:          "codex",
		ProviderSessionID: "shared-provider-session",
		Status:            "running",
		OccurredAtUnixMS:  100,
	}); err != nil {
		t.Fatalf("ReportSessionState(codex) error = %v", err)
	}
	seedTestAgentTurn(t, store, ctx, "ws-agent-provider-collision-message", "shared-provider-session", "turn-claude-1", "claude", 105)

	result, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-provider-collision-message",
		AgentSessionID: "shared-provider-session",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:       "claude",
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID:        "claude-message-1",
			TurnID:           "turn-claude-1",
			Role:             "assistant",
			Kind:             "text",
			Status:           "completed",
			Payload:          map[string]any{"text": "claude"},
			OccurredAtUnixMS: 110,
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if result.AcceptedCount != 1 || result.Messages[0].AgentSessionID != "shared-provider-session" {
		t.Fatalf("result = %#v, want message under raw claude provider session", result)
	}

	codexPage, ok, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    "ws-agent-provider-collision-message",
		AgentSessionID: "codex-session-1",
		Limit:          10,
	})
	if err != nil {
		t.Fatalf("ListSessionMessages(codex) error = %v", err)
	}
	if !ok || len(codexPage.Messages) != 0 {
		t.Fatalf("codex page = %#v ok=%v, want no provider-mismatched message", codexPage, ok)
	}
}

func TestSQLiteStorePersistsLargeAgentActivityMessagePayload(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	largeContent := strings.Repeat("完整回答", 24000)

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-large-message",
		Name: "Workspace Agent Large Message",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	seedTestAgentTurn(t, store, ctx, "ws-agent-large-message", "session-large", "turn-large", "codex", 105)

	result, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-large-message",
		AgentSessionID: "session-large",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID:        "message-large",
			TurnID:           "turn-large",
			Role:             "assistant",
			Kind:             "text",
			Status:           "completed",
			Payload:          map[string]any{"content": largeContent, "text": largeContent},
			OccurredAtUnixMS: 110,
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if result.AcceptedCount != 1 || result.LatestVersion != 1 {
		t.Fatalf("result = %#v, want one accepted message", result)
	}

	page, ok, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    "ws-agent-large-message",
		AgentSessionID: "session-large",
		Limit:          10,
	})
	if err != nil {
		t.Fatalf("ListSessionMessages() error = %v", err)
	}
	if !ok || len(page.Messages) != 1 {
		t.Fatalf("page = %#v ok=%v, want one message", page, ok)
	}
	message := page.Messages[0]
	content, _ := message.Payload["content"].(string)
	text, _ := message.Payload["text"].(string)
	if content != largeContent || text != largeContent {
		t.Fatalf(
			"message payload lengths content=%d text=%d, want %d",
			len(content),
			len(text),
			len(largeContent),
		)
	}
}

func TestSQLiteStoreReportSessionStateReturnsCurrentLastEventForStalePatch(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-state-order",
		Name: "Workspace Agent State Order",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-state-order",
		AgentSessionID:   "session-1",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Status:           "completed",
		CurrentPhase:     "idle",
		OccurredAtUnixMS: 200,
		EndedAtUnixMS:    200,
	}); err != nil {
		t.Fatalf("ReportSessionState(completed) error = %v", err)
	}

	state, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-state-order",
		AgentSessionID:   "session-1",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Status:           "active",
		CurrentPhase:     "working",
		OccurredAtUnixMS: 150,
	})
	if err != nil {
		t.Fatalf("ReportSessionState(stale) error = %v", err)
	}
	if !state.Accepted || state.LastEventUnixMS != 200 {
		t.Fatalf("stale state result = %#v, want accepted with current last event 200", state)
	}
	if state.StateApplied {
		t.Fatalf("stale state applied = true, want false")
	}
	if state.Session.LastEventUnixMS != 200 {
		t.Fatalf("projected session last event = %d, want 200", state.Session.LastEventUnixMS)
	}
	session, ok, err := store.GetSession(ctx, "ws-agent-state-order", "session-1")
	if err != nil {
		t.Fatalf("GetSession() error = %v", err)
	}
	if !ok {
		t.Fatal("GetSession() ok = false, want true")
	}
	if session.LastEventUnixMS != 200 {
		t.Fatalf("session last event = %d, want 200", session.LastEventUnixMS)
	}
}

func TestSQLiteStoreListAgentSessionsByUpdatedAtDescending(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-session-order",
		Name: "Workspace Agent Session Order",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}

	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-session-order",
		AgentSessionID:   "session-older",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Cwd:              "/workspace",
		Status:           "completed",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState(session-older) error = %v", err)
	}

	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-session-order",
		AgentSessionID:   "session-newer",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Cwd:              "/workspace",
		Status:           "running",
		OccurredAtUnixMS: 200,
	}); err != nil {
		t.Fatalf("ReportSessionState(session-newer) error = %v", err)
	}

	sessions, ok, err := store.ListSessions(ctx, "ws-agent-session-order")
	if err != nil {
		t.Fatalf("ListSessions() error = %v", err)
	}
	if !ok {
		t.Fatal("ListSessions() ok = false, want true")
	}
	if len(sessions) != 2 {
		t.Fatalf("ListSessions() len = %d, want 2", len(sessions))
	}
	if sessions[0].ID != "session-newer" || sessions[1].ID != "session-older" {
		t.Fatalf("ListSessions() order = [%s %s], want [session-newer session-older]", sessions[0].ID, sessions[1].ID)
	}
}

func TestSQLiteStoreListSessionSectionPagesByRailSectionKey(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-section-page",
		Name: "Workspace Agent Section Page",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "project-app",
		Path:  "/workspace/app",
		Label: "App",
	}); err != nil {
		t.Fatalf("PutUserProject() error = %v", err)
	}
	for _, input := range []agentactivitybiz.SessionStateReport{
		{
			WorkspaceID:      "ws-agent-section-page",
			AgentSessionID:   "project-newer",
			Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:         "codex",
			Cwd:              "/workspace/app",
			Status:           "completed",
			OccurredAtUnixMS: 300,
		},
		{
			WorkspaceID:      "ws-agent-section-page",
			AgentSessionID:   "project-older",
			Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:         "codex",
			Cwd:              "/workspace/app/pkg",
			Status:           "completed",
			OccurredAtUnixMS: 200,
		},
		{
			WorkspaceID:      "ws-agent-section-page",
			AgentSessionID:   "chat",
			Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:         "codex",
			Cwd:              "/scratch/session",
			RuntimeContext:   map[string]any{"externalImportNoProject": true},
			Status:           "completed",
			OccurredAtUnixMS: 100,
		},
	} {
		if err := reportSessionStateWithStableUpdatedAt(ctx, store, input); err != nil {
			t.Fatalf("ReportSessionState(%s) error = %v", input.AgentSessionID, err)
		}
	}

	projectPage, ok, err := store.ListSessionSection(ctx, agentactivitybiz.ListSessionSectionInput{
		WorkspaceID: "ws-agent-section-page",
		SectionKey:  "project:/workspace/app",
		Limit:       1,
	})
	if err != nil {
		t.Fatalf("ListSessionSection(project) error = %v", err)
	}
	if !ok {
		t.Fatal("ListSessionSection(project) ok=false, want true")
	}
	if got, want := activitySessionIDs(projectPage.Sessions), []string{"project-older"}; !slices.Equal(got, want) {
		t.Fatalf("project page sessions = %#v, want %#v", got, want)
	}
	cursorParts := strings.SplitN(projectPage.NextCursor, "|", 2)
	if !projectPage.HasMore || len(cursorParts) != 2 || cursorParts[1] != "project-older" {
		t.Fatalf("project page cursor = %q hasMore=%v, want cursor for project-older true", projectPage.NextCursor, projectPage.HasMore)
	}

	nextProjectPage, ok, err := store.ListSessionSection(ctx, agentactivitybiz.ListSessionSectionInput{
		WorkspaceID:          "ws-agent-section-page",
		SectionKey:           "project:/workspace/app",
		CursorSortTimeUnixMS: projectPage.Sessions[0].CreatedAtUnixMS,
		CursorSessionID:      "project-older",
		Limit:                2,
	})
	if err != nil {
		t.Fatalf("ListSessionSection(project next) error = %v", err)
	}
	if !ok {
		t.Fatal("ListSessionSection(project next) ok=false, want true")
	}
	if got, want := activitySessionIDs(nextProjectPage.Sessions), []string{"project-newer"}; !slices.Equal(got, want) {
		t.Fatalf("project next sessions = %#v, want %#v", got, want)
	}

	conversationsPage, ok, err := store.ListSessionSection(ctx, agentactivitybiz.ListSessionSectionInput{
		WorkspaceID: "ws-agent-section-page",
		SectionKey:  "conversations",
		Limit:       5,
	})
	if err != nil {
		t.Fatalf("ListSessionSection(conversations) error = %v", err)
	}
	if !ok {
		t.Fatal("ListSessionSection(conversations) ok=false, want true")
	}
	if got, want := activitySessionIDs(conversationsPage.Sessions), []string{"chat"}; !slices.Equal(got, want) {
		t.Fatalf("conversations sessions = %#v, want %#v", got, want)
	}
}

func TestSQLiteStoreListSessionSectionFiltersAgentTargetBeforePagination(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-section-target-filter",
		Name: "Workspace Agent Section Target Filter",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{
		ID:    "project-app",
		Path:  "/workspace/app",
		Label: "App",
	}); err != nil {
		t.Fatalf("PutUserProject() error = %v", err)
	}
	reports := []agentactivitybiz.SessionStateReport{
		{
			WorkspaceID:      "ws-agent-section-target-filter",
			AgentSessionID:   "claude-1",
			AgentTargetID:    "claude-target",
			Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:         "claude-code",
			Cwd:              "/workspace/app",
			Status:           "completed",
			OccurredAtUnixMS: 600,
		},
		{
			WorkspaceID:      "ws-agent-section-target-filter",
			AgentSessionID:   "claude-2",
			AgentTargetID:    "claude-target",
			Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:         "claude-code",
			Cwd:              "/workspace/app/pkg",
			Status:           "completed",
			OccurredAtUnixMS: 500,
		},
	}
	for index := range 4 {
		reports = append(reports, agentactivitybiz.SessionStateReport{
			WorkspaceID:      "ws-agent-section-target-filter",
			AgentSessionID:   fmt.Sprintf("codex-%d", index+1),
			AgentTargetID:    "codex-target",
			Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:         "codex",
			Cwd:              "/workspace/app",
			Status:           "completed",
			OccurredAtUnixMS: int64(400 - index),
		})
	}
	for _, input := range reports {
		if err := reportSessionStateWithStableUpdatedAt(ctx, store, input); err != nil {
			t.Fatalf("ReportSessionState(%s) error = %v", input.AgentSessionID, err)
		}
	}

	allTargetsPage, ok, err := store.ListSessionSection(ctx, agentactivitybiz.ListSessionSectionInput{
		WorkspaceID: "ws-agent-section-target-filter",
		SectionKey:  "project:/workspace/app",
		Limit:       5,
	})
	if err != nil {
		t.Fatalf("ListSessionSection(all targets) error = %v", err)
	}
	if !ok {
		t.Fatal("ListSessionSection(all targets) ok=false, want true")
	}
	if !allTargetsPage.HasMore {
		t.Fatalf("all targets hasMore = false, want true")
	}

	claudePage, ok, err := store.ListSessionSection(ctx, agentactivitybiz.ListSessionSectionInput{
		WorkspaceID:   "ws-agent-section-target-filter",
		SectionKey:    "project:/workspace/app",
		AgentTargetID: "claude-target",
		Limit:         5,
	})
	if err != nil {
		t.Fatalf("ListSessionSection(claude target) error = %v", err)
	}
	if !ok {
		t.Fatal("ListSessionSection(claude target) ok=false, want true")
	}
	if got, want := activitySessionIDs(claudePage.Sessions), []string{"claude-2", "claude-1"}; !slices.Equal(got, want) {
		t.Fatalf("claude sessions = %#v, want %#v", got, want)
	}
	if claudePage.HasMore || claudePage.NextCursor != "" {
		t.Fatalf("claude page state = hasMore %v cursor %q, want false empty", claudePage.HasMore, claudePage.NextCursor)
	}
}

func TestSQLiteStoreSessionSectionSeparatesPinnedAndDeletionCandidates(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "ws-agent-section-pinned"
	if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: "Pinned Sections"}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := store.PutUserProject(ctx, userprojectbiz.Project{ID: "project-app", Path: "/workspace/app", Label: "App"}); err != nil {
		t.Fatalf("PutUserProject() error = %v", err)
	}
	for index, sessionID := range []string{"ordinary", "pinned"} {
		if err := reportSessionStateWithStableUpdatedAt(ctx, store, agentactivitybiz.SessionStateReport{
			WorkspaceID: workspaceID, AgentSessionID: sessionID,
			AgentTargetID: "codex-target", Origin: agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider: "codex", Cwd: "/workspace/app", Status: "completed", OccurredAtUnixMS: int64(100 + index),
		}); err != nil {
			t.Fatalf("ReportSessionState(%s) error = %v", sessionID, err)
		}
	}
	if _, ok, err := store.UpdateSessionPinned(ctx, workspaceID, "pinned", true); err != nil || !ok {
		t.Fatalf("UpdateSessionPinned() ok=%v error=%v, want true nil", ok, err)
	}

	ordinaryPage, ok, err := store.ListSessionSection(ctx, agentactivitybiz.ListSessionSectionInput{
		WorkspaceID: workspaceID, SectionKey: "project:/workspace/app", Limit: 1,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSection() ok=%v error=%v", ok, err)
	}
	if got, want := activitySessionIDs(ordinaryPage.Sessions), []string{"ordinary"}; !slices.Equal(got, want) || ordinaryPage.HasMore {
		t.Fatalf("ordinary page = %#v hasMore=%v, want %#v false", got, ordinaryPage.HasMore, want)
	}
	pinnedPage, ok, err := store.ListSessionSection(ctx, agentactivitybiz.ListSessionSectionInput{
		WorkspaceID: workspaceID, SectionKey: agentactivitybiz.PinnedSessionPageKey, Limit: 5,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSection(pinned) ok=%v error=%v", ok, err)
	}
	if got, want := activitySessionIDs(pinnedPage.Sessions), []string{"pinned"}; !slices.Equal(got, want) {
		t.Fatalf("pinned page = %#v, want %#v", got, want)
	}

	excluded, ok, err := store.ListSessionSectionDeletionCandidates(ctx, agentactivitybiz.ListSessionSectionDeletionCandidatesInput{
		WorkspaceID: workspaceID, SectionKey: "project:/workspace/app", AgentTargetID: "codex-target", ExcludePinned: true,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSectionDeletionCandidates(excluded) ok=%v error=%v", ok, err)
	}
	if got, want := excluded.SessionIDs, []string{"ordinary"}; !slices.Equal(got, want) {
		t.Fatalf("excluded candidates = %#v, want %#v", got, want)
	}
	included, ok, err := store.ListSessionSectionDeletionCandidates(ctx, agentactivitybiz.ListSessionSectionDeletionCandidatesInput{
		WorkspaceID: workspaceID, SectionKey: "project:/workspace/app",
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionSectionDeletionCandidates(included) ok=%v error=%v", ok, err)
	}
	if got, want := included.SessionIDs, []string{"pinned", "ordinary"}; !slices.Equal(got, want) {
		t.Fatalf("included candidates = %#v, want %#v", got, want)
	}
}

func TestSQLiteStoreDeleteSessionsBatchUsesExactIdempotentSnapshot(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	for _, workspaceID := range []string{"ws-agent-batch-delete", "ws-agent-batch-other"} {
		if err := store.Create(ctx, workspacebiz.Summary{ID: workspaceID, Name: workspaceID}); err != nil {
			t.Fatalf("Create(%s) error = %v", workspaceID, err)
		}
	}
	for _, sessionID := range []string{"snapshot", "new-session"} {
		if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
			WorkspaceID: "ws-agent-batch-delete", AgentSessionID: sessionID,
			Origin: agentsessionstore.WorkspaceAgentSessionOriginRuntime, Provider: "codex",
			Cwd: "/workspace/app", Status: "completed", OccurredAtUnixMS: 100,
		}); err != nil {
			t.Fatalf("ReportSessionState(%s) error = %v", sessionID, err)
		}
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID: "ws-agent-batch-other", AgentSessionID: "snapshot",
		Origin: agentsessionstore.WorkspaceAgentSessionOriginRuntime, Provider: "codex", Status: "completed", OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState(other) error = %v", err)
	}
	seedTestAgentTurn(t, store, ctx, "ws-agent-batch-delete", "snapshot", "turn-snapshot", "codex", 105)
	if _, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID: "ws-agent-batch-delete", AgentSessionID: "snapshot",
		Origin:   agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{{MessageID: "message-snapshot", TurnID: "turn-snapshot", Role: "assistant", Kind: "text", Status: "completed", Payload: map[string]any{"text": "done"}}},
	}); err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}
	if _, ok, err := store.UpdateSessionPinned(ctx, "ws-agent-batch-delete", "snapshot", true); err != nil || !ok {
		t.Fatalf("UpdateSessionPinned() ok=%v error=%v", ok, err)
	}

	result, err := store.DeleteSessionsBatch(ctx, agentactivitybiz.DeleteSessionsBatchInput{
		WorkspaceID: "ws-agent-batch-delete", SessionIDs: []string{"snapshot", "missing"},
	})
	if err != nil {
		t.Fatalf("DeleteSessionsBatch() error = %v", err)
	}
	if result.RemovedSessions != 1 || result.RemovedMessages != 1 || !slices.Equal(result.RemovedSessionIDs, []string{"snapshot"}) {
		t.Fatalf("DeleteSessionsBatch() = %#v", result)
	}
	if _, ok, _ := store.GetSession(ctx, "ws-agent-batch-delete", "new-session"); !ok {
		t.Fatal("new-session was deleted, want retained")
	}
	if _, ok, _ := store.GetSession(ctx, "ws-agent-batch-other", "snapshot"); !ok {
		t.Fatal("other workspace session was deleted, want retained")
	}
	retry, err := store.DeleteSessionsBatch(ctx, agentactivitybiz.DeleteSessionsBatchInput{
		WorkspaceID: "ws-agent-batch-delete", SessionIDs: []string{"snapshot"},
	})
	if err != nil || retry.RemovedSessions != 0 || len(retry.RemovedSessionIDs) != 0 {
		t.Fatalf("DeleteSessionsBatch(retry) = %#v error=%v, want no-op", retry, err)
	}
}

func TestSQLiteStoreDeleteAgentActivitySessionSoftDeletesMessages(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-delete",
		Name: "Workspace Agent Delete",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-delete",
		AgentSessionID:   "session-1",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Status:           "running",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	seedTestAgentTurn(t, store, ctx, "ws-agent-delete", "session-1", "turn-1", "codex", 105)
	if _, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-delete",
		AgentSessionID: "session-1",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID: "message-1",
			TurnID:    "turn-1",
			Role:      "assistant",
			Kind:      "text",
			Status:    "completed",
			Payload:   map[string]any{"text": "done"},
		}},
	}); err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}

	deleteResult, err := store.DeleteSessionsBatch(ctx, agentactivitybiz.DeleteSessionsBatchInput{
		WorkspaceID: "ws-agent-delete", SessionIDs: []string{"session-1"},
	})
	if err != nil {
		t.Fatalf("DeleteSessionsBatch() error = %v", err)
	}
	if deleteResult.RemovedSessions != 1 {
		t.Fatalf("DeleteSessionsBatch() = %#v, want one removed session", deleteResult)
	}
	if _, ok, err := store.GetSession(ctx, "ws-agent-delete", "session-1"); err != nil || ok {
		t.Fatalf("GetSession() after delete ok=%v error=%v, want ok=false", ok, err)
	}
	if _, ok, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    "ws-agent-delete",
		AgentSessionID: "session-1",
		Limit:          10,
	}); err != nil || ok {
		t.Fatalf("ListSessionMessages() after delete ok=%v error=%v, want ok=false", ok, err)
	}
}

func activitySessionIDs(sessions []agentactivitybiz.Session) []string {
	ids := make([]string, 0, len(sessions))
	for _, session := range sessions {
		ids = append(ids, session.ID)
	}
	return ids
}

func reportSessionStateWithStableUpdatedAt(
	ctx context.Context,
	store *SQLiteStore,
	input agentactivitybiz.SessionStateReport,
) error {
	if _, err := store.ReportSessionState(ctx, input); err != nil {
		return err
	}
	time.Sleep(2 * time.Millisecond)
	return nil
}

func TestSQLiteStoreClearAgentActivitySessionsHardDeletesTombstones(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()
	const workspaceID = "ws-agent-clear"

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   workspaceID,
		Name: "Workspace Agent Clear",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	for _, sessionID := range []string{"session-1", "session-2"} {
		if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
			WorkspaceID:      workspaceID,
			AgentSessionID:   sessionID,
			Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:         "codex",
			Status:           "completed",
			OccurredAtUnixMS: 100,
		}); err != nil {
			t.Fatalf("ReportSessionState(%s) error = %v", sessionID, err)
		}
		seedTestAgentTurn(t, store, ctx, workspaceID, sessionID, "turn-"+sessionID, "codex", 105)
		if _, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
			WorkspaceID:    workspaceID,
			AgentSessionID: sessionID,
			Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
			Provider:       "codex",
			Messages: []agentactivitybiz.MessageUpdate{{
				MessageID: "message-" + sessionID,
				TurnID:    "turn-" + sessionID,
				Role:      "assistant",
				Kind:      "text",
				Status:    "completed",
				Payload:   map[string]any{"text": "done"},
			}},
		}); err != nil {
			t.Fatalf("ReportSessionMessages(%s) error = %v", sessionID, err)
		}
	}
	if removed, err := store.DeleteSessionsBatch(ctx, agentactivitybiz.DeleteSessionsBatchInput{WorkspaceID: workspaceID, SessionIDs: []string{"session-1"}}); err != nil || removed.RemovedSessions != 1 {
		t.Fatalf("DeleteSessionsBatch() result=%#v error=%v, want one removed session", removed, err)
	}

	result, err := store.ClearSessions(ctx, workspaceID)
	if err != nil {
		t.Fatalf("ClearSessions() error = %v", err)
	}
	if result.RemovedSessions != 2 || result.RemovedMessages != 2 {
		t.Fatalf("ClearSessions() = %#v, want 2 sessions and 2 messages", result)
	}
	removedIDs := map[string]bool{}
	for _, sessionID := range result.RemovedSessionIDs {
		removedIDs[sessionID] = true
	}
	if !removedIDs["session-1"] || !removedIDs["session-2"] {
		t.Fatalf("ClearSessions() removed session IDs = %#v, want session-1 and session-2", result.RemovedSessionIDs)
	}

	recreated, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      workspaceID,
		AgentSessionID:   "session-1",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Status:           "completed",
		OccurredAtUnixMS: 200,
	})
	if err != nil {
		t.Fatalf("ReportSessionState() after clear error = %v", err)
	}
	if !recreated.Accepted {
		t.Fatal("ReportSessionState() after clear accepted = false, want true")
	}
	seedTestAgentTurn(t, store, ctx, workspaceID, "session-1", "turn-reimported", "codex", 205)
	messageResult, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    workspaceID,
		AgentSessionID: "session-1",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:       "codex",
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID: "message-reimported",
			TurnID:    "turn-reimported",
			Role:      "assistant",
			Kind:      "text",
			Status:    "completed",
			Payload:   map[string]any{"text": "reimported"},
		}},
	})
	if err != nil {
		t.Fatalf("ReportSessionMessages() after clear error = %v", err)
	}
	if messageResult.AcceptedCount != 1 {
		t.Fatalf("ReportSessionMessages() after clear accepted count = %d, want 1", messageResult.AcceptedCount)
	}
}

func TestSQLiteStoreUpdateAgentActivitySessionPinned(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-pin",
		Name: "Workspace Agent Pin",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-pin",
		AgentSessionID:   "session-1",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Status:           "running",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}

	session, ok, err := store.GetSession(ctx, "ws-agent-pin", "session-1")
	if err != nil {
		t.Fatalf("GetSession() error = %v", err)
	}
	if !ok {
		t.Fatal("GetSession() ok = false, want true")
	}
	if session.PinnedAtUnixMS != 0 {
		t.Fatalf("default pinnedAtUnixMS = %d, want 0", session.PinnedAtUnixMS)
	}

	pinned, ok, err := store.UpdateSessionPinned(ctx, "ws-agent-pin", "session-1", true)
	if err != nil {
		t.Fatalf("UpdateSessionPinned(pin) error = %v", err)
	}
	if !ok {
		t.Fatal("UpdateSessionPinned(pin) ok = false, want true")
	}
	if pinned.PinnedAtUnixMS <= 0 {
		t.Fatalf("pinnedAtUnixMS after pin = %d, want > 0", pinned.PinnedAtUnixMS)
	}

	unpinned, ok, err := store.UpdateSessionPinned(ctx, "ws-agent-pin", "session-1", false)
	if err != nil {
		t.Fatalf("UpdateSessionPinned(unpin) error = %v", err)
	}
	if !ok {
		t.Fatal("UpdateSessionPinned(unpin) ok = false, want true")
	}
	if unpinned.PinnedAtUnixMS != 0 {
		t.Fatalf("pinnedAtUnixMS after unpin = %d, want 0", unpinned.PinnedAtUnixMS)
	}

	if removed, err := store.DeleteSessionsBatch(ctx, agentactivitybiz.DeleteSessionsBatchInput{WorkspaceID: "ws-agent-pin", SessionIDs: []string{"session-1"}}); err != nil || removed.RemovedSessions != 1 {
		t.Fatalf("DeleteSessionsBatch() result=%#v error=%v, want one removed session", removed, err)
	}
	if _, ok, err := store.UpdateSessionPinned(ctx, "ws-agent-pin", "session-1", true); err != nil || ok {
		t.Fatalf("UpdateSessionPinned(deleted) ok=%v error=%v, want ok=false", ok, err)
	}
}

func TestSQLiteStoreListAgentActivityMessagesForHeadlessSessionWithoutMessages(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-headless-agent-activity",
		Name: "Workspace Headless Agent Activity",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:       "ws-headless-agent-activity",
		AgentSessionID:    "headless-session-1",
		Origin:            agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:          "codex",
		ProviderSessionID: "provider-session-1",
		RuntimeContext:    map[string]any{"visible": false},
		Cwd:               "/workspace",
		Title:             "headless",
		Status:            "running",
		OccurredAtUnixMS:  100,
		StartedAtUnixMS:   90,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}

	page, ok, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    "ws-headless-agent-activity",
		AgentSessionID: "headless-session-1",
		AfterVersion:   5,
		Limit:          10,
	})
	if err != nil {
		t.Fatalf("ListSessionMessages() error = %v", err)
	}
	if !ok {
		t.Fatal("ListSessionMessages() ok = false, want true")
	}
	if page.AgentSessionID != "headless-session-1" || len(page.Messages) != 0 || page.LatestVersion != 5 || page.HasMore {
		t.Fatalf("page = %#v, want empty page for headless session", page)
	}
}

func TestSQLiteStoreDeleteAgentActivitySessionIgnoresLateReports(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-agent-delete-late",
		Name: "Workspace Agent Delete Late Reports",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-delete-late",
		AgentSessionID:   "session-1",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Status:           "running",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}
	if removed, err := store.DeleteSessionsBatch(ctx, agentactivitybiz.DeleteSessionsBatchInput{WorkspaceID: "ws-agent-delete-late", SessionIDs: []string{"session-1"}}); err != nil || removed.RemovedSessions != 1 {
		t.Fatalf("DeleteSessionsBatch() result=%#v error=%v, want one removed session", removed, err)
	}

	lateState, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-agent-delete-late",
		AgentSessionID:   "session-1",
		Origin:           agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Provider:         "codex",
		Status:           "completed",
		OccurredAtUnixMS: 200,
		EndedAtUnixMS:    200,
	})
	if err != nil {
		t.Fatalf("late ReportSessionState() error = %v", err)
	}
	if lateState.Accepted {
		t.Fatal("late ReportSessionState() accepted = true, want false")
	}
	lateMessages, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-delete-late",
		AgentSessionID: "session-1",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID: "message-late",
			TurnID:    "turn-late",
			Role:      "assistant",
			Kind:      "text",
			Status:    "completed",
			Payload:   map[string]any{"text": "late"},
		}},
	})
	if err != nil {
		t.Fatalf("late ReportSessionMessages() error = %v", err)
	}
	if lateMessages.AcceptedCount != 0 {
		t.Fatalf("late ReportSessionMessages() accepted count = %d, want 0", lateMessages.AcceptedCount)
	}
	if _, ok, err := store.GetSession(ctx, "ws-agent-delete-late", "session-1"); err != nil || ok {
		t.Fatalf("GetSession() after late reports ok=%v error=%v, want ok=false", ok, err)
	}
}

func seedTestAgentTurn(t *testing.T, store *SQLiteStore, ctx context.Context, workspaceID, agentSessionID, turnID, provider string, occurredAtUnixMS int64) {
	t.Helper()
	if _, ok, err := store.GetSession(ctx, workspaceID, agentSessionID); err != nil {
		t.Fatalf("GetSession(%s) before turn seed error = %v", agentSessionID, err)
	} else if !ok {
		if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
			WorkspaceID: workspaceID, AgentSessionID: agentSessionID,
			Origin: agentsessionstore.WorkspaceAgentSessionOriginRuntime, Provider: provider,
			Status: "running", OccurredAtUnixMS: occurredAtUnixMS - 1,
		}); err != nil {
			t.Fatalf("ReportSessionState(%s) before turn seed error = %v", agentSessionID, err)
		}
	}
	if _, accepted, err := store.agentStore().RecordTurnTransition(ctx, agentactivitybiz.TurnTransition{
		WorkspaceID: workspaceID, AgentSessionID: agentSessionID, TurnID: turnID,
		Phase: agentactivitybiz.TurnPhaseSubmitted, Origin: agentactivitybiz.TurnOriginLegacyUnknown,
		OccurredAtUnixMS: occurredAtUnixMS,
	}); err != nil || !accepted {
		t.Fatalf("RecordTurnTransition(%s) accepted=%v error=%v", turnID, accepted, err)
	}
}

func openTestSQLiteStore(t *testing.T) *SQLiteStore {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "tuttid.db")
	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})

	if err := store.Migrate(context.Background()); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	return store
}

type testAgentSessionRailSection struct {
	Kind        string
	ProjectPath string
	Key         string
}

func getTestAgentSessionRailSection(
	t *testing.T,
	store *SQLiteStore,
	workspaceID string,
	agentSessionID string,
) testAgentSessionRailSection {
	t.Helper()

	row := store.writeDB.QueryRowContext(context.Background(), `
SELECT rail_section_kind, rail_project_path, rail_section_key
FROM workspace_agent_sessions
WHERE workspace_id = ? AND agent_session_id = ?
`, workspaceID, agentSessionID)
	var rail testAgentSessionRailSection
	if err := row.Scan(&rail.Kind, &rail.ProjectPath, &rail.Key); err != nil {
		t.Fatalf("scan agent session rail section: %v", err)
	}
	return rail
}

func mkdirAll(path string) error {
	return os.MkdirAll(path, 0o755)
}

func createLegacyAgentActivityV4MarkedDatabaseWithoutAgentTargetID(t *testing.T, dbPath string) {
	t.Helper()

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	defer db.Close()

	_, err = db.Exec(`
CREATE TABLE tuttid_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES
  ('workspaces_v1', 1),
  ('workspaces_v2', 1),
  ('workspaces_v3', 1),
  ('workspaces_v4', 1),
  ('workspace_agent_activity_v1', 1),
  ('workspace_agent_activity_v2', 1),
  ('workspace_agent_activity_v3', 1),
  ('workspace_agent_activity_v4', 1);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  last_opened_at_unix_ms INTEGER
);
INSERT INTO workspaces (id, name, created_at_unix_ms, updated_at_unix_ms, last_opened_at_unix_ms)
VALUES ('ws-legacy-agent-target-id', 'Legacy Agent Target ID', 1, 1, 1);

CREATE TABLE workspace_workbench_snapshots (
  workspace_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE workspace_agent_sessions (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  provider_session_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  settings_json TEXT NOT NULL DEFAULT '{}',
  runtime_context_json TEXT NOT NULL DEFAULT '{}',
  cwd TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  current_phase TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  message_version INTEGER NOT NULL DEFAULT 0,
  last_event_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  ended_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  deleted_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  pinned_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, agent_session_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
INSERT INTO workspace_agent_sessions (
  workspace_id, agent_session_id, origin, provider, provider_session_id, model,
  settings_json, runtime_context_json, cwd, title, status, current_phase,
  last_error, message_version, last_event_at_unix_ms, started_at_unix_ms,
  ended_at_unix_ms, deleted_at_unix_ms, created_at_unix_ms, updated_at_unix_ms,
  pinned_at_unix_ms
) VALUES (
  'ws-legacy-agent-target-id', 'session-legacy', 'runtime', 'codex', 'provider-session-legacy', '',
  '{}', '{}', '/', 'Legacy Session', 'running', 'idle',
  '', 0, 1, 1,
  0, 0, 1, 1,
  0
),
(
  'ws-legacy-agent-target-id', 'session-legacy-claude', 'runtime', 'claude-code', 'provider-session-legacy-claude', '',
  '{}', '{}', '/', 'Legacy Claude Session', 'running', 'idle',
  '', 0, 1, 1,
  0, 0, 1, 1,
  0
);

CREATE TABLE workspace_agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  turn_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  completed_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  deleted_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  UNIQUE (workspace_id, agent_session_id, message_id),
  FOREIGN KEY (workspace_id, agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id)
    ON DELETE CASCADE
);
`)
	if err != nil {
		t.Fatalf("create legacy agent activity database: %v", err)
	}
}
