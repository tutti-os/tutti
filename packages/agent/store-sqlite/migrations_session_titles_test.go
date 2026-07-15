package storesqlite

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
)

func TestWorkspaceAgentMessageVisibleTextPrefersStructuredTextContent(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"text": "unsafe top-level fallback",
		"content": []any{
			map[string]any{"type": "image", "text": "unsafe image text"},
			map[string]any{"type": "text", "text": "visible text"},
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	if got := workspaceAgentMessageVisibleText(string(payload)); got != "visible text" {
		t.Fatalf("workspaceAgentMessageVisibleText() = %q, want structured text", got)
	}
}

func TestWorkspaceAgentMessageVisibleTextDoesNotFallbackPastStructuredContent(t *testing.T) {
	payload, err := json.Marshal(map[string]any{
		"text": "unsafe top-level fallback",
		"content": []any{
			map[string]any{"type": "image", "text": "unsafe image text"},
		},
	})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	if got := workspaceAgentMessageVisibleText(string(payload)); got != "" {
		t.Fatalf("workspaceAgentMessageVisibleText() = %q, want empty", got)
	}
}

func TestWorkspaceAgentMessageVisibleTextUsesLegacyTextWithoutStructuredContent(t *testing.T) {
	payload, err := json.Marshal(map[string]any{"text": "legacy visible text"})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	if got := workspaceAgentMessageVisibleText(string(payload)); got != "legacy visible text" {
		t.Fatalf("workspaceAgentMessageVisibleText() = %q, want legacy text", got)
	}
}

func TestSessionTitleMigrationCanonicalizesExistingRows(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	const createdAtUnixMS int64 = 123456789
	const updatedAtUnixMS int64 = 987654321
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_sessions (workspace_id, agent_session_id, title, created_at_unix_ms, updated_at_unix_ms)
VALUES ('ws-title', 'session-title', '[@file](file:///tmp/a_(final).md)', ?, ?)
`, createdAtUnixMS, updatedAtUnixMS); err != nil {
		t.Fatalf("insert legacy title: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `DELETE FROM agent_store_schema_migrations WHERE id = ?`, schemaMigrationWorkspaceAgentSessionTitlesV1); err != nil {
		t.Fatalf("reset title migration marker: %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("rerun title migration: %v", err)
	}
	var (
		title             string
		migratedCreatedAt int64
		migratedUpdatedAt int64
	)
	if err := store.db.QueryRowContext(ctx, `
SELECT title, created_at_unix_ms, updated_at_unix_ms FROM workspace_agent_sessions
WHERE workspace_id = 'ws-title' AND agent_session_id = 'session-title'
`).Scan(&title, &migratedCreatedAt, &migratedUpdatedAt); err != nil {
		t.Fatalf("read canonicalized title: %v", err)
	}
	if title != "@file" {
		t.Fatalf("migrated title = %q, want @file", title)
	}
	if migratedCreatedAt != createdAtUnixMS {
		t.Fatalf("migrated created_at_unix_ms = %d, want %d", migratedCreatedAt, createdAtUnixMS)
	}
	if migratedUpdatedAt != updatedAtUnixMS {
		t.Fatalf("migrated updated_at_unix_ms = %d, want %d", migratedUpdatedAt, updatedAtUnixMS)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("repeat title migration: %v", err)
	}
	if err := store.db.QueryRowContext(ctx, `
SELECT title, created_at_unix_ms, updated_at_unix_ms FROM workspace_agent_sessions
WHERE workspace_id = 'ws-title' AND agent_session_id = 'session-title'
`).Scan(&title, &migratedCreatedAt, &migratedUpdatedAt); err != nil {
		t.Fatalf("read title after repeated migration: %v", err)
	}
	if title != "@file" || migratedCreatedAt != createdAtUnixMS || migratedUpdatedAt != updatedAtUnixMS {
		t.Fatalf(
			"row after repeated migration = title %q, created %d, updated %d; want @file, %d, %d",
			title,
			migratedCreatedAt,
			migratedUpdatedAt,
			createdAtUnixMS,
			updatedAtUnixMS,
		)
	}
}

func TestSessionTitleMigrationBackfillsFirstUserPrompt(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	const createdAtUnixMS int64 = 123456789
	const updatedAtUnixMS int64 = 987654321
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_sessions (
  workspace_id, agent_session_id, provider, title, created_at_unix_ms, updated_at_unix_ms
)
VALUES ('ws-initial-title', 'session-initial-title', 'codex', 'Codex', ?, ?)
`, createdAtUnixMS, updatedAtUnixMS); err != nil {
		t.Fatalf("insert session without conversation title: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, role, kind, payload_json,
  occurred_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
)
VALUES (
  'ws-initial-title', 'session-initial-title', 'message-1', 3, 'user', 'text',
  '{"content":[{"type":"text","text":"[@file](file:///tmp/a_(final).md) inspect repo"}]}',
  100, ?, ?
)
`, createdAtUnixMS, updatedAtUnixMS); err != nil {
		t.Fatalf("insert first user message: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, role, kind, payload_json,
  occurred_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
)
VALUES (
  'ws-initial-title', 'session-initial-title', 'message-2', 2, 'user', 'text',
  '{"text":"later prompt"}', 200, ?, ?
)
`, createdAtUnixMS+1, updatedAtUnixMS+1); err != nil {
		t.Fatalf("insert later user message: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `DELETE FROM agent_store_schema_migrations WHERE id = ?`, schemaMigrationWorkspaceAgentSessionTitlesV2); err != nil {
		t.Fatalf("reset initial title migration marker: %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("rerun initial title migration: %v", err)
	}

	var (
		title             string
		migratedCreatedAt int64
		migratedUpdatedAt int64
	)
	if err := store.db.QueryRowContext(ctx, `
SELECT title, created_at_unix_ms, updated_at_unix_ms FROM workspace_agent_sessions
WHERE workspace_id = 'ws-initial-title' AND agent_session_id = 'session-initial-title'
`).Scan(&title, &migratedCreatedAt, &migratedUpdatedAt); err != nil {
		t.Fatalf("read backfilled title: %v", err)
	}
	if title != "@file inspect repo" {
		t.Fatalf("backfilled title = %q, want @file inspect repo", title)
	}
	if migratedCreatedAt != createdAtUnixMS || migratedUpdatedAt != updatedAtUnixMS {
		t.Fatalf(
			"backfilled timestamps = created %d, updated %d; want %d, %d",
			migratedCreatedAt,
			migratedUpdatedAt,
			createdAtUnixMS,
			updatedAtUnixMS,
		)
	}
}

func TestSessionTitleMigrationClearsLegacyTargetTitleWithoutMessages(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO agent_targets (
  id, provider, launch_ref_json, name, enabled, source, created_at_ms, updated_at_ms
)
VALUES (
  'extension:codebuddy', 'acp:codebuddy',
  '{"type":"agent_extension","provider":"acp:codebuddy"}',
  'CodeBuddy', 1, 'extension', 1, 1
);
INSERT INTO workspace_agent_sessions (
  workspace_id, agent_session_id, agent_target_id, provider, title,
  created_at_unix_ms, updated_at_unix_ms
)
VALUES (
  'ws-legacy-empty', 'session-legacy-empty', 'extension:codebuddy',
  'acp:codebuddy', 'CodeBuddy', 10, 20
);
`); err != nil {
		t.Fatalf("insert legacy target-title session: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `DELETE FROM agent_store_schema_migrations WHERE id = ?`, schemaMigrationWorkspaceAgentSessionTitlesV2); err != nil {
		t.Fatalf("reset initial title migration marker: %v", err)
	}
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("rerun initial title migration: %v", err)
	}

	var (
		title             string
		migratedCreatedAt int64
		migratedUpdatedAt int64
	)
	if err := store.db.QueryRowContext(ctx, `
SELECT title, created_at_unix_ms, updated_at_unix_ms
FROM workspace_agent_sessions
WHERE workspace_id = 'ws-legacy-empty'
  AND agent_session_id = 'session-legacy-empty'
`).Scan(&title, &migratedCreatedAt, &migratedUpdatedAt); err != nil {
		t.Fatalf("read migrated legacy target-title session: %v", err)
	}
	if title != "" {
		t.Fatalf("migrated title = %q, want empty canonical title", title)
	}
	if migratedCreatedAt != 10 || migratedUpdatedAt != 20 {
		t.Fatalf(
			"migrated timestamps = created %d, updated %d; want 10, 20",
			migratedCreatedAt,
			migratedUpdatedAt,
		)
	}
}

func BenchmarkSessionTitleMigrationBackfillsLargeHistory(b *testing.B) {
	store := openTestStore(b, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	const (
		sessionCount         = 100
		messagesPerSession   = 100
		workspaceID          = "ws-title-benchmark"
		migrationCreatedAtMS = 1000
		migrationUpdatedAtMS = 2000
	)
	tx, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		b.Fatalf("begin benchmark seed: %v", err)
	}
	for sessionIndex := range sessionCount {
		sessionID := fmt.Sprintf("session-%04d", sessionIndex)
		if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_sessions (
  workspace_id, agent_session_id, agent_target_id, provider, title,
  created_at_unix_ms, updated_at_unix_ms
)
VALUES (?, ?, ?, 'codex', 'Codex', ?, ?)
`, workspaceID, sessionID, testTargetIDCodex, migrationCreatedAtMS, migrationUpdatedAtMS); err != nil {
			_ = tx.Rollback()
			b.Fatalf("insert benchmark session: %v", err)
		}
		for messageIndex := range messagesPerSession {
			messageID := fmt.Sprintf("message-%04d", messageIndex)
			payload := fmt.Sprintf(`{"text":"prompt %04d"}`, messageIndex)
			if _, err := tx.ExecContext(ctx, `
INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, role, kind,
  payload_json, occurred_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
)
VALUES (?, ?, ?, 1, 'user', 'text', ?, ?, ?, ?)
`, workspaceID, sessionID, messageID, payload, messageIndex+1, migrationCreatedAtMS, migrationUpdatedAtMS); err != nil {
				_ = tx.Rollback()
				b.Fatalf("insert benchmark message: %v", err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		b.Fatalf("commit benchmark seed: %v", err)
	}

	b.ReportAllocs()
	b.ResetTimer()
	for range b.N {
		b.StopTimer()
		if _, err := store.db.ExecContext(ctx, `
UPDATE workspace_agent_sessions SET title = 'Codex' WHERE workspace_id = ?
`, workspaceID); err != nil {
			b.Fatalf("reset benchmark titles: %v", err)
		}
		if _, err := store.db.ExecContext(ctx, `
DELETE FROM agent_store_schema_migrations WHERE id = ?
`, schemaMigrationWorkspaceAgentSessionTitlesV2); err != nil {
			b.Fatalf("reset benchmark migration: %v", err)
		}
		b.StartTimer()
		if err := store.applyWorkspaceAgentSessionTitlesV2(ctx); err != nil {
			b.Fatalf("run benchmark migration: %v", err)
		}
	}
}
