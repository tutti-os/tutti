package storesqlite

import (
	"context"
	"testing"
)

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
  created_at_unix_ms, updated_at_unix_ms
)
VALUES (
  'ws-initial-title', 'session-initial-title', 'message-1', 1, 'user', 'text',
  '{"text":"[@file](file:///tmp/a_(final).md) inspect repo"}', ?, ?
)
`, createdAtUnixMS, updatedAtUnixMS); err != nil {
		t.Fatalf("insert first user message: %v", err)
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
