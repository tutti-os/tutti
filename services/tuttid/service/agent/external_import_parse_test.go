package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestParseCodexJSONLUsesFirstUserEventAsTitle(t *testing.T) {
	cwd := t.TempDir()
	session, ok, err := parseCodexJSONL(
		filepath.Join(cwd, "rollout.jsonl"),
		strings.NewReader(testAgentJSONL(t,
			map[string]any{
				"timestamp": "2026-06-18T00:00:00Z",
				"type":      "session_meta",
				"payload":   map[string]any{"id": "codex-title", "cwd": cwd},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:01Z",
				"type":      "response_item",
				"payload": map[string]any{
					"type":    "message",
					"role":    "user",
					"content": []any{map[string]any{"type": "input_text", "text": "<environment_context>\n</environment_context>"}},
				},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:02Z",
				"type":      "event_msg",
				"payload": map[string]any{
					"type":    "user_message",
					"message": "Tell me the plan",
				},
			},
		)),
	)
	if err != nil {
		t.Fatalf("parseCodexJSONL error = %v", err)
	}
	if !ok {
		t.Fatal("parseCodexJSONL ok = false")
	}
	if session.Title != "Tell me the plan" {
		t.Fatalf("title = %q, want first user message", session.Title)
	}
}

func TestParseCodexJSONLPreservesToolCallStructure(t *testing.T) {
	cwd := t.TempDir()
	session, ok, err := parseCodexJSONL(
		filepath.Join(cwd, "rollout.jsonl"),
		strings.NewReader(testAgentJSONL(t,
			map[string]any{
				"timestamp": "2026-06-18T00:00:00Z",
				"type":      "session_meta",
				"payload":   map[string]any{"id": "codex-tools", "cwd": cwd},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:01Z",
				"type":      "response_item",
				"payload": map[string]any{
					"type":    "message",
					"id":      "user-1",
					"role":    "user",
					"content": []any{map[string]any{"type": "input_text", "text": "Check status"}},
				},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:02Z",
				"type":      "response_item",
				"payload": map[string]any{
					"type":      "function_call",
					"id":        "call-item-1",
					"name":      "exec_command",
					"call_id":   "call-status",
					"arguments": `{"cmd":"git status --short","workdir":"/repo"}`,
				},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:03Z",
				"type":      "response_item",
				"payload": map[string]any{
					"type":    "function_call_output",
					"call_id": "call-status",
					"output":  "Chunk ID: abc\nOutput:\n M file.go\n",
				},
			},
		)),
	)
	if err != nil {
		t.Fatalf("parseCodexJSONL error = %v", err)
	}
	if !ok {
		t.Fatal("parseCodexJSONL ok = false")
	}
	if len(session.Messages) != 3 {
		t.Fatalf("messages = %#v, want user plus tool lifecycle", session.Messages)
	}
	started := session.Messages[1]
	if started.Role != "assistant" || started.Kind != "tool_call" || started.Status != "running" {
		t.Fatalf("started tool message = %#v", started)
	}
	if started.MessageIDSeed != "toolcall:call-status" {
		t.Fatalf("started message seed = %q, want tool call seed", started.MessageIDSeed)
	}
	if started.Payload["toolName"] != "exec_command" {
		t.Fatalf("started payload = %#v, want tool name", started.Payload)
	}
	input, _ := started.Payload["input"].(map[string]any)
	if input["cmd"] != "git status --short" {
		t.Fatalf("started input = %#v, want command", input)
	}
	completed := session.Messages[2]
	if completed.Role != "assistant" || completed.Kind != "tool_call" || completed.Status != "completed" {
		t.Fatalf("completed tool message = %#v", completed)
	}
	if completed.MessageIDSeed != started.MessageIDSeed {
		t.Fatalf("completed message seed = %q, want %q", completed.MessageIDSeed, started.MessageIDSeed)
	}
	output, _ := completed.Payload["output"].(map[string]any)
	if output["output"] != "Chunk ID: abc\nOutput:\n M file.go" {
		t.Fatalf("completed output = %#v, want command output", output)
	}
}

func TestParseCodexJSONLExtractsPromptFromIDEContext(t *testing.T) {
	cwd := t.TempDir()
	ideMessage := "# Context from my IDE setup:\n" +
		"The user is in file foo.go\n\n" +
		"## My request for Codex: Refactor the parser\n"
	session, ok, err := parseCodexJSONL(
		filepath.Join(cwd, "rollout.jsonl"),
		strings.NewReader(testAgentJSONL(t,
			map[string]any{
				"timestamp": "2026-06-18T00:00:00Z",
				"type":      "session_meta",
				"payload":   map[string]any{"id": "codex-ide", "cwd": cwd},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:01Z",
				"type":      "response_item",
				"payload": map[string]any{
					"type":    "message",
					"role":    "user",
					"content": []any{map[string]any{"type": "input_text", "text": ideMessage}},
				},
			},
		)),
	)
	if err != nil || !ok {
		t.Fatalf("parseCodexJSONL ok=%v err=%v", ok, err)
	}
	if session.Title != "Refactor the parser" {
		t.Fatalf("title = %q, want IDE request payload", session.Title)
	}
	if len(session.Messages) != 1 || session.Messages[0].Text != "Refactor the parser" {
		t.Fatalf("messages = %#v, want IDE context replaced with request text", session.Messages)
	}
}

func TestParseCodexJSONLSkipsAgentsAndEnvironmentPreamble(t *testing.T) {
	cwd := t.TempDir()
	session, ok, err := parseCodexJSONL(
		filepath.Join(cwd, "rollout.jsonl"),
		strings.NewReader(testAgentJSONL(t,
			map[string]any{
				"timestamp": "2026-06-18T00:00:00Z",
				"type":      "session_meta",
				"payload":   map[string]any{"id": "codex-preamble", "cwd": cwd},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:01Z",
				"type":      "response_item",
				"payload": map[string]any{
					"type":    "message",
					"role":    "user",
					"content": []any{map[string]any{"type": "input_text", "text": "# AGENTS.md\nrules"}},
				},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:02Z",
				"type":      "response_item",
				"payload": map[string]any{
					"type":    "message",
					"role":    "user",
					"content": []any{map[string]any{"type": "input_text", "text": "Real question here"}},
				},
			},
		)),
	)
	if err != nil || !ok {
		t.Fatalf("parseCodexJSONL ok=%v err=%v", ok, err)
	}
	if session.Title != "Real question here" {
		t.Fatalf("title = %q, want first non-preamble user message", session.Title)
	}
	if len(session.Messages) != 1 || session.Messages[0].Text != "Real question here" {
		t.Fatalf("messages = %#v, want only the real user message", session.Messages)
	}
}

func TestParseCodexJSONLMarksDocumentsCodexScratchCwdAsNoProject(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	cwd := filepath.Join(home, "Documents", "Codex", "2026-06-26", "ge")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatalf("create codex scratch cwd error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(home); ok {
		home = canonical
	}
	if canonical, ok := canonicalExistingDir(cwd); ok {
		cwd = canonical
	}
	t.Setenv("HOME", home)

	session, ok, err := parseCodexJSONL(
		filepath.Join(cwd, "rollout.jsonl"),
		strings.NewReader(testAgentJSONL(t,
			map[string]any{
				"timestamp": "2026-06-18T00:00:00Z",
				"type":      "session_meta",
				"payload":   map[string]any{"id": "codex-scratch", "cwd": cwd},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:01Z",
				"type":      "response_item",
				"payload": map[string]any{
					"type":    "message",
					"role":    "user",
					"content": []any{map[string]any{"type": "input_text", "text": "Scratch question"}},
				},
			},
		)),
	)
	if err != nil || !ok {
		t.Fatalf("parseCodexJSONL ok=%v err=%v", ok, err)
	}
	if !session.NoProject {
		t.Fatalf("NoProject = false for Codex scratch cwd %q", session.Cwd)
	}
}

func TestParseClaudeCodeJSONLDoesNotUseCodexScratchCwdNoProjectRule(t *testing.T) {
	home := filepath.Join(t.TempDir(), "home")
	cwd := filepath.Join(home, "Documents", "Codex", "2026-06-26", "ge")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatalf("create codex scratch-shaped cwd error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(home); ok {
		home = canonical
	}
	if canonical, ok := canonicalExistingDir(cwd); ok {
		cwd = canonical
	}
	t.Setenv("HOME", home)

	session, ok, err := parseClaudeCodeJSONL(
		filepath.Join(cwd, "claude.jsonl"),
		strings.NewReader(testAgentJSONL(t,
			map[string]any{
				"timestamp": "2026-06-18T00:00:00Z",
				"sessionId": "claude-project",
				"cwd":       cwd,
				"uuid":      "claude-1",
				"message":   map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "Project question"}}},
			},
		)),
	)
	if err != nil || !ok {
		t.Fatalf("parseClaudeCodeJSONL ok=%v err=%v", ok, err)
	}
	if session.NoProject {
		t.Fatalf("NoProject = true for non-Codex provider cwd %q", session.Cwd)
	}
}

func TestParseClaudeCodeJSONLPrefersCustomTitle(t *testing.T) {
	cwd := t.TempDir()
	session, ok, err := parseClaudeCodeJSONL(
		filepath.Join(cwd, "claude.jsonl"),
		strings.NewReader(testAgentJSONL(t,
			map[string]any{
				"timestamp": "2026-06-18T00:00:00Z",
				"sessionId": "claude-title",
				"cwd":       cwd,
				"uuid":      "claude-1",
				"message":   map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "Some long first prompt"}}},
			},
			map[string]any{
				"type":        "custom-title",
				"customTitle": "Summarize user persona prompts",
				"sessionId":   "claude-title",
			},
		)),
	)
	if err != nil || !ok {
		t.Fatalf("parseClaudeCodeJSONL ok=%v err=%v", ok, err)
	}
	if session.Title != "Summarize user persona prompts" {
		t.Fatalf("title = %q, want custom-title", session.Title)
	}
}

func TestParseClaudeCodeJSONLStripsTuttiMentionRoutingReminder(t *testing.T) {
	cwd := t.TempDir()
	prompt := "[@AI Canvas](mention://workspace-app/ai-media-canvas?workspaceId=ws-1) 帮我生成图片"
	session, ok, err := parseClaudeCodeJSONL(
		filepath.Join(cwd, "claude.jsonl"),
		strings.NewReader(testAgentJSONL(t,
			map[string]any{
				"timestamp": "2026-06-18T00:00:00Z",
				"sessionId": "claude-reminder",
				"cwd":       cwd,
				"uuid":      "claude-1",
				"message": map[string]any{
					"role": "user",
					"content": []any{
						map[string]any{"type": "text", "text": prompt},
						map[string]any{"type": "text", "text": tuttiMentionRoutingReminder},
					},
				},
			},
		)),
	)
	if err != nil || !ok {
		t.Fatalf("parseClaudeCodeJSONL ok=%v err=%v", ok, err)
	}
	if session.Title != prompt {
		t.Fatalf("title = %q, want user prompt title", session.Title)
	}
	if len(session.Messages) != 1 {
		t.Fatalf("message count = %d, want 1", len(session.Messages))
	}
	if session.Messages[0].Text != prompt {
		t.Fatalf("message text = %q, want user prompt", session.Messages[0].Text)
	}
}

func TestTruncateExternalTitleKeepsMultibyteRunesIntact(t *testing.T) {
	// 120 CJK runes (360 bytes) — must truncate by rune, not byte, so the
	// result stays valid UTF-8 instead of being cut mid-character.
	long := strings.Repeat("测", 120)
	got := truncateExternalTitle(long)
	if !utf8.ValidString(got) {
		t.Fatalf("truncated title = %q is not valid UTF-8", got)
	}
	if runes := utf8.RuneCountInString(got); runes != 80 {
		t.Fatalf("truncated rune count = %d, want 80", runes)
	}
}

func testAgentJSONL(t *testing.T, items ...map[string]any) string {
	t.Helper()
	var builder strings.Builder
	for _, item := range items {
		encoded, err := json.Marshal(item)
		if err != nil {
			t.Fatalf("marshal jsonl item error = %v", err)
		}
		builder.Write(encoded)
		builder.WriteByte('\n')
	}
	return builder.String()
}
