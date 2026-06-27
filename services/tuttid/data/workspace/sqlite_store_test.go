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

func TestSQLiteStoreListsWorkspaceGeneratedFiles(t *testing.T) {
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

	result, ok, err := store.ListWorkspaceGeneratedFiles(ctx, agentactivitybiz.ListWorkspaceGeneratedFilesInput{
		WorkspaceID: "ws-agent-generated-files",
		SessionCwd:  "/workspace",
		Query:       "report",
		Limit:       10,
	})
	if err != nil {
		t.Fatalf("ListWorkspaceGeneratedFiles() error = %v", err)
	}
	if !ok {
		t.Fatal("ListWorkspaceGeneratedFiles() ok = false, want true")
	}
	if len(result.Files) != 1 {
		t.Fatalf("len(files) = %d, want 1: %#v", len(result.Files), result.Files)
	}
	if result.Files[0].Path != "/workspace/report.md" || result.Files[0].Label != "report.md" {
		t.Fatalf("file = %#v, want /workspace/report.md report.md", result.Files[0])
	}

	arrayResult, ok, err := store.ListWorkspaceGeneratedFiles(ctx, agentactivitybiz.ListWorkspaceGeneratedFilesInput{
		WorkspaceID: "ws-agent-generated-files",
		SessionCwd:  "/workspace",
		Query:       "slides",
		Limit:       10,
	})
	if err != nil {
		t.Fatalf("ListWorkspaceGeneratedFiles(array changes) error = %v", err)
	}
	if !ok {
		t.Fatal("ListWorkspaceGeneratedFiles(array changes) ok = false, want true")
	}
	if len(arrayResult.Files) != 2 {
		t.Fatalf("len(array files) = %d, want 2: %#v", len(arrayResult.Files), arrayResult.Files)
	}
	if arrayResult.Files[0].Path != "/workspace/slides/02-why-now.html" ||
		arrayResult.Files[1].Path != "/workspace/slides/01-cover.html" {
		t.Fatalf("array files = %#v, want Codex Edit changes array paths", arrayResult.Files)
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
			TurnID:    "turn-1",
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
	if removed, err := store.DeleteSession(ctx, workspaceID, "session-1"); err != nil || !removed {
		t.Fatalf("DeleteSession() removed=%v error=%v, want removed=true", removed, err)
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
