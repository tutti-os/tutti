package storesqlite

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"testing"
)

func mkdirAll(path string) error {
	return os.MkdirAll(path, 0o755)
}

// createLegacyTuttidDatabase replays the schema a fully migrated tuttid
// database had before the store was extracted: shared tuttid ledger, host
// workspaces table, agent tables with the workspaces foreign key, and
// applied records for every agent migration.
func createLegacyTuttidDatabase(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`
CREATE TABLE tuttid_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES
  ('workspaces_v1', 11),
  ('workspaces_v2', 12),
  ('workspace_agent_activity_v1', 21),
  ('workspace_agent_activity_v2', 22),
  ('workspace_agent_activity_v3', 23),
  ('workspace_agent_activity_v4', 24),
  ('workspace_agent_activity_v5', 25),
  ('agent_targets_v1', 26),
  ('workspace_agent_activity_rail_v1', 27);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL
);
INSERT INTO workspaces (id, name, created_at_unix_ms, updated_at_unix_ms)
VALUES ('ws-legacy', 'Legacy Workspace', 1, 1);

CREATE TABLE workspace_agent_sessions (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT '',
  agent_target_id TEXT,
  provider TEXT NOT NULL DEFAULT '',
  provider_session_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  settings_json TEXT NOT NULL DEFAULT '{}',
  runtime_context_json TEXT NOT NULL DEFAULT '{}',
  cwd TEXT NOT NULL DEFAULT '',
  rail_section_kind TEXT NOT NULL DEFAULT 'conversations',
  rail_project_path TEXT NOT NULL DEFAULT '',
  rail_section_key TEXT NOT NULL DEFAULT 'conversations',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  current_phase TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  message_version INTEGER NOT NULL DEFAULT 0,
  last_event_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  ended_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  pinned_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  deleted_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);
INSERT INTO workspace_agent_sessions (
  workspace_id, agent_session_id, origin, agent_target_id, provider, title, status, runtime_context_json,
  created_at_unix_ms, updated_at_unix_ms
) VALUES
  ('ws-legacy', 'session-with-target', 'runtime', 'local:codex', 'codex', 'Old Session', 'completed',
   '{"visible":false,"imported":true,"capabilities":["planMode","planMode","unknown","modelImageInputRequired"],"backgroundAgents":{"count":99,"items":[{"taskId":"task-1","description":"done","status":"cancelled"}]},"goal":{"objective":"ship","status":"usageLimited"},"providerConfig":{"threadId":"thread-1"}}', 1, 2),
  ('ws-legacy', 'session-untargeted', 'runtime', '', 'codex', 'Untargeted Session', 'completed', '{}', 1, 1);

CREATE TABLE workspace_agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  turn_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  completed_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  deleted_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  UNIQUE (workspace_id, agent_session_id, message_id),
  FOREIGN KEY (workspace_id, agent_session_id)
    REFERENCES workspace_agent_sessions(workspace_id, agent_session_id)
    ON DELETE CASCADE
);
INSERT INTO workspace_agent_messages (
  workspace_id, agent_session_id, message_id, version, role, kind, status,
  payload_json, created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-legacy', 'session-with-target', 'message-1', 1, 'assistant', 'text', 'completed', '{"text":"legacy"}', 1, 1);

CREATE TABLE agent_targets (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  launch_ref_json TEXT NOT NULL,
  name TEXT NOT NULL,
  icon_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
INSERT INTO agent_targets (id, provider, launch_ref_json, name, icon_key, enabled, source, sort_order, created_at_ms, updated_at_ms)
VALUES ('local:codex', 'codex', '{"type":"local_cli","provider":"codex"}', 'Codex', 'codex', 1, 'system', 10, 1, 1);
`); err != nil {
		t.Fatalf("create legacy tuttid database: %v", err)
	}
}

func TestStoreMigrateClaimsLegacyTuttidMigrationsWithoutReplay(t *testing.T) {
	t.Parallel()

	db := openTestDB(t)
	createLegacyTuttidDatabase(t, db)
	store := New(db, testOptions(&staticProjectPaths{}))
	ctx := context.Background()

	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}
	var metadataJSON, internalJSON string
	if err := db.QueryRowContext(ctx, `
SELECT session_metadata_json, internal_runtime_context_json
FROM workspace_agent_sessions
WHERE workspace_id = 'ws-legacy' AND agent_session_id = 'session-with-target'
`).Scan(&metadataJSON, &internalJSON); err != nil {
		t.Fatalf("read migrated session metadata: %v", err)
	}
	metadata, err := unmarshalJSONMap(metadataJSON)
	if err != nil || metadata["visible"] != false || metadata["imported"] != true ||
		payloadString(metadata, "backgroundAgents") != "" {
		t.Fatalf("metadata=%#v err=%v", metadata, err)
	}
	capabilities, _ := metadata["capabilities"].([]any)
	background, _ := metadata["backgroundAgents"].(map[string]any)
	items, _ := background["items"].([]any)
	item, _ := items[0].(map[string]any)
	goal, _ := metadata["goal"].(map[string]any)
	if len(capabilities) != 2 || background["count"] != float64(0) || item["status"] != "canceled" || goal["status"] != "usageLimited" {
		t.Fatalf("normalized metadata=%#v", metadata)
	}
	internal, err := unmarshalJSONMap(internalJSON)
	providerConfig, _ := internal["providerConfig"].(map[string]any)
	if err != nil || providerConfig["threadId"] != "thread-1" || internal["visible"] != nil || internal["goal"] != nil {
		t.Fatalf("internal context=%#v err=%v", internal, err)
	}
	for _, removedColumn := range []string{"status", "current_phase", "last_error", "runtime_context_json"} {
		hasColumn, err := store.hasColumn(ctx, "workspace_agent_sessions", removedColumn)
		if err != nil || hasColumn {
			t.Fatalf("removed column %s present=%v err=%v", removedColumn, hasColumn, err)
		}
	}

	// Every legacy record is claimed into the package ledger with its
	// original timestamp, plus the claim marker itself.
	for migrationID, wantAppliedAt := range map[string]int64{
		"workspace_agent_activity_v1":      21,
		"workspace_agent_activity_v2":      22,
		"workspace_agent_activity_v3":      23,
		"workspace_agent_activity_v4":      24,
		"workspace_agent_activity_v5":      25,
		"agent_targets_v1":                 26,
		"workspace_agent_activity_rail_v1": 27,
	} {
		var appliedAt int64
		if err := db.QueryRowContext(ctx, `
SELECT applied_at_unix_ms FROM agent_store_schema_migrations WHERE id = ?
`, migrationID).Scan(&appliedAt); err != nil {
			t.Fatalf("claimed migration %s missing: %v", migrationID, err)
		}
		if appliedAt != wantAppliedAt {
			t.Fatalf("claimed migration %s applied_at = %d, want %d (copied from legacy ledger)", migrationID, appliedAt, wantAppliedAt)
		}
	}
	claimed, err := store.hasMigration(ctx, schemaMigrationLegacyClaimV1)
	if err != nil || !claimed {
		t.Fatalf("claim marker present = %v error = %v, want recorded", claimed, err)
	}

	// Host-only ledger entries are not claimed; the legacy ledger is left
	// untouched.
	if got, err := store.hasMigration(ctx, "workspaces_v1"); err != nil || got {
		t.Fatalf("workspaces_v1 claimed = %v error = %v, want host record left out", got, err)
	}
	var legacyCount int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM tuttid_schema_migrations`).Scan(&legacyCount); err != nil {
		t.Fatalf("count legacy ledger: %v", err)
	}
	if legacyCount != 9 {
		t.Fatalf("legacy ledger rows = %d, want 9 untouched rows", legacyCount)
	}

	// The v5 backfill was claimed, not replayed: the untargeted codex
	// session keeps its empty agent_target_id.
	var untargeted sql.NullString
	if err := db.QueryRowContext(ctx, `
SELECT agent_target_id FROM workspace_agent_sessions
WHERE workspace_id = 'ws-legacy' AND agent_session_id = 'session-untargeted'
`).Scan(&untargeted); err != nil {
		t.Fatalf("read untargeted session: %v", err)
	}
	if untargeted.String != "" {
		t.Fatalf("untargeted session agent_target_id = %q, want empty (v5 must not replay)", untargeted.String)
	}

	// Legacy rows stay readable through the store.
	sessions, ok, err := store.ListSessions(ctx, "ws-legacy")
	if err != nil || !ok {
		t.Fatalf("ListSessions() ok=%v error=%v", ok, err)
	}
	if len(sessions) != 2 {
		t.Fatalf("ListSessions() len = %d, want 2 legacy sessions", len(sessions))
	}
	page, ok, err := store.ListSessionMessages(ctx, ListSessionMessagesInput{
		WorkspaceID:    "ws-legacy",
		AgentSessionID: "session-with-target",
		Limit:          10,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionMessages() ok=%v error=%v", ok, err)
	}
	if len(page.Messages) != 1 || page.Messages[0].Payload["text"] != "legacy" {
		t.Fatalf("legacy message page = %#v", page)
	}

	// The final entity migration deliberately normalizes legacy sessions onto
	// the package-owned schema: host workspaces are not an agent-store parent,
	// while active_turn_id is an exact nullable turn reference.
	rows, err := db.QueryContext(ctx, `PRAGMA foreign_key_list(workspace_agent_sessions)`)
	if err != nil {
		t.Fatalf("foreign_key_list error = %v", err)
	}
	defer rows.Close()
	hasWorkspacesFK := false
	hasTurnsFK := false
	for rows.Next() {
		var (
			id, seq                                    int
			table, from, to, onUpdate, onDelete, match string
		)
		if err := rows.Scan(&id, &seq, &table, &from, &to, &onUpdate, &onDelete, &match); err != nil {
			t.Fatalf("scan foreign_key_list: %v", err)
		}
		if table == "workspaces" {
			hasWorkspacesFK = true
		}
		if table == "workspace_agent_turns" {
			hasTurnsFK = true
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate foreign_key_list: %v", err)
	}
	if hasWorkspacesFK || !hasTurnsFK {
		t.Fatalf("legacy session foreign keys workspaces=%v turns=%v, want package-owned turn reference only", hasWorkspacesFK, hasTurnsFK)
	}

	// A second Migrate is a no-op for claimed and applied migrations.
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() second run error = %v", err)
	}
}

func TestSessionMetadataMigrationRollsBackDDLAndBackfillAtomically(t *testing.T) {
	db := openTestDB(t)
	createLegacyTuttidDatabase(t, db)
	store := New(db, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := db.Exec(`
CREATE TABLE agent_store_schema_migrations (id TEXT PRIMARY KEY, applied_at_unix_ms INTEGER NOT NULL);
CREATE TRIGGER fail_session_metadata_backfill BEFORE UPDATE ON workspace_agent_sessions
BEGIN SELECT RAISE(ABORT, 'injected metadata backfill failure'); END;
`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentSessionMetadataV1(ctx); err == nil {
		t.Fatal("metadata migration error=nil")
	}
	for _, column := range []string{"session_metadata_json", "internal_runtime_context_json"} {
		present, err := store.hasColumn(ctx, "workspace_agent_sessions", column)
		if err != nil || present {
			t.Fatalf("rolled back column %s present=%v err=%v", column, present, err)
		}
	}
	if _, err := db.Exec(`DROP TRIGGER fail_session_metadata_backfill`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentSessionMetadataV1(ctx); err != nil {
		t.Fatalf("metadata migration retry: %v", err)
	}
	for _, column := range []string{"session_metadata_json", "internal_runtime_context_json"} {
		present, err := store.hasColumn(ctx, "workspace_agent_sessions", column)
		if err != nil || !present {
			t.Fatalf("retried column %s present=%v err=%v", column, present, err)
		}
	}
}

func TestSessionMetadataDropMigrationRollsBackAllColumnsAtomically(t *testing.T) {
	db := openTestDB(t)
	createLegacyTuttidDatabase(t, db)
	store := New(db, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := db.Exec(`CREATE TABLE agent_store_schema_migrations (id TEXT PRIMARY KEY, applied_at_unix_ms INTEGER NOT NULL)`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentSessionMetadataV1(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`CREATE INDEX block_runtime_context_drop ON workspace_agent_sessions(runtime_context_json)`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentSessionMetadataV2(ctx); err == nil {
		t.Fatal("drop migration error=nil")
	}
	for _, column := range []string{"status", "current_phase", "last_error", "runtime_context_json"} {
		present, err := store.hasColumn(ctx, "workspace_agent_sessions", column)
		if err != nil || !present {
			t.Fatalf("rolled back column %s present=%v err=%v", column, present, err)
		}
	}
	if _, err := db.Exec(`DROP INDEX block_runtime_context_drop`); err != nil {
		t.Fatal(err)
	}
	if err := store.applyWorkspaceAgentSessionMetadataV2(ctx); err != nil {
		t.Fatalf("drop migration retry: %v", err)
	}
	for _, column := range []string{"status", "current_phase", "last_error", "runtime_context_json"} {
		present, err := store.hasColumn(ctx, "workspace_agent_sessions", column)
		if err != nil || present {
			t.Fatalf("dropped column %s present=%v err=%v", column, present, err)
		}
	}
}

// A database that already recorded (claimed) the one-time v5 backfill — which
// ran before the cursor provider existed — must still backfill legacy cursor
// sessions: v7 replays the target-id backfill for providers added to
// TargetIDBackfillByProvider after v5, and only for those.
func TestStoreMigrateBackfillsCursorTargetsOnClaimedLegacyDatabase(t *testing.T) {
	t.Parallel()

	db := openTestDB(t)
	createLegacyTuttidDatabase(t, db)
	if _, err := db.Exec(`
INSERT INTO workspace_agent_sessions (
  workspace_id, agent_session_id, origin, agent_target_id, provider, title, status,
  created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-legacy', 'session-cursor-legacy', 'runtime', '', 'cursor', 'Legacy Cursor', 'completed', 1, 1);
`); err != nil {
		t.Fatalf("insert legacy cursor session: %v", err)
	}
	options := testOptions(&staticProjectPaths{})
	options.TargetIDBackfillByProvider["cursor"] = "local:cursor"
	store := New(db, options)
	ctx := context.Background()

	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	var cursorTarget sql.NullString
	if err := db.QueryRowContext(ctx, `
SELECT agent_target_id FROM workspace_agent_sessions
WHERE workspace_id = 'ws-legacy' AND agent_session_id = 'session-cursor-legacy'
`).Scan(&cursorTarget); err != nil {
		t.Fatalf("read legacy cursor session: %v", err)
	}
	if cursorTarget.String != "local:cursor" {
		t.Fatalf("legacy cursor agent_target_id = %q, want local:cursor (v7 backfill)", cursorTarget.String)
	}

	// v7 is scoped to providers added after v5: the untargeted codex session
	// keeps the claimed-v5 outcome.
	var codexTarget sql.NullString
	if err := db.QueryRowContext(ctx, `
SELECT agent_target_id FROM workspace_agent_sessions
WHERE workspace_id = 'ws-legacy' AND agent_session_id = 'session-untargeted'
`).Scan(&codexTarget); err != nil {
		t.Fatalf("read untargeted codex session: %v", err)
	}
	if codexTarget.String != "" {
		t.Fatalf("untargeted codex agent_target_id = %q, want empty (v7 must not replay the full v5 backfill)", codexTarget.String)
	}

	if applied, err := store.hasMigration(ctx, schemaMigrationWorkspaceAgentActivityV7); err != nil || !applied {
		t.Fatalf("v7 marker recorded = %v error = %v, want recorded", applied, err)
	}
}

func TestStoreMigrateUpgradesPartiallyMigratedLegacyDatabase(t *testing.T) {
	t.Parallel()

	db := openTestDB(t)
	// A database at agent activity v3: no agent_target_id column, no
	// agent_targets table, no rail columns.
	if _, err := db.Exec(`
CREATE TABLE tuttid_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES
  ('workspace_agent_activity_v1', 21),
  ('workspace_agent_activity_v2', 22),
  ('workspace_agent_activity_v3', 23);

CREATE TABLE workspace_agent_sessions (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT '',
  provider_session_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  settings_json TEXT NOT NULL DEFAULT '{}',
  runtime_context_json TEXT NOT NULL DEFAULT '{}',
  cwd TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  current_phase TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  message_version INTEGER NOT NULL DEFAULT 0,
  last_event_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  ended_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  pinned_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  deleted_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id)
);
INSERT INTO workspace_agent_sessions (
  workspace_id, agent_session_id, origin, provider, status, created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-partial', 'session-codex', 'runtime', 'codex', 'completed', 1, 1);

CREATE TABLE workspace_agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  turn_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  completed_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  deleted_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  UNIQUE (workspace_id, agent_session_id, message_id)
);
`); err != nil {
		t.Fatalf("create partial legacy database: %v", err)
	}

	store := New(db, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	// v4 added the column and v5 (not claimed) backfilled it.
	session, ok, err := store.GetSession(ctx, "ws-partial", "session-codex")
	if err != nil || !ok {
		t.Fatalf("GetSession() ok=%v error=%v", ok, err)
	}
	if session.AgentTargetID != testTargetIDCodex {
		t.Fatalf("backfilled agent target id = %q, want %s", session.AgentTargetID, testTargetIDCodex)
	}
	// Targets table exists with seeds; rail columns exist.
	targets, err := store.ListAgentTargets(ctx)
	if err != nil || len(targets) != 2 {
		t.Fatalf("ListAgentTargets() len=%d error=%v, want 2 seeded targets", len(targets), err)
	}
	hasRailKey, err := store.hasColumn(ctx, "workspace_agent_sessions", "rail_section_key")
	if err != nil || !hasRailKey {
		t.Fatalf("rail_section_key present = %v error = %v", hasRailKey, err)
	}
}

func TestStoreMigrateReconcilesLegacySystemTargetIDs(t *testing.T) {
	t.Parallel()

	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	now := int64(1700000000000)

	if _, err := store.db.ExecContext(ctx, `
DELETE FROM agent_targets WHERE id = ?;
`, testTargetIDCodex); err != nil {
		t.Fatalf("delete seeded target: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO agent_targets (id, provider, launch_ref_json, name, icon_key, enabled, source, sort_order, created_at_ms, updated_at_ms)
VALUES ('local-codex', 'codex', '{"type":"local_cli","provider":"codex"}', 'Legacy Codex', 'codex', 1, 'system', 10, ?, ?);
`, now, now); err != nil {
		t.Fatalf("insert legacy target fixture: %v", err)
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO workspace_agent_sessions (workspace_id, agent_session_id, origin, agent_target_id, provider, created_at_unix_ms, updated_at_unix_ms)
VALUES ('ws-reconcile', 'session-1', 'runtime', 'local-codex', 'codex', ?, ?);
`, now, now); err != nil {
		t.Fatalf("insert legacy session fixture: %v", err)
	}

	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	if _, err := store.GetAgentTarget(ctx, "local-codex"); !errors.Is(err, ErrAgentTargetNotFound) {
		t.Fatalf("GetAgentTarget(legacy) error = %v, want ErrAgentTargetNotFound", err)
	}
	if _, err := store.GetAgentTarget(ctx, testTargetIDCodex); err != nil {
		t.Fatalf("GetAgentTarget(current) error = %v", err)
	}
	sessions, ok, err := store.ListSessions(ctx, "ws-reconcile")
	if err != nil || !ok || len(sessions) != 1 {
		t.Fatalf("ListSessions() ok=%v len=%d error=%v", ok, len(sessions), err)
	}
	if sessions[0].AgentTargetID != testTargetIDCodex {
		t.Fatalf("session agent target id = %q, want %s", sessions[0].AgentTargetID, testTargetIDCodex)
	}
}

func TestStoreMigrateBackfillsRailSectionsFromInjectedProjects(t *testing.T) {
	t.Parallel()

	db := openTestDB(t)
	repoRoot := t.TempDir()
	repo := repoRoot + "/repo"
	repoSubdir := repo + "/pkg"
	otherDir := repoRoot + "/other"
	for _, path := range []string{repoSubdir, otherDir} {
		if err := mkdirAll(path); err != nil {
			t.Fatalf("mkdir %q error = %v", path, err)
		}
	}

	// Legacy database at v5: rail migration not applied yet.
	if _, err := db.Exec(`
CREATE TABLE tuttid_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES
  ('workspace_agent_activity_v1', 21),
  ('workspace_agent_activity_v2', 22),
  ('workspace_agent_activity_v3', 23),
  ('workspace_agent_activity_v4', 24),
  ('workspace_agent_activity_v5', 25),
  ('agent_targets_v1', 26);

CREATE TABLE workspace_agent_sessions (
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT '',
  agent_target_id TEXT,
  provider TEXT NOT NULL DEFAULT '',
  provider_session_id TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  settings_json TEXT NOT NULL DEFAULT '{}',
  runtime_context_json TEXT NOT NULL DEFAULT '{}',
  cwd TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  current_phase TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  message_version INTEGER NOT NULL DEFAULT 0,
  last_event_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  ended_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  pinned_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  deleted_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, agent_session_id)
);
CREATE TABLE workspace_agent_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  turn_id TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  started_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  completed_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  deleted_at_unix_ms INTEGER NOT NULL DEFAULT 0,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  UNIQUE (workspace_id, agent_session_id, message_id)
);
CREATE TABLE agent_targets (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  launch_ref_json TEXT NOT NULL,
  name TEXT NOT NULL,
  icon_key TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
`); err != nil {
		t.Fatalf("create legacy pre-rail database: %v", err)
	}
	if _, err := db.Exec(`
INSERT INTO workspace_agent_sessions (workspace_id, agent_session_id, provider, cwd, runtime_context_json, created_at_unix_ms, updated_at_unix_ms)
VALUES
  ('ws-rail-backfill', 'session-project', 'codex', ?, '{}', 1, 1),
  ('ws-rail-backfill', 'session-no-project', 'codex', ?, '{"externalImportNoProject":true}', 1, 1),
  ('ws-rail-backfill', 'session-conversations', 'codex', ?, '{}', 1, 1);
`, repoSubdir, repoSubdir, otherDir); err != nil {
		t.Fatalf("insert pre-rail sessions: %v", err)
	}

	store := New(db, testOptions(&staticProjectPaths{paths: []string{repo}}))
	ctx := context.Background()
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	repoCanonical := NormalizeProjectPath(repo)
	wantKeys := map[string]string{
		"session-project":       RailSectionKeyForProject(repoCanonical),
		"session-no-project":    RailSectionKeyConversations,
		"session-conversations": RailSectionKeyConversations,
	}
	for sessionID, wantKey := range wantKeys {
		var key string
		if err := db.QueryRowContext(ctx, `
SELECT rail_section_key FROM workspace_agent_sessions
WHERE workspace_id = 'ws-rail-backfill' AND agent_session_id = ?
`, sessionID).Scan(&key); err != nil {
			t.Fatalf("read rail key for %s: %v", sessionID, err)
		}
		if key != wantKey {
			t.Fatalf("rail key for %s = %q, want %q", sessionID, key, wantKey)
		}
	}
}
