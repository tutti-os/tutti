package storesqlite

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/store-sqlite/canonical"
)

func TestToolPayloadBudgetMigrationCompactsOversizedMCPMessages(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.ReportSessionState(ctx, SessionStateReport{
		WorkspaceID: "ws-mcp-budget", AgentSessionID: "session-mcp-budget",
		Provider: "codex", OccurredAtUnixMS: 10,
	}); err != nil {
		t.Fatal(err)
	}

	large := strings.Repeat("node-repl-output-", 1<<16)
	fixtures := []struct {
		messageID string
		payload   map[string]any
	}{
		{
			messageID: "mcp-duplicate",
			payload: map[string]any{
				"toolName": "node_repl.js",
				"input":    map[string]any{"code": "return value"},
				"output": map[string]any{
					"text": large,
					"structuredContent": map[string]any{
						"result": large,
						"meta":   map[string]any{"necessary": true},
					},
				},
			},
		},
		{
			messageID: "required-input-too-large",
			payload: map[string]any{
				"toolName": "node_repl.js",
				"input":    map[string]any{"code": strings.Repeat("x", canonical.ToolCallPayloadMaxBytes)},
				"output":   map[string]any{"structuredContent": map[string]any{"necessary": true}},
			},
		},
	}
	original := make(map[string]string, len(fixtures))
	for index, fixture := range fixtures {
		encoded, err := json.Marshal(fixture.payload)
		if err != nil {
			t.Fatal(err)
		}
		original[fixture.messageID] = string(encoded)
		if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, role, kind, status,
  payload_json, occurred_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-mcp-budget', 'session-mcp-budget', ?, ?, 'assistant', 'tool_call',
          'completed', ?, 20, 20, 20)
`, fixture.messageID, index+1, string(encoded)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.db.ExecContext(ctx, `DELETE FROM agent_store_schema_migrations WHERE id=?`, schemaMigrationWorkspaceAgentToolPayloadBudgetV1); err != nil {
		t.Fatal(err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}

	var compacted string
	if err := store.db.QueryRowContext(ctx, `SELECT payload_json FROM workspace_agent_messages WHERE message_id='mcp-duplicate'`).Scan(&compacted); err != nil {
		t.Fatal(err)
	}
	if len(compacted) > canonical.ToolCallPayloadMaxBytes || compacted == original["mcp-duplicate"] {
		t.Fatalf("compacted bytes=%d changed=%t", len(compacted), compacted != original["mcp-duplicate"])
	}
	if !strings.Contains(compacted, canonical.ToolStructuredContentDuplicateTextMarker) ||
		!strings.Contains(compacted, canonical.ToolOutputTruncationMarker) {
		t.Fatalf("compacted MCP payload lacks canonical markers: %s", compacted[:256])
	}
	var unchanged string
	if err := store.db.QueryRowContext(ctx, `SELECT payload_json FROM workspace_agent_messages WHERE message_id='required-input-too-large'`).Scan(&unchanged); err != nil {
		t.Fatal(err)
	}
	if unchanged != original["required-input-too-large"] {
		t.Fatal("migration updated a row that could not satisfy the budget")
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatal(err)
	}
	var repeated string
	if err := store.db.QueryRowContext(ctx, `SELECT payload_json FROM workspace_agent_messages WHERE message_id='mcp-duplicate'`).Scan(&repeated); err != nil {
		t.Fatal(err)
	}
	if repeated != compacted {
		t.Fatal("idempotent migration changed compacted payload")
	}
}
