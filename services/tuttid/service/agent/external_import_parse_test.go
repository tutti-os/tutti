package agent

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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

func TestParseCodexJSONLCapturesLatestModelAndEffortFromTurnContext(t *testing.T) {
	cwd := t.TempDir()
	session, ok, err := parseCodexJSONL(
		filepath.Join(cwd, "rollout.jsonl"),
		strings.NewReader(testAgentJSONL(t,
			map[string]any{
				"timestamp": "2026-06-18T00:00:00Z",
				"type":      "session_meta",
				"payload":   map[string]any{"id": "codex-model", "cwd": cwd},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:01Z",
				"type":      "turn_context",
				"payload": map[string]any{
					"turn_id": "turn-1",
					"cwd":     cwd,
					"model":   "gpt-5.3",
					"effort":  "medium",
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
			// A later turn switches the local CLI to a higher-effort model;
			// the imported session should reflect this most recent setting.
			map[string]any{
				"timestamp": "2026-06-18T00:00:03Z",
				"type":      "turn_context",
				"payload": map[string]any{
					"turn_id": "turn-2",
					"cwd":     cwd,
					"model":   "gpt-5.4",
					"effort":  "xhigh",
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
	if session.Model != "gpt-5.4" {
		t.Fatalf("model = %q, want latest turn_context model", session.Model)
	}
	if session.ReasoningEffort != "xhigh" {
		t.Fatalf("reasoningEffort = %q, want latest turn_context effort", session.ReasoningEffort)
	}
}

func TestParseCodexJSONLPreservesNativeTurnBoundaries(t *testing.T) {
	cwd := t.TempDir()
	firstStart := time.Date(2026, time.July, 17, 10, 0, 0, 0, time.UTC)
	firstSettled := firstStart.Add(12 * time.Second)
	secondStart := firstStart.Add(time.Minute)
	secondSettled := secondStart.Add(25 * time.Second)
	thirdStart := secondStart.Add(time.Minute)
	session, ok, err := parseCodexJSONL(
		filepath.Join(cwd, "rollout.jsonl"),
		strings.NewReader(testAgentJSONL(t,
			map[string]any{
				"timestamp": firstStart.Add(-time.Second).Format(time.RFC3339Nano),
				"type":      "session_meta",
				"payload":   map[string]any{"id": "codex-turns", "cwd": cwd},
			},
			map[string]any{
				"timestamp": firstStart.Format(time.RFC3339Nano),
				"type":      "event_msg",
				"payload":   map[string]any{"type": "task_started", "turn_id": "turn-1"},
			},
			map[string]any{
				"timestamp": firstStart.Add(10 * time.Millisecond).Format(time.RFC3339Nano),
				"type":      "turn_context",
				"payload":   map[string]any{"turn_id": "turn-1"},
			},
			map[string]any{
				"timestamp": firstStart.Add(time.Second).Format(time.RFC3339Nano),
				"type":      "response_item",
				"payload": map[string]any{
					"type": "message", "id": "user-1", "role": "user",
					"content": []any{map[string]any{"type": "input_text", "text": "First prompt"}},
				},
			},
			map[string]any{
				"timestamp": firstStart.Add(5 * time.Second).Format(time.RFC3339Nano),
				"type":      "turn_context",
				"payload":   map[string]any{"turn_id": "turn-1"},
			},
			map[string]any{
				"timestamp": firstStart.Add(10 * time.Second).Format(time.RFC3339Nano),
				"type":      "response_item",
				"payload": map[string]any{
					"type": "message", "id": "assistant-1", "role": "assistant",
					"content": []any{map[string]any{"type": "output_text", "text": "First answer"}},
				},
			},
			map[string]any{
				"timestamp": firstSettled.Format(time.RFC3339Nano),
				"type":      "event_msg",
				"payload":   map[string]any{"type": "task_complete", "turn_id": "turn-1"},
			},
			map[string]any{
				"timestamp": secondStart.Format(time.RFC3339Nano),
				"type":      "event_msg",
				"payload":   map[string]any{"type": "task_started", "turn_id": "turn-2"},
			},
			map[string]any{
				"timestamp": secondStart.Add(10 * time.Millisecond).Format(time.RFC3339Nano),
				"type":      "turn_context",
				"payload":   map[string]any{"turn_id": "turn-2"},
			},
			map[string]any{
				"timestamp": secondStart.Add(time.Second).Format(time.RFC3339Nano),
				"type":      "response_item",
				"payload": map[string]any{
					"type": "message", "id": "user-2", "role": "user",
					"content": []any{map[string]any{"type": "input_text", "text": "Second prompt"}},
				},
			},
			map[string]any{
				"timestamp": secondStart.Add(20 * time.Second).Format(time.RFC3339Nano),
				"type":      "response_item",
				"payload": map[string]any{
					"type": "message", "id": "assistant-2", "role": "assistant",
					"content": []any{map[string]any{"type": "output_text", "text": "Second answer"}},
				},
			},
			map[string]any{
				"timestamp": secondSettled.Format(time.RFC3339Nano),
				"type":      "event_msg",
				"payload":   map[string]any{"type": "task_complete", "turn_id": "turn-2"},
			},
			map[string]any{
				"timestamp": thirdStart.Format(time.RFC3339Nano),
				"type":      "event_msg",
				"payload":   map[string]any{"type": "task_started", "turn_id": "turn-3"},
			},
			map[string]any{
				"timestamp": thirdStart.Add(10 * time.Millisecond).Format(time.RFC3339Nano),
				"type":      "turn_context",
				"payload":   map[string]any{"turn_id": "turn-3"},
			},
			map[string]any{
				"timestamp": thirdStart.Add(time.Second).Format(time.RFC3339Nano),
				"type":      "response_item",
				"payload": map[string]any{
					"type": "message", "id": "user-3", "role": "user",
					"content": []any{map[string]any{"type": "input_text", "text": "Still running"}},
				},
			},
		)),
	)
	if err != nil || !ok {
		t.Fatalf("parseCodexJSONL ok=%v err=%v", ok, err)
	}
	if len(session.Turns) != 2 {
		t.Fatalf("turns = %#v, want two native turns", session.Turns)
	}
	if session.Turns[0].TurnID != "turn-1" || session.Turns[0].StartedAtUnixMS != firstStart.UnixMilli() || session.Turns[0].SettledAtUnixMS != firstSettled.UnixMilli() {
		t.Fatalf("first turn = %#v", session.Turns[0])
	}
	if session.Turns[1].TurnID != "turn-2" || session.Turns[1].StartedAtUnixMS != secondStart.UnixMilli() || session.Turns[1].SettledAtUnixMS != secondSettled.UnixMilli() {
		t.Fatalf("second turn = %#v", session.Turns[1])
	}
	wantTurnIDs := []string{"turn-1", "turn-1", "turn-2", "turn-2", ""}
	for index, message := range session.Messages {
		if message.TurnID != wantTurnIDs[index] {
			t.Fatalf("message %d turnId = %q, want %q", index, message.TurnID, wantTurnIDs[index])
		}
	}
}

func TestParseCodexJSONLPreservesUserAbortedTurnBoundary(t *testing.T) {
	cwd := t.TempDir()
	startedAt := time.Date(2026, time.July, 17, 10, 0, 0, 0, time.UTC)
	interruptedAt := startedAt.Add(83 * time.Second)
	session, ok, err := parseCodexJSONL(
		filepath.Join(cwd, "rollout.jsonl"),
		strings.NewReader(testAgentJSONL(t,
			map[string]any{
				"timestamp": startedAt.Add(-time.Second).Format(time.RFC3339Nano),
				"type":      "session_meta",
				"payload":   map[string]any{"id": "codex-interrupted", "cwd": cwd},
			},
			map[string]any{
				"timestamp": startedAt.Format(time.RFC3339Nano),
				"type":      "event_msg",
				"payload":   map[string]any{"type": "task_started", "turn_id": "turn-1"},
			},
			map[string]any{
				"timestamp": startedAt.Add(time.Millisecond).Format(time.RFC3339Nano),
				"type":      "turn_context",
				"payload":   map[string]any{"turn_id": "turn-1"},
			},
			map[string]any{
				"timestamp": startedAt.Add(time.Second).Format(time.RFC3339Nano),
				"type":      "response_item",
				"payload": map[string]any{
					"type": "message", "id": "user-1", "role": "user",
					"content": []any{map[string]any{"type": "input_text", "text": "Run the task"}},
				},
			},
			map[string]any{
				"timestamp": interruptedAt.Format(time.RFC3339Nano),
				"type":      "event_msg",
				"payload": map[string]any{
					"type": "turn_aborted", "turn_id": "turn-1", "reason": "interrupted",
				},
			},
		)),
	)
	if err != nil || !ok {
		t.Fatalf("parseCodexJSONL ok=%v err=%v", ok, err)
	}
	if len(session.Turns) != 1 {
		t.Fatalf("turns = %#v, want one interrupted turn", session.Turns)
	}
	turn := session.Turns[0]
	if turn.TurnID != "turn-1" || turn.Outcome != "canceled" {
		t.Fatalf("turn = %#v, want canceled turn-1", turn)
	}
	if turn.StartedAtUnixMS != startedAt.UnixMilli() || turn.SettledAtUnixMS != interruptedAt.UnixMilli() {
		t.Fatalf("turn timing = %d..%d, want %d..%d", turn.StartedAtUnixMS, turn.SettledAtUnixMS, startedAt.UnixMilli(), interruptedAt.UnixMilli())
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

func TestParseCodexJSONLHandlesCustomToolCallLifecycle(t *testing.T) {
	// Regression for real Codex desktop transcripts where MCP/custom tools
	// (e.g. apply_patch) are recorded as "custom_tool_call" /
	// "custom_tool_call_output" response items rather than the built-in
	// "function_call" / "function_call_output" pair. Before this was handled,
	// every custom-tool-call turn was silently dropped, and sessions
	// dominated by custom tool use (heavy apply_patch usage) could end up
	// with no visible assistant activity at all despite substantial real
	// content — reported as "会话显示为空(实际上有很多对话)".
	cwd := t.TempDir()
	session, ok, err := parseCodexJSONL(
		filepath.Join(cwd, "rollout.jsonl"),
		strings.NewReader(testAgentJSONL(t,
			map[string]any{
				"timestamp": "2026-06-18T00:00:00Z",
				"type":      "session_meta",
				"payload":   map[string]any{"id": "codex-custom-tool", "cwd": cwd},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:01Z",
				"type":      "response_item",
				"payload": map[string]any{
					"type":    "message",
					"role":    "user",
					"content": []any{map[string]any{"type": "input_text", "text": "Apply this patch"}},
				},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:02Z",
				"type":      "response_item",
				"payload": map[string]any{
					"type":    "custom_tool_call",
					"status":  "completed",
					"call_id": "call-patch-1",
					"name":    "apply_patch",
					"input":   "*** Begin Patch\n*** Add File: foo.go\n+package foo\n*** End Patch",
				},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:03Z",
				"type":      "response_item",
				"payload": map[string]any{
					"type":    "custom_tool_call_output",
					"call_id": "call-patch-1",
					"output":  `{"output":"Success. Updated the following files:\nA foo.go\n"}`,
				},
			},
		)),
	)
	if err != nil || !ok {
		t.Fatalf("parseCodexJSONL ok=%v err=%v", ok, err)
	}
	if len(session.Messages) != 3 {
		t.Fatalf("messages = %#v, want user prompt plus custom tool call lifecycle", session.Messages)
	}
	call := session.Messages[1]
	if call.Role != "assistant" || call.Kind != "tool_call" || call.Status != "completed" {
		t.Fatalf("custom tool call message = %#v", call)
	}
	if call.MessageIDSeed != "toolcall:call-patch-1" {
		t.Fatalf("custom tool call seed = %q, want call id seed", call.MessageIDSeed)
	}
	if call.Payload["toolName"] != "apply_patch" {
		t.Fatalf("custom tool call payload = %#v, want apply_patch tool name", call.Payload)
	}
	input, _ := call.Payload["input"].(map[string]any)
	if !strings.Contains(input["arguments"].(string), "Add File: foo.go") {
		t.Fatalf("custom tool call input = %#v, want raw patch text preserved", input)
	}
	output := session.Messages[2]
	if output.Role != "assistant" || output.Kind != "tool_call" || output.Status != "completed" {
		t.Fatalf("custom tool call output message = %#v", output)
	}
	if output.MessageIDSeed != call.MessageIDSeed {
		t.Fatalf("custom tool call output seed = %q, want %q", output.MessageIDSeed, call.MessageIDSeed)
	}
}

func TestParseCodexJSONLRetainsSessionWhenCwdDirectoryNoLongerExists(t *testing.T) {
	// Regression: previously any session whose recorded cwd doesn't currently
	// exist on disk (a deleted git worktree, a cleaned-up temp dir, a renamed
	// project) was silently dropped from scan results in full — undercounting
	// scanned sessions/projects, and making content-rich conversations that
	// happened to run in a since-deleted directory appear to vanish entirely.
	root := t.TempDir()
	deletedCwd := filepath.Join(root, "deleted-worktree")
	if err := os.MkdirAll(deletedCwd, 0o755); err != nil {
		t.Fatalf("create then delete cwd error = %v", err)
	}
	if canonical, ok := canonicalExistingDir(deletedCwd); ok {
		deletedCwd = canonical
	}
	if err := os.RemoveAll(deletedCwd); err != nil {
		t.Fatalf("remove cwd error = %v", err)
	}

	sourcePath := filepath.Join(root, "rollout.jsonl")
	session, ok, err := parseCodexJSONL(
		sourcePath,
		strings.NewReader(testAgentJSONL(t,
			map[string]any{
				"timestamp": "2026-06-18T00:00:00Z",
				"type":      "session_meta",
				"payload":   map[string]any{"id": "codex-deleted-cwd", "cwd": deletedCwd},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:01Z",
				"type":      "response_item",
				"payload": map[string]any{
					"type":    "message",
					"role":    "user",
					"content": []any{map[string]any{"type": "input_text", "text": "Still real content"}},
				},
			},
		)),
	)
	if err != nil {
		t.Fatalf("parseCodexJSONL error = %v", err)
	}
	if !ok {
		t.Fatal("parseCodexJSONL ok = false, want session retained despite missing cwd directory")
	}
	if session.Cwd != deletedCwd {
		t.Fatalf("session.Cwd = %q, want original deleted cwd %q preserved", session.Cwd, deletedCwd)
	}
	if len(session.Messages) != 1 || session.Messages[0].Text != "Still real content" {
		t.Fatalf("messages = %#v, want the real message retained", session.Messages)
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

func TestParseCodexJSONLMarksLegacyDateSlugScratchCwdAsNoProject(t *testing.T) {
	// Real Codex desktop scratch directories have used at least two shapes:
	// the newer "Documents/Codex/<date>/<slug>" (covered by the sibling test
	// above) and an older single-segment "Documents/Codex/<date>-<slug>"
	// layout (e.g. "Documents/Codex/2026-04-24-gh"). Both are Codex's own
	// auto-provisioned no-project workspace, never a folder the user chose;
	// failing to recognize the older shape let its machine-generated slug
	// leak through as a bogus, garbled-looking "project" label — the avjjvg
	// report ("显示的项目文件夹名称乱码,不是我本地对话时的文件夹名称").
	home := filepath.Join(t.TempDir(), "home")
	cwd := filepath.Join(home, "Documents", "Codex", "2026-04-24-gh")
	if err := os.MkdirAll(cwd, 0o755); err != nil {
		t.Fatalf("create legacy codex scratch cwd error = %v", err)
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
				"payload":   map[string]any{"id": "codex-legacy-scratch", "cwd": cwd},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:01Z",
				"type":      "response_item",
				"payload": map[string]any{
					"type":    "message",
					"role":    "user",
					"content": []any{map[string]any{"type": "input_text", "text": "Legacy scratch question"}},
				},
			},
		)),
	)
	if err != nil || !ok {
		t.Fatalf("parseCodexJSONL ok=%v err=%v", ok, err)
	}
	if !session.NoProject {
		t.Fatalf("NoProject = false for legacy Codex scratch cwd %q", session.Cwd)
	}

	projectPath, ok := externalSessionProjectPath(session)
	if !ok {
		t.Fatalf("externalSessionProjectPath ok = false for %#v", session)
	}
	if projectPath == cwd {
		t.Fatalf("project path = %q, want the no-project bucket, not the raw scratch slug directory", projectPath)
	}
	if base := filepath.Base(projectPath); base == "2026-04-24-gh" {
		t.Fatalf("project label = %q, want no leaked scratch slug", base)
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

func TestParseClaudeCodeJSONLCapturesLatestAssistantModel(t *testing.T) {
	cwd := t.TempDir()
	session, ok, err := parseClaudeCodeJSONL(
		filepath.Join(cwd, "claude.jsonl"),
		strings.NewReader(testAgentJSONL(t,
			map[string]any{
				"timestamp": "2026-06-18T00:00:00Z",
				"sessionId": "claude-model",
				"cwd":       cwd,
				"uuid":      "claude-1",
				"message":   map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "Hello"}}},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:01Z",
				"sessionId": "claude-model",
				"cwd":       cwd,
				"uuid":      "claude-2",
				"message": map[string]any{
					"role":    "assistant",
					"model":   "claude-sonnet-4-5",
					"content": []any{map[string]any{"type": "text", "text": "Hi there"}},
				},
			},
			// A later assistant turn switches models mid conversation; the
			// imported session should reflect the most recent one so
			// continuing the chat reuses the user's latest local setting.
			map[string]any{
				"timestamp": "2026-06-18T00:00:02Z",
				"sessionId": "claude-model",
				"cwd":       cwd,
				"uuid":      "claude-3",
				"message": map[string]any{
					"role":    "assistant",
					"model":   "claude-opus-4-8",
					"content": []any{map[string]any{"type": "text", "text": "Follow up"}},
				},
			},
		)),
	)
	if err != nil || !ok {
		t.Fatalf("parseClaudeCodeJSONL ok=%v err=%v", ok, err)
	}
	if session.Model != "claude-opus-4-8" {
		t.Fatalf("model = %q, want latest assistant message model", session.Model)
	}
}

func TestParseClaudeCodeJSONLSkipsIsMetaInjectedFileContent(t *testing.T) {
	// Regression: Claude Code marks injected non-conversation content — Skill
	// tool file dumps, Stop-hook feedback, local-command caveats, etc. — with
	// isMeta:true. This wasn't checked, so e.g. a whole loaded skill file's
	// contents (or CLAUDE.md-shaped instructions) could surface as if the
	// user had typed them, which is the "会话详情会先显示...文件内容" report
	// (imported session detail showing injected file contents up front).
	cwd := t.TempDir()
	session, ok, err := parseClaudeCodeJSONL(
		filepath.Join(cwd, "claude.jsonl"),
		strings.NewReader(testAgentJSONL(t,
			map[string]any{
				"timestamp": "2026-06-18T00:00:00Z",
				"sessionId": "claude-meta",
				"cwd":       cwd,
				"uuid":      "claude-meta-skill",
				"isMeta":    true,
				"message": map[string]any{
					"role": "user",
					"content": []any{map[string]any{
						"type": "text",
						"text": "Base directory for this skill: /Users/asdf/.claude/plugins/cache/skills/brainstorming\n\n# Brainstorming Ideas\n...",
					}},
				},
			},
			map[string]any{
				"timestamp": "2026-06-18T00:00:01Z",
				"sessionId": "claude-meta",
				"cwd":       cwd,
				"uuid":      "claude-meta-real",
				"message": map[string]any{
					"role":    "user",
					"content": []any{map[string]any{"type": "text", "text": "What should I build next?"}},
				},
			},
		)),
	)
	if err != nil || !ok {
		t.Fatalf("parseClaudeCodeJSONL ok=%v err=%v", ok, err)
	}
	if len(session.Messages) != 1 {
		t.Fatalf("messages = %#v, want only the real (non-meta) message", session.Messages)
	}
	if session.Messages[0].Text != "What should I build next?" {
		t.Fatalf("message text = %q, want the real user prompt, not injected skill content", session.Messages[0].Text)
	}
	if session.Title != "What should I build next?" {
		t.Fatalf("title = %q, want derived from the real user prompt", session.Title)
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
