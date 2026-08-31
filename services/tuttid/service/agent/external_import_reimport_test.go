package agent

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	agentactivitybiz "github.com/tutti-os/tutti/packages/agent/store-sqlite"
	agenttargetbiz "github.com/tutti-os/tutti/services/tuttid/biz/agenttarget"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

func TestServiceImportsExternalAgentSessionsByProject(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	root := t.TempDir()
	projectA := filepath.Join(root, "project-a")
	projectB := filepath.Join(root, "project-b")
	if err := os.MkdirAll(projectA, 0o755); err != nil {
		t.Fatalf("create project A error = %v", err)
	}
	if err := os.MkdirAll(projectB, 0o755); err != nil {
		t.Fatalf("create project B error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(projectA); ok {
		projectA = canonical
	}
	if canonical, ok := canonicalExistingDir(projectB); ok {
		projectB = canonical
	}
	codexHome := filepath.Join(root, "codex-home")
	claudeHome := filepath.Join(root, "claude-home")
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", claudeHome)
	recent := time.Now().Add(-24 * time.Hour)
	timestamp := func(offset time.Duration) string {
		return recent.Add(offset).UTC().Format(time.RFC3339Nano)
	}
	oldTimestamp := time.Now().Add(-45 * 24 * time.Hour).UTC().Format(time.RFC3339Nano)

	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "2026", "codex-a.jsonl"),
		map[string]any{
			"timestamp": timestamp(0),
			"type":      "session_meta",
			"payload":   map[string]any{"id": "codex-a", "cwd": projectA},
		},
		map[string]any{"timestamp": timestamp(time.Second), "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-a-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Plan the import"}},
		}},
		map[string]any{"timestamp": timestamp(2 * time.Second), "type": "response_item", "payload": map[string]any{
			"type":      "function_call",
			"id":        "codex-a-tool-1",
			"name":      "exec_command",
			"call_id":   "call-codex-a-status",
			"arguments": `{"cmd":"git status --short","workdir":"/repo"}`,
		}},
		map[string]any{"timestamp": timestamp(3 * time.Second), "type": "response_item", "payload": map[string]any{
			"type":    "function_call_output",
			"call_id": "call-codex-a-status",
			"output":  "Chunk ID: abc\nOutput:\n M file.go\n",
		}},
		map[string]any{"timestamp": timestamp(4 * time.Second), "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-a-2", "role": "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": "Import planned"}},
		}},
	)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "archived_sessions", "codex-b.jsonl"),
		map[string]any{
			"timestamp": timestamp(time.Hour),
			"type":      "session_meta",
			"payload":   map[string]any{"id": "codex-b", "cwd": projectB},
		},
		map[string]any{"timestamp": timestamp(time.Hour + time.Second), "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-b-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Other project"}},
		}},
	)
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "old", "codex-old.jsonl"),
		map[string]any{
			"timestamp": oldTimestamp,
			"type":      "session_meta",
			"payload":   map[string]any{"id": "codex-old", "cwd": projectA},
		},
		map[string]any{"timestamp": oldTimestamp, "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-old-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Old project"}},
		}},
	)
	writeAgentServiceJSONL(t, filepath.Join(claudeHome, "projects", "project-a", "claude-a.jsonl"),
		map[string]any{
			"timestamp": timestamp(2 * time.Hour), "sessionId": "claude-a", "cwd": projectA, "uuid": "claude-a-1",
			"message": map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "Claude question"}}},
		},
		map[string]any{
			"timestamp": timestamp(2*time.Hour + time.Second), "sessionId": "claude-a", "cwd": projectA, "uuid": "claude-a-2",
			"message": map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "Claude answer"}}},
		},
	)

	runtime := newFakeRuntime()
	service := newIsolatedAgentService(runtime)
	service.AgentTargetStore = fakeAgentTargetStore{targets: defaultTestAgentTargets()}
	projection := NewActivityProjection(store)
	service.SessionReader = projection
	service.MessageReader = projection
	service.ExternalImportStore = store

	scan, err := service.ScanExternalImports(ctx, ExternalImportScanInput{})
	if err != nil {
		t.Fatalf("ScanExternalImports error = %v", err)
	}
	if scan.ScannedSessions != 3 || scan.ScannedMessages != 7 || len(scan.Projects) != 2 {
		t.Fatalf("scan = %#v, want 3 sessions, 7 messages, 2 projects", scan)
	}
	codexAID := externalImportedSessionID("codex", "codex-a", filepath.Join(codexHome, "sessions", "2026", "codex-a.jsonl"))
	if !slices.ContainsFunc(scan.Sessions, func(session ExternalImportSession) bool {
		return session.ID == codexAID && session.ProjectPath == projectA && session.Provider == "codex"
	}) {
		t.Fatalf("scan sessions = %#v, want codex-a summary", scan.Sessions)
	}

	result, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: projectA, SessionIDs: []string{codexAID}}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions error = %v", err)
	}
	if result.ImportedProjects != 1 || result.ImportedSessions != 1 || result.ImportedMessages != 4 {
		t.Fatalf("import result = %#v, want one project, one session, four message updates", result)
	}
	if len(result.ProjectPaths) != 1 || result.ProjectPaths[0] != projectA {
		t.Fatalf("project paths = %#v, want [%s]", result.ProjectPaths, projectA)
	}
	importedSession, err := service.Get(ctx, "ws-1", codexAID)
	if err != nil {
		t.Fatalf("Get imported session error = %v", err)
	}
	if value(importedSession.Title) != "Plan the import" {
		t.Fatalf("imported session title = %q, want first user message", value(importedSession.Title))
	}
	if importedSession.AgentTargetID != agenttargetbiz.IDLocalCodex {
		t.Fatalf("imported Codex agent target id = %q, want %s", importedSession.AgentTargetID, agenttargetbiz.IDLocalCodex)
	}
	importedMessages, err := service.ListMessages(ctx, "ws-1", codexAID, ListMessagesInput{Limit: 10})
	if err != nil {
		t.Fatalf("ListMessages imported session error = %v", err)
	}
	if !slices.ContainsFunc(importedMessages.Messages, func(message SessionMessage) bool {
		input, _ := message.Payload["input"].(map[string]any)
		output, _ := message.Payload["output"].(map[string]any)
		return message.Kind == "tool_call" &&
			message.Role == "assistant" &&
			message.Status == "completed" &&
			message.Payload["toolName"] == "exec_command" &&
			input["cmd"] == "git status --short" &&
			output["text"] == "Chunk ID: abc\nOutput:\n M file.go"
	}) {
		t.Fatalf("imported messages = %#v, want canonical Codex tool call", importedMessages.Messages)
	}
	codexTurnID := ""
	for _, message := range importedMessages.Messages {
		if message.TurnID == "" {
			t.Fatalf("imported Codex message %q has no reconstructed turn", message.MessageID)
		}
		if codexTurnID == "" {
			codexTurnID = message.TurnID
		} else if message.TurnID != codexTurnID {
			t.Fatalf("imported Codex message %q turn = %q, want %q", message.MessageID, message.TurnID, codexTurnID)
		}
	}
	codexTurn, ok, err := store.GetTurn(ctx, "ws-1", codexAID, codexTurnID)
	if err != nil || !ok {
		t.Fatalf("GetTurn(imported Codex) ok=%v error=%v", ok, err)
	}
	if !codexTurn.Backfilled || codexTurn.Phase != agentactivitybiz.TurnPhaseSettled ||
		codexTurn.Origin != agentactivitybiz.TurnOriginUserPrompt {
		t.Fatalf("imported Codex turn = %#v, want settled user-prompt backfill", codexTurn)
	}
	sessions, err := service.List(ctx, "ws-1")
	if err != nil {
		t.Fatalf("List error = %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("len(sessions) = %d, want 1", len(sessions))
	}
	for _, session := range sessions {
		if session.Cwd != projectA {
			t.Fatalf("session cwd = %q, want %q", session.Cwd, projectA)
		}
		if !session.Resumable {
			t.Fatalf("imported session %s resumable = false, want continuable in place", session.ID)
		}
	}

	// Importing the whole project (no explicit session ids) now covers all
	// available history rather than only the discovery window, so an explicitly
	// imported project also pulls the 45-day-old codex-old session that the
	// 30-day scan deliberately hides. claude-a (2 messages) + codex-old (1).
	rerun, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: projectA}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions rerun error = %v", err)
	}
	if rerun.ImportedSessions != 2 || rerun.ImportedMessages != 3 {
		t.Fatalf("second import = %#v, want remaining project sessions and messages", rerun)
	}
	claudeSession, err := service.Get(ctx, "ws-1", externalImportedSessionID("claude-code", "claude-a", filepath.Join(claudeHome, "projects", "project-a", "claude-a.jsonl")))
	if err != nil {
		t.Fatalf("Get imported Claude Code session error = %v", err)
	}
	if claudeSession.AgentTargetID != agenttargetbiz.IDLocalClaudeCode {
		t.Fatalf("imported Claude Code agent target id = %q, want %s", claudeSession.AgentTargetID, agenttargetbiz.IDLocalClaudeCode)
	}
	claudeMessages, err := service.ListMessages(ctx, "ws-1", claudeSession.ID, ListMessagesInput{Limit: 10})
	if err != nil {
		t.Fatalf("ListMessages imported Claude Code session error = %v", err)
	}
	if len(claudeMessages.Messages) != 2 ||
		claudeMessages.Messages[0].TurnID == "" ||
		claudeMessages.Messages[0].TurnID != claudeMessages.Messages[1].TurnID {
		t.Fatalf("imported Claude Code messages = %#v, want one reconstructed turn", claudeMessages.Messages)
	}
	finalRerun, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: projectA}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions final rerun error = %v", err)
	}
	if finalRerun.ImportedSessions != 0 || finalRerun.ImportedMessages != 0 {
		t.Fatalf("final rerun import = %#v, want no new sessions or messages", finalRerun)
	}
	writeAgentServiceJSONL(t, filepath.Join(codexHome, "sessions", "2026", "codex-a.jsonl"),
		map[string]any{
			"timestamp": timestamp(0),
			"type":      "session_meta",
			"payload":   map[string]any{"id": "codex-a", "cwd": projectA},
		},
		map[string]any{"timestamp": timestamp(time.Second), "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-a-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Updated first prompt"}},
		}},
		map[string]any{"timestamp": timestamp(2 * time.Second), "type": "response_item", "payload": map[string]any{
			"type":      "function_call",
			"id":        "codex-a-tool-1",
			"name":      "exec_command",
			"call_id":   "call-codex-a-status",
			"arguments": `{"cmd":"git status --short","workdir":"/repo"}`,
		}},
		map[string]any{"timestamp": timestamp(3 * time.Second), "type": "response_item", "payload": map[string]any{
			"type":    "function_call_output",
			"call_id": "call-codex-a-status",
			"output":  "Chunk ID: abc\nOutput:\n M file.go\n",
		}},
		map[string]any{"timestamp": timestamp(4 * time.Second), "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "codex-a-2", "role": "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": "Import planned"}},
		}},
	)
	titleRefresh, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: projectA, SessionIDs: []string{codexAID}}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions title refresh error = %v", err)
	}
	if titleRefresh.ImportedSessions != 0 || titleRefresh.ImportedMessages != 0 {
		t.Fatalf("title refresh import = %#v, want no new sessions or messages", titleRefresh)
	}
	refreshedSession, err := service.Get(ctx, "ws-1", codexAID)
	if err != nil {
		t.Fatalf("Get refreshed imported session error = %v", err)
	}
	if value(refreshedSession.Title) != "Updated first prompt" {
		t.Fatalf("refreshed title = %q, want updated first user message", value(refreshedSession.Title))
	}
}

func TestServiceReimportRepairsLegacyTurnlessExternalMessages(t *testing.T) {
	ctx := context.Background()
	store := openAgentServiceSQLiteStore(t)
	if err := store.Create(ctx, workspacebiz.Summary{ID: "ws-1", Name: "Workspace One"}); err != nil {
		t.Fatalf("Create workspace error = %v", err)
	}
	root := t.TempDir()
	project := filepath.Join(root, "project")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatalf("create project error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(project); ok {
		project = canonical
	}
	codexHome := filepath.Join(root, "codex-home")
	t.Setenv("CODEX_HOME", codexHome)
	t.Setenv("CLAUDE_CONFIG_DIR", filepath.Join(root, "claude-home"))
	sourcePath := filepath.Join(codexHome, "sessions", "legacy-turnless.jsonl")
	writeAgentServiceJSONL(t, sourcePath,
		map[string]any{
			"timestamp": "2026-07-24T00:00:00Z",
			"type":      "session_meta",
			"payload":   map[string]any{"id": "legacy-turnless", "cwd": project},
		},
		map[string]any{"timestamp": "2026-07-24T00:00:01Z", "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "user-1", "role": "user",
			"content": []any{map[string]any{"type": "input_text", "text": "Inspect the project"}},
		}},
		map[string]any{"timestamp": "2026-07-24T00:00:02Z", "type": "response_item", "payload": map[string]any{
			"type": "function_call", "id": "tool-1", "name": "exec_command",
			"call_id": "call-status", "arguments": `{"cmd":"git status --short"}`,
		}},
		map[string]any{"timestamp": "2026-07-24T00:00:03Z", "type": "response_item", "payload": map[string]any{
			"type": "function_call_output", "call_id": "call-status", "output": "clean",
		}},
		map[string]any{"timestamp": "2026-07-24T00:00:04Z", "type": "response_item", "payload": map[string]any{
			"type": "message", "id": "assistant-1", "role": "assistant",
			"content": []any{map[string]any{"type": "output_text", "text": "The project is clean"}},
		}},
	)
	source, err := os.Open(sourcePath)
	if err != nil {
		t.Fatalf("open source transcript error = %v", err)
	}
	defer source.Close()
	parsed, ok, err := parseCodexJSONL(sourcePath, source)
	if err != nil || !ok {
		t.Fatalf("parseCodexJSONL ok=%v error=%v", ok, err)
	}
	agentSessionID := externalImportedSessionID(parsed.Provider, parsed.ProviderSessionID, parsed.SourcePath)
	legacyUpdates := make([]agentactivitybiz.MessageUpdate, 0, len(parsed.Messages))
	for index, message := range parsed.Messages {
		legacyUpdates = append(legacyUpdates, agentactivitybiz.MessageUpdate{
			MessageID:         externalImportedMessageIDForMessage(parsed.Provider, parsed.ProviderSessionID, message, index),
			Role:              message.Role,
			Kind:              message.Kind,
			Status:            message.Status,
			Payload:           externalImportedMessagePayload(message),
			OccurredAtUnixMS:  message.OccurredAtUnixMS,
			StartedAtUnixMS:   message.StartedAtUnixMS,
			CompletedAtUnixMS: message.CompletedAtUnixMS,
		})
	}
	if _, err := store.ReportSessionMessages(ctx, agentactivitybiz.SessionMessageReport{
		WorkspaceID: "ws-1", AgentSessionID: agentSessionID,
		Origin: WorkspaceAgentSessionOriginImported, Provider: parsed.Provider,
		HistoricalImport: true, Messages: legacyUpdates,
	}); err != nil {
		t.Fatalf("seed legacy turnless messages error = %v", err)
	}

	service := newIsolatedAgentService(newFakeRuntime())
	service.ExternalImportStore = store
	result, err := service.ImportExternalSessions(ctx, "ws-1", ExternalImportInput{
		Projects: []ExternalImportProjectSelection{{Path: project}},
	})
	if err != nil {
		t.Fatalf("ImportExternalSessions repair error = %v", err)
	}
	if result.ImportedMessages != len(parsed.Messages) {
		t.Fatalf("repair result = %#v, want %d repaired updates", result, len(parsed.Messages))
	}
	page, found, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID: "ws-1", AgentSessionID: agentSessionID, Limit: 10,
	})
	if err != nil || !found {
		t.Fatalf("ListSessionMessages repaired found=%v error=%v", found, err)
	}
	repairedTurnID := ""
	for _, message := range page.Messages {
		if message.TurnID == "" {
			t.Fatalf("repaired message %q remains turnless", message.MessageID)
		}
		if repairedTurnID == "" {
			repairedTurnID = message.TurnID
		} else if message.TurnID != repairedTurnID {
			t.Fatalf("repaired message %q turn = %q, want %q", message.MessageID, message.TurnID, repairedTurnID)
		}
	}
}
