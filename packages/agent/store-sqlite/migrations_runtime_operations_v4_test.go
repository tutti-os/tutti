package storesqlite

import (
	"context"
	"strings"
	"testing"
)

func TestRuntimeOperationsV4RejectsDuplicateStructuredIdentityWithoutMutation(t *testing.T) {
	store := openTestStore(t, testOptions(&staticProjectPaths{}))
	ctx := context.Background()
	if _, err := store.db.Exec(`
DROP TABLE workspace_agent_runtime_operation_events;
DROP TABLE workspace_agent_runtime_operations;
DELETE FROM agent_store_schema_migrations WHERE id = 'workspace_agent_runtime_operations_v4';
CREATE TABLE workspace_agent_runtime_operations (
  operation_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  request_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result TEXT,
  lease_owner TEXT,
  lease_expires_at_unix_ms INTEGER,
  next_attempt_at_unix_ms INTEGER,
  attempt INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  last_error TEXT NOT NULL DEFAULT '',
  created_at_unix_ms INTEGER NOT NULL,
  updated_at_unix_ms INTEGER NOT NULL,
  completed_at_unix_ms INTEGER
);
CREATE TABLE workspace_agent_runtime_operation_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at_unix_ms INTEGER NOT NULL,
  published_at_unix_ms INTEGER
);
INSERT INTO workspace_agent_runtime_operations (
  operation_id, workspace_id, agent_session_id, kind, status, subject_id,
  turn_id, request_id, next_attempt_at_unix_ms, created_at_unix_ms, updated_at_unix_ms
) VALUES
  ('operation-a', 'ws-1', 'session-1', 'interactive_response', 'prepared', 'legacy-a', 'turn-1', 'request-reused', 10, 10, 10),
  ('operation-b', 'ws-1', 'session-1', 'interactive_response', 'prepared', 'legacy-b', 'turn-1', 'request-reused', 11, 11, 11);
`); err != nil {
		t.Fatal(err)
	}

	err := store.applyWorkspaceAgentRuntimeOperationsV4(ctx)
	if err == nil || !strings.Contains(err.Error(), "conflicting durable identities") {
		t.Fatalf("migration error = %v", err)
	}
	var rows, subjectColumns, migrationRows, renamedTables int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM workspace_agent_runtime_operations`).Scan(&rows); err != nil || rows != 2 {
		t.Fatalf("operation rows=%d err=%v", rows, err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('workspace_agent_runtime_operations') WHERE name = 'subject_id'`).Scan(&subjectColumns); err != nil || subjectColumns != 1 {
		t.Fatalf("subject columns=%d err=%v", subjectColumns, err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM agent_store_schema_migrations WHERE id = ?`, schemaMigrationWorkspaceAgentRuntimeOperationsV4).Scan(&migrationRows); err != nil || migrationRows != 0 {
		t.Fatalf("migration rows=%d err=%v", migrationRows, err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE 'workspace_agent_runtime_operation%_v3'`).Scan(&renamedTables); err != nil || renamedTables != 0 {
		t.Fatalf("renamed tables=%d err=%v", renamedTables, err)
	}
}
