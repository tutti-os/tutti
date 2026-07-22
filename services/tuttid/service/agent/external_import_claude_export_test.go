package agent

import (
	"archive/zip"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestScanClaudeExportArchiveUsesVisibleTextBlocksAndPreservesFileReferences(t *testing.T) {
	archivePath := writeClaudeExportArchive(t, []map[string]any{
		claudeExportConversationFixture(
			"conversation-1",
			"Visible chat",
			[]map[string]any{
				claudeExportMessageFixture("message-user", "human", "2026-06-01T00:00:01.123456Z", []map[string]any{
					{"type": "text", "text": "Hello from the user"},
				}),
				{
					"attachments": []any{},
					"content": []map[string]any{
						{"type": "text", "text": "Visible answer"},
						{"type": "thinking", "thinking": "SECRET_THINKING"},
						{"type": "tool_use", "name": "private_tool", "input": map[string]any{"secret": "SECRET_TOOL"}},
						{"type": "tool_result", "content": []map[string]any{{"type": "text", "text": "SECRET_RESULT"}}},
						{"type": "token_budget", "remaining": nil},
						{"type": "text", "text": "Final note"},
					},
					"created_at":          "2026-06-01T00:00:02.123456Z",
					"files":               []any{},
					"parent_message_uuid": "message-user",
					"sender":              "assistant",
					"text":                "Visible answer\nSECRET_THINKING\nSECRET_TOOL\nSECRET_RESULT\nFinal note",
					"updated_at":          "2026-06-01T00:00:02.123456Z",
					"uuid":                "message-assistant",
				},
				{
					"attachments": []any{},
					"content": []map[string]any{
						{"type": "text", "text": ""},
					},
					"created_at":          "2026-06-01T00:00:03.123456Z",
					"files":               []map[string]any{{"file_name": "notes.txt", "file_uuid": "file-1"}},
					"parent_message_uuid": "message-assistant",
					"sender":              "human",
					"text":                "",
					"updated_at":          "2026-06-01T00:00:03.123456Z",
					"uuid":                "message-file",
				},
			},
		),
		claudeExportConversationFixture("conversation-empty", "Empty", nil),
	})

	data, err := scanClaudeExportArchive(context.Background(), archivePath, 0)
	if err != nil {
		t.Fatalf("scanClaudeExportArchive error = %v", err)
	}
	if data.result.ScannedSessions != 1 || data.result.ScannedMessages != 3 || data.result.SkippedSessions != 1 {
		t.Fatalf("scan result = %#v, want one session, three messages, one skipped empty conversation", data.result)
	}
	if len(data.sessions) != 1 {
		t.Fatalf("sessions = %#v, want one parsed session", data.sessions)
	}
	session := data.sessions[0]
	if session.ProviderSessionID != "claude-export:conversation-1:branch:main" || !session.NoProject {
		t.Fatalf("session identity = %#v", session)
	}
	if session.ResumeSupported == nil || *session.ResumeSupported {
		t.Fatalf("ResumeSupported = %#v, want false", session.ResumeSupported)
	}
	if session.Title != "Visible chat" {
		t.Fatalf("title = %q, want export name", session.Title)
	}
	assistant := session.Messages[1]
	if assistant.Text != "Visible answer\n\nFinal note" {
		t.Fatalf("assistant text = %q, want visible text blocks only", assistant.Text)
	}
	encodedAssistant, err := json.Marshal(assistant)
	if err != nil {
		t.Fatalf("marshal assistant = %v", err)
	}
	for _, secret := range []string{"SECRET_THINKING", "SECRET_TOOL", "SECRET_RESULT"} {
		if strings.Contains(string(encodedAssistant), secret) {
			t.Fatalf("assistant message leaked hidden content %q: %s", secret, encodedAssistant)
		}
	}
	fileMessage := session.Messages[2]
	if fileMessage.Text != "📎 notes.txt" {
		t.Fatalf("file-only message text = %q, want visible unavailable file reference", fileMessage.Text)
	}
	files, ok := fileMessage.Payload["files"].([]map[string]any)
	if !ok || len(files) != 1 || files[0]["fileUuid"] != "file-1" || files[0]["available"] != false {
		t.Fatalf("file payload = %#v", fileMessage.Payload["files"])
	}
	if fileMessage.Payload["sourceParentMessageId"] != "message-assistant" {
		t.Fatalf("parent message id = %#v", fileMessage.Payload["sourceParentMessageId"])
	}
}

func TestScanClaudeExportArchiveSelectsLatestLeafWithoutFlatteningBranches(t *testing.T) {
	root := claudeExportMessageFixture("message-root", "human", "2026-06-03T00:00:01Z", []map[string]any{{"type": "text", "text": "Question"}})
	oldAnswer := claudeExportMessageFixture("message-old", "assistant", "2026-06-03T00:00:03Z", []map[string]any{{"type": "text", "text": "Old retry"}})
	oldAnswer["parent_message_uuid"] = "message-root"
	currentAnswer := claudeExportMessageFixture("message-current", "assistant", "2026-06-03T00:00:02Z", []map[string]any{{"type": "text", "text": "Current answer"}})
	currentAnswer["parent_message_uuid"] = "message-root"
	currentFollowUp := claudeExportMessageFixture("message-follow-up", "human", "2026-06-03T00:00:04Z", []map[string]any{{"type": "text", "text": "Follow up"}})
	currentFollowUp["parent_message_uuid"] = "message-current"
	archivePath := writeClaudeExportArchive(t, []map[string]any{
		claudeExportConversationFixture(
			"conversation-branch",
			"Branched conversation",
			[]map[string]any{root, oldAnswer, currentAnswer, currentFollowUp},
		),
	})

	data, err := scanClaudeExportArchive(context.Background(), archivePath, 0)
	if err != nil {
		t.Fatalf("scanClaudeExportArchive error = %v", err)
	}
	if len(data.sessions) != 1 {
		t.Fatalf("sessions = %#v, want one", data.sessions)
	}
	messages := data.sessions[0].Messages
	if len(messages) != 3 {
		t.Fatalf("messages = %#v, want selected three-message branch", messages)
	}
	if messages[0].Text != "Question" || messages[1].Text != "Current answer" || messages[2].Text != "Follow up" {
		t.Fatalf("selected branch texts = %#v", []string{messages[0].Text, messages[1].Text, messages[2].Text})
	}
	for _, message := range messages {
		if message.Text == "Old retry" {
			t.Fatal("mutually exclusive retry branch was flattened into the selected conversation")
		}
		if message.MessageIDSeed != message.RawID {
			t.Fatalf("message seed = %q, want stable source UUID %q", message.MessageIDSeed, message.RawID)
		}
		if message.Payload["sourceBranchLeafId"] != "message-follow-up" {
			t.Fatalf("branch leaf = %#v, want message-follow-up", message.Payload["sourceBranchLeafId"])
		}
	}
}

func TestClaudeExportArchiveImportIsIdempotentNoProjectAndNonResumable(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-claude-export", Name: "Claude Export"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	archivePath := writeClaudeExportArchive(t, []map[string]any{
		claudeExportConversationFixture(
			"conversation-import",
			"Imported conversation",
			linkedClaudeExportMessages(
				claudeExportMessageFixture("message-1", "human", "2026-06-02T00:00:01.123456Z", []map[string]any{{"type": "text", "text": "Question"}}),
				claudeExportMessageFixture("message-2", "assistant", "2026-06-02T00:00:02.123456Z", []map[string]any{{"type": "text", "text": "Answer"}}),
			),
		),
	})
	service := NewService(newFakeRuntime())
	configureTestApplicationHost(service)
	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = store

	scan, err := service.ScanExternalImports(ctx, ExternalImportScanInput{ArchivePath: archivePath, Days: -1})
	if err != nil {
		t.Fatalf("ScanExternalImports error = %v", err)
	}
	if len(scan.Sessions) != 1 {
		t.Fatalf("scan sessions = %#v, want one", scan.Sessions)
	}
	home, ok := externalImportNoProjectBucketPath()
	if !ok {
		t.Fatal("home bucket unavailable")
	}
	selection := ExternalImportInput{
		ArchivePath: archivePath,
		Projects: []ExternalImportProjectSelection{{
			Path:       home,
			Providers:  []string{"claude-code"},
			SessionIDs: []string{scan.Sessions[0].ID},
		}},
	}
	result, err := service.ImportExternalSessions(ctx, "ws-claude-export", selection)
	if err != nil {
		t.Fatalf("ImportExternalSessions error = %v", err)
	}
	if result.ImportedSessions != 1 || result.ImportedMessages != 2 || result.ImportedProjects != 0 || len(result.ProjectPaths) != 0 {
		t.Fatalf("import result = %#v, want one no-project session and two messages", result)
	}
	rerun, err := service.ImportExternalSessions(ctx, "ws-claude-export", selection)
	if err != nil {
		t.Fatalf("ImportExternalSessions rerun error = %v", err)
	}
	if rerun.ImportedSessions != 0 || rerun.ImportedMessages != 0 {
		t.Fatalf("rerun result = %#v, want idempotent no-op", rerun)
	}

	session, err := service.Get(ctx, "ws-claude-export", scan.Sessions[0].ID)
	if err != nil {
		t.Fatalf("Get imported session error = %v", err)
	}
	if session.AgentTargetID != agenttargetbiz.IDLocalClaudeCode || session.Resumable {
		t.Fatalf("imported session target/resumable = %#v", session)
	}
	persisted, ok := projection.GetSession("ws-claude-export", session.ID)
	if !ok {
		t.Fatalf("persisted imported session %q not found", session.ID)
	}
	if !persisted.Metadata.Imported ||
		persisted.InternalRuntimeContext["externalImportNoProject"] != true ||
		persisted.InternalRuntimeContext["externalImportResumeSupported"] != false {
		t.Fatalf("internal runtime context = %#v", persisted.InternalRuntimeContext)
	}
	if _, err := service.SendInput(ctx, "ws-claude-export", session.ID, SendInput{Content: TextPromptContent("continue")}); !errors.Is(err, ErrSessionNotFound) {
		t.Fatalf("SendInput error = %v, want archive history to remain non-resumable", err)
	}
	messages, err := service.ListMessages(ctx, "ws-claude-export", session.ID, ListMessagesInput{Limit: 10})
	if err != nil {
		t.Fatalf("ListMessages error = %v", err)
	}
	if len(messages.Messages) != 2 || !slices.ContainsFunc(messages.Messages, func(message SessionMessage) bool {
		return message.Role == "assistant" && message.Payload["text"] == "Answer"
	}) {
		t.Fatalf("imported messages = %#v", messages.Messages)
	}
	existingIDs := map[string]string{}
	for _, message := range messages.Messages {
		sourceID, _ := message.Payload["sourceMessageId"].(string)
		existingIDs[sourceID] = message.MessageID
	}
	prepend := claudeExportMessageFixture("message-0", "human", "2026-06-02T00:00:00.123456Z", []map[string]any{{"type": "text", "text": "Earlier context"}})
	question := claudeExportMessageFixture("message-1", "human", "2026-06-02T00:00:01.123456Z", []map[string]any{{"type": "text", "text": "Question"}})
	answer := claudeExportMessageFixture("message-2", "assistant", "2026-06-02T00:00:02.123456Z", []map[string]any{{"type": "text", "text": "Answer"}})
	rewriteClaudeExportArchive(t, archivePath, []map[string]any{
		claudeExportConversationFixture(
			"conversation-import",
			"Imported conversation",
			linkedClaudeExportMessages(prepend, question, answer),
		),
	})
	updated, err := service.ImportExternalSessions(ctx, "ws-claude-export", selection)
	if err != nil {
		t.Fatalf("ImportExternalSessions updated export error = %v", err)
	}
	if updated.ImportedMessages != 1 {
		t.Fatalf("updated export result = %#v, want only the prepended message", updated)
	}
	updatedMessages, err := service.ListMessages(ctx, "ws-claude-export", session.ID, ListMessagesInput{Limit: 10})
	if err != nil {
		t.Fatalf("ListMessages after updated export error = %v", err)
	}
	if len(updatedMessages.Messages) != 3 {
		t.Fatalf("updated messages = %#v, want three unique messages", updatedMessages.Messages)
	}
	for _, message := range updatedMessages.Messages {
		sourceID, _ := message.Payload["sourceMessageId"].(string)
		if oldID := existingIDs[sourceID]; oldID != "" && oldID != message.MessageID {
			t.Fatalf("message %q id changed from %q to %q after predecessor insert", sourceID, oldID, message.MessageID)
		}
	}
}

func TestClaudeExportArchiveKeepsChangedRetryBranchesInSeparateSessions(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-claude-branches", Name: "Claude branches"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	root := claudeExportMessageFixture("message-root", "human", "2026-06-04T00:00:01Z", []map[string]any{{"type": "text", "text": "Question"}})
	oldAnswer := claudeExportMessageFixture("message-old", "assistant", "2026-06-04T00:00:02Z", []map[string]any{{"type": "text", "text": "Old answer"}})
	archivePath := writeClaudeExportArchive(t, []map[string]any{
		claudeExportConversationFixture(
			"conversation-changing-branch",
			"Changing branch",
			linkedClaudeExportMessages(root, oldAnswer),
		),
	})
	service := NewService(newFakeRuntime())
	configureTestApplicationHost(service)
	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = store

	firstScan, err := service.ScanExternalImports(ctx, ExternalImportScanInput{ArchivePath: archivePath, Days: -1})
	if err != nil || len(firstScan.Sessions) != 1 {
		t.Fatalf("first scan = %#v, error = %v", firstScan, err)
	}
	selectionFor := func(scan ExternalImportScanResult) ExternalImportInput {
		return ExternalImportInput{
			ArchivePath: archivePath,
			Projects: []ExternalImportProjectSelection{{
				Path:       scan.Sessions[0].ProjectPath,
				Providers:  []string{"claude-code"},
				SessionIDs: []string{scan.Sessions[0].ID},
			}},
		}
	}
	firstImport, err := service.ImportExternalSessions(ctx, "ws-claude-branches", selectionFor(firstScan))
	if err != nil || firstImport.ImportedSessions != 1 || firstImport.ImportedMessages != 2 {
		t.Fatalf("first import = %#v, error = %v", firstImport, err)
	}
	oldSessionID := firstScan.Sessions[0].ID

	root = claudeExportMessageFixture("message-root", "human", "2026-06-04T00:00:01Z", []map[string]any{{"type": "text", "text": "Question"}})
	oldAnswer = claudeExportMessageFixture("message-old", "assistant", "2026-06-04T00:00:02Z", []map[string]any{{"type": "text", "text": "Old answer"}})
	oldAnswer["parent_message_uuid"] = "message-root"
	newAnswer := claudeExportMessageFixture("message-new", "assistant", "2026-06-04T00:00:03Z", []map[string]any{{"type": "text", "text": "New answer"}})
	newAnswer["parent_message_uuid"] = "message-root"
	rewriteClaudeExportArchive(t, archivePath, []map[string]any{
		claudeExportConversationFixture(
			"conversation-changing-branch",
			"Changing branch",
			[]map[string]any{root, oldAnswer, newAnswer},
		),
	})
	secondScan, err := service.ScanExternalImports(ctx, ExternalImportScanInput{ArchivePath: archivePath, Days: -1})
	if err != nil || len(secondScan.Sessions) != 1 {
		t.Fatalf("second scan = %#v, error = %v", secondScan, err)
	}
	newSessionID := secondScan.Sessions[0].ID
	if newSessionID == oldSessionID {
		t.Fatalf("changed retry branch reused session id %q", newSessionID)
	}
	secondImport, err := service.ImportExternalSessions(ctx, "ws-claude-branches", selectionFor(secondScan))
	if err != nil || secondImport.ImportedSessions != 1 || secondImport.ImportedMessages != 2 {
		t.Fatalf("second import = %#v, error = %v", secondImport, err)
	}

	oldMessages, err := service.ListMessages(ctx, "ws-claude-branches", oldSessionID, ListMessagesInput{Limit: 10})
	if err != nil {
		t.Fatalf("list old branch: %v", err)
	}
	newMessages, err := service.ListMessages(ctx, "ws-claude-branches", newSessionID, ListMessagesInput{Limit: 10})
	if err != nil {
		t.Fatalf("list new branch: %v", err)
	}
	if !sessionMessagesContainText(oldMessages.Messages, "Old answer") || sessionMessagesContainText(oldMessages.Messages, "New answer") {
		t.Fatalf("old branch messages = %#v", oldMessages.Messages)
	}
	if !sessionMessagesContainText(newMessages.Messages, "New answer") || sessionMessagesContainText(newMessages.Messages, "Old answer") {
		t.Fatalf("new branch messages = %#v", newMessages.Messages)
	}
}

func sessionMessagesContainText(messages []SessionMessage, text string) bool {
	return slices.ContainsFunc(messages, func(message SessionMessage) bool {
		return message.Payload["text"] == text
	})
}

func TestScanClaudeExportArchiveRejectsInvalidArchives(t *testing.T) {
	tests := []struct {
		name string
		path func(*testing.T) string
	}{
		{
			name: "relative path",
			path: func(*testing.T) string { return "export.zip" },
		},
		{
			name: "missing conversations entry",
			path: func(t *testing.T) string {
				return writeClaudeExportZipEntries(t, map[string]string{"users.json": `[]`})
			},
		},
		{
			name: "nested conversations entry",
			path: func(t *testing.T) string {
				return writeClaudeExportZipEntries(t, map[string]string{"nested/conversations.json": `[]`})
			},
		},
		{
			name: "invalid JSON",
			path: func(t *testing.T) string {
				return writeClaudeExportZipEntries(t, map[string]string{"conversations.json": `{`})
			},
		},
		{
			name: "wrong top level",
			path: func(t *testing.T) string {
				return writeClaudeExportZipEntries(t, map[string]string{"conversations.json": `{}`})
			},
		},
		{
			name: "duplicate conversations entry",
			path: func(t *testing.T) string {
				return writeClaudeExportZipEntryFixtures(t, []claudeExportZipEntryFixture{
					{Name: "conversations.json", Content: `[]`},
					{Name: "conversations.json", Content: `[]`},
				})
			},
		},
		{
			name: "symlink conversations entry",
			path: func(t *testing.T) string {
				return writeClaudeExportZipEntryFixtures(t, []claudeExportZipEntryFixture{
					{Name: "conversations.json", Content: `target`, Mode: os.ModeSymlink | 0o777},
				})
			},
		},
		{
			name: "excessive nested array items",
			path: func(t *testing.T) string {
				objects := strings.TrimSuffix(strings.Repeat(`{},`, maxClaudeExportJSONContainerItems+1), ",")
				conversation := `{"uuid":"conversation-large","chat_messages":[` + objects + `]}`
				return writeClaudeExportZipEntries(t, map[string]string{"conversations.json": `[` + conversation + `]`})
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := scanClaudeExportArchive(context.Background(), tc.path(t), 0)
			if !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("error = %v, want ErrInvalidArgument", err)
			}
		})
	}
}

func TestScanClaudeExportArchivePreflightsDirectoryLimits(t *testing.T) {
	tests := []struct {
		name   string
		mutate func([]byte, int)
	}{
		{
			name: "entry count",
			mutate: func(data []byte, endOffset int) {
				count := uint16(maxClaudeExportArchiveEntries + 1)
				binary.LittleEndian.PutUint16(data[endOffset+8:], count)
				binary.LittleEndian.PutUint16(data[endOffset+10:], count)
			},
		},
		{
			name: "central directory size",
			mutate: func(data []byte, endOffset int) {
				binary.LittleEndian.PutUint32(data[endOffset+12:], uint32(maxClaudeZipDirectoryBytes+1))
			},
		},
		{
			name: "ZIP64 directory offset sentinel",
			mutate: func(data []byte, endOffset int) {
				binary.LittleEndian.PutUint32(data[endOffset+16:], ^uint32(0))
			},
		},
		{
			name: "directory span mismatch",
			mutate: func(data []byte, endOffset int) {
				directorySize := binary.LittleEndian.Uint32(data[endOffset+12:])
				binary.LittleEndian.PutUint32(data[endOffset+12:], directorySize-1)
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			archivePath := writeClaudeExportArchive(t, nil)
			data, err := os.ReadFile(archivePath)
			if err != nil {
				t.Fatalf("read archive: %v", err)
			}
			endOffset := len(data) - 22
			if endOffset < 0 || binary.LittleEndian.Uint32(data[endOffset:]) != claudeZipEndOfCentralDirectorySignature {
				t.Fatal("test ZIP does not end with an EOCD record")
			}
			tc.mutate(data, endOffset)
			if err := os.WriteFile(archivePath, data, 0o600); err != nil {
				t.Fatalf("rewrite archive: %v", err)
			}
			_, err = scanClaudeExportArchive(context.Background(), archivePath, 0)
			if !errors.Is(err, ErrInvalidArgument) {
				t.Fatalf("error = %v, want ErrInvalidArgument", err)
			}
		})
	}
}

func TestScanExternalAgentSessionsArchiveIgnoresDefaultDayWindow(t *testing.T) {
	// The fixture conversation is dated 2026-06, well past the historical
	// 30-day default, so it only survives if the archive branch skips the
	// implicit window.
	archivePath := writeClaudeExportArchive(t, []map[string]any{
		claudeExportConversationFixture("conversation-old", "Old", linkedClaudeExportMessages(
			claudeExportMessageFixture("message-1", "human", "2026-06-01T00:00:00Z", []map[string]any{
				{"type": "text", "text": "hello"},
			}),
		)),
	})
	data, err := scanExternalAgentSessions(context.Background(), nil, 0, archivePath)
	if err != nil {
		t.Fatalf("scan archive with default days: %v", err)
	}
	if data.result.ScannedSessions != 1 {
		t.Fatalf("ScannedSessions = %d, want 1", data.result.ScannedSessions)
	}
	// An explicit positive window still narrows the archive scan.
	data, err = scanExternalAgentSessions(context.Background(), nil, 7, archivePath)
	if err != nil {
		t.Fatalf("scan archive with 7-day window: %v", err)
	}
	if data.result.ScannedSessions != 0 {
		t.Fatalf("ScannedSessions = %d, want 0 for a 7-day window", data.result.ScannedSessions)
	}
}

func TestScanExternalAgentSessionsRejectsArchiveWithoutClaudeProvider(t *testing.T) {
	archivePath := writeClaudeExportArchive(t, []map[string]any{})
	_, err := scanExternalAgentSessions(context.Background(), []string{"codex"}, 0, archivePath)
	if !errors.Is(err, ErrInvalidArgument) {
		t.Fatalf("error = %v, want ErrInvalidArgument for a provider filter excluding claude-code", err)
	}
	if _, err := scanExternalAgentSessions(context.Background(), []string{"codex", "claude-code"}, 0, archivePath); err != nil {
		t.Fatalf("scan with claude-code included: %v", err)
	}
}

func TestScanExternalAgentSessionsSurfacesCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := scanExternalAgentSessions(ctx, nil, 0, ""); !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}

func TestClaudeExportConversationStreamRejectsElementBeforeExceedingByteBudget(t *testing.T) {
	stream, err := newClaudeExportConversationStreamWithLimits(
		context.Background(),
		strings.NewReader(`[{"uuid":"conversation-too-large","chat_messages":[]}]`),
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

func claudeExportConversationFixture(id string, name string, messages []map[string]any) map[string]any {
	if messages == nil {
		messages = []map[string]any{}
	}
	return map[string]any{
		"account":       map[string]any{"uuid": "account-1"},
		"chat_messages": messages,
		"created_at":    "2026-06-01T00:00:00.123456Z",
		"name":          name,
		"summary":       "",
		"updated_at":    "2026-06-02T00:00:00.123456Z",
		"uuid":          id,
	}
}

func claudeExportMessageFixture(id string, sender string, timestamp string, content []map[string]any) map[string]any {
	return map[string]any{
		"attachments":         []any{},
		"content":             content,
		"created_at":          timestamp,
		"files":               []any{},
		"parent_message_uuid": "00000000-0000-4000-8000-000000000000",
		"sender":              sender,
		"text":                "TOP_LEVEL_TEXT_MUST_NOT_WIN",
		"updated_at":          timestamp,
		"uuid":                id,
	}
}

func linkedClaudeExportMessages(messages ...map[string]any) []map[string]any {
	for index := 1; index < len(messages); index++ {
		messages[index]["parent_message_uuid"] = messages[index-1]["uuid"]
	}
	return messages
}

func writeClaudeExportArchive(t *testing.T, conversations []map[string]any) string {
	t.Helper()
	archivePath := filepath.Join(t.TempDir(), "claude-export.zip")
	rewriteClaudeExportArchive(t, archivePath, conversations)
	return archivePath
}

func rewriteClaudeExportArchive(t *testing.T, archivePath string, conversations []map[string]any) {
	t.Helper()
	data, err := json.Marshal(conversations)
	if err != nil {
		t.Fatalf("marshal conversations: %v", err)
	}
	writeClaudeExportZipEntryFixturesAt(t, archivePath, []claudeExportZipEntryFixture{
		{Name: "conversations.json", Content: string(data)},
		{Name: "users.json", Content: `[]`},
	})
}

func writeClaudeExportZipEntries(t *testing.T, entries map[string]string) string {
	t.Helper()
	archivePath := filepath.Join(t.TempDir(), "claude-export.zip")
	fixtures := make([]claudeExportZipEntryFixture, 0, len(entries))
	for name, content := range entries {
		fixtures = append(fixtures, claudeExportZipEntryFixture{Name: name, Content: content})
	}
	writeClaudeExportZipEntryFixturesAt(t, archivePath, fixtures)
	return archivePath
}

type claudeExportZipEntryFixture struct {
	Name    string
	Content string
	Mode    os.FileMode
}

func writeClaudeExportZipEntryFixtures(t *testing.T, entries []claudeExportZipEntryFixture) string {
	t.Helper()
	archivePath := filepath.Join(t.TempDir(), "claude-export.zip")
	writeClaudeExportZipEntryFixturesAt(t, archivePath, entries)
	return archivePath
}

func writeClaudeExportZipEntryFixturesAt(t *testing.T, archivePath string, entries []claudeExportZipEntryFixture) {
	t.Helper()
	target, err := os.Create(archivePath)
	if err != nil {
		t.Fatalf("create archive: %v", err)
	}
	writer := zip.NewWriter(target)
	for _, fixture := range entries {
		header := &zip.FileHeader{Name: fixture.Name, Method: zip.Deflate}
		if fixture.Mode != 0 {
			header.SetMode(fixture.Mode)
		}
		entry, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatalf("create ZIP entry %s: %v", fixture.Name, err)
		}
		if _, err := entry.Write([]byte(fixture.Content)); err != nil {
			t.Fatalf("write ZIP entry %s: %v", fixture.Name, err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close ZIP writer: %v", err)
	}
	if err := target.Close(); err != nil {
		t.Fatalf("close archive: %v", err)
	}
}
