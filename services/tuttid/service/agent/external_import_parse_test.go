package agent

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
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
