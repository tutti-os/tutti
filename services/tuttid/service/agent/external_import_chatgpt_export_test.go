package agent

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"testing"

	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestScanChatGPTExportArchiveNormalizesRolesTextAndAssetPlaceholders(t *testing.T) {
	archivePath := writeChatGPTExportArchive(t, []map[string]any{
		chatgptExportConversationFixture("conversation-1", "Visible chat", "n-tool", map[string]any{
			"root":   chatgptExportNodeFixture("root", "", []string{"n-user"}, nil),
			"n-user": chatgptExportNodeFixture("n-user", "root", []string{"n-assistant"}, chatgptExportTextMessageFixture("m-user", "user", 1717200001, "Hello from the user")),
			"n-assistant": chatgptExportNodeFixture("n-assistant", "n-user", []string{"n-hidden"}, chatgptExportMultimodalMessageFixture("m-assistant", "assistant", 1717200002, []any{
				"Here is an image",
				map[string]any{"content_type": "image_asset_pointer", "asset_pointer": "file-service://file-ABC"},
			})),
			"n-hidden": chatgptExportNodeFixture("n-hidden", "n-assistant", []string{"n-tool"}, chatgptExportHiddenMessageFixture("m-hidden", "assistant", 1717200003, "SECRET_HIDDEN")),
			"n-tool":   chatgptExportNodeFixture("n-tool", "n-hidden", []string{}, chatgptExportTextMessageFixture("m-tool", "tool", 1717200004, "SECRET_TOOL")),
		}),
		chatgptExportConversationFixture("conversation-empty", "Empty", "root", map[string]any{
			"root": chatgptExportNodeFixture("root", "", []string{}, nil),
		}),
	})

	data, err := scanChatGPTExportArchive(context.Background(), archivePath, 0)
	if err != nil {
		t.Fatalf("scanChatGPTExportArchive error = %v", err)
	}
	if data.result.ScannedSessions != 1 || data.result.ScannedMessages != 2 || data.result.SkippedSessions != 1 {
		t.Fatalf("scan result = %#v, want one session, two messages, one skipped conversation", data.result)
	}
	session := data.sessions[0]
	if session.Provider != chatgptExportProvider {
		t.Fatalf("provider = %q, want %q", session.Provider, chatgptExportProvider)
	}
	if session.ProviderSessionID != "chatgpt-export:conversation-1:branch:main" || !session.NoProject {
		t.Fatalf("session identity = %#v", session)
	}
	if session.ResumeSupported == nil || *session.ResumeSupported {
		t.Fatalf("ResumeSupported = %#v, want false", session.ResumeSupported)
	}
	if session.SourcePath != "" {
		t.Fatalf("SourcePath = %q, want empty (archive path must never be surfaced)", session.SourcePath)
	}
	if session.Title != "Visible chat" {
		t.Fatalf("title = %q, want conversation title", session.Title)
	}
	if len(session.Messages) != 2 {
		t.Fatalf("messages = %#v, want user + assistant only", session.Messages)
	}
	if session.Messages[0].Role != "user" || session.Messages[0].Text != "Hello from the user" {
		t.Fatalf("user message = %#v", session.Messages[0])
	}
	assistant := session.Messages[1]
	if assistant.Role != "assistant" || assistant.Text != "Here is an image\n\n📎 file-ABC" {
		t.Fatalf("assistant message text = %q", assistant.Text)
	}
	encoded, err := json.Marshal(session.Messages)
	if err != nil {
		t.Fatalf("marshal messages: %v", err)
	}
	for _, secret := range []string{"SECRET_HIDDEN", "SECRET_TOOL"} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("imported messages leaked filtered content %q: %s", secret, encoded)
		}
	}
	files, ok := assistant.Payload["files"].([]map[string]any)
	if !ok || len(files) != 1 || files[0]["fileName"] != "file-ABC" || files[0]["available"] != false {
		t.Fatalf("assistant file payload = %#v", assistant.Payload["files"])
	}
	if data.result.Providers[0].Provider != chatgptExportProvider || data.result.Providers[0].Root != "" {
		t.Fatalf("provider summary = %#v, want chatgpt provider without a root path", data.result.Providers[0])
	}
}

func TestScanChatGPTExportArchiveFollowsCurrentNodeAndDropsAbandonedBranch(t *testing.T) {
	archivePath := writeChatGPTExportArchive(t, []map[string]any{
		chatgptExportConversationFixture("conversation-branch", "Branch chat", "n-follow", map[string]any{
			"root":      chatgptExportNodeFixture("root", "", []string{"n-old", "n-current"}, chatgptExportTextMessageFixture("m-root", "user", 1717200001, "Question")),
			"n-old":     chatgptExportNodeFixture("n-old", "root", []string{}, chatgptExportTextMessageFixture("m-old", "assistant", 1717200005, "Old retry answer")),
			"n-current": chatgptExportNodeFixture("n-current", "root", []string{"n-follow"}, chatgptExportTextMessageFixture("m-current", "assistant", 1717200002, "Current answer")),
			"n-follow":  chatgptExportNodeFixture("n-follow", "n-current", []string{}, chatgptExportTextMessageFixture("m-follow", "user", 1717200003, "Follow up")),
		}),
	})

	data, err := scanChatGPTExportArchive(context.Background(), archivePath, 0)
	if err != nil {
		t.Fatalf("scanChatGPTExportArchive error = %v", err)
	}
	if len(data.sessions) != 1 {
		t.Fatalf("sessions = %#v, want one session", data.sessions)
	}
	session := data.sessions[0]
	texts := make([]string, 0, len(session.Messages))
	for _, message := range session.Messages {
		texts = append(texts, message.Text)
	}
	want := []string{"Question", "Current answer", "Follow up"}
	if strings.Join(texts, "|") != strings.Join(want, "|") {
		t.Fatalf("branch texts = %#v, want the current_node thread only", texts)
	}
	for _, message := range session.Messages {
		if strings.Contains(message.Text, "Old retry") {
			t.Fatalf("abandoned branch message leaked: %q", message.Text)
		}
	}
}

func TestScanChatGPTExportArchiveIsIdempotentAndBranchScoped(t *testing.T) {
	buildLinear := func(currentNode string, followUp bool) string {
		mapping := map[string]any{
			"root":        chatgptExportNodeFixture("root", "", []string{"n-user"}, nil),
			"n-user":      chatgptExportNodeFixture("n-user", "root", []string{"n-assistant"}, chatgptExportTextMessageFixture("m-user", "user", 1717200001, "Hello")),
			"n-assistant": chatgptExportNodeFixture("n-assistant", "n-user", []string{}, chatgptExportTextMessageFixture("m-assistant", "assistant", 1717200002, "Hi there")),
		}
		if followUp {
			mapping["n-assistant"] = chatgptExportNodeFixture("n-assistant", "n-user", []string{"n-follow"}, chatgptExportTextMessageFixture("m-assistant", "assistant", 1717200002, "Hi there"))
			mapping["n-follow"] = chatgptExportNodeFixture("n-follow", "n-assistant", []string{}, chatgptExportTextMessageFixture("m-follow", "user", 1717200003, "Follow up"))
		}
		return writeChatGPTExportArchive(t, []map[string]any{
			chatgptExportConversationFixture("conversation-1", "Chat", currentNode, mapping),
		})
	}

	firstPath := buildLinear("n-assistant", false)
	first, err := scanChatGPTExportArchive(context.Background(), firstPath, 0)
	if err != nil {
		t.Fatalf("first scan error = %v", err)
	}
	second, err := scanChatGPTExportArchive(context.Background(), firstPath, 0)
	if err != nil {
		t.Fatalf("second scan error = %v", err)
	}
	firstJSON, _ := json.Marshal(first.sessions)
	secondJSON, _ := json.Marshal(second.sessions)
	if string(firstJSON) != string(secondJSON) {
		t.Fatalf("re-import is not idempotent:\n first=%s\nsecond=%s", firstJSON, secondJSON)
	}
	if first.sessions[0].ProviderSessionID != "chatgpt-export:conversation-1:branch:main" {
		t.Fatalf("linear session id = %q, want branch:main", first.sessions[0].ProviderSessionID)
	}

	extendedPath := buildLinear("n-follow", true)
	extended, err := scanChatGPTExportArchive(context.Background(), extendedPath, 0)
	if err != nil {
		t.Fatalf("extended scan error = %v", err)
	}
	if extended.sessions[0].ProviderSessionID != first.sessions[0].ProviderSessionID {
		t.Fatalf("linear growth changed session id from %q to %q", first.sessions[0].ProviderSessionID, extended.sessions[0].ProviderSessionID)
	}

	oldAnswerPath := writeChatGPTExportArchive(t, []map[string]any{
		chatgptExportConversationFixture("conversation-fork", "Fork chat", "n-old", map[string]any{
			"root":   chatgptExportNodeFixture("root", "", []string{"n-user"}, nil),
			"n-user": chatgptExportNodeFixture("n-user", "root", []string{"n-old"}, chatgptExportTextMessageFixture("m-user", "user", 1717200001, "Question")),
			"n-old":  chatgptExportNodeFixture("n-old", "n-user", []string{}, chatgptExportTextMessageFixture("m-old", "assistant", 1717200002, "Old answer")),
		}),
	})
	newAnswerPath := writeChatGPTExportArchive(t, []map[string]any{
		chatgptExportConversationFixture("conversation-fork", "Fork chat", "n-new", map[string]any{
			"root":   chatgptExportNodeFixture("root", "", []string{"n-user"}, nil),
			"n-user": chatgptExportNodeFixture("n-user", "root", []string{"n-old", "n-new"}, chatgptExportTextMessageFixture("m-user", "user", 1717200001, "Question")),
			"n-old":  chatgptExportNodeFixture("n-old", "n-user", []string{}, chatgptExportTextMessageFixture("m-old", "assistant", 1717200002, "Old answer")),
			"n-new":  chatgptExportNodeFixture("n-new", "n-user", []string{}, chatgptExportTextMessageFixture("m-new", "assistant", 1717200003, "New answer")),
		}),
	})
	oldScan, err := scanChatGPTExportArchive(context.Background(), oldAnswerPath, 0)
	if err != nil {
		t.Fatalf("old fork scan error = %v", err)
	}
	newScan, err := scanChatGPTExportArchive(context.Background(), newAnswerPath, 0)
	if err != nil {
		t.Fatalf("new fork scan error = %v", err)
	}
	if oldScan.sessions[0].ProviderSessionID == newScan.sessions[0].ProviderSessionID {
		t.Fatalf("changed retry branch reused session id %q", oldScan.sessions[0].ProviderSessionID)
	}
}

func TestScanChatGPTExportArchiveRejectsMissingConversationsWithoutLeakingPath(t *testing.T) {
	archivePath := writeChatGPTExportZipEntries(t, map[string]string{"users.json": "[]"})
	_, err := scanChatGPTExportArchive(context.Background(), archivePath, 0)
	if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), "supported ChatGPT conversations payload") {
		t.Fatalf("error = %v, want missing payload rejection", err)
	}
	if strings.Contains(err.Error(), archivePath) || strings.Contains(err.Error(), filepath.Dir(archivePath)) {
		t.Fatalf("error message leaked the archive path: %v", err)
	}
}

func TestScanChatGPTExportArchiveRejectsNonArrayConversations(t *testing.T) {
	archivePath := writeChatGPTExportZipEntries(t, map[string]string{"conversations.json": "{}"})
	_, err := scanChatGPTExportArchive(context.Background(), archivePath, 0)
	if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), "must contain an array") {
		t.Fatalf("error = %v, want array-shape rejection", err)
	}
}

func TestScanChatGPTExportArchiveRejectsDuplicateConversationsEntry(t *testing.T) {
	archivePath := writeChatGPTExportZipEntryFixtures(t, []claudeExportZipEntryFixture{
		{Name: "conversations.json", Content: "[]"},
		{Name: "conversations.json", Content: "[]"},
	})
	_, err := scanChatGPTExportArchive(context.Background(), archivePath, 0)
	if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), "duplicate conversations.json") {
		t.Fatalf("error = %v, want duplicate-entry rejection", err)
	}
}

func TestScanExternalAgentSessionsDispatchesChatGPTArchiveKind(t *testing.T) {
	archivePath := writeChatGPTExportArchive(t, []map[string]any{
		chatgptExportConversationFixture("conversation-1", "Chat", "n-user", map[string]any{
			"root":   chatgptExportNodeFixture("root", "", []string{"n-user"}, nil),
			"n-user": chatgptExportNodeFixture("n-user", "root", []string{}, chatgptExportTextMessageFixture("m-user", "user", 1717200001, "Hello")),
		}),
	})

	// ChatGPT archives are import-only and carry no claude-code provider gate,
	// so a provider filter that excludes claude-code must still scan them.
	data, err := scanExternalAgentSessions(context.Background(), []string{"codex"}, 0, archivePath, ExternalImportArchiveKindChatGPT)
	if err != nil {
		t.Fatalf("scanExternalAgentSessions(chatgpt) error = %v", err)
	}
	if data.result.ScannedSessions != 1 || data.sessions[0].Provider != chatgptExportProvider {
		t.Fatalf("dispatch result = %#v", data.result)
	}
}

func TestImportChatGPTExportArchivePersistsSessionsWithoutLeakingPath(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-chatgpt-export", Name: "ChatGPT export"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	archivePath := writeChatGPTExportArchive(t, []map[string]any{
		chatgptExportConversationFixture("conversation-import", "Imported conversation", "n-assistant", map[string]any{
			"root":        chatgptExportNodeFixture("root", "", []string{"n-user"}, nil),
			"n-user":      chatgptExportNodeFixture("n-user", "root", []string{"n-assistant"}, chatgptExportTextMessageFixture("m-user", "user", 1717200001, "Question")),
			"n-assistant": chatgptExportNodeFixture("n-assistant", "n-user", []string{}, chatgptExportTextMessageFixture("m-assistant", "assistant", 1717200002, "Answer")),
		}),
	})
	service := NewService(newFakeRuntime())
	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = store

	scan, err := service.ScanExternalImports(ctx, ExternalImportScanInput{
		ArchivePath: archivePath,
		ArchiveKind: ExternalImportArchiveKindChatGPT,
		Days:        -1,
	})
	if err != nil {
		t.Fatalf("ScanExternalImports error = %v", err)
	}
	if len(scan.Sessions) != 1 {
		t.Fatalf("scan sessions = %#v, want one", scan.Sessions)
	}
	if scan.Sessions[0].SourcePath != "" {
		t.Fatalf("scan session sourcePath = %q, want empty (path must not be surfaced)", scan.Sessions[0].SourcePath)
	}
	home, ok := externalImportNoProjectBucketPath()
	if !ok {
		t.Fatal("home bucket unavailable")
	}
	selection := ExternalImportInput{
		ArchivePath: archivePath,
		ArchiveKind: ExternalImportArchiveKindChatGPT,
		Projects: []ExternalImportProjectSelection{{
			Path:       home,
			Providers:  []string{chatgptExportProvider},
			SessionIDs: []string{scan.Sessions[0].ID},
		}},
	}
	result, err := service.ImportExternalSessions(ctx, "ws-chatgpt-export", selection)
	if err != nil {
		t.Fatalf("ImportExternalSessions error = %v", err)
	}
	if result.ImportedSessions != 1 || result.ImportedMessages != 2 {
		t.Fatalf("import result = %#v, want one session and two messages", result)
	}
	if len(result.Errors) != 0 {
		t.Fatalf("import errors = %#v, want none", result.Errors)
	}
	rerun, err := service.ImportExternalSessions(ctx, "ws-chatgpt-export", selection)
	if err != nil {
		t.Fatalf("ImportExternalSessions rerun error = %v", err)
	}
	if rerun.ImportedSessions != 0 || rerun.ImportedMessages != 0 {
		t.Fatalf("rerun result = %#v, want idempotent no-op", rerun)
	}

	session, err := service.Get(ctx, "ws-chatgpt-export", scan.Sessions[0].ID)
	if err != nil {
		t.Fatalf("Get imported session error = %v", err)
	}
	if session.Provider != chatgptExportProvider || session.AgentTargetID != "" || session.Resumable {
		t.Fatalf("imported session identity = %#v, want chatgpt provider, empty target, non-resumable", session)
	}
	persisted, ok := projection.GetSession("ws-chatgpt-export", session.ID)
	if !ok {
		t.Fatalf("persisted imported session %q not found", session.ID)
	}
	if !persisted.Metadata.Imported ||
		persisted.InternalRuntimeContext["externalImportNoProject"] != true ||
		persisted.InternalRuntimeContext["externalImportResumeSupported"] != false {
		t.Fatalf("internal runtime context = %#v", persisted.InternalRuntimeContext)
	}
	if sourcePath := persisted.InternalRuntimeContext["externalSourcePath"]; sourcePath != "" {
		t.Fatalf("persisted externalSourcePath = %#v, want empty (path must not be surfaced)", sourcePath)
	}
	messages, err := service.ListMessages(ctx, "ws-chatgpt-export", session.ID, ListMessagesInput{Limit: 10})
	if err != nil {
		t.Fatalf("ListMessages error = %v", err)
	}
	if len(messages.Messages) != 2 {
		t.Fatalf("imported messages = %#v, want two", messages.Messages)
	}
}

func TestScanChatGPTExportArchiveReadsBundledOpenAIExport(t *testing.T) {
	archivePath := writeChatGPTExportBundleArchive(t, map[string][]map[string]any{
		"conversations-000.json": {
			chatgptExportConversationFixture("conversation-a", "First shard", "n-user", map[string]any{
				"root":   chatgptExportNodeFixture("root", "", []string{"n-user"}, nil),
				"n-user": chatgptExportNodeFixture("n-user", "root", []string{}, chatgptExportTextMessageFixture("m-a", "user", 1717200001, "Shard A")),
			}),
		},
		"conversations-001.json": {
			chatgptExportConversationFixture("conversation-b", "Second shard", "n-user", map[string]any{
				"root":   chatgptExportNodeFixture("root", "", []string{"n-user"}, nil),
				"n-user": chatgptExportNodeFixture("n-user", "root", []string{}, chatgptExportTextMessageFixture("m-b", "user", 1717200002, "Shard B")),
			}),
		},
	})

	data, err := scanChatGPTExportArchive(context.Background(), archivePath, 0)
	if err != nil {
		t.Fatalf("scanChatGPTExportArchive error = %v", err)
	}
	if data.result.ScannedSessions != 2 || data.result.ScannedMessages != 2 {
		t.Fatalf("scan result = %#v, want two sessions from bundled shards", data.result)
	}
}

func TestImportChatGPTExportArchiveAppendsNewMessagesWithoutDuplicatingSession(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-chatgpt-append", Name: "ChatGPT append"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	archivePath := writeChatGPTExportArchive(t, []map[string]any{
		chatgptExportConversationFixture("conversation-import", "Imported conversation", "n-assistant", map[string]any{
			"root":        chatgptExportNodeFixture("root", "", []string{"n-user"}, nil),
			"n-user":      chatgptExportNodeFixture("n-user", "root", []string{"n-assistant"}, chatgptExportTextMessageFixture("m-user", "user", 1717200001, "Question")),
			"n-assistant": chatgptExportNodeFixture("n-assistant", "n-user", []string{}, chatgptExportTextMessageFixture("m-assistant", "assistant", 1717200002, "Answer")),
		}),
	})
	service := NewService(newFakeRuntime())
	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = store

	scan, err := service.ScanExternalImports(ctx, ExternalImportScanInput{
		ArchivePath: archivePath,
		ArchiveKind: ExternalImportArchiveKindChatGPT,
		Days:        -1,
	})
	if err != nil {
		t.Fatalf("ScanExternalImports error = %v", err)
	}
	home, ok := externalImportNoProjectBucketPath()
	if !ok {
		t.Fatal("home bucket unavailable")
	}
	selection := ExternalImportInput{
		ArchivePath: archivePath,
		ArchiveKind: ExternalImportArchiveKindChatGPT,
		Projects: []ExternalImportProjectSelection{{
			Path:       home,
			Providers:  []string{chatgptExportProvider},
			SessionIDs: []string{scan.Sessions[0].ID},
		}},
	}
	if _, err := service.ImportExternalSessions(ctx, "ws-chatgpt-append", selection); err != nil {
		t.Fatalf("ImportExternalSessions error = %v", err)
	}
	messages, err := service.ListMessages(ctx, "ws-chatgpt-append", scan.Sessions[0].ID, ListMessagesInput{Limit: 10})
	if err != nil {
		t.Fatalf("ListMessages error = %v", err)
	}
	existingIDs := map[string]string{}
	for _, message := range messages.Messages {
		sourceID, _ := message.Payload["sourceMessageId"].(string)
		existingIDs[sourceID] = message.MessageID
	}

	rewriteChatGPTExportArchive(t, archivePath, []map[string]any{
		chatgptExportConversationFixture("conversation-import", "Imported conversation", "n-follow", map[string]any{
			"root":        chatgptExportNodeFixture("root", "", []string{"n-user"}, nil),
			"n-user":      chatgptExportNodeFixture("n-user", "root", []string{"n-assistant"}, chatgptExportTextMessageFixture("m-user", "user", 1717200001, "Question")),
			"n-assistant": chatgptExportNodeFixture("n-assistant", "n-user", []string{"n-follow"}, chatgptExportTextMessageFixture("m-assistant", "assistant", 1717200002, "Answer")),
			"n-follow":    chatgptExportNodeFixture("n-follow", "n-assistant", []string{}, chatgptExportTextMessageFixture("m-follow", "user", 1717200003, "Follow up")),
		}),
	})
	updatedScan, err := service.ScanExternalImports(ctx, ExternalImportScanInput{
		ArchivePath: archivePath,
		ArchiveKind: ExternalImportArchiveKindChatGPT,
		Days:        -1,
	})
	if err != nil {
		t.Fatalf("ScanExternalImports updated export error = %v", err)
	}
	if updatedScan.Sessions[0].ID != scan.Sessions[0].ID {
		t.Fatalf("updated export changed session id from %q to %q", scan.Sessions[0].ID, updatedScan.Sessions[0].ID)
	}
	selection.Projects[0].SessionIDs = []string{updatedScan.Sessions[0].ID}
	updated, err := service.ImportExternalSessions(ctx, "ws-chatgpt-append", selection)
	if err != nil {
		t.Fatalf("ImportExternalSessions updated export error = %v", err)
	}
	if updated.ImportedMessages != 1 {
		t.Fatalf("updated export result = %#v, want only the appended message", updated)
	}
	updatedMessages, err := service.ListMessages(ctx, "ws-chatgpt-append", scan.Sessions[0].ID, ListMessagesInput{Limit: 10})
	if err != nil {
		t.Fatalf("ListMessages after updated export error = %v", err)
	}
	if len(updatedMessages.Messages) != 3 {
		t.Fatalf("updated messages = %#v, want three unique messages", updatedMessages.Messages)
	}
	for _, message := range updatedMessages.Messages {
		sourceID, _ := message.Payload["sourceMessageId"].(string)
		if oldID := existingIDs[sourceID]; oldID != "" && oldID != message.MessageID {
			t.Fatalf("message %q id changed from %q to %q after append", sourceID, oldID, message.MessageID)
		}
	}
}

func TestImportChatGPTExportArchiveKeepsChangedRetryBranchesInSeparateSessions(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-chatgpt-branches", Name: "ChatGPT branches"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	archivePath := writeChatGPTExportArchive(t, []map[string]any{
		chatgptExportConversationFixture("conversation-changing-branch", "Changing branch", "n-old", map[string]any{
			"root":   chatgptExportNodeFixture("root", "", []string{"n-user"}, nil),
			"n-user": chatgptExportNodeFixture("n-user", "root", []string{"n-old"}, chatgptExportTextMessageFixture("m-user", "user", 1717200001, "Question")),
			"n-old":  chatgptExportNodeFixture("n-old", "n-user", []string{}, chatgptExportTextMessageFixture("m-old", "assistant", 1717200002, "Old answer")),
		}),
	})
	service := NewService(newFakeRuntime())
	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = store

	firstScan, err := service.ScanExternalImports(ctx, ExternalImportScanInput{
		ArchivePath: archivePath,
		ArchiveKind: ExternalImportArchiveKindChatGPT,
		Days:        -1,
	})
	if err != nil || len(firstScan.Sessions) != 1 {
		t.Fatalf("first scan = %#v, error = %v", firstScan, err)
	}
	selectionFor := func(scan ExternalImportScanResult) ExternalImportInput {
		home, ok := externalImportNoProjectBucketPath()
		if !ok {
			t.Fatal("home bucket unavailable")
		}
		return ExternalImportInput{
			ArchivePath: archivePath,
			ArchiveKind: ExternalImportArchiveKindChatGPT,
			Projects: []ExternalImportProjectSelection{{
				Path:       home,
				Providers:  []string{chatgptExportProvider},
				SessionIDs: []string{scan.Sessions[0].ID},
			}},
		}
	}
	firstImport, err := service.ImportExternalSessions(ctx, "ws-chatgpt-branches", selectionFor(firstScan))
	if err != nil || firstImport.ImportedSessions != 1 || firstImport.ImportedMessages != 2 {
		t.Fatalf("first import = %#v, error = %v", firstImport, err)
	}
	oldSessionID := firstScan.Sessions[0].ID

	rewriteChatGPTExportArchive(t, archivePath, []map[string]any{
		chatgptExportConversationFixture("conversation-changing-branch", "Changing branch", "n-new", map[string]any{
			"root":   chatgptExportNodeFixture("root", "", []string{"n-user"}, nil),
			"n-user": chatgptExportNodeFixture("n-user", "root", []string{"n-old", "n-new"}, chatgptExportTextMessageFixture("m-user", "user", 1717200001, "Question")),
			"n-old":  chatgptExportNodeFixture("n-old", "n-user", []string{}, chatgptExportTextMessageFixture("m-old", "assistant", 1717200002, "Old answer")),
			"n-new":  chatgptExportNodeFixture("n-new", "n-user", []string{}, chatgptExportTextMessageFixture("m-new", "assistant", 1717200003, "New answer")),
		}),
	})
	secondScan, err := service.ScanExternalImports(ctx, ExternalImportScanInput{
		ArchivePath: archivePath,
		ArchiveKind: ExternalImportArchiveKindChatGPT,
		Days:        -1,
	})
	if err != nil || len(secondScan.Sessions) != 1 {
		t.Fatalf("second scan = %#v, error = %v", secondScan, err)
	}
	newSessionID := secondScan.Sessions[0].ID
	if newSessionID == oldSessionID {
		t.Fatalf("changed retry branch reused session id %q", newSessionID)
	}
	secondImport, err := service.ImportExternalSessions(ctx, "ws-chatgpt-branches", selectionFor(secondScan))
	if err != nil || secondImport.ImportedSessions != 1 || secondImport.ImportedMessages != 2 {
		t.Fatalf("second import = %#v, error = %v", secondImport, err)
	}

	oldMessages, err := service.ListMessages(ctx, "ws-chatgpt-branches", oldSessionID, ListMessagesInput{Limit: 10})
	if err != nil {
		t.Fatalf("list old branch: %v", err)
	}
	newMessages, err := service.ListMessages(ctx, "ws-chatgpt-branches", newSessionID, ListMessagesInput{Limit: 10})
	if err != nil {
		t.Fatalf("list new branch: %v", err)
	}
	if !chatgptSessionMessagesContainText(oldMessages.Messages, "Old answer") || chatgptSessionMessagesContainText(oldMessages.Messages, "New answer") {
		t.Fatalf("old branch messages = %#v", oldMessages.Messages)
	}
	if !chatgptSessionMessagesContainText(newMessages.Messages, "New answer") || chatgptSessionMessagesContainText(newMessages.Messages, "Old answer") {
		t.Fatalf("new branch messages = %#v", newMessages.Messages)
	}
}

func TestChatGPTExportConversationStreamRejectsElementBeforeExceedingByteBudget(t *testing.T) {
	stream, err := newChatGPTExportConversationStreamWithLimits(
		context.Background(),
		strings.NewReader(`[{"conversation_id":"conversation-too-large","mapping":{}}]`),
		1_024,
		24,
	)
	if err != nil {
		t.Fatalf("create conversation stream: %v", err)
	}
	_, _, err = stream.Next()
	if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), "conversation 1 exceeds the size limit") {
		t.Fatalf("error = %v, want per-conversation byte-budget rejection", err)
	}
}

func writeChatGPTExportBundleArchive(t *testing.T, shardConversations map[string][]map[string]any) string {
	t.Helper()
	innerBuf := new(bytes.Buffer)
	innerWriter := zip.NewWriter(innerBuf)
	names := make([]string, 0, len(shardConversations))
	for name := range shardConversations {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		data, err := json.Marshal(shardConversations[name])
		if err != nil {
			t.Fatalf("marshal %s: %v", name, err)
		}
		entry, err := innerWriter.Create(name)
		if err != nil {
			t.Fatalf("create inner entry %s: %v", name, err)
		}
		if _, err := entry.Write(data); err != nil {
			t.Fatalf("write inner entry %s: %v", name, err)
		}
	}
	if err := innerWriter.Close(); err != nil {
		t.Fatalf("close inner ZIP: %v", err)
	}

	archivePath := filepath.Join(t.TempDir(), "chatgpt-export-bundle.zip")
	writeClaudeExportZipEntryFixturesAt(t, archivePath, []claudeExportZipEntryFixture{
		{
			Name:    "User Online Activity/Conversations__test-hash-chatgpt-0001.zip",
			Content: string(innerBuf.Bytes()),
		},
		{Name: "report.html", Content: "<html></html>"},
	})
	return archivePath
}

func rewriteChatGPTExportArchive(t *testing.T, archivePath string, conversations []map[string]any) {
	t.Helper()
	data, err := json.Marshal(conversations)
	if err != nil {
		t.Fatalf("marshal conversations: %v", err)
	}
	writeClaudeExportZipEntryFixturesAt(t, archivePath, []claudeExportZipEntryFixture{
		{Name: "conversations.json", Content: string(data)},
	})
}

func chatgptSessionMessagesContainText(messages []SessionMessage, text string) bool {
	return slices.ContainsFunc(messages, func(message SessionMessage) bool {
		return message.Payload["text"] == text
	})
}

func writeChatGPTExportArchive(t *testing.T, conversations []map[string]any) string {
	t.Helper()
	data, err := json.Marshal(conversations)
	if err != nil {
		t.Fatalf("marshal conversations: %v", err)
	}
	archivePath := filepath.Join(t.TempDir(), "chatgpt-export.zip")
	writeClaudeExportZipEntryFixturesAt(t, archivePath, []claudeExportZipEntryFixture{
		{Name: "conversations.json", Content: string(data)},
		{Name: "user.json", Content: `{}`},
	})
	return archivePath
}

func writeChatGPTExportZipEntries(t *testing.T, entries map[string]string) string {
	t.Helper()
	archivePath := filepath.Join(t.TempDir(), "chatgpt-export.zip")
	fixtures := make([]claudeExportZipEntryFixture, 0, len(entries))
	for name, content := range entries {
		fixtures = append(fixtures, claudeExportZipEntryFixture{Name: name, Content: content})
	}
	writeClaudeExportZipEntryFixturesAt(t, archivePath, fixtures)
	return archivePath
}

func writeChatGPTExportZipEntryFixtures(t *testing.T, entries []claudeExportZipEntryFixture) string {
	t.Helper()
	archivePath := filepath.Join(t.TempDir(), "chatgpt-export.zip")
	writeClaudeExportZipEntryFixturesAt(t, archivePath, entries)
	return archivePath
}

func chatgptExportConversationFixture(id string, title string, currentNode string, mapping map[string]any) map[string]any {
	return map[string]any{
		"title":           title,
		"create_time":     1717200000.0,
		"update_time":     1717200100.0,
		"mapping":         mapping,
		"current_node":    currentNode,
		"conversation_id": id,
	}
}

func chatgptExportNodeFixture(id string, parent string, children []string, message map[string]any) map[string]any {
	return map[string]any{
		"id":       id,
		"parent":   parent,
		"children": children,
		"message":  message,
	}
}

func chatgptExportTextMessageFixture(id string, role string, createTime float64, text string) map[string]any {
	return map[string]any{
		"id":          id,
		"author":      map[string]any{"role": role},
		"create_time": createTime,
		"content":     map[string]any{"content_type": "text", "parts": []any{text}},
		"metadata":    map[string]any{},
	}
}

func chatgptExportMultimodalMessageFixture(id string, role string, createTime float64, parts []any) map[string]any {
	return map[string]any{
		"id":          id,
		"author":      map[string]any{"role": role},
		"create_time": createTime,
		"content":     map[string]any{"content_type": "multimodal_text", "parts": parts},
		"metadata":    map[string]any{},
	}
}

func chatgptExportHiddenMessageFixture(id string, role string, createTime float64, text string) map[string]any {
	message := chatgptExportTextMessageFixture(id, role, createTime, text)
	message["metadata"] = map[string]any{"is_visually_hidden_from_conversation": true}
	return message
}
