package workspace

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	agentsessionstore "github.com/tutti-os/tutti/packages/agentactivity/daemon/activity"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
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

	first, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-activity",
		AgentSessionID: "session-1",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID:        "message-1",
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

	third, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-activity",
		AgentSessionID: "session-1",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID:        "message-2",
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

	result, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-large-message",
		AgentSessionID: "session-large",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID:        "message-large",
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
	if state.Session.Status != "completed" || state.Session.CurrentPhase != "idle" || state.Session.LastEventUnixMS != 200 {
		t.Fatalf("projected session runtime state = %q/%q last=%d, want completed/idle last=200", state.Session.Status, state.Session.CurrentPhase, state.Session.LastEventUnixMS)
	}
	session, ok, err := store.GetSession(ctx, "ws-agent-state-order", "session-1")
	if err != nil {
		t.Fatalf("GetSession() error = %v", err)
	}
	if !ok {
		t.Fatal("GetSession() ok = false, want true")
	}
	if session.Status != "completed" || session.CurrentPhase != "idle" || session.LastEventUnixMS != 200 {
		t.Fatalf("session runtime state = %q/%q last=%d, want completed/idle last=200", session.Status, session.CurrentPhase, session.LastEventUnixMS)
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
	if _, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID:    "ws-agent-delete",
		AgentSessionID: "session-1",
		Origin:         agentsessionstore.WorkspaceAgentSessionOriginRuntime,
		Messages: []agentactivitybiz.MessageUpdate{{
			MessageID: "message-1",
			Role:      "assistant",
			Kind:      "text",
			Status:    "completed",
			Payload:   map[string]any{"text": "done"},
		}},
	}); err != nil {
		t.Fatalf("ReportSessionMessages() error = %v", err)
	}

	removed, err := store.DeleteSession(ctx, "ws-agent-delete", "session-1")
	if err != nil {
		t.Fatalf("DeleteSession() error = %v", err)
	}
	if !removed {
		t.Fatal("DeleteSession() removed = false, want true")
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

	if removed, err := store.DeleteSession(ctx, "ws-agent-pin", "session-1"); err != nil || !removed {
		t.Fatalf("DeleteSession() removed=%v error=%v, want removed=true", removed, err)
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
	if removed, err := store.DeleteSession(ctx, "ws-agent-delete-late", "session-1"); err != nil || !removed {
		t.Fatalf("DeleteSession() removed=%v error=%v, want removed=true", removed, err)
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
