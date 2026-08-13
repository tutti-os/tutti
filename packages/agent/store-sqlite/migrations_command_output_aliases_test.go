package storesqlite

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func TestCommandOutputAliasMigrationCompactsOnlyOversizedTerminalCommands(
	t *testing.T,
) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID:      "ws-command-alias",
		AgentSessionID:   "session-command-alias",
		Provider:         "codex",
		OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}

	large := strings.Repeat("x", canonical.ToolOutputTextMaxBytes/2+256)
	nearWireLimit := strings.Repeat(
		"n",
		canonical.ToolCallPayloadMaxBytes/2+2048,
	)
	legacyRaw := "  " + strings.Repeat(
		"p",
		canonical.ToolOutputTextMaxBytes+64,
	) + "\n"
	legacyText := canonical.TruncateToolOutputText(strings.TrimSpace(legacyRaw))
	legacyStdout := canonical.TruncateToolOutputText(legacyRaw)
	if legacyText == strings.TrimSpace(legacyStdout) {
		t.Fatal("legacy independently truncated fixture still compares as alias")
	}
	tests := []struct {
		messageID    string
		status       string
		payload      map[string]any
		wantText     bool
		wantBudgeted bool
	}{
		{
			messageID: "oversized-terminal-alias",
			status:    "completed",
			payload: map[string]any{
				"toolName": "Bash",
				"input":    map[string]any{"command": "print output"},
				"output":   map[string]any{"text": large, "stdout": large + "\n"},
				"seq":      json.Number("9007199254740993"),
			},
			wantText:     false,
			wantBudgeted: true,
		},
		{
			messageID: "below-wire-limit-terminal-alias",
			status:    "completed",
			payload: map[string]any{
				"toolName": "Bash",
				"input":    map[string]any{"command": "print output"},
				"output": map[string]any{
					"text":   nearWireLimit,
					"stdout": nearWireLimit + "\n",
				},
			},
			wantText:     false,
			wantBudgeted: true,
		},
		{
			messageID: "independently-truncated-terminal-output",
			status:    "completed",
			payload: map[string]any{
				"toolName": "Bash",
				"input":    map[string]any{"command": "print output"},
				"output": map[string]any{
					"text":   legacyText,
					"stdout": legacyStdout,
				},
			},
			wantText:     true,
			wantBudgeted: true,
		},
		{
			messageID: "small-terminal-alias",
			status:    "completed",
			payload: map[string]any{
				"toolName": "Bash",
				"input":    map[string]any{"command": "print output"},
				"output":   map[string]any{"text": "small", "stdout": "small\n"},
			},
			wantText: true,
		},
		{
			messageID: "oversized-non-command",
			status:    "completed",
			payload: map[string]any{
				"toolName": "Edit",
				"input":    map[string]any{"command": "domain command"},
				"output":   map[string]any{"text": large, "stdout": large + "\n"},
			},
			wantText: true,
		},
		{
			messageID: "oversized-running-command",
			status:    "running",
			payload: map[string]any{
				"toolName": "exec_command",
				"input":    map[string]any{"cmd": "print output"},
				"output":   map[string]any{"text": large, "stdout": large + "\n"},
			},
			wantText: true,
		},
		{
			messageID: "oversized-distinct-command-text",
			status:    "completed",
			payload: map[string]any{
				"toolName": "Bash",
				"input":    map[string]any{"command": "print output"},
				"output": map[string]any{
					"text":   strings.Repeat("y", len(large)),
					"stdout": large + "\n",
				},
			},
			wantText:     true,
			wantBudgeted: true,
		},
		{
			messageID: "running-task-recursive-terminal-step",
			status:    "running",
			payload: map[string]any{
				"toolName": "Task",
				"output":   map[string]any{"text": "task running"},
				"steps": []any{map[string]any{
					"toolName": "Task",
					"status":   "running",
					"toolResult": map[string]any{
						"steps": []any{map[string]any{
							"toolName": "Bash",
							"status":   "completed",
							"toolInput": map[string]any{
								"command": "print nested output",
							},
							"toolResult": map[string]any{
								"text":   large,
								"stdout": large + "\n",
							},
						}},
					},
				}},
			},
			wantText:     true,
			wantBudgeted: true,
		},
	}

	for index, test := range tests {
		payloadJSON, err := json.Marshal(test.payload)
		if err != nil {
			t.Fatalf("marshal %s payload: %v", test.messageID, err)
		}
		if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, role, kind, status,
  payload_json, occurred_at_unix_ms, started_at_unix_ms, completed_at_unix_ms,
  created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, 'assistant', 'tool_call', ?, ?, 101, 102, 103, 104, 105)
`, "ws-command-alias", "session-command-alias", test.messageID, index+1,
			test.status, string(payloadJSON)); err != nil {
			t.Fatalf("insert %s: %v", test.messageID, err)
		}
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions
SET deleted_at_unix_ms = 99
WHERE workspace_id = ? AND agent_session_id = ?
`, "ws-command-alias", "session-command-alias"); err != nil {
		t.Fatalf("mark fixture session deleted: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_messages
SET deleted_at_unix_ms = 99
WHERE workspace_id = ? AND agent_session_id = ? AND message_id = ?
`, "ws-command-alias", "session-command-alias", "oversized-terminal-alias"); err != nil {
		t.Fatalf("mark fixture message deleted: %v", err)
	}

	if _, err := store.db.ExecContext(ctx, `
DELETE FROM agent_store_schema_migrations WHERE id = ?
`, schemaMigrationWorkspaceAgentCommandOutputAliasesV1); err != nil {
		t.Fatalf("reset command output alias migration marker: %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("rerun command output alias migration: %v", err)
	}

	for index, test := range tests {
		var (
			payloadJSON                        string
			version                            int
			occurredAt, startedAt, completedAt int64
			createdAt, updatedAt               int64
		)
		if err := store.db.QueryRowContext(ctx, `
SELECT payload_json, version, occurred_at_unix_ms, started_at_unix_ms,
       completed_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_messages
WHERE workspace_id = ? AND agent_session_id = ? AND message_id = ?
`, "ws-command-alias", "session-command-alias", test.messageID).Scan(
			&payloadJSON,
			&version,
			&occurredAt,
			&startedAt,
			&completedAt,
			&createdAt,
			&updatedAt,
		); err != nil {
			t.Fatalf("read %s: %v", test.messageID, err)
		}
		var payload map[string]any
		if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
			t.Fatalf("decode %s: %v", test.messageID, err)
		}
		output := payload["output"].(map[string]any)
		_, hasText := output["text"]
		if hasText != test.wantText {
			t.Fatalf("%s output = %#v, want text present %t", test.messageID, output, test.wantText)
		}
		if test.wantBudgeted && len(payloadJSON) > canonical.ToolCallPayloadMaxBytes {
			t.Fatalf(
				"%s payload has %d bytes, safe budget is %d",
				test.messageID,
				len(payloadJSON),
				canonical.ToolCallPayloadMaxBytes,
			)
		}
		if test.messageID == "oversized-terminal-alias" &&
			!strings.Contains(payloadJSON, `"seq":9007199254740993`) {
			t.Fatalf("%s lost exact JSON integer: %s", test.messageID, payloadJSON[:128])
		}
		if test.messageID == "oversized-terminal-alias" && output["stdout"] != large+"\n" {
			t.Fatal("oversized terminal alias migration changed raw stdout")
		}
		if test.messageID == "independently-truncated-terminal-output" {
			for _, key := range []string{"text", "stdout"} {
				value := output[key].(string)
				if !strings.HasSuffix(value, canonical.ToolOutputTruncationMarker) {
					t.Fatalf("legacy output.%s lost truncation marker", key)
				}
			}
		}
		if test.messageID == "running-task-recursive-terminal-step" {
			steps := payload["steps"].([]any)
			nested := steps[0].(map[string]any)["toolResult"].(map[string]any)["steps"].([]any)[0].(map[string]any)["toolResult"].(map[string]any)
			if _, exists := nested["text"]; exists {
				t.Fatalf("recursive completed step retained text alias: %#v", nested)
			}
		}
		if version != index+1 || occurredAt != 101 || startedAt != 102 ||
			completedAt != 103 || createdAt != 104 || updatedAt != 105 {
			t.Fatalf(
				"%s metadata changed: version=%d times=%d/%d/%d/%d/%d",
				test.messageID,
				version,
				occurredAt,
				startedAt,
				completedAt,
				createdAt,
				updatedAt,
			)
		}
	}

	var compactedJSON string
	if err := store.db.QueryRowContext(ctx, `
SELECT payload_json FROM workspace_agent_messages WHERE message_id = ?
`, "oversized-terminal-alias").Scan(&compactedJSON); err != nil {
		t.Fatalf("read compacted payload: %v", err)
	}
	if len(compactedJSON) > canonical.ToolCallPayloadMaxBytes {
		t.Fatalf("compacted payload has %d bytes, want at most %d", len(compactedJSON), canonical.ToolCallPayloadMaxBytes)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("repeat command output alias migration: %v", err)
	}
	var repeatedJSON string
	if err := store.db.QueryRowContext(ctx, `
SELECT payload_json FROM workspace_agent_messages WHERE message_id = ?
`, "oversized-terminal-alias").Scan(&repeatedJSON); err != nil {
		t.Fatalf("read repeated payload: %v", err)
	}
	if repeatedJSON != compactedJSON {
		t.Fatal("repeated migration changed the compacted payload")
	}
}
