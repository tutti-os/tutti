package workspace

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/tutti-os/tutti/packages/agent/daemon/providerregistry"
	agentactivitybiz "github.com/tutti-os/tutti/services/tuttid/biz/agentactivity"
	workspacebiz "github.com/tutti-os/tutti/services/tuttid/biz/workspace"
)

// createLegacyFullyMigratedTuttidDatabase replays the state a tuttid
// database was left in by the last release before the agent store
// extraction: all agent migrations recorded in the shared
// tuttid_schema_migrations ledger, agent tables carrying the foreign key
// into workspaces, and live data rows.
func createLegacyFullyMigratedTuttidDatabase(t *testing.T, dbPath string, projectPath string) {
	t.Helper()

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open legacy db: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`
CREATE TABLE tuttid_schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at_unix_ms INTEGER NOT NULL
);
INSERT INTO tuttid_schema_migrations (id, applied_at_unix_ms) VALUES
  ('workspaces_v1', 11),
  ('workspaces_v2', 12),
  ('workspaces_v3', 13),
  ('workspaces_v4', 14),
  ('user_projects_v1', 15),
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
  updated_at_unix_ms INTEGER NOT NULL,
  last_opened_at_unix_ms INTEGER
);
INSERT INTO workspaces (id, name, created_at_unix_ms, updated_at_unix_ms, last_opened_at_unix_ms)
VALUES ('ws-upgrade', 'Upgrade Workspace', 1, 1, 1);

CREATE TABLE user_projects (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  last_used_at_unix_ms INTEGER NOT NULL DEFAULT 0
);

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
  workspace_id, agent_session_id, origin, agent_target_id, provider, title, status,
  message_version, created_at_unix_ms, updated_at_unix_ms
) VALUES
  ('ws-upgrade', 'session-targeted', 'runtime', 'local:codex', 'codex', 'Targeted', 'completed', 1, 1, 2),
  ('ws-upgrade', 'session-untargeted', 'runtime', '', 'codex', 'Untargeted', 'completed', 0, 1, 1);

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
) VALUES ('ws-upgrade', 'session-targeted', 'message-1', 1, 'assistant', 'text', 'completed', '{"text":"legacy payload"}', 1, 1);

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
VALUES
  ('local:codex', 'codex', '{"type":"local_cli","provider":"codex"}', 'Codex', 'codex', 1, 'system', 10, 1, 1),
  ('local:claude-code', 'claude-code', '{"type":"local_cli","provider":"claude-code"}', 'Claude Code', 'claude-code', 1, 'system', 20, 1, 1);
`); err != nil {
		t.Fatalf("create legacy fully migrated database: %v", err)
	}
	// A session whose cwd lives under a registered user project but that is
	// still filed under conversations: the rail backfill would reclassify it
	// if workspace_agent_activity_rail_v1 were (incorrectly) replayed.
	if _, err := db.Exec(`
INSERT INTO user_projects (id, path, label, created_at_unix_ms, updated_at_unix_ms, last_used_at_unix_ms)
VALUES ('project-upgrade', ?, 'upgrade project', 1, 1, 1);
`, projectPath); err != nil {
		t.Fatalf("insert legacy user project: %v", err)
	}
	if _, err := db.Exec(`
INSERT INTO workspace_agent_sessions (
  workspace_id, agent_session_id, origin, agent_target_id, provider, cwd,
  rail_section_kind, rail_project_path, rail_section_key,
  title, status, created_at_unix_ms, updated_at_unix_ms
) VALUES ('ws-upgrade', 'session-conversations-in-project', 'runtime', 'local:codex', 'codex', ?,
  'conversations', '', 'conversations',
  'Filed As Conversation', 'completed', 1, 1);
`, projectPath); err != nil {
		t.Fatalf("insert legacy conversations session: %v", err)
	}
}

func TestSQLiteStoreMigrateUpgradesLegacyDatabaseWithoutReplayingAgentMigrations(t *testing.T) {
	t.Parallel()

	dbPath := filepath.Join(t.TempDir(), "tuttid.db")
	projectPath := filepath.Join(t.TempDir(), "project")
	if err := mkdirAll(projectPath); err != nil {
		t.Fatalf("mkdir project error = %v", err)
	}
	createLegacyFullyMigratedTuttidDatabase(t, dbPath, projectPath)

	store, err := OpenSQLiteStore(dbPath)
	if err != nil {
		t.Fatalf("OpenSQLiteStore() error = %v", err)
	}
	t.Cleanup(func() {
		_ = store.Close()
	})
	ctx := context.Background()
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() error = %v", err)
	}

	// All agent migration records are claimed into the package ledger with
	// their original timestamps; the legacy ledger keeps its rows.
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
		if err := store.db.QueryRowContext(ctx, `
SELECT applied_at_unix_ms FROM agent_store_schema_migrations WHERE id = ?
`, migrationID).Scan(&appliedAt); err != nil {
			t.Fatalf("claimed migration %s missing from agent store ledger: %v", migrationID, err)
		}
		if appliedAt != wantAppliedAt {
			t.Fatalf("claimed migration %s applied_at = %d, want %d (claimed, not replayed)", migrationID, appliedAt, wantAppliedAt)
		}
		applied, err := store.hasMigration(ctx, migrationID)
		if err != nil || !applied {
			t.Fatalf("legacy ledger record %s present = %v error = %v, want untouched", migrationID, applied, err)
		}
	}

	// The v5 target-ID backfill must not replay: the untargeted codex
	// session keeps its empty agent_target_id.
	session, ok, err := store.GetSession(ctx, "ws-upgrade", "session-untargeted")
	if err != nil || !ok {
		t.Fatalf("GetSession(untargeted) ok=%v error=%v", ok, err)
	}
	if session.AgentTargetID != "" {
		t.Fatalf("untargeted session AgentTargetID = %q, want empty (v5 replayed?)", session.AgentTargetID)
	}

	// The rail backfill must not replay: the project-cwd session stays
	// filed under conversations.
	rail := getTestAgentSessionRailSection(t, store, "ws-upgrade", "session-conversations-in-project")
	if rail.Key != agentSessionRailSectionKeyConversations {
		t.Fatalf("conversations session rail key = %q, want conversations (rail_v1 replayed?)", rail.Key)
	}

	// Legacy rows stay readable through the delegated repository.
	sessions, ok, err := store.ListSessions(ctx, "ws-upgrade")
	if err != nil || !ok {
		t.Fatalf("ListSessions() ok=%v error=%v", ok, err)
	}
	if len(sessions) != 3 {
		t.Fatalf("ListSessions() len = %d, want 3 legacy sessions", len(sessions))
	}
	page, ok, err := store.ListSessionMessages(ctx, agentactivitybiz.ListSessionMessagesInput{
		WorkspaceID:    "ws-upgrade",
		AgentSessionID: "session-targeted",
		Limit:          10,
	})
	if err != nil || !ok {
		t.Fatalf("ListSessionMessages() ok=%v error=%v", ok, err)
	}
	if len(page.Messages) != 1 || page.Messages[0].Payload["text"] != "legacy payload" {
		t.Fatalf("legacy message page = %#v", page)
	}

	// Seeded system targets survive untouched, and the complete descriptor
	// catalog is seeded onto the upgraded database.
	targets, err := store.ListAgentTargets(ctx)
	if err != nil {
		t.Fatalf("ListAgentTargets() error = %v", err)
	}
	descriptors := providerregistry.Migrated()
	if len(targets) != len(descriptors) {
		t.Fatalf("targets after upgrade = %#v, want %d descriptor targets", targets, len(descriptors))
	}
	for index, target := range targets {
		if target.ID != descriptors[index].Target.ID || target.Provider != descriptors[index].Identity.ID || target.Enabled != descriptors[index].Target.Enabled {
			t.Fatalf("target[%d] after upgrade = %#v, want descriptor target %#v", index, target, descriptors[index].Target)
		}
	}

	// Migrate is idempotent after the claim.
	if err := store.Migrate(ctx); err != nil {
		t.Fatalf("Migrate() second run error = %v", err)
	}

	// The final entity migration normalizes the claimed legacy table onto the
	// package-owned schema and replaces host coupling with the active-turn FK.
	rows, err := store.db.QueryContext(ctx, `PRAGMA foreign_key_list(workspace_agent_sessions)`)
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
		t.Fatalf("upgraded session foreign keys workspaces=%v turns=%v, want package-owned turn reference", hasWorkspacesFK, hasTurnsFK)
	}

	// Workspace deletion on the upgraded schema clears agent rows through
	// the single-transaction explicit cascade (the legacy FK cascade is
	// redundant with it).
	if err := store.Delete(ctx, "ws-upgrade"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}
	var sessionCount int
	if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM workspace_agent_sessions WHERE workspace_id = 'ws-upgrade'
`).Scan(&sessionCount); err != nil {
		t.Fatalf("count sessions after delete: %v", err)
	}
	if sessionCount != 0 {
		t.Fatalf("sessions after workspace delete = %d, want 0", sessionCount)
	}
}

func TestSQLiteStoreWorkspaceDeleteClearsAgentSessionsWithoutForeignKey(t *testing.T) {
	t.Parallel()

	store := openTestSQLiteStore(t)
	ctx := context.Background()

	if err := store.Create(ctx, workspacebiz.Summary{
		ID:   "ws-delete-cascade",
		Name: "Delete Cascade",
	}); err != nil {
		t.Fatalf("Create() error = %v", err)
	}
	if _, err := store.ReportSessionState(ctx, agentactivitybiz.SessionStateReport{
		WorkspaceID:      "ws-delete-cascade",
		AgentSessionID:   "session-1",
		Origin:           "runtime",
		Provider:         "codex",
		Status:           "completed",
		OccurredAtUnixMS: 100,
	}); err != nil {
		t.Fatalf("ReportSessionState() error = %v", err)
	}

	if err := store.Delete(ctx, "ws-delete-cascade"); err != nil {
		t.Fatalf("Delete() error = %v", err)
	}

	var sessionCount int
	if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM workspace_agent_sessions WHERE workspace_id = ?
`, "ws-delete-cascade").Scan(&sessionCount); err != nil {
		t.Fatalf("count sessions after delete: %v", err)
	}
	if sessionCount != 0 {
		t.Fatalf("sessions after workspace delete = %d, want 0", sessionCount)
	}
}
